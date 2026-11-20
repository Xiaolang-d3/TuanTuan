"""Fresh workspaces contain only current business tables."""
from .library_schema import LIBRARY_CORE_SCHEMA
from ..extensions.schema import EXTENSION_SCHEMA
from ..jobs.schema import JOB_SCHEMA
from ..presentations.schema import PRESENTATION_SCHEMA
from .document_schema import VERSION_SCHEMA, AUTHORED_DOCUMENT_SCHEMA

MODEL_CATALOG_SCHEMA = """
CREATE TABLE IF NOT EXISTS model_catalog_entries (
    connection_id TEXT NOT NULL REFERENCES model_connections(id) ON DELETE CASCADE,
    connection_revision INTEGER NOT NULL,
    model_id TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    discovered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (connection_id, connection_revision, model_id)
);
"""

CURRENT_SCHEMA = """
CREATE TABLE IF NOT EXISTS chat_image_operations (
    id TEXT PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'started' CHECK(status IN ('started','done')),
    selection_json TEXT NOT NULL DEFAULT '{}',
    result_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS chat_image_assets (
    id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL REFERENCES chat_image_operations(id) ON DELETE CASCADE,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    message_id INTEGER REFERENCES chat_messages(id) ON DELETE SET NULL,
    provider_item_id TEXT NOT NULL,
    stored_path TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    UNIQUE(operation_id, provider_item_id)
);
CREATE TABLE IF NOT EXISTS conversations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL DEFAULT '新对话',
                status TEXT NOT NULL DEFAULT 'active',
                summary TEXT NOT NULL DEFAULT '',
                context_cutoff_message_id INTEGER NOT NULL DEFAULT 0,
                model_profile_id TEXT,
                kernel TEXT NOT NULL DEFAULT 'tuantuan',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

CREATE TABLE IF NOT EXISTS conversation_context_seeds (
                conversation_id INTEGER PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
                source_conversation_id INTEGER NOT NULL,
                content TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

CREATE TABLE IF NOT EXISTS conversation_tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id INTEGER NOT NULL,
                title TEXT NOT NULL DEFAULT '当前任务',
                status TEXT NOT NULL DEFAULT 'active',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                completed_at TEXT,
                FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
            );

CREATE TABLE IF NOT EXISTS chat_messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id INTEGER NOT NULL,
                task_id INTEGER,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                payload_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
                FOREIGN KEY (task_id) REFERENCES conversation_tasks(id) ON DELETE SET NULL
            );

CREATE TABLE IF NOT EXISTS attachments (
                id TEXT PRIMARY KEY,
                conversation_id INTEGER NOT NULL,
                kind TEXT NOT NULL,
                object_key TEXT NOT NULL UNIQUE,
                original_filename TEXT NOT NULL,
                content_type TEXT NOT NULL,
                size_bytes INTEGER NOT NULL,
                sha256 TEXT NOT NULL,
                parse_status TEXT NOT NULL DEFAULT 'pending',
                parsed_text TEXT NOT NULL DEFAULT '',
                redacted_text TEXT NOT NULL DEFAULT '',
                metadata_json TEXT NOT NULL DEFAULT '{}',
                vision_status TEXT NOT NULL DEFAULT 'not_requested',
                vision_consent_at TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
            );

CREATE TABLE IF NOT EXISTS knowledge_chunks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_type TEXT NOT NULL,
                source_id TEXT NOT NULL,
                title TEXT NOT NULL DEFAULT '',
                content TEXT NOT NULL,
                metadata_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

CREATE TABLE IF NOT EXISTS agent_settings (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                display_name TEXT NOT NULL DEFAULT '团团',
                persona_role TEXT NOT NULL DEFAULT '理性、坦诚、尊重用户决定，并基于用户资料协助分析与创作的本地 AI 伙伴',
                response_style TEXT NOT NULL DEFAULT 'concise',
                custom_instructions TEXT NOT NULL DEFAULT '',
                library_memory_enabled INTEGER NOT NULL DEFAULT 1,
                conversation_memory_enabled INTEGER NOT NULL DEFAULT 1,
                knowledge_memory_enabled INTEGER NOT NULL DEFAULT 1,
                summary_enabled INTEGER NOT NULL DEFAULT 1,
                context_message_limit INTEGER NOT NULL DEFAULT 12,
                model_name TEXT NOT NULL DEFAULT '',
                model_base_url TEXT NOT NULL DEFAULT '',
                model_protocol TEXT NOT NULL DEFAULT 'auto',
                model_api_key TEXT NOT NULL DEFAULT '',
                user_memory_enabled INTEGER NOT NULL DEFAULT 1,
                connection_id TEXT NOT NULL DEFAULT '',
                config_revision INTEGER NOT NULL DEFAULT 0,
                last_save_request_id TEXT NOT NULL DEFAULT '',
                model_secret_ref TEXT NOT NULL DEFAULT '',
                model_config_initialized INTEGER NOT NULL DEFAULT 0,
                default_model_profile_id TEXT NOT NULL DEFAULT '',
                default_kernel TEXT NOT NULL DEFAULT 'tuantuan',
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

CREATE TABLE IF NOT EXISTS model_settings_requests (
                request_id TEXT PRIMARY KEY,
                payload_fingerprint TEXT NOT NULL,
                saved_revision INTEGER NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

CREATE TABLE IF NOT EXISTS model_service_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                request_kind TEXT NOT NULL,
                status TEXT NOT NULL,
                error_code TEXT NOT NULL DEFAULT '',
                error_message TEXT NOT NULL DEFAULT '',
                latency_ms INTEGER NOT NULL DEFAULT 0,
                total_tokens INTEGER NOT NULL DEFAULT 0,
                model_name TEXT NOT NULL DEFAULT '',
                base_url TEXT NOT NULL DEFAULT '',
                protocol TEXT NOT NULL DEFAULT 'openai',
                response_id TEXT NOT NULL DEFAULT '',
                run_id TEXT NOT NULL DEFAULT '',
                call_id TEXT NOT NULL DEFAULT '',
                profile_id TEXT NOT NULL DEFAULT '',
                connection_id TEXT NOT NULL DEFAULT '',
                connection_revision INTEGER NOT NULL DEFAULT 0,
                profile_revision INTEGER NOT NULL DEFAULT 0,
                stage TEXT NOT NULL DEFAULT '',
                input_tokens INTEGER NOT NULL DEFAULT 0,
                output_tokens INTEGER NOT NULL DEFAULT 0,
                selection_reason TEXT NOT NULL DEFAULT '',
                cost_usd REAL,
                backend TEXT NOT NULL DEFAULT '',
                fallback_from_profile_id TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );

CREATE TABLE IF NOT EXISTS model_connections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    base_url TEXT NOT NULL DEFAULT '',
    effective_base_url TEXT NOT NULL,
    protocol TEXT NOT NULL DEFAULT 'auto',
    detected_protocol TEXT,
    secret_ref TEXT NOT NULL DEFAULT 'none',
    data_boundary TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    deleted_at TEXT,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS model_profiles (
    id TEXT PRIMARY KEY,
    connection_id TEXT NOT NULL REFERENCES model_connections(id),
    model_name TEXT NOT NULL,
    name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    revision INTEGER NOT NULL DEFAULT 1,
    parameters_json TEXT NOT NULL DEFAULT '{}',
    capabilities_json TEXT NOT NULL DEFAULT '{}',
    context_limit INTEGER,
    price_per_million_input REAL,
    price_per_million_output REAL,
    reasoning_effort TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS model_connection_versions (
    connection_id TEXT NOT NULL REFERENCES model_connections(id),
    revision INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (connection_id, revision)
);

CREATE TABLE IF NOT EXISTS model_profile_versions (
    profile_id TEXT NOT NULL REFERENCES model_profiles(id),
    revision INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (profile_id, revision)
);

CREATE TABLE IF NOT EXISTS model_credential_aliases (
    reference TEXT PRIMARY KEY,
    secret_ref TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS model_routing_policy (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL DEFAULT 1,
    payload_json TEXT NOT NULL DEFAULT '{}'
);

-- v29: LiteLLM router fallbacks (one policy per workspace) and per-profile
-- capability overrides that win over live probes and LiteLLM model data.
CREATE TABLE IF NOT EXISTS model_fallback_policy (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    enabled INTEGER NOT NULL DEFAULT 0,
    fallback_profile_ids_json TEXT NOT NULL DEFAULT '[]',
    context_window_profile_ids_json TEXT NOT NULL DEFAULT '[]',
    content_policy_profile_ids_json TEXT NOT NULL DEFAULT '[]',
    retry_policy_json TEXT NOT NULL DEFAULT '{}',
    allowed_fails INTEGER NOT NULL DEFAULT 3,
    cooldown_seconds INTEGER NOT NULL DEFAULT 60,
    revision INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- source = 'user' (manual override) or 'probe' (last live probe result).
CREATE TABLE IF NOT EXISTS model_capability_records (
    profile_id TEXT NOT NULL REFERENCES model_profiles(id),
    capability TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('user', 'probe')),
    status TEXT NOT NULL CHECK (status IN ('supported', 'unsupported')),
    detail TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (profile_id, capability, source)
);

CREATE TABLE IF NOT EXISTS schema_migrations (
                version INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );


CREATE TABLE IF NOT EXISTS agent_run_snapshots (
    conversation_id INTEGER PRIMARY KEY,
    snapshot_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);



CREATE TABLE IF NOT EXISTS agent_execution_runs (
    run_id TEXT PRIMARY KEY,
    conversation_id INTEGER,
    task_id INTEGER,
    user_message_id INTEGER,
    assistant_message_id INTEGER,
    parent_run_id TEXT,
    resumed_by_run_id TEXT,
    user_content TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'queued',
    kernel TEXT NOT NULL DEFAULT 'tuantuan',
    route_kind TEXT NOT NULL DEFAULT '',
    round_number INTEGER NOT NULL DEFAULT 0,
    checkpoint_json TEXT NOT NULL DEFAULT '',
    model_selection_json TEXT NOT NULL DEFAULT '{}',
    result_json TEXT NOT NULL DEFAULT '',
    stop_reason TEXT NOT NULL DEFAULT '',
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (task_id) REFERENCES conversation_tasks(id) ON DELETE SET NULL,
    FOREIGN KEY (user_message_id) REFERENCES chat_messages(id) ON DELETE SET NULL,
    FOREIGN KEY (assistant_message_id) REFERENCES chat_messages(id) ON DELETE SET NULL,
    FOREIGN KEY (parent_run_id) REFERENCES agent_execution_runs(run_id) ON DELETE SET NULL,
    FOREIGN KEY (resumed_by_run_id) REFERENCES agent_execution_runs(run_id) ON DELETE SET NULL,
    CHECK (status IN (
        'queued', 'running', 'waiting_user', 'completed',
        'failed', 'cancelled', 'interrupted'
    ))
);

CREATE TABLE IF NOT EXISTS agent_tool_executions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    tool_call_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    arguments_json TEXT NOT NULL DEFAULT '{}',
    risk TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    result_json TEXT NOT NULL DEFAULT '',
    attempt_count INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT,
    FOREIGN KEY (run_id) REFERENCES agent_execution_runs(run_id) ON DELETE CASCADE,
    UNIQUE(run_id, fingerprint),
    CHECK (status IN (
        'running', 'done', 'failed', 'waiting_approval', 'blocked', 'interrupted'
    ))
);

CREATE TABLE IF NOT EXISTS agent_run_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    step_id TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    title TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    risk TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    started_at TEXT,
    completed_at TEXT,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (run_id) REFERENCES agent_execution_runs(run_id) ON DELETE CASCADE,
    UNIQUE(run_id, step_id),
    CHECK (status IN ('pending', 'running', 'done', 'failed', 'blocked'))
);

CREATE INDEX IF NOT EXISTS idx_agent_execution_runs_conversation
ON agent_execution_runs(conversation_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_execution_runs_status
ON agent_execution_runs(status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_agent_tool_executions_run
ON agent_tool_executions(run_id, status, id);

CREATE INDEX IF NOT EXISTS idx_agent_run_steps_run
ON agent_run_steps(run_id, position, id);



CREATE TABLE IF NOT EXISTS agent_tool_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    round INTEGER NOT NULL,
    tool_call_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    status TEXT NOT NULL,
    latency_ms INTEGER NOT NULL DEFAULT 0,
    error_code TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_tool_call_id
    ON agent_tool_calls(tool_call_id);
CREATE INDEX IF NOT EXISTS idx_agent_tool_calls_conversation_id
    ON agent_tool_calls(conversation_id, created_at);



CREATE TABLE IF NOT EXISTS library_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_kind TEXT NOT NULL DEFAULT 'upload',
    title TEXT NOT NULL,
    original_filename TEXT NOT NULL DEFAULT '',
    mime_type TEXT NOT NULL DEFAULT 'text/plain',
    source_uri TEXT NOT NULL DEFAULT '',
    stored_path TEXT NOT NULL DEFAULT '',
    content TEXT NOT NULL DEFAULT '',
    redacted_content TEXT NOT NULL DEFAULT '',
    privacy_mode TEXT NOT NULL DEFAULT 'redacted',
    enabled INTEGER NOT NULL DEFAULT 1,
    parse_status TEXT NOT NULL DEFAULT 'ready',
    content_hash TEXT NOT NULL,
    character_count INTEGER NOT NULL DEFAULT 0,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (source_kind IN ('upload', 'paste', 'legacy')),
    CHECK (privacy_mode IN ('redacted', 'original')),
    CHECK (parse_status IN ('pending', 'ready', 'failed'))
);
CREATE INDEX IF NOT EXISTS idx_library_sources_enabled_updated
    ON library_sources(enabled, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_library_sources_content_hash
    ON library_sources(content_hash);

CREATE INDEX IF NOT EXISTS idx_chat_conversation ON chat_messages(conversation_id, id);
CREATE INDEX IF NOT EXISTS idx_tasks_conversation ON conversation_tasks(conversation_id, status);
CREATE INDEX IF NOT EXISTS idx_knowledge_source ON knowledge_chunks(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_attachments_conversation ON attachments(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_model_service_events_created_at ON model_service_events(created_at DESC);

CREATE TABLE IF NOT EXISTS memory_summaries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL DEFAULT 0,
    kind TEXT NOT NULL CHECK (kind IN ('fact', 'preference')),
    summary TEXT NOT NULL,
    source_conversation_id INTEGER,
    embedding_json TEXT NOT NULL DEFAULT '[]',
    embedding_backend TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_memory_summaries_kind ON memory_summaries(kind);

CREATE TABLE IF NOT EXISTS memory_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL DEFAULT 0,
    rule TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS memory_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    last_extracted_message_id INTEGER NOT NULL DEFAULT 0,
    last_extraction_at TEXT NOT NULL DEFAULT ''
);

""" + LIBRARY_CORE_SCHEMA + EXTENSION_SCHEMA + JOB_SCHEMA + PRESENTATION_SCHEMA + MODEL_CATALOG_SCHEMA + VERSION_SCHEMA + AUTHORED_DOCUMENT_SCHEMA

AUTH_SCHEMA = """

CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL DEFAULT '',
    avatar_relpath TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS auth_login_attempts (
    throttle_key TEXT PRIMARY KEY,
    failure_count INTEGER NOT NULL DEFAULT 0,
    window_expires_at INTEGER NOT NULL DEFAULT 0,
    locked_until INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);

CREATE TABLE IF NOT EXISTS auth_qq_identities (
    app_id TEXT NOT NULL,
    subject_hash TEXT NOT NULL,
    user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
    qq_only INTEGER NOT NULL CHECK (qq_only IN (0, 1)),
    PRIMARY KEY (app_id, subject_hash)
);
CREATE TABLE IF NOT EXISTS auth_qq_flows (
    key_hash TEXT PRIMARY KEY,
    browser_hash TEXT NOT NULL,
    app_id TEXT NOT NULL,
    session_hash TEXT,
    subject_hash TEXT,
    expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_qq_flows_expiry ON auth_qq_flows(expires_at);

"""
