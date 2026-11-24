"""Direct Sign in with ChatGPT subscription inference (public preview)."""
from __future__ import annotations

import json
import re
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import aclosing
from typing import Any

import httpx

from ..domain import ModelRequest, ModelResponse, ModelStreamEvent, ModelUsage, ToolCall
from .base import ModelProviderError
from .catalog_discovery import DiscoveredModels

_API_ROOT = "https://api.openai.com/v1"
_TOOL_NAMESPACE = "workspace"
_ENCRYPTED_REASONING = "reasoning.encrypted_content"
_BEARER_TOKEN = re.compile(r"[A-Za-z0-9._~+/\-]+=*")
_ADMISSION_ERRORS = {
    "subscription_sharing_user_not_eligible": "当前 ChatGPT 账号不符合订阅用量共享条件。",
    "subscription_sharing_usage_limit_exceeded": "ChatGPT 订阅用量已达上限，请查看 ChatGPT 用量设置。",
    "subscription_sharing_usage_unavailable": "暂时无法获取 ChatGPT 订阅用量，请稍后重试。",
    "subscription_sharing_unsupported_capability": "当前 ChatGPT 账号或模型不支持此功能。",
    "subscription_sharing_route_not_supported": "ChatGPT 订阅连接不支持此接口。",
    "subscription_sharing_invalid_user": "当前 ChatGPT 登录已失效，请重新授权。",
    "chatpass_v2_scope_not_authorized": "当前 ChatGPT 授权缺少必要权限，请重新授权。",
    "chatpass_v2_invalid_authorization_context": "当前 ChatGPT 授权无效，请重新授权。",
    "subscription_sharing_user_unavailable": "暂时无法获取 ChatGPT 账号状态，请稍后重试。",
}


class _AccountCatalog(DiscoveredModels):
    def __init__(self, entries: list[dict[str, Any]]) -> None:
        # This account catalog's ordering is part of the documented picker contract.
        self.entries = entries
        list.__init__(self, (entry["id"] for entry in entries))


class ChatGPTSubscriptionProvider:
    name = "chatgpt_subscription"

    def __init__(self, *, model: str, access_token: Callable[[], Awaitable[str]], timeout_seconds: float = 60) -> None:
        self._model = model
        self._access_token = access_token
        self._timeout = timeout_seconds

    def _client(self) -> httpx.AsyncClient:
        # Never send an account token to a configurable host, proxy or redirect.
        return httpx.AsyncClient(timeout=self._timeout, trust_env=False, follow_redirects=False)

    async def _token(self) -> str:
        token = await self._access_token()  # The store owns refresh and bound-account checks.
        if not isinstance(token, str) or _BEARER_TOKEN.fullmatch(token) is None:
            raise ModelProviderError("authentication_failed", "ChatGPT 登录凭据无效，请重新授权。")
        return token

    async def list_models(self) -> DiscoveredModels:
        try:
            token = await self._token()
            async with self._client() as client:
                response = await client.get(f"{_API_ROOT}/models", headers={"Authorization": f"Bearer {token}"})
                if not response.is_success:
                    raise _http_error(response)
                models = _json_object(response.content).get("models")
        except httpx.RequestError as exc:
            raise _transport_error(exc) from None
        if not isinstance(models, list):
            raise _invalid_response()
        entries = []
        seen = set()
        for model in models:
            if not isinstance(model, dict) or model.get("visibility") != "list":
                continue
            slug = model.get("slug")
            if not isinstance(slug, str) or not slug or slug != slug.strip() or slug in seen or token in slug:
                continue
            seen.add(slug)
            entry: dict[str, Any] = {
                "id": slug,
                "input_types": ["text"],
                "output_types": ["chat"],
                "output_types_source": "provider",
            }
            display_name = model.get("display_name")
            if isinstance(display_name, str) and display_name.strip() and token not in display_name:
                entry["display_name"] = display_name.strip()[:160]
            entries.append(entry)
        return _AccountCatalog(entries)

    async def check_connection(self) -> None:
        # Only check account/catalog admission. Do not consume plan usage for a probe.
        await self.list_models()

    async def generate(self, request: ModelRequest) -> ModelResponse:
        async with aclosing(self.stream(request)) as events:
            async for event in events:
                if event.type == "completed" and event.response is not None:
                    return event.response
        raise _interrupted()

    async def stream(self, request: ModelRequest) -> AsyncIterator[ModelStreamEvent]:
        body = _request_body(self._model, request)
        active_tools = {tool.name for tool in request.tools} if "tools" in body else set()
        deltas: list[str] = []
        final: ModelResponse | None = None
        try:
            token = await self._token()
            async with self._client() as client:
                async with client.stream(
                    "POST", f"{_API_ROOT}/responses", json=body,
                    headers={"Authorization": f"Bearer {token}", "Accept": "text/event-stream"},
                ) as response:
                    if not response.is_success:
                        if not response.is_redirect:
                            await response.aread()
                        raise _http_error(response)
                    if response.headers.get("content-type", "").split(";", 1)[0].strip().lower() != "text/event-stream":
                        raise _invalid_response()
                    async for event in _sse_events(response):
                        event_type = event.get("type")
                        if event_type in ("response.output_text.delta", "response.refusal.delta"):
                            delta = event.get("delta")
                            if not isinstance(delta, str):
                                raise _invalid_response()
                            if delta:
                                deltas.append(delta)
                                yield ModelStreamEvent(type="text_delta", delta=delta)
                        elif event_type == "response.completed":
                            final = _completed_response(event.get("response"), deltas, active_tools, self._model)
                            break
                        elif event_type in ("response.failed", "error"):
                            result = event.get("response")
                            raise _admission_error(result if isinstance(result, dict) else event) or ModelProviderError(
                                "provider_error", "ChatGPT 订阅模型生成失败。",
                            )
                        elif event_type == "response.incomplete":
                            raise ModelProviderError("incomplete_provider_response", "ChatGPT 订阅模型没有完成本次生成。")
        except httpx.RequestError as exc:
            raise _transport_error(exc) from None
        if final is None:
            raise _interrupted()
        yield ModelStreamEvent(type="completed", response=final)


