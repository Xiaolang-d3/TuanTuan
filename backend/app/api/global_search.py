"""Bounded, read-only keyword search in the caller's authenticated workspace."""
import sqlite3
from contextlib import closing
from pathlib import Path
from typing import Annotated, Literal

from fastapi import APIRouter, HTTPException, Query, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel

from ..branding import DATABASE_NAME
from ..chat.studio_generate import current_task_id
from ..privacy import scan_and_redact
from ..redaction import redact_secrets
from ..workspace import snapshot_workspace

_NO_STORE = {"Cache-Control": "no-store"}


class _SearchRoute(APIRoute):
    def get_route_handler(self):
        handle = super().get_route_handler()

        async def handle_search(request: Request) -> Response:
            try:
                return await handle(request)
            except RequestValidationError:
                # FastAPI's default validation body includes the invalid input.
                return JSONResponse({"detail": "无效的搜索参数"}, status_code=422, headers=_NO_STORE)

        return handle_search


router = APIRouter(tags=["global search"], route_class=_SearchRoute)
SearchKind = Literal[
    "chat", "image", "document", "presentation", "project", "image_work", "final_work", "knowledge"
]


class SearchResult(BaseModel):
    kind: SearchKind
    id: str
    title: str
    updated_at: str
    conversation_id: int | None
    status: str | None


class SearchPage(BaseModel):
    items: list[SearchResult]
    has_more: bool


def _matches(text: str | None, needle: str) -> bool:
    return isinstance(text, str) and needle in text.casefold()


def _chat_title(title: str, first_message: str | None) -> str:
    # Auto titles are a literal prefix of the first message; fork titles can
    # carry that same prefix from another conversation.
    if title.endswith("（分支）") or title == " ".join((first_message or "").strip().split())[:28]:
        return "对话"
    return title


def _document_title(title: str, markdown_prefix: str | None) -> str:
    # Document titles come from the first nonempty line, which may be a private
    # paragraph rather than an explicitly marked title.
    first_line = next((line for line in (markdown_prefix or "").splitlines() if line.strip()), "")
    return title if first_line.startswith("# ") else "文档"


# Use the same visibility rules as creation records and the original read APIs.
# Predicates may match private data locally, but the SELECT lists are metadata
# only. In particular, neither the Studio prompt nor the PPT request is a title.
_UTC = "%Y-%m-%dT%H:%M:%fZ"
_UNTRASHED = """CASE WHEN json_valid(s.metadata_json)
    THEN json_extract(s.metadata_json, '$.organization.trashed_at') IS NULL ELSE 0 END"""
_PPT_TOPIC = """CASE WHEN json_valid(j.request_json) THEN
    CASE WHEN json_type(j.request_json, '$.topic') = 'text' THEN json_extract(j.request_json, '$.topic') END END"""
_PPT_CONVERSATION = """CASE WHEN json_valid(j.request_json) THEN
    CASE WHEN json_type(j.request_json, '$.conversation_id') = 'integer'
         THEN json_extract(j.request_json, '$.conversation_id') END END"""
_LIBRARY_TEXT = "CASE WHEN s.privacy_mode = 'original' THEN s.content ELSE s.redacted_content END"

