"""Execution must converge even when the model keeps asking for more tools."""
from __future__ import annotations

import asyncio
import json

from app.agent.execution_budget import ExecutionBudget, ExecutionLimits
from app.agent.capability_resolver import TaskRoute
from app.agent.runtime import AgentRuntime, RunContext
from app.domain import AgentMessage, AgentPlan, AgentPlanStep, AgentRunSnapshot, ExecutionBudgetState, ModelResponse, ToolCall, ToolResult
from app.models import ModelProviderRegistry
from app.search_options import WebSearchOptions
from app.tools import ToolRegistry
from test_agent_runtime import CountingTool, ScriptedModel


URL = "https://example.com/source"
QUOTE = "这是已核对的公开项目说明，可用于判断项目是否符合任务要求。"
ANSWER = f"已整理有证据支持的项目。[来源]({URL})"

def evidence_review():
    return ModelResponse(content='{"verified":true,"patches":[]}')

class SearchTool(CountingTool):
    def __init__(self, *, fresh=False):
        super().__init__("search_public_web")
        self.fresh = fresh

    async def execute(self, arguments, context):
        self.calls += 1
        url = f"{URL}/{self.calls}" if self.fresh else URL
        return ToolResult(ok=True, status="done", message="找到公开项目", data={
            "query": arguments["query"], "sources": [{"url": url, "title": "公开项目", "content": QUOTE}],
            "evidence": [{"url": url, "excerpt": QUOTE}],
        })


def calls(count, name="search_public_web"):
    return ModelResponse(tool_calls=[ToolCall(id=f"c{index}", name=name, arguments={"query": f"项目 {index}"}) for index in range(count)])


def setup(model, tool, *, limits=None, max_rounds=8, required=None):
    models = ModelProviderRegistry(); models.register(model.name, model)
    tools = ToolRegistry(); tools.register_handler(tool)
    runtime = AgentRuntime(models, tools, model.name, "test", max_rounds, execution_limits=limits)
    name = tool.definition.name
    route = TaskRoute("web_search" if name == "search_public_web" else "library_search", False, (name,), tuple(required or [name]))
    ctx = RunContext(provider=model, platform="test", run_id=None, user_content="查找适合的项目",
        conversation_id=None, task_id=None, event_callback=None, web_search_mode="auto", route=route,
        plan=AgentPlan(goal="查找适合的项目", route=route.kind, steps=[AgentPlanStep(id="s1", title="检索项目", tool_name=name, risk="external_read" if name == "search_public_web" else "read_only")]),
        messages=[AgentMessage(role="user", content="查找适合的项目")], events=[], interrupt_tools=set(),
        budget=ExecutionBudget(limits=limits))
    runtime._apply_tool_surface(ctx)
    return runtime, ctx


def run(model, tool, **options):
    runtime, ctx = setup(model, tool, **options)
    return asyncio.run(runtime._run_tool_loop(ctx, start_round=1)), ctx


def test_one_large_batch_cannot_exceed_search_budget_and_every_call_is_answered():
    tool = SearchTool(fresh=True)
    model = ScriptedModel([calls(10), ModelResponse(content="项目资料。[[web:W1]]")])
    result, ctx = run(model, tool, limits=ExecutionLimits(max_web_search_calls=3))
    assert result.status == "done" and tool.calls == 3
    request = model.requests[-1]
    assert request.tools == [] and request.tool_choice == "none"
    responses = [message for message in request.messages if message.role == "tool"]
    assert [message.tool_call_id for message in responses] == [f"c{i}" for i in range(10)]
    assert sum(message.payload["status"] == "blocked" for message in responses) == 7
    assert ctx.budget.state.finalization_reason == "web_search_budget"
    assert result.events[-1].data["web_search_calls"] == 3


