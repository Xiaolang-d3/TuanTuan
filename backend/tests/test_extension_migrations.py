from app import db


def test_migration_preserves_chat_and_is_repeatable(tmp_path):
    path = tmp_path / "tuantuan.db"
    db.init_db(path)
    with db.connect(path) as connection:
        connection.execute("INSERT INTO conversations(id, title) VALUES (888, '旧对话')")
        connection.execute("INSERT INTO chat_messages(role, content, conversation_id) VALUES ('user', '旧消息', 888)")
        connection.execute("DELETE FROM schema_migrations WHERE version > 31")
        connection.execute("INSERT OR IGNORE INTO schema_migrations(version, name) VALUES (31, 'library_topic_collections')")
        connection.execute("DROP TABLE IF EXISTS extension_files")
        connection.execute("DROP TABLE IF EXISTS extension_catalog")
    db.init_db(path)
    db.init_db(path)
    with db.connect(path) as connection:
        assert connection.execute("SELECT content FROM chat_messages WHERE conversation_id=888").fetchone()[0] == "旧消息"
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        assert {"extension_catalog", "extension_files", "extension_mcp_drafts"} <= tables
        assert connection.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0] == db.DB_SCHEMA_VERSION
