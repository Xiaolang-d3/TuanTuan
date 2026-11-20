from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import secrets
import tempfile
import sqlite3
import time
from pathlib import Path
from typing import Any

from fastapi import HTTPException, status

from .config import get_settings
from .db import connect
from .workspace import auth_db_path, data_dir, ensure_workspace, init_auth_db
from .password_policy import LEGACY_PASSWORD_MAX_LENGTH, normalize_password, password_error


def _throttle_key(email: str, client: str | None) -> str:
    raw = f"{email.strip().lower()}|{client or 'unknown'}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def check_login_allowed(email: str, client: str | None = None) -> None:
    key = _throttle_key(email, client)
    now = int(time.time())
    with _connect_auth() as conn:
        record = conn.execute(
            "SELECT failure_count, window_expires_at, locked_until FROM auth_login_attempts WHERE throttle_key = ?",
            (key,),
        ).fetchone()
        if record and int(record["window_expires_at"]) <= now:
            conn.execute("DELETE FROM auth_login_attempts WHERE throttle_key = ?", (key,))
            record = None
    if record and int(record["locked_until"]) > now:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"登录失败次数过多，请在 {int(record['locked_until']) - now} 秒后重试",
            headers={"Retry-After": str(int(record["locked_until"]) - now)},
        )


def _record_login_failure(email: str, client: str | None) -> None:
    settings = get_settings()
    key = _throttle_key(email, client)
    now = int(time.time())
    with _connect_auth() as conn:
        conn.execute("BEGIN IMMEDIATE")
        conn.execute("DELETE FROM auth_login_attempts WHERE window_expires_at <= ?", (now,))
        record = conn.execute(
            "SELECT failure_count, window_expires_at FROM auth_login_attempts WHERE throttle_key = ?",
            (key,),
        ).fetchone()
        count = int(record["failure_count"]) + 1 if record and int(record["window_expires_at"]) > now else 1
        expires_at = now + settings.login_lockout_seconds
        locked_until = expires_at if count >= settings.login_max_attempts else 0
        conn.execute(
            """
            INSERT INTO auth_login_attempts (
                throttle_key, failure_count, window_expires_at, locked_until, updated_at
            ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(throttle_key) DO UPDATE SET
                failure_count = excluded.failure_count,
                window_expires_at = excluded.window_expires_at,
                locked_until = excluded.locked_until,
                updated_at = CURRENT_TIMESTAMP
            """,
            (key, count, expires_at, locked_until),
        )


def _clear_login_failures(email: str, client: str | None) -> None:
    with _connect_auth() as conn:
        conn.execute(
            "DELETE FROM auth_login_attempts WHERE throttle_key = ?",
            (_throttle_key(email, client),),
        )


def auth_is_enabled() -> bool:
    return True


def _connect_auth():
    init_auth_db()
    return connect(auth_db_path())


def public_auth_config() -> dict[str, bool]:
    """Return only the information a browser needs to decide whether to log in."""
    with _connect_auth() as conn:
        exists = conn.execute("SELECT 1 FROM users LIMIT 1").fetchone() is not None
    return {"enabled": True, "setup_required": not exists, "registration_open": True, "qq_enabled": get_settings().qq_origin is not None}


def _encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).rstrip(b"=").decode("ascii")


def _decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def _hash_password(password: str, salt: bytes | None = None) -> str:
    salt = salt or os.urandom(16)
    password_hash = hashlib.scrypt(normalize_password(password).encode("utf-8"), salt=salt, n=2**14, r=8, p=1)
    return f"scrypt-nfc-v1${_encode(salt)}${_encode(password_hash)}"


def _verify_password(password: str, stored: str) -> bool:
    try:
        if stored.startswith("scrypt-nfc-v1$"):
            _, encoded_salt, expected = stored.split("$", 2)
            password = normalize_password(password)
        else:
            # Existing unversioned hashes used the exact input bytes.
            encoded_salt, expected = stored.split("$", 1)
        actual = _encode(hashlib.scrypt(password.encode("utf-8"), salt=_decode(encoded_salt), n=2**14, r=8, p=1))
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(actual.encode("utf-8"), expected.encode("utf-8"))


