"""Per-user workspace routing.

Business data stays in a single-tenant SQLite schema. Isolation comes from
pointing ``connect()`` and current document/attachment storage at
``<data>/workspaces/<user_id>/`` for the authenticated request.
"""

from __future__ import annotations

import sqlite3
import threading
from contextlib import contextmanager
from contextvars import ContextVar
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Any

from . import db as db_module
from .branding import DATABASE_NAME, LEGACY_DATABASE_NAMES, adopt_database


def workspace_db_path(root: Path) -> Path:
    return adopt_database(root)


_user_id: ContextVar[int | None] = ContextVar("workspace_user_id", default=None)
_root: ContextVar[Path | None] = ContextVar("workspace_root", default=None)


def data_dir() -> Path:
    return db_module.DB_PATH.parent


def auth_db_path() -> Path:
    return data_dir() / "auth.db"


def workspaces_dir() -> Path:
    return data_dir() / "workspaces"


def workspace_root_for(user_id: int) -> Path:
    return workspaces_dir() / str(user_id)


def current_user_id() -> int | None:
    return _user_id.get()


def current_workspace_root() -> Path | None:
    return _root.get()


def current_workspace_db() -> Path | None:
    root = _root.get()
    return workspace_db_path(root) if root is not None else None


def snapshot_workspace() -> tuple[int | None, Path | None]:
    return _user_id.get(), _root.get()


@contextmanager
def use_workspace(user_id: int, root: Path | None = None) -> Iterator[Path]:
    resolved = Path(root) if root is not None else workspace_root_for(user_id)
    token_user = _user_id.set(user_id)
    token_root = _root.set(resolved)
    try:
        yield resolved
    finally:
        _user_id.reset(token_user)
        _root.reset(token_root)


def init_auth_db() -> None:
    path = auth_db_path()
    with db_module.connect(path) as conn:
        from .persistence.schema import AUTH_SCHEMA
        conn.executescript(AUTH_SCHEMA)
        columns = {row["name"] for row in conn.execute("PRAGMA table_info(users)")}
        if "display_name" not in columns:
            conn.execute("ALTER TABLE users ADD COLUMN display_name TEXT NOT NULL DEFAULT ''")
        if "avatar_relpath" not in columns:
            conn.execute("ALTER TABLE users ADD COLUMN avatar_relpath TEXT NOT NULL DEFAULT ''")


def list_user_ids() -> list[int]:
    path = auth_db_path()
    if not path.exists():
        return []
    with db_module.connect(path) as conn:
        tables = {
            str(row[0])
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
        }
        if "users" not in tables:
            return []
        rows = conn.execute("SELECT id FROM users ORDER BY id ASC").fetchall()
    return [int(row["id"]) for row in rows]


def existing_workspace_roots() -> list[Path]:
    root = workspaces_dir()
    if not root.exists():
        return []
    return sorted(
        path
        for path in root.iterdir()
        if path.is_dir() and any((path / name).exists() for name in (DATABASE_NAME, *LEGACY_DATABASE_NAMES))
    )


def single_workspace_root() -> Path | None:
    roots = existing_workspace_roots()
    return roots[0] if len(roots) == 1 else None


def resolve_db_path(explicit: str | Path | None = None) -> Path:
    if explicit is not None:
        return Path(explicit)
    current = current_workspace_db()
    if current is not None:
        return current
    if db_module.DB_PATH.exists():
        return db_module.DB_PATH
    only = single_workspace_root()
    if only is not None:
        return workspace_db_path(only)
    return db_module.DB_PATH


def resolve_document_dir(explicit: str | Path | None = None) -> Path:
    if explicit is not None:
        resolved = Path(explicit)
        return resolved.parent if resolved.suffix else resolved
    current = current_workspace_root()
    if current is not None:
        return current
    if (data_dir() / "career-profile.md").exists():
        return data_dir()
    only = single_workspace_root()
    if only is not None:
        return only
    return data_dir()


def attachments_dir() -> Path:
    current = current_workspace_root()
    if current is not None:
        return current / "attachments"
    only = single_workspace_root()
    if only is not None:
        return only / "attachments"
    return data_dir() / "attachments"


