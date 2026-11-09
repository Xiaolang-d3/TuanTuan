"""Trusted Worker exports of immutable document versions."""
from __future__ import annotations

import asyncio
import hashlib
from importlib import metadata
import json
import re

from .document_rendering import font_bytes, render_document, MAX_EXPORT_BYTES
from .documents import DocumentStore, DocumentConflict, DocumentNotFound
from .service import ArtifactService, public_artifact
from ..db import connect
from ..execution.workspace_files import WorkspaceFiles
from ..extensions.runtime_snapshot import ExtensionRunSnapshot
from ..jobs.repository import JobConflict, JobExecutionError, public_job
from ..workspace import current_workspace_root

JOB_KIND = "document.export"
EXPORTER_VERSION = "document-v1-md4.2.0-docx1.2.0-pdf4.4.10-font9eba8b13-6c3631e8"
_store = DocumentStore()


def export_capabilities():
    reason = ""
    try:
        for style in ("Regular", "Bold"):
            font_bytes(style)
    except (OSError, ValueError, KeyError):
        reason = "中文导出字体不可用，请修复团团安装"
    formats = {}
    for format, package, version in (("docx", "python-docx", "1.2.0"), ("pdf", "reportlab", "4.4.10")):
        failure = reason
        try:
            if metadata.version(package) != version:
                failure = failure or "导出组件版本不匹配，请更新团团"
        except metadata.PackageNotFoundError:
            failure = failure or "当前部署缺少此导出组件，请联系部署维护者"
        formats[format] = {"available": not failure, "reason": failure}
    return {"exporter_version": EXPORTER_VERSION, "formats": formats}


