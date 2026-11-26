"""Fresh initialization and recoverable, serialized workspace upgrades."""
from __future__ import annotations

import json
import shutil
import sqlite3
import threading
from contextlib import closing
from pathlib import Path

from ..db import DB_SCHEMA_VERSION, connect
from ..workspace import resolve_db_path, resolve_document_dir
from .schema import CURRENT_SCHEMA, MODEL_CATALOG_SCHEMA


_upgrade_lock = threading.RLock()

# schema_migrations.name per version. Versions up to 27 were all recorded as
# 'independent_library' (the v23 library rewrite and its follow-ups).
_MIGRATION_NAMES = {
    49: "project_context",
    48: "workspace_projects",
    47: "final_works",
    46: "conversation_memory_cursors",
    45: "image_studio_history_and_works",
    44: "ppt_definite_failure_retry",
    43: "conversation_kernel_forks",
    42: "user_memory",
    41: "versioned_document_exports",
    40: "authored_document_versions",
    39: "generic_job_model_budgets",
    38: "versioned_document_blocks",
    37: "model_service_removal",
    36: "model_catalog_discovery",
    35: "presentation_model_budgets",
    34: "execution_attempt_fencing",
    33: "background_jobs_and_file_artifacts",
    32: "extension_catalog_and_skills",
    28: "model_protocol_and_reasoning",
    29: "litellm_model_layer",
    30: "unified_models_and_chat_assets",
    31: "library_topic_collections",
}


def migration_name(version: int) -> str:
    return _MIGRATION_NAMES.get(version, "independent_library")


def _backup(path: Path, label: str = "before-library-v23") -> None:
    directory = path.parent / ".upgrade-backups" / label
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    directory.chmod(0o700)
    target = directory / path.name
    if not target.exists():
        temporary = target.with_suffix(".tmp")
        with closing(sqlite3.connect(path)) as source, closing(sqlite3.connect(temporary)) as backup:
            source.backup(backup)
        temporary.chmod(0o600)
        temporary.replace(target)
    # Upgrades never rewrite source files or attachments. Preserve the only
    # historical file we interpret, alongside the coherent SQLite snapshot.
    document = resolve_document_dir(path) / "career-profile.md"
    saved_document = directory / document.name
    if document.exists() and not saved_document.exists():
        shutil.copyfile(document, saved_document)
        saved_document.chmod(0o600)


