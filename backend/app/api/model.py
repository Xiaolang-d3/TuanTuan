from __future__ import annotations

import asyncio
import sqlite3
from datetime import datetime, timezone
from typing import Any
from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, Field

from .. import chatgpt_subscription as subscription
from ..chatgpt_store import SubscriptionStoreError
from ..workspace import resolve_db_path
from ..agent import get_agent_capabilities
from ..agent.bootstrap import reload_agent_components
from ..agent.model_capabilities import apply_actual_protocol, build_model_list, infer_model_capabilities
from ..agent.settings import AgentSettingsConflict, get_agent_settings, get_model_connection, save_agent_settings
from ..model_connection import resolve_model_connection
from ..models.capability_probe import probe_capabilities
from ..models.auto_negotiating import get_negotiated_model_protocol
from ..secret_store import SecretStoreUnavailable
from ..agent.operations import get_agent_operations_snapshot
from ..config import get_settings
from ..db import connect
from ..observability.model_monitor import get_model_monitor_snapshot, record_model_service_event
from ..observability.model_context import model_call_scope
from ..models import ModelProviderError, OpenAICompatibleProvider, build_model_provider
from ..models.catalog_discovery import all_model_kinds, normalize_catalog, read_cached_catalog, store_discovery
from ..model_protocol import connection_protocol_label, normalize_model_protocol, protocol_requires_api_key
from .schemas import AgentSettingsIn, ModelCapabilitiesIn, ModelDiscoveryIn
from .model_contracts import CapabilityOverridesIn, ConnectionCreateIn, ConnectionUpdateIn, DefaultProfileIn, FallbackPolicyIn, ProfileCreateIn, ProfileUpdateIn, RoutingPolicyIn, ServiceModelIn, PurposeDefaultIn


router = APIRouter()


@router.get("/agent/model-routing")
def model_routing_get() -> dict[str, Any]:
    from ..agent.model_router import get_routing_policy

    return get_routing_policy()


@router.put("/agent/model-routing")
def model_routing_put(payload: RoutingPolicyIn) -> dict[str, Any]:
    from ..agent.model_router import save_routing_policy

    try:
        policy = save_routing_policy(payload.model_dump())
    except AgentSettingsConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    reload_agent_components()
    return policy


def _suggested_protocol(connection: dict[str, Any], error_code: str | None) -> str | None:
    """Machine-readable hint: an explicit Chat Completions connection was rejected."""
    if error_code == "protocol_unsupported" and normalize_model_protocol(connection.get("model_protocol")) == "openai":
        return "responses"
    return None


def _same_saved_connection(connection: dict[str, Any], saved: dict[str, Any]) -> bool:
    """A draft only reuses/records detection when it targets the saved wire identity."""
    return all(connection.get(key) == saved.get(key) for key in ("model_base_url", "model_protocol", "api_key"))


def _provider_for(connection: dict[str, Any], timeout_seconds: float, *, remember: bool = True):
    from ..agent.model_catalog import detected_protocol_recorder

    if connection.get("auth_kind") == subscription.AUTH_KIND:
        return subscription.build_subscription_provider(connection, timeout_seconds=timeout_seconds)
    if not remember:
        connection = {**connection, "detected_protocol": None, "connection_id": ""}
    return build_model_provider(
        api_key=connection["api_key"],
        model=connection["model_name"],
        base_url=connection["model_base_url"] or None,
        timeout_seconds=timeout_seconds,
        protocol=connection.get("model_protocol", "auto"),
        detected_protocol=connection.get("detected_protocol"),
        on_protocol_detected=detected_protocol_recorder(connection),
        price_per_million_input=connection.get("price_per_million_input"),
        price_per_million_output=connection.get("price_per_million_output"),
    )


def _diagnostic_timeout() -> float:
    # A total budget covers protocol negotiation and SDK retries as well.
    return min(get_settings().model_timeout_seconds, 25)


@router.get("/agent/capabilities")
def agent_capabilities() -> dict[str, Any]:
    try:
        return get_agent_capabilities()
    except SecretStoreUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/agent/settings")
def agent_settings_get() -> dict[str, Any]:
    return get_agent_settings()


