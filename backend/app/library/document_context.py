"""Reassemble document input from immutable versions, including old checkpoints."""
from __future__ import annotations

import json

from ..db import connect
from ..documents.blocks import DocumentTarget
from ..domain import AgentMessage
from ..attachments.service import get_attachment
from .source_versions import source_state
from .project_scope import project_source_ids
from .evidence import _resolve, _evidence_card, bounded_evidence_data, TRUSTED_EVIDENCE_TOOLS

ATTACHMENT_PREFIX = "\n\n以下为用户主动上传附件的本地解析文本，请基于此内容回答：\n"
DOCUMENT_CONTEXT_CHARACTERS = 12000
SHORT_DOCUMENT_CHARACTERS = 4000


def attachment_document_context(conversation_id, refs, *, max_characters=DOCUMENT_CONTEXT_CHARACTERS):
    parts, cards, targets, ids = [], [], [], []
    remaining = max_characters
    for ref in refs:
        attachment_id = ref.get("attachment_id") or ref.get("id")
        if not isinstance(attachment_id, str) or attachment_id in ids:
            continue
        attachment = get_attachment(attachment_id)
        if (not attachment or attachment["conversation_id"] != conversation_id or attachment["kind"] != "document"
                or attachment["parse_status"] != "parsed"):
            continue
        revision = ref.get("source_revision") or source_state("attachment", attachment_id)["source_revision"]
        header = f"[脱敏资料：{attachment['original_filename']}]\n"
        ids.append(attachment_id)
        if not revision:
            excerpt = attachment["redacted_text"][:min(remaining, SHORT_DOCUMENT_CHARACTERS)]
            parts.append(header + excerpt + "\n旧附件定位版本待回填；此处仅为有限预览，不能视为已读取全文。")
            remaining -= len(excerpt)
            continue
        target = DocumentTarget(source_kind="attachment", attachment_id=attachment_id, source_revision=revision)
        try:
            source, version, original = _resolve(target, conversation_id=conversation_id)
        except ValueError:
            parts.append(header + "该历史版本已不可用；不能用当前版本冒充原文。")
            continue
        identity = target.model_dump(exclude_none=True)
        targets.append(identity)
        full = version["text"] if original else version["redacted_text"]
        allowance = min(remaining, SHORT_DOCUMENT_CHARACTERS)
        chosen, used = [], 0
        for block in version["blocks"]:
            card = _evidence_card(target, source, block, original=original, automatic=False)
            if used + len(card["excerpt"]) > allowance or len(chosen) >= 20:
                break
            chosen.append(card)
            used += len(card["excerpt"])
        if len(full) <= allowance:
            # Preserve exact short-attachment text, including older history layout.
            body = full
            used = len(full)
        else:
            body = ("本轮仅提供有限片段，不能据此声称读完全文。可用 search_library 定向检索，或 read_library_source 分页读取。\n"
                    + "\n".join(f"{c['excerpt']} [[cite:{c['citation_id']}]]" for c in chosen)
                    + "\n版本句柄：" + json.dumps(identity, ensure_ascii=False))
        parts.append(header + body)
        cards.extend(chosen)
        remaining -= used
    return "\n\n".join(parts), cards, targets, ids


def _legacy_refs(message, conversation_id):
    request, marker, _ = message.content.partition(ATTACHMENT_PREFIX)
    if not marker or conversation_id is None:
        return []
    # A legacy checkpoint may have no attachment IDs. Use only an unambiguous
    # persisted user request; never guess among different attachment selections.
    with connect() as conn:
        rows = conn.execute("""SELECT payload_json FROM chat_messages WHERE conversation_id=?
            AND role='user' AND content=? AND payload_json LIKE '%"attachments"%'
            AND id>COALESCE((SELECT context_cutoff_message_id FROM conversations WHERE id=?),0)""",
            (conversation_id, request, conversation_id)).fetchall()
    selections = {}
    for row in rows:
        refs = json.loads(row["payload_json"]).get("attachments", [])
        key = json.dumps([(r.get("id"), r.get("source_revision")) for r in refs], sort_keys=True)
        selections[key] = refs
    return next(iter(selections.values())) if len(selections) == 1 else []


