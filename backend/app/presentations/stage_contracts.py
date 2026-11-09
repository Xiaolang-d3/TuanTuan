"""Authored recommendation schemas, deliberately separate from user receipts."""
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator
from typing import Annotated



class StrictStageModel(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)


class ProseRecommendation(StrictStageModel):
    # Blank text is a supported, meaningful recommendation/confirmation value.
    value: str = Field(max_length=8000)


class CanvasRecommendation(StrictStageModel):
    canvas: Literal["ppt169"]


class TemplateOptions(StrictStageModel):
    schema_version: Literal[1]
    phase: Literal["template"]
    lang: Literal["zh"]
    default_mode: Literal["free_design"]
    explicit_workspace_roots: list[str] = Field(max_length=0)


class Stage1Recommendation(StrictStageModel):
    stage: Literal["stage1"]
    lang: Literal["zh"]
    primary_language: Literal["zh-CN"]
    recommend: CanvasRecommendation
    audience: ProseRecommendation
    communication_intent: ProseRecommendation
    audience_outcome: ProseRecommendation
    core_message: ProseRecommendation
    delivery_context: ProseRecommendation
    artifact_afterlife: ProseRecommendation
    content_divergence: ProseRecommendation
    template_options: TemplateOptions


AuthoredText = Annotated[str, Field(min_length=1, max_length=8000, pattern=r"\S")]
HexColor = Annotated[str, Field(pattern=r"^#[0-9A-Fa-f]{6}$")]


class BooleanRecommendation(StrictStageModel):
    value: bool


class DisabledRecommendation(StrictStageModel):
    value: Literal[False]


class DepthRecommendation(StrictStageModel):
    value: Literal["brief", "complete"]


class Palette(StrictStageModel):
    background: HexColor
    secondary_bg: HexColor
    primary: HexColor
    accent: HexColor
    secondary_accent: HexColor
    body_text: HexColor


class DirectionColor(StrictStageModel):
    name: AuthoredText
    palette: Palette


class FontRole(StrictStageModel):
    primary: AuthoredText
    english: AuthoredText
    css: AuthoredText


class DirectionTypography(StrictStageModel):
    name: AuthoredText
    heading: FontRole
    body: FontRole
    body_size: float = Field(gt=0, allow_inf_nan=False)


class DirectionImages(StrictStageModel):
    name: AuthoredText
    rendering: Literal["custom"]
    visual: AuthoredText
    mood: AuthoredText
    behavior: AuthoredText


class DesignDirection(StrictStageModel):
    id: str = Field(min_length=1, max_length=80, pattern=r"^[a-zA-Z0-9][a-zA-Z0-9_-]*$")
    name: AuthoredText
    note: AuthoredText
    mode: Literal["custom"]
    mode_behavior: AuthoredText
    visual_style: Literal["custom"]
    visual_style_behavior: AuthoredText
    icons: AuthoredText
    color: DirectionColor
    typography: DirectionTypography
    image_strategy: DirectionImages


class DesignDirections(StrictStageModel):
    selected: int = Field(ge=0, le=2)
    candidates: list[DesignDirection] = Field(min_length=3, max_length=3)

    @model_validator(mode="after")
    def unique_ids(self):
        if len({item.id for item in self.candidates}) != 3:
            raise ValueError("三个设计方向需要唯一标识")
        return self


class ProductionRecommendation(StrictStageModel):
    delivery_purpose: Literal["text", "balanced", "presentation"]
    mode: Literal["custom"]
    visual_style: Literal["custom"]
    image_strategy: Literal["custom"]
    image_usage: list[Literal["none", "provided"]] = Field(min_length=1, max_length=1)
    generation_mode: Literal["continuous"]


class Stage2Recommendation(StrictStageModel):
    """New local authoring contract, not a legacy/upstream full-capability parser.

    Only provided/no images are supported. Selection hash shape is validated
    here; installation and actual selection binding belong to orchestration.
    All production switches must be explicit, never default notes to false to
    hide a no-notes exporter restriction. User-editable prose retains blanks.
    """
    stage: Literal["stage2"]
    lang: Literal["zh"]
    selection_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    recommend: ProductionRecommendation
    page_count: ProseRecommendation
    image_notes: ProseRecommendation
    proactive_speaker_notes: BooleanRecommendation
    proactive_custom_animations: DisabledRecommendation
    proactive_narration_audio: DisabledRecommendation
    refine_spec: DisabledRecommendation
    design_spec_depth: DepthRecommendation
    template_application: ProseRecommendation | None = None
    design_directions: DesignDirections
