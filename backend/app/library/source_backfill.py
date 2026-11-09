"""Trusted, resumable local parsing; database upgrades only enqueue this work."""
from __future__ import annotations

import asyncio
from hashlib import sha256

from ..db import connect, json_dump
from ..documents.blocks import text_document, DocumentBlock
from ..documents.parser import parse_document_result, DocumentParseResult, MAX_DOCUMENT_CHARACTERS
from ..privacy import scan_and_redact
from ..extensions.runtime_snapshot import ExtensionRunSnapshot
from .source_versions import _target, save_attachment_version, save_source_version, source_state
from .sources import _index_source, get_source, get_source_file

JOB_KIND = "library.source_backfill"


def _status(kind, key, status, db_path=None, *, job_id=None, owner_check=None):
    with connect(db_path) as conn:
        conn.execute("BEGIN IMMEDIATE")
        if owner_check is not None:
            owner_check(conn)
        try:
            _target(conn, kind, key)
        except ValueError:
            return
        if status == "pending" and job_id is not None:
            job = conn.execute("SELECT status FROM background_jobs WHERE id=?", (job_id,)).fetchone()
            if job is None or job["status"] != "queued":
                return
        conn.execute("""INSERT INTO document_source_state(source_kind,source_key,backfill_status,job_id,error_code)
            VALUES(?,?,?,?,?) ON CONFLICT(source_kind,source_key) DO UPDATE SET
            backfill_status=excluded.backfill_status,job_id=COALESCE(excluded.job_id,document_source_state.job_id),error_code=excluded.error_code""",
            (kind, str(key), status, job_id, "parse_failed" if status == "failed" else ""))


