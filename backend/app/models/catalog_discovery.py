"""Credential-free catalog evidence, independent of enabled execution profiles."""
from __future__ import annotations

import json
from contextlib import contextmanager
from contextvars import ContextVar
from datetime import datetime, timezone


_ALL_KINDS = ContextVar("all_catalog_kinds", default=False)


@contextmanager
def all_model_kinds():
    token = _ALL_KINDS.set(True)
    try:
        yield
    finally:
        _ALL_KINDS.reset(token)


def catalog_query():
    return {"kind": "all"} if _ALL_KINDS.get() else None


def rejected_kind_parameter(error):
    """Only a definite unsupported catalog filter permits a second, free GET."""
    if getattr(error, "status_code", None) not in {400, 422}:
        return False
    body = str(getattr(error, "body", "")).lower()
    if any(word in body for word in ("api_key", "api key", "authentication", "unauthorized", "permission")):
        return False
    return "kind" in body and any(word in body for word in ("unsupported", "unknown", "unexpected", "unrecognized", "extra_forbidden", "not permitted"))


def normalize_catalog(items, *, api_key=""):
    from .selection import model_output_types

    entries = []
    seen = set()
    for item in items:
        if isinstance(item, str):
            data = {"id": item}
        elif isinstance(item, dict):
            data = item
        elif callable(getattr(item, "model_dump", None)):
            data = item.model_dump()
        else:
            data = {"id": getattr(item, "id", None)}
        identity = data.get("id")
        if not isinstance(identity, str) or not identity.strip() or identity.strip() in seen:
            continue
        identity = identity.strip()
        seen.add(identity)
        modalities = data.get("modalities")
        inputs = modalities.get("input") if isinstance(modalities, dict) else modalities
        outputs = modalities.get("output") if isinstance(modalities, dict) else data.get("output_modalities")
        output_map = {"text": "chat", "chat": "chat", "image": "image", "video": "video"}
        kind = data.get("kind")
        declared = [output_map[kind]] if isinstance(kind, str) and kind in output_map else []
        if isinstance(outputs, list):
            declared.extend(output_map[value] for value in outputs if isinstance(value, str) and value in output_map)
        inferred, source = model_output_types({"model_name": identity}, {})
        entry = {"id": identity, "output_types": list(dict.fromkeys(declared)) if declared else inferred,
                 "output_types_source": "provider" if declared else source}
        if isinstance(inputs, list):
            entry["input_types"] = list(dict.fromkeys(value for value in inputs if isinstance(value, str) and value in {"text", "image", "audio", "video"}))
        for key in ("display_name", "owned_by"):
            value = data.get(key)
            if isinstance(value, str) and value.strip():
                value = value.strip()
                if api_key and api_key in value:
                    continue
                entry[key] = value[:160]
        for key in ("context_window", "max_output_tokens"):
            value = data.get(key)
            if isinstance(value, int) and not isinstance(value, bool) and value > 0:
                entry[key] = value
        entries.append(entry)
    return entries


class DiscoveredModels(list):
    """Existing adapters keep their list[str] contract while preserving metadata."""
    def __init__(self, entries):
        self.entries = sorted(entries, key=lambda entry: entry["id"])
        super().__init__(entry["id"] for entry in self.entries)


def store_discovery(conn, connection_id, revision, entries, *, api_key="", started_at=None):
    # Lock before checking the revision: a concurrent connection update must not
    # let an old discovery overwrite the current service's cache.
    if not conn.in_transaction:
        conn.execute("BEGIN IMMEDIATE")
    current = conn.execute("SELECT revision, enabled, deleted_at FROM model_connections WHERE id=?", (connection_id,)).fetchone()
    if not current or current["revision"] != revision or not current["enabled"] or current["deleted_at"] is not None:
        return False
    safe_entries = []
    for entry in entries:
        if not isinstance(entry, dict) or not isinstance(entry.get("id"), str):
            continue
        model_id = entry["id"]
        if api_key and api_key in model_id:
            continue
        projected = _public_cached_entry(model_id, json.dumps(entry, ensure_ascii=False))
        if not projected:
            continue
        for field in ("display_name", "owned_by"):
            if api_key and api_key in projected.get(field, ""):
                projected.pop(field, None)
        safe_entries.append(projected)
    # Never erase a useful prior snapshot if an upstream catalog contains no
    # safely persistable entry (and preserve its concurrency watermark).
    if not safe_entries:
        return True
    if started_at is not None:
        # An invalid future legacy timestamp must not prevent recovery forever.
        # For ordinary clocks, retain newer observations over a late response.
        now = datetime.now(timezone.utc)
        existing = conn.execute("SELECT discovered_at FROM model_catalog_entries WHERE connection_id=? AND connection_revision=?", (connection_id, revision)).fetchall()
        if any((timestamp := _cached_timestamp(row["discovered_at"])) is not None and started_at < timestamp <= now for row in existing):
            return True
    conn.execute("DELETE FROM model_catalog_entries WHERE connection_id=?", (connection_id,))
    observed = (started_at or datetime.now(timezone.utc)).isoformat()
    conn.executemany(
        "INSERT INTO model_catalog_entries (connection_id, connection_revision, model_id, metadata_json, discovered_at) VALUES (?,?,?,?,?)",
        [(connection_id, revision, entry["id"], json.dumps(entry, ensure_ascii=False), observed) for entry in safe_entries],
    )
    return True


