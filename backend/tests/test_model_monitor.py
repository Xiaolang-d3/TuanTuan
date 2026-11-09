from __future__ import annotations

import tempfile
import unittest
import os
from pathlib import Path
from unittest.mock import patch

from app.agent.settings import get_agent_settings, save_agent_settings
from app.db import init_db
from app.config import Settings
from app.observability.model_monitor import (
    get_model_monitor_snapshot,
    record_model_service_event,
)


class ModelMonitorTest(unittest.TestCase):
    def setUp(self) -> None:
        secret_environment = patch.dict(os.environ, {"TUANTUAN_SECRET_BACKEND": "memory"})
        secret_environment.start()
        self.addCleanup(secret_environment.stop)
        config_patch = patch("app.agent.settings.get_settings", return_value=Settings(openai_api_key=None))
        config_patch.start()
        self.addCleanup(config_patch.stop)
        self._temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self._temp_dir.name) / "test.db"
        init_db(self.db_path)
        settings = get_agent_settings(self.db_path)
        settings.update(
            {
                "model_name": "monitor-test-model",
                "model_base_url": "https://models.example.test",
                "api_key": "monitor-test-key",
            }
        )
        save_agent_settings(settings, self.db_path)

    def tearDown(self) -> None:
        self._temp_dir.cleanup()

    def record(
        self,
        status: str,
        *,
        error_code: str = "",
        latency_ms: int = 100,
        response_id: str = "",
        total_tokens: int = 0,
    ) -> None:
        record_model_service_event(
            request_kind="stream",
            status=status,
            error_code=error_code,
            error_message="safe operational detail",
            latency_ms=latency_ms,
            total_tokens=total_tokens,
            model_name="monitor-test-model",
            base_url="https://models.example.test",
            response_id=response_id,
            db_path=self.db_path,
        )

    def test_empty_monitor_is_unknown(self) -> None:
        snapshot = get_model_monitor_snapshot(db_path=self.db_path)

        self.assertEqual(snapshot["status"], "unknown")
        self.assertEqual(snapshot["summary"]["total_requests"], 0)
        self.assertIsNone(snapshot["summary"]["success_rate"])
        self.assertEqual(snapshot["usage"]["total_tokens"], 0)
        self.assertIsNone(snapshot["usage"]["remaining_quota"])
        self.assertFalse(snapshot["usage"]["quota_available"])

    def test_snapshot_aggregates_latency_and_error_types(self) -> None:
        self.record("success", latency_ms=120, total_tokens=80)
        self.record("success", latency_ms=280, total_tokens=120)
        self.record("error", error_code="request_timeout", latency_ms=60000)

        snapshot = get_model_monitor_snapshot(db_path=self.db_path)

        self.assertEqual(snapshot["status"], "degraded")
        self.assertEqual(snapshot["summary"]["total_requests"], 3)
        self.assertEqual(snapshot["summary"]["successful_requests"], 2)
        self.assertEqual(snapshot["summary"]["success_rate"], 66.7)
        self.assertEqual(snapshot["summary"]["average_latency_ms"], 200)
        self.assertEqual(snapshot["summary"]["p95_latency_ms"], 280)
        self.assertEqual(snapshot["summary"]["timeout_count"], 1)
        self.assertEqual(snapshot["error_breakdown"][0]["label"], "响应超时")
        self.assertEqual(snapshot["usage"]["total_tokens"], 200)
        self.assertIsNone(snapshot["usage"]["remaining_quota"])

    def test_response_id_is_persisted_for_traceability(self) -> None:
        self.record("success", response_id="chatcmpl-abc123")

        from app.db import connect

        with connect(self.db_path) as conn:
            row = conn.execute(
                "SELECT response_id FROM model_service_events ORDER BY id DESC LIMIT 1"
            ).fetchone()

        self.assertEqual(row["response_id"], "chatcmpl-abc123")

    def test_two_latest_failures_mark_service_unavailable(self) -> None:
        self.record("success")
        self.record("error", error_code="rate_limited")
        self.record("error", error_code="request_timeout")

        snapshot = get_model_monitor_snapshot(db_path=self.db_path)

        self.assertEqual(snapshot["status"], "unavailable")
        self.assertEqual(snapshot["summary"]["consecutive_failures"], 2)
        self.assertIn("连续 2 次", snapshot["status_message"])

    def test_snapshot_keeps_protocol_histories_separate(self) -> None:
        self.record("success")
        record_model_service_event(
            request_kind="stream",
            status="error",
            latency_ms=100,
            model_name="monitor-test-model",
            base_url="https://models.example.test",
            protocol="anthropic",
            db_path=self.db_path,
        )

        snapshot = get_model_monitor_snapshot(db_path=self.db_path)

        self.assertEqual(snapshot["protocol"], "openai")
        self.assertEqual(snapshot["summary"]["total_requests"], 1)

    def test_auto_mode_includes_native_and_successful_fallback_attempts(self) -> None:
        settings = get_agent_settings(self.db_path)
        settings.update(
            {
                "model_name": "claude-sonnet-5",
                "model_base_url": "https://gateway.example.test",
                "model_protocol": "auto",
                "api_key": "monitor-test-key",
            }
        )
        save_agent_settings(settings, self.db_path)
        record_model_service_event(
            request_kind="stream",
            status="error",
            error_code="route_not_found",
            latency_ms=30,
            model_name="claude-sonnet-5",
            base_url="https://gateway.example.test",
            protocol="anthropic",
            db_path=self.db_path,
        )
        record_model_service_event(
            request_kind="stream",
            status="success",
            latency_ms=90,
            model_name="claude-sonnet-5",
            base_url="https://gateway.example.test/v1",
            protocol="openai",
            db_path=self.db_path,
        )

        snapshot = get_model_monitor_snapshot(db_path=self.db_path)

        self.assertEqual(snapshot["summary"]["total_requests"], 2)
        self.assertEqual(snapshot["protocol"], "openai")
        self.assertEqual(snapshot["base_url"], "https://gateway.example.test/v1")

    def test_gemini_root_matches_provider_normalized_success_records(self) -> None:
        settings = get_agent_settings(self.db_path)
        settings.update({
            "model_name": "gemini-test", "model_base_url": "https://generativelanguage.googleapis.com",
            "model_protocol": "gemini", "api_key": "gemini-test-key",
        })
        save_agent_settings(settings, self.db_path)
        record_model_service_event(
            request_kind="health_check", status="success", latency_ms=50, total_tokens=9,
            model_name="gemini-test", base_url="https://generativelanguage.googleapis.com/v1beta",
            protocol="gemini", db_path=self.db_path,
        )
        snapshot = get_model_monitor_snapshot(db_path=self.db_path)
        self.assertEqual(snapshot["status"], "healthy")
        self.assertEqual(snapshot["summary"]["total_requests"], 1)
        self.assertEqual(snapshot["usage"]["total_tokens"], 9)

    def test_official_default_keeps_legacy_empty_base_url_records(self) -> None:
        settings = get_agent_settings(self.db_path)
        settings.update({
            "model_name": "gpt-test", "model_base_url": "", "model_protocol": "openai",
            "api_key": "official-test-key",
        })
        save_agent_settings(settings, self.db_path)
        record_model_service_event(
            request_kind="stream", status="success", latency_ms=50, total_tokens=8,
            model_name="gpt-test", base_url="", protocol="openai", db_path=self.db_path,
        )
        snapshot = get_model_monitor_snapshot(db_path=self.db_path)
        self.assertEqual(snapshot["summary"]["total_requests"], 1)
        self.assertEqual(snapshot["usage"]["total_tokens"], 8)


if __name__ == "__main__":
    unittest.main()