def _move_path(source: Path, destination: Path) -> None:
    if not source.exists() or source.resolve() == destination.resolve():
        return
    destination.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if destination.exists():
        return
    source.rename(destination)


def _move_sqlite(source: Path, destination: Path) -> None:
    if not source.exists() or source.resolve() == destination.resolve():
        return
    if source.resolve() == auth_db_path().resolve():
        return
    _move_path(source, destination)
    for suffix in ("-wal", "-shm"):
        sidecar = Path(f"{source}{suffix}")
        if sidecar.exists():
            sidecar.rename(Path(f"{destination}{suffix}"))


def _legacy_payload_exists() -> bool:
    if db_module.DB_PATH.exists() and db_module.DB_PATH.stat().st_size > 0:
        if db_module.DB_PATH.resolve() == auth_db_path().resolve():
            return False
        return True
    if (data_dir() / "career-profile.md").exists():
        return True
    attachments = data_dir() / "attachments"
    return attachments.exists() and any(attachments.iterdir())


def adopt_legacy_into(root: Path) -> None:
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    _move_sqlite(db_module.DB_PATH, workspace_db_path(root))
    _move_path(data_dir() / "career-profile.md", root / "career-profile.md")
    _move_path(data_dir() / "attachments", root / "attachments")


def migrate_users_from_legacy_db() -> None:
    """Copy ``users`` rows out of a pre-split instance database into auth.db."""
    init_auth_db()
    source = db_module.DB_PATH
    if not source.exists() or source.resolve() == auth_db_path().resolve():
        return
    try:
        with db_module.connect(source) as conn:
            tables = {
                str(row[0])
                for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
            }
            if "users" not in tables:
                return
            rows = conn.execute(
                "SELECT id, email, password_hash, created_at FROM users"
            ).fetchall()
    except sqlite3.DatabaseError:
        return
    if not rows:
        return
    with db_module.connect(auth_db_path()) as dest:
        if dest.execute("SELECT 1 FROM users LIMIT 1").fetchone() is not None:
            return
        for row in rows:
            dest.execute(
                "INSERT INTO users (id, email, password_hash, created_at) VALUES (?, ?, ?, ?)",
                (row["id"], row["email"], row["password_hash"], row["created_at"]),
            )


def ensure_workspace(user_id: int) -> Path:
    """Create or adopt the on-disk workspace for ``user_id`` and apply migrations."""
    root = workspace_root_for(user_id)
    db_file = workspace_db_path(root)
    if not db_file.exists() and _legacy_payload_exists() and list_user_ids()[:1] == [user_id]:
        adopt_legacy_into(root)
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    db_module.init_db(workspace_db_path(root))
    return root


def migrate_legacy_workspaces() -> None:
    """On startup: extract users, then give the first account any leftover instance data."""
    init_auth_db()
    migrate_users_from_legacy_db()
    user_ids = list_user_ids()
    if not user_ids:
        return
    for user_id in user_ids:
        ensure_workspace(user_id)


def bind_workspace(target: Callable[..., Any], *args: Any, **kwargs: Any) -> Callable[[], None]:
    """Bind a callable to the current workspace for FastAPI BackgroundTasks."""
    user_id, root = snapshot_workspace()

    def runner() -> None:
        if user_id is not None and root is not None:
            with use_workspace(user_id, root):
                target(*args, **kwargs)
            return
        target(*args, **kwargs)

    return runner


def spawn_thread(
    target: Callable[..., Any],
    *,
    name: str | None = None,
    args: tuple[Any, ...] = (),
    kwargs: dict[str, Any] | None = None,
) -> threading.Thread:
    """Start a daemon thread that keeps the current workspace context."""
    user_id, root = snapshot_workspace()
    payload = kwargs or {}

    def runner() -> None:
        if user_id is not None and root is not None:
            with use_workspace(user_id, root):
                target(*args, **payload)
            return
        target(*args, **payload)

    thread = threading.Thread(target=runner, daemon=True, name=name)
    thread.start()
    return thread
