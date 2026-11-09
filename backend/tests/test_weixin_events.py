import asyncio
import json

from app.channels.weixin.service import WeixinService


def test_committed_snapshots_coalesce_isolate_and_survive_subscriber_close(tmp_path):
    async def scenario():
        owner = WeixinService(1, tmp_path / 'owner')
        other = WeixinService(2, tmp_path / 'other')
        async with owner.events.subscribe() as queue, other.events.subscribe() as other_queue:
            initial = await queue.get()
            await other_queue.get()
            owner.store.bind({'bot_token': 'secret', 'ilink_bot_id': 'bot', 'ilink_user_id': 'peer'})
            owner.store.receive([{'message_id': 1}], 'cursor')
            snapshot = await queue.get()
            assert snapshot['unread_count'] == 1
            assert snapshot['revision'] > initial['revision']
            assert snapshot['stream_id'] == initial['stream_id']
            assert 'secret' not in json.dumps(snapshot)
            assert other_queue.empty()
            owner.store.receive([{'message_id': 1}], 'new-cursor')
            assert queue.empty()  # Cursor-only writes and duplicate deliveries are quiet.
            owner.store.save_reply(owner.store.next_job()['id'], 'answer')
            readable = await queue.get()
            assert readable['readable_sequence'] == 1
            owner.store.mark_read(1, readable['binding_id'])
            assert (await queue.get())['unread_count'] == 0
        assert owner.events.subscriber_count == 0
        assert owner.store.get('enabled') is True
        async with owner.events.subscribe() as queue:
            assert (await queue.get())['unread_count'] == 0
            await owner.disconnect()
            assert (await queue.get())['connected'] is False
        await owner.close()
        await other.close()
    asyncio.run(scenario())


def test_event_route_sends_snapshot_heartbeat_and_cleans_up(tmp_path, monkeypatch):
    from starlette.requests import Request
    from app.api import weixin

    async def scenario():
        channel = WeixinService(1, tmp_path)
        monkeypatch.setattr(weixin.manager, 'current', lambda: channel)
        monkeypatch.setattr(weixin, 'current_user', lambda _: {'id': 1})
        monkeypatch.setattr(weixin, 'HEARTBEAT_SECONDS', 0.01)
        request = Request({'type': 'http', 'headers': [(b'authorization', b'Bearer synthetic')]})
        response = await weixin.events(request)
        assert response.headers['cache-control'] == 'no-store'
        assert response.headers['x-accel-buffering'] == 'no'
        iterator = response.body_iterator
        first = await anext(iterator)
        assert 'event: weixin-status' in first
        assert json.loads(first.split('data: ', 1)[1])['connected'] is False
        assert await anext(iterator) == ': heartbeat\n\n'
        await iterator.aclose()
        assert channel.events.subscriber_count == 0
        await channel.close()
    asyncio.run(scenario())


def test_event_route_closes_after_session_revocation(tmp_path, monkeypatch):
    from types import SimpleNamespace
    from fastapi import HTTPException
    from starlette.requests import Request
    from app.api import weixin

    async def scenario():
        channel = WeixinService(1, tmp_path)
        monkeypatch.setattr(weixin.manager, 'current', lambda: channel)
        now = [0.0]
        monkeypatch.setattr(weixin, 'time', SimpleNamespace(monotonic=lambda: now[0]))
        def revoked(_):
            raise HTTPException(401)
        monkeypatch.setattr(weixin, 'current_user', revoked)
        response = await weixin.events(Request({'type': 'http', 'headers': []}))
        iterator = response.body_iterator
        await anext(iterator)
        now[0] = 16.0
        assert await anext(iterator) == 'event: auth-expired\ndata: {}\n\n'
        try:
            await anext(iterator)
            assert False, 'revoked stream should terminate'
        except StopAsyncIteration:
            pass
        assert channel.events.subscriber_count == 0
        await channel.close()
    asyncio.run(scenario())
