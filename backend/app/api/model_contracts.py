from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field
from .schemas import ConversationUpdate
from ..agent.model_router import RoutingPolicy


Protocol = Literal["auto", "openai", "responses", "images", "anthropic", "gemini", "ollama"]
ReasoningEffort = Literal["low", "medium", "high"]


class ConnectionCreateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(default="", max_length=80)
    model_base_url: str = Field(default="", max_length=500)
    model_protocol: Protocol = "auto"
    api_key: str = Field(default="", max_length=500)
    model_name: str | None = Field(default=None, min_length=1, max_length=120)
    data_boundary: str | None = Field(default=None, max_length=120)


class ConnectionUpdateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_revision: int = Field(ge=0)
    name: str | None = Field(default=None, max_length=80)
    model_base_url: str | None = Field(default=None, max_length=500)
    model_protocol: Protocol | None = None
    api_key: str | None = Field(default=None, max_length=500)
    enabled: bool | None = None
    data_boundary: str | None = Field(default=None, max_length=120)


class ProfileCreateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    connection_id: str = Field(min_length=1, max_length=120)
    model_name: str = Field(min_length=1, max_length=120)
    parameters: dict[str, float | int] = Field(default_factory=dict)
    context_limit: int | None = Field(default=None, ge=1)
    reasoning_effort: ReasoningEffort | None = None


class ServiceModelIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    model_name: str = Field(min_length=1, max_length=120)
    expected_revision: int = Field(ge=0)


class ProfileUpdateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_revision: int = Field(ge=0)
    model_name: str | None = Field(default=None, min_length=1, max_length=120)
    enabled: bool | None = None
    parameters: dict[str, float | int] | None = None
    context_limit: int | None = Field(default=None, ge=1)
    capabilities: dict[Literal["vision", "tools", "streaming", "chat", "image_generation", "video_generation"], Literal["supported", "unsupported", "unknown"]] | None = None
    reasoning_effort: ReasoningEffort | None = None


class DefaultProfileIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    profile_id: str = Field(min_length=1, max_length=120)


class PurposeDefaultIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    profile_id: str | None = Field(default=None, min_length=1, max_length=120)
    expected_version: int = Field(ge=1)


class ConversationModelUpdate(ConversationUpdate):
    model_profile_id: str | None = Field(default=None, min_length=1, max_length=120)
    kernel: Literal["tuantuan", "dsh"] | None = None


class RoutingPolicyIn(RoutingPolicy):
    expected_version: int = Field(ge=1)


CapabilityName = Literal["vision", "tools", "reasoning", "structured_output", "pdf", "prompt_caching"]
CapabilityValue = Literal["supported", "unsupported"]


class RetryPolicyIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    timeout: int = Field(default=0, ge=0, le=3)
    rate_limit: int = Field(default=0, ge=0, le=3)
    server_error: int = Field(default=0, ge=0, le=3)


class FallbackPolicyIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_revision: int | None = Field(default=None, ge=0)
    enabled: bool | None = None
    fallback_profile_ids: list[str] | None = Field(default=None, max_length=5)
    context_window_profile_ids: list[str] | None = Field(default=None, max_length=2)
    content_policy_profile_ids: list[str] | None = Field(default=None, max_length=2)
    retry_policy: RetryPolicyIn | None = None
    allowed_fails: int | None = Field(default=None, ge=1, le=20)
    cooldown_seconds: int | None = Field(default=None, ge=0, le=3600)


class CapabilityOverridesIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    # null clears a manual override so live probes / LiteLLM data apply again.
    overrides: dict[CapabilityName, CapabilityValue | None]
