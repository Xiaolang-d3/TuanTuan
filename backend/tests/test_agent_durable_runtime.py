from __future__ import annotations

import asyncio
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from app.agent.approval_policy import APPROVE_OPTION_LABEL
from app.agent.run_store import AgentRunStore
from app.agent.runtime import AgentRuntime, _tool_call_fingerprint
from app.db import connect, init_db
from app.domain import (
    AgentMessage,
    AgentPlan,
    AgentPlanStep,
    AgentRunSnapshot,
    ModelResponse,
    ToolCall,
    ToolDefinition,
    ToolResult,
)
from app.models import ModelProviderRegistry
from app.search_options import WebSearchOptions
from app.tooling import ToolSpec
from app.tools import ToolContext, ToolRegistry
from app.tools.limits import MAX_RESULT_DATA_CHARS


class AgentDurableRuntimeTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "durable-runtime.db"
        init_db(self.db_path)
        with connect(self.db_path) as conn:
            self.conversation_id = conn.execute(
                "INSERT INTO conversations (title) VALUES ('Durable Agent')"
            ).lastrowid
            self.task_id = conn.execute(
                "INSERT INTO conversation_tasks (conversation_id) VALUES (?)",
                (self.conversation_id,),
            ).lastrowid
        self.store = AgentRunStore(self.db_path)

    async def asyncTearDown(self) -> None:
        self.temp_dir.cleanup()

    async def test_legacy_checkpoint_cannot_grant_new_web_calls_from_allowed_tools(self) -> None:
        tool = CountingTool("search_public_web")
        tools = ToolRegistry()
        tools.register_handler(tool)
        snapshot = AgentRunSnapshot(resume_mode="checkpoint", route_kind="web_search", needs_plan=False,
                                    allowed_tools=["search_public_web"], messages=[AgentMessage(role="user", content="研究公司")])
        self.store.start_run("no-consent", conversation_id=self.conversation_id, task_id=self.task_id, user_content="研究公司")
        self.store.checkpoint("no-consent", snapshot)
        self.store.interrupt_active_runs()
        events = [event async for event in self._runtime(ToolThenTextModel("search_public_web", {"query": "公司"}), tools).run_stream(
            "研究公司", run_id="no-consent", conversation_id=self.conversation_id,
            web_search_options=WebSearchOptions(enabled=True, topic="finance", provider="tavily"),
        )]
        self.assertEqual(tool.calls, 0)
        self.assertEqual(events[-1].result.status, "failed")
        self.assertEqual(events[-1].result.error.code, "web_search_not_allowed")
        ledger = self.store.list_tool_executions("no-consent")
        self.assertEqual(ledger[0]["status"], "blocked")
        self.assertIsNotNone(ledger[0]["completed_at"])

    async def test_same_run_id_uses_original_search_options_in_tool_context(self) -> None:
        class CaptureTool(CountingTool):
            async def execute(self, arguments, context):
                self.options = context.web_search_options
                return await super().execute(arguments, context)

        tool = CaptureTool("search_public_web")
        tools = ToolRegistry()
        tools.register_handler(tool)
        original = WebSearchOptions(enabled=True, topic="news", provider="tavily")
        self.store.start_run("stable-search", conversation_id=self.conversation_id, task_id=self.task_id,
                             user_content="原始任务", web_search_options=original)
        self.store.checkpoint("stable-search", AgentRunSnapshot(
            resume_mode="checkpoint", route_kind="conversation", needs_plan=False, allowed_tools=["search_public_web"],
            messages=[AgentMessage(role="user", content="原始任务")], web_search_options=original,
        ))
        self.store.interrupt_active_runs()
        events = [event async for event in self._runtime(ToolThenTextModel("search_public_web", {"query": "AI动态"}), tools).run_stream(
            "新请求", run_id="stable-search", conversation_id=self.conversation_id,
            web_search_options=WebSearchOptions(enabled=False, topic="finance"),
        )]
        self.assertEqual(events[-1].result.status, "done")
        self.assertEqual(tool.calls, 1)
        self.assertEqual(tool.options, original)

    async def test_terminal_run_id_replays_result_without_calling_model_again(self) -> None:
        class CountingModel:
            name = "counting"

            def __init__(self) -> None:
                self.calls = 0

            async def generate(self, request):
                self.calls += 1
                return ModelResponse(content="持久化回答")

        model = CountingModel()
        runtime = self._runtime(model, ToolRegistry())

        with patch("app.agent.run_store._utc_now", side_effect=[
            "2026-10-11T00:00:00.125+00:00", "2026-10-11T00:00:02.625+00:00",
        ]):
            first = await self._collect(runtime, "你好", run_id="same-run")
            second = await self._collect(runtime, "你好", run_id="same-run")

        self.assertEqual(model.calls, 1)
        self.assertEqual(first[-1].result.content, "持久化回答")
        self.assertEqual(second[-1].result.content, "持久化回答")
        self.assertEqual(first[-1].result.duration_ms, 2500)
        self.assertEqual(second[-1].result.duration_ms, 2500)
        self.assertEqual(first[-1].result.started_at, "2026-10-11T00:00:00.125+00:00")
        self.assertTrue(any(event.type == "text_delta" for event in second))
        self.assertEqual(self.store.get_run("same-run")["status"], "completed")

    async def test_interrupted_run_resumes_checkpoint_without_duplicate_user_message(self) -> None:
        original = AgentMessage(role="user", content="原始任务")
        snapshot = AgentRunSnapshot(
            resume_mode="checkpoint",
            route_kind="conversation",
            needs_plan=False,
            messages=[original],
            rounds_used=1,
        )
        self.store.start_run(
            "resume-run",
            conversation_id=self.conversation_id,
            task_id=self.task_id,
            user_content="原始任务",
        )
        self.store.checkpoint("resume-run", snapshot)
        self.store.interrupt_active_runs()

        class CaptureModel:
            name = "capture"

            def __init__(self) -> None:
                self.requests = []

            async def generate(self, request):
                self.requests.append(request)
                return ModelResponse(content="从检查点完成")

        model = CaptureModel()
        runtime = self._runtime(model, ToolRegistry())

        events = await self._collect(runtime, "原始任务", run_id="resume-run")

        self.assertEqual(events[-1].result.status, "done")
        user_messages = [
            message.content
            for message in model.requests[0].messages
            if message.role == "user"
        ]
        self.assertEqual(user_messages, ["原始任务"])
        self.assertEqual(self.store.get_run("resume-run")["status"], "completed")

    async def test_completed_tool_is_replayed_after_crash_without_handler_execution(self) -> None:
        tool = CountingTool("search_public_web")
        tools = ToolRegistry()
        tools.register_handler(tool)
        plan = AgentPlan(
            goal="研究公司",
            route="web_search",
            steps=[AgentPlanStep(
                id="step-1",
                title="研究公司",
                tool_name="search_public_web",
                risk="external_read",
            )],
        )
        snapshot = AgentRunSnapshot(
            resume_mode="checkpoint",
            route_kind="web_search",
            needs_plan=True,
            allowed_tools=["search_public_web"],
            required_tools=["search_public_web"],
            plan=plan,
            messages=[AgentMessage(role="user", content="研究示例科技")],
        )
        arguments = {"query": "示例科技"}
        fingerprint = _tool_call_fingerprint("search_public_web", arguments)
        self.store.start_run(
            "tool-replay-run",
            conversation_id=self.conversation_id,
            task_id=self.task_id,
            user_content="研究示例科技",
        )
        self.store.checkpoint("tool-replay-run", snapshot)
        self.store.prepare_tool_call(
            "tool-replay-run",
            fingerprint,
            ToolCall(id="before-crash", name="search_public_web", arguments=arguments),
            tools.spec("search_public_web"),
        )
        self.store.record_tool_result(
            "tool-replay-run",
            fingerprint,
            ToolResult(ok=True, status="done", message="已持久化研究结果"),
        )
        self.store.interrupt_active_runs()

        model = ToolThenTextModel("search_public_web", arguments)
        runtime = self._runtime(model, tools)

        events = await self._collect(
            runtime,
            "研究示例科技",
            run_id="tool-replay-run",
        )

        self.assertEqual(events[-1].result.status, "done")
        self.assertEqual(tool.calls, 0)
        done = next(
            event
            for event in events[-1].result.events
            if event.tool_name == "search_public_web" and event.status == "done"
        )
        self.assertTrue(done.data["idempotent_replay"])

    async def test_interrupted_write_tool_is_blocked_instead_of_replayed(self) -> None:
        tool = CountingTool("propose_library_knowledge")
        tools = ToolRegistry()
        tools.register_handler(tool)
        arguments = {"statements": ["熟悉 Python"]}
        fingerprint = _tool_call_fingerprint("propose_library_knowledge", arguments)
        plan = AgentPlan(
            goal="补充画像",
            route="library_update",
            steps=[AgentPlanStep(
                id="step-write",
                title="补充画像",
                tool_name="propose_library_knowledge",
                risk="local_pending_write",
            )],
        )
        snapshot = AgentRunSnapshot(
            resume_mode="checkpoint",
            route_kind="library_update",
            needs_plan=True,
            allowed_tools=["propose_library_knowledge"],
            required_tools=["propose_library_knowledge"],
            plan=plan,
            messages=[AgentMessage(role="user", content="记住我熟悉 Python")],
        )
        self.store.start_run(
            "uncertain-write-run",
            conversation_id=self.conversation_id,
            task_id=self.task_id,
            user_content="记住我熟悉 Python",
        )
        self.store.checkpoint("uncertain-write-run", snapshot)
        self.store.prepare_tool_call(
            "uncertain-write-run",
            fingerprint,
            ToolCall(
                id="write-before-crash",
                name="propose_library_knowledge",
                arguments=arguments,
            ),
            tools.spec("propose_library_knowledge"),
        )
        self.store.interrupt_active_runs()

        model = ToolThenTextModel("propose_library_knowledge", arguments)
        runtime = self._runtime(model, tools)

        events = await self._collect(
            runtime,
            "记住我熟悉 Python",
            run_id="uncertain-write-run",
        )

        result = events[-1].result
        self.assertEqual(result.status, "failed")
        self.assertEqual(result.error.code, "tool_execution_uncertain")
        self.assertFalse(result.error.retryable)
        self.assertIn("文件库 → 知识", result.content)
        self.assertEqual(model.calls, 0)
        self.assertEqual(tool.calls, 0)

    async def test_tool_confirmation_holds_before_ledger_until_approved(self) -> None:
        tool = ConfirmingWriteTool()
        tools = ToolRegistry()
        tools.register_handler(tool)
        arguments = {"note": "周五交付"}
        runtime = self._runtime(ToolThenTextModel(tool.definition.name, arguments), tools)

        events = await self._collect(runtime, "记住这条知识：周五交付", run_id="confirm-run")

        paused = events[-1].result
        self.assertEqual(paused.status, "waiting_user")
        self.assertEqual(paused.error.code, "tool_approval_required")
        self.assertEqual(tool.calls, 0)
        self.assertEqual(self.store.list_tool_executions("confirm-run"), [])
        self.assertEqual(paused.snapshot.pending_tool_approval.tool_name, tool.definition.name)
        self.assertEqual(
            paused.snapshot.pending_tool_approval.fingerprint,
            _tool_call_fingerprint(tool.definition.name, arguments),
        )

        approved_runtime = self._runtime(ToolThenTextModel(tool.definition.name, arguments), tools)
        resumed = [
            event
            async for event in approved_runtime.run_stream(
                APPROVE_OPTION_LABEL,
                conversation_id=self.conversation_id,
                task_id=self.task_id,
                run_id="confirm-run-2",
                resume=paused.snapshot,
            )
        ]

        self.assertEqual(resumed[-1].result.status, "done")
        self.assertEqual(tool.calls, 1)
        ledger = self.store.list_tool_executions("confirm-run-2")
        self.assertEqual([row["status"] for row in ledger], ["done"])

    async def test_oversized_result_is_bounded_in_checkpoint_and_tool_ledger(self) -> None:
        store = self.store

        class OversizedTool(CountingTool):
            async def execute(self, arguments, context):
                self.calls += 1
                return ToolResult(
                    ok=True,
                    status="done",
                    message="找到资料",
                    data={"excerpts": [{"content": "正文" * 5000} for _ in range(40)]},
                )

        class CheckpointModel(ToolThenTextModel):
            async def generate(self, request):
                if self.calls:
                    self.checkpoint = store.load_checkpoint("bounded-result-run")
                return await super().generate(request)

        tool = OversizedTool("search_library")
        tools = ToolRegistry()
        tools.register_handler(tool)
        model = CheckpointModel("search_library", {"query": "周五交付"})

        events = await self._collect(
            self._runtime(model, tools), "查找资料：周五交付", run_id="bounded-result-run",
        )

        self.assertEqual(events[-1].result.status, "done")
        self.assertEqual(tool.calls, 1)
        self.assertIsNotNone(model.checkpoint)
        message = next(message for message in model.checkpoint.messages if message.role == "tool")
        ledger = self.store.list_tool_executions("bounded-result-run")
        data = ledger[0]["result"]["data"]
        self.assertIs(data["truncated"], True)
        self.assertLessEqual(len(json.dumps(data, ensure_ascii=False)), MAX_RESULT_DATA_CHARS)
        self.assertEqual(message.payload["excerpts"], data["excerpts"])
        self.assertIs(message.payload["truncated"], True)

    async def test_durable_cancel_stops_before_model_request(self) -> None:
        class ShouldNotRunModel:
            name = "cancelled"

            def __init__(self) -> None:
                self.calls = 0

            async def generate(self, request):
                self.calls += 1
                raise AssertionError("取消后不应请求模型")

        model = ShouldNotRunModel()
        self.store.start_run(
            "cancel-run",
            conversation_id=self.conversation_id,
            task_id=self.task_id,
            user_content="你好",
        )
        self.store.request_cancel("cancel-run")
        runtime = self._runtime(model, ToolRegistry())

        events = await self._collect(runtime, "你好", run_id="cancel-run")

        self.assertEqual(events[-1].result.status, "cancelled")
        self.assertEqual(model.calls, 0)
        self.assertEqual(self.store.get_run("cancel-run")["status"], "cancelled")

    async def test_durable_cancel_interrupts_inflight_model_request(self) -> None:
        class SlowModel:
            name = "slow-cancel"

            def __init__(self) -> None:
                self.started = asyncio.Event()
                self.cancelled = False

            async def generate(self, request):
                self.started.set()
                try:
                    await asyncio.sleep(10)
                except asyncio.CancelledError:
                    self.cancelled = True
                    raise
                return ModelResponse(content="不应完成")

        model = SlowModel()
        runtime = self._runtime(model, ToolRegistry())
        collector = asyncio.create_task(
            self._collect(runtime, "你好", run_id="inflight-cancel")
        )
        await asyncio.wait_for(model.started.wait(), timeout=1)

        self.assertTrue(self.store.request_cancel("inflight-cancel"))
        events = await asyncio.wait_for(collector, timeout=2)

        self.assertTrue(model.cancelled)
        self.assertEqual(events[-1].result.status, "cancelled")
        self.assertEqual(self.store.get_run("inflight-cancel")["status"], "cancelled")

    def _runtime(self, model, tools: ToolRegistry) -> AgentRuntime:
        models = ModelProviderRegistry()
        models.register(model.name, model)
        return AgentRuntime(
            models=models,
            tools=tools,
            model_provider=model.name,
            platform_name="manual",
            max_tool_rounds=5,
            run_store=self.store,
        )

    async def _collect(self, runtime: AgentRuntime, content: str, *, run_id: str):
        return [
            event
            async for event in runtime.run_stream(
                content,
                conversation_id=self.conversation_id,
                task_id=self.task_id,
                run_id=run_id,
            )
        ]


