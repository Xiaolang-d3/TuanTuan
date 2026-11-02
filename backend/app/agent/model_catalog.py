"""Workspace model connections, profiles and immutable configuration versions."""
from __future__ import annotations

from ..branding import display_name

import hashlib
import hmac
import json
import math
from pathlib import Path
from typing import Any, Callable
from uuid import uuid4

from ..model_connection import normalize_api_root, resolve_model_connection
from ..model_protocol import model_protocol_for_profile, PROTOCOL_LABELS, connection_protocol_label, normalize_detected_protocol, normalize_model_protocol, resolve_model_protocol
from ..secret_store import secret_backend_name, secret_storage_writable, secret_reference_backend, SecretStoreUnavailable
from . import settings


_CAPABILITY_NAMES = ("vision", "tools", "streaming", "image_generation")
REASONING_EFFORTS = ("low", "medium", "high")


def connect(db_path):
    # Reuse the settings adapter so legacy save failure/migration guarantees
    # remain covered by the same deterministic storage tests.
    return settings.connect(db_path)


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _decode_profile(row: Any) -> dict[str, Any]:
    result = dict(row)
    result["enabled"] = bool(result["enabled"])
    result["parameters"] = json.loads(result.pop("parameters_json", "{}"))
    result["capabilities"] = {name: "unknown" for name in _CAPABILITY_NAMES} | json.loads(result.pop("capabilities_json", "{}"))
    result["reasoning_effort"] = normalize_reasoning_effort(result.get("reasoning_effort"))
    return result


def normalize_reasoning_effort(value: Any) -> str | None:
    normalized = str(value or "").strip().lower()
    return normalized if normalized in REASONING_EFFORTS else None


def _decode_connection(row: Any) -> dict[str, Any]:
    result = dict(row)
    result["enabled"] = bool(result["enabled"])
    result["detected_protocol"] = normalize_detected_protocol(result.get("detected_protocol"))
    return result


def _connection(conn, connection_id: str) -> dict[str, Any]:
    row = conn.execute("SELECT * FROM model_connections WHERE id = ?", (connection_id,)).fetchone()
    if row is None:
        raise ValueError("模型连接不存在")
    return _decode_connection(row)


def _profile(conn, profile_id: str) -> dict[str, Any]:
    row = conn.execute("SELECT * FROM model_profiles WHERE id = ?", (profile_id,)).fetchone()
    if row is None:
        raise ValueError("模型档案不存在")
    return _decode_profile(row)


def _version(conn, kind: str, record: dict[str, Any]) -> None:
    id_column = "connection_id" if kind == "connection" else "profile_id"
    conn.execute(
        f"INSERT INTO model_{kind}_versions ({id_column}, revision, payload_json) VALUES (?, ?, ?)",
        (record["id"], record["revision"], _json(record)),
    )


def _secret(connection: dict[str, Any], model_name: str, db_path) -> tuple[str, str, str]:
    reference = str(connection.get("secret_ref") or "none")
    if reference == "none":
        return "", "none", ""
    if reference == settings._ENVIRONMENT_REF:
        row = {
            "model_name": model_name, "model_base_url": connection["effective_base_url"],
            "model_protocol": connection["protocol"], "connection_id": connection["id"], "config_revision": 0,
        }
        value, warning = settings._environment_credential(row)
        return value, "environment" if value else "none", warning
    if reference.startswith("legacy:"):
        # Only the existing v26 field may contain a pending old plaintext key;
        # no new connection/profile/version table copies that credential.
        with connect(db_path) as conn:
            alias = conn.execute("SELECT secret_ref FROM model_credential_aliases WHERE reference = ?", (reference,)).fetchone()
        if alias:
            value = settings.get_secret(alias[0], db_path)
            if not value:
                raise SecretStoreUnavailable("历史模型凭证暂不可读取，无法恢复原配置")
            return value, alias[0].partition(":")[0], ""
        row = settings._row(db_path)
        if row["connection_id"] != connection["id"] or row.get("model_secret_ref"):
            raise SecretStoreUnavailable("历史模型凭证尚未迁移，无法恢复原配置")
        value = str(row.get("model_api_key") or "")
        return value, "legacy" if value else "none", "旧密钥尚未迁入安全存储，原字段已保留"
    value = settings.get_secret(reference, db_path)
    if not value:
        raise SecretStoreUnavailable("已保存的安全凭证暂不可读取，原配置已保留")
    return value, reference.partition(":")[0], ""


def _secret_preview(connection: dict[str, Any], model_name: str, db_path) -> tuple[str, str, str, bool, str]:
    """Display saved state without authenticating to the OS keychain."""
    reference = str(connection.get("secret_ref") or "none")
    if reference.startswith("legacy:"):
        with connect(db_path) as conn:
            alias = conn.execute("SELECT secret_ref FROM model_credential_aliases WHERE reference=?", (reference,)).fetchone()
        if alias:
            reference = alias[0]
    if reference.startswith("keyring:"):
        source = secret_reference_backend(reference, db_path)
        return "", source, "", True, "saved_unverified"
    value, source, warning = _secret(connection, model_name, db_path)
    return value, source, warning, bool(value), "available" if value else "missing"


