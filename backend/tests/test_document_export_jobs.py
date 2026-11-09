"""Exports use real Worker leases and never publish in an API request."""
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import asyncio
import pytest

from app import db
from app.artifacts.document_export import enqueue_export, export_status, register_export_handler
from app.artifacts.service import ArtifactService
from app.jobs.repository import JobConflict
from app.jobs.service import JobService
from app.jobs.worker import JobWorker
from app.workspace import use_workspace
from test_document_artifacts import document


def setup_export(document):
    doc = document["store"].create(**document["request"])
    jobs = JobService()
    register_export_handler(jobs)
    return doc, jobs, document["context"]


def test_real_worker_publishes_exact_saved_version_and_reuses_valid_cache(document):
    doc, jobs, context = setup_export(document)
    queued = enqueue_export(doc["document_id"], 1, "pdf", context, jobs=jobs)
    assert queued["job"]["status"] == "queued" and queued["artifact"] is None
    assert "owner_token" not in queued["job"] and "snapshot" not in queued["job"]
    document["store"].save(doc["document_id"], base_version=1, markdown=doc["markdown"] + "\n\n只有第二版才有这段。", idempotency_key="new-head", context=context)
    assert ArtifactService(jobs.repository).list_for_job(queued["job"]["id"], context) == []
    finished = asyncio.run(JobWorker(jobs).run_once(1, document["root"]))
    assert finished["status"] == "succeeded", finished
    assert finished["result"]["document_version"] == 1
    cached = enqueue_export(doc["document_id"], 1, "pdf", context, jobs=jobs)
    assert cached["job"]["id"] == queued["job"]["id"]
    assert cached["artifact"]["media_type"] == "application/pdf"
    from pypdf import PdfReader
    path = ArtifactService(jobs.repository).resolve(cached["artifact"]["id"], cached["artifact"]["version"], context)
    assert "只有第二版" not in "".join(page.extract_text() for page in PdfReader(path).pages)
    assert export_status(doc["document_id"], 1, context, jobs=jobs)[0]["artifact"]["id"] == cached["artifact"]["id"]


def test_simultaneous_creates_share_one_real_job_and_generic_enqueue_is_rejected(document):
    doc, jobs, context = setup_export(document)
    barrier = Barrier(4)
    def create(_):
        with use_workspace(1, document["root"]):
            barrier.wait()
            return enqueue_export(doc["document_id"], 1, "pdf", context, jobs=jobs)["job"]["id"]
    with ThreadPoolExecutor(max_workers=4) as pool:
        ids = list(pool.map(create, range(4)))
    assert len(set(ids)) == 1
    with pytest.raises(JobConflict, match="专用"):
        jobs.enqueue("document.export", {}, context, "bypass-export-entry")


def test_missing_resource_fails_job_and_preserves_source_document(document):
    doc, jobs, context = setup_export(document)
    queued = enqueue_export(doc["document_id"], 1, "docx", context, jobs=jobs)
    path = document["store"].resource(doc["document_id"], doc["resources"][0]["id"], context)[0]
    path.unlink()
    finished = asyncio.run(JobWorker(jobs).run_once(1, document["root"]))
    assert finished["status"] == "failed" and "资源" in finished["error"]
    assert ArtifactService(jobs.repository).list_for_job(queued["job"]["id"], context) == []
    assert document["store"].get(doc["document_id"], 1, context)["markdown"] == doc["markdown"]


def test_cancel_after_render_never_publishes_or_caches_artifact(document, monkeypatch):
    import app.artifacts.document_export as exporter
    doc, jobs, context = setup_export(document)
    queued = enqueue_export(doc["document_id"], 1, "pdf", context, jobs=jobs)
    render = exporter.render_document
    def cancel_before_publish(*args, **kwargs):
        result = render(*args, **kwargs)
        jobs.cancel(queued["job"]["id"], context)
        return result
    monkeypatch.setattr(exporter, "render_document", cancel_before_publish)
    finished = asyncio.run(JobWorker(jobs, heartbeat_seconds=60).run_once(1, document["root"]))
    assert finished["status"] == "cancelled", finished
    assert ArtifactService(jobs.repository).list_for_job(finished["id"], context) == []
    assert export_status(doc["document_id"], 1, context, jobs=jobs)[0]["artifact"] is None


def test_expired_worker_resumes_same_version_and_old_token_cannot_publish(document):
    doc, jobs, context = setup_export(document)
    clock = [100.0]
    jobs.repository.clock = lambda: clock[0]
    queued = enqueue_export(doc["document_id"], 1, "pdf", context, jobs=jobs)
    stale = jobs.repository.claim(context)
    clock[0] = 200.0
    jobs.repository.interrupt_expired(context)
    assert jobs.get(stale["id"], context)["status"] == "interrupted"
    jobs.resume(stale["id"], context)
    finished = asyncio.run(JobWorker(jobs).run_once(1, document["root"]))
    assert finished["status"] == "succeeded" and finished["id"] == queued["job"]["id"]
    with db.connect() as conn, pytest.raises(JobConflict):
        jobs.repository.assert_owner(conn, stale["id"], stale["owner_token"])


def test_missing_cached_artifact_requires_fresh_job_and_docx_mime_is_correct(document):
    doc, jobs, context = setup_export(document)
    first = enqueue_export(doc["document_id"], 1, "docx", context, jobs=jobs)
    finished = asyncio.run(JobWorker(jobs).run_once(1, document["root"]))
    assert finished["status"] == "succeeded", finished
    cached = enqueue_export(doc["document_id"], 1, "docx", context, jobs=jobs)
    assert cached["artifact"]["media_type"] == "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    ArtifactService(jobs.repository).resolve(cached["artifact"]["id"], cached["artifact"]["version"], context).unlink()
    retry = enqueue_export(doc["document_id"], 1, "docx", context, jobs=jobs)
    assert retry["job"]["id"] != first["job"]["id"] and retry["artifact"] is None


def test_resume_cannot_switch_exporter_version_or_saved_body(document, monkeypatch):
    import app.artifacts.document_export as exporter
    doc, jobs, context = setup_export(document)
    queued = enqueue_export(doc["document_id"], 1, "pdf", context, jobs=jobs)
    jobs.repository.claim(context)
    with db.connect() as conn:
        conn.execute("UPDATE background_jobs SET lease_expires=0 WHERE id=?", (queued["job"]["id"],))
    jobs.repository.interrupt_expired(context)
    monkeypatch.setattr(exporter, "EXPORTER_VERSION", "changed-renderer")
    with pytest.raises(JobConflict, match="版本"):
        jobs.resume(queued["job"]["id"], context)
