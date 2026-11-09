"""Trusted presentation entry point and account-scoped product readiness."""
from __future__ import annotations

from ..branding import env
from ..execution.builtin_runtime import BuiltinRuntime, UPSTREAM_COMMIT
from ..extensions.contracts import ExtensionContext
from ..extensions.runtime_snapshot import ExtensionRunSnapshot
from ..jobs.repository import JobConflict, JobNotFound
from ..jobs.service import JobService, job_service
from .contracts import PresentationRequest
from .progress import public_progress
from .errors import OUTPUT_FAILURES


def preparation_enabled() -> bool:
    return env("TUANTUAN_PPT_PREPARATION_ENABLED", "true").strip().lower() == "true"


def production_enabled() -> bool:
    return (preparation_enabled()
            and env("TUANTUAN_DEPLOYMENT_MODE", "local").strip().lower() == "local"
            and env("TUANTUAN_PPT_GENERATION_ENABLED", "true").strip().lower() == "true")


def resolve_model(profile_id=None, *, preferred_profile_id=None):
    from ..agent.model_purposes import resolve_purpose_connection
    # A conversation may still prefer an image model or an unavailable service.
    # Resolve its text purpose just as chat does, then freeze that exact binding.
    return resolve_purpose_connection("chat", profile_id=profile_id, preferred_profile_id=preferred_profile_id)


_MODEL_FAILURES = {
    "authentication_failed": "模型服务认证失败，请在模型设置中检查该文本模型的 API Key、模型权限和服务地址。",
    "rate_limited": "模型服务触发限流，请稍后重新提交制作。",
    "request_timeout": "当次模型调用等待超时，尚未取得完整结果。请先核对模型服务的调用记录，再决定是否新建制作任务。",
    "service_unavailable": "无法连接模型服务，请检查模型设置中的服务地址和网络状态。",
    "model_unavailable": "当前文本模型不可用，请在模型设置中选择可用模型。",
    "protocol_unsupported": "当前模型不支持所选协议，请在模型设置中检查协议。",
    "context_window_exceeded": "制作资料超出模型上下文限制，请精简要求或选择上下文更大的模型。",
    "content_policy": "模型服务拒绝了此次内容，请调整演示要求后重新提交。",
    "provider_error": "模型服务发生异常，请检查模型服务状态后重新提交。",
    "invalid_response": "模型已返回，但制作数据不完整或格式无效，未继续生成。请核对模型服务的输出完整性后再新建任务。",
}


def _model_failure_code(job: dict) -> str:
    if job["status"] != "failed":
        return ""
    code = job["checkpoint"].get("model_error_code", "")
    if not code and job["error"].startswith("ModelProviderError"):
        # Older workers saved only the exception name. Read the matching
        # workspace-scoped operational code, never the raw upstream body.
        from ..db import connect
        with connect() as conn:
            event = conn.execute("SELECT error_code FROM model_service_events WHERE run_id=? AND status='error' ORDER BY id DESC LIMIT 1", (job["id"],)).fetchone()
        code = event["error_code"] if event else ""
    return code if code in _MODEL_FAILURES else ""


def _output_failure_code(job: dict) -> str:
    if job["status"] != "failed":
        return ""
    code = job["checkpoint"].get("presentation_error_code", "")
    if code in OUTPUT_FAILURES:
        return code
    if (not job["error"].startswith(("ValueError", "ValidationError"))
            or job["checkpoint"].get("stage") != "final_confirmed"
            or job["checkpoint"].get("production")):
        return ""
    # Older workers discarded validation reasons. Diagnose only this job's last
    # completed design output, after checking its ledger hash; never rerun it.
    import hashlib
    import json
    import re
    from types import SimpleNamespace
    from ..db import connect
    from ..execution.workspace_files import WorkspaceFiles
    from ..workspace import current_workspace_root
    from .errors import PresentationOutputError
    from .production import validate_design_plan

    workspace = current_workspace_root()
    if workspace is None or not re.fullmatch(r"[a-f0-9]{32}", job["id"]):
        return ""
    with connect() as conn:
        call = conn.execute("SELECT id,stage,state,result_hash FROM presentation_model_calls WHERE job_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1", (job["id"],)).fetchone()
    if not call or call["stage"] != "design_spec" or call["state"] != "completed" or not re.fullmatch(r"[a-f0-9]{32}", call["id"]):
        return ""
    try:
        root = workspace / "jobs" / job["id"]
        if not root.is_dir():
            return ""
        content = WorkspaceFiles(root, boundary=workspace).read(f"model_responses/{call['id']}.json", limit=1_000_000)
        if hashlib.sha256(content).hexdigest() != call["result_hash"]:
            return ""
        validate_design_plan(json.loads(content), SimpleNamespace(min_pages=1, max_pages=20))
    except PresentationOutputError as exc:
        return exc.code
    except (OSError, ValueError, TypeError):
        pass
    return ""


