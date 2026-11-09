"""Bounded delivery must preserve exact authorized text and every position."""
import asyncio
import json

import pytest

from app.db import connect, init_db
from app.documents.blocks import text_document
from app.library.source_versions import save_source_version
from app.library.sources import create_text_source, get_source, update_source
from app.tools.base import ToolContext
from app.tools.limits import govern_tool_result


def versioned_fixture(path, text):
    # Exercise the reader independently of the still-capped upload parser.
    source = create_text_source(title="long", content="seed", enabled=True, db_path=path)
    with connect(path) as conn:
        conn.execute("UPDATE library_sources SET content=?,redacted_content=? WHERE id=?", (text, text, source["id"]))
    save_source_version(source["id"], text_document(text), path)
    return get_source(source["id"], path)


def identity(source):
    return {"source_kind": "library", "source_id": source["id"], "source_revision": source["source_revision"]}


def read_page(path, arguments, conversation_id=None):
    from app.tools.read_library_source import ReadLibrarySourceTool
    return asyncio.run(ReadLibrarySourceTool(path).execute(arguments, ToolContext(platform_name="manual", conversation_id=conversation_id)))


def test_million_character_reader_concatenates_whole_governed_blocks(tmp_path):
    path = tmp_path / "reader.db"
    init_db(path)
    text = "background " * 90_908 + "unique-tail-fact"
    source = versioned_fixture(path, text)
    delivered, seen, cursor, previous = [], set(), None, -1
    while True:
        result = read_page(path, {**identity(source), "cursor": cursor})
        assert result.ok, result.message
        governed = govern_tool_result(result)
        assert governed.data == result.data, "governance must not change delivered identities or advance a cursor over missing text"
        data = governed.data
        assert len(json.dumps(data, ensure_ascii=False)) <= 31_000
        assert 0 < len(data["blocks"]) <= 20
        assert sum(len(b["text"]) for b in data["blocks"]) <= 12_000
        assert [c["block_id"] for c in data["evidence"]] == [b["block_id"] for b in data["blocks"]]
        for block in data["blocks"]:
            assert block["ordinal"] > previous and block["block_id"] not in seen
            previous = block["ordinal"]
            seen.add(block["block_id"])
            delivered.append(block["text"])
        if not data["has_more"]:
            assert data["next_cursor"] is None
            break
        assert data["next_cursor"] and data["next_cursor"] != cursor
        cursor = data["next_cursor"]
    assert "".join(delivered) == text
    assert len(seen) > 200


def test_reader_cursor_is_bound_to_identity_and_version_and_rechecks_revocation(tmp_path):
    path = tmp_path / "reader.db"
    init_db(path)
    source = versioned_fixture(path, "first " * 5_000)
    first = read_page(path, identity(source))
    assert first.ok and first.data["has_more"]
    cursor = first.data["next_cursor"]
    other = versioned_fixture(path, "second " * 5_000)
    assert not read_page(path, {**identity(other), "cursor": cursor}).ok
    changed = update_source(source["id"], content="new " * 5_000, db_path=path)
    assert not read_page(path, {**identity(changed), "cursor": cursor}).ok
    assert read_page(path, {**identity(source), "cursor": cursor}).ok
    update_source(source["id"], enabled=False, db_path=path)
    assert not read_page(path, {**identity(source), "cursor": cursor}).ok


@pytest.mark.parametrize("options", [{"cursor": "not-a-cursor"}, {"max_blocks": 0}, {"max_blocks": 21}, {"max_characters": 100}, {"max_characters": 12001}])
def test_reader_rejects_invalid_page_requests(tmp_path, options):
    path = tmp_path / "reader.db"
    init_db(path)
    source = versioned_fixture(path, "text")
    assert not read_page(path, {**identity(source), **options}).ok


