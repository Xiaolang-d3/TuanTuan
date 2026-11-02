"""Multi-turn regressions for preserving facts and delivering usable work."""
from __future__ import annotations

import asyncio
import json

import pytest

from app.agent.citations import evidence_cards
from app.agent.resume_policy import clarification_context, relevant_clarification_history
from app.agent.runtime import _web_source_urls
from app.domain import AgentClarification, AgentMessage, AgentPlan, AgentRunSnapshot
from app.domain import ModelResponse, ToolCall, ToolError, ToolResult
from app.agent.progress import clarification_repair_reason
from app.tools import AskUserTool
from app.search_options import WebSearchOptions
from test_agent_runtime import CountingTool, ScriptedModel, runtime_for


def test_repeated_clarification_keeps_original_goal_full_material_and_draft():
    material = "项目说明：" + "甲" * 1500 + "技术栈 FastAPI / SQLite"
    snapshot = AgentRunSnapshot(
        route_kind="content_creation", needs_plan=False,
        messages=[AgentMessage(role="user", content="为2024届、两年经验的候选人写简历"),
                  AgentMessage(role="user", content=material),
                  AgentMessage(role="assistant", content="LocalDesk 项目经历初稿"),
                  AgentMessage(role="system", content="过期计划，不应复用"),
                  *[AgentMessage(role="user", content=f"补充信息 {i}") for i in range(6)]],
        clarification=AgentClarification(question="项目的技术栈是什么？"),
    )
    for _ in range(6):
        context, history, _ = clarification_context(snapshot)
        assert "2024届、两年经验" in context
        assert material in context
        assert any(message.content == "LocalDesk 项目经历初稿" for message in history)
        assert "过期计划" not in str(history)
        snapshot = snapshot.model_copy(update={"messages": [*history, AgentMessage(role="user", content="继续补充")]})


def test_read_evidence_survives_as_data_without_replaying_tool_calls():
    payload = {"tool_name": "search_public_web", "status": "done", "sources": [
        {"url": "https://example.com/source", "content": "公开证据内容"},
    ]}
    snapshot = AgentRunSnapshot(route_kind="content_creation", needs_plan=False, messages=[
        AgentMessage(role="assistant", payload={"tool_calls": [{"id": "old", "name": "search_public_web"}]}),
        AgentMessage(role="tool", tool_call_id="old", payload=payload),
    ])
    _, history, _ = clarification_context(snapshot)
    assert len(history) == 1 and history[0].role == "assistant"
    assert "公开证据内容" in history[0].content
    assert not history[0].payload.get("tool_calls") and history[0].tool_call_id is None
    assert _web_source_urls(history) == {"https://example.com/source"}
    assert evidence_cards(history, "")[0]["excerpt"] == "公开证据内容"


def test_public_source_switch_drops_private_evidence_without_losing_user_facts():
    snapshot = AgentRunSnapshot(route_kind="library_search", needs_plan=False, messages=[
        AgentMessage(role="user", content="我明确提供的事实"),
        AgentMessage(role="tool", payload={"status": "done", "tool_name": "search_library", "excerpt": "私人原文"}),
    ])
    _, history, _ = clarification_context(snapshot)
    assert "私人原文" in str(relevant_clarification_history(history, ("search_library",)))
    public = relevant_clarification_history(history, ("search_public_web",))
    assert "私人原文" not in str(public)
    assert public[0].content == "我明确提供的事实"


def test_redundant_question_after_readme_is_repaired_into_a_project_draft():
    async def scenario():
        question = "项目技术栈是什么？"
        model = ScriptedModel([
            ModelResponse(content='{"kind":"content_creation","sources":[]}'),
            ModelResponse(tool_calls=[ToolCall(id="repeat", name="ask_user", arguments={
                "question": question, "options": [{"label": "粘贴README"}, {"label": "手动补充"}],
            })]),
            ModelResponse(content="LocalDesk｜独立开发：构建本地优先的AI协作工作台，支持对话与资料管理。技术栈待补充。"),
        ])
        snapshot = AgentRunSnapshot(route_kind="content_creation", needs_plan=False,
            messages=[AgentMessage(role="user", content="帮我写简历，LocalDesk是我独立开发的项目。")],
            clarification=AgentClarification(question=question))
        result = await runtime_for(model, AskUserTool()).run(
            "README：团团是本地优先的AI协作工作台，支持对话与资料管理。", resume=snapshot)
        assert result.status == "done" and result.snapshot is None
        assert "LocalDesk｜独立开发" in result.content
        assert any(event.tool_name == "clarification_validator" for event in result.events)
    asyncio.run(scenario())


def test_real_blocker_and_noncreative_tasks_can_still_ask():
    history = [AgentMessage(role="assistant", content="选择哪份？", payload={"clarification_question": True})]
    assert not clarification_repair_reason("content_creation", {
        "question": "选择哪份？", "blocking_reason": "两份材料涉及不同人，用户未指定修改对象",
    }, history)
    assert not clarification_repair_reason("conversation", {"question": "选择哪份？"}, history)


def test_writing_requires_an_actual_draft_even_without_tools():
    async def scenario():
        model = ScriptedModel([
            ModelResponse(content=json.dumps({"kind": "content_creation", "sources": [],
                "goal": "根据LocalDesk说明生成简历项目条目", "expects_draft": True})),
            ModelResponse(content="请补充技术栈，我可以帮你写。"),
            ModelResponse(content='{"complete":false,"reason":"只有索取信息，没有项目条目"}'),
            ModelResponse(content="LocalDesk｜独立开发：构建本地优先的AI工作台，支持对话和文件管理。技术栈待补充。"),
            ModelResponse(content='{"complete":true,"reason":"已交付基于已知事实的项目初稿"}'),
        ])
        result = await runtime_for(model).run("写简历项目条目：LocalDesk由我独立开发，是支持对话和文件管理的本地优先AI工作台。")
        assert result.status == "done" and "LocalDesk｜独立开发" in result.content
        checks = [event for event in result.events if event.tool_name == "delivery_validator"]
        assert [event.status for event in checks] == ["running", "done"]
        assert result.plan.expected_output == "根据LocalDesk说明生成简历项目条目"
        assert not model.requests[2].tools and "evidence" in model.requests[2].messages[-1].content
    asyncio.run(scenario())


