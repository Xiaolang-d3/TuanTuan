"""Confirmation credentials cannot authenticate general APIs or another account."""
import pytest
from fastapi.testclient import TestClient

from app import db
from app.api import presentations as api
from app.extensions.contracts import ExtensionContext
from app.jobs.service import JobService
from app.main import app
from app.presentations.confirmation_sessions import ConfirmationSessions
from app.presentations.service import PresentationService
from app.workspace import ensure_workspace, use_workspace
from api_client import register_authenticated_client


@pytest.fixture
def surface(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "default.db")
    db.init_db()
    jobs = JobService({"ppt.generate": object()})
    store = ConfirmationSessions(jobs.repository)
    monkeypatch.setattr(api, "presentation_service", PresentationService(jobs))
    monkeypatch.setattr(api, "confirmation_sessions", store)
    from app.presentations.confirmation_server import ConfirmationServerManager
    monkeypatch.setattr(api, "confirmation_servers", ConfirmationServerManager())
    origin = "http://localhost:5173"
    monkeypatch.setattr(api, "get_settings", lambda: type("Settings", (), {"allowed_origins": [origin]})())
    with register_authenticated_client(app, "ppt-owner@example.com") as owner, register_authenticated_client(app, "ppt-other@example.com") as other:
        user_id = owner.get("/auth/me").json()["user"]["id"]
        with use_workspace(user_id, ensure_workspace(user_id)):
            context = ExtensionContext.current()
            job = jobs.repository.enqueue("ppt.generate", {}, {}, context, "ppt-api")
            claimed = jobs.repository.claim(context)
            jobs.repository.checkpoint(job["id"], claimed["owner_token"], {
                "stage": "stage1_recommended", "manifest_sha256": "a" * 64, "source_version": 1,
            }, context)
            waiting = jobs.repository.wait_for_user(job["id"], claimed["owner_token"], "确认需求", {}, context)
        yield owner, other, store, waiting, origin


def bootstrap(surface):
    owner, _, _, job, origin = surface
    response = owner.post(f"/presentations/{job['id']}/confirmation-session", headers={"Origin": origin})
    assert response.status_code == 200, response.text
    # No bearer is sent by the confirmation page; the one-use ticket is body-only.
    browser = TestClient(app)
    response = browser.post(f"/presentations/{job['id']}/confirmation-bootstrap", json={"ticket": response.json()["ticket"], "surface_origin": origin}, headers={"Origin": origin})
    assert response.status_code == 200, response.text
    return browser, response


def test_capabilities_is_authenticated_uncached_and_not_a_job_id(surface, monkeypatch):
    owner, _, _, _, _ = surface
    status = {"available": True, "code": "ready", "reason": "制作已就绪"}
    monkeypatch.setattr(api.presentation_service, "capabilities", lambda context: status)
    assert TestClient(app).get("/presentations/capabilities").status_code == 401
    response = owner.get("/presentations/capabilities")
    assert response.status_code == 200 and response.json() == status
    assert response.headers["cache-control"] == "no-store"


def test_retry_endpoint_reuses_original_job_and_remains_account_scoped(surface, monkeypatch):
    from test_presentation_service import service
    from test_ppt_retry import failed
    owner, other, _, _, _ = surface
    user_id = owner.get("/auth/me").json()["user"]["id"]
    worker = service()
    monkeypatch.setattr(api, "presentation_service", worker)
    with use_workspace(user_id, ensure_workspace(user_id)):
        original = failed(worker, ExtensionContext.current())
    path = f"/presentations/{original['id']}/retry"
    body = {"expected_revision": original["revision"], "request_id": "api-retry"}
    assert other.post(path, json=body).status_code == 404
    assert owner.post(path, json={}).status_code == 422
    first = owner.post(path, json=body)
    assert first.status_code == 200, first.text
    assert first.json()["id"] == original["id"]
    assert owner.post(path, json=body).json()["id"] == original["id"]
    assert "secret_ref" not in first.text and "credential_fingerprint" not in first.text
    with use_workspace(user_id, ensure_workspace(user_id)):
        assert len(worker.jobs.repository.list(ExtensionContext.current())) == 2