@router.get("/agent/kernels")
def agent_kernels_get() -> dict[str, Any]:
    from ..agent.kernels.base import KERNEL_CHOICES, dsh_feature_enabled, has_deepseek_connection

    def describe(kernel: str) -> dict[str, Any]:
        if kernel == "tuantuan":
            return {"id": kernel, "name": "团团内核", "available": True, "reason": ""}
        if not dsh_feature_enabled():
            return {"id": kernel, "name": "DeepSeek Harness", "available": False, "reason": "DSH 内核未启用"}
        if not has_deepseek_connection():
            return {"id": kernel, "name": "DeepSeek Harness", "available": False, "reason": "需要先添加并启用 DeepSeek 模型档案"}
        return {"id": kernel, "name": "DeepSeek Harness", "available": True, "reason": ""}

    default_kernel = str(get_agent_settings().get("default_kernel") or "tuantuan")
    return {
        "choices": [describe(kernel) for kernel in KERNEL_CHOICES],
        "default_kernel": default_kernel,
    }


@router.put("/agent/settings")
def agent_settings_put(payload: AgentSettingsIn) -> dict[str, Any]:
    try:
        saved = save_agent_settings(payload.model_dump(exclude_unset=True))
    except SecretStoreUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except AgentSettingsConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    reload_agent_components()
    return saved


@router.get("/agent/settings/requests/{request_id}")
def agent_settings_request_get(request_id: str) -> dict[str, Any]:
    if not request_id or len(request_id) > 120:
        raise HTTPException(status_code=400, detail="保存请求 ID 格式不正确")
    with connect() as conn:
        row = conn.execute(
            "SELECT saved_revision FROM model_settings_requests WHERE request_id = ?", (request_id,),
        ).fetchone()
    # A missing receipt says only that no commit was visible at this instant.
    # The browser must not interpret it as cancellation or automatic rollback.
    return {
        "committed": row is not None,
        "saved_revision": int(row["saved_revision"]) if row else None,
        "settings": get_agent_settings(),
    }


def _catalog_mutation(operation, *args) -> dict[str, Any]:
    from ..agent.model_catalog import get_model_catalog

    try:
        operation(*args)
        reload_agent_components()
        return get_model_catalog()
    except AgentSettingsConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except SecretStoreUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


_SUBSCRIPTION_HEADERS = {"Cache-Control": "no-store"}


class ChatGPTStartIn(BaseModel):
    account_id: str | None = Field(default=None, max_length=36)
    reconsent: bool = False


class ChatGPTActiveIn(BaseModel):
    account_id: str = Field(min_length=1, max_length=36)


def _subscription_error(exc: Exception) -> HTTPException:
    if isinstance(exc, SubscriptionStoreError):
        return HTTPException(status_code=503, detail="本机安全凭证存储不可用，请检查或重试。", headers=_SUBSCRIPTION_HEADERS)
    if isinstance(exc, OSError):
        return HTTPException(status_code=503, detail="无法开启本机 ChatGPT 登录，请稍后重试。", headers=_SUBSCRIPTION_HEADERS)
    return HTTPException(status_code=400, detail=str(exc), headers=_SUBSCRIPTION_HEADERS)


@router.get("/agent/chatgpt-subscription")
def chatgpt_status(response: Response) -> dict[str, Any]:
    response.headers.update(_SUBSCRIPTION_HEADERS)
    return subscription.status(resolve_db_path())


@router.post("/agent/chatgpt-subscription/start")
async def chatgpt_start(payload: ChatGPTStartIn, response: Response) -> dict[str, Any]:
    response.headers.update(_SUBSCRIPTION_HEADERS)
    try:
        return await subscription.start(resolve_db_path(), account_id=payload.account_id, reconsent=payload.reconsent)
    except (subscription.SubscriptionError, SubscriptionStoreError, OSError) as exc:
        raise _subscription_error(exc) from None


@router.get("/agent/chatgpt-subscription/attempts/{attempt_id}")
async def chatgpt_attempt(attempt_id: str, response: Response) -> dict[str, Any]:
    response.headers.update(_SUBSCRIPTION_HEADERS)
    try:
        return subscription.attempt_status(resolve_db_path(), attempt_id)
    except subscription.SubscriptionError as exc:
        raise _subscription_error(exc) from None


