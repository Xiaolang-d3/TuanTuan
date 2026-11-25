"""Local Sign in with ChatGPT session lifecycle. Tokens never enter the model catalog."""
from __future__ import annotations

import asyncio
import hmac
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from uuid import uuid4

import httpx

from . import chatgpt_oauth as oauth, chatgpt_store as store
from .config import get_settings
from .model_network import hosted_models
from .models.base import ModelProviderError

AUTH_KIND = "chatgpt_subscription"
API_ROOT = "https://api.openai.com/v1"
_PENDING_SECONDS = 300
_RESULT_SECONDS = 120
_MAX_ATTEMPTS = 32
_LOCAL_ONLY = "ChatGPT 订阅登录仅支持本机运行的团团，不适用于托管或局域网部署。"
_STORAGE = "无法使用本机安全凭证存储。请解锁或配置系统钥匙串后重试。"
_REAUTHORIZE = "ChatGPT 订阅授权不可用，请在模型设置中重新登录或切回该账号。"
_TERMINAL_REFRESH = {"invalid_client", "invalid_id_token", "invalid_token_response", "account_mismatch", "refresh_identity_unverified"}


class SubscriptionError(RuntimeError):
    pass


def local_enabled() -> bool:
    return not hosted_models() and get_settings().is_loopback_only


def _http() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=12, follow_redirects=False, trust_env=False)


def _tokens(account: dict) -> oauth.TokenSet | None:
    saved = account.get("tokens")
    return oauth.TokenSet(**{**saved, "scopes": tuple(saved["scopes"])}) if saved else None


def _signed_in(account: dict) -> bool:
    return bool(account.get("tokens"))


def _plan_enabled(account: dict) -> bool:
    tokens = _tokens(account)
    return bool(tokens and tokens.plan_enabled)


def _clear(account: dict, *, expired: bool = False) -> None:
    account.update(tokens=None, generation=uuid4().hex, reauthorize=expired)
    account.pop("refresh_after", None)


def status(db_path: Path) -> dict:
    show_entry = not hosted_models()
    base = {"show_entry": show_entry, "available": False, "configured": False, "plan_enabled": False,
            "status": "unavailable", "active_id": None, "connection_id": None, "accounts": []}
    if not show_entry or not local_enabled():
        return {**base, "message": _LOCAL_ONLY}
    try:
        if not store.storage_available():
            return {**base, "message": _STORAGE}
        state = store.read_state(db_path)
    except store.SubscriptionStoreError:
        return {**base, "message": _STORAGE}
    active_id = state.get("active_id")
    active = state["accounts"].get(active_id, {})
    plan = _plan_enabled(active)
    signed_in = _signed_in(active)
    return {**base, "available": True, "configured": signed_in, "plan_enabled": plan,
            "active_id": active_id, "connection_id": active_id if plan else None,
            "status": "connected" if plan else "identity_only" if signed_in else
            "reauthorize" if active.get("reauthorize") else "signed_out",
            "accounts": [{"id": account_id, "label": item["label"], "email": item.get("email"),
                          "signed_in": _signed_in(item), "plan_enabled": _plan_enabled(item)}
                         for account_id, item in state["accounts"].items()]}


def binding(db_path: Path, account_id: str) -> str:
    """Return only a revocable binding identifier (not a token or user identity)."""
    if not local_enabled():
        return ""
    try:
        state = store.read_state(db_path)
    except store.SubscriptionStoreError:
        return ""
    if state["active_id"] != account_id:
        return ""
    account = state["accounts"].get(account_id, {})
    return account.get("generation", "") if _plan_enabled(account) else ""


async def access_token(db_path: Path, account_id: str, generation: str) -> str:
    # Refresh tokens rotate remotely. Cancelling a chat must not roll back the
    # local successor (or terminal invalidation) after the issuer consumed one.
    # The child owns the entire vault transaction, including its commit/close.
    job = asyncio.create_task(_access_token(db_path, account_id, generation))
    try:
        return await asyncio.shield(job)
    except asyncio.CancelledError:
        while not job.done():
            try:
                await asyncio.shield(job)
            except asyncio.CancelledError:
                continue
            except Exception:
                break
        if not job.cancelled():
            job.exception()
        raise


