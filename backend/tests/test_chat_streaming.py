from __future__ import annotations

import asyncio
import base64
import json
import tempfile
import unittest
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from app import db
import app.attachments.service as attachments_module
import app.api.attachments as resources_module
import app.chat.execution as main_module
from app.agent.snapshots import load_run_snapshot, save_run_snapshot
from app.agent.run_store import AgentRunStore
from app.chat.conversations import create_conversation, ensure_active_task
from app.domain import AgentClarification, AgentMessage, AgentRunResult, AgentRunSnapshot, AgentStreamEvent, ClarificationOption, ToolError
from app.main import app
from app.search_options import WebSearchOptions
from app.chat.execution import _active_chat_runs, _chat_run_key, cancel_current_agent_task
from app.chat.service import save_chat_message, with_attachment_context
from api_client import create_authenticated_client


class ChatStreamingApiTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.original_db_path = db.DB_PATH
        db.DB_PATH = Path(self.temp_dir.name) / "streaming.db"
        db.init_db()
        self.client = create_authenticated_client(app)

    def tearDown(self) -> None:
        self.client.close()
        db.DB_PATH = self.original_db_path
        self.temp_dir.cleanup()

    def run_ag_ui(self, conversation_id: int, content: str, run_id: str, *, forwarded: dict | None = None) -> list[dict]:
        with self.client.stream("POST", "/ag-ui", json={
            "threadId": str(conversation_id), "runId": run_id, "state": {},
            "messages": [{"id": f"user-{run_id}", "role": "user", "content": content}],
            "tools": [], "context": [], "forwardedProps": forwarded or {},
        }) as response:
            self.assertEqual(response.status_code, 200)
            return [json.loads(line.removeprefix("data: ")) for line in response.iter_lines() if line.startswith("data: ")]

    def with_runtime(self, runtime, action):
        original = main_module.get_agent_runtime
        main_module.get_agent_runtime = lambda *args, **kwargs: runtime
        try:
            return action()
        finally:
            main_module.get_agent_runtime = original

    def test_clarification_restores_a_legacy_attachment_preview_before_runtime(self) -> None:
        cid = self.client.post("/conversations", json={"title": "附件续接"}).json()["id"]
        text = "前页内容。" * 300 + "\n第二页项目：负责工具编排与中断恢复。"
        uploaded = self.client.post("/attachments", data={"conversation_id": str(cid), "kind": "document"},
                                    files={"file": ("source.txt", text.encode(), "text/plain")})
        self.assertEqual(uploaded.status_code, 200)
        attachment = self.client.post(f"/attachments/{uploaded.json()['id']}/parse").json()
        save_chat_message("user", "分析附件", {"attachments": [{"id": attachment["id"]}]}, cid)
        full = with_attachment_context("分析附件", f"[脱敏资料：source.txt]\n{attachment['redacted_text']}")
        save_run_snapshot(cid, AgentRunSnapshot(route_kind="conversation", needs_plan=False,
            messages=[AgentMessage(role="user", content=full[:1000])],
            clarification=AgentClarification(question="项目属于哪类？")))
        captured = []
        class Runtime:
            async def run_stream(self, *args, **kwargs):
                captured.append(kwargs["resume"])
                yield AgentStreamEvent(type="completed", result=AgentRunResult(
                    content="已收到第二页", provider="test", platform="manual", rounds=1))
        self.with_runtime(Runtime(), lambda: self.run_ag_ui(cid, "个人项目", "attachment-restored", forwarded={"webSearch": False}))
        self.assertEqual(captured[0].messages[0].content, full)
        self.assertIn("第二页项目", captured[0].messages[0].content)

    def test_ag_ui_rejects_invalid_search_contract_values_with_422(self) -> None:
        conversation = self.client.post("/conversations", json={"title": "参数校验"}).json()
        for fields in [{"webSearch": "true"}, {"webSearchTopic": "company"}, {"webSearchProvider": "unknown"},
                       {"webSearchSourcePreference": "official"}, {"webSearchMode": "finance"}]:
            with self.subTest(fields=fields):
                response = self.client.post("/ag-ui", json={
                    "threadId": str(conversation["id"]), "runId": "invalid-search", "state": {},
                    "messages": [{"id": "user", "role": "user", "content": "问题"}],
                    "tools": [], "context": [], "forwardedProps": fields,
                })
                self.assertEqual(response.status_code, 422)

    def test_new_turns_resolve_automatic_search_without_transport_flags(self) -> None:
        captured = []
        class Runtime:
            async def run_stream(self, *args, **kwargs):
                captured.append(kwargs["web_search_options"])
                yield AgentStreamEvent(type="completed", result=AgentRunResult(
                    content="普通回答", provider="test", platform="manual", rounds=1,
                ))
        for enabled, forwarded, expected in [(True, {}, True), (False, {}, False), (True, {"webSearch": False}, False)]:
            with self.subTest(enabled=enabled, forwarded=forwarded):
                conversation = self.client.post("/conversations", json={"title": "自动搜索"}).json()
                settings = SimpleNamespace(web_research_enabled=enabled, resolved_web_search_provider="tavily")
                with patch.object(main_module, "get_settings", return_value=settings):
                    self.with_runtime(Runtime(), lambda: self.run_ag_ui(conversation["id"], "你好", f"auto-{conversation['id']}", forwarded=forwarded))
                self.assertEqual(captured[-1].enabled, expected)
                self.assertEqual((captured[-1].topic, captured[-1].source_preference), ("auto", "none"))
                messages = self.client.get(f"/chat/messages?conversation_id={conversation['id']}").json()
                self.assertEqual(messages[-2]["payload"]["web_search_options"]["enabled"], expected)

    def test_confirmation_inherits_search_options_and_explicit_false_is_preserved(self) -> None:
        conversation = self.client.post("/conversations", json={"title": "搜索配置继承"}).json()
        original = WebSearchOptions(enabled=True, topic="finance", source_preference="technical", provider="tavily")
        captured = []
        class Runtime:
            async def run_stream(self, *args, **kwargs):
                captured.append(kwargs["web_search_options"])
                yield AgentStreamEvent(type="completed", result=AgentRunResult(
                    content="完成", provider="test", platform="manual", rounds=1,
                ))
        def pause():
            save_run_snapshot(conversation["id"], AgentRunSnapshot(
                route_kind="web_search", needs_plan=True, allowed_tools=["search_public_web"], web_search_options=original,
                clarification=AgentClarification(question="继续？", options=[ClarificationOption(label="继续")]),
            ))
        with patch.object(main_module, "get_settings", return_value=SimpleNamespace(resolved_web_search_provider="tavily")):
            pause()
            self.with_runtime(Runtime(), lambda: self.run_ag_ui(conversation["id"], "继续", "inherited-search"))
            self.assertEqual(captured[-1], original)
            pause()
            self.with_runtime(Runtime(), lambda: self.run_ag_ui(conversation["id"], "继续", "disabled-search",
                              forwarded={"webSearch": False, "webSearchTopic": "auto", "webSearchSourcePreference": "none"}))
        self.assertFalse(captured[-1].enabled)
        self.assertEqual((captured[-1].topic, captured[-1].source_preference), ("auto", "none"))
        messages = self.client.get(f"/chat/messages?conversation_id={conversation['id']}").json()
        self.assertEqual(messages[-2]["payload"]["web_search_options"], captured[-1].model_dump())

    def test_provider_change_and_unsupported_capability_fail_before_new_messages(self) -> None:
        conversation = self.client.post("/conversations", json={"title": "服务能力校验"}).json()
        save_run_snapshot(conversation["id"], AgentRunSnapshot(
            route_kind="web_search", needs_plan=True, allowed_tools=["search_public_web"],
            web_search_options=WebSearchOptions(enabled=True, topic="news", provider="tavily"),
        ))
        with patch.object(main_module, "get_settings", return_value=SimpleNamespace(resolved_web_search_provider="agent_search")):
            response = self.client.post("/ag-ui", json={
                "threadId": str(conversation["id"]), "runId": "changed-provider", "state": {},
                "messages": [{"id": "user", "role": "user", "content": "继续"}],
                "tools": [], "context": [], "forwardedProps": {},
            })
            self.assertEqual(response.status_code, 409)
            self.assertIn("搜索服务", response.json()["detail"])
            response = self.client.post("/ag-ui", json={
                "threadId": str(conversation["id"]), "runId": "unsupported-finance", "state": {},
                "messages": [{"id": "user", "role": "user", "content": "换个话题，查金融市场"}],
                "tools": [], "context": [], "forwardedProps": {"webSearch": True, "webSearchTopic": "finance"},
            })
            self.assertEqual(response.status_code, 422)
        messages = self.client.get(f"/chat/messages?conversation_id={conversation['id']}").json()
        self.assertEqual(messages, [])

    def test_terminal_result_backfill_does_not_require_current_provider_or_model(self) -> None:
        conversation = self.client.post("/conversations", json={"title": "结果补写"}).json()
        options = WebSearchOptions(enabled=True, topic="finance", provider="tavily")
        user = save_chat_message("user", "原任务", {"web_search_options": options.model_dump()}, conversation["id"])
        store = AgentRunStore()
        store.start_run("terminal-backfill", conversation_id=conversation["id"], task_id=None,
                        user_content="原任务", web_search_options=options)
        store.bind_messages("terminal-backfill", user_message_id=user["id"])
        store.finish("terminal-backfill", AgentRunResult(content="已完成原搜索", provider="test", platform="manual", rounds=1))
        with patch.object(main_module, "get_settings", return_value=SimpleNamespace(resolved_web_search_provider="agent_search")), \
             patch.object(main_module, "get_agent_runtime", side_effect=AssertionError("已完成结果不应初始化模型")):
            events = self.run_ag_ui(conversation["id"], "重连", "terminal-backfill", forwarded={"webSearch": False})
        self.assertEqual("".join(event["delta"] for event in events if event["type"] == "TEXT_MESSAGE_CONTENT"), "已完成原搜索")
        messages = self.client.get(f"/chat/messages?conversation_id={conversation['id']}").json()
        self.assertEqual(len(messages), 2)
        self.assertEqual(messages[0]["payload"]["web_search_options"], options.model_dump())

    def test_new_retry_expected_provider_cannot_silently_switch_services(self) -> None:
        conversation = self.client.post("/conversations", json={"title": "重试绑定"}).json()
        with patch.object(main_module, "get_settings", return_value=SimpleNamespace(resolved_web_search_provider="agent_search")):
            response = self.client.post("/ag-ui", json={
                "threadId": str(conversation["id"]), "runId": "retry-new-id", "state": {},
                "messages": [{"id": "user", "role": "user", "content": "原任务"}],
                "tools": [], "context": [], "forwardedProps": {
                    "webSearch": True, "webSearchTopic": "general", "webSearchProvider": "tavily",
                },
            })
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.client.get(f"/chat/messages?conversation_id={conversation['id']}").json(), [])

    def test_ag_ui_emits_lifecycle_text_state_and_persists_messages(self) -> None:
        conversation = self.client.post("/conversations", json={"title": "流式测试"}).json()

        class Runtime:
            async def run_stream(self, *args, **kwargs):
                yield AgentStreamEvent(type="text_delta", delta="基于本地资料")
                yield AgentStreamEvent(type="text_delta", delta="完成回答。")
                yield AgentStreamEvent(type="completed", result=AgentRunResult(
                    content="基于本地资料完成回答。", provider="test", platform="manual", rounds=1,
                ))

        events = self.with_runtime(Runtime(), lambda: self.run_ag_ui(conversation["id"], "总结我的资料", "run-lifecycle"))
        types = [event["type"] for event in events]
        self.assertEqual(types[0], "RUN_STARTED")
        self.assertIn("TEXT_MESSAGE_START", types)
        self.assertIn("TEXT_MESSAGE_CONTENT", types)
        self.assertIn("STATE_SNAPSHOT", types)
        self.assertEqual(types[-1], "RUN_FINISHED")
        text = "".join(event["delta"] for event in events if event["type"] == "TEXT_MESSAGE_CONTENT")
        self.assertEqual(text, "基于本地资料完成回答。")
        messages = self.client.get(f"/chat/messages?conversation_id={conversation['id']}").json()
        self.assertEqual([message["role"] for message in messages], ["user", "assistant"])

    def test_ag_ui_emits_server_start_before_text_and_persists_terminal_duration(self) -> None:
        conversation = self.client.post("/conversations", json={"title": "运行用时"}).json()

        class Runtime:
            async def run_stream(self, *args, **kwargs):
                yield AgentStreamEvent(type="text_delta", delta="回答")
                yield AgentStreamEvent(type="completed", result=AgentRunResult(
                    content="回答", provider="test", platform="manual", rounds=1,
                ))

        started_at = "2026-10-11T00:00:00.125+00:00"
        completed_at = "2026-10-11T00:06:29.125+00:00"
        with patch("app.agent.run_store._utc_now", side_effect=[started_at, completed_at]):
            first = self.with_runtime(Runtime(), lambda: self.run_ag_ui(conversation["id"], "计时", "run-timing"))
        timing_index = next(index for index, event in enumerate(first) if event.get("name") == "tuantuan.run_timing")
        text_index = next(index for index, event in enumerate(first) if event["type"] == "TEXT_MESSAGE_CONTENT")
        self.assertLess(timing_index, text_index)
        self.assertEqual(first[timing_index]["value"], {"run_id": "run-timing", "started_at": started_at})
        snapshot = next(event["snapshot"] for event in first if event["type"] == "STATE_SNAPSHOT")
        agent = snapshot["tuantuan"]["assistantMessage"]["payload"]["agent"]
        self.assertEqual(agent["started_at"], started_at)
        self.assertEqual(agent["completed_at"], completed_at)
        self.assertEqual(agent["duration_ms"], 389000)
        messages = self.client.get(f"/chat/messages?conversation_id={conversation['id']}").json()
        self.assertEqual(messages[-1]["payload"]["agent"]["duration_ms"], 389000)

        second = self.run_ag_ui(conversation["id"], "计时", "run-timing")
        replay = next(event["snapshot"] for event in second if event["type"] == "STATE_SNAPSHOT")
        self.assertEqual(replay["tuantuan"]["assistantMessage"]["payload"]["agent"]["duration_ms"], 389000)

    def test_ag_ui_requires_user_text(self) -> None:
        conversation = self.client.post("/conversations", json={"title": "空输入"}).json()
        response = self.client.post("/ag-ui", json={
            "threadId": str(conversation["id"]), "runId": "run-empty", "state": {},
            "messages": [], "tools": [], "context": [], "forwardedProps": {},
        })
        self.assertEqual(response.status_code, 422)

    def test_agent_failure_uses_stable_run_error(self) -> None:
        conversation = self.client.post("/conversations", json={"title": "失败"}).json()

        class Runtime:
            async def run_stream(self, *args, **kwargs):
                yield AgentStreamEvent(type="completed", result=AgentRunResult(
                    content="模型服务认证失败。", provider="test", platform="manual", rounds=1,
                    status="failed", error=ToolError(code="authentication_failed", message="模型服务认证失败"),
                ))

        events = self.with_runtime(Runtime(), lambda: self.run_ag_ui(conversation["id"], "请回答", "run-failed"))
        error = next(event for event in events if event["type"] == "RUN_ERROR")
        self.assertEqual(error["code"], "authentication_failed")
        self.assertNotIn("RUN_FINISHED", [event["type"] for event in events])

    def test_waiting_user_is_reported_in_state_snapshot(self) -> None:
        conversation = self.client.post("/conversations", json={"title": "等待"}).json()

        class Runtime:
            async def run_stream(self, *args, **kwargs):
                yield AgentStreamEvent(type="completed", result=AgentRunResult(
                    content="请确认是否继续。", provider="test", platform="manual", rounds=1,
                    status="waiting_user",
                ))

        events = self.with_runtime(Runtime(), lambda: self.run_ag_ui(conversation["id"], "整理资料", "run-wait"))
        snapshot = next(event["snapshot"] for event in events if event["type"] == "STATE_SNAPSHOT")
        self.assertEqual(snapshot["tuantuan"]["status"], "waiting_user")

    def test_repeated_run_id_replays_without_duplicate_execution(self) -> None:
        conversation = self.client.post("/conversations", json={"title": "幂等"}).json()

        class Runtime:
            def __init__(self):
                self.calls = 0

            async def run_stream(self, *args, **kwargs):
                self.calls += 1
                yield AgentStreamEvent(type="text_delta", delta="只执行一次")
                yield AgentStreamEvent(type="completed", result=AgentRunResult(
                    content="只执行一次", provider="test", platform="manual", rounds=1,
                ))

        runtime = Runtime()
        def run_twice():
            first = self.run_ag_ui(conversation["id"], "执行", "stable-run")
            second = self.run_ag_ui(conversation["id"], "执行", "stable-run")
            return first, second
        first, second = self.with_runtime(runtime, run_twice)
        self.assertEqual(runtime.calls, 1)
        for events in (first, second):
            self.assertEqual("".join(event["delta"] for event in events if event["type"] == "TEXT_MESSAGE_CONTENT"), "只执行一次")

    def test_waiting_snapshot_is_resumed_only_for_matching_option(self) -> None:
        conversation = self.client.post("/conversations", json={"title": "恢复"}).json()
        save_run_snapshot(conversation["id"], AgentRunSnapshot(
            route_kind="library_search", needs_plan=True, allowed_tools=["search_library"],
            clarification=AgentClarification(
                question="要查哪份资料？",
                options=[ClarificationOption(id="one", label="项目笔记", send="查项目笔记")],
            ), rounds_used=1,
        ))
        captured = []

        class Runtime:
            async def run_stream(self, *args, **kwargs):
                captured.append(kwargs.get("resume"))
                yield AgentStreamEvent(type="completed", result=AgentRunResult(
                    content="完成", provider="test", platform="manual", rounds=1,
                ))

        self.with_runtime(Runtime(), lambda: self.run_ag_ui(conversation["id"], "换个话题", "run-new-topic"))
        self.assertIsNone(captured[-1])
        self.assertIsNone(load_run_snapshot(conversation["id"]))

        save_run_snapshot(conversation["id"], AgentRunSnapshot(
            route_kind="library_search", needs_plan=True, allowed_tools=["search_library"],
            clarification=AgentClarification(
                question="要查哪份资料？",
                options=[ClarificationOption(id="one", label="项目笔记", send="查项目笔记")],
            ), rounds_used=1,
        ))
        self.with_runtime(Runtime(), lambda: self.run_ag_ui(conversation["id"], "查项目笔记", "run-resume"))
        self.assertIsNotNone(captured[-1])
        self.assertEqual(captured[-1].route_kind, "library_search")

    def test_attachment_config_never_returns_storage_secrets(self) -> None:
        original = resources_module.get_settings
        resources_module.get_settings = lambda: SimpleNamespace(
            attachment_storage="minio", attachment_vision_enabled=True,
            attachment_vision_url_ttl_seconds=300, minio_endpoint="127.0.0.1:9000",
            minio_access_key="access", minio_secret_key="secret", minio_bucket="tuantuan",
            minio_public_endpoint="https://files.example.test",
        )
        try:
            payload = self.client.get("/attachments/config").json()
        finally:
            resources_module.get_settings = original
        self.assertTrue(payload["vision_ready"])
        self.assertNotIn("minio_secret_key", payload)
        self.assertNotIn("minio_access_key", payload)

    def test_attachment_config_supports_vision_without_public_storage(self) -> None:
        from app.config import Settings

        for enabled, storage, configured, ready in [
            (True, "local", False, True),
            (False, "local", False, False),
            (True, "minio", True, True),
            (True, "minio", False, False),
        ]:
            with self.subTest(enabled=enabled, storage=storage, configured=configured):
                settings = Settings(
                    attachment_vision_enabled=enabled, attachment_storage=storage,
                    minio_endpoint="127.0.0.1:9000" if configured else None,
                    minio_access_key="access" if configured else None,
                    minio_secret_key="secret" if configured else None,
                )
                with patch.object(resources_module, "get_settings", return_value=settings):
                    response = self.client.get("/attachments/config")
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["vision_ready"], ready)
                self.assertFalse(response.json()["requires_public_endpoint"])

    def test_authorized_local_image_reaches_chat_runtime_as_data_url(self) -> None:
        from PIL import Image

        cid = self.client.post("/conversations", json={"title": "本地看图"}).json()["id"]
        buffer = BytesIO()
        Image.new("RGB", (1, 1), color="white").save(buffer, format="PNG")
        content = buffer.getvalue()
        uploaded = self.client.post("/attachments", data={"conversation_id": str(cid), "kind": "image"},
                                    files={"file": ("job.png", content, "image/png")})
        self.assertEqual(uploaded.status_code, 200)
        attachment_id = uploaded.json()["id"]
        self.assertEqual(self.client.post(f"/attachments/{attachment_id}/parse").status_code, 200)
        captured = []

        class Runtime:
            async def run_stream(self, *args, **kwargs):
                captured.extend(kwargs["image_urls"])
                yield AgentStreamEvent(type="completed", result=AgentRunResult(
                    content="已收到图片", provider="test", platform="manual", rounds=1,
                ))

        with patch.object(attachments_module, "get_settings", return_value=SimpleNamespace(attachment_vision_enabled=True, attachment_storage="local")):
            events = self.with_runtime(Runtime(), lambda: self.run_ag_ui(cid, "看看这张图", "local-vision", forwarded={
                "attachmentIds": [attachment_id], "visionAttachmentIds": [attachment_id], "webSearch": False,
            }))
        self.assertIn("RUN_FINISHED", [event["type"] for event in events])
        self.assertEqual(captured, [f"data:image/png;base64,{base64.b64encode(content).decode('ascii')}"])

    def test_rewind_deletes_selected_user_turn_and_following_answer(self) -> None:
        conversation = self.client.post("/conversations", json={"title": "回退"}).json()

        class Runtime:
            async def run_stream(self, *args, **kwargs):
                yield AgentStreamEvent(type="completed", result=AgentRunResult(
                    content="回答", provider="test", platform="manual", rounds=1,
                ))

        self.with_runtime(Runtime(), lambda: self.run_ag_ui(conversation["id"], "问题", "run-rewind"))
        messages = self.client.get(f"/chat/messages?conversation_id={conversation['id']}").json()
        response = self.client.delete(f"/chat/messages/{messages[0]['id']}/tail?conversation_id={conversation['id']}")
        body = response.json()
        self.assertEqual(body["deleted"], 2)
        self.assertEqual([item["role"] for item in body["messages"]], ["user", "assistant"])
        self.assertEqual(body["previous_title"], "回退")
        self.assertEqual(self.client.get(f"/chat/messages?conversation_id={conversation['id']}").json(), [])

    def test_conversation_search_turn_delete_and_restore(self) -> None:
        first = self.client.post("/conversations", json={"title": "项目笔记"}).json()
        second = self.client.post("/conversations", json={"title": "另一段"}).json()
        opening = save_chat_message("user", "第一问：Straße 方案", {}, conversation_id=first["id"])
        save_chat_message("assistant", "第一答", {}, conversation_id=first["id"])
        later = save_chat_message("user", "第二问", {}, conversation_id=first["id"])
        save_chat_message("assistant", "第二答", {}, conversation_id=first["id"])
        save_chat_message("user", "无关内容", {}, conversation_id=second["id"])

        matched = self.client.get("/conversations", params={"q": "strasse"}).json()
        self.assertEqual([item["id"] for item in matched], [first["id"]])
        truncated = self.client.get("/conversations", params={"q": ("a" * 200) + "strasse"}).json()
        self.assertEqual(truncated, [])

        deleted = self.client.delete(f"/chat/messages/{opening['id']}/turn?conversation_id={first['id']}")
        self.assertEqual(deleted.status_code, 200)
        self.assertEqual(deleted.json()["deleted"], 2)
        remaining = self.client.get(f"/chat/messages?conversation_id={first['id']}").json()
        self.assertEqual([item["content"] for item in remaining], ["第二问", "第二答"])

        rewound = self.client.delete(f"/chat/messages/{later['id']}/tail?conversation_id={first['id']}")
        self.assertEqual(rewound.status_code, 200)
        snapshot = rewound.json()
        save_chat_message("user", "替换后的问题", {}, conversation_id=first["id"])
        save_chat_message("assistant", "替换后的回答", {}, conversation_id=first["id"])
        restored = self.client.post("/chat/messages/restore", json={
            "conversation_id": first["id"],
            "previous_title": snapshot["previous_title"],
            "messages": [
                {
                    "id": item["id"],
                    "role": item["role"],
                    "content": item["content"],
                    "payload": item.get("payload") or {},
                    "created_at": item["created_at"],
                }
                for item in snapshot["messages"]
            ],
        })
        self.assertEqual(restored.status_code, 200)
        self.assertEqual(restored.json()["restored"], 2)
        after = self.client.get(f"/chat/messages?conversation_id={first['id']}").json()
        self.assertEqual([item["id"] for item in after], [item["id"] for item in snapshot["messages"]])
        self.assertEqual([item["content"] for item in after], ["第二问", "第二答"])

        with patch("app.api.chat.is_chat_running", return_value=True):
            blocked = self.client.post("/chat/messages/restore", json={
                "conversation_id": first["id"],
                "messages": [{"id": after[0]["id"], "role": "user", "content": "不能覆盖"}],
            })
        self.assertEqual(blocked.status_code, 409)
        self.assertEqual(self.client.get(f"/chat/messages?conversation_id={first['id']}").json()[0]["content"], "第二问")

    def test_preview_origin_is_allowed_by_cors(self) -> None:
        response = self.client.options("/health", headers={
            "Origin": "http://127.0.0.1:4173", "Access-Control-Request-Method": "GET",
        })
        self.assertEqual(response.headers.get("access-control-allow-origin"), "http://127.0.0.1:4173")


class ChatCancellationTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.original_db_path = db.DB_PATH
        db.DB_PATH = Path(self.temp_dir.name) / "cancel.db"
        db.init_db()

    async def asyncTearDown(self) -> None:
        for task in list(_active_chat_runs.values()):
            task.cancel()
        await asyncio.gather(*_active_chat_runs.values(), return_exceptions=True)
        _active_chat_runs.clear()
        db.DB_PATH = self.original_db_path
        self.temp_dir.cleanup()

    async def test_cancel_endpoint_cancels_registered_run(self) -> None:
        conversation = create_conversation("取消测试")
        ensure_active_task(conversation["id"])
        task = asyncio.create_task(asyncio.Event().wait())
        _active_chat_runs[_chat_run_key(conversation["id"])] = task
        result = await cancel_current_agent_task(conversation["id"])
        await asyncio.gather(task, return_exceptions=True)
        self.assertTrue(result["cancelled"])
        self.assertTrue(task.cancelled())


if __name__ == "__main__":
    unittest.main()
