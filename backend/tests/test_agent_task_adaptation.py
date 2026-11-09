"""Regression cases for selecting evidence sources and correcting a paused task."""
from __future__ import annotations

import asyncio
import json

import pytest

from app.agent.capability_resolver import CapabilityRequest, resolve_capabilities
from app.agent.egress_policy import APPROVE_OPTION_LABEL
from app.agent.orchestration import refine_route_from_classifier, route_task
from app.agent.plan_builder import plan_mode
from app.agent.resume_policy import clarification_context, should_abandon_snapshot
from app.db import init_db
from app.domain import AgentClarification, AgentMessage, AgentRunSnapshot, ClarificationOption, ModelResponse, ToolCall
from app.knowledge import index_document, reset_embedder, search_knowledge, set_embedder
from app.knowledge.embeddings import HashEmbedder
from app.search_options import WebSearchOptions
from app.tooling import TOOL_SPECS
from app.tools import AskUserTool, ToolContext
from app.tools.library import SearchLibraryTool
from test_agent_runtime import CountingTool, ScriptedModel, evidence_review, runtime_for
from test_knowledge import PhraseEmbedder


TASK = "帮我整理一下这段时间社招情况，与大家的讨论"
CORRECTION = "不需要围绕我的简历，看一下大家的情况"
PUBLIC_INTENT = ModelResponse(content=json.dumps({
    "kind": "content_creation", "sources": ["public_web"], "needs_planning": True,
}))
PUBLIC_PLAN = ModelResponse(content=json.dumps({
    "goal": "综合近期公开社招行情与社区讨论",
    "expected_output": "有时间范围、来源和样本局限的社招摘要",
    "success_criteria": ["区分招聘统计和个体讨论", "对可核验结论提供来源"],
    "steps": [{"tool_name": "search_public_web", "title": "检索近期招聘报告与公开讨论"}],
}))


def web_call(query="近期社招招聘报告 公开讨论", call_id="public-1"):
    return ModelResponse(tool_calls=[ToolCall(id=call_id, name="search_public_web", arguments={"query": query})])


def test_creation_does_not_implicitly_read_personal_library():
    route = route_task("写一篇关于沟通的短文", set(TOOL_SPECS))
    assert route.allowed_tools == route.required_tools == ()
    local = route_task("根据我的笔记写一篇关于沟通的短文", set(TOOL_SPECS))
    assert "get_library_context" in local.required_tools


def test_clarification_context_keeps_option_meanings_without_obsolete_instructions():
    snapshot = AgentRunSnapshot(
        route_kind="content_creation", needs_plan=False,
        messages=[AgentMessage(role="user", content=TASK), AgentMessage(role="system", content="旧计划")],
        clarification=AgentClarification(question="选择来源？", options=[
            ClarificationOption(label="私人记录", send="基于我的笔记"),
            ClarificationOption(label="公开讨论", send="研究公开平台的近期讨论"),
        ]),
    )
    context, history, _ = clarification_context(snapshot)
    assert "2. 公开讨论：研究公开平台的近期讨论" in context
    assert TASK in context and "旧计划" not in context
    assert all(message.role != "system" for message in history)


@pytest.mark.parametrize("consent", [True, False])
def test_semantic_sources_are_separate_from_kind_and_consent(consent):
    surface = set(TOOL_SPECS) - (set() if consent else {"search_public_web"})
    route = refine_route_from_classifier(route_task(TASK, surface), TASK, surface, PUBLIC_INTENT)
    assert route.kind == "content_creation"
    assert route.allowed_tools == (("search_public_web",) if consent else ())
    assert route.required_tools == route.allowed_tools
    if consent:
        assert plan_mode(route) == "llm"
    # Even a full registry cannot override the independent consent flag.
    denied = resolve_capabilities(CapabilityRequest("web_search", need_public_web=True),
                                  registered_specs=TOOL_SPECS, web_search_allowed=False)
    assert denied.allowed_tools == ()


@pytest.mark.parametrize("output", [
    '{"kind":"content_creation","sources":["queue_application"]}',
    '{"kind":"content_creation","sources":"public_web"}',
    '{"kind":"content_creation","sources":[],"needs_planning":"true"}',
])
def test_invalid_understanding_cannot_grant_tools(output):
    route = route_task(TASK, set(TOOL_SPECS))
    assert refine_route_from_classifier(route, TASK, set(TOOL_SPECS), ModelResponse(content=output)) == route


def test_research_plan_runs_public_search_without_reading_resume():
    async def scenario():
        private = CountingTool("get_library_context")
        search = CountingTool("search_public_web")
        model = ScriptedModel([PUBLIC_INTENT, PUBLIC_PLAN, web_call(),
                               ModelResponse(content="公开材料摘要。[来源](https://example.com/source)"), evidence_review()])
        result = await runtime_for(model, private, search, AskUserTool()).run(
            TASK, web_search_options=WebSearchOptions(enabled=True))
        assert result.status == "done"
        assert private.calls == 0 and search.calls == 1
        assert result.plan.expected_output == "有时间范围、来源和样本局限的社招摘要"
        assert result.plan.success_criteria == ["区分招聘统计和个体讨论", "对可核验结论提供来源"]
        assert [step.tool_name for step in result.plan.steps] == ["search_public_web"]
        execution = model.requests[2]
        assert {tool.name for tool in execution.tools} == {"search_public_web", "ask_user"}
        assert any("本次任务的 UTC 日期" in message.content for message in execution.messages)
    asyncio.run(scenario())


