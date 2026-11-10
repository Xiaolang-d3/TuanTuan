"""Upload parsing must fail explicitly before consuming unbounded resources."""
from io import BytesIO
from zipfile import ZIP_DEFLATED, ZipFile
import multiprocessing

import pytest

from app.db import init_db
from app.documents.parser import parse_document_result
from app.library.sources import get_source_file, import_file_source
from document_fixtures import pdf_bytes


def test_docx_expansion_is_rejected_and_original_is_preserved(tmp_path):
    output = BytesIO()
    with ZipFile(output, "w", compression=ZIP_DEFLATED) as archive:
        archive.writestr("word/document.xml", b"x" * (33 * 1024 * 1024))
    data = output.getvalue()
    assert len(data) < 100_000
    path = tmp_path / "resources.db"
    init_db(path)
    source = import_file_source(filename="expanded.docx", content_bytes=data, enabled=True, db_path=path)
    assert source["parse_status"] == "failed" and not source["enabled"]
    assert any("展开" in warning for warning in source["metadata"]["warnings"]), source["metadata"]["warnings"]
    assert get_source_file(source["id"], path)[0].read_bytes() == data


def test_pdf_stream_expansion_reports_processing_limit_and_preserves_original(tmp_path):
    from pypdf import PdfWriter
    writer = PdfWriter(clone_from=BytesIO(pdf_bytes("x" * (17 * 1024 * 1024))))
    for page in writer.pages:
        page.compress_content_streams()
    output = BytesIO()
    writer.write(output)
    data = output.getvalue()
    assert len(data) < 100_000
    path = tmp_path / "pdf-resources.db"
    init_db(path)
    source = import_file_source(filename="expanded.pdf", content_bytes=data, enabled=True, db_path=path)
    assert source["parse_status"] == "failed" and not source["enabled"]
    assert any("展开" in warning or "解压" in warning for warning in source["metadata"]["warnings"]), source["metadata"]["warnings"]
    assert get_source_file(source["id"], path)[0].read_bytes() == data


def test_parser_wall_time_limit_terminates_and_joins_child(monkeypatch):
    from app.documents import limits
    previous = {process.pid for process in multiprocessing.active_children()}
    monkeypatch.setattr(limits, "FAST_PARSE_SECONDS", 0.001)
    with pytest.raises(ValueError, match="时限"):
        parse_document_result("limited.pdf", pdf_bytes("small"))
    assert {process.pid for process in multiprocessing.active_children()} == previous


def test_parser_memory_limit_is_enforced_in_an_isolated_child(monkeypatch):
    from app.documents import limits
    from app.documents.limits import DocumentLimitError
    previous = {process.pid for process in multiprocessing.active_children()}
    monkeypatch.setattr(limits, "FAST_PARSE_MEMORY_BYTES", 1024 * 1024)
    # A 1 MiB ceiling kills the child before it can always name the reason, and
    # that wording differs by platform. The contract is the limit error itself.
    with pytest.raises(DocumentLimitError):
        parse_document_result("limited.pdf", pdf_bytes("small"))
    assert {process.pid for process in multiprocessing.active_children()} == previous


def test_cumulative_limit_rejects_partial_identity_instead_of_cutting_it(monkeypatch):
    from app.documents import parser
    # A small injected limit exercises the same worker path without huge data.
    monkeypatch.setattr(parser, "MAX_DOCUMENT_CHARACTERS", 1000)
    with pytest.raises(ValueError, match="处理范围"):
        parse_document_result("identity.txt", ("x" * 995 + "13800138000").encode())


@pytest.mark.parametrize("route", ["import", "parse", "attachment"])
def test_async_uploads_bound_reads_and_keep_parsing_off_event_loop(tmp_path, monkeypatch, route):
    import asyncio
    from app.api import library
    from app.documents.parser import MAX_DOCUMENT_BYTES
    from app.workspace import use_workspace
    class Upload:
        filename = "small.txt"
        reads = []
        async def read(self, size=-1):
            self.reads.append(size)
            return b"plain local text"
        async def close(self):
            pass
    off_loop = []
    def observe():
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            off_loop.append(True)
        else:
            off_loop.append(False)
    if route == "import":
        original = library.import_file_source
        def spy(**kwargs):
            observe()
            return original(**kwargs)
        monkeypatch.setattr(library, "import_file_source", spy)
    elif route == "parse":
        original = library.document_service.parse_document_upload
        def spy(*args, **kwargs):
            observe()
            return original(*args, **kwargs)
        monkeypatch.setattr(library.document_service, "parse_document_upload", spy)
    else:
        from app.api import attachments
        original = attachments.create_attachment
        def spy(*args, **kwargs):
            observe()
            return original(*args, **kwargs)
        monkeypatch.setattr(attachments, "create_attachment", spy)
    with use_workspace(1, tmp_path / "owner"):
        init_db()
        upload = Upload()
        if route == "import":
            result = asyncio.run(library.library_sources_import(files=[upload], mode="fast", privacy_mode="redacted", enabled=False))
            assert result["results"][0]["ok"]
        elif route == "parse":
            assert asyncio.run(library.parse_library_document(file=upload, mode="fast"))["text"] == "plain local text"
        else:
            assert asyncio.run(attachments.attachments_upload(conversation_id=1, kind="document", file=upload))["id"]
        assert off_loop == [True]
        assert upload.reads == [MAX_DOCUMENT_BYTES + 1]
