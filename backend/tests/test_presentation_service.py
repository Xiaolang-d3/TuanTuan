"""Dedicated PPT creation is bounded, account-scoped and still release-gated."""
from types import SimpleNamespace

import pytest

from app import db
from app.execution.builtin_runtime import UPSTREAM_COMMIT
from app.extensions.contracts import ExtensionContext
from app.jobs.repository import JobConflict, JobNotFound
from app.jobs.service import JobService
from app.presentations.contracts import PresentationRequest
from app.workspace import use_workspace


@pytest.fixture
def scope(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "accounts.db")
    with use_workspace(1):
        db.init_db()
        yield ExtensionContext.current()


def service():
    from app.presentations.service import PresentationService
    jobs = JobService({"ppt.generate": object()})
    connection = {"profile_id": "p", "profile_revision": 2, "connection_id": "c",
                  "connection_revision": 3, "resolved_model_protocol": "openai",
                  "api_key": "test-only-secret", "api_key_configured": True}
    runtime = SimpleNamespace(digest="a" * 64, manifest={"upstream_commit": UPSTREAM_COMMIT,
                              "files": {"host/render_preview.py": "b" * 64}}, verify=lambda: None)
    return PresentationService(jobs, runtime_loader=lambda: runtime,
                               model_resolver=lambda **_: connection, preparation_enabled=lambda: True)


def test_creation_binds_runtime_and_model_without_secrets(scope):
    app = service()
    job = app.create(PresentationRequest(topic="季度复盘"), scope, "create")
    assert job["status"] == "queued"
    snapshot = job["snapshot"]
    assert snapshot["version"] == 2 and snapshot["user_id"] == 1
    assert snapshot["execution"]["runtime_digest"] == "a" * 64
    assert snapshot["grants"] == ["builtin.ppt-master.execute"]
    assert snapshot["model_selection"]["profile_revision"] == 2
    assert app.model_resolver()["api_key"] not in str(job)
    assert "api_key" not in snapshot["model_selection"]


def test_chat_creation_and_readiness_use_the_conversation_model(scope, monkeypatch):
    from app.chat import conversations
    app = service()
    conversation = conversations.create_conversation("PPT 会话")
    original = conversations.get_conversation
    monkeypatch.setattr(conversations, "get_conversation", lambda value: {**original(value), "model_profile_id": "chat-model"})
    base = app.model_resolver()
    calls = []

    def resolve(**kwargs):
        calls.append(kwargs)
        return {**base, "profile_id": kwargs.get("preferred_profile_id", "default"), "model_name": "聊天文本模型"}

    app.model_resolver = resolve
    ready = app.capabilities(scope, conversation_id=conversation["id"])
    job = app.create(PresentationRequest(topic="复盘", conversation_id=conversation["id"]), scope, "chat-model")
    assert calls == [{"preferred_profile_id": "chat-model"}, {"preferred_profile_id": "chat-model"}]
    assert ready["model_name"] == "聊天文本模型"
    assert job["snapshot"]["model_selection"]["profile_id"] == "chat-model"


@pytest.mark.parametrize("preference", ["image", "disabled", "missing", "text"])
def test_ppt_uses_available_text_model_when_conversation_preference_cannot_write_text(scope, monkeypatch, preference):
    from app.agent import settings
    from app.agent.model_catalog import create_model_connection, get_model_catalog, set_default_model_profile, archive_model_connection
    from app.chat.conversations import create_conversation, get_conversation
    from app.presentations.service import resolve_model

    monkeypatch.setenv("TUANTUAN_SECRET_BACKEND", "memory")
    monkeypatch.setattr(settings, "get_settings", lambda: SimpleNamespace(model_name="", model_base_url=None, model_protocol="auto", openai_api_key=None))
    text = create_model_connection({"name": "Text", "model_base_url": "https://text.test/v1", "model_protocol": "openai", "api_key": "synthetic-text-key", "model_name": "gpt-4.1"})
    profiles = get_model_catalog()["profiles"]
    default = next(item for item in profiles if item["connection_id"] == text["id"])
    set_default_model_profile(default["id"])
    other = create_model_connection({"name": "Other", "model_base_url": "https://other.test/v1", "model_protocol": "auto", "api_key": "synthetic-other-key", "model_name": "gpt-image-2" if preference == "image" else "gpt-6.1-sol"})
    other_profile = next(item for item in get_model_catalog()["profiles"] if item["connection_id"] == other["id"])
    if preference == "disabled":
        archive_model_connection(other["id"])
    preferred = "missing-profile" if preference == "missing" else other_profile["id"]
    conversation = create_conversation("PPT with earlier model preference")
    with db.connect() as conn:
        conn.execute("UPDATE conversations SET model_profile_id=? WHERE id=?", (preferred, conversation["id"]))
    app = service()
    app.model_resolver = resolve_model
    ready = app.capabilities(scope, conversation_id=conversation["id"])
    assert ready["available"] is True, ready
    expected = other_profile if preference == "text" else default
    assert ready["model_name"] == expected["model_name"]
    job = app.create(PresentationRequest(topic="知识分享", conversation_id=conversation["id"]), scope, "purpose-selection")
    assert job["snapshot"]["model_selection"]["profile_id"] == expected["id"]
    assert get_conversation(conversation["id"])["model_profile_id"] == preferred


