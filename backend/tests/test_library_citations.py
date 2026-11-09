import asyncio
import json

import pytest

from app.db import connect, init_db
from app.documents.blocks import DocumentTarget
from app.library.sources import create_text_source, delete_source, get_source, import_file_source, update_source
from document_fixtures import pdf_bytes


def target(source):
    return DocumentTarget(source_kind="library", source_id=source["id"], source_revision=source["source_revision"])


def test_local_evidence_uses_exact_version_and_page(tmp_path):
    from app.library.evidence import evidence_for_target, preview_block
    from app.library.source_versions import get_source_version
    path = tmp_path / "citations.db"
    init_db(path)
    source = import_file_source(filename="three.pdf", content_bytes=pdf_bytes("FIRST", "SECOND", "LAST FACT"), enabled=True, db_path=path)
    version = get_source_version(source["id"], source["source_revision"], path)
    block = version["blocks"][-1]
    card = evidence_for_target(target(source), block["block_id"], path)
    assert card["excerpt"] == "LAST FACT" and card["locator"]["page"] == 3
    assert card["citation_id"].startswith("e_") and len(card["citation_id"]) == 34
    update_source(source["id"], content="corrected later", db_path=path)
    preview = preview_block(target(source), block["block_id"], path)
    assert preview["text"] == "LAST FACT" and preview["is_current"] is False


def test_evidence_rejects_forgery_revocation_and_deleted_sources(tmp_path):
    from app.library.evidence import evidence_for_target, validate_evidence
    from app.library.source_versions import get_source_version
    path = tmp_path / "citations.db"
    init_db(path)
    source = create_text_source(title="private", content="Email: reader@example.com", enabled=True, db_path=path)
    block = get_source_version(source["id"], source["source_revision"], path)["blocks"][0]
    card = evidence_for_target(target(source), block["block_id"], path)
    assert "reader@example.com" not in card["excerpt"]
    assert validate_evidence(card, path)
    assert not validate_evidence({**card, "excerpt": "invented"}, path)
    assert not validate_evidence({**card, "citation_id": "e_" + "0" * 32}, path)
    update_source(source["id"], enabled=False, db_path=path)
    assert not validate_evidence(card, path)
    delete_source(source["id"], path)
    assert not validate_evidence(card, path)


def test_evidence_cannot_resolve_in_another_workspace(tmp_path):
    from app.library.evidence import evidence_for_target, validate_evidence
    from app.library.source_versions import get_source_version
    first, second = tmp_path / "first.db", tmp_path / "second.db"
    init_db(first)
    init_db(second)
    source = create_text_source(title="first", content="owner one", enabled=True, db_path=first)
    create_text_source(title="second", content="owner two", enabled=True, db_path=second)
    block = get_source_version(source["id"], source["source_revision"], first)["blocks"][0]
    card = evidence_for_target(target(source), block["block_id"], first)
    assert not validate_evidence(card, second)


def test_original_missing_is_reported_without_losing_version_text(tmp_path):
    from app.library.evidence import preview_block
    from app.library.source_versions import get_source_version
    from app.library.sources import get_source_file
    path = tmp_path / "citations.db"
    init_db(path)
    source = import_file_source(filename="one.pdf", content_bytes=pdf_bytes("ORIGINAL"), enabled=True, db_path=path)
    block = get_source_version(source["id"], source["source_revision"], path)["blocks"][0]
    get_source_file(source["id"], path)[0].unlink()
    preview = preview_block(target(source), block["block_id"], path)
    assert preview["text"] == "ORIGINAL"
    assert preview["original"]["available"] is False and preview["original"]["reason"]