_SOURCES = {
    "chat": f"""
        SELECT 'chat' AS kind, CAST(c.id AS TEXT) AS id, chat_title(c.title, (
                   SELECT m.content FROM chat_messages m WHERE m.conversation_id = c.id AND m.role = 'user'
                   ORDER BY m.id LIMIT 1
               )) AS title,
               MAX(COALESCE(strftime('{_UTC}', c.updated_at), ''), COALESCE((
                   SELECT MAX(strftime('{_UTC}', m.created_at)) FROM chat_messages m
                   WHERE m.conversation_id = c.id AND m.role IN ('user', 'assistant')
               ), '')) AS updated_at,
               c.id AS conversation_id, c.status AS status
        FROM conversations c
        WHERE EXISTS (
            SELECT 1 FROM chat_messages m WHERE m.conversation_id = c.id AND m.role IN ('user', 'assistant')
        ) AND NOT EXISTS (
            SELECT 1 FROM image_studio_tasks studio
            WHERE studio.conversation_id = c.id AND studio.source_asset_id IS NULL
              AND NOT EXISTS (
                  SELECT 1 FROM agent_execution_runs run
                  WHERE run.conversation_id = c.id AND run.user_message_id IS NOT NULL
                    AND run.run_id <> studio.id
              )
        ) AND (keyword_match(c.title, :needle) OR EXISTS (
            SELECT 1 FROM chat_messages m WHERE m.conversation_id = c.id
              AND m.role IN ('user', 'assistant') AND keyword_match(m.content, :needle)
        ))
    """,
    "image": f"""
        SELECT 'image', t.id, '图片创作', strftime('{_UTC}', t.created_at), t.conversation_id,
               CASE WHEN EXISTS (SELECT 1 FROM chat_image_assets a WHERE a.operation_id = t.id) THEN 'done'
                    WHEN t.status = 'running' AND t.id IS NOT :current_image THEN 'uncertain'
                    ELSE t.status END
        FROM image_studio_tasks t
        WHERE (t.status <> 'done' OR EXISTS (SELECT 1 FROM chat_image_assets a WHERE a.operation_id = t.id))
          AND keyword_match(t.prompt, :needle)
    """,
    "document": f"""
        SELECT 'document', d.id, document_title(d.title, (
                   SELECT substr(original.markdown, 1, 4096) FROM authored_document_versions original
                   WHERE original.document_id = d.id AND original.version = 1
               )), strftime('{_UTC}', COALESCE(v.created_at, d.created_at)), d.conversation_id, NULL
        FROM authored_documents d
        LEFT JOIN authored_document_versions v ON v.document_id = d.id AND v.version = d.latest_version
        WHERE keyword_match(d.title, :needle)
    """,
    "presentation": f"""
        SELECT 'presentation', j.id, '演示文稿', strftime('{_UTC}', j.updated_at), {_PPT_CONVERSATION}, j.status
        FROM background_jobs j
        WHERE j.kind IN ('ppt.generate', 'ppt.quick_generate') AND keyword_match({_PPT_TOPIC}, :needle)
    """,
    "project": f"""
        SELECT 'project', p.id, p.name, strftime('{_UTC}', p.updated_at), NULL, p.status
        FROM projects p WHERE keyword_match(p.name, :needle) OR keyword_match(p.description, :needle)
    """,
    "image_work": f"""
        SELECT 'image_work', w.id, s.title, strftime('{_UTC}', w.created_at), NULL, NULL
        FROM image_studio_works w JOIN library_sources s ON s.id = w.source_id
        WHERE {_UNTRASHED} AND (keyword_match(s.title, :needle) OR keyword_match(s.original_filename, :needle))
    """,
    "final_work": f"""
        SELECT 'final_work', w.id, w.filename, strftime('{_UTC}', w.created_at), NULL, NULL
        FROM final_works w WHERE keyword_match(w.filename, :needle)
    """,
    "knowledge": f"""
        SELECT 'knowledge', CAST(s.id AS TEXT), s.title, strftime('{_UTC}', s.updated_at), NULL, NULL
        FROM library_sources s
        WHERE s.enabled = 1 AND s.parse_status = 'ready' AND {_UNTRASHED}
          AND EXISTS (SELECT 1 FROM agent_settings a WHERE a.id = 1
                      AND a.library_memory_enabled = 1 AND a.knowledge_memory_enabled = 1)
          AND length(trim({_LIBRARY_TEXT}, char(9, 10, 13, 32))) > 0
          AND (keyword_match(s.title, :needle) OR keyword_match(s.original_filename, :needle)
               OR keyword_match({_LIBRARY_TEXT}, :needle))
    """,
}
_FALLBACK_TITLES = {
    "chat": "对话", "image": "图片创作", "document": "文档", "presentation": "演示文稿",
    "project": "项目", "image_work": "图片作品", "final_work": "定稿作品", "knowledge": "资料",
}


def _public_title(title: str, kind: SearchKind) -> str:
    # Stored display labels can be derived from user-authored text. Mask common
    # identifiers/credentials before clipping; never return path-like labels.
    title = " ".join(title.split())
    if any(character in title for character in ("/", "\\")):
        return _FALLBACK_TITLES[kind]
    return scan_and_redact(redact_secrets(title))[1][:120] or _FALLBACK_TITLES[kind]


def _search_workspace(root: Path, needle: str, kind: SearchKind | None, limit: int, offset: int) -> SearchPage:
    sources = tuple(_SOURCES) if kind is None else (kind,)
    args = {"needle": needle, "limit": limit + 1, "offset": offset}
    if "image" in sources:
        args["current_image"] = current_task_id()
    union = " UNION ALL ".join(_SOURCES[source] for source in sources)
    query = f"""
        WITH matches(kind, id, title, updated_at, conversation_id, status) AS ({union})
        SELECT kind, id, title, COALESCE(updated_at, '') AS updated_at, conversation_id, status FROM matches
        ORDER BY updated_at DESC, kind, id DESC LIMIT :limit OFFSET :offset
    """
    # The login middleware already initialized this exact account database.
    # Open read-only: no fallback, creation, migration or permission changes.
    database_uri = (root.absolute() / DATABASE_NAME).as_uri() + "?mode=ro"
    with closing(sqlite3.connect(database_uri, uri=True, timeout=10)) as conn:
        conn.row_factory = sqlite3.Row
        conn.create_function("keyword_match", 2, _matches, deterministic=True)
        conn.create_function("chat_title", 2, _chat_title, deterministic=True)
        conn.create_function("document_title", 2, _document_title, deterministic=True)
        rows = conn.execute(query, args).fetchall()
    items = []
    for row in rows[:limit]:
        result = dict(row)
        result["title"] = _public_title(result["title"], result["kind"])
        items.append(SearchResult(**result))
    return SearchPage(items=items, has_more=len(rows) > limit)


@router.get("/search")
def global_search(
    response: Response,
    q: Annotated[str, Query(max_length=200, description="Literal, case-insensitive search term")],
    kind: SearchKind | None = None,
    limit: Annotated[int, Query(ge=1, le=50)] = 24,
    offset: Annotated[int, Query(ge=0, le=10_000)] = 0,
) -> SearchPage:
    response.headers.update(_NO_STORE)
    user_id, root = snapshot_workspace()
    if not user_id or root is None:
        # Fail closed if mounted without the login middleware.
        raise HTTPException(401, "请先登录", headers=_NO_STORE)
    needle = q.strip().casefold()
    if not needle:
        return SearchPage(items=[], has_more=False)
    return _search_workspace(root, needle, kind, limit, offset)
