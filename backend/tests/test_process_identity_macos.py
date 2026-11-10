"""macOS process identities must never combine data from reused PIDs."""
import ctypes
import errno
import os
import subprocess
import sys

import pytest

from app.execution import local_processes as lp


class FakeLib:
    def __init__(self, records=None, path=b"/usr/bin/python3", info_error=None, path_error=None, short=False):
        self.records = list(records or [(1700000000, 123456), (1700000000, 123456)])
        self.path = path
        self.info_error = info_error
        self.path_error = path_error
        self.short = short

    def proc_pidinfo(self, pid, flavor, arg, out, size):
        assert flavor == 3 and arg == 0 and size == 136
        if self.info_error is not None:
            ctypes.set_errno(self.info_error)
            return 0
        sec, usec = self.records.pop(0)
        item = ctypes.cast(out, ctypes.POINTER(lp._DarwinBsdInfo)).contents
        item.pid, item.start_sec, item.start_usec = pid, sec, usec
        return size - 1 if self.short else size

    def proc_pidpath(self, pid, out, size):
        assert size == 4096
        if self.path_error is not None:
            ctypes.set_errno(self.path_error)
            return 0
        ctypes.memmove(out, self.path + b"\0", len(self.path) + 1)
        return len(self.path)


def test_apple_bsdinfo_layout_and_microsecond_identity():
    assert ctypes.sizeof(lp._DarwinBsdInfo) == 136
    assert lp._DarwinBsdInfo.pid.offset == 12
    assert lp._DarwinBsdInfo.start_sec.offset == 120
    assert lp._DarwinBsdInfo.start_usec.offset == 128
    assert lp._darwin_identity(42, FakeLib()) == {
        "pid": 42, "created": "1700000000123456", "executable": "/usr/bin/python3",
    }


@pytest.mark.parametrize("field", ["info_error", "path_error"])
def test_missing_process_returns_none(field):
    assert lp._darwin_identity(42, FakeLib(**{field: errno.ESRCH})) is None


@pytest.mark.parametrize("field,error", [("info_error", errno.EPERM), ("path_error", errno.EACCES),
                                         ("info_error", 0), ("path_error", 0)])
def test_permission_and_unknown_failure_are_not_treated_as_dead(field, error):
    with pytest.raises(OSError) as result:
        lp._darwin_identity(42, FakeLib(**{field: error}))
    assert result.value.errno == (error or errno.EIO)


def test_short_read_fails_closed():
    with pytest.raises(OSError, match="Incomplete"):
        lp._darwin_identity(42, FakeLib(short=True))


def test_pid_reuse_between_path_and_creation_reads_fails_closed():
    with pytest.raises(OSError, match="changed"):
        lp._darwin_identity(42, FakeLib(records=[(1700000000, 123456), (1700000000, 123457)]))


def test_invalid_start_and_path_fail_closed():
    with pytest.raises(OSError, match="Incomplete"):
        lp._darwin_identity(42, FakeLib(records=[(1700000000, 1000000)]))
    with pytest.raises(OSError, match="Incomplete"):
        lp._darwin_identity(42, FakeLib(path=b"not-absolute"))


@pytest.mark.skipif(sys.platform != "darwin", reason="requires native macOS libproc")
def test_native_current_and_live_child_identity_then_reaped():
    current = lp.process_identity(os.getpid())
    assert current and current["pid"] == os.getpid()
    assert int(current["created"]) > 0 and os.path.isabs(current["executable"])
    assert lp.process_identity(os.getpid()) == current
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    try:
        first = lp.process_identity(child.pid)
        assert first and first["pid"] == child.pid and first == lp.process_identity(child.pid)
        assert os.path.isabs(first["executable"])
    finally:
        child.terminate()
        child.wait(timeout=10)
    assert lp.process_identity(child.pid) is None