@router.post("/agent/chatgpt-subscription/active")
async def chatgpt_activate(payload: ChatGPTActiveIn, response: Response) -> dict[str, Any]:
    response.headers.update(_SUBSCRIPTION_HEADERS)
    db_path = resolve_db_path()
    try:
        await subscription.activate(db_path, payload.account_id)
    except (subscription.SubscriptionError, SubscriptionStoreError) as exc:
        raise _subscription_error(exc) from None
    return await asyncio.to_thread(subscription.status, db_path)


@router.delete("/agent/chatgpt-subscription")
async def chatgpt_sign_out(response: Response) -> dict[str, Any]:
    response.headers.update(_SUBSCRIPTION_HEADERS)
    db_path = resolve_db_path()
    try:
        warning = await subscription.sign_out(db_path)
    except (subscription.SubscriptionError, SubscriptionStoreError) as exc:
        raise _subscription_error(exc) from None
    status = await asyncio.to_thread(subscription.status, db_path)
    return {**status, "message": warning} if warning else status


@router.get("/agent/model-connections")
def model_connections_get() -> dict[str, Any]:
    from ..agent.model_catalog import get_model_catalog

    return get_model_catalog()


@router.get("/agent/model-connections/{connection_id}/catalog")
def model_connection_catalog(connection_id: str, response: Response) -> dict[str, Any]:
    """Return persisted discovery for the current live version, without credentials."""
    headers = {"Cache-Control": "no-store"}
    response.headers.update(headers)
    try:
        with connect() as conn:
            return read_cached_catalog(conn, connection_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc), headers=headers) from exc
    except sqlite3.Error as exc:
        raise HTTPException(status_code=503, detail="模型目录缓存暂不可读取", headers=headers) from exc


@router.post("/agent/model-connections/{connection_id}/reveal-key")
def model_connection_reveal_key(connection_id: str, response: Response) -> dict[str, str]:
    from ..agent.model_catalog import get_service_connection

    response.headers["Cache-Control"] = "no-store"
    try:
        connection = get_service_connection(connection_id)
        if connection.get("auth_kind") == subscription.AUTH_KIND:
            raise ValueError("ChatGPT 订阅不提供 API Key")
        return {"api_key": connection["api_key"]}
    except SecretStoreUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc), headers={"Cache-Control": "no-store"}) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc), headers={"Cache-Control": "no-store"}) from exc


@router.post("/agent/model-connections")
def model_connections_create(payload: ConnectionCreateIn) -> dict[str, Any]:
    from ..agent.model_catalog import create_model_connection

    return _catalog_mutation(create_model_connection, payload.model_dump(exclude_unset=True))


@router.patch("/agent/model-connections/{connection_id}")
def model_connections_update(connection_id: str, payload: ConnectionUpdateIn) -> dict[str, Any]:
    from ..agent.model_catalog import update_model_connection

    return _catalog_mutation(update_model_connection, connection_id, payload.model_dump(exclude_unset=True))


@router.delete("/agent/model-connections/{connection_id}")
def model_connections_archive(connection_id: str, remove: bool = False, expected_revision: int | None = None) -> dict[str, Any]:
    from ..agent.model_catalog import archive_model_connection, remove_model_connection

    if remove:
        if expected_revision is None:
            raise HTTPException(status_code=400, detail="请重新读取服务配置后再删除")
        return _catalog_mutation(remove_model_connection, connection_id, {"expected_revision": expected_revision})
    return _catalog_mutation(archive_model_connection, connection_id, {"expected_revision": expected_revision})


@router.post("/agent/model-profiles")
def model_profiles_create(payload: ProfileCreateIn) -> dict[str, Any]:
    from ..agent.model_catalog import add_model_profile

    return _catalog_mutation(add_model_profile, payload.model_dump(exclude_unset=True))


@router.post("/agent/model-connections/{connection_id}/profiles/ensure")
def model_service_profile_ensure(connection_id: str, payload: ServiceModelIn) -> dict[str, Any]:
    from ..agent.model_catalog import ensure_service_model_profile

    return _catalog_mutation(ensure_service_model_profile, connection_id, payload.model_dump())


