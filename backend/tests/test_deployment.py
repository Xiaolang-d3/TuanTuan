"""Deployment transactions use temporary data and never contact GitHub/launchd."""
from __future__ import annotations

from contextlib import nullcontext
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


@pytest.mark.parametrize("failure", [None, "missing", "wrong-body"])
def test_frontend_smoke_downloads_lazy_chunks_and_public_images(tmp_path, monkeypatch, failure):
    from urllib.error import HTTPError

    asset_paths = [*deployment.PUBLIC_FILES, "assets/revision/ChatWorkspace-chunk.js",
                   "assets/revision/ChatWorkspace-style.css", "avatars/nailong-smile.svg"]
    expected = {}
    for name in asset_paths:
        file = tmp_path / "frontend/dist" / name
        file.parent.mkdir(parents=True, exist_ok=True)
        expected["/" + name] = name.encode()
        file.write_bytes(name.encode())
    requested = []

    def open_asset(url, timeout):
        path = url.removeprefix("http://127.0.0.1:18000")
        requested.append(path)
        body = expected[path]
        if "ChatWorkspace-chunk.js" in path:
            if failure == "missing":
                raise HTTPError(url, 404, "Not Found", {}, None)
            if failure == "wrong-body":
                body = b"<html>fallback page instead of JavaScript</html>"
        response = io.BytesIO(body)
        response.status = 200
        return response

    monkeypatch.setattr(deployment.LOCAL_HTTP, "open", open_asset)
    if failure:
        with pytest.raises((HTTPError, RuntimeError)):
            deployment.check_frontend_assets(tmp_path, 18000)
    else:
        deployment.check_frontend_assets(tmp_path, 18000)
        assert set(requested) == set(expected)


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


@pytest.mark.skipif(sys.platform == "win32", reason="Deployment locking requires POSIX fcntl")
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
    assert result.returncode == 0, result.stderr.decode(errors="replace")


def test_unknown_port_owner_is_not_stopped_or_modified(deployment_root, monkeypatch):
    root, config = deployment_root
    monkeypatch.setattr(deployment, "port_open", lambda _: True)
    monkeypatch.setattr(deployment, "healthy", lambda *_: False)
    monkeypatch.setattr(deployment, "service", lambda *_: pytest.fail("must not stop an unmanaged process"))
    with pytest.raises(RuntimeError, match="unmanaged"):
        deployment.activate(root, config, NEW)
    assert not (root / "maintenance").exists()
    assert deployment.read_json(root / "current.json")["revision"] == OLD


@pytest.mark.skipif(sys.platform == "win32", reason="Deployment locking requires POSIX fcntl")
def test_newer_main_prevents_activation_of_older_candidate(deployment_root, monkeypatch):
    root, config = deployment_root
    deployment.write_json(root / "config.json", {**config, "enabled": True})
    revisions = iter((NEW, "c" * 40))
    monkeypatch.setattr(deployment, "latest_revision", lambda: next(revisions))
    monkeypatch.setattr(deployment, "prepare", lambda *_: root / "releases" / NEW)
    monkeypatch.setattr(deployment, "activate", lambda *_: pytest.fail("stale candidate must not activate"))
    deployment.once(root)
    assert deployment.read_json(root / "current.json")["revision"] == OLD


@pytest.mark.skipif(sys.platform == "win32", reason="Deployment locking requires POSIX fcntl")
def test_failed_revision_is_not_replayed_without_retry(deployment_root, monkeypatch):
    root, config = deployment_root
    deployment.write_json(root / "config.json", {**config, "enabled": True})
    deployment.write_json(root / "last-failure.json", {"revision": NEW})
    monkeypatch.setattr(deployment, "latest_revision", lambda: NEW)
    monkeypatch.setattr(deployment, "prepare", lambda *_: pytest.fail("failed revision must not retry automatically"))
    deployment.once(root)


@pytest.mark.parametrize("error", [TimeoutError(), deployment.URLError("offline"),
                                   deployment.HTTPError("https://example.test", 503, "unavailable", {}, None),
                                   subprocess.CalledProcessError(1, ["installer"])])
