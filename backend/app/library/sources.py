"""Independent local sources; current reads never revisit legacy storage."""
from __future__ import annotations

import json
import mimetypes
import os
import re
from hashlib import sha256
from pathlib import Path
from typing import Any

from ..db import connect, json_dump, row_to_dict
from ..knowledge import delete_document, index_document
from ..knowledge.service import index_chunks
from ..privacy import scan_and_redact
from ..workspace import resolve_document_dir
from ..documents.service import parse_document_upload
from ..documents.blocks import DocumentBlock, text_document
from ..documents.parser import DocumentParseResult
from .source_versions import save_source_version, source_state


SOURCE_TYPE = "library_source"



# The system MIME table differs between macOS, Linux and packaged runtimes; pin the
# text formats the library accepts so previews do not depend on the host.
_KNOWN_MIME_TYPES = {".md": "text/markdown", ".markdown": "text/markdown", ".txt": "text/plain"}


def _guess_mime_type(filename: str) -> str:
    suffix = Path(filename).suffix.lower()
    if suffix in _KNOWN_MIME_TYPES:
        return _KNOWN_MIME_TYPES[suffix]
    return mimetypes.guess_type(filename)[0] or "application/octet-stream"

def _clean_title(value: str, fallback: str = "未命名资料") -> str:
    return " ".join(value.split())[:255] or fallback


def _safe_filename(value: str) -> str:
    name = Path(value).name.strip()[:255] or "document"
    safe = re.sub(r"[^\w.()\-\u4e00-\u9fff ]+", "_", name, flags=re.UNICODE)
    return safe.strip(". ") or "document"


def _library_root(db_path: str | Path | None = None) -> Path:
    root = resolve_document_dir(db_path) / "library"
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        root.chmod(0o700)
    except OSError:
        pass
    return root


def _source_dir(source_id: int, db_path: str | Path | None = None) -> Path:
    directory = _library_root(db_path) / str(source_id)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        directory.chmod(0o700)
    except OSError:
        pass
    return directory


def _model_content(source: dict[str, Any]) -> str:
    return str(
        source.get("content")
        if source.get("privacy_mode") == "original"
        else source.get("redacted_content")
        or ""
    )


def _index_source(source: dict[str, Any], db_path: str | Path | None = None, *, connection=None) -> None:
    source_id = int(source["id"])
    if not source.get("enabled") or source.get("parse_status") != "ready" or source.get("trashed_at"):
        delete_document(SOURCE_TYPE, source_id, db_path=db_path, connection=connection)
        return
    content = _model_content(source).strip()
    if not content:
        delete_document(SOURCE_TYPE, source_id, db_path=db_path, connection=connection)
        return
    if source.get("source_revision"):
        from .source_versions import get_source_version
        version = get_source_version(source_id, source["source_revision"], db_path)
        index_chunks(SOURCE_TYPE, source_id, [
            {"title": source.get("title") or "资料", "content": block["text"] if source["privacy_mode"] == "original" else block["model_text"],
             "metadata": {"source_id": source_id, "source_revision": version["revision"], "block_id": block["block_id"],
                          "locator": block["locator"], "privacy_mode": source["privacy_mode"]}}
            for block in version["blocks"]
        ], db_path, connection=connection)
        return
    index_document(
        SOURCE_TYPE,
        source_id,
        str(source.get("title") or "资料"),
        content,
        metadata={
            "source_id": source_id,
            "title": source.get("title") or "资料",
            "privacy_mode": source.get("privacy_mode") or "redacted",
        },
        db_path=db_path,
    )


def _source_from_row(row: Any) -> dict[str, Any]:
    source = row_to_dict(row) or {}
    source["enabled"] = bool(source.get("enabled"))
    source["character_count"] = int(source.get("character_count") or 0)
    organization = (source.get("metadata") or {}).get("organization") or {}
    source.update({key: organization.get(key) for key in ("folder_id", "trashed_at", "last_opened_at")})
    source["favorite"] = bool(organization.get("favorite"))
    return source


