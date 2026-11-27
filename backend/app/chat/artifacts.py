"""Read-only chat results and account-local, explicitly requested archives."""
from __future__ import annotations

import json
import re
import shutil
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from pydantic import BaseModel, Field

from ..attachments.service import get_attachment_download, get_attachment_metadata
from ..db import connect, json_dump, row_to_dict
from ..library.sources import _clean_title, _index_source, _safe_filename, _source_dir, get_source
from ..library.organization import list_folders
from ..privacy import scan_and_redact
from ..workspace import resolve_document_dir
from .image_assets import asset_metadata, asset_file


class ArtifactConflict(ValueError):
    pass


class SaveArtifactIn(BaseModel):
    selector: str = Field(min_length=1, max_length=150)
    snapshot: str = Field(pattern=r"^[a-f0-9]{64}$")
    filename: str = Field(min_length=1, max_length=200)
    folder_id: int | None = Field(default=None, ge=1)
    enabled: bool = False


EXTENSIONS = {
    "python": "py", "py": "py", "javascript": "js", "js": "js", "typescript": "ts",
    "ts": "ts", "tsx": "tsx", "jsx": "jsx", "json": "json", "html": "html", "css": "css",
    "sql": "sql", "bash": "sh", "sh": "sh", "shell": "sh", "yaml": "yaml", "yml": "yml",
    "go": "go", "rust": "rs", "java": "java", "c": "c", "cpp": "cpp", "markdown": "md",
    "md": "md", "mermaid": "mmd", "xml": "xml", "toml": "toml", "text": "txt",
}


