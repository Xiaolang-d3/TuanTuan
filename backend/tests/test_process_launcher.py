import asyncio
import subprocess
import sys
import threading

import pytest

from app.execution import process_launcher


@pytest.mark.skipif(sys.platform != "win32", reason="Windows Selector compatibility")
@pytest.mark.parametrize("cancels", [1, 2])
def test_cancel_during_os_spawn_keeps_and_reaps_the_process(monkeypatch, cancels):
    entered, release, completed = threading.Event(), threading.Event(), threading.Event()
    created = []
    original = subprocess.Popen

    def delayed(*args, **kwargs):
        entered.set()
        assert release.wait(5)
        process = original(*args, **kwargs)
        created.append(process)
        completed.set()
        return process

    monkeypatch.setattr(process_launcher.subprocess, "Popen", delayed)

    async def scenario():
        task = asyncio.create_task(process_launcher.create_subprocess_exec(sys.executable, "-c", "import time; time.sleep(30)",
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE))
        try:
            assert await asyncio.to_thread(entered.wait, 3)
            for _ in range(cancels):
                task.cancel()
                await asyncio.sleep(0)
            release.set()
            with pytest.raises(asyncio.CancelledError):
                await asyncio.wait_for(task, 3)
            assert len(created) == 1 and created[0].poll() is not None
            assert all(pipe.closed for pipe in (created[0].stdin, created[0].stdout, created[0].stderr))
        finally:
            release.set()
            await asyncio.to_thread(completed.wait, 3)
            for process in created:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=3)

    with asyncio.Runner(loop_factory=asyncio.SelectorEventLoop) as runner:
        runner.run(scenario())
