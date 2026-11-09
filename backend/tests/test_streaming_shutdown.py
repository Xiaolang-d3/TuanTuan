"""Notification iterators release resources on shutdown and client disconnect."""
import asyncio

import anyio
from starlette.requests import Request

from app.streaming import until_shutdown


def test_disconnect_closes_a_pending_notification_iterator():
    async def scenario():
        shutdown = asyncio.Event()
        waiting = asyncio.Event()
        closed = asyncio.Event()

        async def content():
            try:
                yield 'initial snapshot'
                waiting.set()
                await asyncio.Event().wait()
            finally:
                # Cleanup may need an await, e.g. to leave a subscription.
                await asyncio.sleep(0)
                closed.set()

        request = Request({'type': 'http', 'state': {'tuantuan_shutdown': shutdown}})

        async def consume():
            async for _ in until_shutdown(content(), request):
                pass

        async with anyio.create_task_group() as group:
            group.start_soon(consume)
            await asyncio.wait_for(waiting.wait(), 1)
            group.cancel_scope.cancel()
        assert closed.is_set()
        assert not shutdown.is_set(), 'one disconnect must not stop other subscribers'

    asyncio.run(scenario())


def test_finite_notifications_finish_without_waiting_for_server_shutdown():
    async def scenario():
        shutdown = asyncio.Event()

        async def content():
            yield 'terminal job event'

        request = Request({'type': 'http', 'state': {'tuantuan_shutdown': shutdown}})

        async def consume():
            return [chunk async for chunk in until_shutdown(content(), request)]

        assert await asyncio.wait_for(consume(), 1) == ['terminal job event']

    asyncio.run(scenario())
