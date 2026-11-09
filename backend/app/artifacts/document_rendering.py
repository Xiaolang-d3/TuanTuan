"""Bounded offline rendering of an explicit saved document and its owned images."""
from __future__ import annotations

from functools import lru_cache
import hashlib
from io import BytesIO
import json
from pathlib import Path
import threading
import uuid
from xml.sax.saxutils import escape

from .documents import _citation, _parser, _validate

MAX_EXPORT_BYTES = 64 * 1024 * 1024
FONT_ROOT = Path(__file__).with_name("fonts")
FONT_FAMILY = "Tuantuan Document"
_pdf_lock = threading.RLock()


class _BoundedBuffer(BytesIO):
    def write(self, value):
        if self.tell() + len(value) > MAX_EXPORT_BYTES:
            raise ValueError("导出文件超过 64 MiB 大小上限，请使用 Markdown 或 TXT")
        return super().write(value)


@lru_cache(maxsize=1)
def _font_manifest():
    return json.loads((FONT_ROOT / "manifest.json").read_text(encoding="utf-8"))


def font_bytes(style):
    filename = f"TuantuanDocument-{style}.ttf"
    content = (FONT_ROOT / filename).read_bytes()
    if hashlib.sha256(content).hexdigest() != _font_manifest()["files"][filename]["sha256"]:
        raise ValueError("中文导出字体校验失败，请修复团团安装")
    return content


def _source_label(card):
    title = card.get("source_title") or card.get("title") or "本地来源"
    locator = card.get("locator") or {}
    if locator.get("page"):
        title += f" · 第 {locator['page']} 页"
    elif locator.get("paragraph"):
        title += f" · 第 {locator['paragraph']} 段"
    if card.get("url"):
        title += " · " + str(card["url"])
    return title


def _blocks(document):
    _validate(document["markdown"], document["resources"])
    sources = [card for card in document.get("evidence", []) if isinstance(card, dict)]
    cards = {card["citation_id"]: card for card in sources if card.get("citation_id")}
    statuses = {card["citation_id"]: card.get("status") for card in document.get("citations", []) if isinstance(card, dict) and card.get("citation_id")}
    references = {}
    def reference(match):
        key = match.group(1)
        if key not in references:
            references[key] = len(references) + 1
        return f"[{references[key]}]"
    images = {resource["uri"]: resource["id"] for resource in document["resources"]}
    def inline(tokens):
        bold, italic, runs = False, False, []
        for token in tokens or []:
            if token.type in {"strong_open", "strong_close"}:
                bold = token.type == "strong_open"
            elif token.type in {"em_open", "em_close"}:
                italic = token.type == "em_open"
            elif token.type == "image":
                runs.append({"image": images[token.attrGet("src")], "alt": token.content})
            elif token.type in {"text", "code_inline", "html_inline"}:
                text = _citation.sub(reference, token.content) if token.type == "text" else token.content
                runs.append({"text": text, "bold": bold, "italic": italic, "code": token.type == "code_inline"})
            elif token.type in {"softbreak", "hardbreak"}:
                runs.append({"text": "\n"})
        return runs
    blocks, lists, table, row, cell = [], [], None, None, None
    list_serial = 0
    kind, level, prefix, list_kind = "paragraph", 0, "", ""
    tokens = _parser.parse(document["markdown"])
    if len(tokens) > 50_000:
        raise ValueError("文档结构过于复杂，请拆分后导出或使用 Markdown")
    for token in tokens:
        if token.type == "table_open":
            table = []
        elif token.type == "tr_open":
            row = []; table.append(row)
        elif token.type in {"th_open", "td_open"}:
            cell = []; row.append(cell)
        elif token.type in {"th_close", "td_close"}:
            cell = None
        elif token.type == "table_close":
            if len(table) > 2_000 or max(map(len, table), default=0) > 12:
                raise ValueError("表格超过当前导出容量，请拆分表格或使用 Markdown")
            blocks.append({"kind": "table", "rows": table}); table = None
        elif token.type in {"bullet_list_open", "ordered_list_open"}:
            list_serial += 1
            lists.append({"id": list_serial, "ordered": token.type == "ordered_list_open", "next": int(token.attrGet("start") or 1)})
        elif token.type in {"bullet_list_close", "ordered_list_close"}:
            lists.pop()
        elif token.type == "list_item_open":
            current = lists[-1]
            prefix = f"{current['next']}. " if current["ordered"] else "• "
            list_kind = "List Number" if current["ordered"] else "List Bullet"
            current["next"] += 1
        elif token.type == "list_item_close":
            prefix, list_kind = "", ""
        elif token.type == "heading_open":
            kind, level = "heading", int(token.tag[1:])
        elif token.type == "paragraph_open":
            kind, level = "paragraph", 0
        elif token.type == "inline":
            runs = inline(token.children)
            if cell is not None:
                cell.extend(runs)
            else:
                blocks.append({"kind": kind, "level": level, "runs": runs, "prefix": prefix, "list_style": list_kind, "depth": len(lists), "list_id": lists[-1]["id"] if list_kind else None})
                prefix, list_kind = "", ""
        elif token.type in {"fence", "code_block", "html_block"}:
            blocks.append({"kind": "paragraph", "runs": [{"text": token.content, "code": True}]})
        elif token.type == "hr":
            blocks.append({"kind": "paragraph", "runs": [{"text": "---"}]})
    if len(blocks) > 10_000:
        raise ValueError("文档段落过多，请拆分后导出或使用 Markdown")
    extra_sources = []
    seen = set(references)
    for card in sources:
        identity = card.get("citation_id") or json.dumps(card, sort_keys=True, ensure_ascii=False)
        if identity not in seen:
            extra_sources.append(card)
            seen.add(identity)
    if references or extra_sources:
        blocks.append({"kind": "heading", "level": 2, "runs": [{"text": "资料来源"}]})
        for key, number in references.items():
            card = cards.get(key)
            label = _source_label(card) if card else "来源不可用"
            state = "保存时有原文支持" if card and statuses.get(key) == "verified" else "未核对"
            blocks.append({"kind": "paragraph", "runs": [{"text": f"[{number}] {label} · {state}"}]})
        for number, card in enumerate(extra_sources, len(references) + 1):
            blocks.append({"kind": "paragraph", "runs": [{"text": f"[{number}] {_source_label(card)} · 未核对"}]})
    return blocks