def test_chat_listing_is_scoped_authenticated_and_has_safe_fields(surface):
    owner, other, _, _, _ = surface
    conversation = owner.post("/conversations", json={"title": "PPT 会话"}).json()
    other_conversation = other.post("/conversations", json={"title": "另一个账户"}).json()
    owner_id = owner.get("/auth/me").json()["user"]["id"]
    with use_workspace(owner_id, ensure_workspace(owner_id)):
        context = ExtensionContext.current()
        job = api.presentation_service.jobs.repository.enqueue("ppt.generate", {"topic": "季度复盘", "conversation_id": conversation["id"], "options": {"page_count": 6}}, {"model_selection": {"model_name": "测试模型", "secret_ref": "private"}}, context, "chat-list")
    url = f"/presentations?conversation_id={conversation['id']}"
    assert TestClient(app).get(url).status_code == 401
    response = owner.get(url)
    assert response.status_code == 200 and response.headers["cache-control"] == "no-store"
    assert response.json()["jobs"][0]["id"] == job["id"]
    assert response.json()["jobs"][0]["page_count"] == 6
    assert "private" not in response.text and "snapshot" not in response.text
    assert other.get(f"/presentations?conversation_id={other_conversation['id']}").json()["jobs"] == []
    assert owner.get("/presentations?conversation_id=999999").status_code == 404
    assert owner.get("/presentations").status_code == 422


def test_chat_readiness_resolves_the_explicit_conversation(surface, monkeypatch):
    owner, _, _, _, _ = surface
    seen = []
    monkeypatch.setattr(api.presentation_service, "capabilities", lambda context, *, conversation_id: seen.append(conversation_id) or {"available": True})
    response = owner.get("/presentations/capabilities?conversation_id=7")
    assert response.status_code == 200 and seen == [7]


def test_extension_catalog_uses_presentation_readiness(surface, monkeypatch):
    from app.api import extensions
    owner, _, _, _, _ = surface
    monkeypatch.setattr(extensions, "presentation_service", api.presentation_service)
    monkeypatch.setattr(api.presentation_service, "capabilities", lambda context: {"available": True, "code": "ready", "reason": "制作已就绪"})
    response = owner.get("/extensions")
    assert response.status_code == 200
    assert response.json()["execution"]["available"] is True


def test_confirmation_bootstrap_and_cookie_without_bearer(surface):
    _, _, _, job, origin = surface
    browser, response = bootstrap(surface)
    cookie = response.headers["set-cookie"]
    assert "HttpOnly" in cookie and "SameSite=strict" in cookie
    assert f"Path=/presentations/{job['id']}/confirmation" in cookie
    assert response.headers["cache-control"] == "no-store"
    session = browser.get(f"/presentations/{job['id']}/confirmation/session")
    assert session.status_code == 200, session.text
    assert session.json() == {"job_id": job["id"], "status": "authorized"}
    assert session.headers["cache-control"] == "no-store"
    assert browser.get(f"/presentations/{job['id']}/confirmation/session", headers={"Origin": "http://attacker.test"}).status_code == 403


def test_ticket_single_use_and_origin_validation(surface):
    owner, _, _, job, origin = surface
    path = f"/presentations/{job['id']}/confirmation-bootstrap"
    ticket = owner.post(f"/presentations/{job['id']}/confirmation-session", headers={"Origin": origin}).json()["ticket"]
    browser = TestClient(app, base_url="http://localhost:8000")
    assert browser.post(path, json={"ticket": ticket}, headers={"Origin": "http://attacker.test"}).status_code == 403
    assert browser.post(path, json={"ticket": ticket}, headers={"Origin": origin}).status_code == 200
    assert browser.post(path, json={"ticket": ticket}, headers={"Origin": origin}).status_code == 403
    assert browser.post(path, json={"ticket": "invalid"}, headers={"Origin": origin}).status_code == 403
    assert browser.get(path, params={"ticket": ticket}).status_code == 401


def test_cookie_cannot_authenticate_general_api_or_other_job(surface):
    _, other, _, job, origin = surface
    browser, _ = bootstrap(surface)
    credential = browser.cookies.get("tuantuan_ppt_confirmation")
    # Explicit Cookie header exercises the server boundary, not browser Path filtering.
    headers = {"Cookie": f"tuantuan_ppt_confirmation={credential}"}
    for path in ["/auth/me", "/jobs", f"/presentations/{job['id']}", f"/presentations/{'b' * 32}/confirmation/session"]:
        assert browser.get(path, headers=headers).status_code in {401, 403}
    assert other.get(f"/presentations/{job['id']}").status_code == 404
    assert other.post(f"/presentations/{job['id']}/confirmation-session", headers={"Origin": origin}).status_code == 404


