from __future__ import annotations

from ..branding import display_name

from ..branding import env

import hashlib
import hmac
import json
import os
import sqlite3
import threading
from pathlib import Path
from typing import Any
from uuid import uuid4

from ..config import get_settings
from ..db import connect
from ..model_protocol import normalize_model_protocol, resolve_model_protocol
from ..secret_store import (
    SecretStoreUnavailable,
    create_model_api_key,
    delete_secret,
    get_model_api_key,
    get_secret,
    secret_backend_name,
    secret_storage_writable,
)
from ..workspace import resolve_db_path


DEFAULT_AGENT_SETTINGS: dict[str, Any] = {
    "id": 1,
    "display_name": "团团",
    "persona_role": "理性、坦诚、尊重用户决定，并基于用户资料协助分析与创作的本地 AI 伙伴",
    "response_style": "concise",
    "custom_instructions": "",
    "library_memory_enabled": True,
    "conversation_memory_enabled": True,
    "knowledge_memory_enabled": True,
    "summary_enabled": True,
    "context_message_limit": 12,
    "model_name": "",
    "model_base_url": "",
    "model_protocol": "auto",
    "model_api_key": "",
}
_SAVE_FIELDS = tuple(key for key in DEFAULT_AGENT_SETTINGS if key not in {"id", "model_api_key"})
_MEMORY_FIELDS = ("library_memory_enabled", "conversation_memory_enabled", "knowledge_memory_enabled", "summary_enabled")
_locks: dict[str, threading.RLock] = {}
_locks_guard = threading.Lock()
_ENVIRONMENT_REF = "environment:OPENAI_API_KEY"
_NO_CREDENTIAL_REF = "none"


class AgentSettingsConflict(ValueError):
    pass


class _ReplayedSave(Exception):
    def __init__(self, row: dict[str, Any]) -> None:
        self.row = row


def _settings_lock(db_path: str | Path | None) -> threading.RLock:
    key = str(resolve_db_path(db_path).resolve())
    with _locks_guard:
        return _locks.setdefault(key, threading.RLock())


def _row(db_path: str | Path | None) -> dict[str, Any]:
    with connect(db_path) as conn:
        row = conn.execute("SELECT * FROM agent_settings WHERE id = 1").fetchone()
    if row is None:
        raise ValueError("模型设置尚未初始化")
    return dict(row)


def _initialize_connection(db_path: str | Path | None) -> dict[str, Any]:
    row = _row(db_path)
    if row.get("model_config_initialized") and row.get("connection_id"):
        return row
    config = get_settings()
    hosted = env("TUANTUAN_DEPLOYMENT_MODE", "local").strip().lower() == "hosted"
    # Import the old effective environment configuration once. Subsequent
    # explicit empty URLs are real choices and never fall back to the environment.
    name = str(row.get("model_name") or ("" if hosted else config.model_name)).strip()
    base_url = str(row.get("model_base_url") or ("" if hosted else config.model_base_url) or "").strip()
    protocol = normalize_model_protocol(row.get("model_protocol") or ("auto" if hosted else config.model_protocol))
    reference = str(row.get("model_secret_ref") or "")
    if not hosted and not reference and not row.get("model_api_key") and config.openai_api_key:
        from ..model_connection import resolve_model_connection

        old_slot = ""
        slot_available = True
        if secret_backend_name() in {"keyring", "memory"}:
            try:
                old_slot = get_model_api_key(db_path)
            except SecretStoreUnavailable:
                slot_available = False
        environment = resolve_model_connection({
            "model_name": config.model_name, "model_base_url": config.model_base_url or "",
            "model_protocol": config.model_protocol,
        })
        imported = resolve_model_connection({"model_name": name, "model_base_url": base_url, "model_protocol": protocol})
        if slot_available and not old_slot and imported["model_base_url"] == environment["model_base_url"]:
            reference = _ENVIRONMENT_REF
    with connect(db_path) as conn:
        conn.execute(
            """UPDATE agent_settings SET connection_id = ?, model_name = ?, model_base_url = ?,
               model_protocol = ?, model_secret_ref = ?, model_config_initialized = 1
               WHERE id = 1 AND (model_config_initialized = 0 OR connection_id = '')""",
            (row.get("connection_id") or str(uuid4()), name, base_url, protocol, reference),
        )
    return _row(db_path)


