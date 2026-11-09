"""In-memory, job/stage-scoped confirmation credentials; not general API auth.

The HTTP boundary calls authorize for every cookie request, uses HttpOnly/Strict
cookies, and exposes bootstrap only as a body POST. Bootstrap and the actual
confirmation surface have separately host-validated, exact Origin bindings.
"""
from __future__ import annotations

import hashlib
import hmac
import re
import secrets
import threading
import time
from dataclasses import dataclass, replace
from urllib.parse import urlsplit

from ..extensions.contracts import ExtensionContext
from ..jobs.repository import JobConflict, JobNotFound


TICKET_SECONDS = 60
SESSION_SECONDS = 900


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _job_id(value: str) -> None:
    if not isinstance(value, str) or not re.fullmatch(r"[a-f0-9]{32}", value):
        raise ValueError("无效的演示文稿任务标识")


def _origin(value: str) -> None:
    if not isinstance(value, str) or len(value) > 2048 or any(ord(c) <= 32 for c in value):
        raise ValueError("确认页面需要明确的 HTTP Origin")
    try:
        parsed = urlsplit(value)
        _ = parsed.port  # Validate malformed/out-of-range ports, even when unused.
    except ValueError:
        raise ValueError("无效的确认页面 Origin") from None
    if (parsed.scheme not in {"http", "https"} or not parsed.hostname
            or parsed.username is not None or parsed.password is not None
            or parsed.path or parsed.query or parsed.fragment
            or value != f"{parsed.scheme}://{parsed.netloc}"):
        raise ValueError("确认页面需要明确的 HTTP Origin")


def _principal_active(token_hash: str, user_id: int) -> bool:
    from ..auth import _connect_auth
    with _connect_auth() as conn:
        row = conn.execute(
            "SELECT expires_at,revoked_at FROM auth_sessions WHERE token_hash=? AND user_id=?",
            (token_hash, user_id),
        ).fetchone()
    return row is not None and row["revoked_at"] is None and row["expires_at"] > time.time()


@dataclass(frozen=True)
class ConfirmationScope:
    user_id: int
    job_id: str
    stage_id: str
    revision: int
    manifest_sha256: str
    source_version: int
    origin: str
    principal_hash: str
    expires_at: float
    csrf_hash: str = ""


