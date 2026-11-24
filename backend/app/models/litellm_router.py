"""``litellm.Router`` layer: per-conversation primary model plus fallbacks.

The primary deployment is the conversation's selected profile; fallback
deployments are other enabled profiles from the user's fallback policy.
Every deployment is a chat-format LiteLLM route (Responses-only models use
LiteLLM's ``openai/responses/<model>`` bridge), so one request can move across
protocols.  Per-profile settings (reasoning effort, temperature, max tokens,
Responses ``store``/``include``) live in each deployment's parameters so a
fallback never inherits the primary's options.

Protocol negotiation stays ahead of routing: while an auto-mode primary has no
known protocol yet, calls go straight to the negotiating provider and the
router takes over once the protocol is settled.
"""
from __future__ import annotations

from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from time import perf_counter
from typing import Any

from ..domain import ModelRequest, ModelResponse, ModelStreamEvent
from ..model_network import hosted_models
from ..observability.model_monitor import record_model_service_event
from .base import ModelProviderError
from .litellm_core import get_litellm, retry_policy_class
from .litellm_errors import map_litellm_error
from .litellm_provider import LiteLLMProvider


PRIMARY_GROUP = "primary"
_EFFORTS = frozenset({"low", "medium", "high"})


@dataclass
class RouteTarget:
    """One profile reachable through the router."""

    identity: dict[str, Any]
    provider: LiteLLMProvider
    parameters: dict[str, Any] = field(default_factory=dict)
    reasoning_effort: str | None = None

    @property
    def profile_id(self) -> str:
        return str(self.identity.get("profile_id") or "")

    @property
    def model_name(self) -> str:
        return str(self.identity.get("model_name") or self.provider._model)

    def deployment(self, group: str) -> dict[str, Any]:
        protocol = self.provider.name
        params = self.provider.litellm_params(responses_bridge=True)
        effort = self.reasoning_effort if self.reasoning_effort in _EFFORTS else None
        if effort:
            params["reasoning_effort"] = {"effort": effort, "summary": "auto"} if protocol == "responses" else effort
        if "temperature" in self.parameters and not (effort and protocol == "anthropic"):
            params["temperature"] = self.parameters["temperature"]
        if "max_output_tokens" in self.parameters:
            params["max_tokens"] = int(self.parameters["max_output_tokens"])
        if protocol == "responses":
            params["extra_body"] = {"store": False, "include": ["reasoning.encrypted_content"]}
        return {"model_name": group, "litellm_params": params, "model_info": {"id": group}}


def _group(target: RouteTarget) -> str:
    return f"fallback:{target.profile_id}"


def build_router(primary: RouteTarget, fallbacks: dict[str, list[RouteTarget]], policy: dict[str, Any]) -> Any:
    litellm = get_litellm()
    RetryPolicy = retry_policy_class()  # noqa: N806

    targets: dict[str, RouteTarget] = {}
    for role in ("general", "context_window", "content_policy"):
        for target in fallbacks.get(role, []):
            targets.setdefault(_group(target), target)
    model_list = [primary.deployment(PRIMARY_GROUP), *[target.deployment(group) for group, target in targets.items()]]

    def chain(role: str) -> list[dict[str, list[str]]] | None:
        groups = [_group(target) for target in fallbacks.get(role, [])]
        return [{PRIMARY_GROUP: groups}] if groups else None

    retry = policy.get("retry_policy") or {}
    retries = {
        "TimeoutErrorRetries": int(retry.get("timeout", 0)),
        "RateLimitErrorRetries": int(retry.get("rate_limit", 0)),
        "InternalServerErrorRetries": int(retry.get("server_error", 0)),
        # Configuration problems and refusals never get better by retrying.
        "BadRequestErrorRetries": 0,
        "AuthenticationErrorRetries": 0,
        "ContentPolicyViolationErrorRetries": 0,
    }
    router_class = litellm.Router
    if hosted_models():
        # Router otherwise replaces the per-call client with its cached SDK
        # client. Bind every deployment (including cross-protocol fallbacks)
        # to its own guarded client, key and origin instead.
        guarded = {PRIMARY_GROUP: primary, **targets}

        class HostedRouter(litellm.Router):
            def _get_async_openai_model_client(self, deployment, kwargs):
                return guarded[deployment["model_info"]["id"]].provider.hosted_client()

        router_class = HostedRouter
    return router_class(
        model_list=model_list,
        fallbacks=chain("general"),
        context_window_fallbacks=chain("context_window"),
        content_policy_fallbacks=chain("content_policy"),
        num_retries=max(retries.values()),
        retry_policy=RetryPolicy(**retries),
        allowed_fails=int(policy.get("allowed_fails", 3)),
        cooldown_time=float(policy.get("cooldown_seconds", 60)),
        routing_strategy="simple-shuffle",
        set_verbose=False,
    )


