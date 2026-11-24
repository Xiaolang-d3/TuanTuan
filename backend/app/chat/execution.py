from __future__ import annotations

import asyncio
import json
from typing import Any
from ag_ui.core import RunAgentInput
from fastapi import HTTPException
from fastapi.responses import StreamingResponse
from ..agent import get_agent_runtime
from .conversations import get_conversation
from .contracts import ChatMessageIn
from ..workspace import current_user_id
from .conversations import (
    end_active_task,
    ensure_active_task,
    maybe_title_from_first_message,
    reset_conversation_kernel_state,
)
from ..db import connect, json_dump, row_to_dict
from ..config import get_settings
from ..domain import AgentRunResult, AgentRunSnapshot, ToolError, ToolEvent
from ..agent.resume_policy import is_explicit_abandon, matches_clarification_option, should_abandon_snapshot
from ..agent.snapshots import clear_run_snapshot, load_run_snapshot
from ..agent.run_store import AgentRunStore, REPLAYABLE_RUN_STATUSES
from ..agent.model_binding import internal_model_selection, is_bound_selection, is_legacy_selection
from ..agent.kernels.base import KernelUnavailable, normalize_kernel, resolve_kernel_runtime, validate_kernel_selection
from ..observability.model_context import public_model_selection
from ..secret_store import SecretStoreUnavailable
from ..search_options import WebSearchOptions, legacy_web_search_mode, normalize_web_search_options
from ..research.search import validate_search_options
from ..research.web import WebResearchError
from .service import (
    agent_history as _agent_history,
    attachment_context as _attachment_context,
    default_conversation_id as _default_conversation_id,
    save_chat_message as _save_chat_message,
    save_stream_result as _save_stream_result,
    restore_snapshot_attachment_text,
    with_attachment_context,
)
from .ag_ui import event_stream
from .image_followup import resolve_image_followup


_active_chat_runs: dict[tuple[int, int], asyncio.Task[None]] = {}


def require_conversation(conversation_id: int) -> dict[str, Any]:
    conversation = get_conversation(conversation_id)
    if conversation is None:
        raise HTTPException(status_code=404, detail="对话不存在")
    return conversation


def _chat_run_key(conversation_id: int) -> tuple[int, int]:
    return (current_user_id() or 0, conversation_id)


async def cancel_current_agent_task(conversation_id: int | None = None) -> dict[str, Any]:
    resolved_id = conversation_id or _default_conversation_id()
    require_conversation(resolved_id)
    cancelled = False
    if AgentRunStore().request_cancel_for_conversation(resolved_id):
        cancelled = True
    active_task = _active_chat_runs.get(_chat_run_key(resolved_id))
    if active_task is not None and not active_task.done():
        active_task.cancel()
        cancelled = True
    with connect() as conn:
        rows = conn.execute(
            "SELECT id, payload_json FROM chat_messages WHERE role = 'assistant' AND conversation_id = ? ORDER BY id DESC",
            (resolved_id,),
        ).fetchall()
        for row in rows:
            payload = json.loads(row["payload_json"] or "{}")
            agent = payload.get("agent")
            if not agent or agent.get("status") not in {"waiting_user", "failed"}:
                continue
            agent["status"] = "cancelled"
            agent["error"] = None
            payload["agent"] = agent
            conn.execute(
                "UPDATE chat_messages SET payload_json = ? WHERE id = ?",
                (json_dump(payload), row["id"]),
            )
            cancelled = True
            break

    end_active_task(resolved_id)
    clear_run_snapshot(resolved_id)
    reset_conversation_kernel_state(resolved_id)
    return {"cancelled": cancelled}