def _request_body(model: str, request: ModelRequest) -> dict[str, Any]:
    if not model:
        raise ModelProviderError("not_configured", "请为 ChatGPT 订阅连接选择模型。")
    if request.parameters.get("background"):
        raise ModelProviderError("subscription_sharing_unsupported_capability", "ChatGPT 订阅连接不支持后台推理。")
    if request.image_generation or request.image_size or any(m.payload.get("image_urls") for m in request.messages):
        raise ModelProviderError("subscription_sharing_unsupported_capability", "当前 ChatGPT 订阅适配器只支持文本输入和输出。")
    if request.response_format is not None:
        raise ModelProviderError("subscription_sharing_unsupported_capability", "当前 ChatGPT 订阅适配器不支持结构化输出。")

    # Allowlist the preview fields instead of forwarding generic model settings.
    items: list[dict[str, Any]] = []
    body: dict[str, Any] = {"model": model, "input": items, "store": False, "stream": True}
    has_tool_history = False
    for message in request.messages:
        if message.role == "tool":
            if not message.tool_call_id:
                raise _invalid_tool_history()
            items.append({
                "type": "function_call_output", "call_id": message.tool_call_id,
                "output": _json_text(message.payload) if message.payload else message.content,
            })
            has_tool_history = True
        elif message.role == "assistant" and message.payload.get("tool_calls"):
            for reasoning in message.payload.get("responses_reasoning_items") or []:
                if item := _encrypted_reasoning(reasoning):
                    items.append(item)
            if message.content:
                items.append({"role": "assistant", "content": message.content})
            calls = message.payload["tool_calls"]
            if not isinstance(calls, list):
                raise _invalid_tool_history()
            for call in calls:
                if (not isinstance(call, dict) or not isinstance(call.get("id"), str) or not call["id"]
                        or not isinstance(call.get("name"), str) or not call["name"]
                        or not isinstance(call.get("arguments", {}), dict)):
                    raise _invalid_tool_history()
                items.append({
                    "type": "function_call", "call_id": call["id"], "name": call["name"],
                    "namespace": _TOOL_NAMESPACE, "arguments": _json_text(call.get("arguments", {})),
                })
            has_tool_history = True
        else:
            items.append({"role": "developer" if message.role == "system" else message.role, "content": message.content})
    if request.tool_choice != "none" and request.tools:
        body["tools"] = [{
            "type": "namespace", "name": _TOOL_NAMESPACE, "description": "Application workspace tools",
            "tools": [
                {"type": "function", "name": tool.name, "description": tool.description,
                 "parameters": tool.input_schema, "strict": False}
                for tool in request.tools
            ],
        }]
        body["tool_choice"] = request.tool_choice
    elif request.tool_choice == "required":
        raise _invalid_tool_history()
    if "tools" in body or has_tool_history:
        # Needed to replay reasoning alongside function calls without storing a response.
        body["include"] = [_ENCRYPTED_REASONING]
    return body


def _encrypted_reasoning(item: Any) -> dict[str, Any] | None:
    if (not isinstance(item, dict) or item.get("type") != "reasoning"
            or not isinstance(item.get("id"), str) or not item["id"]
            or not isinstance(item.get("encrypted_content"), str) or not item["encrypted_content"]):
        return None
    return {"type": "reasoning", "id": item["id"], "encrypted_content": item["encrypted_content"], "summary": []}


