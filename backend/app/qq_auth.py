from __future__ import annotations

import json
import re
import secrets
import time
from typing import Literal
from urllib.parse import parse_qs, urlencode

import httpx
from fastapi import HTTPException

from .auth import QQ_ACCOUNT_SUFFIX, _connect_auth, _issue_token, _token_hash, current_user, get_account
from .config import Settings
from .workspace import ensure_workspace


QQ_HOST = "https://graph.qq.com"
FLOW_TTL = 600
RESULT_TTL = 120
DECISION_TTL = 600
_OPAQUE = re.compile(r"[A-Za-z0-9_-]{43}")
_OPEN_ID = re.compile(r"[A-Za-z0-9_-]{1,128}")
_qq_transport: httpx.BaseTransport | None = None


def _now() -> int:
    return int(time.time())


def _active_session(conn, session_hash: str, user_id: int) -> bool:
    return conn.execute(
        "SELECT 1 FROM auth_sessions WHERE token_hash = ? AND user_id = ? AND revoked_at IS NULL AND expires_at > ?",
        (session_hash, user_id, _now()),
    ).fetchone() is not None


def new_flow(settings: Settings, authorization: str | None) -> tuple[str, str]:
    session_hash = None
    if authorization is not None:
        user = current_user(authorization)
        if get_account(user["id"]).get("qq_bound"):
            raise HTTPException(status_code=409, detail="当前团团账号已绑定 QQ")
        session_hash = _token_hash(authorization.partition(" ")[2].strip())
    state, browser = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
    now = _now()
    with _connect_auth() as conn:
        conn.execute("DELETE FROM auth_qq_flows WHERE expires_at <= ?", (now,))
        conn.execute(
            "INSERT INTO auth_qq_flows (key_hash, browser_hash, app_id, session_hash, expires_at) VALUES (?, ?, ?, ?, ?)",
            (_token_hash(state), _token_hash(browser), settings.qq_app_id, session_hash, now + FLOW_TTL),
        )
    params = urlencode({
        "client_id": settings.qq_app_id, "redirect_uri": settings.qq_redirect_uri,
        "response_type": "code", "scope": "get_user_info", "state": state,
    })
    return f"{QQ_HOST}/oauth2.0/authorize?{params}", browser


def claim_callback(settings: Settings, state: str, browser: str) -> tuple[str | None] | None:
    if not _OPAQUE.fullmatch(state) or not _OPAQUE.fullmatch(browser):
        return None
    with _connect_auth() as conn:
        record = conn.execute(
            """DELETE FROM auth_qq_flows WHERE key_hash = ? AND browser_hash = ? AND app_id = ?
                AND expires_at > ? AND subject_hash IS NULL RETURNING session_hash""",
            (_token_hash(state), _token_hash(browser), settings.qq_app_id, _now()),
        ).fetchone()
    return (record["session_hash"],) if record else None


def _provider_data(raw: str) -> dict:
    if len(raw) > 16_384:
        raise ValueError("invalid QQ response size")
    text = raw.strip()
    callback = re.fullmatch(r"callback\s*\((.*)\)\s*;?", text, re.DOTALL)
    if callback or text.startswith("{"):
        data = json.loads(callback.group(1) if callback else text)
        if not isinstance(data, dict):
            raise ValueError("invalid QQ response object")
        return data
    return {key: items[0] for key, items in parse_qs(text, max_num_fields=32).items() if len(items) == 1}


def provider_subject(settings: Settings, code: str) -> str:
    try:
        with httpx.Client(base_url=QQ_HOST, timeout=8.0, trust_env=False, transport=_qq_transport) as client:
            token = _provider_data(client.get("/oauth2.0/token", params={
                "grant_type": "authorization_code", "client_id": settings.qq_app_id,
                "client_secret": settings.qq_app_key, "redirect_uri": settings.qq_redirect_uri, "code": code,
            }).raise_for_status().text)
            access_token = token.get("access_token")
            if not isinstance(access_token, str) or not access_token or len(access_token) > 2048 or "error" in token:
                raise ValueError("QQ did not issue an access token")
            identity = _provider_data(client.get("/oauth2.0/me", params={"access_token": access_token}).raise_for_status().text)
            open_id = identity.get("openid")
            if (str(identity.get("client_id")) != settings.qq_app_id or "error" in identity
                    or not isinstance(open_id, str) or not _OPEN_ID.fullmatch(open_id)):
                raise ValueError("QQ did not identify this app's user")
    except (httpx.HTTPError, ValueError, RecursionError):
        raise HTTPException(status_code=502, detail="QQ 暂时无法完成登录，请重新授权") from None
    return _token_hash(f"{settings.qq_app_id}:{open_id}")


