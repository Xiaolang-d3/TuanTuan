"""The .pth scanner never runs startup code and allowlists by content."""
from __future__ import annotations

import base64
import hashlib
import subprocess
import sys
from pathlib import Path

SCANNER = Path(__file__).resolve().parents[1] / "scripts" / "scan_pth.py"
SHIM = (
    "import os; var = 'SETUPTOOLS_USE_DISTUTILS'; enabled = os.environ.get(var, 'local') == 'local'; "
    "enabled and __import__('_distutils_hack').add_shim(); \n"
)


def run(*args: str, isolated: bool = True) -> subprocess.CompletedProcess[str]:
    flags = ["-I", "-S"] if isolated else []
    return subprocess.run([sys.executable, *flags, str(SCANNER), *args], capture_output=True, text=True, timeout=60)


def record(site: Path, dist: str, name: str, data: bytes, *more: tuple[str, bytes]) -> None:
    info = site / f"{dist}.dist-info"
    info.mkdir(exist_ok=True)
    rows = []
    for entry, content in ((name, data), *more):
        digest = base64.urlsafe_b64encode(hashlib.sha256(content).digest()).rstrip(b"=").decode()
        rows.append(f"{entry},sha256={digest},{len(content)}\n")
    (info / "RECORD").write_text("".join(rows), encoding="utf-8")


def test_refuses_to_run_with_site_processing(tmp_path):
    result = run(str(tmp_path), isolated=False)
    assert result.returncode == 2 and "-I -S" in result.stderr


def test_malicious_pth_is_reported_and_never_executed(tmp_path):
    marker = tmp_path / "pwned"
    (tmp_path / "litellm_init.pth").write_text(f"import pathlib; pathlib.Path({str(marker)!r}).write_text('x')\n")
    result = run(str(tmp_path))
    assert result.returncode == 1
    assert "litellm_init.pth: executable .pth not on the content allowlist" in result.stderr
    assert not marker.exists()


def test_allowlist_is_by_content_not_name(tmp_path):
    (tmp_path / "distutils-precedence.pth").write_bytes(SHIM.encode("utf-8"))
    record(tmp_path, "setuptools-84.0.0", "distutils-precedence.pth", SHIM.encode())
    assert run(str(tmp_path)).returncode == 0
    (tmp_path / "distutils-precedence.pth").write_text("import os; os.system('true')\n")
    result = run(str(tmp_path))
    assert result.returncode == 1
    assert "content differs from setuptools-84.0.0 RECORD" in result.stderr
    assert "not on the content allowlist" in result.stderr


def test_paths_only_pth_and_record_mismatch(tmp_path):
    (tmp_path / "extra.pth").write_bytes(b"/opt/somewhere\n")
    record(tmp_path, "extra-1.0", "extra.pth", b"/opt/somewhere\n")
    assert run(str(tmp_path)).returncode == 0
    record(tmp_path, "extra-1.0", "extra.pth", b"/opt/elsewhere\n")
    assert "content differs from extra-1.0 RECORD" in run(str(tmp_path)).stderr


def test_unowned_pth_fails_even_if_paths_only(tmp_path):
    (tmp_path / "extra.pth").write_text("/opt/somewhere\n")
    result = run(str(tmp_path))
    assert result.returncode == 1
    assert "extra.pth: not listed in any installed distribution's RECORD" in result.stderr


def test_bypass_a_pth_adds_directory_with_sitecustomize(tmp_path):
    """A paths-only .pth pointing at a directory that holds sitecustomize.py (runs at startup)."""
    site, payload = tmp_path / "site", tmp_path / "payload"
    site.mkdir()
    payload.mkdir()
    (payload / "sitecustomize.py").write_text("print('pwned')\n")
    content = f"{payload}\n".encode()
    (site / "helper.pth").write_bytes(content)
    record(site, "helper-1.0", "helper.pth", content)  # even a RECORD-owned file is not enough
    result = run(str(site))
    assert result.returncode == 1
    assert "sitecustomize.py: added to sys.path by helper.pth" in result.stderr
    # relative entries and package form are caught too
    (payload / "sitecustomize.py").unlink()
    (payload / "usercustomize").mkdir()
    (payload / "usercustomize" / "__init__.py").write_text("")
    content = b"../payload\n"
    (site / "helper.pth").write_bytes(content)
    record(site, "helper-1.0", "helper.pth", content)
    result = run(str(site))
    assert result.returncode == 1 and "usercustomize: added to sys.path by helper.pth" in result.stderr