@pytest.mark.parametrize("selection_source", ["conversation", "chat_default"])
def test_ppt_does_not_fall_back_from_signed_out_subscription(scope, monkeypatch, selection_source):
    from app import chatgpt_subscription
    from app.agent.model_catalog import create_model_connection, get_model_catalog, set_default_model_profile
    from app.chat.conversations import create_conversation
    from app.presentations.service import PresentationUnavailable, resolve_model

    monkeypatch.setenv("TUANTUAN_SECRET_BACKEND", "memory")
    monkeypatch.setattr(chatgpt_subscription, "binding", lambda *_: None)
    commercial = create_model_connection({"name": "Commercial", "model_base_url": "https://text.test/v1",
                                          "model_protocol": "openai", "api_key": "synthetic-text-key",
                                          "model_name": "gpt-4.1"})
    commercial_profile = next(item for item in get_model_catalog()["profiles"] if item["connection_id"] == commercial["id"])
    set_default_model_profile(commercial_profile["id"])
    conversation = create_conversation("PPT with a signed-out subscription")
    app = service()
    app.model_resolver = resolve_model
    assert app.capabilities(scope, conversation_id=conversation["id"])["available"]

    with db.connect() as conn:
        conn.execute("INSERT INTO model_connections (id, name, effective_base_url, protocol, secret_ref, data_boundary) "
                     "VALUES ('subscription', 'ChatGPT', ?, 'responses', 'chatgpt_subscription', 'subscription')",
                     (chatgpt_subscription.API_ROOT,))
        conn.execute("INSERT INTO model_profiles (id, connection_id, model_name, name) "
                     "VALUES ('selected', 'subscription', 'gpt-test', 'ChatGPT')")
        if selection_source == "conversation":
            conn.execute("UPDATE conversations SET model_profile_id='selected' WHERE id=?", (conversation["id"],))
        else:
            conn.execute("UPDATE model_routing_policy SET payload_json=json_set(payload_json, '$.purpose_defaults.chat', 'selected') WHERE id=1")

    assert app.capabilities(scope, conversation_id=conversation["id"])["code"] == "model_unavailable"
    with pytest.raises(PresentationUnavailable):
        app.create(PresentationRequest(topic="知识分享", conversation_id=conversation["id"]), scope, "subscription")
    assert app.jobs.repository.list(scope) == []


def test_chat_list_filters_before_pagination_and_exposes_only_safe_display_fields(scope):
    from app.chat.conversations import create_conversation
    from app.presentations.service import public_presentation
    app = service()
    own, other = create_conversation("当前会话"), create_conversation("另一个会话")
    ids = set()
    for index in range(25):
        job = app.create(PresentationRequest(topic=f"复盘 {index}", conversation_id=own["id"]), scope, f"own-{index}")
        ids.add(job["id"])
    for index in range(105):
        app.jobs.repository.enqueue("ppt.generate", {"conversation_id": other["id"], "topic": "别的会话"}, {}, scope, f"noise-{index}")
    first = app.list(own["id"], scope)
    assert len(first["jobs"]) == 20 and first["next_cursor"]
    second = app.list(own["id"], scope, before=first["next_cursor"])
    assert len(second["jobs"]) == 5 and second["next_cursor"] is None
    assert {job["id"] for job in first["jobs"] + second["jobs"]} == ids
    public = public_presentation(first["jobs"][0])
    assert public["conversation_id"] == own["id"] and public["page_count"] == 8
    assert public["topic"].startswith("复盘")
    assert not {"snapshot", "request", "checkpoint", "execution"} & public.keys()
    with pytest.raises(JobNotFound):
        app.list(other["id"], scope, before=first["next_cursor"])
    with pytest.raises(JobNotFound):
        app.list(999999, scope)
    with use_workspace(2):
        db.init_db()
        create_conversation("另一个账户相同数字 ID")
        assert app.list(own["id"], ExtensionContext.current())["jobs"] == []


def test_idempotent_create_and_conflicting_content(scope):
    app = service()
    first = app.create(PresentationRequest(topic="季度复盘"), scope, "same")
    assert app.create(PresentationRequest(topic="季度复盘"), scope, "same")["id"] == first["id"]
    with pytest.raises(JobConflict):
        app.create(PresentationRequest(topic="不同主题"), scope, "same")


