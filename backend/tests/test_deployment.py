"""Deployment transactions use temporary data and never contact GitHub/launchd."""
from __future__ import annotations

import importlib.util
import io
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tarfile
from types import SimpleNamespace

import pytest


spec = importlib.util.spec_from_file_location("deployment", Path(__file__).parents[2] / "scripts/deployment.py")
deployment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deployment)
OLD = "a" * 40
NEW = "b" * 40


@pytest.fixture
def deployment_root(tmp_path, monkeypatch):
    for name in ("logs", "backups", "releases", "data"):
        (tmp_path / name).mkdir()
    monkeypatch.setattr(deployment.shutil, "disk_usage", lambda _: SimpleNamespace(free=100 * 1024**3))
    deployment.write_json(tmp_path / "current.json", {"revision": OLD})
    deployment.write_json(tmp_path / "data/record.json", {"message": "keep this conversation"})
    return tmp_path, {"data_dir": str(tmp_path / "data"), "port": 18000}


def test_bundle_excludes_runtime_directories_and_retains_built_frontend(tmp_path):
    source = tmp_path / "source"
    for filename in ("backend/app/main.py", "backend/scripts/install_deps.sh",
                     "backend/requirements-lock.txt", "frontend/dist/index.html"):
        path = source / filename
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("fixture")
    (source / "backend/.env").write_text("must not ship")
    (source / "backend/data").mkdir()
    (source / "backend/data/auth.db").write_text("private")
    deployment.bundle(source, tmp_path / "output", NEW)
    release = tmp_path / "release"
    deployment.extract_bundle(tmp_path / "output/app.tar.gz", release)
    assert (release / "frontend/dist/index.html").read_text() == "fixture"
    assert not (release / "backend/.env").exists()
    assert not (release / "backend/data").exists()
    assert json.loads((tmp_path / "output/release.json").read_text())["revision"] == NEW


@pytest.mark.parametrize("name,kind", [("../escape", "file"), ("/absolute", "file"),
                                      ("backend/app/link", "symlink"), ("backend/data/auth.db", "file")])
def test_untrusted_archives_cannot_escape_or_overwrite_runtime_data(tmp_path, name, kind):
    archive = tmp_path / "app.tar.gz"
    with tarfile.open(archive, "w:gz") as tar:
        member = tarfile.TarInfo(name)
        if kind == "symlink":
            member.type = tarfile.SYMTYPE
            member.linkname = "/tmp/unrelated"
            tar.addfile(member)
        else:
            member.size = 1
            tar.addfile(member, io.BytesIO(b"x"))
    with pytest.raises(RuntimeError):
        deployment.extract_bundle(archive, tmp_path / "release")


def test_failed_candidate_restores_data_before_reopening_old_release(deployment_root, monkeypatch):
    root, config = deployment_root
    events = []
    running = [False]
    monkeypatch.setattr(deployment, "port_open", lambda _: running[0])
    monkeypatch.setattr(deployment, "healthy", lambda *_: running[0])

    def service(_, action):
        events.append(action)
        running[0] = action == "start"

    monkeypatch.setattr(deployment, "service", service)

    def wait(_, revision):
        if revision == NEW:
            assert (root / "maintenance").is_file()
            deployment.write_json(root / "data/record.json", {"message": "candidate migration"})
            raise RuntimeError("candidate startup failed")
        assert json.loads((root / "data/record.json").read_text())["message"] == "keep this conversation"

    monkeypatch.setattr(deployment, "wait_healthy", wait)
    with pytest.raises(RuntimeError, match="candidate startup failed"):
        deployment.activate(root, config, NEW)
    assert deployment.read_json(root / "current.json")["revision"] == OLD
    assert not (root / "maintenance").exists()
    assert events == ["stop", "start", "stop", "start"]
    assert any(p.name.startswith("failed-") for p in (root / "backups").iterdir())


def test_stop_failure_reopens_the_unchanged_old_service(deployment_root, monkeypatch):
    root, config = deployment_root
    monkeypatch.setattr(deployment, "port_open", lambda _: True)
    monkeypatch.setattr(deployment, "healthy", lambda *_: True)
    monkeypatch.setattr(deployment, "service", lambda *_: (_ for _ in ()).throw(RuntimeError("stop failed")))
    with pytest.raises(RuntimeError, match="stop failed"):
        deployment.activate(root, config, NEW)
    assert not (root / "maintenance").exists()
    assert not (root / "transaction.json").exists()
    assert deployment.read_json(root / "current.json")["revision"] == OLD


def test_interrupted_switch_is_recovered_before_same_sha_is_skipped(deployment_root, monkeypatch):
    root, config = deployment_root
    backup = root / "backups/snapshot"
    shutil.copytree(root / "data", backup)
    deployment.write_json(root / "data/record.json", {"message": "partial migration"})
    deployment.write_json(root / "current.json", {"revision": NEW})
    deployment.write_json(root / "transaction.json", {
        "previous": {"revision": OLD}, "candidate": NEW, "phase": "backed-up",
        "backup": str(backup), "failed_data": str(root / "backups/failed"),
    })
    (root / "maintenance").touch()
    deployment.write_json(root / "config.json", {**config, "enabled": True})
    monkeypatch.setattr(deployment, "port_open", lambda _: False)
    monkeypatch.setattr(deployment, "healthy", lambda _, revision: revision == OLD)
    monkeypatch.setattr(deployment, "latest_revision", lambda: OLD)
    stops = []
    monkeypatch.setattr(deployment, "service", lambda _, action: stops.append(action))
    deployment.once(root)
    assert deployment.read_json(root / "current.json")["revision"] == OLD
    assert deployment.read_json(root / "data/record.json")["message"] == "keep this conversation"
    assert not (root / "maintenance").exists()
    assert not (root / "transaction.json").exists()
    assert stops == ["stop"]  # Even an unbound startup/migration must be stopped.


