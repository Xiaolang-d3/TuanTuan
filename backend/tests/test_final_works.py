import hashlib
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier
from urllib.parse import unquote

import pytest
from fastapi.testclient import TestClient

from api_client import create_authenticated_client, register_authenticated_client
from app import db
from app.artifacts import final_works
from app.artifacts.service import ArtifactService
from app.chat.artifacts import message_artifacts
from app.chat.service import save_chat_message
from app.extensions.contracts import ExtensionContext
from app.jobs.repository import JobRepository
from app.jobs.worker import JobWorkerManager
from app.workspace import current_workspace_root, use_workspace

BASE = "/works/final"
PUBLIC_KEYS = {"id", "kind", "filename", "created_at", "media_type", "size"}


@pytest.fixture
def api(tmp_path, monkeypatch):
    from app.main import app

    monkeypatch.setattr(db, "DB_PATH", tmp_path / "accounts.db")
    monkeypatch.setattr(JobWorkerManager, "start", lambda self: None)
    with create_authenticated_client(app) as client:
        yield client, app


def create_document(client, markdown, key="doc", *, status="done"):
    with use_workspace(1):
        message = save_chat_message("assistant", markdown, payload={"agent": {"status": status}}, conversation_id=1)
        payload = {"message_id": message["id"], "snapshot": message_artifacts(message["id"])["snapshot"],
                   "idempotency_key": key}
    response = client.post("/conversations/1/documents", json=payload)
    assert response.status_code == 201, response.text
    return response.json()["document_id"]


def publish_presentation(kind="ppt.generate", *, finish=True, content=None):
    # Use real publication receipts and job completion without running any worker.
    content = content if content is not None else b"deck" * (final_works.CHUNK_BYTES // 2)
    with use_workspace(1):
        context = ExtensionContext.current()
        jobs = JobRepository(clock=lambda: 1000)
        job = jobs.enqueue(kind, {}, {}, context, kind)
        claim = jobs.claim(context)
        assert claim["id"] == job["id"]
        source = current_workspace_root() / "jobs" / job["id"]
        source.mkdir(parents=True)
        service = ArtifactService(jobs)

        def publish(name, data):
            (source / name).write_bytes(data)
            row = service.publish(job["id"], claim["owner_token"], name, name, hashlib.sha256(data).hexdigest(), context)
            return {key: row[key] for key in ("id", "version", "filename")}

        old = publish("演示文稿.pptx", b"superseded")
        deck = publish("演示文稿.pptx", content)
        preview = publish("preview.png", b"preview")
        if finish:
            jobs.finish(job["id"], claim["owner_token"], {"artifacts": [deck, preview]}, context)
        stored = service.resolve(deck["id"], deck["version"], context)
    return job["id"], old, deck, preview, stored, content


def archive_url(kind, source_id, version):
    return f"{BASE}/{kind}/{source_id}/versions/{version}"


def artifact_url(item):
    return archive_url("artifacts", item["id"], item["version"])


def assert_download(client, item, content):
    assert set(item) == PUBLIC_KEYS
    assert item["size"] == len(content)
    response = client.get(f"{BASE}/{item['id']}/file")
    assert response.status_code == 200, response.text
    assert response.content == content
    assert response.headers["cache-control"] == "no-store"
    assert response.headers["x-content-type-options"] == "nosniff"
    assert response.headers["content-type"] == item["media_type"]
    assert unquote(response.headers["content-disposition"]) == f"attachment; filename*=UTF-8''{item['filename']}"


def test_exact_saved_markdown_is_independent_private_and_idempotent(api):
    client, app = api
    anon = TestClient(app).get(BASE)
    assert anon.status_code == 401 and anon.headers["cache-control"] == "no-store"
    assert client.get(BASE).json() == {"items": []}
    markdown = "# 标题\r\n\r\n中文与表情 🎈  \r\n"
    document_id = create_document(client, markdown)
    updated = client.post(f"/documents/{document_id}/versions", json={
        "base_version": 1, "markdown": "# 新的草稿\n", "idempotency_key": "save-second"})
    assert updated.status_code == 201, updated.text
    url = archive_url("documents", document_id, 1)
    archive = client.post(url)
    assert archive.status_code == 200, archive.text
    assert archive.headers["cache-control"] == "no-store"
    item = archive.json()
    assert item["kind"] == "document" and item["filename"] == "标题.md"
    assert item["media_type"] == final_works.MARKDOWN
    assert_download(client, item, markdown.encode("utf-8"))

    listing = client.get(BASE)
    assert listing.json() == {"items": [item]}
    assert listing.headers["cache-control"] == "no-store"
    assert client.post(archive_url("documents", document_id, 99)).status_code == 404
    invalid = client.post(archive_url("documents", document_id, 2**63))
    assert invalid.status_code == 422 and invalid.headers["cache-control"] == "no-store"
    other = register_authenticated_client(app, email="other-final-work@example.test")
    assert other.get(BASE).json() == {"items": []}
    assert other.get(f"{BASE}/{item['id']}/file").status_code == 404
    assert other.post(url).status_code == 404
    assert client.delete(f"/documents/{document_id}").status_code == 200
    assert client.post(url).json() == item
    assert_download(client, item, markdown.encode("utf-8"))
    with use_workspace(1), db.connect() as conn:
        for table in ("background_jobs", "library_sources"):
            assert conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0


def test_document_from_incomplete_answer_cannot_be_finalized(api):
    client, _ = api
    document_id = create_document(client, "# 部分回答", status="failed")
    assert client.get(f"/documents/{document_id}").json()["incomplete"] is True
    response = client.post(archive_url("documents", document_id, 1))
    assert response.status_code == 409 and response.headers["cache-control"] == "no-store"
    assert client.get(BASE).json() == {"items": []}


@pytest.mark.parametrize("kind", ["ppt.generate", "ppt.quick_generate"])
def test_only_delivered_pptx_version_is_copied_and_survives_source_deletion(api, kind):
    client, app = api
    job_id, old, deck, preview, stored, content = publish_presentation(kind)
    assert client.post(artifact_url(old)).status_code == 409
    assert client.post(artifact_url(preview)).status_code == 409
    other = register_authenticated_client(app, email="other-final-ppt@example.test")
    assert other.post(artifact_url(deck)).status_code == 404
    response = client.post(artifact_url(deck))
    assert response.status_code == 200, response.text
    item = response.json()
    assert item["kind"] == "presentation" and item["filename"] == deck["filename"]
    assert item["media_type"] == final_works.PPTX
    stored.unlink()
    with use_workspace(1), db.connect() as conn:
        conn.execute("DELETE FROM file_artifacts WHERE job_id=?", (job_id,))
        conn.execute("DELETE FROM background_job_events WHERE job_id=?", (job_id,))
        conn.execute("DELETE FROM background_jobs WHERE id=?", (job_id,))
    assert client.post(artifact_url(deck)).json() == item
    assert_download(client, item, content)


@pytest.mark.parametrize(("kind", "finish"), [("ppt.generate", False), ("document.export", True)])
def test_other_job_kinds_and_non_succeeded_jobs_are_rejected(api, kind, finish):
    client, _ = api
    _, _, deck, _, _, _ = publish_presentation(kind, finish=finish)
    assert client.post(artifact_url(deck)).status_code == 409
    assert client.get(BASE).json() == {"items": []}


def test_size_and_integrity_failures_leave_no_archive(api, monkeypatch):
    client, _ = api
    _, _, deck, _, stored, content = publish_presentation()
    url = artifact_url(deck)
    with monkeypatch.context() as limits:
        limits.setattr(final_works, "MAX_ARTIFACT_BYTES", len(content) - 1)
        assert client.post(url).status_code == 413
    stored.write_bytes(content + b"extra")
    assert client.post(url).status_code == 409
    stored.write_bytes(b"X" + content[1:])
    assert client.post(url).status_code == 409
    assert client.get(BASE).json() == {"items": []}
    stored.write_bytes(content)
    assert client.post(url).status_code == 200


def test_concurrent_retries_and_quota_share_one_transaction(api, monkeypatch):
    client, _ = api
    document_id = create_document(client, "abcd")
    another_id = create_document(client, "efgh", "second")
    monkeypatch.setattr(final_works, "MAX_TOTAL_BYTES", 4)
    ready = Barrier(2)

    def archive(source_id):
        with use_workspace(1):
            ready.wait(timeout=5)
            try:
                return final_works.archive_document(source_id, 1, ExtensionContext.current())
            except final_works.FinalWorksFull:
                return None

    with ThreadPoolExecutor(max_workers=2) as pool:
        first, second = pool.map(archive, (document_id, document_id))
    assert first == second and first is not None
    assert client.post(archive_url("documents", another_id, 1)).status_code == 507
    assert client.get(BASE).json() == {"items": [first]}

    # With the remaining quota freed for this scenario, distinct requests
    # cannot both claim the same four bytes even when submitted concurrently.
    with use_workspace(1), db.connect() as conn:
        conn.execute("DELETE FROM final_works")
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(archive, (document_id, another_id)))
    assert results.count(None) == 1
    assert client.get(BASE).json() == {"items": [row for row in results if row is not None]}


