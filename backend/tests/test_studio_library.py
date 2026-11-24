from __future__ import annotations

import base64
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from PIL import Image

from api_client import create_authenticated_client, register_authenticated_client
from app import db
from app.chat.conversations import create_conversation
from app.chat.image_assets import begin_generation, persist_images
from app.db import DB_SCHEMA_VERSION, connect, init_db
from app.domain import ModelResponse
from app.domain.agent import ModelImageOutput
from app.workspace import resolve_db_path, use_workspace


def _image(operation_id: str, conversation_id: int, *, studio: bool = True, dimensions=(48, 32)):
    buf = BytesIO()
    Image.new('RGB', dimensions, '#aabbcc').save(buf, 'PNG')
    pixels = buf.getvalue()
    if studio:
        with connect() as conn:
            conn.execute("""INSERT INTO image_studio_tasks
                    (id,request_hash,conversation_id,prompt,size,model_name,status)
                    VALUES (?, 'fake-hash',?,'First studio 猫','1536x1024','test','done')""", (operation_id, conversation_id))
    begin_generation(operation_id, conversation_id, {'model_name': 'test'})
    response = ModelResponse(images=[ModelImageOutput(item_id='output', base64_data=base64.b64encode(pixels).decode())])
    return persist_images(operation_id, response, 'test')['assets'][0], pixels


@pytest.fixture
def clients(tmp_path, monkeypatch):
    from app.main import app
    monkeypatch.setattr(db, 'DB_PATH', tmp_path/'api.db')
    init_db()
    owner = create_authenticated_client(app)
    other = register_authenticated_client(app, 'other-studio@example.com')
    try:
        yield owner, other
    finally:
        owner.close()
        other.close()


def test_studio_history_edit_archive_and_isolation(clients):
    owner, other = clients
    with use_workspace(1):
        cid = create_conversation('图片创作')['id']
        asset, original = _image('generation', cid)
        _image('normal-chat', create_conversation('聊天')['id'], studio=False)
    base = '/image-studio'
    first = owner.get(f'{base}/history').json()
    assert [t['id'] for t in first['items']] == ['generation']
    assert first['items'][0]['assets'][0] == asset
    assert first['items'][0]['size'] == '1536x1024' and first['items'][0]['created_at'].endswith('Z')
    assert not first['has_more']
    assert other.get(f'{base}/history').json() == {'items': [], 'has_more': False}
    assert other.get(f'{base}/tasks/generation').status_code == 404
    assert other.post(f"{base}/works/{asset['id']}").status_code == 404

    edit_id = str(uuid4())
    edit = {'operation_id': edit_id, 'mode': 'resize', 'width': 64, 'height': 32}
    url = f"/chat-assets/{asset['id']}/edits"
    edited = owner.post(url, json=edit)
    assert edited.status_code == 200, edited.text
    output = edited.json()['assets'][0]
    assert owner.post(url, json=edit).json()['assets'][0]['id'] == output['id']
    version = owner.get(f'{base}/tasks/{edit_id}').json()
    assert version['status'] == 'done'
    assert version['source_asset_id'] == asset['id'] and version['assets'] == [output]
    assert version['conversation_id'] == cid and version['model_name'] == 'local-resize'
    assert owner.get(f'{base}/history', params={'limit': 1, 'status': 'done'}).json()['has_more']
    result = owner.get(f'{base}/history', params={'q': 'first STUDIO 猫', 'status': 'done'}).json()
    assert [t['id'] for t in result['items']] == ['generation']
    assert owner.get(f'{base}/history', params={'q': '%'}).json()['items'] == []
    assert len(owner.get(f'{base}/history', params={'offset': 1}).json()['items']) == 1

    save_url = f"{base}/works/{asset['id']}"
    with ThreadPoolExecutor(max_workers=3) as pool:
        saved = list(pool.map(lambda _: owner.post(save_url), range(3)))
    assert {r.status_code for r in saved} == {200}
    work = saved[0].json()
    assert all(r.json() == work for r in saved)
    assert owner.get(f'{base}/works').json()['items'] == [work]
    with use_workspace(1), connect() as conn:
        assert conn.execute("SELECT COUNT(*) FROM library_sources WHERE source_uri LIKE 'image-studio:%'").fetchone()[0] == 1
    assert owner.delete(f'/conversations/{cid}').status_code == 200
    assert owner.get(f'{base}/history').json()['items'] == []
    assert owner.post(save_url).json() == work  # idempotent even after source deletion
    file_url = f"{base}/works/{work['id']}/file"
    thumb_url = f"{base}/works/{work['id']}/thumbnail"
    assert owner.get(file_url).content == original
    assert owner.get(thumb_url).headers['content-type'] == 'image/webp'
    assert owner.get(f"/chat-assets/{asset['id']}/file").status_code == 404
    assert other.get(f'{base}/works').json()['items'] == []
    assert other.get(file_url).status_code == other.get(thumb_url).status_code == 404
    owner.headers.pop('Authorization')
    assert owner.get(file_url).status_code == owner.get(f'{base}/history').status_code == 401


