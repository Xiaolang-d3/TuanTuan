"""Host-owned, version-fenced persistence after an authenticated official POST.

File hashes are consistency checks, not user signatures. Only the proxy may call
accept after a successful user POST and after stopping the confirmation server.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from ..db import connect
from ..execution.workspace_files import WorkspaceFiles
from ..jobs.repository import JobConflict, encoded
from ..workspace import current_workspace_root
from .manifest import ProjectManifestStore
from .receipts import _read_json, validate_final_receipt, validate_stage1_receipt


def project_name(job: dict) -> str:
    from .retry import state_for
    generation = state_for(job["id"])["generation"]
    version = f"_v{generation}" if generation else ""
    return f"deck_{job['id']}{version}_ppt169_{job['created_at'][:10].replace('-', '')}"


def project_root(job: dict) -> Path:
    boundary = current_workspace_root()
    return WorkspaceFiles(boundary / "jobs" / job["id"], boundary=boundary).path(project_name(job))


class ConfirmationFlow:
    def __init__(self, repository):
        self.repository = repository

    def load(self, scope, context) -> tuple[dict, Path, dict]:
        context.check_workspace()
        if context.user_id != scope.user_id:
            raise PermissionError("确认账号不匹配")
        job = self.repository.get(scope.job_id, context)
        checkpoint = job["checkpoint"]
        if (job["kind"] != "ppt.generate" or job["status"] != "waiting_user"
                or job["cancel_requested"] or job["stage_id"] != scope.stage_id
                or job["revision"] != scope.revision
                or checkpoint.get("manifest_sha256") != scope.manifest_sha256
                or checkpoint.get("source_version") != scope.source_version
                or checkpoint.get("stage") not in {"stage1_recommended", "stage2_recommended"}
                or checkpoint.get("external_outcome") == "unknown"):
            raise JobConflict("确认页面已过期或任务版本已改变")
        if job["execution"] and not job["execution"].get("stopped"):
            raise JobConflict("制作进程尚未停止，不能打开确认")
        root = project_root(job)
        manifest = ProjectManifestStore(self.repository, job, context, root).load()
        return job, root, manifest

    def reserve_submission(self, scope, context) -> None:
        job, _, _ = self.load(scope, context)
        with connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT status,stage_id,revision,cancel_requested,checkpoint_json FROM background_jobs WHERE id=?", (job["id"],)).fetchone()
            if (row is None or row["status"] != "waiting_user" or row["cancel_requested"]
                    or row["stage_id"] != scope.stage_id or row["revision"] != scope.revision
                    or json.loads(row["checkpoint_json"]) != job["checkpoint"]):
                raise JobConflict("确认页面已过期或任务版本已改变")
            if job["checkpoint"].get("confirmation_submission"):
                raise JobConflict("上次确认结果待核对，不能自动重复提交")
            checkpoint = {**job["checkpoint"], "confirmation_submission": {
                "stage_id": scope.stage_id, "revision": scope.revision, "status": "reserved"}}
            conn.execute("UPDATE background_jobs SET checkpoint_json=? WHERE id=?", (encoded(checkpoint), job["id"]))

    def accept(self, scope, context) -> dict:
        job, root, manifest = self.load(scope, context)
        if job["checkpoint"].get("confirmation_submission") != {
                "stage_id": scope.stage_id, "revision": scope.revision, "status": "reserved"}:
            raise JobConflict("缺少可信确认提交记录")
        files = WorkspaceFiles(root, boundary=current_workspace_root())
        stage = "stage1" if manifest["stage"] == "stage1_recommended" else "final"
        if stage == "stage1":
            binding = validate_stage1_receipt(root)
        else:
            stage1, _ = _read_json(files, "confirm_ui/recommendations.stage1.json")
            stage2, _ = _read_json(files, "confirm_ui/recommendations.stage2.json")
            binding = validate_final_receipt(root, stage1=stage1, stage2=stage2)["binding"]
        # Keep immutable stage-specific copies: the official next stage replaces
        # result.json, but must never change the previous user's contract.
        receipt_paths = []
        for filename, expected in (("result.json", binding["result_sha256"]),
                                   ("template_selection.json", binding["selection_receipt_sha256"])):
            content = files.read(f"confirm_ui/{filename}", limit=512_000)
            if hashlib.sha256(content).hexdigest() != expected:
                raise JobConflict("确认回执在读取期间发生变化")
            name = f"confirmed/{scope.stage_id}/{filename}"
            files.write(name, content)
            receipt_paths.append(name)
        store = ProjectManifestStore(self.repository, job, context, root)
        next_stage = "stage1_confirmed" if stage == "stage1" else "final_confirmed"
        new_manifest = {**manifest, "stage": next_stage, "source_version": scope.source_version + 1,
                        "files": store._hashes([*manifest["files"], *receipt_paths])}
        content = encoded(new_manifest).encode("utf-8")
        digest = hashlib.sha256(content).hexdigest()
        name = f"manifests/{digest}.json"
        files.write(name, content)
        answer = {**binding, "manifest_sha256": digest,
                  "source_version": new_manifest["source_version"], "receipt_paths": receipt_paths}
        confirmation = {"stage_id": scope.stage_id, "revision": scope.revision, "answer": answer}
        with connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT * FROM background_jobs WHERE id=?", (job["id"],)).fetchone()
            if (row is None or row["status"] != "waiting_user" or row["cancel_requested"]
                    or row["stage_id"] != scope.stage_id or row["revision"] != scope.revision
                    or json.loads(row["checkpoint_json"]) != job["checkpoint"]):
                raise JobConflict("确认页面已过期或任务版本已改变")
            checkpoint = {**job["checkpoint"], "stage": next_stage,
                          "source_version": new_manifest["source_version"],
                          "manifest_path": name, "manifest_sha256": digest}
            checkpoint.pop("confirmation_submission", None)
            conn.execute("UPDATE background_jobs SET status='queued',checkpoint_json=?,confirmation_json=?,"
                         "stage_id=NULL,prompt='',revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE id=?",
                         (encoded(checkpoint), encoded(confirmation), job["id"]))
            self.repository.event(conn, job["id"], "confirmed", confirmation)
        return self.repository.get(job["id"], context)
