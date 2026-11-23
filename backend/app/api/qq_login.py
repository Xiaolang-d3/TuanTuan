from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field

from .. import qq_auth
from ..config import get_settings


router = APIRouter()
_BROWSER_COOKIE = "__Host-tuantu-qq-browser"
_RESULT_COOKIE = "__Host-tuantu-qq-result"
_COOKIE_OPTIONS = {"httponly": True, "secure": True, "samesite": "lax", "path": "/"}


class QqDecision(BaseModel):
    action: Literal["create", "bind"]
    confirmation: str = Field(pattern=r"^[0-9a-f]{64}$")


def _origin(request: Request, *, require_origin: bool) -> str:
    origin = get_settings().qq_origin
    if origin is None:
        raise HTTPException(status_code=404, detail="QQ 登录尚未启用")
    if require_origin and request.headers.get("Origin") != origin:
        raise HTTPException(status_code=403, detail="请在团团网站上继续 QQ 授权")
    return origin


def _start(request: Request, response: Response, authorization: str | None) -> dict[str, str]:
    _origin(request, require_origin=True)
    url, browser = qq_auth.new_flow(get_settings(), authorization)
    response.set_cookie(_BROWSER_COOKIE, browser, max_age=qq_auth.FLOW_TTL, **_COOKIE_OPTIONS)
    response.delete_cookie(_RESULT_COOKIE, **_COOKIE_OPTIONS)
    return {"authorization_url": url}


@router.post("/auth/qq/start")
def start(request: Request, response: Response) -> dict[str, str]:
    return _start(request, response, None)


@router.post("/auth/qq/bind/start")
def start_binding(request: Request, response: Response) -> dict[str, str]:
    return _start(request, response, request.headers.get("Authorization", ""))


@router.get("/api/auth/qq/callback", include_in_schema=False)
@router.get("/auth/qq/callback")
def callback(request: Request) -> RedirectResponse:
    origin = _origin(request, require_origin=False)
    settings = get_settings()
    browser = request.cookies.get(_BROWSER_COOKIE, "")
    state, code, error = (request.query_params.get(name, "") for name in ("state", "code", "error"))
    claimed = qq_auth.claim_callback(settings, state, browser)
    if claimed is None:
        return RedirectResponse(f"{origin}/?qq_auth=failed", status_code=303)
    session_hash, = claimed
    mode = "bind" if session_hash else "login"
    fragment = "#/settings/account" if session_hash else ""
    result, issued = "failed", None
    if error == "access_denied" or (not error and not code):
        result = "cancelled"
    elif not error and 1 <= len(code) <= 1024:
        try:
            subject = qq_auth.provider_subject(settings, code)
        except HTTPException:
            pass
        else:
            result = mode
            issued = qq_auth.new_result(settings, browser, session_hash, subject)
    if session_hash and result != "bind":
        result = f"bind_{result}"
    response = RedirectResponse(f"{origin}/?qq_auth={result}{fragment}", status_code=303)
    if issued is not None:
        ticket, ttl = issued
        response.set_cookie(_RESULT_COOKIE, ticket, max_age=ttl, **_COOKIE_OPTIONS)
        response.set_cookie(_BROWSER_COOKIE, browser, max_age=ttl, **_COOKIE_OPTIONS)
    else:
        response.delete_cookie(_BROWSER_COOKIE, **_COOKIE_OPTIONS)
        response.delete_cookie(_RESULT_COOKIE, **_COOKIE_OPTIONS)
    return response


@router.post("/auth/qq/finish")
def finish(request: Request, response: Response, decision: QqDecision | None = None) -> dict:
    _origin(request, require_origin=True)
    result = qq_auth.finish_flow(
        get_settings(), request.cookies.get(_BROWSER_COOKIE, ""), request.cookies.get(_RESULT_COOKIE, ""),
        request.headers.get("Authorization"),
        action=decision.action if decision else None, confirmation=decision.confirmation if decision else "",
    )
    if "confirmation" not in result:
        response.delete_cookie(_BROWSER_COOKIE, **_COOKIE_OPTIONS)
        response.delete_cookie(_RESULT_COOKIE, **_COOKIE_OPTIONS)
    return result
