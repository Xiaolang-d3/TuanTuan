from __future__ import annotations

import os

import pytest

from app.config import get_settings


@pytest.fixture(autouse=True)
def isolated_settings(monkeypatch):
    monkeypatch.delenv("ARTIFICIAL_ANALYSIS_API_KEY", raising=False)
    monkeypatch.delenv("TUANTUAN_BENCHMARK_ENV_FILE", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    monkeypatch.setenv("PYTHON_DOTENV_DISABLED", "1")
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def test_hosted_service_reads_only_benchmark_key_from_explicit_file(tmp_path, monkeypatch):
    path = tmp_path / "service.env"
    path.write_text("ARTIFICIAL_ANALYSIS_API_KEY=fixture-benchmark-key\nOPENAI_API_KEY=fixture-model-key\n", encoding="utf-8-sig")
    monkeypatch.setenv("TUANTUAN_BENCHMARK_ENV_FILE", str(path))
    settings = get_settings()
    assert settings.artificial_analysis_api_key == "fixture-benchmark-key"
    assert settings.openai_api_key is None
    assert "ARTIFICIAL_ANALYSIS_API_KEY" not in os.environ
    assert "OPENAI_API_KEY" not in os.environ
    assert "fixture-benchmark-key" not in repr(settings)
    assert "artificial_analysis_api_key" not in settings.model_dump()


def test_explicit_environment_key_has_priority_over_file(tmp_path, monkeypatch):
    path = tmp_path / "service.env"
    path.write_text("ARTIFICIAL_ANALYSIS_API_KEY=fixture-file-key\n")
    monkeypatch.setenv("TUANTUAN_BENCHMARK_ENV_FILE", str(path))
    monkeypatch.setenv("ARTIFICIAL_ANALYSIS_API_KEY", " fixture-environment-key ")
    assert get_settings().artificial_analysis_api_key == "fixture-environment-key"


@pytest.mark.parametrize("content", ["", "ARTIFICIAL_ANALYSIS_API_KEY=\n", "OPENAI_API_KEY=fixture-model-key\n"])
def test_missing_key_remains_unconfigured(tmp_path, monkeypatch, content):
    path = tmp_path / "service.env"
    path.write_text(content)
    monkeypatch.setenv("TUANTUAN_BENCHMARK_ENV_FILE", str(path))
    assert get_settings().artificial_analysis_api_key is None


def test_service_file_does_not_expand_other_credentials(tmp_path, monkeypatch):
    path = tmp_path / "service.env"
    path.write_text("ARTIFICIAL_ANALYSIS_API_KEY=${OTHER_SECRET}\n")
    monkeypatch.setenv("OTHER_SECRET", "fixture-private-value")
    monkeypatch.setenv("TUANTUAN_BENCHMARK_ENV_FILE", str(path))
    assert get_settings().artificial_analysis_api_key == "${OTHER_SECRET}"


def test_missing_explicit_file_remains_unconfigured(tmp_path, monkeypatch):
    monkeypatch.setenv("TUANTUAN_BENCHMARK_ENV_FILE", str(tmp_path / "missing.env"))
    assert get_settings().artificial_analysis_api_key is None
