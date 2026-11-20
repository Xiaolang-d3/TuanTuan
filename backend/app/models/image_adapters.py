"""Resolve workbench capabilities and the matching paid image adapter."""
from __future__ import annotations

from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Literal, Protocol, runtime_checkable

from ..domain import ModelResponse
from ..model_protocol import is_image_generation_model, resolve_model_protocol
from .openai_images import OpenAIImagesProvider
from .openai_responses import OpenAIResponsesProvider

ImageSize = Literal["auto", "1024x1024", "1536x1024", "1024x1536"]
ImageOperation = Literal["generate", "edit"]

# Only expose explicit pixel sizes for known model IDs. Generic Images
# gateways retain their minimal request shape with automatic sizing.
_GPT_IMAGE_MODELS = frozenset({"gpt-image-1", "gpt-image-1-mini", "gpt-image-1.5", "gpt-image-2"})
_AUTO: tuple[ImageSize, ...] = ("auto",)
_GPT_SIZES: tuple[ImageSize, ...] = ("auto", "1024x1024", "1536x1024", "1024x1536")
_SQUARE_SIZES: tuple[ImageSize, ...] = ("auto", "1024x1024")


@runtime_checkable
class ImageEditor(Protocol):
    async def edit_image(self, image: bytes, prompt: str, *, mask: bytes | None = None,
                         transparent: bool = False, size: str | None = None) -> ModelResponse: ...


@dataclass(frozen=True)
class ImageAdapter:
    provider: type[OpenAIImagesProvider] | type[OpenAIResponsesProvider]
    generate_sizes: tuple[ImageSize, ...]
    edit_sizes: tuple[ImageSize, ...] = ()

    def size_for_wire(self, operation: ImageOperation, size: str) -> str | None:
        sizes = self.generate_sizes if operation == "generate" else self.edit_sizes
        if size not in sizes:
            raise ValueError("所选模型不支持此画幅，请重新选择")
        return None if size == "auto" else size

    def public_capabilities(self) -> dict[str, dict[str, tuple[ImageSize, ...]] | None]:
        return {
            "generate": {"sizes": self.generate_sizes},
            "edit": {"sizes": self.edit_sizes} if self.edit_sizes else None,
        }

    @asynccontextmanager
    async def open_editor(self, connection: dict):
        if not self.edit_sizes:
            raise ValueError("所选模型不支持图片编辑")
        async with self.open(connection) as provider:
            if not isinstance(provider, ImageEditor):
                raise RuntimeError("图片编辑能力与接口配置不一致")
            yield provider

    @asynccontextmanager
    async def open(self, connection: dict):
        provider = self.provider(
            api_key=connection["api_key"],
            model=connection["model_name"],
            base_url=connection["model_base_url"],
        )
        try:
            yield provider
        finally:
            await provider._client.close()


def image_adapter(model: str, protocol: str, base_url: str) -> ImageAdapter | None:
    if resolve_model_protocol(model, protocol, base_url) == "images":
        name = model.strip().lower()
        sizes = _AUTO
        if name in _GPT_IMAGE_MODELS:
            sizes = _GPT_SIZES
        elif name in {"dall-e-2", "dall-e-3"}:
            sizes = _SQUARE_SIZES
        return ImageAdapter(OpenAIImagesProvider, sizes, sizes)
    if is_image_generation_model(model, protocol, base_url):
        return ImageAdapter(OpenAIResponsesProvider, _AUTO)
    return None


def connection_image_adapter(connection: dict) -> ImageAdapter:
    adapter = image_adapter(connection["model_name"], connection["model_protocol"], connection["model_base_url"])
    if adapter is None:
        raise ValueError("所选模型没有可用的图片接口")
    return adapter
