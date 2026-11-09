from copy import deepcopy
from types import SimpleNamespace

import pytest

from app.jobs.repository import JobConflict


def contract():
    return SimpleNamespace(final={
        "canvas": "ppt169", "primary_language": "zh-CN", "page_count": "5–8",
        "generation_mode": "continuous", "refine_spec": False,
        "proactive_speaker_notes": True, "proactive_custom_animations": False,
        "proactive_narration_audio": False, "image_usage": ["none"],
        "typography": {"body_size": 24, "sizes": {"title": 40, "subtitle": 30, "annotation": 16}},
    }, selection={"mode": "free_design"}, stage1={"page_count": "5–8"})


def resolve(value=None, requested=8):
    from app.presentations.production_contracts import resolve_production
    return resolve_production(value or contract(), requested_pages=requested)


def test_page_range_is_bounded_and_notes_are_preserved():
    result = resolve()
    assert (result.min_pages, result.max_pages, result.notes) == (5, 8, True)
    value = contract()
    value.final["page_count"] = ""
    value.stage1["page_count"] = ""
    assert resolve(value, requested=6).min_pages == resolve(value, requested=6).max_pages == 6


@pytest.mark.parametrize("value", ["0", "21", "8-5", "约十页", True, "5 or 8", "1-200"])
def test_ambiguous_or_out_of_bounds_page_counts_are_not_silently_changed(value):
    c = contract()
    c.final["page_count"] = value
    with pytest.raises(JobConflict):
        resolve(c)


@pytest.mark.parametrize(("field", "value"), [
    ("canvas", "a4"), ("primary_language", "en-US"),
    ("generation_mode", "split"), ("refine_spec", True),
    ("proactive_custom_animations", True), ("proactive_narration_audio", True),
    ("image_usage", ["web"]), ("proactive_speaker_notes", "false"),
])
def test_unsupported_confirmed_requirements_block_before_production(field, value):
    c = contract()
    c.final[field] = value
    before = deepcopy(c.final)
    with pytest.raises(JobConflict):
        resolve(c)
    assert c.final == before


def test_final_page_count_cannot_leave_stage1_range():
    c = contract()
    c.final["page_count"] = "9"
    with pytest.raises(JobConflict):
        resolve(c)


@pytest.mark.parametrize("wording", [
    "请交付可编辑原生图表",
    "图表数据可编辑",
    "内嵌工作簿",
    "editable chart data",
    "native table",
])
def test_explicit_native_data_editing_requirement_blocks_before_production(wording):
    c = contract()
    c.final["audience_outcome"] = wording
    with pytest.raises(JobConflict, match="不支持原生数据对象"):
        resolve(c)


@pytest.mark.parametrize("wording", ["图表可编辑", "可编辑的表格", "页面形状可以调整"])
def test_editable_drawingml_shapes_are_supported(wording):
    c = contract()
    c.final["audience_outcome"] = wording
    assert resolve(c).max_pages == 8


@pytest.mark.parametrize("sizes", [{"title": float("nan")}, {"title": -1}, {"title": "40"}])
def test_nonfinite_or_coerced_font_sizes_block(sizes):
    c = contract()
    c.final["typography"]["sizes"] = sizes
    with pytest.raises(JobConflict):
        resolve(c)
