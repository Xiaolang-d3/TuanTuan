"""Scoped confirmation credentials: no bearer/secret appears in a URL or job."""
import hashlib

import pytest
from app import db
from app.extensions.contracts import ExtensionContext
from app.jobs.repository import JobConflict, JobRepository
from app.workspace import use_workspace


@pytest.fixture
def sessions(tmp_path, monkeypatch):
    from app.presentations.confirmation_sessions import ConfirmationSessions
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "accounts.db")
    with use_workspace(1):
        db.init_db()
        context = ExtensionContext.current()
        now = [1000.0]
        repository = JobRepository(clock=lambda: now[0])
        job = repository.enqueue("ppt.generate", {}, {}, context, "sessions")
        claimed = repository.claim(context)
        repository.checkpoint(job["id"], claimed["owner_token"], {
            "stage": "stage1_recommended", "manifest_sha256": "a" * 64,
            "source_version": 2,
        }, context)
        waiting = repository.wait_for_user(job["id"], claimed["owner_token"], "官方确认", {}, context)
        principal = {"user_id": 1, "expires_at": 9000.0, "revoked": False}
        principal_calls = []

        def authenticate(authorization):
            assert authorization == "Bearer test-main-secret"
            return {"id": 1, "email": "fixture@example.test"}

        def active(digest, user_id):
            principal_calls.append(digest)
            return (digest == hashlib.sha256(b"test-main-secret").hexdigest()
                    and user_id == principal["user_id"] and not principal["revoked"]
                    and now[0] < principal["expires_at"])

        monkeypatch.setattr("app.auth.current_user", authenticate)
        store = ConfirmationSessions(repository, clock=lambda: now[0], principal_active=active)
        yield store, repository, context, waiting, now, principal, principal_calls


def issue(fixture):
    store, _, context, waiting, *_ = fixture
    return store.issue(waiting["id"], context, "Bearer test-main-secret", origin="http://localhost:1420")


def bootstrap(fixture):
    store, *_ = fixture
    ticket = issue(fixture)
    return store.bootstrap(ticket["ticket"], ticket["job_id"], origin="http://localhost:1420")


def test_bootstrap_ticket_is_single_use_and_body_only(sessions):
    store, _, _, waiting, *_ = sessions
    ticket = issue(sessions)
    assert set(ticket) == {"job_id", "ticket", "expires_in"}
    credential = store.bootstrap(ticket["ticket"], waiting["id"], origin="http://localhost:1420")
    assert set(credential) == {"cookie", "csrf", "expires_in"}
    assert credential["expires_in"] == 900
    assert "test-main-secret" not in repr(vars(store))
    with pytest.raises(PermissionError):
        store.bootstrap(ticket["ticket"], waiting["id"], origin="http://localhost:1420")


def test_cookie_only_authorizes_its_job_and_live_stage(sessions):
    store, repository, context, waiting, *_ = sessions
    credential = bootstrap(sessions)
    bound = store.authorize(credential["cookie"], waiting["id"], method="GET", origin=None)
    assert bound.user_id == 1 and bound.job_id == waiting["id"]
    with pytest.raises(PermissionError):
        store.authorize(credential["cookie"], "b" * 32, method="GET", origin=None)
    repository.confirm(waiting["id"], waiting["stage_id"], waiting["revision"], {}, context)
    with pytest.raises(PermissionError):
        store.authorize(credential["cookie"], waiting["id"], method="GET", origin=None)


def test_confirmation_csrf_and_foreign_origin_are_rejected(sessions):
    store, _, _, waiting, *_ = sessions
    credential = bootstrap(sessions)
    for origin, csrf in [(None, credential["csrf"]), ("null", credential["csrf"]),
                         ("http://attacker.test", credential["csrf"]), ("http://localhost:1420", None)]:
        with pytest.raises(PermissionError):
            store.authorize(credential["cookie"], waiting["id"], method="POST", origin=origin, csrf=csrf)
    store.authorize(credential["cookie"], waiting["id"], method="POST", origin="http://localhost:1420", csrf=credential["csrf"])
    with pytest.raises(PermissionError):
        store.authorize(credential["cookie"], waiting["id"], method="GET", origin="http://attacker.test")


def test_origin_mismatch_and_expired_ticket_do_not_issue_cookie(sessions):
    store, _, _, waiting, now, *_ = sessions
    ticket = issue(sessions)
    with pytest.raises(PermissionError):
        store.bootstrap(ticket["ticket"], waiting["id"], origin="http://attacker.test")
    now[0] += 61
    with pytest.raises(PermissionError):
        store.bootstrap(ticket["ticket"], waiting["id"], origin="http://localhost:1420")


def test_expired_cookie_and_revoked_parent_session_are_rejected(sessions):
    store, _, _, waiting, now, principal, _ = sessions
    credential = bootstrap(sessions)
    principal["revoked"] = True
    with pytest.raises(PermissionError):
        store.authorize(credential["cookie"], waiting["id"], method="GET", origin=None)
    principal["revoked"] = False
    credential = bootstrap(sessions)
    now[0] += 901
    with pytest.raises(PermissionError):
        store.authorize(credential["cookie"], waiting["id"], method="GET", origin=None)


def test_ticket_binds_recommendation_revision_and_is_cleared_on_close(sessions):
    store, _, _, waiting, *_ = sessions
    ticket = issue(sessions)
    with db.connect() as conn:
        conn.execute("UPDATE background_jobs SET checkpoint_json=? WHERE id=?", (
            '{"stage":"stage1_recommended","manifest_sha256":"' + "b" * 64 + '","source_version":2}', waiting["id"]))
    with pytest.raises(PermissionError):
        store.bootstrap(ticket["ticket"], waiting["id"], origin="http://localhost:1420")
    credential = bootstrap(sessions)
    store.close_job(1, waiting["id"])
    with pytest.raises(PermissionError):
        store.authorize(credential["cookie"], waiting["id"], method="GET", origin=None)