def _load_images(document, blocks, resource_loader, fence):
    from PIL import Image
    resources = {resource["id"]: resource for resource in document["resources"]}
    used = set()
    for block in blocks:
        for runs in ([cell for row in block["rows"] for cell in row] if block["kind"] == "table" else [block["runs"]]):
            used.update(run["image"] for run in runs if "image" in run)
    images, size = {}, 0
    for key in used:
        fence()
        data = resource_loader(key)
        size += len(data)
        if size > MAX_EXPORT_BYTES or hashlib.sha256(data).hexdigest() != resources[key]["sha256"]:
            raise ValueError("文档图片缺失、已变化或超过导出大小上限")
        try:
            with Image.open(BytesIO(data)) as image:
                if image.width * image.height > 16_000_000:
                    raise ValueError("单张文档图片超过 1600 万像素，请缩小后再导出")
                target = BytesIO()
                image.convert("RGBA" if "A" in image.getbands() else "RGB").save(target, format="PNG")
                images[key] = (target.getvalue(), image.width, image.height)
        except (OSError, Image.DecompressionBombError) as exc:
            raise ValueError("文档图片无法安全解码") from exc
    if sum(len(image[0]) for image in images.values()) > MAX_EXPORT_BYTES:
        raise ValueError("解码后的图片超过导出大小上限")
    return images


def _widths(rows, total):
    count = max(map(len, rows))
    weights = [max((len("".join(run.get("text", "") for run in row[index])) for row in rows if index < len(row)), default=1) for index in range(count)]
    weights = [max(3, min(24, size)) for size in weights]
    remaining = total - count * 26
    return [26 + remaining * weight / sum(weights) for weight in weights]


def _embed_fonts(doc):
    from docx.opc.constants import RELATIONSHIP_TYPE as RT
    from docx.opc.packuri import PackURI
    from docx.opc.part import Part
    from docx.oxml import OxmlElement, parse_xml
    from docx.oxml.ns import qn
    from lxml import etree
    font_part = doc.part.part_related_by(RT.FONT_TABLE)
    root = parse_xml(font_part.blob)
    entry = OxmlElement("w:font"); entry.set(qn("w:name"), FONT_FAMILY)
    for style, tag in (("Regular", "embedRegular"), ("Bold", "embedBold")):
        data = bytearray(font_bytes(style))
        key = uuid.uuid5(uuid.NAMESPACE_URL, hashlib.sha256(data).hexdigest())
        mask = key.bytes[::-1]
        for index in range(32):
            data[index] ^= mask[index % 16]
        part = Part(PackURI(f"/word/fonts/tuantuan-{style.lower()}.odttf"), "application/vnd.openxmlformats-officedocument.obfuscatedFont", bytes(data), doc.part.package)
        embedded = OxmlElement(f"w:{tag}")
        embedded.set(qn("r:id"), font_part.relate_to(part, RT.FONT))
        embedded.set(qn("w:fontKey"), "{" + str(key).upper() + "}")
        entry.append(embedded)
    root.append(entry)
    font_part._blob = etree.tostring(root, xml_declaration=True, encoding="UTF-8", standalone=True)
    doc.settings._element.append(OxmlElement("w:embedTrueTypeFonts"))


