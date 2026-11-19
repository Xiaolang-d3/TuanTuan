"""Hosted model URLs are open to public services, never to the server's LAN."""
from __future__ import annotations

import asyncio
import json
import socket

import httpx
import pytest

from app.model_connection import normalize_api_root


@pytest.fixture
def hosted(monkeypatch):
    monkeypatch.setenv("TUANTUAN_DEPLOYMENT_MODE", "hosted")
    monkeypatch.setenv("TUANTUAN_MODEL_ALLOWED_HOSTS", "127.0.0.1,internal.local")


@pytest.mark.parametrize("url", [
    "https://www.packyapi.ai/v1", "https://new-gateway.example.com/tenant/v1",
    "https://8.8.8.8/v1", "https://[2606:4700:4700::1111]/v1",
    "https://gateway.example.com:8443/v1",
])
def test_hosted_accepts_new_public_https_roots_without_allowlist(hosted, url):
    assert normalize_api_root(url) == url


@pytest.mark.parametrize("url", [
    "http://api.openai.com/v1", "https://127.0.0.1/v1", "https://10.1.2.3/v1",
    "https://169.254.169.254/latest", "https://100.100.100.200/v1",
    "https://198.18.0.1/v1", "https://224.0.0.1/v1", "https://192.168.1.1/v1",
    "https://[::1]/v1", "https://[fc00::1]/v1", "https://[fe80::1]/v1",
    "https://[::ffff:127.0.0.1]/v1", "https://[64:ff9b::7f00:1]/v1",
    "https://[2002:7f00:1::]/v1", "https://localhost./v1",
    "https://internal.local/v1", "https://metadata.google.internal/v1",
    "https://singlelabel/v1", "https://[fe80::1%25eth0]/v1",
    "https://api.openai.com\\@127.0.0.1/v1", "https://api.openai.com/\npath",
])
def test_hosted_rejects_unsafe_roots_even_when_allowlisted(hosted, url):
    with pytest.raises(ValueError, match="托管模式|Base URL"):
        normalize_api_root(url)


def test_local_keeps_private_http_models(monkeypatch):
    monkeypatch.setenv("TUANTUAN_DEPLOYMENT_MODE", "local")
    assert normalize_api_root("http://127.0.0.1:11434", "ollama") == "http://127.0.0.1:11434"


class WireStream:
    """Real HTTPcore parsing over deterministic bytes; no remote services."""
    def __init__(self, response=None):
        self.response = response or b'HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}'
        self.writes = []
        self.sni = None

    async def read(self, max_bytes, timeout=None):
        response, self.response = self.response, b""
        return response

    async def write(self, buffer, timeout=None):
        self.writes.append(buffer)

    async def start_tls(self, ssl_context, server_hostname=None, timeout=None):
        assert ssl_context.verify_mode != 0
        self.sni = server_hostname
        return self

    async def aclose(self):
        pass

    def get_extra_info(self, info):
        return None


def setup_network(monkeypatch, ips, response=None):
    import anyio
    from httpcore._backends.anyio import AnyIOBackend

    connections, streams, lookups = [], [], []

    async def resolve(host, port, **kwargs):
        lookups.append(host)
        return [(socket.AF_INET6 if ":" in ip else socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, port)) for ip in ips]

    async def connect(self, host, port, **kwargs):
        connections.append((host, port))
        stream = WireStream(response(host) if callable(response) else response)
        streams.append(stream)
        return stream

    monkeypatch.setattr(anyio, "getaddrinfo", resolve)
    monkeypatch.setattr(AnyIOBackend, "connect_tcp", connect)
    return connections, streams, lookups


def test_connections_pin_public_ip_preserve_sni_host_and_ignore_proxies(hosted, monkeypatch):
    from app.model_network import model_http_client

    monkeypatch.setenv("HTTPS_PROXY", "http://127.0.0.1:9999")
    connections, streams, lookups = setup_network(monkeypatch, ["8.8.8.8"])

    async def exercise():
        async with model_http_client(timeout=3) as client:
            assert (await client.get("https://gateway.example.com/v1/models")).status_code == 200
            assert (await client.get("https://gateway.example.com/v1/models")).status_code == 200

    asyncio.run(exercise())
    assert connections == [("8.8.8.8", 443), ("8.8.8.8", 443)]
    assert lookups == ["gateway.example.com", "gateway.example.com"]
    assert all(stream.sni == "gateway.example.com" for stream in streams)
    assert b"Host: gateway.example.com\r\n" in b"".join(streams[0].writes)