async def _access_token(db_path: Path, account_id: str, generation: str) -> str:
    def usable(state: dict) -> tuple[dict, oauth.TokenSet]:
        account = state["accounts"].get(account_id, {})
        if state["active_id"] != account_id or not generation or account.get("generation") != generation:
            raise ModelProviderError("chatgpt_reauthorize", _REAUTHORIZE)
        tokens = _tokens(account)
        if not tokens or not tokens.plan_enabled:
            raise ModelProviderError("chatgpt_reauthorize", _REAUTHORIZE)
        return account, tokens

    if not local_enabled():
        raise ModelProviderError("chatgpt_local_only", _LOCAL_ONLY)
    try:
        state = await asyncio.to_thread(store.read_state, db_path)
        _, tokens = usable(state)
        now = time.time()
        if tokens.expires_at > now and (tokens.expires_at > now + 90 or
                                       (tokens.earliest_refresh_at or 0) > now):
            return tokens.access_token
        error: ModelProviderError | None = None
        async with store.edit_state(db_path) as state:
            account, tokens = usable(state)
            now = time.time()
            if tokens.expires_at > now + 90:
                return tokens.access_token
            if not tokens.refresh_token:
                if tokens.expires_at > now:
                    return tokens.access_token
                _clear(account, expired=True)
                error = ModelProviderError("chatgpt_reauthorize", _REAUTHORIZE)
            elif max(tokens.earliest_refresh_at or 0, account.get("refresh_after", 0)) > now:
                if tokens.expires_at > now:
                    return tokens.access_token
                error = ModelProviderError("chatgpt_refresh_pending", "ChatGPT 授权暂不能续期，请稍后重试。")
            else:
                try:
                    async with _http() as http:
                        refreshed = await oauth.refresh_tokens(http, tokens)
                except oauth.OAuthError as exc:
                    if exc.code in oauth.TERMINAL_REFRESH_ERRORS or exc.code in _TERMINAL_REFRESH:
                        _clear(account, expired=True)
                        error = ModelProviderError("chatgpt_reauthorize", _REAUTHORIZE)
                    else:
                        account["refresh_after"] = now + 15
                        if tokens.expires_at > time.time():
                            return tokens.access_token
                        error = ModelProviderError("chatgpt_refresh_unavailable", "无法续期 ChatGPT 授权，请稍后重试。")
                else:
                    account.update(tokens=asdict(refreshed), email=refreshed.email or account.get("email"))
                    account.pop("refresh_after", None)
                    if refreshed.plan_enabled:
                        return refreshed.access_token
                    error = ModelProviderError("chatgpt_plan_disabled", "当前 ChatGPT 账号未授权使用订阅额度。")
        assert error is not None
        raise error
    except store.SubscriptionStoreError:
        raise ModelProviderError("chatgpt_storage_unavailable", _STORAGE) from None


@dataclass
class Pending:
    db_path: Path
    account_id: str | None
    generation: str | None
    server: asyncio.Server = field(repr=False)
    attempt: oauth.AuthorizationAttempt = field(repr=False)
    deadline: float
    status: str = "pending"
    message: str = ""
    claimed: bool = False
    expiry: asyncio.TimerHandle | None = field(default=None, repr=False)


_attempts: dict[str, Pending] = {}


def _finish(pending: Pending, status_value: str, message: str = "") -> None:
    pending.server.close()
    if pending.expiry:
        pending.expiry.cancel()
    pending.status, pending.message = status_value, message
    pending.deadline = time.monotonic() + _RESULT_SECONDS


def _expire(pending: Pending) -> None:
    if pending.status == "pending" and not pending.claimed:
        _finish(pending, "failed", "本次 ChatGPT 登录已超时，请重新发起。")


def _prune() -> None:
    for attempt_id, item in list(_attempts.items()):
        if item.deadline <= time.monotonic() and item.status != "pending":
            del _attempts[attempt_id]


def _cancel(db_path: Path) -> None:
    for pending in _attempts.values():
        if pending.db_path == db_path and pending.status == "pending" and not pending.claimed:
            _finish(pending, "failed", "本次 ChatGPT 登录已取消。")


