"""Current product identity and narrowly scoped historical compatibility."""
from __future__ import annotations

import os
from pathlib import Path


DATABASE_NAME = "tuantuan.db"
LEGACY_DATABASE_NAMES = ("careerloop.db", "bosscopilot.db")
LEGACY_KEYRING_SERVICE = "com.careerloop.app"
LEGACY_ATTACHMENT_BUCKET = "careerloop-attachments"
_LEGACY_DISPLAY_NAMES = {"careerloop", "bosscopilot", "dengdeng", "灯灯"}


def env(name: str, default: str | None = None) -> str | None:
    """Prefer explicitly configured current names, including empty values."""
    if name in os.environ:
        return os.environ[name]
    if name.startswith("TUANTUAN_"):
        suffix = name.removeprefix("TUANTUAN_")
        for prefix in ("CAREERLOOP_", "DENGDENG_"):
            legacy = prefix + suffix
            if legacy in os.environ:
                return os.environ[legacy]
    return default


def display_name(value: str) -> str:
    return "团团" if value.strip().casefold() in _LEGACY_DISPLAY_NAMES else value


def adopt_database(root: Path) -> Path:
    """Move an offline SQLite database together with its WAL/SHM sidecars."""
    target = root / DATABASE_NAME
    if target.exists():
        return target
    for name in LEGACY_DATABASE_NAMES:
        source = root / name
        if not source.exists():
            continue
        # Do not overwrite orphaned destination sidecars: they may contain data.
        if any(Path(f"{target}{suffix}").exists() for suffix in ("-wal", "-shm")):
            raise FileExistsError(f"SQLite sidecars already exist for {target}")
        moved: list[tuple[Path, Path]] = []
        try:
            for suffix in ("", "-wal", "-shm"):
                old, new = Path(f"{source}{suffix}"), Path(f"{target}{suffix}")
                if old.exists():
                    old.rename(new)
                    moved.append((old, new))
        except OSError:
            for old, new in reversed(moved):
                new.rename(old)
            raise
        break
    return target
