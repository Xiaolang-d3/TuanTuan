"""Citation formatting must never rewrite the user's research task or draft."""
from __future__ import annotations
import asyncio
import json
import pytest
from app.agent.citations import apply_citation_patches, evaluate_citation_patches, evidence_cards, repair_messages
from app.agent.runtime import validate_web_citations
from app.domain import AgentMessage, AgentPlan, AgentPlanStep, AgentRunSnapshot, ModelResponse, ToolCall, ToolResult
from app.models import ModelProviderError
from app.search_options import WebSearchOptions
from app.tools.limits import MAX_RESULT_DATA_CHARS, govern_tool_result
from app.tools.search_public_web import compact_web_data
from app.research.web import build_evidence_bundle
from test_agent_runtime import CountingTool, ScriptedModel, runtime_for

URL = "https://example.com/report"
QUOTE = "本报告统计社会招聘职位变化，仅代表本平台样本。"
DRAFT = "本平台社招职位存在变化。[报告](https://invented.example/report)"
CARDS = [{"url": URL, "title": "社招报告", "excerpt": QUOTE, "published_at": "2026-10-20"}]

def patch_response(action="replace_url", target="https://invented.example/report", source_id="C1", quote=QUOTE):
    return ModelResponse(content=json.dumps({"verified": True, "patches": [{"action": action, "target": target, "source_id": source_id, "quote": quote}]}, ensure_ascii=False))

class EvidenceTool(CountingTool):
    def __init__(self):
        super().__init__("search_public_web")
    async def execute(self, arguments, context):
        self.calls += 1
        return ToolResult(ok=True, status="done", data={"sources": [{"url": URL, "title": "社招报告", "content": QUOTE}], "evidence": CARDS}, message="已返回公开报告")

def web_call():
    return ModelResponse(tool_calls=[ToolCall(id="web", name="search_public_web", arguments={"query": "社招报告"})])

def test_unicode_encoding_and_parentheses_are_not_false_unknown_sources():
    assert validate_web_citations("[报告](https://example.com/社会招聘)", {"https://example.com/%E7%A4%BE%E4%BC%9A%E6%8B%9B%E8%81%98"})[0]
    assert validate_web_citations("[报告](https://example.com/Report_(2026))", {"https://example.com/Report_(2026)"})[0]
    assert validate_web_citations("[报告](<https://example.com/report>)", {URL})[0]
    assert not validate_web_citations("[报告](https://example.com/report?id=2)", {URL + "?id=1"})[0]
    assert not validate_web_citations("[报告](https://other.example/report)", {URL})[0]

def test_patch_changes_url_only_and_preserves_every_word():
    result = apply_citation_patches(DRAFT, CARDS, patch_response())
    assert result == DRAFT.replace("https://invented.example/report", URL)
    assert validate_web_citations(result, {URL})[0]
    plain = "本平台社招职位存在变化。"
    assert apply_citation_patches(plain, CARDS, patch_response("cite_after", plain)) == plain + f"[来源]({URL})"


def test_known_link_does_not_skip_evidence_review_and_unsupported_number_is_removed():
    async def scenario():
        supported = f"本报告仅代表本平台样本。[报告]({URL})"
        unsupported = f"2025年企业AI招聘应用率79%。[报告]({URL})"
        model = ScriptedModel([web_call(), ModelResponse(content=supported + "\n\n" + unsupported),
            ModelResponse(content=json.dumps({"verified": True, "patches": [
                {"action": "remove_claim", "target": unsupported},
            ]}))])
        result = await runtime_for(model, EvidenceTool()).run("联网核实招聘统计")
        assert result.status == "done" and supported in result.content
        assert "79%" not in result.content
        assert "逐项核对每个事实和数字" in model.requests[-1].messages[0].content
        assert result.events[-1].tool_name == "citation_validator"
    asyncio.run(scenario())


