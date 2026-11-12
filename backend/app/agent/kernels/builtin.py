"""团团自研内核：现有 AgentRuntime 的直通适配。"""

from __future__ import annotations

from typing import Any, AsyncIterator

from ...domain import AgentStreamEvent


class BuiltinKernelRuntime:
    def __init__(self, runtime: Any) -> None:
        self._runtime = runtime

    async def run_stream(self, user_content: str, **kwargs: Any) -> AsyncIterator[AgentStreamEvent]:
        async for event in self._runtime.run_stream(user_content, **kwargs):
            yield event