def test_cancel_revokes_confirmation_credentials(surface):
    owner, _, store, job, _ = surface
    browser, _ = bootstrap(surface)
    assert store.cookies
    response = owner.post(f"/presentations/{job['id']}/cancel")
    assert response.status_code == 200, response.text
    assert not store.cookies and not store.tickets
    assert browser.get(f"/presentations/{job['id']}/confirmation/session").status_code == 403


def test_parent_logout_revokes_cookie_access(surface):
    owner, _, _, job, _ = surface
    browser, _ = bootstrap(surface)
    response = owner.post("/auth/logout")
    assert response.status_code == 204, response.text
    assert browser.get(f"/presentations/{job['id']}/confirmation/session").status_code == 403


def test_main_bearer_cannot_bypass_cookie_csrf_or_origin(surface):
    owner, _, _, job, origin = surface
    path = f"/presentations/{job['id']}/confirmation/api/confirm"
    assert owner.post(path, json={"stage": "stage1", "template_selection": {"mode": "free_design", "selection_keys": []}}, headers={"Origin": origin}).status_code == 403
    browser, response = bootstrap(surface)
    assert browser.post(path, json={"stage": "stage1", "template_selection": {"mode": "free_design", "selection_keys": []}}, headers={"Origin": origin}).status_code == 403
    assert browser.post(path, json={"stage": "stage1", "template_selection": {"mode": "free_design", "selection_keys": []}}, headers={"X-PPT-CSRF": response.json()["csrf"]}).status_code == 403


def test_proxy_scopes_transport_and_sanitizes_health(surface, monkeypatch):
    from types import SimpleNamespace
    from pathlib import Path
    from app.presentations.confirmation_server import ConfirmationResponse
    owner, _, _, job, origin = surface
    browser, _ = bootstrap(surface)
    calls = []

    class Flow:
        def __init__(self, repository):
            pass

        def load(self, scope, context):
            assert scope.user_id == context.user_id
            return ({"snapshot": {}}, Path("host-owned-project"), {"stage": "stage1_recommended"})

    class Servers:
        async def request(self, *args, **kwargs):
            calls.append((args, kwargs))
            return ConfirmationResponse(200, "application/json", b'{"status":"ok","project":"C:/private","pid":42,"server_port":5000}')

        async def close_job(self, *args):
            pass

        async def close_all(self):
            pass

        async def close_invalid(self, validate):
            return 0

    monkeypatch.setattr(api, "ConfirmationFlow", Flow)
    monkeypatch.setattr(api, "confirmation_servers", Servers())
    monkeypatch.setattr(api.ExtensionRunSnapshot, "model_validate", lambda value: SimpleNamespace(execution={"runtime_digest": "a" * 64}))
    monkeypatch.setattr(api, "resolve_snapshot", lambda snapshot, context: snapshot)
    monkeypatch.setattr(api.BuiltinRuntime, "load", lambda: SimpleNamespace(digest="a" * 64))
    response = browser.get(f"/presentations/{job['id']}/confirmation/api/health")
    assert response.status_code == 200, response.text
    assert response.json() == {"status": "ok", "service": "confirm_ui"}
    assert "private" not in response.text and "5000" not in response.text
    assert calls[0][0][1] == job["id"] and calls[0][0][4:7] == ("stage1", "GET", "/api/health")
    assert calls[0][1]["expires_at"] > 0
    assert response.headers["cache-control"] == "no-store"
    assert "script-src 'self'" in response.headers["content-security-policy"]
    # Query-bearing requests never reach the local service.
    assert browser.get(f"/presentations/{job['id']}/confirmation/api/health?path=secret").status_code == 422
    assert len(calls) == 1


