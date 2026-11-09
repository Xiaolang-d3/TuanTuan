from unittest.mock import patch

import pytest

from app import db
from app.agent.run_store import AgentRunStore
from app.workspace import ensure_workspace


@pytest.mark.parametrize("missing_column", [True, False])
def test_existing_v27_workspace_upgrades_preserving_history(tmp_path, monkeypatch, missing_column):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "tuantuan.db")
    path = tmp_path / "workspaces" / "7" / "tuantuan.db"
    db.init_db(path)
    with db.connect(path) as conn:
        conversation_id = conn.execute("SELECT id FROM conversations LIMIT 1").fetchone()[0]
        conn.execute("INSERT INTO chat_messages (conversation_id, role, content) VALUES (?, 'user', 'migration test history')", (conversation_id,))
        conn.execute("INSERT INTO agent_execution_runs (run_id, conversation_id, user_content, status) VALUES ('old-run', ?, 'old content', 'completed')", (conversation_id,))
        if missing_column:
            conn.execute("ALTER TABLE agent_execution_runs DROP COLUMN model_selection_json")
        conn.execute("DELETE FROM schema_migrations WHERE version >= 27")
        conn.execute("INSERT INTO schema_migrations (version, name) VALUES (27, 'previous_release')")
    with patch("app.library.sources._index_source") as index:
        ensure_workspace(7)
        ensure_workspace(7)
        index.assert_not_called()
    with db.connect(path) as conn:
        assert conn.execute("SELECT max(version) FROM schema_migrations").fetchone()[0] == db.DB_SCHEMA_VERSION
        assert conn.execute("SELECT content FROM chat_messages").fetchone()[0] == "migration test history"
        assert conn.execute("SELECT model_selection_json FROM agent_execution_runs WHERE run_id='old-run'").fetchone()[0] == "{}"
    run = AgentRunStore(path).start_run("new-run", conversation_id=conversation_id, task_id=None, user_content="new content", model_selection={"profile_id": "test-profile"})
    assert run["run_id"] == "new-run"
    with db.connect(path) as conn:
        assert 'test-profile' in conn.execute("SELECT model_selection_json FROM agent_execution_runs WHERE run_id='new-run'").fetchone()[0]
