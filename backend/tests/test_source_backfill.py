import asyncio

import pytest

from app.db import connect, init_db
from app.library.sources import get_source, import_file_source, update_source
from document_fixtures import pdf_bytes


def legacy_source(path, *, corrected=False):
    init_db(path)
    source = import_file_source(filename="pages.pdf", content_bytes=pdf_bytes("ORIGINAL ONE", "ORIGINAL TWO"), enabled=True, db_path=path)
    if corrected:
        update_source(source["id"], content="manually corrected", db_path=path)
    with connect(path) as conn:
        conn.execute("DELETE FROM document_source_versions")
        conn.execute("DELETE FROM document_source_state")
        conn.execute("INSERT INTO document_source_state(source_kind,source_key,backfill_status) VALUES('library',?,'pending')", (str(source["id"]),))
    return source


def test_backfill_adds_positions_without_overwriting_corrections(tmp_path):
    from app.library.source_backfill import backfill_source
    path = tmp_path / "legacy.db"
    source = legacy_source(path, corrected=True)
    backfill_source(source["id"], path)
    actual = get_source(source["id"], path)
    assert actual["content"] == "manually corrected"
    assert actual["source_revision"] and actual["backfill_status"] == "ready"


@pytest.mark.parametrize("original", ["missing", "different"])
def test_legacy_file_saved_text_is_not_presented_as_complete_extraction(tmp_path, monkeypatch, original):
    from app.library import source_backfill
    from app.library.source_versions import get_source_version
    path = tmp_path / "unverified.db"
    source = legacy_source(path)
    if original == "missing":
        monkeypatch.setattr(source_backfill, "get_source_file", lambda *a: (_ for _ in ()).throw(ValueError("missing original")))
    else:
        with connect(path) as conn:
            conn.execute("UPDATE library_sources SET content='saved partial body',redacted_content='saved partial body' WHERE id=?", (source["id"],))
    before = get_source(source["id"], path)["content"]
    result = source_backfill.backfill_source(source["id"], path)
    version = get_source_version(source["id"], result["source_revision"], path)
    assert version["text"] == before and get_source(source["id"], path)["content"] == before
    assert not result["extraction_complete"] and not version["complete"]
    assert any(item["reason"] == "original_not_verified" for item in version["unprocessed_ranges"])


def test_startup_repairs_old_saved_file_range_without_rewriting_version(tmp_path, monkeypatch):
    from app.documents.blocks import text_document
    from app.extensions.contracts import ExtensionContext
    from app.jobs.service import JobService
    from app.jobs.worker import JobWorker
    from app.library import source_backfill
    from app.library.source_versions import save_source_version, get_source_version
    from app.workspace import resolve_db_path, use_workspace
    root = tmp_path / "owner"
    with use_workspace(1, root):
        path = resolve_db_path()
        source = legacy_source(path)
        old = save_source_version(source["id"], text_document(source["content"]))["revision"]
        monkeypatch.setattr(source_backfill, "get_source_file", lambda *a: (_ for _ in ()).throw(ValueError("missing original")))
        service = JobService()
        source_backfill.register_backfill_handler(service)
        context = ExtensionContext.current()
        assert source_backfill.enqueue_pending_backfills(context, service) == 1
        result = asyncio.run(JobWorker(service).run_once(1, root))
        assert result["status"] == "succeeded" and result["result"]["extraction_complete"] is False
        assert get_source_version(source["id"], old)["complete"] is True
        assert get_source(source["id"])["source_revision"] != old
        assert source_backfill.enqueue_pending_backfills(context, service) == 0


