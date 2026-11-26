from __future__ import annotations

import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.agent.operations import get_agent_operations_snapshot
from app.db import connect, init_db


class AgentOperationsSnapshotTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.db_path = Path(self.temp_dir.name) / "agent-operations.db"
        init_db(self.db_path)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_snapshot_aggregates_runs_and_deduplicates_tool_events(self) -> None:
        payload = {
            "agent": {
                "provider": "openai",
                "platform": "manual",
                "rounds": 2,
                "status": "done",
                "stop_reason": "completed",
                "plan": {"route": "company_research", "goal": "核验公司"},
                "events": [
                    {"tool_call_id": "call-1", "tool_name": "search_public_web", "status": "running"},
                    {"tool_call_id": "call-1", "tool_name": "search_public_web", "status": "done"},
                    {"tool_call_id": "thinking", "tool_name": "agent_thinking", "status": "done"},
                ],
            }
        }
        with connect(self.db_path) as conn:
            conversation_id = conn.execute(
                "INSERT INTO conversations (title) VALUES ('公司研究')"
            ).lastrowid
            conn.execute(
                """INSERT INTO chat_messages
                   (conversation_id, role, content, payload_json)
                   VALUES (?, 'assistant', '完成', ?)""",
                (conversation_id, json.dumps(payload)),
            )
            conn.execute(
                """INSERT INTO model_service_events
                   (request_kind, status, latency_ms, total_tokens, model_name)
                   VALUES ('chat', 'success', 1200, 345, 'test-model')"""
            )

        snapshot = get_agent_operations_snapshot(db_path=self.db_path)

        self.assertEqual(snapshot["summary"]["total_runs"], 1)
        self.assertEqual(snapshot["summary"]["successful_runs"], 1)
        self.assertEqual(snapshot["summary"]["total_tool_calls"], 1)
        self.assertEqual(snapshot["summary"]["total_tokens"], 345)
        self.assertEqual(snapshot["tool_breakdown"][0]["count"], 1)
        self.assertEqual(snapshot["recent_runs"][0]["route"], "company_research")
        self.assertEqual(snapshot["recent_runs"][0]["stop_reason"], "completed")

    def test_snapshot_filters_before_pagination_without_changing_aggregates(self) -> None:
        with connect(self.db_path) as conn:
            # Legacy stores can contain orphan messages; bypass the current FK for this fixture.
            conn.execute("PRAGMA foreign_keys = OFF")
            conversation_id = conn.execute("INSERT INTO conversations (title) VALUES ('统计测试')").lastrowid

            def add_run(created_at: str, status: str, *, orphan: bool = False) -> int:
                return conn.execute(
                    """INSERT INTO chat_messages (conversation_id, role, content, payload_json, created_at)
                       VALUES (?, 'assistant', '', ?, ?)""",
                    (99999 if orphan else conversation_id, json.dumps({"agent": {"status": status}}), created_at),
                ).lastrowid

            # Out-of-order insertion and equal timestamps exercise both sort keys.
            first = add_run("2026-11-26 12:30:00", "failed", orphan=True)
            second = add_run("2026-11-26 12:30:00", "unexpected")
            newer = add_run("2026-11-26 12:31:00", "failed")
            add_run("2026-11-26 14:00:00", "done")
            add_run("2026-11-25 13:00:00", "failed")
            add_run("2026-11-20 00:00:00", "waiting_user")
            add_run("2026-11-19 23:59:59", "done")
            add_run("2026-11-27 00:00:00", "done")
            conn.executemany(
                """INSERT INTO model_service_events (request_kind, status, total_tokens, created_at)
                   VALUES ('chat', 'success', ?, ?)""",
                [(1000, "2026-11-19 23:59:59"), (30, "2026-11-20 00:00:00"), (1000, "2026-11-27 00:00:00")],
            )

        with patch("app.agent.operations.datetime") as clock:
            clock.now.return_value = datetime(2026, 11, 26, 16, tzinfo=timezone.utc)
            # The existing three positional arguments still work.
            snapshot = get_agent_operations_snapshot(7, 20, self.db_path)
            pages = [
                get_agent_operations_snapshot(
                    7, 1, self.db_path, run_status="failed", run_date="2026-11-26", offset=offset
                )
                for offset in range(4)
            ]
            status_only = get_agent_operations_snapshot(db_path=self.db_path, run_status="failed")
            date_only = get_agent_operations_snapshot(db_path=self.db_path, run_date="2026-11-26")
            outside = get_agent_operations_snapshot(db_path=self.db_path, run_date="2026-11-19")

        clock.now.assert_called_with(timezone.utc)
        self.assertEqual(snapshot["matching_runs"], 6)
        self.assertEqual(snapshot["summary"]["total_runs"], 6)
        self.assertEqual(snapshot["summary"]["model_requests"], 1)
        self.assertEqual(snapshot["summary"]["total_tokens"], 30)
        self.assertEqual(snapshot["freshness_at"], "2026-11-26 14:00:00")
        self.assertEqual([row["total"] for row in snapshot["trend"]], [1, 0, 0, 0, 0, 1, 4])
        self.assertEqual(snapshot["trend"][0]["date"], "2026-11-20")
        self.assertEqual(snapshot["trend"][-1]["failed"], 3)
        self.assertEqual(status_only["matching_runs"], 4)
        self.assertEqual(date_only["matching_runs"], 4)
        self.assertEqual(outside["matching_runs"], 0)
        self.assertEqual(outside["recent_runs"], [])
        for page in pages:
            self.assertEqual(page["matching_runs"], 3)
            for key in snapshot.keys() - {"matching_runs", "recent_runs"}:
                self.assertEqual(page[key], snapshot[key], key)
        self.assertEqual(pages[3]["recent_runs"], [])
        runs = [page["recent_runs"][0] for page in pages[:3]]
        self.assertEqual([run["message_id"] for run in runs], [newer, second, first])
        self.assertIs(runs[0]["conversation_available"], True)
        self.assertIs(runs[-1]["conversation_available"], False)
        self.assertEqual(runs[-1]["conversation_title"], "已删除对话")

    def test_operations_endpoint_accepts_query_and_rejects_invalid_filters(self) -> None:
        from app.api.model import router

        app = FastAPI()
        app.include_router(router)
        with TestClient(app) as client, patch(
            "app.agent.operations.connect", side_effect=lambda _: connect(self.db_path)
        ):
            response = client.get(
                "/agent/operations",
                params={"days": 30, "limit": 2, "offset": 1, "run_status": "done", "run_date": "2024-02-29"},
            )
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()["window_days"], 30)
            self.assertEqual(response.json()["matching_runs"], 0)
            for params in (
                {"days": 14},
                {"offset": -1},
                {"offset": "not-an-int"},
                {"run_status": "unknown"},
                {"run_date": "2026-02-29"},
                {"run_date": "20261126"},
                {"run_date": "2026-11-26T00:00:00Z"},
            ):
                with self.subTest(params=params):
                    self.assertEqual(client.get("/agent/operations", params=params).status_code, 422)

    def test_snapshot_rejects_unsupported_window(self) -> None:
        with self.assertRaisesRegex(ValueError, "仅支持"):
            get_agent_operations_snapshot(days=14, db_path=self.db_path)


if __name__ == "__main__":
    unittest.main()