def test_bypass_a4_pth_adds_zip_with_sitecustomize(tmp_path):
    """A RECORD-owned paths-only .pth pointing at a zip holding sitecustomize.py (zipimport runs it)."""
    import zipfile

    site = tmp_path / "site"
    site.mkdir()
    archive = tmp_path / "payload.zip"
    with zipfile.ZipFile(archive, "w") as bundle:
        bundle.writestr("sitecustomize.py", "print('pwned')\n")
    for line in (str(archive), "../payload.zip"):
        content = f"{line}\n".encode()
        (site / "helper.pth").write_bytes(content)
        record(site, "helper-1.0", "helper.pth", content)
        result = run(str(site))
        assert result.returncode == 1, line
        assert "payload.zip: file added to sys.path by helper.pth" in result.stderr
    # any regular file is refused, not only zips with a startup module
    (tmp_path / "plain.txt").write_text("x")
    content = f"{tmp_path / 'plain.txt'}\n".encode()
    (site / "helper.pth").write_bytes(content)
    record(site, "helper-1.0", "helper.pth", content)
    assert "plain.txt: file added to sys.path" in run(str(site)).stderr


def test_bypass_b_utf8_bom_before_import_line(tmp_path, monkeypatch):
    """site decodes .pth as utf-8-sig, so a BOM does not hide an import line."""
    marker = tmp_path / "pwned"
    content = b"\xef\xbb\xbf" + f"import pathlib; pathlib.Path({str(marker)!r}).write_text('x')\n".encode()
    (tmp_path / "bom.pth").write_bytes(content)
    record(tmp_path, "bom-1.0", "bom.pth", content)
    result = run(str(tmp_path))
    assert result.returncode == 1
    assert "EXECUTABLE" in result.stdout
    assert "bom.pth: executable .pth not on the content allowlist" in result.stderr
    assert not marker.exists()
    # bytes that are not UTF-8 would be decoded with the locale encoding by site: reject
    (tmp_path / "bom.pth").write_bytes(b"\xffimport os\n")
    assert "bom.pth: not valid UTF-8" in run(str(tmp_path)).stderr


def test_bypass_c_allowlisted_bytes_need_verified_setuptools(tmp_path):
    """Byte-identical copy of the setuptools .pth shipping its own _distutils_hack."""
    hack = b"import os; os.system('touch /tmp/pwned')\n"
    (tmp_path / "distutils-precedence.pth").write_bytes(SHIM.encode("utf-8"))
    (tmp_path / "_distutils_hack").mkdir()
    (tmp_path / "_distutils_hack" / "__init__.py").write_bytes(hack)
    # 1. not owned by any RECORD
    result = run(str(tmp_path))
    assert result.returncode == 1
    assert "distutils-precedence.pth: not listed in any installed distribution's RECORD" in result.stderr
    assert "allowlisted content but not owned by setuptools" in result.stderr
    # 2. owned by a different distribution that also ships the fake module
    record(tmp_path, "evil-1.0", "distutils-precedence.pth", SHIM.encode(), ("_distutils_hack/__init__.py", hack))
    assert "allowlisted content but not owned by setuptools" in run(str(tmp_path)).stderr
    # 3. owned by setuptools, but the module it imports differs from setuptools' RECORD
    (tmp_path / "evil-1.0.dist-info" / "RECORD").unlink()
    record(tmp_path, "setuptools-84.0.0", "distutils-precedence.pth", SHIM.encode(),
           ("_distutils_hack/__init__.py", b"# reviewed shim\n"))
    result = run(str(tmp_path))
    assert result.returncode == 1
    assert "__init__.py: content differs from setuptools-84.0.0 RECORD" in result.stderr
    (tmp_path / "_distutils_hack" / "__init__.py").write_bytes(b"# reviewed shim\n")
    assert run(str(tmp_path)).returncode == 0


def test_sitecustomize_is_flagged(tmp_path):
    (tmp_path / "sitecustomize.py").write_text("print('hi')\n")
    result = run(str(tmp_path))
    assert result.returncode == 1 and "sitecustomize" in result.stderr


def test_current_environment_is_clean():
    """The test venv itself (resolved via pyvenv.cfg under -S) has no unexpected startup code."""
    result = run("--python", sys.executable)
    assert result.returncode == 0, result.stdout + result.stderr
