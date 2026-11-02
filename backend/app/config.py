from __future__ import annotations

from .branding import env

import os
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field
from dotenv import dotenv_values, load_dotenv


BACKEND_DIR = Path(__file__).resolve().parents[1]
load_dotenv(BACKEND_DIR / ".env")

LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}
_FRONTEND_PORTS = (5173, 4173)


def _split_list(raw: str | None) -> list[str]:
    return [item.strip() for item in (raw or "").split(",") if item.strip()]


def _origins_for_hosts(hosts: list[str]) -> list[str]:
    return [f"http://{host}:{port}" for host in hosts for port in _FRONTEND_PORTS]


def _is_loopback(host: str) -> bool:
    return host.strip().strip("[]") in LOOPBACK_HOSTS


class Settings(BaseModel):
    bind_host: str = "127.0.0.1"
    allowed_origins: list[str] = Field(default_factory=list)
    api_docs_enabled: bool = True
    login_max_attempts: int = Field(default=5, ge=1, le=100)
    login_lockout_seconds: int = Field(default=300, ge=30, le=86_400)
    auth_token_ttl_seconds: int = Field(default=28_800, ge=300, le=86_400)
    model_provider: str = "openai"
    model_protocol: Literal["auto", "openai", "responses", "images", "anthropic", "gemini", "ollama"] = "auto"
    model_name: str = ""
    model_base_url: str | None = None
    openai_api_key: str | None = None
    model_timeout_seconds: float = Field(default=60, gt=0, le=300)
    model_max_tool_rounds: int = Field(default=8, ge=1, le=20)
    model_retry_attempts: int = Field(default=1, ge=0, le=3)
    tool_execution_timeout_seconds: float = Field(default=60, gt=0, le=300)
    tool_retry_attempts: int = Field(default=1, ge=0, le=3)
    attachment_storage: Literal["local", "minio"] = "local"
    minio_endpoint: str | None = None
    minio_access_key: str | None = None
    minio_secret_key: str | None = None
    minio_bucket: str = "tuantuan-attachments"
    minio_bucket_legacy_fallback: bool = True
    minio_secure: bool = False
    minio_public_endpoint: str | None = None
    attachment_vision_enabled: bool = False
    attachment_vision_url_ttl_seconds: int = Field(default=300, ge=60, le=3600)
    web_research_enabled: bool = False
    web_search_provider: Literal["auto", "tavily", "agent_search"] = "auto"
    tavily_api_key: str | None = Field(default=None, repr=False)
    agent_search_base_url: str = "http://127.0.0.1:3939"
    agent_search_token: str | None = None
    web_research_timeout_seconds: float = Field(default=25, gt=0, le=120)
    web_research_max_sources: int = Field(default=10, ge=3, le=20)
    artificial_analysis_api_key: str | None = Field(default=None, repr=False, exclude=True)

    @property
    def is_loopback_only(self) -> bool:
        return _is_loopback(self.bind_host)

    @property
    def resolved_web_search_provider(self) -> Literal["tavily", "agent_search"]:
        if self.web_search_provider != "auto":
            return self.web_search_provider
        return "tavily" if (self.tavily_api_key or "").strip() else "agent_search"


def _int_env(name: str, default: int) -> int:
    raw = (os.getenv(name) or "").strip()
    return int(raw) if raw.isdigit() else default


def _benchmark_api_key() -> str | None:
    key = (os.getenv("ARTIFICIAL_ANALYSIS_API_KEY") or "").strip()
    if key:
        return key
    # Hosted releases disable automatic dotenv loading. Read only this service
    # credential from an explicitly selected file, without importing model keys
    # or expanding references to other environment variables.
    filename = (env("TUANTUAN_BENCHMARK_ENV_FILE") or "").strip()
    if not filename:
        return None
    try:
        with Path(filename).open(encoding="utf-8-sig") as source:
            values = dotenv_values(stream=source, interpolate=False)
    except FileNotFoundError:
        return None
    return (values.get("ARTIFICIAL_ANALYSIS_API_KEY") or "").strip() or None


