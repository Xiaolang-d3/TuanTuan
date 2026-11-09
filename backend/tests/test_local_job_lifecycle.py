import pytest
import asyncio
import sys

from app import db
from app.extensions.contracts import ExtensionContext
from app.extensions.runtime_snapshot import ExtensionRunSnapshot
from app.jobs.repository import JobConflict
from app.jobs.service import JobService
from app.workspace import use_workspace


@pytest.fixture
def scope(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "default.db")
    with use_workspace(1):
        db.init_db()
        yield ExtensionContext.current()


def test_generic_jobs_cannot_enqueue_ppt(scope):
    service = JobService({"ppt.generate": object()})
    with pytest.raises(JobConflict, match="专用"):
        service.enqueue("ppt.generate", {}, scope, "generic")


def test_generic_confirmation_cannot_bypass_official_receipt(scope):
    service = JobService({"ppt.generate": object()})
    # Stored legacy/forged jobs remain unable to enter production confirmation.
    snapshot = ExtensionRunSnapshot(user_id=scope.user_id)
    job = service.repository.enqueue("ppt.generate", {}, snapshot.model_dump(mode="json"), scope, "test-confirm")
    claimed = service.repository.claim(scope)
    waiting = service.repository.wait_for_user(job["id"], claimed["owner_token"], "确认", {}, scope)
    with pytest.raises(JobConflict, match="确认"):
        service.confirm(job["id"], waiting["stage_id"], waiting["revision"], {}, scope)


def test_local_snapshot_requires_bound_model_and_builtin_grant(scope):
    binding = {"backend": "local_builtin", "adapter": "ppt-master", "runtime_digest": "a" * 64, "upstream_commit": "492a52b2b845927b0924b6eaaa495fc0dfc8f646"}
    with pytest.raises(ValueError):
        ExtensionRunSnapshot(version=2, user_id=scope.user_id, execution=binding)


def test_v1_container_snapshot_remains_compatible(scope):
    snapshot = ExtensionRunSnapshot(user_id=scope.user_id, dependency_digest="example@sha256:" + "a" * 64)
    assert snapshot.version == 1
    assert snapshot.execution is None


def test_prepared_local_handle_uses_account_workspace_and_fences(scope):
    from app.execution.local_builtin import LocalBuiltinBackend
    from app.workspace import current_workspace_root

    class Runtime:
        digest = "a" * 64

        def verify(self):
            pass

        def command(self, command_id, args, root):
            return [sys.executable, "-c", "print('managed')"]

    identities = []
    checks = []

    async def exercise():
        handle = await LocalBuiltinBackend(runtime=Runtime()).prepare(
            scope, "a" * 32, runtime_digest="a" * 64,
            fence=lambda: checks.append(True), record_identity=identities.append,
        )
        assert handle.files.root == current_workspace_root() / "jobs" / ("a" * 32)
        result = await handle.run("test", {})
        assert result.stdout.strip() == "managed"
        assert len(identities) == 1
        assert identities[0]["created"]
        assert identities[0]["executable"]
        assert len(checks) >= 3

    asyncio.run(exercise())


def test_changed_runtime_blocks_resume(scope, monkeypatch):
    from app.execution.builtin_runtime import BuiltinRuntime
    from types import SimpleNamespace
    service = JobService({"ppt.generate": object()})
    snapshot = ExtensionRunSnapshot(
        version=2, user_id=scope.user_id, grants=("builtin.ppt-master.execute",),
        model_selection={"profile_id": "p", "profile_revision": 1, "connection_id": "c", "connection_revision": 1},
        execution={"backend": "local_builtin", "adapter": "ppt-master", "runtime_digest": "a" * 64, "upstream_commit": "492a52b2b845927b0924b6eaaa495fc0dfc8f646"},
    )
    job = service.repository.enqueue("ppt.generate", {}, snapshot.model_dump(mode="json"), scope, "changed-runtime")
    claimed = service.repository.claim(scope)
    service.repository.release(job["id"], claimed["owner_token"], "interrupted", "restart", scope)
    monkeypatch.setattr(BuiltinRuntime, "load", lambda: SimpleNamespace(digest="b" * 64))
    with pytest.raises(JobConflict, match="版本"):
        service.resume(job["id"], scope)
    assert service.get(job["id"], scope)["status"] == "interrupted"