def test_non_web_tools_share_the_total_call_budget():
    tool = CountingTool("search_library")
    model = ScriptedModel([calls(5, "search_library"), ModelResponse(content="已整理查到的资料。")])
    result, ctx = run(model, tool, limits=ExecutionLimits(max_tool_calls=2))
    assert result.status == "done" and tool.calls == 2
    assert ctx.budget.state.finalization_reason == "tool_call_budget"


def test_different_queries_with_no_new_evidence_stop_after_two_stale_results():
    tool = SearchTool()
    model = ScriptedModel([calls(8), ModelResponse(content=ANSWER)])
    result, ctx = run(model, tool)
    assert result.status == "done" and tool.calls == 3
    assert ctx.budget.state.finalization_reason == "web_search_no_progress"


def test_normalized_repeated_queries_reuse_results_and_do_not_spend_more_calls():
    duplicate = ModelResponse(tool_calls=[ToolCall(id=f"c{i}", name="search_public_web", arguments={"query": query, "count": count})
        for i, (query, count) in enumerate([("Claude Skills", 6), ("  claude   skills ", 8), ("CLAUDE SKILLS", 10)])])
    tool = SearchTool(); model = ScriptedModel([duplicate, ModelResponse(content=ANSWER)])
    result, ctx = run(model, tool)
    assert result.status == "done" and tool.calls == 1
    guards = [event for event in result.events if event.tool_name == "agent_loop_guard"]
    assert len(guards) == 2 and all(event.status == "done" for event in guards)
    assert all("推进下一步" not in event.message for event in guards)
    assert ctx.budget.state.finalization_reason == "repeated_tool_call"


def test_last_tool_round_has_a_separate_final_answer_and_citation_repair_slot():
    patch = {"verified": True, "patches": [{"action": "cite_after", "target": "已核对项目。", "source_id": "C1", "quote": QUOTE}]}
    tool = SearchTool(); model = ScriptedModel([calls(1), ModelResponse(content="已核对项目。"), ModelResponse(content=json.dumps(patch, ensure_ascii=False))])
    runtime, ctx = setup(model, tool, max_rounds=1)
    ctx.verify_web_claims = True
    result = asyncio.run(runtime._run_tool_loop(ctx, start_round=1))
    assert result.status == "done" and result.rounds == 3 and tool.calls == 1
    assert URL in result.content
    assert all(request.tools == [] and request.tool_choice == "none" for request in model.requests[1:])


def test_final_answer_never_dispatches_tools_even_when_provider_ignores_none():
    tool = SearchTool(); model = ScriptedModel([calls(1), calls(1)])
    result, _ = run(model, tool, max_rounds=1)
    assert result.status == "failed" and tool.calls == 1 and len(model.requests) == 2
    assert result.events[-1].data["error_code"] == "invalid_final_answer"


def test_a_summary_cannot_mark_unexecuted_required_steps_complete():
    tool = CountingTool("search_library")
    model = ScriptedModel([calls(2, "search_library"), ModelResponse(content="只查到部分资料。")])
    result, _ = run(model, tool, limits=ExecutionLimits(max_tool_calls=1), required=["search_library", "propose_library_knowledge"])
    assert result.status == "failed" and result.error.code == "execution_budget_incomplete"
    assert "只查到部分资料" in result.content and "尚未全部完成" in result.content


def test_budget_survives_checkpoint_serialization_and_resume_without_new_searches():
    model = ScriptedModel([calls(1)]); tool = SearchTool()
    runtime, ctx = setup(model, tool, limits=ExecutionLimits(max_web_search_calls=1))
    ctx.budget.state = ExecutionBudgetState(tool_calls=1, web_search_calls=1, active_seconds=20)
    ctx.completed_tools.add("search_public_web")
    ctx.messages.append(AgentMessage(role="tool", tool_call_id="old", payload={"tool_name": "search_public_web", "status": "done", "sources": [{"url": URL, "content": QUOTE}]}))
    snapshot = runtime._build_snapshot(ctx, rounds_used=1)
    restored = AgentRunSnapshot.model_validate_json(snapshot.model_dump_json())
    final_model = ScriptedModel([ModelResponse(content=ANSWER)])
    final_runtime, _ = setup(final_model, tool, limits=ExecutionLimits(max_web_search_calls=1))
    result = asyncio.run(final_runtime.run("查找适合的项目", resume=restored, web_search_options=WebSearchOptions(enabled=True)))
    assert result.status == "done" and tool.calls == 0
    assert final_model.requests[0].tools == []
    assert result.events[-1].data["web_search_calls"] == 1


