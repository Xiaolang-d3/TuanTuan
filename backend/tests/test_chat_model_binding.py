from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app import db
from app.chat import execution
from app.db import connect
from app.domain import AgentClarification, AgentRunResult, AgentRunSnapshot, AgentStreamEvent, ClarificationOption
from app.main import app
from app.secret_store import SecretStoreUnavailable
from api_client import create_authenticated_client


def selection(profile_id="account-default", revision=1):
    return {
        "profile_id": profile_id, "profile_revision": revision,
        "connection_id": "connection-one", "connection_revision": 1,
        "model_name": "test-model", "model_base_url": "https://model.example.test/v1",
        "model_protocol": "openai", "secret_ref": "memory:fake-private-reference",
    }


class BoundRuntime:
    def __init__(self, binding):
        self.model_selection = binding
        self.calls = []
        self.inputs = []

    async def run_stream(self, *args, **kwargs):
        self.calls.append(kwargs)
        self.inputs.append(args[0])
        yield AgentStreamEvent(type="completed", result=AgentRunResult(
            content="完成回答", provider=self.model_selection["profile_id"], platform="manual", rounds=1,
            model_selection=kwargs["model_selection"],
        ))


class ChatModelBindingTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.original_db_path = db.DB_PATH
        db.DB_PATH = Path(self.temp_dir.name) / "chat-bindings.db"
        db.init_db()
        self.client = create_authenticated_client(app)
        self.conversation = self.client.post("/conversations", json={"title": "模型绑定测试"}).json()

    def tearDown(self):
        self.client.close()
        db.DB_PATH = self.original_db_path
        self.temp_dir.cleanup()

    def stream(self, run_id, forwarded=None, content="你好"):
        return self.client.post("/ag-ui", json={
            "threadId": str(self.conversation["id"]), "runId": run_id, "state": {},
            "messages": [{"id": f"user-{run_id}", "role": "user", "content": content}],
            "tools": [], "context": [], "forwardedProps": forwarded or {},
        })

    def test_request_override_inherit_and_explicit_null_capture_one_runtime(self):
        # Patch the conversation lookup so this test isolates selection precedence.
        conversation = {**self.conversation, "model_profile_id": "conversation-model"}
        resolved = []
        runtimes = []

        def resolve(profile_id=None, **kwargs):
            resolved.append((profile_id, kwargs))
            runtime = BoundRuntime(selection(profile_id or "account-default"))
            runtimes.append(runtime)
            return runtime

        with patch.object(execution, "require_conversation", return_value=conversation), patch.object(execution, "get_agent_runtime", side_effect=resolve):
            for run_id, props in (
                ("inherit", {}), ("override", {"modelProfileId": "explicit-model"}),
                ("default", {"modelProfileId": None}),
            ):
                response = self.stream(run_id, props)
                self.assertEqual(response.status_code, 200)
        self.assertEqual([item[0] for item in resolved], ["conversation-model", "explicit-model", None])
        self.assertEqual([len(runtime.calls) for runtime in runtimes], [1, 1, 1])
        self.assertEqual(
            [runtime.calls[0]["model_selection"]["selection_reason"] for runtime in runtimes],
            ["conversation_profile", "explicit_profile", "default_profile"],
        )

    def test_public_history_and_stream_remove_secret_reference(self):
        runtime = BoundRuntime(selection())
        with patch.object(execution, "get_agent_runtime", return_value=runtime) as resolve:
            response = self.stream("public-binding")
        self.assertEqual(response.status_code, 200)
        resolve.assert_called_once_with(None, selection=None, user_content="你好", has_image_input=False, allow_chatgpt_subscription=True)
        self.assertNotIn("secret_ref", response.text)
        messages = self.client.get(f"/chat/messages?conversation_id={self.conversation['id']}").json()
        agent = messages[-1]["payload"]["agent"]
        self.assertEqual(agent["model_selection"]["profile_id"], "account-default")
        self.assertNotIn("secret_ref", json.dumps(agent))

    def test_image_request_passes_intent_before_binding_and_keeps_routing_reason(self):
        binding = {**selection("image-model"), "model_name": "gpt-image-2", "selection_reason": "image_intent"}
        runtime = BoundRuntime(binding)
        prompt = "生成一张小猫玩小鱼玩具图"
        with patch.object(execution, "get_agent_runtime", return_value=runtime) as resolve:
            response = self.stream("auto-image", {"modelProfileId": "chat-model"}, content=prompt)
        self.assertEqual(response.status_code, 200)
        resolve.assert_called_once_with("chat-model", selection=None, user_content=prompt, has_image_input=False, allow_chatgpt_subscription=True)
        self.assertEqual(runtime.calls[0]["model_selection"]["selection_reason"], "image_intent")
        self.assertEqual(runtime.calls[0]["model_selection"]["profile_id"], "image-model")

    def test_repeat_resolves_before_binding_but_preserves_visible_user_text_and_replay(self):
        binding = {**selection("image-model"), "selection_reason": "image_intent"}
        runtime = BoundRuntime(binding)
        prompt = "生成一张图片，画面是小猫玩小鱼玩具。"
        with patch.object(execution, "resolve_image_followup", return_value=prompt) as followup, patch.object(execution, "get_agent_runtime", return_value=runtime) as resolve:
            response = self.stream("repeat-image", content="再生成一张")
            self.assertEqual(response.status_code, 200)
            followup.assert_called_once_with("再生成一张", self.conversation["id"])
            resolve.assert_called_once_with(None, selection=None, user_content=prompt, has_image_input=False, allow_chatgpt_subscription=True)
            replay = self.stream("repeat-image", content="改成其他内容")
            self.assertEqual(replay.status_code, 200)
            self.assertEqual(followup.call_count, 1)
            self.assertEqual(resolve.call_count, 1)
        self.assertEqual(runtime.inputs, [prompt])
        self.assertEqual(runtime.calls[0]["model_selection"]["selection_reason"], "image_intent")
        messages = self.client.get(f"/chat/messages?conversation_id={self.conversation['id']}").json()
        self.assertEqual(messages[0]["content"], "再生成一张")
        self.assertEqual(len(messages), 2)

    def test_waiting_resume_uses_original_versions_despite_explicit_new_model(self):
        binding = selection("original-model", revision=1)
        snapshot = AgentRunSnapshot(
            route_kind="conversation", needs_plan=False, model_selection=binding,
            clarification=AgentClarification(question="怎么继续", options=[ClarificationOption(id="one", label="继续", send="继续")]),
        )
        with patch.object(execution, "load_run_snapshot", return_value=snapshot), patch.object(execution, "get_agent_runtime", return_value=BoundRuntime(binding)) as resolve:
            response = self.stream("resume-waiting", {"modelProfileId": "new-model"}, content="继续")
        self.assertEqual(response.status_code, 200)
        resolve.assert_called_once_with(None, selection=binding, user_content=None, has_image_input=False, allow_chatgpt_subscription=True)

    def test_removed_historical_version_fails_before_saving_a_user_turn(self):
        snapshot = AgentRunSnapshot(route_kind="conversation", needs_plan=False, model_selection=selection(), resume_mode="checkpoint")
        with patch.object(execution, "load_run_snapshot", return_value=snapshot), patch.object(execution, "get_agent_runtime", side_effect=ValueError("运行快照引用的模型版本不存在，无法恢复")):
            response = self.stream("missing-version", content="继续")
        self.assertEqual(response.status_code, 400)
        messages = self.client.get(f"/chat/messages?conversation_id={self.conversation['id']}").json()
        self.assertEqual(messages, [])

    def test_unavailable_historical_credential_has_actionable_http_error(self):
        with patch.object(execution, "get_agent_runtime", side_effect=SecretStoreUnavailable("运行绑定的模型凭证已改变，无法恢复原配置")):
            response = self.stream("missing-credential")
        self.assertEqual(response.status_code, 503)
        self.assertIn("凭证已改变", response.json()["detail"])
        self.assertEqual(self.client.get(f"/chat/messages?conversation_id={self.conversation['id']}").json(), [])
