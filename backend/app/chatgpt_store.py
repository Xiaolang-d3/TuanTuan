"""Installation-local vault for ChatGPT subscription credentials."""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import sqlite3
import sys
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager, closing
from pathlib import Path
from typing import TypeVar
from uuid import UUID, uuid4

import keyring
from cryptography.fernet import Fernet
from keyring.backend import KeyringBackend
from keyring.backends.chainer import ChainerBackend

_SERVICE = "com.tuantuan.app.chatgpt"
_MESSAGE = "无法使用本机 ChatGPT 安全凭证存储。请检查系统钥匙串及本机存储。"
# Reject null/fail, plaintext (even in a chainer), and unknown plugins. Do not
# call generic keyring operations, which can silently fall back across backends.
_OS_BACKENDS = {
    ("keyring.backends.Windows", "WinVaultKeyring"),
    ("keyring.backends.macOS", "Keyring"),
    ("keyring.backends.SecretService", "Keyring"),
    ("keyring.backends.libsecret", "Keyring"),
    ("keyring.backends.kwallet", "DBusKeyring"),
    ("keyring.backends.kwallet", "DBusKeyringKWallet4"),
}
_LOCK_RETRY_SECONDS = 0.05
_T = TypeVar("_T")


class SubscriptionStoreError(RuntimeError):
    """A sanitized failure: never expose a credential or keyring error."""

    def __init__(self) -> None:
        super().__init__(_MESSAGE)


def _secure_backend() -> KeyringBackend:
    selected = keyring.get_keyring()
    candidates = selected.backends if type(selected) is ChainerBackend else (selected,)
    for backend in candidates:
        cls = type(backend)
        if (cls.__module__, cls.__name__) in _OS_BACKENDS:
            return backend
    raise SubscriptionStoreError()


def storage_available() -> bool:
    """Check that an OS-backed keyring can round-trip and remove a small entry."""
    try:
        backend = _secure_backend()
        probe = f"probe:{uuid4().hex}"
        sample = Fernet.generate_key().decode("ascii")
        backend.set_password(_SERVICE, probe, sample)
        try:
            return backend.get_password(_SERVICE, probe) == sample
        finally:
            backend.delete_password(_SERVICE, probe)
    except Exception:
        return False


def _vault_dir() -> Path:
    home = Path.home()
    if sys.platform == "win32":
        root = Path(os.environ.get("LOCALAPPDATA") or home / "AppData" / "Local")
    elif sys.platform == "darwin":
        root = home / "Library" / "Application Support"
    else:
        root = Path(os.environ.get("XDG_DATA_HOME") or home / ".local" / "share")
        if not root.is_absolute():
            root = home / ".local" / "share"
    # Intentionally independent of TUANTUAN_DATA_DIR, which can be backed up
    # or synchronized wholesale. Only the canonical-path digest is kept here.
    return root / "TuanTuan Credentials" / "chatgpt"


def _path_digest(path: Path) -> str:
    canonical = os.path.normcase(str(path.resolve()))
    return hashlib.sha256(os.fsencode(canonical)).hexdigest()


def _workspace_vault(workspace_db: Path) -> Path:
    return _vault_dir() / f"workspace-{_path_digest(workspace_db)}.sqlite3"


def _connect(path: Path, *, timeout: float = 5) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Do not open/close a raw fd here: POSIX can release this process's
    # SQLite locks for that file when an unrelated fd is closed.
    return sqlite3.connect(path, timeout=timeout, check_same_thread=False)


def host_id() -> str:
    """Return a random installation ID, independent of accounts and keyring."""
    try:
        path = _vault_dir() / "installation.sqlite3"
        with closing(_connect(path)) as conn, conn:
            conn.execute("BEGIN IMMEDIATE")
            conn.execute("CREATE TABLE IF NOT EXISTS installation (id INTEGER PRIMARY KEY, urn TEXT NOT NULL)")
            row = conn.execute("SELECT urn FROM installation WHERE id = 1").fetchone()
            if row is None:
                urn = uuid4().urn
                conn.execute("INSERT INTO installation (id, urn) VALUES (1, ?)", (urn,))
                return urn
            urn = UUID(row[0]).urn
            if row[0] != urn:
                raise SubscriptionStoreError()
            return urn
    except Exception:
        raise SubscriptionStoreError() from None