def _summary(source: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": int(source["id"]),
        "source_kind": source.get("source_kind") or "upload",
        "title": source.get("title") or "资料",
        "original_filename": source.get("original_filename") or "",
        "mime_type": source.get("mime_type") or "application/octet-stream",
        "source_uri": source.get("source_uri") or "",
        "privacy_mode": source.get("privacy_mode") or "redacted",
        "enabled": bool(source.get("enabled")),
        "parse_status": source.get("parse_status") or "ready",
        "character_count": int(source.get("character_count") or 0),
        "file_available": bool(source.get("stored_path")),
        "created_at": source.get("created_at") or "",
        "updated_at": source.get("updated_at") or "",
        "folder_id": source.get("folder_id"),
        "favorite": bool(source.get("favorite")),
        "trashed_at": source.get("trashed_at"),
        "last_opened_at": source.get("last_opened_at"),
        "size_bytes": (source.get("metadata") or {}).get("size_bytes", 0),
        "file_status": (source.get("metadata") or {}).get("file_status", "ready" if source.get("stored_path") else "unavailable"),
        "text_parse_status": (source.get("metadata") or {}).get("text_parse_status", source.get("parse_status") or "ready"),
        "source_revision": source.get("source_revision"),
        "backfill_status": source.get("backfill_status") or "pending",
        "backfill_job_id": source.get("backfill_job_id"),
    }


def list_sources(db_path: str | Path | None = None, *, query: str = "") -> list[dict[str, Any]]:
    with connect(db_path) as conn:
        rows = conn.execute(
            """SELECT s.*, v.current_revision AS source_revision, v.job_id AS backfill_job_id,
            CASE WHEN v.backfill_status IN ('pending','running') AND j.status IN ('failed','cancelled','interrupted')
                 THEN 'failed' ELSE v.backfill_status END AS backfill_status
            FROM library_sources s LEFT JOIN document_source_state v
            ON v.source_kind='library' AND v.source_key=CAST(s.id AS TEXT)
            LEFT JOIN background_jobs j ON j.id=v.job_id
            ORDER BY s.updated_at DESC, s.id DESC"""
        ).fetchall()
    needle = query.strip().casefold()
    # Search the same workspace snapshot once, without a separate detail read
    # per file. Python casefold preserves Unicode matching across platforms.
    return [
        _summary(_source_from_row(row)) for row in rows
        if not needle or needle in f"{row['title']} {row['original_filename']} {row['content']}".casefold()
    ]


def get_source(
    source_id: int,
    db_path: str | Path | None = None,
) -> dict[str, Any]:
    with connect(db_path) as conn:
        row = conn.execute(
            "SELECT * FROM library_sources WHERE id = ?", (source_id,)
        ).fetchone()
    if row is None:
        raise ValueError("资料来源不存在")
    source = _source_from_row(row)
    return {
        **_summary(source),
        "content": str(source.get("content") or ""),
        "redacted_content": str(source.get("redacted_content") or ""),
        "metadata": source.get("metadata") if isinstance(source.get("metadata"), dict) else {},
        **source_state("library", source_id, db_path),
    }


def create_text_source(
    *,
    title: str,
    content: str,
    privacy_mode: str = "redacted",
    source_uri: str = "",
    enabled: bool = False,
    db_path: str | Path | None = None,
) -> dict[str, Any]:
    clean_content = content.strip()
    if not clean_content:
        raise ValueError("资料内容不能为空")
    if privacy_mode not in {"redacted", "original"}:
        raise ValueError("隐私模式不合法")
    redacted = scan_and_redact(clean_content)[1]
    with connect(db_path) as conn:
        cursor = conn.execute(
            """
            INSERT INTO library_sources (
                source_kind, title, mime_type, source_uri, content,
                redacted_content, privacy_mode, enabled, parse_status,
                content_hash, character_count, metadata_json
            ) VALUES ('paste', ?, 'text/plain', ?, ?, ?, ?, ?, 'ready', ?, ?, '{}')
            """,
            (
                _clean_title(title),
                source_uri.strip()[:2000],
                clean_content,
                redacted,
                privacy_mode,
                int(enabled),
                sha256(clean_content.encode("utf-8")).hexdigest(),
                len(clean_content),
            ),
        )
        source_id = int(cursor.lastrowid)
    source = get_source(source_id, db_path=db_path)
    save_source_version(source_id, text_document(clean_content), db_path)
    source = get_source(source_id, db_path=db_path)
    _index_source(source, db_path)
    return source


