from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))

from app.agent.eval_harness import run_eval_case  # noqa: E402


def call_api(prompt: str, options: dict[str, Any], context: dict[str, Any]) -> dict[str, Any]:
    vars_ = dict((context or {}).get("vars") or {})
    if prompt and not vars_.get("query") and not vars_.get("content"):
        vars_["query"] = prompt
    result = run_eval_case({"vars": vars_})
    return {
        "output": json.dumps(result, ensure_ascii=False),
        "tokenUsage": {"total": 0, "prompt": 0, "completion": 0},
    }