@pytest.mark.parametrize("payload", [
    {"verified": False, "patches": []},
    {"patches": []},
    {"verified": True, "patches": [{"action": "remove_claim", "target": "79%"}]},
    {"verified": True, "patches": [{"action": "remove_claim", "target": f"应用率79%。[来源]({URL})"}]},
])
def test_unverified_verdict_and_partial_sentence_deletions_are_rejected(payload):
    draft = f"企业AI招聘应用率79%。[来源]({URL})"
    assert apply_citation_patches(draft, CARDS, ModelResponse(content=json.dumps(payload))) is None

@pytest.mark.parametrize("response", [
    ModelResponse(content="不能将社招改成校园招聘。"),
    ModelResponse(content='{"patches":[],"answer":"校园招聘的新正文"}'),
    patch_response(source_id="C99"),
    patch_response(quote="来源中从未出现过的这条杜撰证据内容"),
    patch_response(target="并不存在的网址"),
    patch_response("cite_after", "唯一出现的完整句子"),
])
def test_invalid_or_off_topic_repairs_are_rejected(response):
    assert apply_citation_patches(DRAFT, CARDS, response) is None

def test_insertion_cannot_change_existing_link_labels_or_urls():
    assert apply_citation_patches(DRAFT, CARDS, patch_response("cite_after", "https://invented.example/report")) is None


@pytest.mark.parametrize("fence", ["```json\n{}\n```", "```\n{}\n```", "```JSON\n{}\n```", "```json{}```"])
def test_json_fences_preserve_the_same_strict_patch_validation(fence):
    valid = patch_response()
    assert apply_citation_patches(DRAFT, CARDS, ModelResponse(content=fence.format(valid.content))) == DRAFT.replace("https://invented.example/report", URL)
    assert evaluate_citation_patches(DRAFT, CARDS, ModelResponse(content=fence.format('{"patches":[]}'))) == (None, "empty_patches")


@pytest.mark.parametrize("response,code", [
    (ModelResponse(content="private-raw-response"), "invalid_format"),
    (ModelResponse(content='{"patches":[]}'), "empty_patches"),
    (patch_response(source_id="C99"), "unknown_source"),
    (patch_response(quote="从未出现在证据中的杜撰引文内容"), "quote_not_found"),
    (patch_response(target="https://missing.example/"), "target_not_found"),
    (patch_response("cite_after", "不在原文中出现的句子"), "invalid_anchor"),
])
def test_rejected_patches_return_specific_diagnostics_without_raw_response(response, code):
    assert evaluate_citation_patches(DRAFT, CARDS, response) == (None, code)


def test_failed_review_updates_one_node_with_diagnostics_without_publishing_unverified_draft():
    async def scenario():
        model = ScriptedModel([web_call(), ModelResponse(content="本平台社招职位存在变化。"), ModelResponse(content='{"patches":[]}')])
        result = await runtime_for(model, EvidenceTool()).run("联网整理社招讨论")
        events = [event for event in result.events if event.tool_name == "citation_validator"]
        assert result.status == "failed" and result.error.code == "citation_validation_failed"
        assert "本平台社招职位存在变化。" not in result.content
        assert "来源核验" in result.content
        assert result.snapshot.citation_draft == "本平台社招职位存在变化。"
        assert len(events) == 2 and events[0].tool_call_id == events[1].tool_call_id
        assert events[-1].data["repair_error_code"] == "empty_patches"
        assert "未找到可确认的引用补丁" in result.error.message
        assert "没有使用 Markdown" in events[0].data["validation_reason"]
    asyncio.run(scenario())

def test_repair_uses_compact_evidence_and_no_historical_instructions():
    messages = [AgentMessage(role="system", content="obsolete-planning-instruction")]
    messages.extend(AgentMessage(role="tool", tool_call_id=str(index), payload={"tool_name": "search_public_web", "sources": [{"url": URL, "title": "社招报告", "content": QUOTE}], "evidence": CARDS}) for index in range(11))
    cards = evidence_cards(messages, DRAFT)
    assert len(cards) == 1
    compact = repair_messages("整理近期社招讨论", "帮我搜一下社招情况", DRAFT, cards)
    assert len(compact) == 2 and "obsolete-planning-instruction" not in str(compact)
    assert "整理近期社招讨论" in compact[1].content
    assert json.loads(compact[1].content)["draft"] == DRAFT