class RoutedModelProvider:
    """Same interface as a provider; generation goes through ``litellm.Router``."""

    backend = "litellm"

    def __init__(
        self,
        *,
        primary: Any,
        primary_identity: dict[str, Any],
        primary_parameters: dict[str, Any] | None,
        primary_reasoning_effort: str | None,
        fallbacks: dict[str, list[RouteTarget]],
        policy: dict[str, Any],
    ) -> None:
        self._primary = primary
        self._primary_identity = dict(primary_identity)
        self._primary_parameters = dict(primary_parameters or {})
        self._primary_effort = primary_reasoning_effort
        self._fallbacks = fallbacks
        self._policy = dict(policy)
        self._routers: dict[str, Any] = {}

    # --- identity / diagnostics delegate to the selected (primary) model ---
    @property
    def name(self) -> str:
        return self._primary.name

    @property
    def models_url(self) -> str:
        return self._primary.models_url

    async def list_models(self) -> list[str]:
        return await self._primary.list_models()

    async def check_connection(self) -> None:
        await self._primary.check_connection()

    async def probe_vision(self) -> dict[str, str]:
        return await self._primary.probe_vision()

    # --- routing ---
    def _primary_target(self) -> RouteTarget | None:
        provider = self._primary
        if getattr(provider, "negotiated", True) is False:
            return None
        provider = getattr(provider, "active_provider", provider)
        if not isinstance(provider, LiteLLMProvider):
            return None
        return RouteTarget(
            identity=self._primary_identity, provider=provider,
            parameters=self._primary_parameters, reasoning_effort=self._primary_effort,
        )

    def _router(self, primary: RouteTarget) -> Any:
        # The negotiated protocol can change; rebuild only then so cooldown
        # state survives across calls.
        key = primary.provider.name
        router = self._routers.get(key)
        if router is None:
            router = build_router(primary, self._fallbacks, self._policy)
            self._routers = {key: router}
        return router

    def _target_for(self, model_id: str, primary: RouteTarget) -> RouteTarget:
        if model_id and model_id != PRIMARY_GROUP:
            for targets in self._fallbacks.values():
                for target in targets:
                    if _group(target) == model_id:
                        return target
        return primary

    def _arguments(self, primary: RouteTarget, request: ModelRequest) -> dict[str, Any]:
        # Messages and tools in the primary's dialect; per-profile options come
        # from each deployment's parameters, so drop them from the call.
        arguments = primary.provider.chat_arguments(
            request.model_copy(update={"parameters": {}, "reasoning_effort": None}),
        )
        arguments.pop("extra_body", None)
        return arguments

    def _secrets(self, primary: RouteTarget) -> tuple[str | None, ...]:
        """Keys of every deployment that may have produced the error."""
        targets = [primary, *(target for group in self._fallbacks.values() for target in group)]
        return tuple(getattr(target.provider, "_api_key", None) for target in targets)

    async def generate(self, request: ModelRequest) -> ModelResponse:
        if request.image_generation:
            return await self._primary.generate(request)
        primary = self._primary_target()
        if primary is None:
            return await self._primary.generate(request)
        started_at = perf_counter()
        try:
            raw = await self._router(primary).acompletion(model=PRIMARY_GROUP, **self._arguments(primary, request))
            target = self._target_for(str((getattr(raw, "_hidden_params", None) or {}).get("model_id") or ""), primary)
            result = target.provider.response_from_completion(raw)
        except Exception as exc:
            error = map_litellm_error(exc, primary.provider.name, self._secrets(primary))
            self._record(primary, "generate", started_at, error=error)
            raise error from exc
        return self._finish(primary, target, "generate", started_at, result)

    async def stream(self, request: ModelRequest) -> AsyncIterator[ModelStreamEvent]:
        if request.image_generation:
            async for event in self._primary.stream(request):
                yield event
            return
        primary = self._primary_target()
        if primary is None:
            async for event in self._primary.stream(request):
                yield event
            return
        started_at = perf_counter()
        arguments = self._arguments(primary, request)
        arguments.update(stream=True, stream_options={"include_usage": True})
        result: ModelResponse | None = None
        target = primary
        try:
            stream = await self._router(primary).acompletion(model=PRIMARY_GROUP, **arguments)
            target = self._target_for(str((getattr(stream, "_hidden_params", None) or {}).get("model_id") or ""), primary)
            async for event in target.provider.consume_chat_stream(stream):
                if event.type == "completed":
                    result = event.response
                else:
                    yield event
        except Exception as exc:
            error = map_litellm_error(exc, primary.provider.name, self._secrets(primary))
            self._record(target, "stream", started_at, error=error)
            raise error from exc
        if result is None:
            error = ModelProviderError("invalid_provider_response", "模型流已结束，但没有返回完整响应")
            self._record(target, "stream", started_at, error=error)
            raise error
        yield ModelStreamEvent(type="completed", response=self._finish(primary, target, "stream", started_at, result))

    def _finish(self, primary: RouteTarget, target: RouteTarget, kind: str, started_at: float, result: ModelResponse) -> ModelResponse:
        metadata = dict(result.provider_metadata)
        metadata.update(answered_profile_id=target.profile_id, answered_model_name=target.model_name, routed=True)
        fallback = target is not primary
        if fallback:
            metadata["fallback_from_profile_id"] = primary.profile_id
            self._record(
                primary, kind, started_at,
                error=ModelProviderError("fallback_used", f"主模型调用失败，已由备用模型 {target.model_name} 回答"),
            )
        self._record(target, kind, started_at, result=result, fallback_from=primary.profile_id if fallback else "")
        return result.model_copy(update={"provider_metadata": metadata})

    def _record(
        self, target: RouteTarget, kind: str, started_at: float, *,
        error: ModelProviderError | None = None, result: ModelResponse | None = None, fallback_from: str = "",
    ) -> None:
        identity = {
            key: target.identity[key]
            for key in ("profile_id", "connection_id", "profile_revision", "connection_revision")
            if key in target.identity
        }
        usage = result.usage if result else None
        try:
            record_model_service_event(
                request_kind=kind,
                status="error" if error else "success",
                error_code=error.code if error else "",
                error_message=str(error) if error else "",
                latency_ms=round((perf_counter() - started_at) * 1000),
                total_tokens=usage.total_tokens if usage else 0,
                input_tokens=usage.input_tokens if usage else 0,
                output_tokens=usage.output_tokens if usage else 0,
                model_name=target.provider._model,
                base_url=target.provider._base_url,
                response_id=str((result.provider_metadata.get("response_id") if result else "") or ""),
                protocol=target.provider.name,
                cost_usd=result.provider_metadata.get("cost_usd") if result else None,
                backend="litellm",
                fallback_from_profile_id=fallback_from,
                identity=identity,
            )
        except Exception:
            pass


