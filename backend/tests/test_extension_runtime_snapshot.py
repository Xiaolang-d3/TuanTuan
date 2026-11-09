import pytest

from app import db
from app.extensions.contracts import ExtensionContext
from app.extensions.repository import ExtensionRepository, ExtensionNotFound
from app.extensions.runtime_snapshot import ExtensionRunSnapshot, bind_extensions, resolve_snapshot
from app.extensions.skills import SkillService
from app.workspace import use_workspace


def test_snapshot_keeps_original_grants_revision_and_user_identity(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "default.db")
    with use_workspace(1):
        db.init_db()
        context = ExtensionContext.current()
        item = SkillService().import_text("---\nname: example\ndescription: 示例\npermissions: [shell]\n---\n方法", context)
        ExtensionRepository().set_enabled(item["id"], True, context)
        snapshot = bind_extensions(context, item["id"], grants=("workspace.read",), model_selection={"api_key": "do-not-store"})
        assert snapshot.grants == ("workspace.read",) and "do-not-store" not in snapshot.model_dump_json()
        ExtensionRepository().set_enabled(item["id"], False, context)
        assert resolve_snapshot(snapshot, context).skill_binding["revision"] == item["revision"]
        with db.connect() as conn:
            conn.execute("UPDATE extension_catalog SET revision=? WHERE id=?", ("b" * 64, item["id"]))
        with pytest.raises(ExtensionNotFound):
            resolve_snapshot(snapshot, context)
    with use_workspace(2):
        db.init_db()
        with pytest.raises(PermissionError):
            resolve_snapshot(snapshot, ExtensionContext.current())


def test_local_snapshot_requires_explicit_execution_binding(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "default.db")
    with use_workspace(1):
        db.init_db()
        context = ExtensionContext.current()
        snapshot = ExtensionRunSnapshot(
            user_id=context.user_id,
            version=2,
            grants=("builtin.ppt-master.execute",),
            model_selection={"profile_id": "p", "profile_revision": 1, "connection_id": "c", "connection_revision": 1},
            execution={"backend": "local_builtin", "adapter": "ppt-master", "runtime_digest": "a" * 64, "upstream_commit": "492a52b2b845927b0924b6eaaa495fc0dfc8f646"},
        )
        assert resolve_snapshot(snapshot, context).version == 2
