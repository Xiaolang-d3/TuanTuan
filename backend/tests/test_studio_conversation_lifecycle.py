import pytest
from fastapi import HTTPException

from app.api import conversations
from app.chat import studio_generate


def test_running_studio_conversation_cannot_be_deleted(monkeypatch):
    monkeypatch.setattr(conversations, "require_conversation", lambda cid: None)
    monkeypatch.setattr(conversations, "is_chat_running", lambda cid: False)
    monkeypatch.setattr(studio_generate, "is_conversation_running", lambda cid: cid == 17)
    monkeypatch.setattr(conversations, "delete_conversation_attachments", lambda cid: pytest.fail("must not remove assets during generation"))
    with pytest.raises(HTTPException) as exc:
        conversations.conversations_delete(17)
    assert exc.value.status_code == 409