def _public_cached_entry(model_id, metadata_json):
    """Treat legacy JSON as untrusted, and project only known discovery fields."""
    if not isinstance(model_id, str) or not model_id.strip() or model_id != model_id.strip() or len(model_id) > 120:
        return None
    result = {"id": model_id}
    try:
        data = json.loads(metadata_json)
    except (TypeError, ValueError, UnicodeError, RecursionError):
        return result
    # A legacy record may omit id. If it names a different model, none of its
    # capability metadata is evidence about this entry.
    if not isinstance(data, dict) or ("id" in data and data["id"] != model_id):
        return result
    for key, allowed in (
        ("output_types", {"chat", "image", "video"}),
        ("input_types", {"text", "image", "audio", "video"}),
    ):
        value = data.get(key)
        if isinstance(value, list):
            result[key] = list(dict.fromkeys(item for item in value if isinstance(item, str) and item in allowed))
    if data.get("output_types_source") in ("provider", "inferred", "unknown", "configured"):
        result["output_types_source"] = data["output_types_source"]
    for key in ("display_name", "owned_by"):
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            value = value.strip()[:160]
            try:
                value.encode("utf-8")
            except UnicodeEncodeError:
                continue
            result[key] = value
    for key in ("context_window", "max_output_tokens"):
        value = data.get(key)
        if isinstance(value, int) and not isinstance(value, bool) and value > 0:
            result[key] = value
    return result


def _cached_timestamp(value):
    """Normalize SQLite UTC timestamps and ignore malformed legacy values."""
    if not isinstance(value, str):
        return None
    try:
        timestamp = datetime.fromisoformat(value)
        if timestamp.tzinfo is None:
            timestamp = timestamp.replace(tzinfo=timezone.utc)
        return timestamp.astimezone(timezone.utc)
    except (ValueError, OverflowError):
        return None


def read_cached_catalog(conn, connection_id):
    """Read the live connection and its cache from one SQLite statement snapshot."""
    rows = conn.execute(
        """SELECT c.revision, c.enabled, c.deleted_at, e.model_id, e.metadata_json, e.discovered_at
           FROM model_connections AS c
           LEFT JOIN model_catalog_entries AS e
             ON e.connection_id = c.id AND e.connection_revision = c.revision
           WHERE c.id = ?
           ORDER BY e.model_id""",
        (connection_id,),
    ).fetchall()
    if not rows or rows[0]["deleted_at"] is not None:
        raise ValueError("模型连接不存在")
    if not rows[0]["enabled"]:
        raise ValueError("连接已停用")
    entries = []
    timestamps = []
    for row in rows:
        entry = _public_cached_entry(row["model_id"], row["metadata_json"])
        if entry is None:
            continue
        entries.append(entry)
        timestamp = _cached_timestamp(row["discovered_at"])
        if timestamp is not None:
            timestamps.append(timestamp)
    # Mixed or malformed timestamps can arise in legacy data. Treat the entire
    # directory as stale rather than letting one recent row refresh older rows.
    discovered_at = min(timestamps) if len(timestamps) == len(entries) and timestamps else None
    now = datetime.now(timezone.utc)
    return {
        "connection_id": connection_id,
        "connection_revision": rows[0]["revision"],
        "models": [entry["id"] for entry in entries],
        "entries": entries,
        "discovered_at": discovered_at.isoformat().replace("+00:00", "Z") if discovered_at else None,
        "cache_age_seconds": max(0, (now - discovered_at).total_seconds()) if discovered_at and discovered_at <= now else None,
    }


def discovered_entry(conn, connection_id, revision, model_name):
    row = conn.execute(
        "SELECT metadata_json FROM model_catalog_entries WHERE connection_id=? AND connection_revision=? AND model_id=?",
        (connection_id, revision, model_name),
    ).fetchone()
    return json.loads(row["metadata_json"]) if row else None


def discovered_capabilities(conn, connection_id, revision, model_name):
    entry = discovered_entry(conn, connection_id, revision, model_name)
    if not entry or entry["output_types_source"] != "provider":
        return {}
    return {key: "supported" if kind in entry["output_types"] else "unsupported" for kind, key in (
        ("chat", "chat"), ("image", "image_generation"), ("video", "video_generation"),
    )}
