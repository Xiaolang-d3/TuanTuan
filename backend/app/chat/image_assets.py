"""Account-local generated images and durable, non-retryable generation attempts."""
from __future__ import annotations

import base64
import json
import re
import uuid
from hashlib import sha256
from io import BytesIO
from pathlib import Path
from typing import Any

from PIL import Image, UnidentifiedImageError

from ..db import connect, json_dump
from ..domain import ModelResponse
from ..models import ModelProviderError
from ..workspace import resolve_document_dir


def image_generation_intent(text: str, *, image_model_selected: bool = False) -> bool:
    # Only an instruction in this turn enables the billed native tool. Quoted
    # documents, past turns and requests to explain image generation do not.
    instruction_text = text.strip()
    # A pasted opening quote can prefix a request heading, e.g. “请生成这张图片：\n…”.
    # Only normalize a heading that introduces a separate description.
    if "\n" in instruction_text and re.match(r'^[“"「『](?:请|帮我|麻烦|生成|绘制|画).*[：:]\s*\n', instruction_text):
        instruction_text = instruction_text[1:]
    first = instruction_text.split("\n", 1)[0]
    instruction_block = instruction_text.split("\n\n", 1)[0]
    if re.search(r"(?:图片|图像)(?:的(?:原理|功能|接口|能力)|功能|接口|能力|是什么|支持吗|怎么用)", first):
        return False
    if re.search(r"(?:图片|图像|插画|海报|壁纸|封面|照片|图)(?:的)?(?:提示词|prompt|原理|教程|代码|费用|价格)", first, re.I):
        return False
    if re.search(r"(?:只(?:要|需)|仅(?:要|需)|先(?:给|写|提供)).{0,12}(?:提示词|prompt)|不要(?:生成|绘制|画).{0,12}(?:图片|图像)", instruction_block, re.I):
        return False
    if not image_model_selected and re.search(r"(?:图表|思维导图|流程图|时序图|架构图|折线图|柱状图|饼图|Mermaid)", first, re.I) and not re.search(r"图片|图像|插画|海报", first):
        return False
    if re.match(r"^(?:请|帮我)?生成(?:图片|图像)(?:需要|有什么|怎么|是否)", first):
        return False
    # Strip polite framing without imposing a short subject-length limit. A
    # concrete request such as “能不能生成一张小猫图？” is still an instruction.
    instruction = re.sub(r"^(?:(?:请你|请|帮我|帮忙|给我|能不能|可不可以|能否|可以|你能|你可以|麻烦你|麻烦|我想要|我想|我要|用\s*Grok|为我)\s*)+", "", first, flags=re.I)
    if re.fullmatch(r"(?:生成|绘制|画|生图)(?:图片|图像|图)?(?:吗|么)?[?？。！!]*", instruction):
        return False
    if re.match(r"^(?:生成|制作|设计)(?:一(?:个|段|份))?\s*(?:Python|JavaScript|JS|TypeScript|TS)?\s*(?:代码|程序|脚本|接口|教程|文档|提示词|prompt)", instruction, re.I):
        return False
    if re.search(r"\b(?:image|picture|photo|poster)(?:\s+generation)?\s+(?:prompt|code|tutorial)\b", first, re.I):
        return False
    if re.match(r"^(?:(?:please|can you|could you|would you)\s+)*(?:generate|create)\s+(?:an?\s+)?(?:(?:Python|JavaScript|TypeScript)\s+)?(?:code|program|script|tutorial|prompt)\b", first, re.I):
        return False
    if re.fullmatch(r"(?:can|could|would)\s+you\s+(?:generate|create|draw|paint)\s+(?:an?\s+)?(?:images?|pictures?|photos?|illustrations?)\s*[?？]?", first, re.I):
        return False
    return bool(
        re.match(r"^(?:画(?:一|个|张|出|幅)|绘制|(?:生成|制作|做一张|设计).*(?:图片|图像|插画|海报|壁纸|封面|照片|图|banner))", instruction, re.I)
        or re.match(r"^(?:一张|一幅).+(?:图片|图像|插画|海报|壁纸|封面|照片|图)[。！!？?]*$", instruction)
        or re.match(r"^(?:(?:please|can you|could you|would you)\s+)*(?:generate|create|draw|paint)\s+.*\b(?:image|picture|illustration|poster|painting|photo)\b", first, re.I)
    )


