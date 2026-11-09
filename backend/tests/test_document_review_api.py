import asyncio

import pytest

from app import db
from app.jobs.service import JobService
from app.jobs.worker import JobWorker, JobWorkerManager
from app.library.document_review import register_document_review_handler
from app.domain import ModelResponse, ModelUsage
from app.workspace import use_workspace
from api_client import create_authenticated_client, register_authenticated_client


@pytest.fixture
def api(tmp_path, monkeypatch):
    from app.main import app
    from app.api import jobs as job_api, library
    from app.jobs import service
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "accounts.db")
    db.init_db()
    calls = []
    class Provider:
        async def generate(self, request):
            calls.append(request)
            return ModelResponse(provider="fake", content='{"summary":"已处理给定批次。","citations":[]}', usage=ModelUsage(input_tokens=5, output_tokens=5))
    connection = {"profile_id": "p", "profile_revision": 1, "connection_id": "c", "connection_revision": 1,
                  "model_name": "fake", "model_protocol": "openai", "resolved_model_protocol": "openai",
                  "secret_ref": "private-reference", "credential_fingerprint": "private-fingerprint", "api_key": "fake-key-never-publish"}
    jobs = JobService()
    register_document_review_handler(jobs, provider_factory=lambda _: Provider(), connection_resolver=lambda *a, **kw: connection)
    monkeypatch.setattr(service, "job_service", jobs)
    monkeypatch.setattr(job_api, "job_service", jobs)
    monkeypatch.setattr(library, "job_service", jobs, raising=False)
    monkeypatch.setattr(JobWorkerManager, "start", lambda self: None)
    with create_authenticated_client(app) as client:
        yield client, app, jobs, calls


def create_input(client):
    source = client.post("/library/sources", json={"title": "用户选择的资料", "content": "正文。", "enabled": False}).json()["source"]
    return {"target": {"source_kind": "library", "source_id": source["id"], "source_revision": source["source_revision"]}, "budget": {"calls": 1}, "idempotency_key": "create-review-once"}


def test_creation_refresh_and_repeated_confirmation_do_not_duplicate_work(api):
    client, _, jobs, calls = api
    payload = create_input(client)
    response = client.post("/document-reviews", json=payload)
    assert response.status_code == 201, response.text
    job = response.json()
    assert job["kind"] == "document.review" and "owner_token" not in job and "snapshot" not in job
    assert client.post("/document-reviews", json=payload).json()["id"] == job["id"]
    assert len(client.get("/document-reviews").json()["jobs"]) == 1
    assert client.get(f"/document-reviews/{job['id']}").json()["id"] == job["id"]
    assert not calls
    paused = asyncio.run(JobWorker(jobs).run_once(1))
    assert paused["status"] == "waiting_user" and len(calls) == 1
    confirmation = {"stage_id": paused["stage_id"], "revision": paused["revision"], "answer": {"budget": {"calls": 2, "input_tokens": 10000, "output_tokens": 5000, "active_seconds": 60}, "idempotency_key": "additional-once"}}
    for _ in range(2):
        response = client.post(f"/jobs/{job['id']}/confirm", json=confirmation)
        assert response.status_code == 200, response.text
        assert response.json()["model_budget"]["calls_limit"] == 3
    assert len(calls) == 1
    assert asyncio.run(JobWorker(jobs).run_once(1))["status"] == "succeeded"
    final = client.get(f"/document-reviews/{job['id']}")
    assert final.json()["result"]["coverage"]["status"] == "complete"
    assert final.headers["cache-control"] == "no-store"
    assert all(value not in final.text for value in ("private-reference", "private-fingerprint", "fake-key-never-publish"))


def test_creation_is_account_scoped_and_cannot_use_generic_enqueue(api):
    client, app, _, calls = api
    payload = create_input(client)
    job = client.post("/document-reviews", json=payload)
    assert job.status_code == 201
    assert client.post("/jobs", json={"kind": "document.review", "request": payload, "idempotency_key": "bypass"}).status_code == 409
    with register_authenticated_client(app, email="other-review@example.test") as other:
        assert other.get(f"/document-reviews/{job.json()['id']}").status_code == 404
        assert other.get("/document-reviews").json()["jobs"] == []
        assert other.post("/document-reviews", json={**payload, "idempotency_key": "foreign"}).status_code in {403, 404, 422}
    assert not calls


def test_attachment_preparation_exposes_version_handle_and_enforces_conversation(api):
    client, _, _, calls = api
    conversation_id = client.post("/conversations", json={"title": "附件审阅"}).json()["id"]
    uploaded = client.post("/attachments", data={"conversation_id": conversation_id, "kind": "document"}, files={"file": ("selected.txt", b"selected document body", "text/plain")})
    assert uploaded.status_code == 200
    attachment_id = uploaded.json()["id"]
    parsed = client.post(f"/attachments/{attachment_id}/parse")
    assert parsed.status_code == 200 and "object_key" not in parsed.json()
    revision = parsed.json()["source_revision"]
    assert len(revision) == 64
    assert client.get(f"/attachments/{attachment_id}").json()["source_revision"] == revision
    payload = {"target": {"source_kind": "attachment", "attachment_id": attachment_id, "source_revision": revision}, "conversation_id": conversation_id, "idempotency_key": "attachment-review"}
    assert client.post("/document-reviews", json={**payload, "conversation_id": conversation_id + 100}).status_code in {403, 404, 409, 422}
    assert client.post("/document-reviews", json=payload).status_code == 201
    assert not calls


def test_library_review_cannot_bind_a_missing_conversation(api):
    client, _, _, _ = api
    payload = create_input(client)
    response = client.post("/document-reviews", json={**payload, "conversation_id": 999999})
    assert response.status_code in {404, 422}


def test_status_polling_does_not_load_source_body_or_immutable_block_json(api, monkeypatch):
    client, _, _, _ = api
    payload = create_input(client)
    job = client.post("/document-reviews", json=payload).json()
    queries = []
    original = db.sqlite3.connect
    def traced(*args, **kwargs):
        conn = original(*args, **kwargs)
        conn.set_trace_callback(queries.append)
        return conn
    monkeypatch.setattr(db.sqlite3, "connect", traced)
    assert client.get(f"/document-reviews/{job['id']}").status_code == 200
    assert not [sql for sql in queries if "FROM document_source_versions" in sql or "SELECT * FROM library_sources" in sql]
