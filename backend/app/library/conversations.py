"""Copy explicitly selected source text into a new conversation's attachments."""
from pathlib import Path
from hashlib import sha256
from typing import Any

from pydantic import BaseModel, Field

from ..attachments.service import create_attachment, delete_attachment, index_attachment
from ..chat.conversations import create_conversation, delete_conversation
from ..db import connect, json_dump
from .sources import get_source
from .source_versions import get_source_version, save_attachment_version
from ..documents.blocks import DocumentBlock, text_document
from ..documents.parser import DocumentParseResult


class LibraryConversationIn(BaseModel):
    source_ids: list[int] = Field(min_length=1, max_length=8)


def prepare_conversation(source_ids: list[int], db_path: str | Path | None = None) -> dict[str, Any]:
    if not source_ids or len(source_ids) > 8 or any(type(item) is not int or item <= 0 for item in source_ids):
        raise ValueError("一次对话请选择 1–8 个文件")
    sources = [get_source(source_id, db_path) for source_id in dict.fromkeys(source_ids)]
    if any(source["trashed_at"] or source["parse_status"] != "ready" or not source["content"].strip() for source in sources):
        raise ValueError("请先恢复文件或补充提取文字，再用于对话")
    conversation = create_conversation(f"资料：{sources[0]['title']}"[:80], db_path)
    attachments: list[dict[str, Any]] = []
    try:
        for source in sources:
            content = source["content"] if source["privacy_mode"] == "original" else source["redacted_content"]
            attachment = create_attachment(conversation["id"], "document", f"{source['title']}.txt", content.encode("utf-8"), db_path=db_path)
            attachments.append(attachment)
            metadata = {"character_count": len(content), "library_source_id": source["id"],
                        "library_source_revision": source.get("source_revision"),
                        "library_source_title": source["title"], "library_snapshot_hash": sha256(content.encode("utf-8")).hexdigest(),
                        "library_source_updated_at": source["updated_at"],
                        "privacy_mode": source["privacy_mode"], "parser": "library_snapshot"}
            with connect(db_path) as conn:
                conn.execute("UPDATE attachments SET parse_status = 'parsed', parsed_text = ?, redacted_text = ?, metadata_json = ? WHERE id = ?", (content, content, json_dump(metadata), attachment["id"]))
            attachment.update(parse_status="parsed", metadata=metadata)
            if source.get("source_revision"):
                version = get_source_version(source["id"], source["source_revision"], db_path)
                blocks = [DocumentBlock(b["block_id"], b["ordinal"], b["text"] if source["privacy_mode"] == "original" else b["model_text"], b["model_text"], b["locator"]) for b in version["blocks"]]
                parsed = DocumentParseResult(content, "library_snapshot", blocks=blocks, complete=version["complete"],
                                             units=version["units"], unprocessed_ranges=version["unprocessed_ranges"])
            else:
                parsed = text_document(content, parser="library_snapshot")
            save_attachment_version(attachment["id"], parsed, db_path)
            index_attachment(attachment["id"], db_path=db_path)
    except Exception:
        for attachment in attachments:
            delete_attachment(attachment["id"], db_path=db_path)
        delete_conversation(conversation["id"], db_path)
        raise
    return {"conversation": conversation, "attachments": attachments}
