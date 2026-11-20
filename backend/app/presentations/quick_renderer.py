from __future__ import annotations

import argparse
import os
import struct
import subprocess
import unicodedata
from pathlib import Path
from tempfile import TemporaryDirectory

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.oxml.xmlchemy import OxmlElement
from pptx.util import Inches, Pt

from app.presentations.quick_plan import DeckPlan, wrap_text

INK, NAVY, SURFACE = "142B3A", "123240", "F2F5F3"
GREEN, LIGHT, MUTED = "17644D", "BDF0C8", "426275"
FONT = "Noto Sans CJK SC"


def rgb(value):
    return RGBColor.from_string(value)


def rectangle(slide, left, top, width, height, color):
    shape = slide.shapes.add_shape(MSO_SHAPE.RECTANGLE, *map(Inches, (left, top, width, height)))
    shape.fill.solid()
    shape.fill.fore_color.rgb = rgb(color)
    shape.line.fill.background()
    shape.shadow.inherit = False
    return shape


def text(slide, value, left, top, width, height, *, size, color=INK, bold=False, columns=100):
    box = slide.shapes.add_textbox(*map(Inches, (left, top, width, height))).text_frame
    box.margin_left = box.margin_right = box.margin_top = box.margin_bottom = 0
    box.word_wrap = False
    for index, line in enumerate(wrap_text(value, columns)):
        paragraph = box.add_paragraph() if index else box.paragraphs[0]
        paragraph.line_spacing = Pt(size * 1.40)
        run = paragraph.add_run()
        run.text = line
        run.font.name = FONT
        run.font.size = Pt(size)
        run.font.bold = bold
        run.font.color.rgb = rgb(color)
        east_asian = OxmlElement("a:ea")
        east_asian.set("typeface", FONT)
        run._r.get_or_add_rPr().insert_element_before(east_asian, "a:cs", "a:sym")


def render_slide(deck, slide, plan, number):
    cover = plan.layout == "cover"
    closing = plan.layout == "summary"
    dark = cover or closing
    rectangle(slide, 0, 0, 13.333, 7.5, NAVY if dark else SURFACE)
    text(slide, f"{number:02} / {len(deck.slides):02}", 11.65, .45, 1, .25, size=11, color=LIGHT if dark else GREEN)
    if cover:
        rectangle(slide, .78, 1.55, .77, .07, LIGHT)
        rectangle(slide, 11.06, 3.45, 2.27, 4.05, GREEN)
        rectangle(slide, 11.85, 2.67, 1.48, .72, LIGHT)
        text(slide, plan.title, .78, 2.05, 10.15, 2.1, size=44, bold=True, color="FFFFFF", columns=16)
        text(slide, plan.takeaway, .82, 4.5, 10, 1.1, size=24, color=LIGHT, columns=27)
        return

    section = {"points": "核心观点", "comparison": "对照分析", "process": "实施流程", "summary": "总结与行动"}[plan.layout]
    text(slide, section, .78, .46, 3, .36, size=13, color=LIGHT if dark else GREEN, bold=True)
    text(slide, plan.title, .76, .94, 12, .75, size=36, color="FFFFFF" if dark else INK, bold=True, columns=22)
    text(slide, plan.takeaway, .78, 1.87, 11.8, .5, size=20, color=LIGHT if dark else MUTED, columns=39)

    if plan.layout in {"comparison", "process"}:
        count = len(plan.items)
        gap = .20
        width = (11.78 - gap * (count - 1)) / count
        for index, item in enumerate(plan.items):
            left = .78 + index * (width + gap)
            rectangle(slide, left, 2.89, width, 3.54, "FFFFFF")
            rectangle(slide, left, 2.89, width, .07, GREEN)
            text(slide, f"{index + 1:02}", left + .22, 3.17, 1, .42, size=17, color=GREEN, bold=True)
            text(slide, item.label, left + .22, 3.87, width - .44, .5, size=17, bold=True, columns=9)
            text(slide, item.text, left + .22, 4.55, width - .44, 1.3, size=16, color=MUTED, columns=20 if count == 2 and plan.layout == "comparison" else 10)
    else:
        for index, item in enumerate(plan.items):
            top = 2.7 + index * 1.32
            rectangle(slide, .78, top, 11.78, 1.18, "204657" if dark else "FFFFFF")
            text(slide, f"{index + 1:02}", 1.02, top + .22, .4, .34, size=15, color=LIGHT if dark else GREEN, bold=True)
            text(slide, item.label, 1.74, top + .22, 2.5, .4, size=18, color="FFFFFF" if dark else INK, bold=True, columns=9)
            text(slide, item.text, 4.54, top + .1, 7.7, 1.04, size=16, color="FFFFFF" if dark else MUTED, columns=34)


