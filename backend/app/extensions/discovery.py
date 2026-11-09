"""Read-only online discovery and account-scoped, immutable installation previews."""
from __future__ import annotations

import base64
import io
import json
import re
import stat
import time
import uuid
import zipfile
from pathlib import Path
from urllib.parse import quote, urlsplit

import httpx

from ..workspace import current_workspace_root
from .contracts import ExtensionContext
from .manifest import safe_resource_path
from .repository import ExtensionRepository
from .skills import MAX_ARCHIVE_FILES, MAX_EXPANDED_BYTES, parse_skill

MAX_DOWNLOAD_BYTES = 20_000_000
MAX_REPO_BYTES = 50_000_000
PREVIEW_TTL = 1800
REPOSITORY = re.compile(r"[A-Za-z0-9][A-Za-z0-9-]{0,38}/[A-Za-z0-9_.-]{1,100}\Z")


class DiscoveryUnavailable(ValueError):
    pass


def _client() -> httpx.Client:
    return httpx.Client(timeout=httpx.Timeout(30, connect=10), follow_redirects=False,
                        headers={"User-Agent": "Tuantuan-Skills/1", "Accept": "application/vnd.github+json"})


def _download(url: str, *, limit: int) -> bytes:
    try:
        with _client() as client, client.stream("GET", url) as response:
            if response.status_code == 404:
                raise DiscoveryUnavailable("仓库或技能不存在，请检查地址；首版仅支持公开仓库")
            if response.status_code in {403, 429}:
                raise DiscoveryUnavailable("在线服务访问过于频繁，请稍后重试")
            if response.status_code != 200:
                raise DiscoveryUnavailable("在线服务暂时不可用，请稍后重试")
            data = bytearray()
            for chunk in response.iter_bytes():
                data.extend(chunk)
                if len(data) > limit:
                    raise ValueError("下载内容超过大小限制，请选择较小的技能仓库")
            return bytes(data)
    except httpx.TimeoutException:
        raise DiscoveryUnavailable("在线请求超时，请检查网络后重试") from None
    except httpx.HTTPError:
        raise DiscoveryUnavailable("无法连接在线服务，请检查网络后重试") from None


def _json(url: str) -> dict:
    try:
        result = json.loads(_download(url, limit=1_000_000))
        if not isinstance(result, dict):
            raise DiscoveryUnavailable("在线服务返回格式异常，请稍后重试")
        return result
    except (json.JSONDecodeError, UnicodeError):
        raise DiscoveryUnavailable("在线服务返回格式异常，请稍后重试") from None


def repository_name(source: str) -> str:
    value = source.strip()
    if value.startswith("https://"):
        parsed = urlsplit(value)
        if parsed.netloc != "github.com" or parsed.query or parsed.fragment:
            raise ValueError("请填写公开 GitHub 仓库地址或 owner/repo")
        value = parsed.path.strip("/")
    value = value.removesuffix(".git")
    if not REPOSITORY.fullmatch(value) or value.split("/")[1] in {".", ".."}:
        raise ValueError("请填写公开 GitHub 仓库地址或 owner/repo")
    return value


def search(query: str, context: ExtensionContext) -> dict:
    context.check_workspace()
    query = query.strip()
    if not 2 <= len(query) <= 100:
        raise ValueError("请输入 2 到 100 个字符搜索技能")
    data = _json(f"https://skills.sh/api/search?q={quote(query, safe='')}")
    if not isinstance(data.get("skills"), list):
        raise DiscoveryUnavailable("在线技能目录格式发生变化，请稍后重试")
    installed = {(item.get("origin", {}).get("repository", "").lower(), item.get("origin", {}).get("skill_id"))
                 for item in ExtensionRepository().list(context) if item["kind"] == "skill"}
    results, seen = [], set()
    for entry in data["skills"][:100]:
        if not isinstance(entry, dict):
            continue
        try:
            source = repository_name(entry.get("source", ""))
            name = entry.get("skillId") or entry.get("name")
            if not isinstance(name, str) or not name.strip() or len(name) > 100:
                continue
            identity = (source.lower(), name)
            if identity in seen:
                continue
            seen.add(identity)
            installs = entry.get("installs", 0)
            results.append({"name": name, "source": source, "installs": max(0, installs) if type(installs) is int else 0,
                            "installed": identity in installed})
        except (ValueError, TypeError, AttributeError):
            continue
    return {"skills": results}


