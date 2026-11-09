"""A loopback HTTP server that speaks just enough of each vendor wire format.

LiteLLM builds real HTTP requests; asserting on what reaches this server
verifies the protocol mapping (paths, auth headers, reasoning parameters and
replayed reasoning state) without any network access beyond 127.0.0.1.
"""
from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


def _sse(events: list[Any], *, named: bool = False) -> bytes:
    lines: list[str] = []
    for event in events:
        if named:
            lines.append(f"event: {event['type']}")
        lines.append(f"data: {json.dumps(event, ensure_ascii=False)}")
        lines.append("")
    if not named:
        lines.extend(["data: [DONE]", ""])
    return ("\n".join(lines) + "\n").encode()


def openai_chat_json(*, tool: bool = False) -> dict[str, Any]:
    message: dict[str, Any] = {"role": "assistant", "content": "" if tool else "你好", "reasoning_content": "先想一想"}
    if tool:
        message["tool_calls"] = [{"id": "call_1", "type": "function", "function": {"name": "search_library", "arguments": "{\"query\": \"团团\"}"}}]
    return {
        "id": "chatcmpl-1", "object": "chat.completion", "created": 1, "model": "deepseek-v3",
        "choices": [{"index": 0, "message": message, "finish_reason": "tool_calls" if tool else "stop"}],
        "usage": {"prompt_tokens": 11, "completion_tokens": 7, "total_tokens": 18},
    }


def openai_chat_sse() -> bytes:
    base = {"id": "chatcmpl-2", "object": "chat.completion.chunk", "created": 1, "model": "deepseek-v3"}
    chunks = [
        {**base, "choices": [{"index": 0, "delta": {"role": "assistant", "reasoning_content": "先想"}, "finish_reason": None}]},
        {**base, "choices": [{"index": 0, "delta": {"reasoning_content": "一想"}, "finish_reason": None}]},
        {**base, "choices": [{"index": 0, "delta": {"content": "你"}, "finish_reason": None}]},
        {**base, "choices": [{"index": 0, "delta": {"content": "好"}, "finish_reason": None}]},
        {**base, "choices": [{"index": 0, "delta": {"tool_calls": [{"index": 0, "id": "call_9", "type": "function", "function": {"name": "search_library", "arguments": "{\"query\""}}]}, "finish_reason": None}]},
        {**base, "choices": [{"index": 0, "delta": {"tool_calls": [{"index": 0, "function": {"arguments": ": \"团团\"}"}}]}, "finish_reason": None}]},
        {**base, "choices": [{"index": 0, "delta": {}, "finish_reason": "tool_calls"}]},
        {**base, "choices": [], "usage": {"prompt_tokens": 20, "completion_tokens": 9, "total_tokens": 29}},
    ]
    return _sse(chunks)


def anthropic_json(*, tool: bool = False) -> dict[str, Any]:
    content: list[dict[str, Any]] = [{"type": "thinking", "thinking": "需要查资料", "signature": "sig-abc"}]
    if tool:
        content.append({"type": "tool_use", "id": "toolu_1", "name": "search_library", "input": {"query": "团团"}})
    else:
        content.append({"type": "text", "text": "你好"})
    return {
        "id": "msg_1", "type": "message", "role": "assistant", "model": "claude-sonnet-4-5",
        "content": content, "stop_reason": "tool_use" if tool else "end_turn", "stop_sequence": None,
        "usage": {"input_tokens": 12, "output_tokens": 6},
    }