class CountingTool:
    def __init__(self, name: str) -> None:
        self.definition = ToolDefinition(
            name=name,
            description="持久化测试工具",
            input_schema={"type": "object", "additionalProperties": True},
        )
        self.calls = 0

    async def execute(self, arguments: dict, context: ToolContext) -> ToolResult:
        self.calls += 1
        return ToolResult(ok=True, status="done", message="工具完成")


class ConfirmingWriteTool:
    def __init__(self) -> None:
        self.definition = ToolDefinition(
            name="test_confirm_write",
            description="持久化确认写入工具",
            input_schema={"type": "object", "additionalProperties": True},
        )
        self.spec = ToolSpec(
            name="test_confirm_write",
            title="写入确认工具",
            risk="confirmed_local_write",
            capabilities=frozenset({"library.propose"}),
            priority=1,
        )
        self.calls = 0

    async def execute(self, arguments: dict, context: ToolContext) -> ToolResult:
        self.calls += 1
        return ToolResult(ok=True, status="done", message="写入完成")


class ToolThenTextModel:
    name = "tool-then-text"

    def __init__(self, tool_name: str, arguments: dict) -> None:
        self.tool_name = tool_name
        self.arguments = arguments
        self.calls = 0

    async def generate(self, request):
        self.calls += 1
        if self.calls == 1:
            return ModelResponse(
                tool_calls=[ToolCall(
                    id=f"resume-{self.tool_name}",
                    name=self.tool_name,
                    arguments=self.arguments,
                )]
            )
        return ModelResponse(content="恢复任务完成")


if __name__ == "__main__":
    unittest.main()