def import_file_source(
    *,
    filename: str,
    content_bytes: bytes,
    mode: str = "fast",
    privacy_mode: str = "redacted",
    enabled: bool = False,
    db_path: str | Path | None = None,
) -> dict[str, Any]:
    if not content_bytes:
        raise ValueError("资料文件不能为空")
    if privacy_mode not in {"redacted", "original"}:
        raise ValueError("隐私模式不合法")
    safe_name = _safe_filename(filename)
    try:
        parsed = parse_document_upload(safe_name, content_bytes, mode)
        extracted = str(parsed.get("text") or "").strip()
    except ValueError as exc:
        parsed = {"warnings": [f"{exc}；原文件已保存，可预览或下载。"]}
        extracted = ""
    except Exception:
        # The original is the file library's durable record; extraction is optional.
        parsed = {"warnings": ["文字提取失败，原文件已保存，可预览或下载。"]}
        extracted = ""
    redacted = str(parsed.get("redacted_text") or scan_and_redact(extracted)[1])
    mime_type = _guess_mime_type(safe_name)
    digest = sha256(content_bytes).hexdigest()
    metadata = {
        "parser": parsed.get("parser") or "unknown",
        "warnings": parsed.get("warnings") or [],
        "size_bytes": len(content_bytes),
    }
    with connect(db_path) as conn:
        cursor = conn.execute(
            """
            INSERT INTO library_sources (
                source_kind, title, original_filename, mime_type, content,
                redacted_content, privacy_mode, enabled, parse_status,
                content_hash, character_count, metadata_json
            ) VALUES ('upload', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                _clean_title(Path(safe_name).stem),
                safe_name,
                mime_type,
                extracted,
                redacted,
                privacy_mode,
                int(enabled and bool(extracted)),
                "ready" if extracted else "failed",
                digest,
                len(extracted),
                json_dump(metadata),
            ),
        )
        source_id = int(cursor.lastrowid)
    directory = _source_dir(source_id, db_path)
    stored = directory / safe_name
    try:
        stored.write_bytes(content_bytes)
        stored.chmod(0o600)
        relative = stored.relative_to(resolve_document_dir(db_path)).as_posix()
        with connect(db_path) as conn:
            conn.execute(
                "UPDATE library_sources SET stored_path = ? WHERE id = ?",
                (relative, source_id),
            )
    except Exception:
        with connect(db_path) as conn:
            conn.execute("DELETE FROM library_sources WHERE id = ?", (source_id,))
        try:
            stored.unlink(missing_ok=True)
            directory.rmdir()
        except OSError:
            pass
        raise
    source = get_source(source_id, db_path=db_path)
    if extracted:
        result = DocumentParseResult(extracted, str(parsed.get("parser") or "saved_text"),
            blocks=[DocumentBlock(**block) for block in parsed.get("blocks", [])],
            extracted_characters=parsed.get("extracted_characters", len(extracted)),
            complete=parsed.get("complete", True), unprocessed_ranges=parsed.get("unprocessed_ranges", []),
            units=parsed.get("units", []))
        if not result.blocks:
            result = text_document(extracted, parser=result.parser)
        save_source_version(source_id, result, db_path)
        source = get_source(source_id, db_path=db_path)
    _index_source(source, db_path)
    return source


def update_source(
    source_id: int,
    *,
    title: str | None = None,
    content: str | None = None,
    privacy_mode: str | None = None,
    enabled: bool | None = None,
    db_path: str | Path | None = None,
) -> dict[str, Any]:
    current = get_source(source_id, db_path=db_path)
    next_title = _clean_title(title, current["title"]) if title is not None else current["title"]
    next_privacy = privacy_mode or current["privacy_mode"]
    if next_privacy not in {"redacted", "original"}:
        raise ValueError("隐私模式不合法")
    next_enabled = current["enabled"] if enabled is None else enabled
    next_content = current["content"] if content is None else content.strip()
    if enabled is True and not next_content.strip():
        raise ValueError("该文件没有可检索文字，请先补充正文")
    if content is not None and not next_content:
        raise ValueError("资料内容不能为空")
    from ..documents.parser import MAX_DOCUMENT_CHARACTERS
    if content is not None and len(next_content) > MAX_DOCUMENT_CHARACTERS:
        raise ValueError(f"资料内容不能超过 {MAX_DOCUMENT_CHARACTERS} 字符")
    next_redacted = current["redacted_content"] if content is None else scan_and_redact(next_content)[1]
    next_hash = (
        sha256(next_content.encode("utf-8")).hexdigest()
        if content is not None else None
    )
    metadata = dict(current["metadata"])
    if content is not None and "text_parse_status" in metadata:
        metadata["text_parse_status"] = "ready"
    if content is not None and current["source_kind"] == "upload":
        metadata["content_edited"] = True
    with connect(db_path) as conn:
        if content is not None:
            conn.execute("UPDATE document_source_state SET current_revision=NULL,backfill_status='pending' WHERE source_kind='library' AND source_key=?", (str(source_id),))
        conn.execute(
            """
            UPDATE library_sources
            SET title = ?, content = ?, redacted_content = ?,
                content_hash = COALESCE(?, content_hash), character_count = ?,
                metadata_json = ?, privacy_mode = ?, enabled = ?,
                parse_status = CASE WHEN ? IS NOT NULL THEN 'ready' ELSE parse_status END,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
            """,
            (
                next_title, next_content, next_redacted, next_hash,
                len(next_content), json_dump(metadata), next_privacy,
                int(next_enabled), content, source_id,
            ),
        )
    source = get_source(source_id, db_path=db_path)
    if content is not None:
        save_source_version(source_id, text_document(next_content, parser="corrected_text"), db_path)
        source = get_source(source_id, db_path=db_path)
    _index_source(source, db_path)
    return source


def _stored_file(source: dict[str, Any], db_path: str | Path | None = None) -> Path | None:
    relative = str(source.get("stored_path") or "")
    if not relative:
        return None
    root = resolve_document_dir(db_path).resolve()
    candidate = (root / relative).resolve()
    if candidate != root and root not in candidate.parents:
        raise ValueError("资料文件路径无效")
    return candidate


def get_source_file(source_id: int, db_path: str | Path | None = None) -> tuple[Path, str, str]:
    source = get_source(source_id, db_path=db_path)
    with connect(db_path) as conn:
        row = conn.execute(
            "SELECT stored_path FROM library_sources WHERE id = ?", (source_id,)
        ).fetchone()
    stored = _stored_file({"stored_path": row["stored_path"] if row else ""}, db_path)
    if stored is None or not stored.is_file():
        raise ValueError("该来源没有可用原文件")
    return stored, source["original_filename"] or stored.name, source["mime_type"]


def get_source_asset(source_id: int, asset_id: str, db_path: str | Path | None = None) -> tuple[Path, str, str]:
    source = get_source(source_id, db_path=db_path)
    if source is None:
        raise ValueError("文件不存在")
    asset = next((a for a in source.get("metadata", {}).get("chat_assets", []) if a.get("id") == asset_id), None)
    if asset is None:
        raise ValueError("文件图片不存在")
    root = _library_root(db_path) / str(source_id)
    target = (root / asset["path"]).resolve()
    if root.is_symlink() or not root.resolve().is_relative_to(resolve_document_dir(db_path).resolve()) or not target.is_relative_to(root.resolve()) or not target.is_file() or target == root.resolve():
        raise ValueError("文件图片不可用")
    return target, asset["original_filename"], asset["content_type"]


def delete_source(source_id: int, db_path: str | Path | None = None) -> bool:
    stored: Path | None = None
    original: bytes | None = None
    asset_backups: list[tuple[Path, bytes]] = []
    try:
        with connect(db_path) as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute(
                "SELECT * FROM library_sources WHERE id = ?", (source_id,)
            ).fetchone()
            if row is None:
                raise ValueError("资料来源不存在")
            source = _source_from_row(row)
            stored = _stored_file(source, db_path)
            original = stored.read_bytes() if stored is not None and stored.is_file() else None
            for asset in source.get("metadata", {}).get("chat_assets", []):
                path, _, _ = get_source_asset(source_id, asset["id"], db_path)
                asset_backups.append((path, path.read_bytes()))
            evidence = conn.execute(
                """
                SELECT e.id, e.knowledge_id, i.status
                FROM library_evidence e
                JOIN library_knowledge i ON i.id = e.knowledge_id
                WHERE e.source_id = ?
                """,
                (source_id,),
            ).fetchall()
            for item in evidence:
                memory_id = int(item["knowledge_id"])
                if item["status"] == "pending":
                    conn.execute("DELETE FROM library_evidence WHERE id = ?", (item["id"],))
                    remaining = conn.execute(
                        "SELECT 1 FROM library_evidence WHERE knowledge_id = ? LIMIT 1",
                        (memory_id,),
                    ).fetchone()
                    if remaining is None:
                        conn.execute("DELETE FROM library_knowledge WHERE id = ?", (memory_id,))
                else:
                    conn.execute(
                        """
                        UPDATE library_evidence
                        SET source_id = NULL,
                            locator = CASE WHEN locator = '' THEN '原来源已删除'
                              ELSE locator || ' · 原来源已删除' END
                        WHERE id = ?
                        """,
                        (item["id"],),
                    )
            conn.execute("DELETE FROM library_sources WHERE id = ?", (source_id,))
            conn.execute("DELETE FROM document_source_versions WHERE source_kind='library' AND source_key=?", (str(source_id),))
            conn.execute("DELETE FROM document_source_state WHERE source_kind='library' AND source_key=?", (str(source_id),))
            delete_document(SOURCE_TYPE, source_id, db_path=db_path, connection=conn)
            for path, _ in asset_backups:
                path.unlink(missing_ok=True)
            if stored is not None:
                try:
                    stored.unlink(missing_ok=True)
                except OSError as exc:
                    raise ValueError("无法删除原文件，请检查文件权限后重试") from exc
    except Exception:
        for path, data in asset_backups:
            if not path.exists():
                path.write_bytes(data)
                path.chmod(0o600)
        if stored is not None and original is not None and not stored.exists():
            stored.write_bytes(original)
            stored.chmod(0o600)
        raise
    if stored is not None:
        if asset_backups:
            try:
                (stored.parent / "assets").rmdir()
            except OSError:
                pass
        try:
            stored.parent.rmdir()
        except OSError:
            # Empty directory cleanup is optional; original-file deletion is not.
            pass
    return True


def enabled_source_details(db_path: str | Path | None = None, *, source_ids: set[int] | None = None) -> list[dict[str, Any]]:
    if source_ids is not None and not source_ids:
        return []
    scope = "" if source_ids is None else f" AND s.id IN ({','.join('?' for _ in source_ids)})"
    with connect(db_path) as conn:
        rows = conn.execute(
            """
            SELECT s.*, v.current_revision AS source_revision, v.job_id AS backfill_job_id,
            CASE WHEN v.backfill_status IN ('pending','running') AND j.status IN ('failed','cancelled','interrupted')
                 THEN 'failed' ELSE v.backfill_status END AS backfill_status
            FROM library_sources s LEFT JOIN document_source_state v
            ON v.source_kind='library' AND v.source_key=CAST(s.id AS TEXT)
            LEFT JOIN background_jobs j ON j.id=v.job_id
            WHERE s.enabled = 1 AND s.parse_status = 'ready'
            """ + scope + " ORDER BY s.updated_at DESC, s.id DESC",
            tuple(sorted(source_ids or ())),
        ).fetchall()
    return [source for row in rows if not (source := _source_from_row(row)).get("trashed_at")]
