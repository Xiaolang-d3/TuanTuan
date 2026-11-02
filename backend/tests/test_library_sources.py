from __future__ import annotations

from pathlib import Path

import pytest

from app.db import connect, init_db
from app.compatibility import profile_document as document
from app.compatibility.schema_v22 import init_db as init_legacy_db
from app.library.repository import save_metadata
from app.library.knowledge import list_knowledge, propose_knowledge, review_knowledge
from app.library.sources import (
    create_text_source,
    delete_source,
    get_source,
    get_source_file,
    import_file_source,
    list_sources,
    update_source,
)
from app.tools.base import ToolContext
from app.tools.library import SearchLibraryTool


def test_legacy_resume_migrates_once_without_deleting_original(tmp_path):
    db_path = tmp_path / "tuantuan.db"
    init_legacy_db(db_path)
    document.document_path(db_path).write_text(document.render(document.ProfileDocument(name="读者", resume_text="旧资料内容：每周回顾一次。")))
    init_db(db_path)
    init_db(db_path)
    sources = list_sources(db_path)
    assert len(sources) == 1
    assert sources[0]["source_kind"] == "legacy"
    assert get_source(sources[0]["id"], db_path=db_path)["content"] == "旧资料内容：每周回顾一次。"
    assert document.load(db_path).resume_text == "旧资料内容：每周回顾一次。"


def test_two_files_are_stored_as_independent_sources_with_private_permissions(tmp_path):
    db_path = tmp_path / "tuantuan.db"
    init_db(db_path)
    first = import_file_source(filename="one.txt", content_bytes="第一份资料：火星是一颗岩石行星，这份记录只属于第一个来源。".encode(), db_path=db_path)
    second = import_file_source(filename="two.txt", content_bytes="第二份资料：木星是一颗气态巨行星，这份记录只属于第二个来源。".encode(), db_path=db_path)

    sources = list_sources(db_path)
    assert {item["id"] for item in sources} == {first["id"], second["id"]}
    assert {item["title"] for item in sources} == {"one", "two"}
    first_path, _, _ = get_source_file(first["id"], db_path=db_path)
    second_path, _, _ = get_source_file(second["id"], db_path=db_path)
    assert first_path != second_path
    assert first_path.read_bytes() != second_path.read_bytes()
    assert first_path.stat().st_mode & 0o777 == 0o600
    assert first_path.parent.stat().st_mode & 0o777 == 0o700


def test_disabled_source_leaves_search_and_reenable_restores_it(tmp_path):
    import asyncio

    db_path = tmp_path / "tuantuan.db"
    init_db(db_path)
    source = create_text_source(title="天文笔记", content="海王星是一颗冰巨星", enabled=True, db_path=db_path)
    tool = SearchLibraryTool(db_path)
    context = ToolContext(platform_name="test")
    assert asyncio.run(tool.execute({"query": "海王星"}, context)).data["excerpts"]
    update_source(source["id"], enabled=False, db_path=db_path)
    assert asyncio.run(tool.execute({"query": "海王星"}, context)).data["excerpts"] == []
    update_source(source["id"], enabled=True, db_path=db_path)
    assert asyncio.run(tool.execute({"query": "海王星"}, context)).data["excerpts"]


def test_editing_extracted_text_updates_privacy_and_index_without_changing_original_file(tmp_path):
    db_path = tmp_path / "tuantuan.db"
    init_db(db_path)
    original = "原文件内容：木星是一颗气态巨行星，这份资料只用于验证原文件不会被正文校正覆盖。".encode()
    source = import_file_source(filename="notes.txt", content_bytes=original, enabled=True, db_path=db_path)
    file_path, _, _ = get_source_file(source["id"], db_path=db_path)

    edited = update_source(
        source["id"],
        content="校正后的内容：海王星是一颗冰巨星。联系邮箱 reader@example.com",
        db_path=db_path,
    )

    assert edited["content"].startswith("校正后的内容")
    assert "reader@example.com" not in edited["redacted_content"]
    assert edited["metadata"]["content_edited"] is True
    assert edited["character_count"] == len(edited["content"])
    assert file_path.read_bytes() == original
    with connect(db_path) as conn:
        chunks = conn.execute(
            "SELECT content FROM knowledge_chunks WHERE source_type = 'library_source' AND source_id = ?",
            (str(source["id"]),),
        ).fetchall()
    assert chunks and "[邮箱已隐藏]" in chunks[0]["content"]
    assert "木星" not in chunks[0]["content"]

    with pytest.raises(ValueError, match="资料内容不能为空"):
        update_source(source["id"], content="   ", db_path=db_path)
    assert get_source(source["id"], db_path=db_path)["content"] == edited["content"]


def test_deleting_source_removes_file_index_and_only_unconfirmed_exclusive_memory(tmp_path):
    db_path = tmp_path / "tuantuan.db"
    init_db(db_path)
    save_metadata(name="读者", db_path=db_path)
    source = import_file_source(filename="notes.txt", content_bytes="来源内容需要足够完整，用于验证删除原文件、索引和待确认知识。".encode(), db_path=db_path)
    file_path, _, _ = get_source_file(source["id"], db_path=db_path)
    pending = propose_knowledge(category="knowledge", statement="待确认内容", source_id=source["id"], db_path=db_path)
    confirmed = propose_knowledge(category="knowledge", statement="已确认内容", source_id=source["id"], db_path=db_path)
    review_knowledge(confirmed["id"], action="confirm", db_path=db_path)

    assert delete_source(source["id"], db_path=db_path)
    assert not file_path.exists()
    assert all(item["id"] != pending["id"] for item in list_knowledge(db_path=db_path))
    kept = next(item for item in list_knowledge(db_path=db_path) if item["id"] == confirmed["id"])
    assert kept["status"] == "confirmed"
    assert kept["evidence"][0]["source_id"] is None
    assert "原来源已删除" in kept["evidence"][0]["locator"]
    with connect(db_path) as conn:
        assert conn.execute(
            "SELECT 1 FROM knowledge_chunks WHERE source_type = 'library_source' AND source_id = ?",
            (str(source["id"]),),
        ).fetchone() is None


def test_failed_original_file_deletion_keeps_source_knowledge_and_index(tmp_path, monkeypatch):
    db_path = tmp_path / "tuantuan.db"
    init_db(db_path)
    source = import_file_source(filename="notes.txt", content_bytes="可供重试删除的原始笔记。".encode(), enabled=True, db_path=db_path)
    file_path, _, _ = get_source_file(source["id"], db_path=db_path)
    pending = propose_knowledge(category="knowledge", statement="待确认结论", source_id=source["id"], db_path=db_path)
    original_unlink = Path.unlink

    def deny_original(path, *args, **kwargs):
        if path == file_path:
            raise PermissionError("synthetic permission failure")
        return original_unlink(path, *args, **kwargs)

    monkeypatch.setattr(Path, "unlink", deny_original)
    with pytest.raises(ValueError, match="无法删除原文件"):
        delete_source(source["id"], db_path=db_path)
    assert get_source(source["id"], db_path=db_path)["content"]
    assert file_path.read_text() == "可供重试删除的原始笔记。"
    assert any(item["id"] == pending["id"] for item in list_knowledge(db_path=db_path))
    with connect(db_path) as conn:
        assert conn.execute("SELECT 1 FROM knowledge_chunks WHERE source_type = 'library_source' AND source_id = ?", (str(source["id"]),)).fetchone()
