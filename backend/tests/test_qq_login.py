from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from threading import Barrier, Event, Lock
import os
from urllib.parse import parse_qs, urlsplit

import httpx
import pytest
from fastapi.testclient import TestClient

from app import db
from app.config import get_settings
from app.main import app


ORIGIN = "https://tuantuan.example.test"
CALLBACK = f"{ORIGIN}/api/auth/qq/callback"
EMAIL = "owner@example.test"
LOCAL_CREDENTIAL = "local-demo-passphrase-274"


@pytest.fixture(autouse=True)
def configure(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "test.db")
    monkeypatch.setenv("QQ_APP_ID", "12345")
    monkeypatch.setenv("QQ_APP_KEY", "qq-test-app-key")
    monkeypatch.setenv("QQ_REDIRECT_URI", CALLBACK)
    monkeypatch.delenv("TUANTUAN_QQ_ENV_FILE", raising=False)
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


@pytest.fixture
def client():
    with TestClient(app, base_url=ORIGIN, follow_redirects=False) as browser:
        yield browser


@pytest.fixture
def qq(monkeypatch):
    from app import qq_auth

    calls = []

    def respond(request):
        calls.append(request)
        if request.url.path == "/oauth2.0/token":
            assert request.url.params["redirect_uri"] == CALLBACK
            assert request.url.params["client_secret"] == "qq-test-app-key"
            return httpx.Response(200, text="access_token=test-qq-access&expires_in=7200")
        assert request.url.path == "/oauth2.0/me"
        assert request.url.params["access_token"] == "test-qq-access"
        return httpx.Response(200, text='callback( {"client_id":"12345","openid":"test-open-id"} );')

    monkeypatch.setattr(qq_auth, "_qq_transport", httpx.MockTransport(respond))
    return calls


def begin(client, headers=None):
    path = "/auth/qq/bind/start" if headers else "/auth/qq/start"
    response = client.post(path, headers={"Origin": ORIGIN, **(headers or {})})
    response.raise_for_status()
    url = urlsplit(response.json()["authorization_url"])
    params = parse_qs(url.query)
    assert url.netloc == "graph.qq.com"
    assert params["redirect_uri"] == [CALLBACK]
    assert "client_secret" not in params
    assert "HttpOnly" in response.headers["set-cookie"]
    assert "Secure" in response.headers["set-cookie"]
    return params["state"][0]


def authorise(client, state):
    return client.get(CALLBACK, params={"state": state, "code": "provider-code"})


def finish(client, headers=None, *, action=None, confirmation=None):
    payload = {"action": action, "confirmation": confirmation} if action else None
    return client.post("/auth/qq/finish", headers={"Origin": ORIGIN, **(headers or {})}, json=payload)


def register(client, email=EMAIL):
    response = client.post("/auth/register", json={"email": email, "password": LOCAL_CREDENTIAL})
    response.raise_for_status()
    return response.json()


def bearer(payload):
    return {"Authorization": f"Bearer {payload['access_token']}"}


def test_register_and_return_to_the_same_qq_account(client, qq):
    assert client.get("/auth/config").json()["qq_enabled"] is True
    redirect = authorise(client, begin(client))
    assert redirect.headers["location"] == f"{ORIGIN}/?qq_auth=login"
    assert redirect.headers["cache-control"] == "no-store"
    assert "provider-code" not in redirect.headers["location"]
    choice = finish(client).json()
    assert set(choice) == {"confirmation"}
    assert client.get("/auth/config").json()["setup_required"] is True
    assert finish(client).json() == choice
    first = finish(client, action="create", **choice).json()
    assert first["user"]["qq_only"] is True
    assert first["user"]["qq_bound"] is True
    assert client.get("/auth/me", headers=bearer(first)).json()["user"] == first["user"]
    assert finish(client).status_code == 400
    assert client.post("/auth/logout", headers=bearer(first)).status_code == 204

    authorise(client, begin(client))
    second = finish(client).json()
    assert first["user"]["id"] == second["user"]["id"]
    assert first["access_token"] != second["access_token"]


def test_binding_preserves_account_and_both_login_methods(client, qq):
    old_account = register(client)
    headers = bearer(old_account)
    redirect = authorise(client, begin(client, headers))
    assert redirect.headers["location"] == f"{ORIGIN}/?qq_auth=bind#/settings/account"
    bound = finish(client, headers).json()
    assert "access_token" not in bound
    assert bound["user"]["id"] == old_account["user"]["id"]
    assert bound["user"]["qq_bound"] is True
    assert bound["user"]["email"] == EMAIL

    authorise(client, begin(client))
    assert finish(client).json()["user"] == bound["user"]
    assert client.post("/auth/login", json={"email": EMAIL, "password": LOCAL_CREDENTIAL}).json()["user"] == bound["user"]