def anthropic_sse() -> bytes:
    events = [
        {"type": "message_start", "message": {"id": "msg_2", "type": "message", "role": "assistant", "model": "claude-sonnet-4-5", "content": [], "stop_reason": None, "usage": {"input_tokens": 15, "output_tokens": 1}}},
        {"type": "content_block_start", "index": 0, "content_block": {"type": "thinking", "thinking": "", "signature": ""}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "需要"}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "thinking_delta", "thinking": "查资料"}},
        {"type": "content_block_delta", "index": 0, "delta": {"type": "signature_delta", "signature": "sig-xyz"}},
        {"type": "content_block_stop", "index": 0},
        {"type": "content_block_start", "index": 1, "content_block": {"type": "text", "text": ""}},
        {"type": "content_block_delta", "index": 1, "delta": {"type": "text_delta", "text": "好的"}},
        {"type": "content_block_stop", "index": 1},
        {"type": "content_block_start", "index": 2, "content_block": {"type": "tool_use", "id": "toolu_2", "name": "search_library", "input": {}}},
        {"type": "content_block_delta", "index": 2, "delta": {"type": "input_json_delta", "partial_json": "{\"query\": "}},
        {"type": "content_block_delta", "index": 2, "delta": {"type": "input_json_delta", "partial_json": "\"团团\"}"}},
        {"type": "content_block_stop", "index": 2},
        {"type": "message_delta", "delta": {"stop_reason": "tool_use", "stop_sequence": None}, "usage": {"output_tokens": 9}},
        {"type": "message_stop"},
    ]
    return _sse(events, named=True)


def gemini_json() -> dict[str, Any]:
    return {
        "candidates": [{"content": {"role": "model", "parts": [{"text": "思考中", "thought": True}, {"text": "你好"}]}, "finishReason": "STOP", "index": 0}],
        "usageMetadata": {"promptTokenCount": 8, "candidatesTokenCount": 4, "totalTokenCount": 12},
        "modelVersion": "gemini-2.5-flash",
    }


def gemini_sse() -> bytes:
    chunks = [
        {"candidates": [{"content": {"role": "model", "parts": [{"text": "思考", "thought": True}]}, "index": 0}]},
        {"candidates": [{"content": {"role": "model", "parts": [{"text": "你好"}]}, "index": 0}]},
        {"candidates": [{"content": {"role": "model", "parts": [{"functionCall": {"name": "search_library", "args": {"query": "团团"}}}]}, "finishReason": "STOP", "index": 0}],
         "usageMetadata": {"promptTokenCount": 8, "candidatesTokenCount": 5, "totalTokenCount": 13}},
    ]
    lines = []
    for chunk in chunks:
        lines.append(f"data: {json.dumps(chunk, ensure_ascii=False)}")
        lines.append("")
    return ("\n".join(lines) + "\n").encode()


def ollama_json() -> dict[str, Any]:
    return {"model": "qwen3", "created_at": "2026-01-01T00:00:00Z", "message": {"role": "assistant", "content": "你好", "thinking": "嗯"}, "done": True, "done_reason": "stop", "prompt_eval_count": 5, "eval_count": 3}


def ollama_ndjson() -> bytes:
    lines = [
        {"model": "qwen3", "created_at": "t", "message": {"role": "assistant", "content": "", "thinking": "嗯"}, "done": False},
        {"model": "qwen3", "created_at": "t", "message": {"role": "assistant", "content": "你好"}, "done": False},
        {"model": "qwen3", "created_at": "t", "message": {"role": "assistant", "content": ""}, "done": True, "done_reason": "stop", "prompt_eval_count": 5, "eval_count": 3},
    ]
    return ("\n".join(json.dumps(line, ensure_ascii=False) for line in lines) + "\n").encode()


def _responses_output(tool: bool) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = [{"type": "reasoning", "id": "rs_1", "encrypted_content": "enc-123", "summary": [{"type": "summary_text", "text": "先检索"}]}]
    if tool:
        output.append({"type": "function_call", "id": "fc_1", "call_id": "call_r1", "name": "search_library", "arguments": "{\"query\": \"团团\"}", "status": "completed"})
    else:
        output.append({"type": "message", "id": "msg_r1", "role": "assistant", "status": "completed", "content": [{"type": "output_text", "text": "你好", "annotations": []}]})
    return output


