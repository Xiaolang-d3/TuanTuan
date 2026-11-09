BEGIN TRANSACTION;
CREATE TABLE agent_execution_runs (
    run_id TEXT PRIMARY KEY,
    conversation_id INTEGER,
    task_id INTEGER,
    user_message_id INTEGER,
    assistant_message_id INTEGER,
    parent_run_id TEXT,
    resumed_by_run_id TEXT,
    user_content TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'queued',
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
CREATE TABLE agent_run_snapshots (
    conversation_id INTEGER PRIMARY KEY,
    snapshot_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
);
CREATE TABLE agent_run_steps (
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
CREATE TABLE agent_settings (
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
                connection_id TEXT NOT NULL DEFAULT '',
                config_revision INTEGER NOT NULL DEFAULT 0,
                last_save_request_id TEXT NOT NULL DEFAULT '',
                model_secret_ref TEXT NOT NULL DEFAULT '',
                model_config_initialized INTEGER NOT NULL DEFAULT 0,
                default_model_profile_id TEXT NOT NULL DEFAULT '',
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
CREATE TABLE agent_tool_calls (
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
CREATE TABLE agent_tool_executions (
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
CREATE TABLE attachments (
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
CREATE TABLE background_job_events (
    cursor INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL REFERENCES background_jobs(id),
    type TEXT NOT NULL,
    data_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE background_jobs (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    request_hash TEXT NOT NULL,
    request_json TEXT NOT NULL,
    snapshot_json TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('queued','running','waiting_user','succeeded','failed','cancelled','interrupted')),
    revision INTEGER NOT NULL DEFAULT 1,
    checkpoint_json TEXT NOT NULL DEFAULT '{}',
    execution_json TEXT NOT NULL DEFAULT '{}',
    confirmation_json TEXT,
    result_json TEXT,
    error TEXT NOT NULL DEFAULT '',
    stage_id TEXT,
    prompt TEXT NOT NULL DEFAULT '',
    answer_schema_json TEXT NOT NULL DEFAULT '{}',
    owner_token TEXT,
    lease_expires REAL,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE chat_image_assets (
    id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL REFERENCES chat_image_operations(id) ON DELETE CASCADE,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    message_id INTEGER REFERENCES chat_messages(id) ON DELETE SET NULL,
    provider_item_id TEXT NOT NULL,
    stored_path TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    UNIQUE(operation_id, provider_item_id)
);
CREATE TABLE chat_image_operations (
    id TEXT PRIMARY KEY,
    conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'started' CHECK(status IN ('started','done')),
    selection_json TEXT NOT NULL DEFAULT '{}',
    result_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE chat_messages (
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
CREATE TABLE conversation_tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                conversation_id INTEGER NOT NULL,
                title TEXT NOT NULL DEFAULT '当前任务',
                status TEXT NOT NULL DEFAULT 'active',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                completed_at TEXT,
                FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
            );
CREATE TABLE conversations (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL DEFAULT '新对话',
                status TEXT NOT NULL DEFAULT 'active',
                summary TEXT NOT NULL DEFAULT '',
                context_cutoff_message_id INTEGER NOT NULL DEFAULT 0,
                model_profile_id TEXT,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
CREATE TABLE document_source_state (
 source_kind TEXT NOT NULL, source_key TEXT NOT NULL, current_revision TEXT,
 backfill_status TEXT NOT NULL DEFAULT 'pending', job_id TEXT, error_code TEXT NOT NULL DEFAULT '',
 PRIMARY KEY(source_kind,source_key)
);
CREATE TABLE document_source_versions (
 source_kind TEXT NOT NULL, source_key TEXT NOT NULL, revision TEXT NOT NULL,
 text TEXT NOT NULL, redacted_text TEXT NOT NULL, parser TEXT NOT NULL,
 content_hash TEXT NOT NULL, structure_hash TEXT NOT NULL, blocks_json TEXT NOT NULL,
 complete INTEGER NOT NULL, units_json TEXT NOT NULL, unprocessed_json TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(source_kind,source_key,revision)
);
CREATE TABLE extension_catalog (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('skill', 'plugin')),
    revision TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    content TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'installed',
    deleted INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE extension_files (
    extension_id TEXT NOT NULL REFERENCES extension_catalog(id),
    path TEXT NOT NULL,
    content BLOB NOT NULL,
    PRIMARY KEY(extension_id, path)
);
CREATE TABLE extension_mcp_drafts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    transport TEXT NOT NULL CHECK(transport IN ('http', 'stdio')),
    endpoint TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE file_artifacts (
    id TEXT NOT NULL,
    version INTEGER NOT NULL,
    job_id TEXT NOT NULL REFERENCES background_jobs(id),
    filename TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    size INTEGER NOT NULL,
    media_type TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(id, version),
    UNIQUE(job_id, filename, content_hash)
);
CREATE TABLE knowledge_chunks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_type TEXT NOT NULL,
                source_id TEXT NOT NULL,
                title TEXT NOT NULL DEFAULT '',
                content TEXT NOT NULL,
                metadata_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
CREATE TABLE library_collection_sources (
    collection_id INTEGER NOT NULL REFERENCES library_collections(id) ON DELETE CASCADE,
    source_id INTEGER NOT NULL REFERENCES library_sources(id) ON DELETE CASCADE,
    PRIMARY KEY (collection_id, source_id)
);
CREATE TABLE library_collections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE library_evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    knowledge_id INTEGER NOT NULL,
    source_id INTEGER,
    excerpt TEXT NOT NULL DEFAULT '',
    locator TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (knowledge_id) REFERENCES library_knowledge(id) ON DELETE CASCADE
);
CREATE TABLE library_folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE library_knowledge (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    library_id INTEGER NOT NULL,
    category TEXT NOT NULL,
    statement TEXT NOT NULL,
    canonical_key TEXT NOT NULL DEFAULT '',
    value_json TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'pending',
    sensitivity TEXT NOT NULL DEFAULT 'private',
    confidence REAL NOT NULL DEFAULT 0,
    source_kind TEXT NOT NULL DEFAULT 'agent_proposal',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    superseded_by_id INTEGER,
    expires_at TEXT,
    reviewed_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (status IN ('pending', 'confirmed', 'disputed', 'retracted', 'superseded')),
    CHECK (sensitivity IN ('public', 'private', 'sensitive')),
    FOREIGN KEY (superseded_by_id) REFERENCES library_knowledge(id) ON DELETE SET NULL
);
CREATE TABLE library_metadata (
 id INTEGER PRIMARY KEY CHECK(id = 1), name TEXT NOT NULL DEFAULT '用户',
 privacy_mode TEXT NOT NULL DEFAULT 'redacted' CHECK(privacy_mode IN ('redacted', 'original')),
 locale TEXT NOT NULL DEFAULT 'zh-CN', knowledge_revision INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE library_sources (
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
CREATE TABLE model_capability_records (
    profile_id TEXT NOT NULL REFERENCES model_profiles(id),
    capability TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('user', 'probe')),
    status TEXT NOT NULL CHECK (status IN ('supported', 'unsupported')),
    detail TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (profile_id, capability, source)
);
CREATE TABLE model_catalog_entries (
    connection_id TEXT NOT NULL REFERENCES model_connections(id) ON DELETE CASCADE,
    connection_revision INTEGER NOT NULL,
    model_id TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    discovered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (connection_id, connection_revision, model_id)
);
CREATE TABLE model_connection_versions (
    connection_id TEXT NOT NULL REFERENCES model_connections(id),
    revision INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (connection_id, revision)
);
CREATE TABLE model_connections (
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
CREATE TABLE model_credential_aliases (
    reference TEXT PRIMARY KEY,
    secret_ref TEXT NOT NULL
);
CREATE TABLE model_fallback_policy (
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
CREATE TABLE model_profile_versions (
    profile_id TEXT NOT NULL REFERENCES model_profiles(id),
    revision INTEGER NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (profile_id, revision)
);
CREATE TABLE model_profiles (
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
CREATE TABLE model_routing_policy (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    version INTEGER NOT NULL DEFAULT 1,
    payload_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE model_service_events (
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
CREATE TABLE model_settings_requests (
                request_id TEXT PRIMARY KEY,
                payload_fingerprint TEXT NOT NULL,
                saved_revision INTEGER NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
CREATE TABLE presentation_job_budgets (
    job_id TEXT PRIMARY KEY REFERENCES background_jobs(id),
    calls_used INTEGER NOT NULL DEFAULT 0 CHECK(calls_used BETWEEN 0 AND 48),
    active_seconds REAL NOT NULL DEFAULT 0 CHECK(active_seconds >= 0),
    active_attempt TEXT,
    active_started REAL,
    active_until REAL
);
CREATE TABLE presentation_model_calls (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES background_jobs(id),
    attempt TEXT NOT NULL,
    stage TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('reserved','completed','unknown')),
    result_hash TEXT NOT NULL DEFAULT '',
    usage_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT
);
CREATE TABLE schema_migrations (
                version INTEGER PRIMARY KEY,
                name TEXT NOT NULL,
                applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
CREATE INDEX idx_agent_execution_runs_conversation
ON agent_execution_runs(conversation_id, updated_at DESC);
CREATE INDEX idx_agent_execution_runs_status
ON agent_execution_runs(status, updated_at DESC);
CREATE INDEX idx_agent_tool_executions_run
ON agent_tool_executions(run_id, status, id);
CREATE INDEX idx_agent_run_steps_run
ON agent_run_steps(run_id, position, id);
CREATE INDEX idx_agent_tool_calls_tool_call_id
    ON agent_tool_calls(tool_call_id);
CREATE INDEX idx_agent_tool_calls_conversation_id
    ON agent_tool_calls(conversation_id, created_at);
CREATE INDEX idx_library_sources_enabled_updated
    ON library_sources(enabled, updated_at DESC);
CREATE INDEX idx_library_sources_content_hash
    ON library_sources(content_hash);
CREATE INDEX idx_chat_conversation ON chat_messages(conversation_id, id);
CREATE INDEX idx_tasks_conversation ON conversation_tasks(conversation_id, status);
CREATE INDEX idx_knowledge_source ON knowledge_chunks(source_type, source_id);
CREATE INDEX idx_attachments_conversation ON attachments(conversation_id, created_at DESC);
CREATE INDEX idx_model_service_events_created_at ON model_service_events(created_at DESC);
CREATE INDEX idx_library_collection_source ON library_collection_sources(source_id);
CREATE INDEX idx_library_knowledge_status ON library_knowledge(status, id);
CREATE INDEX idx_library_evidence_item ON library_evidence(knowledge_id, id);
CREATE INDEX idx_background_job_events ON background_job_events(job_id, cursor);
CREATE INDEX idx_presentation_model_calls ON presentation_model_calls(job_id, state);
DELETE FROM "sqlite_sequence";
INSERT INTO schema_migrations(version,name) VALUES(38,'versioned_document_blocks');
INSERT INTO conversations(title) VALUES('fixture-conversation');
COMMIT;