@pytest.mark.parametrize("ips", [["127.0.0.1"], ["8.8.8.8", "10.0.0.1"], ["::ffff:127.0.0.1"], []])
def test_dns_private_or_mixed_answers_never_open_socket(hosted, monkeypatch, ips):
    from app.model_network import ModelAddressError, model_http_client

    connections, _, _ = setup_network(monkeypatch, ips)

    async def exercise():
        async with model_http_client(timeout=3) as client:
            with pytest.raises(ModelAddressError, match="公网|解析"):
                await client.get("https://gateway.example.com/v1/models")

    asyncio.run(exercise())
    assert connections == []


@pytest.fixture
def model_db(tmp_path, monkeypatch):
    from app import db

    monkeypatch.setattr(db, "DB_PATH", tmp_path / "models.db")
    db.init_db()


def wire_response(payload, content_type="application/json", status="200 OK"):
    if not isinstance(payload, bytes):
        payload = json.dumps(payload).encode()
    return (f"HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nConnection: close\r\nContent-Length: {len(payload)}\r\n\r\n".encode() + payload)


@pytest.mark.parametrize("backend", ["native", "litellm"])
@pytest.mark.parametrize("protocol", ["openai", "responses", "anthropic", "gemini", "ollama"])
@pytest.mark.parametrize("streaming", [False, True])
def test_public_generation_and_streaming_keep_working(hosted, monkeypatch, model_db, backend, protocol, streaming, request):
    import fake_llm_server as fake
    from app.domain import AgentMessage, ModelRequest
    from app.models.factory import build_model_provider

    if backend == "litellm" and protocol == "ollama":
        from app.models.litellm_core import get_litellm

        # LiteLLM's cost logging can issue a separate synchronous /api/show
        # request. Mock only that client's transport; keep the async chat path
        # on setup_network so it still exercises guarded DNS, TLS and parsing.
        def metadata(request):
            assert request.method == "POST"
            assert request.url.host == "new-gateway.example.com"
            assert request.url.path.endswith("/api/show")
            return httpx.Response(200, json={"model_info": {}, "template": ""})

        metadata_client = httpx.Client(transport=httpx.MockTransport(metadata), trust_env=False)
        request.addfinalizer(metadata_client.close)
        monkeypatch.setattr(get_litellm().module_level_client, "client", metadata_client)

    prefix = "openai_chat" if protocol == "openai" else protocol
    suffix = "ndjson" if protocol == "ollama" and streaming else "sse" if streaming else "json"
    payload = getattr(fake, f"{prefix}_{suffix}")()
    content_type = "application/x-ndjson" if protocol == "ollama" and streaming else "text/event-stream" if streaming else "application/json"
    connections, _, _ = setup_network(monkeypatch, ["8.8.8.8"], wire_response(payload, content_type))
    provider = build_model_provider(api_key="fixture-key", model="gpt-5" if protocol == "responses" else "test-model", base_url="https://new-gateway.example.com/v1", protocol=protocol, backend=backend)
    model_request = ModelRequest(messages=[AgentMessage(role="user", content="你好")])

    async def exercise():
        if streaming:
            events = [event async for event in provider.stream(model_request)]
            assert any(event.type == "text_delta" and event.delta for event in events)
        else:
            assert (await provider.generate(model_request)).content

    asyncio.run(exercise())
    assert connections and all(pair == ("8.8.8.8", 443) for pair in connections)