@router.patch("/agent/model-profiles/{profile_id}")
def model_profiles_update(profile_id: str, payload: ProfileUpdateIn) -> dict[str, Any]:
    from ..agent.model_catalog import update_model_profile

    return _catalog_mutation(update_model_profile, profile_id, payload.model_dump(exclude_unset=True))


@router.post("/agent/model-default")
def model_profiles_default(payload: DefaultProfileIn) -> dict[str, Any]:
    from ..agent.model_catalog import set_default_model_profile

    return _catalog_mutation(set_default_model_profile, payload.profile_id)


@router.post("/agent/model-defaults/{purpose}")
def model_purpose_default(purpose: str, payload: PurposeDefaultIn) -> dict[str, Any]:
    from ..agent.model_purposes import save_purpose_default

    return _catalog_mutation(save_purpose_default, purpose, payload.model_dump())


def _profile_for_connection(connection_id: str) -> dict[str, Any]:
    from ..agent.model_catalog import get_model_catalog, get_profile_connection, get_service_connection

    catalog = get_model_catalog()
    profiles = [profile for profile in catalog["profiles"] if profile["connection_id"] == connection_id and profile["enabled"]]
    if not profiles:
        try:
            return get_service_connection(connection_id)
        except SecretStoreUnavailable as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    profile = next((item for item in profiles if item["id"] == catalog["default_profile_id"]), profiles[0])
    try:
        return get_profile_connection(profile["id"])
    except SecretStoreUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/agent/model-connections/{connection_id}/discover")
async def model_connection_discover(connection_id: str) -> dict[str, Any]:
    connection = await asyncio.to_thread(_profile_for_connection, connection_id)
    return await _discover_connection(connection)


@router.post("/agent/model-connections/{connection_id}/check")
async def model_connection_check(connection_id: str) -> dict[str, Any]:
    connection = await asyncio.to_thread(_profile_for_connection, connection_id)
    if not connection["model_name"] or connection.get("auth_kind") == subscription.AUTH_KIND:
        result = await _discover_connection(connection)
        return {"available": True, "check_error_message": "", "check_scope": "catalog", "models": result["models"]}
    return await _check_connection(connection)


@router.post("/agent/models/discover")
async def discover_models(payload: ModelDiscoveryIn, draft_only: bool = False) -> dict[str, Any]:
    saved = {} if draft_only else get_model_connection()
    try:
        connection = resolve_model_connection(payload.model_dump(exclude_unset=True), saved=saved)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return await _discover_connection(connection, remember=not draft_only and _same_saved_connection(connection, saved))