def responses_json(*, tool: bool = False) -> dict[str, Any]:
    return {
        "id": "resp_1", "object": "response", "created_at": 1, "status": "completed", "model": "gpt-5",
        "output": _responses_output(tool), "parallel_tool_calls": True, "tool_choice": "auto", "tools": [],
        "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15, "input_tokens_details": {"cached_tokens": 0}, "output_tokens_details": {"reasoning_tokens": 2}},
    }


def responses_sse() -> bytes:
    final = responses_json(tool=False)
    events = [
        {"type": "response.created", "sequence_number": 0, "response": {**final, "status": "in_progress", "output": [], "usage": None}},
        {"type": "response.reasoning_summary_text.delta", "sequence_number": 1, "item_id": "rs_1", "output_index": 0, "summary_index": 0, "delta": "先检索"},
        {"type": "response.output_text.delta", "sequence_number": 2, "item_id": "msg_r1", "output_index": 1, "content_index": 0, "delta": "你", "logprobs": []},
        {"type": "response.output_text.delta", "sequence_number": 3, "item_id": "msg_r1", "output_index": 1, "content_index": 0, "delta": "好", "logprobs": []},
        {"type": "response.completed", "sequence_number": 4, "response": final},
    ]
    return _sse(events, named=True)


class FakeLLMServer:
    """Serve canned replies; ``errors`` maps a path substring to (status, body),
    ``raw`` maps a path substring to (status, raw bytes) for malformed replies."""

    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        self.errors: dict[str, tuple[int, dict[str, Any]]] = {}
        self.raw: dict[str, tuple[int, bytes]] = {}
        self.tool = False
        server = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args: Any) -> None:
                return

            def do_POST(self) -> None:  # noqa: N802 - stdlib naming
                length = int(self.headers.get("content-length") or 0)
                raw = self.rfile.read(length) if length else b"{}"
                try:
                    body = json.loads(raw or b"{}")
                except ValueError:
                    body = {}
                server.requests.append({"path": self.path, "headers": {k.lower(): v for k, v in self.headers.items()}, "body": body})
                for marker, (status, data) in server.raw.items():
                    if marker in self.path:
                        self._send(status, data, "application/json")
                        return
                for marker, (status, payload) in server.errors.items():
                    if marker in self.path:
                        self._send(status, json.dumps(payload).encode(), "application/json")
                        return
                stream = bool(body.get("stream")) or "streamGenerateContent" in self.path
                path = self.path
                if path.endswith("/chat/completions"):
                    self._reply(stream, openai_chat_sse, lambda: openai_chat_json(tool=server.tool))
                elif path.endswith("/messages"):
                    self._reply(stream, anthropic_sse, lambda: anthropic_json(tool=server.tool))
                elif ":generateContent" in path or ":streamGenerateContent" in path:
                    self._reply(stream, gemini_sse, gemini_json)
                elif path.endswith("/api/chat"):
                    if stream:
                        self._send(200, ollama_ndjson(), "application/x-ndjson")
                    else:
                        self._send(200, json.dumps(ollama_json()).encode(), "application/json")
                elif path.endswith("/responses"):
                    self._reply(stream, responses_sse, lambda: responses_json(tool=server.tool))
                else:
                    self._send(404, b'{"error": {"message": "not found"}}', "application/json")

            def _reply(self, stream: bool, sse, payload) -> None:
                if stream:
                    self._send(200, sse(), "text/event-stream")
                else:
                    self._send(200, json.dumps(payload(), ensure_ascii=False).encode(), "application/json")

            def _send(self, status: int, data: bytes, content_type: str) -> None:
                self.send_response(status)
                self.send_header("content-type", content_type)
                self.send_header("content-length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self._httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self._httpd.server_address[1]}"
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)

    def __enter__(self) -> "FakeLLMServer":
        self._thread.start()
        return self

    def __exit__(self, *exc: Any) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()

    def last(self) -> dict[str, Any]:
        return self.requests[-1]
