"""Subscription-marked selections must never use a commercial auxiliary provider."""
from types import SimpleNamespace
from unittest.mock import Mock

import pytest

from app import db
from app.agent import bootstrap, model_catalog
from app.agent.kernels.base import KernelUnavailable
from app.agent.kernels.dsh import adapter, manager
from app.agent.memory import service as memory
from app.chat.conversations import create_conversation
from app.feeds import digest
from app.jobs.repository import JobExecutionError
from app.library import document_review
from app.models import litellm_router
from app.presentations import model_runner, service as presentations


SUBSCRIPTION = "chatgpt_subscription"
SELECTION = {"profile_id": "p", "profile_revision": 1, "connection_id": "c", "connection_revision": 1}


@pytest.mark.parametrize("marker", ["auth_kind", "secret_ref"])
def test_model_boundaries_block_subscription_even_with_a_key(monkeypatch, tmp_path, marker):
    connection = {**SELECTION, marker: SUBSCRIPTION, "api_key": "commercial-key",
                  "api_key_configured": True, "model_name": "gpt-test",
                  "resolved_model_protocol": "responses", "model_base_url": "https://api.openai.com/v1"}
    monkeypatch.setattr(model_catalog, "get_profile_connection", lambda *a, **kw: connection)
    monkeypatch.setattr(bootstrap, "get_profile_connection", lambda *a, **kw: connection)

    with pytest.raises(ValueError, match="ChatGPT"):
        digest.validate_profile("p")
    with pytest.raises(ValueError, match="ChatGPT"):
        digest._request_model(connection, "news", stage="curation")
    with pytest.raises(ValueError, match="ChatGPT"):
        document_review._provider(connection)
    with pytest.raises(ValueError, match="ChatGPT"):
        model_runner.build_bound_provider(SELECTION)
    with pytest.raises(presentations.PresentationUnavailable, match="ChatGPT"):
        presentations.PresentationService(None, model_resolver=lambda: connection)._model()
    with pytest.raises(KernelUnavailable, match="ChatGPT"):
        adapter.build_dsh_runtime(SimpleNamespace(model_selection=SELECTION))
    with pytest.raises(KernelUnavailable, match="ChatGPT"):
        manager.build_dsh_launch(connection, patch_path=tmp_path / "patch.yml")
    with pytest.raises(ValueError, match="ChatGPT"):
        memory._build_provider(connection)


def test_dsh_cannot_reuse_commercial_session_for_subscription():
    runtime = manager.DshRuntimeManager()
    runtime._sessions[manager._session_key(7)] = SimpleNamespace(client=SimpleNamespace(running=True))
    with pytest.raises(KernelUnavailable, match="ChatGPT"):
        runtime.acquire(7, {"auth_kind": SUBSCRIPTION})


def test_litellm_bypasses_fallbacks_from_subscription_and_skips_subscription_candidates(monkeypatch):
    primary = object()
    load = Mock(return_value={"auth_kind": SUBSCRIPTION, "api_key": "commercial-key",
                              "model_name": "gpt-test", "resolved_model_protocol": "responses"})
    build = Mock(side_effect=AssertionError("should not instantiate LiteLLM"))
    monkeypatch.setattr(litellm_router, "LiteLLMProvider", build)
    policy = {"fallback_profile_ids": ["fallback"], "content_policy_profile_ids": ["fallback"]}
    assert litellm_router.build_routed_provider(primary, {"auth_kind": SUBSCRIPTION}, policy,
                                               timeout_seconds=1, load_profile=load) is primary
    load.assert_not_called()
    assert litellm_router.build_routed_provider(primary, SELECTION, policy,
                                               timeout_seconds=1, load_profile=load) is primary
    load.assert_called_once_with("fallback")
    build.assert_not_called()


@pytest.mark.parametrize("marker_location", ["snapshot", "current", "resolved_snapshot"])
def test_review_resume_rejects_subscription_before_provider_factory(monkeypatch, marker_location):
    monkeypatch.setattr(document_review, "_source", lambda request: (None, {}, {}, False))
    selection = dict(SELECTION)
    current = dict(SELECTION)
    bound = dict(SELECTION)
    if marker_location == "snapshot":
        selection["secret_ref"] = SUBSCRIPTION
    elif marker_location == "current":
        current["auth_kind"] = SUBSCRIPTION
    else:
        bound["auth_kind"] = SUBSCRIPTION
    resolver = Mock(side_effect=lambda profile_id=None, *, selection=None: bound if selection else current)
    handler = document_review.DocumentReviewHandler(connection_resolver=resolver)
    job = {"request": {}, "snapshot": {"grants": ["documents.review.v1"], "model_selection": selection}}
    with pytest.raises(JobExecutionError, match="ChatGPT"):
        handler.validate_resume(job, SimpleNamespace(check_workspace=lambda: None))
    if marker_location == "snapshot":
        resolver.assert_not_called()


@pytest.mark.parametrize("selection_source", ["conversation", "workspace_default", "latest_run"])
def test_memory_skips_raw_subscription_without_resolving_any_key(tmp_path, monkeypatch, selection_source):
    path = tmp_path / "memory.db"
    db.init_db(path)
    cid = create_conversation(db_path=path)["id"]
    with db.connect(path) as conn:
        conn.execute("INSERT INTO model_connections (id, name, effective_base_url, secret_ref, data_boundary) "
                     "VALUES ('subscription', 'ChatGPT', 'https://api.openai.com/v1', ?, 'subscription')", (SUBSCRIPTION,))
        conn.execute("INSERT INTO model_profiles (id, connection_id, model_name, name) "
                     "VALUES ('selected', 'subscription', 'gpt-test', 'ChatGPT')")
        if selection_source == "conversation":
            conn.execute("UPDATE conversations SET model_profile_id='selected' WHERE id=?", (cid,))
        elif selection_source == "workspace_default":
            conn.execute("UPDATE agent_settings SET default_model_profile_id='selected' WHERE id=1")
        else:
            conn.execute("INSERT INTO agent_execution_runs (run_id, conversation_id, status, model_selection_json) "
                         "VALUES ('run', ?, 'completed', ?)", (cid, db.json_dump({"secret_ref": SUBSCRIPTION})))
        conn.executemany("INSERT INTO chat_messages (conversation_id, role, content) VALUES (?, 'user', 'message')",
                         [(cid,)] * memory.EXTRACT_EVERY_MESSAGES)

    resolve = Mock(return_value={"model_name": "commercial", "api_key": "commercial-key"})
    generate = Mock()
    monkeypatch.setattr(memory, "get_agent_settings", lambda _: {"user_memory_enabled": True})
    monkeypatch.setattr(memory, "get_model_connection", resolve)
    assert not memory.memory_extraction_due(cid, db_path=path)
    assert memory.extract_from_conversation(cid, db_path=path) == 0
    assert memory.extract_from_conversation(cid, db_path=path, generate=generate) == 0
    resolve.assert_not_called()
    generate.assert_not_called()
