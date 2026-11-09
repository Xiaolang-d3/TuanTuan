import asyncio
import os

import pytest

from app.execution.container_backend import ContainerBackend
from app.extensions.contracts import ExtensionContext
from app.workspace import use_workspace


def test_real_container_is_isolated_and_cancelled(tmp_path, monkeypatch):
    # Run only against an operator-supplied, pinned, already-present image.
    backend = ContainerBackend(config_dir=tmp_path / "docker-config")
    async def scenario():
        status = await backend.probe()
        if not status.available:
            pytest.skip(f"真实容器未验证：{status.code}: {status.reason}")
        with use_workspace(1, tmp_path / "workspace"):
            handle = await backend.prepare(ExtensionContext.current(), "e" * 32)
            try:
                result = await handle.exec(["python3", "-I", "-c", "import os,socket; assert 'OPENAI_API_KEY' not in os.environ; assert not os.path.exists('/var/run/docker.sock'); socket.create_connection(('1.1.1.1',443),timeout=1)"])
                assert result.returncode != 0, "容器不应访问外网"
                await handle.write("page.txt", "中文执行测试".encode())
                assert await handle.read("page.txt") == "中文执行测试".encode()
                task = asyncio.create_task(handle.exec(["python3", "-I", "-c", "import time; time.sleep(300)"], timeout=300))
                await asyncio.sleep(0.2)
                task.cancel()
                with pytest.raises(asyncio.CancelledError):
                    await task
                inspected = await backend.call(["inspect", handle.name])
                assert inspected.returncode != 0
            finally:
                await handle.stop()
    asyncio.run(scenario())