def test_runtime_repairs_last_round_without_another_search_or_streaming_json():
    async def scenario():
        model = ScriptedModel([web_call(), ModelResponse(content=DRAFT), patch_response()])
        tool = EvidenceTool(); streamed = []
        async def capture(event):
            if event.type == "text_delta": streamed.append(event.delta)
        result = await runtime_for(model, tool, max_rounds=2).run("联网整理社招讨论", event_callback=capture)
        assert result.status == "done" and tool.calls == 1
        assert result.content == DRAFT.replace("https://invented.example/report", URL)
        assert result.rounds == 3
        assert model.requests[-1].tools == [] and model.requests[-1].tool_choice == "none"
        assert model.requests[-1].reasoning_effort == "low"
        assert model.requests[-1].parameters["max_output_tokens"] == 3000
        assert not any('"patches"' in part for part in streamed)
        assert result.events[-1].tool_name == "citation_validator" and result.events[-1].status == "done"
        assert len({event.tool_call_id for event in result.events if event.tool_name == "citation_validator"}) == 1
    asyncio.run(scenario())


def test_oversized_draft_does_not_start_another_model_request():
    async def scenario():
        draft = DRAFT + "超长草稿" * 7000
        model = ScriptedModel([web_call(), ModelResponse(content=draft)])
        result = await runtime_for(model, EvidenceTool()).run("联网整理社招讨论")
        assert result.status == "failed" and draft not in result.content
        assert "超出引用修正预算" in result.error.message
        assert len(model.requests) == 2
    asyncio.run(scenario())


def test_retryable_repair_timeout_is_not_retried():
    async def scenario():
        model = ScriptedModel([web_call(), ModelResponse(content=DRAFT),
            ModelProviderError("request_timeout", "模型超时", retryable=True), patch_response()])
        tool = EvidenceTool()
        result = await runtime_for(model, tool).run("联网整理社招讨论")
        assert result.status == "failed" and DRAFT not in result.content
        assert len(model.requests) == 3 and tool.calls == 1
        assert not any(event.tool_call_id.startswith("model-retry") for event in result.events)
    asyncio.run(scenario())


def test_repair_deadline_cancels_provider_and_withholds_unverified_draft(monkeypatch):
    from app.agent import runtime as runtime_module
    monkeypatch.setattr(runtime_module, "CITATION_REPAIR_TIMEOUT_SECONDS", 0.01)
    class HangingRepair(ScriptedModel):
        cancelled = False
        async def generate(self, request):
            if request.tool_choice == "none" and request.reasoning_effort == "low":
                self.requests.append(request)
                try:
                    await asyncio.Event().wait()
                finally:
                    self.cancelled = True
            return await super().generate(request)
    async def scenario():
        model = HangingRepair([web_call(), ModelResponse(content=DRAFT)])
        result = await runtime_for(model, EvidenceTool()).run("联网整理社招讨论")
        assert result.status == "failed" and DRAFT not in result.content
        assert "引用修正超时" in result.error.message
        assert model.cancelled and len(model.requests) == 3
    asyncio.run(scenario())