def _cipher(path: Path, *, create: bool = False) -> Fernet:
    backend = _secure_backend()
    account = f"workspace-key:{_path_digest(path)}"
    key = backend.get_password(_SERVICE, account)
    if key is None and create:
        # Called under the workspace's SQLite write reservation, so two
        # processes cannot overwrite one another's newly created key.
        key = Fernet.generate_key().decode("ascii")
        backend.set_password(_SERVICE, account, key)
        if backend.get_password(_SERVICE, account) != key:
            raise SubscriptionStoreError()
    if not key:
        raise SubscriptionStoreError()
    return Fernet(key.encode("ascii"))


def _empty_state() -> dict:
    return {"active_id": None, "accounts": {}}


def _payload(conn: sqlite3.Connection) -> bytes | None:
    table = conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'state'").fetchone()
    if table is None:
        return None
    row = conn.execute("SELECT payload FROM state WHERE id = 1").fetchone()
    return row[0] if row is not None else None


def _decode(payload: bytes, cipher: Fernet) -> dict:
    state = json.loads(cipher.decrypt(payload))
    _validate(state)
    return state


def _validate(state: dict) -> None:
    if (
        not isinstance(state, dict)
        or "active_id" not in state
        or (state["active_id"] is not None and not isinstance(state["active_id"], str))
        or not isinstance(state.get("accounts"), dict)
        or not all(isinstance(account, dict) for account in state["accounts"].values())
    ):
        raise SubscriptionStoreError()


def read_state(workspace_db: Path) -> dict:
    """Read the last committed snapshot; never initialize an empty workspace."""
    try:
        path = _workspace_vault(workspace_db)
        try:
            path.stat()
        except FileNotFoundError:
            return _empty_state()
        # Open without creating a new database, but allow SQLite to recover
        # a hot rollback journal if a previous writer died during commit.
        with closing(sqlite3.connect(f"{path.absolute().as_uri()}?mode=rw", uri=True)) as conn:
            payload = _payload(conn)
        return _empty_state() if payload is None else _decode(payload, _cipher(path))
    except Exception:
        raise SubscriptionStoreError() from None


async def _run_io(function: Callable[[], _T]) -> _T:
    # Do not close a SQLite connection while its worker thread is still
    # using it. A cancelled waiter never leaves a transaction behind.
    job = asyncio.create_task(asyncio.to_thread(function))
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


@asynccontextmanager
async def edit_state(workspace_db: Path) -> AsyncIterator[dict]:
    """Serialize writers per workspace across processes and across awaits."""
    conn: sqlite3.Connection | None = None

    def begin() -> tuple[Fernet, dict] | None:
        nonlocal conn
        path = _workspace_vault(workspace_db)
        conn = _connect(path, timeout=0)
        try:
            conn.execute("BEGIN IMMEDIATE")
        except sqlite3.OperationalError as exc:
            if exc.sqlite_errorcode not in (sqlite3.SQLITE_BUSY, sqlite3.SQLITE_LOCKED):
                raise
            close()
            return None
        # Allow readers reaching the tiny write/commit window to finish. The
        # potentially long wait for another writer is always async polling.
        conn.execute("PRAGMA busy_timeout = 5000")
        payload = _payload(conn)
        cipher = _cipher(path, create=payload is None)
        return cipher, _empty_state() if payload is None else _decode(payload, cipher)

    def close() -> None:
        nonlocal conn
        if conn is not None:
            conn.close()  # implicitly rolls back an uncommitted transaction
            conn = None

    try:
        try:
            while (snapshot := await _run_io(begin)) is None:
                await asyncio.sleep(_LOCK_RETRY_SECONDS)
        except Exception:
            raise SubscriptionStoreError() from None
        cipher, state = snapshot
        yield state

        def save() -> None:
            assert conn is not None
            _validate(state)
            raw = json.dumps(state, ensure_ascii=True, allow_nan=False).encode("ascii")
            payload = cipher.encrypt(raw)
            conn.execute("CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY, payload BLOB NOT NULL)")
            conn.execute("INSERT OR REPLACE INTO state (id, payload) VALUES (1, ?)", (payload,))
            conn.commit()

        try:
            await _run_io(save)
        except Exception:
            raise SubscriptionStoreError() from None
    finally:
        try:
            await _run_io(close)
        except Exception:
            raise SubscriptionStoreError() from None