_ROLE_FIELDS = {
    "general": "fallback_profile_ids",
    "context_window": "context_window_profile_ids",
    "content_policy": "content_policy_profile_ids",
}


def route_target_for_connection(connection: dict[str, Any], *, timeout_seconds: float) -> RouteTarget:
    from ..model_protocol import protocol_requires_api_key

    if (connection.get("auth_kind") == "chatgpt_subscription"
            or connection.get("secret_ref") == "chatgpt_subscription"):
        raise ValueError("ChatGPT 订阅不可作为 LiteLLM 备用模型")
    protocol = connection.get("detected_protocol") or connection["resolved_model_protocol"]
    if protocol == "images":
        raise ValueError("图片模型不能作为聊天备用模型")
    if protocol_requires_api_key(protocol) and not connection.get("api_key"):
        raise ValueError("备用模型缺少 API Key")
    provider = LiteLLMProvider(
        api_key=connection.get("api_key") or "",
        model=connection["model_name"],
        base_url=connection.get("model_base_url") or None,
        timeout_seconds=timeout_seconds,
        protocol=protocol,
        price_per_million_input=connection.get("price_per_million_input"),
        price_per_million_output=connection.get("price_per_million_output"),
    )
    return RouteTarget(
        identity={key: connection.get(key) for key in ("profile_id", "connection_id", "profile_revision", "connection_revision", "model_name")},
        provider=provider,
        parameters=dict(connection.get("parameters") or {}),
        reasoning_effort=connection.get("reasoning_effort"),
    )


def build_routed_provider(
    primary: Any,
    primary_connection: dict[str, Any],
    policy: dict[str, Any],
    *,
    timeout_seconds: float,
    load_profile,
) -> Any:
    """Wrap ``primary`` with router fallbacks; return it unchanged when none apply."""
    if (primary_connection.get("auth_kind") == "chatgpt_subscription"
            or primary_connection.get("secret_ref") == "chatgpt_subscription"):
        return primary
    primary_id = str(primary_connection.get("profile_id") or "")
    fallbacks: dict[str, list[RouteTarget]] = {}
    cache: dict[str, RouteTarget | None] = {}
    for role, field_name in _ROLE_FIELDS.items():
        targets: list[RouteTarget] = []
        for profile_id in policy.get(field_name) or []:
            if profile_id == primary_id:
                continue
            if profile_id not in cache:
                try:
                    cache[profile_id] = route_target_for_connection(load_profile(profile_id), timeout_seconds=timeout_seconds)
                except Exception:
                    # Ineligible fallbacks (including subscriptions) are skipped.
                    cache[profile_id] = None
            if cache[profile_id] is not None:
                targets.append(cache[profile_id])
        if targets:
            fallbacks[role] = targets
    if not fallbacks:
        return primary
    return RoutedModelProvider(
        primary=primary,
        primary_identity={key: primary_connection.get(key) for key in ("profile_id", "connection_id", "profile_revision", "connection_revision", "model_name")},
        primary_parameters=primary_connection.get("parameters"),
        primary_reasoning_effort=primary_connection.get("reasoning_effort"),
        fallbacks=fallbacks,
        policy=policy,
    )