def test_legacy_checkpoint_is_charged_for_its_existing_tool_results():
    messages = [AgentMessage(role="tool", tool_call_id=str(i), payload={"tool_name": "search_public_web", "status": "done", "sources": [{"url": URL, "content": QUOTE}]}) for i in range(3)]
    budget = ExecutionBudget.restore(None, messages, ExecutionLimits())
    assert budget.state.web_search_calls == 3
    assert budget.stop_reason() == "web_search_no_progress"


def test_new_evidence_on_the_same_url_counts_as_progress_but_whitespace_does_not():
    budget = ExecutionBudget()
    def result(text):
        return ToolResult(ok=True, status="done", message="找到资料", data={"sources": [{"url": URL, "snippet": text}]})
    budget.record_result("search_public_web", result("first fact"))
    budget.record_result("search_public_web", result("first   fact"))
    assert budget.state.searches_without_progress == 1
    budget.record_result("search_public_web", result("a newly verified fact"))
    assert budget.state.searches_without_progress == 0
    budget.record_result("search_public_web", result("first fact"))
    budget.record_result("search_public_web", result("a newly verified fact"))
    assert budget.stop_reason() == "web_search_no_progress"


def test_active_time_is_preserved_but_user_waiting_time_is_not_charged(monkeypatch):
    now = [100.0]
    monkeypatch.setattr("app.agent.execution_budget.monotonic", lambda: now[0])
    budget = ExecutionBudget(limits=ExecutionLimits(max_active_seconds=30))
    now[0] = 110
    budget.tick()
    state = budget.state.model_copy(deep=True)
    now[0] = 10000
    restored = ExecutionBudget(state, ExecutionLimits(max_active_seconds=30))
    assert restored.stop_reason() == "" and restored.state.active_seconds == 10
    now[0] += 20
    assert restored.stop_reason() == "execution_time_budget"


def test_synthesis_failure_keeps_current_partial_text_and_does_not_retry():
    tool = CountingTool("search_library")
    model = ScriptedModel([ModelResponse(content="已查到可用线索。", tool_calls=[ToolCall(id="c1", name="search_library", arguments={"query": "项目"})]), RuntimeError("summary failed")])
    result, _ = run(model, tool, max_rounds=1)
    assert result.status == "failed" and result.content.startswith("已查到可用线索。")
    assert tool.calls == 1 and len(model.requests) == 2


def test_continuing_research_stops_at_six_searches_with_new_evidence_each_time():
    class ResearchModel(ScriptedModel):
        async def generate(self, request):
            self.requests.append(request)
            if request.tool_choice == "none":
                return ModelResponse(content="已整理可确认的项目，日期未核实。[[web:W1]]")
            offset = 3 * (len(self.requests) - 1)
            return ModelResponse(tool_calls=[ToolCall(id=f"c{offset + i}", name="search_public_web", arguments={"query": f"补查项目 {offset + i}"}) for i in range(3)])
    model = ResearchModel([]); tool = SearchTool(fresh=True)
    result, ctx = run(model, tool)
    assert result.status == "done" and tool.calls == 6 and len(model.requests) == 3
    assert f"{URL}/1" in result.content
    assert ctx.budget.state.finalization_reason == "web_search_budget"


