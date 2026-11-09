"""Strict, host-owned validation of the official confirmation receipts."""
from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

from ..execution.workspace_files import WorkspaceFiles
from ..jobs.repository import JobConflict

_HASH = re.compile(r"[a-f0-9]{64}\Z")


def canonical_sha256(value: object) -> str:
    content = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode("utf-8")
    return hashlib.sha256(content).hexdigest()


def _unique_object(pairs):
    value = {}
    for key, item in pairs:
        if key in value:
            raise ValueError("JSON 包含重复字段")
        value[key] = item
    return value


def _reject_constant(value):
    raise ValueError("非有限 JSON 数值")


def _read_json(files: WorkspaceFiles, name: str) -> tuple[dict, str]:
    try:
        content = files.read(name, limit=512_000)
        value = json.loads(content, object_pairs_hook=_unique_object,
                           parse_constant=_reject_constant)
    except (OSError, TypeError, ValueError, json.JSONDecodeError) as exc:
        raise JobConflict("官方确认回执缺失或格式无效") from exc
    if not isinstance(value, dict):
        raise JobConflict("官方确认回执必须是 JSON 对象")
    return value, hashlib.sha256(content).hexdigest()


def _selection_digest(selection: dict) -> str:
    fields = {"schema_version", "phase", "status", "mode", "selections", "options_sha256",
              "selection_sha256", "confirmed_at", "root_snapshots"}
    if (set(selection) != fields or type(selection.get("schema_version")) is not int
            or selection["schema_version"] != 1 or selection.get("phase") != "template"
            or selection.get("status") != "confirmed"
            or selection.get("mode") not in {"free_design", "templates"}
            or not isinstance(selection.get("confirmed_at"), str) or not selection["confirmed_at"]
            or not isinstance(selection.get("options_sha256"), str)
            or not _HASH.fullmatch(selection["options_sha256"])):
        raise JobConflict("模板选择回执格式无效")
    selections, snapshots = selection.get("selections"), selection.get("root_snapshots")
    if not isinstance(selections, list) or not isinstance(snapshots, list):
        raise JobConflict("模板选择及来源快照必须是数组")
    if selection["mode"] == "free_design":
        if selections or snapshots:
            raise JobConflict("自由设计不能携带模板或来源快照")
    else:
        # Templates additionally require installer validation before Stage 2.
        # A matching digest is never proof that these paths are trusted roots.
        if not selections or not snapshots or len(selections) > 4 or len(snapshots) > 4:
            raise JobConflict("模板选择缺少有效的安装来源快照")
        projected, kinds = [], set()
        try:
            for item in selections:
                if not isinstance(item, dict):
                    raise ValueError
                source, kind = item.get("source"), item.get("kind")
                expected = {"source", "kind", "workspace_root"} | ({"id"} if source == "library" else set())
                if (set(item) != expected or source not in {"library", "explicit"}
                        or kind not in {"brand", "style", "layout", "deck"} or kind in kinds
                        or not isinstance(item["workspace_root"], str) or not item["workspace_root"]
                        or (source == "library" and not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", item.get("id", "")))):
                    raise ValueError
                kinds.add(kind)
            for snapshot in snapshots:
                if not isinstance(snapshot, dict) or not isinstance(snapshot["files"], dict):
                    raise ValueError
                if sorted(spec["kind"] for spec in snapshot["specs"]) != snapshot["kinds"]:
                    raise ValueError
                for spec in snapshot["specs"]:
                    if spec["path"] not in snapshot["files"]:
                        raise ValueError
                    item = {"source": snapshot["source"], "kind": spec["kind"],
                            "workspace_root": snapshot["workspace_root"]}
                    if snapshot["source"] == "library":
                        item["id"] = spec["id"]
                    projected.append(item)
            if sorted(map(canonical_sha256, projected)) != sorted(map(canonical_sha256, selections)):
                raise ValueError
        except (KeyError, TypeError, ValueError):
            raise JobConflict("模板选择与来源快照不匹配") from None
    expected_digest = canonical_sha256({key: selection[key] for key in (
        "mode", "selections", "options_sha256", "root_snapshots")})
    if selection.get("selection_sha256") != expected_digest:
        raise JobConflict("模板选择内容与摘要不一致")
    return expected_digest


def validate_stage1_receipt(root: Path, *, recommendation: dict | None = None) -> dict:
    """Return only a small, non-user-authored binding record.

    The upstream UI is deliberately treated as an untrusted local client.  We
    consume the two files only as a matching pair and never forward their
    arbitrary fields into the jobs confirmation record.
    """
    files = WorkspaceFiles(root)
    result, result_sha256 = _read_json(files, "confirm_ui/result.json")
    selection, selection_file_sha256 = _read_json(files, "confirm_ui/template_selection.json")
    _selection_digest(selection)
    stored_recommendation, _ = _read_json(files, "confirm_ui/recommendations.stage1.json")
    if recommendation is not None and canonical_sha256(recommendation) != canonical_sha256(stored_recommendation):
        raise JobConflict("Stage 1 推荐与已保存版本不一致")
    recommendation = stored_recommendation
    if result.get("stage") != "stage1" or result.get("status") != "stage1-confirmed":
        raise JobConflict("尚未收到有效的 Stage 1 用户确认")
    if selection.get("status") != "confirmed" or selection.get("phase") != "template":
        raise JobConflict("Stage 1 模板选择回执无效")
    stage1_sha256 = result.get("stage1_sha256")
    selection_sha256 = result.get("selection_sha256")
    if not (isinstance(stage1_sha256, str) and isinstance(selection_sha256, str)
            and _HASH.fullmatch(stage1_sha256) and _HASH.fullmatch(selection_sha256)):
        raise JobConflict("官方确认回执缺少有效摘要")
    if selection.get("selection_sha256") != selection_sha256:
        raise JobConflict("Stage 1 两份回执的选择摘要不一致")
    if recommendation is not None and canonical_sha256(recommendation) != stage1_sha256:
        raise JobConflict("Stage 1 回执不属于当前推荐版本")
    return {
        "stage": "stage1",
        "status": "confirmed",
        "stage1_sha256": stage1_sha256,
        "selection_sha256": selection_sha256,
        "result_sha256": result_sha256,
        "selection_receipt_sha256": selection_file_sha256,
    }


def validate_final_receipt(root: Path, *, stage1: dict, stage2: dict) -> dict:
    """Bind a final user contract, without treating it as an installation gate.

    Callers must separately validate installed templates, capability bounds and
    the task/stage/manifest before advancing. Hashes detect version mismatch;
    they are not signatures and cannot prove a user submitted a confirmation.
    """
    files = WorkspaceFiles(root)
    result, result_hash = _read_json(files, "confirm_ui/result.json")
    selection, selection_hash = _read_json(files, "confirm_ui/template_selection.json")
    selection_digest = _selection_digest(selection)
    stored_stage1, _ = _read_json(files, "confirm_ui/recommendations.stage1.json")
    stored_stage2, _ = _read_json(files, "confirm_ui/recommendations.stage2.json")
    if (canonical_sha256(stored_stage1) != canonical_sha256(stage1)
            or canonical_sha256(stored_stage2) != canonical_sha256(stage2)):
        raise JobConflict("最终确认的推荐版本已经改变")
    if (result.get("stage") != "final" or result.get("status") != "confirmed"
            or stage1.get("stage") != "stage1" or stage2.get("stage") != "stage2"
            or result.get("stage1_sha256") != canonical_sha256(stage1)
            or result.get("selection_sha256") != selection_digest
            or stage2.get("selection_sha256") != selection_digest):
        raise JobConflict("最终确认不属于当前需求及模板选择版本")
    return {
        "contract": result,
        "binding": {"stage": "final", "status": "confirmed",
                    "stage1_sha256": canonical_sha256(stage1), "stage2_sha256": canonical_sha256(stage2),
                    "selection_sha256": selection_digest, "result_sha256": result_hash,
                    "selection_receipt_sha256": selection_hash},
    }
