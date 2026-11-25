"""用户记忆服务的确定性回归测试。

覆盖：条目与规则 CRUD、数量上限与去重合并、抽取（节流/开关/失败静默/
脱敏/脱敏资料标记跳过/水位推进）、上下文注入（相关匹配、字符预算、规则全注入）、
会话重置挂点与 41→42 迁移兼容。所有模型调用均以注入 generate 模拟，不发网络。
"""
from __future__ import annotations

import sqlite3
from contextlib import closing
from pathlib import Path
from tempfile import TemporaryDirectory

import pytest

from app.agent.memory import context, service
from app.agent.settings import save_agent_settings
from app.chat.conversations import create_conversation, reset_conversation_context
from app.db import DB_SCHEMA_VERSION, connect, init_db
from app.domain import AgentRunResult
from app.knowledge import reset_embedder


@pytest.fixture(autouse=True)
def pin_hash_embedder(monkeypatch: pytest.MonkeyPatch) -> None:
    """固定 hash 嵌入后端，保证词法去重/检索在任何执行顺序下都确定。"""
    monkeypatch.setenv("EMBEDDING_BACKEND", "hash")
    reset_embedder()
    yield
    reset_embedder()


def _insert_messages(
    db_path: Path, conversation_id: int, messages: list[tuple[str, str]]
) -> None:
    with connect(db_path) as conn:
        for role, content in messages:
            cursor = conn.execute(
                "INSERT INTO chat_messages (conversation_id, role, content) VALUES (?, ?, ?)",
                (conversation_id, role, content),
            )
        if messages[-1][0] != "assistant":
            cursor = conn.execute(
                "INSERT INTO chat_messages (conversation_id, role, content) VALUES (?, 'assistant', '收到。')",
                (conversation_id,),
            )
        result = AgentRunResult(content="收到。", provider="test", platform="manual", rounds=1)
        conn.execute(
            "INSERT INTO agent_execution_runs (run_id, conversation_id, assistant_message_id, status, stop_reason, result_json) "
            "VALUES (?, ?, ?, 'completed', 'completed', ?)",
            (f"test-{cursor.lastrowid}", conversation_id, cursor.lastrowid, result.model_dump_json()),
        )


def test_add_list_update_delete_item() -> None:
    with TemporaryDirectory() as directory:
        path = Path(directory) / "memory.db"
        init_db(path)
        item = service.add_memory_item("fact", "用户是后端工程师", db_path=path)
        assert item["kind"] == "fact"
        assert item["summary"] == "用户是后端工程师"
        assert item["source_conversation_id"] is None
        assert item["embedding_backend"] == "hash:hash-blake2b"

        assert [row["summary"] for row in service.list_memory_items(path)] == [
            "用户是后端工程师"
        ]

        updated = service.update_memory_item(
            item["id"], summary="用户是资深后端工程师", db_path=path
        )
        assert updated is not None
        assert updated["summary"] == "用户是资深后端工程师"
        assert service.update_memory_item(9999, summary="不存在", db_path=path) is None

        assert service.delete_memory_item(item["id"], path) is True
        assert service.list_memory_items(path) == []
        assert service.delete_memory_item(item["id"], path) is False


def test_add_item_validates_kind_and_summary() -> None:
    with TemporaryDirectory() as directory:
        path = Path(directory) / "memory.db"
        init_db(path)
        with pytest.raises(ValueError):
            service.add_memory_item("mood", "无效类型", db_path=path)
        with pytest.raises(ValueError):
            service.add_memory_item("fact", "   ", db_path=path)
        assert service.list_memory_items(path) == []


def test_hash_dedupe_merges_similar_summaries() -> None:
    with TemporaryDirectory() as directory:
        path = Path(directory) / "memory.db"
        init_db(path)
        first = service.add_memory_item("fact", "用户是后端工程师", db_path=path)
        second = service.add_memory_item("fact", "用户是后端开发人员", db_path=path)
        assert second["id"] == first["id"]
        assert len(service.list_memory_items(path)) == 1


