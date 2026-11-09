from dataclasses import dataclass

import pytest
from pydantic import ValidationError

from app.domain import ToolDefinition
from app.extensions.contracts import ExtensionContext, RegistrationOwner
from app.extensions.manifest import ExtensionManifest
from app.tooling import ToolSpec
from app.tools import ToolRegistry


def test_v1_rejects_unknown_adapter_and_invalid_manifest():
    assert ExtensionManifest(id="notes", name="笔记", version="1.0", api_version=1).api_version == 1
    for extra in ({"api_version": 2}, {"tools": [{"adapter": "arbitrary-python"}]}, {"files": {"../secret": "a" * 64}}):
        with pytest.raises(ValidationError):
            ExtensionManifest.model_validate({"id": "notes", "name": "笔记", "version": "1.0", "api_version": 1, **extra})


@dataclass
class Handler:
    label: str
    definition = ToolDefinition(name="extension_test", description="测试", input_schema={"type": "object"})
    spec = ToolSpec(name="extension_test", title="测试", risk="read_only", capabilities=frozenset({"test.read"}))


def test_owner_dispose_does_not_remove_other_revision_and_snapshot_survives():
    registry = ToolRegistry()
    old = Handler("old")
    dispose = registry.register_handler(old, owner=RegistrationOwner(extension_id="demo", revision="one"), scope=1)
    snapshot = registry.snapshot_for_run(ExtensionContext(user_id=1))
    assert not registry.snapshot_for_run(ExtensionContext(user_id=2)).names()
    dispose()
    registry.register_handler(Handler("new"), owner=RegistrationOwner(extension_id="demo", revision="two"), scope=1)
    dispose()
    assert registry.get("extension_test").label == "new"
    assert snapshot.get("extension_test") is old
    with pytest.raises(ValueError, match="快照"):
        snapshot.register_handler(Handler("invalid"))