@pytest.mark.parametrize("protocol", ["openai", "responses", "anthropic", "gemini", "ollama"])
def test_hosted_router_cannot_replace_guarded_clients(hosted, monkeypatch, model_db, protocol):
    import fake_llm_server as fake
    from app.domain import AgentMessage, ModelRequest
    from app.models.litellm_provider import LiteLLMProvider
    from app.models.litellm_router import RouteTarget, build_router, PRIMARY_GROUP
    from app.models.litellm_core import get_litellm

    # SDK may already have been imported before entering hosted mode.
    monkeypatch.setenv("TUANTUAN_DEPLOYMENT_MODE", "local")
    module = get_litellm()
    policy = getattr(module, "_tuantuan_network_policy", None)
    module.callbacks = [callback for callback in module.callbacks if callback is not policy]
    monkeypatch.setenv("TUANTUAN_DEPLOYMENT_MODE", "hosted")

    payload = getattr(fake, f"{'openai_chat' if protocol == 'openai' else protocol}_json")()
    connections, _, _ = setup_network(monkeypatch, ["8.8.8.8"], wire_response(payload))
    provider = LiteLLMProvider("fixture-key", "test-model", "https://new-gateway.example.com/v1", protocol=protocol)
    target = RouteTarget(identity={"profile_id": "test-profile"}, provider=provider)
    router = build_router(target, {}, {})
    arguments = provider.chat_arguments(ModelRequest(messages=[AgentMessage(role="user", content="你好")]))
    response = asyncio.run(router.acompletion(model=PRIMARY_GROUP, **arguments))
    assert provider.response_from_completion(response).content
    assert connections and all(pair == ("8.8.8.8", 443) for pair in connections)


def test_cross_protocol_fallback_keeps_its_own_guard_and_key(hosted, monkeypatch, model_db):
    import anyio
    from fake_llm_server import anthropic_json
    from app.domain import AgentMessage, ModelRequest
    from app.models.litellm_provider import LiteLLMProvider
    from app.models.litellm_router import RouteTarget, build_router, PRIMARY_GROUP

    connections, streams, _ = setup_network(monkeypatch, [], lambda host: wire_response(
        {"error": {"message": "temporarily unavailable"}}, status="503 Service Unavailable"
    ) if host == "8.8.8.8" else wire_response(anthropic_json()))

    async def resolve(host, port, **kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("8.8.8.8" if host == "primary.example.com" else "1.1.1.1", port))]

    monkeypatch.setattr(anyio, "getaddrinfo", resolve)
    primary = LiteLLMProvider("primary-fixture-key", "test-model", "https://primary.example.com/v1", protocol="openai")
    backup = LiteLLMProvider("backup-fixture-key", "claude-test", "https://backup.example.com", protocol="anthropic")
    router = build_router(RouteTarget(identity={"profile_id": "primary"}, provider=primary),
        {"general": [RouteTarget(identity={"profile_id": "backup"}, provider=backup)]}, {})
    arguments = primary.chat_arguments(ModelRequest(messages=[AgentMessage(role="user", content="你好")]))
    response = asyncio.run(router.acompletion(model=PRIMARY_GROUP, **arguments))
    assert backup.response_from_completion(response).content == "你好"
    assert connections == [("8.8.8.8", 443), ("1.1.1.1", 443)]
    assert b"backup-fixture-key" in b"".join(streams[1].writes)
    assert b"primary-fixture-key" not in b"".join(streams[1].writes)


def test_unreachable_first_public_ip_does_not_hide_working_second_ip(hosted, monkeypatch):
    import anyio
    import httpcore
    from httpcore._backends.anyio import AnyIOBackend
    from app.model_network import model_http_client

    setup_network(monkeypatch, ["2606:4700:4700::1111", "8.8.8.8"])
    attempts = []

    async def connect(self, host, port, timeout=None, **kwargs):
        attempts.append(host)
        if ":" in host:
            await anyio.sleep(timeout)
            raise httpcore.ConnectTimeout()
        return WireStream()

    monkeypatch.setattr(AnyIOBackend, "connect_tcp", connect)

    async def exercise():
        async with model_http_client(timeout=0.1) as client:
            assert (await client.get("https://gateway.example.com/v1/models")).status_code == 200

    asyncio.run(exercise())
    assert attempts == ["2606:4700:4700::1111", "8.8.8.8"]


def test_redirect_is_rejected_even_if_caller_requests_following(hosted, monkeypatch):
    from app.model_network import ModelAddressError, model_http_client

    connections, _, _ = setup_network(monkeypatch, ["8.8.8.8"],
        b"HTTP/1.1 307 Temporary Redirect\r\nLocation: https://127.0.0.1/private\r\nContent-Length: 0\r\n\r\n")

    async def exercise():
        async with model_http_client(timeout=3) as client:
            with pytest.raises(ModelAddressError, match="跳转"):
                await client.get("https://gateway.example.com/v1/models", follow_redirects=True)

    asyncio.run(exercise())
    assert connections == [("8.8.8.8", 443)]


