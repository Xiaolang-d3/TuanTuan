from __future__ import annotations

from .branding import LEGACY_DATABASE_NAMES, env

import json
import os
import sqlite3
from contextlib import contextmanager
from collections.abc import Iterator
from pathlib import Path
from typing import Any, Iterable


ROOT_DIR = Path(__file__).resolve().parents[1]
# Desktop bundles are read-only after installation.  Let the launcher put all
# mutable state in the operating system's per-user application-data directory,
# while keeping the repository-local default for development and self-hosting.
DATA_DIR = Path(env("TUANTUAN_DATA_DIR", ROOT_DIR / "data")).expanduser()
DB_PATH = DATA_DIR / "tuantuan.db"
LEGACY_DB_PATH = DATA_DIR / LEGACY_DATABASE_NAMES[-1]
DB_SCHEMA_VERSION = 31


def adopt_legacy_database() -> None:
    """Adopt historical instance databases before initializing current storage."""
    from .branding import adopt_database

    adopt_database(DB_PATH.parent)


@contextmanager
def connect(db_path: str | Path | None = None) -> Iterator[sqlite3.Connection]:
    if db_path is not None:
        path = Path(db_path)
    else:
        from .workspace import resolve_db_path

        path = resolve_db_path()
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        path.parent.chmod(0o700)
    except OSError:
        pass
    conn = sqlite3.connect(path, timeout=10)
    try:
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA foreign_keys = ON")
        conn.execute("PRAGMA busy_timeout = 10000")
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
        try:
            path.chmod(0o600)
        except OSError:
            pass


def init_db(db_path: str | Path | None = None) -> None:
    from .persistence.upgrades import initialize_workspace
    initialize_workspace(db_path)


def row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    if row is None:
        return None
    result = dict(row)
    for key, value in list(result.items()):
        if key.endswith("_json") and isinstance(value, str):
            result[key.removesuffix("_json")] = json.loads(value or "[]")
            del result[key]
        elif key == "raw_json" and isinstance(value, str):
            result["raw"] = json.loads(value or "{}")
            del result[key]
    return result

def rows_to_dicts(rows: Iterable[sqlite3.Row]) -> list[dict[str, Any]]:
    return [row_to_dict(row) for row in rows if row is not None]

def json_dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)