def _linked_user_id(conn, app_id: str, subject_hash: str) -> int | None:
    record = conn.execute(
        "SELECT user_id FROM auth_qq_identities WHERE app_id = ? AND subject_hash = ?",
        (app_id, subject_hash),
    ).fetchone()
    return int(record["user_id"]) if record is not None else None


def new_result(settings: Settings, browser: str, session_hash: str | None, subject_hash: str) -> tuple[str, int]:
    ticket = secrets.token_urlsafe(32)
    with _connect_auth() as conn:
        needs_decision = session_hash is None and _linked_user_id(conn, settings.qq_app_id, subject_hash) is None
        ttl = DECISION_TTL if needs_decision else RESULT_TTL
        conn.execute(
            """INSERT INTO auth_qq_flows (key_hash, browser_hash, app_id, session_hash, subject_hash, expires_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (_token_hash(ticket), _token_hash(browser), settings.qq_app_id, session_hash, subject_hash, _now() + ttl),
        )
    return ticket, ttl


def finish_flow(
    settings: Settings, browser: str, ticket: str, authorization: str | None,
    *, action: Literal["create", "bind"] | None = None, confirmation: str = "",
) -> dict:
    if not _OPAQUE.fullmatch(ticket) or not _OPAQUE.fullmatch(browser):
        raise HTTPException(status_code=400, detail="QQ 授权已失效，请重新开始")
    ticket_hash = _token_hash(ticket)
    if action is not None and confirmation != ticket_hash:
        raise HTTPException(status_code=400, detail="QQ 授权已失效，请重新开始")
    if action == "bind" and authorization is None:
        raise HTTPException(status_code=401, detail="请先登录团团账号，再绑定 QQ")
    if action == "create" and authorization is not None:
        raise HTTPException(status_code=400, detail="请退出当前账号，再创建新账号")
    user_id = current_user(authorization)["id"] if authorization is not None else None
    session_hash = _token_hash(authorization.partition(" ")[2].strip()) if authorization is not None else None
    with _connect_auth() as conn:
        conn.execute("BEGIN IMMEDIATE")
        record = conn.execute(
            """SELECT subject_hash FROM auth_qq_flows WHERE key_hash = ? AND browser_hash = ? AND app_id = ?
                AND session_hash IS ? AND expires_at > ? AND subject_hash IS NOT NULL""",
            (ticket_hash, _token_hash(browser), settings.qq_app_id, None if action else session_hash, _now()),
        ).fetchone()
        if record is None:
            raise HTTPException(status_code=400, detail="QQ 授权已失效，请重新开始")
        linked_user_id = _linked_user_id(conn, settings.qq_app_id, record["subject_hash"])
        if user_id is None and linked_user_id is None and action is None:
            # Keep the result for the user's decision. The digest ties it to this browser's ticket.
            return {"confirmation": ticket_hash}
        conn.execute("DELETE FROM auth_qq_flows WHERE key_hash = ?", (ticket_hash,))
        if user_id is not None:
            if not _active_session(conn, session_hash, user_id):
                raise HTTPException(status_code=401, detail="登录状态已失效，请重新登录后绑定 QQ")
            if linked_user_id is not None and linked_user_id != user_id:
                raise HTTPException(status_code=409, detail="这个 QQ 已绑定其他团团账号，无法重复绑定")
            if linked_user_id is None:
                if conn.execute("SELECT 1 FROM auth_qq_identities WHERE user_id = ?", (user_id,)).fetchone():
                    raise HTTPException(status_code=409, detail="当前团团账号已绑定其他 QQ")
                conn.execute("INSERT INTO auth_qq_identities VALUES (?, ?, ?, 0)", (settings.qq_app_id, record["subject_hash"], user_id))
        else:
            if linked_user_id is None:
                email = f"qq-{secrets.token_hex(16)}{QQ_ACCOUNT_SUFFIX}"
                created = conn.execute(
                    "INSERT INTO users (email, password_hash, display_name) VALUES (?, ?, ?)",
                    (email, secrets.token_urlsafe(48), "QQ 用户"),
                )
                user_id = int(created.lastrowid)
                conn.execute("INSERT INTO auth_qq_identities VALUES (?, ?, ?, 1)", (settings.qq_app_id, record["subject_hash"], user_id))
            else:
                user_id = linked_user_id
            user_row = dict(conn.execute("SELECT id, email, password_hash FROM users WHERE id = ?", (user_id,)).fetchone())
    if authorization is not None:
        return {"user": get_account(user_id)}
    with _connect_auth() as conn:
        conn.execute("BEGIN IMMEDIATE")
        ensure_workspace(user_id)
    return {"access_token": _issue_token(user_row), "token_type": "bearer", "user": get_account(user_id)}
