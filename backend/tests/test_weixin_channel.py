from __future__ import annotations

import asyncio
import json

import httpx
import pytest


def test_official_qr_headers_and_authenticated_reply():
    from app.channels.weixin.client import WeixinClient

    requests = []

    def respond(request):
        requests.append(request)
        if request.url.path.endswith('get_bot_qrcode'):
            return httpx.Response(200, json={'qrcode': 'qr-secret', 'qrcode_img_content': 'https://weixin.qq.com/login/qr'})
        if request.url.path.endswith('get_qrcode_status'):
            return httpx.Response(200, json={'status': 'wait'})
        return httpx.Response(200, json={'ret': 0})

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as http:
            client = WeixinClient(http)
            await client.start_login()
            await client.poll_login('qr-secret')
            await client.send_text('bot-token', 'owner', 'context-secret', '你好', 'stable-id')

    asyncio.run(scenario())
    qr, poll, reply = requests
    assert qr.method == 'POST' and qr.url.params['bot_type'] == '3'
    assert json.loads(qr.content) == {'local_token_list': []}
    assert qr.headers['iLink-App-Id'] == 'bot'
    assert 'authorization' not in qr.headers
    assert poll.method == 'GET' and 'authorizationtype' not in poll.headers
    assert reply.headers['authorization'] == 'Bearer bot-token'
    payload = json.loads(reply.content)
    assert payload['msg']['context_token'] == 'context-secret'
    assert payload['msg']['client_id'] == 'stable-id'
    assert payload['msg']['item_list'] == [{'type': 1, 'text_item': {'text': '你好'}}]
    assert payload['base_info']['bot_agent'].startswith('Tuantuan/')


@pytest.mark.parametrize('url', ['http://ilinkai.weixin.qq.com', 'https://localhost', 'https://weixin.qq.com.evil.test', 'https://evil.test', 'https://user:pass@ilinkai.weixin.qq.com', 'https://ilinkai.weixin.qq.com:444'])
def test_rejects_untrusted_api_hosts(url):
    from app.channels.weixin.client import validate_base_url

    with pytest.raises(ValueError):
        validate_base_url(url)


def test_upstream_errors_do_not_expose_tokens():
    from app.channels.weixin.client import WeixinClient, WeixinError

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, json={'ret': -14, 'errmsg': 'secret-token private-context'}))) as http:
            with pytest.raises(WeixinError) as error:
                await WeixinClient(http).get_updates('secret-token', '')
            assert error.value.code == -14
            assert 'secret-token' not in str(error.value)
            assert 'private-context' not in str(error.value)

    asyncio.run(scenario())


def test_inbox_cursor_dedup_and_encrypted_credentials(tmp_path):
    from app.channels.weixin.store import WeixinStore

    store = WeixinStore(tmp_path)
    store.bind({'bot_token': 'bot-secret', 'ilink_bot_id': 'bot', 'ilink_user_id': 'owner', 'baseurl': 'https://ilinkai.weixin.qq.com'})
    message = {'message_id': 9, 'from_user_id': 'owner', 'context_token': 'context-secret'}
    store.receive([message, message], 'cursor-1')
    assert store.account()['bot_token'] == 'bot-secret'
    assert store.cursor() == 'cursor-1'
    job = store.next_job()
    assert job['message']['message_id'] == 9
    store.save_reply(job['id'], 'answer')
    store.receive([message], 'cursor-2')
    assert store.next_job()['reply'] == 'answer'
    store.delivered(job['id'])
    assert store.next_job() is None
    assert b'bot-secret' not in store.path.read_bytes()
    assert b'context-secret' not in store.path.read_bytes()
    assert WeixinStore(tmp_path).cursor() == 'cursor-2'
    store.disconnect()
    assert store.account() is None


def test_missing_message_id_does_not_collapse_distinct_messages(tmp_path):
    from app.channels.weixin.store import WeixinStore

    store = WeixinStore(tmp_path)
    store.receive([{'seq': 1, 'text': 'first'}, {'seq': 2, 'text': 'second'}], 'cursor')
    first = store.next_job()
    store.delivered(first['id'])
    assert store.next_job()['message']['text'] == 'second'


def test_weixin_query_and_context_credentials_are_redacted():
    from app.redaction import redact_secrets
    text = 'GET https://ilinkai.weixin.qq.com/status?qrcode=qr%2Bsecret&verify_code=12 context_token=private-context bot_token=private-bot'
    result = redact_secrets(text)
    for value in ['qr%2Bsecret', '12', 'private-context', 'private-bot']:
        assert value not in result


def test_reconnecting_same_bot_keeps_pending_answers_and_message_identity(tmp_path):
    from app.channels.weixin.store import WeixinStore
    store = WeixinStore(tmp_path)
    account = {'bot_token': 'first-token', 'ilink_bot_id': 'bot', 'ilink_user_id': 'owner'}
    store.bind(account)
    message = {'message_id': 10, 'context_token': 'ctx'}
    store.receive([message], 'cursor')
    job = store.next_job()
    store.save_reply(job['id'], 'already-paid-answer')
    store.bind({**account, 'bot_token': 'renewed-token'})
    assert store.cursor() == 'cursor'
    assert store.next_job()['reply'] == 'already-paid-answer'
    store.receive([message], 'next-cursor')
    store.delivered(job['id'])
    assert store.next_job() is None


def test_idle_long_poll_timeout_keeps_cursor_without_reporting_service_failure():
    from app.channels.weixin.client import WeixinClient

    def respond(request):
        raise httpx.ReadTimeout('private-token-and-url', request=request)

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as http:
            result = await WeixinClient(http).get_updates('private-token', 'existing-cursor')
            assert result == {'ret': 0, 'msgs': [], 'get_updates_buf': 'existing-cursor'}
    asyncio.run(scenario())


@pytest.mark.parametrize('failure,expected', [('connect', '无法连接微信服务'), ('http', 'HTTP 503'), ('json', '无效数据'), ('send-timeout', '读取超时')])
def test_transport_errors_identify_failure_without_exposing_credentials(failure, expected):
    from app.channels.weixin.client import WeixinClient, WeixinError

    def respond(request):
        if failure == 'connect':
            raise httpx.ConnectError('private-token', request=request)
        if failure == 'send-timeout':
            raise httpx.ReadTimeout('private-token', request=request)
        if failure == 'http':
            return httpx.Response(503, text='private-token')
        return httpx.Response(200, text='private-token')

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as http:
            with pytest.raises(WeixinError) as caught:
                await WeixinClient(http).send_text('private-token', 'owner', 'context', 'hello', 'id')
            assert expected in str(caught.value)
            assert 'private-token' not in str(caught.value)
    asyncio.run(scenario())
