from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from fastapi import HTTPException

from ..agent.resume_policy import is_explicit_abandon, matches_clarification_option, should_abandon_snapshot
from ..agent.run_store import AgentRunStore, REPLAYABLE_RUN_STATUSES
from ..agent.snapshots import load_run_snapshot
from ..db import connect, row_to_dict
from ..domain import AgentRunSnapshot
from ..search_options import WebSearchOptions, normalize_web_search_options
from .contracts import ChatMessageIn
from .service import restore_snapshot_attachment_text


@dataclass(frozen=True)
class RunRecovery:
    """已有 run 的记录、可重放消息和待补写的结果。"""

    persisted_run: dict[str, Any] | None
    cached_execution: dict[str, Any] | None
    recovered_user_message: dict[str, Any] | None
    recovering_terminal_result: bool


def load_run_recovery(store: AgentRunStore, run_id: str, conversation_id: int) -> RunRecovery:
    """加载指定对话的持久化 run 和消息，拒绝冲突或损坏的 run。"""
    persisted_run = store.get_run(run_id)
    if persisted_run is not None and persisted_run.get("model_selection_invalid"):
        raise HTTPException(status_code=409, detail="运行的模型绑定信息损坏，无法恢复")
    if (
        persisted_run is not None
        and persisted_run.get("conversation_id") is not None
        and int(persisted_run["conversation_id"]) != conversation_id
    ):
        raise HTTPException(status_code=409, detail="runId 已属于其他对话")
    if persisted_run is not None and persisted_run.get("status") == "running":
        raise HTTPException(status_code=409, detail="该 Agent run 仍在其他执行器中运行")
    cached_execution: dict[str, Any] | None = None
    if (
        persisted_run is not None
        and persisted_run.get("result") is not None
        and persisted_run.get("user_message_id")
        and persisted_run.get("assistant_message_id")
    ):
        with connect() as conn:
            cached_user = conn.execute(
                "SELECT * FROM chat_messages WHERE id = ? AND conversation_id = ?",
                (persisted_run["user_message_id"], conversation_id),
            ).fetchone()
            cached_assistant = conn.execute(
                "SELECT * FROM chat_messages WHERE id = ? AND conversation_id = ?",
                (persisted_run["assistant_message_id"], conversation_id),
            ).fetchone()
        if cached_user is not None and cached_assistant is not None:
            cached_execution = {
                "result": persisted_run["result"],
                "user_message": row_to_dict(cached_user),
                "assistant_message": row_to_dict(cached_assistant),
            }

    recovered_user_message: dict[str, Any] | None = None
    if (
        cached_execution is None
        and persisted_run is not None
        and persisted_run.get("user_message_id")
        and (
            persisted_run.get("result") is not None
            or persisted_run.get("status") == "interrupted"
        )
    ):
        with connect() as conn:
            bound_user = conn.execute(
                "SELECT * FROM chat_messages WHERE id = ? AND conversation_id = ?",
                (persisted_run["user_message_id"], conversation_id),
            ).fetchone()
        if bound_user is not None:
            recovered_user_message = row_to_dict(bound_user)
    recovering_terminal_result = bool(
        cached_execution is None and recovered_user_message is not None and persisted_run is not None
        and persisted_run.get("status") in REPLAYABLE_RUN_STATUSES and persisted_run.get("result") is not None
    )
    return RunRecovery(persisted_run, cached_execution, recovered_user_message, recovering_terminal_result)


@dataclass(frozen=True)
class ResumeDecision:
    """恢复运行所用的快照、路由文本和联网搜索选项。"""

    snapshot: AgentRunSnapshot | None
    abandon_snapshot: bool
    dsh_waiting: bool
    routing_content: str
    search_options: WebSearchOptions


