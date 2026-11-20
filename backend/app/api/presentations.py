from __future__ import annotations

import re
import json
from urllib.parse import parse_qs, urlsplit

from fastapi import APIRouter, HTTPException, Query, Request, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field

from ..branding import env
from ..config import get_settings, LOOPBACK_HOSTS
from ..extensions.contracts import ExtensionContext
from ..jobs.repository import JobConflict, JobNotFound
from ..presentations.confirmation_sessions import ConfirmationSessions
from ..presentations.confirmation import ConfirmationFlow
from ..presentations.confirmation_proxy import BRIDGE, SECURITY_HEADERS, adapt_response
from ..presentations.confirmation_server import ConfirmationServerManager, ConfirmationServerError, MAX_REQUEST_BYTES
from ..execution.builtin_runtime import BuiltinRuntime
from ..extensions.runtime_snapshot import ExtensionRunSnapshot, resolve_snapshot
from ..presentations.contracts import PresentationRequest
from ..presentations.service import presentation_service, public_presentation
from ..presentations import quick_service
from ..presentations.confirmation_constraints import UnsupportedPresentationInput, validate_submission
from ..workspace import use_workspace, workspace_root_for

router = APIRouter(tags=["presentations"])

_JOB_ID = r"[a-f0-9]{32}"
_CONFIRMATION_PATH = re.compile(rf"^/presentations/{_JOB_ID}/confirmation(?:/.*)?$")
_BOOTSTRAP_PATH = re.compile(rf"^/presentations/{_JOB_ID}/confirmation-(?:bootstrap|open)$")
_LANDING_PATH = re.compile(rf"^/presentations/{_JOB_ID}/confirmation-open$")
_COOKIE = "tuantuan_ppt_confirmation"


def is_confirmation_bootstrap(request: Request) -> bool:
    return request.method == "POST" and bool(_BOOTSTRAP_PATH.fullmatch(request.url.path))


def confirmation_request_scope(request: Request):
    """Validate a cookie within its workspace; never grant general API access."""
    if not _CONFIRMATION_PATH.fullmatch(request.url.path):
        raise PermissionError("不允许的确认路径")
    job_id = request.url.path.split("/")[2]
    cookie = request.cookies.get(_COOKIE, "")
    scope = confirmation_sessions.credential_scope(cookie, job_id)
    with use_workspace(scope.user_id, workspace_root_for(scope.user_id)):
        return confirmation_sessions.authorize(
            cookie, job_id, method=request.method, origin=request.headers.get("Origin"),
            csrf=request.headers.get("X-PPT-CSRF"),
        )


class PresentationInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    topic: str = Field(min_length=1, max_length=8000)
    attachment_ids: list[str] = Field(default_factory=list, max_length=20)
    conversation_id: int | None = Field(default=None, gt=0, strict=True)
    options: dict = Field(default_factory=dict)
    idempotency_key: str = Field(min_length=1, max_length=128)


class BootstrapInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    ticket: str = Field(min_length=1, max_length=128)
    # Explicit for a configured same-origin frontend reverse proxy. Direct API
    # navigation defaults to the actual backend origin, not the caller's port.
    surface_origin: str | None = Field(default=None, max_length=2048)


class PresentationRetryInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_revision: int = Field(ge=1, strict=True)
    request_id: str = Field(min_length=1, max_length=128)
    topic: str | None = Field(default=None, min_length=1, max_length=8000)
    page_count: int | None = Field(default=None, ge=1, le=20, strict=True)
    acknowledge_uncertain: bool = Field(default=False, strict=True)


confirmation_sessions = ConfirmationSessions(presentation_service.jobs.repository)
confirmation_servers = ConfirmationServerManager()


async def maintain_confirmation_servers():
    import asyncio
    while True:
        await asyncio.sleep(2)

        def active(user_id, job_id, stage):
            with use_workspace(user_id, workspace_root_for(user_id)):
                return confirmation_sessions.has_live_stage(user_id, job_id, stage)

        await confirmation_servers.close_invalid(active)


def is_confirmation_request(request: Request) -> bool:
    """Only the job-scoped confirmation surface may use its cookie auth."""
    return bool(_CONFIRMATION_PATH.fullmatch(request.url.path)) or is_confirmation_bootstrap(request)


def is_confirmation_landing(request: Request) -> bool:
    return request.method == "GET" and bool(_LANDING_PATH.fullmatch(request.url.path))


