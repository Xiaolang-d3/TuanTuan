"""Portable exports preserve saved structure, resources and readable provenance."""
from io import BytesIO
from zipfile import ZipFile

import pytest
from docx import Document
from pypdf import PdfReader

from app.artifacts.document_rendering import render_document
from test_document_artifacts import document


def saved_document(fixture):
    store, context = fixture["store"], fixture["context"]
    first = store.create(**fixture["request"])
    resource = first["resources"][0]
    markdown = (f"# 中文交付方案\n\n日期结论 [[cite:{fixture['card']['citation_id']}]]\n\n"
                "- 核对**全部资料**\n- 确认责任人\n\n3. 第三项\n4. 第四项\n\n"
                "| 工作 | 状态 |\n| --- | --- |\n| 交付验收 | 待确认 |\n\n"
                f"![交付示意图]({resource['uri']})\n\n图片之后的最后结论。")
    saved = store.save(first["document_id"], base_version=1, markdown=markdown, idempotency_key="export-fixture-v2", context=context)
    load = lambda resource_id: store.resource(saved["document_id"], resource_id, context)[0].read_bytes()
    return saved, load


def test_docx_reopens_with_title_lists_table_image_and_readable_sources(document):
    saved, load = saved_document(document)
    data = render_document(saved, format="docx", resource_loader=load)
    doc = Document(BytesIO(data))
    text = "\n".join(paragraph.text for paragraph in doc.paragraphs)
    assert "中文交付方案" in text and "图片之后的最后结论。" in text
    assert "核对依据" in text and "未核对" in text
    assert "[[cite:" not in text and document["card"]["citation_id"] not in text
    assert doc.paragraphs[0].style.name == "Title"
    assert str(doc.styles["Title"].font.color.rgb) == "000000"
    assert not doc.styles["Title"]._element.xpath(".//w:pBdr")
    assert any(paragraph.style.name == "List Bullet" for paragraph in doc.paragraphs)
    assert any(paragraph.style.name == "List Number" for paragraph in doc.paragraphs)
    numbered = next(paragraph for paragraph in doc.paragraphs if paragraph.text == "第三项")
    num_id = numbered._p.pPr.numPr.numId.val
    number = doc.part.numbering_part.element.xpath(f'./w:num[@w:numId="{num_id}"]')[0]
    assert number.xpath('./w:lvlOverride/w:startOverride')[0].val == 3
    assert doc.tables[0].cell(1, 0).text == "交付验收"
    assert len(doc.inline_shapes) == 1
    with ZipFile(BytesIO(data)) as archive:
        assert not any(b"TargetMode=\"External\"" in archive.read(name) for name in archive.namelist() if name.endswith(".rels"))


def test_pdf_contains_visible_chinese_image_and_human_citation_labels(document):
    saved, load = saved_document(document)
    reader = PdfReader(BytesIO(render_document(saved, format="pdf", resource_loader=load)))
    text = "\n".join(page.extract_text() for page in reader.pages)
    assert "中文交付方案" in text and "图片之后的最后结论。" in text
    assert "核对依据" in text and "未核对" in text and "[[cite:" not in text
    assert "第三项" in text and "交付验收" in text
    assert any(list(page.images) for page in reader.pages)


@pytest.mark.parametrize("format", ["docx", "pdf"])
def test_export_rejects_foreign_images_before_loading_any_resource(document, format):
    saved, _ = saved_document(document)
    saved["markdown"] += "\n\n![外链](https://example.test/private.png)"
    def forbidden(_resource_id):
        raise AssertionError("Untrusted image caused a resource read")
    with pytest.raises(ValueError, match="图片"):
        render_document(saved, format=format, resource_loader=forbidden)


def test_export_size_is_bounded_without_changing_source_version(document, monkeypatch):
    import app.artifacts.document_rendering as rendering
    saved, load = saved_document(document)
    monkeypatch.setattr(rendering, "MAX_EXPORT_BYTES", 128)
    with pytest.raises(ValueError, match="64|大小"):
        render_document(saved, format="docx", resource_loader=load)
    assert document["store"].get(saved["document_id"], 2, document["context"])["markdown"] == saved["markdown"]


def test_large_chinese_table_splits_without_duplicate_headers_or_lost_cell_characters(document):
    saved, load = saved_document(document)
    rows = ["| 编号 | 工作说明 | 状态 |", "| --- | --- | --- |"]
    rows += [f"| {i} | " + "资料核对与交付验收。" * (130 if i == 8 else 3) + " | 等待确认 |" for i in range(1, 46)]
    saved["markdown"] = "# 长表导出验收\n\n" + "\n".join(rows)
    reader = PdfReader(BytesIO(render_document(saved, format="pdf", resource_loader=load)))
    text = "".join(page.extract_text() for page in reader.pages)
    assert 3 <= len(reader.pages) <= 12
    assert text.split("资料来源", 1)[0].count("核") == 44 * 3 + 130
    assert "核对依据" in text
    assert all(page.extract_text().count("工作说明") <= 1 for page in reader.pages)


def test_pdf_fails_clearly_for_missing_glyphs_instead_of_silent_boxes(document):
    saved, load = saved_document(document)
    saved["markdown"] += "\n\n" + chr(0x10FFFF)
    with pytest.raises(ValueError, match="字符|字体"):
        render_document(saved, format="pdf", resource_loader=load)


@pytest.mark.parametrize("format", ["pdf", "docx"])
def test_sources_without_local_citation_ids_remain_readable(document, format):
    saved, load = saved_document(document)
    saved["evidence"].append({"title": "网页资料", "url": "https://example.test/report"})
    saved["evidence"].append({"title": "旧版资料来源", "source_id": 42})
    data = render_document(saved, format=format, resource_loader=load)
    if format == "pdf":
        text = "\n".join(page.extract_text() for page in PdfReader(BytesIO(data)).pages)
    else:
        text = "\n".join(paragraph.text for paragraph in Document(BytesIO(data)).paragraphs)
    assert "网页资料" in text and "https://example.test/report" in text
    assert "旧版资料来源" in text