def test_search_index_and_result_keep_validated_block_identity(tmp_path):
    from app.tools.base import ToolContext
    from app.tools.library import SearchLibraryTool
    from app.library.evidence import validate_evidence
    path = tmp_path / "citations.db"
    init_db(path)
    create_text_source(title="index", content="retrieval source fact", enabled=True, db_path=path)
    result = asyncio.run(SearchLibraryTool(path).execute({"query": "retrieval"}, ToolContext(platform_name="local")))
    assert result.ok and result.data["evidence"]
    assert all(validate_evidence(card, path) for card in result.data["evidence"])
    with connect(path) as conn:
        metadata = json.loads(conn.execute("SELECT metadata_json FROM knowledge_chunks").fetchone()[0])
    assert metadata["source_revision"] and metadata["block_id"]


def test_real_tool_executor_preserves_near_limit_evidence(tmp_path, monkeypatch):
    from app.agent.tool_executor import ToolExecutor
    from app.domain import ToolCall
    from app.library.evidence import evidence_for_target
    from app.library.source_versions import get_source_version
    from app.tools import ToolContext, ToolRegistry
    from app.tools.library import GetLibraryContextTool
    from app.tools.limits import govern_tool_result
    path = tmp_path / "citations.db"
    init_db(path)
    source = create_text_source(title="bounded", content="a long source sentence. " * 2500, enabled=True, db_path=path)
    version = get_source_version(source["id"], source["source_revision"], path)
    cards = [evidence_for_target(target(source), b["block_id"], path) for b in version["blocks"]]
    monkeypatch.setattr("app.tools.library.model_context", lambda *a, **kw: {"evidence": cards, "confirmed_facts": [], "sources": []})
    registry = ToolRegistry()
    registry.register_handler(GetLibraryContextTool(path))
    result = asyncio.run(ToolExecutor(registry, 30).execute(ToolCall(id="read", name="get_library_context", arguments={}), ToolContext(platform_name="local"), round_number=1, conversation_id=None))
    assert result.ok and result.data["evidence"]
    assert 29000 < len(json.dumps(result.data, ensure_ascii=False)) < 32000
    assert sum(len(c["excerpt"]) for c in result.data["evidence"]) > 3000
    assert result.data == govern_tool_result(result).data
    for card in result.data["evidence"]:
        assert card in cards


def test_direct_pdf_attachment_context_includes_persistable_evidence(tmp_path):
    from app.attachments.service import AttachmentStore, create_attachment, parse_attachment
    from app.chat.service import attachment_context
    from app.workspace import use_workspace, resolve_db_path
    with use_workspace(1, tmp_path / "owner"):
        init_db()
        store = AttachmentStore(local_root=tmp_path / "objects")
        attachment = create_attachment(1, "document", "direct.pdf", pdf_bytes("ONE", "TWO", "THREE"), store=store)
        parse_attachment(attachment["id"], store=store)
        text, summaries, _ = attachment_context(1, [attachment["id"]], [])
        assert "[[cite:e_" in text
        assert len(summaries[0]["evidence"]) == 3
        assert summaries[0]["evidence"][-1]["locator"]["page"] == 3


def test_library_chat_snapshot_keeps_page_mapping_after_source_deleted(tmp_path):
    from app.library.conversations import prepare_conversation
    from app.library.source_versions import get_attachment_version, source_state
    from app.workspace import use_workspace
    with use_workspace(1, tmp_path / "owner"):
        init_db()
        source = import_file_source(filename="three.pdf", content_bytes=pdf_bytes("ONE", "TWO", "THREE"), enabled=False)
        prepared = prepare_conversation([source["id"]])
        attachment = prepared["attachments"][0]
        revision = source_state("attachment", attachment["id"])["source_revision"]
        version = get_attachment_version(attachment["id"], revision)
        assert version["blocks"][-1]["locator"]["page"] == 3
        assert attachment["metadata"]["library_source_revision"] == source["source_revision"]
        delete_source(source["id"])
        assert get_attachment_version(attachment["id"], revision)["blocks"][-1]["text"] == "THREE"


