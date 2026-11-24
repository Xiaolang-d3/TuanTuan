"""跨会话用户记忆的存储、抽取与去重合并。

正常完成的聊天轮次落库后调度后台抽取；重置可重试仍未处理的会话消息。
所有模型调用可通过注入 generate 替换（测试用），失败不影响主对话。
"""
from __future__ import annotations

import asyncio
import json
import re
import sqlite3
from pathlib import Path
from threading import Lock
from time import perf_counter
from typing import Any, Callable
from weakref import WeakValueDictionary

from ...config import get_settings
from ...db import connect, json_dump, row_to_dict, rows_to_dicts
from ...domain import AgentMessage, AgentRunResult, ModelRequest
from ...knowledge.embeddings import embed_text, get_embedder
from ...observability.model_context import model_call_scope
from ...observability.model_monitor import record_model_service_event
from ...privacy.service import scan_and_redact
from ...workspace import current_user_id, resolve_db_path
from ..model_binding import internal_model_selection
from ..settings import get_agent_settings, get_model_connection

MAX_MEMORY_ITEMS = 200
MAX_MEMORY_RULES = 50
MAX_MEMORY_SUMMARY_CHARS = 500
MAX_MEMORY_RULE_CHARS = 300
MAX_EXTRACTION_ITEMS = 8
EXTRACT_EVERY_MESSAGES = 6
EXTRACTION_CONTEXT_MESSAGES = 12
EXTRACTION_MESSAGE_CHARS = 300
EXTRACTION_MAX_EXISTING = 20
DEDUP_FASTEMBED_THRESHOLD = 0.85
DEDUP_LEXICAL_SHARED_TERMS = 2

_REDACTED_MARKER = "\n[脱敏资料："
_extraction_locks: WeakValueDictionary[tuple[Path, int], Any] = WeakValueDictionary()
_extraction_locks_guard = Lock()

EXTRACTION_PROMPT = """你是用户记忆抽取助手。请阅读下面的对话片段，提取关于用户的长期事实与偏好，供后续会话个性化使用。

要求：
1. 只输出一个严格的 JSON 数组，元素形如 {"kind": "fact", "summary": "..."} 或 {"kind": "preference", "summary": "..."}；不要输出任何其他文字。
2. "fact" 是跨会话稳定的用户事实（身份、职业、项目、环境等）；"preference" 是用户的偏好（语言、风格、习惯等）。
3. summary 用第三人称描述用户，不超过 60 字。
4. 只提取对话中明确出现的信息，不得编造；不确定的不写。
5. 不提取一次性任务本身（例如"帮我写一封邮件"不是记忆）。
6. 与"已有记忆"重复的信息不要再次输出；没有新信息时输出 []。

已有记忆：
{existing}

对话片段：
{conversation}"""

_ASCII_TERM = re.compile(r"[a-z0-9][a-z0-9.+#-]*")
_ZH_RUN = re.compile(r"[\u4e00-\u9fff]+")


class MemoryLimitError(ValueError):
    """记忆条目或规则数量达到上限。"""


def parse_extraction(text: str) -> list[dict[str, str]]:
    """宽容解析抽取输出；无可用结果时返回 []。"""
    return _parse_extraction(text) or []


