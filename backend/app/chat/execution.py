from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
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
    reset_conversation_kernel_state,
)
from ..db import connect, json_dump
from ..config import get_settings
from ..domain import AgentRunResult, AgentRunSnapshot, ToolError, ToolEvent
from ..agent.snapshots import clear_run_snapshot
from ..agent.run_store import AgentRunStore
from ..agent.model_binding import internal_model_selection, is_bound_selection, is_legacy_selection
from ..agent.kernels.base import KernelRuntime, KernelUnavailable, normalize_kernel, resolve_kernel_runtime, validate_kernel_selection
from ..observability.model_context import public_model_selection
from ..secret_store import SecretStoreUnavailable
from ..search_options import WebSearchOptions, legacy_web_search_mode, normalize_web_search_options
from ..research.search import validate_search_options
from ..research.web import WebResearchError
from .ag_ui import event_stream
from .image_followup import resolve_image_followup
from .run_messages import RunMessages, persist_run_result, prepare_run_messages
from .run_recovery import RunRecovery, load_run_recovery, resolve_run_resume
from .service import attachment_context, default_conversation_id as _default_conversation_id

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


@dataclass(frozen=True)
class _RunContext:
    run_id: str
    conversation_id: int
    conversation_kernel: str
    run_store: AgentRunStore
    recovery: RunRecovery
    messages: RunMessages
    kernel_runtime: KernelRuntime | None
    model_selection: dict[str, Any]
    resume_snapshot: AgentRunSnapshot | None
    dsh_waiting: bool
    routing_content: str
    search_options: WebSearchOptions
    skill_binding: dict[str, Any] | None


def _validate_run_search(
    options: WebSearchOptions, payload: ChatMessageIn, *, is_new_run: bool,
) -> WebSearchOptions:
    search_provider = get_settings().resolved_web_search_provider
    try:
        if options.enabled:
            validate_search_options(options, search_provider)
            if is_new_run and payload.web_search_provider is not None:
                validate_search_options(
                    normalize_web_search_options(base=options, provider=payload.web_search_provider),
                    search_provider,
                )
    except WebResearchError as exc:
        raise HTTPException(status_code=409 if exc.code == "web_search_provider_changed" else 422, detail=str(exc)) from exc
    if options.provider is None:
        return normalize_web_search_options(base=options, provider=search_provider)
    return options


def _resolve_skill_binding(
    payload: ChatMessageIn,
    recovery: RunRecovery,
    resume_snapshot: AgentRunSnapshot | None,
    dsh_waiting: bool,
) -> dict[str, Any] | None:
    cached_execution = recovery.cached_execution
    recovered_user_message = recovery.recovered_user_message
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
    return skill_binding


def _prepare_run(payload: ChatMessageIn, run_id: str, allow_chatgpt_subscription: bool) -> _RunContext:
    conversation_id = payload.conversation_id or _default_conversation_id()
    conversation = require_conversation(conversation_id)
    conversation_kernel = normalize_kernel(conversation.get("kernel"))
    active = _active_chat_runs.get(_chat_run_key(conversation_id))
    if active is not None and not active.done():
        raise HTTPException(status_code=409, detail="当前对话已有正在执行的任务")

    run_store = AgentRunStore()
    recovery = load_run_recovery(run_store, run_id, conversation_id)
    cached_execution = recovery.cached_execution
    persisted_run = recovery.persisted_run
    resume = resolve_run_resume(payload, conversation_id, conversation_kernel, run_store, recovery)
    resume_snapshot = resume.snapshot
    search_options = resume.search_options
    needs_kernel = cached_execution is None and not recovery.recovering_terminal_result
    if needs_kernel:
        search_options = _validate_run_search(search_options, payload, is_new_run=persisted_run is None)

    effective_content = payload.content
    if persisted_run is None and resume_snapshot is None and not payload.attachment_ids and not payload.vision_attachment_ids:
        effective_content = resolve_image_followup(payload.content, conversation_id)
    runtime = None
    skill_binding = _resolve_skill_binding(payload, recovery, resume_snapshot, resume.dsh_waiting)
    if not resume.dsh_waiting and resume_snapshot is not None and "skill_id" in payload.model_fields_set and skill_binding != resume_snapshot.skill_binding:
        resume_snapshot = None
    prepared_attachments = None
    if cached_execution is None and recovery.recovered_user_message is None and payload.vision_attachment_ids:
        prepared_attachments = attachment_context(conversation_id, payload.attachment_ids, payload.vision_attachment_ids)
    model_selection: dict[str, Any] = {}
    if recovery.recovering_terminal_result:
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
        if resume.abandon_snapshot:
            clear_run_snapshot(conversation_id)

    kernel_runtime = None
    if needs_kernel:
        try:
            validated_kernel = validate_kernel_selection(conversation_kernel)
            kernel_runtime = resolve_kernel_runtime(validated_kernel, runtime)
        except KernelUnavailable as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc

    messages = prepare_run_messages(
        payload, conversation_id, conversation_kernel, run_store, run_id, recovery,
        effective_content=effective_content, prepared_attachments=prepared_attachments,
        skill_binding=skill_binding, search_options=search_options, model_selection=model_selection,
    )
    return _RunContext(
        run_id=run_id,
        conversation_id=conversation_id,
        conversation_kernel=conversation_kernel,
        run_store=run_store,
        recovery=recovery,
        messages=messages,
        kernel_runtime=kernel_runtime,
        model_selection=model_selection,
        resume_snapshot=resume_snapshot,
        dsh_waiting=resume.dsh_waiting,
        routing_content=resume.routing_content,
        search_options=search_options,
        skill_binding=skill_binding,
    )


