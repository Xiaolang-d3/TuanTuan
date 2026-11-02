from __future__ import annotations

from ..branding import env

import logging
import os
from collections.abc import Callable

from .anthropic_messages import AnthropicMessagesProvider
from .auto_negotiating import AutoNegotiatingModelProvider, protocol_cache_key
from .gemini_generate_content import GeminiGenerateContentProvider
from .ollama_chat import OllamaChatProvider
from .openai_compatible import OpenAICompatibleProvider
from .openai_responses import OpenAIResponsesProvider
from .openai_images import OpenAIImagesProvider
from ..model_protocol import base_url_for_protocol, model_protocol_candidates, normalize_model_protocol


logger = logging.getLogger(__name__)

MODEL_BACKEND_ENV = "TUANTUAN_MODEL_BACKEND"
_NATIVE_CLASSES = {
    "openai": OpenAICompatibleProvider,
    "responses": OpenAIResponsesProvider,
    "images": OpenAIImagesProvider,
    "anthropic": AnthropicMessagesProvider,
    "gemini": GeminiGenerateContentProvider,
    "ollama": OllamaChatProvider,
}


_BACKENDS = ("litellm", "native")
_warned: set[str] = set()


def _warn_once(key: str, message: str, *args: object) -> None:
    # model_backend() runs on every provider cache lookup; log each problem once.
    if key not in _warned:
        _warned.add(key)
        logger.warning(message, *args)


def model_backend() -> str:
    """``litellm`` (default) or ``native``; the native adapters stay for one release as a rollback."""
    raw = env(MODEL_BACKEND_ENV) or ""
    requested = raw.strip().lower() or "litellm"
    if requested not in _BACKENDS:
        _warn_once(
            f"unknown:{requested}",
            "Unknown %s=%r (expected 'litellm' or 'native'); using litellm", MODEL_BACKEND_ENV, raw,
        )
        requested = "litellm"
    if requested == "native":
        return "native"
    from .litellm_core import litellm_available

    if not litellm_available():
        _warn_once("missing", "LiteLLM is not installed; falling back to the native model adapters")
        return "native"
    return "litellm"


def _provider_class(candidate: str, backend: str):
    if candidate == "images":
        # Images are a single paid operation, outside Completion retries/router.
        return OpenAIImagesProvider
    if backend == "litellm":
        from .litellm_provider import LiteLLMProvider

        def build(**kwargs):
            return LiteLLMProvider(protocol=candidate, **kwargs)

        return build
    return _NATIVE_CLASSES[candidate]


def build_model_provider(
    *,
    api_key: str,
    model: str,
    base_url: str | None = None,
    timeout_seconds: float = 60,
    protocol: str = "auto",
    detected_protocol: str | None = None,
    on_protocol_detected: Callable[[str], None] | None = None,
    backend: str | None = None,
    price_per_million_input: float | None = None,
    price_per_million_output: float | None = None,
):
    """Build a provider; auto mode may start from a previously detected protocol."""
    backend = backend or model_backend()
    extra = (
        {"price_per_million_input": price_per_million_input, "price_per_million_output": price_per_million_output}
        if backend == "litellm" else {}
    )
    candidates = model_protocol_candidates(model, protocol, base_url or "")
    providers = [
        (
            candidate,
            _provider_class(candidate, backend)(
                api_key=api_key,
                model=model,
                base_url=base_url_for_protocol(
                    base_url,
                    candidate,
                    fallback=index > 0,
                ),
                timeout_seconds=timeout_seconds,
                **(extra if candidate != "images" else {}),
            ),
        )
        for index, candidate in enumerate(candidates)
    ]
    if normalize_model_protocol(protocol) != "auto" or len(providers) == 1:
        return providers[0][1]
    return AutoNegotiatingModelProvider(
        providers,
        protocol_cache_key(base_url, model, api_key),
        preferred=detected_protocol,
        on_protocol_detected=on_protocol_detected,
    )