def test_cross_account_cannot_bootstrap_or_reuse_cookie(sessions):
    store, _, _, waiting, *_ = sessions
    ticket = issue(sessions)
    credential = store.bootstrap(ticket["ticket"], waiting["id"], origin="http://localhost:1420")
    with use_workspace(2):
        db.init_db()
        with pytest.raises(PermissionError):
            store.authorize(credential["cookie"], waiting["id"], method="GET", origin=None)


def test_server_restart_drops_sessions_and_does_not_touch_receipts(sessions):
    store, repository, _, waiting, now, *_ = sessions
    credential = bootstrap(sessions)
    from app.presentations.confirmation_sessions import ConfirmationSessions
    fresh = ConfirmationSessions(repository, clock=lambda: now[0], principal_active=lambda *_: True)
    with pytest.raises(PermissionError):
        fresh.authorize(credential["cookie"], waiting["id"], method="GET", origin=None)
    store.close_all()
    assert not store.tickets and not store.cookies


def test_only_ppt_waiting_user_can_create_ticket(sessions):
    store, repository, context, waiting, *_ = sessions
    repository.cancel(waiting["id"], context)
    with pytest.raises(JobConflict):
        issue(sessions)


def test_only_explicit_origins_and_valid_job_ids_are_accepted(sessions):
    store, _, context, waiting, *_ = sessions
    for origin in ["null", "*", "http://localhost:1420/path", "http://user@localhost:1420", "http://localhost:1420/", "file://"]:
        with pytest.raises(ValueError):
            store.issue(waiting["id"], context, "Bearer test-main-secret", origin=origin)
    with pytest.raises(ValueError):
        store.issue("../other", context, "Bearer test-main-secret", origin="http://localhost:1420")


def test_default_parent_session_check_honors_revocation_and_expiration(tmp_path, monkeypatch):
    from app import auth
    from app.presentations.confirmation_sessions import _principal_active
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "auth.db")
    db.init_db()
    auth.init_auth_db()
    digest = hashlib.sha256(b"test-main-secret").hexdigest()
    with auth._connect_auth() as conn:
        conn.execute("INSERT INTO users(id,email,password_hash) VALUES(1,'fixture@example.test','test-only')")
        conn.execute("INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)", (digest, 1, 9999999999))
    assert _principal_active(digest, 1)
    assert not _principal_active(digest, 2)
    with auth._connect_auth() as conn:
        conn.execute("UPDATE auth_sessions SET revoked_at=1 WHERE token_hash=?", (digest,))
    assert not _principal_active(digest, 1)
    with auth._connect_auth() as conn:
        conn.execute("UPDATE auth_sessions SET revoked_at=NULL,expires_at=1 WHERE token_hash=?", (digest,))
    assert not _principal_active(digest, 1)


def test_credential_scope_only_resolves_matching_job_and_still_needs_authorization(sessions):
    store, repository, context, waiting, *_ = sessions
    ticket = issue(sessions)
    scope = store.credential_scope(ticket["ticket"], waiting["id"], ticket=True)
    assert scope.user_id == 1
    with pytest.raises(PermissionError):
        store.credential_scope(ticket["ticket"], "b" * 32, ticket=True)
    credential = store.bootstrap(ticket["ticket"], waiting["id"], origin="http://localhost:1420")
    with pytest.raises(PermissionError):
        store.credential_scope(ticket["ticket"], waiting["id"], ticket=True)
    repository.cancel(waiting["id"], context)
    # Resolving identity is not permission to access a now-cancelled task.
    assert store.credential_scope(credential["cookie"], waiting["id"]).user_id == 1
    with pytest.raises(PermissionError):
        store.authorize(credential["cookie"], waiting["id"], method="GET", origin=None)


def test_lifecycle_probe_rejects_revocation_and_wrong_stage(sessions):
    store, _, _, waiting, _, principal, _ = sessions
    bootstrap(sessions)
    assert store.has_live_stage(1, waiting["id"], "stage1")
    assert not store.has_live_stage(1, waiting["id"], "stage2")
    principal["revoked"] = True
    assert not store.has_live_stage(1, waiting["id"], "stage1")


def test_bridge_csrf_stays_valid_across_page_reads(sessions):
    store, _, _, waiting, *_ = sessions
    credential = bootstrap(sessions)
    token = store.refresh_csrf(credential["cookie"], waiting["id"])
    assert token == credential["csrf"]
    for _ in range(3):
        assert store.refresh_csrf(credential["cookie"], waiting["id"]) == token
    store.authorize(credential["cookie"], waiting["id"], method="POST", origin="http://localhost:1420", csrf=token)
    assert token not in repr(store.cookies)


def test_surface_origin_is_separate_from_bootstrap_caller(sessions):
    store, _, _, waiting, *_ = sessions
    ticket = issue(sessions)
    credential = store.bootstrap(ticket["ticket"], waiting["id"], origin="http://localhost:1420",
                                 surface_origin="http://localhost:8000")
    store.authorize(credential["cookie"], waiting["id"], method="POST", origin="http://localhost:8000", csrf=credential["csrf"])
    with pytest.raises(PermissionError):
        store.authorize(credential["cookie"], waiting["id"], method="POST", origin="http://localhost:1420", csrf=credential["csrf"])


def test_session_capacity_is_bounded(sessions):
    store, *_ = sessions
    store.max_entries = 2
    issue(sessions)
    issue(sessions)
    with pytest.raises(JobConflict, match="确认"):
        issue(sessions)
