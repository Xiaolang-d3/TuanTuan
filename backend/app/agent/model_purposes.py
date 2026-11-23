"""Workspace purpose policy and versioned binding; pure choices live in models."""
from __future__ import annotations

import json
from functools import lru_cache

from ..model_protocol import model_protocol_for_profile, resolve_model_protocol
from ..models.selection import model_output_types, supported_purposes, purpose_exclusion, select_model_for_purpose
from . import settings
from .model_capabilities import infer_vision


PURPOSE_LABELS = {"chat": "聊天", "image": "图片生成", "vision": "图像理解"}


def catalog_vision_statuses(conn, profile_id=None):
    query = "SELECT profile_id, source, status FROM model_capability_records WHERE capability='vision'"
    rows = conn.execute(query) if profile_id is None else conn.execute(f"{query} AND profile_id=?", (profile_id,))
    records = {}
    for row in rows:
        records.setdefault(row["profile_id"], {})[row["source"]] = row["status"]
    return records


@lru_cache(maxsize=1024)
def _litellm_vision_status(protocol, model_name):
    from ..models.litellm_core import capability_defaults

    try:
        supported = capability_defaults(protocol, model_name)["capabilities"].get("vision")
    except Exception:
        return None
    return None if supported is None else "supported" if supported else "unsupported"


def profile_with_vision_status(profile, source, records, *, load_model_metadata=False):
    from ..models.factory import model_backend
    from ..models.litellm_core import litellm_loaded

    configured = (profile.get("capabilities") or {}).get("vision")
    if configured == "unknown":
        configured = None
    status = records.get("user") or configured or records.get("probe")
    name = profile["model_name"]
    # Reading the settings catalog must not trigger LiteLLM's cold import.
    if not status and (load_model_metadata or litellm_loaded()) and model_backend() == "litellm" and "chat" in supported_purposes(profile, source):
        base_url = source.get("effective_base_url", "")
        protocol = model_protocol_for_profile(name, source.get("protocol", "auto"), profile.get("capabilities"), base_url)
        protocol = source.get("detected_protocol") or resolve_model_protocol(name, protocol, base_url)
        status = _litellm_vision_status(protocol, name)
    return {**profile, "vision_status": status or infer_vision(name)["status"]}


def selection_catalog(db_path=None, *, include_vision=False):
    """Read saved identities and credential references, never plaintext secrets.

    Avoid catalog initialization: migrating an old credential or authenticating
    to a keychain requires an actual settings/runtime action.
    """
    from .model_catalog import _decode_connection, _decode_profile
    from ..secret_store import SecretStoreUnavailable, secret_reference_backend

    with settings.connect(db_path) as conn:
        sources = [_decode_connection(row) for row in conn.execute("SELECT * FROM model_connections WHERE deleted_at IS NULL ORDER BY created_at, id")]
        profiles = [_decode_profile(row) for row in conn.execute("SELECT p.* FROM model_profiles p JOIN model_connections c ON c.id=p.connection_id WHERE c.deleted_at IS NULL ORDER BY p.created_at, p.id")]
        if include_vision:
            vision_records = catalog_vision_statuses(conn)
            source_map = {source["id"]: source for source in sources}
            profiles = [profile_with_vision_status(profile, source_map[profile["connection_id"]], vision_records.get(profile["id"], {}), load_model_metadata=True) for profile in profiles]
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
            if purpose != "vision":
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
            if kind != "vision":
                defaults.setdefault(kind, legacy)
    return {kind: defaults.get(kind) for kind in PURPOSE_LABELS}, row["version"]


def save_purpose_default(kind, values, db_path=None):
    from .model_catalog import _mutate, _profile, _connection

    if kind not in PURPOSE_LABELS:
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
            if kind == "vision":
                profile = profile_with_vision_status(profile, source, catalog_vision_statuses(conn, profile_id).get(profile_id, {}), load_model_metadata=True)
            rejection = purpose_exclusion(profile, {**source, "api_key_configured": bool(source["secret_ref"] and source["secret_ref"] != "none")}, kind)
            if rejection:
                raise ValueError(rejection)
            if kind == "chat" or (kind == "image" and not conn.execute("SELECT default_model_profile_id FROM agent_settings WHERE id=1").fetchone()[0]):
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
            raise ValueError(f"请先更换或清除{PURPOSE_LABELS[kind]}默认模型，再停用此模型或连接")
