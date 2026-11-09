"""Local model selection previews never call a provider or unlock credentials."""
from typing import Literal

from fastapi import APIRouter, Response
from pydantic import BaseModel, ConfigDict, Field

from ..agent.model_purposes import preview_model_selection


router = APIRouter()


class ModelSelectionPreviewIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    purpose: Literal["chat", "image", "video"]
    profile_id: str | None = Field(default=None, min_length=1)


@router.post("/agent/model-selection/preview")
def preview(payload: ModelSelectionPreviewIn, response: Response) -> dict:
    response.headers["Cache-Control"] = "no-store"
    return preview_model_selection(payload.purpose, payload.profile_id)
