from typing import Literal

from pydantic import BaseModel, Field, StrictBool

from ..search_options import WebSearchProvider, WebSearchSourcePreference, WebSearchTopic


class ChatMessageIn(BaseModel):
    skill_id: str | None = Field(default=None, min_length=1, max_length=100)
    content: str = Field(min_length=1)
    conversation_id: int | None = None
    model_profile_id: str | None = Field(default=None, min_length=1, max_length=120)
    attachment_ids: list[str] = Field(default_factory=list, max_length=8)
    vision_attachment_ids: list[str] = Field(default_factory=list, max_length=4)
    web_search: StrictBool = Field(default=False, description="省略时按搜索服务配置自动允许按需搜索；显式 false 禁止本轮新增搜索。")
    web_search_mode: Literal["auto", "technical", "general"] = "auto"
    web_search_topic: WebSearchTopic = "auto"
    web_search_source_preference: WebSearchSourcePreference = "none"
    # Expected original binding during retry/regeneration; never chooses a service.
    web_search_provider: WebSearchProvider | None = None


class RestoredChatMessage(BaseModel):
    id: int = Field(gt=0)
    role: Literal["user", "assistant"]
    content: str = Field(max_length=200_000)
    payload: dict = Field(default_factory=dict)
    created_at: str | None = Field(default=None, max_length=64)
    task_id: int | None = Field(default=None, gt=0)


class RestoreChatMessagesIn(BaseModel):
    conversation_id: int = Field(gt=0)
    messages: list[RestoredChatMessage] = Field(min_length=1, max_length=500)
    previous_title: str | None = Field(default=None, max_length=80)
