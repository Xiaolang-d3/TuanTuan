JOB_SCHEMA = """
CREATE TABLE IF NOT EXISTS background_jobs (
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
CREATE TABLE IF NOT EXISTS background_job_events (
    cursor INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL REFERENCES background_jobs(id),
    type TEXT NOT NULL,
    data_json TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_background_job_events ON background_job_events(job_id, cursor);
CREATE TABLE IF NOT EXISTS file_artifacts (
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
CREATE TABLE IF NOT EXISTS job_model_budgets (
    job_id TEXT PRIMARY KEY REFERENCES background_jobs(id),
    calls_limit INTEGER NOT NULL, input_tokens_limit INTEGER NOT NULL,
    output_tokens_limit INTEGER NOT NULL, active_seconds_limit INTEGER NOT NULL,
    calls_used INTEGER NOT NULL DEFAULT 0, input_tokens_used INTEGER NOT NULL DEFAULT 0,
    output_tokens_used INTEGER NOT NULL DEFAULT 0, active_seconds REAL NOT NULL DEFAULT 0,
    active_attempt TEXT, active_started REAL, active_until REAL
);
CREATE TABLE IF NOT EXISTS job_model_calls (
    id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES background_jobs(id),
    attempt TEXT NOT NULL, stage TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('reserved','completed','unknown')),
    input_reserved INTEGER NOT NULL, output_reserved INTEGER NOT NULL,
    result_hash TEXT, usage_json TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT, UNIQUE(job_id,stage)
);
CREATE TABLE IF NOT EXISTS job_budget_confirmations (
    job_id TEXT NOT NULL REFERENCES background_jobs(id), stage_id TEXT NOT NULL,
    revision INTEGER NOT NULL, idempotency_key TEXT NOT NULL, answer_hash TEXT NOT NULL,
    PRIMARY KEY(job_id,stage_id), UNIQUE(job_id,idempotency_key)
);
"""
