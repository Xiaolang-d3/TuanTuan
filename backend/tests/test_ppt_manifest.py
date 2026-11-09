import hashlib

import pytest

from app import db
from app.execution.workspace_files import WorkspaceFiles
from app.extensions.contracts import ExtensionContext
from app.jobs.repository import JobConflict, JobRepository
from app.presentations.manifest import ProjectManifestStore
from app.workspace import use_workspace


@pytest.fixture
def running(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "accounts.db")
    with use_workspace(1):
        db.init_db()
        context = ExtensionContext.current()
        now = [1000.0]
        repository = JobRepository(clock=lambda: now[0])
        repository.enqueue("ppt.generate", {}, {}, context, "manifest")
        job = repository.claim(context)
        root = tmp_path / "project"
        files = WorkspaceFiles(root)
        files.write("sources/input.md", "中文来源".encode())
        files.write("svg_output/slide_01.svg", b"svg source fixture")
        yield ProjectManifestStore(repository, job, context, root), repository, job, root, now


def test_only_committed_manifest_can_resume(running):
    store, repository, job, root, _ = running
    record = store.commit("pages", ["sources/input.md", "svg_output/slide_01.svg"])
    checkpoint = repository.get(job["id"], store.context)["checkpoint"]
    assert checkpoint["manifest_sha256"] == record["sha256"]
    assert checkpoint["source_version"] == 1
    assert store.load()["stage"] == "pages"
    # A stray or newer candidate cannot become the current manifest on recovery.
    (root / "manifests/uncommitted.json").write_text('{"stage":"export"}')
    assert store.load()["stage"] == "pages"


@pytest.mark.parametrize("name", ["sources/input.md", "svg_output/slide_01.svg"])
def test_modified_committed_source_cannot_resume(running, name):
    store, _, _, root, _ = running
    store.commit("pages", ["sources/input.md", "svg_output/slide_01.svg"])
    (root / name).write_bytes(b"changed")
    with pytest.raises(ValueError, match="校验"):
        store.load()


def test_modified_manifest_cannot_resume(running):
    store, _, _, root, _ = running
    record = store.commit("pages", ["sources/input.md"])
    (root / record["path"]).write_bytes(b"{}")
    with pytest.raises(ValueError, match="校验"):
        store.load()


def test_previous_manifest_bytes_are_preserved(running):
    store, _, _, root, _ = running
    first = store.commit("sources", ["sources/input.md"])
    original = (root / first["path"]).read_bytes()
    second = store.commit("pages", ["sources/input.md", "svg_output/slide_01.svg"])
    assert first["path"] != second["path"]
    assert (root / first["path"]).read_bytes() == original
    assert second["source_version"] == 2
    assert store.load()["files"]["sources/input.md"] == hashlib.sha256((root / "sources/input.md").read_bytes()).hexdigest()


def test_expired_attempt_cannot_commit(running):
    store, _, _, root, now = running
    now[0] += 31
    with pytest.raises(JobConflict):
        store.commit("pages", ["sources/input.md"])
    assert not (root / "manifests").exists()


def test_manifest_checkpoint_does_not_erase_unknown_model_request(running):
    store, repository, job, _, _ = running
    repository.checkpoint(job["id"], job["owner_token"], {"external_outcome": "unknown", "model_request_id": "pending"}, store.context)
    with pytest.raises(JobConflict, match="结果不明"):
        store.commit("pages", ["sources/input.md"])
    assert repository.get(job["id"], store.context)["checkpoint"]["external_outcome"] == "unknown"


def test_missing_manifest_is_not_reconstructed_from_disk(running):
    store, _, _, _, _ = running
    with pytest.raises(JobConflict, match="清单"):
        store.load()


def test_cannot_commit_manifest_as_its_own_source_or_external_paths(running):
    store, _, _, _, _ = running
    for paths in [["../outside.md"], ["manifests/x.json"], ["sources/input.md"] * 2]:
        with pytest.raises(ValueError):
            store.commit("pages", paths)


def test_lease_lost_between_write_and_checkpoint_does_not_commit(running, monkeypatch):
    store, repository, job, root, now = running
    original = store.files.write

    def lose_lease(*args, **kwargs):
        original(*args, **kwargs)
        now[0] += 31

    monkeypatch.setattr(store.files, "write", lose_lease)
    with pytest.raises(JobConflict):
        store.commit("pages", ["sources/input.md"])
    assert repository.get(job["id"], store.context)["checkpoint"] == {}
    assert list((root / "manifests").glob("*.json"))
