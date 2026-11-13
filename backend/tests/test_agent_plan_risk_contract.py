from __future__ import annotations

import json
import re
from pathlib import Path

from app.domain import AgentPlanStep


FRONTEND_CONTRACT = (
    Path(__file__).resolve().parents[2]
    / "frontend"
    / "src"
    / "features"
    / "chat"
    / "agent-plan-risk.generated.ts"
)


def test_frontend_risk_contract_matches_backend_json_schema() -> None:
    assert FRONTEND_CONTRACT.is_file(), "Run python backend/scripts/generate_agent_plan_risk.py to generate the frontend contract"
    source = FRONTEND_CONTRACT.read_text(encoding="utf-8")
    match = re.search(r"export const AGENT_PLAN_RISK_VALUES = (\[.*?\]) as const;", source, re.DOTALL)
    assert match is not None, "Generated frontend plan risk contract is invalid"
    frontend_risks = json.loads(match.group(1))
    backend_risks = AgentPlanStep.model_json_schema()["properties"]["risk"]["enum"]
    assert frontend_risks == backend_risks, "Run python backend/scripts/generate_agent_plan_risk.py to update the frontend contract"


def _plan_with_current_and_legacy_risks():
    from app.domain import AgentPlan

    risks = [
        "read_only", "derived_analysis", "local_pending_write", "confirmed_local_write",
        "external_read", "analysis", "local_write", "user_input",
    ]
    return AgentPlan(
        goal="Contract test",
        route="test",
        steps=[
            AgentPlanStep(id=f"step-{index}", title="Step", tool_name="tool", risk=risk)
            for index, risk in enumerate(risks)
        ],
    )


def test_plan_risks_survive_custom_sse_events_and_terminal_snapshots() -> None:
    import asyncio

    from ag_ui.core import RunAgentInput
    from app.chat.ag_ui import event_stream
    from app.domain import AgentRunResult, ToolEvent

    plan = _plan_with_current_and_legacy_risks()
    expected = [step.risk for step in plan.steps]
    planner_event = ToolEvent(
        round=1, tool_call_id="plan", tool_name="agent_planner", status="done", message="Planned",
        data={"plan": plan.model_dump(mode="json")},
    )
    result = AgentRunResult(content="Done", provider="test", platform="test", rounds=1, plan=plan)

    async def encode_events():
        queue = asyncio.Queue()
        queue.put_nowait(("agent_event", {"event": planner_event.model_dump(mode="json")}))
        queue.put_nowait(("completed", {
            "user_message": {"id": 1},
            "assistant_message": {"id": 2, "payload": {"agent": result.model_dump(mode="json")}},
        }))
        queue.put_nowait(None)
        worker = asyncio.create_task(asyncio.sleep(0))
        request = RunAgentInput(thread_id="thread", run_id="run", state={}, messages=[], tools=[], context=[], forwarded_props={})
        return [chunk async for chunk in event_stream(queue, worker, request, "text/event-stream")]

    chunks = asyncio.run(encode_events())
    events = [json.loads(line[6:]) for chunk in chunks for line in chunk.splitlines() if line.startswith("data: ")]
    custom = next(event for event in events if event.get("name") == "tuantuan.agent_event")
    snapshot = next(event for event in events if event.get("type") == "STATE_SNAPSHOT")
    custom_steps = custom["value"]["data"]["plan"]["steps"]
    snapshot_steps = snapshot["snapshot"]["tuantuan"]["assistantMessage"]["payload"]["agent"]["plan"]["steps"]
    assert [step["risk"] for step in custom_steps] == expected
    assert [step["risk"] for step in snapshot_steps] == expected


def test_plan_risks_survive_persisted_checkpoints_and_results(tmp_path: Path) -> None:
    from app.agent.run_store import AgentRunStore
    from app.db import init_db
    from app.domain import AgentRunResult, AgentRunSnapshot

    plan = _plan_with_current_and_legacy_risks()
    expected = [step.risk for step in plan.steps]
    db_path = tmp_path / "agent-risk-contract.db"
    init_db(db_path)
    store = AgentRunStore(db_path)
    store.start_run("risk-contract", conversation_id=None, task_id=None, user_content="test")
    store.checkpoint("risk-contract", AgentRunSnapshot(route_kind="test", needs_plan=True, plan=plan))
    checkpoint = store.load_checkpoint("risk-contract")
    assert checkpoint is not None and checkpoint.plan is not None
    assert [step.risk for step in checkpoint.plan.steps] == expected

    store.finish("risk-contract", AgentRunResult(content="Done", provider="test", platform="test", rounds=1, plan=plan))
    result = store.load_result("risk-contract")
    assert result is not None and result.plan is not None
    assert [step.risk for step in result.plan.steps] == expected
