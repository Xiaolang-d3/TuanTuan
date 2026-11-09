"""Ephemeral, bounded snapshot fan-out; durable state stays in the channel store."""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from uuid import uuid4


class SnapshotEvents:
    def __init__(self, snapshot):
        self.snapshot = snapshot
        self.stream_id = uuid4().hex
        self.revision = 0
        self.latest = None
        self.subscribers = set()

    @property
    def subscriber_count(self):
        return len(self.subscribers)

    def refresh(self):
        state = self.snapshot()
        if self.latest is None or state != self.latest:
            self.latest = state
            self.revision += 1
            for queue in self.subscribers:
                self._offer(queue, self.current())
        return self.current()

    def current(self):
        return {**self.latest, 'stream_id': self.stream_id, 'revision': self.revision}

    @staticmethod
    def _offer(queue, state):
        if queue.full():
            queue.get_nowait()
        queue.put_nowait(state)

    @asynccontextmanager
    async def subscribe(self):
        queue = asyncio.Queue(maxsize=1)
        self.subscribers.add(queue)
        try:
            # No await between registration and snapshot: a commit cannot be lost.
            self._offer(queue, self.refresh())
            yield queue
        finally:
            self.subscribers.discard(queue)

    def close(self):
        for queue in self.subscribers:
            self._offer(queue, None)
