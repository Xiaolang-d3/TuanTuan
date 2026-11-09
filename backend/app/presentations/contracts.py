"""Public input contracts: no host paths, runtime choice or execution grants."""
from __future__ import annotations

from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

AttachmentId = Annotated[str, Field(pattern=r"^[a-f0-9]{32}$")]


class PresentationOptions(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    page_count: int = Field(default=8, ge=1, le=20, strict=True)
    language: Literal["zh-CN"] = "zh-CN"
    canvas: Literal["ppt169"] = "ppt169"
    image_source: Literal["none", "provided"] = "none"


class PresentationRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    topic: str = Field(min_length=1, max_length=8000)
    attachment_ids: list[AttachmentId] = Field(default_factory=list, max_length=20)
    conversation_id: int | None = Field(default=None, gt=0, strict=True)
    options: PresentationOptions = Field(default_factory=PresentationOptions)

    @field_validator("topic")
    @classmethod
    def nonblank_topic(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("请填写演示文稿主题或目标")
        return value

    @field_validator("attachment_ids")
    @classmethod
    def unique_attachments(cls, values: list[str]) -> list[str]:
        if len(set(values)) != len(values):
            raise ValueError("附件标识不能重复")
        return values
