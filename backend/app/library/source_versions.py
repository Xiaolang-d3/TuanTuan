"""Versioned source text, isolated by the active workspace database."""
from __future__ import annotations

import json
from hashlib import sha256

from ..db import connect, json_dump
from ..documents.blocks import BLOCK_SCHEMA_VERSION
from ..privacy import scan_and_redact

def _target(conn, kind, key):
    table = "library_sources" if kind == "library" else "attachments" if kind == "attachment" else None
    if table is None:
        raise ValueError("资料类型不合法")
    row = conn.execute(f"SELECT * FROM {table} WHERE id=?", (key,)).fetchone()
    if row is None:
        raise ValueError("资料不存在")
    if kind == "library" and (json.loads(row["metadata_json"] or "{}").get("organization") or {}).get("trashed_at"):
        raise ValueError("资料已移入回收站")
    return row


def _save(kind, key, parsed, db_path, activate, owner_check=None):
    blocks = [block.to_dict() for block in parsed.blocks]
    structure = json_dump({"parser": parsed.parser, "schema": BLOCK_SCHEMA_VERSION, "blocks": blocks,
                           "units": parsed.units, "complete": parsed.complete, "unprocessed": parsed.unprocessed_ranges})
    structure_hash = sha256(structure.encode()).hexdigest()
    content_hash = sha256(parsed.text.encode()).hexdigest()
    revision = sha256(f"{content_hash}:{structure_hash}".encode()).hexdigest()
    with connect(db_path) as conn:
        conn.execute("BEGIN IMMEDIATE")
        if owner_check is not None:
            owner_check(conn)
        current = _target(conn, kind, key)
        current_text = current["content"] if kind == "library" else current["parsed_text"]
        if activate and current_text != parsed.text:
            raise ValueError("资料正文已变化，不能激活此解析版本")
        conn.execute("""INSERT OR IGNORE INTO document_source_versions
            (source_kind,source_key,revision,text,redacted_text,parser,content_hash,structure_hash,blocks_json,complete,units_json,unprocessed_json)
            VALUES(?,?,?,?,?,?,?,?,?,?,?,?)""", (kind, str(key), revision, parsed.text, scan_and_redact(parsed.text)[1], parsed.parser,
                content_hash, structure_hash, json_dump(blocks), int(parsed.complete), json_dump(parsed.units), json_dump(parsed.unprocessed_ranges)))
        if activate:
            conn.execute("""INSERT INTO document_source_state(source_kind,source_key,current_revision,backfill_status)
                VALUES(?,?,?,'ready') ON CONFLICT(source_kind,source_key) DO UPDATE SET
                current_revision=excluded.current_revision,backfill_status='ready',error_code=''""", (kind, str(key), revision))
    return _get(kind, key, revision, db_path)


def _get(kind, key, revision, db_path, conversation_id=None):
    with connect(db_path) as conn:
        target = _target(conn, kind, key)
        if kind == "attachment" and conversation_id is not None and target["conversation_id"] != conversation_id:
            raise ValueError("附件不属于当前对话")
        row = conn.execute("SELECT * FROM document_source_versions WHERE source_kind=? AND source_key=? AND revision=?",
                           (kind, str(key), revision)).fetchone()
        if row is None:
            raise ValueError("资料历史版本不存在，无法精确定位")
        state = conn.execute("SELECT current_revision FROM document_source_state WHERE source_kind=? AND source_key=?", (kind, str(key))).fetchone()
    result = dict(row)
    result["blocks"] = json.loads(result.pop("blocks_json"))
    result["units"] = json.loads(result.pop("units_json"))
    result["unprocessed_ranges"] = json.loads(result.pop("unprocessed_json"))
    result["complete"] = bool(result["complete"])
    result["is_current"] = state is not None and state["current_revision"] == revision
    return result


def save_source_version(source_id, parsed, db_path=None, *, activate=True, owner_check=None):
    return _save("library", source_id, parsed, db_path, activate, owner_check)


def get_source_version(source_id, revision, db_path=None):
    return _get("library", source_id, revision, db_path)


def save_attachment_version(attachment_id, parsed, db_path=None, *, activate=True, owner_check=None):
    return _save("attachment", attachment_id, parsed, db_path, activate, owner_check)


def get_attachment_version(attachment_id, revision, db_path=None, *, conversation_id=None):
    return _get("attachment", attachment_id, revision, db_path, conversation_id)


def source_state(kind, key, db_path=None):
    with connect(db_path) as conn:
        row = conn.execute("""SELECT s.current_revision,s.job_id,
            CASE WHEN s.backfill_status IN ('pending','running') AND j.status IN ('failed','cancelled','interrupted')
                 THEN 'failed' ELSE s.backfill_status END AS backfill_status
            FROM document_source_state s LEFT JOIN background_jobs j ON j.id=s.job_id
            WHERE s.source_kind=? AND s.source_key=?""", (kind, str(key))).fetchone()
    return {"source_revision": row["current_revision"], "backfill_status": row["backfill_status"], "backfill_job_id": row["job_id"]} if row else {"source_revision": None, "backfill_status": "pending", "backfill_job_id": None}
