from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


ToolRisk = Literal[
    "read_only",
    "derived_analysis",
    "local_pending_write",
    "confirmed_local_write",
    "external_read",
]


class ToolSpec(BaseModel):
    """Runtime policy and discovery metadata for one registered tool."""

    model_config = ConfigDict(frozen=True)

    name: str = Field(min_length=1)
    title: str = Field(min_length=1)
    risk: ToolRisk
    capabilities: frozenset[str] = Field(min_length=1)
    priority: int = Field(default=100, ge=0)
    stage_id: str | None = None
    timeout_seconds: float | None = Field(default=None, gt=0)

    @property
    def requires_confirmation(self) -> bool:
        return self.risk == "confirmed_local_write"


def _spec(
    name: str,
    title: str,
    risk: ToolRisk,
    *capabilities: str,
    priority: int = 100,
    stage_id: str | None = None,
    timeout_seconds: float | None = None,
) -> ToolSpec:
    return ToolSpec(
        name=name,
        title=title,
        risk=risk,
        capabilities=frozenset(capabilities),
        priority=priority,
        stage_id=stage_id,
        timeout_seconds=timeout_seconds,
    )


TOOL_SPECS: dict[str, ToolSpec] = {
    "ask_user": _spec("ask_user", "确认任务信息", "read_only", "dialog.ask"),
    "search_public_web": _spec("search_public_web", "检索公开网页", "external_read", "web.search.generic"),
    "get_library_context": _spec("get_library_context", "读取知识库", "read_only", "library.read"),
    "search_library": _spec("search_library", "检索资料", "read_only", "library.search"),
    "read_library_source": _spec("read_library_source", "分页读取资料", "read_only", "library.read.blocks"),
    "propose_library_knowledge": _spec("propose_library_knowledge", "添加待确认知识", "local_pending_write", "library.propose"),
}