def _docx(document, blocks, images, output, fence):
    from docx import Document
    from docx.shared import Inches, Pt, RGBColor
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    doc = Document()
    section = doc.sections[0]
    section.page_width, section.page_height = Inches(8.5), Inches(11)
    section.left_margin = section.right_margin = Inches(2 / 3)
    section.top_margin = section.bottom_margin = Inches(.6)
    for name in ("Normal", "Title", "Heading 1", "Heading 2", "Heading 3", "Heading 4", "Heading 5", "Heading 6", "List Bullet", "List Number"):
        style = doc.styles[name]
        style.font.name, style.font.color.rgb = FONT_FAMILY, RGBColor(0, 0, 0)
        fonts = style._element.get_or_add_rPr().get_or_add_rFonts()
        for attribute in ("asciiTheme", "hAnsiTheme", "eastAsiaTheme", "cstheme"):
            fonts.attrib.pop(qn("w:" + attribute), None)
        fonts.set(qn("w:eastAsia"), FONT_FAMILY)
    doc.styles["Normal"].font.size = Pt(11)
    doc.styles["Normal"].paragraph_format.line_spacing = 1.4
    doc.core_properties.author = "团团"
    for border in list(doc.styles["Title"]._element.iter(qn("w:pBdr"))):
        border.getparent().remove(border)
    def add_runs(paragraph, runs, width=516):
        for item in runs:
            if "image" in item:
                data, w, h = images[item["image"]]
                shape = paragraph.add_run().add_picture(BytesIO(data), width=Pt(min(width, w * .75, 650 * w / h)))
                shape._inline.docPr.set("descr", item.get("alt", ""))
            else:
                run = paragraph.add_run(item["text"])
                run.bold, run.italic = item.get("bold", False), item.get("italic", False)
    list_numbers = {}
    for index, block in enumerate(blocks):
        fence()
        if block["kind"] == "table":
            widths = _widths(block["rows"], 516)
            table = doc.add_table(rows=0, cols=len(widths)); table.style = "Table Grid"; table.autofit = False
            for column, width in zip(table.columns, widths): column.width = Pt(width)
            for row_index, row in enumerate(block["rows"]):
                fence()
                target_row = table.add_row()
                if row_index == 0: target_row._tr.get_or_add_trPr().append(OxmlElement("w:tblHeader"))
                for cell_index, cell in enumerate(target_row.cells):
                    cell.width = Pt(widths[cell_index])
                    properties = cell._tc.get_or_add_tcPr()
                    margins = OxmlElement("w:tcMar")
                    for side in ("top", "bottom", "left", "right"):
                        margin = OxmlElement(f"w:{side}"); margin.set(qn("w:w"), "110"); margin.set(qn("w:type"), "dxa"); margins.append(margin)
                    properties.append(margins)
                    if row_index == 0:
                        shading = OxmlElement("w:shd"); shading.set(qn("w:fill"), "E4EDF3"); properties.append(shading)
                    paragraph = cell.paragraphs[0]; paragraph.paragraph_format.space_after = Pt(0)
                    add_runs(paragraph, row[cell_index] if cell_index < len(row) else [], widths[cell_index] - 12)
            continue
        if block["kind"] == "heading":
            paragraph = doc.add_paragraph(style="Title" if index == 0 and block["level"] == 1 else f"Heading {min(block['level'], 6)}")
        else:
            paragraph = doc.add_paragraph(style=block.get("list_style") or "Normal")
            if block.get("depth", 0) > 1: paragraph.paragraph_format.left_indent = Pt(18 * block["depth"])
            if block.get("list_style") == "List Number":
                list_id = block["list_id"]
                if list_id not in list_numbers:
                    numbering = doc.part.numbering_part.element
                    base_id = doc.styles["List Number"]._element.xpath(".//w:numId")[0].val
                    abstract = numbering.xpath(f'./w:num[@w:numId="{base_id}"]/w:abstractNumId')[0].val
                    number = numbering.add_num(abstract)
                    override = OxmlElement("w:lvlOverride"); override.set(qn("w:ilvl"), "0")
                    start = OxmlElement("w:startOverride"); start.set(qn("w:val"), block["prefix"].split(".", 1)[0])
                    override.append(start); number.append(override)
                    list_numbers[list_id] = number.numId
                properties = paragraph._p.get_or_add_pPr().get_or_add_numPr()
                properties.get_or_add_ilvl().val = 0
                properties.get_or_add_numId().val = list_numbers[list_id]
        add_runs(paragraph, block["runs"])
    _embed_fonts(doc)
    fence()
    doc.save(output)


