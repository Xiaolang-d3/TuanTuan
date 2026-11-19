import asyncio
import base64
from io import BytesIO
from uuid import uuid4
from unittest.mock import AsyncMock, Mock

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from openai import AsyncOpenAI
from PIL import Image

from app.api.chat import router
from app.chat.image_editing import ImageEditIn, edit_generated_image, selection_mask, Stroke
from app.chat.image_assets import begin_generation, persist_images, asset_file
from app.chat.conversations import create_conversation
from app.db import connect, init_db
from app.domain import ModelResponse
from app.domain.agent import ModelImageOutput
from app.models import ModelProviderError
from app.models.openai_images import OpenAIImagesProvider
from app.workspace import use_workspace


def image_response():
    buffer = BytesIO()
    Image.new('RGBA', (64, 32), 'blue').save(buffer, 'PNG')
    return ModelResponse(images=[ModelImageOutput(item_id='mock', base64_data=base64.b64encode(buffer.getvalue()).decode())])


@pytest.fixture
def workspace(tmp_path):
    with use_workspace(1, tmp_path):
        init_db(tmp_path / 'tuantuan.db')
        cid = create_conversation('图片编辑')['id']
        begin_generation('original', cid, {})
        result = persist_images('original', image_response(), 'test')
        yield tmp_path, result['assets'][0]


def test_mask_only_opens_selected_pixels():
    stroke = Stroke(points=[{'x': .5, 'y': .5}], width=.1)
    mask = Image.open(BytesIO(selection_mask((100, 50), [stroke])))
    assert mask.size == (100, 50)
    assert mask.getpixel((50, 25))[3] == 0
    assert mask.getpixel((0, 0))[3] == 255


def test_resize_endpoint_preserves_source_and_replay_does_not_add_messages(workspace):
    _, source = workspace
    original = asset_file(source['id'])[0].read_bytes()
    app = FastAPI(); app.include_router(router)
    request = {'operation_id': str(uuid4()), 'mode': 'resize', 'width': 80, 'height': 40, 'rotation': 90, 'flip': True}
    with TestClient(app) as client:
        response = client.post(f"/chat-assets/{source['id']}/edits", json=request)
        assert response.status_code == 200, response.text
        result = response.json()
        replay = client.post(f"/chat-assets/{source['id']}/edits", json=request)
        assert replay.status_code == 200
        assert replay.json()['message_id'] == result['message_id']
        mismatch = client.post(f"/chat-assets/{source['id']}/edits", json={**request, 'width': 100})
        assert mismatch.status_code == 409
    with Image.open(asset_file(result['assets'][0]['id'])[0]) as image:
        assert image.size == (80, 40)
    assert asset_file(source['id'])[0].read_bytes() == original
    with connect() as conn:
        assert conn.execute('select count(*) from chat_messages').fetchone()[0] == 2


def test_another_workspace_cannot_edit_source(workspace, tmp_path):
    _, source = workspace
    other = tmp_path / 'other'
    other.mkdir()
    with use_workspace(2, other):
        init_db(other / 'tuantuan.db')
        with pytest.raises(ValueError, match='不存在'):
            asyncio.run(edit_generated_image(source['id'], ImageEditIn(operation_id=uuid4(), mode='resize')))


def test_ai_edit_forwards_mask_comments_and_prevents_repeat_after_timeout(workspace, monkeypatch):
    _, source = workspace
    monkeypatch.setattr('app.chat.image_editing._image_connection', lambda: dict(profile_id='p', profile_revision=1,
        connection_id='c', connection_revision=1, model_name='gpt-image-2', model_protocol='images', api_key='test', model_base_url='https://example.invalid'))
    edit = AsyncMock(return_value=image_response())
    monkeypatch.setattr(OpenAIImagesProvider, 'edit_image', edit)
    request = ImageEditIn(operation_id=uuid4(), mode='erase', strokes=[Stroke(points=[{'x': .5, 'y': .5}], width=.1)], comments=[{'x': .4, 'y': .2, 'text': '补全天空'}])
    result = asyncio.run(edit_generated_image(source['id'], request))
    assert result['assets'][0]['id'] != source['id']
    assert edit.call_args.kwargs['mask']
    assert '补全天空' in edit.call_args.args[1]
    asyncio.run(edit_generated_image(source['id'], request))
    assert edit.await_count == 1
    edit.side_effect = ModelProviderError('timeout', '请求超时')
    failed = request.model_copy(update={'operation_id': uuid4()})
    with pytest.raises(ModelProviderError, match='超时'):
        asyncio.run(edit_generated_image(source['id'], failed))
    with pytest.raises(ModelProviderError, match='不会自动重复'):
        asyncio.run(edit_generated_image(source['id'], failed))
    assert edit.await_count == 2