async def _discover_connection(connection: dict[str, Any], *, remember: bool = True) -> dict[str, Any]:
    started_at = datetime.now(timezone.utc)
    api_key = connection["api_key"]
    base_url = connection["model_base_url"]
    model_name = connection["model_name"]
    model_protocol = connection["model_protocol"]
    resolved_protocol = connection["resolved_model_protocol"]
    is_subscription = connection.get("auth_kind") == subscription.AUTH_KIND
    if not is_subscription and protocol_requires_api_key(resolved_protocol) and not api_key:
        raise HTTPException(status_code=400, detail="请先填写或保存 API Key")

    provider = _provider_for(connection, min(get_settings().model_timeout_seconds, 20), remember=remember)
    try:
        with model_call_scope(connection, stage="discover"), all_model_kinds():
            async with asyncio.timeout(_diagnostic_timeout()):
                models = await provider.list_models()
    except TimeoutError as exc:
        raise HTTPException(status_code=504, detail="读取 ChatGPT 订阅模型目录超时，请重试" if is_subscription else "读取模型列表超时，请重试或手动填写模型名称") from exc
    except ModelProviderError as exc:
        suggested = _suggested_protocol(connection, exc.code)
        raise HTTPException(
            status_code=503 if exc.retryable else 400,
            detail={"message": str(exc), "code": exc.code, "suggested_protocol": suggested} if suggested else str(exc),
        ) from exc
    except Exception as exc:
        # 识别模型是配置类操作，未预期异常也要给出可读原因，不能冒泡成 500。
        raise HTTPException(
            status_code=502,
            detail=(
                "读取 ChatGPT 订阅模型目录失败，请确认登录后重试" if is_subscription else
                f"读取模型目录 {provider.models_url} 时发生未预期异常，请确认 Base URL 与 API Key 后重试"
            ),
        ) from exc
    if not models:
        raise HTTPException(
            status_code=404,
            detail=(
                "当前 ChatGPT 订阅未返回可用模型，请检查账号授权。" if is_subscription else
                f"服务已连接，但 {provider.models_url} 没有返回可用模型；请继续手动填写模型名称"
            ),
        )
    provider_name = provider.name
    normalized_base = base_url.rstrip("/")
    entries = getattr(models, "entries", None) or normalize_catalog(models, api_key=api_key)
    # A provider must not echo credentials into the persisted or returned catalog.
    # Treat truncated key prefixes as sensitive as well as a complete key.
    def contains_key(value: str) -> bool:
        return bool(api_key) and (api_key in value or any(value.endswith(api_key[:length]) for length in range(8, min(len(api_key), len(value)) + 1)))

    models = [name for name in models if isinstance(name, str) and name.strip() == name and 0 < len(name) <= 120 and not contains_key(name)]
    if not models:
        raise HTTPException(status_code=502, detail="模型服务未返回有效的模型名称，请检查服务配置。")
    allowed_models = set(models)
    entries = [dict(entry) for entry in entries if isinstance(entry, dict) and entry.get("id") in allowed_models]
    for entry in entries:
        for field in ("display_name", "owned_by"):
            value = entry.get(field)
            if isinstance(value, str) and contains_key(value):
                entry.pop(field, None)
    if remember and connection.get("connection_id") and connection.get("connection_revision"):
        with connect() as conn:
            if not store_discovery(conn, connection["connection_id"], connection["connection_revision"], entries, api_key=api_key, started_at=started_at):
                raise HTTPException(status_code=409, detail="连接已更新，请重新读取模型目录")
    return {
        "models": models,
        "entries": entries,
        "count": len(models),
        "base_url": normalized_base,
        "provider": provider_name,
        "protocol": provider_name,
        "items": build_model_list(
            connection["model_name"],
            models,
            provider=provider_name,
            base_url=normalized_base,
        ),
    }


@router.get("/agent/models/capabilities")
def model_capabilities_get(model_name: str = "") -> dict[str, Any]:
    connection = get_model_connection(resolve_credentials=False)
    report = infer_model_capabilities(
        model_name.strip() or connection["model_name"],
        provider=connection.get("resolved_model_protocol", "openai"),
        base_url=connection["model_base_url"],
        protocol=connection.get("model_protocol", "auto"),
        actual_protocol=get_negotiated_model_protocol(
            model_name.strip() or connection["model_name"],
            connection.get("model_protocol", "auto"),
            connection["model_base_url"], connection["api_key"],
        ) or (connection.get("detected_protocol") if not model_name.strip() or model_name.strip() == connection["model_name"] else None),
    )
    report["protocol_label"] = connection_protocol_label(
        connection.get("model_protocol", "auto"), report.get("actual_protocol"), report["model_name"], connection["model_base_url"],
    )
    extended = _profile_report_or_none(connection.get("profile_id")) if not model_name.strip() or model_name.strip() == connection["model_name"] else None
    return {**report, "connection_id": connection.get("connection_id", ""),
            "config_revision": connection.get("config_revision", 0),
            **({"merged": extended} if extended else {})}


def _profile_report_or_none(profile_id: Any) -> dict[str, Any] | None:
    if not profile_id:
        return None
    from ..agent.model_routing import profile_capability_report

    try:
        return profile_capability_report(str(profile_id))
    except Exception:
        return None


def _remember_probe(profile_id: str, vision: dict[str, Any]) -> None:
    from ..agent.model_routing import set_capability_record

    status = vision.get("status")
    if status in {"supported", "unsupported"}:
        try:
            set_capability_record(profile_id, "vision", status, source="probe", detail=str(vision.get("detail") or ""))
        except Exception:
            pass  # Remembering a probe is an optimization only.