def _fingerprint(document):
    fields = {key: document[key] for key in ("document_id", "version", "title", "markdown", "evidence", "citations", "resources", "incomplete")}
    return hashlib.sha256(json.dumps(fields, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()


def _key(document_id, version, format):
    return document_id, version, format, EXPORTER_VERSION


def _response(row, context, jobs, *, verify=False):
    job, artifact = jobs.get(row["job_id"], context), None
    if job["status"] == "succeeded" and row["artifact_id"]:
        service = ArtifactService(jobs.repository)
        try:
            item = service.get(row["artifact_id"], row["artifact_version"], context)
            if verify:
                service.resolve(item["id"], item["version"], context)
            artifact = public_artifact(item)
        except (FileNotFoundError, ValueError, OSError):
            pass
    return {"document_id": row["document_id"], "document_version": row["document_version"], "format": row["format"], "exporter_version": row["exporter_version"], "job": public_job(job), "artifact": artifact}


def export_status(document_id, version, context, *, jobs):
    context.check_workspace()
    _store.get(document_id, version, context)
    with connect() as conn:
        rows = conn.execute("SELECT * FROM document_exports WHERE document_id=? AND document_version=? AND exporter_version=? ORDER BY format", (document_id, version, EXPORTER_VERSION)).fetchall()
    return [_response(dict(row), context, jobs) for row in rows]


def enqueue_export(document_id, version, format, context, *, jobs):
    context.check_workspace()
    document = _store.get(document_id, version, context)
    if format not in {"pdf", "docx"}:
        raise ValueError("只支持 DOCX 或 PDF 导出")
    capability = export_capabilities()["formats"][format]
    if not capability["available"]:
        raise ValueError(capability["reason"])
    if jobs.handlers.get(JOB_KIND) is not run_export:
        raise JobConflict("文档导出任务适配器尚未就绪")
    key, fingerprint = _key(document_id, version, format), _fingerprint(document)
    with connect() as conn:
        previous = conn.execute("SELECT * FROM document_exports WHERE document_id=? AND document_version=? AND format=? AND exporter_version=?", key).fetchone()
    previous_id = None
    if previous:
        if previous["source_hash"] != fingerprint:
            raise DocumentConflict("保存版本内容已变化，请核对文档")
        response = _response(dict(previous), context, jobs, verify=True)
        if response["artifact"] or response["job"]["status"] in {"queued", "running", "waiting_user", "interrupted"}:
            return response
        previous_id = previous["job_id"]
    request = {"document_id": document_id, "document_version": version, "format": format, "exporter_version": EXPORTER_VERSION, "source_hash": fingerprint, "previous_job_id": previous_id}
    identity = hashlib.sha256(json.dumps(request, sort_keys=True).encode()).hexdigest()
    job = jobs.repository.enqueue(JOB_KIND, request, ExtensionRunSnapshot(user_id=context.user_id).model_dump(mode="json"), context, f"document-export:{identity}")
    with connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        current = conn.execute("SELECT * FROM document_exports WHERE document_id=? AND document_version=? AND format=? AND exporter_version=?", key).fetchone()
        if current is None:
            conn.execute("INSERT INTO document_exports(document_id,document_version,format,exporter_version,source_hash,job_id) VALUES(?,?,?,?,?,?)", (*key, fingerprint, job["id"]))
        elif current["job_id"] == previous_id:
            conn.execute("UPDATE document_exports SET job_id=?,artifact_id=NULL,artifact_version=NULL WHERE document_id=? AND document_version=? AND format=? AND exporter_version=?", (job["id"], *key))
        # Do not clear a receipt published by a fast Worker.
        current = conn.execute("SELECT * FROM document_exports WHERE document_id=? AND document_version=? AND format=? AND exporter_version=?", key).fetchone()
    return _response(dict(current), context, jobs)


def validate_export_resume(job, context):
    request = job["request"]
    if request["exporter_version"] != EXPORTER_VERSION:
        raise JobConflict("原导出器版本已变化，请显式新建导出任务")
    document = _store.get(request["document_id"], request["document_version"], context)
    if _fingerprint(document) != request["source_hash"]:
        raise JobConflict("原保存版本内容已变化，不能恢复导出")
    capability = export_capabilities()["formats"][request["format"]]
    if not capability["available"]:
        raise JobConflict(capability["reason"])
    return document


async def run_export(job, control):
    request, context, jobs = job["request"], control.context, control.service
    artifacts = ArtifactService(jobs.repository)
    def fence():
        jobs.repository.check_owner(job["id"], job["owner_token"], context)
    def record(conn, artifact):
        document = _store._version(conn, request["document_id"], request["document_version"])
        if _fingerprint(document) != request["source_hash"]:
            raise JobConflict("保存版本已变化，不能发布此导出")
        key = _key(request["document_id"], request["document_version"], request["format"])
        previous = conn.execute("SELECT job_id FROM document_exports WHERE document_id=? AND document_version=? AND format=? AND exporter_version=?", key).fetchone()
        if previous and previous["job_id"] not in {job["id"], request["previous_job_id"]}:
            raise JobConflict("此导出已由另一任务接替")
        conn.execute("""INSERT INTO document_exports(document_id,document_version,format,exporter_version,source_hash,job_id,artifact_id,artifact_version)
            VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(document_id,document_version,format,exporter_version) DO UPDATE SET
            job_id=excluded.job_id,artifact_id=excluded.artifact_id,artifact_version=excluded.artifact_version""", (*key, request["source_hash"], job["id"], artifact["id"], artifact["version"]))
    def result(item):
        return {"document_id": request["document_id"], "document_version": request["document_version"], "format": request["format"], "exporter_version": EXPORTER_VERSION, "artifacts": [public_artifact(item)]}
    try:
        document = validate_export_resume(job, context)
        filename = (re.sub(r'[<>:"/\\|?*\x00-\x1f]', "-", document["title"]).strip(" .") or "文档")[:80] + f"-v{document['version']}.{request['format']}"
        for item in job.get("recovered_artifacts", []):
            if item["filename"] == filename:
                artifacts.resolve(item["id"], item["version"], context)
                with connect() as conn:
                    conn.execute("BEGIN IMMEDIATE")
                    jobs.repository.assert_owner(conn, job["id"], job["owner_token"])
                    record(conn, item)
                return result(item)
        def render():
            data = render_document(document, format=request["format"], resource_loader=lambda key: _store.resource(document["document_id"], key, context)[0].read_bytes(), fence=fence)
            for resource in document["resources"]:
                fence()
                _store.resource(document["document_id"], resource["id"], context)
            fence()
            relative = f"document-v{document['version']}.{request['format']}"
            root = current_workspace_root()
            WorkspaceFiles(root / "jobs" / job["id"], boundary=root).write(relative, data, limit=MAX_EXPORT_BYTES)
            fence()
            return artifacts.publish(job["id"], job["owner_token"], relative, filename, hashlib.sha256(data).hexdigest(), context, on_publish=record)
        return result(await asyncio.to_thread(render))
    except (DocumentNotFound, DocumentConflict, FileNotFoundError, OSError) as exc:
        raise JobExecutionError("文档或图片资源不可用，请核对保存版本后重试；原文与 Markdown/TXT 仍保留") from exc
    except JobConflict:
        raise
    except ValueError as exc:
        raise JobExecutionError(str(exc)) from exc


run_export.validate_resume = validate_export_resume


def register_export_handler(jobs):
    existing = jobs.handlers.get(JOB_KIND)
    if existing is not None and existing is not run_export:
        raise ValueError("文档导出任务适配器已经注册")
    jobs.handlers[JOB_KIND] = run_export
