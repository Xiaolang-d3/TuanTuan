import pytest

from app.db import connect, init_db
from app.documents.parser import parse_document_result
from app.library.sources import create_text_source, get_source, import_file_source, update_source
from document_fixtures import pdf_bytes


def test_upload_has_immutable_page_version_and_edits_keep_original(tmp_path):
    path = tmp_path / "versions.db"
    init_db(path)
    source = import_file_source(filename="pages.pdf", content_bytes=pdf_bytes("PAGE ONE", "PAGE TWO"), db_path=path)
    assert source.get("source_revision"), "new imports need a durable document revision"
    from app.library.source_versions import get_source_version
    before = get_source_version(source["id"], source["source_revision"], path)
    assert before["blocks"][-1]["locator"]["page"] == 2
    edited = update_source(source["id"], content="corrected content", db_path=path)
    assert edited["source_revision"] != before["revision"]
    assert get_source_version(source["id"], before["revision"], path)["text"] == before["text"]
    assert get_source_version(source["id"], edited["source_revision"], path)["blocks"][0]["locator"]["kind"] == "text_range"


def test_versions_reuse_only_identical_text_and_structure(tmp_path):
    path = tmp_path / "versions.db"
    init_db(path)
    source = create_text_source(title="source", content="ONE\nTWO", db_path=path)
    assert source.get("source_revision"), "text sources need a durable revision"
    from app.library.source_versions import save_source_version
    first = parse_document_result("x.pdf", pdf_bytes("ONE", "TWO"))
    version = save_source_version(source["id"], first, path, activate=False)
    again = save_source_version(source["id"], first, path, activate=False)
    assert version["revision"] == again["revision"]
    assert version["revision"] != source["source_revision"]
    assert get_source(source["id"], path)["source_revision"] == source["source_revision"]


def test_current_schema_marks_legacy_sources_for_backfill_without_parsing(tmp_path, monkeypatch):
    path = tmp_path / "legacy.db"
    init_db(path)
    source = create_text_source(title="legacy", content="preserved", db_path=path)
    with connect(path) as conn:
        assert "document_source_versions" in {r[0] for r in conn.execute("SELECT name FROM sqlite_master")}, "version schema is missing"
        conn.execute("DELETE FROM document_source_versions")
        conn.execute("DELETE FROM document_source_state")
        conn.execute("DELETE FROM schema_migrations WHERE version = (SELECT MAX(version) FROM schema_migrations)")
        conn.execute("INSERT OR IGNORE INTO schema_migrations(version,name) VALUES(37,'previous')")
    monkeypatch.setattr("app.documents.parser.parse_document_result", lambda *a, **k: pytest.fail("upgrade parsed a document"))
    init_db(path)
    init_db(path)
    assert get_source(source["id"], path)["backfill_status"] == "pending"


def test_other_workspace_cannot_resolve_a_source_revision(tmp_path):
    first, other = tmp_path / "first.db", tmp_path / "other.db"
    init_db(first)
    init_db(other)
    source = create_text_source(title="private", content="private body", db_path=first)
    assert source.get("source_revision"), "revision identity is missing"
    create_text_source(title="other", content="another body", db_path=other)
    from app.library.source_versions import get_source_version
    with pytest.raises(ValueError):
        get_source_version(source["id"], source["source_revision"], other)