def test_images_edit_uses_multipart_and_never_retries():
    requests = []
    def handler(request):
        requests.append(request)
        return httpx.Response(500, json={'error': {'message': 'unavailable'}})
    async def run():
        provider = OpenAIImagesProvider(api_key='test', model='gpt-image-2', base_url='https://example.invalid')
        await provider._client.close()
        provider._record_event = Mock()
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            provider._client = AsyncOpenAI(api_key='test', base_url='https://example.invalid/v1', http_client=client)
            with pytest.raises(ModelProviderError):
                await provider.edit_image(b'png-source', 'erase', mask=b'png-mask', transparent=True, size='1536x1024')
    asyncio.run(run())
    assert len(requests) == 1
    assert requests[0].url.path == '/v1/images/edits'
    assert 'multipart/form-data' in requests[0].headers['content-type']
    assert b'png-source' in requests[0].content and b'png-mask' in requests[0].content
    assert b'transparent' in requests[0].content
    assert b'name="size"\r\n\r\n1536x1024' in requests[0].content


@pytest.mark.parametrize('fields', [dict(mode='erase'), dict(mode='edit'), dict(mode='resize',width=8192,height=8192), dict(mode='edit',prompt='ok', comments=[{'x': 2,'y': .5,'text':'invalid'}])])
def test_invalid_edits_are_rejected(fields):
    with pytest.raises(ValueError):
        ImageEditIn(operation_id=uuid4(), **fields)


def test_annotation_is_location_guidance_never_a_painted_image_or_mask(workspace, monkeypatch):
    _, source = workspace
    original = asset_file(source['id'])[0].read_bytes()
    monkeypatch.setattr('app.chat.image_editing._image_connection', lambda: dict(profile_id='p', profile_revision=1,
        connection_id='c', connection_revision=1, model_name='gpt-image-2', model_protocol='images', api_key='test', model_base_url='https://example.invalid'))
    edit = AsyncMock(return_value=image_response())
    monkeypatch.setattr(OpenAIImagesProvider, 'edit_image', edit)
    request = ImageEditIn(operation_id=uuid4(), mode='edit', prompt='改为近脸图', strokes=[Stroke(points=[{'x': .2, 'y': .2}, {'x': .8, 'y': .2}, {'x': .8, 'y': .8}, {'x': .2, 'y': .8}, {'x': .2, 'y': .2}], width=.05)])
    result = asyncio.run(edit_generated_image(source['id'], request))
    assert edit.call_args.kwargs['mask'] is None
    assert '不绘制' in edit.call_args.args[1]
    assert '20.0%' in edit.call_args.args[1] and '80.0%' in edit.call_args.args[1]
    with Image.open(BytesIO(edit.call_args.args[0])) as uploaded, Image.open(BytesIO(original)) as original_image:
        assert uploaded.convert('RGBA').tobytes() == original_image.convert('RGBA').tobytes()
    with connect() as conn:
        label = conn.execute("select content from chat_messages where role='user' order by id desc limit 1").fetchone()[0]
    assert '改为近脸图' in label and '蒙版' not in label
    assert asset_file(source['id'])[0].read_bytes() == original


def test_erasure_mask_has_no_black_ink_even_in_transparent_pixels():
    mask = Image.open(BytesIO(selection_mask((100, 50), [Stroke(points=[{'x': .5, 'y': .5}], width=.1)])))
    assert mask.getpixel((50, 25)) == (255, 255, 255, 0)
