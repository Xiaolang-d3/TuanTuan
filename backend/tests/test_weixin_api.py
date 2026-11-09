import asyncio
import json
from contextlib import asynccontextmanager

import httpx
import pytest
from fastapi.testclient import TestClient

from app import db
from app.main import app
from app.channels.weixin.manager import manager
from app.workspace import use_workspace, ensure_workspace
from api_client import register_authenticated_client


@pytest.fixture(autouse=True)
def isolated(tmp_path, monkeypatch):
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'tuantuan.db')
    db.init_db()
    manager.channels.clear()
    yield
    asyncio.run(manager.close())


def test_weixin_routes_require_login_and_isolate_qr_sessions(monkeypatch):
    assert TestClient(app).get('/channels/weixin').status_code == 401
    assert TestClient(app).get('/channels/weixin/events').status_code == 401
    owner = register_authenticated_client(app, 'wx-owner@example.com')
    other = register_authenticated_client(app, 'wx-other@example.com')
    owner_id = owner.get('/auth/me').json()['user']['id']
    with use_workspace(owner_id, ensure_workspace(owner_id)):
        channel = manager.current()
    async def respond(request):
        if request.url.path.endswith('get_bot_qrcode'):
            return httpx.Response(200, json={'qrcode': 'qr', 'qrcode_img_content': 'https://weixin.qq.com/login/test'})
        return httpx.Response(200, json={'status': 'confirmed', 'bot_token': 'private-token', 'ilink_bot_id': 'bot', 'ilink_user_id': 'peer'})
    channel.http = httpx.AsyncClient(transport=httpx.MockTransport(respond))
    monkeypatch.setattr(channel, 'start', lambda: None)
    login = owner.post('/channels/weixin/login')
    assert login.status_code == 200
    assert login.headers['cache-control'] == 'no-store'
    assert login.json()['qr_image'].startswith('data:image/png;base64,iVBOR')
    session = login.json()['session_id']
    assert other.post('/channels/weixin/login/poll', json={'session_id': session}).status_code == 409
    result = owner.post('/channels/weixin/login/poll', json={'session_id': session})
    assert result.json()['status'] == 'confirmed'
    assert 'private-token' not in result.text
    assert owner.get('/channels/weixin').json()['connected'] is True
    assert other.get('/channels/weixin').json()['connected'] is False
    assert owner.delete('/channels/weixin').json()['connected'] is False


def test_bridge_uses_real_chat_persistence_and_replays_without_second_model_call(tmp_path, monkeypatch):
    from app.channels.weixin.bridge import execute_message
    from app.chat import execution
    from app.domain import AgentRunResult, AgentStreamEvent

    calls = []
    class Runtime:
        async def run_stream(self, *args, **kwargs):
            calls.append(args)
            yield AgentStreamEvent(type='completed', result=AgentRunResult(content='真实持久化回答', provider='test', platform='manual', rounds=1))
    monkeypatch.setattr(execution, 'get_agent_runtime', lambda *args, **kwargs: Runtime())
    async def scenario():
        with use_workspace(1, ensure_workspace(1)):
            result = await execute_message('hello', None, 'weixin-replay')
            assert result['text'] == '真实持久化回答'
            replay = await execute_message('hello', None, 'weixin-replay')
            assert replay == result
            assert len(calls) == 1
    asyncio.run(scenario())


def test_read_endpoint_cannot_acknowledge_another_accounts_notifications():
    owner = register_authenticated_client(app, 'bot-a@example.com')
    other = register_authenticated_client(app, 'bot-b@example.com')
    for client in (owner, other):
        uid = client.get('/auth/me').json()['user']['id']
        with use_workspace(uid, ensure_workspace(uid)):
            channel = manager.current()
            channel.store.bind({'bot_token': 'token', 'ilink_bot_id': str(uid), 'ilink_user_id': 'owner'})
            channel.store.receive([{'message_id': 1}], 'cursor')
            channel.store.save_reply(channel.store.next_job()['id'], 'answer')
    snapshot = owner.get('/channels/weixin').json()
    payload = {'binding_id': snapshot['binding_id'], 'through_sequence': snapshot['readable_sequence']}
    assert other.post('/channels/weixin/read', json=payload).status_code == 409
    assert owner.post('/channels/weixin/read', json=payload).json()['unread_count'] == 0
    assert other.get('/channels/weixin').json()['unread_count'] == 1