def test_list_is_bounded_and_count_limit_rejects_new_snapshots(api, monkeypatch):
    client, _ = api
    document_id = create_document(client, "abc")
    for version in (1, 2):
        response = client.post(f"/documents/{document_id}/versions", json={
            "base_version": version, "markdown": str(version + 1), "idempotency_key": f"save-{version}"})
        assert response.status_code == 201
    monkeypatch.setattr(final_works, "MAX_WORKS", 2)
    first, second = (client.post(archive_url("documents", document_id, version)).json() for version in (1, 2))
    assert first["id"] != second["id"]
    assert client.post(archive_url("documents", document_id, 3)).status_code == 507
    assert client.get(BASE).json() == {"items": [second, first]}
    assert_download(client, first, b"abc")
    assert_download(client, second, b"2")


def test_v46_upgrade_keeps_existing_content_and_adds_an_empty_archive(tmp_path):
    path = tmp_path / "tuantuan.db"
    db.init_db(path)
    with db.connect(path) as conn:
        conn.execute("DROP TABLE final_works")
        conn.execute("UPDATE schema_migrations SET version=46,name='conversation_memory_cursors'")
        conn.execute("INSERT INTO conversations(title) VALUES ('before final works')")
    db.init_db(path)
    with db.connect(path) as conn:
        assert conn.execute("SELECT title FROM conversations WHERE title='before final works'").fetchone()
        assert conn.execute("SELECT COUNT(*) FROM final_works").fetchone()[0] == 0
        assert conn.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0] == db.DB_SCHEMA_VERSION