def test_explicit_attachment_tail_is_searchable_with_memory_off_and_conversation_scoped(tmp_path):
    from app.attachments.service import create_attachment, parse_attachment, delete_attachment
    from app.agent.settings import save_agent_settings
    from app.tools.library import SearchLibraryTool
    from app.library.source_versions import source_state
    from app.workspace import use_workspace
    with use_workspace(1, tmp_path / "owner"):
        init_db()
        text = "background " * 8_000 + "tailfact-amber-river"
        attachment = create_attachment(1, "document", "long.txt", text.encode())
        parse_attachment(attachment["id"])
        target = {"source_kind": "attachment", "attachment_id": attachment["id"],
                  "source_revision": source_state("attachment", attachment["id"])["source_revision"]}
        save_agent_settings({"library_memory_enabled": False, "knowledge_memory_enabled": False})
        tool = SearchLibraryTool()
        arguments = {"query": "tailfact-amber-river", "targets": [target]}
        ctx = ToolContext(platform_name="manual", conversation_id=1)
        found = asyncio.run(tool.execute(arguments, ctx))
        assert found.ok and found.data["evidence"], found
        card = found.data["evidence"][0]
        assert card["attachment_id"] == attachment["id"] and "tailfact-amber-river" in card["excerpt"]
        assert read_page(None, {**target, "cursor": None}, conversation_id=1).ok
        assert not read_page(None, target, conversation_id=2).ok
        wrong = asyncio.run(tool.execute(arguments, ToolContext(platform_name="manual", conversation_id=2)))
        assert not wrong.ok
        delete_attachment(attachment["id"])
        assert not asyncio.run(tool.execute(arguments, ctx)).ok
        with connect() as conn:
            assert not conn.execute("SELECT 1 FROM knowledge_chunks WHERE source_type='conversation_attachment' AND source_id=?", (attachment["id"],)).fetchone()


@pytest.mark.parametrize("vector_available", [False, True])
def test_source_filter_applies_before_candidates_and_lexical_tail_recovers_bad_vectors(tmp_path, monkeypatch, vector_available):
    from app.knowledge import index_document, search_knowledge
    from app.knowledge.embeddings import EmbeddingSpec
    from app.knowledge import set_embedder, reset_embedder
    from app.knowledge import service
    class MockVector:
        spec = EmbeddingSpec("fake-semantic", "fixed-test", 2)
        def embed(self, text):
            return [1.0, 0.0] if text in {"wantedfact", "semantic-only"} or text.startswith("distractor") else [0.0, 1.0]
        def embed_many(self, texts):
            return [self.embed(text) for text in texts]
    path = tmp_path / "candidate.db"
    init_db(path)
    set_embedder(MockVector())
    if not vector_available:
        monkeypatch.setattr(service, "_ensure_vectors", lambda conn: False)
    try:
        for source_id in range(30):
            index_document("noise", source_id, "noise", "distractor wantedfact", db_path=path)
        index_document("wanted", "only", "selected", "facts " * 150 + "wantedfact", db_path=path)
        found = search_knowledge("wantedfact", source_types=["wanted"], limit=1, db_path=path,
                                 relevant_only=True, source_filters=[("wanted", "only", None)])
        assert len(found) == 1 and found[0]["source_id"] == "only"
        if vector_available:
            index_document("wanted", "only", "selected", "semantic-only", db_path=path)
            found = search_knowledge("wantedfact", source_types=["wanted"], limit=1, db_path=path,
                                     relevant_only=True, source_filters=[("wanted", "only", None)])
            assert len(found) == 1 and found[0]["content"] == "semantic-only", "native filtered vectors must also work without lexical overlap"
    finally:
        reset_embedder()


def test_paginated_reader_is_registered_and_allowed_with_library_reads():
    from app.agent.bootstrap import _build_tool_registry
    from app.agent.orchestration import route_task
    from app.config import get_settings
    tools = _build_tool_registry(get_settings())
    assert "read_library_source" in tools.names()
    route = route_task("在我的资料里找事实", set(tools.names()), tool_specs={s.name: s for s in tools.specs()})
    assert "read_library_source" in route.allowed_tools


