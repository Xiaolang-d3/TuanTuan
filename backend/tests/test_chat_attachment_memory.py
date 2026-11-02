"""Attachment text must survive clarification and ordinary conversation history."""
from __future__ import annotations

import asyncio
import pytest

from app import db
from app.agent.resume_policy import clarification_context
from app.attachments.service import AttachmentStore, create_attachment, parse_attachment, delete_attachment
from app.chat.conversations import create_conversation
from app.chat.service import agent_history, restore_snapshot_attachment_text, save_chat_message, with_attachment_context
from app.domain import AgentClarification, AgentMessage, AgentRunSnapshot, ModelResponse
from test_agent_runtime import ScriptedModel, runtime_for


@pytest.fixture
def uploaded(tmp_path, monkeypatch):
    path = tmp_path / "tuantuan.db"
    monkeypatch.setattr(db, "DB_PATH", path)
    db.init_db(path)
    cid = create_conversation("附件续接")["id"]
    store = AttachmentStore(local_root=tmp_path / "objects")
    text = "前页内容。" * 300 + "\n团团：个人开源项目，负责运行时、工具编排与中断恢复。\n第二页末尾。"
    attachment = create_attachment(cid, "document", "resume.txt", text.encode(), store=store)
    attachment = parse_attachment(attachment["id"], store=store)
    row = save_chat_message("user", "帮我分析这份简历", {"attachments": [{"id": attachment["id"]}]}, cid)
    full = with_attachment_context(row["content"], f"[脱敏资料：resume.txt]\n{attachment['redacted_text']}")
    return cid, attachment, full, store, path


def snapshot(content):
    return AgentRunSnapshot(route_kind="conversation", needs_plan=False,
        messages=[AgentMessage(role="user", content=content)],
        clarification=AgentClarification(question="项目是个人还是公司项目？"))


def test_clarification_keeps_full_execution_text_but_bounds_routing_preview(uploaded):
    _, _, full, _, _ = uploaded
    context, history, _ = clarification_context(snapshot(full))
    assert history[0].content == full and history[0].content.endswith("第二页末尾。")
    assert "第二页末尾。" not in context
    assert "前页内容。" not in context
    assert "附件全文保留在执行上下文" in context
    assert len(context) < 1300


def test_attachment_and_all_user_facts_survive_more_than_four_clarification_replies(uploaded):
    _, _, full, _, _ = uploaded
    state = snapshot(full)
    state.messages += [AgentMessage(role="user", content=f"补充答复 {i}") for i in range(6)]
    _, history, _ = clarification_context(state)
    assert [m.content for m in history if m.role == "user"] == [full, *[f"补充答复 {i}" for i in range(6)]]
    assert state.messages[0].content == full


def test_ordinary_history_rehydrates_only_redacted_document_text(uploaded):
    cid, attachment, full, _, path = uploaded
    with db.connect(path) as conn:
        conn.execute("update attachments set parsed_text=? where id=?", ("private-original-not-for-model", attachment["id"]))
    current = save_chat_message("user", "继续看第二页项目", conversation_id=cid)
    history = agent_history(cid, current["id"])
    match = next(m for m in history if m.role == "user")
    assert match.content == full
    assert match.payload["document_attachment_ids"] == [attachment["id"]]
    assert "private-original-not-for-model" not in str(history)


def test_repairs_old_snapshot_from_an_exact_prefix_without_mutating_audit(uploaded):
    cid, attachment, full, _, _ = uploaded
    state = snapshot(full[:1000])
    repaired = restore_snapshot_attachment_text(cid, state)
    assert repaired.messages[0].content == full
    assert repaired.messages[0].payload["document_attachment_ids"] == [attachment["id"]]
    assert state.messages[0].content == full[:1000]


@pytest.mark.parametrize("boundary", ["other_conversation", "deleted", "cutoff", "changed_prefix", "approval"])
def test_does_not_recover_unavailable_or_unrelated_attachments(uploaded, boundary):
    cid, attachment, full, store, path = uploaded
    state = snapshot(full[:1000])
    if boundary == "other_conversation":
        cid = create_conversation("无关对话")["id"]
    elif boundary == "deleted":
        delete_attachment(attachment["id"], store=store)
    elif boundary == "cutoff":
        with db.connect(path) as conn:
            conn.execute("update conversations set context_cutoff_message_id=9999 where id=?", (cid,))
    elif boundary == "changed_prefix":
        state.messages[0].content = "不同的要求" + full[:1000]
    elif boundary == "approval":
        state.pending_search_queries = ["已绑定的公开查询"]
    repaired = restore_snapshot_attachment_text(cid, state)
    assert repaired.messages[0].content == state.messages[0].content
    assert len(repaired.messages[0].content) < len(full)


def test_deleted_attachment_is_not_reinserted_into_ordinary_history(uploaded):
    cid, attachment, _, store, _ = uploaded
    delete_attachment(attachment["id"], store=store)
    current = save_chat_message("user", "继续", conversation_id=cid)
    history = agent_history(cid, current["id"])
    assert all("第二页末尾。" not in m.content for m in history)


@pytest.mark.parametrize("boundary", ["disabled", "cutoff", "window"])
def test_attachment_history_respects_conversation_memory_controls(uploaded, monkeypatch, boundary):
    cid, _, _, _, path = uploaded
    if boundary == "disabled":
        monkeypatch.setattr("app.chat.service.get_agent_settings", lambda: {"conversation_memory_enabled": False})
    elif boundary == "cutoff":
        with db.connect(path) as conn:
            conn.execute("update conversations set context_cutoff_message_id=9999 where id=?", (cid,))
    else:
        monkeypatch.setattr("app.chat.service.get_agent_settings", lambda: {"conversation_memory_enabled": True, "context_message_limit": 4, "summary_enabled": False})
        for i in range(5):
            save_chat_message("user", f"其他问题 {i}", conversation_id=cid)
    current = save_chat_message("user", "继续", conversation_id=cid)
    assert all("第二页末尾。" not in m.content for m in agent_history(cid, current["id"]))


def test_resume_model_request_receives_the_entire_second_page(uploaded):
    _, _, full, _, _ = uploaded
    async def scenario():
        model = ScriptedModel([ModelResponse(content='{"kind":"conversation","sources":[]}'), ModelResponse(content="已根据第二页项目给出建议。")])
        result = await runtime_for(model).run("个人开源项目", resume=snapshot(full))
        assert result.status == "done"
        execution = model.requests[-1]
        assert any(m.role == "user" and m.content == full for m in execution.messages)
        assert any("第二页末尾。" in m.content for m in execution.messages)
        assert all(not m.payload.get("image_urls") for m in execution.messages)
    asyncio.run(scenario())