def _parse_extraction(text: str) -> list[dict[str, str]] | None:
    """区分合法空数组与不可用响应，只有前者可推进游标。"""
    if not text:
        return None
    content = str(text).strip()
    if content.startswith("```"):
        content = re.sub(r"^```[a-zA-Z]*\s*", "", content)
        content = re.sub(r"\s*```$", "", content)
        content = content.strip()
    start = content.find("[")
    if start >= 0:
        end = content.rfind("]")
        if end <= start:
            return None
        try:
            items = json.loads(content[start : end + 1])
        except (ValueError, TypeError):
            return None
    else:
        try:
            payload = json.loads(content)
        except (ValueError, TypeError):
            return None
        items = payload.get("items") if isinstance(payload, dict) else payload
    if not isinstance(items, list):
        return None
    result: list[dict[str, str]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        kind = item.get("kind")
        summary = item.get("summary")
        if kind not in ("fact", "preference") or not isinstance(summary, str) or not summary.strip():
            continue
        result.append({"kind": kind, "summary": summary.strip()[:MAX_MEMORY_SUMMARY_CHARS]})
        if len(result) >= MAX_EXTRACTION_ITEMS:
            break
    return result if result or not items else None


def _embedder_key() -> str:
    spec = get_embedder().spec
    return f"{spec.backend}:{spec.model}"


def _embed_summary(summary: str) -> tuple[list[float], str]:
    try:
        return embed_text(summary), _embedder_key()
    except Exception:
        # 嵌入失败不阻断记忆存储：留空向量，检索阶段跳过该行。
        return [], ""


def _lexical_terms(text: str) -> set[str]:
    terms = set(_ASCII_TERM.findall(text.casefold()))
    for run in _ZH_RUN.findall(text):
        terms.update(run[i : i + 2] for i in range(len(run) - 1))
    return terms


def _cosine(left: list[float], right: list[float]) -> float:
    if not left or not right or len(left) != len(right):
        return 0.0
    return sum(a * b for a, b in zip(left, right))


def _dedupe_merge(
    conn: sqlite3.Connection,
    kind: str,
    summary: str,
    *,
    user_id: int,
    source_conversation_id: int | None,
    embedding: list[float],
    backend: str,
) -> int:
    """fastembed 用余弦去重；hash 后端用词元交集（≥2）去重；命中则合并刷新。"""
    rows = conn.execute(
        "SELECT id, summary, embedding_json FROM memory_summaries WHERE kind = ? AND embedding_backend = ?",
        (kind, backend),
    ).fetchall()
    terms: set[str] | None = None
    if backend and not backend.startswith("fastembed"):
        terms = _lexical_terms(summary)
    for row in rows:
        duplicate = False
        if backend.startswith("fastembed"):
            stored = json.loads(row["embedding_json"] or "[]")
            duplicate = _cosine(embedding, stored) >= DEDUP_FASTEMBED_THRESHOLD
        elif terms is not None:
            duplicate = len(terms & _lexical_terms(row["summary"])) >= DEDUP_LEXICAL_SHARED_TERMS
        if duplicate:
            conn.execute(
                "UPDATE memory_summaries SET updated_at = CURRENT_TIMESTAMP, source_conversation_id = ? WHERE id = ?",
                (source_conversation_id, row["id"]),
            )
            return int(row["id"])
    cursor = conn.execute(
        "INSERT INTO memory_summaries (user_id, kind, summary, source_conversation_id, embedding_json, embedding_backend) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (user_id, kind, summary, source_conversation_id, json_dump(embedding), backend),
    )
    return int(cursor.lastrowid)


def _enforce_item_limits(conn: sqlite3.Connection) -> None:
    count = conn.execute("SELECT COUNT(*) FROM memory_summaries").fetchone()[0]
    excess = count - MAX_MEMORY_ITEMS
    if excess > 0:
        conn.execute(
            "DELETE FROM memory_summaries WHERE id IN ("
            "SELECT id FROM memory_summaries ORDER BY updated_at ASC, id ASC LIMIT ?)",
            (excess,),
        )


def _memory_cursor(conn: sqlite3.Connection, conversation_id: int) -> int:
    row = conn.execute(
        "SELECT last_extracted_message_id FROM memory_conversation_state WHERE conversation_id = ?",
        (conversation_id,),
    ).fetchone()
    return int(row["last_extracted_message_id"]) if row is not None else 0


def list_memory_items(db_path: str | Path | None = None) -> list[dict[str, Any]]:
    with connect(db_path) as conn:
        rows = conn.execute(
            "SELECT * FROM memory_summaries ORDER BY updated_at DESC, id DESC"
        ).fetchall()
    return rows_to_dicts(rows)


def add_memory_item(
    kind: str,
    summary: str,
    *,
    db_path: str | Path | None = None,
    source_conversation_id: int | None = None,
) -> dict[str, Any]:
    if kind not in {"fact", "preference"}:
        raise ValueError("记忆类型必须是 fact 或 preference")
    cleaned = str(summary or "").strip()
    if not cleaned:
        raise ValueError("记忆内容不能为空")
    _, redacted = scan_and_redact(cleaned[:MAX_MEMORY_SUMMARY_CHARS])
    redacted = redacted.strip()
    if not redacted:
        raise ValueError("记忆内容不能为空")
    embedding, backend = _embed_summary(redacted)
    user_id = current_user_id() or 0
    with connect(db_path) as conn:
        conn.execute("BEGIN IMMEDIATE")
        item_id = _dedupe_merge(
            conn, kind, redacted, user_id=user_id,
            source_conversation_id=source_conversation_id, embedding=embedding, backend=backend,
        )
        _enforce_item_limits(conn)
        row = conn.execute("SELECT * FROM memory_summaries WHERE id = ?", (item_id,)).fetchone()
    return row_to_dict(row)


def update_memory_item(
    item_id: int,
    *,
    kind: str | None = None,
    summary: str | None = None,
    db_path: str | Path | None = None,
) -> dict[str, Any] | None:
    if kind is not None and kind not in {"fact", "preference"}:
        raise ValueError("记忆类型必须是 fact 或 preference")
    with connect(db_path) as conn:
        row = conn.execute("SELECT * FROM memory_summaries WHERE id = ?", (item_id,)).fetchone()
        if row is None:
            return None
        new_kind = kind or row["kind"]
        new_summary = row["summary"]
        embedding = json.loads(row["embedding_json"] or "[]")
        backend = row["embedding_backend"]
        if summary is not None:
            cleaned = str(summary).strip()
            if not cleaned:
                raise ValueError("记忆内容不能为空")
            _, redacted = scan_and_redact(cleaned[:MAX_MEMORY_SUMMARY_CHARS])
            new_summary = redacted.strip()
            embedding, backend = _embed_summary(new_summary)
        conn.execute(
            "UPDATE memory_summaries SET kind = ?, summary = ?, embedding_json = ?, embedding_backend = ?, "
            "updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (new_kind, new_summary, json_dump(embedding), backend, item_id),
        )
        row = conn.execute("SELECT * FROM memory_summaries WHERE id = ?", (item_id,)).fetchone()
    return row_to_dict(row)


def delete_memory_item(item_id: int, db_path: str | Path | None = None) -> bool:
    with connect(db_path) as conn:
        cursor = conn.execute("DELETE FROM memory_summaries WHERE id = ?", (item_id,))
    return cursor.rowcount > 0


def list_memory_rules(db_path: str | Path | None = None) -> list[dict[str, Any]]:
    with connect(db_path) as conn:
        rows = conn.execute("SELECT * FROM memory_rules ORDER BY id ASC").fetchall()
    return rows_to_dicts(rows)


def add_memory_rule(rule: str, db_path: str | Path | None = None) -> dict[str, Any]:
    cleaned = str(rule or "").strip()
    if not cleaned:
        raise ValueError("规则内容不能为空")
    cleaned = cleaned[:MAX_MEMORY_RULE_CHARS]
    user_id = current_user_id() or 0
    with connect(db_path) as conn:
        count = conn.execute("SELECT COUNT(*) FROM memory_rules").fetchone()[0]
        if count >= MAX_MEMORY_RULES:
            raise MemoryLimitError(f"规则数量已达上限（{MAX_MEMORY_RULES} 条）")
        cursor = conn.execute(
            "INSERT INTO memory_rules (user_id, rule) VALUES (?, ?)", (user_id, cleaned)
        )
        row = conn.execute("SELECT * FROM memory_rules WHERE id = ?", (cursor.lastrowid,)).fetchone()
    return row_to_dict(row)


def update_memory_rule(
    rule_id: int,
    *,
    rule: str | None = None,
    enabled: bool | None = None,
    db_path: str | Path | None = None,
) -> dict[str, Any] | None:
    with connect(db_path) as conn:
        row = conn.execute("SELECT * FROM memory_rules WHERE id = ?", (rule_id,)).fetchone()
        if row is None:
            return None
        new_rule = row["rule"]
        if rule is not None:
            cleaned = str(rule).strip()
            if not cleaned:
                raise ValueError("规则内容不能为空")
            new_rule = cleaned[:MAX_MEMORY_RULE_CHARS]
        new_enabled = 1 if enabled else 0 if enabled is not None else row["enabled"]
        conn.execute(
            "UPDATE memory_rules SET rule = ?, enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
            (new_rule, new_enabled, rule_id),
        )
        row = conn.execute("SELECT * FROM memory_rules WHERE id = ?", (rule_id,)).fetchone()
    return row_to_dict(row)


def delete_memory_rule(rule_id: int, db_path: str | Path | None = None) -> bool:
    with connect(db_path) as conn:
        cursor = conn.execute("DELETE FROM memory_rules WHERE id = ?", (rule_id,))
    return cursor.rowcount > 0


def clear_all_memory(db_path: str | Path | None = None) -> dict[str, int]:
    with connect(db_path) as conn:
        conn.execute("BEGIN IMMEDIATE")
        items = conn.execute("SELECT COUNT(*) FROM memory_summaries").fetchone()[0]
        rules = conn.execute("SELECT COUNT(*) FROM memory_rules").fetchone()[0]
        conn.execute("DELETE FROM memory_summaries")
        conn.execute("DELETE FROM memory_rules")
    # 保留 memory_state 的抽取水位，避免清空后立即重复抽取。
    return {"cleared_items": items, "cleared_rules": rules}


def _build_provider(connection: dict[str, Any]) -> Any:
    from ...models.configured import configure_model_provider
    from ...models.factory import build_model_provider

    provider = build_model_provider(
        api_key=str(connection.get("api_key") or ""),
        model=connection["model_name"],
        base_url=connection.get("model_base_url") or None,
        protocol=connection.get("model_protocol") or "auto",
        detected_protocol=connection.get("detected_protocol"),
        timeout_seconds=get_settings().model_timeout_seconds,
        price_per_million_input=connection.get("price_per_million_input"),
        price_per_million_output=connection.get("price_per_million_output"),
    )
    return configure_model_provider(
        provider, connection.get("parameters") or {}, connection.get("reasoning_effort") or "low"
    )


def _response_content(response: Any) -> str:
    content = getattr(response, "content", None)
    if content is not None:
        return str(content or "")
    if isinstance(response, dict):
        return str(response.get("content") or "")
    if isinstance(response, str):
        return response
    return ""


def _protocol_label(connection: dict[str, Any]) -> str:
    return (
        connection.get("detected_protocol")
        or connection.get("resolved_model_protocol")
        or connection.get("model_protocol")
        or "auto"
    )


def _record_success(connection: dict[str, Any], started_at: float, response: Any) -> None:
    usage = getattr(response, "usage", None)
    try:
        record_model_service_event(
            request_kind="memory_extract",
            status="success",
            latency_ms=round((perf_counter() - started_at) * 1000),
            model_name=connection["model_name"],
            base_url=connection.get("model_base_url"),
            protocol=_protocol_label(connection),
            input_tokens=int(getattr(usage, "input_tokens", 0) or 0),
            output_tokens=int(getattr(usage, "output_tokens", 0) or 0),
            total_tokens=int(getattr(usage, "total_tokens", 0) or 0),
        )
    except Exception:
        pass


def _record_failure(connection: dict[str, Any], started_at: float, error: BaseException) -> None:
    try:
        record_model_service_event(
            request_kind="memory_extract",
            status="error",
            error_code=getattr(error, "code", "") or "provider_error",
            error_message=str(error),
            latency_ms=round((perf_counter() - started_at) * 1000),
            model_name=connection["model_name"],
            base_url=connection.get("model_base_url"),
            protocol=_protocol_label(connection),
        )
    except Exception:
        pass


def _completed_result(result: AgentRunResult) -> bool:
    return result.status == "done" and result.stop_reason == "completed" and result.error is None


def _extraction_window(
    conn: sqlite3.Connection, conversation_id: int, through_message_id: int | None,
) -> tuple[int, int] | None:
    if through_message_id is None:
        # Reset may retry the most recent turn, but never a waiting/failed/in-progress one.
        run = conn.execute(
            "SELECT assistant_message_id, status, stop_reason, result_json FROM agent_execution_runs "
            "WHERE conversation_id = ? ORDER BY rowid DESC LIMIT 1",
            (conversation_id,),
        ).fetchone()
    else:
        run = conn.execute(
            "SELECT assistant_message_id, status, stop_reason, result_json FROM agent_execution_runs "
            "WHERE conversation_id = ? AND assistant_message_id = ?",
            (conversation_id, through_message_id),
        ).fetchone()
    if run is None or run["status"] != "completed" or not run["assistant_message_id"]:
        return None
    if run["stop_reason"] != "completed" or not _completed_result(AgentRunResult.model_validate_json(run["result_json"])):
        return None
    end = int(run["assistant_message_id"])
    start = _memory_cursor(conn, conversation_id)
    count = conn.execute(
        "SELECT COUNT(*) FROM (SELECT 1 FROM chat_messages WHERE conversation_id = ? "
        "AND id > ? AND id <= ? AND role IN ('user', 'assistant') LIMIT ?)",
        (conversation_id, start, end, EXTRACT_EVERY_MESSAGES),
    ).fetchone()[0]
    return (start, end) if count >= EXTRACT_EVERY_MESSAGES else None


def _due_window(
    conversation_id: int, db_path: str | Path | None, through_message_id: int | None,
) -> tuple[int, int] | None:
    if not get_agent_settings(db_path).get("user_memory_enabled", True):
        return None
    with connect(db_path) as conn:
        window = _extraction_window(conn, conversation_id, through_message_id)
    if window and get_model_connection(db_path, resolve_credentials=False).get("model_name"):
        return window
    return None


def memory_extraction_due(
    conversation_id: int, *, db_path: str | Path | None = None,
) -> bool:
    """预检最近轮次是否正常完成，且有足够的本会话增量可抽取。"""
    try:
        return _due_window(conversation_id, db_path, None) is not None
    except Exception:
        return False


def schedule_memory_extraction(
    conversation_id: int,
    *,
    db_path: str | Path | None = None,
    through_message_id: int | None = None,
) -> None:
    """在持久化完成后触发；不允许预检或启动线程的失败影响主对话。"""
    from ...workspace import spawn_thread

    try:
        window = _due_window(conversation_id, db_path, through_message_id)
        if window is not None:
            spawn_thread(
                extract_from_conversation,
                name=f"memory-extract-{conversation_id}",
                args=(conversation_id,),
                kwargs={"db_path": db_path, "through_message_id": window[1]},
            )
    except Exception:
        return


def extract_from_conversation(
    conversation_id: int,
    *,
    db_path: str | Path | None = None,
    through_message_id: int | None = None,
    generate: Callable[[ModelRequest], Any] | None = None,
) -> int:
    """串行处理同一工作区同一会话的抽取，不阻塞其他会话或主对话。"""
    try:
        path = resolve_db_path(db_path).resolve()
        key = (path, conversation_id)
        with _extraction_locks_guard:
            lock = _extraction_locks.get(key)
            if lock is None:
                lock = Lock()
                _extraction_locks[key] = lock
        with lock:
            return _extract_from_conversation(conversation_id, path, through_message_id, generate)
    except Exception:
        return 0


def _extract_from_conversation(
    conversation_id: int,
    db_path: Path,
    through_message_id: int | None,
    generate: Callable[[ModelRequest], Any] | None,
) -> int:
    if not get_agent_settings(db_path).get("user_memory_enabled", True):
        return 0
    with connect(db_path) as conn:
        window = _extraction_window(conn, conversation_id, through_message_id)
        if window is None:
            return 0
        start, end = window
        message_rows = conn.execute(
            "SELECT id, role, content FROM chat_messages WHERE conversation_id = ? AND id > ? AND id <= ? "
            "AND role IN ('user', 'assistant') ORDER BY id LIMIT ?",
            (conversation_id, start, end, EXTRACTION_CONTEXT_MESSAGES),
        ).fetchall()
        existing_rows = conn.execute(
            "SELECT kind, summary FROM memory_summaries ORDER BY updated_at DESC, id DESC LIMIT ?",
            (EXTRACTION_MAX_EXISTING,),
        ).fetchall()
    fragments: list[str] = []
    for row in message_rows:
        content = row["content"] or ""
        if _REDACTED_MARKER in content:
            continue
        _, redacted = scan_and_redact(content)
        fragments.append(f"{row['role']}: {redacted[:EXTRACTION_MESSAGE_CHARS]}")
    if not fragments:
        return 0
    last_message_id = int(message_rows[-1]["id"])
    existing_text = "\n".join(
        f"- [{row['kind']}] {row['summary']}" for row in existing_rows
    ) or "（暂无）"
    request = ModelRequest(
        messages=[
            AgentMessage(
                role="user",
                content=EXTRACTION_PROMPT.replace(
                    "{existing}", existing_text
                ).replace("{conversation}", "\n".join(fragments)),
            )
        ],
        tool_choice="none",
        reasoning_effort="low",
        parameters={"max_output_tokens": 800},
    )
    started_at = perf_counter()
    if generate is not None:
        try:
            response = generate(request)
        except Exception:
            return 0
    else:
        try:
            connection = get_model_connection(db_path)
        except Exception:
            return 0
        if not connection.get("model_name"):
            return 0
        try:
            provider = _build_provider(connection)
            selection = internal_model_selection(connection)
        except Exception:
            return 0

        async def call() -> Any:
            async with asyncio.timeout(get_settings().model_timeout_seconds):
                return await provider.generate(request)

        with model_call_scope(selection, run_id=f"memory-extract-{conversation_id}", stage="memory_extract"):
            try:
                response = asyncio.run(call())
            except Exception as error:
                _record_failure(connection, started_at, error)
                return 0
            _record_success(connection, started_at, response)
    items = _parse_extraction(_response_content(response))
    if items is None:
        return 0
    prepared = []
    for item in items:
        _, redacted = scan_and_redact(item["summary"])
        if redacted.strip():
            redacted = redacted.strip()
            prepared.append((item["kind"], redacted, *_embed_summary(redacted)))
    with connect(db_path) as conn:
        conn.execute("BEGIN IMMEDIATE")
        # Compare again under the write lock if another process already handled this window.
        if _memory_cursor(conn, conversation_id) != start:
            return 0
        for kind, summary, embedding, backend in prepared:
            _dedupe_merge(
                conn, kind, summary, user_id=current_user_id() or 0,
                source_conversation_id=conversation_id, embedding=embedding, backend=backend,
            )
        _enforce_item_limits(conn)
        conn.execute(
            "INSERT INTO memory_conversation_state (conversation_id, last_extracted_message_id) VALUES (?, ?) "
            "ON CONFLICT(conversation_id) DO UPDATE SET last_extracted_message_id = excluded.last_extracted_message_id, "
            "last_extraction_at = CURRENT_TIMESTAMP",
            (conversation_id, last_message_id),
        )
    return len(prepared)