def _resolve_allowed_origins(bind_host: str) -> list[str]:
    """Loopback origins always work; extra hosts must be named explicitly."""
    origins = _origins_for_hosts(["127.0.0.1", "localhost"])
    origins.extend(_origins_for_hosts(_split_list(os.getenv("PUBLIC_HOSTS"))))
    origins.extend(_split_list(os.getenv("ALLOWED_ORIGINS")))
    if not _is_loopback(bind_host):
        origins.extend(_origins_for_hosts([bind_host]))
    # Tauri's production WebView serves the bundled SPA from this origin while
    # the API remains on loopback.  Never enable it for ordinary web hosting.
    if env("TUANTUAN_DESKTOP", "false").lower() == "true":
        origins.extend(["http://tauri.localhost", "https://tauri.localhost", "tauri://localhost", "asset://localhost"])
    return list(dict.fromkeys(origins))


@lru_cache
def get_settings() -> Settings:
    bind_host = os.getenv("BIND_HOST", "127.0.0.1").strip() or "127.0.0.1"
    return Settings(
        bind_host=bind_host,
        allowed_origins=_resolve_allowed_origins(bind_host),
        api_docs_enabled=os.getenv(
            "API_DOCS_ENABLED",
            "true" if _is_loopback(bind_host) else "false",
        ).lower() == "true",
        login_max_attempts=_int_env("LOGIN_MAX_ATTEMPTS", 5),
        login_lockout_seconds=_int_env("LOGIN_LOCKOUT_SECONDS", 300),
        auth_token_ttl_seconds=os.getenv("AUTH_TOKEN_TTL_SECONDS", "28800"),
        model_provider=os.getenv("MODEL_PROVIDER", "openai"),
        model_protocol=os.getenv("MODEL_PROTOCOL", "auto"),
        model_name=os.getenv("MODEL_NAME", ""),
        model_base_url=os.getenv("MODEL_BASE_URL") or None,
        openai_api_key=os.getenv("OPENAI_API_KEY") or None,
        model_timeout_seconds=os.getenv("MODEL_TIMEOUT_SECONDS", "60"),
        model_max_tool_rounds=os.getenv("MODEL_MAX_TOOL_ROUNDS", "8"),
        model_retry_attempts=os.getenv("MODEL_RETRY_ATTEMPTS", "1"),
        tool_execution_timeout_seconds=os.getenv("TOOL_EXECUTION_TIMEOUT_SECONDS", "60"),
        tool_retry_attempts=os.getenv("TOOL_RETRY_ATTEMPTS", "1"),
        attachment_storage=os.getenv("ATTACHMENT_STORAGE", "local"),
        minio_endpoint=os.getenv("MINIO_ENDPOINT") or None,
        minio_access_key=os.getenv("MINIO_ACCESS_KEY") or None,
        minio_secret_key=os.getenv("MINIO_SECRET_KEY") or None,
        minio_bucket=os.getenv("MINIO_BUCKET", "tuantuan-attachments"),
        minio_bucket_legacy_fallback="MINIO_BUCKET" not in os.environ,
        minio_secure=os.getenv("MINIO_SECURE", "false").lower() == "true",
        minio_public_endpoint=os.getenv("MINIO_PUBLIC_ENDPOINT") or None,
        attachment_vision_enabled=os.getenv("ATTACHMENT_VISION_ENABLED", "false").lower() == "true",
        attachment_vision_url_ttl_seconds=os.getenv("ATTACHMENT_VISION_URL_TTL_SECONDS", "300"),
        web_research_enabled=os.getenv("WEB_RESEARCH_ENABLED", "false").lower() == "true",
        web_search_provider=os.getenv("WEB_SEARCH_PROVIDER", "auto").strip().lower(),
        tavily_api_key=(os.getenv("TAVILY_API_KEY") or "").strip() or None,
        agent_search_base_url=os.getenv("AGENT_SEARCH_BASE_URL", "http://127.0.0.1:3939"),
        agent_search_token=os.getenv("AGENT_SEARCH_TOKEN") or None,
        web_research_timeout_seconds=os.getenv("WEB_RESEARCH_TIMEOUT_SECONDS", "25"),
        web_research_max_sources=os.getenv("WEB_RESEARCH_MAX_SOURCES", "10"),
        artificial_analysis_api_key=_benchmark_api_key(),
    )
