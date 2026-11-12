PRESENTATION_SCHEMA = """
CREATE TABLE IF NOT EXISTS presentation_job_budgets (
    job_id TEXT PRIMARY KEY REFERENCES background_jobs(id),
    calls_used INTEGER NOT NULL DEFAULT 0 CHECK(calls_used BETWEEN 0 AND 48),
    active_seconds REAL NOT NULL DEFAULT 0 CHECK(active_seconds >= 0),
    active_attempt TEXT,
    active_started REAL,
    active_until REAL
);
CREATE TABLE IF NOT EXISTS presentation_model_calls (
    id TEXT PRIMARY KEY,
    job_id TEXT NOT NULL REFERENCES background_jobs(id),
    attempt TEXT NOT NULL,
    stage TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('reserved','completed','unknown')),
    definite_failure INTEGER NOT NULL DEFAULT 0,
    result_hash TEXT NOT NULL DEFAULT '',
    usage_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_presentation_model_calls ON presentation_model_calls(job_id, state);
"""
