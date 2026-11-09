"""Workspace purpose policy and versioned binding; pure choices live in models."""
from __future__ import annotations

import json

from ..models.selection import model_output_types, supported_purposes, purpose_exclusion, select_model_for_purpose
from . import settings


def selection_catalog(db_path=None):
    """Read saved identities and credential references, never plaintext secrets.

    Avoid catalog initialization: migrating an old credential or authenticating
    to a keychain requires an actual settings/runtime action.
    """
    from .model_catalog import _decode_connection, _decode_profile
    from ..secret_store import SecretStoreUnavailable, secret_reference_backend

    with settings.connect(db_path) as conn:
        sources = [_decode_connection(row) for row in conn.execute("SELECT * FROM model_connections WHERE deleted_at IS NULL ORDER BY created_at, id")]
        profiles = [_decode_profile(row) for row in conn.execute("SELECT p.* FROM model_profiles p JOIN model_connections c ON c.id=p.connection_id WHERE c.deleted_at IS NULL ORDER BY p.created_at, p.id")]
        row = conn.execute("SELECT default_model_profile_id FROM agent_settings WHERE id=1").fetchone()
        policy = conn.execute("SELECT payload_json FROM model_routing_policy WHERE id=1").fetchone()
        payload = json.loads(policy[0]) if policy else {}
        for source in sources:
            reference = source.pop("secret_ref", "none")
            alias = conn.execute("SELECT secret_ref FROM model_credential_aliases WHERE reference=?", (reference,)).fetchone()
            reference = alias[0] if alias else reference
            configured = bool(reference and reference != "none")
            status = "saved_unverified" if configured else "missing"
            if configured and not reference.startswith(("environment:", "legacy:")):
                try:
                    secret_reference_backend(reference, db_path)
                except SecretStoreUnavailable:
                    configured, status = False, "unavailable"
            source.update(api_key_configured=configured, credential_status=status)
    default = row[0] if row else None
    defaults = dict(payload.get("purpose_defaults", {}))
    legacy = next((item for item in profiles if item["id"] == default), None)
    if legacy:
        source = next((item for item in sources if item["id"] == legacy["connection_id"]), {})
        for purpose in supported_purposes(legacy, source):
            defaults.setdefault(purpose, default)
    return {"connections": sources, "profiles": profiles, "purpose_defaults": defaults, "default_profile_id": default,
            "effective_execution_profile_id": payload.get("roles", {}).get("execute") or default,
            "strict_capabilities": bool(payload.get("strict_capabilities", False))}


def preview_model_selection(purpose, profile_id=None, db_path=None):
    with settings._settings_lock(db_path):
        catalog = selection_catalog(db_path)
        return select_model_for_purpose(catalog, purpose, profile_id, strict_capabilities=catalog["strict_capabilities"])


def resolve_purpose_connection(purpose, profile_id=None, *, action=None, preferred_profile_id=None):
    """Bind a new purpose choice and then validate its live credentials."""
    from .model_catalog import get_profile_connection
    with settings._settings_lock(None):
        catalog = selection_catalog()
        result = select_model_for_purpose(catalog, purpose, profile_id, action=action, strict_capabilities=catalog["strict_capabilities"], preferred_profile_id=preferred_profile_id)
        if not result["eligible"]:
            raise ValueError(result["error"])
        connection = get_profile_connection(result["profile_id"])
        source = {"protocol": connection["model_protocol"], "model_base_url": connection["model_base_url"], "api_key_configured": connection.get("api_key_configured", bool(connection.get("api_key")))}
        rejection = purpose_exclusion(connection, source, purpose, action=action, strict_capabilities=catalog["strict_capabilities"])
        if rejection:
            raise ValueError(rejection)
        return {**connection, "selection_reason": result["reason"]}


def purpose_defaults(conn):
    row = conn.execute("SELECT version, payload_json FROM model_routing_policy WHERE id=1").fetchone()
    payload = json.loads(row["payload_json"])
    defaults = dict(payload.get("purpose_defaults", {}))
    # Only inherit the old explicit default; never guess another enabled model.
    legacy = conn.execute("SELECT default_model_profile_id FROM agent_settings WHERE id=1").fetchone()[0]
    if legacy:
        from .model_catalog import _profile, _connection
        profile = _profile(conn, legacy)
        for kind in supported_purposes(profile, _connection(conn, profile["connection_id"])):
            defaults.setdefault(kind, legacy)
    return {"chat": defaults.get("chat"), "image": defaults.get("image")}, row["version"]


def save_purpose_default(kind, values, db_path=None):
    from .model_catalog import _mutate, _profile, _connection

    if kind not in {"chat", "image"}:
        raise ValueError("暂不支持此模型用途")

    def operation(conn, _candidates):
        defaults, version = purpose_defaults(conn)
        if values.get("expected_version") != version:
            raise settings.AgentSettingsConflict("使用规则已更新，请重新读取后保存")
        profile_id = values.get("profile_id")
        if profile_id:
            profile = _profile(conn, profile_id)
            source = _connection(conn, profile["connection_id"])
            if not profile["enabled"] or not source["enabled"]:
                raise ValueError("模型或连接已停用")
            if kind not in supported_purposes(profile, source):
                raise ValueError("模型能力或已接入的接口不支持此用途，请先确认模型能力")
            if not source["secret_ref"] or source["secret_ref"] == "none":
                if source["protocol"] != "ollama":
                    raise ValueError("请先配置此连接的密钥")
            if kind == "chat" or not conn.execute("SELECT default_model_profile_id FROM agent_settings WHERE id=1").fetchone()[0]:
                conn.execute("UPDATE agent_settings SET default_model_profile_id=? WHERE id=1", (profile_id,))
        defaults[kind] = profile_id
        row = conn.execute("SELECT payload_json FROM model_routing_policy WHERE id=1").fetchone()
        payload = json.loads(row[0])
        payload["purpose_defaults"] = defaults
        conn.execute("UPDATE model_routing_policy SET version=version+1, payload_json=? WHERE id=1", (json.dumps(payload),))

    _mutate(f"purpose_default:{kind}", values, db_path, operation)


def protect_purpose_defaults(conn, *, profile_id=None, connection_id=None):
    from .model_catalog import _profile

    defaults, _ = purpose_defaults(conn)
    for kind, selected in defaults.items():
        if selected and (selected == profile_id or (connection_id and _profile(conn, selected)["connection_id"] == connection_id)):
            label = "聊天" if kind == "chat" else "图片"
            raise ValueError(f"请先更换或清除{label}默认模型，再停用此模型或连接")
