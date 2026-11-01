"""Resolve a draft without allowing a saved credential to cross API roots."""
from __future__ import annotations

from .branding import env

import os
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from .model_protocol import normalize_model_protocol, resolve_model_protocol


DEFAULT_API_ROOTS = {
    "openai": "https://api.openai.com/v1",
    "responses": "https://api.openai.com/v1",
    "images": "https://api.openai.com/v1",
    "anthropic": "https://api.anthropic.com",
    "gemini": "https://generativelanguage.googleapis.com/v1beta",
    "ollama": "http://127.0.0.1:11434",
}


def normalize_api_root(base_url: str, protocol: str = "openai") -> str:
    """Canonicalize the complete API root, preserving custom tenant paths."""
    value = str(base_url or "").strip()
    if not value:
        value = DEFAULT_API_ROOTS[protocol]
    try:
        parsed = urlsplit(value)
        port = parsed.port
    except ValueError as exc:
        raise ValueError("Base URL 格式不正确") from exc
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
        raise ValueError("Base URL 需要包含 http:// 或 https:// 和服务地址")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("Base URL 不能包含账号或密钥，请在 API Key 中填写凭证")
    if parsed.query or parsed.fragment:
        raise ValueError("Base URL 应为 API 根地址，不能包含查询参数或片段")
    if env("TUANTUAN_DEPLOYMENT_MODE", "local").strip().lower() == "hosted":
        allowed = {"api.openai.com", "api.anthropic.com", "generativelanguage.googleapis.com"}
        allowed.update(host.strip().lower() for host in env("TUANTUAN_MODEL_ALLOWED_HOSTS", "").split(",") if host.strip())
        if parsed.scheme.lower() != "https" or parsed.hostname.lower() not in allowed:
            raise ValueError("托管模式只允许使用已授权的 HTTPS 模型服务地址")
    scheme = parsed.scheme.lower()
    host = parsed.hostname.lower()
    if ":" in host:
        host = f"[{host}]"
    if port is not None and (scheme, port) not in {("http", 80), ("https", 443)}:
        host = f"{host}:{port}"
    path = parsed.path.rstrip("/")
    if protocol == "images" and not path:
        path = "/v1"
    if protocol == "gemini" and parsed.hostname.lower() == "generativelanguage.googleapis.com" and not path:
        path = "/v1beta"
    return urlunsplit((scheme, host, path, "", ""))


def resolve_model_connection(
    values: dict[str, Any], saved: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Omission inherits; an explicit blank address selects the protocol default.

    Credential reuse requires the same full canonical root. In particular, an
    empty draft key is never permission to send a stored key to another host,
    port, scheme or tenant path. This function performs no storage/network I/O.
    """
    current = saved or {}
    model_name = str(values.get("model_name") or current.get("model_name") or "").strip()
    protocol = normalize_model_protocol(values.get("model_protocol", current.get("model_protocol", "auto")))
    saved_base = str(current.get("configured_model_base_url", current.get("model_base_url", "")) or "").strip()
    configured_base = str(values.get("model_base_url", saved_base) or "").strip()
    resolved_protocol = resolve_model_protocol(model_name, protocol, configured_base)
    effective_base = normalize_api_root(configured_base, resolved_protocol)
    saved_protocol = resolve_model_protocol(
        str(current.get("model_name") or ""), current.get("model_protocol", "auto"), saved_base,
    )
    saved_effective_base = normalize_api_root(saved_base, saved_protocol)
    submitted_key = str(values.get("api_key") or "").strip()
    saved_key = str(current.get("api_key") or "").strip()
    if resolved_protocol == "ollama":
        api_key = ""
    elif submitted_key:
        api_key = submitted_key
    elif saved_key and effective_base != saved_effective_base:
        raise ValueError("服务地址已改变，请填写目标服务的 API Key；旧密钥不能用于新地址")
    else:
        api_key = saved_key
    return {
        **current,
        "model_name": model_name,
        "model_base_url": effective_base,
        "configured_model_base_url": configured_base,
        "model_protocol": protocol,
        "resolved_model_protocol": resolved_protocol,
        "api_key": api_key,
    }
