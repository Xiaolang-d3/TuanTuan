"""Reject unsupported choices before the official UI writes any user receipt.

This is only input validation. It never creates a confirmation or authorizes
production; the authenticated, immutable receipt chain remains authoritative.
"""
import json
import re
from types import SimpleNamespace

from ..execution.workspace_files import WorkspaceFiles
from ..jobs.repository import JobConflict
from .contracts import PresentationRequest
from .production_contracts import resolve_production
from .receipts import _read_json


class UnsupportedPresentationInput(JobConflict):
    """A fixed, user-actionable message safe to display in the confirmation UI."""


def validate_submission(job: dict, root, manifest: dict, payload: dict) -> None:
    if payload["stage"] == "stage1":
        selection = payload.get("template_selection")
        if (not isinstance(selection, dict) or selection.get("mode") != "free_design"
                or selection.get("selection_keys", []) != []):
            raise UnsupportedPresentationInput("当前仅支持自由设计，请选择自由设计后重新提交")
        if payload.get("canvas", "ppt169") != "ppt169" or payload.get("primary_language", "zh-CN") != "zh-CN":
            raise UnsupportedPresentationInput("当前仅支持中文 16:9，请调整后重新提交")
        return
    # flow.load has checked the current manifest. Read only its immutable Stage 1
    # sources, never the mutable official result.json about to be overwritten.
    # wait_for_user clears the latest confirmation field when opening Stage 2.
    # Its committed Stage 1 files remain in the manifest; no final receipt can
    # exist yet. Preflight reads those values; production later verifies events.
    results = [path for path in manifest["files"] if re.fullmatch(r"confirmed/[a-f0-9]{32}/result\.json", path)]
    if len(results) != 1:
        raise JobConflict("设计确认缺少可信需求确认")
    paths = [results[0], results[0].removesuffix("result.json") + "template_selection.json"]
    if paths[1] not in manifest["files"]:
        raise JobConflict("设计确认缺少可信模板选择")
    files = WorkspaceFiles(root)
    stage1, result_hash = _read_json(files, paths[0])
    selection, selection_hash = _read_json(files, paths[1])
    if (result_hash != manifest["files"][paths[0]] or selection_hash != manifest["files"][paths[1]]
            or stage1.get("stage") != "stage1" or stage1.get("status") != "stage1-confirmed"):
        raise JobConflict("需求确认版本已改变")
    try:
        options = resolve_production(SimpleNamespace(final=payload, stage1=stage1, selection=selection),
            requested_pages=PresentationRequest.model_validate(job["request"]).options.page_count)
    except JobConflict as exc:
        raise UnsupportedPresentationInput(str(exc)) from None
    if options.provided_images:
        # The sources manifest is a list, unlike receipt JSON objects.
        sources = json.loads(files.read("sources/manifest.json", limit=100000))
        if not any(source.get("kind") == "image" for source in sources):
            raise UnsupportedPresentationInput("本任务未提供图片，请选择无图后重新提交")