def _durable_run_payload(run: dict[str, Any]) -> dict[str, Any]:
    run_id = str(run["run_id"])
    tool_executions = [
        {
            "tool_call_id": item.get("tool_call_id"),
            "tool_name": item.get("tool_name"),
            "risk": item.get("risk"),
            "status": item.get("status"),
            "attempt_count": item.get("attempt_count"),
            "created_at": item.get("created_at"),
            "updated_at": item.get("updated_at"),
            "completed_at": item.get("completed_at"),
        }
        for item in AgentRunStore().list_tool_executions(run_id)
    ]
    return {
        "run_id": run_id,
        "conversation_id": run.get("conversation_id"),
        "task_id": run.get("task_id"),
        "user_message_id": run.get("user_message_id"),
        "status": run.get("status"),
        "route_kind": run.get("route_kind"),
        "round_number": run.get("round_number"),
        "model_selection": public_model_selection(run.get("model_selection")),
        "stop_reason": run.get("stop_reason"),
        "cancel_requested": bool(run.get("cancel_requested")),
        "can_resume": bool(
            run.get("status") == "interrupted" and run.get("checkpoint") is not None
        ),
        "parent_run_id": run.get("parent_run_id"),
        "resumed_by_run_id": run.get("resumed_by_run_id"),
        "steps": AgentRunStore().list_steps(run_id),
        "tool_executions": tool_executions,
        "created_at": run.get("created_at"),
        "updated_at": run.get("updated_at"),
        "completed_at": run.get("completed_at"),
        "web_search_options": run["web_search_options"].model_dump() if run.get("web_search_options") is not None else None,
    }


def current_durable_agent_run(conversation_id: int | None = None) -> dict[str, Any]:
    resolved_id = conversation_id or _default_conversation_id()
    require_conversation(resolved_id)
    run = AgentRunStore().latest_for_conversation(resolved_id)
    return {"run": _durable_run_payload(run) if run is not None else None}


def cancel_durable_agent_run(run_id: str) -> dict[str, Any]:
    store = AgentRunStore()
    run = store.get_run(run_id)
    if run is None:
        raise HTTPException(status_code=404, detail="Agent run 不存在")
    if run.get("conversation_id") is not None:
        require_conversation(int(run["conversation_id"]))
    cancelled = store.request_cancel(run_id)
    refreshed = store.get_run(run_id)
    return {
        "cancelled": cancelled,
        "run": _durable_run_payload(refreshed),
    }


def require_configured_runtime(profile_id: str | None = None, *, selection: dict[str, Any] | None = None,
                               user_content: str | None = None, has_image_input: bool = False,
                               allow_chatgpt_subscription: bool = False):
    """Ensure model is configured before AG-UI streaming starts.

    Missing API key must surface as HTTP 400 (not an in-stream 200 failure or 500).
    """
    try:
        return get_agent_runtime(profile_id, selection=selection, user_content=user_content,
                                 has_image_input=has_image_input, allow_chatgpt_subscription=allow_chatgpt_subscription)
    except SecretStoreUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        detail = str(exc)
        if "必须先配置模型服务 API Key" in detail or "API Key" in detail:
            raise HTTPException(status_code=400, detail="必须先配置模型服务 API Key") from exc
        raise HTTPException(status_code=400, detail=detail) from exc


