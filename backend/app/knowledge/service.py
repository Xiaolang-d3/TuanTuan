from __future__ import annotations

import re
import sqlite3
from contextlib import nullcontext
from pathlib import Path
from typing import Any

from ..db import connect, json_dump, row_to_dict
from .embeddings import EmbeddingSpec, get_embedder


def index_document(
    source_type: str,
    source_id: str | int,
    title: str,
    content: str,
    metadata: dict[str, Any] | None = None,
    db_path: str | Path | None = None,
) -> int:
    """Index redacted/local text with the current on-device embedder."""
    return index_chunks(source_type, source_id, [
        {"title": title, "content": chunk, "metadata": metadata or {}} for chunk in _chunk_text(content)
    ], db_path)


def _embedding_items(items, embedder):
    split = getattr(embedder, "split_for_embedding", None)
    if not callable(split):
        return items
    expanded = []
    for item in items:
        metadata = item.get("metadata") or {}
        start, end = metadata.get("embedding_start", 0), metadata.get("embedding_end", len(item["content"]))
        for left, right in split(item["content"][start:end]):
            expanded.append({**item, "metadata": {**metadata, "embedding_start": start + left, "embedding_end": start + right}})
    return expanded


def _embedding_text(item):
    metadata = item.get("metadata") or {}
    return item["content"][metadata.get("embedding_start", 0):metadata.get("embedding_end", len(item["content"]))]


