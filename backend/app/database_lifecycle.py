from __future__ import annotations

import shutil
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from . import db as db_module
from .branding import display_name


REBUILD_CONFIRMATION = "确认重建团团数据库"


def _resolved_db_path(db_path: str | Path | None = None) -> Path:
    if db_path is not None:
        return Path(db_path)
    from .workspace import current_workspace_db, resolve_db_path

    return current_workspace_db() or resolve_db_path()


def database_status(db_path: str | Path | None = None) -> dict[str, Any]:
    path = _resolved_db_path(db_path)
    if not path.exists() or path.stat().st_size == 0:
        return {
            "status": "uninitialized",
            "schema_version": None,
            "required_schema_version": db_module.DB_SCHEMA_VERSION,
            "database_path": str(path),
        }
    try:
        conn = sqlite3.connect(path)
        tables = {
            str(row[0])
            for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
        }
        versions = (
            [int(row[0]) for row in conn.execute("SELECT version FROM schema_migrations")]
            if "schema_migrations" in tables
            else []
        )
    except sqlite3.DatabaseError as exc:
        return {
            "status": "requires_rebuild",
            "schema_version": None,
            "required_schema_version": db_module.DB_SCHEMA_VERSION,
            "database_path": str(path),
            "reason": f"数据库无法读取：{exc}",
        }
    finally:
        if "conn" in locals():
            conn.close()
    current = max(versions, default=0)
    return {
        "status": "ready" if current >= db_module.DB_SCHEMA_VERSION else "requires_rebuild",
        "schema_version": current or None,
        "required_schema_version": db_module.DB_SCHEMA_VERSION,
        "database_path": str(path),
        "reason": "" if current >= db_module.DB_SCHEMA_VERSION else "检测到团团当前版本之前的本地数据库",
    }


def initialize_or_report(db_path: str | Path | None = None) -> dict[str, Any]:
    if db_path is not None:
        status = database_status(db_path)
        if status["status"] == "uninitialized":
            db_module.init_db(db_path)
            return database_status(db_path)
        if status["status"] == "requires_rebuild" and status["schema_version"] is not None:
            db_module.init_db(db_path)
            return database_status(db_path)
        return status

    db_module.adopt_legacy_database()
    from .workspace import auth_db_path, existing_workspace_roots, migrate_legacy_workspaces, workspace_db_path

    migrate_legacy_workspaces()
    roots = existing_workspace_roots()
    if roots:
        last = None
        for root in roots:
            last = initialize_or_report(workspace_db_path(root))
        return last or database_status(workspace_db_path(roots[0]))
    if db_module.DB_PATH.exists() and db_module.DB_PATH.resolve() != auth_db_path().resolve():
        return initialize_or_report(db_module.DB_PATH)
    return {
        "status": "ready",
        "schema_version": db_module.DB_SCHEMA_VERSION,
        "required_schema_version": db_module.DB_SCHEMA_VERSION,
        "database_path": str(auth_db_path()),
    }


def rebuild_database_v2(
    confirmation: str,
    db_path: str | Path | None = None,
) -> dict[str, Any]:
    if confirmation != REBUILD_CONFIRMATION and display_name(confirmation.removeprefix("确认重建").removesuffix("数据库")) != "团团":
        raise ValueError("需要明确确认后才能备份并重建数据库")
    path = _resolved_db_path(db_path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    backup_path: Path | None = None
    if path.exists() and path.stat().st_size:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S-%f")
        backup_path = path.with_name(f"{path.stem}.pre-v2-{stamp}{path.suffix}")
        source = sqlite3.connect(path)
        backup = sqlite3.connect(backup_path)
        try:
            source.backup(backup)
        finally:
            backup.close()
            source.close()
        backup_path.chmod(0o600)
    for candidate in (path, Path(f"{path}-wal"), Path(f"{path}-shm")):
        candidate.unlink(missing_ok=True)
    try:
        db_module.init_db(path)
    except Exception:
        if backup_path is not None and backup_path.exists():
            shutil.copy2(backup_path, path)
        raise
    return {
        **database_status(path),
        "backup_path": str(backup_path) if backup_path is not None else None,
    }