def test_repair_card_ranking_focuses_on_bad_link_and_preserves_full_allowlist():
    valid = [f"https://example.com/valid/{i}" for i in range(40)]
    draft = "\n".join(f"已有结论{i}。[有效]({url})" for i, url in enumerate(valid))
    claim = "专项招聘活动提供四万七千个社会招聘岗位。"
    draft += f"\n{claim}[招聘活动](https://unknown.example/child)"
    source = "https://example.com/parent"
    messages = [AgentMessage(role="tool", payload={"tool_name": "search_public_web", "sources": [
        *[{"url": url, "title": "已有资料", "content": "其他就业信息" * 200} for url in valid],
        {"url": source, "title": "招聘活动", "content": claim * 50},
    ]})]
    cards = evidence_cards(messages, draft)
    assert cards[0]["url"] == source and len(cards) <= 8
    compact = repair_messages("社招", "整理社招", draft, cards, allowed_urls=set(valid + [source]))
    payload = json.loads(compact[1].content)
    assert payload["invalid_urls"] == ["https://unknown.example/child"]
    assert len(compact[1].content) <= 24000
    assert payload["draft"] == draft
    async def scenario():
        snapshot = AgentRunSnapshot(resume_mode="checkpoint", route_kind="web_search", needs_plan=False,
            allowed_tools=["search_public_web"], required_tools=["search_public_web"], completed_tools=["search_public_web"], rounds_used=2,
            citation_retry_used=True, citation_draft=draft, citation_sources=cards, citation_allowed_urls=valid + [source],
            messages=compact, web_search_options=WebSearchOptions(enabled=True))
        restored = AgentRunSnapshot.model_validate_json(snapshot.model_dump_json())
        model = ScriptedModel([patch_response(target="https://unknown.example/child", quote=claim)])
        result = await runtime_for(model, EvidenceTool(), max_rounds=2).run("整理社招", resume=restored)
        assert result.status == "done"
        assert result.content == draft.replace("https://unknown.example/child", source)
    asyncio.run(scenario())


def test_web_model_context_is_bounded_deduplicated_and_does_not_mutate_audit():
    from app.agent.research_context import MAX_WEB_CONTEXT_CHARS, web_context_messages
    messages = [AgentMessage(role="user", content="社招讨论"), AgentMessage(role="assistant", payload={"signed_reasoning": "opaque", "tool_calls": []})]
    for index in range(11):
        sources = [{"url": f"https://example.com/report/{j}?business=2026", "title": "社招公开报告", "snippet": QUOTE, "content": "重复网页正文" * 400} for j in range(index * 5, index * 5 + 8)]
        messages.append(AgentMessage(role="tool", tool_call_id=f"tool-{index}", content="找到资料", payload={"tool_name": "search_public_web", "query": f"社招 {index}", "status": "done", "sources": sources, "evidence": build_evidence_bundle(sources)}))
    before = [m.model_dump_json() for m in messages]
    projected = web_context_messages(messages)
    tools = [m for m in projected if m.role == "tool"]
    assert sum(len(json.dumps(m.payload, ensure_ascii=False)) for m in tools) <= MAX_WEB_CONTEXT_CHARS
    assert [m.tool_call_id for m in tools] == [f"tool-{i}" for i in range(11)]
    urls = [s["url"] for m in tools for s in m.payload["sources"]]
    assert len(urls) == len(set(urls))
    assert set(urls) == {f"https://example.com/report/{j}?business=2026" for j in range(58)}
    assert all("?business=2026" in url for url in urls)
    assert any(len(s["excerpt"]) >= 800 for m in tools for s in m.payload["sources"])
    assert any(QUOTE in s["excerpt"] for m in tools for s in m.payload["sources"])
    assert projected[0] is messages[0] and projected[1] is messages[1]
    assert [m.model_dump_json() for m in messages] == before

@pytest.mark.parametrize("repair", [
    ModelResponse(content="不能把社招统一改成校园招聘；上一份纪要保持原样。"),
    ModelProviderError("service_unavailable", "修正服务暂不可用", retryable=False),
    ModelResponse(tool_calls=[ToolCall(id="forbidden", name="search_public_web", arguments={"query": "校招"})]),
])
def test_failed_repair_withholds_unverified_draft_and_never_runs_tools(repair):
    async def scenario():
        model = ScriptedModel([web_call(), ModelResponse(content=DRAFT), repair]); tool = EvidenceTool()
        result = await runtime_for(model, tool).run("联网整理社招讨论")
        assert result.status == "failed" and result.error.code == "citation_validation_failed"
        assert DRAFT not in result.content and "校园招聘" not in result.content
        assert "未能通过来源核验" in result.content and tool.calls == 1
        assert result.events[-1].data["original_draft_preserved"]
        assert result.events[-1].status == "failed"
    asyncio.run(scenario())