def _unpack(data: bytes) -> tuple[dict[str, bytes], str]:
    files, seen = {}, set()
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            # GitHub's git-archive ZIP comment identifies the exact downloaded snapshot.
            commit = archive.comment.decode("ascii", errors="replace")
            if not re.fullmatch(r"[a-f0-9]{40}", commit):
                raise ValueError("无法确认仓库版本，请重新预览")
            entries = archive.infolist()
            if len(entries) > 5000 or sum(entry.file_size for entry in entries) > MAX_REPO_BYTES:
                raise ValueError("仓库展开后过大，请使用较小的技能仓库")
            roots = set()
            for entry in entries:
                full = safe_resource_path(entry.filename.rstrip("/"))
                roots.add(full.split("/")[0])
                mode = stat.S_IFMT(entry.external_attr >> 16)
                if entry.flag_bits & 1 or mode not in {0, stat.S_IFREG, stat.S_IFDIR}:
                    raise ValueError("仓库包含链接或加密条目，不能导入")
                if full.casefold() in seen:
                    raise ValueError("仓库包含重复路径或大小写冲突")
                seen.add(full.casefold())
                if not entry.is_dir():
                    if "/" not in full:
                        raise ValueError("仓库快照目录无效")
                    files[full.split("/", 1)[1]] = archive.read(entry)
            if len(roots) != 1:
                raise ValueError("仓库快照目录无效")
    except (zipfile.BadZipFile, RuntimeError, NotImplementedError, EOFError):
        raise ValueError("无法读取仓库压缩包，请重试") from None
    return files, commit


def _cache_root(context: ExtensionContext) -> Path:
    context.check_workspace()
    root = current_workspace_root() / "skill-previews"
    root.mkdir(parents=True, exist_ok=True)
    return root


def preview(source: str, ref: str | None, name: str | None, context: ExtensionContext) -> dict:
    context.check_workspace()
    repository = repository_name(source)
    ref = (ref or "HEAD").strip()
    if not ref or len(ref) > 200 or any(ord(char) < 32 for char in ref):
        raise ValueError("分支或标签无效")
    files, commit = _unpack(_download(f"https://codeload.github.com/{repository}/zip/{quote(ref, safe='')}", limit=MAX_DOWNLOAD_BYTES))
    skill_paths = sorted(path for path in files if path == "SKILL.md" or path.endswith("/SKILL.md"))
    if len(skill_paths) > 300:
        raise ValueError("仓库技能数量过多，请使用较小的技能仓库")
    candidates, packages, skipped = [], {}, 0
    for skill_path in skill_paths:
        prefix = skill_path.removesuffix("SKILL.md")
        try:
            content = files[skill_path].decode("utf-8-sig")
            metadata, _ = parse_skill(content)
            if name and metadata["name"] != name and prefix.rstrip("/").split("/")[-1] != name:
                continue
            children = [path.removesuffix("SKILL.md") for path in skill_paths if path != skill_path and path.startswith(prefix)]
            resources = {path[len(prefix):]: data for path, data in files.items()
                         if path.startswith(prefix) and path != skill_path and not any(path.startswith(child) for child in children)}
            if len(resources) + 1 > MAX_ARCHIVE_FILES or sum(len(data) for data in resources.values()) + len(files[skill_path]) > MAX_EXPANDED_BYTES:
                raise ValueError("技能包超过资源数量或大小限制")
            path = prefix.rstrip("/")
            candidates.append({"path": path, "name": metadata["name"], "description": metadata["description"],
                               "content": content, "files": sorted(resources)})
            packages[path] = {"content": content, "files": {key: base64.b64encode(value).decode("ascii") for key, value in resources.items()},
                              "origin": {"repository": repository, "commit": commit, "path": path, "skill_id": name or metadata["name"]}}
        except (ValueError, UnicodeError):
            skipped += 1
    if not candidates:
        raise ValueError("没有找到可导入的技能，请检查技能名称、格式和资源大小")
    root = _cache_root(context)
    existing = sorted(root.glob("*.json"), key=lambda path: path.stat().st_mtime, reverse=True)
    for index, path in enumerate(existing):
        if path.stat().st_mtime < time.time() - PREVIEW_TTL or index >= 2:
            path.unlink(missing_ok=True)
    preview_id = uuid.uuid4().hex
    expires_at = time.time() + PREVIEW_TTL
    (root / f"{preview_id}.json").write_text(json.dumps({"expires_at": expires_at, "packages": packages}, ensure_ascii=False), encoding="utf-8")
    return {"preview_id": preview_id, "repository": repository, "commit": commit,
            "expires_at": expires_at, "skills": candidates, "skipped": skipped}


def install(preview_id: str, path: str, context: ExtensionContext) -> dict:
    root = _cache_root(context)
    if not re.fullmatch(r"[a-f0-9]{32}", preview_id):
        raise ValueError("预览标识无效，请重新预览")
    cache = root / f"{preview_id}.json"
    try:
        data = json.loads(cache.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise ValueError("预览不存在，请重新预览") from None
    if data["expires_at"] < time.time():
        cache.unlink(missing_ok=True)
        raise ValueError("预览已过期，请重新预览")
    package = data["packages"].get(path)
    if not package:
        raise ValueError("技能不在本次预览中，请重新选择")
    repository = ExtensionRepository()
    for item in repository.list(context):
        origin = item.get("origin", {})
        if item["kind"] == "skill" and origin.get("repository", "").lower() == package["origin"]["repository"].lower() and origin.get("path") == path:
            return repository.get(item["id"], context)
    metadata, body = parse_skill(package["content"])
    metadata.update(source="github", origin=package["origin"])
    return repository.add("skill", metadata, body,
                          {key: base64.b64decode(value) for key, value in package["files"].items()}, context)