def _public_connection(connection: dict[str, Any], db_path) -> dict[str, Any]:
    result = {name: value for name, value in connection.items() if name != "secret_ref"}
    try:
        _, source, warning, configured, status = _secret_preview(connection, "", db_path)
    except SecretStoreUnavailable as exc:
        source, warning, configured, status = "none", str(exc), False, "unavailable"
    detected = normalize_detected_protocol(connection.get("detected_protocol")) if normalize_model_protocol(connection["protocol"]) == "auto" else None
    result.update(detected_protocol=detected, detected_protocol_label=PROTOCOL_LABELS[detected] if detected else None,
                  protocol_label=connection_protocol_label(connection["protocol"], detected, "", connection.get("effective_base_url") or ""))
    result.update(model_base_url=connection["base_url"], model_protocol=connection["protocol"], api_key_configured=configured, credential_status=status, api_key_source=source, secret_storage=secret_backend_name(), secret_storage_writable=secret_storage_writable(), secret_migration_warning=warning)
    return result


def _ensure_catalog(db_path) -> None:
    with settings._settings_lock(db_path):
        row = settings._initialize_connection(db_path)
        with connect(db_path) as conn:
            # Routing preferences exist independently of a selected model.
            conn.execute("INSERT OR IGNORE INTO model_routing_policy (id, version, payload_json) VALUES (1, 1, '{}')")
        with connect(db_path) as conn:
            if row.get("default_model_profile_id") and conn.execute("SELECT 1 FROM model_profiles WHERE id = ?", (row["default_model_profile_id"],)).fetchone():
                if row.get("model_api_key") and not row.get("model_secret_ref"):
                    settings._credential(row, db_path)
                return
        if not str(row.get("model_name") or "").strip():
            return
        key, _, _ = settings._credential(row, db_path)
        row = settings._row(db_path)
        resolved = settings._connection(row, key)
        connection_id = row["connection_id"]
        reference = str(row.get("model_secret_ref") or "none")
        if not row.get("model_secret_ref") and row.get("model_api_key"):
            reference = f"legacy:{connection_id}"
        profile_id = str(uuid4())
        with connect(db_path) as conn:
            conn.execute("BEGIN IMMEDIATE")
            existing = conn.execute("SELECT default_model_profile_id FROM agent_settings WHERE id = 1").fetchone()[0]
            if existing and conn.execute("SELECT 1 FROM model_profiles WHERE id = ?", (existing,)).fetchone():
                return
            conn.execute("""INSERT OR IGNORE INTO model_connections (id, name, base_url, effective_base_url, protocol, secret_ref, data_boundary)
                            VALUES (?, '默认连接', ?, ?, ?, ?, ?)""", (connection_id, row["model_base_url"], resolved["model_base_url"], row["model_protocol"], reference, connection_id))
            conn.execute("INSERT INTO model_profiles (id, connection_id, model_name, name) VALUES (?, ?, ?, ?)", (profile_id, connection_id, row["model_name"], row["model_name"]))
            if not conn.execute("SELECT 1 FROM model_connection_versions WHERE connection_id = ?", (connection_id,)).fetchone():
                _version(conn, "connection", _connection(conn, connection_id))
            _version(conn, "profile", _profile(conn, profile_id))
            conn.execute("UPDATE agent_settings SET default_model_profile_id = ? WHERE id = 1", (profile_id,))
            conn.execute("INSERT OR IGNORE INTO model_routing_policy (id, version, payload_json) VALUES (1, 1, '{}')")


def get_model_catalog(db_path: str | Path | None = None) -> dict[str, Any]:
    from .model_purposes import purpose_defaults, model_output_types, supported_purposes
    _ensure_catalog(db_path)
    with connect(db_path) as conn:
        connections = [_decode_connection(row) for row in conn.execute("SELECT * FROM model_connections ORDER BY created_at, id")]
        profiles = [_decode_profile(row) for row in conn.execute("SELECT * FROM model_profiles ORDER BY created_at, id")]
        row = conn.execute("SELECT default_model_profile_id, config_revision FROM agent_settings WHERE id = 1").fetchone()
        policy = conn.execute("SELECT payload_json FROM model_routing_policy WHERE id=1").fetchone()
        execution_profile = (json.loads(policy[0]) if policy else {}).get("roles", {}).get("execute") or row["default_model_profile_id"]
        defaults, purpose_version = purpose_defaults(conn)
    sources = {item["id"]: item for item in connections}
    default_profile = next((item for item in profiles if item["id"] == row["default_model_profile_id"]), None)
    routing_payload = json.loads(policy[0]) if policy else {}
    preferred_connection = routing_payload.get("service_connection_id") or (default_profile["connection_id"] if default_profile else None)
    service = next((item for item in connections if item["id"] == preferred_connection and item["enabled"]), None) or next((item for item in connections if item["enabled"]), None)
    if service and not routing_payload.get("service_connection_id"):
        # Add only this metadata key atomically; do not replace concurrent role edits.
        with connect(db_path) as conn:
            conn.execute("UPDATE model_routing_policy SET payload_json=json_set(payload_json, '$.service_connection_id', ?) WHERE id=1 AND json_extract(payload_json, '$.service_connection_id') IS NULL", (service["id"],))
    for profile in profiles:
        source = sources[profile["connection_id"]]
        types, origin = model_output_types(profile, source)
        profile.update(output_types=types, output_types_source=origin, supported_purposes=supported_purposes(profile, source))
    return {"connections": [_public_connection(item, db_path) for item in connections], "profiles": profiles, "default_profile_id": row["default_model_profile_id"], "effective_execution_profile_id": execution_profile, "config_revision": row["config_revision"], "purpose_defaults": defaults, "purpose_version": purpose_version, "service_connection_id": service["id"] if service else None}


