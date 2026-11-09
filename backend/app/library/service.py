"""Current library read model and privacy-aware model context."""
from __future__ import annotations

from pathlib import Path
from typing import Any

from .repository import get_metadata
from .knowledge import list_knowledge
from .sources import enabled_source_details, list_sources
from .organization import list_folders
from .collections import list_collections
from ..agent.settings import get_agent_settings
from ..privacy import scan_and_redact


def get_library(db_path: str | Path | None = None) -> dict[str, Any]:
    stored = get_metadata(db_path)
    return {
        "profile": {key: stored[key] for key in ("name", "privacy_mode", "knowledge_revision")} if stored else None,
        "facts": [fact for fact in list_knowledge(db_path=db_path) if fact["status"] in {"pending", "confirmed"}
                  and fact["category"] not in {"career_goal", "career_strategy", "job_preference"}],
        "sources": list_sources(db_path),
        "folders": list_folders(db_path),
        "collections": list_collections(db_path),
    }


def model_context(db_path: str | Path | None = None) -> dict[str, Any]:
    settings = get_agent_settings(db_path)
    if not settings["library_memory_enabled"]:
        return {"document": "", "confirmed_facts": [], "sources": [], "disabled": True}
    bundle = get_library(db_path)
    profile = bundle["profile"]
    facts = [
        {"id": fact["id"], "statement": fact["statement"]}
        for fact in bundle["facts"] if fact["status"] == "confirmed"
    ] if settings["knowledge_memory_enabled"] else []
    facts = [{**fact, "statement": scan_and_redact(fact["statement"])[1]} for fact in facts]
    sources = enabled_source_details(db_path)
    excerpts: list[str] = []
    evidence: list[dict] = []
    legacy_excerpts: list[str] = []
    remaining = 12_000
    for source in sources:
        if remaining <= 0:
            break
        content = str(
            source.get("content")
            if source.get("privacy_mode") == "original"
            else source.get("redacted_content")
            or ""
        ).strip()
        if not content:
            continue
        excerpt = content[: min(4_000, remaining)]
        excerpts.append(f"## {source.get('title') or '资料'}\n{excerpt}")
        if source.get("source_revision"):
            from ..documents.blocks import DocumentTarget
            from .evidence import target_evidence
            evidence.extend(target_evidence(DocumentTarget(source_kind="library", source_id=source["id"], source_revision=source["source_revision"]), db_path,
                                            max_characters=min(4000, remaining)))
        else:
            legacy_excerpts.extend(excerpt[start:start + 900] for start in range(0, len(excerpt), 900))
        remaining -= len(excerpt)
    return {
        "document": "\n\n".join(excerpts),
        "document_truncated": any(
            len(str(source.get("content") or "")) > 4_000 for source in sources
        ) or remaining <= 0,
        "confirmed_facts": facts[:100],
        "evidence": evidence,
        "legacy_excerpts": legacy_excerpts,
        "sources": [
            {
                "id": source["id"],
                "title": source["title"],
                "privacy_mode": source["privacy_mode"],
                "source_revision": source.get("source_revision"),
            }
            for source in sources
        ],
        "profile": {"name": profile["name"]} if profile else None,
    }
