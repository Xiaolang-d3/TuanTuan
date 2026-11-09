"""Presentation calls use one bound provider and one observable network attempt."""
import asyncio
import json

import pytest

from app import db
from app.domain import ModelResponse, ModelUsage
from app.extensions.contracts import ExtensionContext
from app.jobs.repository import JobConflict, JobRepository
from app.observability.model_context import current_model_call
from app.models.base import ModelProviderError
from app.workspace import use_workspace


@pytest.fixture
def running(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "default.db")
    with use_workspace(1):
        db.init_db()
        context = ExtensionContext.current()
        repository = JobRepository()
        repository.enqueue("ppt.generate", {}, {}, context, "runner")
        job = repository.claim(context)
        yield repository, context, job, tmp_path, monkeypatch


def selection():
    return {"profile_id": "p", "profile_revision": 2, "connection_id": "c", "connection_revision": 3}


def test_reservation_is_visible_before_provider_dispatch(running):
    from app.presentations.model_runner import PptModelRunner
    repository, context, job, root, _ = running
    calls = []

    class Provider:
        async def generate(self, request):
            with db.connect() as conn:
                row = conn.execute("SELECT state FROM presentation_model_calls").fetchone()
                assert row[0] == "reserved"
            assert request.tools == [] and request.tool_choice == "none"
            assert request.allow_option_fallback is False
            assert request.response_format == {"type": "json_object"}
            assert current_model_call()["stage"] == "ppt.outline"
            calls.append(request)
            return ModelResponse(content='{"title":"中文"}', usage=ModelUsage(total_tokens=20))

    runner = PptModelRunner(repository, job, context, root, provider_factory=lambda bound: Provider())
    result = asyncio.run(runner.generate_stage("outline", {"source": "内容"}, selection(), instructions="输出 JSON"))
    assert result == {"title": "中文"}
    assert len(calls) == 1
    with db.connect() as conn:
        row = conn.execute("SELECT state,result_hash FROM presentation_model_calls").fetchone()
        assert row[0] == "completed" and len(row[1]) == 64
    assert len(list((root / "model_responses").glob("*.json"))) == 1


def test_explicit_retry_reuses_completed_outputs_and_only_repeats_failed_stage(running):
    from app.presentations.model_runner import PptModelRunner
    from app.presentations.retry import retry_presentation
    repository, context, job, root, _ = running
    with db.connect() as conn:
        conn.execute("UPDATE background_jobs SET request_json=? WHERE id=?", (json.dumps({"topic": "大语言模型入门"}), job["id"]))
    calls = []
    outputs = iter(['{"design":"accepted"}', '{"lock":"invalid"}', '{"lock":"fixed"}'])
    class Provider:
        async def generate(self, request):
            calls.append(request)
            return ModelResponse(content=next(outputs))
    runner = PptModelRunner(repository, job, context, root, provider_factory=lambda _: Provider())
    asyncio.run(runner.generate_stage("design_spec", {}, selection(), instructions="JSON"))
    asyncio.run(runner.generate_stage("spec_lock", {}, selection(), instructions="JSON"))
    repository.checkpoint(job["id"], job["owner_token"], {"stage": "final_confirmed"}, context)
    repository.release(job["id"], job["owner_token"], "failed", "ValueError：任务执行失败", context)
    failed = repository.get(job["id"], context)
    retry_presentation(repository, job["id"], {"expected_revision": failed["revision"], "request_id": "retry-lock"}, context)
    retry = repository.claim(context)
    runner = PptModelRunner(repository, retry, context, root, provider_factory=lambda _: Provider())
    assert asyncio.run(runner.generate_stage("design_spec", {}, selection(), instructions="JSON")) == {"design": "accepted"}
    assert len(calls) == 2
    assert asyncio.run(runner.generate_stage("spec_lock", {}, selection(), instructions="JSON")) == {"lock": "fixed"}
    assert asyncio.run(runner.generate_stage("spec_lock", {}, selection(), instructions="JSON")) == {"lock": "fixed"}
    assert len(calls) == 3
    assert runner.ledger.status(job["id"], context)["calls_used"] == 3


def test_retry_cannot_reuse_a_tampered_model_response(running):
    from app.presentations.model_runner import PptModelRunner
    from app.presentations.retry import retry_presentation
    repository, context, job, root, _ = running
    with db.connect() as conn:
        conn.execute("UPDATE background_jobs SET request_json=? WHERE id=?", (json.dumps({"topic": "大语言模型入门"}), job["id"]))
    class Provider:
        async def generate(self, request):
            return ModelResponse(content='{"ok":true}')
    runner = PptModelRunner(repository, job, context, root, provider_factory=lambda _: Provider())
    asyncio.run(runner.generate_stage("design_spec", {}, selection(), instructions="JSON"))
    response = next((root / "model_responses").glob("*.json"))
    response.write_text('{"tampered":true}', encoding="utf-8")
    repository.checkpoint(job["id"], job["owner_token"], {"stage": "final_confirmed"}, context)
    repository.release(job["id"], job["owner_token"], "failed", "RuntimeError：任务执行失败", context)
    failed = repository.get(job["id"], context)
    retry_presentation(repository, job["id"], {"expected_revision": failed["revision"], "request_id": "local-retry"}, context)
    retry = repository.claim(context)
    def forbidden(_):
        pytest.fail("a damaged completed result must not trigger another paid call")
    runner = PptModelRunner(repository, retry, context, root, provider_factory=forbidden)
    with pytest.raises(JobConflict, match="校验"):
        asyncio.run(runner.generate_stage("design_spec", {}, selection(), instructions="JSON"))


