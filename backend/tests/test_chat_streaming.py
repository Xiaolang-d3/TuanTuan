from __future__ import annotations

import asyncio
import base64
import json
import sqlite3
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

    def test_resume_interrupted_write_streams_and_saves_verification_guidance(self) -> None:
        from app.agent.runtime import AgentRuntime, _tool_call_fingerprint
        from app.domain import ToolCall
        from app.models import ModelProviderRegistry
        from app.tooling import ToolSpec
        from app.tools import ToolRegistry

        cid = self.client.post("/conversations", json={"title": "写入中断"}).json()["id"]
        task = ensure_active_task(cid)
        run_id = "interrupted-write-ag-ui"
        content = "记住我熟悉 Python"
        user = save_chat_message("user", content, conversation_id=cid, task_id=task)
        store = AgentRunStore()
        store.start_run(run_id, conversation_id=cid, task_id=task, user_content=content)
        store.bind_messages(run_id, user_message_id=user["id"])
        store.checkpoint(run_id, AgentRunSnapshot(
            resume_mode="checkpoint", route_kind="library_update", needs_plan=True,
            messages=[AgentMessage(role="user", content=content)],
        ))
        tool = ToolCall(id="pending-write", name="propose_library_knowledge", arguments={"statements": ["熟悉 Python"]})
        fingerprint = _tool_call_fingerprint(tool.name, tool.arguments)
        store.prepare_tool_call(run_id, fingerprint, tool, ToolSpec(
            name=tool.name, title="记录知识", risk="local_pending_write", capabilities=frozenset({"library.write"}),
        ))
        store.interrupt_active_runs()

        runtime = AgentRuntime(
            models=ModelProviderRegistry(), tools=ToolRegistry(), model_provider="test",
            platform_name="local", max_tool_rounds=3, run_store=store,
        )
        with patch.object(runtime, "run", wraps=runtime.run) as execute:
            events = self.with_runtime(runtime, lambda: self.run_ag_ui(cid, content, run_id))
            replay = self.with_runtime(runtime, lambda: self.run_ag_ui(cid, content, run_id))
        execute.assert_not_called()
        self.assertEqual(events[-1]["code"], "tool_execution_uncertain")
        self.assertEqual(replay[-1]["code"], "tool_execution_uncertain")
        history = self.client.get("/chat/messages", params={"conversation_id": cid}).json()
        self.assertEqual([msg["role"] for msg in history], ["user", "assistant"])
        guidance = history[-1]["content"]
        self.assertIn("文件库 → 知识", guidance)
        self.assertIn("确认缺失后", guidance)
        self.assertEqual(events[-1]["message"], guidance)
        self.assertFalse(history[-1]["payload"]["agent"]["error"]["retryable"])
        with db.connect() as conn:
            entry = conn.execute("SELECT status, attempt_count FROM agent_tool_executions WHERE run_id = ?", (run_id,)).fetchone()
        self.assertEqual(tuple(entry), ("interrupted", 1))

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

    def test_new_turns_use_web_search_only_with_opt_in(self) -> None:
        captured = []
        class Runtime:
            async def run_stream(self, *args, **kwargs):
                captured.append(kwargs["web_search_options"])
                yield AgentStreamEvent(type="completed", result=AgentRunResult(
                    content="普通回答", provider="test", platform="manual", rounds=1,
                ))
        for enabled, forwarded, expected in [
            (True, {}, False),
            (False, {}, False),
            (True, {"webSearch": False}, False),
            (True, {"webSearch": True}, True),
        ]:
            with self.subTest(enabled=enabled, forwarded=forwarded):
                conversation = self.client.post("/conversations", json={"title": "搜索开关"}).json()
                settings = SimpleNamespace(web_research_enabled=enabled, resolved_web_search_provider="tavily")
                with patch.object(main_module, "get_settings", return_value=settings):
                    self.with_runtime(Runtime(), lambda: self.run_ag_ui(
                        conversation["id"], "请联网搜索最新新闻", f"search-{conversation['id']}", forwarded=forwarded,
                    ))
                self.assertEqual(captured[-1].enabled, expected)
                self.assertEqual((captured[-1].topic, captured[-1].source_preference), ("auto", "none"))
                messages = self.client.get(f"/chat/messages?conversation_id={conversation['id']}").json()
                self.assertEqual(messages[-2]["payload"]["web_search_options"]["enabled"], expected)

    def test_confirmation_requires_consent_and_inherits_search_preferences(self) -> None:
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
            self.assertEqual(captured[-1], original.model_copy(update={"enabled": False}))
            pause()
            self.with_runtime(Runtime(), lambda: self.run_ag_ui(
                conversation["id"], "继续", "opt-in-search", forwarded={"webSearch": True},
            ))
            self.assertEqual(captured[-1], original)
            pause()
            self.with_runtime(Runtime(), lambda: self.run_ag_ui(conversation["id"], "继续", "disabled-search",
                              forwarded={"webSearch": False, "webSearchTopic": "auto", "webSearchSourcePreference": "none"}))
        self.assertFalse(captured[-1].enabled)
        self.assertEqual((captured[-1].topic, captured[-1].source_preference), ("auto", "none"))
        messages = self.client.get(f"/chat/messages?conversation_id={conversation['id']}").json()
        self.assertEqual(messages[-2]["payload"]["web_search_options"], captured[-1].model_dump())
        with patch.object(main_module, "get_settings", return_value=SimpleNamespace(
            web_research_enabled=True, resolved_web_search_provider="tavily",
        )):
            pause()
            self.with_runtime(Runtime(), lambda: self.run_ag_ui(
                conversation["id"], "换个话题，写一封邮件", "abandoned-search",
            ))
        self.assertFalse(captured[-1].enabled)
        self.assertEqual(captured[-1].topic, "auto")

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
                "tools": [], "context": [], "forwardedProps": {"webSearch": True},
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
        with (
            patch.object(main_module, "get_settings", return_value=SimpleNamespace(resolved_web_search_provider="agent_search")),
            patch.object(main_module, "get_agent_runtime", side_effect=AssertionError("已完成结果不应初始化模型")),
            patch("app.agent.memory.service.schedule_memory_extraction") as extract_memory,
        ):
            backfill = self.run_ag_ui(conversation["id"], "重连", "terminal-backfill", forwarded={"webSearch": False})
            replay = self.run_ag_ui(conversation["id"], "再次重连", "terminal-backfill")
        for events in (backfill, replay):
            self.assertEqual("".join(event["delta"] for event in events if event["type"] == "TEXT_MESSAGE_CONTENT"), "已完成原搜索")
        messages = self.client.get(f"/chat/messages?conversation_id={conversation['id']}").json()
        self.assertEqual(len(messages), 2)
        self.assertEqual(messages[0]["payload"]["web_search_options"], options.model_dump())
        self.assertEqual(store.get_run("terminal-backfill")["assistant_message_id"], messages[1]["id"])
        extract_memory.assert_called_once_with(conversation["id"], through_message_id=messages[1]["id"])

    def test_failed_assistant_binding_preserves_result_for_idempotent_reconnect(self) -> None:
        cid = self.client.post("/conversations", json={"title": "消息入库失败"}).json()["id"]
        run_id = "assistant-binding-fault"
        answer = "原始已完成的回答。"

        class Runtime:
            async def run_stream(self, *args, **kwargs):
                yield AgentStreamEvent(type="text_delta", delta=answer)
                yield AgentStreamEvent(type="completed", result=AgentRunResult(
                    content=answer, provider="test", platform="manual", rounds=1,
                ))

        bind = AgentRunStore.bind_messages

        def fail_assistant_bind(store, run_id, **kwargs):
            if kwargs.get("assistant_message_id") is not None:
                raise sqlite3.OperationalError("injected assistant binding failure")
            return bind(store, run_id, **kwargs)

        with patch.object(AgentRunStore, "bind_messages", fail_assistant_bind):
            original = self.with_runtime(Runtime(), lambda: self.run_ag_ui(cid, "请回答", run_id))
            with patch.object(main_module, "get_agent_runtime", side_effect=AssertionError("补写不应调用模型")):
                unavailable = self.run_ag_ui(cid, "请回答", run_id)

        for events in (original, unavailable):
            self.assertEqual(events[-1]["type"], "RUN_ERROR")
            self.assertEqual(events[-1]["code"], "run_result_persist_failed")
            self.assertFalse(any(event["type"] == "STATE_SNAPSHOT" for event in events))
        run = AgentRunStore().get_run(run_id)
        self.assertEqual(run["status"], "completed")
        self.assertEqual(run["result"].content, answer)
        self.assertIsNone(run["assistant_message_id"])
        messages = self.client.get(f"/chat/messages?conversation_id={cid}").json()
        self.assertEqual([message["role"] for message in messages], ["user"])

        with (
            patch.object(main_module, "get_agent_runtime", side_effect=AssertionError("补写不应调用模型")),
            patch("app.agent.memory.service.schedule_memory_extraction") as extract_memory,
        ):
            backfill = self.run_ag_ui(cid, "请回答", run_id)
            replay = self.run_ag_ui(cid, "请回答", run_id)
        self.assertEqual(backfill[-1]["type"], "RUN_FINISHED")
        self.assertEqual(backfill[-1], replay[-1])
        messages = self.client.get(f"/chat/messages?conversation_id={cid}").json()
        self.assertEqual([message["role"] for message in messages], ["user", "assistant"])
        self.assertEqual(messages[1]["content"], answer)
        self.assertEqual(AgentRunStore().get_run(run_id)["assistant_message_id"], messages[1]["id"])
        extract_memory.assert_called_once_with(cid, through_message_id=messages[1]["id"])

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

    def test_dsh_wait_is_durable_and_only_the_live_process_can_resume_it(self) -> None:
        from app.agent.kernels.dsh import manager as dsh_manager
        from app.agent.kernels.dsh.adapter import DshKernelRuntime
        from app.agent.kernels.dsh.approvals import APPROVE_LABEL
        from app.agent.kernels.dsh.client import DshLaunch, DshTimeoutError, Notification

        class Client:
            running = False
            request = None

            def __init__(self, *_args, **_kwargs):
                self.queries = []
                self.replies = []

            async def start(self):
                self.running = True

            async def initialize(self, _params):
                pass

            async def session_query(self, _session_id, blocks):
                self.queries.append(blocks[0]["text"])
                self.request = Notification("approval/request", {"toolName": "ping"}, "test-rpc-id")

            async def next_request(self, **_kwargs):
                request, self.request = self.request, None
                if request is None:
                    raise DshTimeoutError("no request")
                return request

            async def next_notification(self, **_kwargs):
                return Notification("session.status", {"status": "idle"})

            async def respond(self, request_id, result):
                self.replies.append((request_id, result))

        client = Client()
        manager = dsh_manager.DshRuntimeManager(client_factory=lambda *a, **kw: client)
        replacement = dsh_manager.DshRuntimeManager(client_factory=lambda *a, **kw: self.fail("started a new DSH client"))
        runtime = DshKernelRuntime(manager, {}, tool_ready_grace=0)
        conversation = self.client.post("/conversations", json={"title": "DSH 审批"}).json()
        conversation_id = conversation["id"]
        with db.connect() as conn:
            conn.execute("UPDATE conversations SET kernel = 'dsh' WHERE id = ?", (conversation_id,))
        run_store = AgentRunStore()

        with (
            patch.object(main_module, "get_agent_runtime", return_value=SimpleNamespace()),
            patch.object(main_module, "validate_kernel_selection", return_value="dsh"),
            patch.object(main_module, "resolve_kernel_runtime", side_effect=lambda *_args: runtime),
            patch.object(dsh_manager, "build_dsh_launch", return_value=DshLaunch(bin="fake")) as launch,
            patch.object(dsh_manager, "dsh_home", return_value=Path(self.temp_dir.name) / "dsh"),
        ):
            waiting = self.run_ag_ui(conversation_id, "需要审批的任务", "dsh-wait")
            replay = self.run_ag_ui(conversation_id, "被忽略的重放内容", "dsh-wait")
            for events in (waiting, replay):
                finished = next(event for event in events if event["type"] == "RUN_FINISHED")
                self.assertEqual(finished["result"]["status"], "waiting_user")
                state = next(event["snapshot"]["tuantuan"] for event in events if event["type"] == "STATE_SNAPSHOT")
                public_agent = state["assistantMessage"]["payload"]["agent"]
                self.assertEqual(public_agent["status"], "waiting_user")
                clarification = public_agent["events"][-1]["data"]["clarification"]
                self.assertEqual(clarification["options"][0]["send"], APPROVE_LABEL)
                self.assertNotIn("dsh_wait_token", json.dumps(events))
                self.assertNotIn("test-rpc-id", json.dumps(events))
            durable = run_store.get_run("dsh-wait")
            checkpoint = load_run_snapshot(conversation_id)
            self.assertEqual(durable["status"], "waiting_user")
            self.assertIsNotNone(durable["assistant_message_id"])
            self.assertEqual(durable["result"].snapshot.dsh_wait_token, checkpoint.dsh_wait_token)
            self.assertTrue(checkpoint.dsh_wait_token)
            self.assertEqual(client.queries, ["需要审批的任务"])

            completed = self.run_ag_ui(conversation_id, APPROVE_LABEL, "dsh-resume")
            self.assertEqual(completed[-1]["result"]["status"], "done")
            self.assertEqual(client.queries, ["需要审批的任务"])
            self.assertEqual(client.replies, [("test-rpc-id", {"outcome": "allowed-once"})])
            self.assertIsNone(load_run_snapshot(conversation_id))
            self.assertEqual(run_store.get_run("dsh-resume")["parent_run_id"], "dsh-wait")

            self.run_ag_ui(conversation_id, "另一个需要审批的任务", "dsh-wait-old-process")
            runtime = DshKernelRuntime(replacement, {}, tool_ready_grace=0)
            expired = self.run_ag_ui(conversation_id, APPROVE_LABEL, "dsh-expired")
            self.assertEqual(expired[-1]["type"], "RUN_ERROR")
            self.assertEqual(expired[-1]["code"], "dsh_wait_expired")
            self.assertEqual(run_store.get_run("dsh-expired")["status"], "failed")
            self.assertEqual(run_store.get_run("dsh-expired")["parent_run_id"], "dsh-wait-old-process")
            self.assertIsNone(load_run_snapshot(conversation_id))
            self.assertEqual(len(client.queries), 2)
            self.assertEqual(len(client.replies), 1)
            launch.assert_called_once()

    def test_restarted_dsh_does_not_run_an_interrupted_answer_as_a_query(self) -> None:
        from app.agent.kernels.dsh.adapter import DshKernelRuntime
        from app.agent.kernels.dsh.approvals import APPROVE_LABEL
        from app.agent.kernels.dsh.manager import DshRuntimeManager

        cid = self.client.post("/conversations", json={"title": "回复审批时中断"}).json()["id"]
        task = ensure_active_task(cid)
        store = AgentRunStore()
        store.start_run("dsh-parent", conversation_id=cid, task_id=task, user_content="原任务", kernel="dsh")
        snapshot = AgentRunSnapshot(route_kind="dsh", needs_plan=False, dsh_wait_token="old-process-token")
        store.finish("dsh-parent", AgentRunResult(
            content="需要审批", provider="dsh", platform="dsh", rounds=0,
            status="waiting_user", snapshot=snapshot,
        ))
        save_run_snapshot(cid, snapshot)
        store.start_run("dsh-reply-in-progress", conversation_id=cid, task_id=task, user_content=APPROVE_LABEL, kernel="dsh")
        user = save_chat_message("user", APPROVE_LABEL, conversation_id=cid, task_id=task)
        store.bind_messages("dsh-reply-in-progress", user_message_id=user["id"])
        store.link_waiting_resume(cid, "dsh-reply-in-progress")
        with db.connect() as conn:
            conn.execute("UPDATE conversations SET kernel = 'dsh' WHERE id = ?", (cid,))
            conn.execute("UPDATE agent_execution_runs SET status = 'interrupted' WHERE run_id = 'dsh-reply-in-progress'")
        manager = DshRuntimeManager()
        runtime = DshKernelRuntime(manager, {}, tool_ready_grace=0)
        with (
            patch.object(main_module, "get_agent_runtime", return_value=SimpleNamespace()),
            patch.object(main_module, "validate_kernel_selection", return_value="dsh"),
            patch.object(main_module, "resolve_kernel_runtime", return_value=runtime),
            patch.object(manager, "acquire", side_effect=AssertionError("resumed reply started a new DSH client")) as acquire,
        ):
            expired = self.run_ag_ui(cid, "换个话题", "dsh-reply-in-progress")
        acquire.assert_not_called()
        self.assertEqual(expired[-1]["type"], "RUN_ERROR")
        self.assertEqual(expired[-1]["code"], "dsh_wait_expired")
        self.assertIsNone(load_run_snapshot(cid))
        run = store.get_run("dsh-reply-in-progress")
        self.assertEqual(run["status"], "failed")
        self.assertEqual(run["user_message_id"], user["id"])
        self.assertEqual(run["parent_run_id"], "dsh-parent")

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
            with patch.object(main_module, "get_agent_runtime", return_value=Runtime()) as get_runtime:
                events = self.run_ag_ui(cid, "看看这张图", "local-vision", forwarded={
                    "attachmentIds": [attachment_id], "visionAttachmentIds": [attachment_id], "webSearch": False,
                })
                get_runtime.assert_called_once_with(None, selection=None, user_content="看看这张图", has_image_input=True, allow_chatgpt_subscription=True)
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