def index_chunks(
    source_type: str,
    source_id: str | int,
    chunks: list[dict[str, Any]],
    db_path: str | Path | None = None,
    *,
    connection: sqlite3.Connection | None = None,
) -> int:
    """Index pre-cut text blocks, preserving caller metadata such as block_id."""
    items = [
        item for item in chunks
        if str(item.get("content") or "").strip()
    ]
    if not items:
        delete_document(source_type, source_id, db_path, connection=connection)
        return 0
    embedder = get_embedder()
    with (nullcontext(connection) if connection is not None else connect(db_path)) as conn:
        vectors_available = _ensure_vectors(conn)
        if vectors_available:
            items = _embedding_items(items, embedder)
        existing = conn.execute(
            "SELECT id FROM knowledge_chunks WHERE source_type = ? AND source_id = ?",
            (source_type, str(source_id)),
        ).fetchall()
        if vectors_available:
            for row in existing:
                conn.execute("DELETE FROM vec_knowledge WHERE rowid = ?", (row["id"],))
        conn.execute(
            "DELETE FROM knowledge_chunks WHERE source_type = ? AND source_id = ?",
            (source_type, str(source_id)),
        )
        contents = [_embedding_text(item) for item in items]
        vectors = embedder.embed_many(contents) if vectors_available else []
        if vectors_available and len(vectors) != len(items):
            raise ValueError("embedding 返回数量不完整，索引未激活")
        for item, vector in zip(items, vectors or [None] * len(items)):
            cursor = conn.execute(
                """
                INSERT INTO knowledge_chunks (source_type, source_id, title, content, metadata_json)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    source_type,
                    str(source_id),
                    str(item.get("title") or "")[:200],
                    str(item["content"]),
                    json_dump(item.get("metadata") or {}),
                ),
            )
            if vectors_available and vector is not None:
                conn.execute(
                    "INSERT INTO vec_knowledge(rowid, embedding) VALUES (?, ?)",
                    (cursor.lastrowid, _serialize(vector)),
                )
    return len(items)


def search_knowledge(
    query: str,
    source_types: list[str] | None = None,
    limit: int = 5,
    db_path: str | Path | None = None,
    *,
    relevant_only: bool = False,
    source_filters: list[tuple[str, str, str | None]] | None = None,
    allow_unversioned: bool = False,
) -> list[dict[str, Any]]:
    if not query.strip():
        return []
    clauses, parameters = [], []
    if source_types:
        clauses.append("source_type IN (" + ",".join("?" for _ in source_types) + ")")
        parameters.extend(source_types)
    if source_filters is not None:
        clauses.append("""EXISTS (SELECT 1 FROM authorized_knowledge a
            WHERE a.source_type=knowledge_chunks.source_type AND a.source_id=knowledge_chunks.source_id
            AND (a.revision IS NULL OR a.revision=json_extract(knowledge_chunks.metadata_json,'$.source_revision')"""
            + (" OR json_extract(knowledge_chunks.metadata_json,'$.source_revision') IS NULL" if allow_unversioned else "") + "))")
    scope = " AND ".join(clauses) or "1"
    candidate_limit = max(limit * 4, 12)
    terms = sorted(_query_terms(query)) or [query.strip().casefold()]
    vectors = []
    with connect(db_path) as conn:
        if source_filters is not None:
            conn.execute("CREATE TEMP TABLE authorized_knowledge(source_type TEXT,source_id TEXT,revision TEXT)")
            conn.executemany("INSERT INTO authorized_knowledge VALUES(?,?,?)", source_filters)
            conn.execute("CREATE INDEX authorized_knowledge_identity ON authorized_knowledge(source_type,source_id)")
        try:
            if not _ensure_vectors(conn):
                raise RuntimeError("vector extension unavailable")
            vectors = conn.execute(
                f"""
                SELECT chunks.*, v.distance
                FROM vec_knowledge v JOIN knowledge_chunks chunks ON chunks.id = v.rowid
                WHERE v.embedding MATCH ? AND k = ?
                AND v.rowid IN (SELECT id FROM knowledge_chunks WHERE {scope})
                ORDER BY v.distance
                """,
                (_serialize(get_embedder().embed(query)), candidate_limit, *parameters),
            ).fetchall()
        except Exception:
            pass
        # Always supplement vectors with deterministic lexical candidates. A
        # model's token truncation or poor vector cannot hide a stored tail fact.
        escaped = [term.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") for term in terms]
        lexical = conn.execute(
            f"SELECT *,0.0 AS distance FROM knowledge_chunks WHERE ({scope}) AND ("
            + " OR ".join("content LIKE ? ESCAPE '\\'" for _ in escaped)
            + ") GROUP BY source_type,source_id,COALESCE(json_extract(metadata_json,'$.block_id'),content)"
            + " ORDER BY (instr(lower(content),lower(?))>0) DESC,id LIMIT ?",
            (*parameters, *(f"%{term}%" for term in escaped), query.strip(), candidate_limit),
        ).fetchall()
    rows = [row_to_dict(row) for row in vectors]
    if relevant_only:
        if get_embedder().spec.backend == "hash":
            # Hash vectors rank lexical features; collisions are not evidence.
            rows = [row for row in rows if any(term in row["content"].casefold() for term in terms)]
        else:
            # Embedders produce unit vectors; sqlite-vec reports L2 distance.
            # A conservative cosine floor removes clearly unrelated neighbours.
            rows = [row for row in rows if 1.0 - float(row["distance"]) ** 2 / 2 >= 0.3]
    merged = {row["id"]: row_to_dict(row) for row in lexical}
    for row in rows:
        merged.setdefault(row["id"], row)
    return [
        {
            **row,
            "similarity": round(max(0.0, 1.0 - float(row.pop("distance", 1.0))), 4),
        }
        for row in list(merged.values())[:limit]
    ]


def _query_terms(query: str) -> set[str]:
    terms = set(re.findall(r"[a-z0-9][a-z0-9.+#-]*", query.casefold()))
    generic = {"帮我", "一下", "整理", "大家", "情况", "相关", "资料", "信息", "内容", "请问", "关于", "最近", "近期", "我的"}
    for run in re.findall(r"[\u4e00-\u9fff]+", query):
        terms.update(run[index:index + 2] for index in range(len(run) - 1))
    return terms - generic


def list_knowledge_chunks(
    source_types: list[str] | None = None,
    limit: int = 10,
    db_path: str | Path | None = None,
) -> list[dict[str, Any]]:
    """按写入顺序读取分块原文，供检索未命中时兜底返回。"""
    with connect(db_path) as conn:
        if source_types:
            placeholders = ", ".join("?" for _ in source_types)
            rows = conn.execute(
                "SELECT * FROM knowledge_chunks WHERE source_type IN "
                f"({placeholders}) ORDER BY id LIMIT ?",
                (*source_types, limit),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM knowledge_chunks ORDER BY id LIMIT ?",
                (limit,),
            ).fetchall()
    return [row_to_dict(row) for row in rows]


def delete_document(
    source_type: str,
    source_id: str | int,
    db_path: str | Path | None = None,
    *,
    connection: sqlite3.Connection | None = None,
) -> int:
    """Delete a source document and its vector rows from the local knowledge store."""
    with (nullcontext(connection) if connection is not None else connect(db_path)) as conn:
        rows = conn.execute(
            "SELECT id FROM knowledge_chunks WHERE source_type = ? AND source_id = ?",
            (source_type, str(source_id)),
        ).fetchall()
        row_ids = [row["id"] for row in rows]
        if row_ids:
            try:
                _load_sqlite_vec(conn)
                conn.executemany(
                    "DELETE FROM vec_knowledge WHERE rowid = ?",
                    ((row_id,) for row_id in row_ids),
                )
            except Exception:
                # The text rows remain authoritative when the optional native
                # vector extension is unavailable on the current machine.
                pass
        conn.execute(
            "DELETE FROM knowledge_chunks WHERE source_type = ? AND source_id = ?",
            (source_type, str(source_id)),
        )
    return len(row_ids)


def rebuild_knowledge_index(db_path: str | Path | None = None) -> dict[str, Any]:
    """Drop and rebuild vec_knowledge from stored chunk text."""
    spec = get_embedder().spec
    with connect(db_path) as conn:
        try:
            _load_sqlite_vec(conn)
        except Exception as exc:
            return {
                "rebuilt": False,
                "reason": str(exc),
                "chunks": 0,
                **_spec_payload(spec),
            }
        conn.execute("DROP TABLE IF EXISTS knowledge_index_meta")
        conn.execute("DROP TABLE IF EXISTS vec_knowledge")
        rebuilt = _ensure_vectors(conn)
        chunks = conn.execute("SELECT COUNT(*) AS count FROM knowledge_chunks").fetchone()["count"]
    return {
        "rebuilt": rebuilt,
        "reason": "" if rebuilt else "vector extension unavailable",
        "chunks": int(chunks),
        **_spec_payload(spec),
    }


def knowledge_index_info(db_path: str | Path | None = None) -> dict[str, Any]:
    spec = get_embedder().spec
    with connect(db_path) as conn:
        stored = None
        try:
            stored = _read_meta(conn)
        except Exception:
            stored = None
        return {
            **_spec_payload(spec),
            "stored": stored,
            "table_dimensions": _vec_table_dimensions(conn),
        }


def _ensure_vectors(conn) -> bool:
    try:
        _load_sqlite_vec(conn)
    except Exception:
        return False
    spec = get_embedder().spec
    _ensure_meta_table(conn)
    existing_dim = _vec_table_dimensions(conn)
    stored = _read_meta(conn)
    needs_rebuild = (
        existing_dim != spec.dimensions
        or stored is None
        or stored["backend"] != spec.backend
        or stored["model"] != spec.model
        or int(stored["dimensions"]) != spec.dimensions
        or int(stored["processing_version"]) != spec.processing_version
    )
    if needs_rebuild:
        if existing_dim is not None:
            conn.execute("DROP TABLE IF EXISTS vec_knowledge")
        conn.execute(
            f"CREATE VIRTUAL TABLE vec_knowledge USING vec0(embedding float[{spec.dimensions}])"
        )
        _reembed_all(conn, spec)
        _write_meta(conn, spec)
    return True


def _reembed_all(conn, spec: EmbeddingSpec) -> None:
    # Bound rebuild batches and exclude newly created child rows from this scan.
    highest = conn.execute("SELECT COALESCE(MAX(id),0) FROM knowledge_chunks").fetchone()[0]
    last, embedder = 0, get_embedder()
    while last < highest:
        rows = conn.execute("SELECT * FROM knowledge_chunks WHERE id>? AND id<=? ORDER BY id LIMIT 64", (last, highest)).fetchall()
        if not rows:
            break
        expanded = []
        for row in rows:
            parts = _embedding_items([row_to_dict(row)], embedder)
            for index, part in enumerate(parts):
                if index == 0:
                    conn.execute("UPDATE knowledge_chunks SET metadata_json=? WHERE id=?", (json_dump(part.get("metadata") or {}), row["id"]))
                else:
                    cursor = conn.execute("INSERT INTO knowledge_chunks(source_type,source_id,title,content,metadata_json) VALUES(?,?,?,?,?)",
                        (part["source_type"], part["source_id"], part["title"], part["content"], json_dump(part.get("metadata") or {})))
                    part = {**part, "id": cursor.lastrowid}
                expanded.append(part)
        vectors = embedder.embed_many([_embedding_text(part) for part in expanded])
        if len(vectors) != len(expanded) or any(len(vector) != spec.dimensions for vector in vectors):
            raise RuntimeError("embedding result does not match the current index")
        for part, vector in zip(expanded, vectors):
            conn.execute("INSERT INTO vec_knowledge(rowid, embedding) VALUES (?, ?)", (part["id"], _serialize(vector)))
        last = rows[-1]["id"]


def _load_sqlite_vec(conn) -> None:
    import sqlite_vec

    conn.enable_load_extension(True)
    sqlite_vec.load(conn)
    conn.enable_load_extension(False)


def _ensure_meta_table(conn) -> None:
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS knowledge_index_meta (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            backend TEXT NOT NULL,
            model TEXT NOT NULL,
            dimensions INTEGER NOT NULL,
            processing_version INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    if "processing_version" not in {row["name"] for row in conn.execute("PRAGMA table_info(knowledge_index_meta)")}:
        conn.execute("ALTER TABLE knowledge_index_meta ADD COLUMN processing_version INTEGER NOT NULL DEFAULT 0")


def _read_meta(conn) -> dict[str, Any] | None:
    try:
        row = conn.execute(
            "SELECT backend, model, dimensions, processing_version FROM knowledge_index_meta WHERE id = 1"
        ).fetchone()
    except Exception:
        return None
    return dict(row) if row else None


def _write_meta(conn, spec: EmbeddingSpec) -> None:
    _ensure_meta_table(conn)
    conn.execute(
        """
        INSERT INTO knowledge_index_meta (id, backend, model, dimensions, processing_version, updated_at)
        VALUES (1, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(id) DO UPDATE SET
            backend = excluded.backend,
            model = excluded.model,
            dimensions = excluded.dimensions,
            processing_version = excluded.processing_version,
            updated_at = CURRENT_TIMESTAMP
        """,
        (spec.backend, spec.model, spec.dimensions, spec.processing_version),
    )


def _vec_table_dimensions(conn) -> int | None:
    row = conn.execute(
        "SELECT sql FROM sqlite_master WHERE name = 'vec_knowledge'"
    ).fetchone()
    if not row or not row["sql"]:
        return None
    match = re.search(r"float\[(\d+)\]", row["sql"])
    return int(match.group(1)) if match else None


def _serialize(vector: list[float]) -> bytes:
    import sqlite_vec

    return sqlite_vec.serialize_float32(vector)


def _spec_payload(spec: EmbeddingSpec) -> dict[str, Any]:
    return {
        "backend": spec.backend,
        "model": spec.model,
        "dimensions": spec.dimensions,
        "processing_version": spec.processing_version,
    }


def _chunk_text(text: str, max_chars: int = 900) -> list[str]:
    paragraphs = [item.strip() for item in re.split(r"\n{2,}", text) if item.strip()]
    if not paragraphs and text.strip():
        paragraphs = [text.strip()]
    chunks: list[str] = []
    current = ""
    for paragraph in paragraphs:
        if current and len(current) + len(paragraph) + 1 > max_chars:
            chunks.append(current)
            current = ""
        while len(paragraph) > max_chars:
            chunks.append(paragraph[:max_chars])
            paragraph = paragraph[max_chars:]
        current = f"{current}\n{paragraph}".strip()
    if current:
        chunks.append(current)
    return chunks