def _origin(request: Request) -> str:
    value = request.headers.get("Origin")
    if not value or value not in get_settings().allowed_origins:
        raise HTTPException(403, "确认页面来源未获允许")
    return value


def _surface_origin(request: Request, selected: str | None) -> str:
    actual = f"{request.url.scheme}://{request.url.netloc}"
    value = actual if selected is None else selected
    if value in get_settings().allowed_origins:
        return value
    # Direct local backend navigation may use a different (or desktop-assigned)
    # port. Do not trust forwarded headers or admit arbitrary Host names.
    parsed = urlsplit(actual)
    if (value == actual and env("TUANTUAN_DEPLOYMENT_MODE", "local").strip().lower() == "local"
            and parsed.scheme in {"http", "https"} and parsed.hostname in LOOPBACK_HOSTS):
        return value
    raise HTTPException(403, "确认页面地址未获允许")


def _execute(operation):
    try:
        return operation(ExtensionContext.current())
    except JobNotFound as exc:
        raise HTTPException(404, str(exc), headers={"Cache-Control": "no-store"}) from None
    except JobConflict as exc:
        raise HTTPException(409, str(exc), headers={"Cache-Control": "no-store"}) from None
    except PermissionError as exc:
        raise HTTPException(403, str(exc), headers={"Cache-Control": "no-store"}) from None
    except ValueError as exc:
        raise HTTPException(422, str(exc), headers={"Cache-Control": "no-store"}) from None


@router.post("/presentations", status_code=201)
def create_presentation(payload: PresentationInput):
    try:
        request = PresentationRequest.model_validate(payload.model_dump(exclude={"idempotency_key"}))
    except ValueError as exc:
        raise HTTPException(422, str(exc), headers={"Cache-Control": "no-store"}) from None
    return _execute(lambda context: public_presentation(presentation_service.create(request, context, payload.idempotency_key)))


@router.get("/presentations/capabilities")
def presentation_capabilities(response: Response, conversation_id: int | None = Query(default=None, gt=0)):
    response.headers["Cache-Control"] = "no-store"
    return _execute(lambda context: presentation_service.capabilities(context, conversation_id=conversation_id)
                    if conversation_id is not None else presentation_service.capabilities(context))


async def _execute_quick(operation):
    try:
        return await operation(ExtensionContext.current())
    except (JobNotFound, JobConflict, PermissionError, ValueError) as exc:
        status = 404 if isinstance(exc, JobNotFound) else 409 if isinstance(exc, JobConflict) else 403 if isinstance(exc, PermissionError) else 422
        raise HTTPException(status, str(exc), headers={"Cache-Control": "no-store"}) from None


@router.get("/presentations/quick/capabilities")
async def quick_capabilities(response: Response, conversation_id: int = Query(gt=0)):
    response.headers["Cache-Control"] = "no-store"
    return await _execute_quick(lambda context: quick_service.capabilities(context, conversation_id, service=presentation_service))


@router.post("/presentations/quick", status_code=201)
async def create_quick_presentation(payload: quick_service.QuickInput, response: Response):
    response.headers["Cache-Control"] = "no-store"
    return public_presentation(await _execute_quick(lambda context: quick_service.create(payload, context, service=presentation_service)))


@router.get("/presentations")
def list_presentations(response: Response, conversation_id: int = Query(gt=0), before: str | None = Query(default=None, pattern=rf"^{_JOB_ID}$")):
    response.headers["Cache-Control"] = "no-store"
    def listing(context):
        result = presentation_service.list(conversation_id, context, before=before)
        return {**result, "jobs": [public_presentation(job) for job in result["jobs"]]}
    return _execute(listing)


@router.get("/presentations/{job_id}")
def get_presentation(job_id: str, response: Response):
    response.headers["Cache-Control"] = "no-store"
    return _execute(lambda context: public_presentation(presentation_service.get(job_id, context)))


@router.post("/presentations/{job_id}/cancel")
async def cancel_presentation(job_id: str):
    def cancel(context):
        job = presentation_service.cancel(job_id, context)
        confirmation_sessions.close_job(context.user_id, job_id)
        return public_presentation(job)
    result = _execute(cancel)
    await confirmation_servers.close_job(ExtensionContext.current().user_id, job_id)
    return result


@router.post("/presentations/{job_id}/resume")
def resume_presentation(job_id: str):
    return _execute(lambda context: public_presentation(presentation_service.resume(job_id, context)))


