"""DSH 内核适配器：把 DSH 会话事件翻译成 AgentStreamEvent。"""

from __future__ import annotations

import asyncio
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, AsyncIterator

from ....domain import AgentMessage, AgentRunResult, AgentRunSnapshot, AgentStreamEvent, ToolError, ToolEvent
from ....workspace import current_user_id
from ..base import KernelRuntime, KernelUnavailable, register_kernel_runtime
from .approvals import (
    answers_from_reply,
    approval_clarification,
    decision_from_reply,
    question_clarification,
)
from .client import DshClientError, DshTimeoutError, Notification
from .manager import DshRuntimeManager, DshSession, require_dsh_compatible_auth


_manager = DshRuntimeManager()
_pending: dict[tuple[int, int], dict[str, Any]] = {}


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _conversation_key(conversation_id: int) -> tuple[int, int]:
    return (int(current_user_id() or 0), int(conversation_id))


def _text_from_content(content: Any) -> str:
    if not isinstance(content, list):
        return ""
    parts = []
    for block in content:
        if isinstance(block, dict) and block.get("type") == "text":
            parts.append(str(block.get("text") or ""))
    return "".join(parts)


def _history_rebuild_prompt(history: list[AgentMessage], user_content: str) -> str:
    """Turn canonical persisted messages into one safe startup input for a reset SDK session."""
    entries = []
    for message in history:
        content = str(message.content or "").strip()
        if not content:
            continue
        label = {"user": "用户", "assistant": "团团", "system": "系统上下文"}.get(
            message.role, "对话记录"
        )
        entries.append(f"{label}：{content}")
    if not entries:
        return user_content
    transcript = "\n".join(entries)
    return (
        "以下是应用保存的同一对话历史，仅用于理解当前请求。"
        "不要重新回答或执行历史中的请求，只处理最后的“当前用户消息”。\n"
        "--- 对话历史开始 ---\n"
        f"{transcript}\n"
        "--- 对话历史结束 ---\n"
        f"当前用户消息：\n{user_content}"
    )


def reset_dsh_conversation_state(conversation_id: int) -> None:
    """Drop approval state and make the next live session rebuild from the SQL conversation."""
    _pending.pop(_conversation_key(conversation_id), None)
    _manager.reset_for_history_change(conversation_id)


def reap_idle_dsh_sessions() -> list[int]:
    return _manager.reap_idle()


async def close_dsh_runtime() -> None:
    _pending.clear()
    await _manager.close_all()


def _tool_event(event_type: str, event: dict[str, Any], *, round_number: int) -> ToolEvent | None:
    data = event.get("data") if isinstance(event.get("data"), dict) else {}
    call_id = str(data.get("callId") or data.get("id") or event.get("callId") or "")
    name = str(data.get("name") or data.get("toolName") or event.get("name") or "tool")
    if not call_id:
        return None
    if event_type == "tool/call":
        return ToolEvent(
            round=round_number, tool_call_id=call_id, tool_name=name, status="running",
            message=f"正在执行 {name}", data={"arguments": data.get("arguments") or {}},
            started_at=_utc_now(),
        )
    if event_type == "tool/result":
        error = data.get("error")
        message = ""
        if error:
            message = str(error if isinstance(error, str) else error.get("message") or "工具执行失败")
        else:
            message = _text_from_content(data.get("content"))
        return ToolEvent(
            round=round_number, tool_call_id=call_id, tool_name=name,
            status="failed" if error else "done", message=message or f"{name} 完成",
            data={"result": data.get("result") or {}}, completed_at=_utc_now(),
        )
    return None


def _waiting_result(
    *,
    conversation_id: int,
    provider: str,
    model_selection: dict[str, Any],
    snapshot: AgentRunSnapshot,
    events: list[ToolEvent],
) -> AgentRunResult:
    return AgentRunResult(
        content="", provider=provider, platform="dsh", rounds=0,
        model_selection=model_selection, status="waiting_user", events=events, snapshot=snapshot,
    )


