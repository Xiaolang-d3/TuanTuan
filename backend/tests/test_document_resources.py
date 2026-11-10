"""Upload parsing must fail explicitly before consuming unbounded resources."""
from io import BytesIO
from zipfile import ZIP_DEFLATED, ZipFile
import multiprocessing
import sys
import tempfile
from types import SimpleNamespace

import pytest

from app.db import init_db
from app.documents.parser import parse_document_result
from app.library.sources import get_source_file, import_file_source
from document_fixtures import pdf_bytes


@pytest.mark.parametrize("soft,hard,expected", [(-1, -1, 512), (256, 1024, 256), (1024, 256, 256), (1024, 1024, 512)])
def test_posix_limit_never_raises_existing_bounds(monkeypatch, soft, hard, expected):
    from app.documents import limits
    calls = []
    resource = SimpleNamespace(RLIMIT_AS=0, getrlimit=lambda _: (soft, hard),
                               setrlimit=lambda *args: calls.append(args))
    monkeypatch.setitem(sys.modules, "resource", resource)
    limits._set_posix_memory_limit(512)
    assert calls == [(0, (expected, expected))]


def test_posix_limit_failure_is_not_silently_ignored(monkeypatch):
    from app.documents import limits
    def fail(*_):
        raise ValueError("unsupported")
    monkeypatch.setitem(sys.modules, "resource", SimpleNamespace(RLIMIT_AS=0, getrlimit=lambda _: (-1, -1), setrlimit=fail))
    with pytest.raises(limits.DocumentLimitError, match="资源边界"):
        limits._set_posix_memory_limit(512)


def test_darwin_worker_does_not_attempt_rlimit(monkeypatch, run_worker_error):
    from app.documents import limits
    monkeypatch.setattr(limits, "_is_darwin", lambda: True)
    monkeypatch.setattr(limits, "_set_posix_memory_limit", lambda *_: pytest.fail("Darwin must use parent monitoring"))
    assert run_worker_error(limits.DocumentLimitError("明确的限制")) == "明确的限制"


@pytest.mark.parametrize("samples,response,expected,ready", [
    ([50, 100], ("ok", "parsed", 90), "parsed", True),
    ([101], None, "内存资源预算", False),
    ([50, 101], None, "内存资源预算", True),
    ([50, 60], ("ok", "parsed", 101), "内存资源预算", True),
    ([50, 60], ("error", "malformed", None), "malformed", True),
    ([None], None, "内存监控", False),
    ([50, None], None, "内存监控", True),
])
def test_darwin_parent_monitors_child_and_fails_closed(monkeypatch, samples, response, expected, ready):
    from app.documents import limits

    calls = []
    remaining = iter(samples)
    class Monitor:
        def resident_bytes(self, pid):
            assert pid == 123
            value = next(remaining)
            if value is None:
                raise limits.DocumentLimitError("无法读取文档解析的内存监控")
            return value
    class Child:
        pid = 123
        def start(self): calls.append("start")
        def is_alive(self): return True
        def terminate(self): calls.append("terminate")
        def join(self, timeout): calls.append("join")
        def kill(self): calls.append("kill")
        def close(self): calls.append("close")
    class _FakeTemporaryDirectory:
        def __enter__(self): return "unused"
        def __exit__(self, *args): return False
    class Receiver:
        def poll(self, timeout): return response is not None
        def recv(self): return response
        def close(self): calls.append("receive.close")
    child = Child()
    ctx = SimpleNamespace(Pipe=lambda **_: (Receiver(), SimpleNamespace(close=lambda: None)),
                          Event=lambda: SimpleNamespace(set=lambda: calls.append("ready")),
                          Process=lambda *args, **kwargs: child)
    monkeypatch.setattr(limits, "_is_darwin", lambda: True)
    monkeypatch.setattr(limits, "_DarwinMemoryMonitor", Monitor)
    monkeypatch.setattr(limits, "FAST_PARSE_MEMORY_BYTES", 100)
    monkeypatch.setattr(limits.tempfile, "TemporaryDirectory", lambda **_: _FakeTemporaryDirectory())
    monkeypatch.setattr(limits.multiprocessing, "get_context", lambda _: ctx)
    if response and response[0] == "ok" and expected == "parsed":
        assert limits._run_document_parser("note.txt", b"x", "fast", max_characters=1000, metrics=None) == "parsed"
    else:
        with pytest.raises(limits.DocumentLimitError, match=expected):
            limits._run_document_parser("note.txt", b"x", "fast", max_characters=1000, metrics=None)
    assert ("ready" in calls) is ready
    assert "terminate" in calls and "join" in calls and "close" in calls


