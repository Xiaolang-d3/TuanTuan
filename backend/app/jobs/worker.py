from __future__ import annotations

import asyncio
from contextlib import suppress
from pathlib import Path

from ..db import init_db
from ..extensions.contracts import ExtensionContext
from ..extensions.runtime_snapshot import ExtensionRunSnapshot, resolve_snapshot
from ..models.base import ModelProviderError
from ..presentations.errors import PresentationOutputError
from ..redaction import known_secrets, redact_secrets
from ..workspace import list_user_ids, use_workspace
from .repository import JobConflict, JobExecutionError
from .service import JobService, job_service
from .model_ledger import ADDITION_SCHEMA, JobBudgetExceeded, JobModelCallLedger


class JobPaused(Exception):
    pass


async def stop_execution(job: dict, context: ExtensionContext) -> None:
    from ..execution.container_backend import ContainerBackend, container_name
    from ..execution.contracts import ExecutionUnavailable
    record = job["execution"]
    if record.get("backend") == "local_builtin":
        from ..execution.recovery import confirm_local_execution_stopped
        await confirm_local_execution_stopped(record)
        return
    if record.get("backend", "container") != "container":
        raise ExecutionUnavailable("未知执行方式，不能确认已停止")
    name = container_name(context, job["id"], record["attempt"])
    backend = ContainerBackend(image=record["image"])
    result = await backend.call(["rm", "--force", name], timeout=10)
    if result.returncode and "No such container" not in result.stderr:
        raise ExecutionUnavailable("无法确认原执行容器已停止")


