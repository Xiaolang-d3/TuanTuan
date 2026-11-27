"""Cancellation shared by model requests and tool execution."""

from __future__ import annotations

import asyncio
from collections.abc import Coroutine
from typing import TYPE_CHECKING, Any, TypeVar

if TYPE_CHECKING:
    from .run_store import AgentRunStore

_OperationResult = TypeVar("_OperationResult")


class RunCancellationRequested(Exception):
    """The user requested cancellation through the durable run store."""


def is_run_cancel_requested(store: AgentRunStore | None, run_id: str | None) -> bool:
    """Return whether a durable run has a pending user cancellation."""
    return store is not None and run_id is not None and store.is_cancel_requested(run_id)


async def await_with_cancellation(
    operation: Coroutine[Any, Any, _OperationResult],
    store: AgentRunStore | None,
    run_id: str | None,
) -> _OperationResult:
    """Return the operation result, or stop it and raise RunCancellationRequested."""
    if store is None or run_id is None:
        return await operation
    task = asyncio.create_task(operation)
    try:
        while True:
            done, _ = await asyncio.wait({task}, timeout=0.25)
            if done:
                return await task
            if is_run_cancel_requested(store, run_id):
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
                raise RunCancellationRequested()
    except BaseException:
        if not task.done():
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        raise