@router.post("/presentations/{job_id}/retry")
def retry_presentation(job_id: str, payload: PresentationRetryInput):
    return _execute(lambda context: public_presentation(presentation_service.retry(job_id, payload.model_dump(exclude_none=True, exclude_unset=True), context)))


@router.post("/presentations/{job_id}/confirmation-session")
def issue_confirmation_session(job_id: str, request: Request):
    origin = _origin(request)
    authorization = request.headers.get("Authorization")
    return _execute(lambda context: confirmation_sessions.issue(job_id, context, authorization or "", origin=origin))


@router.post("/presentations/{job_id}/confirmation-bootstrap")
def bootstrap_confirmation(job_id: str, payload: BootstrapInput, request: Request, response: Response):
    origin = _origin(request)
    surface_origin = _surface_origin(request, payload.surface_origin)
    try:
        scope = confirmation_sessions.credential_scope(payload.ticket, job_id, ticket=True)
        with use_workspace(scope.user_id, workspace_root_for(scope.user_id)):
            credential = confirmation_sessions.bootstrap(payload.ticket, job_id, origin=origin, surface_origin=surface_origin)
    except PermissionError as exc:
        raise HTTPException(403, str(exc), headers={"Cache-Control": "no-store"}) from None
    response.set_cookie(
        _COOKIE, credential["cookie"], max_age=credential["expires_in"],
        httponly=True, secure=surface_origin.startswith("https://"), samesite="strict", path=f"/presentations/{job_id}/confirmation",
    )
    response.headers["Cache-Control"] = "no-store"
    return {"csrf": credential["csrf"], "expires_in": credential["expires_in"]}


def _confirmation_landing(job_id: str, *, headers=None):
    return Response(
        f'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
        f'<title>打开演示文稿确认页</title><body><main><h1>演示文稿确认</h1>'
        f'<p>请在官方确认页审核内容并提交。完成后可关闭窗口，返回团团查看进度。</p>'
        f'<a href="/presentations/{job_id}/confirmation/">进入确认页</a></main></body></html>',
        media_type="text/html", headers={**SECURITY_HEADERS, "Content-Security-Policy":
            "default-src 'none'; script-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'", **(headers or {})},
    )


@router.get("/presentations/{job_id}/confirmation-open")
def confirmation_landing(job_id: str, request: Request):
    if request.url.query:
        raise HTTPException(422, "确认请求不允许查询参数", headers=SECURITY_HEADERS)
    return _confirmation_landing(job_id)


@router.post("/presentations/{job_id}/confirmation-open")
async def open_confirmation(job_id: str, request: Request):
    # A top-level form navigation can set Strict cookies without relying on
    # third-party storage. Commit this backend-origin page before the user's
    # next navigation so even cross-site launches have a same-site initiator.
    _origin(request)
    if request.url.query or request.headers.get("Content-Type", "").split(";")[0].strip() != "application/x-www-form-urlencoded":
        raise HTTPException(422, "无效的确认打开请求", headers=SECURITY_HEADERS)
    body = bytearray()
    async for chunk in request.stream():
        body.extend(chunk)
        if len(body) > 512:
            raise HTTPException(422, "确认票据过大", headers=SECURITY_HEADERS)
    try:
        fields = parse_qs(body.decode("ascii"), strict_parsing=True, max_num_fields=1)
        if set(fields) != {"ticket"} or len(fields["ticket"]) != 1:
            raise ValueError()
        payload = BootstrapInput(ticket=fields["ticket"][0])
    except (ValueError, UnicodeError):
        raise HTTPException(422, "无效的确认票据", headers=SECURITY_HEADERS) from None
    response = _confirmation_landing(job_id)
    bootstrap_confirmation(job_id, payload, request, response)
    return response


