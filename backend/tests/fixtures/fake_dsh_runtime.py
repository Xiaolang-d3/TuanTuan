"""Scripted fake DSH runtime for stdio JSON-RPC client tests."""
from __future__ import annotations

import json
import os
import sys


def send(payload) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def record(payload) -> None:
    path = os.environ.get("FAKE_DSH_RECORD")
    if not path:
        return
    with open(path, "a", encoding="utf-8") as stream:
        stream.write(json.dumps(payload, ensure_ascii=False) + "\n")


def main() -> None:
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            continue
        method = message.get("method")
        request_id = message.get("id")
        params = message.get("params") or {}
        if method == "initialize":
            send({"jsonrpc": "2.0", "id": request_id,
                  "result": {"serverInfo": {"name": "fake-dsh", "version": "0.0.1"}}})
            if params.get("approvalRequests"):
                send({"jsonrpc": "2.0", "method": "approval/request", "params": {
                    "requestId": "req-1", "sessionId": "any", "toolName": "ping", "reason": "测试审批",
                }})
        elif method == "session/query":
            session_id = params["sessionId"]
            send({"jsonrpc": "2.0", "id": request_id, "result": {"kind": "prompt", "messageId": "msg-1"}})
            if os.environ.get("FAKE_DSH_APPROVE_DURING_TURN") == "1":
                send({"jsonrpc": "2.0", "method": "approval/request", "params": {
                    "requestId": "req-turn-1", "sessionId": session_id, "toolName": "ping", "reason": "测试审批",
                }})
                for reply_line in sys.stdin:
                    try:
                        reply = json.loads(reply_line.strip())
                    except json.JSONDecodeError:
                        continue
                    if reply.get("method") is None and ("result" in reply or "error" in reply):
                        record(reply)
                        break
            send({"jsonrpc": "2.0", "method": "session.event", "params": {
                "sessionId": session_id, "event": {"type": "assistant/message", "data": {
                    "message": {"content": [{"type": "text", "text": "你好，中文回复"}]},
                }},
            }})
            send({"jsonrpc": "2.0", "method": "session.status", "params": {
                "sessionId": session_id, "status": "idle",
            }})
        elif method == "session/prompt":
            send({"jsonrpc": "2.0", "id": request_id, "result": {"messageId": "msg-2"}})
        elif method == "session/resume":
            send({"jsonrpc": "2.0", "id": request_id, "result": {}})
        elif method == "session/wait":
            send({"jsonrpc": "2.0", "id": request_id, "result": {}})
        elif method == "unknown-method":
            send({"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": "未知方法"}})
        elif method == "shutdown":
            if os.environ.get("FAKE_DSH_IGNORE_SHUTDOWN") == "1":
                continue
            send({"jsonrpc": "2.0", "id": request_id, "result": {}})
            return
        elif method is None and ("result" in message or "error" in message):
            record(message)


if __name__ == "__main__":
    main()