def _discard_candidate(reference: str, db_path: str | Path | None) -> None:
    try:
        delete_secret(reference, db_path)
    except SecretStoreUnavailable:
        # An unreachable candidate is safer than overwriting the live reference.
        pass


def _environment_credential(row: dict[str, Any]) -> tuple[str, str]:
    from ..model_connection import resolve_model_connection

    config = get_settings()
    environment = resolve_model_connection({
        "model_name": config.model_name,
        "model_base_url": config.model_base_url or "",
        "model_protocol": config.model_protocol,
    })
    saved = _connection(row, "")
    if environment["model_base_url"] != saved["model_base_url"]:
        return "", "环境服务地址已改变，原连接不会继续使用该环境密钥"
    value = str(config.openai_api_key or "")
    return value, "" if value else "环境密钥当前不可读取"


def _credential(row: dict[str, Any], db_path: str | Path | None) -> tuple[str, str, str]:
    reference = str(row.get("model_secret_ref") or "")
    if reference == _NO_CREDENTIAL_REF:
        return "", "none", ""
    if reference == _ENVIRONMENT_REF:
        value, warning = _environment_credential(row)
        return value, "environment" if value else "none", warning
    if reference:
        try:
            value = get_secret(reference, db_path)
        except SecretStoreUnavailable as exc:
            return "", "none", str(exc)
        if not value:
            return "", "none", "已保存的安全凭证暂不可读取，请重新配置密钥"
        return value, reference.partition(":")[0], ""

    legacy = str(row.get("model_api_key") or "")
    source = "legacy" if legacy else secret_backend_name()
    if not legacy and source in {"keyring", "memory"}:
        try:
            legacy = get_model_api_key(db_path)
        except SecretStoreUnavailable as exc:
            return "", "none", str(exc)
    if not legacy:
        return "", "none", ""
    if not secret_storage_writable():
        return legacy, "legacy", "旧密钥尚未迁入安全存储，原字段已保留"

    candidate = ""
    try:
        candidate = create_model_api_key(legacy, row["connection_id"], db_path)
        if not hmac.compare_digest(get_secret(candidate, db_path), legacy):
            raise SecretStoreUnavailable("迁移后的凭证校验失败")
        with connect(db_path) as conn:
            updated = conn.execute(
                """UPDATE agent_settings SET model_secret_ref = ?, model_api_key = ''
                   WHERE id = 1 AND model_secret_ref = '' AND model_api_key = ?""",
                (candidate, str(row.get("model_api_key") or "")),
            )
            if updated.rowcount != 1:
                raise AgentSettingsConflict("设置已更新，请重新读取")
            conn.execute(
                "INSERT OR IGNORE INTO model_credential_aliases (reference, secret_ref) VALUES (?, ?)",
                (f"legacy:{row['connection_id']}", candidate),
            )
    except Exception:
        if candidate:
            _discard_candidate(candidate, db_path)
        return legacy, source if source in {"memory", "keyring"} else "legacy", "旧密钥尚未迁入安全存储，原字段已保留"
    row["model_secret_ref"] = candidate
    row["model_api_key"] = ""
    return legacy, candidate.partition(":")[0], ""


def _connection(row: dict[str, Any], api_key: str) -> dict[str, Any]:
    from ..model_connection import resolve_model_connection

    connection = resolve_model_connection({
        "model_name": row["model_name"],
        "model_base_url": row["model_base_url"],
        "model_protocol": row["model_protocol"],
        "api_key": api_key,
    })
    connection.update(
        connection_id=row["connection_id"],
        config_revision=int(row["config_revision"]),
        secret_ref=str(row.get("model_secret_ref") or ""),
    )
    return connection