def get_service_connection(connection_id: str, db_path: str | Path | None = None) -> dict[str, Any]:
    _ensure_catalog(db_path)
    with connect(db_path) as conn:
        connection = _connection(conn, connection_id)
    if not connection["enabled"]:
        raise ValueError("连接已停用")
    key, _, _ = _secret(connection, "", db_path)
    resolved = resolve_model_connection({"model_name": "", "model_base_url": connection["effective_base_url"], "model_protocol": connection["protocol"], "api_key": key})
    resolved.update(connection_id=connection_id, connection_revision=connection["revision"], secret_ref=connection["secret_ref"], detected_protocol=connection.get("detected_protocol"), connection_effective_base_url=connection["effective_base_url"])
    return resolved


def get_profile_connection(profile_id: str | None = None, db_path: str | Path | None = None, selection: dict[str, Any] | None = None, *, resolve_credentials: bool = True) -> dict[str, Any]:
    if selection is not None and not resolve_credentials:
        raise ValueError("恢复运行必须校验实际凭证，不能使用配置预览")
    _ensure_catalog(db_path)
    requested = dict(selection or {})
    with connect(db_path) as conn:
        profile_id = str(requested.get("profile_id") or profile_id or conn.execute("SELECT default_model_profile_id FROM agent_settings WHERE id = 1").fetchone()[0])
        profile = _profile(conn, profile_id)
        connection = _connection(conn, profile["connection_id"])
        if not profile["enabled"] or not connection["enabled"]:
            raise ValueError("所选模型或连接已停用，请明确选择其他模型")
        if requested.get("connection_id") and requested["connection_id"] != profile["connection_id"]:
            raise ValueError("运行快照中的模型连接不匹配")
        for kind, record in (("profile", profile), ("connection", connection)):
            version = requested.get(f"{kind}_revision")
            if version is not None:
                revision = int(version)
                version_row = conn.execute(f"SELECT payload_json FROM model_{kind}_versions WHERE {kind}_id = ? AND revision = ?", (record["id"], revision)).fetchone()
                if version_row is None:
                    raise ValueError("运行快照引用的模型版本不存在，无法恢复")
                restored = json.loads(version_row[0])
                if kind == "profile":
                    profile = restored
                else:
                    connection = restored
        if profile["connection_id"] != connection["id"]:
            raise ValueError("运行快照中的模型连接不匹配")
        config_revision = conn.execute("SELECT config_revision FROM agent_settings WHERE id = 1").fetchone()[0]
        live = _connection(conn, connection["id"])
    # Detection is runtime state, not configuration: use the live value only
    # while the wire-relevant fields still match the bound connection version.
    detected = None
    if normalize_model_protocol(connection["protocol"]) == "auto" and all(
        live.get(key) == connection.get(key) for key in ("effective_base_url", "protocol", "secret_ref")
    ):
        detected = normalize_detected_protocol(live.get("detected_protocol"))
    if resolve_credentials:
        api_key, source, warning = _secret(connection, profile["model_name"], db_path)
        configured, status = bool(api_key), "available" if api_key else "missing"
    else:
        api_key, source, warning, configured, status = _secret_preview(connection, profile["model_name"], db_path)
    credential_fingerprint = hashlib.sha256(api_key.encode()).hexdigest()
    if requested.get("credential_fingerprint") and not hmac.compare_digest(requested["credential_fingerprint"], credential_fingerprint):
        raise SecretStoreUnavailable("运行绑定的模型凭证已改变，无法恢复原配置；请新建任务")
    # Restored runs retain their bound adapter; only new selections infer an Images adapter.
    profile_protocol = (requested.get("model_protocol") or connection["protocol"]) if selection is not None else model_protocol_for_profile(profile["model_name"], connection["protocol"])
    resolved = resolve_model_connection({"model_name": profile["model_name"], "model_base_url": connection["effective_base_url"], "model_protocol": profile_protocol, "api_key": api_key})
    if resolved["resolved_model_protocol"] == "images":
        detected = None
    resolved.update(profile_id=profile["id"], connection_id=connection["id"], profile_revision=profile["revision"], connection_revision=connection["revision"], secret_ref=connection["secret_ref"], credential_fingerprint=credential_fingerprint, data_boundary=connection["data_boundary"], parameters=profile["parameters"], capabilities=profile["capabilities"], context_limit=profile["context_limit"], price_per_million_input=profile["price_per_million_input"], price_per_million_output=profile["price_per_million_output"], config_revision=config_revision, connection_configured_base_url=connection["base_url"], api_key_source=source if resolved["api_key"] else "none", secret_migration_warning=warning)
    resolved.update(connection_effective_base_url=connection["effective_base_url"], detected_protocol=detected, reasoning_effort=normalize_reasoning_effort(profile.get("reasoning_effort")))
    resolved.update(api_key_configured=configured, credential_status=status, api_key_source=source)
    if not resolve_credentials:
        resolved.pop("credential_fingerprint", None)
    return resolved


