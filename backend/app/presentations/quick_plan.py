from __future__ import annotations

import unicodedata
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, model_validator

ShortText = Annotated[str, StringConstraints(strip_whitespace=True, min_length=1, max_length=200)]
Layout = Literal["cover", "points", "comparison", "process", "summary"]
ITEM_COUNTS = {"cover": (0, 0), "points": (2, 3), "comparison": (2, 2), "process": (2, 4), "summary": (1, 3)}


def line_width(char: str) -> float:
    if unicodedata.east_asian_width(char) in {"W", "F", "A"}:
        return 1
    return 0.8 if char.isupper() or char in "mw@" else 0.62


def wrap_text(text: str, width: int) -> list[str]:
    if any(not char.isprintable() for char in text):
        raise ValueError("不支持换行或控制字符")
    remaining = text
    lines = []
    while remaining:
        limit, used = 0, 0.0
        for char in remaining:
            used += line_width(char)
            if used > width:
                break
            limit += 1
        if limit < len(remaining) and remaining[limit - 1:limit].isascii() and remaining[limit:limit + 1].isascii():
            space = remaining.rfind(" ", 0, limit + 1)
            if space > 0:
                limit = space
        lines.append(remaining[:limit].rstrip())
        remaining = remaining[limit:].lstrip()
    return lines


class SlideItem(BaseModel):
    model_config = ConfigDict(extra="forbid")
    label: ShortText
    text: ShortText


class SlidePlan(BaseModel):
    model_config = ConfigDict(extra="forbid")
    layout: Layout
    title: ShortText
    takeaway: ShortText
    items: list[SlideItem] = Field(max_length=4)


class DeckPlan(BaseModel):
    model_config = ConfigDict(extra="forbid")
    title: ShortText
    slides: list[SlidePlan] = Field(min_length=3, max_length=10)

    @model_validator(mode="after")
    def check_capacity(self):
        if self.slides[0].layout != "cover" or self.slides[-1].layout != "summary":
            raise ValueError("第一页需要封面，最后一页需要总结")
        if len(wrap_text(self.title, 18)) > 2:
            raise ValueError("演示文稿名称过长")
        for number, slide in enumerate(self.slides, 1):
            try:
                if number != 1 and slide.layout == "cover":
                    raise ValueError("中间不能插入封面")
                minimum, maximum = ITEM_COUNTS[slide.layout]
                if not minimum <= len(slide.items) <= maximum:
                    raise ValueError(f"需要 {minimum}–{maximum} 个内容块")
                cover = slide.layout == "cover"
                if len(wrap_text(slide.title, 16 if cover else 22)) > (2 if cover else 1):
                    raise ValueError("标题过长")
                if len(wrap_text(slide.takeaway, 27 if cover else 39)) > (2 if cover else 1):
                    raise ValueError("要点过长")
                width = 20 if slide.layout == "comparison" else 10 if slide.layout == "process" else 34
                for item in slide.items:
                    if len(wrap_text(item.label, 9)) > 1 or len(wrap_text(item.text, width)) > 3:
                        raise ValueError("内容块文字过长")
            except ValueError as exc:
                raise ValueError(f"第 {number} 页：{exc}") from None
        return self
