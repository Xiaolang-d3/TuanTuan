"""Model stages for the built-in presentation workflow; no executable tools."""
from __future__ import annotations

import asyncio
import hashlib
import json
from pathlib import Path

from ..branding import env
from ..agent.model_binding import is_bound_selection
from ..domain import AgentMessage, ModelRequest
from ..execution.workspace_files import WorkspaceFiles
from ..extensions.contracts import ExtensionContext
from ..jobs.repository import JobRepository, JobConflict
from ..db import connect
from ..models.base import ModelProviderError
from ..observability.model_context import model_call_scope
from .model_ledger import ModelCallLedger
from .retry import state_for, stage_name


def model_timeout_seconds() -> int:
    # A PPT stage may read a full design contract and produce a complete plan.
    # Keep its deadline separate from short interactive chat requests.
    try:
        seconds = int(env("TUANTUAN_PPT_MODEL_TIMEOUT_SECONDS", "300"))
    except (TypeError, ValueError):
        return 300
    return seconds if 30 <= seconds <= 600 else 300


def model_retry_attempts() -> int:
    # Bounded automatic retries after a definite provider gateway failure such
    # as an HTTP 502/524. Only error responses the provider already returned
    # are retried; timeouts and mid-request disconnects keep their unknown
    # outcome and still wait for an explicit user decision.
    try:
        attempts = int(env("TUANTUAN_PPT_MODEL_RETRIES", "2"))
    except (TypeError, ValueError):
        return 2
    return attempts if 0 <= attempts <= 5 else 2


def _require_presentation_model(connection: dict) -> None:
    if (connection.get("auth_kind") == "chatgpt_subscription"
            or connection.get("secret_ref") == "chatgpt_subscription"):
        raise ValueError("ChatGPT 订阅仅支持团团对话，不可用于 PPT 制作")


def build_bound_provider(selection: dict, *, timeout_seconds: float | None = None):
    from ..agent import get_profile_connection
    from ..models.configured import configure_model_provider
    from ..models.factory import build_model_provider

    if not is_bound_selection(selection):
        raise ValueError("PPT 制作需要固定的模型版本绑定")
    _require_presentation_model(selection)
    connection = get_profile_connection(selection=selection)
    _require_presentation_model(connection)
    configured = connection.get("model_protocol", "auto")
    # Resolve exactly one wire protocol, without negotiation or router fallback.
    protocol = (connection.get("detected_protocol") or connection["resolved_model_protocol"]) if configured == "auto" else configured
    if protocol not in {"openai", "responses", "anthropic", "gemini", "ollama"}:
        raise ValueError("所选模型不支持演示文稿文本生成")
    provider = build_model_provider(
        api_key=connection["api_key"], model=connection["model_name"],
        base_url=connection.get("model_base_url"), protocol=protocol,
        timeout_seconds=model_timeout_seconds() if timeout_seconds is None else timeout_seconds,
        price_per_million_input=connection.get("price_per_million_input"),
        price_per_million_output=connection.get("price_per_million_output"),
    )
    return configure_model_provider(provider, connection.get("parameters") or {}, connection.get("reasoning_effort"))