def test_transient_prepare_failures_retry_with_backoff_but_stop_after_three(tmp_path, monkeypatch, error):
    config = {"enabled": True, "data_dir": str(tmp_path / "data"), "port": 18000}
    deployment.write_json(tmp_path / "config.json", config)
    monkeypatch.setattr(deployment, "deploy_lock", lambda _: nullcontext(True))
    monkeypatch.setattr(deployment, "recover", lambda *_: None)
    monkeypatch.setattr(deployment, "latest_revision", lambda: NEW)
    now = [1000]
    monkeypatch.setattr(deployment.time, "time", lambda: now[0])
    attempts = []

    def fail(*_):
        attempts.append(now[0])
        raise error

    monkeypatch.setattr(deployment, "prepare", fail)
    monkeypatch.setattr(deployment, "activate", lambda *_: pytest.fail("must not activate"))
    for attempt in range(1, 4):
        with pytest.raises(type(error)):
            deployment.once(tmp_path)
        failure = deployment.read_json(tmp_path / "last-failure.json")
        assert failure["phase"] == "prepare"
        assert failure["attempts"] == attempt
        deployment.once(tmp_path)
        assert len(attempts) == attempt
        if attempt < 3:
            assert failure["retry_at"] == now[0] + 60 * 2 ** (attempt - 1)
            now[0] = failure["retry_at"]
        else:
            assert "retry_at" not in failure
    now[0] += 10000
    deployment.once(tmp_path)
    assert len(attempts) == 3
    with pytest.raises(type(error)):
        deployment.once(tmp_path, retry=True)
    assert len(attempts) == 4


@pytest.mark.parametrize("phase,error", [
    ("prepare", ValueError("integrity/config failure")),
    ("prepare", deployment.HTTPError("https://example.test", 403, "forbidden", {}, None)),
    ("activate", TimeoutError("startup timeout")),
])
def test_integrity_and_activation_failures_require_manual_retry(tmp_path, monkeypatch, phase, error):
    deployment.write_json(tmp_path / "config.json", {"enabled": True})
    monkeypatch.setattr(deployment, "deploy_lock", lambda _: nullcontext(True))
    monkeypatch.setattr(deployment, "recover", lambda *_: None)
    monkeypatch.setattr(deployment, "latest_revision", lambda: NEW)
    monkeypatch.setattr(deployment, "prepare", lambda *_: tmp_path)
    calls = []

    def fail(*_):
        calls.append(phase)
        raise error

    monkeypatch.setattr(deployment, phase if phase == "prepare" else "activate", fail)
    with pytest.raises(type(error)):
        deployment.once(tmp_path)
    assert "retry_at" not in deployment.read_json(tmp_path / "last-failure.json")
    deployment.once(tmp_path)
    assert calls == [phase]


def test_smoke_environment_never_inherits_operator_credentials(tmp_path, monkeypatch):
    monkeypatch.setenv("SYSTEMROOT", "C:/Windows")
    monkeypatch.setenv("WINDIR", "C:/Windows")
    monkeypatch.setenv("OPENAI_API_KEY", "synthetic-do-not-use")
    monkeypatch.setenv("GITHUB_TOKEN", "synthetic-do-not-use")
    monkeypatch.setenv("ARTIFICIAL_ANALYSIS_API_KEY", "fixture-benchmark-key")
    monkeypatch.setenv("TUANTUAN_BENCHMARK_ENV_FILE", "/operator/private.env")
    env = deployment.runtime_environment(tmp_path, {"data_dir": str(tmp_path / "real")}, NEW,
                                         smoke_data=tmp_path / "isolated")
    assert env["OPENAI_API_KEY"] == ""
    assert "GITHUB_TOKEN" not in env
    assert env["SYSTEMROOT"] == "C:/Windows"
    assert env["WINDIR"] == "C:/Windows"
    assert env["TUANTUAN_DATA_DIR"] == str(tmp_path / "isolated")
    assert env["TUANTUAN_SECRET_BACKEND"] == "memory"
    assert env["TUANTUAN_DEPLOYMENT_MODE"] == "hosted"
    assert "TUANTUAN_SECRET_MASTER_KEY" not in env
    assert env["PYTHON_DOTENV_DISABLED"] == "1"
    assert "ARTIFICIAL_ANALYSIS_API_KEY" not in env
    assert "TUANTUAN_BENCHMARK_ENV_FILE" not in env
    assert "TUANTUAN_QQ_ENV_FILE" not in env
    assert not {"QQ_APP_ID", "QQ_APP_KEY", "QQ_REDIRECT_URI"} & env.keys()


def test_release_uses_stable_service_config_outside_release(tmp_path, monkeypatch):
    monkeypatch.setenv("ARTIFICIAL_ANALYSIS_API_KEY", "fixture-do-not-inherit")
    monkeypatch.setenv("QQ_APP_KEY", "fixture-do-not-inherit")
    env = deployment.runtime_environment(tmp_path, {"data_dir": str(tmp_path / "real")}, NEW)
    assert env["TUANTUAN_BENCHMARK_ENV_FILE"] == str(tmp_path / "service.env")
    assert env["TUANTUAN_QQ_ENV_FILE"] == str(tmp_path / "service.env")
    assert "QQ_APP_KEY" not in env
    assert "ARTIFICIAL_ANALYSIS_API_KEY" not in env
    assert env["PYTHON_DOTENV_DISABLED"] == "1"
    assert env["TUANTUAN_DEPLOYMENT_MODE"] == "hosted"
    assert env["TUANTUAN_SECRET_BACKEND"] == "keyring"
    assert env["TUANTUAN_MODEL_ALLOWED_HOSTS"] == ""


