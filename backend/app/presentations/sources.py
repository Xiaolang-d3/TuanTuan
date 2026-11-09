"""Stage current-account attachments as immutable, bounded presentation inputs."""
from __future__ import annotations

import hashlib
import re
from pathlib import Path

from ..attachments import service as attachments
from ..execution.workspace_files import WorkspaceFiles
from ..extensions.contracts import ExtensionContext
from .validation import validate_raster

MAX_SOURCES = 20
MAX_SOURCE_BYTES = 64 * 1024 * 1024
MAX_SOURCE_TEXT_BYTES = 180_000


def stage_sources(attachment_ids: list[str], root: Path, context: ExtensionContext) -> list[dict]:
    context.check_workspace()
    if not isinstance(attachment_ids, list) or len(attachment_ids) > MAX_SOURCES:
        raise ValueError("演示文稿最多使用 20 个附件")
    if any(not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{32}", value) for value in attachment_ids) or len(set(attachment_ids)) != len(attachment_ids):
        raise ValueError("附件标识无效或重复")
    # Resolve every identity before parsing or creating any project files. Database
    # selection is inherited from the explicitly checked account workspace.
    rows = [attachments.get_attachment(value) for value in attachment_ids]
    if any(row is None for row in rows):
        raise FileNotFoundError("附件不存在")
    if sum(row["size_bytes"] for row in rows) > MAX_SOURCE_BYTES:
        raise ValueError("附件总大小超过 64 MB")
    staged, total_bytes, text_bytes = [], 0, 0
    store = attachments.get_attachment_store()
    for row in rows:
        context.check_workspace()
        kind, attachment_id = row["kind"], row["id"]
        if kind not in attachments.MAX_BYTES:
            raise ValueError("不支持的演示文稿附件类型")
        if row["size_bytes"] > attachments.MAX_BYTES[kind]:
            raise ValueError("附件大小超过限制")
        content = store.get(row["object_key"])
        if len(content) != row["size_bytes"] or hashlib.sha256(content).hexdigest() != row["sha256"]:
            raise ValueError("附件内容校验失败，请重新上传")
        total_bytes += len(content)
        if total_bytes > MAX_SOURCE_BYTES:
            raise ValueError("附件总大小超过 64 MB")
        if kind == "image":
            attachments.validate_attachment(kind, row["original_filename"], content)
            validate_raster(content)
            suffix = Path(row["original_filename"]).suffix.lower()
            relative = f"images/{attachment_id}{suffix}"
        else:
            if row["parse_status"] != "parsed":
                attachments.parse_attachment(attachment_id, store=store)
                row = attachments.get_attachment(attachment_id)
            # Respect the existing privacy pipeline; never silently replace an
            # intentionally empty redacted result with the private original.
            text = row["redacted_text"] if row["redacted_text"] is not None else row["parsed_text"]
            if not text or not text.strip():
                raise ValueError("附件未提取到可用文字")
            content = text.encode("utf-8")
            text_bytes += len(content)
            if text_bytes > MAX_SOURCE_TEXT_BYTES:
                raise ValueError("附件文字过多，请精简内容后重新制作")
            relative = f"sources/{attachment_id}.md"
        staged.append((relative, content, {
            "attachment_id": attachment_id, "kind": kind, "path": relative,
            "sha256": hashlib.sha256(content).hexdigest(), "size_bytes": len(content),
        }))
    # Preflight all inputs before writing; do not use user filenames as paths.
    context.check_workspace()
    files = WorkspaceFiles(root)
    for relative, content, _ in staged:
        files.write(relative, content, limit=attachments.MAX_BYTES["image"])
    return [item[2] for item in staged]