def test_checkpoint_restores_citation_draft_and_disables_all_tools():
    async def scenario():
        snapshot = AgentRunSnapshot(resume_mode="checkpoint", route_kind="web_search", needs_plan=False,
            allowed_tools=["search_public_web"], required_tools=["search_public_web"], completed_tools=["search_public_web"], rounds_used=2,
            citation_retry_used=True, citation_draft=DRAFT, citation_sources=CARDS,
            messages=repair_messages("社招讨论", "整理社招", DRAFT, CARDS), web_search_options=WebSearchOptions(enabled=True),
            plan=AgentPlan(goal="社招讨论", route="web_search", steps=[AgentPlanStep(id="search", title="检索公开报告", tool_name="search_public_web", risk="external_read", status="done")]))
        restored = AgentRunSnapshot.model_validate_json(snapshot.model_dump_json())
        model = ScriptedModel([patch_response()]); tool = EvidenceTool()
        result = await runtime_for(model, tool, max_rounds=2).run("整理社招", resume=restored)
        assert result.status == "done" and tool.calls == 0 and model.requests[0].tools == []
        assert result.content == DRAFT.replace("https://invented.example/report", URL)
    asyncio.run(scenario())

def test_web_budget_preserves_substantial_evidence_and_search_snippet():
    sources = [{"url": f"https://example.com/{index}", "title": "社招报告", "domain": "example.com", "score": 0.8, "snippet": QUOTE, "content": "网站导航和登录提示" * 1000} for index in range(8)]
    evidence = build_evidence_bundle(sources)
    assert evidence[0]["excerpt"].startswith(QUOTE)
    data = compact_web_data({"sources": sources, "evidence": evidence, "source_count": 8, "evidence_count": 8})
    assert len(json.dumps(data, ensure_ascii=False)) <= MAX_RESULT_DATA_CHARS
    assert all(len(item["excerpt"]) >= 800 for item in data["evidence"])
    bounded = govern_tool_result(ToolResult(ok=True, status="done", data=data, message="找到公开来源"))
    assert bounded.data == data
    assert all(QUOTE in item["excerpt"] for item in bounded.data["evidence"])


def test_failed_citation_answer_does_not_poison_retry_history_or_summary(tmp_path, monkeypatch):
    from app import db
    from app.chat.conversations import create_conversation
    from app.chat.service import agent_history, refresh_conversation_summary, save_chat_message
    path = tmp_path / "tuantuan.db"
    monkeypatch.setattr(db, "DB_PATH", path)
    db.init_db(path)
    conversation = create_conversation("社招讨论")
    cid = conversation["id"]
    save_chat_message("user", "整理公开社招情况", conversation_id=cid)
    failed = save_chat_message("assistant", "错误改成校园招聘的正文", conversation_id=cid, payload={
        "agent": {"status": "failed", "error": {"code": "citation_validation_failed"}},
    })
    current = save_chat_message("user", "重新整理社招情况", conversation_id=cid)
    history = agent_history(cid, current["id"])
    assert "校园招聘" not in str(history)
    assert "未通过来源引用校验" in str(history)
    for index in range(14):
        save_chat_message("user", f"后续请求 {index}", conversation_id=cid)
    refresh_conversation_summary(cid)
    with db.connect(path) as conn:
        summary = conn.execute("SELECT summary FROM conversations WHERE id=?", (cid,)).fetchone()[0]
        original = conn.execute("SELECT content FROM chat_messages WHERE id=?", (failed["id"],)).fetchone()[0]
    assert "校园招聘" not in summary and "未通过来源引用校验" in summary
    assert original == "错误改成校园招聘的正文"
