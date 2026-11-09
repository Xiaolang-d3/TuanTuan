"""Bounded, immutable text blocks with source positions and privacy mapping."""
from __future__ import annotations

from dataclasses import asdict, dataclass
from hashlib import sha256
import json
from typing import Literal, Self

from pydantic import BaseModel, ConfigDict, Field, model_validator

from ..privacy import scan_and_redact

BLOCK_SCHEMA_VERSION = 1
MAX_BLOCK_CHARACTERS = 900


class DocumentTarget(BaseModel):
    model_config = ConfigDict(frozen=True, extra="forbid")
    source_kind: Literal["library", "attachment"]
    source_id: int | None = Field(default=None, gt=0)
    attachment_id: str | None = Field(default=None, min_length=1, max_length=64)
    source_revision: str = Field(pattern=r"^[0-9a-f]{64}$")

    @model_validator(mode="after")
    def exclusive_identity(self) -> Self:
        if self.source_kind == "library":
            valid = self.source_id is not None and self.attachment_id is None
        else:
            valid = self.attachment_id is not None and self.source_id is None
        if not valid:
            raise ValueError("来源和附件身份必须互斥，且与来源类型一致")
        return self


@dataclass(frozen=True)
class DocumentBlock:
    block_id: str
    ordinal: int
    text: str
    model_text: str
    locator: dict

    def to_dict(self) -> dict:
        return asdict(self)


def build_blocks(segments: list[tuple[str, dict]], *, limit: int | None = None):
    """Scan before splitting: a block boundary must not expose half an identifier."""
    nonempty = [(text, dict(locator)) for text, locator in segments if text]
    full_text = "\n".join(text for text, _ in nonempty)
    findings, _ = scan_and_redact(full_text)
    replacements = [(f["start"], f["end"], scan_and_redact(full_text[f["start"]:f["end"]])[1]) for f in findings]
    text = full_text if limit is None else full_text[:limit]

    def redacted_range(start: int, end: int) -> str:
        cursor, parts = start, []
        for left, right, replacement in replacements:
            if right <= cursor or left >= end:
                continue
            if left > cursor:
                parts.append(full_text[cursor:left])
            if left >= start:
                parts.append(replacement)
            cursor = min(end, max(cursor, right))
        parts.append(full_text[cursor:end])
        return "".join(parts)

    blocks, offset = [], 0
    structure = sha256(json.dumps([(t, loc) for t, loc in nonempty], sort_keys=True, ensure_ascii=False).encode()).hexdigest()
    for unit_index, (content, locator) in enumerate(nonempty):
        unit_text = content + ("\n" if unit_index < len(nonempty) - 1 else "")
        unit_start, unit_end = offset, min(offset + len(unit_text), len(text))
        while offset < unit_end:
            end = min(offset + MAX_BLOCK_CHARACTERS, unit_end)
            model_text = redacted_range(offset, end)
            while len(model_text) > MAX_BLOCK_CHARACTERS:
                end -= max(1, len(model_text) - MAX_BLOCK_CHARACTERS)
                model_text = redacted_range(offset, end)
            position = {**locator, "start": offset - unit_start, "end": end - unit_start,
                        "text_start": offset, "text_end": end}
            identity = f"{BLOCK_SCHEMA_VERSION}:{structure}:{offset}:{end}"
            blocks.append(DocumentBlock(sha256(identity.encode()).hexdigest()[:32], len(blocks), text[offset:end], model_text, position))
            offset = end
        offset = unit_start + len(unit_text)
        if offset >= len(text):
            break
    unprocessed = [{"start": len(text), "end": len(full_text), "reason": "character_limit"}] if len(text) < len(full_text) else []
    return text, blocks, len(full_text), unprocessed


def text_document(text: str, *, parser: str = "saved_text"):
    from .parser import DocumentParseResult
    content, blocks, count, unprocessed = build_blocks([(text, {"kind": "text_range", "precise": True})])
    return DocumentParseResult(content, parser, blocks=blocks, extracted_characters=count,
                               complete=not unprocessed, unprocessed_ranges=unprocessed)