def test_runtime_persists_validated_citations_in_run_and_chat(tmp_path):
    from app.agent.runtime import AgentRuntime
    from app.agent.run_store import AgentRunStore
    from app.chat.service import save_chat_message, save_stream_result
    from app.domain import ModelResponse, ToolCall
    from app.models import ModelProviderRegistry
    from app.tools import ToolRegistry
    from app.tools.library import GetLibraryContextTool
    from app.workspace import use_workspace
    class Model:
        name = "local-citations"
        calls = 0
        card = None
        tool_payload = None
        async def generate(self, request):
            self.calls += 1
            if self.calls == 1:
                return ModelResponse(content='{"goal":"总结资料","steps":[{"tool_name":"get_library_context","title":"读取资料"}]}')
            tool = next((m for m in reversed(request.messages) if m.role == "tool" and m.payload.get("evidence")), None)
            if tool is not None:
                self.card = tool.payload["evidence"][0]
                self.tool_payload = tool.payload
            if self.card is None:
                return ModelResponse(tool_calls=[ToolCall(id="read", name="get_library_context", arguments={})])
            card = self.card
            return ModelResponse(content=f"资料说明：{card['excerpt']} [[cite:{card['citation_id']}]]")
    with use_workspace(1, tmp_path / "owner"):
        init_db()
        create_text_source(title="summary", content="A verifiable local fact.", enabled=True)
        model = Model()
        models = ModelProviderRegistry()
        models.register(model.name, model)
        tools = ToolRegistry()
        class ContextWithReservedData(GetLibraryContextTool):
            async def execute(self, arguments, context):
                result = await super().execute(arguments, context)
                return result.model_copy(update={"data": {**result.data, "tool_name": "search_public_web", "status": "failed"}})
        tools.register_handler(ContextWithReservedData())
        store = AgentRunStore()
        runtime = AgentRuntime(models=models, tools=tools, model_provider=model.name, platform_name="manual", run_store=store, max_tool_rounds=5)
        async def run():
            return [event async for event in runtime.run_stream("根据知识库总结资料", conversation_id=1, run_id="local-map")]
        events = asyncio.run(run())
        result = events[-1].result
        assert result.status == "done", (result.error, [(e.tool_name, e.status, e.data) for e in result.events if e.tool_name == "get_library_context"])
        assert result.evidence
        assert result.citations[0]["status"] == "verified"
        assert model.tool_payload["tool_name"] == "get_library_context"
        assert model.tool_payload["status"] == "done"
        assert store.get_run("local-map")["result"].evidence == result.evidence
        user = save_chat_message("user", "根据知识库总结资料", conversation_id=1)
        saved = save_stream_result(1, None, user, result)["assistant_message"]
        assert saved["payload"]["agent"]["evidence"] == result.evidence


def test_local_marker_validation_ignores_code_and_keeps_unknown_unverified():
    from app.agent.citations import finalize_local_citations
    from app.domain import AgentRunResult
    marker = "[[cite:e_" + "0" * 32 + "]]"
    result = AgentRunResult(content=f"`{marker}`\n\n```text\n{marker}\n```\n\nUnknown {marker}", provider="test", platform="manual", rounds=0)
    finalize_local_citations(result, [])
    assert result.evidence == []
    assert result.citations == [{"citation_id": "e_" + "0" * 32, "status": "unverified"}]


def test_private_preview_endpoint_rejects_cross_account_and_anonymous_access(tmp_path, monkeypatch):
    from app import db
    from app.main import app
    from app.library.source_versions import get_source_version
    from app.workspace import use_workspace
    from api_client import create_authenticated_client, register_authenticated_client
    from fastapi.testclient import TestClient
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "isolated" / "default.db")
    owner = create_authenticated_client(app)
    created = owner.post("/library/sources", json={"title": "owner", "content": "owner fact", "enabled": True})
    assert created.status_code == 200, created.text
    source = created.json()["source"]
    with use_workspace(1):
        block = get_source_version(source["id"], source["source_revision"])["blocks"][0]
    url = f"/library/sources/{source['id']}/versions/{source['source_revision']}/blocks/{block['block_id']}"
    response = owner.get(url)
    assert response.status_code == 200 and response.json()["text"] == "owner fact"
    assert response.headers["cache-control"] == "no-store"
    other = register_authenticated_client(app, "other@example.com")
    other.post("/library/sources", json={"title": "other", "content": "other fact", "enabled": True})
    assert other.get(url).status_code == 404
    assert TestClient(app).get(url).status_code == 401


