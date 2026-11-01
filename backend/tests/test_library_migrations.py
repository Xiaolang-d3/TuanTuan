import sqlite3

import pytest

from app.compatibility.profile_document import ProfileDocument, document_path, render
from app.compatibility.schema_v22 import init_db as init_v22
from app.db import DB_SCHEMA_VERSION, connect, init_db
from app.library.knowledge import get_knowledge, list_knowledge
from app.library.service import model_context
from app.library.sources import delete_source, get_source, list_sources, update_source


def legacy_workspace(tmp_path):
    path = tmp_path / "tuantuan.db"
    init_v22(path)
    document_path(path).write_text(render(ProfileDocument(
        name="读者", skills="- 记录笔记", goals="- 历史求职目标",
        resume_text="历史阅读资料：每周整理笔记，联系 reader@example.com。",
    )))
    with connect(path) as conn:
        for status, statement in [("proposed", "待确认"), ("confirmed", "已确认"), ("rejected", "已否决"), ("retracted", "已撤回")]:
            conn.execute("INSERT INTO candidate_memory_items (profile_id, category, statement, status) VALUES (1, 'knowledge', ?, ?)", (statement, status))
        conn.execute("INSERT INTO jobs (job_title, company_name) VALUES ('历史岗位', '示例公司')")
        conn.execute("INSERT INTO chat_messages (conversation_id, role, content) VALUES (1, 'user', '历史消息')")
    return path


def test_fresh_schema_contains_no_retired_business_tables(tmp_path):
    path = tmp_path / "fresh.db"
    init_db(path)
    with connect(path) as conn:
        names = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    assert not {"profiles", "candidate_memory_items", "jobs", "workflow_runs", "resume_versions", "interview_kits", "companies", "discovered_jobs"} & names
    assert {"library_metadata", "library_knowledge", "library_evidence", "library_sources", "agent_execution_runs"} <= names


def test_upgrade_preserves_states_ids_history_and_original_document(tmp_path):
    path = legacy_workspace(tmp_path)
    original = document_path(path).read_bytes()
    init_db(path)
    init_db(path)
    assert get_knowledge(1_000_001, path)["status"] == "pending"
    assert get_knowledge(1_000_002, path)["status"] == "confirmed"
    assert get_knowledge(1_000_003, path)["status"] == "disputed"
    assert get_knowledge(1_000_004, path)["status"] == "retracted"
    context = model_context(path)
    assert "reader@example.com" not in context["document"]
    assert {item["statement"] for item in context["confirmed_facts"]} == {"记录笔记", "已确认"}
    assert document_path(path).read_bytes() == original
    with connect(path) as conn:
        assert conn.execute("SELECT job_title FROM jobs").fetchone()[0] == "历史岗位"
        assert conn.execute("SELECT content FROM chat_messages").fetchone()[0] == "历史消息"
        assert conn.execute("PRAGMA foreign_key_check").fetchall() == []
    backup = tmp_path / ".upgrade-backups" / "before-library-v23" / path.name
    with sqlite3.connect(backup) as conn:
        assert conn.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0] == 22
        assert conn.execute("SELECT COUNT(*) FROM candidate_memory_items").fetchone()[0] == 4
    assert backup.stat().st_mode & 0o777 == 0o600


def test_disabled_or_deleted_migrated_source_never_reappears(tmp_path):
    path = legacy_workspace(tmp_path)
    init_db(path)
    source = list_sources(path)[0]
    update_source(source["id"], enabled=False, db_path=path)
    init_db(path)
    assert model_context(path)["document"] == ""
    delete_source(source["id"], path)
    init_db(path)
    assert list_sources(path) == []
    assert document_path(path).exists()


def test_v23_upgrade_does_not_reimport_deleted_legacy_source(tmp_path):
    path = legacy_workspace(tmp_path)
    init_db(path)
    delete_source(list_sources(path)[0]["id"], path)
    # v23 already owns its independent library; v24 only generalizes fields.
    with connect(path) as conn:
        conn.execute("DELETE FROM schema_migrations WHERE version > 23")
        conn.execute("INSERT OR IGNORE INTO schema_migrations(version, name) VALUES (23, 'independent_library')")
        conn.execute("ALTER TABLE agent_settings RENAME COLUMN library_memory_enabled TO profile_memory_enabled")
    init_db(path)
    assert list_sources(path) == []
    assert document_path(path).exists()
    assert get_knowledge(1_000_002, path)["status"] == "confirmed"


def test_index_failure_does_not_complete_upgrade_and_retry_is_idempotent(tmp_path, monkeypatch):
    path = legacy_workspace(tmp_path)
    from app.library import sources
    index = sources._index_source
    monkeypatch.setattr(sources, "_index_source", lambda *args: (_ for _ in ()).throw(RuntimeError("index unavailable")))
    with pytest.raises(RuntimeError, match="index unavailable"):
        init_db(path)
    with connect(path) as conn:
        assert conn.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0] == 22
    monkeypatch.setattr(sources, "_index_source", index)
    init_db(path)
    assert len(list_sources(path)) == 1
    assert len(list_knowledge(db_path=path)) == 5
    assert get_source(list_sources(path)[0]["id"], db_path=path)["content"].startswith("历史阅读资料")
    with connect(path) as conn:
        assert conn.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0] == DB_SCHEMA_VERSION


def test_older_upgrade_preserves_retired_records(tmp_path):
    path = legacy_workspace(tmp_path)
    with connect(path) as conn:
        conn.execute("DELETE FROM schema_migrations WHERE version >= 17")
        for table in ("candidate_facts", "career_weekly_reports", "application_stage_events"):
            conn.execute(f"CREATE TABLE {table} (id INTEGER PRIMARY KEY, payload TEXT)")
            conn.execute(f"INSERT INTO {table} VALUES (7, '历史原文')")
    init_db(path)
    with connect(path) as conn:
        for table in ("candidate_facts", "career_weekly_reports", "application_stage_events"):
            assert conn.execute(f"SELECT payload FROM {table}").fetchone()[0] == "历史原文"
    assert len(list_sources(path)) == 1


def test_upgrade_converts_attachment_kinds_and_preserves_memory_preference(tmp_path):
    path = legacy_workspace(tmp_path)
    with connect(path) as conn:
        conn.execute("UPDATE agent_settings SET profile_memory_enabled = 0")
        conn.execute("INSERT INTO attachments (id, conversation_id, kind, object_key, original_filename, content_type, size_bytes, sha256) VALUES ('legacy-doc', 1, 'resume', 'original.txt', 'notes.txt', 'text/plain', 12, 'hash')")
        conn.execute('UPDATE chat_messages SET payload_json = ? WHERE id = 1', ('{"attachments":[{"id":"legacy-doc","kind":"resume"}]}',))
    init_db(path)
    with connect(path) as conn:
        assert conn.execute("SELECT library_memory_enabled FROM agent_settings").fetchone()[0] == 0
        assert conn.execute("SELECT kind FROM attachments").fetchone()[0] == "document"
        assert '"document"' in conn.execute("SELECT payload_json FROM chat_messages WHERE id = 1").fetchone()[0]
    assert model_context(path)["disabled"]