def test_create_rejects_missing_sources_and_foreign_conversation(scope):
    app = service()
    with pytest.raises(JobNotFound):
        app.create(PresentationRequest(topic="复盘", attachment_ids=["a" * 32]), scope, "source")
    with pytest.raises(JobNotFound):
        app.create(PresentationRequest(topic="复盘", conversation_id=99999), scope, "conversation")
    assert app.jobs.repository.list(scope) == []


def test_service_only_exposes_presentation_jobs(scope):
    app = service()
    other = app.jobs.repository.enqueue("test", {}, {}, scope, "other")
    with pytest.raises(JobNotFound):
        app.get(other["id"], scope)
    with pytest.raises(JobNotFound):
        app.cancel(other["id"], scope)
    assert app.jobs.repository.get(other["id"], scope)["status"] == "queued"


def test_legacy_model_failure_exposes_actionable_reason_without_upstream_body(scope):
    from app.presentations.service import public_presentation
    app = service()
    job = app.create(PresentationRequest(topic="复盘"), scope, "legacy-model-failure")
    claimed = app.jobs.repository.claim(scope)
    app.jobs.repository.checkpoint(job["id"], claimed["owner_token"], {"stage": "sources_ready"}, scope)
    app.jobs.repository.release(job["id"], claimed["owner_token"], "failed", "ModelProviderError：任务执行失败", scope)
    with db.connect() as conn:
        conn.execute("INSERT INTO model_service_events(request_kind,status,error_code,error_message,run_id) VALUES('generate','error','authentication_failed','raw upstream body must remain private',?)", (job["id"],))
    public = public_presentation(app.get(job["id"], scope))
    assert public["error_code"] == "authentication_failed"
    assert "认证失败" in public["error"] and "模型设置" in public["error"]
    assert "raw upstream" not in str(public)


def test_model_failure_never_reads_another_jobs_diagnostic_event(scope):
    from app.presentations.service import public_presentation
    app = service()
    first = app.create(PresentationRequest(topic="一"), scope, "first-failure")
    second = app.create(PresentationRequest(topic="二"), scope, "second-failure")
    with db.connect() as conn:
        conn.execute("INSERT INTO model_service_events(request_kind,status,error_code,run_id) VALUES('generate','error','authentication_failed',?)", (second["id"],))
    first.update(status="failed", error="ModelProviderError：任务执行失败")
    public = public_presentation(first)
    assert public["error_code"] == ""


def test_preparation_gate_and_hosted_block_before_creation(scope, monkeypatch):
    app = service()
    app.preparation_enabled = lambda: False
    with pytest.raises(JobConflict, match="确认流程"):
        app.create(PresentationRequest(topic="复盘"), scope, "disabled")
    app.preparation_enabled = lambda: True
    monkeypatch.setenv("TUANTUAN_DEPLOYMENT_MODE", "hosted")
    with pytest.raises(JobConflict, match="本地"):
        app.create(PresentationRequest(topic="复盘"), scope, "hosted")
    assert app.jobs.repository.list(scope) == []


def test_unbound_or_image_only_model_is_rejected(scope):
    app = service()
    for connection in [{}, {"profile_id": "p", "profile_revision": 1, "connection_id": "c",
                            "connection_revision": 1, "resolved_model_protocol": "images"}]:
        app.model_resolver = lambda **_: connection
        with pytest.raises(JobConflict, match="模型"):
            app.create(PresentationRequest(topic="复盘"), scope, "invalid")
    assert app.jobs.repository.list(scope) == []


def test_public_view_omits_checkpoint_paths_and_confirmation_receipts(scope):
    from app.presentations.service import public_presentation
    app = service()
    job = app.create(PresentationRequest(topic="复盘"), scope, "public")
    claimed = app.jobs.repository.claim(scope)
    app.jobs.repository.checkpoint(job["id"], claimed["owner_token"], {
        "stage": "stage1_recommended", "manifest_path": "private/path.json", "secret": "private"}, scope)
    waiting = app.jobs.repository.wait_for_user(job["id"], claimed["owner_token"], "确认需求", {}, scope)
    public = public_presentation(waiting)
    assert public["stage"] == "stage1_recommended" and public["confirmation_required"] is True
    assert not {"checkpoint", "execution", "snapshot", "confirmation", "owner_token"} & public.keys()
    assert "private" not in str(public)


def test_cross_account_task_is_not_found(scope):
    app = service()
    job = app.create(PresentationRequest(topic="复盘"), scope, "own")
    with use_workspace(2):
        db.init_db()
        with pytest.raises(JobNotFound):
            app.get(job["id"], ExtensionContext.current())