def test_proxy_post_stops_writer_before_accept_and_never_retries(surface, monkeypatch):
    from types import SimpleNamespace
    from pathlib import Path
    from app.presentations.confirmation_server import ConfirmationResponse
    _, _, store, job, origin = surface
    browser, bootstrap_response = bootstrap(surface)
    order = []

    class Flow:
        def __init__(self, repository):
            pass

        def load(self, scope, context):
            return ({"snapshot": {}}, Path("host-owned-project"), {"stage": "stage1_recommended"})

        def reserve_submission(self, scope, context):
            order.append("reserve")

        def accept(self, scope, context):
            order.append("accept")

    class Servers:
        async def request(self, *args, **kwargs):
            kwargs["before_submit"]()
            order.append("post")
            return ConfirmationResponse(200, "application/json", b'{"status":"ok"}')

        async def close_job(self, *args):
            order.append("stop")

        async def close_all(self):
            pass

        async def close_invalid(self, validate):
            return 0

    monkeypatch.setattr(api, "ConfirmationFlow", Flow)
    monkeypatch.setattr(api, "confirmation_servers", Servers())
    monkeypatch.setattr(api.ExtensionRunSnapshot, "model_validate", lambda value: SimpleNamespace(execution={"runtime_digest": "a" * 64}))
    monkeypatch.setattr(api, "resolve_snapshot", lambda snapshot, context: snapshot)
    monkeypatch.setattr(api.BuiltinRuntime, "load", lambda: SimpleNamespace(digest="a" * 64))
    path = f"/presentations/{job['id']}/confirmation/api/confirm"
    headers = {"Origin": origin, "X-PPT-CSRF": bootstrap_response.json()["csrf"]}
    unsupported = browser.post(path, json={"stage": "stage1", "template_selection": {"mode": "templates"}}, headers=headers)
    assert unsupported.status_code == 422 and "自由设计" in unsupported.json()["error"]
    assert order == []  # No reservation, process stop or irreversible receipt.
    assert browser.get(f"/presentations/{job['id']}/confirmation/session").status_code == 200
    response = browser.post(path, json={"stage": "stage1", "template_selection": {"mode": "free_design", "selection_keys": []}}, headers=headers)
    assert response.status_code == 200, response.text
    assert order == ["reserve", "post", "stop", "accept"]
    assert not store.cookies
    assert browser.post(path, json={"stage": "stage1", "template_selection": {"mode": "free_design", "selection_keys": []}}, headers=headers).status_code == 403
    assert order.count("post") == 1


@pytest.mark.parametrize("failure", ["startup", "duplicate", "unknown"])
def test_proxy_only_stops_its_own_reserved_submission(surface, monkeypatch, failure):
    from pathlib import Path
    from types import SimpleNamespace
    from app.jobs.repository import JobConflict
    from app.presentations.confirmation_server import ConfirmationResponse, ConfirmationServerError
    _, _, _, job, origin = surface
    browser, credential = bootstrap(surface)
    state = {"reserved": failure == "duplicate", "sent": 0, "stopped": 0, "accepted": 0}

    class Flow:
        def __init__(self, repository):
            pass

        def load(self, scope, context):
            return {"snapshot": {}}, Path("host-owned-project"), {"stage": "stage1_recommended"}

        def reserve_submission(self, scope, context):
            if state["reserved"]:
                raise JobConflict("already reserved")
            state["reserved"] = True

        def accept(self, scope, context):
            state["accepted"] += 1

    class Servers:
        async def request(self, *args, **kwargs):
            if failure == "startup":
                raise ConfirmationServerError("capacity")
            kwargs["before_submit"]()
            state["sent"] += 1
            raise ConfirmationServerError("outcome unknown")

        async def close_job(self, *args):
            state["stopped"] += 1

        async def close_all(self):
            pass

        async def close_invalid(self, validate):
            return 0

    monkeypatch.setattr(api, "ConfirmationFlow", Flow)
    monkeypatch.setattr(api, "confirmation_servers", Servers())
    monkeypatch.setattr(api.ExtensionRunSnapshot, "model_validate", lambda value: SimpleNamespace(execution={"runtime_digest": "a" * 64}))
    monkeypatch.setattr(api, "resolve_snapshot", lambda snapshot, context: snapshot)
    monkeypatch.setattr(api.BuiltinRuntime, "load", lambda: SimpleNamespace(digest="a" * 64))
    response = browser.post(f"/presentations/{job['id']}/confirmation/api/confirm", json={"stage": "stage1", "template_selection": {"mode": "free_design", "selection_keys": []}},
                            headers={"Origin": origin, "X-PPT-CSRF": credential.json()["csrf"]})
    assert response.status_code == 409, response.text
    assert state["sent"] == (1 if failure == "unknown" else 0)
    assert state["stopped"] == (1 if failure == "unknown" else 0)
    assert state["reserved"] is (failure != "startup")
    assert state["accepted"] == 0