def _completed_response(raw: Any, deltas: list[str], active_tools: set[str], model: str) -> ModelResponse:
    if (not isinstance(raw, dict) or raw.get("status") != "completed"
            or not isinstance(raw.get("output"), list)):
        raise _invalid_response()
    texts: list[str] = []
    calls: list[ToolCall] = []
    call_ids: set[str] = set()
    reasoning_items = []
    for item in raw["output"]:
        if not isinstance(item, dict):
            raise _invalid_response()
        item_type = item.get("type")
        if item_type == "message":
            parts = item.get("content")
            if not isinstance(parts, list):
                raise _invalid_response()
            for part in parts:
                if not isinstance(part, dict):
                    raise _invalid_response()
                field = {"output_text": "text", "refusal": "refusal"}.get(str(part.get("type")))
                if field:
                    value = part.get(field)
                    if not isinstance(value, str):
                        raise _invalid_response()
                    if value:
                        texts.append(value)
        elif item_type == "function_call":
            call_id = item.get("call_id")
            name = item.get("name")
            if (not isinstance(name, str) or name not in active_tools or item.get("namespace") != _TOOL_NAMESPACE
                    or not isinstance(call_id, str) or not call_id or call_id in call_ids):
                raise _invalid_response()
            call_ids.add(call_id)
            calls.append(ToolCall(id=call_id, name=name, arguments=_json_object(item.get("arguments"))))
        elif reasoning := _encrypted_reasoning(item):
            reasoning_items.append(reasoning)
    usage = None
    if isinstance(raw.get("usage"), dict):
        usage = ModelUsage(**{
            field: value for field in ("input_tokens", "output_tokens", "total_tokens")
            if type(value := raw["usage"].get(field)) is int and value >= 0
        })
    metadata: dict[str, Any] = {
        "model": model, "protocol": ChatGPTSubscriptionProvider.name, "base_url": _API_ROOT,
        "finish_reason": "completed",
    }
    if calls and reasoning_items:
        metadata["responses_reasoning_items"] = reasoning_items
    texts = texts or (["".join(deltas)] if deltas else [])
    return ModelResponse(
        content="".join(texts), tool_calls=calls, usage=usage, provider_metadata=metadata,
        output_blocks=[{"type": "text", "text": text} for text in texts],
    )


async def _sse_events(response: httpx.Response) -> AsyncIterator[dict[str, Any]]:
    event_name = ""
    data: list[str] = []
    async for line in response.aiter_lines():
        if not line:
            if data:
                frame = "\n".join(data)
                if frame.strip() == "[DONE]":
                    return  # Legacy end marker is not proof of successful inference.
                event = _json_object(frame)
                if not event.get("type") and event_name:
                    event["type"] = event_name
                yield event
            event_name = ""
            data = []
            continue
        field, _, value = line.partition(":")
        if value.startswith(" "):
            value = value[1:]
        if field == "data":
            data.append(value)
        elif field == "event":
            event_name = value


def _json_object(raw: Any) -> dict[str, Any]:
    try:
        parsed = json.loads(raw)
    except (TypeError, ValueError, UnicodeError, RecursionError):
        raise _invalid_response() from None
    if not isinstance(parsed, dict):
        raise _invalid_response()
    return parsed


def _json_text(value: Any) -> str:
    try:
        return json.dumps(value, ensure_ascii=False, allow_nan=False)
    except (TypeError, ValueError, RecursionError):
        raise _invalid_tool_history() from None


def _admission_error(body: dict[str, Any]) -> ModelProviderError | None:
    # The preview uses both {detail: code} and standard Responses error objects.
    for candidate in (body.get("error"), body.get("detail"), body):
        code = candidate.get("code") if isinstance(candidate, dict) else candidate
        if isinstance(code, str) and code in _ADMISSION_ERRORS:
            return ModelProviderError(code, _ADMISSION_ERRORS[code])
    return None


def _http_error(response: httpx.Response) -> ModelProviderError:
    if response.is_redirect:
        return ModelProviderError("route_not_found", "ChatGPT 订阅接口返回了重定向；已拒绝继续请求。")
    try:
        known = _admission_error(_json_object(response.content))
    except ModelProviderError:
        known = None
    if known is not None:
        return known
    status = response.status_code
    if status in (401, 403):
        return ModelProviderError("authentication_failed", "ChatGPT 拒绝了订阅授权，请重新登录或检查账号权限。")
    if status == 429:
        return ModelProviderError("rate_limited", "ChatGPT 订阅请求受限，请稍后重试。")
    if status >= 500:
        return ModelProviderError("service_unavailable", "ChatGPT 订阅服务暂时不可用。")
    return ModelProviderError("provider_error", f"ChatGPT 订阅服务拒绝了请求（HTTP {status}）。")


def _transport_error(exc: httpx.RequestError) -> ModelProviderError:
    if isinstance(exc, httpx.TimeoutException):
        return ModelProviderError("request_timeout", "ChatGPT 订阅服务请求超时。")
    return ModelProviderError("service_unavailable", "无法连接 ChatGPT 订阅服务，或连接中断。")


def _invalid_tool_history() -> ModelProviderError:
    return ModelProviderError("invalid_tool_history", "ChatGPT 订阅模型的工具配置或历史不完整。")


def _invalid_response() -> ModelProviderError:
    return ModelProviderError("invalid_provider_response", "ChatGPT 订阅服务返回了无法解析的响应。")


def _interrupted() -> ModelProviderError:
    return ModelProviderError("incomplete_provider_response", "ChatGPT 订阅流在生成完成前中断。")
