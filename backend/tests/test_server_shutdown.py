"""A connected notification stream must not prevent backend restarts."""
import asyncio
import socket
import sys
import threading
from types import ModuleType

import httpx
import pytest
from fastapi import FastAPI
import uvicorn

from app.api import weixin
from app.channels.weixin.service import WeixinService


@pytest.mark.parametrize('stream_kind', ['weixin', 'jobs'])
def test_server_drains_notifications_and_finishes_pending_request(tmp_path, monkeypatch, capsys, stream_kind):
    from app.server import main

    channel = WeixinService(1, tmp_path)
    monkeypatch.setattr(weixin.manager, 'current', lambda: channel)
    monkeypatch.setattr(weixin, 'current_user', lambda _: {'id': 1})
    fixture = ModuleType('shutdown_fixture')
    fixture.app = FastAPI()
    fixture.app.include_router(weixin.router)
    if stream_kind == 'jobs':
        from types import SimpleNamespace
        from app.api import jobs
        monkeypatch.setattr(jobs.ExtensionContext, 'current', lambda: SimpleNamespace(user_id=1))
        monkeypatch.setattr(jobs, 'current_workspace_root', lambda: tmp_path)
        monkeypatch.setattr(jobs.job_service, 'get', lambda *_: {'status': 'running'})
        monkeypatch.setattr(jobs.job_service, 'events', lambda *_, **__: [])
        fixture.app.include_router(jobs.router)

    entered = threading.Event()
    release = threading.Event()
    draining = threading.Event()

    @fixture.app.post('/pending')
    def pending_request():
        entered.set()
        assert release.wait(5), 'test did not release the pending request'
        return {'completed': True}

    @fixture.app.middleware('http')
    async def passthrough(request, call_next):
        # Match the authentication middleware's streaming response wrapper.
        return await call_next(request)
    monkeypatch.setitem(sys.modules, 'shutdown_fixture', fixture)

    listener = socket.socket()
    listener.bind(('127.0.0.1', 0))
    listener.listen()
    port = listener.getsockname()[1]
    instances = []
    original_init = uvicorn.Server.__init__

    def capture(instance, config):
        original_init(instance, config)
        instances.append(instance)

    monkeypatch.setattr(uvicorn.Server, '__init__', capture)
    original_shutdown = uvicorn.Server.shutdown

    async def shutdown(instance, sockets=None):
        draining.set()
        await original_shutdown(instance, sockets=sockets)

    monkeypatch.setattr(uvicorn.Server, 'shutdown', shutdown)
    monkeypatch.setattr(sys, 'argv', [
        'app.server', 'shutdown_fixture:app', '--host', '127.0.0.1',
        '--log-level', 'error',
    ])
    # Supply a reserved ephemeral socket to avoid a race between choosing a
    # test port and binding it, including on Windows where --fd is unavailable.
    original_run = uvicorn.Server.run
    monkeypatch.setattr(uvicorn.Server, 'run', lambda instance, sockets=None:
                        original_run(instance, sockets=[listener]))
    failures = []

    def run():
        try:
            main()
        except SystemExit as exc:
            if exc.code:
                failures.append(exc)
        except BaseException as exc:
            failures.append(exc)

    thread = threading.Thread(target=run, daemon=True)
    thread.start()

    async def scenario():
        async with httpx.AsyncClient(trust_env=False, timeout=2) as client:
            path = '/channels/weixin/events' if stream_kind == 'weixin' else '/jobs/test/events'
            async with client.stream('GET', f'http://127.0.0.1:{port}{path}', headers={'Accept': 'text/event-stream'}) as response:
                assert response.status_code == 200
                lines = response.aiter_lines()
                assert await anext(lines) == ('event: weixin-status' if stream_kind == 'weixin' else ': heartbeat')
                if stream_kind == 'weixin':
                    assert channel.events.subscriber_count == 1
                pending = asyncio.create_task(client.post(f'http://127.0.0.1:{port}/pending'))
                assert await asyncio.to_thread(entered.wait, 2)
                instances[0].should_exit = True
                assert await asyncio.to_thread(draining.wait, 2)
                release.set()
                result = await pending
                assert result.status_code == 200 and result.json() == {'completed': True}
                await asyncio.to_thread(thread.join, 7)
                assert not thread.is_alive(), 'backend waited indefinitely for the live notification stream'
                # A completed SSE response must include its final HTTP chunk.
                async for _ in lines:
                    pass
        assert channel.events.subscriber_count == 0

    try:
        asyncio.run(scenario())
        assert not failures
        assert 'ERROR' not in capsys.readouterr().err
    finally:
        release.set()
        if instances:
            instances[0].should_exit = True
            instances[0].force_exit = True
        thread.join(3)
        listener.close()
        asyncio.run(channel.close())
