"""Offline contracts for on-demand platform workflows, separate from Web CI gates."""
from __future__ import annotations

from fnmatch import fnmatchcase
from pathlib import Path
import os
import shutil
import subprocess

import pytest
import yaml


ROOT = Path(__file__).resolve().parents[2]


def workflow(name):
    # GitHub's on/true/false keys must remain strings, not YAML 1.1 booleans.
    return yaml.load((ROOT / f".github/workflows/{name}.yml").read_text(encoding="utf-8"), Loader=yaml.BaseLoader)


def test_main_candidates_require_core_e2e_but_prs_only_need_fast_checks():
    config = workflow("ci")
    assert "paths" not in (config["on"]["pull_request"] or {})
    jobs = config["jobs"]
    assert "backend-windows-documents" not in jobs
    for name in ("backend-tests", "frontend-unit"):
        assert jobs[name]["runs-on"] == "ubuntu-latest"
        assert "if" not in jobs[name]
    e2e = jobs["frontend-e2e"]
    assert e2e["if"] == "github.event_name != 'pull_request'"
    assert e2e["runs-on"] == "ubuntu-latest" and "strategy" not in e2e
    restore = next(step for step in e2e["steps"] if step.get("uses", "").startswith("actions/download-artifact@"))
    assert restore["with"] == {"name": "frontend-dist", "path": "frontend/dist"}
    run = next(step for step in e2e["steps"] if "E2E_SUITE" in step.get("env", {}))
    assert "core-smoke.spec.ts" in run["run"]
    assert "github.event_name == 'workflow_dispatch'" in run["env"]["E2E_SUITE"]
    assert config["on"]["workflow_dispatch"]["inputs"]["e2e_suite"]["options"] == ["core", "full"]
    assert not any("npm run build" in step.get("run", "") for step in e2e["steps"])
    assert jobs["ci-gate"]["if"] == "always()"
    assert set(jobs["ci-gate"]["needs"]) == {
        "validate-ref", "docs-sync", "backend-tests", "frontend-unit", "frontend-e2e",
    }


def bash_executable():
    if os.name != "nt":
        return shutil.which("bash")
    git = shutil.which("git")
    if git:
        root = Path(git).resolve().parent.parent
        return next((str(path) for path in (root / "bin/bash.exe", root / "usr/bin/bash.exe") if path.is_file()), None)
    return None


@pytest.mark.parametrize("event,backend,frontend,e2e,docs,valid", [
    ("pull_request", "success", "success", "skipped", "success", True),
    ("push", "success", "success", "success", "skipped", True),
    ("workflow_dispatch", "success", "success", "success", "skipped", True),
    ("pull_request", "failure", "success", "skipped", "success", False),
    ("pull_request", "success", "skipped", "skipped", "success", False),
    ("pull_request", "success", "success", "skipped", "failure", False),
    ("push", "success", "success", "skipped", "skipped", False),
    ("push", "success", "success", "failure", "skipped", False),
    ("push", "success", "success", "cancelled", "skipped", False),
])
def test_gate_does_not_accept_failed_checks_or_skipped_candidate_acceptance(event, backend, frontend, e2e, docs, valid):
    bash = bash_executable()
    if not bash:
        pytest.skip("requires Bash")
    step = workflow("ci")["jobs"]["ci-gate"]["steps"][0]
    script = step["run"]
    for job, result in {"validate-ref": "success", "backend-tests": backend,
                        "frontend-unit": frontend, "frontend-e2e": e2e, "docs-sync": docs}.items():
        script = script.replace("${{ needs." + job + ".result }}", result)
    result = subprocess.run([bash, "-c", script], env={**os.environ, "EVENT_NAME": event}, capture_output=True, text=True)
    assert (result.returncode == 0) is valid, result.stderr


def triggers_for(name, path):
    paths = workflow(name)["on"]["pull_request"]["paths"]
    return any(fnmatchcase(path, pattern) for pattern in paths)