class JobControl:
    def __init__(self, service: JobService, job: dict, context: ExtensionContext):
        self.service, self.job, self.context = service, job, context
        self.execution = None
        self.execution_attempt = None
        self.activity_ledger = None
        self.budget_exhausted = None

    def start_activity(self) -> None:
        if self.job["kind"] in self.service.model_budget_kinds:
            self.activity_ledger = JobModelCallLedger(self.service.repository, clock=self.service.repository.clock)
            self.activity_ledger.start_activity(self.job["id"], self.job["owner_token"], self.context)
        elif self.job["kind"].startswith("ppt.") and self.job["snapshot"].get("version") == 2:
            from ..presentations.model_ledger import ModelCallLedger
            ledger = ModelCallLedger(self.service.repository, clock=self.service.repository.clock)
            ledger.start_activity(self.job["id"], self.job["owner_token"], self.context)
            self.activity_ledger = ledger

    def refresh_activity(self) -> None:
        if self.activity_ledger is not None:
            self.activity_ledger.refresh_activity(self.job["id"], self.job["owner_token"], self.context)

    def stop_activity(self) -> None:
        if self.activity_ledger is not None:
            self.activity_ledger.stop_activity(self.job["id"], self.job["owner_token"], self.context)
            self.activity_ledger = None

    def check_activity_budget(self) -> None:
        if isinstance(self.activity_ledger, JobModelCallLedger):
            self.activity_ledger.check_budget(self.job["id"], self.context)
        elif self.activity_ledger is not None:
            from ..presentations.model_ledger import MAX_ACTIVE_SECONDS, PresentationBudgetExceeded
            budget = self.activity_ledger.status(self.job["id"], self.context)
            if budget["active_seconds"] >= MAX_ACTIVE_SECONDS:
                raise PresentationBudgetExceeded("已达到 1800 秒活动执行上限")

    def checkpoint(self, value: dict) -> None:
        self.service.repository.checkpoint(self.job["id"], self.job["owner_token"], value, self.context)

    async def wait_for_user(self, prompt: str, answer_schema: dict | None = None) -> None:
        await self.stop()
        self.check_activity_budget()
        self.stop_activity()
        self.service.repository.wait_for_user(self.job["id"], self.job["owner_token"], prompt, answer_schema or {"type": "object"}, self.context)
        raise JobPaused()

    async def pause_for_budget(self, prompt: str) -> None:
        """Independent exit: exhausted activity must never reject its own pause."""
        await self.stop()
        self.stop_activity()
        latest = self.service.repository.get(self.job["id"], self.context)
        if latest["cancel_requested"]:
            self.service.repository.release(self.job["id"], self.job["owner_token"], "cancelled", "任务已取消", self.context)
            raise JobPaused()
        checkpoint = latest["checkpoint"]
        checkpoint["budget_exhausted"] = True
        self.checkpoint(checkpoint)
        self.service.repository.wait_for_user(self.job["id"], self.job["owner_token"], prompt, ADDITION_SCHEMA, self.context)
        raise JobPaused()

    def attach_execution(self, handle) -> None:
        if self.execution is not None:
            raise ValueError("任务已绑定执行环境")
        self.execution = handle

    async def prepare_execution(self):
        from ..execution.container_backend import ContainerBackend
        from ..tools.workspace import workspace_tools
        snapshot = ExtensionRunSnapshot.model_validate(self.job["snapshot"])
        resolve_snapshot(snapshot, self.context)
        if "workspace.execute" not in snapshot.grants:
            raise PermissionError("此任务未获准使用隔离执行环境")
        if not snapshot.dependency_digest:
            raise JobConflict("原任务没有固定的执行依赖版本")
        if self.execution is not None:
            raise JobConflict("任务已绑定执行环境")
        token = self.job["owner_token"]
        record = {"attempt": token, "image": snapshot.dependency_digest, "stopped": False}
        self.service.repository.set_execution(self.job["id"], token, record, self.context)
        self.execution_attempt = token
        handle = await ContainerBackend(image=snapshot.dependency_digest).prepare(self.context, self.job["id"], attempt=token, fence=lambda: self.service.repository.check_owner(self.job["id"], token, self.context))
        self.attach_execution(handle)
        return workspace_tools(handle, revision=snapshot.dependency_digest)

    async def prepare_builtin_execution(self):
        from ..execution.local_builtin import LocalBuiltinBackend
        snapshot = ExtensionRunSnapshot.model_validate(self.job["snapshot"])
        resolve_snapshot(snapshot, self.context)
        if snapshot.version != 2 or snapshot.execution is None:
            raise PermissionError("任务没有固定的内置本机执行绑定")
        if self.execution is not None:
            raise JobConflict("任务已绑定执行环境")
        token = self.job["owner_token"]
        record = {**snapshot.execution, "attempt": token, "stopped": False}
        self.service.repository.set_execution(self.job["id"], token, record, self.context)
        self.execution_attempt = token

        def record_identity(identity):
            record["identity"] = identity
            self.service.repository.set_execution(self.job["id"], token, record, self.context)

        handle = await LocalBuiltinBackend().prepare(
            self.context, self.job["id"], runtime_digest=snapshot.execution["runtime_digest"],
            fence=lambda: self.service.repository.check_owner(self.job["id"], token, self.context),
            record_identity=record_identity,
        )
        self.attach_execution(handle)
        return handle

    async def stop(self) -> None:
        if self.execution is not None:
            await self.execution.stop()
            if self.execution_attempt:
                self.service.repository.mark_execution_stopped(self.job["id"], self.execution_attempt, self.context)
        elif self.execution_attempt:
            current = self.service.get(self.job["id"], self.context)
            if current["execution"].get("attempt") == self.execution_attempt:
                await stop_execution(current, self.context)
                self.service.repository.mark_execution_stopped(self.job["id"], self.execution_attempt, self.context)

    async def publish(self, relative_path: str, filename: str, content_hash: str) -> dict:
        from ..artifacts.service import ArtifactService
        # Freeze the entire workload before a host-side hash/copy. A container
        # must not mutate paths between containment validation and publication.
        await self.stop()
        self.check_activity_budget()
        return ArtifactService(self.service.repository).publish(self.job["id"], self.job["owner_token"], relative_path, filename, content_hash, self.context)