def begin_generation(operation_id: str, conversation_id: int, selection: dict[str, Any], db_path=None) -> dict | None:
    fields = ("profile_id", "profile_revision", "connection_id", "connection_revision", "model_name", "model_protocol")
    selection = {**{k: selection[k] for k in fields if k in selection},
                 **({"stages": {name: {k: stage[k] for k in fields if k in stage} for name, stage in selection["stage_selections"].items()}}
                    if selection.get("stage_selections") else {})}
    with connect(db_path) as conn:
        conn.execute("BEGIN IMMEDIATE")
        row = conn.execute("SELECT * FROM chat_image_operations WHERE id=?", (operation_id,)).fetchone()
        if row:
            if row["conversation_id"] != conversation_id:
                raise ModelProviderError("image_operation_conflict", "生图任务不属于当前对话")
            if json.loads(row["selection_json"]) != selection:
                raise ModelProviderError("image_operation_conflict", "生图任务的模型配置版本不匹配")
            if row["status"] == "done":
                return json.loads(row["result_json"])
            raise ModelProviderError("image_generation_uncertain", "上次生图请求的执行结果尚未确认，已阻止自动重复生成。请查看服务记录后重新发起请求")
        conn.execute("INSERT INTO chat_image_operations (id,conversation_id,selection_json) VALUES (?,?,?)",
                     (operation_id, conversation_id, json_dump(selection)))
    return None


def _root(db_path=None) -> Path:
    return resolve_document_dir(db_path) / "chat-images"


def _confined(root: Path, path: Path) -> Path:
    resolved = path.resolve()
    if not resolved.is_relative_to(root.resolve()) or resolved == root.resolve():
        raise ValueError("图片路径不可用")
    return resolved


