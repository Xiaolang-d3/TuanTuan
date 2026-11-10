from __future__ import annotations

import json

from collections.abc import AsyncIterator
from time import perf_counter
from typing import Any
from urllib.parse import quote

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


class GeminiGenerateContentProvider:
    name = "gemini"

    def __init__(
        self,
        api_key: str,
        model: str,
        base_url: str | None = None,
        timeout_seconds: float = 60,
    ) -> None:
        if not api_key:
            raise ValueError("启用 Gemini generateContent Provider 时必须配置 API Key")
        self._model = model.removeprefix("models/")
        self._secret = api_key  # masked in error messages
        remember_secret(api_key)  # masked verbatim in logs
        self._base_url = self._normalize_base_url(base_url)
        self._client = model_http_client(
            headers={
                "x-goog-api-key": api_key,
                "content-type": "application/json",
            },
            timeout=timeout_seconds,
        )

    @staticmethod
    def _normalize_base_url(base_url: str | None) -> str:
        if not base_url:
            return "https://generativelanguage.googleapis.com/v1beta"
        normalized = base_url.rstrip("/")
        if normalized == "https://generativelanguage.googleapis.com":
            return f"{normalized}/v1beta"
        return normalized

    @property
    def generate_url(self) -> str:
        return f"{self._base_url}/models/{quote(self._model, safe='')}:generateContent"

    @property
    def stream_url(self) -> str:
        return f"{self._base_url}/models/{quote(self._model, safe='')}:streamGenerateContent?alt=sse"

    @property
    def models_url(self) -> str:
        return f"{self._base_url}/models"

    async def generate(self, request: ModelRequest) -> ModelResponse:
        started_at = perf_counter()
        try:
            response = await self._client.post(self.generate_url, json=self._request_body(request))
            response.raise_for_status()
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
        content_parts: list[str] = []
        tool_calls: list[ToolCall] = []
        usage = ModelUsage()
        finish_reason = ""
        try:
            async with self._client.stream("POST", self.stream_url, json=self._request_body(request)) as response:
                if response.is_error:
                    await response.aread()
                response.raise_for_status()
                async for line in response.aiter_lines():
                    if not line.startswith("data:"):
                        continue
                    raw = line[5:].strip()
                    if not raw or raw == "[DONE]":
                        continue
                    payload = json.loads(raw)
                    text, calls, current_finish = self._parts_from_payload(payload)
                    if text:
                        content_parts.append(text)
                        yield ModelStreamEvent(type="text_delta", delta=text)
                    tool_calls.extend(calls)
                    finish_reason = current_finish or finish_reason
                    usage = self._usage_from_payload(payload)
        except (httpx.TimeoutException, httpx.RequestError, httpx.HTTPStatusError, ValueError, TypeError, json.JSONDecodeError) as exc:
            error = self._provider_error(exc)
            self._record_event("stream", started_at, error=error)
            raise error from exc
        if not content_parts and not tool_calls and not finish_reason and usage.total_tokens == 0:
            error = self._invalid_response_error()
            self._record_event("stream", started_at, error=error)
            raise error
        self._record_event("stream", started_at, total_tokens=usage.total_tokens, usage=usage)
        yield ModelStreamEvent(
            type="completed",
            response=ModelResponse(
                content="".join(content_parts),
                tool_calls=tool_calls,
                usage=usage,
                provider_metadata={
                    "model": self._model,
                    "finish_reason": finish_reason,
                    "response_id": "",
                    "base_url": self._base_url,
                    "protocol": self.name,
                },
            ),
        )

    async def check_connection(self) -> None:
        started_at = perf_counter()
        body = {
            "contents": [{"role": "user", "parts": [{"text": "仅回复 OK"}]}],
            "generationConfig": {"maxOutputTokens": 8},
        }
        try:
            response = await self._client.post(self.generate_url, json=body)
            response.raise_for_status()
            payload = response.json()
            result = self._response_from_payload(payload)
            validate_diagnostic_response(result, payload, self.name)
        except ModelProviderError as error:
            self._record_event("health_check", started_at, error=error)
            raise
        except (httpx.TimeoutException, httpx.RequestError, httpx.HTTPStatusError, ValueError) as exc:
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
            "contents": [
                {
                    "role": "user",
                    "parts": [
                        {"text": "只回复 OK"},
                        {
                            "inlineData": {
                                "mimeType": "image/png",
                                "data": _TINY_PNG_DATA_URL.split(",", 1)[1],
                            }
                        },
                    ],
                }
            ],
            "generationConfig": {"maxOutputTokens": 8},
        }
        try:
            response = await self._client.post(self.generate_url, json=body)
            response.raise_for_status()
            payload = response.json()
            result = self._response_from_payload(payload)
            validate_diagnostic_response(result, payload, self.name)
        except ModelProviderError as error:
            self._record_event("health_check", started_at, error=error)
            raise
        except (httpx.TimeoutException, httpx.RequestError, httpx.HTTPStatusError, ValueError) as exc:
            error = self._provider_error(exc)
            self._record_event("health_check", started_at, error=error)
            status = exc.response.status_code if isinstance(exc, httpx.HTTPStatusError) else None
            if _looks_like_vision_rejection(upstream_error_detail(exc), status):
                return {"status": "unsupported", "source": "probe", "detail": "服务拒绝了图片输入，当前模型不支持多模态"}
            raise error from exc
        self._record_event("health_check", started_at, total_tokens=result.usage.total_tokens if result.usage else 0, usage=result.usage)
        return {"status": "supported", "source": "probe", "detail": "服务接受了图片输入，当前模型支持多模态"}

    async def list_models(self) -> list[str]:
        try:
            response = await self._client.get(self.models_url)
            response.raise_for_status()
            payload = response.json()
            if not isinstance(payload, dict) or not isinstance(payload.get("models"), list):
                raise self._invalid_response_error()
        except ModelProviderError:
            raise
        except (httpx.TimeoutException, httpx.RequestError, httpx.HTTPStatusError, ValueError) as exc:
            raise self._provider_error(exc) from exc
        return sorted(
            {
                str(item.get("name") or "").removeprefix("models/").strip()
                for item in payload.get("models") or []
                if isinstance(item, dict) and str(item.get("name") or "").strip()
            }
        )

    def _request_body(self, request: ModelRequest) -> dict[str, Any]:
        settings = get_agent_settings()
        body: dict[str, Any] = {
            "systemInstruction": {"parts": [{"text": SYSTEM_PROMPT + persona_prompt(settings)}]},
            "contents": [self._convert_message(message) for message in request.messages if message.role != "system"],
        }
        parameters = request_parameters(request.parameters, "maxOutputTokens")
        if parameters:
            body["generationConfig"] = parameters
        if request.tools:
            body["tools"] = [
                {
                    "functionDeclarations": [
                        {
                            "name": tool.name,
                            "description": tool.description,
                            "parameters": tool.input_schema,
                        }
                        for tool in request.tools
                    ]
                }
            ]
            mode = {
                "auto": "AUTO",
                "required": "ANY",
                "none": "NONE",
            }[request.tool_choice]
            body["toolConfig"] = {"functionCallingConfig": {"mode": mode}}
        return body

    @staticmethod
    def _convert_message(message: Any) -> dict[str, Any]:
        if message.role == "assistant" and message.payload.get("tool_calls"):
            parts: list[dict[str, Any]] = []
            if message.content:
                parts.append({"text": message.content})
            parts.extend(
                {
                    "functionCall": {
                        "id": call["id"],
                        "name": call["name"],
                        "args": call.get("arguments", {}),
                    }
                }
                for call in message.payload["tool_calls"]
            )
            return {"role": "model", "parts": parts}
        if message.role == "tool":
            return {
                "role": "user",
                "parts": [
                    {
                        "functionResponse": {
                            "id": message.tool_call_id,
                            "name": str(message.payload.get("tool_name") or "tool"),
                            "response": message.payload,
                        }
                    }
                ],
            }
        parts = [{"text": message.content}] if message.content else []
        image_urls = message.payload.get("image_urls") if isinstance(message.payload, dict) else None
        if message.role == "user" and image_urls:
            parts.extend(
                GeminiGenerateContentProvider._image_part(url)
                for url in image_urls
                if isinstance(url, str) and url
            )
        return {"role": "model" if message.role == "assistant" else "user", "parts": parts}

    @staticmethod
    def _image_part(url: str) -> dict[str, Any]:
        if url.startswith("data:") and "," in url:
            header, data = url.split(",", 1)
            mime_type = header[5:].split(";", 1)[0] or "application/octet-stream"
            return {"inlineData": {"mimeType": mime_type, "data": data}}
        return {"fileData": {"mimeType": "application/octet-stream", "fileUri": url}}

    def _response_from_payload(self, payload: dict[str, Any]) -> ModelResponse:
        if not isinstance(payload, dict) or not isinstance(payload.get("candidates"), list):
            raise self._invalid_response_error()
        if not payload["candidates"]:
            raise ModelProviderError(
                "provider_error",
                "Gemini 服务没有返回候选答案，可能是内容安全策略阻止了本次响应",
            )
        text, tool_calls, finish_reason = self._parts_from_payload(payload)
        return ModelResponse(
            content=text,
            tool_calls=tool_calls,
            usage=self._usage_from_payload(payload),
            provider_metadata={
                "model": self._model,
                "finish_reason": finish_reason,
                "response_id": payload.get("responseId") or "",
                "base_url": self._base_url,
                "protocol": self.name,
            },
        )

    @staticmethod
    def _parts_from_payload(payload: dict[str, Any]) -> tuple[str, list[ToolCall], str]:
        candidates = payload.get("candidates") or []
        candidate = candidates[0] if candidates and isinstance(candidates[0], dict) else {}
        parts = (candidate.get("content") or {}).get("parts") or []
        text_parts: list[str] = []
        tool_calls: list[ToolCall] = []
        for part in parts:
            if not isinstance(part, dict):
                continue
            if "text" in part:
                text_parts.append(str(part.get("text") or ""))
            function_call = part.get("functionCall")
            if isinstance(function_call, dict):
                tool_calls.append(
                    ToolCall(
                        id=str(function_call.get("id") or f"gemini-call-{len(tool_calls)}"),
                        name=str(function_call.get("name") or ""),
                        arguments=function_call.get("args") if isinstance(function_call.get("args"), dict) else {},
                    )
                )
        return "".join(text_parts), tool_calls, str(candidate.get("finishReason") or "")

    @staticmethod
    def _usage_from_payload(payload: dict[str, Any]) -> ModelUsage:
        usage = payload.get("usageMetadata") or {}
        return ModelUsage(
            input_tokens=int(usage.get("promptTokenCount") or 0),
            output_tokens=int(usage.get("candidatesTokenCount") or 0),
            total_tokens=int(usage.get("totalTokenCount") or 0),
        )

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
                error = (exc.response.json() or {}).get("error") or {}
                detail = str(error.get("message") or error.get("status") or "") if isinstance(error, dict) else str(error)
            except Exception:
                pass
            normalized_detail = detail.lower()
            if any(marker in normalized_detail for marker in _ACCOUNT_POOL_MARKERS):
                return ModelProviderError(
                    "account_pool_exhausted",
                    "模型网关没有可调度的上游账户，请联系服务商检查账户状态、额度或并发限制",
                    retryable=True,
                )
            if status == 404 and any(marker in normalized_detail for marker in _MODEL_UNAVAILABLE_MARKERS):
                return ModelProviderError(
                    "model_unavailable",
                    f"当前账户组不支持模型 {detail[:160] or '（未知模型）'}",
                )
            if status in {404, 405}:
                return ModelProviderError(
                    "route_not_found",
                    "当前地址没有提供 Gemini generateContent 路由，可检查协议或 API 根路径",
                )
            message = f"模型服务返回异常状态（{status}）"
            if detail:
                message = f"{message}：{detail[:200]}"
            return ModelProviderError("provider_error", message, retryable=status >= 500)
        return GeminiGenerateContentProvider._invalid_response_error()

    @staticmethod
    def _invalid_response_error() -> ModelProviderError:
        return ModelProviderError("invalid_provider_response", "模型服务返回了无法解析的 Gemini 响应")

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
