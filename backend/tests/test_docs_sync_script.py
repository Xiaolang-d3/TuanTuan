"""CI keeps local docs out of Git without requiring documentation commits."""
from __future__ import annotations

import shutil
import os
import subprocess
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "check-docs-sync.sh"
GIT = shutil.which("git")
BASH = shutil.which("bash")
if os.name == "nt":
    # System32/bash.exe is a WSL launcher, not an installed Unix shell.
    root = Path(GIT).resolve().parent.parent if GIT else None
    BASH = next((str(path) for path in (root / "bin/bash.exe", root / "usr/bin/bash.exe") if path.is_file()), None) if root else None
pytestmark = pytest.mark.skipif(GIT is None or BASH is None, reason="needs git and an installed Bash (Git Bash on Windows)")


def _repo(tmp_path: Path, files: list[str]) -> tuple[Path, str, str]:
    def git(*args: str) -> str:
        return subprocess.run(["git", *args], cwd=tmp_path, check=True, capture_output=True, text=True).stdout.strip()

    git("init", "-q")
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "base")
    base = git("rev-parse", "HEAD")
    for name in files:
        path = tmp_path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("x\n")
    git("add", "-A")
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "change")
    return tmp_path, base, git("rev-parse", "HEAD")


def _check(tmp_path: Path, files: list[str]) -> subprocess.CompletedProcess[str]:
    repo, base, head = _repo(tmp_path, files)
    return subprocess.run([BASH, SCRIPT.as_posix(), base, head], cwd=repo, capture_output=True, text=True, encoding="utf-8")


@pytest.mark.parametrize("document", ["docs/agent.md", "docs/nested/notes.md", "docs/images/example.png"])
def test_rejects_tracked_docs(tmp_path, document):
    result = _check(tmp_path, [document])
    assert result.returncode == 1
    assert document in result.stdout


def test_code_changes_pass_without_docs(tmp_path):
    result = _check(tmp_path, [
        "backend/app/agent/runtime.py",
        "backend/app/models/litellm_provider.py",
        "backend/requirements-lock.txt",
        ".github/workflows/ci.yml",
    ])
    assert result.returncode == 0, result.stdout


def test_untracking_docs_preserves_local_files_and_passes(tmp_path):
    repo, base, _ = _repo(tmp_path, ["docs/agent.md"])
    (repo / ".gitignore").write_text("/docs/\n")
    subprocess.run(["git", "rm", "-r", "--cached", "docs"], cwd=repo, check=True, capture_output=True)
    subprocess.run(["git", "add", ".gitignore"], cwd=repo, check=True)
    subprocess.run([
        "git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "local docs",
    ], cwd=repo, check=True)
    result = subprocess.run([BASH, SCRIPT.as_posix(), base, "HEAD"], cwd=repo, capture_output=True, text=True, encoding="utf-8")
    assert result.returncode == 0, result.stdout
    assert (repo / "docs/agent.md").read_text() == "x\n"
    ignored = subprocess.run(["git", "check-ignore", "docs/agent.md"], cwd=repo, capture_output=True)
    assert ignored.returncode == 0


def test_invalid_head_fails(tmp_path):
    repo, base, _ = _repo(tmp_path, ["README.md"])
    result = subprocess.run([BASH, SCRIPT.as_posix(), base, "missing-ref"], cwd=repo, capture_output=True)
    assert result.returncode != 0
