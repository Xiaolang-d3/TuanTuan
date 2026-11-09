import asyncio

import pytest

from app.execution.contracts import ExecutionUnavailable
from app.execution.recovery import confirm_local_execution_stopped


def test_no_process_was_released_is_already_stopped():
    asyncio.run(confirm_local_execution_stopped({"backend": "local_builtin", "attempt": "a" * 32, "stopped": False}))


def test_pid_reuse_does_not_kill_unrelated_process(monkeypatch):
    monkeypatch.setattr("app.execution.recovery.process_identity", lambda pid: {"pid": pid, "created": "new", "executable": "python.exe"})
    asyncio.run(confirm_local_execution_stopped({"backend": "local_builtin", "identity": {"pid": 123, "created": "old", "executable": "python.exe"}}))


def test_same_process_still_alive_cannot_be_declared_stopped(monkeypatch):
    identity = {"pid": 123, "created": "same", "executable": "python.exe"}
    monkeypatch.setattr("app.execution.recovery.process_identity", lambda pid: identity)
    with pytest.raises(ExecutionUnavailable, match="停止"):
        asyncio.run(confirm_local_execution_stopped({"backend": "local_builtin", "identity": identity}))