def _snapshot(message: dict[str, Any], resources: list[dict[str, str]]) -> str:
    return sha256(json.dumps({**{k: message[k] for k in ("id", "role", "content", "payload")}, "resources": resources},
                             sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def _safe_url(raw: str) -> str:
    try:
        url = urlsplit(raw)
        if url.scheme not in {"http", "https"} or not url.hostname or url.username or url.password:
            return ""
        query = [(k, v) for k, v in parse_qsl(url.query) if not re.search(r"token|key|signature|credential", k, re.I)]
        return urlunsplit((url.scheme, url.netloc, url.path, urlencode(query), ""))
    except ValueError:
        return ""


def _sources(message: dict[str, Any]) -> list[dict[str, str]]:
    sources: list[dict[str, str]] = []
    for event in (message["payload"].get("agent") or {}).get("events", []):
        data = event.get("data") or {}
        if event.get("tool_name") in {"search_public_web", "research_company"}:
            for item in data.get("sources", []):
                if not isinstance(item, dict):
                    continue
                url = _safe_url(str(item.get("url") or ""))
                if url and not any(s.get("url") == url for s in sources):
                    sources.append({"title": " ".join(str(item.get("title") or url).split()), "url": url})
        if event.get("tool_name") == "search_library" and not data.get("evidence"):
            for item in data.get("excerpts", []):
                if isinstance(item, dict) and item.get("source_id") is not None:
                    source = {"title": " ".join(str(item.get("title") or "本地资料").split()), "source_id": str(item["source_id"])}
                    if source not in sources:
                        sources.append(source)
    for card in (message["payload"].get("agent") or {}).get("evidence", []):
        if isinstance(card, dict) and card.get("citation_id"):
            sources.append(card)
    return sources


def fenced_blocks(content: str) -> list[dict[str, Any]]:
    """Use source offsets as selectors; closed fences only, preserving exact code bytes."""
    blocks = []
    lines = content.splitlines(keepends=True)
    offset = 0
    opening = None
    body: list[str] = []
    for line in lines:
        if opening is None:
            match = re.match(r"^( {0,3})(`{3,}|~{3,})([^\r\n]*)[\r\n]*$", line)
            if match and not (match[2][0] == "`" and "`" in match[3]):
                opening = (offset + len(match[1]), match[2], match[3].strip().split()[0] if match[3].strip() else "text")
                body = []
        elif re.match(r"^ {0,3}" + re.escape(opening[1][0]) + "{" + str(len(opening[1])) + r",}\s*$", line):
            blocks.append({"offset": opening[0], "language": opening[2].lower(), "content": "".join(body)})
            opening = None
        else:
            body.append(line)
        offset += len(line)
    return blocks


def _manifest(message: dict[str, Any], db_path: str | Path | None) -> dict[str, Any]:
    agent = message["payload"].get("agent") or {}
    status = agent.get("status", "done")
    if status not in {"done", "failed", "cancelled"}:
        raise ArtifactConflict("生成尚未结束，请完成或停止后再保存成果")
    incomplete = message["role"] == "assistant" and status != "done"
    citations = _sources(message)
    artifacts = []
    resources = []
    images = []
    if message["role"] == "assistant":
        for ref in agent.get("assets", []):
            asset = asset_metadata(str(ref.get("id") or ""), db_path)
            if asset["conversation_id"] != message["conversation_id"] or asset["message_id"] != message["id"]:
                raise ValueError("图片不属于当前消息")
            images.append(asset)
            resources.append({"id": asset["id"], "sha256": asset["sha256"]})
    error_message = str((agent.get("error") or {}).get("message") or "").strip()
    error_only = status == "failed" and bool(error_message) and message["content"].strip() == error_message
    if message["role"] == "assistant" and (message["content"].strip() or images) and not (error_only and not images):
        content = message["content"]
        if images:
            by_id = {asset["id"]: asset for asset in images}
            content = "\n\n".join(b.get("text", "") if b.get("type") == "text" else
                                    f"![生成图片](assets/{b['asset_id']}{Path(by_id[b['asset_id']]['original_filename']).suffix})"
                                    for b in agent.get("output_blocks", []) if b.get("type") == "text" or b.get("asset_id") in by_id)
            if not content:
                content = message["content"] + "\n\n" + "\n\n".join(f"![生成图片](assets/{a['id']}{Path(a['original_filename']).suffix})" for a in images)
        if incomplete:
            content = "> 未完成：此内容来自已停止或失败的执行。\n\n" + content
        if citations:
            content += "\n\n---\n\n## 来源\n\n" + "\n".join(
                f"- {s['title']}：{s['url']}" if s.get("url") else f"- {s['title']}（" + (f"本地资料 ID：{s['source_id']}" if s.get("source_id") else f"对话附件：{s.get('attachment_id')}") + "）"
                for s in citations
            ) + "\n"
        artifacts.append({"selector": "answer", "kind": "answer", "filename": "回答.md",
                          "mime_type": "text/markdown", "content": content, "can_index": bool(message["content"].strip()),
                          **({"assets": images, "output_blocks": agent.get("output_blocks", [])} if images else {})})
        for index, block in enumerate(fenced_blocks(message["content"]), 1):
            ext = EXTENSIONS.get(block["language"], "txt")
            artifacts.append({"selector": f"code:{block['offset']}", "kind": "diagram" if ext == "mmd" else "code",
                              "filename": f"{'导图' if ext == 'mmd' else '代码'}-{index}.{ext}",
                              "mime_type": "text/plain", "content": block["content"], "can_index": bool(block["content"].strip())})
        for asset in images:
            artifacts.append({"selector": f"asset:{asset['id']}", "kind": "image", "filename": asset["original_filename"],
                              "mime_type": asset["content_type"], "asset": asset, "can_index": False})
    if message["role"] == "user":
        for ref in message["payload"].get("attachments", []):
            attachment = get_attachment_metadata(str(ref.get("id") or ""), db_path=db_path)
            if attachment["conversation_id"] != message["conversation_id"]:
                raise ValueError("附件不属于当前对话")
            resources.append({"id": attachment["id"], "sha256": attachment["sha256"],
                              "text_hash": sha256(attachment.get("parsed_text", "").encode()).hexdigest(),
                              "parse_status": attachment["parse_status"]})
            artifacts.append({"selector": f"attachment:{attachment['id']}", "kind": "attachment",
                              "filename": attachment["original_filename"], "mime_type": attachment["content_type"],
                              "attachment_id": attachment["id"], "can_index": bool(attachment.get("parsed_text", "").strip())})
    return {"message_id": message["id"], "snapshot": _snapshot(message, resources), "incomplete": incomplete,
            "artifacts": artifacts, "sources": citations, "folders": list_folders(db_path)}


def message_artifacts(message_id: int, db_path: str | Path | None = None) -> dict[str, Any]:
    with connect(db_path) as conn:
        message = row_to_dict(conn.execute("SELECT * FROM chat_messages WHERE id = ?", (message_id,)).fetchone())
    if message is None:
        raise ValueError("消息不存在")
    return _manifest(message, db_path)


def write_archive_snapshot(conn, *, filename, mime_type, source_uri, text, data, metadata, enabled, copies=(), db_path=None):
    """Write one account-local snapshot; chat and authored documents share copies."""
    status = metadata["text_parse_status"]
    cursor = conn.execute("""INSERT INTO library_sources
        (source_kind, title, original_filename, mime_type, source_uri, content, redacted_content,
         privacy_mode, enabled, parse_status, content_hash, character_count, metadata_json)
        VALUES ('upload', ?, ?, ?, ?, ?, ?, 'redacted', ?, ?, ?, ?, ?)""",
        (_clean_title(Path(filename).stem), filename, mime_type, source_uri, text, scan_and_redact(text)[1],
         int(enabled), "ready" if status == "not_required" else status, sha256(data).hexdigest(), len(text), json_dump(metadata)))
    source_id = int(cursor.lastrowid)
    directory = _source_dir(source_id, db_path)
    try:
        stored = directory / filename
        stored.write_bytes(data)
        stored.chmod(0o600)
        if copies:
            image_directory = directory / "assets"
            image_directory.mkdir(mode=0o700)
            for asset, image_data in copies:
                target = image_directory / f"{asset['id']}{Path(asset['original_filename']).suffix}"
                target.write_bytes(image_data)
                target.chmod(0o600)
        conn.execute("UPDATE library_sources SET stored_path=? WHERE id=?", (stored.relative_to(resolve_document_dir(db_path)).as_posix(), source_id))
    except Exception:
        # Cleanup is inside the caller's write transaction, before an ID can be
        # reused by another archive. Never follow a directory outside storage.
        if directory.resolve().is_relative_to(resolve_document_dir(db_path).resolve()) and not directory.is_symlink():
            shutil.rmtree(directory, ignore_errors=True)
        raise
    return source_id, directory


def save_artifact(message_id: int, request: SaveArtifactIn, db_path: str | Path | None = None) -> dict[str, Any]:
    directory: Path | None = None
    try:
        with connect(db_path) as conn:
            conn.execute("BEGIN IMMEDIATE")
            message = row_to_dict(conn.execute("SELECT * FROM chat_messages WHERE id = ?", (message_id,)).fetchone())
            if message is None:
                raise ValueError("消息不存在")
            manifest = _manifest(message, db_path)
            if request.snapshot != manifest["snapshot"]:
                raise ArtifactConflict("回答已更新，请重新打开成果后再保存")
            artifact = next((item for item in manifest["artifacts"] if item["selector"] == request.selector), None)
            if artifact is None:
                raise ValueError("所选成果不存在")
            if request.enabled and not artifact["can_index"]:
                raise ValueError("该成果没有可检索文字，请只保存原文件")
            if request.folder_id is not None and not conn.execute("SELECT 1 FROM library_folders WHERE id = ?", (request.folder_id,)).fetchone():
                raise ValueError("目标文件夹不存在")
            filename = _safe_filename(request.filename)
            suffix = Path(artifact["filename"]).suffix
            if Path(filename).suffix.lower() != suffix.lower():
                raise ValueError(f"请保留原文件扩展名 {suffix}")
            key = sha256(json_dump([message_id, request.snapshot, request.selector, filename, request.folder_id, request.enabled]).encode()).hexdigest()
            previous = conn.execute("SELECT id FROM library_sources WHERE json_extract(metadata_json, '$.chat_archive.key') = ? AND json_extract(metadata_json, '$.organization.trashed_at') IS NULL", (key,)).fetchone()
            if previous:
                source_id = previous["id"]
                reused = True
            else:
                reused = False
                text = artifact.get("content", "")
                copies = []
                if artifact["kind"] == "attachment":
                    attachment = get_attachment_metadata(artifact["attachment_id"], db_path=db_path)
                    content, _, _ = get_attachment_download(artifact["attachment_id"], db_path=db_path)
                    data = content if isinstance(content, bytes) else content.read_bytes()
                    if sha256(data).hexdigest() != attachment["sha256"]:
                        raise ArtifactConflict("附件原文件已变化，请重新上传后再保存")
                    text = str(attachment.get("parsed_text") or "")
                elif artifact["kind"] == "image":
                    asset = artifact["asset"]
                    data = asset_file(asset["id"], db_path)[0].read_bytes()
                    if sha256(data).hexdigest() != asset["sha256"]:
                        raise ArtifactConflict("图片原文件已变化，请重新打开成果")
                else:
                    data = text.encode("utf-8")
                    for asset in artifact.get("assets", []):
                        image_data = asset_file(asset["id"], db_path)[0].read_bytes()
                        if sha256(image_data).hexdigest() != asset["sha256"]:
                            raise ArtifactConflict("图片原文件已变化，请重新打开成果")
                        copies.append((asset, image_data))
                    if copies:
                        # Markdown references belong to the original file; they
                        # are not OCR text or facts the knowledge index can read.
                        text = re.sub(r"!\[生成图片\]\(assets/[a-f0-9]{32}\.(?:png|jpg|webp)\)", "", text).strip()
                if len(text) > 200_000:
                    raise ValueError("成果正文不能超过 20 万字")
                text_status = "ready" if text.strip() else "not_required"
                if artifact["kind"] == "attachment" and attachment["kind"] == "document" and not text.strip():
                    text_status = "failed" if attachment["parse_status"] == "failed" else "pending"
                metadata = {"size_bytes": len(data), "file_status": "ready", "text_parse_status": text_status,
                            "organization": {"folder_id": request.folder_id},
                            "chat_archive": {"key": key, "origin": "uploaded" if artifact["kind"] == "attachment" else "generated",
                                             "conversation_id": message["conversation_id"], "message_id": message_id,
                                             "selector": request.selector, "snapshot": request.snapshot,
                                             "incomplete": manifest["incomplete"], "model_name": (message["payload"].get("agent") or {}).get("model_selection", {}).get("model_name", ""),
                                             "sources": manifest["sources"]}}
                if copies:
                    metadata["chat_assets"] = [{**{k: a[k] for k in ("id", "content_type", "original_filename", "sha256", "width", "height")},
                                                "path": f"assets/{a['id']}{Path(a['original_filename']).suffix}"} for a, _ in copies]
                if artifact["kind"] == "image":
                    metadata["generated_image"] = {k: artifact["asset"][k] for k in ("model_name", "sha256", "width", "height")}
                run = conn.execute("SELECT run_id FROM agent_execution_runs WHERE assistant_message_id = ? ORDER BY created_at DESC LIMIT 1", (message_id,)).fetchone()
                selection = (message["payload"].get("agent") or {}).get("model_selection") or {}
                execute = (selection.get("stage_selections") or {}).get("execute") or selection
                metadata["chat_archive"].update(saved_at=datetime.now(timezone.utc).isoformat(), run_id=run["run_id"] if run else None,
                                               model_name=execute.get("model_name") or selection.get("model_name", ""),
                                               model_selection={key: execute[key] for key in ("profile_id", "profile_revision", "connection_id", "connection_revision") if key in execute})
                source_id, directory = write_archive_snapshot(conn, filename=filename, mime_type=artifact["mime_type"],
                    source_uri=f"chat:{message['conversation_id']}/{message_id}", text=text, data=data, metadata=metadata,
                    enabled=request.enabled, copies=copies, db_path=db_path)
    except Exception:
        if directory is not None:
            shutil.rmtree(directory, ignore_errors=True)
        raise
    source = get_source(source_id, db_path=db_path)
    if source["content"] and not source.get("source_revision"):
        from ..documents.blocks import text_document
        from ..library.source_versions import save_source_version, source_state, get_attachment_version
        parsed = text_document(source["content"], parser="chat_archive")
        if artifact["kind"] == "attachment":
            state = source_state("attachment", artifact["attachment_id"], db_path)
            if state.get("source_revision"):
                version = get_attachment_version(artifact["attachment_id"], state["source_revision"], db_path,
                                                 conversation_id=message["conversation_id"])
                # The archive's frozen body must match before copying positions.
                # Older attachments without a matching version keep text ranges.
                if version["text"] == source["content"]:
                    from ..documents.blocks import DocumentBlock
                    from ..documents.parser import DocumentParseResult
                    parsed = DocumentParseResult(source["content"], "attachment_archive",
                        blocks=[DocumentBlock(**block) for block in version["blocks"]],
                        complete=version["complete"], units=version["units"],
                        unprocessed_ranges=version["unprocessed_ranges"])
        save_source_version(source_id, parsed, db_path)
        source = get_source(source_id, db_path=db_path)
    _index_source(source, db_path)
    return {"source": source, "reused": reused}