def document_targets_in_messages(messages, conversation_id):
    targets = {}
    for message in messages:
        if message.role != "user":
            continue
        refs = (message.payload.get("document_targets") or message.payload.get("evidence")
                or [{"id": item} for item in message.payload.get("document_attachment_ids", [])]
                or _legacy_refs(message, conversation_id))
        for ref in refs:
            if not isinstance(ref, dict) or ref.get("source_kind", "attachment") != "attachment":
                continue
            attachment_id = ref.get("attachment_id") or ref.get("id")
            if isinstance(attachment_id, str):
                revision = ref.get("source_revision") or source_state("attachment", attachment_id)["source_revision"]
                if revision:
                    target = {"source_kind": "attachment", "attachment_id": attachment_id, "source_revision": revision}
                    targets[(attachment_id, revision)] = target
    return list(targets.values())


def bounded_document_messages(messages, conversation_id, *, library_read_allowed=True, db_path=None):
    remaining, result = DOCUMENT_CONTEXT_CHARACTERS, []
    scope_checked = False
    selected_sources = None
    for message in reversed(messages):
        payload = message.payload
        refs = document_targets_in_messages([message], conversation_id) if message.role == "user" else []
        request, marker, _ = message.content.partition(ATTACHMENT_PREFIX)
        if refs and not payload.get("retained_evidence"):
            text, cards, targets, ids = attachment_document_context(conversation_id, refs, max_characters=remaining)
            remaining -= sum(len(card["excerpt"]) for card in cards)
            updated = {**payload, "document_targets": targets, "document_attachment_ids": ids, "evidence": cards}
            message = message.model_copy(update={"content": request + (ATTACHMENT_PREFIX + text if text else ""), "payload": updated})
        elif marker and (conversation_id is not None or len(message.content) > SHORT_DOCUMENT_CHARACTERS):
            # No reliable identity: discard the body instead of replaying an
            # unbounded and potentially revoked legacy source string.
            message = message.model_copy(update={"content": request + "\n历史附件缺少可核对版本，请重新选择资料。", "payload": {}})
        elif ((message.role == "tool" or payload.get("retained_evidence"))
              and (payload.get("tool_name") in TRUSTED_EVIDENCE_TOOLS
                   or (message.role == "user" and payload.get("retained_evidence")))):
            from ..agent.settings import get_agent_settings
            if not scope_checked:
                selected_sources = project_source_ids(conversation_id, db_path)
                scope_checked = True
            settings = get_agent_settings(db_path)
            permitted, used = [], 0
            for card in payload.get("evidence", []):
                try:
                    target = DocumentTarget(**{k: card[k] for k in ("source_kind", "source_id", "attachment_id", "source_revision") if k in card})
                    if target.source_kind == "library" and (not library_read_allowed or not settings["library_memory_enabled"] or not settings["knowledge_memory_enabled"]):
                        continue
                    source, version, original = _resolve(target, db_path, conversation_id=conversation_id, automatic=target.source_kind == "library")
                    block = next(b for b in version["blocks"] if b["block_id"] == card["block_id"])
                    current = _evidence_card(target, source, block, original=original, automatic=target.source_kind == "library")
                    if any(card.get(k) != current[k] for k in ("citation_id", "excerpt", "excerpt_hash", "locator")):
                        continue
                    if used + len(card["excerpt"]) > remaining:
                        break
                    permitted.append(card)
                    used += len(card["excerpt"])
                except (ValueError, KeyError, TypeError, StopIteration):
                    continue
            if selected_sources is None and payload.get("tool_name") == "read_library_source" and len(permitted) == len(payload.get("evidence", [])) and permitted:
                remaining -= used
            else:
                extras = payload if library_read_allowed and selected_sources is None else {}
                data = {**bounded_evidence_data(permitted, extras), "tool_name": payload.get("tool_name"), "status": payload.get("status")}
                if payload.get("retained_evidence"):
                    data["retained_evidence"] = True
                data["history_reassembled"] = True
                data["notice"] = "历史资料仅保留本轮获准片段；缺少精确版本时请用工具重新读取。"
                remaining -= used
                message = message.model_copy(update={"content": json.dumps(data, ensure_ascii=False), "payload": data})
        result.append(message)
    return list(reversed(result))