def test_item_limit_evicts_oldest() -> None:
    with TemporaryDirectory() as directory:
        path = Path(directory) / "memory.db"
        init_db(path)
        for index in range(service.MAX_MEMORY_ITEMS):
            service.add_memory_item("fact", f"alpha{index} beta{index}", db_path=path)
        assert len(service.list_memory_items(path)) == service.MAX_MEMORY_ITEMS

        service.add_memory_item("fact", "omega one", db_path=path)
        items = service.list_memory_items(path)
        assert len(items) == service.MAX_MEMORY_ITEMS
        summaries = {row["summary"] for row in items}
        assert "alpha0 beta0" not in summaries
        assert "omega one" in summaries


def test_rules_crud_and_limit() -> None:
    with TemporaryDirectory() as directory:
        path = Path(directory) / "memory.db"
        init_db(path)
        rule = service.add_memory_rule("回答保持简洁", db_path=path)
        assert rule["rule"] == "回答保持简洁"
        assert rule["enabled"] == 1

        updated = service.update_memory_rule(
            rule["id"], rule="回答用中文", enabled=False, db_path=path
        )
        assert updated is not None
        assert updated["rule"] == "回答用中文"
        assert updated["enabled"] == 0
        assert service.update_memory_rule(9999, rule="不存在", db_path=path) is None

        with pytest.raises(ValueError):
            service.add_memory_rule("   ", db_path=path)

        assert service.delete_memory_rule(rule["id"], path) is True
        assert service.delete_memory_rule(rule["id"], path) is False

        for index in range(service.MAX_MEMORY_RULES):
            service.add_memory_rule(f"rule-{index}", db_path=path)
        with pytest.raises(service.MemoryLimitError):
            service.add_memory_rule("overflow", db_path=path)


def test_clear_all_memory_preserves_watermark() -> None:
    with TemporaryDirectory() as directory:
        path = Path(directory) / "memory.db"
        init_db(path)
        service.add_memory_item("fact", "用户养猫", db_path=path)
        service.add_memory_item("preference", "用户偏好深夜工作", db_path=path)
        service.add_memory_rule("规则一", db_path=path)
        service.add_memory_rule("规则二", db_path=path)
        conversation_id = create_conversation(db_path=path)["id"]
        with connect(path) as conn:
            conn.execute(
                "INSERT INTO memory_conversation_state (conversation_id, last_extracted_message_id) VALUES (?, 42)",
                (conversation_id,),
            )

        cleared = service.clear_all_memory(path)
        assert cleared == {"cleared_items": 2, "cleared_rules": 2}
        assert service.list_memory_items(path) == []
        assert service.list_memory_rules(path) == []
        with connect(path) as conn:
            row = conn.execute(
                "SELECT last_extracted_message_id FROM memory_conversation_state WHERE conversation_id = ?",
                (conversation_id,),
            ).fetchone()
        assert row is not None and row["last_extracted_message_id"] == 42


def test_extraction_stores_items_and_advances_watermark() -> None:
    with TemporaryDirectory() as directory:
        path = Path(directory) / "memory.db"
        init_db(path)
        conversation = create_conversation(db_path=path)
        conversation_id = conversation["id"]
        _insert_messages(
            path,
            conversation_id,
            [
                ("user", "我在游戏公司做后端开发。"),
                ("assistant", "好的。"),
                ("user", "我喜欢简洁的要点式回答。"),
                ("assistant", "明白。"),
                ("user", "我的主力语言是 Python。"),
                ("assistant", "收到。"),
                ("user", "我们公司在上海。"),
            ],
        )
        captured: list[object] = []

        def fake_generate(request: object) -> dict[str, str]:
            captured.append(request)
            return {
                "content": '[{"kind": "fact", "summary": "用户是游戏公司后端开发者"}, '
                '{"kind": "preference", "summary": "用户偏好简洁要点式回答"}]'
            }

        stored = service.extract_from_conversation(
            conversation_id, db_path=path, generate=fake_generate
        )
        assert stored == 2
        items = service.list_memory_items(path)
        assert {row["summary"] for row in items} == {
            "用户是游戏公司后端开发者",
            "用户偏好简洁要点式回答",
        }
        assert all(row["source_conversation_id"] == conversation_id for row in items)

        assert len(captured) == 1
        request = captured[0]
        assert request.tool_choice == "none"
        assert request.reasoning_effort == "low"
        assert request.parameters == {"max_output_tokens": 800}
        prompt = request.messages[0].content
        assert "我在游戏公司做后端开发" in prompt
        assert "已有记忆" in prompt

        with connect(path) as conn:
            row = conn.execute(
                "SELECT last_extracted_message_id FROM memory_conversation_state WHERE conversation_id = ?",
                (conversation_id,),
            ).fetchone()
        assert row is not None and row["last_extracted_message_id"] == 8

        # 水位推进后没有新消息，不应再次调用模型。
        assert (
            service.extract_from_conversation(
                conversation_id, db_path=path, generate=fake_generate
            )
            == 0
        )
        assert len(captured) == 1