async def start(db_path: Path, *, account_id: str | None, reconsent: bool) -> dict:
    if not local_enabled():
        raise SubscriptionError(_LOCAL_ONLY)
    if not await asyncio.to_thread(store.storage_available):
        raise SubscriptionError(_STORAGE)
    state = await asyncio.to_thread(store.read_state, db_path)
    existing = state["accounts"].get(account_id) if account_id else None
    if account_id and existing is None:
        raise SubscriptionError("找不到这个 ChatGPT 账号登记。")
    if reconsent and existing is None:
        raise SubscriptionError("请先选择需要重新授权的 ChatGPT 账号。")
    host = await asyncio.to_thread(store.host_id)
    server = await asyncio.start_server(lambda r, w: _callback(pending, r, w), "127.0.0.1", 0,
                                        limit=16_384, start_serving=False)
    attempt_id = None
    try:
        # Check and reserve after binding: other starts can run during start_server.
        _prune()
        if any(item.db_path == db_path and item.status == "pending" and item.claimed for item in _attempts.values()):
            raise SubscriptionError("正在完成上一次 ChatGPT 登录，请稍候。")
        if len(_attempts) >= _MAX_ATTEMPTS:
            raise SubscriptionError("ChatGPT 登录请求过多，请稍后重试。")
        _cancel(db_path)
        port = server.sockets[0].getsockname()[1]
        attempt = oauth.begin_authorization(
            redirect_uri=f"http://127.0.0.1:{port}{oauth.CALLBACK_PATH}", host_id=host,
            agent_name="团团 (TuanTuan)", client_id=existing["client_id"] if existing else None,
            expected_subject=existing["subject"] if existing else None,
            login_hint=existing.get("email") if existing else None, reconsent=reconsent,
        )
        attempt_id = uuid4().hex
        pending = Pending(db_path, account_id, existing.get("generation") if existing else None,
                          server, attempt, time.monotonic() + _PENDING_SECONDS)
        pending.expiry = asyncio.get_running_loop().call_later(_PENDING_SECONDS, _expire, pending)
        _attempts[attempt_id] = pending
        await server.start_serving()
    except BaseException:
        server.close()
        if attempt_id is not None and _attempts.pop(attempt_id, None) is not None and pending.expiry:
            pending.expiry.cancel()
        raise
    return {"attempt_id": attempt_id, "authorization_url": attempt.authorization_url}


def attempt_status(db_path: Path, attempt_id: str) -> dict:
    _prune()
    pending = _attempts.get(attempt_id)
    if pending is None or pending.db_path != db_path:
        raise SubscriptionError("本次 ChatGPT 登录已失效，请重新发起。")
    return {"status": pending.status, "message": pending.message}


def _callback_query(header: bytes, attempt: oauth.AuthorizationAttempt) -> str:
    start_line, *lines = header.decode("ascii").split("\r\n")
    method, target, version = start_line.split(" ")
    uri = urlsplit(target)
    redirect = urlsplit(attempt.redirect_uri)
    hosts = [line.split(":", 1)[1].strip() for line in lines if line.lower().startswith("host:")]
    if (method != "GET" or version not in {"HTTP/1.0", "HTTP/1.1"} or uri.path != oauth.CALLBACK_PATH
            or uri.scheme or uri.netloc or uri.fragment or hosts != [redirect.netloc]):
        raise ValueError("not an OAuth callback")
    states = parse_qs(uri.query, keep_blank_values=True, max_num_fields=12).get("state", [])
    if len(states) != 1 or not states[0].isascii() or not hmac.compare_digest(states[0], attempt.state):
        raise ValueError("invalid state")
    return uri.query