def record_detected_protocol(connection: dict[str, Any], protocol: str, db_path: str | Path | None = None) -> bool:
    """Durably remember which protocol auto negotiation settled on for a connection.

    The write is guarded by the wire-relevant fields so a detection that raced
    with an edit of the address, key or protocol is discarded.
    """
    detected = normalize_detected_protocol(protocol)
    connection_id = str(connection.get("connection_id") or "")
    if not detected or not connection_id or normalize_model_protocol(connection.get("model_protocol")) != "auto":
        return False
    with connect(db_path) as conn:
        cursor = conn.execute(
            """UPDATE model_connections SET detected_protocol = ?
               WHERE id = ? AND protocol = 'auto' AND effective_base_url = ? AND secret_ref = ?
                 AND COALESCE(detected_protocol, '') != ?""",
            (detected, connection_id, connection.get("connection_effective_base_url", connection.get("model_base_url")) or "", connection.get("secret_ref") or "none", detected),
        )
        return cursor.rowcount > 0


def detected_protocol_recorder(connection: dict[str, Any], db_path: str | Path | None = None):
    """Callback for AutoNegotiatingModelProvider; None when the connection is not auto."""
    if not connection.get("connection_id") or normalize_model_protocol(connection.get("model_protocol")) != "auto":
        return None
    snapshot = dict(connection)
    from ..workspace import resolve_db_path

    db_path = resolve_db_path(db_path)

    def remember(protocol: str) -> None:
        record_detected_protocol(snapshot, protocol, db_path)

    return remember


def _candidate(value: str, connection_id: str, db_path, candidates: list[str]) -> str:
    reference = settings.create_model_api_key(value, connection_id, db_path)
    candidates.append(reference)
    if not hmac.compare_digest(settings.get_secret(reference, db_path), value):
        raise SecretStoreUnavailable("新凭证写入校验失败，原配置已保留")
    return reference


def _check_revision(record: dict[str, Any], values: dict[str, Any]) -> None:
    if values.get("expected_revision") is not None and int(values["expected_revision"]) != record["revision"]:
        raise settings.AgentSettingsConflict("配置已在其他页面更新，请重新读取后保存")


def _bridge(conn, db_path, candidates: list[str]) -> None:
    row = dict(conn.execute("SELECT * FROM agent_settings WHERE id = 1").fetchone())
    if not row["default_model_profile_id"]:
        conn.execute("UPDATE agent_settings SET config_revision = config_revision + 1 WHERE id = 1")
        return
    profile = _profile(conn, row["default_model_profile_id"])
    connection = _connection(conn, profile["connection_id"])
    reference = connection["secret_ref"]
    legacy_reference = f"legacy:{row['connection_id']}"
    if row.get("model_api_key") and not row.get("model_secret_ref") and reference != legacy_reference:
        # Switching defaults or replacing a pending key must preserve the old
        # version first. Never point its legacy reference at the new credential.
        if not conn.execute("SELECT 1 FROM model_credential_aliases WHERE reference = ?", (legacy_reference,)).fetchone():
            preserved = _candidate(row["model_api_key"], row["connection_id"], db_path, candidates)
            conn.execute("INSERT INTO model_credential_aliases (reference, secret_ref) VALUES (?, ?)", (legacy_reference, preserved))
        conn.execute("UPDATE agent_settings SET model_api_key = '' WHERE id = 1")
    # Keep a pending old key until its safe migration has actually completed.
    if reference.startswith("legacy:"):
        reference = ""
    conn.execute("""UPDATE agent_settings SET connection_id = ?, model_name = ?, model_base_url = ?,
                   model_protocol = ?, model_secret_ref = ?, config_revision = config_revision + 1 WHERE id = 1""", (connection["id"], profile["model_name"], connection["base_url"], connection["protocol"], reference))


def _mutate(action: str, values: dict[str, Any], db_path, operation: Callable) -> Any:
    _ensure_catalog(db_path)
    with settings._settings_lock(db_path):
        candidates: list[str] = []
        request_id = str(values.get("request_id") or "").strip()
        fingerprint_values = {key: value for key, value in values.items() if key not in {"request_id", "expected_revision"}}
        fingerprint = settings._request_fingerprint(values) if action == "save_default_settings" else hashlib.sha256(_json({"action": action, "values": fingerprint_values}).encode()).hexdigest()
        replay = False
        try:
            with connect(db_path) as conn:
                conn.execute("BEGIN IMMEDIATE")
                if request_id:
                    previous = conn.execute("SELECT payload_fingerprint FROM model_settings_requests WHERE request_id = ?", (request_id,)).fetchone()
                    if previous:
                        if not hmac.compare_digest(previous[0], fingerprint):
                            raise settings.AgentSettingsConflict("同一保存请求已用于不同内容，请重新保存")
                        replay = True
                if not replay:
                    result = operation(conn, candidates)
                    _bridge(conn, db_path, candidates)
                    revision = conn.execute("SELECT config_revision FROM agent_settings WHERE id = 1").fetchone()[0]
                    conn.execute("UPDATE agent_settings SET last_save_request_id = ? WHERE id = 1", (request_id,))
                    if request_id:
                        conn.execute("INSERT INTO model_settings_requests (request_id, payload_fingerprint, saved_revision) VALUES (?, ?, ?)", (request_id, fingerprint, revision))
        except Exception:
            for reference in candidates:
                settings._discard_candidate(reference, db_path)
            raise
        return get_model_catalog(db_path) if replay else result


