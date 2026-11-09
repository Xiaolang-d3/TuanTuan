from __future__ import annotations

import re
from typing import Literal
from urllib.parse import urlsplit, urlunsplit


ModelProtocol = Literal["auto", "openai", "responses", "images", "anthropic", "gemini", "ollama"]
ResolvedModelProtocol = Literal["openai", "responses", "images", "anthropic", "gemini", "ollama"]

PROTOCOL_LABELS: dict[ResolvedModelProtocol, str] = {
    "openai": "OpenAI 兼容 Chat Completions",
    "responses": "OpenAI Responses API",
    "images": "OpenAI Images API",
    "anthropic": "Anthropic Messages API",
    "gemini": "Google Gemini generateContent",
    "ollama": "Ollama Chat API",
}


def normalize_model_protocol(value: str | None) -> ModelProtocol:
    normalized = (value or "auto").strip().lower()
    if normalized in PROTOCOL_LABELS:
        return normalized  # type: ignore[return-value]
    return "auto"


def resolve_model_protocol(
    model_name: str,
    configured: str | None = "auto",
    base_url: str = "",
) -> ResolvedModelProtocol:
    protocol = normalize_model_protocol(configured)
    if protocol != "auto":
        return protocol
    normalized_model = model_name.strip().lower()
    normalized_url = base_url.strip().lower()
    if normalized_model.startswith("gpt-image-"):
        return "images"
    if "anthropic.com" in normalized_url:
        return "anthropic"
    if "generativelanguage.googleapis.com" in normalized_url:
        return "gemini"
    if "ollama" in normalized_url or ":11434" in normalized_url:
        return "ollama"
    # Multi-protocol gateways commonly expose both native and compatibility
    # endpoints. Prefer the model family's native wire format; a user can
    # still force a compatibility protocol with an explicit selection.
    if "claude" in normalized_model:
        return "anthropic"
    if "gemini" in normalized_model:
        return "gemini"
    return "openai"


def model_protocol_for_profile(model_name: str, connection_protocol: str = "auto", capabilities: dict | None = None, base_url: str = "") -> str:
    """Select a model adapter within a shared compatibility service."""
    protocol = normalize_model_protocol(connection_protocol)
    if model_name.strip().lower().startswith("gpt-image-") and protocol in {"auto", "openai", "responses", "images"}:
        return "images"
    # Provider-declared image-only aliases share the service's credentials but
    # require the existing Images action. A native Gemini/Anthropic/Ollama
    # connection cannot acquire an unsupported action from output metadata.
    caps = capabilities or {}
    native_auto = protocol == "auto" and any(marker in base_url.lower() for marker in ("anthropic.com", "generativelanguage.googleapis.com", "ollama", ":11434"))
    if caps.get("image_generation") == "supported" and caps.get("chat") == "unsupported" and protocol in {"auto", "openai", "responses", "images"} and not native_auto:
        return "images"
    return protocol


def model_protocol_candidates(
    model_name: str,
    configured: str | None = "auto",
    base_url: str = "",
) -> tuple[ResolvedModelProtocol, ...]:
    """Return the ordered protocols that auto mode may safely negotiate."""
    protocol = normalize_model_protocol(configured)
    primary = resolve_model_protocol(model_name, protocol, base_url)
    if protocol != "auto":
        return (primary,)
    if primary == "images":
        return (primary,)
    normalized_url = base_url.strip().lower()
    if any(
        marker in normalized_url
        for marker in ("anthropic.com", "generativelanguage.googleapis.com", "ollama", ":11434")
    ):
        return (primary,)
    if primary == "openai":
        # Some newer models are served only over the Responses API; auto mode
        # retries there when Chat Completions is explicitly rejected.
        return ("openai", "responses")
    if not normalized_url:
        return (primary,)
    if any(
        marker in normalized_url
        for marker in ("anthropic.com", "generativelanguage.googleapis.com", "ollama", ":11434")
    ):
        return (primary,)
    if primary in {"anthropic", "gemini"}:
        return (primary, "openai")
    return (primary, "responses") if primary == "openai" else (primary,)


def is_image_generation_model(model_name: str, configured: str | None = "auto", base_url: str = "") -> bool:
    """Whether this adapter supports generating image output, not image input."""
    if resolve_model_protocol(model_name, configured, base_url) == "images":
        return True
    return normalize_model_protocol(configured) in {"auto", "responses"} and bool(
        re.match(r"^grok-4\.7(?:[-.]|$)", model_name, re.I)
    )


def base_url_for_protocol(
    base_url: str | None,
    protocol: ResolvedModelProtocol,
    *,
    fallback: bool = False,
) -> str | None:
    """Adapt only a root URL when negotiating a standard compatibility route."""
    normalized = (base_url or "").strip().rstrip("/")
    if not normalized or protocol != "openai" or not fallback:
        return normalized or None
    parsed = urlsplit(normalized)
    if parsed.path not in {"", "/"}:
        return normalized
    return urlunsplit((parsed.scheme, parsed.netloc, "/v1", parsed.query, parsed.fragment))


def protocol_requires_api_key(protocol: str) -> bool:
    return normalize_model_protocol(protocol) != "ollama"


def model_protocol_label(
    model_name: str,
    configured: str | None = "auto",
    base_url: str = "",
) -> str:
    return PROTOCOL_LABELS[resolve_model_protocol(model_name, configured, base_url)]


def normalize_detected_protocol(value: str | None) -> ResolvedModelProtocol | None:
    """Return a concrete protocol remembered from negotiation, or None."""
    normalized = (value or "").strip().lower()
    return normalized if normalized in PROTOCOL_LABELS else None  # type: ignore[return-value]


def connection_protocol_label(
    configured: str | None,
    detected: str | None = None,
    model_name: str = "",
    base_url: str = "",
) -> str:
    """Human label for a connection's protocol, including what auto mode settled on."""
    protocol = normalize_model_protocol(configured)
    if protocol != "auto":
        return PROTOCOL_LABELS[protocol]
    actual = normalize_detected_protocol(detected)
    if actual:
        return f"自动 · 实际使用 {PROTOCOL_LABELS[actual]}"
    return f"自动 · 优先 {PROTOCOL_LABELS[resolve_model_protocol(model_name, 'auto', base_url)]}"