def test_read_projection_stale_running_and_filters(clients, monkeypatch):
    from app.chat import studio_generate
    owner, _ = clients
    with use_workspace(1), connect() as conn:
        cid = conn.execute('SELECT id FROM conversations LIMIT 1').fetchone()[0]
        conn.executemany('INSERT INTO image_studio_tasks (id,request_hash,conversation_id,prompt,status,error) '
                         'VALUES (?,\'hash\',?,\'海报\',?,?)',
                         [('live', cid, 'running', ''), ('orphan', cid, 'running', ''), ('reject', cid, 'failed', '模型拒绝请求')])
    monkeypatch.setattr(studio_generate, 'current_task_id', lambda: 'live')
    for status, task_id in [('running', 'live'), ('uncertain', 'orphan'), ('failed', 'reject')]:
        page = owner.get('/image-studio/history', params={'q':'海报', 'status':status, 'limit':1}).json()
        assert not page['has_more']
        assert page['items'][0]['id'] == task_id and page['items'][0]['status'] == status
        assert owner.get(f'/image-studio/tasks/{task_id}').json() == page['items'][0]
    with use_workspace(1), connect() as conn:
        # A process-local read cannot mutate another worker's receipt or resend it.
        assert conn.execute("SELECT status FROM image_studio_tasks WHERE id='orphan'").fetchone()[0] == 'running'
    assert owner.get('/image-studio/history?limit=99999').status_code == 422


@pytest.mark.parametrize('sent,expected', [(True, 'uncertain'), (False, 'failed')])
def test_studio_edit_error_does_not_repeat(clients, monkeypatch, sent, expected):
    from app.chat import image_editing
    from app.models import ModelProviderError
    owner, _ = clients
    with use_workspace(1):
        asset, _ = _image('original', create_conversation('图片创作')['id'])
    calls = []

    async def fail(path, request, connection, prompt, mark_submitted, *, size=None):
        if sent:
            mark_submitted()
        calls.append(prompt)
        raise ModelProviderError('request_timeout', '测试模拟的服务异常')

    monkeypatch.setattr(image_editing, '_render_edit', fail)
    monkeypatch.setattr(image_editing, 'bind_image_selection', lambda *args, **kwargs: {
        'profile_id': 'p', 'profile_revision': 1, 'connection_id': 'c', 'connection_revision': 1,
        'model_name': 'test', 'model_protocol': 'images', 'model_base_url': 'https://test.invalid'})
    edit_id = str(uuid4())
    payload = {'mode': 'edit', 'operation_id': edit_id, 'prompt': '变橙色'}
    url = f"/chat-assets/{asset['id']}/edits"
    assert owner.post(url, json=payload).status_code == 502
    replay = owner.post(url, json=payload)
    assert replay.status_code == (409 if sent else 502)
    assert len(calls) == 1
    task = owner.get(f'/image-studio/tasks/{edit_id}').json()
    assert task['status'] == expected and task['source_asset_id'] == asset['id'] and not task['assets']
    assert not owner.get('/image-studio/history?status=running').json()['items']


