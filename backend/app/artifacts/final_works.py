"""Account-local, immutable copies of explicitly selected work versions."""
from __future__ import annotations

import hashlib
import json
import re
import uuid
from pathlib import Path

from ..db import connect
from ..execution.workspace_files import WorkspaceFiles, open_regular_file
from ..extensions.contracts import ExtensionContext
from ..workspace import current_workspace_root
from .service import MAX_ARTIFACT_BYTES

MAX_WORKS = 500
MAX_TOTAL_BYTES = 512 * 1024 * 1024
CHUNK_BYTES = 64 * 1024
MARKDOWN = "text/markdown; charset=utf-8"
PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
_PPT_JOBS = {"ppt.generate", "ppt.quick_generate"}
_PUBLIC = "id,kind,filename,created_at,media_type,size"


class FinalWorkConflict(ValueError):
    pass


class FinalWorkTooLarge(ValueError):
    pass


class FinalWorksFull(ValueError):
    pass


def _document(conn, document_id, version):
    # Read the stored version, not an export, the latest draft, or a library copy.
    row = conn.execute("""SELECT d.title,d.incomplete,v.markdown FROM authored_documents d
        JOIN authored_document_versions v ON v.document_id=d.id WHERE d.id=? AND v.version=?""",
        (document_id, version)).fetchone()
    if row is None:
        raise FileNotFoundError
    if row["incomplete"]:
        raise FinalWorkConflict("不能归档来自未完成回答的文档")
    stem = re.sub(r"[^\w.()\- ]+", "_", row["title"]).strip(". ") or "文档"
    return f"{stem}.md", row["markdown"].encode("utf-8")


def _presentation(conn, artifact_id, version):
    row = conn.execute("""SELECT a.*,j.kind AS job_kind,j.status AS job_status,j.result_json
        FROM file_artifacts a JOIN background_jobs j ON j.id=a.job_id WHERE a.id=? AND a.version=?""",
        (artifact_id, version)).fetchone()
    if row is None:
        raise FileNotFoundError
    try:
        result = json.loads(row["result_json"] or "null")
    except ValueError:
        result = None
    artifacts = result.get("artifacts") if isinstance(result, dict) else None
    if (row["job_kind"] not in _PPT_JOBS or row["job_status"] != "succeeded"
            or row["media_type"] != PPTX or Path(row["filename"]).suffix.lower() != ".pptx"
            or not isinstance(artifacts, list)
            or not any(isinstance(item, dict) and item.get("id") == artifact_id
                       and type(item.get("version")) is int and item["version"] == version
                       and item.get("filename") == row["filename"] for item in artifacts)):
        raise FinalWorkConflict("只能归档已成功交付的 PPTX 文件")
    return row


def _copy_presentation(conn, rowid, source):
    relative = f"{source['job_id']}/{source['id']}/{source['version']}/payload.bin"
    if source["relative_path"] != relative or not all(
        re.fullmatch(r"[0-9a-f]{32}", source[key]) for key in ("job_id", "id")
    ):
        raise FinalWorkConflict("PPTX 文件引用无效")
    workspace = current_workspace_root()
    try:
        path = WorkspaceFiles(workspace / "artifacts", boundary=workspace).path(relative)
        digest, size = hashlib.sha256(), 0
        with open_regular_file(path) as input_file, conn.blobopen("final_works", "payload", rowid) as output:
            while chunk := input_file.read(min(CHUNK_BYTES, source["size"] - size + 1)):
                size += len(chunk)
                if size > source["size"]:
                    raise FinalWorkConflict("PPTX 文件内容与交付记录不符")
                digest.update(chunk)
                output.write(chunk)
    except ValueError as exc:
        if isinstance(exc, FinalWorkConflict):
            raise
        raise FinalWorkConflict("PPTX 文件路径不可用") from exc
    if size != source["size"] or digest.hexdigest() != source["content_hash"]:
        raise FinalWorkConflict("PPTX 文件内容与交付记录不符")


def _reserve(conn, size):
    if not 0 <= size <= MAX_ARTIFACT_BYTES:
        raise FinalWorkTooLarge("单个定稿文件不能超过 64 MB")
    count, used = conn.execute("SELECT COUNT(*), COALESCE(SUM(size),0) FROM final_works").fetchone()
    if count >= MAX_WORKS or used + size > MAX_TOTAL_BYTES:
        raise FinalWorksFull("本账号的定稿归档已达到存储上限")


def _archive(kind, source_id, version, context):
    context.check_workspace()
    with connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        existing = conn.execute(f"SELECT {_PUBLIC} FROM final_works WHERE kind=? AND source_id=? AND source_version=?",
                                (kind, source_id, version)).fetchone()
        if existing is not None:
            return dict(existing)
        if kind == "document":
            filename, payload = _document(conn, source_id, version)
            media_type, size = MARKDOWN, len(payload)
        else:
            source = _presentation(conn, source_id, version)
            filename, media_type, size = source["filename"], PPTX, source["size"]
            payload = None
        _reserve(conn, size)
        work_id = uuid.uuid4().hex
        cursor = conn.execute("""INSERT INTO final_works(id,kind,source_id,source_version,filename,media_type,size,payload)
            VALUES(?,?,?,?,?,?,?,COALESCE(?,zeroblob(?)))""",
            (work_id, kind, source_id, version, filename, media_type, size, payload, size))
        if kind == "presentation":
            # The verified bytes and public metadata become visible together at commit.
            _copy_presentation(conn, cursor.lastrowid, source)
        return dict(conn.execute(f"SELECT {_PUBLIC} FROM final_works WHERE id=?", (work_id,)).fetchone())


def archive_document(document_id: str, version: int, context: ExtensionContext) -> dict:
    return _archive("document", document_id, version, context)


def archive_presentation(artifact_id: str, version: int, context: ExtensionContext) -> dict:
    return _archive("presentation", artifact_id, version, context)


def list_works(context: ExtensionContext) -> list[dict]:
    context.check_workspace()
    with connect() as conn:
        return [dict(row) for row in conn.execute(
            f"SELECT {_PUBLIC} FROM final_works ORDER BY rowid DESC LIMIT ?", (MAX_WORKS,))]


def download_work(work_id: str, context: ExtensionContext) -> tuple[str, str, bytes]:
    context.check_workspace()
    with connect() as conn:
        row = conn.execute("SELECT filename,media_type,payload FROM final_works WHERE id=? AND size<=?",
                           (work_id, MAX_ARTIFACT_BYTES)).fetchone()
    if row is None:
        raise FileNotFoundError
    return row["filename"], row["media_type"], row["payload"]
