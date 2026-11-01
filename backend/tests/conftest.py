import os
import tempfile

# Never load a developer's .env or inherit product-specific credentials/options.
os.environ["PYTHON_DOTENV_DISABLED"] = "1"
for _name in list(os.environ):
    if _name.startswith(("TUANTUAN_", "CAREERLOOP_", "DENGDENG_")):
        os.environ.pop(_name, None)

_test_data_dir = tempfile.TemporaryDirectory(prefix="tuantuan-tests-")
os.environ["TUANTUAN_DATA_DIR"] = _test_data_dir.name

# Tests never read real credentials or the host operating-system keychain.
# Dedicated backend tests override these values and mock every keyring call.
os.environ["TUANTUAN_SECRET_BACKEND"] = "memory"
os.environ["OPENAI_API_KEY"] = ""
os.environ["MODEL_BASE_URL"] = ""
# A developer's .env must not seed a model that a clean CI workspace lacks.
os.environ["MODEL_NAME"] = ""
os.environ["MODEL_PROTOCOL"] = "auto"
# Attachment tests use isolated local directories or a mocked object store.
os.environ["ATTACHMENT_STORAGE"] = "local"
# The pre-LiteLLM suites patch the native adapters (OpenAI SDK / httpx); they
# pin the rollback backend explicitly. LiteLLM suites opt in per test with
# monkeypatch.setenv("TUANTUAN_MODEL_BACKEND", "litellm") and a loopback server.
os.environ["TUANTUAN_MODEL_BACKEND"] = "native"
# Loopback fake model servers must never be routed through a developer proxy.
os.environ["NO_PROXY"] = os.environ["no_proxy"] = ",".join(
    filter(None, ["127.0.0.1", "localhost", os.environ.get("NO_PROXY", "")])
)

# Keep unit tests offline and deterministic. Production default remains auto/fastembed.
os.environ.setdefault("EMBEDDING_BACKEND", "hash")


import pytest


@pytest.fixture(autouse=True)
def fake_secret_store(monkeypatch):
    # unittest setUp/tearDown also changes this variable; restore it per test.
    monkeypatch.setenv("TUANTUAN_SECRET_BACKEND", "memory")
