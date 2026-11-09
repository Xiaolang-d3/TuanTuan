"""Real Worker integration for generic lease-fenced model budgets; no providers."""
import asyncio

import pytest

from app import db
from app.extensions.contracts import ExtensionContext
from app.extensions.runtime_snapshot import ExtensionRunSnapshot
from app.jobs.repository import JobConflict
from app.jobs.service import JobService
from app.jobs.worker import JobWorker
from app.jobs.model_ledger import JobModelCallLedger, JobBudgetExceeded
from app.workspace import current_workspace_root, use_workspace


@pytest.fixture
def scope(tmp_path):
    with use_workspace(1, tmp_path / "owner"):
        db.init_db()
        yield ExtensionContext.current()


def enqueue(service, context, budget=None, key="review-budget"):
    snapshot = ExtensionRunSnapshot(user_id=context.user_id, grants=("jobs.model_budget",)).model_dump(mode="json")
    limits = {"calls": 32, "input_tokens": 200000, "output_tokens": 32000, "active_seconds": 1800, **(budget or {})}
    return service.repository.enqueue("document.review", {"budget": limits}, snapshot, context, key)


def run(service):
    return asyncio.run(JobWorker(service, heartbeat_seconds=0.001).run_once(1, current_workspace_root()))


@pytest.mark.parametrize("dimension", ["calls", "input_tokens", "output_tokens", "active_seconds"])
def test_worker_budget_exhaustion_pauses_instead_of_failing_or_replaying(scope, dimension):
    now = [1000.0]
    limits = {"calls": 1} if dimension == "calls" else {"input_tokens": 10} if dimension == "input_tokens" else {"output_tokens": 3} if dimension == "output_tokens" else {"active_seconds": 2}
    async def handler(job, control):
        ledger = JobModelCallLedger(control.service.repository, clock=lambda: now[0])
        first = ledger.reserve(job["id"], job["owner_token"], "batch.0", scope, input_tokens=6, output_tokens=2)
        ledger.complete(first, job["owner_token"], "a" * 64, {"input_tokens": 6, "output_tokens": 2}, scope)
        if dimension == "active_seconds":
            now[0] += 3
            await control.wait_for_user("普通暂停不能绕过活动预算")
        else:
            ledger.reserve(job["id"], job["owner_token"], "batch.1", scope, input_tokens=6, output_tokens=2)
        raise AssertionError("exhausted budget must stop the handler")
    service = JobService({"document.review": handler}, clock=lambda: now[0], model_budget_kinds={"document.review"})
    job = enqueue(service, scope, limits)
    paused = run(service)
    assert paused["id"] == job["id"] and paused["status"] == "waiting_user"
    assert paused["checkpoint"]["budget_exhausted"] is True
    budget = JobModelCallLedger(service.repository, clock=lambda: now[0]).status(job["id"], scope)
    assert budget["calls_used"] == 1
    if dimension == "active_seconds":
        assert budget["active_seconds"] == 3
        now[0] += 300
        assert JobModelCallLedger(service.repository, clock=lambda: now[0]).status(job["id"], scope)["active_seconds"] == 3


def test_heartbeat_budget_exhaustion_enters_waiting_user(scope):
    now = [1000.0]
    async def handler(job, control):
        await asyncio.sleep(0.004)
        now[0] += 3
        await asyncio.Event().wait()
    service = JobService({"document.review": handler}, clock=lambda: now[0], model_budget_kinds={"document.review"})
    enqueue(service, scope, {"active_seconds": 2})
    assert run(service)["status"] == "waiting_user"


@pytest.mark.parametrize("during_budget_pause", [False, True])
def test_user_cancellation_stops_activity_even_when_budget_pause_races(scope, during_budget_pause):
    now = [1000.0]
    async def handler(job, control):
        now[0] += 7
        control.service.cancel(job["id"], scope)
        if during_budget_pause:
            raise JobBudgetExceeded("取消同时达到预算")
        await asyncio.Event().wait()
    service = JobService({"document.review": handler}, clock=lambda: now[0], model_budget_kinds={"document.review"})
    job = enqueue(service, scope)
    assert run(service)["status"] == "cancelled"
    now[0] += 500
    assert JobModelCallLedger(service.repository, clock=lambda: now[0]).status(job["id"], scope)["active_seconds"] == 7


def test_budget_confirmation_is_stage_revision_and_receipt_fenced(scope):
    async def handler(job, control):
        await control.pause_for_budget("需要追加预算")
    service = JobService({"document.review": handler}, model_budget_kinds={"document.review"})
    job = enqueue(service, scope)
    paused = run(service)
    answer = {"budget": {"calls": 2, "input_tokens": 1000, "output_tokens": 200, "active_seconds": 60}, "idempotency_key": "add-once"}
    queued = service.confirm(job["id"], paused["stage_id"], paused["revision"], answer, scope)
    assert queued["status"] == "queued"
    assert service.confirm(job["id"], paused["stage_id"], paused["revision"], answer, scope)["id"] == job["id"]
    ledger = JobModelCallLedger(service.repository)
    assert ledger.status(job["id"], scope)["calls_limit"] == 34
    changed = {**answer, "budget": {**answer["budget"], "calls": 3}}
    with pytest.raises(JobConflict):
        service.confirm(job["id"], paused["stage_id"], paused["revision"], changed, scope)
    with pytest.raises(JobConflict):
        service.confirm(job["id"], paused["stage_id"], paused["revision"] + 1, answer, scope)
    assert ledger.status(job["id"], scope)["calls_limit"] == 34