def test_studio_cross_service_edit_requires_current_confirmation(clients, monkeypatch):
    from app.agent.model_catalog import create_model_connection, get_model_catalog

    owner, other = clients
    with use_workspace(1):
        source, original = _image('unbound', create_conversation('图片创作')['id'])
        for name in ('工作室 A', '工作室 B'):
            create_model_connection({'name': name, 'api_key': 'fixture', 'model_name': 'gpt-image-2',
                                     'model_protocol': 'images', 'model_base_url': 'https://test.invalid'})
        chosen = next(p['id'] for p in get_model_catalog()['profiles'] if p['model_name'] == 'gpt-image-2')
    edit = AsyncMock(return_value=ModelResponse(images=[ModelImageOutput(
        item_id='edited', base64_data=base64.b64encode(original).decode())]))
    monkeypatch.setattr('app.models.openai_images.OpenAIImagesProvider.edit_image', edit)
    query = {'operation': 'image.edit', 'asset_id': source['id'], 'profile_id': chosen}
    assert other.post('/agent/model-selection/preview', json=query).status_code == 404
    preview = owner.post('/agent/model-selection/preview', json=query).json()
    assert preview['requires_confirmation'] is True
    assert {item['service_name'] for item in preview['candidates']} == {'工作室 A', '工作室 B'}
    request = {'operation_id': str(uuid4()), 'mode': 'edit', 'prompt': '改为暖色', 'profile_id': chosen}
    url = f"/chat-assets/{source['id']}/edits"
    rejected = owner.post(url, json={**request, 'confirm_data_boundary': True})
    assert rejected.json()['detail']['code'] == 'image_data_boundary_confirmation_required'
    stale = owner.post(url, json={**request, 'comparison_key': '0' * 64, 'confirm_data_boundary': True})
    assert stale.json()['detail']['code'] == 'model_selection_changed'
    edit.assert_not_awaited()
    result = owner.post(url, json={**request, 'comparison_key': preview['comparison_key'], 'confirm_data_boundary': True})
    assert result.status_code == 200, result.text
    replay = owner.post(url, json=request)
    assert replay.json()['assets'] == result.json()['assets']
    edit.assert_awaited_once()
    task = owner.get(f"/image-studio/tasks/{request['operation_id']}").json()
    assert task['service_name'] == preview['selection']['service_name'] and task['selection_reason'] == '本次指定'


def test_generation_only_model_is_not_eligible_for_studio_edit(clients, monkeypatch):
    from app.agent.model_catalog import create_model_connection, get_model_catalog

    owner, _ = clients
    with use_workspace(1):
        source, _ = _image('generation-only', create_conversation('图片创作')['id'])
        create_model_connection({'name': '出图服务', 'api_key': 'fixture', 'model_name': 'dall-e-3',
                                 'model_protocol': 'images', 'model_base_url': 'https://api.openai.com/v1'})
        profile_id = next(p['id'] for p in get_model_catalog()['profiles'] if p['model_name'] == 'dall-e-3')

    edit = AsyncMock()
    monkeypatch.setattr('app.models.openai_images.OpenAIImagesProvider.edit_image', edit)
    options = owner.get('/image-studio/options').json()
    model = next(m for m in options['models'] if m['id'] == profile_id)
    assert model['capabilities'] == {'generate': {'sizes': ['auto', '1024x1024']}, 'edit': None}
    assert options['can_edit'] is False

    preview = '/agent/model-selection/preview'
    generate = owner.post(preview, json={'operation': 'image.generate', 'profile_id': profile_id}).json()
    assert generate['eligible'] is True and generate['selection']['profile_id'] == profile_id
    edit_preview = {'operation': 'image.edit', 'asset_id': source['id']}
    for query in (edit_preview, {**edit_preview, 'profile_id': profile_id}):
        result = owner.post(preview, json=query).json()
        assert result['eligible'] is False and result['selection'] is None
        candidate = next(c for c in result['candidates'] if c['profile_id'] == profile_id)
        assert candidate['eligible'] is False and '不支持图片编辑' in candidate['reason_code']

    response = owner.post(f"/chat-assets/{source['id']}/edits", json={
        'operation_id': str(uuid4()), 'mode': 'edit', 'prompt': '改为暖色', 'profile_id': profile_id,
    })
    assert response.status_code == 400, response.text
    assert '不支持图片编辑' in response.json()['detail']
    edit.assert_not_awaited()