@router.get("/agent/model-layer")
def model_layer_get() -> dict[str, Any]:
    """Which model backend is active and how LiteLLM is configured (no secrets)."""
    from ..models.factory import model_backend
    from ..models.litellm_core import OFFLINE_ENVIRONMENT, litellm_import_seconds, litellm_loaded, litellm_version

    return {
        "backend": model_backend(),
        "litellm_version": litellm_version(),
        "litellm_loaded": litellm_loaded(),
        "litellm_import_seconds": litellm_import_seconds(),
        "offline_cost_map": OFFLINE_ENVIRONMENT["LITELLM_LOCAL_MODEL_COST_MAP"] == "True",
    }


@router.get("/agent/model-fallbacks")
def model_fallbacks_get() -> dict[str, Any]:
    from ..agent.model_routing import get_fallback_policy
    from ..models.factory import model_backend

    return {**get_fallback_policy(), "backend": model_backend()}


@router.put("/agent/model-fallbacks")
def model_fallbacks_put(payload: FallbackPolicyIn) -> dict[str, Any]:
    from ..agent.model_routing import save_fallback_policy
    from ..models.factory import model_backend

    try:
        policy = save_fallback_policy(payload.model_dump(exclude_unset=True))
    except AgentSettingsConflict as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    reload_agent_components()
    return {**policy, "backend": model_backend()}


def _profile_report(profile_id: str) -> dict[str, Any]:
    from ..agent.model_routing import profile_capability_report

    try:
        return profile_capability_report(profile_id)
    except SecretStoreUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.get("/agent/model-profiles/{profile_id}/capabilities")
def model_profile_capabilities_get(profile_id: str) -> dict[str, Any]:
    return _profile_report(profile_id)


@router.put("/agent/model-profiles/{profile_id}/capabilities")
def model_profile_capabilities_put(profile_id: str, payload: CapabilityOverridesIn) -> dict[str, Any]:
    from ..agent.model_routing import set_capability_record

    try:
        for capability, value in payload.overrides.items():
            set_capability_record(profile_id, capability, value, source="user")
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _profile_report(profile_id)


@router.post("/agent/model-profiles/{profile_id}/capabilities/probe")
async def model_profile_capabilities_probe(profile_id: str) -> dict[str, Any]:
    from ..agent.model_catalog import get_profile_connection

    try:
        connection = get_profile_connection(profile_id)
    except SecretStoreUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if connection.get("auth_kind") == subscription.AUTH_KIND:
        raise HTTPException(status_code=400, detail="ChatGPT 订阅当前仅支持文字聊天，不能探测图片输入。")
    if protocol_requires_api_key(connection["resolved_model_protocol"]) and not connection["api_key"]:
        raise HTTPException(status_code=400, detail="请先为该连接保存 API Key")
    provider = _provider_for(connection, min(get_settings().model_timeout_seconds, 20))
    probe_error = None
    try:
        with model_call_scope(connection, stage="vision_probe"):
            async with asyncio.timeout(_diagnostic_timeout()):
                vision = await provider.probe_vision()
        _remember_probe(profile_id, vision)
    except TimeoutError:
        probe_error = "图片输入检测超时，请重试"
    except ModelProviderError as exc:
        probe_error = str(exc)
    except Exception:
        probe_error = "图片输入检测失败，请确认服务配置后重试"
    return {**_profile_report(profile_id), "probe_error": probe_error}