def test_short_followup_understands_recent_user_goal_before_planning():
    async def scenario():
        complete_goal = "整理近期公开社招行情与平台讨论，不围绕个人简历"
        understanding = ModelResponse(content=json.dumps({
            "kind": "content_creation", "goal": complete_goal,
            "sources": ["public_web"], "needs_planning": True,
        }))
        model = ScriptedModel([understanding, PUBLIC_PLAN, web_call(),
                               ModelResponse(content="公开材料摘要。[来源](https://example.com/source)"), evidence_review()])
        search = CountingTool("search_public_web")
        result = await runtime_for(model, search).run(
            "继续", history=[AgentMessage(role="user", content=complete_goal),
                             AgentMessage(role="assistant", content="此前助手的错误猜测：围绕个人简历")],
            web_search_options=WebSearchOptions(enabled=True),
        )
        assert result.status == "done" and search.calls == 1
        assert complete_goal in model.requests[0].messages[0].content
        assert "此前助手的错误猜测" not in model.requests[0].messages[0].content
        assert complete_goal in model.requests[1].messages[0].content
    asyncio.run(scenario())


def test_ambiguous_discussion_can_clarify_then_replan_for_public_evidence():
    async def scenario():
        model = ScriptedModel([
            ModelResponse(content='{"kind":"content_creation","sources":[]}'),
            ModelResponse(tool_calls=[ToolCall(id="clarify", name="ask_user", arguments={
                "question": "你指公开平台讨论，还是已有聊天记录？",
                "options": [{"label": "公开平台讨论"}, {"label": "已有聊天记录"}],
            })]),
            PUBLIC_INTENT, PUBLIC_PLAN, web_call(),
            ModelResponse(content="公开材料摘要。[来源](https://example.com/source)"), evidence_review(),
        ])
        private = CountingTool("get_library_context")
        search = CountingTool("search_public_web")
        runtime = runtime_for(model, private, search, AskUserTool())
        paused = await runtime.run(TASK, web_search_options=WebSearchOptions(enabled=True))
        assert paused.status == "waiting_user" and private.calls == 0
        result = await runtime.run("公开平台讨论", resume=paused.snapshot)
        assert result.status == "done" and search.calls == 1 and private.calls == 0
        assert result.events[0].data["replanned_after_reply"]
        classification = model.requests[2].messages[0].content
        assert TASK in classification and "公开平台讨论" in classification
    asyncio.run(scenario())


@pytest.mark.parametrize("reply", [CORRECTION, "了解公开社招行情", "联网查看近期公开社招讨论"])
def test_correction_replaces_old_tools_and_keeps_external_approval(reply):
    async def scenario():
        snapshot = AgentRunSnapshot(
            route_kind="content_creation", needs_plan=False,
            allowed_tools=["get_library_context", "search_library"],
            completed_tools=["get_library_context"],
            web_search_options=WebSearchOptions(enabled=True),
            messages=[AgentMessage(role="user", content=TASK),
                      AgentMessage(role="system", content="旧计划：必须围绕私人简历回答"),
                      AgentMessage(role="tool", content="不应复用的私人原文", tool_call_id="read-1")],
            clarification=AgentClarification(question="需要整理哪个来源？", options=[
                ClarificationOption(label="了解公开社招行情"), ClarificationOption(label="私人记录")]),
        )
        assert not should_abandon_snapshot(reply, snapshot)
        private = CountingTool("get_library_context")
        library = CountingTool("search_library")
        search = CountingTool("search_public_web")
        model = ScriptedModel([PUBLIC_INTENT, PUBLIC_PLAN, web_call()])
        runtime = runtime_for(model, private, library, search, AskUserTool())
        paused = await runtime.run(reply, resume=snapshot)
        assert paused.status == "waiting_user"
        assert [step.tool_name for step in paused.plan.steps] == ["search_public_web"]
        assert paused.snapshot.requires_query_approval
        assert search.calls == private.calls == library.calls == 0
        assert TASK in model.requests[0].messages[0].content
        assert "不应复用的私人原文" not in str(model.requests)
        assert "必须围绕私人简历回答" not in str(model.requests)
        # Restoring the new web-only plan must not lose its inherited privacy boundary.
        model.responses.extend([web_call(call_id="approved"), web_call("另一条未批准查询", "not-approved")])
        held = await runtime.run(APPROVE_OPTION_LABEL, resume=paused.snapshot)
        assert held.status == "waiting_user" and search.calls == 1
        assert held.snapshot.pending_search_queries == ["另一条未批准查询"]
        assert held.snapshot.requires_query_approval
    asyncio.run(scenario())


