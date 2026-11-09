"""Credential-free catalog evidence, independent of enabled execution profiles."""
from __future__ import annotations

import json
from contextlib import contextmanager
from contextvars import ContextVar


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


def normalize_catalog(items):
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
                entry[key] = value.strip()[:160]
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


def store_discovery(conn, connection_id, revision, entries):
    current = conn.execute("SELECT revision, enabled FROM model_connections WHERE id=?", (connection_id,)).fetchone()
    if not current or current["revision"] != revision or not current["enabled"]:
        return False
    conn.execute("DELETE FROM model_catalog_entries WHERE connection_id=?", (connection_id,))
    conn.executemany(
        "INSERT INTO model_catalog_entries (connection_id, connection_revision, model_id, metadata_json) VALUES (?,?,?,?)",
        [(connection_id, revision, entry["id"], json.dumps(entry, ensure_ascii=False)) for entry in entries],
    )
    return True


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
