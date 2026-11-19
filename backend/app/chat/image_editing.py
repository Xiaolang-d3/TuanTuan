"""Explicit, versioned image edits scoped to the authenticated workspace."""
from __future__ import annotations

import base64
import hashlib
import json
from io import BytesIO
from typing import Literal
from uuid import UUID

from openai import APIStatusError
from PIL import Image, ImageDraw, ImageOps
from pydantic import BaseModel, Field, model_validator

from ..db import connect, json_dump
from ..domain import ModelResponse
from ..domain.agent import ModelImageOutput
from ..models import ModelProviderError
from .image_assets import asset_file, asset_metadata, persist_images


class Point(BaseModel):
    x: float = Field(ge=0, le=1, allow_inf_nan=False)
    y: float = Field(ge=0, le=1, allow_inf_nan=False)


class Stroke(BaseModel):
    points: list[Point] = Field(min_length=1, max_length=2000)
    width: float = Field(ge=.001, le=.25, allow_inf_nan=False)


class Comment(Point):
    text: str = Field(min_length=1, max_length=500)


class ImageEditIn(BaseModel):
    operation_id: UUID
    mode: Literal["edit", "erase", "background", "resize"]
    prompt: str = Field(default="", max_length=4000)
    strokes: list[Stroke] = Field(default_factory=list, max_length=100)
    comments: list[Comment] = Field(default_factory=list, max_length=20)
    width: int = Field(default=1024, ge=16, le=8192)
    height: int = Field(default=1024, ge=16, le=8192)
    rotation: Literal[0, 90, 180, 270] = 0
    flip: bool = False

    @model_validator(mode="after")
    def validate_edit(self):
        if self.width * self.height > 40_000_000:
            raise ValueError("图片不能超过 4000 万像素")
        if sum(len(stroke.points) for stroke in self.strokes) > 20000:
            raise ValueError("选区过于复杂，请减少笔画")
        if self.mode == "erase" and not self.strokes:
            raise ValueError("请先涂抹需要擦除的区域")
        if self.mode == "edit" and not self.prompt.strip() and not self.comments:
            raise ValueError("请填写修改要求或添加位置评论")
        return self


def png_bytes(image: Image.Image) -> bytes:
    out = BytesIO()
    image.save(out, "PNG")
    return out.getvalue()


def selection_mask(size: tuple[int, int], strokes: list[Stroke]) -> bytes | None:
    if not strokes:
        return None
    width, height = size
    mask = Image.new("RGBA", size, (255, 255, 255, 255))
    draw = ImageDraw.Draw(mask)
    for stroke in strokes:
        radius = max(1, round(stroke.width * width / 2))
        points = [(round(p.x * (width - 1)), round(p.y * (height - 1))) for p in stroke.points]
        draw.line(points, fill=(255, 255, 255, 0), width=radius * 2)
        for x, y in points:
            draw.ellipse((x-radius, y-radius, x+radius, y+radius), fill=(255, 255, 255, 0))
    return png_bytes(mask)


def _image_connection():
    from ..agent.model_purposes import resolve_purpose_connection
    return resolve_purpose_connection("image", action="image_edit")


def _publish(operation_id: str, source: dict, result: dict, label: str) -> dict:
    # The asset link is the idempotency receipt, including recovery after save.
    with connect() as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute("SELECT message_id FROM chat_image_assets WHERE operation_id=? LIMIT 1", (operation_id,)).fetchone()
        message_id = row["message_id"] if row else None
        if not message_id:
            agent = {**result, "provider": "images", "platform": "local", "rounds": 1,
                     "status": "done", "events": [], "source_asset_id": source["id"]}
            # Keep a normal user/assistant turn so conversation grouping stays intact.
            conn.execute("INSERT INTO chat_messages(role,content,payload_json,conversation_id) VALUES ('user',?,'{}',?)",
                         (label, source["conversation_id"]))
            cursor = conn.execute("INSERT INTO chat_messages(role,content,payload_json,conversation_id) VALUES ('assistant',?,?,?)",
                                  (result.get("content", ""), json_dump({"agent": agent}), source["conversation_id"]))
            message_id = cursor.lastrowid
            conn.execute("UPDATE chat_image_assets SET message_id=? WHERE operation_id=?", (message_id, operation_id))
            conn.execute("UPDATE conversations SET updated_at=CURRENT_TIMESTAMP WHERE id=?", (source["conversation_id"],))
        conn.execute("UPDATE image_studio_tasks SET status='done',error='' WHERE id=? AND source_asset_id=?",
                     (operation_id, source['id']))
    return {**result, "message_id": message_id, "conversation_id": source["conversation_id"]}


