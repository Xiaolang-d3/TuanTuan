import asyncio
from unittest.mock import Mock

import httpx
import pytest
from openai import AsyncOpenAI, BadRequestError

from app.models import ModelProviderError
from app.models.openai_images import OpenAIImagesProvider


def test_transparent_background_rejection_is_actionable_and_not_retried():
    requests = []

    def handler(request):
        requests.append(request)
        return httpx.Response(400, json={"error": {"message": "Transparent background is not supported for this model."}})

    async def run():
        provider = OpenAIImagesProvider(api_key="test", model="custom-image-model", base_url="https://example.invalid")
        await provider._client.close()
        provider._record_event = Mock()
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            provider._client = AsyncOpenAI(api_key="test", base_url="https://example.invalid/v1", http_client=client)
            with pytest.raises(ModelProviderError) as failure:
                await provider.edit_image(b"png-source", "remove background", transparent=True)
            assert failure.value.code == "transparent_background_unsupported"
            assert not failure.value.retryable
            assert "切换" in str(failure.value) and "透明背景" in str(failure.value)
    asyncio.run(run())
    assert len(requests) == 1
    assert b'transparent' in requests[0].content


def test_other_bad_requests_keep_their_original_diagnosis():
    request = httpx.Request("POST", "https://example.invalid/v1/images/edits")
    response = httpx.Response(400, request=request)
    error = BadRequestError("image too large", response=response, body={"message": "image too large"})
    provider = OpenAIImagesProvider(api_key="test", model="custom-image-model", base_url="https://example.invalid")
    try:
        mapped = provider._provider_error(error)
        assert mapped.code != "transparent_background_unsupported"
    finally:
        asyncio.run(provider._client.close())