def _sign(payload: str, password_hash: str) -> str:
    return _encode(hmac.new(password_hash.encode("utf-8"), payload.encode("ascii"), hashlib.sha256).digest())


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _issue_token(user: dict[str, Any]) -> str:
    now = int(time.time())
    expires_at = now + get_settings().auth_token_ttl_seconds
    payload = _encode(json.dumps({
        "id": user["id"], "email": user["email"], "exp": expires_at,
        "sid": secrets.token_urlsafe(24),
    }, separators=(",", ":")).encode("utf-8"))
    token = f"{payload}.{_sign(payload, user['password_hash'])}"
    with _connect_auth() as conn:
        conn.execute("DELETE FROM auth_sessions WHERE expires_at <= ?", (now,))
        conn.execute(
            "INSERT INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
            (_token_hash(token), user["id"], expires_at),
        )
    return token


def _validate_password(password: str, email: str = "") -> None:
    error = password_error(password, email)
    if error:
        raise HTTPException(status_code=422, detail=error)


# Match the form's email syntax without a DNS lookup; these are local accounts.
_EMAIL_PATTERN = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")
QQ_ACCOUNT_SUFFIX = "@qq.tuantuan.invalid"
# An unknown email still performs the same expensive password check.
_DUMMY_PASSWORD_HASH = _hash_password(secrets.token_urlsafe(32))


def authenticate(email: str, password: str, client: str | None = None) -> str:
    normalized = email.strip().lower()
    if not normalized or len(normalized) > 320 or not 1 <= len(password) <= LEGACY_PASSWORD_MAX_LENGTH:
        raise HTTPException(status_code=422, detail="请输入邮箱和密码，密码不能超过 500 位")
    if normalized.endswith(QQ_ACCOUNT_SUFFIX):
        raise HTTPException(status_code=422, detail="请使用 QQ 登录，或输入你的登录邮箱")
    check_login_allowed(normalized, client)
    with _connect_auth() as conn:
        row = conn.execute(
            "SELECT id, email, password_hash FROM users WHERE email = ?", (normalized,),
        ).fetchone()
    verified = _verify_password(password, row["password_hash"] if row else _DUMMY_PASSWORD_HASH)
    if row is None or not verified:
        _record_login_failure(normalized, client)
        if row is None:
            raise HTTPException(status_code=404, detail="该邮箱尚未注册")
        raise HTTPException(status_code=401, detail="密码不正确")
    _clear_login_failures(normalized, client)
    ensure_workspace(int(row["id"]))
    return _issue_token(dict(row))


def register_user(email: str, password: str, *, initial_only: bool = False) -> str:
    normalized_email = email.strip().lower()
    if len(normalized_email) > 320 or normalized_email.endswith(QQ_ACCOUNT_SUFFIX) or not _EMAIL_PATTERN.fullmatch(normalized_email):
        raise HTTPException(status_code=422, detail="请输入有效的邮箱地址，长度不能超过 320 个字符")
    _validate_password(password, normalized_email)
    password_hash = _hash_password(password)
    with _connect_auth() as conn:
        conn.execute("BEGIN IMMEDIATE")
        if initial_only and conn.execute("SELECT 1 FROM users LIMIT 1").fetchone():
            raise HTTPException(status_code=409, detail="已完成首次设置，请登录或创建普通本地账户")
        try:
            cursor = conn.execute(
                "INSERT INTO users (email, password_hash) VALUES (?, ?)",
                (normalized_email, password_hash),
            )
        except sqlite3.IntegrityError as exc:
            raise HTTPException(status_code=409, detail="该邮箱已注册，请直接登录") from exc
        user = conn.execute(
            "SELECT id, email, password_hash FROM users WHERE id = ?", (cursor.lastrowid,),
        ).fetchone()
    ensure_workspace(int(user["id"]))
    return _issue_token(dict(user))


def create_initial_user(email: str, password: str) -> str:
    return register_user(email, password, initial_only=True)


