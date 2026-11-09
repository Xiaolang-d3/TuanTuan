"""Persist reservations before dispatch, including uncertain paid requests."""
import sqlite3

import pytest

from app import db
from app.extensions.contracts import ExtensionContext
from app.jobs.repository import JobConflict, JobRepository
from app.workspace import use_workspace


@pytest.fixture
def running(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "default.db")
    now = [1000.0]
    repository = JobRepository(clock=lambda: now[0])
    with use_workspace(1):
        db.init_db()
        context = ExtensionContext.current()
        job = repository.enqueue("ppt.generate", {}, {}, context, "ledger")
        claimed = repository.claim(context)
        from app.presentations.model_ledger import ModelCallLedger
        ledger = ModelCallLedger(repository, clock=lambda: now[0])
        yield ledger, repository, context, claimed, now


def test_crash_after_model_dispatch_preserves_budget(running):
    ledger, repository, context, job, now = running
    request_id = ledger.reserve(job["id"], job["owner_token"], "outline", context)
    # A fresh connection observes both the reservation and the recovery fence.
    with db.connect() as conn:
        call = conn.execute("SELECT * FROM presentation_model_calls WHERE id=?", (request_id,)).fetchone()
        assert call["state"] == "reserved"
    checkpoint = repository.get(job["id"], context)["checkpoint"]
    assert checkpoint["external_outcome"] == "unknown"
    now[0] += 31
    repository.interrupt_expired(context)
    with pytest.raises(JobConflict, match="结果不明"):
        repository.resume(job["id"], context)
    assert ledger.status(job["id"], context)["calls_used"] == 1


def test_unknown_request_requires_explicit_retry(running):
    ledger, repository, context, job, _ = running
    request_id = ledger.reserve(job["id"], job["owner_token"], "outline", context)
    ledger.mark_unknown(request_id, job["owner_token"], context)
    with pytest.raises(JobConflict, match="结果不明"):
        ledger.reserve(job["id"], job["owner_token"], "outline", context)
    assert ledger.status(job["id"], context)["calls_used"] == 1


def test_completed_reservation_keeps_other_checkpoint_fields(running):
    ledger, repository, context, job, _ = running
    repository.checkpoint(job["id"], job["owner_token"], {"stage": "outline", "manifest_sha256": "a" * 64}, context)
    request_id = ledger.reserve(job["id"], job["owner_token"], "outline", context)
    ledger.complete(request_id, job["owner_token"], "b" * 64, {"total_tokens": 42}, context)
    checkpoint = repository.get(job["id"], context)["checkpoint"]
    assert checkpoint == {"stage": "outline", "manifest_sha256": "a" * 64}
    with db.connect() as conn:
        call = dict(conn.execute("SELECT * FROM presentation_model_calls WHERE id=?", (request_id,)).fetchone())
        assert call["result_hash"] == "b" * 64
        assert call["state"] == "completed"
        assert '42' in call["usage_json"]
        assert "content" not in call


def test_stage_recovery_fence_allows_next_stage_but_not_rebilling(running):
    ledger, _, context, job, _ = running
    ledger.assert_stage_unused(job["id"], "stage1", context)
    request_id = ledger.reserve(job["id"], job["owner_token"], "stage1", context)
    with pytest.raises(JobConflict, match="恢复"):
        ledger.assert_stage_unused(job["id"], "stage2", context)
    ledger.complete(request_id, job["owner_token"], "a" * 64, {}, context)
    ledger.assert_stage_unused(job["id"], "stage2", context)
    with pytest.raises(JobConflict, match="恢复"):
        ledger.assert_stage_unused(job["id"], "stage1", context)


def test_model_attempt_budget_is_not_reset_by_new_ledger(running):
    from app.presentations.model_ledger import ModelCallLedger, PresentationBudgetExceeded
    ledger, repository, context, job, now = running
    for _ in range(48):
        request_id = ledger.reserve(job["id"], job["owner_token"], "slide", context)
        ledger.complete(request_id, job["owner_token"], "b" * 64, {}, context)
    restored = ModelCallLedger(repository, clock=lambda: now[0])
    with pytest.raises(PresentationBudgetExceeded, match="48"):
        restored.reserve(job["id"], job["owner_token"], "slide", context)
    assert restored.status(job["id"], context)["calls_used"] == 48