@pytest.mark.parametrize("mode", ["initial", "multi_initial", "history", "clarification", "checkpoint", "legacy_checkpoint", "legacy_preview"])
def test_actual_model_inputs_keep_long_attachments_bounded_and_readable(tmp_path, mode):
    from app.agent.runtime import AgentRuntime
    from app.attachments.service import create_attachment, parse_attachment
    from app.chat.service import attachment_context, with_attachment_context, _history_message, save_chat_message
    from app.domain import AgentMessage, AgentRunSnapshot, ModelResponse
    from app.models import ModelProviderRegistry
    from app.tools import ToolRegistry
    from app.tools.library import SearchLibraryTool
    from app.tools.read_library_source import ReadLibrarySourceTool
    from app.library.source_versions import source_state
    from app.workspace import use_workspace
    with use_workspace(1, tmp_path / "owner"):
        init_db()
        text = "background " * 8_000 + "tailfact-violet"
        attachment = create_attachment(1, "document", "long.txt", text.encode())
        parse_attachment(attachment["id"])
        target = {"source_kind": "attachment", "attachment_id": attachment["id"],
                  "source_revision": source_state("attachment", attachment["id"])["source_revision"]}
        targets, attachment_ids = [target], [attachment["id"]]
        if mode == "multi_initial":
            for index in range(7):
                other = create_attachment(1, "document", f"long-{index}.txt", text.encode())
                parse_attachment(other["id"])
                attachment_ids.append(other["id"])
                targets.append({"source_kind": "attachment", "attachment_id": other["id"], "source_revision": source_state("attachment", other["id"])["source_revision"]})
        context, summaries, _ = attachment_context(1, attachment_ids, [])
        assert all(summary["source_revision"] for summary in summaries)
        full = with_attachment_context("你好", f"[脱敏资料：long.txt]\n{text}")
        saved = save_chat_message("user", "你好", {"attachments": summaries}, conversation_id=1)
        original = AgentMessage(role="user", content=full, payload={"document_targets": [target]})
        class Model:
            name = "bounded-input"
            calls = []
            async def generate(self, request):
                self.calls.append(request)
                if not request.tools:
                    return ModelResponse(content='{"kind":"conversation","sources":[],"needs_planning":false}')
                return ModelResponse(content="本轮仅收到有限片段；尚未完成全文审阅。")
        model = Model()
        models, tools = ModelProviderRegistry(), ToolRegistry()
        models.register(model.name, model)
        tools.register_handler(SearchLibraryTool())
        tools.register_handler(ReadLibrarySourceTool())
        runtime = AgentRuntime(models=models, tools=tools, model_provider=model.name, platform_name="manual", max_tool_rounds=3)
        if mode in {"initial", "multi_initial"}:
            result = asyncio.run(runtime.run(with_attachment_context("你好", context), document_targets=targets, conversation_id=1, routing_content="你好"))
        elif mode == "history":
            with connect() as conn:
                row = conn.execute("SELECT * FROM chat_messages WHERE id=?", (saved["id"],)).fetchone()
            result = asyncio.run(runtime.run("你好", history=[_history_message(row, 1)], conversation_id=1))
        else:
            state = AgentRunSnapshot(route_kind="conversation", needs_plan=False,
                resume_mode="waiting_user" if mode == "clarification" else "checkpoint",
                allowed_tools=["search_library", "read_library_source"], messages=[original])
            if mode in {"legacy_checkpoint", "legacy_preview"}:
                state.allowed_tools = ["search_library"]
                state.messages[0] = original.model_copy(update={"payload": {}})
                if mode == "legacy_preview":
                    state.messages[0].content = full[:1000]
            result = asyncio.run(runtime.run("你好", resume=state, conversation_id=1))
        assert result.status == "done", result.error
        serialized = "\n".join(r.model_dump_json() for r in model.calls)
        assert text not in serialized
        assert "tailfact-violet" not in serialized, "the tail must be fetched deliberately, not injected as full text"
        assert max(len(r.model_dump_json()) for r in model.calls) < 45_000
        execution = model.calls[-1]
        assert any(d.name == "read_library_source" for d in execution.tools)
        assert target["source_revision"] in execution.model_dump_json()
        assert all(item["attachment_id"] in execution.model_dump_json() for item in targets)
        found = asyncio.run(SearchLibraryTool().execute({"query": "tailfact-violet", "targets": [target]}, ToolContext(platform_name="manual", conversation_id=1)))
        assert found.ok and "tailfact-violet" in found.data["evidence"][0]["excerpt"]


def test_existing_version_attachment_backfill_repairs_missing_index(tmp_path):
    from app.attachments.service import create_attachment, parse_attachment
    from app.knowledge.service import delete_document, search_knowledge
    from app.library.source_backfill import backfill_source
    from app.library.source_versions import source_state
    from app.workspace import use_workspace
    with use_workspace(1, tmp_path / "owner"):
        init_db()
        attachment = create_attachment(1, "document", "saved.txt", b"existing version tailfact")
        parse_attachment(attachment["id"])
        revision = source_state("attachment", attachment["id"])["source_revision"]
        delete_document("conversation_attachment", attachment["id"])
        backfill_source(attachment["id"], kind="attachment")
        assert source_state("attachment", attachment["id"])["source_revision"] == revision
        found = search_knowledge("tailfact", source_types=["conversation_attachment"])
        assert found and found[0]["metadata"]["source_revision"] == revision