def test_production_runtime_is_checked_before_creating_a_billable_job(scope, monkeypatch):
    app = service()
    app.runtime_loader().manifest["files"].clear()
    monkeypatch.setenv("TUANTUAN_PPT_PREPARATION_ENABLED", "true")
    monkeypatch.setenv("TUANTUAN_PPT_GENERATION_ENABLED", "true")
    with pytest.raises(JobConflict, match="制作运行资源"):
        app.create(PresentationRequest(topic="季度复盘"), scope, "old-runtime")
    assert app.jobs.repository.list(scope) == []


def test_production_public_stage_preserves_allowlist(scope):
    from app.presentations.service import public_presentation
    app = service()
    job = app.create(PresentationRequest(topic="复盘"), scope, "production-status")
    claimed = app.jobs.repository.claim(scope)
    app.jobs.repository.checkpoint(job["id"], claimed["owner_token"], {
        "stage": "final_confirmed", "production": {"stage": "page_3_ready", "manifest_path": "private/project"},
    }, scope)
    public = public_presentation(app.get(job["id"], scope))
    assert public["stage"] == "page_3_ready"
    assert "private" not in str(public)


@pytest.mark.parametrize("tampered", [False, True])
def test_legacy_failed_design_plan_is_diagnosed_from_its_own_verified_output(scope, tampered):
    import hashlib
    from app.execution.workspace_files import WorkspaceFiles
    from app.presentations.model_ledger import ModelCallLedger
    from app.presentations.service import public_presentation
    from app.workspace import current_workspace_root

    app = service()
    job = app.create(PresentationRequest(topic="面向初学者制作知识分享"), scope, "legacy-invalid-design")
    claimed = app.jobs.repository.claim(scope)
    ledger = ModelCallLedger(app.jobs.repository)
    request_id = ledger.reserve(job["id"], claimed["owner_token"], "design_spec", scope)
    content = b'{"design_spec":"# Need a specific topic", "slides":[]}'
    root = current_workspace_root() / "jobs" / job["id"]
    files = WorkspaceFiles(root)
    files.write(f"model_responses/{request_id}.json", b'{}' if tampered else content)
    ledger.complete(request_id, claimed["owner_token"], hashlib.sha256(content).hexdigest(), {}, scope)
    app.jobs.repository.checkpoint(job["id"], claimed["owner_token"], {"stage": "final_confirmed"}, scope)
    app.jobs.repository.release(job["id"], claimed["owner_token"], "failed", "ValueError：任务执行失败", scope)
    public = public_presentation(app.get(job["id"], scope))
    assert public["error_code"] == ("" if tampered else "presentation_plan_invalid")
    assert "model_responses" not in str(public)
    if not tampered:
        assert "主题" in public["error"] and "ValueError" not in public["error"]


def test_failed_job_exposes_precise_model_failure_stage(scope):
    from app.presentations.service import public_presentation
    app = service()
    job = app.create(PresentationRequest(topic="智能体架构设计讲解"), scope, "stage-label")
    claimed = app.jobs.repository.claim(scope)
    with db.connect() as conn:
        conn.execute(
            "INSERT INTO model_service_events(request_kind,status,error_code,error_message,model_name,base_url,protocol,stage,run_id,call_id,backend) "
            "VALUES('ppt.generate','error','provider_error','模型服务返回异常状态（524）','gpt-6.1-sol','https://www.fastaitoken.com/v1','openai','ppt.retry9.design_spec',?,?, 'litellm')",
            (job["id"], "e" * 32))
    app.jobs.repository.checkpoint(job["id"], claimed["owner_token"], {"stage": "final_confirmed", "model_error_code": "provider_error"}, scope)
    app.jobs.repository.release(job["id"], claimed["owner_token"], "failed", "模型服务返回异常状态（524）", scope)
    public = public_presentation(app.get(job["id"], scope))
    assert public["error_code"] == "provider_error"
    assert public["error_stage"] == "design_spec"
    assert public["error"].startswith("模型服务发生异常")


def test_output_failure_has_no_model_stage_label(scope):
    from app.presentations.service import public_presentation
    app = service()
    job = app.create(PresentationRequest(topic="季度复盘"), scope, "output-failure")
    claimed = app.jobs.repository.claim(scope)
    app.jobs.repository.checkpoint(job["id"], claimed["owner_token"], {"stage": "final_confirmed", "presentation_error_code": "presentation_plan_invalid"}, scope)
    app.jobs.repository.release(job["id"], claimed["owner_token"], "failed", "ValueError：任务执行失败", scope)
    public = public_presentation(app.get(job["id"], scope))
    assert public["error_stage"] == ""
