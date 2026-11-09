"""Non-streaming Images API; never retry a possibly billed generation."""
from __future__ import annotations

import asyncio
import base64
import ipaddress
import socket
from collections.abc import AsyncIterator
from time import perf_counter
from typing import Any
from urllib.parse import urlsplit

import httpx
from openai import APIError, APIStatusError

from ..domain import ModelRequest, ModelResponse, ModelStreamEvent, ModelUsage
from ..domain.agent import ModelImageOutput
from ..model_connection import normalize_api_root
from .base import ModelProviderError
from .openai_compatible import OpenAICompatibleProvider


class OpenAIImagesProvider(OpenAICompatibleProvider):
    name = "images"
    _image_download_transport: httpx.AsyncBaseTransport | None = None

    @staticmethod
    def _normalize_base_url(base_url: str | None) -> str:
        return normalize_api_root(base_url or "", "images")

    async def generate(self, request: ModelRequest) -> ModelResponse:
        # Selecting an image model alone must not turn a text/diagnostic request
        # into an unexpected paid generation.
        if not request.image_generation:
            raise ModelProviderError("image_prompt_required", "当前选择的是图片模型，请发送明确的生图指令，或切换聊天模型")
        if any(message.payload.get("image_urls") for message in request.messages):
            raise ModelProviderError("image_edit_not_supported", "当前支持文字生图；基于附件的图片编辑尚未接入")
        prompt = next((message.content.strip() for message in reversed(request.messages) if message.role == "user"), "")
        if not prompt:
            raise ModelProviderError("image_prompt_required", "请填写图片描述")
        started_at = perf_counter()
        try:
            # Live Packy routes reject response_format despite the tutorial's
            # optional-parameter table. Send only the documented minimum; never
            # negotiate by resending a potentially billed generation.
            raw = await self._client.with_options(timeout=300, max_retries=0).images.generate(
                model=self._model, prompt=prompt, n=1,
            )
            result = await self._response_from_images(raw)
        except APIError as exc:
            error = self._provider_error(exc)
            error.retryable = False
            self._record_event("generate", started_at, error=error)
            raise error from exc
        except ModelProviderError as error:
            self._record_event("generate", started_at, error=error)
            raise
        except (ValueError, TypeError, AttributeError) as exc:
            error = ModelProviderError("invalid_provider_response", "生图服务返回了无法解析的 Images API 响应；不会自动重新生成")
            self._record_event("generate", started_at, error=error)
            raise error from exc
        self._record_event("generate", started_at, usage=result.usage,
                           total_tokens=result.usage.total_tokens if result.usage else 0)
        return result

    async def edit_image(self, image: bytes, prompt: str, *, mask: bytes | None = None,
                         transparent: bool = False) -> ModelResponse:
        """One explicit edit; never retry or fall back to a billed generation."""
        arguments: dict[str, Any] = {
            "model": self._model, "prompt": prompt, "n": 1,
            "image": ("source.png", image, "image/png"),
        }
        if mask is not None:
            arguments["mask"] = ("mask.png", mask, "image/png")
        if transparent:
            arguments["background"] = "transparent"
        started_at = perf_counter()
        try:
            raw = await self._client.with_options(timeout=300, max_retries=0).images.edit(**arguments)
            result = await self._response_from_images(raw)
        except APIError as exc:
            error = self._provider_error(exc)
            error.retryable = False
            self._record_event("edit", started_at, error=error)
            raise error from exc
        self._record_event("edit", started_at, usage=result.usage)
        return result

    async def _response_from_images(self, raw: Any) -> ModelResponse:
        data = getattr(raw, "data", None)
        if not isinstance(data, list) or not data:
            raise ModelProviderError("image_generation_not_executed", "服务没有返回生成的图片，请确认 sora 分组令牌与模型权限；不会自动重新生成")
        if len(data) != 1:
            raise ModelProviderError("invalid_image_output", "生图服务未按 n=1 返回图片；不会自动重新生成")
        encoded = getattr(data[0], "b64_json", None)
        if not encoded and getattr(data[0], "url", None):
            encoded = await self._download_image(data[0].url)
        if not isinstance(encoded, str) or not encoded:
            raise ModelProviderError("invalid_image_output", "服务没有返回图片数据或可用的图片地址；不会自动重新生成")
        if len(encoded) > 28_000_000:
            raise ModelProviderError("invalid_image_output", "生成的图片超过 20 MB；不会自动重新生成")
        raw_usage = getattr(raw, "usage", None)
        usage = None
        if raw_usage is not None:
            usage = ModelUsage(input_tokens=int(getattr(raw_usage, "input_tokens", 0) or 0),
                               output_tokens=int(getattr(raw_usage, "output_tokens", 0) or 0),
                               total_tokens=int(getattr(raw_usage, "total_tokens", 0) or 0))
        return ModelResponse(
            images=[ModelImageOutput(item_id="image-0", base64_data=encoded)],
            output_blocks=[{"type": "image", "index": 0}], usage=usage,
            provider_metadata={"model": self._model, "base_url": self._base_url, "protocol": self.name},
        )

    async def _download_image(self, url: str) -> str:
        # A separate client never forwards the generation API's bearer token.
        # Providers may use their own CDN. Resolve and pin a public address so
        # DNS rebinding, redirects and environment proxies cannot reach a LAN.
        try:
            parsed = urlsplit(url)
            allowed = (parsed.scheme == "https" and parsed.hostname
                       and parsed.port in {None, 443} and not parsed.username and not parsed.password
                       and not parsed.fragment and not any(ord(char) <= 32 for char in url)
                       and not parsed.hostname.rstrip('.').endswith(('localhost', '.local', '.internal')))
            if not allowed:
                raise ValueError("Unsupported image URL")
            source_url = httpx.URL(url)
            hostname = source_url.raw_host.decode('ascii')
            try:
                addresses = [ipaddress.ip_address(hostname)]
            except ValueError:
                resolved = await asyncio.wait_for(
                    asyncio.get_running_loop().getaddrinfo(hostname, 443, type=socket.SOCK_STREAM),
                    timeout=10,
                )
                addresses = [ipaddress.ip_address(address[4][0]) for address in resolved]
                # Clash fake-IP DNS cannot be used as proof of a public target.
                # Resolve through a fixed HTTPS resolver, then validate and pin
                # its real answer. Only the hostname is sent, never signed URLs.
                fake_network = ipaddress.ip_network('198.18.0.0/15')
                if addresses and all(address in fake_network for address in addresses):
                    async with httpx.AsyncClient(timeout=10, trust_env=False, follow_redirects=False,
                                                 transport=self._image_download_transport) as resolver:
                        answer = await resolver.get(
                            'https://1.1.1.1/dns-query', params={'name': hostname, 'type': 'A'},
                            headers={'Host': 'cloudflare-dns.com', 'Accept': 'application/dns-json'},
                            extensions={'sni_hostname': 'cloudflare-dns.com'},
                        )
                        answer.raise_for_status()
                        records = answer.json()
                        if records.get('Status') != 0:
                            raise ValueError('Public DNS resolution failed')
                        addresses = [ipaddress.ip_address(record['data'])
                                     for record in records.get('Answer', []) if record.get('type') == 1]
            if not addresses or any(not address.is_global or address.is_multicast or address.is_reserved
                                    for address in addresses):
                raise ValueError("Image URL must resolve only to public addresses")
            download_url = source_url.copy_with(host=str(addresses[0]))
        except (ValueError, TypeError, KeyError, AttributeError):
            raise ModelProviderError("invalid_image_output", "服务返回的图片地址必须是公网 HTTPS 地址，且不能包含账号或使用非标准端口；不会自动重新生成") from None
        except (OSError, TimeoutError, httpx.HTTPError) as exc:
            raise ModelProviderError("image_download_failed", "图片已生成，但图片地址解析失败。请保留服务记录；不会自动重新生成") from exc
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(60, connect=10), follow_redirects=False,
                                         trust_env=False,
                                         transport=self._image_download_transport) as client:
                # Keep the original virtual host and TLS certificate check while
                # connecting directly to the address validated above.
                host_header = f'[{hostname}]' if ':' in hostname else hostname
                async with client.stream("GET", download_url, headers={"Host": host_header},
                                         extensions={"sni_hostname": hostname}) as response:
                    response.raise_for_status()
                    declared = response.headers.get("content-length", "")
                    if declared.isdigit() and int(declared) > 20_000_000:
                        raise ModelProviderError("invalid_image_output", "生成的图片超过 20 MB；不会自动重新生成")
                    content = bytearray()
                    async for chunk in response.aiter_bytes():
                        content.extend(chunk)
                        if len(content) > 20_000_000:
                            raise ModelProviderError("invalid_image_output", "生成的图片超过 20 MB；不会自动重新生成")
            if not content:
                raise ModelProviderError("invalid_image_output", "图片下载结果为空；不会自动重新生成")
            return base64.b64encode(content).decode("ascii")
        except httpx.HTTPError as exc:
            raise ModelProviderError("image_download_failed", "图片已生成，但下载失败。请保留服务记录；不会自动重新生成") from exc

    def _provider_error(self, exc: Exception) -> ModelProviderError:
        if isinstance(exc, APIStatusError) and exc.status_code == 400:
            detail = str(exc).lower()
            if "transparent background" in detail and any(marker in detail for marker in ("not supported", "unsupported", "does not support")):
                return ModelProviderError(
                    "transparent_background_unsupported",
                    "当前模型服务不支持透明背景，无法完成移除背景。请切换支持透明背景的图像模型后重新提交；本次不会自动重试。",
                )
        if isinstance(exc, APIStatusError) and exc.status_code in {404, 405}:
            return ModelProviderError("route_not_found", "当前地址没有提供 Images API，请检查 /v1/images/generations 与 sora 分组令牌")
        return super()._provider_error(exc)

    async def stream(self, request: ModelRequest) -> AsyncIterator[ModelStreamEvent]:
        # The application can keep its SSE progress connection while the image
        # endpoint receives exactly one ordinary, non-streaming POST.
        yield ModelStreamEvent(type="completed", response=await self.generate(request))

    async def check_connection(self) -> None:
        # Health checks never buy a sample image or call a text endpoint.
        started_at = perf_counter()
        try:
            if self._model not in await self.list_models():
                raise ModelProviderError("model_unavailable", "模型目录未包含当前图片模型，请检查 sora 分组令牌；尚未执行生图")
        except ModelProviderError as error:
            self._record_event("health_check", started_at, error=error)
            raise
        self._record_event("health_check", started_at)

    async def probe_vision(self) -> dict[str, str]:
        return {"status": "unsupported", "source": "client", "detail": "当前 Images 接入仅支持文字生图，未接入图片编辑"}
