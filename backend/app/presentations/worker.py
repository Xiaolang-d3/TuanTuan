"""Local PPT adapter with independently gated preparation and production."""
from __future__ import annotations

from ..branding import env
from ..extensions.runtime_snapshot import ExtensionRunSnapshot, resolve_snapshot
from ..jobs.repository import JobConflict
from .generation import GeneratePreparation
from .model_runner import PptModelRunner
from .service import preparation_enabled, production_enabled


def _enabled() -> bool:
    return preparation_enabled() and env("TUANTUAN_DEPLOYMENT_MODE", "local").strip().lower() == "local"


async def prepare_presentation(job: dict, control) -> dict:
    # Recheck at execution time as well as registration/creation. Restarted or
    # persisted jobs never bypass the opt-in, account or local-execution gates.
    if not _enabled():
        raise JobConflict("本机 PPT 准备流程尚未开放")
    repository, context = control.service.repository, control.context
    repository.check_owner(job["id"], job["owner_token"], context)
    snapshot = resolve_snapshot(ExtensionRunSnapshot.model_validate(job["snapshot"]), context)
    if job["kind"] != "ppt.generate" or snapshot.version != 2 or snapshot.execution is None:
        raise JobConflict("准备任务缺少固定的本机 PPT 执行绑定")
    checkpoint = repository.get(job["id"], context)["checkpoint"]
    if checkpoint.get("external_outcome") == "unknown" or checkpoint.get("confirmation_submission"):
        raise JobConflict("上次外部操作结果待核对，不能自动恢复准备流程")
    stage = checkpoint.get("stage")
    if stage == "final_confirmed":
        if not production_enabled():
            raise JobConflict("完整 PPT 制作尚未开放")
        # Validate both immutable confirmation receipts before starting execution.
        from .final_contract import load_final_contract
        from .production_contracts import resolve_production
        from .contracts import PresentationRequest
        contract = load_final_contract(repository, job, context)
        resolve_production(contract, requested_pages=PresentationRequest.model_validate(job["request"]).options.page_count)
        handle = await control.prepare_builtin_execution()
        from .production import GenerateProduction
        runner = PptModelRunner(repository, job, context, handle.files.root)
        return await GenerateProduction(repository, job, context, handle, runner).deliver(control)
    if stage not in {None, "sources_ready", "stage1_recommended", "stage1_confirmed", "stage2_recommended"}:
        raise JobConflict("当前阶段不属于已开放的准备流程，完整制作尚未就绪")

    handle = await control.prepare_builtin_execution()
    runner = PptModelRunner(repository, job, context, handle.files.root)
    preparation = GeneratePreparation(repository, job, context, handle, runner)
    if stage in {None, "sources_ready", "stage1_recommended"}:
        await preparation.prepare_stage1()
        await control.wait_for_user("请打开确认页，亲自确认需求与模板选择。")
    else:
        await preparation.prepare_stage2()
        await control.wait_for_user("请打开确认页，亲自确认设计方案与制作参数。")
    # The real control raises JobPaused. Even an incorrect injected control must
    # not let this recommendation-only adapter return and publish job success.
    raise JobConflict("准备流程必须停在真实用户确认处，不能作为制作成功返回")


def register_preparation_handler(jobs) -> bool:
    """Register only a trusted adapter on explicit local integration opt-in."""
    if not _enabled():
        return False
    existing = jobs.handlers.get("ppt.generate")
    if existing is not None and existing is not prepare_presentation:
        raise JobConflict("已有其他 PPT 执行适配器，不能自动替换")
    jobs.handlers["ppt.generate"] = prepare_presentation
    return True
