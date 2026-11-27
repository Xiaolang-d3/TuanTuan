from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from time import perf_counter

from pydantic import ValidationError

from ..domain import ToolCall, ToolError, ToolResult
from ..observability.tool_call_audit import record_tool_call_event
from ..tools import ToolContext, ToolRegistry
from ..tools.errors import invalid_arguments
from ..tools.limits import govern_tool_result
from .egress_policy import SEARCH_TOOL_NAME
from .run_cancellation import await_with_cancellation
from .run_store import SAFE_RETRY_RISKS, AgentRunStore


class ToolExecutor:
    """Execute tools with timeouts, auditing and durable retry rules."""

    def __init__(
        self,
        tools: ToolRegistry,
        default_timeout_seconds: float,
        *,
        run_store: AgentRunStore | None = None,
        max_retries: int = 0,
    ) -> None:
        self._tools = tools
        self._default_timeout_seconds = default_timeout_seconds
        self._run_store = run_store
        self._max_retries = max(0, max_retries)

    async def execute_with_retry(
        self,
        tool_call: ToolCall,
        context: ToolContext,
        *,
        round_number: int,
        conversation_id: int | None,
        run_id: str | None,
        fingerprint: str | None,
        on_retry: Callable[[int, ToolError], Awaitable[None]],
    ) -> ToolResult:
        """Execute or replay a call and return its final result.

        A store, run ID and fingerprint enable the durable ledger. The retry
        callback runs after the ledger authorizes the next attempt. A durable
        cancellation stops the active call and raises RunCancellationRequested.
        """
        spec = self._tools.spec(tool_call.name)
        store = self._run_store
        retry_error: ToolError | None = None
        for retry_number in range(self._max_retries + 1):
            if store is not None and run_id is not None and fingerprint is not None:
                decision = store.prepare_tool_call(run_id, fingerprint, tool_call, spec)
                if decision.action != "execute":
                    if decision.result is None:
                        raise RuntimeError("持久化工具决策缺少结果")
                    return decision.result

            if retry_error is not None:
                await on_retry(retry_number, retry_error)

            if (
                retry_number == 0
                and tool_call.name == SEARCH_TOOL_NAME
                and context.web_search_options is not None
                and not context.web_search_options.enabled
            ):
                message = "本次任务未允许联网搜索，请检查搜索服务配置或发起新任务。"
                result = ToolResult(
                    ok=False, status="blocked", message=message,
                    error=ToolError(code="web_search_not_allowed", message=message),
                )
            else:
                result = await await_with_cancellation(
                    self.execute(tool_call, context, round_number=round_number, conversation_id=conversation_id),
                    store,
                    run_id,
                )

            if store is not None and run_id is not None and fingerprint is not None:
                store.record_tool_result(run_id, fingerprint, result)
            if (
                result.status != "failed"
                or result.error is None
                or not result.error.retryable
                or spec.risk not in SAFE_RETRY_RISKS
                or retry_number == self._max_retries
            ):
                return result
            retry_error = result.error
        raise AssertionError("unreachable tool retry state")

    async def execute(
        self,
        tool_call: ToolCall,
        context: ToolContext,
        *,
        round_number: int,
        conversation_id: int | None,
    ) -> ToolResult:
        started_at = perf_counter()
        timeout = (
            self._tools.spec(tool_call.name).timeout_seconds
            or self._default_timeout_seconds
        )
        try:
            arguments = self._tools.validate_arguments(tool_call.name, tool_call.arguments)
        except ValidationError as exc:
            result = invalid_arguments(f"工具 {tool_call.name} 参数不合法", exc)
        else:
            try:
                handler = self._tools.get(tool_call.name)
                result = await asyncio.wait_for(
                    handler.execute(arguments, context),
                    timeout=timeout,
                )
            except asyncio.TimeoutError:
                message = f"工具 {tool_call.name} 执行超时"
                result = ToolResult(
                    ok=False,
                    status="failed",
                    data={"status": "failed", "error": "timeout"},
                    message=message,
                    error=ToolError(code="tool_timeout", message=message, retryable=True),
                )
            except Exception as exc:
                message = f"工具执行失败：{exc}"
                result = ToolResult(
                    ok=False,
                    status="failed",
                    data={"status": "failed", "error": str(exc)},
                    message=message,
                    error=ToolError(code="tool_execution_failed", message=message),
                )

        result = govern_tool_result(result)

        self._record(
            conversation_id=conversation_id,
            round_number=round_number,
            tool_call=tool_call,
            result=result,
            started_at=started_at,
        )
        return result

    @staticmethod
    def _record(
        *,
        conversation_id: int | None,
        round_number: int,
        tool_call: ToolCall,
        result: ToolResult,
        started_at: float,
    ) -> None:
        try:
            record_tool_call_event(
                conversation_id=conversation_id,
                round_number=round_number,
                tool_call_id=tool_call.id,
                tool_name=tool_call.name,
                status=result.status,
                latency_ms=round((perf_counter() - started_at) * 1000),
                error_code=result.error.code if result.error else "",
            )
        except Exception:
            # Auditing is best-effort and must never break tool execution.
            pass