class JobWorker:
    def __init__(self, service: JobService, *, heartbeat_seconds: float = 5):
        self.service, self.heartbeat_seconds = service, heartbeat_seconds

    async def run_once(self, user_id: int, root: Path | None = None) -> dict | None:
        # Never inherit a request's workspace or the process-wide default DB.
        with use_workspace(user_id, root):
            init_db()
            context = ExtensionContext.current()
            repository = self.service.repository
            repository.interrupt_expired(context)
            for previous in repository.cleanup_candidates(context):
                try:
                    await stop_execution(previous, context)
                    repository.mark_execution_stopped(previous["id"], previous["execution"]["attempt"], context)
                except Exception:
                    # Keep interruption / pending cancellation visible; never
                    # announce stopped while the daemon outcome is uncertain.
                    continue
            if not self.service.handlers:
                return None
            job = repository.claim(context)
            if job is None:
                return None
            control = JobControl(self.service, job, context)

            async def execute():
                resolve_snapshot(ExtensionRunSnapshot.model_validate(job["snapshot"]), context)
                if job["execution"] and not job["execution"].get("stopped"):
                    raise JobConflict("原执行环境尚未确认停止")
                from ..artifacts.service import ArtifactService
                job["recovered_artifacts"] = ArtifactService(repository).reconcile(job["id"], job["owner_token"], context)
                handler = self.service.handlers.get(job["kind"])
                if handler is None:
                    raise JobConflict("原任务适配器不可用")
                control.start_activity()
                completed = False
                try:
                    result = await handler(job, control)
                    control.check_activity_budget()
                    completed = True
                    return result
                finally:
                    # Stop the workload before closing its active-time interval.
                    # If ownership was lost, keep the persisted interval for the
                    # next attempt's conservative lease-bound reconciliation.
                    if control.activity_ledger is not None:
                        await control.stop()
                        try:
                            if completed:
                                control.check_activity_budget()
                        finally:
                            with suppress(JobConflict):
                                control.stop_activity()

            task = asyncio.create_task(execute())
            async def heartbeat():
                while not task.done():
                    await asyncio.sleep(self.heartbeat_seconds)
                    try:
                        alive = repository.heartbeat(job["id"], job["owner_token"], context)
                        if alive:
                            control.refresh_activity()
                    except JobBudgetExceeded as exc:
                        control.budget_exhausted = str(exc)
                        task.cancel()
                        return
                    except Exception:
                        alive = False
                    if not alive:
                        task.cancel()
                        return
            pulse = asyncio.create_task(heartbeat())
            try:
                result = await task
                await control.stop()
                repository.finish(job["id"], job["owner_token"], result, context)
            except JobPaused:
                await control.stop()
            except JobBudgetExceeded as exc:
                with suppress(JobPaused):
                    await control.pause_for_budget(str(exc))
            except asyncio.CancelledError:
                try:
                    await control.stop()
                    if control.budget_exhausted and not repository.get(job["id"], context)["cancel_requested"]:
                        with suppress(JobPaused):
                            await control.pause_for_budget(control.budget_exhausted)
                    else:
                        status = "cancelled" if repository.get(job["id"], context)["cancel_requested"] else "interrupted"
                        repository.release(job["id"], job["owner_token"], status, "任务已停止" if status == "cancelled" else "工作进程已中断", context)
                except Exception:
                    repository.release(job["id"], job["owner_token"], "interrupted", "无法确认执行环境已停止，请检查后恢复", context)
            except Exception as exc:
                try:
                    await control.stop()
                except Exception:
                    repository.release(job["id"], job["owner_token"], "interrupted", "无法确认执行环境已停止", context)
                else:
                    if repository.get(job["id"], context)["cancel_requested"]:
                        repository.release(job["id"], job["owner_token"], "cancelled", "任务已取消", context)
                    else:
                        error = (redact_secrets(str(exc), known_secrets())[:500] if isinstance(exc, (ModelProviderError, JobExecutionError))
                                 else f"{type(exc).__name__}：任务执行失败")
                        if job["kind"].startswith("ppt.") and isinstance(exc, (ModelProviderError, PresentationOutputError)):
                            checkpoint = repository.get(job["id"], context)["checkpoint"]
                            checkpoint["model_error_code" if isinstance(exc, ModelProviderError) else "presentation_error_code"] = exc.code
                            if isinstance(exc, PresentationOutputError):
                                error = str(exc)
                            # Cleanup can outlive a lease. Diagnostic metadata
                            # must not prevent the owner-fenced terminal release.
                            with suppress(JobConflict, ValueError):
                                repository.checkpoint(job["id"], job["owner_token"], checkpoint, context)
                        repository.release(job["id"], job["owner_token"], "failed", error, context)
            finally:
                pulse.cancel()
                with suppress(asyncio.CancelledError):
                    await pulse
            return repository.get(job["id"], context)


class JobWorkerManager:
    def __init__(self, service: JobService):
        self.service = service
        self.loop_task: asyncio.Task | None = None
        self.tasks: dict[int, asyncio.Task] = {}
        self.cursor = 0

    def start(self) -> None:
        if self.loop_task is None:
            self.loop_task = asyncio.create_task(self.run())

    async def run(self) -> None:
        worker = JobWorker(self.service)
        while True:
            for finished_id, task in list(self.tasks.items()):
                if task.done():
                    with suppress(Exception, asyncio.CancelledError): task.result()
                    self.tasks.pop(finished_id)
            users = list_user_ids()
            if users:
                start = self.cursor % len(users)
                users = users[start:] + users[:start]
            for offset, user_id in enumerate(users):
                if user_id not in self.tasks and len(self.tasks) < 2:
                    self.tasks[user_id] = asyncio.create_task(worker.run_once(user_id))
                    self.cursor = (start + offset + 1) % len(users)
            await asyncio.sleep(1)

    async def close(self) -> None:
        if self.loop_task is not None:
            self.loop_task.cancel()
            with suppress(asyncio.CancelledError):
                await self.loop_task
            self.loop_task = None
        pending = list(self.tasks.values())
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        self.tasks.clear()
