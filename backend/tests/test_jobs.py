import asyncio

import pytest

from app import db
from app.extensions.contracts import ExtensionContext
from app.jobs.repository import JobConflict, JobNotFound, JobRepository
from app.jobs.service import JobService
from app.jobs.worker import JobWorker
from app.workspace import current_user_id, use_workspace


@pytest.fixture
def scope(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "default.db")
    with use_workspace(1):
        db.init_db()
        yield ExtensionContext.current()


def service(handler=None, clock=lambda: 1000.0):
    async def default(job, control):
        return {"answer": "done"}
    return JobService({"test": handler or default}, clock=clock)


def test_enqueue_is_idempotent_and_claim_is_exclusive(scope):
    jobs = service()
    first = jobs.enqueue("test", {"topic": "主题"}, scope, "same-request")
    assert jobs.enqueue("test", {"topic": "主题"}, scope, "same-request")["id"] == first["id"]
    with pytest.raises(JobConflict):
        jobs.enqueue("test", {"topic": "另一个"}, scope, "same-request")
    repo = jobs.repository
    claim = repo.claim(scope)
    assert claim["id"] == first["id"] and claim["owner_token"]
    assert repo.claim(scope) is None
    with pytest.raises(JobConflict):
        repo.finish(first["id"], "wrong-token", {"bad": True}, scope)


def test_confirmation_requires_current_stage_and_revision(scope):
    jobs = service()
    item = jobs.enqueue("test", {}, scope, "confirm")
    claimed = jobs.repository.claim(scope)
    waiting = jobs.repository.wait_for_user(item["id"], claimed["owner_token"], "确认大纲", {"type": "object"}, scope)
    with pytest.raises(JobConflict):
        jobs.confirm(item["id"], "wrong-stage", waiting["revision"], {"approved": True}, scope)
    confirmed = jobs.confirm(item["id"], waiting["stage_id"], waiting["revision"], {"approved": True}, scope)
    assert confirmed["status"] == "queued" and confirmed["confirmation"]["answer"]["approved"] is True
    with pytest.raises(JobConflict):
        jobs.confirm(item["id"], waiting["stage_id"], waiting["revision"], {"approved": True}, scope)


def test_expired_lease_interrupts_without_auto_retry_and_old_worker_cannot_finish(scope):
    now = [1000.0]
    jobs = service(clock=lambda: now[0])
    item = jobs.enqueue("test", {}, scope, "lease")
    claimed = jobs.repository.claim(scope)
    now[0] += 60
    jobs.repository.interrupt_expired(scope)
    assert jobs.get(item["id"], scope)["status"] == "interrupted"
    assert jobs.repository.claim(scope) is None
    with pytest.raises(JobConflict):
        jobs.repository.finish(item["id"], claimed["owner_token"], {}, scope)
    jobs.resume(item["id"], scope)
    assert jobs.get(item["id"], scope)["status"] == "queued"


def test_worker_restores_each_users_workspace_and_events_are_replayable(scope):
    seen = []
    async def handler(job, control):
        seen.append(current_user_id())
        return {"user_id": current_user_id()}
    jobs = service(handler)
    first = jobs.enqueue("test", {}, scope, "one")
    with use_workspace(2):
        db.init_db()
        other = ExtensionContext.current()
        second = jobs.enqueue("test", {}, other, "two")
        with pytest.raises(JobNotFound):
            jobs.get(first["id"], other)
    async def scenario():
        worker = JobWorker(jobs)
        await asyncio.gather(worker.run_once(1), worker.run_once(2))
    asyncio.run(scenario())
    assert sorted(seen) == [1, 2]
    assert jobs.get(first["id"], scope)["result"]["user_id"] == 1
    events = jobs.events(first["id"], scope, after=0)
    assert [event["type"] for event in events] == ["queued", "running", "succeeded"]
    assert jobs.events(first["id"], scope, after=events[0]["cursor"])[0] == events[1]


