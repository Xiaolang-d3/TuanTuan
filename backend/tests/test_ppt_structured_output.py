"""Structured output reaches the native wire adapters without a model call."""
import pytest

from app.domain import AgentMessage, ModelRequest


@pytest.mark.parametrize("protocol", ["openai_compatible", "openai_responses"])
@pytest.mark.parametrize("format", [
    {"type": "json_object"},
    {"type": "json_schema", "json_schema": {"name": "result", "strict": True, "schema": {"type": "object", "properties": {}, "additionalProperties": False}}},
    None,
])
def test_native_adapter_keeps_explicit_structured_output(monkeypatch, protocol, format):
    import importlib
    module = importlib.import_module(f"app.models.{protocol}")
    monkeypatch.setattr(module, "get_agent_settings", lambda: {})
    monkeypatch.setattr(module, "persona_prompt", lambda _: "")
    cls = module.OpenAICompatibleProvider if protocol == "openai_compatible" else module.OpenAIResponsesProvider
    provider = cls(api_key="test-only", model="test-model", base_url="https://offline.example.test/v1")
    request = ModelRequest(messages=[AgentMessage(role="user", content="JSON")], response_format=format)
    arguments = provider._request_arguments(request)
    if format is None:
        assert "response_format" not in arguments and "text" not in arguments
    elif protocol == "openai_compatible":
        assert arguments["response_format"] == format
    elif format["type"] == "json_object":
        assert arguments["text"]["format"] == {"type": "json_object"}
    else:
        assert arguments["text"]["format"] == {"type": "json_schema", **format["json_schema"]}


@pytest.mark.parametrize("allow_fallback", [False, True])
def test_strict_format_is_not_removed_by_an_earlier_optional_capability_cache(monkeypatch, allow_fallback):
    import app.models.litellm_provider as module
    provider = module.LiteLLMProvider(api_key="test-only", model="test-model", base_url="https://offline.example.test/v1")
    monkeypatch.setattr(provider, "chat_messages", lambda *args, **kwargs: [])
    monkeypatch.setitem(module._UNSUPPORTED_CHAT_OPTIONS, ("openai", provider._base_url, "test-model"), {"response_format"})
    format = {"type": "json_object"}
    request = ModelRequest(messages=[], response_format=format, allow_option_fallback=allow_fallback)
    arguments = provider.chat_arguments(request)
    assert arguments.get("response_format") == (None if allow_fallback else format)
