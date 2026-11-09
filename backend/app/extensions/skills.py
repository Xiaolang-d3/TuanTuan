from __future__ import annotations

import hashlib
import io
import json
import re
import stat
import uuid
import zipfile
from urllib.parse import urlsplit

import yaml
from pydantic import BaseModel, Field, ValidationError

from ..db import connect
from .contracts import ExtensionContext
from .manifest import ExtensionManifest, safe_resource_path
from .repository import ExtensionNotFound, ExtensionRepository, ExtensionUnavailable

MAX_CONTENT_BYTES = 100_000
MAX_ARCHIVE_BYTES = 2_000_000
MAX_EXPANDED_BYTES = 5_000_000
MAX_ARCHIVE_FILES = 100


class SkillMetadata(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(min_length=1, max_length=1000)


class UniqueSafeLoader(yaml.SafeLoader):
    pass


def _unique_mapping(loader, node, deep=False):
    result = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if not isinstance(key, str) or key in result:
            raise ValueError("技能元数据需要不重复的字符串字段")
        result[key] = loader.construct_object(value_node, deep=deep)
    return result


UniqueSafeLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, _unique_mapping)


def parse_skill(content: str) -> tuple[dict, str]:
    if len(content.encode("utf-8")) > MAX_CONTENT_BYTES:
        raise ValueError("SKILL.md 不能超过 100 KB")
    match = re.match(r"\A\ufeff?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)\Z", content)
    if not match:
        raise ValueError("SKILL.md 需要 name 和 description frontmatter")
    try:
        # Aliases / recursive values serve no purpose in the metadata contract.
        if any(isinstance(token, (yaml.tokens.AliasToken, yaml.tokens.AnchorToken, yaml.tokens.TagToken)) for token in yaml.scan(match[1])):
            raise ValueError("技能元数据不支持 YAML 引用、锚点或自定义标签")
        metadata = yaml.load(match[1], Loader=UniqueSafeLoader)
        if not isinstance(metadata, dict):
            raise ValueError("技能元数据必须是对象")
        parsed = SkillMetadata.model_validate(metadata)
        json.dumps(metadata, allow_nan=False)
    except (yaml.YAMLError, ValidationError, TypeError, OverflowError) as exc:
        raise ValueError("技能元数据格式无效，请检查 name 和 description") from exc
    body = match[2].strip()
    if not body:
        raise ValueError("技能正文不能为空")
    return {
        "name": parsed.name.strip(), "description": parsed.description.strip(),
        "permissions": [], "metadata": metadata, "provider": "user",
        "model_invocable": metadata.get("disable-model-invocation") is not True,
        "user_invocable": metadata.get("user-invocable") is not False,
    }, body


def unpack_skill_archive(data: bytes) -> tuple[str, dict[str, bytes]]:
    if len(data) > MAX_ARCHIVE_BYTES:
        raise ValueError("压缩包不能超过 2 MB")
    files: dict[str, bytes] = {}
    seen: set[str] = set()
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
            if len(entries) > MAX_ARCHIVE_FILES or sum(item.file_size for item in entries) > MAX_EXPANDED_BYTES:
                raise ValueError("压缩包超过 100 个条目或展开后超过 5 MB")
            for entry in entries:
                path = safe_resource_path(entry.filename.rstrip("/") if entry.is_dir() else entry.filename)
                mode = entry.external_attr >> 16
                if entry.flag_bits & 1 or (stat.S_IFMT(mode) and not (stat.S_ISREG(mode) or stat.S_ISDIR(mode))):
                    raise ValueError("压缩包不能包含加密条目或链接")
                if path.casefold() in seen:
                    raise ValueError("压缩包存在重复文件或大小写冲突")
                seen.add(path.casefold())
                if not entry.is_dir():
                    files[path] = archive.read(entry)
    except (zipfile.BadZipFile, RuntimeError, NotImplementedError, EOFError) as exc:
        raise ValueError("无法读取技能 ZIP 压缩包") from exc
    candidates = [path for path in files if path == "SKILL.md" or path.endswith("/SKILL.md")]
    if len(candidates) != 1:
        raise ValueError("技能 ZIP 必须包含一个 SKILL.md")
    skill_path = candidates[0]
    prefix = skill_path.removesuffix("SKILL.md")
    if any(not path.startswith(prefix) for path in files):
        raise ValueError("所有资源必须位于同一个技能目录")
    try:
        content = files[skill_path].decode("utf-8-sig")
    except UnicodeDecodeError as exc:
        raise ValueError("SKILL.md 必须采用 UTF-8 编码") from exc
    return content, {path[len(prefix):]: value for path, value in files.items() if path != skill_path}