@pytest.mark.parametrize("mode", [None, "local", "hosted"])
def test_production_policy_cannot_be_weakened_by_operator_environment(tmp_path, monkeypatch, mode):
    from app.model_connection import normalize_api_root
    from app.presentations.service import production_enabled
    from app.secret_store import secret_backend_name

    if mode is not None:
        monkeypatch.setenv("TUANTUAN_DEPLOYMENT_MODE", mode)
    monkeypatch.setenv("TUANTUAN_MODEL_ALLOWED_HOSTS", "untrusted.test,127.0.0.1")
    monkeypatch.setenv("TUANTUAN_SECRET_MASTER_KEY", "must-not-inherit")
    env = deployment.runtime_environment(tmp_path, {"data_dir": str(tmp_path / "data")}, NEW)
    assert "TUANTUAN_SECRET_MASTER_KEY" not in env
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    assert secret_backend_name() == "keyring"
    assert not production_enabled()
    assert normalize_api_root("https://api.openai.com/v1") == "https://api.openai.com/v1"
    assert normalize_api_root("https://new-gateway.example.com/v1") == "https://new-gateway.example.com/v1"
    for base in ("http://127.0.0.1:11434", "https://127.0.0.1/v1", "http://api.openai.com/v1"):
        with pytest.raises(ValueError, match="托管模式"):
            normalize_api_root(base)


def test_explicit_production_hosts_and_master_key_do_not_leak_to_smoke(tmp_path, monkeypatch):
    from cryptography.fernet import Fernet
    from app.model_connection import normalize_api_root

    key = Fernet.generate_key().decode("ascii")
    (tmp_path / "secret-master-key").write_text(key + "\n", encoding="ascii")
    config = {"data_dir": str(tmp_path / "data"), "model_allowed_hosts": ["Gateway.Example.test"]}
    env = deployment.runtime_environment(tmp_path, config, NEW)
    assert env["TUANTUAN_SECRET_MASTER_KEY"] == key
    assert env["TUANTUAN_MODEL_ALLOWED_HOSTS"] == "gateway.example.test"
    for name, value in env.items():
        monkeypatch.setenv(name, value)
    assert normalize_api_root("https://gateway.example.test/v1") == "https://gateway.example.test/v1"
    with pytest.raises(ValueError, match="托管模式"):
        normalize_api_root("http://gateway.example.test/v1")
    smoke_env = deployment.runtime_environment(tmp_path, config, NEW, smoke_data=tmp_path / "smoke")
    assert "TUANTUAN_SECRET_MASTER_KEY" not in smoke_env
    assert "TUANTUAN_MODEL_ALLOWED_HOSTS" not in smoke_env


@pytest.mark.parametrize("hosts", ["gateway.test", ["https://gateway.test"], ["*.test"], ["a.test,b.test"], [None]])
def test_production_rejects_malformed_allowed_hosts(tmp_path, hosts):
    with pytest.raises(ValueError, match="model_allowed_hosts"):
        deployment.runtime_environment(tmp_path, {"data_dir": "data", "model_allowed_hosts": hosts}, NEW)


def test_production_quick_ppt_image_must_be_explicit_and_pinned(tmp_path, monkeypatch):
    monkeypatch.setenv("TUANTUAN_QUICK_PPT_IMAGE", "not-inherited")
    image = "registry.example.test/quick-ppt@sha256:" + "b" * 64
    config = {"data_dir": "data", "quick_ppt_image": image}
    env = deployment.runtime_environment(tmp_path, config, NEW)
    assert env["TUANTUAN_QUICK_PPT_IMAGE"] == image and env["TUANTUAN_DEPLOYMENT_MODE"] == "hosted"
    assert "TUANTUAN_QUICK_PPT_IMAGE" not in deployment.runtime_environment(tmp_path, config, NEW, smoke_data=tmp_path / "smoke")
    with pytest.raises(ValueError, match="quick_ppt_image"):
        deployment.runtime_environment(tmp_path, {**config, "quick_ppt_image": "quick-ppt:latest"}, NEW)


def test_invalid_production_config_is_rejected_before_service_stop(tmp_path, monkeypatch):
    monkeypatch.setattr(deployment, "service", lambda *_: pytest.fail("must not stop live service"))
    with pytest.raises(ValueError, match="model_allowed_hosts"):
        deployment.activate(tmp_path, {"data_dir": "data", "model_allowed_hosts": ["*.test"]}, NEW)
    assert not (tmp_path / "transaction.json").exists()


@pytest.mark.parametrize("key", ["not-base64", "YWJj"])
def test_production_rejects_invalid_master_key(tmp_path, key):
    (tmp_path / "secret-master-key").write_text(key, encoding="ascii")
    with pytest.raises(ValueError, match="master key"):
        deployment.runtime_environment(tmp_path, {"data_dir": "data"}, NEW)