async def _execute_run(
    context: _RunContext,
    queue: asyncio.Queue[tuple[str, dict[str, Any]] | None],
    run_key: tuple[int, int],
) -> None:
    run_id, conversation_id = context.run_id, context.conversation_id
    run_store, messages = context.run_store, context.messages
    recovery = context.recovery
    model_selection = context.model_selection
    partial_content = ""
    streamed_events: dict[str, ToolEvent] = {}
    current_task = asyncio.current_task()
    try:
        run = run_store.get_run(run_id)
        await queue.put(("run_started", {
            "user_message": messages.user_message,
            "timing": {
                "run_id": run_id,
                "started_at": run.get("started_at") if run is not None else None,
            },
        }))
        if recovery.cached_execution is not None or recovery.recovering_terminal_result:
            cached = recovery.cached_execution
            result = cached["result"] if cached is not None else recovery.persisted_run["result"]
            await queue.put(("text_reset", {}))
            if result.content:
                await queue.put(("text_delta", {"delta": result.content}))
            if cached is not None:
                completed = {"user_message": cached["user_message"], "assistant_message": cached["assistant_message"]}
            else:
                # 持久化结果先于消息写入。恢复时补写消息，无需再次访问模型。
                completed = persist_run_result(run_store, run_id, conversation_id, messages, result)
            await queue.put(("completed", completed))
            return

        kernel_runtime = context.kernel_runtime
        assert kernel_runtime is not None
        result = None
        if context.resume_snapshot is not None and not (context.dsh_waiting and recovery.persisted_run is not None):
            run_store.link_waiting_resume(conversation_id, run_id)
        attachments = messages.user_message.get("payload", {}).get("attachments", [])
        local_evidence = [card for item in attachments for card in (item.get("evidence") or [])]
        document_targets = [
            {"source_kind": "attachment", "attachment_id": item["id"], "source_revision": item["source_revision"]}
            for item in attachments if item.get("source_revision")
        ]
        async for stream_event in kernel_runtime.run_stream(
            messages.agent_input,
            history=messages.history,
            conversation_id=conversation_id,
            task_id=messages.task_id,
            image_urls=messages.image_urls,
            routing_content=context.routing_content,
            web_search_mode=legacy_web_search_mode(context.search_options),
            web_search_options=context.search_options,
            resume=context.resume_snapshot,
            run_id=run_id,
            model_selection=model_selection,
            **({"skill_binding": context.skill_binding} if context.skill_binding is not None else {}),
            **({"local_evidence": local_evidence} if local_evidence else {}),
            **({"document_targets": document_targets} if document_targets else {}),
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
                context.conversation_kernel == "dsh" and stream_event.type == "waiting_user"
            ):
                result = stream_event.result
        if result is None:
            raise RuntimeError("Agent 流已结束，但没有返回结果")

        run_store.finish(run_id, result)
        completed = persist_run_result(run_store, run_id, conversation_id, messages, result)
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
        run_store.finish(run_id, cancelled_result)
        completed = persist_run_result(run_store, run_id, conversation_id, messages, cancelled_result)
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
        run_store.finish(run_id, failed_result)
        completed = persist_run_result(run_store, run_id, conversation_id, messages, failed_result)
        await queue.put(("error", {**completed, "message": str(exc)}))
    finally:
        if _active_chat_runs.get(run_key) is current_task:
            _active_chat_runs.pop(run_key, None)
        await queue.put(None)


async def stream_chat_response(
    payload: ChatMessageIn,
    *,
    ag_ui_input: RunAgentInput,
    accept: str | None = None,
    allow_chatgpt_subscription: bool = False,
) -> StreamingResponse:
    """准备并启动聊天运行，将结果事件封装为 AG-UI SSE 响应。"""
    context = _prepare_run(payload, ag_ui_input.run_id, allow_chatgpt_subscription)
    run_key = _chat_run_key(context.conversation_id)
    queue: asyncio.Queue[tuple[str, dict[str, Any]] | None] = asyncio.Queue()
    worker = asyncio.create_task(_execute_run(context, queue, run_key))
    _active_chat_runs[run_key] = worker

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