def initialize_workspace(db_path: str | Path | None = None) -> None:
    path = resolve_db_path(db_path)
    with _upgrade_lock:
        with connect(path) as conn:
            tables = {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
            version = conn.execute("SELECT COALESCE(MAX(version), 0) FROM schema_migrations").fetchone()[0] if "schema_migrations" in tables else 0
        if version == DB_SCHEMA_VERSION:
            # An early v36 build recorded completion while the rebuildable
            # catalog cache was accidentally included in AUTH_SCHEMA. Repair
            # only that cache; never recreate missing business data tables.
            if "model_catalog_entries" not in tables:
                _backup(path, f"before-schema-v{DB_SCHEMA_VERSION}-catalog-repair")
                with connect(path) as conn:
                    conn.executescript(MODEL_CATALOG_SCHEMA)
            from ..extensions.seed import seed_builtin_extensions
            if "extension_catalog" in tables:
                seed_builtin_extensions(path)
            return
        if version > DB_SCHEMA_VERSION:
            raise ValueError("数据库来自更新版本，请升级应用后打开")
        if tables:
            if not 1 <= version < DB_SCHEMA_VERSION:
                raise ValueError("未知数据库格式，未修改原文件")
            if version < 24:
                _backup(path)
            else:
                # v28-v30 only add model columns and tables, but every schema
                # bump keeps a coherent pre-upgrade snapshot like earlier releases.
                _backup(path, f"before-schema-v{DB_SCHEMA_VERSION}")
            if version < 22:
                from ..compatibility.schema_v22 import init_db as upgrade_to_v22
                upgrade_to_v22(path)
        with connect(path) as conn:
            conn.executescript(CURRENT_SCHEMA)
            job_columns = {row[1] for row in conn.execute("PRAGMA table_info(background_jobs)")}
            if "execution_json" not in job_columns:
                conn.execute("ALTER TABLE background_jobs ADD COLUMN execution_json TEXT NOT NULL DEFAULT '{}'")
            columns = {row[1] for row in conn.execute("PRAGMA table_info(agent_settings)")}
            if "profile_memory_enabled" in columns:
                conn.execute("ALTER TABLE agent_settings RENAME COLUMN profile_memory_enabled TO library_memory_enabled")
            for name, definition in {
                "user_memory_enabled": "INTEGER NOT NULL DEFAULT 1",
                "connection_id": "TEXT NOT NULL DEFAULT ''",
                "config_revision": "INTEGER NOT NULL DEFAULT 0",
                "last_save_request_id": "TEXT NOT NULL DEFAULT ''",
                "model_secret_ref": "TEXT NOT NULL DEFAULT ''",
                "model_config_initialized": "INTEGER NOT NULL DEFAULT 0",
                "default_model_profile_id": "TEXT NOT NULL DEFAULT ''",
                "default_kernel": "TEXT NOT NULL DEFAULT 'tuantuan'",
            }.items():
                if name not in columns:
                    conn.execute(f"ALTER TABLE agent_settings ADD COLUMN {name} {definition}")
            # v28: per-connection negotiated protocol and per-profile reasoning effort.
            connection_columns = {row[1] for row in conn.execute("PRAGMA table_info(model_connections)")}
            if "detected_protocol" not in connection_columns:
                conn.execute("ALTER TABLE model_connections ADD COLUMN detected_protocol TEXT")
            if "deleted_at" not in connection_columns:
                conn.execute("ALTER TABLE model_connections ADD COLUMN deleted_at TEXT")
            profile_columns = {row[1] for row in conn.execute("PRAGMA table_info(model_profiles)")}
            if "reasoning_effort" not in profile_columns:
                conn.execute("ALTER TABLE model_profiles ADD COLUMN reasoning_effort TEXT")
            conversation_columns = {row[1] for row in conn.execute("PRAGMA table_info(conversations)")}
            if "model_profile_id" not in conversation_columns:
                conn.execute("ALTER TABLE conversations ADD COLUMN model_profile_id TEXT")
            if "kernel" not in conversation_columns:
                conn.execute("ALTER TABLE conversations ADD COLUMN kernel TEXT NOT NULL DEFAULT 'tuantuan'")
            project_columns = {row[1] for row in conn.execute("PRAGMA table_info(projects)")}
            if "default_model_profile_id" not in project_columns:
                conn.execute("ALTER TABLE projects ADD COLUMN default_model_profile_id TEXT")
            run_columns = {row[1] for row in conn.execute("PRAGMA table_info(agent_execution_runs)")}
            if "model_selection_json" not in run_columns:
                conn.execute("ALTER TABLE agent_execution_runs ADD COLUMN model_selection_json TEXT NOT NULL DEFAULT '{}'")
            if "kernel" not in run_columns:
                conn.execute("ALTER TABLE agent_execution_runs ADD COLUMN kernel TEXT NOT NULL DEFAULT 'tuantuan'")
            event_columns = {row[1] for row in conn.execute("PRAGMA table_info(model_service_events)")}
            for name, definition in {
                "run_id": "TEXT NOT NULL DEFAULT ''", "call_id": "TEXT NOT NULL DEFAULT ''",
                "profile_id": "TEXT NOT NULL DEFAULT ''", "connection_id": "TEXT NOT NULL DEFAULT ''",
                "connection_revision": "INTEGER NOT NULL DEFAULT 0", "profile_revision": "INTEGER NOT NULL DEFAULT 0",
                "stage": "TEXT NOT NULL DEFAULT ''", "input_tokens": "INTEGER NOT NULL DEFAULT 0",
                "output_tokens": "INTEGER NOT NULL DEFAULT 0", "selection_reason": "TEXT NOT NULL DEFAULT ''",
                # v29: estimated USD cost, model backend and router fallback origin.
                "cost_usd": "REAL", "backend": "TEXT NOT NULL DEFAULT ''",
                "fallback_from_profile_id": "TEXT NOT NULL DEFAULT ''",
            }.items():
                if name not in event_columns:
                    conn.execute(f"ALTER TABLE model_service_events ADD COLUMN {name} {definition}")
            # v43: definite provider failures (received HTTP error responses) are
            # recorded so they never fence a retry like unknown outcomes do.
            ppt_call_columns = {row[1] for row in conn.execute("PRAGMA table_info(presentation_model_calls)")}
            if "definite_failure" not in ppt_call_columns:
                conn.execute("ALTER TABLE presentation_model_calls ADD COLUMN definite_failure INTEGER NOT NULL DEFAULT 0")
            conn.execute("UPDATE attachments SET kind = CASE kind WHEN 'resume' THEN 'document' WHEN 'job_screenshot' THEN 'image' ELSE kind END")
            for row in conn.execute("SELECT id, payload_json FROM chat_messages WHERE payload_json LIKE '%attachments%'").fetchall():
                payload = json.loads(row["payload_json"] or "{}")
                if not isinstance(payload, dict):
                    continue
                changed = False
                for attachment in payload.get("attachments") or []:
                    if isinstance(attachment, dict) and attachment.get("kind") in {"resume", "job_screenshot"}:
                        attachment["kind"] = {"resume": "document", "job_screenshot": "image"}[attachment["kind"]]
                        changed = True
                if changed:
                    conn.execute("UPDATE chat_messages SET payload_json = ? WHERE id = ?", (json.dumps(payload, ensure_ascii=False), row["id"]))
            conn.execute("INSERT OR IGNORE INTO agent_settings (id) VALUES (1)")
            if conn.execute("SELECT 1 FROM conversations LIMIT 1").fetchone() is None:
                cursor = conn.execute("INSERT INTO conversations (title) VALUES ('历史对话')")
                conn.execute("INSERT INTO conversation_tasks (conversation_id, title) VALUES (?, '历史任务')", (cursor.lastrowid,))
        if tables and version < 23:
            from ..compatibility.library_v23 import migrate_library
            migrate_library(path)
        # Indexing is a recoverable phase. The completion version is written
        # only after it succeeds; data imports use persisted IDs and markers.
        from ..library.sources import _index_source, enabled_source_details
        # v28 only adds model metadata; existing v27 library indexes remain valid.
        if version < 27:
            for source in enabled_source_details(path):
                _index_source(source, path)
        with connect(path) as conn:
            if version < 38:
                conn.execute("""INSERT OR IGNORE INTO document_source_state(source_kind,source_key,backfill_status)
                    SELECT 'library',CAST(id AS TEXT),'pending' FROM library_sources""")
                conn.execute("""INSERT OR IGNORE INTO document_source_state(source_kind,source_key,backfill_status)
                    SELECT 'attachment',id,'pending' FROM attachments WHERE kind='document'""")
            if tables and version < 45:
                from .studio_migration import backfill_image_studio
                backfill_image_studio(conn)
            if version < 46 and "memory_state" in tables:
                # The legacy cursor was global: preserve the old cutoff without
                # guessing which older conversations were already extracted.
                conn.execute("""
                    INSERT OR IGNORE INTO memory_conversation_state
                        (conversation_id, last_extracted_message_id, last_extraction_at)
                    SELECT messages.conversation_id, MAX(messages.id), state.last_extraction_at
                    FROM memory_state AS state
                    JOIN chat_messages AS messages ON messages.id <= state.last_extracted_message_id
                    JOIN conversations ON conversations.id = messages.conversation_id
                    WHERE state.id = 1 AND messages.role IN ('user', 'assistant')
                    GROUP BY messages.conversation_id
                    """)
                conn.execute("DROP TABLE memory_state")
            conn.execute(
                "INSERT OR IGNORE INTO schema_migrations (version, name) VALUES (?, ?)",
                (DB_SCHEMA_VERSION, migration_name(DB_SCHEMA_VERSION)),
            )
        from ..extensions.seed import seed_builtin_extensions
        seed_builtin_extensions(path)
