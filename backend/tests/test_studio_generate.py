"""Exercise the studio HTTP contract and inspect the actual SDK request on the wire."""
import asyncio
import base64
import json
from io import BytesIO
from uuid import uuid4

import httpx
import pytest
from fastapi import FastAPI
from openai import AsyncOpenAI
from PIL import Image

from app.agent.model_catalog import create_model_connection, get_model_catalog
from app.agent.model_purposes import save_purpose_default
from app.api.studio_generate import router
from app.chat import studio_generate as studio
from app.db import connect, init_db
from app.workspace import resolve_db_path, use_workspace


@pytest.fixture
def workspace(tmp_path):
    with use_workspace(3, tmp_path / 'account-3'):
        init_db()
        ids = {}
        for model, protocol in [('gpt-image-1.5','auto'), ('gpt-image-2','auto'), ('private-image-v9','images'),
                                ('grok-4.7','responses'), ('gpt-4.1','auto')]:
            source = create_model_connection({'name': model, 'api_key':'fake-studio-key',
                'model_base_url':'https://studio.example.test/v1', 'model_protocol':protocol, 'model_name':model})
            profiles = get_model_catalog()['profiles']
            ids[model] = next(p['id'] for p in profiles if p['connection_id'] == source['id'])
        save_purpose_default('image', {'profile_id':ids['gpt-image-1.5'],
                                       'expected_version':get_model_catalog()['purpose_version']})
        yield ids


def app_transport():
    app = FastAPI()
    app.include_router(router)
    return httpx.ASGITransport(app=app)


def png(size=(1536, 1024)):
    buffer = BytesIO()
    Image.new('RGB',size,'blue').save(buffer,'PNG')
    return base64.b64encode(buffer.getvalue()).decode()


def wire(monkeypatch, handler):
    def client(**kwargs):
        return AsyncOpenAI(api_key=kwargs['api_key'], base_url=kwargs['base_url'], max_retries=0,
                           http_client=httpx.AsyncClient(transport=httpx.MockTransport(handler)))
    monkeypatch.setattr('app.models.openai_compatible.AsyncOpenAI',client)


def payload(profile=None, size='auto'):
    return {'request_id':str(uuid4()),'prompt':'画一张日落海报','profile_id':profile,'size':size}


def read_task(tid):
    with connect() as conn:
        return dict(conn.execute('SELECT * FROM image_studio_tasks WHERE id=?',(tid,)).fetchone())


async def wait_task(tid):
    task = studio._active[resolve_db_path()][2]
    await asyncio.wait_for(asyncio.shield(task), 5)
    return read_task(tid)


def test_options_use_eligible_models_and_never_resolve_secrets(workspace, monkeypatch):
    monkeypatch.setattr('app.agent.model_catalog._secret', lambda *a, **k: pytest.fail('reading options must not resolve credentials'))
    async def run():
        async with httpx.AsyncClient(transport=app_transport(),base_url='http://test') as api:
            resp = await api.get('/image-studio/options')
            assert resp.status_code == 200
            assert 'fake-studio-key' not in resp.text
            opts = resp.json()
            sizes = {m['id']:m['sizes'] for m in opts['models']}
            assert opts['default_profile_id'] == workspace['gpt-image-1.5']
            assert sizes[workspace['gpt-image-2']] == ['auto','1024x1024','1536x1024','1024x1536']
            assert sizes[workspace['private-image-v9']] == sizes[workspace['grok-4.7']] == ['auto']
            assert workspace['gpt-4.1'] not in sizes
            assert opts['can_edit'] is True
            catalog = studio.selection_catalog()
            grok_only = {**catalog, 'profiles': [p for p in catalog['profiles'] if p['id'] == workspace['grok-4.7']]}
            monkeypatch.setattr(studio, 'selection_catalog', lambda: grok_only)
            grok = (await api.get('/image-studio/options')).json()
            assert grok['can_edit'] is False and grok['default_profile_id'] == workspace['grok-4.7']
    asyncio.run(run())


@pytest.mark.parametrize('size',['auto','1024x1024','1536x1024','1024x1536'])
def test_submit_binds_wire_params_actual_dimensions_and_chat(workspace, monkeypatch, size):
    calls = []
    dimensions = tuple(int(n) for n in size.split('x')) if size!='auto' else (256,256)
    def handler(req):
        calls.append(req)
        return httpx.Response(200,json={'data':[{'b64_json':png(dimensions)}]})
    wire(monkeypatch, handler)
    async def run():
        async with httpx.AsyncClient(transport=app_transport(),base_url='http://test') as api:
            request = payload(workspace['gpt-image-2'],size)
            tid = request['request_id']
            resp = await api.post('/image-studio/generate', json=request)
            assert resp.status_code == 202 and resp.json() == {'id':tid}
            row = await wait_task(tid)
            assert len(calls)==1 and calls[0].method=='POST' and calls[0].url.path=='/v1/images/generations'
            sent = json.loads(calls[0].content)
            assert sent['model']=='gpt-image-2' and sent['n']==1 and request['prompt'] in sent['prompt']
            if size=='auto':
                assert sent.keys()=={'model','prompt','n'}  # preserve legacy gateways
            else:
                assert sent['size']==size
            assert (row['status'], row['size'], row['profile_id']) == ('done',size,workspace['gpt-image-2'])
            with connect() as conn:
                a = conn.execute('SELECT * FROM chat_image_assets WHERE operation_id=?',(tid,)).fetchone()
                meta = json.loads(a['metadata_json']); assert (meta['width'],meta['height'])==dimensions
                assert (resolve_db_path().parent/a['stored_path']).is_file()
                turns = conn.execute('SELECT * FROM chat_messages WHERE conversation_id=? ORDER BY id',(row['conversation_id'],)).fetchall()
                assert [t['role'] for t in turns]==['user','assistant']
                assert turns[0]['content']==request['prompt'] and a['message_id']==turns[1]['id']
                assert json.loads(turns[1]['payload_json'])['agent']['assets'][0]['id']==a['id']
                assert 'fake-studio-key' not in conn.execute('SELECT selection_json FROM chat_image_operations WHERE id=?',(tid,)).fetchone()[0]
            assert studio.studio_options()['default_profile_id']==workspace['gpt-image-1.5']
            monkeypatch.setattr(studio, 'resolve_purpose_connection', lambda *a, **k:pytest.fail('replay should bypass lookup'))
            assert (await api.post('/image-studio/generate', json=request)).json()=={'id':tid}
            assert (await api.post('/image-studio/generate', json={**request,'size':'auto' if size!='auto' else '1024x1024'})).status_code==409
            with connect() as conn:
                conn.execute('DELETE FROM conversations WHERE id=?', (row['conversation_id'],))
            # A delayed replay after deleting the owning conversation cannot buy
            # the same image again, even though the task and journal are gone.
            assert (await api.post('/image-studio/generate', json=request)).status_code==409
            assert len(calls)==1
    asyncio.run(run())


