from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, Field, SecretStr, model_validator

from ..search_options import WebSearchOptions


class ToolDefinition(BaseModel):
    name: str = Field(min_length=1)
    description: str = Field(min_length=1)
    input_schema: dict[str, Any]
    output_schema: dict[str, Any] = Field(
        default_factory=lambda: {"type": "object", "additionalProperties": True}
    )


class ToolCall(BaseModel):
    id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    arguments: dict[str, Any] = Field(default_factory=dict)


class ToolError(BaseModel):
    code: str
    message: str
    retryable: bool = False


class ToolResult(BaseModel):
    ok: bool
    status: Literal["done", "failed", "waiting_approval", "blocked"]
    data: dict[str, Any] = Field(default_factory=dict)
    message: str
    error: ToolError | None = None


class AgentMessage(BaseModel):
    role: Literal["system", "user", "assistant", "tool"]
    content: str = ""
    tool_call_id: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)


class ModelUsage(BaseModel):
    input_tokens: int = 0
    output_tokens: int = 0
    total_tokens: int = 0


class ModelRequest(BaseModel):
    messages: list[AgentMessage]
    tools: list[ToolDefinition] = Field(default_factory=list)
    tool_choice: Literal["auto", "required", "none"] = "auto"
    parameters: dict[str, float | int] = Field(default_factory=dict)
    image_generation: bool = False
    # Optional per-profile reasoning effort for providers that support it.
    reasoning_effort: Literal["low", "medium", "high"] | None = None
    # Structured output (OpenAI ``response_format`` shape, e.g. json_schema);
    # translated per protocol by the model layer.
    response_format: dict[str, Any] | None = None
    # Mark the static system prompt cacheable where the protocol needs an
    # explicit marker (Anthropic); other providers cache automatically.
    prompt_cache: bool = True
    # Budgeted workflows reserve each network attempt before dispatch.
    allow_option_fallback: bool = True


class ModelImageOutput(BaseModel):
    item_id: str
    # Binary results are transient, never part of a checkpoint, log or SSE payload.
    base64_data: SecretStr = Field(exclude=True, repr=False)


class ModelResponse(BaseModel):
    content: str = ""
    tool_calls: list[ToolCall] = Field(default_factory=list)
    usage: ModelUsage | None = None
    provider_metadata: dict[str, Any] = Field(default_factory=dict)
    images: list[ModelImageOutput] = Field(default_factory=list, exclude=True, repr=False)
    output_blocks: list[dict[str, Any]] = Field(default_factory=list)


class ModelStreamEvent(BaseModel):
    type: Literal["text_delta", "reasoning_delta", "completed", "image_progress"]
    delta: str = ""
    response: ModelResponse | None = None


class ToolEvent(BaseModel):
    round: int
    tool_call_id: str
    tool_name: str
    status: str
    message: str
    data: dict[str, Any] = Field(default_factory=dict)
    started_at: str | None = None
    completed_at: str | None = None
    duration_ms: int | None = Field(default=None, ge=0)


class AgentPlanStep(BaseModel):
    id: str = Field(min_length=1)
    title: str = Field(min_length=1)
    tool_name: str = Field(min_length=1)
    risk: Literal[
        "read_only", "derived_analysis", "local_pending_write",
        "confirmed_local_write", "external_read",
        # Legacy values stay valid for persisted operation records.
        "analysis", "local_write", "user_input",
    ]
    status: Literal["pending", "running", "done", "failed", "blocked"] = "pending"


class AgentPlan(BaseModel):
    goal: str = Field(min_length=1)
    route: str = Field(min_length=1)
    steps: list[AgentPlanStep] = Field(default_factory=list)
    requires_confirmation: bool = False
    expected_output: str = Field(default="", max_length=500)
    success_criteria: list[str] = Field(default_factory=list, max_length=6)


class ClarificationOption(BaseModel):
    id: str = ""
    label: str = ""
    send: str = ""


class AgentClarification(BaseModel):
    question: str = ""
    options: list[ClarificationOption] = Field(default_factory=list)
    allow_custom: bool = True


