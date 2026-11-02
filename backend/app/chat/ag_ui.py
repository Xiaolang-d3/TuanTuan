from __future__ import annotations

import asyncio
import json
from typing import Any
from ag_ui.core import (
    CustomEvent,
    ReasoningEndEvent,
    ReasoningMessageContentEvent,
    ReasoningMessageEndEvent,
    ReasoningMessageStartEvent,
    ReasoningStartEvent,
    RunAgentInput,
    RunErrorEvent,
    RunFinishedEvent,
    RunStartedEvent,
    StateSnapshotEvent,
    TextMessageContentEvent,
    TextMessageEndEvent,
    TextMessageStartEvent,
    ToolCallArgsEvent,
    ToolCallEndEvent,
    ToolCallResultEvent,
    ToolCallStartEvent,
)
from ag_ui.encoder import EventEncoder


async def event_stream(queue, worker, ag_ui_input: RunAgentInput, accept: str | None):
    encoder = EventEncoder(accept=accept)
    thread_id = ag_ui_input.thread_id
    run_id = ag_ui_input.run_id
    message_generation = 0
    assistant_message_id = f"{run_id}:assistant:{message_generation}"
    text_started = False
    started_tool_calls: set[str] = set()
    reasoning_generation = 0
    reasoning_message_id: str | None = None

    def encode(event: Any) -> str:
        return encoder.encode(event)

    def start_text_message() -> str | None:
        nonlocal text_started
        if text_started:
            return None
        text_started = True
        return encode(TextMessageStartEvent(messageId=assistant_message_id, role="assistant"))

    def close_reasoning() -> list[str]:
        nonlocal reasoning_message_id
        if reasoning_message_id is None:
            return []
        message_id, reasoning_message_id = reasoning_message_id, None
        return [
            encode(ReasoningMessageEndEvent(messageId=message_id)),
            encode(ReasoningEndEvent(messageId=message_id)),
        ]

    try:
        while True:
            item = await queue.get()
            if item is None:
                for chunk in close_reasoning():
                    yield chunk
                break
            event_name, data = item
            if event_name == "reasoning_delta":
                delta = data.get("delta", "")
                if not delta:
                    continue
                if reasoning_message_id is None:
                    reasoning_message_id = f"{run_id}:reasoning:{reasoning_generation}"
                    reasoning_generation += 1
                    yield encode(ReasoningStartEvent(messageId=reasoning_message_id))
                    yield encode(ReasoningMessageStartEvent(messageId=reasoning_message_id, role="reasoning"))
                yield encode(ReasoningMessageContentEvent(messageId=reasoning_message_id, delta=delta))
                continue
            # Model reasoning streams before its answer or tool calls; any other
            # event ends the current reasoning message.
            for chunk in close_reasoning():
                yield chunk
            if event_name == "run_started":
                yield encode(RunStartedEvent(threadId=thread_id, runId=run_id))
                yield encode(CustomEvent(name="tuantuan.user_message", value=data["user_message"]))
                if data.get("timing", {}).get("started_at"):
                    yield encode(CustomEvent(name="tuantuan.run_timing", value=data["timing"]))
                continue
            if event_name == "text_reset":
                if text_started:
                    yield encode(TextMessageEndEvent(messageId=assistant_message_id))
                    message_generation += 1
                    assistant_message_id = f"{run_id}:assistant:{message_generation}"
                    text_started = False
                started = start_text_message()
                if started:
                    yield started
                continue
            if event_name == "text_delta":
                delta = data.get("delta", "")
                if not delta:
                    continue
                started = start_text_message()
                if started:
                    yield started
                yield encode(TextMessageContentEvent(messageId=assistant_message_id, delta=delta))
                continue
            if event_name == "agent_event":
                tool_event = data["event"]
                tool_call_id = tool_event["tool_call_id"]
                tool_name = tool_event["tool_name"]
                if tool_name == "agent_thinking":
                    reasoning_id = f"reasoning:{tool_call_id}"
                    yield encode(ReasoningStartEvent(messageId=reasoning_id))
                    yield encode(ReasoningMessageStartEvent(messageId=reasoning_id, role="reasoning"))
                    if tool_event.get("message"):
                        yield encode(ReasoningMessageContentEvent(
                            messageId=reasoning_id,
                            delta=tool_event["message"],
                        ))
                    yield encode(ReasoningMessageEndEvent(messageId=reasoning_id))
                    yield encode(ReasoningEndEvent(messageId=reasoning_id))
                    yield encode(CustomEvent(name="tuantuan.agent_event", value=tool_event))
                    continue
                if tool_call_id not in started_tool_calls:
                    started_tool_calls.add(tool_call_id)
                    yield encode(ToolCallStartEvent(
                        toolCallId=tool_call_id,
                        toolCallName=tool_name,
                        parentMessageId=assistant_message_id,
                    ))
                    yield encode(ToolCallArgsEvent(
                        toolCallId=tool_call_id,
                        delta=json.dumps(tool_event.get("data") or {}, ensure_ascii=False),
                    ))
                if tool_event.get("status") != "running":
                    yield encode(ToolCallEndEvent(toolCallId=tool_call_id))
                    yield encode(ToolCallResultEvent(
                        messageId=f"tool-result:{tool_call_id}",
                        toolCallId=tool_call_id,
                        content=json.dumps(tool_event, ensure_ascii=False),
                        role="tool",
                    ))
                yield encode(CustomEvent(name="tuantuan.agent_event", value=tool_event))
                continue
            if event_name in {"completed", "cancelled", "error"}:
                if text_started:
                    yield encode(TextMessageEndEvent(messageId=assistant_message_id))
                assistant_payload = data["assistant_message"].get("payload") or {}
                agent_payload = assistant_payload.get("agent") or {}
                status = (
                    "cancelled"
                    if event_name == "cancelled"
                    else "failed"
                    if event_name == "error"
                    else agent_payload.get("status", "done")
                )
                snapshot = {
                    "tuantuan": {
                        "status": status,
                        "userMessage": data["user_message"],
                        "assistantMessage": data["assistant_message"],
                    },
                }
                yield encode(StateSnapshotEvent(snapshot=snapshot))
                if event_name == "cancelled":
                    yield encode(CustomEvent(name="tuantuan.cancelled", value={"status": status}))
                if status == "failed":
                    agent_error = agent_payload.get("error") or {}
                    yield encode(RunErrorEvent(
                        message=agent_error.get("message") or data.get("message", "流式执行失败"),
                        code=agent_error.get("code") or "stream_failed",
                    ))
                else:
                    yield encode(RunFinishedEvent(
                        threadId=thread_id,
                        runId=run_id,
                        result={
                            "status": status,
                            "assistantMessageId": data["assistant_message"]["id"],
                        },
                    ))
    finally:
        if not worker.done():
            worker.cancel()
            await asyncio.gather(worker, return_exceptions=True)