class PptModelRunner:
    def __init__(self, repository: JobRepository, job: dict, context: ExtensionContext, root: Path, *, provider_factory=None):
        self.repository, self.job, self.context = repository, job, context
        self.files = WorkspaceFiles(root)
        self.ledger = ModelCallLedger(repository, clock=repository.clock)
        self.provider_factory = provider_factory
        self.retry = state_for(job["id"])
        self.allow_replay = self.retry["count"] > 0

    async def generate_stage(self, stage: str, inputs: dict, selection: dict, *, instructions: str, retry_attempts: int | None = None) -> dict:
        if not is_bound_selection(selection):
            raise ValueError("PPT 制作需要固定的模型版本绑定")
        _require_presentation_model(selection)
        stage = stage_name(stage, self.retry)
        if self.allow_replay:
            self.repository.check_owner(self.job["id"], self.job["owner_token"], self.context)
            with connect() as conn:
                previous = conn.execute("SELECT id,state,result_hash FROM presentation_model_calls WHERE job_id=? AND stage=? ORDER BY created_at DESC,rowid DESC LIMIT 1", (self.job["id"], stage)).fetchone()
            if previous:
                if previous["state"] != "completed":
                    raise JobConflict("此阶段请求结果待核对，请明确确认后再重试")
                try:
                    content = self.files.read(f"model_responses/{previous['id']}.json")
                    if hashlib.sha256(content).hexdigest() != previous["result_hash"]:
                        raise ValueError()
                except (OSError, ValueError) as exc:
                    raise JobConflict("已完成的模型结果校验失败，不能自动重复请求") from exc
                return self._parse(content)
        serialized = json.dumps(inputs, ensure_ascii=False, allow_nan=False)
        if len(serialized.encode("utf-8")) + len(instructions.encode("utf-8")) > 240_000:
            raise ValueError("阶段资料过大，请精简内容后重新制作")
        timeout = model_timeout_seconds()
        provider = (self.provider_factory(selection) if self.provider_factory is not None
                    else build_bound_provider(selection, timeout_seconds=timeout))
        request = ModelRequest(
            messages=[AgentMessage(role="system", content=instructions), AgentMessage(role="user", content=serialized)],
            tools=[], tool_choice="none", allow_option_fallback=False,
            response_format={"type": "json_object"},
            parameters={"max_output_tokens": 16000},
        )
        job_id, attempt = self.job["id"], self.job["owner_token"]
        total_attempts = 1 + (model_retry_attempts() if retry_attempts is None else retry_attempts)
        for attempt_no in range(1, total_attempts + 1):
            request_id = self.ledger.reserve(job_id, attempt, stage, self.context)
            try:
                with model_call_scope(selection, run_id=job_id, stage=f"ppt.{stage}"):
                    try:
                        response = await asyncio.wait_for(provider.generate(request), timeout=timeout + 30)
                    except TimeoutError as exc:
                        raise ModelProviderError("request_timeout", "PPT 模型调用等待超时，请先核对原请求结果") from exc
                # Store the actual response durably before clearing the unknown fence.
                # This file contains model output only, never provider metadata or keys.
                content = response.content.encode("utf-8")
                self.repository.check_owner(job_id, attempt, self.context)
                self.files.write(f"model_responses/{request_id}.json", content)
                self.ledger.complete(request_id, attempt, hashlib.sha256(content).hexdigest(), response.usage.model_dump() if response.usage else {}, self.context)
                break
            except ModelProviderError as exc:
                # A definite provider error response resolves the reservation;
                # everything else keeps the unknown-outcome fence. Settling
                # failures must never mask the original exception.
                try:
                    if exc.retry_safe:
                        self.ledger.mark_failed(request_id, attempt, self.context)
                    else:
                        self.ledger.mark_unknown(request_id, attempt, self.context)
                except Exception:
                    pass
                if not (exc.retry_safe and exc.retryable and attempt_no < total_attempts):
                    raise
                await asyncio.sleep(2 * attempt_no)
            except BaseException:
                # If the lease was lost, reserve() already left a durable fence.
                try:
                    self.ledger.mark_unknown(request_id, attempt, self.context)
                except Exception:
                    pass
                raise
        if response.tool_calls or response.images:
            raise ValueError("PPT 阶段只接受 JSON 数据，不能调用工具或生成图片")
        return self._parse(response.content)

    @staticmethod
    def _parse(content):
        try:
            result = json.loads(content, parse_constant=lambda value: (_ for _ in ()).throw(ValueError(value)))
        except (ValueError, TypeError) as exc:
            raise ModelProviderError("invalid_response", "模型阶段返回了不完整或无效的 JSON") from exc
        if not isinstance(result, dict):
            raise ValueError("模型阶段必须返回 JSON 对象")
        return result
