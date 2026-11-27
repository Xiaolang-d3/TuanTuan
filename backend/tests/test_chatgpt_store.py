from __future__ import annotations

import asyncio
import sqlite3
import sys
from uuid import UUID

import pytest
from keyring.backends.chainer import ChainerBackend
from keyring.backends.fail import Keyring as FailKeyring
from keyring.backends.null import Keyring as NullKeyring

from app import chatgpt_store as store


class _MemoryBackend:
    def __init__(self):
        self.entries = {}
        self.writes = 0

    def set_password(self, service, username, password):
        self.writes += 1
        self.entries[service, username] = password

    def get_password(self, service, username):
        return self.entries.get((service, username))

    def delete_password(self, service, username):
        del self.entries[service, username]


def _os_backend(module="keyring.backends.Windows", name="WinVaultKeyring"):
    return type(name, (_MemoryBackend,), {"__module__": module})()


@pytest.fixture(autouse=True)
def local_vault(monkeypatch, tmp_path):
    directory = tmp_path / "installation" / "vault"
    monkeypatch.setattr(store, "_vault_dir", lambda: directory)
    backend = _os_backend()
    monkeypatch.setattr(store.keyring, "get_keyring", lambda: backend)
    return directory, backend


@pytest.mark.parametrize("module, name", [
    ("keyring.backends.Windows", "WinVaultKeyring"),
    ("keyring.backends.macOS", "Keyring"),
    ("keyring.backends.SecretService", "Keyring"),
    ("keyring.backends.libsecret", "Keyring"),
    ("keyring.backends.kwallet", "DBusKeyring"),
    ("keyring.backends.kwallet", "DBusKeyringKWallet4"),
])
def test_probes_only_supported_os_keyrings(monkeypatch, module, name):
    backend = _os_backend(module, name)
    monkeypatch.setattr(store.keyring, "get_keyring", lambda: backend)
    assert store.storage_available() is True
    assert backend.writes == 1
    assert not backend.entries


def test_rejects_plaintext_null_fail_and_broken_backends(monkeypatch, tmp_path):
    plaintext = _os_backend("keyrings.alt.file", "PlaintextKeyring")
    monkeypatch.setenv("OPENAI_API_KEY", "mock-environment-credential")
    for backend in [plaintext, NullKeyring(), FailKeyring()]:
        monkeypatch.setattr(store.keyring, "get_keyring", lambda: backend)
        assert store.storage_available() is False
    assert plaintext.writes == 0

    broken = _os_backend()

    def blocked(*args):
        raise RuntimeError("keychain diagnostics with a sensitive value")

    broken.set_password = blocked
    monkeypatch.setattr(store.keyring, "get_keyring", lambda: broken)
    assert store.storage_available() is False

    async def edit():
        async with store.edit_state(tmp_path / "workspace.db"):
            pytest.fail("editing should not start without a protected key")

    with pytest.raises(store.SubscriptionStoreError) as caught:
        asyncio.run(edit())
    assert "sensitive value" not in str(caught.value)
    assert caught.value.__suppress_context__


def test_chainer_does_not_touch_plaintext_backend(monkeypatch):
    plaintext = _os_backend("keyrings.alt.file", "PlaintextKeyring")
    secure = _os_backend()
    monkeypatch.setattr(ChainerBackend, "backends", [plaintext, secure])
    monkeypatch.setattr(store.keyring, "get_keyring", ChainerBackend)
    assert store.storage_available()
    assert secure.writes == 1
    assert plaintext.writes == 0


def test_host_id_is_stable_before_authorization_without_keyring(local_vault, monkeypatch):
    directory, backend = local_vault
    monkeypatch.setattr(store.keyring, "get_keyring", lambda: NullKeyring())
    original = store.host_id()
    assert UUID(original).urn == original
    assert store.host_id() == original
    assert not backend.entries
    assert tuple(directory.iterdir()) == (directory / "installation.sqlite3",)
    monkeypatch.setattr(store, "_vault_dir", lambda: directory.with_name("other-installation"))
    assert store.host_id() != original