def test_duplicate_and_page_reload_do_not_abort_inflight_confirmation(surface, monkeypatch):
    import asyncio
    import httpx
    from pathlib import Path
    from types import SimpleNamespace
    from app.jobs.repository import JobConflict
    from app.presentations.confirmation_server import ConfirmationResponse
    _, _, store, job, origin = surface
    browser, credential = bootstrap(surface)
    state = {"reserved": False, "sent": 0, "stopped": 0, "accepted": 0}

    class Flow:
        def __init__(self, repository):
            pass

        def load(self, scope, context):
            return {"snapshot": {}}, Path("host-owned-project"), {"stage": "stage1_recommended"}

        def reserve_submission(self, scope, context):
            if state["reserved"]:
                raise JobConflict("already reserved")
            state["reserved"] = True

        def accept(self, scope, context):
            state["accepted"] += 1

    async def run():
        entered, release = asyncio.Event(), asyncio.Event()

        class Servers:
            async def request(self, *args, **kwargs):
                if args[5] == "GET":
                    return ConfirmationResponse(200, "text/html", b'<script src="/static/app.js"></script>')
                kwargs["before_submit"]()
                state["sent"] += 1
                entered.set()
                await release.wait()
                return ConfirmationResponse(200, "application/json", b'{"status":"ok"}')

            async def close_job(self, *args):
                state["stopped"] += 1

            async def close_all(self):
                pass

            async def close_invalid(self, validate):
                return 0

        monkeypatch.setattr(api, "confirmation_servers", Servers())
        path = f"/presentations/{job['id']}/confirmation/"
        headers = {"Origin": origin, "X-PPT-CSRF": credential.json()["csrf"]}
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://testserver",
                                     cookies=browser.cookies) as client:
            first = asyncio.create_task(client.post(path + "api/confirm", json={"stage": "stage1", "template_selection": {"mode": "free_design", "selection_keys": []}}, headers=headers))
            try:
                await asyncio.wait_for(entered.wait(), 3)
                duplicate = await client.post(path + "api/confirm", json={"stage": "stage1", "template_selection": {"mode": "free_design", "selection_keys": []}}, headers=headers)
                assert duplicate.status_code == 409
                assert state["stopped"] == 0
                refreshed = await client.get(path)
                assert refreshed.status_code == 200, refreshed.text
                assert credential.json()["csrf"] in refreshed.text
            finally:
                release.set()
            response = await first
        assert response.status_code == 200, response.text
        assert state == {"reserved": True, "sent": 1, "stopped": 1, "accepted": 1}
        assert not store.cookies

    monkeypatch.setattr(api, "ConfirmationFlow", Flow)
    monkeypatch.setattr(api.ExtensionRunSnapshot, "model_validate", lambda value: SimpleNamespace(execution={"runtime_digest": "a" * 64}))
    monkeypatch.setattr(api, "resolve_snapshot", lambda snapshot, context: snapshot)
    monkeypatch.setattr(api.BuiltinRuntime, "load", lambda: SimpleNamespace(digest="a" * 64))
    asyncio.run(run())


def test_direct_backend_surface_binds_actual_port_not_frontend_origin(surface):
    owner, _, store, job, origin = surface
    ticket = owner.post(f"/presentations/{job['id']}/confirmation-session", headers={"Origin": origin}).json()["ticket"]
    browser = TestClient(app, base_url="http://localhost:8000")
    response = browser.post(f"/presentations/{job['id']}/confirmation-bootstrap", json={"ticket": ticket}, headers={"Origin": origin})
    assert response.status_code == 200, response.text
    scope = store.credential_scope(browser.cookies.get("tuantuan_ppt_confirmation"), job["id"])
    assert scope.origin == "http://localhost:8000"
    path = f"/presentations/{job['id']}/confirmation/session"
    assert browser.get(path, headers={"Origin": scope.origin}).status_code == 200
    assert browser.get(path, headers={"Origin": origin}).status_code == 403


