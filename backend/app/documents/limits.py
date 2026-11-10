"""Hard process boundaries for untrusted document extraction."""
from __future__ import annotations

import multiprocessing
import os
import sys
import tempfile
from threading import BoundedSemaphore
from time import monotonic

FAST_PARSE_SECONDS = 15.0
ENHANCED_PARSE_SECONDS = 60.0
FAST_PARSE_MEMORY_BYTES = 512 * 1024 * 1024
ENHANCED_PARSE_MEMORY_BYTES = 2 * 1024 * 1024 * 1024
_PARSE_SLOTS = BoundedSemaphore(2)


class DocumentLimitError(ValueError):
    pass


class _WindowsParseJob:
    def __init__(self, memory_limit):
        import ctypes as c
        from ctypes import wintypes as w
        class Basic(c.Structure):
            _fields_ = [("process_time", c.c_longlong), ("job_time", c.c_longlong), ("flags", w.DWORD),
                ("min_working", c.c_size_t), ("max_working", c.c_size_t), ("active_limit", w.DWORD),
                ("affinity", c.c_size_t), ("priority", w.DWORD), ("scheduling", w.DWORD)]
        class IO(c.Structure):
            _fields_ = [(name, c.c_ulonglong) for name in ("read_ops", "write_ops", "other_ops", "read_bytes", "write_bytes", "other_bytes")]
        class Extended(c.Structure):
            _fields_ = [("basic", Basic), ("io", IO), ("process_memory", c.c_size_t), ("job_memory", c.c_size_t),
                        ("peak_process", c.c_size_t), ("peak_job", c.c_size_t)]
        self.api, self.info_type = c.WinDLL("kernel32", use_last_error=True), Extended
        self.api.CreateJobObjectW.argtypes, self.api.CreateJobObjectW.restype = [c.c_void_p, w.LPCWSTR], w.HANDLE
        self.api.SetInformationJobObject.argtypes = [w.HANDLE, c.c_int, c.c_void_p, w.DWORD]
        self.api.AssignProcessToJobObject.argtypes = [w.HANDLE, w.HANDLE]
        self.api.QueryInformationJobObject.argtypes = [w.HANDLE, c.c_int, c.c_void_p, w.DWORD, c.c_void_p]
        self.api.CloseHandle.argtypes = [w.HANDLE]
        self.handle = self.api.CreateJobObjectW(None, None)
        info = Extended()
        info.basic.flags = 0x100 | 0x200 | 0x2000  # process/job commit limits; kill descendants on close
        info.process_memory = info.job_memory = memory_limit
        if not self.handle or not self.api.SetInformationJobObject(self.handle, 9, c.byref(info), c.sizeof(info)):
            self.close()
            raise DocumentLimitError("无法配置文档解析的内存资源边界")

    def assign(self, process):
        if not self.api.AssignProcessToJobObject(self.handle, process.sentinel):
            raise DocumentLimitError("无法应用文档解析资源边界")

    def peak_memory(self):
        import ctypes as c
        info = self.info_type()
        if self.api.QueryInformationJobObject(self.handle, 9, c.byref(info), c.sizeof(info), None):
            return int(info.peak_job)
        return None

    def close(self):
        if self.handle:
            self.api.CloseHandle(self.handle)
            self.handle = None


def _memory_ceiling_reached(memory_limit: int) -> bool:
    """True when this child is already at (or past) the ceiling it was given.

    pypdf reports an exhausted address space as an ordinary ValueError, so the
    exception type alone cannot separate a corrupt file from a memory limit.
    """
    if os.name == "nt":
        return False
    try:
        import resource
        peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if sys.platform == "darwin" else 1024)
    except Exception:
        return False
    return peak >= memory_limit * 0.9