def test_cancel_interrupts_running_handler_and_does_not_publish_success(scope):
    async def scenario():
        started = asyncio.Event()
        stopped = asyncio.Event()
        async def handler(job, control):
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                stopped.set()
        jobs = service(handler)
        item = jobs.enqueue("test", {}, scope, "cancel")
        worker = JobWorker(jobs, heartbeat_seconds=0.01)
        task = asyncio.create_task(worker.run_once(1))
        await started.wait()
        jobs.cancel(item["id"], scope)
        await task
        assert stopped.is_set() and jobs.get(item["id"], scope)["status"] == "cancelled"
    asyncio.run(scenario())


def test_heartbeat_failure_stops_the_handler_instead_of_leaving_unleased_work(scope, monkeypatch):
    async def scenario():
        stopped = asyncio.Event()
        async def handler(job, control):
            try:
                await asyncio.Event().wait()
            finally:
                stopped.set()
        jobs = service(handler)
        item = jobs.enqueue("test", {}, scope, "lost-heartbeat")
        def unavailable(*args):
            raise RuntimeError("database temporarily unavailable")
        monkeypatch.setattr(jobs.repository, "heartbeat", unavailable)
        await asyncio.wait_for(JobWorker(jobs, heartbeat_seconds=0.01).run_once(1), 0.3)
        assert stopped.is_set()
        assert jobs.get(item["id"], scope)["status"] == "interrupted"
    asyncio.run(scenario())


def test_unknown_external_outcome_is_not_resumable(scope):
    now = [1000.0]
    jobs = service(clock=lambda: now[0])
    item = jobs.enqueue("test", {}, scope, "unknown-external")
    claimed = jobs.repository.claim(scope)
    jobs.repository.checkpoint(item["id"], claimed["owner_token"], {"external_outcome": "unknown"}, scope)
    now[0] += 60
    jobs.repository.interrupt_expired(scope)
    with pytest.raises(JobConflict):
        jobs.resume(item["id"], scope)


def test_pause_stops_execution_before_publishing_a_confirmation(scope):
    stopped = []
    class Execution:
        async def stop(self):
            stopped.append(True)
    async def handler(job, control):
        control.attach_execution(Execution())
        await control.wait_for_user("确认下一步", {"type": "object"})
    jobs = service(handler)
    item = jobs.enqueue("test", {}, scope, "stop-before-wait")
    asyncio.run(JobWorker(jobs).run_once(1))
    assert stopped and jobs.get(item["id"], scope)["status"] == "waiting_user"


def test_worker_preserves_safe_model_failure_instead_of_only_exception_name(scope):
    from app.models.base import ModelProviderError
    calls = []

    async def handler(job, control):
        calls.append(job["id"])
        raise ModelProviderError("authentication_failed", "模型服务认证失败，请检查 API Key；Authorization: Bearer test-secret-value")

    jobs = service(handler)
    item = jobs.enqueue("test", {}, scope, "model-auth-failure")
    result = asyncio.run(JobWorker(jobs).run_once(1))
    assert result["status"] == "failed"
    assert "认证失败" in result["error"]
    assert "test-secret-value" not in result["error"]
    assert asyncio.run(JobWorker(jobs).run_once(1)) is None
    assert calls == [item["id"]]


def test_worker_does_not_publish_arbitrary_exception_details(scope):
    async def handler(job, control):
        raise RuntimeError("private filesystem details and provider credentials")

    jobs = service(handler)
    jobs.enqueue("test", {}, scope, "private-failure")
    result = asyncio.run(JobWorker(jobs).run_once(1))
    assert result["error"] == "RuntimeError：任务执行失败"


def test_manager_schedules_third_account_when_first_two_are_idle(monkeypatch):
    from app.jobs import worker as module
    seen = []
    class Worker:
        def __init__(self, *args): pass
        async def run_once(self, user_id): seen.append(user_id)
    original_sleep = asyncio.sleep
    scans = [0]
    async def sleep(_seconds):
        await original_sleep(0)
        scans[0] += 1
        if scans[0] == 3: raise asyncio.CancelledError()
    monkeypatch.setattr(module, "JobWorker", Worker)
    monkeypatch.setattr(module, "list_user_ids", lambda: [1, 2, 3])
    monkeypatch.setattr(module.asyncio, "sleep", sleep)
    async def scenario():
        manager = module.JobWorkerManager(service())
        with pytest.raises(asyncio.CancelledError): await manager.run()
        await manager.close()
    asyncio.run(scenario())
    assert 3 in seen, seen