def test_unsupported_first_message_has_readable_conversation_and_clearable_unread():
    client = register_authenticated_client(app, 'attachment-bot@example.com')
    uid = client.get('/auth/me').json()['user']['id']
    with use_workspace(uid, ensure_workspace(uid)):
        channel = manager.current()
        channel.store.bind({'bot_token': 'token', 'ilink_bot_id': 'bot', 'ilink_user_id': 'owner'})
        channel.store.receive([{'message_id': 1, 'context_token': 'ctx', 'item_list': [{'type': 2, 'image_item': {}}]}], 'cursor')
    channel.http = httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, json={'ret': 0})))
    asyncio.run(channel.work_once())
    snapshot = client.get('/channels/weixin').json()
    assert snapshot['conversation_id'] is not None
    assert snapshot['unread_count'] == 1
    messages = client.get(f"/chat/messages?conversation_id={snapshot['conversation_id']}").json()
    assert len(messages) == 2
    assert '微信渠道' in messages[1]['content']
    assert client.post('/channels/weixin/read', json={
        'through_sequence': snapshot['readable_sequence'], 'binding_id': snapshot['binding_id']
    }).json()['unread_count'] == 0


def test_authenticated_asgi_streams_push_commits_and_ignore_foreign_workspace_query():
    owner = register_authenticated_client(app, 'sse-owner@example.com')
    other = register_authenticated_client(app, 'sse-other@example.com')
    owner_id = owner.get('/auth/me').json()['user']['id']
    with use_workspace(owner_id, ensure_workspace(owner_id)):
        channel = manager.current()
    channel.store.bind({'bot_token': 'never-expose-this-token', 'ilink_bot_id': 'bot', 'ilink_user_id': 'owner'})

    @asynccontextmanager
    async def open_stream(client, query=b''):
        incoming = asyncio.Queue()
        outgoing = asyncio.Queue()
        await incoming.put({'type': 'http.request', 'body': b'', 'more_body': False})
        async def send(message):
            await outgoing.put(message)
        scope = {'type': 'http', 'asgi': {'version': '3.0', 'spec_version': '2.3'},
                 'http_version': '1.1', 'method': 'GET', 'scheme': 'http',
                 'path': '/channels/weixin/events', 'raw_path': b'/channels/weixin/events',
                 'query_string': query, 'root_path': '', 'server': ('testserver', 80),
                 'client': ('127.0.0.1', 12345), 'headers': [(b'authorization', client.headers['Authorization'].encode())]}
        task = asyncio.create_task(app(scope, incoming.get, send))
        try:
            start = await asyncio.wait_for(outgoing.get(), 5)
            assert start['status'] == 200
            async def snapshot():
                message = await asyncio.wait_for(outgoing.get(), 5)
                raw = message['body'].decode()
                assert raw.startswith('event: weixin-status\ndata: ')
                assert 'never-expose-this-token' not in raw
                return json.loads(raw.split('data: ', 1)[1])
            yield snapshot, outgoing
        finally:
            await incoming.put({'type': 'http.disconnect'})
            await asyncio.wait_for(task, 5)

    async def scenario():
        async with open_stream(owner) as (read_owner, _), open_stream(other, f'user_id={owner_id}'.encode()) as (read_other, other_events):
            assert (await read_owner())['connected'] is True
            assert (await read_other())['connected'] is False
            channel.store.receive([{'message_id': 1}], 'cursor')
            assert (await read_owner())['unread_count'] == 1
            assert other_events.empty()
            channel.store.save_reply(channel.store.next_job()['id'], 'answer')
            readable = await read_owner()
            channel.store.mark_read(1, readable['binding_id'])
            assert (await read_owner())['unread_count'] == 0
        assert channel.events.subscriber_count == 0
        assert channel.store.get('enabled') is True
    asyncio.run(scenario())