class DshKernelRuntime:
    def __init__(
        self,
        manager: DshRuntimeManager,
        connection: dict[str, Any],
        *,
        tool_ready_grace: float = 3.0,
    ) -> None:
        self._manager = manager
        self._connection = connection
        self._tool_ready_grace = tool_ready_grace

    async def run_stream(
        self,
        user_content: str,
        *,
        history: list[AgentMessage] | None = None,
        conversation_id: int | None = None,
        task_id: int | None = None,
        image_urls: list[str] | None = None,
        routing_content: str | None = None,
        web_search_mode: str = "auto",
        web_search_options: Any = None,
        resume: AgentRunSnapshot | None = None,
        run_id: str | None = None,
        model_selection: dict[str, Any] | None = None,
        skill_binding: dict[str, Any] | None = None,
        local_evidence: list[dict[str, Any]] | None = None,
        document_targets: list[dict[str, Any]] | None = None,
    ) -> AsyncIterator[AgentStreamEvent]:
        conversation_key = int(conversation_id or 0)
        provider = str(model_selection.get("profile_id") or "dsh") if model_selection else "dsh"
        selection = dict(model_selection or {})
        yield AgentStreamEvent(type="run_started")
        session: DshSession | None = None
        try:
            session = self._manager.acquire(conversation_key, self._connection)
            session.in_use = True
            session.last_active = time.monotonic()
            async for event in self._drive(
                session,
                conversation_key,
                user_content,
                history or [],
                resume,
                provider,
                selection,
            ):
                yield event
        except KernelUnavailable as exc:
            yield AgentStreamEvent(
                type="error",
                result=AgentRunResult(
                    content="DeepSeek Harness 内核当前不可用，本次任务未执行。",
                    provider=provider, platform="dsh", rounds=0, model_selection=selection,
                    status="failed",
                    error=ToolError(code="dsh_unavailable", message=str(exc), retryable=False),
                    events=[],
                ),
            )
        except (DshClientError, OSError) as exc:
            yield AgentStreamEvent(
                type="error",
                result=AgentRunResult(
                    content="DeepSeek Harness 内核执行失败，本次任务已终止。",
                    provider=provider, platform="dsh", rounds=0, model_selection=selection,
                    status="failed",
                    error=ToolError(code="dsh_runtime_failed", message=str(exc), retryable=True),
                    events=[],
                ),
            )
        finally:
            if session is not None:
                session.in_use = False
                session.last_active = time.monotonic()

    async def _drive(
        self,
        session: DshSession,
        conversation_id: int,
        user_content: str,
        history: list[AgentMessage],
        resume: AgentRunSnapshot | None,
        provider: str,
        selection: dict[str, Any],
    ) -> AsyncIterator[AgentStreamEvent]:
        client = session.client
        await client.start()
        fresh = not session.initialized
        if fresh:
            model = str(self._connection.get("model_name") or "")
            await client.initialize({
                "cwd": str(Path.cwd()),
                "provider": "deepseek-official",
                "model": model,
            })
            session.initialized = True
        pending_key = _conversation_key(conversation_id)
        pending = _pending.get(pending_key)
        if fresh and pending is not None:
            # A fresh DSH process cannot answer a request owned by the previous
            # process. Treat the user's reply as a new turn with SQL history.
            _pending.pop(pending_key, None)
            pending = None
        if pending is not None and resume is not None:
            reply = " ".join((user_content or "").split())
            if pending["kind"] == "approval":
                await client.respond(pending["request_id"], decision_from_reply(reply))
            else:
                await client.respond(pending["request_id"], answers_from_reply(pending["request"], reply))
            _pending.pop(pending_key, None)
        else:
            query_content = user_content
            if fresh:
                query_content = _history_rebuild_prompt(history, user_content)
            blocks: list[dict[str, Any]] = [{"type": "text", "text": query_content}]
            if fresh and self._tool_ready_grace > 0:
                await asyncio.sleep(self._tool_ready_grace)
            await client.session_query(f"session-{conversation_id}", blocks)
            if fresh:
                session.needs_history_rebuild = False

        events: list[ToolEvent] = []
        text_parts: list[str] = []
        reasoning_parts: list[str] = []
        round_number = 0
        started_at = _utc_now()
        finished = False
        finish_status = "done"
        finish_error: ToolError | None = None
        while not finished:
            try:
                request = await client.next_request(timeout=0.05)
            except DshTimeoutError:
                request = None
            if request is not None:
                session.last_active = time.monotonic()
                if request.method == "approval/request":
                    clarification = approval_clarification(request)
                    _pending[pending_key] = {
                        "kind": "approval", "request_id": request.params.get("requestId"), "request": request,
                    }
                else:
                    clarification = question_clarification(request)
                    _pending[pending_key] = {
                        "kind": "question", "request_id": request.params.get("requestId"), "request": request,
                    }
                snapshot = AgentRunSnapshot(
                    route_kind="dsh", needs_plan=False, clarification=clarification,
                    messages=[AgentMessage(role="user", content=user_content)],
                    model_selection=selection,
                )
                yield AgentStreamEvent(
                    type="waiting_user",
                    result=_waiting_result(
                        conversation_id=conversation_id, provider=provider,
                        model_selection=selection, snapshot=snapshot, events=events,
                    ),
                )
                return
            try:
                notification = await client.next_notification(timeout=0.5)
            except DshTimeoutError:
                continue
            session.last_active = time.monotonic()
            if notification.method != "session.event":
                if notification.method == "session.status" and notification.params.get("status") == "idle":
                    finished = True
                continue
            event = notification.params.get("event")
            if not isinstance(event, dict):
                continue
            event_type = event.get("type")
            data = event.get("data") if isinstance(event.get("data"), dict) else {}
            if event_type == "assistant/message":
                content = data.get("message", {})
                if isinstance(content, dict):
                    content = content.get("content")
                delta = _text_from_content(content)
                if delta:
                    text_parts.append(delta)
                    yield AgentStreamEvent(type="text_delta", delta=delta)
            elif event_type in {"reasoning/delta", "assistant/attempt"}:
                delta = str(data.get("delta") or _text_from_content(data.get("message")))
                if delta:
                    reasoning_parts.append(delta)
                    yield AgentStreamEvent(type="reasoning_delta", delta=delta)
            elif event_type in {"tool/call", "tool/result"}:
                tool_event = _tool_event(event_type, event, round_number=round_number)
                if tool_event is not None:
                    events.append(tool_event)
                    yield AgentStreamEvent(type="agent_event", event=tool_event)
            elif event_type == "turn/end":
                reason = data.get("reason") or {}
                kind = reason.get("kind") if isinstance(reason, dict) else reason
                if kind != "completed":
                    finish_status = "failed"
                    error_data = reason.get("error") if isinstance(reason, dict) else None
                    finish_error = ToolError(
                        code=str(error_data.get("code") or "dsh_turn_error") if isinstance(error_data, dict) else "dsh_turn_error",
                        message=str(error_data.get("message") or "任务未完成") if isinstance(error_data, dict) else str(reason),
                    )
                finished = True
        content = "".join(text_parts)
        yield AgentStreamEvent(
            type="completed" if finish_status == "done" else "error",
            result=AgentRunResult(
                content=content, provider=provider, platform="dsh", rounds=round_number,
                model_selection=selection, status=finish_status, error=finish_error, events=events,
                started_at=started_at, completed_at=_utc_now(),
            ),
        )


def build_dsh_runtime(agent_runtime: Any) -> KernelRuntime:
    from ...bootstrap import get_profile_connection

    selection = getattr(agent_runtime, "model_selection", None)
    require_dsh_compatible_auth(selection or {})
    profile_id = (selection or {}).get("profile_id")
    connection = get_profile_connection(profile_id, selection=selection)
    require_dsh_compatible_auth(connection)
    return DshKernelRuntime(_manager, connection)


register_kernel_runtime("dsh", build_dsh_runtime)
