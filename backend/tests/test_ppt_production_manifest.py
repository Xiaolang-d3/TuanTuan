import asyncio

import pytest

from app.presentations.manifest import ProjectManifestStore
from test_ppt_generate import preparation


def test_production_checkpoint_preserves_confirmation_authority(preparation):
    p = preparation
    asyncio.run(p.preparer.prepare_stage1())
    before = p.repository.get(p.job["id"], p.context)["checkpoint"]
    files = p.preparer.files
    files.write("design_spec.md", b"spec")
    production = ProjectManifestStore(p.repository, p.job, p.context, files.root, namespace="production")
    production.commit("spec_ready", ["design_spec.md"])
    after = p.repository.get(p.job["id"], p.context)["checkpoint"]
    assert all(after[key] == value for key, value in before.items())
    assert after["production"]["stage"] == "spec_ready"
    assert p.preparer.manifests.load()["stage"] == "stage1_recommended"
    assert production.load()["files"].keys() == {"design_spec.md"}
    files.write("design_spec.md", b"modified")
    with pytest.raises(ValueError):
        production.load()


def test_production_manifest_cannot_clear_unknown_model_fence(preparation):
    p = preparation
    p.preparer.files.write("design_spec.md", b"spec")
    p.repository.checkpoint(p.job["id"], p.job["owner_token"], {"external_outcome": "unknown"}, p.context)
    store = ProjectManifestStore(p.repository, p.job, p.context, p.preparer.files.root, namespace="production")
    with pytest.raises(Exception, match="检查点"):
        store.commit("spec_ready", ["design_spec.md"])