class ConfirmationSessions:
    def __init__(self, repository, *, clock=time.time, principal_active=_principal_active, max_entries=1024):
        self.repository, self.clock, self.principal_active = repository, clock, principal_active
        self.max_entries = max_entries
        self.tickets: dict[str, ConfirmationScope] = {}
        self.cookies: dict[str, ConfirmationScope] = {}
        # Derive a stable token per cookie without retaining plaintext tokens.
        # Reading another page must not revoke a submission already in flight.
        self._csrf_key = secrets.token_bytes(32)
        self.lock = threading.RLock()

    def _prune(self):
        now = self.clock()
        for entries in (self.tickets, self.cookies):
            for key in [key for key, scope in entries.items() if scope.expires_at <= now]:
                entries.pop(key, None)

    def _waiting(self, job_id, context):
        job = self.repository.get(job_id, context)
        checkpoint = job["checkpoint"]
        if (job["kind"] != "ppt.generate" or job["status"] != "waiting_user"
                or job["cancel_requested"] or not job["stage_id"]
                or checkpoint.get("stage") not in {"stage1_recommended", "stage2_recommended"}
                or checkpoint.get("external_outcome") == "unknown"
                or not re.fullmatch(r"[a-f0-9]{64}", checkpoint.get("manifest_sha256", ""))
                or type(checkpoint.get("source_version")) is not int or checkpoint["source_version"] < 1):
            raise JobConflict("当前任务没有可用的官方确认阶段")
        return job

    def _validate(self, scope, job_id):
        if scope.expires_at <= self.clock() or scope.job_id != job_id:
            raise PermissionError("确认会话已失效")
        context = ExtensionContext(user_id=scope.user_id)
        try:
            context.check_workspace()
            job = self._waiting(job_id, context)
            checkpoint = job["checkpoint"]
            if (job["stage_id"] != scope.stage_id or job["revision"] != scope.revision
                    or checkpoint["manifest_sha256"] != scope.manifest_sha256
                    or checkpoint["source_version"] != scope.source_version
                    or not self.principal_active(scope.principal_hash, scope.user_id)):
                raise PermissionError("确认会话已失效")
        except (JobConflict, JobNotFound):
            raise PermissionError("确认会话已失效") from None

    def issue(self, job_id: str, context: ExtensionContext, authorization: str, *, origin: str) -> dict:
        from ..auth import current_user
        _job_id(job_id)
        _origin(origin)
        context.check_workspace()
        user = current_user(authorization)
        if user["id"] != context.user_id:
            raise PermissionError("登录账号与确认任务不匹配")
        principal_hash = _digest(authorization.partition(" ")[2].strip())
        if not self.principal_active(principal_hash, context.user_id):
            raise PermissionError("登录会话已失效")
        job = self._waiting(job_id, context)
        with self.lock:
            self._prune()
            if len(self.tickets) + len(self.cookies) >= self.max_entries:
                raise JobConflict("确认会话过多，请关闭已有确认页面后重试")
            ticket = secrets.token_urlsafe(32)
            self.tickets[_digest(ticket)] = ConfirmationScope(
                context.user_id, job_id, job["stage_id"], job["revision"],
                job["checkpoint"]["manifest_sha256"], job["checkpoint"]["source_version"],
                origin, principal_hash, self.clock() + TICKET_SECONDS,
            )
        return {"job_id": job_id, "ticket": ticket, "expires_in": TICKET_SECONDS}

    def bootstrap(self, ticket: str, job_id: str, *, origin: str, surface_origin: str | None = None) -> dict:
        # The HTTP boundary validates the surface against its deployment origins.
        # The caller origin remains bound to the one-use ticket independently.
        surface_origin = origin if surface_origin is None else surface_origin
        _origin(surface_origin)
        with self.lock:
            self._prune()
            scope = self.tickets.get(_digest(ticket)) if isinstance(ticket, str) and len(ticket) <= 128 else None
            if scope is None or scope.origin != origin:
                raise PermissionError("确认票据已失效")
            self._validate(scope, job_id)
            self.tickets.pop(_digest(ticket))
            cookie = secrets.token_urlsafe(32)
            csrf = self._csrf(cookie)
            self.cookies[_digest(cookie)] = replace(
                scope, origin=surface_origin, expires_at=self.clock() + SESSION_SECONDS,
                csrf_hash=_digest(csrf),
            )
        return {"cookie": cookie, "csrf": csrf, "expires_in": SESSION_SECONDS}

    def credential_scope(self, credential: str, job_id: str, *, ticket: bool = False) -> ConfirmationScope:
        """Resolve an opaque credential before entering its isolated workspace.

        This is not authorization: callers must still bootstrap/authorize inside
        that workspace to recheck the live job, revision and parent login.
        """
        with self.lock:
            self._prune()
            entries = self.tickets if ticket else self.cookies
            scope = entries.get(_digest(credential)) if isinstance(credential, str) and len(credential) <= 128 else None
            if scope is None or scope.job_id != job_id:
                raise PermissionError("确认会话已失效")
            return scope

    def authorize(self, cookie: str, job_id: str, *, method: str, origin: str | None, csrf: str | None = None) -> ConfirmationScope:
        with self.lock:
            self._prune()
            scope = self.cookies.get(_digest(cookie)) if isinstance(cookie, str) and len(cookie) <= 128 else None
            if scope is None or (origin is not None and origin != scope.origin):
                raise PermissionError("确认会话已失效")
            if method not in {"GET", "HEAD", "POST"}:
                raise PermissionError("不允许的确认请求")
            if method == "POST" and (origin != scope.origin or not isinstance(csrf, str)
                                     or not hmac.compare_digest(_digest(csrf), scope.csrf_hash)):
                raise PermissionError("确认请求未通过 Origin/CSRF 校验")
            self._validate(scope, job_id)
            return scope

    def _csrf(self, cookie: str) -> str:
        return hmac.new(self._csrf_key, cookie.encode("utf-8"), hashlib.sha256).hexdigest()

    def refresh_csrf(self, cookie: str, job_id: str) -> str:
        """Return this live cookie's stable bridge token; page reads never rotate it."""
        with self.lock:
            self.authorize(cookie, job_id, method="GET", origin=None)
            return self._csrf(cookie)

    def has_live_stage(self, user_id: int, job_id: str, stage: str) -> bool:
        """Lifecycle probe; caller must enter this account's workspace first."""
        with self.lock:
            self._prune()
            scopes = [scope for scope in self.cookies.values()
                      if (scope.user_id, scope.job_id) == (user_id, job_id)]
        for scope in scopes:
            try:
                self._validate(scope, job_id)
                job = self.repository.get(job_id, ExtensionContext(user_id=user_id))
                if job["checkpoint"].get("stage") == f"{stage}_recommended":
                    return True
            except (PermissionError, ValueError):
                continue
        return False

    def close_job(self, user_id: int, job_id: str) -> None:
        with self.lock:
            for entries in (self.tickets, self.cookies):
                for key in [key for key, scope in entries.items() if (scope.user_id, scope.job_id) == (user_id, job_id)]:
                    entries.pop(key, None)

    def close_all(self) -> None:
        with self.lock:
            self.tickets.clear()
            self.cookies.clear()