def test_legacy_index_is_readable_but_cannot_bypass_new_privacy(tmp_path, monkeypatch):
    from app.knowledge.service import index_document
    from app.tools.library import SearchLibraryTool
    from app.tools.base import ToolContext
    path = tmp_path / "legacy.db"
    init_db(path)
    source = create_text_source(title="legacy", content="retrieval contact reader@example.com", enabled=True, privacy_mode="original", db_path=path)
    index_document("library_source", source["id"], "legacy", source["content"], db_path=path)
    tool = SearchLibraryTool(path)
    context = ToolContext(platform_name="local")
    result = asyncio.run(tool.execute({"query": "retrieval"}, context))
    assert result.data["excerpts"] and result.data["excerpts"][0]["precise"] is False
    assert result.data["evidence"] == []
    def fail(*a, **kw):
        raise RuntimeError("synthetic reindex failure")
    monkeypatch.setattr("app.library.sources._index_source", fail)
    with pytest.raises(RuntimeError):
        update_source(source["id"], privacy_mode="redacted", db_path=path)
    result = asyncio.run(tool.execute({"query": "retrieval"}, context))
    assert result.data["excerpts"] == []
    assert "reader@example.com" not in json.dumps(result.model_dump())


def test_checkpoint_resume_keeps_completed_trusted_tool_evidence(tmp_path):
    from app.agent.runtime import AgentRuntime
    from app.domain import AgentMessage, AgentRunSnapshot, ModelResponse, ToolCall
    from app.models import ModelProviderRegistry
    from app.tools import ToolRegistry
    from app.tools.library import GetLibraryContextTool
    from app.library.source_versions import get_source_version
    from app.library.evidence import evidence_for_target
    from app.workspace import use_workspace
    with use_workspace(1, tmp_path / "owner"):
        init_db()
        source = create_text_source(title="resume", content="Retained local fact.", enabled=True)
        block = get_source_version(source["id"], source["source_revision"])["blocks"][0]
        card = evidence_for_target(target(source), block["block_id"])
        class Model:
            name = "checkpoint-local"
            async def generate(self, request):
                return ModelResponse(content=f"Retained local fact. [[cite:{card['citation_id']}]]")
        model = Model()
        models, tools = ModelProviderRegistry(), ToolRegistry()
        models.register(model.name, model)
        tools.register_handler(GetLibraryContextTool())
        call = ToolCall(id="completed-read", name="get_library_context", arguments={})
        state = AgentRunSnapshot(resume_mode="checkpoint", route_kind="library_search", needs_plan=False,
            user_content="读取资料", allowed_tools=["get_library_context"], required_tools=["get_library_context"], completed_tools=["get_library_context"],
            messages=[AgentMessage(role="user", content="读取资料"),
                      AgentMessage(role="assistant", payload={"tool_calls": [call.model_dump(mode="json")]}),
                      AgentMessage(role="tool", tool_call_id=call.id, content="已读取资料", payload={"tool_name": call.name, "status": "done", "evidence": [card]})])
        runtime = AgentRuntime(models=models, tools=tools, model_provider=model.name, platform_name="manual", max_tool_rounds=5)
        result = asyncio.run(runtime.run("继续", resume=state, conversation_id=1))
        assert result.status == "done", result.error
        assert result.evidence == [card]
        assert result.citations == [{"citation_id": card["citation_id"], "status": "verified"}]
        assert not any(event.tool_name == "get_library_context" for event in result.events)