def persist_images(operation_id: str, response: ModelResponse, model_name: str, db_path=None, *, prompt: str | None = None) -> dict:
    if not response.images:
        from ..models.openai_responses import IMAGE_NOT_EXECUTED_MESSAGE
        raise ModelProviderError("image_generation_not_executed", IMAGE_NOT_EXECUTED_MESSAGE)
    if len(response.images) > 4:
        raise ModelProviderError("too_many_image_outputs", "服务返回的图片超过单次保存上限（4 张），不会自动重新生成")
    prepared = []
    seen: set[str] = set()
    try:
        for image in response.images:
            if image.item_id in seen:
                raise ValueError("重复的图片输出")
            seen.add(image.item_id)
            encoded = image.base64_data.get_secret_value()
            if len(encoded) > 28_000_000:
                raise ValueError("生成的图片超过 20 MB")
            data = base64.b64decode(encoded, validate=True)
            if len(data) > 20_000_000:
                raise ValueError("生成的图片超过 20 MB")
            with Image.open(BytesIO(data)) as decoded:
                if decoded.format not in {"PNG", "JPEG", "WEBP"} or decoded.width * decoded.height > 40_000_000:
                    raise ValueError("生成图片的格式或尺寸不受支持")
                mime, extension = {"PNG": ("image/png", "png"), "JPEG": ("image/jpeg", "jpg"), "WEBP": ("image/webp", "webp")}[decoded.format]
                width, height = decoded.size
                decoded.verify()
            aid = uuid.uuid4().hex
            asset = {"id": aid, "origin": "generated", "kind": "image", "original_filename": f"生成图片-{len(prepared)+1}.{extension}",
                     "content_type": mime, "size_bytes": len(data), "width": width, "height": height,
                     "sha256": sha256(data).hexdigest(), "parse_status": "parsed", "model_name": model_name}
            prepared.append((image.item_id, asset, data))
    except (ValueError, UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
        raise ModelProviderError("invalid_image_output", "生图服务返回的图片无效或过大，未保存；不会自动重新生成") from exc
    written: list[Path] = []
    try:
        with connect(db_path) as conn:
            conn.execute("BEGIN IMMEDIATE")
            operation = conn.execute("SELECT * FROM chat_image_operations WHERE id=?", (operation_id,)).fetchone()
            if operation is None:
                raise ValueError("生图任务不存在")
            if operation["status"] == "done":
                return json.loads(operation["result_json"])
            root = _root(db_path)
            if root.is_symlink():
                raise ValueError("图片目录不可用")
            root.mkdir(parents=True, exist_ok=True, mode=0o700)
            root.chmod(0o700)
            for item_id, asset, data in prepared:
                suffix = Path(asset["original_filename"]).suffix
                target = _confined(root, root / f"{asset['id']}{suffix}")
                # Exclusive creation, with restrictive permissions from the start.
                import os
                fd = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                written.append(target)
                with os.fdopen(fd, "wb") as stream:
                    stream.write(data)
                conn.execute("INSERT INTO chat_image_assets (id,operation_id,conversation_id,provider_item_id,stored_path,metadata_json) VALUES (?,?,?,?,?,?)",
                             (asset["id"], operation_id, operation["conversation_id"], item_id, target.relative_to(resolve_document_dir(db_path)).as_posix(), json_dump(asset)))
            assets = [asset for _, asset, _ in prepared]
            blocks = [{"type": "image", "asset_id": assets[b["index"]]["id"]} if b["type"] == "image" else b for b in response.output_blocks]
            if not blocks:
                blocks = ([{"type": "text", "text": response.content}] if response.content else []) + [{"type": "image", "asset_id": asset["id"]} for asset in assets]
            result = {"content": response.content, "assets": assets, "output_blocks": blocks}
            if prompt:
                result["image_generation_prompt"] = prompt
            conn.execute("UPDATE chat_image_operations SET status='done',result_json=? WHERE id=?", (json_dump(result), operation_id))
        return result
    except OSError as exc:
        for path in written:
            path.unlink(missing_ok=True)
        raise ModelProviderError("image_storage_failed", "图片已生成，但本地保存失败。请检查磁盘；不会自动重新生成") from exc
    except Exception:
        for path in written:
            path.unlink(missing_ok=True)
        raise


def with_generation_prompts(messages: list[dict], conversation_id: int, db_path=None) -> list[dict]:
    """Expose the saved request for legacy image replies without reconstructing it."""
    with connect(db_path) as conn:
        rows = conn.execute(
            "SELECT r.assistant_message_id, r.user_content FROM agent_execution_runs r "
            "WHERE r.conversation_id=? AND r.status='completed' AND EXISTS "
            "(SELECT 1 FROM chat_image_assets a WHERE a.conversation_id=r.conversation_id "
            "AND a.message_id=r.assistant_message_id)", (conversation_id,),
        ).fetchall()
    prompts = {row["assistant_message_id"]: row["user_content"].strip() for row in rows}
    for message in messages:
        agent = (message.get("payload") or {}).get("agent")
        if isinstance(agent, dict) and agent.get("assets") and not agent.get("image_generation_prompt"):
            prompt = prompts.get(message["id"])
            if prompt:
                agent["image_generation_prompt"] = prompt
    return messages


def asset_metadata(asset_id: str, db_path=None) -> dict:
    with connect(db_path) as conn:
        row = conn.execute("SELECT * FROM chat_image_assets WHERE id=?", (asset_id,)).fetchone()
    if row is None:
        raise ValueError("生成图片不存在")
    return {**json.loads(row["metadata_json"]), "conversation_id": row["conversation_id"], "message_id": row["message_id"]}


def asset_file(asset_id: str, db_path=None) -> tuple[Path, str, str]:
    with connect(db_path) as conn:
        row = conn.execute("SELECT stored_path,metadata_json FROM chat_image_assets WHERE id=?", (asset_id,)).fetchone()
    if row is None:
        raise ValueError("生成图片不存在")
    path = _confined(_root(db_path), resolve_document_dir(db_path) / row["stored_path"])
    if _root(db_path).is_symlink():
        raise ValueError("图片目录不可用")
    if not path.is_file():
        raise ValueError("生成图片原文件不可用")
    metadata = json.loads(row["metadata_json"])
    return path, metadata["original_filename"], metadata["content_type"]


def asset_thumbnail(asset_id: str, db_path=None) -> bytes:
    return image_file_thumbnail(asset_file(asset_id, db_path)[0])


def image_file_thumbnail(path: Path) -> bytes:
    with Image.open(path) as img:
        if img.width * img.height > 40_000_000:
            raise ValueError("图片尺寸过大")
        from PIL import ImageOps
        img = ImageOps.exif_transpose(img)
        img.thumbnail((960, 640))
        output = BytesIO()
        img.save(output, "WEBP", quality=82)
        return output.getvalue()


def delete_images(
    conversation_id: int,
    *,
    message_cutoff: int | None = None,
    message_before: int | None = None,
    db_path=None,
) -> None:
    clauses = ["conversation_id=?"]
    args: list[object] = [conversation_id]
    if message_cutoff is not None:
        clauses.append("message_id>=?")
        args.append(message_cutoff)
    if message_before is not None:
        clauses.append("message_id<?")
        args.append(message_before)
    with connect(db_path) as conn:
        rows = conn.execute(
            f"SELECT id,operation_id,stored_path FROM chat_image_assets WHERE {' AND '.join(clauses)}",
            args,
        ).fetchall()
        for row in rows:
            path = _confined(_root(db_path), resolve_document_dir(db_path) / row["stored_path"])
            path.unlink(missing_ok=True)
            conn.execute("DELETE FROM chat_image_assets WHERE id=?", (row["id"],))
        # Keep attempt markers on rewind: reconnecting the same paid run must not regenerate.
        if message_cutoff is None and message_before is None:
            conn.execute("DELETE FROM chat_image_operations WHERE conversation_id=?", (conversation_id,))
