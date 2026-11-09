"""Resolve only supported production mechanics without changing confirmed prose."""
from __future__ import annotations

import math
import re
from dataclasses import dataclass

from ..jobs.repository import JobConflict

_UNSUPPORTED_DATA_EDITING = re.compile(
    r"(?:原生\s*(?:chart|table|图表|表格|公式)|native\s+(?:chart|table)|"
    r"(?:chart|table|图表|表格)\s*(?:data|数据)\s*(?:editable|editing|可编辑|编辑)|"
    r"(?:editable|editing|可编辑|编辑)\s*(?:chart|table|图表|表格)\s*(?:data|数据)|"
    r"内嵌\s*(?:excel|工作簿))",
    re.IGNORECASE,
)


def _confirmed_prose(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from _confirmed_prose(item)
    elif isinstance(value, list):
        for item in value:
            yield from _confirmed_prose(item)


@dataclass(frozen=True)
class ProductionOptions:
    min_pages: int
    max_pages: int
    notes: bool
    provided_images: bool


def page_range(value, fallback: tuple[int, int]) -> tuple[int, int]:
    if isinstance(value, str) and not value.strip():
        return fallback
    if type(value) is int:
        value = str(value)
    match = re.fullmatch(r"\s*(\d{1,2})(?:\s*[-–—~～至]\s*(\d{1,2}))?\s*(?:页)?\s*", value) if isinstance(value, str) else None
    if match:
        lower, upper = int(match[1]), int(match[2] or match[1])
        if 1 <= lower <= upper <= 20:
            return lower, upper
    raise JobConflict("确认的页数需为 1–20 内的整数或范围（例如 5–8），请重新确认需求")


def resolve_production(contract, *, requested_pages: int) -> ProductionOptions:
    final = contract.final
    if any(_UNSUPPORTED_DATA_EDITING.search(value) for value in _confirmed_prose(final)):
        raise JobConflict("当前仅支持图表和表格的可编辑形状，不支持原生数据对象或内嵌工作簿")
    requirements = {
        "canvas": ("ppt169", "当前制作仅支持 16:9 画布"),
        "primary_language": ("zh-CN", "当前制作仅支持中文"),
        "generation_mode": ("continuous", "拆分制作尚未接通，请选择连续制作"),
        "refine_spec": (False, "设计规格额外审批尚未接通，不能跳过您要求的审批"),
        "proactive_custom_animations": (False, "自定义动画尚未支持，不能忽略已确认的动画要求"),
        "proactive_narration_audio": (False, "旁白音频尚未支持，不能忽略已确认的音频要求"),
    }
    for key, (expected, message) in requirements.items():
        if type(final.get(key)) is not type(expected) or final[key] != expected:
            raise JobConflict(message)
    if contract.selection.get("mode") != "free_design":
        raise JobConflict("模板安装尚未验收，不能替换成自由设计")
    if type(final.get("proactive_speaker_notes")) is not bool:
        raise JobConflict("讲稿开关无效，请重新确认")
    if final.get("image_usage") not in (["none"], ["provided"]):
        raise JobConflict("当前制作仅支持用户图片或无图")
    typography = final.get("typography")
    if not isinstance(typography, dict) or not isinstance(typography.get("sizes"), dict):
        raise JobConflict("确认合同缺少字号层级")
    sizes = {"body": typography.get("body_size"), **typography["sizes"]}
    if (not {"body", "title", "subtitle", "annotation"} <= sizes.keys()
            or any(type(v) not in (int, float) or not math.isfinite(v) or not 0 < v <= 300 for v in sizes.values())):
        raise JobConflict("确认字号必须为有效正数")
    first_range = page_range(contract.stage1.get("page_count", ""), (1, 20))
    # A cleared final field leaves no explicit constraint; use the request only
    # inside the Stage-1 boundary, never restore the model recommendation.
    fallback = (min(max(requested_pages, first_range[0]), first_range[1]),) * 2
    lower, upper = page_range(final.get("page_count", ""), fallback)
    if lower < first_range[0] or upper > first_range[1]:
        raise JobConflict("最终页数超出 Stage 1 确认范围，需重新确认需求")
    return ProductionOptions(lower, upper, final["proactive_speaker_notes"], final["image_usage"] == ["provided"])