def test_failed_backfill_preserves_legacy_index_and_can_retry(tmp_path, monkeypatch):
    from app.library import source_backfill
    path = tmp_path / "legacy.db"
    source = legacy_source(path)
    with connect(path) as conn:
        before = [tuple(r) for r in conn.execute("SELECT id,content FROM knowledge_chunks")]
    original = source_backfill.parse_document_result
    monkeypatch.setattr(source_backfill, "parse_document_result", lambda *a, **kw: (_ for _ in ()).throw(ValueError("synthetic parse failure")))
    with pytest.raises(ValueError):
        source_backfill.backfill_source(source["id"], path)
    assert get_source(source["id"], path)["backfill_status"] == "failed"
    with connect(path) as conn:
        assert [tuple(r) for r in conn.execute("SELECT id,content FROM knowledge_chunks")] == before
    monkeypatch.setattr(source_backfill, "parse_document_result", original)
    source_backfill.backfill_source(source["id"], path)
    assert get_source(source["id"], path)["backfill_status"] == "ready"


def test_backfill_does_not_activate_stale_text(tmp_path, monkeypatch):
    from app.library import source_backfill
    path = tmp_path / "legacy.db"
    source = legacy_source(path)
    original = source_backfill.parse_document_result
    def concurrent_edit(*args, **kwargs):
        parsed = original(*args, **kwargs)
        update_source(source["id"], content="new user edit", db_path=path)
        return parsed
    monkeypatch.setattr(source_backfill, "parse_document_result", concurrent_edit)
    result = source_backfill.backfill_source(source["id"], path)
    assert result["status"] == "superseded"
    assert get_source(source["id"], path)["content"] == "new user edit"


def test_index_failure_does_not_activate_the_new_version(tmp_path, monkeypatch):
    from app.library import source_backfill
    path = tmp_path / "legacy.db"
    source = legacy_source(path)
    with connect(path) as conn:
        before = [tuple(r) for r in conn.execute("SELECT id,content FROM knowledge_chunks")]
    def fail(*a, **kw):
        raise RuntimeError("synthetic index failure")
    monkeypatch.setattr(source_backfill, "_index_source", fail, raising=False)
    with pytest.raises(RuntimeError, match="synthetic index failure"):
        source_backfill.backfill_source(source["id"], path)
    current = get_source(source["id"], path)
    assert current["source_revision"] is None and current["backfill_status"] == "failed"
    with connect(path) as conn:
        assert [tuple(r) for r in conn.execute("SELECT id,content FROM knowledge_chunks")] == before


def test_registered_backfill_job_runs_in_the_owning_workspace(tmp_path):
    from app.extensions.contracts import ExtensionContext
    from app.jobs.service import JobService
    from app.jobs.worker import JobWorker
    from app.library.source_backfill import enqueue_backfill, register_backfill_handler
    from app.workspace import resolve_db_path, use_workspace
    with use_workspace(1, tmp_path / "user"):
        source = legacy_source(resolve_db_path())
        service = JobService()
        register_backfill_handler(service)
        context = ExtensionContext.current()
        job = enqueue_backfill(source["id"], context, service, "request-1")
        assert enqueue_backfill(source["id"], context, service, "request-1")["id"] == job["id"]
        result = asyncio.run(JobWorker(service).run_once(1, tmp_path / "user"))
        assert result["status"] == "succeeded"
        assert get_source(source["id"])["source_revision"]


def test_deleted_attachment_cannot_leave_version_text_behind(tmp_path):
    from app.attachments.service import AttachmentStore, create_attachment, parse_attachment, delete_attachment
    path = tmp_path / "attachment.db"
    init_db(path)
    store = AttachmentStore(local_root=tmp_path / "objects")
    attachment = create_attachment(1, "document", "two.pdf", pdf_bytes("ONE", "TWO"), db_path=path, store=store)
    parse_attachment(attachment["id"], db_path=path, store=store)
    with connect(path) as conn:
        assert conn.execute("SELECT COUNT(*) FROM document_source_versions").fetchone()[0] == 1
    delete_attachment(attachment["id"], db_path=path, store=store)
    with connect(path) as conn:
        assert conn.execute("SELECT COUNT(*) FROM document_source_versions").fetchone()[0] == 0