def test_extraction_respects_switch_and_threshold() -> None:
    with TemporaryDirectory() as directory:
        path = Path(directory) / "memory.db"
        init_db(path)
        conversation = create_conversation(db_path=path)
        conversation_id = conversation["id"]
        _insert_messages(
            path,
            conversation_id,
            [
                ("user", "message one"),
                ("assistant", "ok"),
                ("user", "message two"),
                ("assistant", "ok"),
                ("user", "message three"),
                ("assistant", "ok"),
                ("user", "message four"),
            ],
        )
        calls: list[object] = []

        def fake_generate(request: object) -> dict[str, str]:
            calls.append(request)
            return {"content": "[]"}

        # 开关关闭：消息足够也不抽取。
        save_agent_settings({"user_memory_enabled": False}, path)
        assert (
            service.extract_from_conversation(
                conversation_id, db_path=path, generate=fake_generate
            )
            == 0
        )
        assert calls == []

        # 开关打开且本会话增量达到阈值：合法空数组仍推进游标。
        save_agent_settings({"user_memory_enabled": True}, path)
        assert (
            service.extract_from_conversation(
                conversation_id, db_path=path, generate=fake_generate
            )
            == 0
        )
        assert len(calls) == 1
        with connect(path) as conn:
            row = conn.execute(
                "SELECT last_extracted_message_id FROM memory_conversation_state WHERE conversation_id = ?",
                (conversation_id,),
            ).fetchone()
        assert row is not None and row["last_extracted_message_id"] == 8

        # 即使全局 ID 已很大，另一个会话仅有 4 条消息，仍未到阈值。
        other = create_conversation(db_path=path)
        _insert_messages(path, other["id"], [("user", "a"), ("assistant", "b")] * 2)
        assert (
            service.extract_from_conversation(
                other["id"], db_path=path, generate=fake_generate
            )
            == 0
        )
        assert len(calls) == 1

        # 轻量预检：开关开启但模型未配置时不值得后台抽取。
        assert service.memory_extraction_due(conversation_id, db_path=path) is False


def test_extraction_skips_unfinished_runs_and_unknown_conversations() -> None:
    with TemporaryDirectory() as directory:
        path = Path(directory) / "memory.db"
        init_db(path)
        conversation = create_conversation(db_path=path)
        conversation_id = conversation["id"]
        _insert_messages(
            path,
            conversation_id,
            [("user", f"message {index}") for index in range(6)],
        )
        calls: list[object] = []

        def fake_generate(request: object) -> dict[str, str]:
            calls.append(request)
            return {"content": "[]"}

        with connect(path) as conn:
            conn.execute(
                "INSERT INTO agent_execution_runs (run_id, conversation_id, status) "
                "VALUES (?, ?, ?)",
                ("run-1", conversation_id, "running"),
            )
        assert (
            service.extract_from_conversation(
                conversation_id, db_path=path, generate=fake_generate
            )
            == 0
        )
        assert calls == []

        assert (
            service.extract_from_conversation(9999, db_path=path, generate=fake_generate)
            == 0
        )
        assert calls == []