async def edit_generated_image(asset_id: str, request: ImageEditIn) -> dict:
    source = asset_metadata(asset_id)
    path, _, _ = asset_file(asset_id)
    operation_id = str(request.operation_id)
    # Bind the operation to the source and *all* edit parameters, not just a model.
    digest = hashlib.sha256(json_dump({"asset_id": asset_id, **request.model_dump(mode="json")}).encode()).hexdigest()
    with connect() as conn:
        existing = conn.execute("SELECT * FROM chat_image_operations WHERE id=?", (operation_id,)).fetchone()
        studio = conn.execute("""SELECT 1 FROM chat_image_assets a JOIN image_studio_tasks t
                                 ON t.id=a.operation_id WHERE a.id=?""", (asset_id,)).fetchone()
    if existing:
        saved = json.loads(existing["selection_json"])
        if existing["conversation_id"] != source["conversation_id"] or saved.get("edit_digest") != digest:
            raise ModelProviderError("image_operation_conflict", "编辑任务与原请求不匹配")
        if existing["status"] == "done":
            return _publish(operation_id, source, json.loads(existing["result_json"]), json.loads(existing["result_json"]).get("image_generation_prompt", "图片编辑"))
        with connect() as conn:
            receipt = conn.execute('SELECT status,error FROM image_studio_tasks WHERE id=?', (operation_id,)).fetchone()
        if receipt and receipt['status'] == 'failed':
            raise ModelProviderError('image_edit_failed', receipt['error'] or '图片编辑未完成，未重复请求')
        raise ModelProviderError("image_generation_uncertain", "上次图片编辑结果尚未确认，不会自动重复请求；请刷新对话检查结果")
    labels = {"edit": "按要求修改图片", "erase": "擦除选中区域，并自然补全画面", "background": "移除背景，保留主体及细节，输出透明背景 PNG", "resize": "调整图片尺寸"}
    label = labels[request.mode] + ("：" + request.prompt.strip() if request.prompt.strip() else "")
    prompt = label
    if request.mode in {"edit", "erase"}:
        prompt += "。标注圈线、笔迹、箭头及评论编号仅用于定位，不绘制这些辅助标记，也不要为主体添加描边。"
    if request.mode == "edit" and request.strokes:
        # Annotation gestures describe a subject/region, not pixels to repaint.
        # Do not send the stroke bitmap as a mask: some gateways treat it as
        # another reference image and reproduce its lines in the output.
        for index, stroke in enumerate(request.strokes, 1):
            left = min(point.x for point in stroke.points)
            right = max(point.x for point in stroke.points)
            top = min(point.y for point in stroke.points)
            bottom = max(point.y for point in stroke.points)
            prompt += f"\n位置标注 {index}：目标在画面横向 {left:.1%}–{right:.1%}、纵向 {top:.1%}–{bottom:.1%} 的区域。圈选指向该区域内的主体；按用户要求修改主体或构图，不是沿圈线绘画。"
    if request.mode == "erase":
        prompt += "。蒙版仅指示擦除位置，补全该位置的自然内容，保持其他部分不变。"
    for index, comment in enumerate(request.comments, 1):
        prompt += f"\n位置评论 {index}（从左到右 {comment.x:.1%}，从上到下 {comment.y:.1%}）：{comment.text}"
    if request.comments:
        label += "\n" + "\n".join(f"位置 {index}：{comment.text}" for index, comment in enumerate(request.comments, 1))
    connection = None if request.mode == "resize" else _image_connection()
    selection = {key: connection[key] for key in ("profile_id", "profile_revision", "connection_id", "connection_revision", "model_name", "model_protocol")} if connection else {}
    size = None
    if studio and connection:
        from .studio_generate import supported_sizes
        original_size = f'{source.get("width")}x{source.get("height")}'
        if original_size in supported_sizes(connection['model_name'], connection['model_protocol'], connection['model_base_url']):
            size = original_size
    if studio:
        from .studio_generate import release_edit, try_reserve_edit
        if not try_reserve_edit(operation_id, source['conversation_id']):
            raise ModelProviderError('image_operation_conflict', '已有图片任务在进行，请等待当前任务结束')
    submitted = recorded = False
    try:
        with connect() as conn:
            conn.execute('BEGIN IMMEDIATE')
            if conn.execute('SELECT 1 FROM chat_image_operations WHERE id=?', (operation_id,)).fetchone():
                raise ModelProviderError('image_generation_uncertain', '编辑任务已提交，请勿重复请求')
            if conn.execute('SELECT 1 FROM image_studio_deleted_requests WHERE id=?', (operation_id,)).fetchone():
                raise ModelProviderError('image_operation_conflict', '此编辑请求已删除，未再次执行')
            if conn.execute('SELECT 1 FROM image_studio_tasks WHERE id=?', (operation_id,)).fetchone():
                raise ModelProviderError('image_operation_conflict', '操作编号已被其他图片任务使用')
            conn.execute('INSERT INTO chat_image_operations(id,conversation_id,selection_json) VALUES (?,?,?)',
                         (operation_id, source['conversation_id'], json_dump({**selection, 'edit_digest': digest})))
            if studio:
                requested_size = f'{request.width}x{request.height}' if request.mode == 'resize' else size or 'auto'
                conn.execute("""INSERT INTO image_studio_tasks
                    (id,conversation_id,prompt,request_hash,profile_id,model_name,size,source_asset_id,status)
                    VALUES (?,?,?,?,?,?,?,?,'running')""", (operation_id, source['conversation_id'],
                        request.prompt.strip() or label, digest, selection.get('profile_id'),
                        selection.get('model_name', 'local-resize'), requested_size, asset_id))
        recorded = True
        def mark_submitted():
            nonlocal submitted
            submitted = True
        response = await _render_edit(path, request, connection, prompt, mark_submitted, size=size)
        result = persist_images(operation_id, response, connection['model_name'] if connection else 'local-resize', prompt=label)
        return _publish(operation_id, source, result, label)
    except Exception as exc:
        if studio and recorded:
            cause = exc.__cause__
            rejected = (isinstance(exc, ModelProviderError) and isinstance(cause, APIStatusError)
                        and cause.status_code in {400, 401, 403, 404, 405, 422})
            uncertain = submitted and not rejected
            status = 'uncertain' if uncertain else 'failed'
            error = '暂未确认生成结果；未自动重新提交。' if uncertain else '图片编辑未完成，请检查原图和修改要求。'
            with connect() as conn:
                conn.execute('UPDATE image_studio_tasks SET status=?,error=? WHERE id=?', (status,error,operation_id))
        raise
    finally:
        if studio:
            release_edit(operation_id)


async def _render_edit(path, request, connection, prompt, mark_submitted, *, size: str | None = None):
    with Image.open(path) as original:
        if original.width * original.height > 40_000_000:
            raise ValueError("图片尺寸过大")
        image = ImageOps.exif_transpose(original).convert("RGBA")
        if request.mode == "resize":
            if request.flip:
                image = ImageOps.mirror(image)
            image = image.rotate(-request.rotation, expand=True)
            image = image.resize((request.width, request.height), Image.Resampling.LANCZOS)
            response = ModelResponse(images=[ModelImageOutput(item_id="resize-0", base64_data=base64.b64encode(png_bytes(image)).decode())])
        else:
            from ..models.openai_images import OpenAIImagesProvider
            provider = OpenAIImagesProvider(api_key=connection["api_key"], model=connection["model_name"],
                                             base_url=connection["model_base_url"] or None)
            try:
                image_data = png_bytes(image)
                mask = selection_mask(image.size, request.strokes) if request.mode == 'erase' else None
                mark_submitted()
                response = await provider.edit_image(image_data, prompt, mask=mask,
                                                     transparent=request.mode == "background", size=size)
            finally:
                await provider._client.close()
    return response