class PendingToolApproval(BaseModel):
    """A held tool call waiting for one explicit user confirmation."""

    tool_name: str = Field(min_length=1)
    tool_call_id: str = ""
    fingerprint: str = Field(min_length=1)
    title: str = ""
    summary: str = ""


class ExecutionBudgetState(BaseModel):
    tool_calls: int = Field(default=0, ge=0)
    web_search_calls: int = Field(default=0, ge=0)
    searches_without_progress: int = Field(default=0, ge=0)
    web_evidence: dict[str, list[str]] = Field(default_factory=dict)
    active_seconds: float = Field(default=0, ge=0)
    finalization_reason: str = ""


class AgentRunSnapshot(BaseModel):
    skill_catalog: list[dict[str, Any]] = Field(default_factory=list)
    skill_binding: dict[str, Any] | None = None
    # Internal immutable identity only. Credentials are resolved from versioned storage.
    model_selection: dict[str, Any] = Field(default_factory=dict)
    web_search_options: WebSearchOptions | None = None
    resume_mode: Literal["waiting_user", "checkpoint"] = "waiting_user"
    route_kind: str
    needs_plan: bool
    allowed_tools: list[str] = Field(default_factory=list)
    library_read_allowed: bool | None = None
    required_tools: list[str] = Field(default_factory=list)
    plan: AgentPlan | None = None
    messages: list[AgentMessage] = Field(default_factory=list)
    replan_used: bool = False
    citation_retry_used: bool = False
    citation_draft: str = ""
    citation_sources: list[dict[str, Any]] = Field(default_factory=list)
    citation_allowed_urls: list[str] = Field(default_factory=list)
    expects_draft: bool = False
    delivery_retry_used: bool = False
    degraded_tools: dict[str, ToolError] = Field(default_factory=dict)
    rounds_used: int = 0
    clarification: AgentClarification | None = None
    completed_tools: list[str] = Field(default_factory=list)
    completed_tool_calls: list[str] = Field(default_factory=list)
    repeated_tool_calls: dict[str, int] = Field(default_factory=dict)
    execution_budget: ExecutionBudgetState | None = None
    approved_search_queries: list[str] = Field(default_factory=list)
    pending_search_queries: list[str] = Field(default_factory=list)
    approved_tool_fingerprints: list[str] = Field(default_factory=list)
    pending_tool_approval: PendingToolApproval | None = None
    requires_query_approval: bool = False


class AgentRunResult(BaseModel):
    content: str
    provider: str
    platform: str
    rounds: int
    model_selection: dict[str, Any] = Field(default_factory=dict)
    evidence: list[dict[str, Any]] = Field(default_factory=list)
    citations: list[dict[str, Any]] = Field(default_factory=list)
    assets: list[dict[str, Any]] = Field(default_factory=list)
    output_blocks: list[dict[str, Any]] = Field(default_factory=list)
    image_generation_prompt: str | None = None
    status: Literal["done", "failed", "waiting_user", "cancelled"] = "done"
    error: ToolError | None = None
    events: list[ToolEvent] = Field(default_factory=list)
    plan: AgentPlan | None = None
    snapshot: AgentRunSnapshot | None = None
    stop_reason: str = ""
    started_at: str | None = None
    completed_at: str | None = None
    duration_ms: int | None = Field(default=None, ge=0)

    @model_validator(mode="after")
    def infer_stop_reason(self) -> "AgentRunResult":
        """Keep every terminal result machine-readable without duplicating status logic."""
        if self.stop_reason:
            return self
        if self.status == "done":
            self.stop_reason = "completed"
        elif self.status == "waiting_user":
            self.stop_reason = "waiting_user"
        elif self.status == "cancelled":
            self.stop_reason = "cancelled"
        elif self.error is not None:
            self.stop_reason = self.error.code
        else:
            self.stop_reason = "failed"
        return self


class AgentStreamEvent(BaseModel):
    type: Literal[
        "run_started",
        "text_reset",
        "text_delta",
        "reasoning_delta",
        "agent_event",
        "waiting_user",
        "completed",
        "cancelled",
        "error",
    ]
    delta: str = ""
    event: ToolEvent | None = None
    result: AgentRunResult | None = None