def test_first_qq_authorization_can_bind_after_email_login(client, qq):
    account = register(client)["user"]
    authorise(client, begin(client))
    choice = finish(client).json()
    assert finish(client, action="bind", **choice).status_code == 401
    login = client.post("/auth/login", json={"email": EMAIL, "password": LOCAL_CREDENTIAL}).json()
    bound = finish(client, bearer(login), action="bind", **choice).json()["user"]
    assert bound["id"] == account["id"]
    assert bound["email"] == EMAIL
    assert bound["qq_bound"] is True
    assert not bound.get("qq_only")
    assert finish(client, bearer(login), action="bind", **choice).status_code == 400

    authorise(client, begin(client))
    assert finish(client).json()["user"] == bound


def test_replacing_a_qq_authorization_invalidates_the_old_confirmation(client, qq):
    authorise(client, begin(client))
    old_choice = finish(client).json()
    authorise(client, begin(client))
    new_choice = finish(client).json()

    assert finish(client, action="create", **old_choice).status_code == 400
    assert client.get("/auth/config").json()["setup_required"] is True
    assert finish(client, action="create", **new_choice).json()["user"]["qq_bound"] is True


def test_browser_origin_state_and_callback_lifetime_are_checked(client, qq):
    assert client.post("/auth/qq/start", headers={"Origin": "https://other.example.test"}).status_code == 403
    state = begin(client)
    with TestClient(app, base_url=ORIGIN, follow_redirects=False) as other:
        assert authorise(other, state).headers["location"].endswith("?qq_auth=failed")
    assert authorise(client, "other-state").headers["location"].endswith("?qq_auth=failed")
    assert not qq
    assert authorise(client, state).headers["location"].endswith("?qq_auth=login")
    assert authorise(client, state).headers["location"].endswith("?qq_auth=failed")
    assert len(qq) == 2
    assert client.post("/auth/qq/finish", headers={"Origin": "https://other.example.test"}).status_code == 403
    assert finish(client).status_code == 200


def test_binding_requires_the_original_authenticated_session(client, qq):
    first = bearer(register(client))
    second = bearer(register(client, "second@example.test"))
    authorise(client, begin(client, first))
    assert finish(client, second).status_code == 400
    client.post("/auth/logout", headers=first).raise_for_status()
    assert finish(client, first).status_code == 401
    assert client.get("/auth/me", headers=second).json()["user"]["qq_bound"] is False


def test_existing_qq_identity_is_not_moved_to_another_account(client, qq):
    authorise(client, begin(client))
    choice = finish(client).json()
    original = finish(client, action="create", **choice).json()["user"]
    other = bearer(register(client))
    authorise(client, begin(client, other))
    assert finish(client, other).status_code == 409
    assert client.get("/auth/me", headers=other).json()["user"]["qq_bound"] is False
    authorise(client, begin(client))
    assert finish(client).json()["user"] == original


def test_denied_or_expired_authorisation_does_not_create_an_account(client, qq, monkeypatch):
    from app import qq_auth

    denied = client.get(CALLBACK, params={"state": begin(client), "error": "access_denied"})
    assert denied.headers["location"].endswith("?qq_auth=cancelled")
    assert finish(client).status_code == 400
    state = begin(client)
    after_expiry = qq_auth._now() + 601
    monkeypatch.setattr(qq_auth, "_now", lambda: after_expiry)
    assert authorise(client, state).headers["location"].endswith("?qq_auth=failed")
    assert not qq
    assert client.get("/auth/config").json()["setup_required"] is True


def test_unconfigured_qq_does_not_affect_email_login(client, monkeypatch):
    monkeypatch.delenv("QQ_APP_KEY")
    get_settings.cache_clear()
    assert not client.get("/auth/config").json().get("qq_enabled")
    assert client.post("/auth/qq/start", headers={"Origin": ORIGIN}).status_code == 404
    assert register(client)["user"]["email"] == EMAIL


def test_concurrent_first_logins_initialize_the_shared_workspace_serially(client, monkeypatch):
    from app import qq_auth

    settings = get_settings()
    browsers = ["a" * 43, "b" * 43]
    tickets = [qq_auth.new_result(settings, browser, None, "same-subject") for browser in browsers]
    start = Barrier(2)
    initializer_lock = Lock()
    overlap = Event()
    initialize = qq_auth.ensure_workspace

    def isolated_initializer(user_id):
        if not initializer_lock.acquire(blocking=False):
            overlap.set()
            raise ValueError("concurrent workspace initialization")
        try:
            overlap.wait(timeout=0.25)
            return initialize(user_id)
        finally:
            initializer_lock.release()

    def login(index):
        start.wait(timeout=5)
        return qq_auth.finish_flow(
            settings, browsers[index], tickets[index], None,
            action="create", confirmation=qq_auth._token_hash(tickets[index]),
        )

    monkeypatch.setattr(qq_auth, "ensure_workspace", isolated_initializer)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(login, range(2)))
    assert not overlap.is_set()
    assert results[0]["user"]["id"] == results[1]["user"]["id"]
    assert results[0]["access_token"] != results[1]["access_token"]