def test_darwin_sample_race_accepts_completed_result(monkeypatch):
    from app.documents import limits

    calls = []
    class Monitor:
        def resident_bytes(self, pid):
            calls.append("sample")
            if calls.count("sample") == 1:
                return 50
            raise limits.DocumentLimitError("无法读取文档解析的内存监控")
    class Child:
        pid = 123
        alive = iter([True, False, False])
        def start(self): pass
        def is_alive(self): return next(self.alive, False)
        def join(self, timeout): pass
        def close(self): pass
    class Receiver:
        def poll(self, timeout): return True
        def recv(self): return ("ok", "parsed", 80)
        def close(self): pass
    class Directory:
        def __enter__(self): return "unused"
        def __exit__(self, *args): return False
    child = Child()
    ctx = SimpleNamespace(Pipe=lambda **_: (Receiver(), SimpleNamespace(close=lambda: None)),
                          Event=lambda: SimpleNamespace(set=lambda: None),
                          Process=lambda *args, **kwargs: child)
    monkeypatch.setattr(limits, "_is_darwin", lambda: True)
    monkeypatch.setattr(limits, "_DarwinMemoryMonitor", Monitor)
    monkeypatch.setattr(limits, "FAST_PARSE_MEMORY_BYTES", 100)
    monkeypatch.setattr(limits.tempfile, "TemporaryDirectory", lambda **_: Directory())
    monkeypatch.setattr(limits.multiprocessing, "get_context", lambda _: ctx)
    assert limits._run_document_parser("note.txt", b"x", "fast", max_characters=1000, metrics=None) == "parsed"


@pytest.fixture
def run_worker_error(monkeypatch):
    """Exercise worker exception routing without spawning or imposing host limits."""
    from app.documents import limits, parser
    import pypdf.filters as filters

    monkeypatch.setattr(limits, "_set_posix_memory_limit", lambda *_: None)
    monkeypatch.setattr(tempfile, "tempdir", tempfile.tempdir)
    for name in ("ZLIB_MAX_OUTPUT_LENGTH", "LZW_MAX_OUTPUT_LENGTH", "RUN_LENGTH_MAX_OUTPUT_LENGTH", "JBIG2_MAX_OUTPUT_LENGTH"):
        monkeypatch.setattr(filters, name, getattr(filters, name, None), raising=False)
    monkeypatch.setattr(limits, "_memory_ceiling_reached", lambda _: True)

    def run(error):
        messages = []
        closed = []
        ready = []
        connection = SimpleNamespace(send=messages.append, close=lambda: closed.append(True))

        def fail(*args, **kwargs):
            raise error

        monkeypatch.setattr(parser, "_parse_document_result", fail)
        limits._parse_worker(connection, SimpleNamespace(wait=lambda: ready.append(True)),
                             "limited.pdf", b"fixture", "fast", 1000, 512, "unused")
        assert ready == [True] and closed == [True]
        assert len(messages) == 1 and messages[0][0] == "error"
        return messages[0][1]

    return run


def test_worker_preserves_explicit_limit_error_even_at_memory_ceiling(run_worker_error):
    from app.documents.limits import DocumentLimitError
    message = "明确的处理范围错误；原文件保留"
    assert run_worker_error(DocumentLimitError(message)) == message


@pytest.mark.parametrize("message", [
    "Word 文件展开超过安全处理范围；请拆分资料，原文件保留",
    "资料展开超过 1000 字符处理范围；请拆分资料，原文件保留",
    "资料超过 1000 字符处理范围；请拆分资料，原文件保留",
    "PDF 页数超过处理范围；请拆分资料，原文件保留",
])
def test_worker_preserves_known_parser_limit_errors(run_worker_error, message):
    from app.documents.limits import DocumentLimitError
    assert run_worker_error(DocumentLimitError(message)) == message


def test_worker_preserves_pdf_filter_expansion_limit(run_worker_error):
    from pypdf.filters import LimitReachedError
    assert run_worker_error(LimitReachedError("decode limit")) == "PDF 解压展开超过处理范围；原文件保留"


@pytest.mark.parametrize("error", [ValueError("cannot reshape array"), MemoryError()])
def test_worker_still_reports_unknown_allocation_failures_as_memory(run_worker_error, error):
    assert run_worker_error(error) == "文档解析超过内存资源预算"


def test_worker_keeps_unknown_value_error_below_memory_ceiling(run_worker_error, monkeypatch):
    from app.documents import limits
    monkeypatch.setattr(limits, "_memory_ceiling_reached", lambda _: False)
    assert run_worker_error(ValueError("corrupt PDF")) == "corrupt PDF"


def test_parser_character_limit_has_an_explicit_error_type():
    from app.documents.limits import DocumentLimitError
    from app.documents.parser import _parse_document_result
    with pytest.raises(DocumentLimitError, match="处理范围"):
        _parse_document_result("identity.txt", ("x" * 995 + "13800138000").encode(), max_characters=1000)


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
