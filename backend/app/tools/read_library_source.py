"""Deliver whole authorized blocks; a cursor never skips governed-away text."""
from __future__ import annotations

import base64
import binascii
import json
from hashlib import sha256
from pathlib import Path
from typing import Any

from pydantic import Field

from ..agent.citations import LOCAL_CITATION_GUIDANCE
from ..agent.settings import get_agent_settings
from ..documents.blocks import DocumentTarget, MAX_BLOCK_CHARACTERS
from ..domain import ToolDefinition, ToolResult
from ..library.evidence import _resolve, _evidence_card
from ..workspace import current_user_id, resolve_db_path
from .base import ToolContext
from .errors import tool_error_boundary


class ReadArguments(DocumentTarget):
    cursor: str | None = Field(default=None, max_length=256)
    max_blocks: int = Field(default=20, ge=1, le=20)
    max_characters: int = Field(default=12000, ge=MAX_BLOCK_CHARACTERS, le=12000)


def _binding(target, db_path):
    return sha256(json.dumps([current_user_id(), str(resolve_db_path(db_path)), target.model_dump(exclude_none=True)], sort_keys=True).encode()).hexdigest()


def _cursor(binding, offset):
    data = json.dumps({"v": 1, "target": binding, "offset": offset}, separators=(",", ":")).encode()
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def _offset(cursor, binding):
    if cursor is None:
        return 0
    try:
        data = json.loads(base64.b64decode(cursor + "=" * (-len(cursor) % 4), altchars=b"-_", validate=True))
        if (not isinstance(data, dict) or data.get("v") != 1 or data.get("target") != binding
                or type(data.get("offset")) is not int or data["offset"] < 0):
            raise ValueError
        return data["offset"]
    except (ValueError, TypeError, UnicodeError, binascii.Error):
        raise ValueError("游标不合法或与当前来源版本不匹配") from None


class ReadLibrarySourceTool:
    definition = ToolDefinition(
        name="read_library_source",
        description="按版本分页读取已获准的本地资料或当前对话附件。原样传递 next_cursor，has_more=false 仅表示已返回本版本可处理的块；extraction_complete=false 时不能称全文已处理。" + LOCAL_CITATION_GUIDANCE,
        input_schema=ReadArguments.model_json_schema(),
    )
    arguments_model = ReadArguments

    def __init__(self, db_path: str | Path | None = None):
        self._db_path = db_path

    @tool_error_boundary("读取资料失败")
    async def execute(self, arguments: dict[str, Any], context: ToolContext) -> ToolResult:
        payload = ReadArguments.model_validate(arguments)
        target = DocumentTarget(**payload.model_dump(include={"source_kind", "source_id", "attachment_id", "source_revision"}))
        if target.source_kind == "attachment" and context.conversation_id is None:
            raise ValueError("读取附件需要当前对话")
        if target.source_kind == "library":
            if not context.library_read_allowed:
                raise ValueError("本轮未授权读取资料库，可单独读取当前对话附件")
            settings = get_agent_settings(self._db_path)
            if not settings["library_memory_enabled"] or not settings["knowledge_memory_enabled"]:
                return ToolResult(ok=True, status="done", data={"blocks": [], "evidence": [], "next_cursor": None, "has_more": False, "disabled": True}, message="知识库读取已关闭")
        automatic = target.source_kind == "library"
        source, version, original = _resolve(target, self._db_path, conversation_id=context.conversation_id, automatic=automatic)
        binding = _binding(target, self._db_path)
        offset = _offset(payload.cursor, binding)
        blocks = version["blocks"]
        if offset > len(blocks) or (payload.cursor and offset == len(blocks)):
            raise ValueError("游标超出此版本的可读范围")
        data = {**target.model_dump(exclude_none=True), "blocks": [], "evidence": [],
                "next_cursor": None, "has_more": False, "total_blocks": len(blocks),
                "extraction_complete": version["complete"], "unprocessed_count": len(version["unprocessed_ranges"])}
        used = 0
        for index in range(offset, min(len(blocks), offset + payload.max_blocks)):
            block = blocks[index]
            card = _evidence_card(target, source, block, original=original, automatic=automatic)
            if used + len(card["excerpt"]) > payload.max_characters:
                break
            has_more = index + 1 < len(blocks)
            candidate = {**data,
                "blocks": [*data["blocks"], {"block_id": block["block_id"], "ordinal": block["ordinal"], "text": card["excerpt"], "locator": card["locator"]}],
                "evidence": [*data["evidence"], card],
                "has_more": has_more, "next_cursor": _cursor(binding, index + 1) if has_more else None}
            if len(json.dumps(candidate, ensure_ascii=False)) > 31000:
                break
            data = candidate
            used += len(card["excerpt"])
        if offset < len(blocks) and not data["blocks"]:
            raise ValueError("当前片段无法在结果预算内完整返回")
        return ToolResult(ok=True, status="done", data=data, message=f"已返回 {len(data['blocks'])} 个完整片段；" + ("尚有后续片段" if data["has_more"] else "已到此版本可处理范围末尾"))