@pytest.mark.parametrize("path", [
    "backend/app/documents/parser.py",
    "backend/app/documents/limits.py",
    "backend/app/library/sources.py",
    "backend/app/attachments/service.py",
    "backend/app/artifacts/documents.py",
    "backend/app/chat/artifacts.py",
    "backend/app/workspace.py",
    "backend/app/db.py",
    "backend/app/database_lifecycle.py",
    "backend/app/persistence/upgrades.py",
    "backend/app/api/library.py",
    "backend/requirements.txt",
    "backend/requirements-dev-lock.txt",
    "backend/scripts/install_deps.sh",
    "backend/scripts/scan_pth.py",
    "backend/tests/test_file_permissions_windows.py",
    "backend/tests/test_library_sources.py",
    "backend/tests/test_document_blocks.py",
    "backend/tests/test_ci_workflow.py",
    "backend/tests/conftest.py",
    ".github/workflows/platform-checks.yml",
])
def test_platform_checks_cover_relevant_files(path):
    assert triggers_for("platform-checks", path)


@pytest.mark.parametrize("path", [
    "backend/app/models/service.py",
    "backend/app/agent/runtime.py",
    "backend/app/feeds/service.py",
    "backend/app/channels/weixin/service.py",
    "frontend/src/App.tsx",
    "README.md",
])
def test_ordinary_web_changes_do_not_start_windows_special_checks(path):
    assert not triggers_for("platform-checks", path)


def test_platform_checks_are_manual_or_path_scoped_and_read_only():
    config = workflow("platform-checks")
    assert set(config["on"]) == {"workflow_dispatch", "pull_request"}
    assert config["permissions"] == {"contents": "read"}
    assert "backend/**" not in config["on"]["pull_request"]["paths"]
    assert config["concurrency"]["cancel-in-progress"] == "true"
    assert "${{ github.ref }}" in config["concurrency"]["group"]
    for job in config["jobs"].values():
        assert "needs" not in job
        assert job["runs-on"] == "windows-latest"
        checkout = next(step for step in job["steps"] if step.get("uses", "").startswith("actions/checkout@"))
        assert checkout["with"]["persist-credentials"] == "false"


def test_windows_document_tests_keep_hash_install_and_both_encoding_modes():
    job = workflow("platform-checks")["jobs"]["backend-windows-documents"]
    steps = job["steps"]
    python = next(step for step in steps if step.get("uses", "").startswith("actions/setup-python@"))
    assert python["with"]["python-version"] == "3.12"
    install = next(step for step in steps if "pip install" in step.get("run", ""))
    assert install["working-directory"] == "backend"
    for flag in ("--require-hashes", "--no-deps", "--only-binary :all:", "requirements-dev-lock.txt"):
        assert flag in install["run"]
    scan = next(step for step in steps if "scan_pth.py" in step.get("run", ""))
    assert "python -I -S" in scan["run"]
    tests = [step for step in steps if "-m pytest" in step.get("run", "")]
    assert len(tests) == 2
    native, utf8 = tests
    assert native["env"] == {"EMBEDDING_BACKEND": "hash", "PYTHONUTF8": "0"}
    assert "python -X utf8 -m pytest" in utf8["run"]
    for filename in ("test_library_sources.py", "test_chat_artifacts.py", "test_file_permissions_windows.py"):
        assert filename in native["run"] and filename in utf8["run"]
    for filename in ("test_document_blocks.py", "test_source_versions.py", "test_source_backfill.py", "test_library_citations.py"):
        assert filename in native["run"]
    report = next(step for step in steps if step.get("uses", "").startswith("actions/upload-artifact@"))
    assert report["if"] == "always()"
    assert report["with"]["path"] == "backend/platform-*.xml"


def test_desktop_builds_are_owned_by_the_separate_repository():
    config = workflow("platform-checks")
    assert "desktop-windows-scripts" not in config["jobs"]
    assert not any(path.startswith("desktop/") for path in config["on"]["pull_request"]["paths"])
    assert not (ROOT / ".github/workflows/desktop-macos.yml").exists()
    assert not (ROOT / "desktop").exists()