def test_transport_failure_is_not_automatically_replayed(running):
    from app.presentations.model_runner import PptModelRunner
    repository, context, job, root, _ = running
    calls = []

    class Provider:
        async def generate(self, request):
            calls.append(request)
            raise TimeoutError("uncertain upstream outcome")

    runner = PptModelRunner(repository, job, context, root, provider_factory=lambda bound: Provider())
    with pytest.raises(ModelProviderError) as caught:
        asyncio.run(runner.generate_stage("outline", {}, selection(), instructions="JSON"))
    assert caught.value.code == "request_timeout"
    with pytest.raises(JobConflict, match="结果不明"):
        asyncio.run(runner.generate_stage("outline", {}, selection(), instructions="JSON"))
    assert len(calls) == 1


def test_invalid_json_is_completed_but_not_silently_repaired(running):
    from app.presentations.model_runner import PptModelRunner
    repository, context, job, root, _ = running

    class Provider:
        async def generate(self, request):
            return ModelResponse(content="invalid")

    runner = PptModelRunner(repository, job, context, root, provider_factory=lambda bound: Provider())
    with pytest.raises(ModelProviderError, match="JSON") as caught:
        asyncio.run(runner.generate_stage("outline", {}, selection(), instructions="JSON"))
    assert caught.value.code == "invalid_response"
    assert repository.get(job["id"], context)["checkpoint"].get("external_outcome") is None
    with db.connect() as conn:
        assert conn.execute("SELECT state FROM presentation_model_calls").fetchone()[0] == "completed"


def test_model_binding_change_does_not_switch_provider(running):
    from app.presentations.model_runner import build_bound_provider
    _, _, _, _, monkeypatch = running
    monkeypatch.delenv("TUANTUAN_PPT_MODEL_TIMEOUT_SECONDS", raising=False)
    monkeypatch.delenv("CAREERLOOP_PPT_MODEL_TIMEOUT_SECONDS", raising=False)
    import app.agent.bootstrap as bootstrap
    import app.models.factory as factory
    captured = []

    def resolve(*, selection):
        assert selection == globals()["selection"]()
        return {"api_key": "test-only", "model_name": "bound-model", "model_base_url": "http://127.0.0.1:1", "model_protocol": "auto", "resolved_model_protocol": "openai", "detected_protocol": "responses", "parameters": {}}

    monkeypatch.setattr(bootstrap, "get_profile_connection", resolve)
    monkeypatch.setattr(factory, "build_model_provider", lambda **kwargs: captured.append(kwargs) or object())
    build_bound_provider(selection())
    assert captured[0]["protocol"] == "responses"
    assert captured[0]["model"] == "bound-model"
    assert captured[0]["timeout_seconds"] == 300


def test_unbound_model_rejected_before_any_call(running):
    from app.presentations.model_runner import PptModelRunner
    repository, context, job, root, _ = running
    runner = PptModelRunner(repository, job, context, root, provider_factory=lambda bound: pytest.fail("unbound dispatch"))
    with pytest.raises(ValueError, match="绑定"):
        asyncio.run(runner.generate_stage("outline", {}, {}, instructions="JSON"))
    with db.connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM presentation_model_calls").fetchone()[0] == 0


@pytest.mark.parametrize(("setting", "expected"), [
    (None, 300), ("240", 240), ("30", 30), ("600", 600),
    ("invalid", 300), ("nan", 300), ("0", 300), ("601", 300),
])
def test_ppt_timeout_setting_is_shared_by_client_and_total_deadline(running, setting, expected):
    import app.presentations.model_runner as module
    repository, context, job, root, monkeypatch = running
    monkeypatch.delenv("CAREERLOOP_PPT_MODEL_TIMEOUT_SECONDS", raising=False)
    if setting is None:
        monkeypatch.delenv("TUANTUAN_PPT_MODEL_TIMEOUT_SECONDS", raising=False)
    else:
        monkeypatch.setenv("TUANTUAN_PPT_MODEL_TIMEOUT_SECONDS", setting)
    deadlines, clients = [], []

    class Provider:
        async def generate(self, request):
            return ModelResponse(content='{"ok":true}')

    def provider(bound, **kwargs):
        assert bound == selection()
        clients.append(kwargs["timeout_seconds"])
        return Provider()

    async def wait_for(awaitable, *, timeout):
        deadlines.append(timeout)
        return await awaitable

    monkeypatch.setattr(module, "build_bound_provider", provider)
    monkeypatch.setattr(module.asyncio, "wait_for", wait_for)
    runner = module.PptModelRunner(repository, job, context, root)
    assert asyncio.run(runner.generate_stage("design_spec", {}, selection(), instructions="JSON")) == {"ok": True}
    assert clients == [expected]
    assert deadlines == [expected + 30]


def test_total_deadline_failure_is_classified_and_cannot_replay(running):
    import app.presentations.model_runner as module
    repository, context, job, root, monkeypatch = running
    calls = []

    class Provider:
        async def generate(self, request):
            calls.append(request)
            await asyncio.Event().wait()

    real_wait_for = asyncio.wait_for

    async def short_deadline(awaitable, *, timeout):
        return await real_wait_for(awaitable, timeout=0.01)

    monkeypatch.setattr(module.asyncio, "wait_for", short_deadline)
    runner = module.PptModelRunner(repository, job, context, root, provider_factory=lambda _: Provider())
    with pytest.raises(ModelProviderError) as caught:
        asyncio.run(runner.generate_stage("design_spec", {}, selection(), instructions="JSON"))
    assert caught.value.code == "request_timeout"
    assert caught.value.retryable is False
    assert repository.get(job["id"], context)["checkpoint"]["external_outcome"] == "unknown"
    with pytest.raises(JobConflict, match="结果不明"):
        asyncio.run(runner.generate_stage("design_spec", {}, selection(), instructions="JSON"))
    assert len(calls) == 1