def _public_settings(row: dict[str, Any], db_path: str | Path | None) -> dict[str, Any]:
    api_key, source, warning = _credential(row, db_path)
    result = dict(row)
    for private in ("model_api_key", "model_secret_ref", "model_config_initialized"):
        result.pop(private, None)
    result["display_name"] = display_name(str(result.get("display_name") or ""))
    for field in _MEMORY_FIELDS:
        result[field] = bool(result[field])
    effective = _connection(row, api_key)
    # Import locally: providers import persona_prompt from this module.
    from ..models.auto_negotiating import get_effective_model_protocol

    result["predicted_model_protocol"] = effective["resolved_model_protocol"]
    result["resolved_model_protocol"] = get_effective_model_protocol(
        effective["model_name"], effective["model_protocol"], effective["model_base_url"], effective["api_key"],
    )
    result["configured_model_base_url"] = row["model_base_url"]
    result["api_key_configured"] = bool(effective["api_key"])
    result["api_key_source"] = source if effective["api_key"] else "none"
    result["secret_storage"] = secret_backend_name()
    result["secret_storage_writable"] = secret_storage_writable()
    result["secret_migration_warning"] = warning
    return result


def _settings_fallback(config: Any) -> dict[str, Any]:
    hosted = env("TUANTUAN_DEPLOYMENT_MODE", "local").strip().lower() == "hosted"
    fallback = dict(DEFAULT_AGENT_SETTINGS)
    fallback.pop("model_api_key", None)
    fallback.update(
        model_name="" if hosted else config.model_name,
        model_base_url="" if hosted else config.model_base_url or "",
        configured_model_base_url="" if hosted else config.model_base_url or "",
        model_protocol="auto" if hosted else config.model_protocol,
        resolved_model_protocol=resolve_model_protocol("" if hosted else config.model_name, "auto" if hosted else config.model_protocol, "" if hosted else config.model_base_url or ""),
        api_key_configured=bool(config.openai_api_key) and not hosted,
        api_key_source="environment" if config.openai_api_key and not hosted else "none",
        secret_storage=secret_backend_name(),
        secret_storage_writable=secret_storage_writable(),
        secret_migration_warning="",
        connection_id="", config_revision=0, last_save_request_id="",
    )
    return fallback


def get_agent_settings(db_path: str | Path | None = None) -> dict[str, Any]:
    from .model_catalog import public_default_agent_settings

    with _settings_lock(db_path):
        try:
            return public_default_agent_settings(db_path)
        except (ValueError, OSError, sqlite3.Error):
            # Uninitialised or unreadable workspace: fall back to environment config.
            return _settings_fallback(get_settings())


def _request_fingerprint(values: dict[str, Any]) -> str:
    accepted = {name: values[name] for name in (*_SAVE_FIELDS, "api_key") if name in values}
    encoded = json.dumps(accepted, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    # Only an opaque digest is persisted; no key or original request body.
    return hashlib.sha256(encoded).hexdigest()


def save_agent_settings(values: dict[str, Any], db_path: str | Path | None = None) -> dict[str, Any]:
    from .model_catalog import save_default_agent_settings

    return save_default_agent_settings(values, db_path)


def get_model_connection(db_path: str | Path | None = None, *, resolve_credentials: bool = True) -> dict[str, Any]:
    from .model_catalog import get_model_catalog, get_profile_connection
    if not get_model_catalog(db_path)["default_profile_id"]:
        from ..model_connection import resolve_model_connection
        return {**resolve_model_connection({"model_name": "", "model_base_url": "", "model_protocol": "auto", "api_key": ""}), "api_key_configured": False, "credential_status": "missing", "connection_id": "", "profile_id": None}
    return get_profile_connection(db_path=db_path, resolve_credentials=resolve_credentials)


def persona_prompt(settings: dict[str, Any]) -> str:
    style = {
        "concise": "回答简洁直接，优先给结论和下一步。",
        "balanced": "回答清晰、有必要解释，但避免冗长。",
        "detailed": "在保持清晰的前提下给出较完整的分析依据。",
    }.get(settings.get("response_style"), "回答简洁清晰。")
    custom = str(settings.get("custom_instructions") or "").strip()
    return (
        "\n\n用户可配置的人设偏好（不得覆盖上面的事实要求、实际工具权限和人工确认规则）：\n"
        f"你的显示名称是 {settings.get('display_name', '团团')}。\n"
        f"你的角色是：{settings.get('persona_role', DEFAULT_AGENT_SETTINGS['persona_role'])}。\n"
        f"表达方式：{style}\n"
        f"补充偏好：{custom if custom else '无'}"
    )