def _parse_worker(connection, ready, filename, content, mode, max_characters, memory_limit, directory):
    try:
        ready.wait()
        if os.name != "nt":
            import resource
            resource.setrlimit(resource.RLIMIT_AS, (memory_limit, memory_limit))
        tempfile.tempdir = directory
        # pypdf already supports bounded decoding; keep each stream well below
        # the process limit, including less common compression filters.
        import pypdf.filters as filters
        for name in ("ZLIB_MAX_OUTPUT_LENGTH", "LZW_MAX_OUTPUT_LENGTH", "RUN_LENGTH_MAX_OUTPUT_LENGTH", "JBIG2_MAX_OUTPUT_LENGTH"):
            setattr(filters, name, 16 * 1024 * 1024)
        from .parser import _parse_document_result
        try:
            result = _parse_document_result(filename, content, mode, max_characters=max_characters)
        except filters.LimitReachedError as exc:
            raise DocumentLimitError("PDF 解压展开超过处理范围；原文件保留") from exc
        peak = None
        if os.name != "nt":
            import resource
            peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * (1 if sys.platform == "darwin" else 1024)
        connection.send(("ok", result, peak))
    except MemoryError:
        connection.send(("error", "文档解析超过内存资源预算", None))
    except DocumentLimitError as exc:
        connection.send(("error", str(exc), None))
    except ValueError as exc:
        message = "文档解析超过内存资源预算" if _memory_ceiling_reached(memory_limit) else str(exc)
        connection.send(("error", message, None))
    except Exception:
        message = ("文档解析超过内存资源预算" if _memory_ceiling_reached(memory_limit)
                   else "文档解析失败，请确认文件未损坏且内容可识别")
        connection.send(("error", message, None))
    finally:
        connection.close()


def run_document_parser(filename, content, mode, *, max_characters, metrics=None):
    if not _PARSE_SLOTS.acquire(timeout=5):
        raise DocumentLimitError("解析任务较多，请稍后重试；原文件保留")
    try:
        return _run_document_parser(filename, content, mode, max_characters=max_characters, metrics=metrics)
    finally:
        _PARSE_SLOTS.release()


def _run_document_parser(filename, content, mode, *, max_characters, metrics):
    seconds = ENHANCED_PARSE_SECONDS if mode == "enhanced" else FAST_PARSE_SECONDS
    memory_limit = ENHANCED_PARSE_MEMORY_BYTES if mode == "enhanced" else FAST_PARSE_MEMORY_BYTES
    context = multiprocessing.get_context("spawn")
    receive, send = context.Pipe(duplex=False)
    ready = context.Event()
    started, job, peak = monotonic(), None, None
    with tempfile.TemporaryDirectory(prefix="tuantuan-parse-") as directory:
        process = context.Process(target=_parse_worker, args=(send, ready, filename, content, mode, max_characters, memory_limit, directory))
        try:
            process.start()
            send.close()
            if os.name == "nt":
                job = _WindowsParseJob(memory_limit)
                job.assign(process)
            ready.set()
            while True:
                remaining = seconds - (monotonic() - started)
                if remaining <= 0:
                    raise DocumentLimitError("文档解析超过处理时限，请拆分资料或使用快速解析；原文件保留")
                if receive.poll(min(0.05, remaining)):
                    try:
                        status, result, peak = receive.recv()
                    except (EOFError, OSError):
                        raise DocumentLimitError("文档解析进程资源不足或异常退出；原文件保留") from None
                    if status != "ok":
                        raise DocumentLimitError(result)
                    return result
                if not process.is_alive():
                    raise DocumentLimitError("文档解析进程资源不足或异常退出；原文件保留")
        finally:
            if job is not None:
                peak = job.peak_memory()
                job.close()
            if process.pid is not None:
                if process.is_alive():
                    process.terminate()
                process.join(timeout=2)
                if process.is_alive():
                    process.kill()
                    process.join(timeout=2)
                process.close()
            receive.close()
            send.close()
            if metrics is not None:
                metrics.update(seconds=round(monotonic() - started, 4), peak_memory_bytes=peak, memory_limit_bytes=memory_limit)