def test_semantic_public_request_without_consent_has_actionable_notice():
    async def scenario():
        search = CountingTool("search_public_web")
        model = ScriptedModel([PUBLIC_INTENT, ModelResponse(content="请开启联网搜索后继续。")])
        result = await runtime_for(model, search).run(TASK, web_search_options=WebSearchOptions(enabled=False))
        assert result.status == "done" and search.calls == 0
        assert not model.requests[-1].tools
        assert any("当前任务未允许使用搜索能力" in message.content for message in model.requests[-1].messages)
    asyncio.run(scenario())


def test_declining_web_does_not_emit_a_false_enable_search_notice():
    async def scenario():
        model = ScriptedModel([
            ModelResponse(content='{"kind":"content_creation","sources":[]}'),
            ModelResponse(content="基于你给的内容整理。"),
            ModelResponse(content='{"complete":true,"reason":"已完成改写"}'),
        ])
        result = await runtime_for(model, CountingTool("search_public_web")).run(
            "不用联网，改写我给的内容", web_search_options=WebSearchOptions(enabled=False))
        assert result.status == "done"
        assert not any("用户要求联网" in message.content for message in model.requests[-1].messages)
    asyncio.run(scenario())


def test_irrelevant_resume_is_not_reported_as_recruitment_evidence(tmp_path):
    path = tmp_path / "knowledge.db"
    set_embedder(HashEmbedder())
    try:
        init_db(path)
        index_document("library_source", 1, "示例简历", "负责 Python 和 FastAPI 接口开发及数据平台维护。", db_path=path)
        assert search_knowledge("社招讨论", ["library_source"], 6, path, relevant_only=True) == []
        index_document("library_source", 2, "社招讨论记录", "社招讨论中大家反映面试周期较长。", db_path=path)
        matches = search_knowledge("社招讨论", ["library_source"], 6, path, relevant_only=True)
        assert {item["source_id"] for item in matches} == {"2"}
        assert search_knowledge("FastAPI", ["library_source"], 6, path, relevant_only=True)
    finally:
        reset_embedder()


def test_search_message_counts_distinct_sources_and_marks_empty_evidence(tmp_path, monkeypatch):
    path = tmp_path / "library.db"
    init_db(path)
    from app.library.sources import create_text_source
    source = create_text_source(title="讨论资料", content="第一段\n第二段", enabled=True, db_path=path)
    monkeypatch.setattr("app.tools.library.search_knowledge", lambda *args, **kwargs: [
        {"id": 1, "source_id": str(source["id"]), "content": "第一段"},
        {"id": 2, "source_id": str(source["id"]), "content": "第二段"},
    ])
    context = ToolContext(platform_name="test")
    tool = SearchLibraryTool(path)
    result = asyncio.run(tool.execute({"query": "讨论"}, context))
    assert result.data["source_count"] == 1
    assert result.data["evidence_status"] == "found"
    assert "1 份资料的 2 个相关片段" in result.message
    monkeypatch.setattr("app.tools.library.search_knowledge", lambda *args, **kwargs: [])
    empty = asyncio.run(tool.execute({"query": "讨论"}, context))
    assert empty.data["evidence_status"] == "empty"
    assert "不存在" in empty.message


def test_semantic_filter_keeps_paraphrase_and_removes_unrelated_neighbours(tmp_path):
    path = tmp_path / "semantic.db"
    set_embedder(PhraseEmbedder({
        "微服务": [1.0, 0.0, 0.0, 0.0],
        "分布式接口": [1.0, 0.0, 0.0, 0.0],
        "门店销售": [0.0, 1.0, 0.0, 0.0],
    }, dimensions=4))
    try:
        init_db(path)
        index_document("library_source", 1, "服务开发", "负责微服务平台。", db_path=path)
        index_document("library_source", 2, "销售经历", "负责门店销售。", db_path=path)
        matches = search_knowledge("分布式接口", ["library_source"], 5, path, relevant_only=True)
        assert {row["source_id"] for row in matches} == {"1"}
    finally:
        reset_embedder()


def test_automatic_search_permission_does_not_force_search_for_a_greeting():
    async def scenario():
        search = CountingTool("search_public_web")
        model = ScriptedModel([ModelResponse(content="你好，有什么需要帮忙的？")])
        result = await runtime_for(model, search).run("你好", web_search_options=WebSearchOptions(enabled=True))
        assert result.status == "done"
        assert search.calls == 0
    asyncio.run(scenario())


def test_explicit_image_request_starts_fresh_from_clarification():
    snapshot = AgentRunSnapshot(
        route_kind="conversation", needs_plan=False,
        clarification=AgentClarification(question="希望怎么处理？", options=[
            ClarificationOption(label="优化提示词"),
        ]),
    )
    assert should_abandon_snapshot("“请生成这张图片：\n一只蓝色的小狗", snapshot)
    assert not should_abandon_snapshot("优化提示词", snapshot)
    assert not should_abandon_snapshot("只要提示词，不要生成图片", snapshot)
