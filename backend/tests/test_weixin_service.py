from __future__ import annotations

import asyncio
import json

import httpx
import pytest


def test_login_binds_owner_without_returning_credentials(tmp_path):
    from app.channels.weixin.service import WeixinService

    def respond(request):
        if request.url.path.endswith('get_bot_qrcode'):
            return httpx.Response(200, json={'qrcode': 'secret-qr', 'qrcode_img_content': 'https://weixin.qq.com/login/test'})
        return httpx.Response(200, json={'status': 'confirmed', 'bot_token': 'secret-token', 'ilink_bot_id': 'bot', 'ilink_user_id': 'owner', 'baseurl': 'https://ilinkai.weixin.qq.com'})

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as http:
            channel = WeixinService(1, tmp_path, http=http)
            login = await channel.login()
            result = await channel.poll_login(login['session_id'])
            assert result['status'] == 'confirmed'
            assert channel.status()['connected'] is True
            assert 'secret-token' not in json.dumps(result)
            assert 'secret-token' not in json.dumps(channel.status())
            assert channel.store.account()['ilink_user_id'] == 'owner'
            with pytest.raises(ValueError):
                await channel.poll_login('another-users-session')

    asyncio.run(scenario())


def test_disconnect_prevents_late_login_response_rebinding(tmp_path):
    from app.channels.weixin.service import WeixinService

    async def scenario():
        entered, finish = asyncio.Event(), asyncio.Event()

        async def respond(request):
            if request.url.path.endswith('get_bot_qrcode'):
                return httpx.Response(200, json={'qrcode': 'qr', 'qrcode_img_content': 'https://weixin.qq.com/login/test'})
            entered.set()
            await finish.wait()
            return httpx.Response(200, json={'status': 'confirmed', 'bot_token': 'token', 'ilink_bot_id': 'bot', 'ilink_user_id': 'owner'})

        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as http:
            channel = WeixinService(1, tmp_path, http=http)
            login = await channel.login()
            pending = asyncio.create_task(channel.poll_login(login['session_id']))
            await entered.wait()
            await channel.disconnect()
            finish.set()
            with pytest.raises(ValueError):
                await pending
            assert channel.status()['connected'] is False

    asyncio.run(scenario())


def test_only_owner_private_messages_execute_and_delivery_retry_reuses_answer(tmp_path):
    from app.channels.weixin.service import WeixinService
    from app.channels.weixin.client import WeixinError

    executions, deliveries = [], []

    async def execute(content, conversation_id, run_id):
        executions.append(content)
        return {'text': '任务已完成', 'conversation_id': 12}

    def respond(request):
        deliveries.append(json.loads(request.content)['msg'])
        return httpx.Response(503 if len(deliveries) == 1 else 200, json={'ret': 0})

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as http:
            channel = WeixinService(1, tmp_path, http=http, executor=execute)
            channel.store.bind({'bot_token': 'token', 'ilink_bot_id': 'bot', 'ilink_user_id': 'owner', 'baseurl': 'https://ilinkai.weixin.qq.com'})
            messages = [
                {'message_id': 1, 'from_user_id': 'stranger'},
                {'message_id': 2, 'from_user_id': 'owner', 'group_id': 'group'},
                {'message_id': 3, 'from_user_id': 'owner', 'message_type': 2},
                {'message_id': 4, 'from_user_id': 'owner', 'message_type': 1, 'context_token': 'ctx', 'item_list': [{'type': 1, 'text_item': {'text': '执行任务'}}]},
            ]
            channel.accept_updates({'msgs': messages, 'get_updates_buf': 'cursor'})
            assert channel.store.cursor() == 'cursor'
            with pytest.raises(WeixinError):
                await channel.work_once()
            await channel.work_once()
            channel.accept_updates({'msgs': messages, 'get_updates_buf': 'cursor-2'})
            assert await channel.work_once() is False
            assert executions == ['执行任务']
            assert deliveries[0]['client_id'] == deliveries[1]['client_id']
            assert deliveries[1]['context_token'] == 'ctx'
            assert deliveries[1]['to_user_id'] == 'owner'

    asyncio.run(scenario())


def test_missing_context_does_not_execute_task(tmp_path):
    from app.channels.weixin.service import WeixinService

    async def execute(*args):
        pytest.fail('a message without a reply context must not run')

    async def scenario():
        async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: httpx.Response(200, json={}))) as http:
            channel = WeixinService(1, tmp_path, http=http, executor=execute)
            channel.store.bind({'bot_token': 'token', 'ilink_bot_id': 'bot', 'ilink_user_id': 'owner'})
            channel.accept_updates({'msgs': [{'message_id': 1, 'from_user_id': 'owner', 'message_type': 1, 'item_list': [{'type': 1, 'text_item': {'text': 'hello'}}]}]})
            assert await channel.work_once() is False

    asyncio.run(scenario())
