"""Exercise the real local callback and workspace catalog with offline OAuth."""
import asyncio
import copy
import json
import time
from contextlib import asynccontextmanager
from dataclasses import asdict, replace
from unittest.mock import AsyncMock
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient

from api_client import create_authenticated_client, register_authenticated_client
from app import chatgpt_oauth as oauth, chatgpt_subscription as subscription, db
from app.agent.model_catalog import get_profile_connection
from app.main import app
from app.models.base import ModelProviderError
from app.secret_store import SecretStoreUnavailable
from app.workspace import use_workspace, resolve_db_path


ROOT = '/agent/chatgpt-subscription'


def tokens(*, plan=True):
    return oauth.TokenSet(
        client_id='issued-client', subject='subject-secret', email='user@example.test', issuer=oauth.ISSUER,
        id_token='synthetic-id-token', access_token='synthetic-access-token' if plan else None,
        refresh_token='synthetic-refresh-token', token_type='Bearer', expires_in=1800,
        expires_at=time.time() + 1800 if plan else None,
        scopes=tuple(sorted(oauth.PLAN_SCOPES)) if plan else ('openid',),
    )


@pytest.fixture
def vault(monkeypatch):
    states = {}

    def read(path):
        return copy.deepcopy(states.get(path, {'active_id': None, 'accounts': {}}))

    @asynccontextmanager
    async def edit(path):
        state = read(path)
        yield state
        states[path] = copy.deepcopy(state)

    monkeypatch.setattr(subscription, 'local_enabled', lambda: True)
    monkeypatch.setattr(subscription, '_attempts', {})
    monkeypatch.setattr(subscription.store, 'storage_available', lambda: True)
    monkeypatch.setattr(subscription.store, 'read_state', read)
    monkeypatch.setattr(subscription.store, 'edit_state', edit)
    monkeypatch.setattr(subscription.store, 'host_id', lambda: 'urn:uuid:eef98d60-9f70-44d5-b293-79bea1271893')
    return states


@pytest.fixture
def clients(tmp_path, monkeypatch, vault):
    monkeypatch.setenv('TUANTUAN_DATA_DIR', str(tmp_path))
    monkeypatch.setattr(db, 'DB_PATH', tmp_path / 'isolated.db')
    db.init_db()
    with create_authenticated_client(app) as owner, register_authenticated_client(app, 'other-chatgpt@example.test') as other:
        yield owner, other


def finish_login(client, value, monkeypatch):
    exchange = AsyncMock(return_value=value)
    monkeypatch.setattr(oauth, 'exchange_code', exchange)
    result = client.post(f'{ROOT}/start', json={})
    assert result.status_code == 200, result.text
    assert result.headers['cache-control'] == 'no-store'
    attempt = result.json()
    auth = parse_qs(urlsplit(attempt['authorization_url']).query)
    callback = auth['redirect_uri'][0]
    with httpx.Client(trust_env=False, timeout=10) as local:
        bad = local.get(callback, params={'code': 'not-sent', 'state': 'wrong-state', 'client_id': value.client_id})
        assert bad.status_code == 400
        assert client.get(f"{ROOT}/attempts/{attempt['attempt_id']}").json()['status'] == 'pending'
        exchange.assert_not_awaited()
        good = local.get(callback, params={'code': 'test-code', 'state': auth['state'][0], 'client_id': value.client_id})
    assert good.status_code == 200
    assert good.headers['referrer-policy'] == 'no-referrer'
    assert 'test-code' not in good.text
    exchange.assert_awaited_once()
    assert client.get(f"{ROOT}/attempts/{attempt['attempt_id']}").json()['status'] == 'completed'
    return attempt['attempt_id']