def test_studio_edit_preserves_supported_original_size(clients, monkeypatch):
    owner, _ = clients
    with use_workspace(1):
        source, original = _image('landscape', create_conversation('图片创作')['id'], dimensions=(1536, 1024))
    monkeypatch.setattr('app.chat.image_editing.bind_image_selection', lambda *args, **kwargs: {
        'profile_id': 'p', 'profile_revision': 1, 'connection_id': 'c', 'connection_revision': 1,
        'model_name': 'gpt-image-2', 'model_protocol': 'images', 'api_key': 'fixture', 'model_base_url': 'https://test.invalid',
    })
    edit = AsyncMock(return_value=ModelResponse(images=[ModelImageOutput(
        item_id='edited', base64_data=base64.b64encode(original).decode())]))
    monkeypatch.setattr('app.models.openai_images.OpenAIImagesProvider.edit_image', edit)
    edit_id = str(uuid4())
    request = {'operation_id': edit_id, 'mode': 'edit', 'prompt': '把配色改暖'}
    result = owner.post(f"/chat-assets/{source['id']}/edits", json=request)
    assert result.status_code == 200, result.text
    edit.assert_awaited_once()
    assert edit.call_args.kwargs['size'] == '1536x1024'
    receipt = owner.get(f'/image-studio/tasks/{edit_id}').json()
    assert receipt['size'] == '1536x1024' and receipt['source_asset_id'] == source['id']
    assert owner.get(f"/chat-assets/{source['id']}/file").content == original


def test_v44_upgrade_imports_only_linked_legacy_studio_history(tmp_path):
    from app.chat import studio_library
    with use_workspace(1, tmp_path/'owner'):
        init_db()
        for run, title, text in [('legacy','图片创作','请生成一张图片：\n\n猫'),
                                 ('chat','图片创作','随便画一张图'),
                                 ('other','其他话题','请生成一张图片：\n\n猫')]:
            cid = create_conversation(title)['id']
            asset, _ = _image(run, cid, studio=False)
            with connect() as conn:
                um = conn.execute("INSERT INTO chat_messages(role,content,conversation_id) VALUES ('user',?,?)", (text,cid)).lastrowid
                am = conn.execute("INSERT INTO chat_messages(role,content,conversation_id) VALUES ('assistant','',?)", (cid,)).lastrowid
                conn.execute('UPDATE chat_image_assets SET message_id=? WHERE id=?', (am, asset['id']))
                conn.execute("INSERT INTO agent_execution_runs(run_id,user_content,conversation_id,user_message_id,assistant_message_id,status) VALUES (?,?,?,?,?,'completed')", (run,text,cid,um,am))
            if run == 'legacy':
                from app.chat.image_editing import edit_generated_image, ImageEditIn
                import asyncio
                edit_id = uuid4()
                asyncio.run(edit_generated_image(asset['id'], ImageEditIn(operation_id=edit_id, mode='resize', width=64, height=32)))
        with connect() as conn:
            conn.execute('DROP TABLE image_studio_tasks')
            conn.execute('DROP TABLE image_studio_works')
            conn.execute('UPDATE schema_migrations SET version=44')
        init_db(resolve_db_path())
        records = {r['id']: r for r in studio_library.history()['items']}
        assert set(records) == {'legacy',str(edit_id)}
        assert records['legacy']['prompt'] == '猫'
        assert records[str(edit_id)]['source_asset_id'] == records['legacy']['assets'][0]['id']
        assert (resolve_db_path().parent / '.upgrade-backups' / f'before-schema-v{DB_SCHEMA_VERSION}' / resolve_db_path().name).is_file()
