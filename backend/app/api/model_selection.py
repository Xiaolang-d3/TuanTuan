"""Local model selection previews never call a provider or unlock credentials."""
from typing import Literal

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, ConfigDict, Field, model_validator

from ..agent.image_selection import ImageOperation, ImageSourceMissing, preview_image_selection

from ..agent.model_purposes import preview_model_selection


router = APIRouter()


class ModelSelectionPreviewIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    purpose: Literal["chat", "image", "video"] | None = None
    operation: ImageOperation | None = None
    profile_id: str | None = Field(default=None, min_length=1, max_length=120)
    asset_id: str | None = Field(default=None, min_length=1, max_length=120)

    @model_validator(mode="after")
    def validate_scope(self):
        if (self.purpose is None) == (self.operation is None):
            raise ValueError("请选择一个模型用途或操作")
        if bool(self.asset_id) != (self.operation == "image.edit"):
            raise ValueError("仅图片编辑需要指定图片")
        return self


@router.post("/agent/model-selection/preview")
def preview(payload: ModelSelectionPreviewIn, response: Response) -> dict:
    response.headers["Cache-Control"] = "no-store"
    if payload.operation is None:
        return preview_model_selection(payload.purpose, payload.profile_id)
    try:
        return preview_image_selection(payload.operation, payload.profile_id, payload.asset_id)
    except ImageSourceMissing as exc:
        raise HTTPException(404, str(exc)) from exc