def test_unconfigured_surface_and_forwarded_host_cannot_rebind_ticket(surface):
    owner, _, _, job, origin = surface
    ticket = owner.post(f"/presentations/{job['id']}/confirmation-session", headers={"Origin": origin}).json()["ticket"]
    path = f"/presentations/{job['id']}/confirmation-bootstrap"
    browser = TestClient(app, base_url="http://localhost:8000")
    assert browser.post(path, json={"ticket": ticket, "surface_origin": "http://attacker.test"},
                        headers={"Origin": origin, "X-Forwarded-Host": "attacker.test"}).status_code == 403
    assert TestClient(app, base_url="http://attacker.test").post(path, json={"ticket": ticket},
                        headers={"Origin": origin, "X-Forwarded-Host": "localhost:8000"}).status_code == 403
    assert browser.post(path, json={"ticket": ticket}, headers={"Origin": origin}).status_code == 200


def test_secure_cookie_on_https(surface):
    owner, _, _, job, _ = surface
    # The deployment's configured origin, not a client-supplied forwarded header,
    # determines whether the cookie must be restricted to HTTPS.
    from unittest.mock import patch
    origin = "https://ppt.example.test"
    with patch.object(api, "get_settings", return_value=type("Settings", (), {"allowed_origins": [origin]})()):
        ticket = owner.post(f"/presentations/{job['id']}/confirmation-session", headers={"Origin": origin}).json()["ticket"]
        response = TestClient(app).post(f"/presentations/{job['id']}/confirmation-bootstrap", json={"ticket": ticket, "surface_origin": origin}, headers={"Origin": origin})
    assert response.status_code == 200, response.text
    assert "Secure" in response.headers["set-cookie"]


def test_cross_origin_form_open_keeps_ticket_out_of_navigation_and_cookie_scoped(surface):
    owner, _, store, job, origin = surface
    ticket = owner.post(f"/presentations/{job['id']}/confirmation-session", headers={"Origin": origin}).json()["ticket"]
    browser = TestClient(app, base_url="http://localhost:8000")
    path = f"/presentations/{job['id']}/confirmation-open"
    response = browser.post(path, data={"ticket": ticket}, headers={"Origin": origin})
    assert response.status_code == 200, response.text
    assert response.headers["content-type"].startswith("text/html")
    assert f'href="/presentations/{job["id"]}/confirmation/"' in response.text
    assert ticket not in response.text and "csrf" not in response.text
    assert "HttpOnly" in response.headers["set-cookie"] and "SameSite=strict" in response.headers["set-cookie"]
    assert f"Path=/presentations/{job['id']}/confirmation;" in response.headers["set-cookie"]
    assert "script-src 'none'" in response.headers["content-security-policy"]
    cookie = browser.cookies.get("tuantuan_ppt_confirmation")
    assert store.credential_scope(cookie, job["id"]).origin == "http://localhost:8000"
    assert browser.get(f"/presentations/{job['id']}/confirmation/session").status_code == 200
    landing = browser.get(f"/presentations/{job['id']}/confirmation-open")
    assert landing.status_code == 200
    assert "script-src 'none'" in landing.headers["content-security-policy"]
    assert landing.headers["cache-control"] == "no-store"
    assert browser.post(path, data={"ticket": ticket}, headers={"Origin": origin}).status_code == 403


def test_cross_origin_open_rejects_foreign_origin_query_duplicate_and_oversize_forms(surface):
    owner, _, _, job, origin = surface
    ticket = owner.post(f"/presentations/{job['id']}/confirmation-session", headers={"Origin": origin}).json()["ticket"]
    browser = TestClient(app, base_url="http://localhost:8000")
    path = f"/presentations/{job['id']}/confirmation-open"
    assert browser.post(path, data={"ticket": ticket}, headers={"Origin": "http://attacker.test"}).status_code == 403
    headers = {"Origin": origin, "Content-Type": "application/x-www-form-urlencoded"}
    for suffix, body in [("?ticket=leaked", f"ticket={ticket}"), ("", f"ticket={ticket}&ticket={ticket}"), ("", "ticket=" + "a" * 1024)]:
        assert browser.post(path + suffix, content=body, headers=headers).status_code == 422
    assert browser.post(path, data={"ticket": ticket}, headers={"Origin": origin}).status_code == 200