async def _callback(pending: Pending, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    code, text = "400 Bad Request", "这不是有效的 ChatGPT 登录回调。"
    try:
        header = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=5)
        query = _callback_query(header, pending.attempt)
        if pending.status != "pending" or pending.claimed or pending.deadline <= time.monotonic():
            raise ValueError("stale callback")
        pending.claimed = True
        pending.server.close()
        try:
            authorization_code = oauth.parse_callback(pending.attempt, query)
            await _exchange(pending, authorization_code)
        except oauth.OAuthError as exc:
            if exc.code == "access_denied":
                text = "未授权 ChatGPT 订阅使用。可返回团团重新登录。"
            else:
                text = "ChatGPT 登录未完成，请返回团团重试。"
            _finish(pending, "failed", text)
        except (SubscriptionError, store.SubscriptionStoreError, OSError):
            text = "无法保存 ChatGPT 登录，请返回团团重试。"
            _finish(pending, "failed", text)
        except Exception:
            # Never log the local HTTP query, OAuth response or an exception carrying secrets.
            text = "ChatGPT 登录未完成，请返回团团重试。"
            _finish(pending, "failed", text)
        else:
            code, text = "200 OK", "ChatGPT 登录完成，可以关闭此页并返回团团。"
            _finish(pending, "completed")
    except (ValueError, UnicodeError, asyncio.IncompleteReadError, asyncio.LimitOverrunError, TimeoutError, OSError):
        pass
    finally:
        body = ("<!doctype html><html lang=zh-CN><meta charset=utf-8><title>团团 · ChatGPT</title>"
                f"<main><p>{text}</p></main></html>").encode()
        try:
            writer.write((f"HTTP/1.1 {code}\r\nContent-Type: text/html; charset=utf-8\r\n"
                          "Cache-Control: no-store\r\nReferrer-Policy: no-referrer\r\n"
                          "Content-Security-Policy: default-src 'none'; frame-ancestors 'none'\r\n"
                          f"Connection: close\r\nContent-Length: {len(body)}\r\n\r\n").encode() + body)
            await writer.drain()
        except OSError:
            pass
        finally:
            writer.close()


async def _exchange(pending: Pending, code: oauth.AuthorizationCode) -> None:
    from .agent.model_catalog import ensure_chatgpt_connection

    async with store.edit_state(pending.db_path) as state:
        if pending.account_id:
            account = state["accounts"].get(pending.account_id)
            if not account or account["generation"] != pending.generation:
                raise SubscriptionError("ChatGPT 账号状态已改变，请重新登录。")
            account_id = pending.account_id
        else:
            account, account_id = {}, str(uuid4())
        async with _http() as http:
            tokens = await oauth.exchange_code(http, pending.attempt, code)
        if any(item["client_id"] == tokens.client_id for key, item in state["accounts"].items() if key != account_id):
            raise SubscriptionError("此 ChatGPT 登记已存在，请选用已保存账号。")
        label = account.get("label") or f"ChatGPT · {account_id[:8]}"
        if tokens.plan_enabled:
            # The model catalog contains only the public registration id. A DB write
            # failure aborts credential replacement and never selects a different account.
            await asyncio.to_thread(ensure_chatgpt_connection, account_id, label, pending.db_path)
        state["accounts"][account_id] = {"label": label, "email": tokens.email, "client_id": tokens.client_id,
            "subject": tokens.subject, "generation": uuid4().hex, "tokens": asdict(tokens)}
        state["active_id"] = account_id


async def activate(db_path: Path, account_id: str) -> None:
    if not local_enabled():
        raise SubscriptionError(_LOCAL_ONLY)
    _cancel(db_path)
    async with store.edit_state(db_path) as state:
        account = state["accounts"].get(account_id, {})
        if not _signed_in(account):
            raise SubscriptionError("此 ChatGPT 账号需要重新登录。")
        state["active_id"] = account_id


async def sign_out(db_path: Path) -> str:
    if not local_enabled():
        raise SubscriptionError(_LOCAL_ONLY)
    _cancel(db_path)
    warning = ""
    async with store.edit_state(db_path) as state:
        account = state["accounts"].get(state["active_id"])
        if not account:
            return warning
        tokens = _tokens(account)
        if tokens and tokens.refresh_token:
            for attempt in range(2):
                try:
                    async with _http() as http:
                        await oauth.revoke_refresh_token(http, client_id=tokens.client_id, refresh_token=tokens.refresh_token)
                except oauth.OAuthError as exc:
                    if exc.retryable and attempt == 0:
                        await asyncio.sleep(0.5)
                        continue
                    warning = "已清除本机登录，未能确认远端撤销。可在 ChatGPT 设置中断开团团的访问权限。"
                break
        _clear(account)
    return warning


def build_subscription_provider(connection: dict, *, timeout_seconds: float):
    from .models.chatgpt_subscription import ChatGPTSubscriptionProvider

    db_path = connection["subscription_db_path"]
    account_id = connection["connection_id"]
    generation = connection["credential_fingerprint"]
    return ChatGPTSubscriptionProvider(model=connection["model_name"], timeout_seconds=timeout_seconds,
                                       access_token=lambda: access_token(db_path, account_id, generation))