def test_expired_attempt_cannot_reserve_or_complete(running):
    ledger, _, context, job, now = running
    request_id = ledger.reserve(job["id"], job["owner_token"], "outline", context)
    now[0] += 31
    with pytest.raises(JobConflict, match="租约"):
        ledger.complete(request_id, job["owner_token"], "b" * 64, {}, context)
    with pytest.raises(JobConflict, match="租约"):
        ledger.reserve(job["id"], job["owner_token"], "slide", context)


def test_resume_does_not_reset_activity_budget(running):
    ledger, repository, context, job, now = running
    ledger.start_activity(job["id"], job["owner_token"], context)
    now[0] += 10
    ledger.stop_activity(job["id"], job["owner_token"], context)
    repository.release(job["id"], job["owner_token"], "interrupted", "restart", context)
    now[0] += 500  # Time waiting for a person is excluded.
    repository.resume(job["id"], context)
    resumed = repository.claim(context)
    ledger.start_activity(job["id"], resumed["owner_token"], context)
    now[0] += 5
    ledger.stop_activity(job["id"], resumed["owner_token"], context)
    assert ledger.status(job["id"], context)["active_seconds"] == 15


def test_crashed_activity_charges_through_last_observed_lease(running):
    ledger, repository, context, job, now = running
    ledger.start_activity(job["id"], job["owner_token"], context)
    now[0] += 10
    assert repository.heartbeat(job["id"], job["owner_token"], context)
    ledger.refresh_activity(job["id"], job["owner_token"], context)
    now[0] += 100
    repository.interrupt_expired(context)
    repository.resume(job["id"], context)
    resumed = repository.claim(context)
    ledger.start_activity(job["id"], resumed["owner_token"], context)
    ledger.stop_activity(job["id"], resumed["owner_token"], context)
    assert ledger.status(job["id"], context)["active_seconds"] == 40


def test_activity_limit_survives_crash(running):
    from app.presentations.model_ledger import PresentationBudgetExceeded
    ledger, repository, context, job, now = running
    ledger.start_activity(job["id"], job["owner_token"], context)
    for _ in range(60):
        now[0] += 29
        assert repository.heartbeat(job["id"], job["owner_token"], context)
        ledger.refresh_activity(job["id"], job["owner_token"], context)
    now[0] += 29
    assert repository.heartbeat(job["id"], job["owner_token"], context)
    ledger.refresh_activity(job["id"], job["owner_token"], context)
    now[0] += 1
    assert repository.heartbeat(job["id"], job["owner_token"], context)
    ledger.refresh_activity(job["id"], job["owner_token"], context)
    now[0] += 31
    repository.interrupt_expired(context)
    repository.resume(job["id"], context)
    resumed = repository.claim(context)
    with pytest.raises(PresentationBudgetExceeded, match="1800"):
        ledger.start_activity(job["id"], resumed["owner_token"], context)


def test_cross_account_ledger_is_unavailable(running):
    ledger, _, _, job, _ = running
    with use_workspace(2):
        db.init_db()
        with pytest.raises(JobConflict, match="不存在"):
            ledger.status(job["id"], ExtensionContext.current())


def test_v34_upgrade_preserves_jobs_and_is_repeatable(tmp_path):
    from app.persistence.upgrades import migration_name
    path = tmp_path / "upgrade.db"
    db.init_db(path)
    with db.connect(path) as conn:
        conn.execute("DROP TABLE IF EXISTS presentation_model_calls")
        conn.execute("DROP TABLE IF EXISTS presentation_job_budgets")
        conn.execute("DELETE FROM schema_migrations WHERE version > 34")
        conn.execute("INSERT OR IGNORE INTO schema_migrations(version,name) VALUES(34,'execution_attempt_fencing')")
        conn.execute("INSERT INTO background_jobs(id,kind,idempotency_key,request_hash,request_json,snapshot_json,status) VALUES('old','example','old','hash','{}','{}','interrupted')")
    db.init_db(path)
    db.init_db(path)
    with sqlite3.connect(path) as conn:
        assert conn.execute("SELECT status FROM background_jobs WHERE id='old'").fetchone() == ("interrupted",)
        assert conn.execute("SELECT version,name FROM schema_migrations WHERE version > 34").fetchall() == [(db.DB_SCHEMA_VERSION, migration_name(db.DB_SCHEMA_VERSION))]
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
        assert conn.execute("SELECT COUNT(*) FROM presentation_model_calls").fetchone() == (0,)
    assert (tmp_path / f".upgrade-backups/before-schema-v{db.DB_SCHEMA_VERSION}/upgrade.db").is_file()