@router.api_route("/presentations/{job_id}/confirmation/", methods=["GET", "POST"])
@router.api_route("/presentations/{job_id}/confirmation/{route:path}", methods=["GET", "POST"])
async def proxy_confirmation(job_id: str, request: Request, route: str = ""):
    context = ExtensionContext.current()
    owns_submission = False
    try:
        # Even a main bearer must not bypass this surface's Cookie/Origin/CSRF.
        scope = confirmation_request_scope(request)
        if scope.user_id != context.user_id or scope.job_id != job_id:
            raise PermissionError("确认账号不匹配")
        if request.url.query:
            raise ValueError("确认请求不允许查询参数")
        if route == "session" and request.method == "GET":
            return {"job_id": job_id, "status": "authorized"}
        flow = ConfirmationFlow(presentation_service.jobs.repository)
        job, root, manifest = flow.load(scope, context)
        if request.method == "GET" and route == "bridge.js":
            return Response(BRIDGE, media_type="text/javascript", headers=SECURITY_HEADERS)
        body = bytearray()
        async for chunk in request.stream():
            body.extend(chunk)
            if len(body) > MAX_REQUEST_BYTES:
                raise ValueError("确认请求过大")
        if request.method == "GET" and body:
            raise ValueError("确认读取不能携带请求内容")
        snapshot = ExtensionRunSnapshot.model_validate(job["snapshot"])
        resolve_snapshot(snapshot, context)
        runtime = BuiltinRuntime.load()
        if not snapshot.execution or runtime.digest != snapshot.execution["runtime_digest"]:
            raise JobConflict("任务绑定的 PPT 资源版本已变化")
        upstream_route = "/" + route
        if request.method == "POST":
            if route != "api/confirm" or request.headers.get("Content-Type", "").split(";")[0].strip() != "application/json":
                raise ValueError("不允许的确认提交")
            try:
                payload = json.loads(body)
            except (ValueError, UnicodeError):
                raise ValueError("无效的确认内容") from None
            expected_stage = "stage1" if manifest["stage"] == "stage1_recommended" else "final"
            if not isinstance(payload, dict) or payload.get("stage") != expected_stage:
                raise ValueError("确认阶段不匹配")
            try:
                validate_submission(job, root, manifest, payload)
            except UnsupportedPresentationInput as exc:
                # No reservation or upstream POST yet: keep the same session so
                # the user can correct the choice without losing their task.
                return JSONResponse({"error": str(exc)}, status_code=422, headers=SECURITY_HEADERS)

        def before_submit():
            nonlocal owns_submission
            # Starting/queueing may take time; recheck live authorization before
            # reserving. Startup failures have not sent anything and stay retryable.
            confirmation_request_scope(request)
            flow.reserve_submission(scope, context)
            owns_submission = True

        result = await confirmation_servers.request(
            context.user_id, job_id, root, runtime,
            "stage1" if manifest["stage"] == "stage1_recommended" else "stage2",
            request.method, upstream_route, bytes(body),
            expires_at=scope.expires_at,
            before_submit=before_submit if request.method == "POST" else None,
        )
        if request.method == "POST":
            # No writer may race receipt validation/publication. A transport
            # failure leaves the durable submission fence, never auto-replays.
            await confirmation_servers.close_job(context.user_id, job_id)
            if result.status_code == 200:
                confirmation_request_scope(request)
                flow.accept(scope, context)
                confirmation_sessions.close_job(context.user_id, job_id)
        csrf = confirmation_sessions.refresh_csrf(request.cookies.get(_COOKIE, ""), job_id) if upstream_route == "/" else ""
        content = adapt_response(upstream_route, result.content_type, result.body, csrf=csrf) if result.status_code == 200 else result.body
        return Response(content, status_code=result.status_code, media_type=result.content_type.split(";")[0], headers=SECURITY_HEADERS)
    except (PermissionError, JobNotFound, JobConflict, ValueError, OSError, ConfirmationServerError) as exc:
        # A failed/duplicate request must not revoke another in-flight writer.
        # The manager cleans up its own transport failures; explicit cancellation
        # and the lifecycle watcher remain responsible for revoking live sessions.
        if owns_submission:
            await confirmation_servers.close_job(context.user_id, job_id)
        if isinstance(exc, PermissionError):
            status = 403
        elif isinstance(exc, JobNotFound):
            status = 404
        elif isinstance(exc, (JobConflict, ConfirmationServerError)):
            status = 409
        else:
            status = 422
        # Never expose an upstream filesystem path, process detail or raw body.
        raise HTTPException(status, "确认页面不可用，请返回任务查看状态或重新打开", headers=SECURITY_HEADERS) from None


@router.get("/presentations/{job_id}/confirmation/session")
def confirmation_session(job_id: str, request: Request, response: Response):
    origin = request.headers.get("Origin")
    cookie = request.cookies.get("tuantuan_ppt_confirmation")
    if not cookie:
        raise HTTPException(401, "确认会话不存在")
    _execute(lambda _: confirmation_sessions.authorize(cookie, job_id, method="GET", origin=origin))
    response.headers["Cache-Control"] = "no-store"
    return {"job_id": job_id, "status": "authorized"}
