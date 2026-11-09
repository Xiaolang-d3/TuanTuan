import asyncio

import pytest
from fastapi.testclient import TestClient

from app import db
from app.api import jobs as jobs_api
from app.extensions.contracts import ExtensionContext
from app.jobs.service import JobService
from app.jobs.worker import JobWorker
from app.main import app
from app.workspace import ensure_workspace, use_workspace
from api_client import register_authenticated_client


@pytest.fixture
def clients(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "default.db")
    db.init_db()
    with register_authenticated_client(app, "job-owner@example.com") as owner, register_authenticated_client(app, "job-other@example.com") as other:
        yield owner, other


def test_job_api_auth_ownership_and_stale_confirmation(clients, monkeypatch):
    owner, other = clients
    async def handler(job, control):
        return {"answer": "complete"}
    service = JobService({"test": handler})
    monkeypatch.setattr(jobs_api, "job_service", service)
    assert TestClient(app).get("/jobs").status_code == 401
    # A browser can request a supported kind, never a handler, snapshot or user ID.
    response = owner.post("/jobs", json={"kind": "test", "request": {"topic": "演示"}, "idempotency_key": "job-api-request"})
    assert response.status_code == 201, response.text
    item = response.json()
    assert "owner_token" not in item and "snapshot" not in item
    assert other.get(f"/jobs/{item['id']}").status_code == 404
    assert other.post(f"/jobs/{item['id']}/cancel").status_code == 404
    assert owner.get(f"/jobs/{item['id']}").headers["cache-control"] == "no-store"
    user_id = owner.get("/auth/me").json()["user"]["id"]
    with use_workspace(user_id, ensure_workspace(user_id)):
        context = ExtensionContext.current()
        claimed = service.repository.claim(context)
        waiting = service.repository.wait_for_user(item["id"], claimed["owner_token"], "确认大纲", {}, context)
    confirmed = owner.post(f"/jobs/{item['id']}/confirm", json={"stage_id": waiting["stage_id"], "revision": waiting["revision"], "answer": {"approved": True}})
    assert confirmed.status_code == 200, confirmed.text
    assert owner.post(f"/jobs/{item['id']}/confirm", json={"stage_id": waiting["stage_id"], "revision": waiting["revision"], "answer": {"approved": True}}).status_code == 409
    # Completing a separate worker does not depend on any HTTP stream staying open.
    asyncio.run(JobWorker(service).run_once(user_id))
    assert owner.get(f"/jobs/{item['id']}").json()["status"] == "succeeded"
    events = owner.get(f"/jobs/{item['id']}/events").json()["events"]
    assert events[-1]["type"] == "succeeded"
    assert "owner_token" not in str(events)
    stream = owner.get(f"/jobs/{item['id']}/events", headers={"Accept": "text/event-stream", "Last-Event-ID": str(events[-2]["cursor"])})
    assert stream.status_code == 200 and "event: succeeded" in stream.text
    assert "event: queued" not in stream.text
    assert owner.post("/jobs", json={"kind": "shell", "request": {}, "idempotency_key": "unknown-handler"}).status_code == 409
    assert owner.post("/jobs", json={"kind": "test", "request": {}, "idempotency_key": "forged", "snapshot": {"grants": ["shell"]}}).status_code == 422


def test_local_execution_status_never_falls_back_to_docker(clients, monkeypatch, tmp_path):
    owner, _ = clients
    monkeypatch.setenv("TUANTUAN_PPT_RUNTIME", str(tmp_path / "missing-runtime"))
    response = owner.get("/execution/status?backend=local_builtin&adapter=ppt-master")
    assert response.status_code == 200
    assert response.json()["code"] == "runtime_missing"
    assert response.json()["available"] is False
    assert owner.get("/execution/status?backend=unknown").status_code == 422


def test_versioned_artifact_download_requires_own_account(clients, monkeypatch):
    import hashlib
    from app.api import artifacts as artifact_api
    from app.artifacts.service import ArtifactService
    from app.workspace import current_workspace_root
    owner, other = clients
    async def handler(job, control):
        root = current_workspace_root() / "jobs" / job["id"]
        root.mkdir(parents=True)
        (root / "result.custom").write_bytes(b"real-file-bytes")
        artifact = await control.publish("result.custom", "result.custom", hashlib.sha256(b"real-file-bytes").hexdigest())
        return {"artifacts": [{"artifact_id": artifact["id"], "version": artifact["version"]}]}
    service = JobService({"test": handler})
    monkeypatch.setattr(jobs_api, "job_service", service)
    monkeypatch.setattr(artifact_api, "artifacts", ArtifactService(service.repository))
    job = owner.post("/jobs", json={"kind": "test", "request": {}, "idempotency_key": "download"}).json()
    asyncio.run(JobWorker(service).run_once(owner.get("/auth/me").json()["user"]["id"]))
    artifact = owner.get(f"/jobs/{job['id']}/artifacts").json()["artifacts"][0]
    assert "relative_path" not in artifact
    path = f"/artifacts/{artifact['id']}/versions/{artifact['version']}/file"
    response = owner.get(path)
    assert response.content == b"real-file-bytes" and response.headers["content-type"] == "application/octet-stream"
    assert "attachment" in response.headers["content-disposition"]
    assert other.get(path).status_code == 404