def test_extraction_model_failure_is_silent() -> None:
    with TemporaryDirectory() as directory:
        path = Path(directory) / "memory.db"
        init_db(path)
        conversation = create_conversation(db_path=path)
        conversation_id = conversation["id"]
        _insert_messages(
            path,
            conversation_id,
            [("user", f"message {index}") for index in range(6)],
        )

        def broken_generate(request: object) -> dict[str, str]:
            raise RuntimeError("provider exploded")

        assert (
            service.extract_from_conversation(
                conversation_id, db_path=path, generate=broken_generate
            )
            == 0
        )
        assert service.list_memory_items(path) == []
        with connect(path) as conn:
            row = conn.execute(
                "SELECT last_extracted_message_id FROM memory_conversation_state WHERE conversation_id = ?",
                (conversation_id,),
            ).fetchone()
        assert row is None
        assert service.extract_from_conversation(
            conversation_id, db_path=path, generate=lambda request: {"content": "not JSON"}
        ) == 0
        assert service.list_memory_items(path) == []
        assert service.extract_from_conversation(
            conversation_id, db_path=path,
            generate=lambda request: {"content": '[{"kind":"fact","summary":"retry succeeds"}]'},
        ) == 1
        assert service.extract_from_conversation(
            conversation_id, db_path=path, generate=broken_generate
        ) == 0


def test_extraction_redacts_pii_and_skips_redacted_context_messages() -> None:
    with TemporaryDirectory() as directory:
        path = Path(directory) / "memory.db"
        init_db(path)
        conversation = create_conversation(db_path=path)
        conversation_id = conversation["id"]
        _insert_messages(
            path,
            conversation_id,
            [
                ("user", "我的邮箱是 user@example.com，记住它。"),
                ("assistant", "好的。"),
                ("user", "普通消息 one。"),
                ("assistant", "收到。"),
                ("user", "普通消息 two。"),
                ("assistant", "收到。"),
                # 携带脱敏资料标记的消息不应进入抽取提示词。
                ("user", "\n[脱敏资料：附件.txt]\n机密内容不应外发"),
            ],
        )
        captured_prompts: list[str] = []

        def fake_generate(request: object) -> dict[str, str]:
            captured_prompts.append(request.messages[0].content)
            return {"content": '[{"kind": "fact", "summary": "用户邮箱 user@example.com 用于工作"}]'}

        stored = service.extract_from_conversation(
            conversation_id, db_path=path, generate=fake_generate
        )
        assert stored == 1
        prompt = captured_prompts[0]
        assert "user@example.com" not in prompt
        assert "[邮箱已隐藏]" in prompt
        assert "附件.txt" not in prompt
        assert "机密内容不应外发" not in prompt
        items = service.list_memory_items(path)
        assert items[0]["summary"] == "用户邮箱 [邮箱已隐藏] 用于工作"


def test_parse_extraction_tolerates_fences_and_junk() -> None:
    assert service.parse_extraction(
        '```json\n[{"kind": "fact", "summary": "用户养猫"}]\n```'
    ) == [{"kind": "fact", "summary": "用户养猫"}]
    assert service.parse_extraction(
        '前缀说明 [{"kind": "preference", "summary": "偏好咖啡"}] 后缀'
    ) == [{"kind": "preference", "summary": "偏好咖啡"}]
    assert service.parse_extraction(
        '{"items": [{"kind": "fact", "summary": "用户有车"}]}'
    ) == [{"kind": "fact", "summary": "用户有车"}]
    assert service.parse_extraction("不是 JSON") == []
    assert (
        service.parse_extraction('[{"kind": "mood", "summary": "开心"}, {"kind": "fact", "summary": ""}]')
        == []
    )