def _write_connection(conn, record: dict[str, Any]) -> None:
    record = {**record, "detected_protocol": normalize_detected_protocol(record.get("detected_protocol"))}
    conn.execute("""INSERT INTO model_connections (id, name, base_url, effective_base_url, protocol, secret_ref, data_boundary, enabled, revision, detected_protocol)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name=excluded.name, base_url=excluded.base_url,
        effective_base_url=excluded.effective_base_url, protocol=excluded.protocol, secret_ref=excluded.secret_ref,
        data_boundary=excluded.data_boundary, enabled=excluded.enabled, revision=excluded.revision,
        detected_protocol=excluded.detected_protocol, updated_at=CURRENT_TIMESTAMP""", tuple(record[key] for key in ("id", "name", "base_url", "effective_base_url", "protocol", "secret_ref", "data_boundary", "enabled", "revision", "detected_protocol")))
    _version(conn, "connection", _connection(conn, record["id"]))


def _create_connection_records(conn, values, db_path, candidates):
    connection_id = str(uuid4())
    protocol = normalize_model_protocol(values.get("protocol", values.get("model_protocol")))
    base = str(values.get("base_url", values.get("model_base_url", "")) or "").strip()
    root = normalize_api_root(base, resolve_model_protocol(str(values.get("model_name") or ""), protocol, base))
    key = str(values.get("api_key") or "").strip()
    reference = _candidate(key, connection_id, db_path, candidates) if key and resolve_model_protocol(str(values.get("model_name") or ""), protocol, root) != "ollama" else "none"
    record = {"id": connection_id, "name": str(values.get("name") or "模型连接").strip(), "base_url": base, "effective_base_url": root, "protocol": protocol, "secret_ref": reference, "data_boundary": str(values.get("data_boundary") or connection_id), "enabled": bool(values.get("enabled", True)), "revision": 1}
    _write_connection(conn, record)
    if values.get("model_name") is not None:
        profile = {"id": str(uuid4()), "connection_id": connection_id, "revision": 1, **_validated_profile({"model_name": values["model_name"]})}
        _write_profile(conn, profile)
    return record


def create_model_connection(values: dict[str, Any], db_path: str | Path | None = None) -> dict[str, Any]:
    def operation(conn, candidates):
        return _public_connection(_create_connection_records(conn, values, db_path, candidates), db_path)
    return _mutate("create_connection", values, db_path, operation)


def _updated_connection(conn, connection_id, values, db_path, candidates, model_name=""):
    current = _connection(conn, connection_id)
    _check_revision(current, values)
    key = str(values.get("api_key") or "").strip()
    old_key, _, _ = _secret(current, model_name, db_path) if not key else ("", "none", "")
    draft = {"model_name": model_name, "model_base_url": values.get("base_url", values.get("model_base_url", current["effective_base_url"])), "model_protocol": values.get("protocol", values.get("model_protocol", current["protocol"])), "api_key": key}
    resolved = resolve_model_connection(draft, saved={"model_name": model_name, "model_base_url": current["effective_base_url"], "model_protocol": current["protocol"], "api_key": old_key})
    reference = current["secret_ref"]
    if key and resolved["api_key"]:
        reference = _candidate(key, connection_id, db_path, candidates)
    elif not resolved["api_key"]:
        reference = "none"
    updated = {**current, "name": str(values.get("name", current["name"])).strip(), "base_url": str(values.get("base_url", values.get("model_base_url", current["base_url"])) or "").strip(), "effective_base_url": resolved["model_base_url"], "protocol": resolved["model_protocol"], "secret_ref": reference, "data_boundary": str(values.get("data_boundary", current["data_boundary"])), "enabled": bool(values.get("enabled", current["enabled"])), "revision": current["revision"] + 1}
    # A remembered negotiation result only describes the old address/key/protocol.
    if updated["protocol"] != "auto" or any(updated[key] != current[key] for key in ("base_url", "effective_base_url", "protocol", "secret_ref")):
        updated["detected_protocol"] = None
    default_id = conn.execute("SELECT default_model_profile_id FROM agent_settings WHERE id = 1").fetchone()[0]
    if not updated["enabled"] and default_id and _profile(conn, default_id)["connection_id"] == connection_id:
        raise ValueError("请先选择其他默认模型，再停用当前默认连接")
    if not updated["enabled"]:
        from .model_purposes import protect_purpose_defaults
        protect_purpose_defaults(conn, connection_id=connection_id)
    if updated["protocol"] != current["protocol"]:
        from .model_purposes import purpose_defaults, supported_purposes
        defaults, _ = purpose_defaults(conn)
        for kind, profile_id in defaults.items():
            if profile_id:
                profile = _profile(conn, profile_id)
                if profile["connection_id"] == connection_id and kind not in supported_purposes(profile, updated):
                    raise ValueError("此连接包含默认用途模型，请先更换默认模型再修改协议")
    _write_connection(conn, updated)
    if key or updated["effective_base_url"] != current["effective_base_url"] or updated["protocol"] != current["protocol"]:
        # Image availability is specific to a service/account. Replacement
        # credentials or gateways must not inherit an old service's denial.
        for row in conn.execute("SELECT * FROM model_profiles WHERE connection_id=?", (connection_id,)).fetchall():
            profile = _decode_profile(row)
            if profile["capabilities"]["image_generation"] != "unknown":
                profile["capabilities"]["image_generation"] = "unknown"
                _write_profile(conn, {**profile, "revision": profile["revision"] + 1})
    return updated