@router.post("/agent/models/capabilities")
async def model_capabilities_probe(payload: ModelCapabilitiesIn) -> dict[str, Any]:
    saved = get_model_connection()
    try:
        connection = resolve_model_connection(payload.model_dump(exclude_unset=True), saved=saved)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    remember = _same_saved_connection(connection, saved)
    settings = get_settings()
    model_name = connection["model_name"]
    base_url = connection["model_base_url"]
    model_protocol = connection["model_protocol"]
    resolved_protocol = connection["resolved_model_protocol"]
    report = infer_model_capabilities(
        model_name,
        provider=resolved_protocol,
        base_url=base_url,
        protocol=model_protocol,
    )
    report.update(connection_id=connection.get("connection_id", ""),
                  config_revision=connection.get("config_revision", 0))
    if not payload.probe:
        return report

    api_key = connection["api_key"]
    if protocol_requires_api_key(resolved_protocol) and not api_key:
        report["probe_error"] = "请先填写或保存 API Key"
        return report

    provider = _provider_for(connection, min(settings.model_timeout_seconds, 20), remember=remember)
    with model_call_scope(connection, stage="capability_probe"):
        results, errors = await probe_capabilities(provider, _diagnostic_timeout())
    confirmed = any(result["status"] in {"supported", "unsupported"} for result in results.values())
    if confirmed:
        apply_actual_protocol(report, provider.name, base_url)
        report["protocol_label"] = connection_protocol_label(model_protocol, provider.name, model_name, base_url)
    report.update(results)
    report["probed"] = confirmed
    report["probe_error"] = "；".join(errors) or None
    if remember and connection.get("profile_id"):
        _remember_probe(str(connection["profile_id"]), results["vision"])
    return report


@router.get("/agent/model-monitor")
def model_monitor_get(hours: int = 24) -> dict[str, Any]:
    return get_model_monitor_snapshot(hours)


@router.get("/agent/operations")
def agent_operations_get(days: int = 7, limit: int = 20) -> dict[str, Any]:
    try:
        return get_agent_operations_snapshot(days=days, limit=limit)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.post("/agent/model-monitor/check")
async def model_monitor_check() -> dict[str, Any]:
    connection = get_model_connection()
    return await _check_connection(connection)


async def _check_connection(connection: dict[str, Any]) -> dict[str, Any]:
    with model_call_scope(connection, stage="health_check"):
        return await _check_scoped_connection(connection)


def _monitor_for_connection(connection: dict[str, Any]) -> dict[str, Any]:
    if connection.get("profile_id"):
        return get_model_monitor_snapshot(connection=connection)
    return get_model_monitor_snapshot()


async def _check_scoped_connection(connection: dict[str, Any]) -> dict[str, Any]:
    if (
        protocol_requires_api_key(connection.get("resolved_model_protocol", "openai"))
        and not connection["api_key"]
    ):
        error_message = "尚未配置模型服务 API Key"
        record_model_service_event(
            request_kind="health_check",
            status="error",
            error_code="not_configured",
            error_message=error_message,
            latency_ms=0,
            model_name=connection["model_name"],
            base_url=connection["model_base_url"],
            protocol=connection.get("resolved_model_protocol", "openai"),
        )
        return {
            **_monitor_for_connection(connection),
            "available": False,
            "connection_id": connection.get("connection_id", ""),
            "config_revision": connection.get("config_revision", 0),
            "check_error_code": "not_configured",
            "check_error_message": error_message,
        }

    provider = _provider_for(connection, get_settings().model_timeout_seconds)
    available = False
    check_error_code: str | None = None
    check_error_message: str | None = None
    try:
        async with asyncio.timeout(_diagnostic_timeout()):
            await provider.check_connection()
        available = True
    except TimeoutError:
        check_error_code = "request_timeout"
        check_error_message = "连接检测超时，请稍后重试"
        record_model_service_event(
            request_kind="health_check", status="error", error_code=check_error_code,
            error_message=check_error_message, latency_ms=round(_diagnostic_timeout() * 1000),
            model_name=connection["model_name"], base_url=connection["model_base_url"],
            protocol=provider.name,
        )
    except ModelProviderError as exc:
        # The provider already stored a classified failure without prompt content.
        check_error_code = exc.code
        check_error_message = str(exc)
    except Exception:
        check_error_code = "provider_error"
        check_error_message = "主动检测发生未知异常"
        record_model_service_event(
            request_kind="health_check",
            status="error",
            error_code="provider_error",
            error_message=check_error_message,
            latency_ms=0,
            model_name=connection["model_name"],
            base_url=connection["model_base_url"],
            protocol=connection.get("resolved_model_protocol", "openai"),
        )
    return {
        **_monitor_for_connection(connection),
        "available": available,
        "connection_id": connection.get("connection_id", ""),
        "config_revision": connection.get("config_revision", 0),
        "check_error_code": check_error_code,
        "check_error_message": check_error_message,
        "suggested_protocol": _suggested_protocol(connection, check_error_code),
    }