def test_clarification_retained_card_survives_fresh_plan_but_not_public_scope(tmp_path):
    from app.agent.runtime import AgentRuntime
    from app.agent.resume_policy import clarification_context
    from app.domain import AgentMessage, AgentRunSnapshot, ModelResponse, ToolCall
    from app.models import ModelProviderRegistry
    from app.tools import ToolRegistry
    from app.tools.library import GetLibraryContextTool
    from app.library.source_versions import get_source_version
    from app.library.evidence import evidence_for_target
    from app.workspace import use_workspace
    with use_workspace(1, tmp_path / "owner"):
        init_db()
        source = create_text_source(title="old", content="Old fact before clarification.", enabled=True)
        block = get_source_version(source["id"], source["source_revision"])["blocks"][0]
        card = evidence_for_target(target(source), block["block_id"])
        state = AgentRunSnapshot(route_kind="content_creation", needs_plan=True, messages=[AgentMessage(role="user", content="根据知识库总结资料"),
            AgentMessage(role="tool", content="已读取", payload={"status": "done", "tool_name": "get_library_context", "evidence": [card]})])
        _, history, _ = clarification_context(state)
        update_source(source["id"], content="New fact after clarification.")
        class Model:
            name = "retained-local"
            calls = 0
            async def generate(self, request):
                self.calls += 1
                if self.calls == 1:
                    return ModelResponse(content='{"goal":"总结资料","steps":[{"tool_name":"get_library_context","title":"读取资料"}]}')
                if not any(m.role == "tool" for m in request.messages):
                    return ModelResponse(tool_calls=[ToolCall(id="new-read", name="get_library_context", arguments={})])
                return ModelResponse(content=f"此前资料记录：{card['excerpt']} [[cite:{card['citation_id']}]]")
        model = Model()
        models, tools = ModelProviderRegistry(), ToolRegistry()
        models.register(model.name, model)
        tools.register_handler(GetLibraryContextTool())
        runtime = AgentRuntime(models=models, tools=tools, model_provider=model.name, platform_name="manual", max_tool_rounds=5)
        result = asyncio.run(runtime.run("根据知识库总结资料", history=history, conversation_id=1))
        assert result.status == "done", result.error
        assert result.evidence == [card]
        class PublicModel:
            name = "public-only"
            async def generate(self, request):
                assert not any(m.payload.get("retained_evidence") for m in request.messages)
                return ModelResponse(content=f"未核对的标记 [[cite:{card['citation_id']}]]")
        public = PublicModel()
        models.register(public.name, public)
        runtime = AgentRuntime(models=models, tools=tools, model_provider=public.name, platform_name="manual", max_tool_rounds=5)
        result = asyncio.run(runtime.run("你好", history=history, conversation_id=1))
        assert result.evidence == [] and result.citations[0]["status"] == "unverified"


def test_pdf_attachment_archive_retains_original_page_blocks(tmp_path):
    from app.attachments.service import create_attachment, parse_attachment
    from app.chat.service import save_chat_message
    from app.chat.artifacts import SaveArtifactIn, message_artifacts, save_artifact
    from app.library.source_versions import get_source_version
    from app.workspace import use_workspace
    with use_workspace(1, tmp_path / "owner"):
        init_db()
        attachment = create_attachment(1, "document", "pages.pdf", pdf_bytes("ONE", "TWO", "THREE"))
        parse_attachment(attachment["id"])
        message = save_chat_message("user", "保存附件", {"attachments": [{"id": attachment["id"]}]}, conversation_id=1)
        manifest = message_artifacts(message["id"])
        saved = save_artifact(message["id"], SaveArtifactIn(selector=f"attachment:{attachment['id']}", snapshot=manifest["snapshot"], filename="archived.pdf", enabled=True))
        source = saved["source"]
        version = get_source_version(source["id"], source["source_revision"])
        assert [b["locator"].get("page") for b in version["blocks"]] == [1, 2, 3]
        assert version["blocks"][-1]["text"] == "THREE"