def test_scoped_roundtrip_ciphertext_and_large_token(tmp_path, local_vault):
    directory, backend = local_vault
    workspace = tmp_path / "exported-workspace" / "data.db"
    other = workspace.with_name("other.db")
    token = "mock-access-token!" * 1400
    workspace.parent.mkdir()
    workspace.write_bytes(b"ordinary workspace data, not a vault")
    alias = workspace.parent / "unused" / ".." / workspace.name
    assert store.read_state(workspace) == {"active_id": None, "accounts": {}}
    assert not directory.exists()

    async def populate():
        async with store.edit_state(alias) as state:
            state["active_id"] = "account-a"
            state["accounts"]["account-a"] = {"tokens": {"access_token": token}}
            assert await asyncio.to_thread(store.read_state, workspace) == {"active_id": None, "accounts": {}}

    asyncio.run(populate())
    state = store.read_state(workspace)
    assert state["active_id"] == "account-a"
    assert state["accounts"]["account-a"]["tokens"]["access_token"] == token
    state["accounts"].clear()
    assert store.read_state(workspace)["accounts"]
    assert store.read_state(other) == {"active_id": None, "accounts": {}}
    assert tuple(workspace.parent.iterdir()) == (workspace,)
    assert workspace.read_bytes() == b"ordinary workspace data, not a vault"
    assert len(backend.entries) == 1
    assert len(next(iter(backend.entries.values()))) == 44
    for path in directory.iterdir():
        assert b"mock-access-token" not in path.read_bytes()
        assert b"account-a" not in path.read_bytes()


def test_rollback_preserves_snapshot_and_hides_serialization_errors(tmp_path):
    workspace = tmp_path / "workspace.db"

    async def run():
        async with store.edit_state(workspace) as state:
            state["accounts"]["one"] = {"label": "initial"}
        with pytest.raises(LookupError, match="caller failure"):
            async with store.edit_state(workspace) as state:
                state["accounts"].clear()
                raise LookupError("caller failure")
        with pytest.raises(store.SubscriptionStoreError):
            async with store.edit_state(workspace) as state:
                state["accounts"]["one"] = {"invalid": object()}

    asyncio.run(run())
    assert store.read_state(workspace)["accounts"] == {"one": {"label": "initial"}}


def test_lost_key_does_not_replace_committed_data(tmp_path, local_vault):
    directory, backend = local_vault
    workspace = tmp_path / "workspace.db"

    async def populate():
        async with store.edit_state(workspace) as state:
            state["accounts"]["account"] = {"access_token": "mock-access"}

    asyncio.run(populate())
    stored = next(directory.iterdir()).read_bytes()
    backend.entries.clear()
    with pytest.raises(store.SubscriptionStoreError):
        store.read_state(workspace)
    with pytest.raises(store.SubscriptionStoreError):
        asyncio.run(populate())
    assert not backend.entries
    assert next(directory.iterdir()).read_bytes() == stored


def test_same_workspace_writers_see_latest_commit_and_cancelled_waiter_does_not_leak(tmp_path):
    workspace = tmp_path / "workspace.db"

    async def run():
        entered, release = asyncio.Event(), asyncio.Event()

        async def first():
            async with store.edit_state(workspace) as state:
                state["accounts"]["first"] = {}
                entered.set()
                await release.wait()

        async def following():
            async with store.edit_state(workspace) as state:
                assert "first" in state["accounts"]
                state["accounts"]["next"] = {}

        first_writer = asyncio.create_task(first())
        await asyncio.wait_for(entered.wait(), 5)
        cancelled_writer = asyncio.create_task(following())
        # Other vaults need not wait through a remote call for this workspace.
        async with asyncio.timeout(5):
            async with store.edit_state(workspace.with_name("other.db")):
                assert not cancelled_writer.done()
        cancelled_writer.cancel()
        with pytest.raises(asyncio.CancelledError):
            await cancelled_writer
        next_writer = asyncio.create_task(following())
        release.set()
        await asyncio.wait_for(asyncio.gather(first_writer, next_writer), 5)

    asyncio.run(run())
    assert store.read_state(workspace)["accounts"] == {"first": {}, "next": {}}


def test_waits_for_another_process_without_blocking_event_loop(tmp_path):
    workspace = tmp_path / "workspace.db"
    path = store._workspace_vault(workspace)
    path.parent.mkdir(parents=True)
    # A real separate interpreter reserves the same SQLite writer. The parent
    # must remain responsive while waiting so it can tell the child to release.
    code = "\n".join([
        "import sqlite3, sys",
        "db = sqlite3.connect(sys.argv[1])",
        "db.execute('BEGIN IMMEDIATE')",
        "print('acquired', flush=True)",
        "sys.stdin.readline()",
        "db.close()",
    ])

    async def run():
        child = await asyncio.create_subprocess_exec(
            sys.executable, "-c", code, str(path),
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
        )
        try:
            assert (await asyncio.wait_for(child.stdout.readline(), 5)).rstrip(b"\r\n") == b"acquired"
            entered = asyncio.Event()

            async def edit():
                async with store.edit_state(workspace):
                    entered.set()

            writer = asyncio.create_task(edit())
            with pytest.raises(TimeoutError):
                await asyncio.wait_for(entered.wait(), 0.2)
            child.stdin.write(b"release\n")
            await child.stdin.drain()
            await asyncio.wait_for(writer, 5)
            assert entered.is_set()
            assert await asyncio.wait_for(child.wait(), 5) == 0
        finally:
            if child.returncode is None:
                child.kill()
                await child.wait()

    asyncio.run(run())
