import hashlib

import pytest

from app import db
from app.artifacts.service import ArtifactService
from app.extensions.contracts import ExtensionContext
from app.jobs.service import JobService
from app.workspace import current_workspace_root, use_workspace


@pytest.fixture
def scope(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "default.db")
    with use_workspace(1):
        db.init_db()
        yield ExtensionContext.current()


def output(scope, content=b"first"):
    jobs = JobService({"test": lambda *args: None}, clock=lambda: 1000.0)
    job = jobs.enqueue("test", {}, scope, "artifact-job")
    claim = jobs.repository.claim(scope)
    root = current_workspace_root() / "jobs" / job["id"]
    root.mkdir(parents=True, exist_ok=True)
    path = root / "result.pptx"
    path.write_bytes(content)
    return jobs, claim, path


def test_partial_output_is_not_published_and_versions_remain_downloadable(scope):
    jobs, claim, path = output(scope)
    artifacts = ArtifactService(jobs.repository)
    with pytest.raises(ValueError):
        artifacts.publish(claim["id"], claim["owner_token"], "result.pptx", "report.pptx", "0" * 64, scope)
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    first = artifacts.publish(claim["id"], claim["owner_token"], "result.pptx", "report.pptx", digest, scope)
    assert artifacts.resolve(first["id"], 1, scope).read_bytes() == b"first"
    again = artifacts.publish(claim["id"], claim["owner_token"], "result.pptx", "report.pptx", digest, scope)
    assert again["id"] == first["id"] and again["version"] == 1
    path.write_bytes(b"second")
    second = artifacts.publish(claim["id"], claim["owner_token"], "result.pptx", "report.pptx", hashlib.sha256(b"second").hexdigest(), scope)
    assert second["id"] == first["id"] and second["version"] == 2
    assert artifacts.resolve(first["id"], 1, scope).read_bytes() == b"first"
    with use_workspace(2):
        db.init_db()
        with pytest.raises(FileNotFoundError):
            artifacts.resolve(first["id"], 1, ExtensionContext.current())


def test_publish_receipt_reconciles_without_exporting_again(scope, monkeypatch):
    jobs, claim, path = output(scope)
    artifacts = ArtifactService(jobs.repository)
    original = artifacts._record_receipt
    monkeypatch.setattr(artifacts, "_record_receipt", lambda *args: (_ for _ in ()).throw(RuntimeError("crash before database commit")))
    with pytest.raises(RuntimeError):
        artifacts.publish(claim["id"], claim["owner_token"], "result.pptx", "report.pptx", hashlib.sha256(b"first").hexdigest(), scope)
    monkeypatch.setattr(artifacts, "_record_receipt", original)
    restored = artifacts.reconcile(claim["id"], claim["owner_token"], scope)
    assert len(restored) == 1 and artifacts.resolve(restored[0]["id"], 1, scope).read_bytes() == b"first"


def test_worker_recovery_reuses_committed_artifact_instead_of_exporting_twice(scope):
    import asyncio
    from app.jobs.worker import JobWorker
    exported = []
    async def handler(job, control):
        if job["recovered_artifacts"]:
            return {"artifacts": [{"artifact_id": item["id"], "version": item["version"]} for item in job["recovered_artifacts"]]}
        exported.append(True)
        root = current_workspace_root() / "jobs" / job["id"]
        root.mkdir(parents=True)
        (root / "done.txt").write_bytes(b"done")
        await control.publish("done.txt", "done.txt", hashlib.sha256(b"done").hexdigest())
        raise asyncio.CancelledError()
    jobs = JobService({"test": handler}, clock=lambda: 1000.0)
    item = jobs.enqueue("test", {}, scope, "recover-file")
    asyncio.run(JobWorker(jobs).run_once(1))
    assert jobs.get(item["id"], scope)["status"] == "interrupted"
    jobs.resume(item["id"], scope)
    asyncio.run(JobWorker(jobs).run_once(1))
    assert jobs.get(item["id"], scope)["status"] == "succeeded" and len(exported) == 1


def test_non_regular_file_is_rejected_before_opening(scope, monkeypatch):
    import stat
    from pathlib import Path
    from types import SimpleNamespace
    jobs, claim, path = output(scope)
    original = Path.stat
    def fifo_stat(self, *args, **kwargs):
        if self == path: return SimpleNamespace(st_mode=stat.S_IFIFO, st_size=0, st_mtime_ns=0)
        return original(self, *args, **kwargs)
    monkeypatch.setattr(Path, "stat", fifo_stat)
    with pytest.raises(ValueError, match="普通文件"):
        ArtifactService(jobs.repository).publish(claim["id"], claim["owner_token"], "result.pptx", "report.pptx", hashlib.sha256(b"first").hexdigest(), scope)
