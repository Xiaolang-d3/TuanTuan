"""Finish notification responses before the server's HTTP drain deadline."""
from __future__ import annotations

import asyncio
from contextlib import aclosing

import anyio
from fastapi import Request


async def until_shutdown(content, request: Request):
    shutdown = request.scope.get("state", {}).get("tuantuan_shutdown")
    if shutdown is None:
        async with aclosing(content):
            async for chunk in content:
                yield chunk
        return

    stopping = asyncio.create_task(shutdown.wait())
    pending = None
    try:
        while not shutdown.is_set():
            pending = asyncio.create_task(anext(content))
            done, _ = await asyncio.wait((pending, stopping), return_when=asyncio.FIRST_COMPLETED)
            if stopping in done:
                return
            try:
                yield pending.result()
            except StopAsyncIteration:
                return
    finally:
        # StreamingResponse also cancels its producer on a client disconnect.
        # Await children and close subscriptions even inside that cancel scope.
        with anyio.CancelScope(shield=True):
            tasks = [stopping] + ([pending] if pending is not None else [])
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
            await content.aclose()