def public_presentation(job: dict) -> dict:
    """An allowlist, unlike generic jobs' diagnostic checkpoint representation."""
    error_code = _model_failure_code(job) or _output_failure_code(job)
    from .retry import public_retry
    delivered = (job.get("result") or {}).get("artifacts") if job["status"] == "succeeded" else None
    return {key: job[key] for key in ("id", "kind", "status", "revision", "created_at", "updated_at", "error", "cancel_requested")} | {
        "topic": job["request"].get("topic", "演示文稿"),
        "page_count": job["request"].get("options", {}).get("page_count", 8),
        "conversation_id": job["request"].get("conversation_id"),
        "model_name": job["snapshot"].get("model_selection", {}).get("model_name", ""),
        "error_code": error_code,
        "error": {**_MODEL_FAILURES, **OUTPUT_FAILURES}.get(error_code, job["error"]),
        "stage": job["checkpoint"].get("production", {}).get("stage", job["checkpoint"].get("stage", "queued")),
        "progress": public_progress(job),
        "stage_id": job["stage_id"],
        "confirmation_required": job["status"] == "waiting_user" and not job["cancel_requested"],
        "prompt": job["prompt"],
        "generation_available": production_enabled(),
        **public_retry(job),
        **({"delivery_artifacts": [{key: item[key] for key in ("id", "version", "filename")} for item in delivered if isinstance(item, dict) and {"id", "version", "filename"} <= item.keys()]} if isinstance(delivered, list) else {}),
    }