def resolve_run_resume(
    payload: ChatMessageIn,
    conversation_id: int,
    conversation_kernel: str,
    run_store: AgentRunStore,
    recovery: RunRecovery,
) -> ResumeDecision:
    """判断当前请求是否续接旧任务，恢复适用的附件上下文和搜索选项。"""
    persisted_run = recovery.persisted_run
    recovered_user_message = recovery.recovered_user_message
    # The built-in runtime recovers an interrupted turn from its own checkpoint.
    # A conversation's waiting snapshot normally belongs to a separate confirmation turn.
    resume_snapshot = load_run_snapshot(conversation_id) if persisted_run is None else None
    if conversation_kernel == "dsh" and persisted_run is not None and persisted_run["status"] == "interrupted":
        parent_id = persisted_run.get("parent_run_id")
        if parent_id:
            parent = run_store.get_run(parent_id)
            if parent is not None and parent["conversation_id"] == conversation_id:
                resume_snapshot = parent.get("checkpoint")
            # A missing checkpoint may not turn an interrupted answer into a new query.
            if resume_snapshot is None or recovered_user_message is None:
                resume_snapshot = AgentRunSnapshot(route_kind="dsh", needs_plan=False)
        else:
            waiting_snapshot = load_run_snapshot(conversation_id)
            if waiting_snapshot is not None and waiting_snapshot.route_kind == "dsh":
                # The run may have crashed before the parent link was committed. Without
                # that link we cannot prove which waiting request it was answering.
                resume_snapshot = AgentRunSnapshot(route_kind="dsh", needs_plan=False)
    fields = payload.model_fields_set
    inherited_options = resume_snapshot.web_search_options if resume_snapshot is not None else None
    # Only same-run recovery retains consent. A new request can inherit
    # search preferences from a waiting task, but must opt in explicitly.
    if persisted_run is not None:
        # A run ID names an immutable turn, even if a reconnect submits changes.
        search_options = persisted_run.get("web_search_options") or WebSearchOptions()
    else:
        search_options = normalize_web_search_options(
            enabled=payload.web_search is True,
            topic=payload.web_search_topic if "web_search_topic" in fields else None,
            source_preference=payload.web_search_source_preference if "web_search_source_preference" in fields else None,
            legacy_mode=payload.web_search_mode if "web_search_mode" in fields else None,
            base=inherited_options,
            provider=payload.web_search_provider if inherited_options is None or inherited_options.provider is None else None,
        )
    # Consent no longer rewrites routing text; it only extends the trusted tool
    # surface inside the runtime, so the content stays verbatim.
    trusted_routing_content = payload.content
    dsh_waiting = conversation_kernel == "dsh" and resume_snapshot is not None and resume_snapshot.route_kind == "dsh"
    if dsh_waiting:
        if recovered_user_message is not None:
            trusted_routing_content = recovered_user_message["content"]
        # DSH owns its paused turn; only an explicit topic change on a new run may abandon it.
        abandon_snapshot = (
            persisted_run is None and is_explicit_abandon(payload.content)
            and not matches_clarification_option(payload.content, resume_snapshot)
        )
    else:
        abandon_snapshot = bool(resume_snapshot is not None and should_abandon_snapshot(
            payload.content, resume_snapshot, routing_text=trusted_routing_content,
        ))
    if abandon_snapshot:
        resume_snapshot = None
        if persisted_run is None:
            # A new topic must not inherit consent/preferences from an abandoned task.
            search_options = normalize_web_search_options(
                enabled=payload.web_search is True,
                topic=payload.web_search_topic if "web_search_topic" in fields else None,
                source_preference=payload.web_search_source_preference if "web_search_source_preference" in fields else None,
                legacy_mode=payload.web_search_mode if "web_search_mode" in fields else None,
                provider=payload.web_search_provider,
            )
    elif resume_snapshot is not None:
        resume_snapshot = restore_snapshot_attachment_text(conversation_id, resume_snapshot)
    return ResumeDecision(resume_snapshot, abandon_snapshot, dsh_waiting, trusted_routing_content, search_options)
