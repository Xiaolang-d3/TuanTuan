"""Read authenticated, version-bound user contracts without authoring any output.

The two confirmation events are host records of successful user submissions;
matching files or hashes alone never establish consent. Mutable confirmation UI
receipts are not authority. This is an evidence boundary, not a full production
options/capability gate or permission to skip specification review.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass

from ..db import connect
from ..execution.workspace_files import WorkspaceFiles
from ..jobs.repository import JobConflict, decode
from ..workspace import current_workspace_root
from . import confirmation
from .manifest import ProjectManifestStore
from .receipts import _read_json, _reject_constant, _selection_digest, _unique_object, canonical_sha256
from .stage_contracts import Stage1Recommendation, Stage2Recommendation

_HASH = re.compile(r"[a-f0-9]{64}\Z")
_STAGE_ID = re.compile(r"[a-f0-9]{32}\Z")
_STAGE1_PATH = "confirm_ui/recommendations.stage1.json"
_STAGE2_PATH = "confirm_ui/recommendations.stage2.json"


@dataclass(frozen=True)
class FinalContract:
    """Detached values, preserved exactly; recommendations never fill user blanks."""

    final: dict
    stage1: dict
    selection: dict
    stage1_recommendation: dict
    stage2_recommendation: dict
    source_version: int
    manifest_sha256: str


def _snapshot(repository, job, context):
    context.check_workspace()
    with connect() as conn:
        conn.execute("BEGIN")
        repository.assert_owner(conn, job["id"], job["owner_token"])
        try:
            live = decode(conn.execute("SELECT * FROM background_jobs WHERE id=?", (job["id"],)).fetchone())
            checkpoint = live["checkpoint"]
            if (live["kind"] != "ppt.generate" or not isinstance(checkpoint, dict)
                    or checkpoint.get("stage") != "final_confirmed"
                    or checkpoint.get("external_outcome") == "unknown"
                    or checkpoint.get("confirmation_submission")
                    or checkpoint.get("model_request_id")):
                raise JobConflict("当前任务没有可读取的最终确认合同，或仍需明确恢复")
            from .retry import unresolved_calls
            if unresolved_calls(conn, job["id"]):
                raise JobConflict("模型请求结果待核对，不能消费最终确认合同")
            # The general events API paginates at 200. Filter in SQL and fetch a
            # bounded third record so missing/duplicate confirmations fail closed.
            rows = conn.execute("SELECT data_json FROM background_job_events WHERE job_id=? AND type='confirmed' AND cursor>COALESCE((SELECT MAX(cursor) FROM background_job_events WHERE job_id=? AND type='requirements_updated'),0) ORDER BY cursor LIMIT 3",
                                (job["id"], job["id"])).fetchall()
            events = [json.loads(row[0], object_pairs_hook=_unique_object, parse_constant=_reject_constant) for row in rows]
        except (TypeError, KeyError, ValueError) as exc:
            raise JobConflict("最终确认的数据库记录无效或任务需要恢复") from exc
    if len(events) != 2 or live["confirmation"] != events[1]:
        raise JobConflict("缺少两阶段可信确认记录，或最终确认绑定已经改变")
    return live, events


def _binding(event, stage):
    if not isinstance(event, dict) or set(event) != {"stage_id", "revision", "answer"}:
        raise JobConflict("确认事件格式无效")
    stage_id, revision, answer = event["stage_id"], event["revision"], event["answer"]
    if (not isinstance(stage_id, str) or not _STAGE_ID.fullmatch(stage_id)
            or type(revision) is not int or revision < 1 or not isinstance(answer, dict)):
        raise JobConflict("确认事件缺少有效阶段及版本")
    hash_fields = {"stage1_sha256", "selection_sha256", "result_sha256",
                   "selection_receipt_sha256", "manifest_sha256"}
    if stage == "final":
        hash_fields.add("stage2_sha256")
    if (set(answer) != hash_fields | {"stage", "status", "source_version", "receipt_paths"}
            or answer.get("stage") != stage or answer.get("status") != "confirmed"
            or type(answer.get("source_version")) is not int or answer["source_version"] < 1
            or any(not isinstance(answer.get(key), str) or not _HASH.fullmatch(answer[key]) for key in hash_fields)):
        raise JobConflict("确认绑定字段或摘要无效")
    paths = [f"confirmed/{stage_id}/result.json", f"confirmed/{stage_id}/template_selection.json"]
    if answer["receipt_paths"] != paths:
        raise JobConflict("确认回执路径不属于可信阶段")
    return answer


def _committed_json(files, manifest, name):
    if name not in manifest["files"]:
        raise JobConflict("确认合同来源未提交到项目清单")
    value, digest = _read_json(files, name)
    # load() has checked all files, but read values must also match that snapshot
    # if a writer changes a file between manifest validation and this read.
    if digest != manifest["files"][name]:
        raise JobConflict("确认合同来源在读取期间改变")
    return value, digest


def _receipts(files, manifest, answer, stage):
    result, result_hash = _committed_json(files, manifest, answer["receipt_paths"][0])
    selection, selection_hash = _committed_json(files, manifest, answer["receipt_paths"][1])
    digest = _selection_digest(selection)
    if (result_hash != answer["result_sha256"] or selection_hash != answer["selection_receipt_sha256"]
            or result.get("stage") != stage
            or result.get("status") != ("stage1-confirmed" if stage == "stage1" else "confirmed")
            or result.get("stage1_sha256") != answer["stage1_sha256"]
            or result.get("selection_sha256") != digest or digest != answer["selection_sha256"]):
        raise JobConflict("确认合同与数据库绑定或模板选择不一致")
    return result, selection


def _stage1_manifest(files, manifest, answer):
    historical, digest = _read_json(files, f"manifests/{answer['manifest_sha256']}.json")
    if (digest != answer["manifest_sha256"]
            or set(historical) != {"version", "job_id", "stage", "source_version", "files"}
            or type(historical["version"]) is not int or historical["version"] != 1
            or historical["job_id"] != manifest["job_id"] or historical["stage"] != "stage1_confirmed"
            or type(historical["source_version"]) is not int or historical["source_version"] != answer["source_version"]
            or not isinstance(historical["files"], dict)
            or any(name not in historical["files"] for name in [*answer["receipt_paths"], _STAGE1_PATH])
            or any(name not in manifest["files"] or value != manifest["files"][name]
                   for name, value in historical["files"].items())):
        raise JobConflict("最终项目未保留可信 Stage 1 清单及合同来源")


def load_final_contract(repository, job, context) -> FinalContract:
    """Require a live owner and both authenticated confirmations; never mutate."""
    live, events = _snapshot(repository, job, context)
    first, final = _binding(events[0], "stage1"), _binding(events[1], "final")
    checkpoint = live["checkpoint"]
    if (final["manifest_sha256"] != checkpoint.get("manifest_sha256")
            or final["source_version"] != checkpoint.get("source_version")
            or events[0]["stage_id"] == events[1]["stage_id"]
            or not events[0]["revision"] < events[1]["revision"] < live["revision"]
            or first["source_version"] >= final["source_version"]
            or first["stage1_sha256"] != final["stage1_sha256"]
            or first["selection_sha256"] != final["selection_sha256"]
            or first["selection_receipt_sha256"] != final["selection_receipt_sha256"]):
        raise JobConflict("最终确认与两阶段版本链不一致")
    root = confirmation.project_root(live)
    files = WorkspaceFiles(root, boundary=current_workspace_root())
    manifest = ProjectManifestStore(repository, live, context, root).load()
    if (manifest["stage"] != "final_confirmed" or manifest["source_version"] != final["source_version"]
            or manifest["job_id"] != live["id"]):
        raise JobConflict("读取期间项目阶段已经改变")
    _stage1_manifest(files, manifest, first)
    stage1, first_selection = _receipts(files, manifest, first, "stage1")
    contract, selection = _receipts(files, manifest, final, "final")
    if selection != first_selection:
        raise JobConflict("最终确认改变了 Stage 1 的模板选择")
    if selection["mode"] != "free_design":
        raise JobConflict("已选模板缺少固定资源安装验收，不能降级为自由设计")
    recommendation1, _ = _committed_json(files, manifest, _STAGE1_PATH)
    recommendation2, _ = _committed_json(files, manifest, _STAGE2_PATH)
    if (canonical_sha256(recommendation1) != final["stage1_sha256"]
            or canonical_sha256(recommendation2) != final["stage2_sha256"]
            or recommendation2.get("selection_sha256") != final["selection_sha256"]):
        raise JobConflict("最终合同的推荐来源版本不一致")
    Stage1Recommendation.model_validate(recommendation1)
    Stage2Recommendation.model_validate(recommendation2)
    current, current_events = _snapshot(repository, job, context)
    if (any(current[key] != live[key] for key in ("revision", "checkpoint", "confirmation"))
            or current_events != events):
        raise JobConflict("最终合同读取期间任务版本已经改变")
    return FinalContract(final=contract, stage1=stage1, selection=selection,
                         stage1_recommendation=recommendation1, stage2_recommendation=recommendation2,
                         source_version=final["source_version"], manifest_sha256=final["manifest_sha256"])
