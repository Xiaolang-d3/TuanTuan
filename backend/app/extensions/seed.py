from __future__ import annotations

from pathlib import Path

from .repository import ExtensionRepository
from .skills import parse_skill

BUILTIN_SKILLS: tuple[str, ...] = ("ppt-master",)
BUILTIN_DIR = Path(__file__).parent / "builtin"


def seed_builtin_extensions(db_path=None) -> None:
    """Install packaged skills as stable catalog rows.

    Idempotent: a row is created once with a fixed id, its content and revision
    follow the packaged file on later starts, and a user's disable/delete choice
    is never overridden.
    """
    repository = ExtensionRepository()
    for item_id in BUILTIN_SKILLS:
        source = BUILTIN_DIR / item_id / "SKILL.md"
        if not source.is_file():
            continue
        metadata, content = parse_skill(source.read_text(encoding="utf-8"))
        metadata = {**metadata, "source": "builtin", "provider": "builtin"}
        repository.seed_builtin("skill", item_id, metadata, content, db_path=db_path)