async def stream_chat_response(
    payload: ChatMessageIn,
    *,
    ag_ui_input: RunAgentInput,
    accept: str | None = None,
    allow_chatgpt_subscription: bool = False,
) -> StreamingResponse:
    conversation_id = payload.conversation_id or _default_conversation_id()
    conversation = require_conversation(conversation_id)
    conversation_kernel = normalize_kernel(conversation.get("kernel"))
    active = _active_chat_runs.get(_chat_run_key(conversation_id))
    if active is not None and not active.done():
        raise HTTPException(status_code=409, detail="当前对话已有正在执行的任务")

    run_store = AgentRunStore()
    persisted_run = run_store.get_run(ag_ui_input.run_id)
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

    # The built-in runtime recovers an interrupted turn from its own checkpoint.
    # A conversation's waiting snapshot normally belongs to a separate confirmation turn.
    resume_snapshot = load_run_snapshot(conversation_id) if cached_execution is None and persisted_run is None else None
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

    if cached_execution is None and not recovering_terminal_result:
        search_provider = get_settings().resolved_web_search_provider
        try:
            if search_options.enabled:
                validate_search_options(search_options, search_provider)
                if persisted_run is None and payload.web_search_provider is not None:
                    validate_search_options(
                        normalize_web_search_options(base=search_options, provider=payload.web_search_provider),
                        search_provider,
                    )
        except WebResearchError as exc:
            raise HTTPException(status_code=409 if exc.code == "web_search_provider_changed" else 422, detail=str(exc)) from exc
        if search_options.provider is None:
            search_options = normalize_web_search_options(base=search_options, provider=search_provider)

    effective_content = payload.content
    if persisted_run is None and resume_snapshot is None and not payload.attachment_ids and not payload.vision_attachment_ids:
        effective_content = resolve_image_followup(payload.content, conversation_id)
    runtime = None
    skill_binding = None
    if cached_execution is not None:
        skill_binding = (cached_execution["user_message"].get("payload") or {}).get("skill_binding")
    elif recovered_user_message is not None:
        skill_binding = (recovered_user_message.get("payload") or {}).get("skill_binding")
    elif resume_snapshot is not None and (dsh_waiting or "skill_id" not in payload.model_fields_set or (resume_snapshot.skill_binding is not None and payload.skill_id == resume_snapshot.skill_binding.get("id"))):
        skill_binding = resume_snapshot.skill_binding
    elif payload.skill_id:
        from ..extensions.contracts import ExtensionContext
        from ..extensions.skills import SkillService
        from ..extensions.repository import ExtensionNotFound, ExtensionUnavailable
        try:
            skill_binding = SkillService().binding(payload.skill_id, ExtensionContext.current())
        except (ExtensionNotFound, ExtensionUnavailable) as exc:
            raise HTTPException(409, str(exc)) from None
    if not dsh_waiting and resume_snapshot is not None and "skill_id" in payload.model_fields_set and skill_binding != resume_snapshot.skill_binding:
        resume_snapshot = None
    prepared_attachments = None
    if cached_execution is None and recovered_user_message is None and payload.vision_attachment_ids:
        prepared_attachments = _attachment_context(conversation_id, payload.attachment_ids, payload.vision_attachment_ids)
    model_selection: dict[str, Any] = {}
    if recovering_terminal_result:
        model_selection = internal_model_selection(persisted_run.get("model_selection"))
    elif cached_execution is None:
        persisted_selection = persisted_run.get("model_selection") if persisted_run is not None else None
        if persisted_run is not None and persisted_run.get("status") == "interrupted":
            historical_selection = persisted_selection
        elif resume_snapshot is not None:
            historical_selection = resume_snapshot.model_selection
        else:
            historical_selection = None
        if historical_selection is not None and not is_bound_selection(historical_selection) and not is_legacy_selection(historical_selection):
            raise HTTPException(status_code=409, detail="运行的模型绑定信息不完整，无法恢复")
        if is_bound_selection(historical_selection):
            runtime = require_configured_runtime(selection=historical_selection, allow_chatgpt_subscription=allow_chatgpt_subscription)
            model_selection = internal_model_selection(historical_selection)
        else:
            # Omitted inherits conversation; explicit null selects the account default.
            profile_id = (getattr(payload, "model_profile_id", None)
                          if "model_profile_id" in payload.model_fields_set
                          else conversation.get("model_profile_id"))
            runtime = require_configured_runtime(
                profile_id,
                user_content=effective_content if historical_selection is None else None,
                has_image_input=bool(historical_selection is None and conversation_kernel == "tuantuan" and prepared_attachments and prepared_attachments[2]),
                allow_chatgpt_subscription=allow_chatgpt_subscription,
            )
            if historical_selection is not None:
                model_selection = internal_model_selection(historical_selection)
            else:
                model_selection = internal_model_selection(getattr(runtime, "model_selection", None))
                if is_bound_selection(model_selection) and model_selection.get("selection_reason") not in {"image_intent", "text_intent", "vision_default", "vision_input"}:
                    model_selection["selection_reason"] = (
                        "explicit_profile" if "model_profile_id" in payload.model_fields_set and profile_id is not None
                        else "conversation_profile" if profile_id is not None else model_selection.get("selection_reason", "default_profile")
                    )
        if abandon_snapshot:
            clear_run_snapshot(conversation_id)

    if cached_execution is None and not recovering_terminal_result:
        try:
            validated_kernel = validate_kernel_selection(conversation_kernel)
            kernel_runtime = resolve_kernel_runtime(validated_kernel, runtime)
        except KernelUnavailable as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    if cached_execution is not None or recovered_user_message is not None:
        task_id = int(persisted_run.get("task_id") or 0) or None
        attachment_context, attachment_summaries, image_urls = "", [], []
        user_message = (
            cached_execution["user_message"]
            if cached_execution is not None
            else recovered_user_message
        )
        history = []
        agent_input = str(persisted_run.get("user_content") or payload.content)
    else:
        task_id = ensure_active_task(conversation_id)
        attachment_context, attachment_summaries, image_urls = prepared_attachments or _attachment_context(
            conversation_id, payload.attachment_ids, payload.vision_attachment_ids
        )
        user_payload: dict[str, Any] = {}
        if skill_binding is not None:
            user_payload["skill_binding"] = skill_binding
        if attachment_summaries:
            user_payload["attachments"] = attachment_summaries
        user_payload["web_search_options"] = search_options.model_dump()
        agent_input = effective_content
        agent_input = with_attachment_context(agent_input, attachment_context)
        try:
            run_store.start_run(
                ag_ui_input.run_id,
                conversation_id=conversation_id,
                task_id=task_id,
                user_content=agent_input,
                model_selection=model_selection,
                web_search_options=search_options,
                kernel=conversation_kernel,
            )
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        user_message = _save_chat_message(
            "user",
            payload.content,
            user_payload or None,
            conversation_id,
            task_id,
        )
        run_store.bind_messages(
            ag_ui_input.run_id,
            user_message_id=int(user_message["id"]),
        )
        maybe_title_from_first_message(conversation_id, payload.content)
        history = _agent_history(conversation_id, user_message["id"])

    queue: asyncio.Queue[tuple[str, dict[str, Any]] | None] = asyncio.Queue()

    def save_and_bind_result(result: AgentRunResult) -> dict[str, Any]:
        completed = _save_stream_result(conversation_id, task_id, user_message, result)
        assistant_message_id = int(completed["assistant_message"]["id"])
        run_store.bind_messages(ag_ui_input.run_id, assistant_message_id=assistant_message_id)
        if result.status == "done":
            from ..agent.memory.service import schedule_memory_extraction

            schedule_memory_extraction(conversation_id, through_message_id=assistant_message_id)
        return completed

    async def execute() -> None:
        partial_content = ""
        streamed_events: dict[str, ToolEvent] = {}
        current_task = asyncio.current_task()
        try:
            run = run_store.get_run(ag_ui_input.run_id)
            await queue.put(("run_started", {
                "user_message": user_message,
                "timing": {
                    "run_id": ag_ui_input.run_id,
                    "started_at": run.get("started_at") if run is not None else None,
                },
            }))
            if cached_execution is not None:
                result = cached_execution["result"]
                await queue.put(("text_reset", {}))
                if result.content:
                    await queue.put(("text_delta", {"delta": result.content}))
                await queue.put(
                    (
                        "completed",
                        {
                            "user_message": cached_execution["user_message"],
                            "assistant_message": cached_execution["assistant_message"],
                        },
                    )
                )
                return
            if recovering_terminal_result:
                # The result was committed before its chat row. Backfill it
                # without model/search requests or current provider validation.
                result = persisted_run["result"]
                await queue.put(("text_reset", {}))
                if result.content:
                    await queue.put(("text_delta", {"delta": result.content}))
                completed = save_and_bind_result(result)
                await queue.put(("completed", completed))
                return
            result = None
            if resume_snapshot is not None and not (dsh_waiting and persisted_run is not None):
                run_store.link_waiting_resume(
                    conversation_id,
                    ag_ui_input.run_id,
                )
            async for stream_event in kernel_runtime.run_stream(
                agent_input,
                history=history,
                conversation_id=conversation_id,
                task_id=task_id,
                image_urls=image_urls,
                routing_content=trusted_routing_content,
                web_search_mode=legacy_web_search_mode(search_options),
                web_search_options=search_options,
                resume=resume_snapshot,
                run_id=ag_ui_input.run_id,
                model_selection=model_selection,
                **({"skill_binding": skill_binding} if skill_binding is not None else {}),
                **({"local_evidence": [card for item in user_message.get("payload", {}).get("attachments", []) for card in item.get("evidence", [])]}
                   if any(item.get("evidence") for item in user_message.get("payload", {}).get("attachments", [])) else {}),
                **({"document_targets": [{"source_kind": "attachment", "attachment_id": item["id"], "source_revision": item["source_revision"]}
                                          for item in user_message.get("payload", {}).get("attachments", []) if item.get("source_revision")]}
                   if any(item.get("source_revision") for item in user_message.get("payload", {}).get("attachments", [])) else {}),
            ):
                if stream_event.type == "text_delta":
                    partial_content += stream_event.delta
                    await queue.put(("text_delta", {"delta": stream_event.delta}))
                elif stream_event.type == "reasoning_delta":
                    if stream_event.delta:
                        await queue.put(("reasoning_delta", {"delta": stream_event.delta}))
                elif stream_event.type == "text_reset":
                    partial_content = ""
                    await queue.put(("text_reset", {}))
                elif stream_event.type == "agent_event" and stream_event.event is not None:
                    streamed_events[stream_event.event.tool_call_id] = stream_event.event
                    await queue.put(
                        ("agent_event", {"event": stream_event.event.model_dump(mode="json")})
                    )
                elif stream_event.type in {"completed", "error"} or (
                    conversation_kernel == "dsh" and stream_event.type == "waiting_user"
                ):
                    result = stream_event.result
            if result is None:
                raise RuntimeError("Agent 流已结束，但没有返回结果")

            run_store.finish(ag_ui_input.run_id, result)
            completed = save_and_bind_result(result)
            await queue.put(("completed", completed))
        except asyncio.CancelledError:
            cancel_event = ToolEvent(
                round=0,
                tool_call_id="user-cancelled",
                tool_name="model_provider",
                status="cancelled",
                message="用户已停止生成",
            )
            streamed_events[cancel_event.tool_call_id] = cancel_event
            cancelled_result = AgentRunResult(
                content=partial_content.strip() or "已停止生成。",
                provider=str(model_selection.get("profile_id") or "legacy"),
                model_selection=model_selection,
                platform="manual",
                rounds=0,
                status="cancelled",
                error=ToolError(code="user_cancelled", message="用户已停止生成"),
                events=list(streamed_events.values()),
            )
            run_store.finish(ag_ui_input.run_id, cancelled_result)
            completed = _save_stream_result(
                conversation_id, task_id, user_message, cancelled_result
            )
            run_store.bind_messages(
                ag_ui_input.run_id,
                assistant_message_id=int(completed["assistant_message"]["id"]),
            )
            await queue.put(("cancelled", completed))
        except Exception as exc:
            failed_result = AgentRunResult(
                content="流式执行发生异常，本次任务已终止。",
                provider=str(model_selection.get("profile_id") or "legacy"),
                model_selection=model_selection,
                platform="manual",
                rounds=0,
                status="failed",
                error=ToolError(code="stream_failed", message=str(exc), retryable=True),
                events=list(streamed_events.values()),
            )
            run_store.finish(ag_ui_input.run_id, failed_result)
            completed = _save_stream_result(conversation_id, task_id, user_message, failed_result)
            run_store.bind_messages(
                ag_ui_input.run_id,
                assistant_message_id=int(completed["assistant_message"]["id"]),
            )
            await queue.put(("error", {**completed, "message": str(exc)}))
        finally:
            if _active_chat_runs.get(_chat_run_key(conversation_id)) is current_task:
                _active_chat_runs.pop(_chat_run_key(conversation_id), None)
            await queue.put(None)

    worker = asyncio.create_task(execute())
    _active_chat_runs[_chat_run_key(conversation_id)] = worker

    return StreamingResponse(
        event_stream(queue, worker, ag_ui_input, accept),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


def is_chat_running(conversation_id: int) -> bool:
    task = _active_chat_runs.get(_chat_run_key(conversation_id))
    return task is not None and not task.done()