def export_deck(plan: DeckPlan, output: Path) -> None:
    plan = DeckPlan.model_validate(plan.model_dump())
    deck = Presentation()
    deck.slide_width, deck.slide_height = Inches(40 / 3), Inches(7.5)
    deck.core_properties.title = plan.title
    deck.core_properties.author = "团团"
    for number, slide in enumerate(plan.slides, 1):
        render_slide(plan, deck.slides.add_slide(deck.slide_layouts[6]), slide, number)
    with TemporaryDirectory(dir=output.parent) as directory:
        temporary = Path(directory) / "deck.pptx"
        deck.save(str(temporary))
        temporary.replace(output)


def compact_text(value: str) -> str:
    return "".join(unicodedata.normalize("NFKC", value).split())


def render_preview(pptx: Path, output: Path, plan: DeckPlan) -> list[Path]:
    pages = len(plan.slides)
    if not 3 <= pages <= 10 or output.exists():
        raise ValueError("预览页数无效或输出目录已存在")
    with TemporaryDirectory(dir=output.parent) as directory:
        root = Path(directory).resolve()
        environment = {**os.environ, "HOME": str(root), "XDG_CACHE_HOME": str(root / "cache"), "SAL_USE_VCLPLUGIN": "svp"}
        subprocess.run(["soffice", f"-env:UserInstallation={(root / 'profile').as_uri()}", "--headless",
                        "--convert-to", "pdf:impress_pdf_Export", "--outdir", str(root), str(pptx.resolve())],
                       check=True, timeout=75, env=environment, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        pdf = root / f"{pptx.stem}.pdf"
        extracted = subprocess.run(["pdftotext", "-enc", "UTF-8", str(pdf), "-"], check=True, timeout=10,
                                   stdout=subprocess.PIPE, stderr=subprocess.DEVNULL).stdout.decode("utf-8").split("\f")
        if len(extracted) != pages + 1 or any(
            compact_text(title) not in compact_text(content)
            for slide, content in zip(plan.slides, extracted)
            for title in (slide.title, slide.takeaway)
        ):
            raise ValueError("预览中的文字无法识别，请检查渲染环境中的中文字体")
        rendered = root / "rendered"
        rendered.mkdir()
        subprocess.run(["pdftoppm", "-l", str(pages + 1), "-scale-to-x", "1280", "-scale-to-y", "720", "-png",
                        str(pdf), str(rendered / "slide")],
                       check=True, timeout=35, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        images = sorted(rendered.glob("slide-*.png"), key=lambda path: int(path.stem.split("-")[-1]))
        if len(images) != pages:
            raise ValueError("预览页数与演示文稿不一致")
        for number, image in enumerate(images, 1):
            with image.open("rb") as stream:
                header = stream.read(24)
            if len(header) != 24 or header[:8] != b"\x89PNG\r\n\x1a\n" or struct.unpack(">II", header[16:24]) != (1280, 720):
                raise ValueError("预览图尺寸无效")
            image.rename(rendered / f"{number:02}.png")
        rendered.rename(output)
    return [output / f"{number:02}.png" for number in range(1, pages + 1)]


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=("export", "preview"))
    arguments = parser.parse_args()
    if arguments.action == "export":
        export_deck(DeckPlan.model_validate_json(Path("plan.json").read_bytes()), Path("deck.pptx"))
    else:
        plan = DeckPlan.model_validate_json(Path("plan.json").read_bytes())
        render_preview(Path("deck.pptx"), Path("previews"), plan)