def backfill_source(source_id, db_path=None, *, kind="library", owner_check=None):
    if kind == "library":
        source = get_source(int(source_id), db_path)
        text = source["content"]
        corrected = source["metadata"].get("content_edited", False)
        filename = source["original_filename"]
        get_file = lambda: get_source_file(int(source_id), db_path)[0]
        save = save_source_version
    elif kind == "attachment":
        from ..attachments.service import get_attachment, get_attachment_file
        source = get_attachment(str(source_id), db_path=db_path)
        if source is None or source["kind"] != "document":
            raise ValueError("文档附件不存在")
        text, corrected = source["parsed_text"], False
        filename = source["original_filename"]
        get_file = lambda: get_attachment_file(str(source_id), db_path=db_path)[0]
        save = save_attachment_version
    else:
        raise ValueError("资料类型不合法")
    try:
        # User corrections are authoritative; their coordinates refer to that text.
        parsed = text_document(text, parser="corrected_text" if corrected else "saved_text")
        if filename and not corrected:
            parsed.complete = False
            parsed.unprocessed_ranges = [{"kind": "file", "reason": "original_not_verified"}]
        from .source_versions import get_attachment_version, get_source_version
        revision = source_state(kind, source_id, db_path)["source_revision"]
        existing = (get_source_version if kind == "library" else get_attachment_version)(source_id, revision, db_path) if revision else None
        saved_file = bool(existing and existing["text"] == text and existing["parser"] == "saved_text" and filename and not corrected)
        if existing and existing["text"] == text and not saved_file:
            parsed = DocumentParseResult(text, existing["parser"], blocks=[DocumentBlock(**b) for b in existing["blocks"]],
                complete=existing["complete"], units=existing["units"], unprocessed_ranges=existing["unprocessed_ranges"])
        known_truncated = bool(existing and not corrected and existing["text"] == text
            and any(item.get("reason") == "character_limit" for item in existing["unprocessed_ranges"]))
        if (not existing or known_truncated or saved_file) and not corrected and filename:
            try:
                path = get_file()
            except ValueError:
                path = None
            if path is not None:
                original = parse_document_result(filename, path.read_bytes())
                # Extend only a known capped prefix, never a correction or an
                # unrelated normalisation change. The old version stays immutable.
                if ((not existing or saved_file) and original.text == text) or (known_truncated and len(original.text) > len(text) and original.text.startswith(text)):
                    parsed = original
        version = save(source_id, parsed, db_path, activate=False, owner_check=owner_check)
        # Both source kinds activate their head and index under the same lease.
        with connect(db_path) as conn:
            conn.execute("BEGIN IMMEDIATE")
            if owner_check is not None:
                owner_check(conn)
            current = get_source(int(source_id), db_path) if kind == "library" else get_attachment(str(source_id), db_path=db_path)
            body_key = "content" if kind == "library" else "parsed_text"
            if current is None or current[body_key] != text:
                raise ValueError("资料正文已变化，不能激活此解析版本")
            metadata = dict(current.get("metadata") or {})
            if known_truncated:
                metadata["document_backfill_limit"] = MAX_DOCUMENT_CHARACTERS
            if parsed.text != text:
                metadata.update(parser=parsed.parser, warnings=parsed.warnings, character_count=len(parsed.text))
            if parsed.text != text or known_truncated:
                redacted = scan_and_redact(parsed.text)[1]
                if kind == "library":
                    conn.execute("UPDATE library_sources SET content=?,redacted_content=?,character_count=?,metadata_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",
                                 (parsed.text, redacted, len(parsed.text), json_dump(metadata), source_id))
                else:
                    conn.execute("UPDATE attachments SET parsed_text=?,redacted_text=?,metadata_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?",
                                 (parsed.text, redacted, json_dump(metadata), source_id))
                current = {**current, body_key: parsed.text, "redacted_content": redacted, "metadata": metadata}
            if kind == "library":
                _index_source({**current, "source_revision": version["revision"]}, db_path, connection=conn)
            else:
                from ..attachments.service import index_attachment
                index_attachment(source_id, db_path=db_path, version=version, connection=conn)
            if owner_check is not None:
                owner_check(conn)
            conn.execute("""INSERT INTO document_source_state(source_kind,source_key,current_revision,backfill_status)
                VALUES(?,?,?,'ready') ON CONFLICT(source_kind,source_key) DO UPDATE SET
                current_revision=excluded.current_revision,backfill_status='ready',error_code=''""", (kind, str(source_id), version["revision"]))
            if owner_check is not None:
                owner_check(conn)
        return {"status": "ready", "source_revision": version["revision"], "extraction_complete": parsed.complete, "characters": len(parsed.text)}
    except ValueError as exc:
        if "正文已变化" in str(exc):
            return {"status": "superseded", **source_state(kind, source_id, db_path)}
        _status(kind, source_id, "failed", db_path, owner_check=owner_check)
        raise
    except Exception:
        _status(kind, source_id, "failed", db_path, owner_check=owner_check)
        raise


async def run_backfill(job, control):
    kind, key = job["request"]["source_kind"], job["request"]["source_key"]
    owner_check = lambda conn: control.service.repository.assert_owner(conn, job["id"], job["owner_token"])
    _status(kind, key, "running", job_id=job["id"], owner_check=owner_check)
    return await asyncio.to_thread(backfill_source, key, kind=kind, owner_check=owner_check)


def register_backfill_handler(jobs):
    existing = jobs.handlers.get(JOB_KIND)
    if existing is not None and existing is not run_backfill:
        raise ValueError("资料回填任务适配器已经注册")
    jobs.handlers[JOB_KIND] = run_backfill


def enqueue_backfill(source_id, context, jobs, request_id, *, kind="library"):
    context.check_workspace()
    if kind == "library":
        if get_source(int(source_id))["trashed_at"]:
            raise ValueError("资料已移入回收站")
    else:
        from ..attachments.service import get_attachment
        if kind != "attachment" or get_attachment(str(source_id)) is None:
            raise ValueError("资料不存在")
    state = source_state(kind, source_id)
    if state["backfill_job_id"]:
        active = jobs.get(state["backfill_job_id"], context)
        if active["status"] in {"queued", "running"}:
            return active
    identity = sha256(f"{kind}:{source_id}:{request_id}".encode()).hexdigest()
    job = jobs.enqueue(JOB_KIND, {"source_kind": kind, "source_key": str(source_id)}, context,
                       f"source-backfill:{identity}", snapshot=ExtensionRunSnapshot(user_id=context.user_id))
    if job["status"] == "queued":
        _status(kind, source_id, "pending", job_id=job["id"])
    return job