@pytest.mark.parametrize("review", [
    ModelResponse(content="无法判断"),
    ModelResponse(content='{"complete":false,"reason":"仍未提供草稿"}'),
])
def test_failed_delivery_cannot_be_marked_done_or_repair_forever(review):
    async def scenario():
        model = ScriptedModel([
            ModelResponse(content='{"kind":"content_creation","sources":[],"expects_draft":true}'),
            ModelResponse(content="你想怎么补充？"), review,
            ModelResponse(content="请先补充资料。"), review,
        ])
        result = await runtime_for(model).run("帮我起草项目经历")
        assert result.status == "failed" and result.error.code == "delivery_requirements_unmet"
        assert "尚未交付" in result.content
        assert len(model.requests) <= 5
    asyncio.run(scenario())


def test_delivery_obligation_survives_a_checkpoint():
    async def scenario():
        model = ScriptedModel([
            ModelResponse(content="仅给通用建议"),
            ModelResponse(content='{"complete":false,"reason":"缺少项目条目"}'),
        ])
        snapshot = AgentRunSnapshot(resume_mode="checkpoint", route_kind="content_creation", needs_plan=False,
            expects_draft=True, delivery_retry_used=True,
            plan=AgentPlan(
                goal="写项目经历", route="content_creation", expected_output="项目条目"),
            messages=[AgentMessage(role="user", content="LocalDesk独立开发")])
        result = await runtime_for(model).run("继续", resume=snapshot)
        assert result.status == "failed" and result.error.code == "delivery_requirements_unmet"
    asyncio.run(scenario())


class UnavailableSearch(CountingTool):
    def __init__(self, *, blocked=False):
        super().__init__("search_public_web")
        self.blocked = blocked

    async def execute(self, arguments, context):
        self.calls += 1
        return ToolResult(ok=False, status="blocked" if self.blocked else "failed",
            message="无法读取公开来源", error=ToolError(
                code="external_query_not_approved" if self.blocked else "tool_timeout", message="无法读取公开来源"))


def test_search_timeout_still_delivers_supplied_project_material_as_partial_result():
    async def scenario():
        search = UnavailableSearch()
        model = ScriptedModel([
            ModelResponse(content='{"kind":"content_creation","sources":["public_web"],"expects_draft":true}'),
            ModelResponse(tool_calls=[ToolCall(id="web", name="search_public_web", arguments={"query": "公开项目核验"})]),
            ModelResponse(content="LocalDesk｜独立开发：实现本地AI工作台。外部核验待完成。"),
            ModelResponse(content='{"complete":true,"reason":"基于用户已提供材料形成初稿并说明缺口"}'),
        ])
        result = await runtime_for(model, search).run("按我提供的LocalDesk说明写项目条目，并联网核验。", web_search_options=WebSearchOptions(enabled=True))
        assert "LocalDesk｜独立开发" in result.content and "部分结果" in result.content
        assert result.status == "failed" and result.stop_reason == "partial_result"
        assert search.calls == 1 and not model.requests[2].tools
        assert any(event.tool_name == "task_degradation" for event in result.events)
    asyncio.run(scenario())


def test_source_approval_failure_is_never_downgraded_or_bypassed():
    async def scenario():
        search = UnavailableSearch(blocked=True)
        model = ScriptedModel([
            ModelResponse(content='{"kind":"content_creation","sources":["public_web"]}'),
            ModelResponse(tool_calls=[ToolCall(id="web", name="search_public_web", arguments={"query": "公开项目核验"})]),
        ])
        result = await runtime_for(model, search).run("根据说明写项目条目", web_search_options=WebSearchOptions(enabled=True))
        assert result.status == "failed" and result.error.code == "external_query_not_approved"
        assert not any(event.tool_name == "task_degradation" for event in result.events)
        assert len(model.requests) == 2
    asyncio.run(scenario())


def test_deterministic_library_writing_route_cannot_skip_delivery_review():
    async def scenario():
        model = ScriptedModel([
            ModelResponse(tool_calls=[ToolCall(id="read", name="get_library_context", arguments={})]),
            ModelResponse(content="LocalDesk：本地资料协作工具，支持文件管理。"),
            ModelResponse(content='{"complete":true,"reason":"实际改写了用户材料"}'),
        ])
        result = await runtime_for(model, CountingTool("get_library_context")).run(
            "根据我的笔记改写文章：LocalDesk是支持文件管理的本地资料协作工具。")
        assert result.status == "done" and result.events[-1].tool_name == "delivery_validator"
        assert result.plan.expected_output
    asyncio.run(scenario())


def test_retained_web_evidence_uses_existing_model_context_budget():
    from app.agent.research_context import MAX_WEB_CONTEXT_CHARS, web_context_messages

    payload = {"retained_evidence": True, "tool_name": "search_public_web", "status": "done", "sources": [
        {"url": "https://example.com/source", "content": "长网页正文" * 20000},
    ]}
    message = AgentMessage(role="assistant", content=json.dumps(payload), payload=payload)
    projected = web_context_messages([message])
    assert "https://example.com/source" in projected[0].content
    assert len(projected[0].content) < MAX_WEB_CONTEXT_CHARS
    assert len(message.content) > MAX_WEB_CONTEXT_CHARS