def test_dns_timeout_is_bounded(hosted, monkeypatch):
    import anyio
    from app.model_network import model_http_client

    async def resolve(*args, **kwargs):
        await anyio.sleep(1)

    monkeypatch.setattr(anyio, "getaddrinfo", resolve)

    async def exercise():
        async with model_http_client(timeout=0.01) as client:
            with pytest.raises(httpx.ConnectTimeout):
                await client.get("https://gateway.example.com/v1/models")

    asyncio.run(exercise())


@pytest.mark.parametrize("backend", ["native", "litellm"])
@pytest.mark.parametrize("protocol", ["openai", "responses", "anthropic", "gemini", "ollama", "images"])
def test_every_provider_catalog_uses_guarded_connection(hosted, monkeypatch, backend, protocol):
    from app.models.factory import build_model_provider

    payload = json.dumps({"data": [{"id": "test-model"}], "models": [{"name": "models/test-model", "model": "test-model"}]}).encode()
    response = b"HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nConnection: close\r\nContent-Length: " + str(len(payload)).encode() + b"\r\n\r\n" + payload
    connections, _, _ = setup_network(monkeypatch, ["8.8.8.8"], response)
    provider = build_model_provider(api_key="fixture-key", model="test-model", base_url="https://new-gateway.example.com/v1", protocol=protocol, backend=backend)
    models = asyncio.run(provider.list_models())
    assert ("models/test-model" if protocol == "ollama" else "test-model") in models
    assert connections == [("8.8.8.8", 443)]


@pytest.mark.parametrize("backend", ["native", "litellm"])
@pytest.mark.parametrize("protocol", ["openai", "responses", "anthropic", "gemini", "ollama", "images"])
def test_generation_blocks_private_dns_with_clear_nonretryable_reason(hosted, monkeypatch, backend, protocol, tmp_path):
    from app import db
    from app.domain import AgentMessage, ModelRequest
    from app.models.base import ModelProviderError
    from app.models.factory import build_model_provider

    monkeypatch.setattr(db, "DB_PATH", tmp_path / "models.db")
    db.init_db()
    connections, _, _ = setup_network(monkeypatch, ["10.0.0.1"])
    provider = build_model_provider(api_key="fixture-key", model="test-model", base_url="https://new-gateway.example.com/v1", protocol=protocol, backend=backend)
    request = ModelRequest(messages=[AgentMessage(role="user", content="你好")], image_generation=protocol == "images")

    async def exercise():
        with pytest.raises(ModelProviderError, match="非公网") as error:
            await provider.generate(request)
        assert error.value.code == "unsafe_model_address"
        assert not error.value.retryable

    asyncio.run(exercise())
    assert connections == []


@pytest.mark.parametrize("address", ["8.8.8.8", "10.0.0.1"])
def test_automatic_gpt54_tools_responses_bridge_keeps_public_policy(hosted, monkeypatch, model_db, address):
    from fake_llm_server import responses_json
    from app.domain import AgentMessage, ModelRequest
    from app.models.base import ModelProviderError
    from app.models.litellm_provider import LiteLLMProvider

    connections, streams, _ = setup_network(monkeypatch, [address], wire_response(responses_json()))
    provider = LiteLLMProvider("fixture-key", "gpt-5.4", "https://api.openai.com/v1", protocol="openai")
    from app.domain import ToolDefinition
    request = ModelRequest(messages=[AgentMessage(role="user", content="hello")], reasoning_effort="high",
        tools=[ToolDefinition(name="lookup", description="Lookup", input_schema={"type": "object", "properties": {}})])

    async def exercise():
        if address == "10.0.0.1":
            with pytest.raises(ModelProviderError) as error:
                await provider.generate(request)
            assert error.value.code == "unsafe_model_address"
            assert not error.value.retryable
        else:
            assert (await provider.generate(request)).content

    asyncio.run(exercise())
    if address == "10.0.0.1":
        assert connections == []
    else:
        assert connections == [("8.8.8.8", 443)]
        assert b"POST /v1/responses " in b"".join(streams[0].writes)