class PresentationService:
    def __init__(self, jobs: JobService, *, runtime_loader=BuiltinRuntime.load,
                 model_resolver=resolve_model, preparation_enabled=preparation_enabled):
        self.jobs = jobs
        self.runtime_loader, self.model_resolver = runtime_loader, model_resolver
        self.preparation_enabled = preparation_enabled

    def _runtime(self):
        try:
            runtime = self.runtime_loader()
            runtime.verify()
        except FileNotFoundError as exc:
            raise PresentationUnavailable("runtime_missing", "PPT 本机运行包尚未准备好，请先按部署说明构建运行包") from exc
        except (OSError, ValueError, KeyError, TypeError) as exc:
            raise PresentationUnavailable("runtime_invalid", "PPT 本机运行资源不完整或与当前系统不兼容，请重新构建运行包") from exc
        if production_enabled() and "host/render_preview.py" not in runtime.manifest.get("files", {}):
            raise PresentationUnavailable("runtime_invalid", "PPT 制作运行资源缺少预览入口，请重新构建完整运行包")
        return runtime

    def _conversation(self, conversation_id: int | None):
        from ..chat.conversations import get_conversation
        if conversation_id is None:
            return None
        conversation = get_conversation(conversation_id)
        if conversation is None:
            raise JobNotFound("对话不存在")
        return conversation

    def _model(self, profile_id: str | None = None, *, preferred: bool = True):
        from ..agent.model_binding import internal_model_selection, is_bound_selection
        try:
            connection = self.model_resolver(**{"preferred_profile_id" if preferred else "profile_id": profile_id}) if profile_id else self.model_resolver()
        except ValueError as exc:
            raise PresentationUnavailable("model_unavailable", "请先在模型设置中配置可用的文本模型") from exc
        selection = internal_model_selection(connection)
        if (not is_bound_selection(selection)
                or connection.get("resolved_model_protocol") not in {"openai", "responses", "anthropic", "gemini", "ollama"}
                or (connection.get("resolved_model_protocol") != "ollama" and not connection.get("api_key_configured"))):
            raise PresentationUnavailable("model_unavailable", "请先配置可用且有固定版本的文本模型")
        return selection

    def _check_entry(self):
        if env("TUANTUAN_DEPLOYMENT_MODE", "local").strip().lower() != "local":
            raise PresentationUnavailable("hosted_disabled", "PPT 制作仅支持本地部署")
        if not self.preparation_enabled():
            raise PresentationUnavailable("generation_disabled", "PPT 需求确认流程已被管理员关闭")
        if not production_enabled():
            raise PresentationUnavailable("generation_disabled", "PPT 制作已被管理员关闭")
        if "ppt.generate" not in self.jobs.handlers:
            raise PresentationUnavailable("worker_unavailable", "PPT 后台制作服务未启动，请重启团团")

    def capabilities(self, context: ExtensionContext, *, conversation_id: int | None = None) -> dict:
        context.check_workspace()
        conversation = self._conversation(conversation_id)
        status = {"available": False, "code": "ready", "reason": "",
                  "limits": {"min_pages": 1, "max_pages": 20, "language": "zh-CN", "canvas": "ppt169"}}
        try:
            self._check_entry()
            selection = self._model(conversation.get("model_profile_id") if conversation else None)
            self._runtime()
        except PresentationUnavailable as exc:
            return {**status, "code": exc.code, "reason": str(exc)}
        return {**status, "available": True, "reason": "AI PPT 制作已就绪", "model_name": selection.get("model_name", "")}

    def list(self, conversation_id: int, context: ExtensionContext, *, before: str | None = None) -> dict:
        from ..db import connect
        from ..jobs.repository import decode
        context.check_workspace()
        self._conversation(conversation_id)
        condition = "kind='ppt.generate' AND json_extract(request_json,'$.conversation_id')=?"
        parameters = [conversation_id]
        with connect() as conn:
            if before:
                cursor = conn.execute(f"SELECT created_at,id FROM background_jobs WHERE {condition} AND id=?", (conversation_id, before)).fetchone()
                if cursor is None:
                    raise JobNotFound("制作任务游标不存在")
                condition += " AND (created_at,id)<(?,?)"
                parameters.extend([cursor["created_at"], cursor["id"]])
            rows = conn.execute(f"SELECT * FROM background_jobs WHERE {condition} ORDER BY created_at DESC,id DESC LIMIT 21", parameters).fetchall()
        return {"jobs": [decode(row) for row in rows[:20]], "next_cursor": rows[19]["id"] if len(rows) > 20 else None}

    def create(self, request: PresentationRequest, context: ExtensionContext, idempotency_key: str) -> dict:
        from ..attachments.service import get_attachment
        context.check_workspace()
        self._check_entry()
        if any(get_attachment(value) is None for value in request.attachment_ids):
            raise JobNotFound("附件不存在")
        conversation = self._conversation(request.conversation_id)
        runtime = self._runtime()
        selection = self._model(conversation.get("model_profile_id") if conversation else None)
        snapshot = ExtensionRunSnapshot(
            version=2, user_id=context.user_id, model_selection=selection,
            grants=("builtin.ppt-master.execute",),
            execution={"backend": "local_builtin", "adapter": "ppt-master", "runtime_digest": runtime.digest,
                       "upstream_commit": UPSTREAM_COMMIT},
        )
        return self.jobs.repository.enqueue("ppt.generate", request.model_dump(mode="json"), snapshot.model_dump(mode="json"), context, idempotency_key)

    def get(self, job_id: str, context: ExtensionContext) -> dict:
        job = self.jobs.get(job_id, context)
        if job["kind"] != "ppt.generate":
            raise JobNotFound("制作任务不存在")
        return job

    def cancel(self, job_id: str, context: ExtensionContext) -> dict:
        self.get(job_id, context)
        return self.jobs.cancel(job_id, context)

    def resume(self, job_id: str, context: ExtensionContext) -> dict:
        self.get(job_id, context)
        return self.jobs.resume(job_id, context)

    def retry(self, job_id: str, values: dict, context: ExtensionContext) -> dict:
        from .retry import retry_presentation
        job = self.get(job_id, context)
        self._check_entry()
        runtime = self._runtime()
        snapshot = ExtensionRunSnapshot.model_validate(job["snapshot"])
        if not snapshot.execution or runtime.digest != snapshot.execution["runtime_digest"]:
            raise JobConflict("原任务的 PPT 运行资源版本已改变，请恢复对应版本后重试")
        selection = self._model(snapshot.model_selection.get("profile_id"), preferred=False)
        return retry_presentation(self.jobs.repository, job_id, values, context, model_selection=selection)


class PresentationUnavailable(JobConflict):
    def __init__(self, code: str, reason: str):
        super().__init__(reason)
        self.code = code


presentation_service = PresentationService(job_service)