def test_reject_unknown_size_and_ineligible_model_before_attempt(workspace,monkeypatch):
    monkeypatch.setattr(studio,'_provider',lambda *_:pytest.fail('must not call provider'))
    async def run():
        async with httpx.AsyncClient(transport=app_transport(),base_url='http://test') as api:
            for model,size,code in [('private-image-v9','1536x1024',400),('grok-4.7','1024x1024',400),
                                    ('gpt-4.1','auto',400),('gpt-image-2','512x512',422)]:
                assert (await api.post('/image-studio/generate',json=payload(workspace[model],size))).status_code==code
            with connect() as conn:
                assert conn.execute('SELECT COUNT(*) FROM image_studio_tasks').fetchone()[0]==0
    asyncio.run(run())


@pytest.mark.parametrize('code,status',[(400,'failed'),(500,'uncertain'),(200,'uncertain')])
def test_rejected_or_unknown_outcomes_never_replay(workspace,monkeypatch,code,status):
    calls=[]
    async def handler(req):
        calls.append(req)
        return httpx.Response(code,json={'error':{'message':'fake-studio-key'}} if code!=200 else {'data':[]})
    wire(monkeypatch,handler)
    async def run():
        async with httpx.AsyncClient(transport=app_transport(),base_url='http://test') as api:
            req=payload(); tid=req['request_id']
            await api.post('/image-studio/generate',json=req)
            row = await wait_task(tid)
            assert row['status']==status and row['error'] and 'fake-studio-key' not in row['error']
            assert (await api.post('/image-studio/generate',json=req)).json()=={'id':tid}
            assert len(calls)==1
    asyncio.run(run())


def test_double_click_workspace_isolation_and_shutdown(workspace,monkeypatch,tmp_path):
    async def run():
        gate=asyncio.Event()
        calls=[]
        async def handler(req):
            calls.append(req);gate.set();await asyncio.Future()
        wire(monkeypatch,handler)
        req=studio.GenerateIn(**payload()); tid=str(req.request_id)
        assert await asyncio.gather(studio.submit(req),studio.submit(req))==[tid,tid]
        await asyncio.wait_for(gate.wait(), 5)
        assert studio.is_running(tid)
        cid=read_task(tid)['conversation_id'];assert studio.is_conversation_running(cid)
        assert not studio.try_reserve_edit('test-edit',cid)
        with use_workspace(8,tmp_path/'account-8'):
            init_db(); assert not studio.is_running(tid) and not studio.is_conversation_running(cid)
            with connect() as conn:
                assert conn.execute('SELECT COUNT(*) FROM image_studio_tasks').fetchone()[0]==0
        with pytest.raises(studio.StudioConflict):
            await studio.submit(studio.GenerateIn(**payload()))
        await studio.shutdown_generations();assert not studio.is_running(tid)
        assert read_task(tid)['status']=='uncertain'
        assert await studio.submit(req)==tid and len(calls)==1
        assert studio.try_reserve_edit('test-edit', cid)
        try:
            with pytest.raises(studio.StudioConflict):
                await studio.submit(studio.GenerateIn(**payload()))
            assert studio.current_task_id()=='test-edit'
        finally:
            studio.release_edit('test-edit')
        assert studio.current_task_id() is None
    asyncio.run(run())


def test_grok_uses_responses_tool_without_images_size_or_fallback(workspace, monkeypatch):
    calls = []
    def handler(req):
        calls.append(req)
        return httpx.Response(200,json={'id':'resp_1','status':'completed','output':[{
            'type':'image_generation_call','id':'ig_1','status':'completed','result':png((40,30)),
        }]})
    wire(monkeypatch, handler)
    async def run():
        tid = await studio.submit(studio.GenerateIn(**payload(workspace['grok-4.7'])))
        row = await wait_task(tid)
        assert row['status']=='done' and row['model_name']=='grok-4.7'
        assert len(calls)==1 and calls[0].url.path=='/v1/responses'
        sent = json.loads(calls[0].content)
        assert sent['tools']==[{'type':'image_generation','action':'generate'}]
        assert sent['tool_choice']=='required' and 'size' not in sent
    asyncio.run(run())
