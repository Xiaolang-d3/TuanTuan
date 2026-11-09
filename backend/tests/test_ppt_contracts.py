import pytest
from pydantic import ValidationError

from app.presentations.contracts import PresentationRequest


def test_generate_request_has_explicit_supported_scope():
    request = PresentationRequest(topic="  中文工作汇报  ")
    assert request.topic == "中文工作汇报"
    assert request.options.page_count == 8
    assert request.options.language == "zh-CN"
    assert request.options.canvas == "ppt169"
    assert request.attachment_ids == []


@pytest.mark.parametrize("fields", [
    {"topic": " "}, {"topic": "a" * 8001},
    {"topic": "demo", "grants": ["workspace.execute"]},
    {"topic": "demo", "runtime_path": "C:/runtime"},
    {"topic": "demo", "options": {"page_count": 21}},
    {"topic": "demo", "options": {"page_count": 0}},
    {"topic": "demo", "options": {"page_count": True}},
    {"topic": "demo", "options": {"language": "en"}},
    {"topic": "demo", "options": {"canvas": "a4"}},
    {"topic": "demo", "options": {"image_source": "web"}},
    {"topic": "demo", "attachment_ids": ["../a"]},
    {"topic": "demo", "attachment_ids": ["a" * 32] * 2},
    {"topic": "demo", "conversation_id": 0},
])
def test_unimplemented_or_host_control_options_rejected(fields):
    with pytest.raises(ValidationError):
        PresentationRequest.model_validate(fields)


def test_explicit_user_images_and_page_count_are_preserved():
    request = PresentationRequest(topic="中文", attachment_ids=["b" * 32], options={"page_count": 5, "image_source": "provided"})
    assert request.options.page_count == 5
    assert request.options.image_source == "provided"