def test_oauth_loopback_catalog_isolation_and_signout(clients, vault, monkeypatch):
    owner, other = clients
    assert TestClient(app).get(ROOT).status_code == 401
    assert owner.post(f'{ROOT}/start', json={'reconsent': True}).status_code == 400
    attempt = finish_login(owner, tokens(), monkeypatch)
    assert other.get(f'{ROOT}/attempts/{attempt}').status_code == 400
    assert other.get(ROOT).json()['status'] == 'signed_out'
    status = owner.get(ROOT).json()
    assert status['status'] == 'connected' and status['plan_enabled']
    cid = status['connection_id']
    assert cid == status['active_id']
    assert other.post(f'{ROOT}/active', json={'account_id': cid}).status_code == 400
    catalog = owner.get('/agent/model-connections').json()
    managed = next(item for item in catalog['connections'] if item['id'] == cid)
    assert managed['auth_kind'] == 'chatgpt_subscription'
    assert not managed['api_key_configured']
    assert not catalog['profiles'] and not catalog['default_profile_id']
    assert all(row['id'] != cid for row in other.get('/agent/model-connections').json()['connections'])
    assert owner.post(f'/agent/model-connections/{cid}/reveal-key').status_code == 400
    assert owner.patch(f'/agent/model-connections/{cid}', json={'name': 'tamper', 'expected_revision': 1}).status_code == 400
    assert owner.delete(f'/agent/model-connections/{cid}', params={'remove': True, 'expected_revision': 1}).status_code == 400
    assert owner.post('/agent/model-profiles', json={'connection_id': cid, 'model_name': 'not-listed'}).status_code == 400

    requests = []

    async def handler(request):
        assert request.headers['authorization'] == 'Bearer synthetic-access-token'
        if request.method == 'GET':
            assert str(request.url) == 'https://api.openai.com/v1/models'
            return httpx.Response(200, json={'models': [{'slug': 'gpt-test', 'display_name': 'GPT Test', 'visibility': 'list'}]})
        assert str(request.url) == 'https://api.openai.com/v1/responses'
        requests.append(json.loads(request.content))
        text = 'Hello from the subscription.'
        events = [
            {'type': 'response.output_text.delta', 'delta': text},
            {'type': 'response.completed', 'response': {'status': 'completed', 'output': [
                {'type': 'message', 'role': 'assistant', 'content': [{'type': 'output_text', 'text': text}]},
            ]}},
        ]
        stream = ''.join(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n" for event in events)
        return httpx.Response(200, headers={'Content-Type': 'text/event-stream'}, content=stream.encode())

    from app.models import chatgpt_subscription as provider
    real_client = httpx.AsyncClient
    # Replace only the provider's client construction, not the loopback transport.
    monkeypatch.setattr(provider.httpx, 'AsyncClient', lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw))
    discovered = owner.post(f'/agent/model-connections/{cid}/discover')
    assert discovered.status_code == 200, discovered.text
    assert discovered.json()['models'] == ['gpt-test']
    created = owner.post('/agent/model-profiles', json={'connection_id': cid, 'model_name': 'gpt-test'})
    assert created.status_code == 200, created.text
    profile = created.json()['profiles'][0]
    assert profile['model_name'] == 'gpt-test'
    owner_id = owner.get('/auth/me').json()['user']['id']
    with use_workspace(owner_id):
        bound = get_profile_connection(profile['id'])
        assert bound['api_key'] == ''
        assert bound['credential_fingerprint'] == vault[resolve_db_path()]['accounts'][cid]['generation']
    conversation = owner.post('/conversations', json={'title': 'Subscription test'}).json()
    turn = owner.post('/ag-ui', json={
        'threadId': str(conversation['id']), 'runId': 'subscription-first-turn', 'state': {},
        'messages': [{'id': 'subscription-user', 'role': 'user', 'content': '你好'}],
        'tools': [], 'context': [], 'forwardedProps': {'modelProfileId': profile['id']},
    })
    assert turn.status_code == 200, turn.text
    turn_events = [json.loads(line.removeprefix('data: ')) for line in turn.text.splitlines() if line.startswith('data: ')]
    assert turn_events[-1]['type'] == 'RUN_FINISHED', turn_events
    assert 'Hello from the subscription.' in turn.text
    assert requests and all(body['model'] == 'gpt-test' and body['stream'] and not body['store'] for body in requests)
    assert '你好' in json.dumps(requests, ensure_ascii=False)

    from app.channels.weixin.bridge import execute_message

    selected = owner.patch(f"/conversations/{conversation['id']}", json={'model_profile_id': profile['id']})
    assert selected.status_code == 200, selected.text
    calls_before = len(requests)
    with use_workspace(owner_id), pytest.raises(HTTPException) as external:
        asyncio.run(execute_message('你好', conversation['id'], 'subscription-channel-turn'))
    assert external.value.status_code == 400
    assert '不支持外部消息渠道' in external.value.detail
    assert len(requests) == calls_before
    for body in (str(status), str(catalog), discovered.text, created.text, turn.text):
        assert 'synthetic-' not in body and 'subject-secret' not in body and 'issued-client' not in body

    revoke = AsyncMock()
    monkeypatch.setattr(oauth, 'revoke_refresh_token', revoke)
    signed_out = owner.delete(ROOT)
    assert signed_out.json()['status'] == 'signed_out'
    revoke.assert_awaited_once()
    assert owner.post(f'/agent/model-connections/{cid}/discover').status_code == 503
    with use_workspace(owner_id), pytest.raises(SecretStoreUnavailable):
        get_profile_connection(profile['id'])


def test_identity_only_and_non_local_guards(clients, monkeypatch):
    owner, _ = clients
    finish_login(owner, tokens(plan=False), monkeypatch)
    status = owner.get(ROOT).json()
    assert status['status'] == 'identity_only' and status['configured'] and not status['plan_enabled']
    assert status['connection_id'] is None
    assert not owner.get('/agent/model-connections').json()['connections']
    monkeypatch.setattr(subscription, 'local_enabled', lambda: False)
    assert not owner.get(ROOT).json()['available']
    assert owner.post(f'{ROOT}/start', json={}).status_code == 400
    assert owner.post(f'{ROOT}/active', json={'account_id': status['active_id']}).status_code == 400
    assert owner.delete(ROOT).status_code == 400


def test_rotation_keeps_binding_but_terminal_refresh_removes_it(tmp_path, vault, monkeypatch):
    path = tmp_path / 'workspace.db'
    old = replace(tokens(), expires_at=time.time() - 1)
    vault[path] = {'active_id': 'a', 'accounts': {'a': {'generation': 'generation', 'tokens': asdict(old)}}}
    rotated = replace(tokens(), access_token='rotated-token', refresh_token='rotated-refresh')
    refresh = AsyncMock(return_value=rotated)
    monkeypatch.setattr(oauth, 'refresh_tokens', refresh)
    assert asyncio.run(subscription.access_token(path, 'a', 'generation')) == 'rotated-token'
    assert subscription.binding(path, 'a') == 'generation'
    assert asyncio.run(subscription.access_token(path, 'a', 'generation')) == 'rotated-token'
    refresh.assert_awaited_once()
    vault[path]['accounts']['a']['tokens']['expires_at'] = time.time() - 1
    refresh.side_effect = oauth.OAuthError('invalid_grant')
    with pytest.raises(ModelProviderError) as exc:
        asyncio.run(subscription.access_token(path, 'a', 'generation'))
    assert exc.value.code == 'chatgpt_reauthorize'
    assert subscription.binding(path, 'a') == ''
    assert vault[path]['accounts']['a']['tokens'] is None