def update_model_connection(connection_id: str, values: dict[str, Any], db_path: str | Path | None = None) -> dict[str, Any]:
    def operation(conn, candidates):
        return _public_connection(_updated_connection(conn, connection_id, values, db_path, candidates), db_path)
    return _mutate(f"update_connection:{connection_id}", values, db_path, operation)


def _validated_profile(values, current=None):
    result = {**(current or {}), **{key: value for key, value in values.items() if key not in {"expected_revision", "request_id"}}}
    model_name = str(result.get("model_name") or "").strip()
    if not model_name:
        raise ValueError("模型名称不能为空")
    parameters = dict(result.get("parameters") or {})
    if set(parameters) - {"temperature", "max_output_tokens"}:
        raise ValueError("模型参数仅支持 temperature 和 max_output_tokens")
    if "temperature" in parameters and (isinstance(parameters["temperature"], bool) or not isinstance(parameters["temperature"], (int, float)) or not math.isfinite(parameters["temperature"]) or not 0 <= parameters["temperature"] <= 2):
        raise ValueError("temperature 需要在 0 到 2 之间")
    if "max_output_tokens" in parameters and (isinstance(parameters["max_output_tokens"], bool) or not isinstance(parameters["max_output_tokens"], int) or parameters["max_output_tokens"] <= 0):
        raise ValueError("max_output_tokens 需要为正整数")
    capabilities = {name: "unknown" for name in _CAPABILITY_NAMES} | dict(result.get("capabilities") or {})
    if set(capabilities) - set((*_CAPABILITY_NAMES, "chat", "video_generation")) or any(value not in {"supported", "unsupported", "unknown"} for value in capabilities.values()):
        raise ValueError("模型能力需要为 supported、unsupported 或 unknown")
    context_limit = result.get("context_limit")
    if context_limit is not None and (isinstance(context_limit, bool) or not isinstance(context_limit, int) or context_limit <= 0):
        raise ValueError("context_limit 需要为正整数或空值")
    for key in ("price_per_million_input", "price_per_million_output"):
        price = result.get(key)
        if price is not None and (isinstance(price, bool) or not isinstance(price, (float, int)) or not math.isfinite(price) or price < 0):
            raise ValueError("模型价格需要为非负数或空值")
    effort = result.get("reasoning_effort")
    if effort is not None and (not isinstance(effort, str) or effort.strip().lower() not in REASONING_EFFORTS):
        raise ValueError("reasoning_effort 需要为 low、medium、high 或空值")
    return {"model_name": model_name, "name": str(result.get("name") or model_name), "enabled": bool(result.get("enabled", True)), "parameters": parameters, "capabilities": capabilities, "context_limit": context_limit, "price_per_million_input": result.get("price_per_million_input"), "price_per_million_output": result.get("price_per_million_output"), "reasoning_effort": normalize_reasoning_effort(effort)}


def _write_profile(conn, record):
    conn.execute("""INSERT INTO model_profiles (id, connection_id, model_name, name, enabled, revision, parameters_json, capabilities_json, context_limit, price_per_million_input, price_per_million_output, reasoning_effort)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET model_name=excluded.model_name,
        name=excluded.name, enabled=excluded.enabled, revision=excluded.revision, parameters_json=excluded.parameters_json,
        capabilities_json=excluded.capabilities_json, context_limit=excluded.context_limit, price_per_million_input=excluded.price_per_million_input,
        price_per_million_output=excluded.price_per_million_output, reasoning_effort=excluded.reasoning_effort, updated_at=CURRENT_TIMESTAMP""",
        (record["id"], record["connection_id"], record["model_name"], record["name"], record["enabled"], record["revision"], _json(record["parameters"]), _json(record["capabilities"]), record["context_limit"], record["price_per_million_input"], record["price_per_million_output"], normalize_reasoning_effort(record.get("reasoning_effort"))))
    _version(conn, "profile", _profile(conn, record["id"]))


def add_model_profile(values: dict[str, Any], db_path: str | Path | None = None) -> dict[str, Any]:
    def operation(conn, _candidates):
        connection = _connection(conn, str(values.get("connection_id") or ""))
        if not connection["enabled"]:
            raise ValueError("连接已停用")
        record = {"id": str(uuid4()), "connection_id": connection["id"], "revision": 1, **_validated_profile(values)}
        _write_profile(conn, record)
        return _profile(conn, record["id"])
    return _mutate("add_profile", values, db_path, operation)


