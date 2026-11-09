from __future__ import annotations

import time

from ..extensions.contracts import ExtensionContext
from ..extensions.runtime_snapshot import ExtensionRunSnapshot, bind_extensions, resolve_snapshot
from .repository import JobConflict, JobRepository


class JobService:
    def __init__(self, handlers: dict | None = None, *, clock=time.time, model_budget_kinds: set[str] | None = None):
        # Handlers are registered by trusted application adapters, never manifests.
        self.handlers = handlers if handlers is not None else {}
        self.repository = JobRepository(clock=clock)
        self.model_budget_kinds = set(model_budget_kinds or ())
        if not self.model_budget_kinds.issubset(self.handlers):
            raise ValueError("模型预算能力只能注册给可信任务适配器")

    def enqueue(self, kind: str, request: dict, context: ExtensionContext, idempotency_key: str, *, snapshot: ExtensionRunSnapshot | None = None) -> dict:
        if kind.startswith("ppt."):
            raise JobConflict("PPT 任务必须通过专用制作入口创建")
        if kind == "document.review":
            raise JobConflict("全文审阅任务必须通过专用入口创建")
        if kind == "document.export":
            raise JobConflict("文档导出任务必须通过专用入口创建")
        if kind not in self.handlers:
            raise JobConflict("此任务的执行适配器尚未就绪")
        snapshot = snapshot or bind_extensions(context)
        resolve_snapshot(snapshot, context)
        return self.repository.enqueue(kind, request, snapshot.model_dump(mode="json"), context, idempotency_key)

    def get(self, job_id: str, context: ExtensionContext) -> dict:
        return self.repository.get(job_id, context)

    def cancel(self, job_id: str, context: ExtensionContext) -> dict:
        return self.repository.cancel(job_id, context)

    def resume(self, job_id: str, context: ExtensionContext) -> dict:
        job = self.get(job_id, context)
        if job["kind"] not in self.handlers:
            raise JobConflict("原任务适配器不可用，不能切换到其他执行器")
        snapshot = resolve_snapshot(ExtensionRunSnapshot.model_validate(job["snapshot"]), context)
        guard = getattr(self.handlers[job["kind"]], "validate_resume", None)
        if guard is not None:
            guard(job, context)
        if snapshot.execution is not None:
            from ..execution.builtin_runtime import BuiltinRuntime
            from ..branding import env
            if env("TUANTUAN_DEPLOYMENT_MODE", "local").strip().lower() != "local":
                raise JobConflict("本机任务不能在当前部署方式中恢复")
            try:
                runtime = BuiltinRuntime.load()
            except (ValueError, OSError) as exc:
                raise JobConflict("原任务的 PPT 运行资源版本不可用") from exc
            if runtime.digest != snapshot.execution["runtime_digest"]:
                raise JobConflict("原任务绑定的 PPT 运行资源版本已变化，不能自动切换版本")
        return self.repository.resume(job_id, context)

    def confirm(self, job_id: str, stage_id: str, revision: int, answer: dict, context: ExtensionContext) -> dict:
        job = self.get(job_id, context)
        if job["kind"].startswith("ppt."):
            raise JobConflict("PPT 任务必须通过原制作流程的真实确认提交")
        if job["kind"] not in self.handlers:
            raise JobConflict("原任务适配器不可用")
        resolve_snapshot(ExtensionRunSnapshot.model_validate(job["snapshot"]), context)
        guard = getattr(self.handlers[job["kind"]], "validate_resume", None)
        if guard is not None:
            guard(job, context)
        if job["kind"] in self.model_budget_kinds and (job["checkpoint"].get("budget_exhausted") or "budget" in answer):
            from .model_ledger import JobModelCallLedger
            return JobModelCallLedger(self.repository, clock=self.repository.clock).add_budget(job_id, stage_id, revision, answer, context)
        return self.repository.confirm(job_id, stage_id, revision, answer, context)

    def events(self, job_id: str, context: ExtensionContext, *, after: int = 0) -> list[dict]:
        return self.repository.events(job_id, context, after=after)


job_service = JobService()
