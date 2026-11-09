import asyncio
import hashlib
import json

import pytest

from app import db
from app.jobs.repository import JobConflict
from app.presentations.contracts import PresentationRequest
from test_presentation_service import scope, service  # noqa: F401
from test_ppt_final_contract import finalized  # noqa: F401
from test_ppt_generate import preparation  # noqa: F401


def failed(app, scope, checkpoint=None):
    job = app.create(PresentationRequest(topic="大语言模型入门"), scope, "retry-original")
    claimed = app.jobs.repository.claim(scope)
    app.jobs.repository.checkpoint(job["id"], claimed["owner_token"], checkpoint or {"stage": "final_confirmed"}, scope)
    app.jobs.repository.release(job["id"], claimed["owner_token"], "failed", "ValueError：任务执行失败", scope)
    return app.get(job["id"], scope)


def test_retry_requeues_original_job_and_keeps_confirmations_and_budget(scope):
    app = service()
    original = failed(app, scope, {"stage": "final_confirmed", "production": {"stage": "page_3_ready"}})
    result = app.retry(original["id"], {"expected_revision": original["revision"], "request_id": "first-retry"}, scope)
    assert result["id"] == original["id"] and result["status"] == "queued"
    assert result["checkpoint"]["production"]["stage"] == "page_3_ready"
    assert result["request"] == original["request"] and result["snapshot"] == original["snapshot"]
    assert len(app.jobs.repository.list(scope)) == 1


def test_retry_request_is_idempotent_and_stale_or_changed_replay_is_rejected(scope):
    app = service(); original = failed(app, scope)
    body = {"expected_revision": original["revision"], "request_id": "once"}
    first = app.retry(original["id"], body, scope)
    assert app.retry(original["id"], body, scope)["revision"] == first["revision"]
    with pytest.raises(JobConflict):
        app.retry(original["id"], {**body, "topic": "不同内容"}, scope)
    with pytest.raises(JobConflict):
        app.retry(original["id"], {**body, "request_id": "stale"}, scope)


def test_explicit_retry_refreshes_same_models_saved_configuration(scope):
    app = service(); original = failed(app, scope)
    connection = app.model_resolver()
    app.model_resolver = lambda **_: {**connection, "profile_revision": 7, "connection_revision": 9}
    result = app.retry(original["id"], {"expected_revision": original["revision"], "request_id": "updated-model"}, scope)
    assert result["snapshot"]["model_selection"]["profile_id"] == original["snapshot"]["model_selection"]["profile_id"]
    assert result["snapshot"]["model_selection"]["connection_revision"] == 9
    assert result["snapshot"]["model_selection"]["profile_revision"] == 7


def test_edit_and_retry_updates_same_job_and_starts_new_content_revision(scope):
    from app.presentations.confirmation import project_name
    app = service(); original = failed(app, scope)
    old_project = project_name(original)
    result = app.retry(original["id"], {"expected_revision": original["revision"], "request_id": "edit", "topic": "面向初学者介绍大语言模型的基本原理", "page_count": 6}, scope)
    assert result["id"] == original["id"]
    assert result["request"]["topic"] == "面向初学者介绍大语言模型的基本原理"
    assert result["request"]["options"]["page_count"] == 6
    assert result["checkpoint"] == {} and result["confirmation"] is None
    assert project_name(result) != old_project
    assert len(app.jobs.repository.list(scope)) == 1


