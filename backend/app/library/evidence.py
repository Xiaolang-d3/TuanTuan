"""Server-issued local citations. IDs are references, never access credentials."""
from __future__ import annotations

import json
from hashlib import sha256

from ..documents.blocks import DocumentTarget
from .source_versions import get_attachment_version, get_source_version

TRUSTED_EVIDENCE_TOOLS = {"get_library_context", "search_library", "read_library_source"}


def _resolve(target, db_path=None, *, conversation_id=None, automatic=False):
    if target.source_kind == "library":
        from .project_scope import project_source_ids
        from .sources import get_source
        selected = project_source_ids(conversation_id, db_path)
        if selected is not None and target.source_id not in selected:
            raise ValueError("未选择此项目资料，或资料已不可用")
        source = get_source(target.source_id, db_path)
        if automatic and not source["enabled"]:
            raise ValueError("来源已关闭长期使用")
        version = get_source_version(target.source_id, target.source_revision, db_path)
        return source, version, source["privacy_mode"] == "original"
    from ..attachments.service import get_attachment
    source = get_attachment(target.attachment_id, db_path=db_path)
    version = get_attachment_version(target.attachment_id, target.source_revision, db_path, conversation_id=conversation_id)
    original = (source.get("metadata") or {}).get("privacy_mode") == "original"
    return source, version, original


def _block(version, block_id):
    block = next((b for b in version["blocks"] if b["block_id"] == block_id), None)
    if block is None:
        raise ValueError("引用片段不属于此资料版本")
    return block


def evidence_for_target(target: DocumentTarget, block_id: str, db_path=None, *, conversation_id=None, automatic=None):
    automatic = target.source_kind == "library" if automatic is None else automatic
    source, version, original = _resolve(target, db_path, conversation_id=conversation_id, automatic=automatic)
    block = _block(version, block_id)
    return _evidence_card(target, source, block, original=original, automatic=automatic)


def _evidence_card(target, source, block, *, original, automatic):
    """Build from an already authorized version without reloading its full JSON."""
    excerpt = block["text"] if original else block["model_text"]
    identity = target.model_dump(exclude_none=True)
    excerpt_hash = sha256(excerpt.encode()).hexdigest()
    citation_id = "e_" + sha256(json.dumps([identity, block["block_id"], excerpt_hash], sort_keys=True).encode()).hexdigest()[:32]
    return {**identity, **({"conversation_id": source["conversation_id"]} if target.source_kind == "attachment" else {}),
            "citation_id": citation_id, "block_id": block["block_id"],
            "title": str(source.get("title") or source.get("original_filename") or "资料")[:200],
            "locator": block["locator"], "excerpt": excerpt, "excerpt_hash": excerpt_hash,
            "usage": "automatic" if automatic else "explicit"}


def validate_evidence(card, db_path=None, *, conversation_id=None):
    if not isinstance(card, dict):
        return False
    try:
        target = DocumentTarget(**{key: card[key] for key in ("source_kind", "source_id", "attachment_id", "source_revision") if key in card})
        expected = evidence_for_target(target, card["block_id"], db_path, conversation_id=conversation_id,
                                       automatic=target.source_kind == "library")
        return all(card.get(key) == expected[key] for key in ("citation_id", "excerpt", "excerpt_hash", "locator"))
    except (ValueError, KeyError, TypeError):
        return False


def target_evidence(target, db_path=None, *, conversation_id=None, max_characters=12000, max_blocks=40):
    source, version, original = _resolve(target, db_path, conversation_id=conversation_id, automatic=target.source_kind == "library")
    cards, used = [], 0
    for block in version["blocks"]:
        card = _evidence_card(target, source, block, original=original, automatic=target.source_kind == "library")
        if len(cards) >= max_blocks or used + len(card["excerpt"]) > max_characters:
            break
        cards.append(card)
        used += len(card["excerpt"])
    return cards


def bounded_evidence_data(cards, extras=None, *, max_data_chars=31000):
    """Admit whole records before generic governance; never truncate identities."""
    extras = extras or {}
    result = {"evidence": [], "confirmed_facts": [], "sources": [], "legacy_excerpts": [],
              "document_truncated": bool(extras.get("document_truncated")), "has_more": False}
    if extras.get("disabled"):
        result["disabled"] = True
    if extras.get("profile"):
        result["profile"] = {"name": str(extras["profile"].get("name", ""))[:200]}
    def admit(key, item):
        candidate = {**result, key: [*result[key], item]}
        if len(json.dumps(candidate, ensure_ascii=False)) > max_data_chars or len(candidate[key]) > 40:
            result["has_more"] = True
            return False
        result[key].append(item)
        return True
    for card in cards:
        if not admit("evidence", card):
            break
    for fact in extras.get("confirmed_facts", [])[:20]:
        statement = str(fact.get("statement") or "")
        if not admit("confirmed_facts", {"id": fact.get("id"), "statement": statement[:900], "truncated": len(statement) > 900}):
            break
    for item in extras.get("legacy_excerpts", [])[:20]:
        if not admit("legacy_excerpts", {"text": str(item)[:900], "precise": False}):
            break
    for source in extras.get("sources", [])[:20]:
        item = {key: source[key] for key in ("id", "source_revision", "privacy_mode") if key in source}
        item["title"] = str(source.get("title") or "资料")[:200]
        if not admit("sources", item):
            break
    return result


def preview_block(target, block_id, db_path=None, *, conversation_id=None):
    source, version, _ = _resolve(target, db_path, conversation_id=conversation_id)
    block = _block(version, block_id)
    original = {"available": False, "reason": "没有可预览原文件"}
    original_kind, original_id = target.source_kind, target.source_id or target.attachment_id
    metadata = source.get("metadata") or {}
    if target.source_kind == "attachment" and metadata.get("library_source_id"):
        original_kind, original_id = "library", metadata["library_source_id"]
    try:
        if original_kind == "library":
            from .sources import get_source_file
            if metadata.get("library_source_revision"):
                get_source_version(original_id, metadata["library_source_revision"], db_path)
            _, filename, mime = get_source_file(original_id, db_path)
        else:
            from ..attachments.service import get_attachment_download
            _, filename, mime = get_attachment_download(original_id, db_path=db_path)
        original = {"available": True, "source_kind": original_kind, "filename": filename, "mime_type": mime,
                    "source_id" if original_kind == "library" else "attachment_id": original_id}
    except (ValueError, OSError, RuntimeError) as exc:
        original["reason"] = str(exc)
    return {**target.model_dump(exclude_none=True), "block_id": block_id, "title": source.get("title") or source.get("original_filename"),
            "locator": block["locator"], "text": block["text"], "model_text": block["model_text"],
            "is_current": version["is_current"], "original": original}