def enqueue_pending_backfills(context, jobs):
    with connect() as conn:
        # Old saved-text versions prove the stored body, not extraction of an
        # uploaded original. Publish a new, honest range without rewriting them.
        conn.execute("""UPDATE document_source_state SET backfill_status='pending',job_id=NULL
            WHERE backfill_status='ready' AND EXISTS(SELECT 1 FROM document_source_versions v
                WHERE v.source_kind=document_source_state.source_kind AND v.source_key=document_source_state.source_key
                AND v.revision=document_source_state.current_revision AND v.parser='saved_text' AND v.complete=1)
            AND ((source_kind='library' AND EXISTS(SELECT 1 FROM library_sources s WHERE CAST(s.id AS TEXT)=source_key
                AND COALESCE(s.original_filename,'')<>'' AND COALESCE(json_extract(s.metadata_json,'$.content_edited'),0)=0
                AND json_extract(s.metadata_json,'$.organization.trashed_at') IS NULL))
             OR (source_kind='attachment' AND EXISTS(SELECT 1 FROM attachments a WHERE a.id=source_key
                AND a.kind='document' AND a.parse_status='parsed' AND length(a.parsed_text)>0)))""")
        conn.execute("""UPDATE document_source_state SET backfill_status='pending',job_id=NULL
            WHERE backfill_status='ready' AND EXISTS(SELECT 1 FROM document_source_versions v
                WHERE v.source_kind=document_source_state.source_kind AND v.source_key=document_source_state.source_key
                AND v.revision=document_source_state.current_revision AND v.complete=0 AND length(v.text)<?
                AND EXISTS(SELECT 1 FROM json_each(v.unprocessed_json) r WHERE json_extract(r.value,'$.reason')='character_limit'))
            AND ((source_kind='library' AND EXISTS(SELECT 1 FROM library_sources s WHERE CAST(s.id AS TEXT)=source_key
                AND COALESCE(json_extract(s.metadata_json,'$.content_edited'),0)=0
                AND COALESCE(json_extract(s.metadata_json,'$.document_backfill_limit'),0)<?
                AND json_extract(s.metadata_json,'$.organization.trashed_at') IS NULL))
             OR (source_kind='attachment' AND EXISTS(SELECT 1 FROM attachments a WHERE a.id=source_key
                AND a.parse_status='parsed' AND COALESCE(json_extract(a.metadata_json,'$.document_backfill_limit'),0)<?)))""",
            (MAX_DOCUMENT_CHARACTERS, MAX_DOCUMENT_CHARACTERS, MAX_DOCUMENT_CHARACTERS))
        # Existing schema-38 attachments already have versions but predate
        # conversation-local indexing. Reuse those versions in the same worker.
        conn.execute("""UPDATE document_source_state SET backfill_status='pending',job_id=NULL
            WHERE source_kind='attachment' AND backfill_status='ready'
            AND EXISTS(SELECT 1 FROM attachments a WHERE a.id=document_source_state.source_key
                       AND a.kind='document' AND a.parse_status='parsed' AND length(a.parsed_text)>0)
            AND NOT EXISTS(SELECT 1 FROM knowledge_chunks k WHERE k.source_type='conversation_attachment'
                AND k.source_id=document_source_state.source_key
                AND json_extract(k.metadata_json,'$.source_revision')=document_source_state.current_revision)""")
        pending = conn.execute("SELECT source_kind,source_key,current_revision FROM document_source_state WHERE backfill_status='pending' AND job_id IS NULL").fetchall()
    for row in pending:
        try:
            enqueue_backfill(row["source_key"], context, jobs, f"document-range-v2:{MAX_DOCUMENT_CHARACTERS}:{row['current_revision'] or 'legacy'}", kind=row["source_kind"])
        except ValueError:
            _status(row["source_kind"], row["source_key"], "failed")
    return len(pending)