def _pdf(document, blocks, images, output, fence):
    from reportlab.lib.colors import HexColor
    from reportlab.lib.pagesizes import letter
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.platypus import SimpleDocTemplate, Paragraph, LongTable, TableStyle, Image, CondPageBreak, Spacer
    for style in ("Regular", "Bold"):
        name = f"TuantuanDocument-{style}"
        if name not in pdfmetrics.getRegisteredFontNames():
            pdfmetrics.registerFont(TTFont(name, BytesIO(font_bytes(style))))
    pdfmetrics.registerFontFamily("TuantuanDocument-Regular", normal="TuantuanDocument-Regular", bold="TuantuanDocument-Bold", italic="TuantuanDocument-Regular", boldItalic="TuantuanDocument-Bold")
    glyphs = pdfmetrics.getFont("TuantuanDocument-Regular").face.charToGlyph
    for block in blocks:
        runs = [run for row in block["rows"] for cell in row for run in cell] if block["kind"] == "table" else block["runs"]
        if any(not character.isspace() and not glyphs.get(ord(character)) for run in runs for character in run.get("text", "")):
            raise ValueError("正文含当前 PDF 字体不支持的字符，请使用 DOCX、Markdown 或 TXT")
    normal = ParagraphStyle("Body", fontName="TuantuanDocument-Regular", fontSize=11, leading=17, wordWrap="CJK", spaceAfter=8)
    headings = {level: ParagraphStyle(f"Heading{level}", parent=normal, fontName="TuantuanDocument-Bold", fontSize=size, leading=size * 1.4, spaceBefore=12, spaceAfter=12) for level, size in enumerate((22, 18, 15, 13, 12, 11), 1)}
    cell_style = ParagraphStyle("Cell", parent=normal, fontSize=10, leading=15, spaceAfter=0)
    def flowables(runs, style, width=516, prefix=""):
        result, text = [], escape(prefix)
        for item in runs:
            if "image" in item:
                if text: result.append(Paragraph(text, style)); text = ""
                data, w, h = images[item["image"]]
                scale = min(width / w, .75, 650 / h)
                result.append(Image(BytesIO(data), width=w * scale, height=h * scale))
            else:
                value = escape(item["text"]).replace("\n", "<br/>")
                if item.get("bold"): value = "<b>" + value + "</b>"
                if item.get("italic"): value = "<i>" + value + "</i>"
                text += value
        if text: result.append(Paragraph(text, style))
        return result or [Spacer(1, 4)]
    story = []
    for block in blocks:
        fence()
        if block["kind"] == "table":
            widths = _widths(block["rows"], 516)
            rows = [[flowables(row[index] if index < len(row) else [], cell_style, width - 16) for index, width in enumerate(widths)] for row in block["rows"]]
            table = LongTable(rows, colWidths=widths, repeatRows=1, splitByRow=0, splitInRow=1)
            table.setStyle(TableStyle([("BACKGROUND", (0, 0), (-1, 0), HexColor("#e4edf3")), ("GRID", (0, 0), (-1, -1), .3, HexColor("#b8c8d4")), ("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 8), ("RIGHTPADDING", (0, 0), (-1, -1), 8), ("TOPPADDING", (0, 0), (-1, -1), 7), ("BOTTOMPADDING", (0, 0), (-1, -1), 7)]))
            story += [table, Spacer(1, 8)]
        else:
            style = headings[block["level"]] if block["kind"] == "heading" else normal
            if block["kind"] == "heading": story.append(CondPageBreak(90))
            story.extend(flowables(block["runs"], style, prefix=block.get("prefix", "")))
    def footer(canvas, doc):
        fence()
        if doc.page > 500: raise ValueError("文档超过 500 页导出上限，请拆分后重试")
        canvas.setFont("TuantuanDocument-Regular", 9)
        canvas.drawRightString(564, 27, f"第 {doc.page} 页")
    SimpleDocTemplate(output, pagesize=letter, leftMargin=48, rightMargin=48, topMargin=42, bottomMargin=42, title=document.get("title", "文档")).build(story, onFirstPage=footer, onLaterPages=footer)


def render_document(document, *, format, resource_loader, fence=lambda: None):
    if format not in {"docx", "pdf"}:
        raise ValueError("只支持 DOCX 或 PDF 导出")
    fence()
    blocks = _blocks(document)
    images = _load_images(document, blocks, resource_loader, fence)
    output = _BoundedBuffer()
    if format == "pdf":
        # ReportLab's dynamic TTFont instances must not be shared concurrently.
        with _pdf_lock:
            fence(); _pdf(document, blocks, images, output, fence)
    else:
        _docx(document, blocks, images, output, fence)
    fence()
    return output.getvalue()
