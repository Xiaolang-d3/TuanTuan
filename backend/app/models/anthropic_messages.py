from __future__ import annotations

import json

from collections.abc import AsyncIterator
from time import perf_counter
from typing import Any

import httpx

from .parameters import request_parameters
from ..redaction import remember_secret
from ..model_network import model_http_client, model_address_error
from ..agent.settings import get_agent_settings, persona_prompt
from ..domain import ModelRequest, ModelResponse, ModelStreamEvent, ModelUsage, ToolCall
from ..observability.model_monitor import record_model_service_event
from .base import ModelProviderError
from .validation import upstream_error_detail, validate_diagnostic_response
from .openai_compatible import (
    SYSTEM_PROMPT,
    _ACCOUNT_POOL_MARKERS,
    _MODEL_UNAVAILABLE_MARKERS,
    _TINY_PNG_DATA_URL,
    _looks_like_vision_rejection,
)


class AnthropicMessagesProvider:
    name = "anthropic"

    def __init__(
        self,
        api_key: str,
        model: str,
        base_url: str | None = None,
        timeout_seconds: float = 60,
    ) -> None:
        if not api_key:
            raise ValueError("启用 Anthropic Messages Provider 时必须配置 API Key")
        self._model = model
        self._secret = api_key  # masked in error messages
        remember_secret(api_key)  # masked verbatim in logs
        self._base_url = (base_url or "https://api.anthropic.com").rstrip("/")
        self._client = model_http_client(
            headers={
                "x-api-key": api_key,
                "authorization": f"Bearer {api_key}",
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            },
            timeout=timeout_seconds,
        )

    @property
    def messages_url(self) -> str:
        suffix = "/messages" if self._base_url.endswith("/v1") else "/v1/messages"
        return f"{self._base_url}{suffix}"

    @property
    def models_url(self) -> str:
        suffix = "/models" if self._base_url.endswith("/v1") else "/v1/models"
        return f"{self._base_url}{suffix}"

    async def generate(self, request: ModelRequest) -> ModelResponse:
        started_at = perf_counter()
        try:
            response = await self._client.post(self.messages_url, json=self._request_body(request))
            self._raise_for_status(response)
            payload = response.json()
            result = self._response_from_payload(payload)
        except ModelProviderError as error:
            self._record_event("generate", started_at, error=error)
            raise
        except (httpx.TimeoutException, httpx.RequestError, httpx.HTTPStatusError, ValueError, TypeError) as exc:
            error = self._provider_error(exc)
            self._record_event("generate", started_at, error=error)
            raise error from exc
        self._record_event(
            "generate",
            started_at,
            total_tokens=result.usage.total_tokens if result.usage else 0,
            usage=result.usage,
            response_id=result.provider_metadata.get("response_id", ""),
        )
        return result

    async def stream(self, request: ModelRequest) -> AsyncIterator[ModelStreamEvent]:
        started_at = perf_counter()
        body = self._request_body(request)
        body["stream"] = True
        content_parts: list[str] = []
        tool_parts: dict[int, dict[str, str]] = {}
        input_tokens = 0
        output_tokens = 0
        response_id = ""
        response_model = self._model
        stop_reason = ""
        try:
            async with self._client.stream("POST", self.messages_url, json=body) as response:
                if response.is_error:
                    await response.aread()
                self._raise_for_status(response)
                async for line in response.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    raw = line[5:].strip()
                    if not raw or raw == "[DONE]":
                        continue
                    event = json.loads(raw)
                    event_type = str(event.get("type") or "")
                    if event_type == "message_start":
                        message = event.get("message") or {}
                        response_id = str(message.get("id") or response_id)
                        response_model = str(message.get("model") or response_model)
                        input_tokens = int((message.get("usage") or {}).get("input_tokens") or 0)
                    elif event_type == "content_block_start":
                        index = int(event.get("index") or 0)
                        block = event.get("content_block") or {}
                        if block.get("type") == "tool_use":
                            tool_parts[index] = {
                                "id": str(block.get("id") or f"tool-{index}"),
                                "name": str(block.get("name") or ""),
                                "arguments": "",
                            }
                    elif event_type == "content_block_delta":
                        index = int(event.get("index") or 0)
                        delta = event.get("delta") or {}
                        if delta.get("type") == "text_delta":
                            text = str(delta.get("text") or "")
                            if text:
                                content_parts.append(text)
                                yield ModelStreamEvent(type="text_delta", delta=text)
                        elif delta.get("type") == "input_json_delta":
                            part = tool_parts.setdefault(
                                index,
                                {"id": f"tool-{index}", "name": "", "arguments": ""},
                            )
                            part["arguments"] += str(delta.get("partial_json") or "")
                    elif event_type == "message_delta":
                        stop_reason = str((event.get("delta") or {}).get("stop_reason") or stop_reason)
                        output_tokens = int((event.get("usage") or {}).get("output_tokens") or output_tokens)
        except (httpx.TimeoutException, httpx.RequestError, httpx.HTTPStatusError, ValueError, json.JSONDecodeError) as exc:
            error = self._provider_error(exc)
            self._record_event("stream", started_at, error=error)
            raise error from exc

        if not response_id and not content_parts and not tool_parts and not stop_reason:
            error = self._invalid_response_error()
            self._record_event("stream", started_at, error=error)
            raise error
        tool_calls = [self._stream_tool_call(tool_parts[index]) for index in sorted(tool_parts)]
        usage = ModelUsage(
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            total_tokens=input_tokens + output_tokens,
        )
        self._record_event("stream", started_at, total_tokens=usage.total_tokens, usage=usage, response_id=response_id)
        yield ModelStreamEvent(
            type="completed",
            response=ModelResponse(
                content="".join(content_parts),
                tool_calls=tool_calls,
                usage=usage,
                provider_metadata={
                    "model": response_model,
                    "finish_reason": stop_reason,
                    "response_id": response_id,
                    "base_url": self._base_url,
                    "protocol": self.name,
                },
            ),
        )

    async def check_connection(self) -> None:
        started_at = perf_counter()
        body = {
            "model": self._model,
            "max_tokens": 8,
            "messages": [{"role": "user", "content": "仅回复 OK"}],
        }
        try:
            response = await self._client.post(self.messages_url, json=body)
            self._raise_for_status(response)
            payload = response.json()
            result = self._response_from_payload(payload)
            validate_diagnostic_response(result, payload, self.name)
        except ModelProviderError as error:
            self._record_event("health_check", started_at, error=error)
            raise
        except (httpx.TimeoutException, httpx.RequestError, httpx.HTTPStatusError, ValueError, TypeError) as exc:
            error = self._provider_error(exc)
            self._record_event("health_check", started_at, error=error)
            raise error from exc
        self._record_event(
            "health_check",
            started_at,
            total_tokens=result.usage.total_tokens if result.usage else 0,
            usage=result.usage,
            response_id=result.provider_metadata.get("response_id", ""),
        )

    async def probe_vision(self) -> dict[str, str]:
        started_at = perf_counter()
        body = {
            "model": self._model,
            "max_tokens": 8,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": "image/png",
                                "data": _TINY_PNG_DATA_URL.split(",", 1)[1],
                            },
                        },
                        {"type": "text", "text": "只回复 OK"},
                    ],
                }
            ],
        }
        try:
            response = await self._client.post(self.messages_url, json=body)
            self._raise_for_status(response)
            payload = response.json()
            result = self._response_from_payload(payload)
            validate_diagnostic_response(result, payload, self.name)
        except ModelProviderError as error:
            self._record_event("health_check", started_at, error=error)
            raise
        except (httpx.TimeoutException, httpx.RequestError, httpx.HTTPStatusError, ValueError) as exc:
            error = self._provider_error(exc)
            self._record_event("health_check", started_at, error=error)
            status_code = exc.response.status_code if isinstance(exc, httpx.HTTPStatusError) else None
            if _looks_like_vision_rejection(upstream_error_detail(exc), status_code):
                return {"status": "unsupported", "source": "probe", "detail": "服务拒绝了图片输入，当前模型不支持多模态"}
            raise error from exc
        self._record_event("health_check", started_at, total_tokens=result.usage.total_tokens if result.usage else 0, usage=result.usage)
        return {"status": "supported", "source": "probe", "detail": "服务接受了图片输入，当前模型支持多模态"}

    async def list_models(self) -> list[str]:
        try:
            response = await self._client.get(self.models_url)
            self._raise_for_status(response)
            payload = response.json()
            if not isinstance(payload, dict) or not isinstance(payload.get("data"), list):
                raise self._invalid_response_error()
        except ModelProviderError:
            raise
        except (httpx.TimeoutException, httpx.RequestError, httpx.HTTPStatusError, ValueError, TypeError) as exc:
            raise self._provider_error(exc) from exc
        return sorted(
            {
                str(item.get("id") or "").strip()
                for item in payload.get("data") or []
                if isinstance(item, dict) and str(item.get("id") or "").strip()
            }
        )

    def _request_body(self, request: ModelRequest) -> dict[str, Any]:
        settings = get_agent_settings()
        extra_instructions = "\n".join(
            message.content
            for message in request.messages
            if message.role == "system" and message.content
        )
        system = SYSTEM_PROMPT + persona_prompt(settings)
        if extra_instructions:
            system = f"{system}\n{extra_instructions}"
        body: dict[str, Any] = {
            "model": self._model,
            "max_tokens": 4096,
            "system": system,
            "messages": [
                self._convert_message(message)
                for message in request.messages
                if message.role != "system"
            ],
        }
        body.update(request_parameters(request.parameters, "max_tokens"))
        if request.tools and request.tool_choice != "none":
            body["tools"] = [
                {
                    "name": tool.name,
                    "description": tool.description,
                    "input_schema": tool.input_schema,
                }
                for tool in request.tools
            ]
            body["tool_choice"] = {
                "type": "any" if request.tool_choice == "required" else "auto"
            }
        return body

    @staticmethod
    def _convert_message(message: Any) -> dict[str, Any]:
        if message.role == "assistant" and message.payload.get("tool_calls"):
            content: list[dict[str, Any]] = []
            if message.content:
                content.append({"type": "text", "text": message.content})
            content.extend(
                {
                    "type": "tool_use",
                    "id": call["id"],
                    "name": call["name"],
                    "input": call.get("arguments", {}),
                }
                for call in message.payload["tool_calls"]
            )
            return {"role": "assistant", "content": content}
        if message.role == "tool":
            return {
                "role": "user",
                "content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": message.tool_call_id,
                        "content": json.dumps(message.payload, ensure_ascii=False),
                    }
                ],
            }
        image_urls = message.payload.get("image_urls") if isinstance(message.payload, dict) else None
        if message.role == "user" and image_urls:
            content = [{"type": "text", "text": message.content}] if message.content else []
            content.extend(
                {"type": "image", "source": {"type": "url", "url": url}}
                for url in image_urls
                if isinstance(url, str) and url
            )
            return {"role": "user", "content": content}
        role = "assistant" if message.role == "assistant" else "user"
        return {"role": role, "content": message.content}

    def _response_from_payload(self, payload: dict[str, Any]) -> ModelResponse:
        if not isinstance(payload, dict) or not isinstance(payload.get("content"), list):
            raise self._invalid_response_error()
        text_parts: list[str] = []
        tool_calls: list[ToolCall] = []
        for block in payload.get("content") or []:
            if not isinstance(block, dict):
                continue
            if block.get("type") == "text":
                text_parts.append(str(block.get("text") or ""))
            elif block.get("type") == "tool_use":
                tool_calls.append(
                    ToolCall(
                        id=str(block.get("id") or f"tool-{len(tool_calls)}"),
                        name=str(block.get("name") or ""),
                        arguments=block.get("input") if isinstance(block.get("input"), dict) else {},
                    )
                )
        raw_usage = payload.get("usage") or {}
        usage = ModelUsage(
            input_tokens=int(raw_usage.get("input_tokens") or 0),
            output_tokens=int(raw_usage.get("output_tokens") or 0),
            total_tokens=int(raw_usage.get("input_tokens") or 0) + int(raw_usage.get("output_tokens") or 0),
        )
        return ModelResponse(
            content="".join(text_parts),
            tool_calls=tool_calls,
            usage=usage,
            provider_metadata={
                "model": payload.get("model") or self._model,
                "finish_reason": payload.get("stop_reason"),
                "response_id": payload.get("id") or "",
                "base_url": self._base_url,
                "protocol": self.name,
            },
        )

    @staticmethod
    def _stream_tool_call(part: dict[str, str]) -> ToolCall:
        try:
            arguments = json.loads(part["arguments"] or "{}")
        except json.JSONDecodeError as exc:
            raise ModelProviderError("invalid_tool_arguments", f"模型返回的工具参数无法解析：{part['name']}") from exc
        return ToolCall(id=part["id"], name=part["name"], arguments=arguments)

    @staticmethod
    def _raise_for_status(response: httpx.Response) -> None:
        response.raise_for_status()

    def _provider_error(self, exc: Exception) -> ModelProviderError:
        # Gateways may echo the key back in error bodies; never surface or store it.
        return self._map_provider_error(exc).redact(self._secret)

    @staticmethod
    def _map_provider_error(exc: Exception) -> ModelProviderError:
        policy_error = model_address_error(exc)
        if policy_error:
            return policy_error
        if isinstance(exc, httpx.TimeoutException):
            return ModelProviderError("request_timeout", "模型服务响应超时，请稍后重试", retryable=True)
        if isinstance(exc, httpx.RequestError):
            return ModelProviderError("service_unavailable", "无法连接模型服务，请检查网关地址或网络状态", retryable=True)
        if isinstance(exc, httpx.HTTPStatusError):
            status = exc.response.status_code
            if status in {401, 403}:
                return ModelProviderError("authentication_failed", "模型服务认证失败，请检查 API Key 是否有效")
            if status == 429:
                return ModelProviderError("rate_limited", "模型服务触发限流，请稍后重试", retryable=True)
            detail = ""
            try:
                payload = exc.response.json()
                error = payload.get("error") if isinstance(payload, dict) else None
                if isinstance(error, dict):
                    detail = str(error.get("message") or error.get("type") or "")
                elif isinstance(error, str):
                    detail = error
            except Exception:
                pass
            normalized_detail = detail.lower()
            if any(marker in normalized_detail for marker in _ACCOUNT_POOL_MARKERS):
                return ModelProviderError(
                    "account_pool_exhausted",
                    "模型网关没有可调度的上游账户，请联系服务商检查账户状态、额度或并发限制",
                    retryable=True,
                )
            if status == 404 and any(
                marker in normalized_detail for marker in _MODEL_UNAVAILABLE_MARKERS
            ):
                return ModelProviderError(
                    "model_unavailable",
                    f"当前账户组不支持模型 {detail[:160] or '（未知模型）'}",
                )
            if status in {404, 405}:
                return ModelProviderError(
                    "route_not_found",
                    "当前地址没有提供 Anthropic Messages 路由，可检查协议或 API 根路径",
                )
            message = f"模型服务返回异常状态（{status}）"
            if detail:
                message = f"{message}：{detail[:200]}"
            return ModelProviderError("provider_error", message, retryable=status >= 500)
        return AnthropicMessagesProvider._invalid_response_error()

    @staticmethod
    def _invalid_response_error() -> ModelProviderError:
        return ModelProviderError(
            "invalid_provider_response",
            "模型服务没有返回符合 Anthropic Messages 协议的响应内容",
        )

    def _record_event(
        self,
        request_kind: str,
        started_at: float,
        *,
        error: ModelProviderError | None = None,
        total_tokens: int = 0,
        usage: ModelUsage | None = None,
        response_id: str = "",
    ) -> None:
        try:
            record_model_service_event(
                request_kind=request_kind,
                status="error" if error else "success",
                error_code=error.code if error else "",
                error_message=str(error) if error else "",
                latency_ms=round((perf_counter() - started_at) * 1000),
                total_tokens=total_tokens,
                input_tokens=usage.input_tokens if usage else 0,
                output_tokens=usage.output_tokens if usage else 0,
                model_name=self._model,
                base_url=self._base_url,
                response_id=response_id,
                protocol=self.name,
            )
        except Exception:
            pass
