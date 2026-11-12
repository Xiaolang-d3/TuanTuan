"""DSH 审批与用户提问 → 团团澄清交互的桥接。"""

from __future__ import annotations

from typing import Any

from ....domain import AgentClarification, ClarificationOption
from .client import Notification

APPROVE_LABEL = "允许本次操作"
REJECT_LABEL = "拒绝本次操作"
CANCEL_LABEL = "取消并停止"


def approval_clarification(request: Notification) -> AgentClarification:
    tool_name = str(request.params.get("toolName") or "工具")
    reason = str(request.params.get("reason") or "").strip()
    question = f"是否允许执行 {tool_name}？"
    if reason:
        question += f"\n说明：{reason}"
    return AgentClarification(
        question=question,
        options=[
            ClarificationOption(id="approve", label=APPROVE_LABEL, send=APPROVE_LABEL),
            ClarificationOption(id="reject", label=REJECT_LABEL, send=REJECT_LABEL),
        ],
        allow_custom=False,
    )


def decision_from_reply(reply_text: str) -> dict[str, str]:
    normalized = " ".join((reply_text or "").split())
    if normalized == APPROVE_LABEL:
        return {"outcome": "allowed-once"}
    if normalized == REJECT_LABEL:
        return {"outcome": "rejected"}
    if normalized == CANCEL_LABEL:
        return {"outcome": "cancelled"}
    return {"outcome": "rejected"}


def question_clarification(request: Notification) -> AgentClarification:
    questions = request.params.get("questions") or []
    first = questions[0] if isinstance(questions, list) and questions else {}
    text = str(first.get("question") or first.get("title") or "需要你的确认")
    options = []
    for option in first.get("options") or []:
        label = str(option.get("label") or option or "")
        if label:
            options.append(ClarificationOption(id=label, label=label, send=label))
    return AgentClarification(
        question=text,
        options=options,
        allow_custom=True,
    )


def answers_from_reply(request: Notification, reply_text: str) -> dict[str, Any]:
    questions = request.params.get("questions") or []
    reply = " ".join((reply_text or "").split())
    answers = []
    for question in questions:
        if not isinstance(question, dict):
            continue
        options = [str(option.get("label") or "") for option in question.get("options") or [] if isinstance(option, dict)]
        selected = [reply] if reply and reply in options else []
        answers.append({"id": question.get("id"), "selected": selected, "custom": "" if selected else reply})
    return {"answers": answers}
