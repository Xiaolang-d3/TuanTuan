"""Strict new local Stage 2 authoring contracts, without vendor/model execution."""
from copy import deepcopy

import pytest
from pydantic import ValidationError

from app.presentations.stage_contracts import Stage2Recommendation


def stage2():
    candidate = {
        "id": "direction-0", "name": "清晰", "note": "为当前主题设计", "mode": "custom",
        "mode_behavior": "先判断后证据", "visual_style": "custom", "visual_style_behavior": "对齐留白",
        "icons": "tabler-outline",
        "color": {"name": "冷静", "palette": {role: "#112233" for role in (
            "background", "secondary_bg", "primary", "accent", "secondary_accent", "body_text")}},
        "typography": {"name": "中文", "heading": {"primary": "Noto Sans CJK SC", "english": "Arial",
                                                   "css": '"Noto Sans CJK SC", Arial, sans-serif'},
                       "body": {"primary": "Noto Sans CJK SC", "english": "Arial",
                                "css": '"Noto Sans CJK SC", Arial, sans-serif'}, "body_size": 24},
        "image_strategy": {"name": "证据图", "rendering": "custom", "visual": "用户资料", "mood": "克制", "behavior": "保留真实信息"},
    }
    candidates = []
    for i in range(3):
        item = deepcopy(candidate)
        item["id"] = f"direction-{i}"
        candidates.append(item)
    return {"stage": "stage2", "lang": "zh", "selection_sha256": "a" * 64,
            "recommend": {"delivery_purpose": "balanced", "mode": "custom", "visual_style": "custom",
                          "image_strategy": "custom", "image_usage": ["none"], "generation_mode": "continuous"},
            "page_count": {"value": ""}, "image_notes": {"value": "  "},
            "proactive_speaker_notes": {"value": True}, "proactive_custom_animations": {"value": False},
            "proactive_narration_audio": {"value": False}, "refine_spec": {"value": False},
            "design_spec_depth": {"value": "brief"}, "design_directions": {"selected": 1, "candidates": candidates}}


def test_complete_directions_and_user_blanks_retained():
    value = Stage2Recommendation.model_validate(stage2())
    assert value.page_count.value == "" and value.image_notes.value == "  "
    assert value.proactive_speaker_notes.value is True  # never silently no-notes
    assert len(value.design_directions.candidates) == 3


@pytest.mark.parametrize("change", [
    lambda d: d["recommend"].update(generation_mode="split"),
    lambda d: d.update(refine_spec={"value": True}),
    lambda d: d.update(proactive_custom_animations={"value": True}),
    lambda d: d.update(proactive_narration_audio={"value": True}),
])
def test_new_recommendations_cannot_default_to_unimplemented_production(change):
    data = stage2()
    data["design_spec_depth"]["value"] = "complete"
    change(data)
    with pytest.raises(ValidationError):
        Stage2Recommendation.model_validate(data)


@pytest.mark.parametrize("candidate_index", range(3))
@pytest.mark.parametrize("role", ["heading", "body"])
@pytest.mark.parametrize("invalid_css", [None, "", " \t\n", "missing"])
def test_each_direction_requires_nonblank_font_css(candidate_index, role, invalid_css):
    data = stage2()
    font = data["design_directions"]["candidates"][candidate_index]["typography"][role]
    if invalid_css == "missing":
        font.pop("css")
    else:
        font["css"] = invalid_css
    with pytest.raises(ValidationError):
        Stage2Recommendation.model_validate(data)


def test_font_css_is_required_in_authoring_schema():
    font = Stage2Recommendation.model_json_schema()["$defs"]["FontRole"]
    assert "css" in font["required"]
    assert font["properties"]["css"]["type"] == "string"


@pytest.mark.parametrize("usage", [["none"], ["provided"]])
def test_product_image_sources(usage):
    data = stage2()
    data["recommend"]["image_usage"] = usage
    Stage2Recommendation.model_validate(data)


@pytest.mark.parametrize("usage", [[], ["ai"], ["web"], ["placeholder"], ["none", "provided"], ["provided", "provided"], "none"])
def test_no_implicit_external_image_capability(usage):
    data = stage2()
    data["recommend"]["image_usage"] = usage
    with pytest.raises(ValidationError):
        Stage2Recommendation.model_validate(data)


@pytest.mark.parametrize("selected", [-1, 3, True, "1"])
def test_selected_is_strict_index(selected):
    data = stage2()
    data["design_directions"]["selected"] = selected
    with pytest.raises(ValidationError):
        Stage2Recommendation.model_validate(data)


@pytest.mark.parametrize("size", [0, -1, True, "24", float("nan"), float("inf")])
def test_body_size_is_positive_finite_number(size):
    data = stage2()
    data["design_directions"]["candidates"][0]["typography"]["body_size"] = size
    with pytest.raises(ValidationError):
        Stage2Recommendation.model_validate(data)


@pytest.mark.parametrize("change", [
    lambda d: d.pop("selection_sha256"),
    lambda d: d.update(selection_sha256="A" * 64),
    lambda d: d["recommend"].update(image_ai_path="auto"),
    lambda d: d["design_directions"]["candidates"].pop(),
    lambda d: d["design_directions"]["candidates"].append(deepcopy(d["design_directions"]["candidates"][0])),
    lambda d: d["design_directions"]["candidates"][1].update(id="direction-0"),
    lambda d: d["design_directions"]["candidates"][0].update(mode="pyramid"),
    lambda d: d["design_directions"]["candidates"][0]["color"]["palette"].pop("accent"),
    lambda d: d["design_directions"]["candidates"][0]["color"]["palette"].update(accent="#123"),
    lambda d: d["design_directions"]["candidates"][0]["typography"]["heading"].pop("english"),
    lambda d: d["design_directions"]["candidates"][0]["typography"]["body"].update(primary="  "),
    lambda d: d["design_directions"]["candidates"][0].pop("image_strategy"),
    lambda d: d["design_directions"]["candidates"][0]["image_strategy"].update(rendering="photo"),
    lambda d: d["refine_spec"].update(value=1),
    lambda d: d.pop("proactive_speaker_notes"),
    lambda d: d["recommend"].update(generation_mode="split"),
    lambda d: d["refine_spec"].update(value=True),
    lambda d: d.update(unexpected="no"),
])
def test_invalid_or_incomplete_authoring_rejected(change):
    data = stage2()
    change(data)
    with pytest.raises(ValidationError):
        Stage2Recommendation.model_validate(data)


def test_complete_spec_does_not_enable_unimplemented_split_or_refinement():
    data = stage2()
    data["recommend"]["generation_mode"] = "split"
    data["refine_spec"]["value"] = True
    data["design_spec_depth"]["value"] = "complete"
    with pytest.raises(ValidationError):
        Stage2Recommendation.model_validate(data)