@pytest.mark.parametrize("rebuild", [False, True])
def test_embedding_windows_preserve_parent_locator_and_lexical_boundary_fact(tmp_path, monkeypatch, rebuild):
    from types import SimpleNamespace
    from tokenizers import Tokenizer, models, pre_tokenizers
    from app.knowledge import set_embedder, reset_embedder
    from app.knowledge.embeddings import FastEmbedEmbedder
    from app.tools.library import SearchLibraryTool
    tokenizer = Tokenizer(models.WordLevel({"[UNK]": 0, "汉": 1}, unk_token="[UNK]"))
    tokenizer.pre_tokenizer = pre_tokenizers.Split("", behavior="isolated")
    tokenizer.enable_truncation(max_length=12)
    class Dense:
        model = SimpleNamespace(tokenizer=tokenizer)
        seen = []
        def embed(self, texts):
            for text in texts:
                assert not tokenizer.encode(text).overflowing, "embedding input silently exceeds its token window"
                self.seen.append(text)
                yield [1.0] * 512
    dense = Dense()
    embedder = FastEmbedEmbedder("BAAI/bge-small-zh-v1.5")
    monkeypatch.setattr(embedder, "_load", lambda: dense)
    path = tmp_path / "windows.db"
    init_db(path)
    try:
        text = "汉" * 25 + "wantedfact"
        if not rebuild:
            set_embedder(embedder)
        source = create_text_source(title="windowed", content=text, enabled=True, db_path=path)
        if rebuild:
            from app.knowledge import search_knowledge
            set_embedder(embedder)
            assert search_knowledge("wantedfact", db_path=path)
            assert get_source(source["id"], path)["source_revision"] == source["source_revision"]
        assert "".join(dense.seen[:-1] if rebuild else dense.seen) == text
        with connect(path) as conn:
            rows = conn.execute("SELECT * FROM knowledge_chunks ORDER BY id").fetchall()
        assert len(rows) > 1 and all(row["content"] == text for row in rows)
        metadata = [json.loads(row["metadata_json"]) for row in rows]
        assert len({m["block_id"] for m in metadata}) == 1
        assert "".join(text[m["embedding_start"]:m["embedding_end"]] for m in metadata) == text
        # Native vector support is optional: lexical matching uses the entire
        # parent so a fact crossing two embedding windows remains retrievable.
        monkeypatch.setattr("app.knowledge.service._ensure_vectors", lambda conn: False)
        result = asyncio.run(SearchLibraryTool(path).execute({"query": "wantedfact", "source_ids": [source["id"]]}, ToolContext(platform_name="manual")))
        assert result.ok and len(result.data["evidence"]) == 1
        assert result.data["evidence"][0]["excerpt"] == text
    finally:
        reset_embedder()


@pytest.mark.parametrize("entry", ["direct", "snapshot", "automatic"])
def test_upload_entrypoints_index_and_retrieve_fact_after_200001(entry, tmp_path):
    from app.attachments.service import create_attachment, parse_attachment
    from app.library.sources import import_file_source
    from app.library.conversations import prepare_conversation
    from app.library.source_versions import source_state
    from app.tools.library import SearchLibraryTool
    from app.workspace import use_workspace
    with use_workspace(1, tmp_path / "owner"):
        init_db()
        text = "padding " * 31_250 + "unique-fact-turquoise"
        conversation = 1
        if entry == "direct":
            attachment = create_attachment(conversation, "document", "large.txt", text.encode())
            parse_attachment(attachment["id"])
            target = {"source_kind": "attachment", "attachment_id": attachment["id"],
                      "source_revision": source_state("attachment", attachment["id"])["source_revision"]}
        else:
            source = import_file_source(filename="large.txt", content_bytes=text.encode(), enabled=entry == "automatic")
            assert source["parse_status"] == "ready", source["metadata"]
            if entry == "snapshot":
                prepared = prepare_conversation([source["id"]])
                conversation = prepared["conversation"]["id"]
                attachment = prepared["attachments"][0]
                target = {"source_kind": "attachment", "attachment_id": attachment["id"],
                          "source_revision": source_state("attachment", attachment["id"])["source_revision"]}
            else:
                target = identity(source)
        result = asyncio.run(SearchLibraryTool().execute({"query": "unique-fact-turquoise", "targets": [target]}, ToolContext(platform_name="manual", conversation_id=conversation)))
        assert result.ok and "unique-fact-turquoise" in result.data["evidence"][0]["excerpt"]
        assert result.data["evidence"][0]["locator"]["text_start"] > 200_001
        with connect() as conn:
            assert conn.execute("SELECT COUNT(*) FROM knowledge_chunks").fetchone()[0] > 200