@pytest.mark.parametrize("usage,expected", [({}, (8, 4)), ({"input_tokens": 3, "output_tokens": 1}, (3, 1)),
    ({"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}, (8, 4)), ({"total_tokens": 100}, (100, 100))])
def test_completion_keeps_unknown_usage_reserved_and_reconciles_known_usage(scope, usage, expected):
    service = JobService({"document.review": lambda *_: None}, model_budget_kinds={"document.review"})
    job = enqueue(service, scope)
    claimed = service.repository.claim(scope)
    ledger = JobModelCallLedger(service.repository)
    request = ledger.reserve(job["id"], claimed["owner_token"], "batch.0", scope, input_tokens=8, output_tokens=4)
    ledger.complete(request, claimed["owner_token"], "a" * 64, usage, scope)
    ledger.complete(request, claimed["owner_token"], "a" * 64, usage, scope)
    status = ledger.status(job["id"], scope)
    assert (status["input_tokens_used"], status["output_tokens_used"]) == expected and status["calls_used"] == 1
    with pytest.raises(JobConflict):
        ledger.reserve(job["id"], claimed["owner_token"], "batch.0", scope, input_tokens=8, output_tokens=4)


def test_lost_attempt_and_unknown_call_never_get_an_automatic_replay(scope):
    now = [1000.0]
    service = JobService({"document.review": lambda *_: None}, clock=lambda: now[0], model_budget_kinds={"document.review"})
    job = enqueue(service, scope)
    claimed = service.repository.claim(scope)
    ledger = JobModelCallLedger(service.repository, clock=lambda: now[0])
    ledger.start_activity(job["id"], claimed["owner_token"], scope)
    call = ledger.reserve(job["id"], claimed["owner_token"], "batch.0", scope, input_tokens=8, output_tokens=4)
    now[0] += 31
    service.repository.interrupt_expired(scope)
    with pytest.raises(JobConflict):
        ledger.complete(call, claimed["owner_token"], "a" * 64, {}, scope)
    with pytest.raises(JobConflict):
        service.resume(job["id"], scope)
    status = ledger.status(job["id"], scope)
    assert status["calls_used"] == 1 and status["active_seconds"] == 30


def test_expired_activity_is_settled_on_new_attempt_without_resetting_budget(scope):
    now = [1000.0]
    service = JobService({"document.review": lambda *_: None}, clock=lambda: now[0], model_budget_kinds={"document.review"})
    job = enqueue(service, scope)
    first = service.repository.claim(scope)
    ledger = JobModelCallLedger(service.repository, clock=lambda: now[0])
    ledger.start_activity(job["id"], first["owner_token"], scope)
    now[0] += 31
    service.repository.interrupt_expired(scope)
    service.resume(job["id"], scope)
    second = service.repository.claim(scope)
    ledger.start_activity(job["id"], second["owner_token"], scope)
    now[0] += 3
    ledger.stop_activity(job["id"], second["owner_token"], scope)
    assert ledger.status(job["id"], scope)["active_seconds"] == 33


def test_generic_tasks_do_not_acquire_model_budget_from_request_json(scope):
    async def ordinary(job, control):
        assert control.activity_ledger is None
        return {"done": True}
    service = JobService({"echo": ordinary})
    snapshot = ExtensionRunSnapshot(user_id=scope.user_id).model_dump(mode="json")
    job = service.repository.enqueue("echo", {"budget": {"calls": 1}}, snapshot, scope, "ordinary")
    assert run(service)["status"] == "succeeded"
    with pytest.raises(JobConflict):
        JobModelCallLedger(service.repository).status(job["id"], scope)


def test_v38_upgrade_backs_up_before_adding_generic_model_ledger(tmp_path):
    import sqlite3
    from pathlib import Path
    path = tmp_path / "tuantuan.db"
    fixture = Path(__file__).parent / "fixtures/workspace_v38.sql"
    with sqlite3.connect(path) as conn:
        conn.executescript(fixture.read_text(encoding="utf-8"))
    db.init_db(path)
    assert (path.parent / f".upgrade-backups/before-schema-v{db.DB_SCHEMA_VERSION}" / path.name).exists()
    with sqlite3.connect(path) as conn:
        assert conn.execute("SELECT title FROM conversations").fetchone()[0] == "fixture-conversation"
        assert {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")} >= {"job_model_budgets", "job_model_calls", "job_budget_confirmations"}
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []


def test_status_initialization_can_race_with_another_reader(scope, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from contextlib import contextmanager
    from threading import Barrier
    from app.jobs import model_ledger
    service = JobService({"document.review": lambda *_: None}, model_budget_kinds={"document.review"})
    job = enqueue(service, scope)
    root, barrier = current_workspace_root(), Barrier(2)
    original = model_ledger.connect
    class Row:
        def __init__(self, row):
            self.row = row
        def fetchone(self):
            return self.row
    class Connection:
        def __init__(self, conn):
            self.conn = conn
        def execute(self, sql, args=()):
            cursor = self.conn.execute(sql, args)
            if sql == "SELECT * FROM job_model_budgets WHERE job_id=?":
                row = cursor.fetchone()
                if row is None:
                    barrier.wait(timeout=3)
                return Row(row)
            return cursor
    @contextmanager
    def raced_connect():
        with original() as conn:
            yield Connection(conn)
    monkeypatch.setattr(model_ledger, "connect", raced_connect)
    def read():
        with use_workspace(1, root):
            return JobModelCallLedger(service.repository).status(job["id"], ExtensionContext.current())
    with ThreadPoolExecutor(max_workers=2) as workers:
        futures = [workers.submit(read) for _ in range(2)]
        assert [future.result()["calls_used"] for future in futures] == [0, 0]
