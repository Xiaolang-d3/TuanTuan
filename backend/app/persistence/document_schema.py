"""Immutable document text and lightweight migration state."""

VERSION_SCHEMA = """
CREATE TABLE IF NOT EXISTS document_source_versions (
 source_kind TEXT NOT NULL, source_key TEXT NOT NULL, revision TEXT NOT NULL,
 text TEXT NOT NULL, redacted_text TEXT NOT NULL, parser TEXT NOT NULL,
 content_hash TEXT NOT NULL, structure_hash TEXT NOT NULL, blocks_json TEXT NOT NULL,
 complete INTEGER NOT NULL, units_json TEXT NOT NULL, unprocessed_json TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(source_kind,source_key,revision)
);
CREATE TABLE IF NOT EXISTS document_source_state (
 source_kind TEXT NOT NULL, source_key TEXT NOT NULL, current_revision TEXT,
 backfill_status TEXT NOT NULL DEFAULT 'pending', job_id TEXT, error_code TEXT NOT NULL DEFAULT '',
 PRIMARY KEY(source_kind,source_key)
);
"""

AUTHORED_DOCUMENT_SCHEMA = """
CREATE TABLE IF NOT EXISTS authored_documents (
 id TEXT PRIMARY KEY, conversation_id INTEGER NOT NULL, message_id INTEGER NOT NULL,
 title TEXT NOT NULL, latest_version INTEGER NOT NULL DEFAULT 1,
 incomplete INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS authored_document_versions (
 document_id TEXT NOT NULL REFERENCES authored_documents(id) ON DELETE CASCADE,
 version INTEGER NOT NULL, parent_document_version INTEGER,
 markdown TEXT NOT NULL, evidence_json TEXT NOT NULL, citations_json TEXT NOT NULL,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(document_id,version)
);
CREATE TABLE IF NOT EXISTS authored_document_resources (
 id TEXT PRIMARY KEY, document_id TEXT NOT NULL REFERENCES authored_documents(id) ON DELETE CASCADE,
 filename TEXT NOT NULL, mime_type TEXT NOT NULL, sha256 TEXT NOT NULL,
 size_bytes INTEGER NOT NULL, uri TEXT NOT NULL, UNIQUE(document_id,id)
);
CREATE TABLE IF NOT EXISTS authored_document_version_resources (
 document_id TEXT NOT NULL, version INTEGER NOT NULL, resource_id TEXT NOT NULL,
 ordinal INTEGER NOT NULL,
 PRIMARY KEY(document_id,version,resource_id),
 FOREIGN KEY(document_id,version) REFERENCES authored_document_versions(document_id,version) ON DELETE CASCADE,
 FOREIGN KEY(document_id,resource_id) REFERENCES authored_document_resources(document_id,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS authored_document_receipts (
 idempotency_key TEXT PRIMARY KEY, operation TEXT NOT NULL, request_hash TEXT NOT NULL,
 result_json TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS document_exports (
 document_id TEXT NOT NULL, document_version INTEGER NOT NULL,
 format TEXT NOT NULL CHECK(format IN ('docx','pdf')), exporter_version TEXT NOT NULL,
 source_hash TEXT NOT NULL, job_id TEXT NOT NULL REFERENCES background_jobs(id),
 artifact_id TEXT, artifact_version INTEGER,
 PRIMARY KEY(document_id,document_version,format,exporter_version),
 FOREIGN KEY(document_id,document_version) REFERENCES authored_document_versions(document_id,version) ON DELETE CASCADE,
 FOREIGN KEY(artifact_id,artifact_version) REFERENCES file_artifacts(id,version)
);
"""
