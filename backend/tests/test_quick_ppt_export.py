import os
from zipfile import ZipFile

import pytest

from app.presentations.quick_plan import DeckPlan

pytest.importorskip("pptx", reason="requires the isolated PPT runner dependencies")

from app.presentations.quick_renderer import export_deck, render_preview


def sample_deck():
    return DeckPlan.model_validate({
        "title": "智能体架构设计",
        "slides": [
            {"layout": "cover", "title": "智能体架构设计", "takeaway": "从目标到可验证的执行", "items": []},
            {"layout": "points", "title": "架构要解决什么", "takeaway": "任务需要边界", "items": [
                {"label": "输入", "text": "明确任务、资料和验收条件"}, {"label": "输出", "text": "给出可验证的结果"},
            ]},
            {"layout": "comparison", "title": "工具与模型", "takeaway": "分离推理与执行", "items": [
                {"label": "模型", "text": "分析目标与上下文"}, {"label": "工具", "text": "执行受约束的操作"},
            ]},
            {"layout": "process", "title": "运行流程", "takeaway": "每步都留下可检查的结果", "items": [
                {"label": "规划", "text": "拆解任务"}, {"label": "执行", "text": "调用工具"}, {"label": "核验", "text": "检查输出"},
            ]},
            {"layout": "summary", "title": "下一步", "takeaway": "先验证最小闭环", "items": [
                {"label": "验证", "text": "选取真实任务，检查质量和耗时"},
            ]},
        ],
    })


def test_export_contains_native_text_in_each_slide(tmp_path):
    destination = tmp_path / "result.pptx"
    export_deck(sample_deck(), destination)
    with ZipFile(destination) as archive:
        assert archive.testzip() is None
        for number, slide in enumerate(sample_deck().slides, 1):
            content = archive.read(f"ppt/slides/slide{number}.xml").decode()
            assert slide.title in content
            assert "<a:t>" in content
            assert "<p:pic" not in content
        assert '<a:ea typeface="Noto Sans CJK SC"' in archive.read("ppt/slides/slide1.xml").decode()


def test_rejects_content_that_would_overflow_without_leaving_a_file(tmp_path):
    deck = sample_deck()
    deck.slides[0].title = "长" * 34
    output = tmp_path / "result.pptx"
    with pytest.raises(ValueError, match="第 1 页"):
        export_deck(deck, output)
    assert not output.exists()


@pytest.mark.skipif(not os.getenv("TEST_QUICK_PPT_RENDER"), reason="requires LibreOffice and Poppler")
def test_real_preview_uses_exported_pptx(tmp_path):
    from PIL import Image

    pptx = tmp_path / "result.pptx"
    export_deck(sample_deck(), pptx)
    paths = render_preview(pptx, tmp_path / "previews", sample_deck())
    assert [path.name for path in paths] == [f"{number:02}.png" for number in range(1, 6)]
    for path in paths:
        with Image.open(path) as image:
            assert image.size == (1280, 720)
            assert image.convert("L").getextrema()[0] < 100
