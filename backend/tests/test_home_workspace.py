from __future__ import annotations

import asyncio

import pytest

from app import db
from app.domain import ModelResponse, ModelUsage
from app.jobs.service import JobService
from app.jobs.worker import JobWorker, JobWorkerManager
from app.library.document_review import register_document_review_handler
from api_client import create_authenticated_client


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
        yield client, jobs, calls


def test_workspace_returns_all_blocks_without_store(api):
    client, _, _ = api
    response = client.get("/home/workspace")
    assert response.status_code == 200, response.text
    assert response.headers["cache-control"] == "no-store"
    body = response.json()
    assert set(body) == {"generated_at", "conversations", "jobs", "weixin", "changelog", "skills", "library_recent"}
    assert body["generated_at"]
    assert set(body["conversations"]) == {"items", "error"}
    assert body["conversations"]["error"] is None
    assert all({"id", "title", "task_status"} <= set(item) for item in body["conversations"]["items"])
    assert body["jobs"] == {"running": [], "pending_confirmations": []}
    assert set(body["weixin"]) == {"connected", "unread_count", "error"}
    assert body["weixin"]["connected"] is False and body["weixin"]["unread_count"] == 0
    assert len(body["changelog"]["items"]) == 6
    assert all({"category", "text", "version"} <= set(item) for item in body["changelog"]["items"])
    # The packaged PPT skill is enabled by default, so a fresh workspace already
    # has one discoverable skill.
    assert body["skills"]["error"] is None
    assert [item["name"] for item in body["skills"]["items"]] == ["PPT Master"]
    assert body["library_recent"]["error"] is None and body["library_recent"]["items"] == []


def test_workspace_reflects_recent_conversation_and_library_source(api):
    client, _, _ = api
    client.post("/conversations", json={"title": "首页改版计划"}).raise_for_status()
    client.post("/library/sources", json={"title": "产品手册", "content": "产品定位与信息架构说明。", "enabled": False}).raise_for_status()
    body = client.get("/home/workspace").json()
    assert any(item["title"] == "首页改版计划" for item in body["conversations"]["items"])
    assert [item["title"] for item in body["library_recent"]["items"]] == ["产品手册"]
    assert body["library_recent"]["items"][0]["kind"] == "paste"


def test_workspace_splits_running_and_pending_jobs(api):
    client, jobs, calls = api
    source = client.post("/library/sources", json={"title": "待审阅资料", "content": "正文。", "enabled": False}).json()["source"]
    payload = {"target": {"source_kind": "library", "source_id": source["id"], "source_revision": source["source_revision"]}, "budget": {"calls": 1}, "idempotency_key": "workspace-review"}
    queued = client.post("/document-reviews", json=payload)
    assert queued.status_code == 201, queued.text
    job = queued.json()
    # queued 任务既不在运行中也无需确认。
    body = client.get("/home/workspace").json()
    assert body["jobs"] == {"running": [], "pending_confirmations": []}
    paused = asyncio.run(JobWorker(jobs).run_once(1))
    assert paused["status"] == "waiting_user" and len(calls) == 1
    body = client.get("/home/workspace").json()
    assert body["jobs"]["running"] == []
    assert [item["id"] for item in body["jobs"]["pending_confirmations"]] == [job["id"]]
    pending = body["jobs"]["pending_confirmations"][0]
    assert pending["kind"] == "document.review" and pending["display_title"] == "文档评审"
    assert pending["status"] == "waiting_user"


def test_single_block_failure_keeps_rest_of_workspace(api, monkeypatch):
    client, _, _ = api
    import app.api.home as home_api
    from app.extensions.skills import SkillService

    def fail_sources():
        raise RuntimeError("资料库暂不可用")

    def fail_skills(self, context, *, enabled_only=False):
        raise RuntimeError("技能目录读取失败")

    monkeypatch.setattr(home_api, "list_sources", fail_sources)
    monkeypatch.setattr(SkillService, "list", fail_skills)
    response = client.get("/home/workspace")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["library_recent"] == {"items": [], "error": "资料库暂不可用"}
    assert body["skills"] == {"items": [], "error": "技能目录读取失败"}
    assert body["changelog"]["error"] is None and len(body["changelog"]["items"]) == 6
    assert body["conversations"]["error"] is None