class SkillService:
    def __init__(self):
        self.repository = ExtensionRepository()

    def list(self, context: ExtensionContext, *, enabled_only: bool = False) -> list[dict]:
        return [item for item in self.repository.list(context) if item["kind"] == "skill" and (not enabled_only or item["enabled"])]

    def import_text(self, content: str, context: ExtensionContext, *, files: dict[str, bytes] | None = None) -> dict:
        metadata, body = parse_skill(content)
        return self.repository.add("skill", metadata, body, files or {}, context)

    def import_zip(self, data: bytes, context: ExtensionContext) -> dict:
        content, files = unpack_skill_archive(data)
        return self.import_text(content, context, files=files)

    def get(self, skill_id: str, revision: str | None, context: ExtensionContext, *, bound: bool = False) -> dict:
        item = self.repository.get(skill_id, context, revision=revision, include_deleted=bound)
        if item["kind"] != "skill":
            raise ExtensionNotFound("技能不存在")
        if not bound and not item["enabled"]:
            raise ExtensionUnavailable("技能已停用，请在扩展中心启用后重试")
        return item

    def binding(self, skill_id: str, context: ExtensionContext) -> dict:
        item = self.get(skill_id, None, context)
        if not item.get("user_invocable", True):
            raise ExtensionUnavailable("此技能不支持手动调用")
        return {"id": item["id"], "revision": item["revision"], "user_id": context.user_id,
                "content_hash": hashlib.sha256(item["content"].encode()).hexdigest()}

    def resolve_binding(self, binding: dict, context: ExtensionContext) -> dict:
        if binding.get("user_id") != context.user_id:
            raise PermissionError("技能绑定不属于当前用户")
        item = self.get(binding["id"], binding["revision"], context, bound=True)
        if hashlib.sha256(item["content"].encode()).hexdigest() != binding.get("content_hash"):
            raise ExtensionUnavailable("技能原版本校验失败")
        return item


def import_plugin(content: str, context: ExtensionContext) -> dict:
    if len(content.encode()) > MAX_CONTENT_BYTES:
        raise ValueError("插件清单不能超过 100 KB")
    try:
        manifest = ExtensionManifest.model_validate_json(content)
    except ValidationError as exc:
        raise ValueError("插件清单需要 api_version=1、id、name、version，且只能引用已支持的适配器") from exc
    if manifest.files or manifest.skills:
        raise ValueError("带资源或技能的插件需要完整安装包；当前接口仅支持清单配置")
    metadata = manifest.model_dump(mode="json")
    metadata["unavailable_reason"] = "插件清单已保存；插件执行环境和完整资源安装尚未接入"
    return ExtensionRepository().add("plugin", metadata, content, {}, context)


def list_mcp(context: ExtensionContext) -> list[dict]:
    context.check_workspace()
    with connect() as conn:
        return [{**dict(row), "status": "draft"} for row in conn.execute("SELECT id,name,transport,endpoint FROM extension_mcp_drafts ORDER BY created_at,id")]


def save_mcp(name: str, transport: str, endpoint: str, context: ExtensionContext) -> dict:
    context.check_workspace()
    name, endpoint = name.strip(), endpoint.strip()
    if not name or not endpoint:
        raise ValueError("名称和连接信息不能为空")
    if transport == "http":
        try:
            url = urlsplit(endpoint)
            if url.scheme not in {"http", "https"} or not url.hostname or url.username or url.password or url.query or url.fragment:
                raise ValueError("请填写不含凭据或查询参数的 HTTP/HTTPS 地址")
            url.port
        except ValueError as exc:
            raise ValueError("请填写有效且不含凭据的 HTTP/HTTPS 服务地址") from exc
    item = {"id": uuid.uuid4().hex, "name": name, "transport": transport, "endpoint": endpoint, "status": "draft"}
    with connect() as conn:
        if conn.execute("SELECT id FROM extension_mcp_drafts WHERE name=?", (name,)).fetchone():
            raise ValueError("同名 MCP 配置已存在")
        conn.execute("INSERT INTO extension_mcp_drafts(id,name,transport,endpoint) VALUES(?,?,?,?)", (item["id"], name, transport, endpoint))
    return item