@pytest.mark.parametrize("kind", ["library", "attachment"])
def test_upgrade_worker_extends_only_known_truncated_versions_and_preserves_old_revision(tmp_path, kind):
    from app.attachments.service import create_attachment, parse_attachment, get_attachment, index_attachment
    from app.documents.blocks import build_blocks
    from app.documents.parser import DocumentParseResult
    from app.library.source_versions import save_attachment_version, get_attachment_version, get_source_version, source_state
    from app.library.sources import import_file_source, _index_source
    from app.library.source_backfill import enqueue_pending_backfills, register_backfill_handler
    from app.jobs.service import JobService
    from app.jobs.worker import JobWorker
    from app.extensions.contracts import ExtensionContext
    from app.workspace import use_workspace
    root = tmp_path / "owner"
    with use_workspace(1, root):
        init_db()
        full = "padding " * 31_250 + "old-version-tailfact"
        text, blocks, count, unprocessed = build_blocks([(full, {"kind": "text_range", "precise": True})], limit=100_000)
        partial = DocumentParseResult(text, "lightweight", blocks=blocks, extracted_characters=count, complete=False, unprocessed_ranges=unprocessed)
        if kind == "library":
            source = import_file_source(filename="old.txt", content_bytes=full.encode(), enabled=True)
            key = source["id"]
            with connect() as conn:
                conn.execute("UPDATE library_sources SET content=?,redacted_content=?,character_count=? WHERE id=?", (text, text, len(text), key))
            save_source_version(key, partial)
            _index_source(get_source(key), None)
        else:
            source = create_attachment(1, "document", "old.txt", full.encode())
            key = source["id"]
            parse_attachment(key)
            with connect() as conn:
                conn.execute("UPDATE attachments SET parsed_text=?,redacted_text=? WHERE id=?", (text, text, key))
            save_attachment_version(key, partial)
            index_attachment(key)
        old = source_state(kind, key)["source_revision"]
        jobs = JobService()
        register_backfill_handler(jobs)
        assert enqueue_pending_backfills(ExtensionContext.current(), jobs) == 1
        completed = asyncio.run(JobWorker(jobs).run_once(1, root))
        assert completed["status"] == "succeeded"
        current = get_source(key) if kind == "library" else get_attachment(key)
        assert current["content" if kind == "library" else "parsed_text"] == full
        version = get_source_version(key, old) if kind == "library" else get_attachment_version(key, old)
        assert version["text"] == text and version["complete"] is False
        assert source_state(kind, key)["source_revision"] != old


def test_uploaded_long_source_can_be_disabled_corrected_and_privacy_scanned(tmp_path):
    from app.api.schemas import LibrarySourceUpdateIn, PrivacyScanIn
    path = tmp_path / "long-edit.db"
    init_db(path)
    text = "owner text " * 25_000
    source = versioned_fixture(path, text)
    assert update_source(source["id"], enabled=False, db_path=path)["enabled"] is False
    assert LibrarySourceUpdateIn(content=text).content == text
    assert PrivacyScanIn(text=text).text == text


