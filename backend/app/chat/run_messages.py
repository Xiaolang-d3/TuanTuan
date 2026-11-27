from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

from fastapi import HTTPException

from ..agent.run_store import AgentRunStore
from ..db import connect, row_to_dict
from ..domain import AgentMessage, AgentRunResult
from ..search_options import WebSearchOptions
from .contracts import ChatMessageIn
from .conversations import ensure_active_task, maybe_title_from_first_message
from .run_recovery import RunRecovery
from .service import (
    agent_history,
    attachment_context,
    refresh_conversation_summary,
    save_chat_message,
    save_stream_result,
    with_attachment_context,
)

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class RunMessages:
    """供聊天内核运行或重放的用户消息、输入与历史。"""

    task_id: int | None
    user_message: dict[str, Any]
    agent_input: str
    history: list[AgentMessage]
    image_urls: list[str]


def prepare_run_messages(
    payload: ChatMessageIn,
    conversation_id: int,
    conversation_kernel: str,
    run_store: AgentRunStore,
    run_id: str,
    recovery: RunRecovery,
    *,
    effective_content: str,
    prepared_attachments: tuple[str, list[dict[str, Any]], list[str]] | None,
    skill_binding: dict[str, Any] | None,
    search_options: WebSearchOptions,
    model_selection: dict[str, Any],
) -> RunMessages:
    """恢复已绑定的用户消息，或记录新一轮的消息并加载此前历史。"""
    cached_execution = recovery.cached_execution
    recovered_user_message = recovery.recovered_user_message
    if cached_execution is not None or recovered_user_message is not None:
        persisted_run = recovery.persisted_run
        assert persisted_run is not None
        task_id = int(persisted_run.get("task_id") or 0) or None
        user_message = cached_execution["user_message"] if cached_execution is not None else recovered_user_message
        agent_input = str(persisted_run.get("user_content") or payload.content)
        return RunMessages(task_id, user_message, agent_input, [], [])

    task_id = ensure_active_task(conversation_id)
    attachment_text, attachment_summaries, image_urls = prepared_attachments or attachment_context(
        conversation_id, payload.attachment_ids, payload.vision_attachment_ids
    )
    user_payload: dict[str, Any] = {}
    if skill_binding is not None:
        user_payload["skill_binding"] = skill_binding
    if attachment_summaries:
        user_payload["attachments"] = attachment_summaries
    user_payload["web_search_options"] = search_options.model_dump()
    agent_input = with_attachment_context(effective_content, attachment_text)
    try:
        run_store.start_run(
            run_id,
            conversation_id=conversation_id,
            task_id=task_id,
            user_content=agent_input,
            model_selection=model_selection,
            web_search_options=search_options,
            kernel=conversation_kernel,
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    user_message = save_chat_message(
        "user",
        payload.content,
        user_payload or None,
        conversation_id,
        task_id,
    )
    run_store.bind_messages(
        run_id,
        user_message_id=int(user_message["id"]),
    )
    maybe_title_from_first_message(conversation_id, payload.content)
    history = agent_history(conversation_id, user_message["id"])
    return RunMessages(task_id, user_message, agent_input, history, image_urls)


def persist_run_result(
    run_store: AgentRunStore,
    run_id: str,
    conversation_id: int,
    messages: RunMessages,
    result: AgentRunResult,
) -> dict[str, Any]:
    """在同一事务保存并绑定助手消息，重复补写时返回同一条消息。"""
    with connect(run_store.db_path) as conn:
        # 锁住“检查绑定、插入、绑定”的整个过程，避免多个重连重复写入。
        conn.execute("BEGIN IMMEDIATE")
        run = conn.execute(
            "SELECT assistant_message_id FROM agent_execution_runs WHERE run_id = ? AND conversation_id = ?",
            (run_id, conversation_id),
        ).fetchone()
        if run is None:
            raise ValueError("运行不属于当前对话")
        if run["assistant_message_id"] is not None:
            assistant = row_to_dict(conn.execute(
                "SELECT * FROM chat_messages WHERE id = ? AND conversation_id = ? AND role = 'assistant'",
                (run["assistant_message_id"], conversation_id),
            ).fetchone())
            if assistant is None:
                raise ValueError("运行绑定的助手消息不可用")
            return {"user_message": messages.user_message, "assistant_message": assistant}
        completed = save_stream_result(
            conversation_id, messages.task_id, messages.user_message, result, connection=conn,
        )
        assistant_message_id = int(completed["assistant_message"]["id"])
        run_store.bind_messages(run_id, assistant_message_id=assistant_message_id, connection=conn)

    try:
        refresh_conversation_summary(conversation_id)
    except Exception:
        log.exception("Failed to refresh conversation summary after saving run %s", run_id)
    if result.status == "done":
        from ..agent.memory.service import schedule_memory_extraction

        schedule_memory_extraction(conversation_id, through_message_id=assistant_message_id)
    return completed