def test_time_budget_stops_new_calls_but_still_allows_final_synthesis(monkeypatch):
    now = [0.0]
    monkeypatch.setattr("app.agent.execution_budget.monotonic", lambda: now[0])
    class SlowSearch(SearchTool):
        async def execute(self, arguments, context):
            now[0] += 6
            return await super().execute(arguments, context)
    model = ScriptedModel([calls(3), ModelResponse(content=ANSWER)]); tool = SlowSearch()
    result, ctx = run(model, tool, limits=ExecutionLimits(max_active_seconds=5))
    assert result.status == "done" and tool.calls == 1
    assert ctx.budget.state.finalization_reason == "execution_time_budget"


def test_expired_model_request_is_cancelled_before_reserved_synthesis():
    class SlowModel(ScriptedModel):
        cancelled = False
        async def generate(self, request):
            self.requests.append(request)
            if request.tool_choice == "none":
                return ModelResponse(content=ANSWER)
            if len(self.requests) == 1:
                return calls(1)
            try:
                await asyncio.sleep(60)
            finally:
                self.cancelled = True
    model = SlowModel([]); tool = SearchTool()
    result, _ = run(model, tool, limits=ExecutionLimits(max_active_seconds=0.03))
    assert model.cancelled and result.status == "done" and tool.calls == 1
    assert model.requests[-1].tools == []


def test_final_synthesis_timeout_is_bounded_and_not_retried(monkeypatch):
    monkeypatch.setattr("app.agent.runtime.FINAL_ANSWER_TIMEOUT_SECONDS", 0.01)
    class SlowSummary(ScriptedModel):
        cancelled = False
        async def generate(self, request):
            self.requests.append(request)
            if request.tool_choice != "none":
                return calls(1)
            try:
                await asyncio.sleep(60)
            finally:
                self.cancelled = True
    model = SlowSummary([]); tool = SearchTool()
    result, _ = run(model, tool, max_rounds=1)
    assert result.status == "failed" and model.cancelled and len(model.requests) == 2
    assert result.events[-1].data["error_code"] == "final_answer_timeout"


def test_restored_citation_repair_keeps_missing_obligations_failed():
    patch = {"verified": True, "patches": [{"action": "cite_after", "target": "已核对项目。", "source_id": "C1", "quote": QUOTE}]}
    model = ScriptedModel([ModelResponse(content=json.dumps(patch, ensure_ascii=False))]); tool = SearchTool()
    runtime, ctx = setup(model, tool, required=["search_public_web", "propose_library_knowledge"], max_rounds=1)
    ctx.completed_tools.add("search_public_web")
    ctx.citation_draft = "已核对项目。"
    ctx.citation_sources = [{"url": URL, "excerpt": QUOTE}]
    ctx.citation_allowed_urls = [URL]
    ctx.citation_retry_used = True
    ctx.budget.state.finalization_reason = "tool_call_budget"
    result = asyncio.run(runtime._run_tool_loop(ctx, start_round=3))
    assert result.status == "failed" and result.error.code == "execution_budget_incomplete"
    assert URL in result.content and tool.calls == 0


def test_budget_summary_draft_correction_still_gets_an_evidence_review_slot():
    model = ScriptedModel([
        calls(1), ModelResponse(content="建议先整理项目资料。"),
        ModelResponse(content='{"complete":false,"reason":"缺少实际草稿"}'),
        ModelResponse(content=ANSWER),
        ModelResponse(content='{"complete":true,"reason":"已形成可用草稿"}'), evidence_review(),
    ])
    tool = SearchTool()
    runtime, ctx = setup(model, tool, max_rounds=1)
    ctx.expects_draft = True
    ctx.verify_web_claims = True
    result = asyncio.run(runtime._run_tool_loop(ctx, start_round=1))
    assert result.status == "done" and result.content == ANSWER
    assert result.rounds == 4 and tool.calls == 1
    assert all(request.tools == [] for request in model.requests[1:])