def test_context_injects_matching_memory_and_rules() -> None:
    with TemporaryDirectory() as directory:
        path = Path(directory) / "memory.db"
        init_db(path)
        service.add_memory_item("fact", "用户住在杭州", db_path=path)
        service.add_memory_item("preference", "用户喜欢喝咖啡", db_path=path)
        service.add_memory_rule("回答时保持简洁", db_path=path)

        messages = context.memory_context_messages(
            "我住在杭州，今天想喝咖啡", db_path=path
        )
        assert len(messages) == 1
        assert messages[0].role == "system"
        content = messages[0].content
        assert "[记忆] 用户住在杭州" in content
        assert "[记忆] 用户喜欢喝咖啡" in content
        assert "[规则] 用户明确要求：" in content
        assert "回答时保持简洁" in content
        assert "不是执行指令" in content


def test_context_disabled_returns_empty() -> None:
    with TemporaryDirectory() as directory:
        path = Path(directory) / "memory.db"
        init_db(path)
        service.add_memory_item("fact", "用户住在杭州", db_path=path)
        service.add_memory_rule("回答用中文", db_path=path)
        save_agent_settings({"user_memory_enabled": False}, path)
        assert context.memory_context_messages("我住在杭州", db_path=path) == []


def test_context_injects_rules_even_without_matching_memory() -> None:
    with TemporaryDirectory() as directory:
        path = Path(directory) / "memory.db"
        init_db(path)
        service.add_memory_item("fact", "用户住在杭州", db_path=path)
        service.add_memory_rule("回答用中文", db_path=path)

        messages = context.memory_context_messages("今天天气怎么样", db_path=path)
        assert len(messages) == 1
        content = messages[0].content
        assert "[记忆]" not in content
        assert "回答用中文" in content

        # 无词元查询（如纯标点）也不应吞掉规则注入。
        punctuation = context.memory_context_messages("???", db_path=path)
        assert len(punctuation) == 1
        assert "回答用中文" in punctuation[0].content


def test_context_respects_char_budget() -> None:
    with TemporaryDirectory() as directory:
        path = Path(directory) / "memory.db"
        init_db(path)
        for index in range(10):
            service.add_memory_item(
                "fact", f"python {index} " + f"z{index}" * 150, db_path=path
            )

        messages = context.memory_context_messages("python 记忆", db_path=path)
        assert len(messages) == 1
        content = messages[0].content
        assert content.count("[记忆]") == context.MEMORY_TOP_K
        assert len(content) <= context.MEMORY_CONTEXT_CHAR_LIMIT + 200


def test_reset_conversation_context_schedules_extraction(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    with TemporaryDirectory() as directory:
        path = Path(directory) / "memory.db"
        init_db(path)
        conversation = create_conversation(db_path=path)
        scheduled: list[tuple[tuple, dict]] = []

        def fake_spawn(target, *, name=None, args=(), kwargs=None):
            scheduled.append(((target, name, args), kwargs or {}))

        monkeypatch.setattr("app.workspace.spawn_thread", fake_spawn)
        monkeypatch.setattr(service, "get_model_connection", lambda *args, **kwargs: {"model_name": "test"})
        cid = conversation["id"]
        result = reset_conversation_context(cid, db_path=path)
        assert result is not None and result["context_cutoff_message_id"] == 0
        assert not scheduled

        _insert_messages(path, cid, [("user", "user request"), ("assistant", "reply")] * 3)
        result = reset_conversation_context(cid, db_path=path)
        assert result is not None and result["context_cutoff_message_id"] == 6
        assert scheduled == [((service.extract_from_conversation, f"memory-extract-{cid}", (cid,)),
                              {"db_path": path, "through_message_id": 6})]

        scheduled.clear()
        save_agent_settings({"user_memory_enabled": False}, path)
        assert reset_conversation_context(cid, db_path=path) is not None
        assert not scheduled

        save_agent_settings({"user_memory_enabled": True}, path)
        with connect(path) as conn:
            conn.execute("INSERT INTO agent_execution_runs (run_id, conversation_id, status) VALUES (?, ?, ?)",
                         ("waiting", cid, "waiting_user"))
        assert reset_conversation_context(cid, db_path=path) is not None
        assert not scheduled


def test_migration_adds_memory_tables_and_column_from_v41() -> None:
    from app.database_lifecycle import initialize_or_report

    with TemporaryDirectory() as directory:
        path = Path(directory) / "existing.db"
        init_db(path)
        with closing(sqlite3.connect(path)) as conn, conn:
            conn.execute("DROP TABLE memory_summaries")
            conn.execute("DROP TABLE memory_rules")
            conn.execute("DROP TABLE memory_conversation_state")
            conn.execute("ALTER TABLE agent_settings DROP COLUMN user_memory_enabled")
            conn.execute("UPDATE schema_migrations SET version = 41, name = 'versioned_document_exports'")

        upgraded = initialize_or_report(path)
        assert upgraded["status"] == "ready"
        assert upgraded["schema_version"] == DB_SCHEMA_VERSION
        with closing(sqlite3.connect(path)) as conn, conn:
            tables = {
                row[0]
                for row in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                )
            }
            assert {"memory_summaries", "memory_rules", "memory_conversation_state"} <= tables
            columns = {
                row[1] for row in conn.execute("PRAGMA table_info(agent_settings)")
            }
            assert "user_memory_enabled" in columns

        # 重复升级幂等。
        assert initialize_or_report(path)["status"] == "ready"