def ensure_service_model_profile(connection_id: str, values: dict[str, Any], db_path: str | Path | None = None) -> dict[str, Any]:
    """Reuse a saved model or materialize a service model without changing defaults."""
    def operation(conn, _candidates):
        connection = _connection(conn, connection_id)
        _check_revision(connection, values)
        if not connection["enabled"]:
            raise ValueError("连接已停用")
        model_name = _validated_profile(values)["model_name"]
        matches = [_decode_profile(row) for row in conn.execute(
            "SELECT * FROM model_profiles WHERE connection_id = ? AND model_name = ? ORDER BY created_at, id",
            (connection_id, model_name),
        )]
        existing = next((profile for profile in matches if profile["enabled"]), None)
        if existing:
            return existing
        if matches:
            raise ValueError("此模型已停用，请在模型设置中启用")
        record = {"id": str(uuid4()), "connection_id": connection_id, "revision": 1, **_validated_profile({"model_name": model_name})}
        _write_profile(conn, record)
        return _profile(conn, record["id"])
    return _mutate(f"ensure_service_profile:{connection_id}", values, db_path, operation)


def update_model_profile(profile_id: str, values: dict[str, Any], db_path: str | Path | None = None) -> dict[str, Any]:
    def operation(conn, _candidates):
        current = _profile(conn, profile_id)
        _check_revision(current, values)
        if "connection_id" in values and values["connection_id"] != current["connection_id"]:
            raise ValueError("模型档案不能改绑其他连接，请新建档案")
        changes = dict(values)
        if changes.get("capabilities") is not None:
            changes["capabilities"] = {**current["capabilities"], **changes["capabilities"]}
        elif "capabilities" in changes:
            changes.pop("capabilities")
        if changes.get("model_name", current["model_name"]) != current["model_name"] and "image_generation" not in (values.get("capabilities") or {}):
            changes["capabilities"] = {**current["capabilities"], **changes.get("capabilities", {}), "image_generation": "unknown"}
        record = {**current, **_validated_profile(changes, current), "revision": current["revision"] + 1}
        if not record["enabled"] and conn.execute("SELECT default_model_profile_id FROM agent_settings WHERE id=1").fetchone()[0] == profile_id:
            raise ValueError("请先选择其他默认模型，再停用当前默认模型")
        from .model_purposes import protect_purpose_defaults, purpose_defaults, supported_purposes
        if not record["enabled"]:
            protect_purpose_defaults(conn, profile_id=profile_id)
        defaults, _ = purpose_defaults(conn)
        for kind, selected in defaults.items():
            if selected == profile_id and kind not in supported_purposes(record, _connection(conn, record["connection_id"])):
                raise ValueError("此模型正用于默认用途，请先更换默认模型再修改能力")
        _write_profile(conn, record)
        return _profile(conn, profile_id)
    return _mutate(f"update_profile:{profile_id}", values, db_path, operation)


def set_default_model_profile(profile_id: str, values: dict[str, Any] | None = None, db_path: str | Path | None = None) -> dict[str, Any]:
    def operation(conn, _candidates):
        profile = _profile(conn, profile_id)
        connection = _connection(conn, profile["connection_id"])
        if not profile["enabled"] or not connection["enabled"]:
            raise ValueError("所选模型或连接已停用")
        row = conn.execute("SELECT config_revision FROM agent_settings WHERE id=1").fetchone()
        if (values or {}).get("expected_revision") is not None and int(values["expected_revision"]) != row[0]:
            raise settings.AgentSettingsConflict("默认模型已更新，请重新读取")
        from .model_purposes import purpose_defaults, supported_purposes, model_output_types
        types, _ = model_output_types(profile, connection)
        if types == ["video"]:
            raise ValueError("视频生成接口暂未接入，不能设为默认模型")
        defaults, _ = purpose_defaults(conn)
        kinds = supported_purposes(profile, connection)
        for kind in kinds:
            defaults[kind] = profile_id
        # Keep legacy clients in sync with the same per-purpose rules.
        payload = json.loads(conn.execute("SELECT payload_json FROM model_routing_policy WHERE id=1").fetchone()[0])
        payload["purpose_defaults"] = defaults
        conn.execute("UPDATE model_routing_policy SET version=version+1, payload_json=? WHERE id=1", (_json(payload),))
        conn.execute("UPDATE agent_settings SET default_model_profile_id=? WHERE id=1", (profile_id,))
        return profile
    _mutate(f"set_default:{profile_id}", values or {}, db_path, operation)
    return get_model_catalog(db_path)


def archive_model_connection(connection_id: str, values: dict[str, Any] | None = None, db_path: str | Path | None = None) -> dict[str, Any]:
    update_model_connection(connection_id, {**(values or {}), "enabled": False}, db_path)
    return get_model_catalog(db_path)