def current_user(authorization: str | None) -> dict[str, Any]:
    scheme, _, token = (authorization or "").partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        raise HTTPException(status_code=401, detail="请先登录", headers={"WWW-Authenticate": "Bearer"})
    token = token.strip()
    try:
        if len(token) > 8192:
            raise ValueError("oversized token")
        payload, signature = token.split(".", 1)
        data = json.loads(_decode(payload))
        if (
            not isinstance(data, dict) or type(data.get("id")) is not int
            or data["id"] <= 0 or not isinstance(data.get("email"), str)
            or type(data.get("exp")) is not int or data["exp"] <= time.time()
            or ("sid" in data and (not isinstance(data["sid"], str) or not data["sid"]))
        ):
            raise ValueError("invalid payload")
        with _connect_auth() as conn:
            user = conn.execute(
                "SELECT id, email, password_hash FROM users WHERE id = ?", (data["id"],),
            ).fetchone()
            if user is None or data["email"].lower() != user["email"].lower():
                raise ValueError("unexpected user")
            if not hmac.compare_digest(signature.encode("utf-8"), _sign(payload, user["password_hash"]).encode("ascii")):
                raise ValueError("invalid signature")
            token_hash = _token_hash(token)
            # Old signed tokens remain usable until their original expiry. Register
            # them once so that logout can revoke them too, without storing secrets.
            if "sid" not in data:
                conn.execute(
                    "INSERT OR IGNORE INTO auth_sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
                    (token_hash, user["id"], data["exp"]),
                )
            session = conn.execute(
                "SELECT user_id, expires_at, revoked_at FROM auth_sessions WHERE token_hash = ?", (token_hash,),
            ).fetchone()
            if not session or session["user_id"] != user["id"] or session["revoked_at"] is not None or session["expires_at"] <= time.time():
                raise ValueError("revoked or unknown session")
    except (ValueError, TypeError, UnicodeError, OverflowError, RecursionError):
        raise HTTPException(status_code=401, detail="登录状态已失效，请重新登录", headers={"WWW-Authenticate": "Bearer"}) from None
    return {"id": user["id"], "email": user["email"]}


def revoke_session(authorization: str | None) -> None:
    user = current_user(authorization)
    token = (authorization or "").partition(" ")[2].strip()
    with _connect_auth() as conn:
        conn.execute(
            "UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ? AND user_id = ?",
            (int(time.time()), _token_hash(token), user["id"]),
        )


_AVATAR_MAX_BYTES = 2 * 1024 * 1024
_AVATAR_SIZE = 256
_AVATAR_MAX_PIXELS = 16_000_000
_ACCOUNT_COLUMNS = "id, email, display_name, avatar_relpath"


def _safe_avatar_path(user_id: int, relpath: str) -> Path | None:
    if not relpath:
        return None
    root = (data_dir() / "avatars").resolve()
    path = (data_dir() / relpath).resolve()
    if not path.is_relative_to(root) or path.name != f"{user_id}.jpg":
        return None
    return path if path.is_file() else None


def _account_from_row(row: Any) -> dict[str, Any]:
    relpath = str(row["avatar_relpath"] or "")
    account = {
        "id": int(row["id"]),
        "email": str(row["email"]),
        "display_name": str(row["display_name"] or ""),
        "has_avatar": _safe_avatar_path(int(row["id"]), relpath) is not None,
    }
    if get_settings().qq_origin or row["qq_only"] is not None:
        account.update(qq_enabled=get_settings().qq_origin is not None, qq_bound=row["qq_only"] is not None)
    if row["qq_only"]:
        account["qq_only"] = True
    return account


def get_account(user_id: int) -> dict[str, Any]:
    with _connect_auth() as conn:
        row = conn.execute(
            f"SELECT {_ACCOUNT_COLUMNS}, (SELECT qq_only FROM auth_qq_identities WHERE user_id = users.id) AS qq_only FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="账号不存在")
    return _account_from_row(row)


def update_account(user_id: int, display_name: str) -> dict[str, Any]:
    clean = display_name.strip()
    if len(clean) > 40:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="昵称不能超过 40 个字")
    with _connect_auth() as conn:
        cursor = conn.execute(
            "UPDATE users SET display_name = ? WHERE id = ?",
            (clean, user_id),
        )
        if cursor.rowcount == 0:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="账号不存在")
    return get_account(user_id)


