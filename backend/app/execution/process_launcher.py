"""Trusted supervisor launch compatible with Windows Uvicorn reload loops.

Selector is required by Uvicorn's shared reload socket on Windows, but does not
implement asyncio subprocess transports. Use blocking OS pipes in worker threads
there; keep native asyncio processes on all other loops. This is not a tool API.
"""
from __future__ import annotations

import asyncio
import subprocess
import sys
from functools import partial


class _Reader:
    def __init__(self, pipe):
        self.pipe = pipe

    async def read(self, size=-1):
        read = self.pipe.read if size < 0 else getattr(self.pipe, "read1", self.pipe.read)
        return await asyncio.to_thread(read, size)


class _Writer:
    def __init__(self, pipe):
        self.pipe = pipe
        self.pending = bytearray()

    def write(self, content):
        self.pending.extend(content)

    async def drain(self):
        content = bytes(self.pending)
        self.pending.clear()

        def send():
            self.pipe.write(content)
            self.pipe.flush()

        await asyncio.to_thread(send)

    def close(self):
        self.pending.clear()
        self.pipe.close()


class _Process:
    def __init__(self, process):
        self.process = process
        self.pid = process.pid
        self.stdin = _Writer(process.stdin) if process.stdin else None
        self.stdout = _Reader(process.stdout) if process.stdout else None
        self.stderr = _Reader(process.stderr) if process.stderr else None

    @property
    def returncode(self):
        return self.process.poll()

    async def wait(self):
        # Confirmation services can remain open for minutes. A waiter must not
        # occupy an executor thread and starve other process starts or pipe I/O.
        while (code := self.process.poll()) is None:
            await asyncio.sleep(.05)
        return code

    def kill(self):
        self.process.kill()


async def create_subprocess_exec(*args, **kwargs):
    if sys.platform != "win32" or not isinstance(asyncio.get_running_loop(), asyncio.SelectorEventLoop):
        return await asyncio.create_subprocess_exec(*args, **kwargs)
    # OS process creation cannot be cancelled. Retain its result so a cancelled
    # launch never leaves an unattached supervisor waiting for its parent.
    spawning = asyncio.get_running_loop().run_in_executor(None, partial(subprocess.Popen, args, **kwargs))
    try:
        process = await asyncio.shield(spawning)
    except asyncio.CancelledError:
        # Heartbeat cancellation and app shutdown can overlap. Defer each
        # cancellation until we own the OS result; never cancel its future.
        while not spawning.done():
            try:
                await asyncio.shield(spawning)
            except asyncio.CancelledError:
                continue
        process = spawning.result()
        process.kill()
        while process.poll() is None:
            try:
                await asyncio.sleep(.05)
            except asyncio.CancelledError:
                continue
        for pipe in (process.stdin, process.stdout, process.stderr):
            if pipe:
                pipe.close()
        raise
    return _Process(process)