def test_interleaved_conversations_extract_independently(tmp_path: Path) -> None:
    path = tmp_path / "memory.db"
    init_db(path)
    first = create_conversation(db_path=path)["id"]
    second = create_conversation(db_path=path)["id"]
    _insert_messages(path, first, [("user", "first initial message"), ("assistant", "first reply")])
    _insert_messages(path, second, [("user", "second message"), ("assistant", "second reply")] * 3)
    prompts = []

    def generate(request):
        prompts.append(request.messages[0].content)
        return {"content": "[]"}

    service.extract_from_conversation(second, db_path=path, generate=generate)
    _insert_messages(path, first, [("user", "first continuation"), ("assistant", "first reply")] * 2)
    service.extract_from_conversation(first, db_path=path, generate=generate)
    assert len(prompts) == 2
    assert "second message" in prompts[0] and "first initial message" not in prompts[0]
    assert "first initial message" in prompts[1] and "second message" not in prompts[1]
    with connect(path) as conn:
        assert dict(conn.execute(
            "SELECT conversation_id, last_extracted_message_id FROM memory_conversation_state"
        ).fetchall()) == {first: 12, second: 8}


def test_v45_upgrade_preserves_legacy_watermark_per_conversation(tmp_path: Path) -> None:
    path = tmp_path / "memory.db"
    init_db(path)
    first = create_conversation(db_path=path)["id"]
    second = create_conversation(db_path=path)["id"]
    _insert_messages(path, first, [("user", "old first message"), ("assistant", "old first reply")])
    _insert_messages(path, second, [("user", "old second message"), ("assistant", "old second reply")])
    _insert_messages(path, first, [("user", "unread message"), ("assistant", "unread reply")])
    item = service.add_memory_item("fact", "preserved memory item", db_path=path)
    with connect(path) as conn:
        conn.execute("DROP TABLE memory_conversation_state")
        conn.execute("CREATE TABLE memory_state (id INTEGER PRIMARY KEY CHECK(id = 1), "
                     "last_extracted_message_id INTEGER NOT NULL DEFAULT 0, last_extraction_at TEXT NOT NULL DEFAULT '')")
        conn.execute("INSERT INTO memory_state VALUES (1, 4, '2026-01-01 12:00:00')")
        conn.execute("UPDATE schema_migrations SET version = 45, name = 'image_studio_history_and_works'")
    init_db(path)
    init_db(path)
    with connect(path) as conn:
        assert [tuple(row) for row in conn.execute(
            "SELECT conversation_id, last_extracted_message_id, last_extraction_at "
            "FROM memory_conversation_state ORDER BY conversation_id"
        )] == [(first, 2, "2026-01-01 12:00:00"), (second, 4, "2026-01-01 12:00:00")]
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
    assert service.list_memory_items(path)[0]["id"] == item["id"]
