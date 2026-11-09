from __future__ import annotations

import asyncio

from .contracts import ProcessResult


async def run_process(argv: list[str], *, env: dict[str, str], timeout: float = 30, input: bytes | None = None, output_limit: int = 65_536) -> ProcessResult:
    """One bounded CLI invocation, without shell expansion or inherited credentials."""
    process = await asyncio.create_subprocess_exec(*argv, env=env, stdin=asyncio.subprocess.PIPE if input is not None else asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)

    async def read(stream) -> bytes:
        parts = []
        size = 0
        while chunk := await stream.read(4096):
            size += len(chunk)
            if size > output_limit:
                raise ValueError("执行输出超过当前传输限制")
            parts.append(chunk)
        return b"".join(parts)

    async def communicate():
        if input is not None:
            process.stdin.write(input)
            await process.stdin.drain()
            process.stdin.close()
        stdout, stderr = await asyncio.gather(read(process.stdout), read(process.stderr))
        await process.wait()
        return ProcessResult(process.returncode, stdout.decode("utf-8", "replace"), stderr.decode("utf-8", "replace"))

    try:
        return await asyncio.wait_for(communicate(), timeout)
    finally:
        if process.returncode is None:
            process.kill()
            await process.wait()
