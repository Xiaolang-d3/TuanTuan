"""Resolve project references against the live, account-local library."""
from ..db import connect


_ELIGIBLE_SOURCES = """
    JOIN project_items link ON link.project_id = scope.project_id AND link.kind = 'library'
        AND link.source_id = CAST(source.id AS TEXT)
    WHERE scope.conversation_id = ? AND source.enabled = 1 AND source.parse_status = 'ready'
        AND CASE WHEN json_valid(source.metadata_json)
            THEN json_extract(source.metadata_json, '$.organization.trashed_at') IS NULL ELSE 0 END
    ORDER BY source.id
"""


def _sources(conn, conversation_id):
    return [dict(row) for row in conn.execute("""
        SELECT source.id, substr(source.title, 1, 240) AS title
        FROM conversation_project_scopes scope
        JOIN conversation_project_sources selected USING (conversation_id)
        JOIN library_sources source ON source.id = selected.source_id
    """ + _ELIGIBLE_SOURCES, (conversation_id,))]


def project_context(conn, conversation_id):
    row = conn.execute("""
        SELECT project.id, project.name FROM conversation_project_scopes scope
        LEFT JOIN projects project ON project.id = scope.project_id
        WHERE scope.conversation_id = ?
    """, (conversation_id,)).fetchone()
    if row is None or row["id"] is None:
        return None
    return {**dict(row), "sources": _sources(conn, conversation_id)}


def project_source_ids(conversation_id, db_path=None) -> set[int] | None:
    """None means ordinary chat; an empty set is a scoped chat with no live grants."""
    if conversation_id is None:
        return None
    with connect(db_path) as conn:
        conn.execute("BEGIN")
        if not conn.execute("SELECT 1 FROM conversation_project_scopes WHERE conversation_id = ?", (conversation_id,)).fetchone():
            return None
        return {source["id"] for source in _sources(conn, conversation_id)}