@pytest.mark.parametrize("resume_run", [False, True])
def test_attachment_helpers_do_not_grant_unrequested_library_access(tmp_path, resume_run):
    from app.agent.runtime import AgentRuntime
    from app.attachments.service import create_attachment, parse_attachment
    from app.library.source_versions import source_state
    from app.domain import AgentMessage, AgentRunSnapshot, ModelResponse, ToolCall
    from app.models import ModelProviderRegistry
    from app.tools import ToolRegistry
    from app.tools.library import SearchLibraryTool
    from app.tools.read_library_source import ReadLibrarySourceTool
    from app.workspace import use_workspace
    with use_workspace(1, tmp_path / "owner"):
        init_db()
        secret = "confidential explanation never attached"
        create_text_source(title="other library", content="vaultmarker " + secret, enabled=True)
        attachment = create_attachment(1, "document", "chosen.txt", b"explicitly attached material")
        parse_attachment(attachment["id"])
        target = {"source_kind": "attachment", "attachment_id": attachment["id"], "source_revision": source_state("attachment", attachment["id"])["source_revision"]}
        class Model:
            name = "scope-test"
            requests = []
            async def generate(self, request):
                self.requests.append(request)
                if not any(m.role == "tool" for m in request.messages):
                    return ModelResponse(tool_calls=[ToolCall(id="attempt", name="search_library", arguments={"query": "vaultmarker"})])
                return ModelResponse(content="当前附件中未找到该事实。")
        model = Model()
        models, tools = ModelProviderRegistry(), ToolRegistry()
        models.register(model.name, model)
        tools.register_handler(SearchLibraryTool())
        tools.register_handler(ReadLibrarySourceTool())
        runtime = AgentRuntime(models=models, tools=tools, model_provider=model.name, platform_name="manual", max_tool_rounds=3)
        if resume_run:
            state = AgentRunSnapshot(route_kind="conversation", needs_plan=False, resume_mode="checkpoint",
                library_read_allowed=False, allowed_tools=["search_library", "read_library_source"],
                messages=[AgentMessage(role="user", content="你好", payload={"document_targets": [target]})])
            result = asyncio.run(runtime.run("你好", resume=state, conversation_id=1))
        else:
            result = asyncio.run(runtime.run("你好", document_targets=[target], conversation_id=1))
        assert result.status == "done", result.error
        assert all(secret not in request.model_dump_json() for request in model.requests)
        assert not next(event for event in result.events if event.tool_name == "search_library").data["evidence"]


def test_attachment_index_failure_does_not_activate_unsearchable_version(tmp_path, monkeypatch):
    from app.attachments import service
    from app.library.source_versions import source_state
    from app.workspace import use_workspace
    with use_workspace(1, tmp_path / "owner"):
        init_db()
        attachment = service.create_attachment(1, "document", "original.txt", b"complete text")
        def fail(*args, **kwargs):
            raise RuntimeError("synthetic index failure")
        monkeypatch.setattr(service, "index_attachment", fail)
        with pytest.raises(RuntimeError, match="index failure"):
            service.parse_attachment(attachment["id"])
        current = service.get_attachment(attachment["id"])
        assert current["parse_status"] == "failed" and current["parsed_text"] == ""
        assert source_state("attachment", attachment["id"])["source_revision"] is None


def test_targeted_search_does_not_mix_in_unrelated_confirmed_knowledge(tmp_path):
    from app.library.knowledge import propose_knowledge, review_knowledge
    from app.tools.library import SearchLibraryTool
    path = tmp_path / "target-facts.db"
    init_db(path)
    source = create_text_source(title="chosen", content="only this document", enabled=True, db_path=path)
    fact = propose_knowledge(category="knowledge", statement="vaultmarker unrelated confirmed fact", db_path=path)
    review_knowledge(fact["id"], action="confirm", db_path=path)
    result = asyncio.run(SearchLibraryTool(path).execute({"query": "vaultmarker", "targets": [identity(source)]}, ToolContext(platform_name="manual")))
    assert result.ok and result.data["facts"] == [] and result.data["evidence"] == []


def test_legacy_source_ids_remain_searchable_before_version_backfill(tmp_path):
    from app.tools.library import SearchLibraryTool
    from app.knowledge import index_document
    path = tmp_path / "legacy-target.db"
    init_db(path)
    source = create_text_source(title="legacy", content="legacy target fact", enabled=True, db_path=path)
    with connect(path) as conn:
        conn.execute("DELETE FROM document_source_versions")
        conn.execute("DELETE FROM document_source_state")
    index_document("library_source", source["id"], "legacy", source["content"], db_path=path)
    result = asyncio.run(SearchLibraryTool(path).execute({"query": "target", "source_ids": [source["id"]]}, ToolContext(platform_name="manual")))
    assert result.ok and result.data["excerpts"] and result.data["excerpts"][0]["precise"] is False