@pytest.mark.parametrize("stage,body,status", [
    ("token", '{"error":100,"error_description":"rejected"}', 200),
    ("token", "not-a-token-response", 200),
    ("token", "provider unavailable", 503),
    ("identity", 'callback({"client_id":"other-app","openid":"same-subject"});', 200),
    ("identity", 'callback({"client_id":"12345","openid":null});', 200),
    ("identity", "callback(broken-json);", 200),
])
def test_provider_errors_do_not_create_accounts(client, monkeypatch, stage, body, status):
    from app import qq_auth

    def respond(request):
        if request.url.path.endswith("/token") and stage != "token":
            return httpx.Response(200, text="access_token=provider-fixture")
        return httpx.Response(status, text=body)

    monkeypatch.setattr(qq_auth, "_qq_transport", httpx.MockTransport(respond))
    assert authorise(client, begin(client)).headers["location"].endswith("?qq_auth=failed")
    assert finish(client).status_code == 400
    assert client.get("/auth/config").json()["setup_required"] is True


def test_expired_result_cannot_create_an_account(client, qq, monkeypatch):
    from app import qq_auth

    authorise(client, begin(client))
    choice = finish(client).json()
    after_expiry = qq_auth._now() + 121
    monkeypatch.setattr(qq_auth, "_now", lambda: after_expiry)
    assert finish(client, action="create", **choice).status_code == 400
    assert client.get("/auth/config").json()["setup_required"] is True


def test_provider_timeout_can_be_restarted_without_creating_an_account(client, monkeypatch):
    from app import qq_auth

    def timeout(request):
        raise httpx.ReadTimeout("provider timeout", request=request)

    monkeypatch.setattr(qq_auth, "_qq_transport", httpx.MockTransport(timeout))
    assert authorise(client, begin(client)).headers["location"].endswith("?qq_auth=failed")
    assert finish(client).status_code == 400
    assert client.get("/auth/config").json()["setup_required"] is True
    assert begin(client)


def test_service_file_reads_only_qq_configuration_without_expansion(tmp_path, monkeypatch):
    path = tmp_path / "service.env"
    path.write_text(
        f"QQ_APP_ID=12345\nQQ_APP_KEY=${{OTHER_SECRET}}\nQQ_REDIRECT_URI={CALLBACK}\n"
        "OPENAI_API_KEY=unrelated-model-fixture\n",
        encoding="utf-8-sig",
    )
    for name in ("QQ_APP_ID", "QQ_APP_KEY", "QQ_REDIRECT_URI", "OPENAI_API_KEY"):
        monkeypatch.delenv(name, raising=False)
    monkeypatch.setenv("OTHER_SECRET", "private-fixture-value")
    monkeypatch.setenv("TUANTUAN_QQ_ENV_FILE", str(path))
    settings = get_settings()
    assert settings.qq_origin == ORIGIN
    assert settings.qq_app_key == "${OTHER_SECRET}"
    assert settings.openai_api_key is None
    assert "QQ_APP_KEY" not in os.environ
    assert "qq_app_key" not in settings.model_dump()
    assert "${OTHER_SECRET}" not in repr(settings)
    monkeypatch.setenv("QQ_APP_KEY", "environment-fixture")
    get_settings.cache_clear()
    assert get_settings().qq_app_key == "environment-fixture"
    monkeypatch.setenv("QQ_APP_KEY", "")
    get_settings.cache_clear()
    assert get_settings().qq_origin is None


@pytest.mark.parametrize("uri", [
    "http://tuantuan.example.test/api/auth/qq/callback",
    f"{ORIGIN}/auth/qq/callback",
    f"{CALLBACK}?redirect=elsewhere",
    f"{CALLBACK}#fragment",
    "https://name:credential@tuantuan.example.test/api/auth/qq/callback",
    "https://tuantuan.example.test:invalid/api/auth/qq/callback",
])
def test_invalid_callback_disables_qq(uri, monkeypatch):
    monkeypatch.setenv("QQ_REDIRECT_URI", uri)
    assert get_settings().qq_origin is None


def test_qq_urls_are_redacted_from_logs():
    from app.redaction import redact_secrets

    callback = redact_secrets(f"GET {CALLBACK}?code=private-code&state=private-state HTTP/1.1")
    provider = redact_secrets("GET https://graph.qq.com/oauth2.0/token?client_secret=private-key&code=private-code")
    assert "private-code" not in callback + provider
    assert "private-state" not in callback
    assert "private-key" not in provider
