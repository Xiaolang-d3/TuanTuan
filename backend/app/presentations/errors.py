"""Allowlisted, actionable failures from presentation output validation."""
from __future__ import annotations


OUTPUT_FAILURES = {
    "quick_plan_invalid": "模型生成的内容不符合版式要求。请补充主题或精简资料后重新发送。",
    "presentation_needs_details": "演示内容还不明确。请补充具体的分享主题、核心概念和要点，再编辑要求后重新制作。",
    "presentation_plan_invalid": "模型没有返回完整的设计规格和页面方案，已停止制作。请明确演示主题与核心内容，再编辑要求后重做。",
    "presentation_page_count_mismatch": "模型返回的页面数量不符合已确认的页数要求，已停止制作。请补充具体主题与内容，再编辑要求后重做。",
}


class PresentationOutputError(ValueError):
    def __init__(self, code: str):
        self.code = code if code in OUTPUT_FAILURES else "presentation_plan_invalid"
        super().__init__(OUTPUT_FAILURES[self.code])