def test_confirmation_schema_rejects_incomplete_or_incorrectly_typed_answers(scope):
    jobs = service()
    item = jobs.enqueue("test", {}, scope, "typed-confirmation")
    claim = jobs.repository.claim(scope)
    waiting = jobs.repository.wait_for_user(item["id"], claim["owner_token"], "确认标题", {"type": "object", "properties": {"approved": {"type": "boolean"}, "title": {"type": "string"}}, "required": ["approved", "title"], "additionalProperties": False}, scope)
    for answer in ({"approved": True}, {"approved": "false", "title": "报告"}):
        with pytest.raises(ValueError):
            jobs.confirm(item["id"], waiting["stage_id"], waiting["revision"], answer, scope)
    assert jobs.get(item["id"], scope)["status"] == "waiting_user"


def test_orphan_cleanup_precedes_resume_and_cancel_completion(scope, monkeypatch):
    from app.jobs import worker as module
    stopped = []
    async def stop_old(job, context): stopped.append(job["execution"]["attempt"])
    monkeypatch.setattr(module, "stop_execution", stop_old, raising=False)
    now = [1000.0]
    jobs = service(clock=lambda: now[0])
    item = jobs.enqueue("test", {}, scope, "orphan")
    claim = jobs.repository.claim(scope)
    jobs.repository.set_execution(item["id"], claim["owner_token"], {"attempt": claim["owner_token"], "stopped": False, "image": "image@sha256:" + "a" * 64}, scope)
    now[0] += 60
    jobs.repository.interrupt_expired(scope)
    with pytest.raises(JobConflict): jobs.resume(item["id"], scope)
    pending = jobs.cancel(item["id"], scope)
    assert pending["status"] != "cancelled"
    asyncio.run(JobWorker(jobs).run_once(1))
    assert stopped == [claim["owner_token"]]
    assert jobs.get(item["id"], scope)["status"] == "cancelled"


def test_old_execution_receipt_cannot_mark_a_new_attempt_stopped(scope):
    now = [1000.0]
    jobs = service(clock=lambda: now[0])
    item = jobs.enqueue("test", {}, scope, "attempt-fence")
    old = jobs.repository.claim(scope)
    jobs.repository.set_execution(item["id"], old["owner_token"], {"attempt": old["owner_token"], "stopped": False}, scope)
    now[0] += 60
    jobs.repository.interrupt_expired(scope)
    jobs.repository.mark_execution_stopped(item["id"], old["owner_token"], scope)
    jobs.resume(item["id"], scope)
    new = jobs.repository.claim(scope)
    jobs.repository.set_execution(item["id"], new["owner_token"], {"attempt": new["owner_token"], "stopped": False}, scope)
    jobs.repository.mark_execution_stopped(item["id"], old["owner_token"], scope)
    assert jobs.get(item["id"], scope)["execution"] == {"attempt": new["owner_token"], "stopped": False}


def test_expired_cancel_waits_for_orphan_stop_before_becoming_terminal(scope, monkeypatch):
    from app.jobs import worker as module
    stopped = []
    async def stop_old(job, context): stopped.append(job["execution"]["attempt"])
    monkeypatch.setattr(module, "stop_execution", stop_old)
    now = [1000.0]
    jobs = service(clock=lambda: now[0])
    item = jobs.enqueue("test", {}, scope, "expired-cancel")
    claim = jobs.repository.claim(scope)
    jobs.repository.set_execution(item["id"], claim["owner_token"], {"attempt": claim["owner_token"], "stopped": False}, scope)
    jobs.cancel(item["id"], scope)
    now[0] += 60
    jobs.repository.interrupt_expired(scope)
    assert jobs.get(item["id"], scope)["status"] == "interrupted"
    assert jobs.get(item["id"], scope)["cancel_requested"]
    asyncio.run(JobWorker(jobs).run_once(1))
    assert stopped == [claim["owner_token"]]
    assert jobs.get(item["id"], scope)["status"] == "cancelled"