def test_uncertain_request_requires_explicit_retry_confirmation_and_preserves_ledger(scope):
    from app.presentations.model_ledger import ModelCallLedger
    app = service()
    job = app.create(PresentationRequest(topic="大语言模型入门"), scope, "uncertain")
    claimed = app.jobs.repository.claim(scope)
    ledger = ModelCallLedger(app.jobs.repository)
    request_id = ledger.reserve(job["id"], claimed["owner_token"], "design_spec", scope)
    ledger.mark_unknown(request_id, claimed["owner_token"], scope)
    app.jobs.repository.release(job["id"], claimed["owner_token"], "failed", "模型调用超时", scope)
    original = app.get(job["id"], scope)
    body = {"expected_revision": original["revision"], "request_id": "confirm-retry"}
    with pytest.raises(JobConflict, match="确认"):
        app.retry(job["id"], body, scope)
    queued = app.retry(job["id"], {**body, "acknowledge_uncertain": True}, scope)
    assert queued["id"] == job["id"] and queued["status"] == "queued"
    next_attempt = app.jobs.repository.claim(scope)
    ledger.reserve(job["id"], next_attempt["owner_token"], "retry1.design_spec", scope)
    with db.connect() as conn:
        assert conn.execute("SELECT state FROM presentation_model_calls WHERE id=?", (request_id,)).fetchone()[0] == "unknown"
    assert ledger.status(job["id"], scope)["calls_used"] == 2


def test_unchanged_retry_retains_the_authenticated_final_contract(finalized):
    from app.presentations.final_contract import load_final_contract
    from app.presentations.retry import retry_presentation
    p = finalized.p
    before = load_final_contract(p.repository, p.job, p.context)
    p.repository.release(p.job["id"], p.job["owner_token"], "failed", "RuntimeError：任务执行失败", p.context)
    original = p.repository.get(p.job["id"], p.context)
    retry_presentation(p.repository, p.job["id"], {"expected_revision": original["revision"], "request_id": "keep-confirmations"}, p.context)
    job = p.repository.claim(p.context)
    assert load_final_contract(p.repository, job, p.context).final == before.final
    assert len(p.calls) == 2


def test_edit_retry_requires_new_confirmations_without_reusing_old_content(finalized):
    from types import SimpleNamespace
    from app.presentations.confirmation import ConfirmationFlow
    from app.presentations.final_contract import load_final_contract
    from app.presentations.generation import GeneratePreparation
    from app.presentations.model_runner import PptModelRunner
    from app.presentations.retry import retry_presentation
    from test_ppt_generate import recommendation, confirmed_free_design
    p = finalized.p
    old_root = p.preparer.root
    p.repository.release(p.job["id"], p.job["owner_token"], "failed", "ValueError：任务执行失败", p.context)
    original = p.repository.get(p.job["id"], p.context)
    retry_presentation(p.repository, p.job["id"], {"expected_revision": original["revision"], "request_id": "edit-content", "topic": "新的具体主题：大语言模型入门"}, p.context)
    p.job = p.repository.claim(p.context)
    runner = PptModelRunner(p.repository, p.job, p.context, p.task.root, provider_factory=p.preparer.runner.provider_factory)
    p.preparer = GeneratePreparation(p.repository, p.job, p.context, p.preparer.handle, runner)
    assert p.preparer.root != old_root and old_root.is_dir()
    with pytest.raises(JobConflict):
        load_final_contract(p.repository, p.job, p.context)
    p.output[0] = recommendation()
    confirmed_free_design(p)
    asyncio.run(p.preparer.prepare_stage2())
    waiting = p.repository.wait_for_user(p.job["id"], p.job["owner_token"], "确认新内容", {}, p.context)
    scope = SimpleNamespace(user_id=p.context.user_id, job_id=waiting["id"], stage_id=waiting["stage_id"], revision=waiting["revision"], source_version=waiting["checkpoint"]["source_version"], manifest_sha256=waiting["checkpoint"]["manifest_sha256"])
    p.preparer.files.write("confirm_ui/result.json", json.dumps(finalized.result, ensure_ascii=False).encode())
    flow = ConfirmationFlow(p.repository)
    flow.reserve_submission(scope, p.context)
    flow.accept(scope, p.context)
    job = p.repository.claim(p.context)
    assert load_final_contract(p.repository, job, p.context).final == finalized.result
    assert len(p.calls) == 4
    assert p.repository.get(job["id"], p.context)["request"]["topic"].startswith("新的具体主题")