def test_attachment_version_checks_its_conversation(tmp_path):
    from app.attachments.service import AttachmentStore, create_attachment, parse_attachment
    from app.library.source_versions import get_attachment_version, source_state
    path = tmp_path / "attachment.db"
    init_db(path)
    store = AttachmentStore(local_root=tmp_path / "objects")
    attachment = create_attachment(1, "document", "two.pdf", pdf_bytes("ONE", "TWO"), db_path=path, store=store)
    parse_attachment(attachment["id"], db_path=path, store=store)
    revision = source_state("attachment", attachment["id"], path)["source_revision"]
    version = get_attachment_version(attachment["id"], revision, path, conversation_id=1)
    assert [b["locator"]["page"] for b in version["blocks"]] == [1, 2]
    with pytest.raises(ValueError):
        get_attachment_version(attachment["id"], revision, path, conversation_id=99)


def test_interrupted_backfill_is_reported_failed_and_explicitly_retryable(tmp_path):
    from app.extensions.contracts import ExtensionContext
    from app.jobs.service import JobService
    from app.library.source_backfill import _status, enqueue_backfill, register_backfill_handler
    from app.workspace import resolve_db_path, use_workspace
    now = [1000.0]
    with use_workspace(1, tmp_path / "owner"):
        source = legacy_source(resolve_db_path())
        service = JobService(clock=lambda: now[0])
        register_backfill_handler(service)
        context = ExtensionContext.current()
        first = enqueue_backfill(source["id"], context, service, "first")
        service.repository.claim(context)
        _status("library", source["id"], "running", job_id=first["id"])
        now[0] += 60
        service.repository.interrupt_expired(context)
        assert get_source(source["id"])["backfill_status"] == "failed"
        from app.library.sources import list_sources
        assert list_sources()[0]["backfill_status"] == "failed"
        retried = enqueue_backfill(source["id"], context, service, "retry")
        assert retried["id"] != first["id"] and retried["status"] == "queued"


def test_expired_lease_after_indexing_cannot_activate_or_replace_index(tmp_path, monkeypatch):
    from app.extensions.contracts import ExtensionContext
    from app.jobs.repository import JobConflict
    from app.jobs.service import JobService
    from app.library import source_backfill
    from app.workspace import resolve_db_path, use_workspace
    now = [1000.0]
    with use_workspace(1, tmp_path / "owner"):
        source = legacy_source(resolve_db_path())
        with connect() as conn:
            before = [tuple(r) for r in conn.execute("SELECT id,content FROM knowledge_chunks")]
        service = JobService(clock=lambda: now[0])
        source_backfill.register_backfill_handler(service)
        context = ExtensionContext.current()
        source_backfill.enqueue_backfill(source["id"], context, service, "lease")
        job = service.repository.claim(context)
        original = source_backfill._index_source
        def slow_index(*args, **kwargs):
            original(*args, **kwargs)
            now[0] += 31
        monkeypatch.setattr(source_backfill, "_index_source", slow_index)
        owner_check = lambda conn: service.repository.assert_owner(conn, job["id"], job["owner_token"])
        with pytest.raises(JobConflict):
            source_backfill.backfill_source(source["id"], owner_check=owner_check)
        assert get_source(source["id"])["source_revision"] is None
        with connect() as conn:
            assert [tuple(r) for r in conn.execute("SELECT id,content FROM knowledge_chunks")] == before


def test_fast_job_completion_cannot_be_overwritten_by_enqueue_status(tmp_path, monkeypatch):
    from app.extensions.contracts import ExtensionContext
    from app.jobs.service import JobService
    from app.jobs.worker import JobWorker
    from app.library.source_backfill import enqueue_backfill, register_backfill_handler
    from app.workspace import resolve_db_path, use_workspace
    root = tmp_path / "owner"
    with use_workspace(1, root):
        source = legacy_source(resolve_db_path())
        service = JobService()
        register_backfill_handler(service)
        context = ExtensionContext.current()
        original = service.enqueue
        def complete_before_response(*args, **kwargs):
            queued = original(*args, **kwargs)
            assert asyncio.run(JobWorker(service).run_once(1, root))["status"] == "succeeded"
            return queued
        monkeypatch.setattr(service, "enqueue", complete_before_response)
        enqueue_backfill(source["id"], context, service, "fast")
        assert get_source(source["id"])["backfill_status"] == "ready"