def test_committed_switch_never_restores_an_old_snapshot(deployment_root, monkeypatch):
    root, config = deployment_root
    deployment.write_json(root / "data/record.json", {"message": "new visitor write"})
    deployment.write_json(root / "current.json", {"revision": NEW})
    deployment.write_json(root / "transaction.json", {
        "previous": {"revision": OLD}, "candidate": NEW, "phase": "verified",
        "backup": "old snapshot", "failed_data": str(root / "backups/failed"),
    })
    deployment.recover(root, config)
    assert deployment.read_json(root / "data/record.json")["message"] == "new visitor write"
    assert deployment.read_json(root / "last-success.json")["revision"] == NEW
    assert not (root / "transaction.json").exists()


@pytest.mark.parametrize("users", [0, 2])
def test_readiness_accepts_fresh_and_multi_user_databases(tmp_path, users):
    env = deployment.runtime_environment(tmp_path, {"data_dir": str(tmp_path / "data")}, NEW,
                                         smoke_data=tmp_path / "data")
    setup = "from app.api.system import startup; startup(); from app.auth import register_user; "
    setup += "; ".join(f"register_user('user{i}@example.test', 'a-long-test-password')" for i in range(users))
    result = subprocess.run([sys.executable, "-c", setup + "\n" + deployment.DATABASE_READY_CODE],
                            cwd=Path(__file__).parents[1], env=env, capture_output=True, timeout=30)
    assert result.returncode == 0, result.stderr.decode()


def test_unknown_port_owner_is_not_stopped_or_modified(deployment_root, monkeypatch):
    root, config = deployment_root
    monkeypatch.setattr(deployment, "port_open", lambda _: True)
    monkeypatch.setattr(deployment, "healthy", lambda *_: False)
    monkeypatch.setattr(deployment, "service", lambda *_: pytest.fail("must not stop an unmanaged process"))
    with pytest.raises(RuntimeError, match="unmanaged"):
        deployment.activate(root, config, NEW)
    assert not (root / "maintenance").exists()
    assert deployment.read_json(root / "current.json")["revision"] == OLD


def test_newer_main_prevents_activation_of_older_candidate(deployment_root, monkeypatch):
    root, config = deployment_root
    deployment.write_json(root / "config.json", {**config, "enabled": True})
    revisions = iter((NEW, "c" * 40))
    monkeypatch.setattr(deployment, "latest_revision", lambda: next(revisions))
    monkeypatch.setattr(deployment, "prepare", lambda *_: root / "releases" / NEW)
    monkeypatch.setattr(deployment, "activate", lambda *_: pytest.fail("stale candidate must not activate"))
    deployment.once(root)
    assert deployment.read_json(root / "current.json")["revision"] == OLD


def test_failed_revision_is_not_replayed_without_retry(deployment_root, monkeypatch):
    root, config = deployment_root
    deployment.write_json(root / "config.json", {**config, "enabled": True})
    deployment.write_json(root / "last-failure.json", {"revision": NEW})
    monkeypatch.setattr(deployment, "latest_revision", lambda: NEW)
    monkeypatch.setattr(deployment, "prepare", lambda *_: pytest.fail("failed revision must not retry automatically"))
    deployment.once(root)


def test_smoke_environment_never_inherits_operator_credentials(tmp_path, monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "synthetic-do-not-use")
    monkeypatch.setenv("GITHUB_TOKEN", "synthetic-do-not-use")
    monkeypatch.setenv("ARTIFICIAL_ANALYSIS_API_KEY", "fixture-benchmark-key")
    monkeypatch.setenv("TUANTUAN_BENCHMARK_ENV_FILE", "/operator/private.env")
    env = deployment.runtime_environment(tmp_path, {"data_dir": str(tmp_path / "real")}, NEW,
                                         smoke_data=tmp_path / "isolated")
    assert env["OPENAI_API_KEY"] == ""
    assert "GITHUB_TOKEN" not in env
    assert env["TUANTUAN_DATA_DIR"] == str(tmp_path / "isolated")
    assert env["TUANTUAN_SECRET_BACKEND"] == "memory"
    assert env["PYTHON_DOTENV_DISABLED"] == "1"
    assert "ARTIFICIAL_ANALYSIS_API_KEY" not in env
    assert "TUANTUAN_BENCHMARK_ENV_FILE" not in env


def test_release_uses_stable_service_config_outside_release(tmp_path, monkeypatch):
    monkeypatch.setenv("ARTIFICIAL_ANALYSIS_API_KEY", "fixture-do-not-inherit")
    env = deployment.runtime_environment(tmp_path, {"data_dir": str(tmp_path / "real")}, NEW)
    assert env["TUANTUAN_BENCHMARK_ENV_FILE"] == str(tmp_path / "service.env")
    assert "ARTIFICIAL_ANALYSIS_API_KEY" not in env
    assert env["PYTHON_DOTENV_DISABLED"] == "1"
