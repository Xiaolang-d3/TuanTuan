EXTENSION_SCHEMA = """
CREATE TABLE IF NOT EXISTS extension_catalog (
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
CREATE TABLE IF NOT EXISTS extension_files (
    extension_id TEXT NOT NULL REFERENCES extension_catalog(id),
    path TEXT NOT NULL,
    content BLOB NOT NULL,
    PRIMARY KEY(extension_id, path)
);
CREATE TABLE IF NOT EXISTS extension_mcp_drafts (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    transport TEXT NOT NULL CHECK(transport IN ('http', 'stdio')),
    endpoint TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
"""
