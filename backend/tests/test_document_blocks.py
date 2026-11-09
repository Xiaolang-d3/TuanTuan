from io import BytesIO

from docx import Document
import pytest
from pydantic import ValidationError

from app.documents.parser import parse_document_result
from app.privacy import scan_and_redact
from document_fixtures import pdf_bytes


def test_pdf_blocks_keep_page_positions_and_blank_page_status():
    parsed = parse_document_result("three.pdf", pdf_bytes("FIRST PAGE", "", "LAST PAGE FACT"))
    assert hasattr(parsed, "blocks"), "structured document blocks are missing"
    assert [block.locator["page"] for block in parsed.blocks] == [1, 3]
    assert parsed.units[1]["status"] == "no_text"
    assert parsed.blocks[-1].text == "LAST PAGE FACT"
    assert "".join(block.text for block in parsed.blocks) == parsed.text


def test_docx_preserves_interleaved_paragraph_table_order():
    document = Document()
    document.add_paragraph("BEFORE")
    document.add_table(rows=1, cols=2).cell(0, 0).text = "TABLE"
    document.add_paragraph("AFTER")
    output = BytesIO()
    document.save(output)
    parsed = parse_document_result("ordered.docx", output.getvalue())
    assert hasattr(parsed, "blocks"), "structured document blocks are missing"
    assert [block.locator["kind"] for block in parsed.blocks] == ["docx_paragraph", "docx_table", "docx_paragraph"]
    assert parsed.text.index("BEFORE") < parsed.text.index("TABLE") < parsed.text.index("AFTER")
    assert all("page" not in block.locator for block in parsed.blocks)


def test_long_unit_splits_without_losing_text_or_private_identifiers():
    text = "x" * 893 + "reader@example.com" + "y" * 895 + " 13812345678 " + "z" * 28000
    parsed = parse_document_result("long.txt", text.encode())
    assert hasattr(parsed, "blocks"), "bounded document blocks are missing"
    assert "".join(block.text for block in parsed.blocks) == parsed.text
    model_text = "".join(block.model_text for block in parsed.blocks)
    assert model_text == scan_and_redact(parsed.text)[1]
    assert "reader@example.com" not in model_text and "13812345678" not in model_text
    assert all(len(block.text) <= 900 and len(block.model_text) <= 900 for block in parsed.blocks)
    assert len({block.block_id for block in parsed.blocks}) == len(parsed.blocks)


def test_block_ids_are_stable_for_same_parsing_and_change_with_structure():
    first = parse_document_result("one.pdf", pdf_bytes("SAME", "TEXT"))
    second = parse_document_result("two.pdf", pdf_bytes("SAME", "TEXT"))
    assert hasattr(first, "blocks"), "stable block identities are missing"
    assert [b.block_id for b in first.blocks] == [b.block_id for b in second.blocks]
    combined = parse_document_result("combined.pdf", pdf_bytes("SAME TEXT"))
    assert [b.block_id for b in first.blocks] != [b.block_id for b in combined.blocks]


def test_enhanced_plain_text_without_provenance_does_not_invent_pages(monkeypatch):
    from app.documents import parser
    monkeypatch.setattr(parser, "_parse_with_docling", lambda *args: "extracted content")
    parsed = parser._parse_document_result("enhanced.pdf", pdf_bytes("source"), "enhanced")
    assert hasattr(parsed, "blocks"), "provenance-aware fallback is missing"
    assert parsed.blocks[0].locator["kind"] == "text_range"
    assert parsed.blocks[0].locator["precise"] is False


def test_over_parse_limit_fails_without_a_partial_model_view():
    import pytest
    from app.documents.parser import MAX_DOCUMENT_CHARACTERS
    with pytest.raises(ValueError, match="处理范围"):
        parse_document_result("bounded.txt", ("x" * (MAX_DOCUMENT_CHARACTERS + 1)).encode())


def test_long_pdf_page_and_docx_table_are_bounded_without_text_loss():
    text = "long logical unit " * 1800
    pdf = parse_document_result("long.pdf", pdf_bytes(text))
    document = Document()
    document.add_paragraph(text)
    document.add_table(rows=1, cols=1).cell(0, 0).text = text
    output = BytesIO()
    document.save(output)
    word = parse_document_result("long.docx", output.getvalue())
    for parsed in (pdf, word):
        assert len(parsed.blocks) > 30
        assert "".join(b.text for b in parsed.blocks) == parsed.text
        assert all(len(b.text) <= 900 for b in parsed.blocks)
    assert {b.locator["page"] for b in pdf.blocks} == {1}
    assert {b.locator["kind"] for b in word.blocks} == {"docx_paragraph", "docx_table"}


@pytest.mark.parametrize("payload", [
    {"source_kind": "library", "source_id": 1, "attachment_id": "attachment"},
    {"source_kind": "attachment", "source_id": 1},
    {"source_kind": "library"},
])
def test_document_target_rejects_mixed_or_missing_identities(payload):
    from app.documents.blocks import DocumentTarget
    with pytest.raises(ValidationError):
        DocumentTarget(source_revision="a" * 64, **payload)