def change_password(user_id: int, current_password: str, new_password: str, client: str | None = None) -> str:
    if not 1 <= len(current_password) <= 500:
        raise HTTPException(status_code=422, detail="请输入当前密码")
    if normalize_password(current_password) == normalize_password(new_password):
        raise HTTPException(status_code=422, detail="新密码不能与当前密码相同")
    with _connect_auth() as conn:
        row = conn.execute(
            "SELECT id, email, password_hash FROM users WHERE id = ?", (user_id,),
        ).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="账号不存在")
    _validate_password(new_password, row["email"])
    check_login_allowed(row["email"], client)
    if not _verify_password(current_password, row["password_hash"]):
        _record_login_failure(row["email"], client)
        # A credential error does not invalidate the authenticated session.
        raise HTTPException(status_code=422, detail="当前密码不正确")
    password_hash = _hash_password(new_password)
    with _connect_auth() as conn:
        conn.execute("BEGIN IMMEDIATE")
        changed = conn.execute(
            "UPDATE users SET password_hash = ? WHERE id = ? AND password_hash = ?",
            (password_hash, user_id, row["password_hash"]),
        )
        if changed.rowcount != 1:
            raise HTTPException(status_code=409, detail="密码已被更新，请重新登录后再试")
        conn.execute("DELETE FROM auth_sessions WHERE user_id = ?", (user_id,))
    _clear_login_failures(row["email"], client)
    return _issue_token({"id": row["id"], "email": row["email"], "password_hash": password_hash})


def avatar_path(user_id: int) -> Path | None:
    with _connect_auth() as conn:
        row = conn.execute(
            "SELECT avatar_relpath FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
    if row is None or not row["avatar_relpath"]:
        return None
    return _safe_avatar_path(user_id, str(row["avatar_relpath"]))


def save_avatar(user_id: int, filename: str, content: bytes) -> dict[str, Any]:
    get_account(user_id)
    if not content:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="头像文件为空")
    if len(content) > _AVATAR_MAX_BYTES:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="头像不能超过 2MB")
    suffix = Path(filename).suffix.lower()
    if suffix not in {".png", ".jpg", ".jpeg", ".webp"}:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="头像仅支持 PNG、JPEG 或 WebP")
    try:
        from io import BytesIO
        from PIL import Image

        with Image.open(BytesIO(content)) as image:
            if image.format not in {"PNG", "JPEG", "WEBP"}:
                raise HTTPException(status_code=422, detail="头像仅支持 PNG、JPEG 或 WebP")
            if image.width * image.height > _AVATAR_MAX_PIXELS:
                raise HTTPException(status_code=422, detail="头像分辨率不能超过 1600 万像素")
            image = image.convert("RGB")
            width, height = image.size
            side = min(width, height)
            left = (width - side) // 2
            top = (height - side) // 2
            image = image.crop((left, top, left + side, top + side))
            image = image.resize((_AVATAR_SIZE, _AVATAR_SIZE))
            output = BytesIO()
            image.save(output, format="JPEG", quality=88)
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="无法识别该图片文件") from exc
    relpath = f"avatars/{user_id}.jpg"
    destination = data_dir() / relpath
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(dir=destination.parent, suffix=".tmp", delete=False) as temporary:
            temporary_path = Path(temporary.name)
            temporary.write(output.getvalue())
        with _connect_auth() as conn:
            conn.execute("BEGIN IMMEDIATE")
            os.replace(temporary_path, destination)
            conn.execute("UPDATE users SET avatar_relpath = ? WHERE id = ?", (relpath, user_id))
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)
    return get_account(user_id)


def delete_avatar(user_id: int) -> dict[str, Any]:
    get_account(user_id)
    with _connect_auth() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute("SELECT avatar_relpath FROM users WHERE id = ?", (user_id,)).fetchone()
        previous = _safe_avatar_path(user_id, str(row["avatar_relpath"]))
        if previous is not None:
            previous.unlink(missing_ok=True)
        conn.execute("UPDATE users SET avatar_relpath = '' WHERE id = ?", (user_id,))
    return get_account(user_id)