def save_default_agent_settings(values: dict[str, Any], db_path: str | Path | None = None) -> dict[str, Any]:
    def operation(conn, candidates):
        row = dict(conn.execute("SELECT * FROM agent_settings WHERE id=1").fetchone())
        if values.get("expected_revision") is not None and int(values["expected_revision"]) != row["config_revision"]:
            raise settings.AgentSettingsConflict("设置已在其他页面更新，请重新读取后保存")
        created = False
        if not row["default_model_profile_id"] and str(values.get("model_name") or "").strip():
            connection = _create_connection_records(conn, values, db_path, candidates)
            profile_id = conn.execute("SELECT id FROM model_profiles WHERE connection_id = ?", (connection["id"],)).fetchone()[0]
            conn.execute("UPDATE agent_settings SET default_model_profile_id = ? WHERE id = 1", (profile_id,))
            row["default_model_profile_id"] = profile_id
            created = True
        if not row["default_model_profile_id"]:
            for field in settings._SAVE_FIELDS:
                if field in values and field not in {"model_name", "model_base_url", "model_protocol"}:
                    conn.execute(f"UPDATE agent_settings SET {field} = ? WHERE id = 1", (values[field],))
            return None
        profile = _profile(conn, row["default_model_profile_id"])
        if "model_name" in values and not str(values["model_name"] or "").strip():
            raise ValueError("模型名称不能为空")
        if not str(values.get("api_key") or "").strip():
            old_connection = _connection(conn, profile["connection_id"])
            old_key, _, warning = _secret(old_connection, profile["model_name"], db_path)
            if old_connection["secret_ref"] == settings._ENVIRONMENT_REF and not old_key:
                raise SecretStoreUnavailable(warning)
        connection_changes = {key: values[key] for key in ("model_base_url", "model_protocol", "api_key") if key in values}
        if not created and connection_changes and (values.get("api_key") or any(values.get(key) != row[key] for key in ("model_base_url", "model_protocol") if key in values)):
            _updated_connection(conn, profile["connection_id"], connection_changes, db_path, candidates, str(values.get("model_name", profile["model_name"])))
            profile = _profile(conn, profile["id"])
        if "model_name" in values and values["model_name"] != profile["model_name"]:
            profile = {**profile, **_validated_profile({"model_name": values["model_name"], "capabilities": {**profile["capabilities"], "image_generation": "unknown"}}, profile), "revision": profile["revision"] + 1}
            _write_profile(conn, profile)
        for field in settings._SAVE_FIELDS:
            if field in {"model_name", "model_base_url", "model_protocol"} or field not in values:
                continue
            value = int(values[field]) if field in settings._MEMORY_FIELDS else values[field]
            conn.execute(f"UPDATE agent_settings SET {field}=? WHERE id=1", (value,))
        return profile
    _mutate("save_default_settings", {key: value for key, value in values.items() if key in {*settings._SAVE_FIELDS, "api_key", "expected_revision", "request_id"}}, db_path, operation)
    return public_default_agent_settings(db_path)


def public_default_agent_settings(db_path: str | Path | None = None) -> dict[str, Any]:
    _ensure_catalog(db_path)
    row = settings._row(db_path)
    if display_name(str(row.get("display_name") or "")) != row.get("display_name"):
        row["display_name"] = display_name(str(row.get("display_name") or ""))
        with connect(db_path) as conn:
            conn.execute("UPDATE agent_settings SET display_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1", (row["display_name"],))
    if not row["default_model_profile_id"]:
        result = settings._settings_fallback(settings.get_settings())
        result.update({key: row[key] for key in settings._SAVE_FIELDS})
        for field in settings._MEMORY_FIELDS:
            result[field] = bool(result[field])
        result.update(configured_model_base_url=row["model_base_url"], config_revision=row["config_revision"], last_save_request_id=row.get("last_save_request_id", ""), profile_id=None, connection_id="", api_key_configured=False, api_key_source="none")
        return result
    with connect(db_path) as conn:
        profile = _profile(conn, row["default_model_profile_id"])
        connection = _connection(conn, profile["connection_id"])
    try:
        key, source, warning, configured, status = _secret_preview(connection, profile["model_name"], db_path)
    except SecretStoreUnavailable as exc:
        key, source, warning, configured, status = "", "none", str(exc), False, "unavailable"
    effective = resolve_model_connection({"model_name": profile["model_name"], "model_base_url": connection["effective_base_url"], "model_protocol": model_protocol_for_profile(profile["model_name"], connection["protocol"]), "api_key": key})
    from ..models.auto_negotiating import get_negotiated_model_protocol
    detected = normalize_detected_protocol(connection.get("detected_protocol")) if normalize_model_protocol(connection["protocol"]) == "auto" else None
    if effective["resolved_model_protocol"] == "images":
        detected = None
    actual = get_negotiated_model_protocol(effective["model_name"], effective["model_protocol"], effective["model_base_url"], effective["api_key"]) or detected

    result = {name: value for name, value in row.items() if name not in {"model_api_key", "model_secret_ref", "model_config_initialized"}}
    for field in settings._MEMORY_FIELDS:
        result[field] = bool(result[field])
    result.update(model_name=profile["model_name"], model_base_url=connection["base_url"], configured_model_base_url=connection["base_url"], model_protocol=connection["protocol"],
        profile_id=profile["id"], connection_id=connection["id"], profile_revision=profile["revision"], connection_revision=connection["revision"],
        predicted_model_protocol=effective["resolved_model_protocol"], resolved_model_protocol=actual or effective["resolved_model_protocol"], detected_model_protocol=actual,
        model_protocol_label=connection_protocol_label(connection["protocol"], actual, profile["model_name"], effective["model_base_url"]),
        api_key_configured=configured, credential_status=status, api_key_source=source if configured else "none", secret_storage=secret_backend_name(), secret_storage_writable=secret_storage_writable(), secret_migration_warning=warning)
    return result
