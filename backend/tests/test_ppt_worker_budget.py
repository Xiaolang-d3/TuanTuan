import asyncio

import pytest

from app import db
from app.extensions.contracts import ExtensionContext
from app.extensions.runtime_snapshot import ExtensionRunSnapshot
from app.jobs.service import JobService
from app.jobs.worker import JobWorker
from app.presentations.model_ledger import ModelCallLedger
from app.workspace import use_workspace


@pytest.fixture
def scope(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "accounts.db")
    with use_workspace(1):
        db.init_db()
        yield ExtensionContext.current()


def snapshot(context):
    return ExtensionRunSnapshot(
        version=2, user_id=context.user_id, grants=("builtin.ppt-master.execute",),
        model_selection={"profile_id": "p", "profile_revision": 1, "connection_id": "c", "connection_revision": 1},
        execution={"backend": "local_builtin", "adapter": "ppt-master", "runtime_digest": "a" * 64,
                   "upstream_commit": "492a52b2b845927b0924b6eaaa495fc0dfc8f646"},
    ).model_dump(mode="json")


@pytest.mark.parametrize("outcome", ["pause", "success", "failure"])
def test_worker_accounts_activity_and_excludes_user_wait(scope, outcome):
    now = [1000.0]

    async def handler(job, control):
        with db.connect() as conn:
            row = conn.execute("SELECT active_attempt FROM presentation_job_budgets WHERE job_id=?", (job["id"],)).fetchone()
            assert row is not None and row[0] == job["owner_token"]
        now[0] += 7
        if outcome == "pause":
            await control.wait_for_user("请完成官方阶段确认")
        if outcome == "failure":
            raise ValueError("test stage failure")
        return {"done": True}

    service = JobService({"ppt.generate": handler}, clock=lambda: now[0])
    job = service.repository.enqueue("ppt.generate", {}, snapshot(scope), scope, outcome)
    asyncio.run(JobWorker(service).run_once(1))
    expected = {"pause": "waiting_user", "success": "succeeded", "failure": "failed"}[outcome]
    assert service.get(job["id"], scope)["status"] == expected
    now[0] += 500
    ledger = ModelCallLedger(service.repository, clock=lambda: now[0])
    assert ledger.status(job["id"], scope)["active_seconds"] == 7
    with db.connect() as conn:
        assert conn.execute("SELECT active_started FROM presentation_job_budgets WHERE job_id=?", (job["id"],)).fetchone()[0] is None


def test_ppt_validation_failure_keeps_actionable_reason_and_safe_code(scope):
    from app.presentations.production import validate_design_plan
    from app.presentations.service import public_presentation
    from types import SimpleNamespace

    async def handler(job, control):
        validate_design_plan({"clarification_required": True, "question": "请说明主题"}, SimpleNamespace(min_pages=8, max_pages=8))

    service = JobService({"ppt.generate": handler})
    job = service.repository.enqueue("ppt.generate", {"topic": "面向初学者制作知识分享"}, snapshot(scope), scope, "needs-topic")
    asyncio.run(JobWorker(service).run_once(1))
    failed = service.get(job["id"], scope)
    assert failed["status"] == "failed"
    public = public_presentation(failed)
    assert public["error_code"] == "presentation_needs_details"
    assert "主题" in public["error"] and "ValueError" not in public["error"]


@pytest.mark.parametrize("pause", [False, True])
def test_budget_exhausted_between_heartbeats_cannot_finish_or_pause(scope, pause):
    now = [1000.0]

    async def handler(job, control):
        with db.connect() as conn:
            conn.execute("UPDATE presentation_job_budgets SET active_seconds=1795 WHERE job_id=?", (job["id"],))
        now[0] += 7
        if pause:
            await control.wait_for_user("不得跳过预算检查")
        return {"must_not_finish": True}

    service = JobService({"ppt.generate": handler}, clock=lambda: now[0])
    job = service.repository.enqueue("ppt.generate", {}, snapshot(scope), scope, "final-budget")
    asyncio.run(JobWorker(service).run_once(1))
    assert service.get(job["id"], scope)["status"] == "failed"
    assert ModelCallLedger(service.repository, clock=lambda: now[0]).status(job["id"], scope)["active_seconds"] == 1802


def test_process_shutdown_time_is_included_before_success(scope):
    now = [1000.0]

    class Execution:
        async def stop(self):
            now[0] += 7

    async def handler(job, control):
        control.attach_execution(Execution())
        with db.connect() as conn:
            conn.execute("UPDATE presentation_job_budgets SET active_seconds=1795 WHERE job_id=?", (job["id"],))
        return {"must_not_finish": True}

    service = JobService({"ppt.generate": handler}, clock=lambda: now[0])
    job = service.repository.enqueue("ppt.generate", {}, snapshot(scope), scope, "shutdown-budget")
    asyncio.run(JobWorker(service).run_once(1))
    assert service.get(job["id"], scope)["status"] == "failed"


def test_worker_refreshes_activity_with_lease_and_stops_at_limit(scope, monkeypatch):
    now = [1000.0]

    async def handler(job, control):
        await asyncio.Event().wait()

    service = JobService({"ppt.generate": handler}, clock=lambda: now[0])
    heartbeat = service.repository.heartbeat

    def advance_heartbeat(*args):
        now[0] += 29
        return heartbeat(*args)

    monkeypatch.setattr(service.repository, "heartbeat", advance_heartbeat)
    job = service.repository.enqueue("ppt.generate", {}, snapshot(scope), scope, "limit")
    asyncio.run(asyncio.wait_for(JobWorker(service, heartbeat_seconds=0).run_once(1), 5))
    assert service.get(job["id"], scope)["status"] == "interrupted"
    ledger = ModelCallLedger(service.repository, clock=lambda: now[0])
    assert ledger.status(job["id"], scope)["active_seconds"] >= 1800
