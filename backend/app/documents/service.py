from __future__ import annotations

from pathlib import Path
from typing import Any
from dataclasses import asdict

from ..privacy import scan_and_redact
from ..documents.parser import parse_document_result


def parse_document_upload(
    filename: str,
    content: bytes,
    mode: str,
) -> dict[str, Any]:
    suffix = Path(filename).suffix.lower()
    document_data = {}
    if suffix in {".png", ".jpg", ".jpeg", ".webp"}:
        from ..documents.ocr import extract_image_text

        text = extract_image_text(filename, content)
        parser = "local_ocr"
        warnings = ["截图 OCR 结果可能受清晰度和裁剪范围影响，请保存前检查文本。"]
    else:
        parsed = parse_document_result(filename, content, mode)
        text = parsed.text
        parser = parsed.parser
        warnings = parsed.warnings
        document_data = {"blocks": [asdict(block) for block in parsed.blocks], "extracted_characters": parsed.extracted_characters,
                         "complete": parsed.complete, "unprocessed_ranges": parsed.unprocessed_ranges, "units": parsed.units}
    findings, redacted_text = scan_and_redact(text)
    return {
        "filename": filename[:255],
        "text": text,
        "redacted_text": redacted_text,
        "privacy_findings": findings,
        "character_count": len(text),
        "parser": parser,
        "warnings": warnings,
        **document_data,
        "notice": "仅完成本地文本提取；原文保留，默认仅向模型提供脱敏文本。保存前不会写入知识库。",
    }


def scan_document_privacy(text: str) -> dict[str, Any]:
    findings, redacted_text = scan_and_redact(text)
    return {
        "findings": findings,
        "redacted_text": redacted_text,
        "notice": "检测在本机完成；结果用于提醒，保存和是否向 Agent 提供原文仍由你决定。",
    }
