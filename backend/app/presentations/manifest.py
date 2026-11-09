"""Lease-fenced, content-addressed project checkpoints for PPT recovery."""
from __future__ import annotations

import hashlib
import json
import re
from types import SimpleNamespace

from ..db import connect
from ..execution.workspace_files import WorkspaceFiles, open_regular_file
from ..extensions.contracts import ExtensionContext
from ..jobs.repository import JobConflict, JobRepository, encoded

_HASH = re.compile(r"[a-f0-9]{64}\Z")
MAX_FILES = 500
MAX_PROJECT_BYTES = 64 * 1024 * 1024


class ProjectManifestStore:
    def __init__(self, repository: JobRepository, job: dict, context: ExtensionContext, root, *, namespace=None):
        context.check_workspace()
        if namespace not in {None, "production"}:
            raise ValueError("不允许的项目清单命名空间")
        self.repository, self.job, self.context = repository, job, context
        self.files = WorkspaceFiles(root)
        self.namespace = namespace

    def _checkpoint(self, checkpoint):
        return checkpoint.get(self.namespace, {}) if self.namespace else checkpoint

    def _hashes(self, paths: list[str]) -> dict[str, str]:
        if not isinstance(paths, list) or not paths or len(paths) > MAX_FILES:
            raise ValueError("项目清单必须包含 1–500 个文件")
        result, names, total = {}, set(), 0
        for name in paths:
            path = self.files.path(name)
            if name.split("/")[0].casefold() == "manifests" or name.casefold() in names:
                raise ValueError("项目清单不能重复或引用清单自身")
            names.add(name.casefold())
            digest = hashlib.sha256()
            with open_regular_file(path) as stream:
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    total += len(chunk)
                    if total > MAX_PROJECT_BYTES:
                        raise ValueError("项目源文件超过 64 MB")
                    digest.update(chunk)
            result[name] = digest.hexdigest()
        return result

    def _production_progress(self, hashes: dict[str, str]) -> dict:
        """Compute cheap API metadata from the same files this commit hashes."""
        pages = {name for name in hashes if re.fullmatch(r"svg_output/P(0[1-9]|1[0-9]|20)\.svg", name)}
        total = None
        if "production/plan.json" in hashes:
            content = self.files.read("production/plan.json", limit=200000)
            if hashlib.sha256(content).hexdigest() != hashes["production/plan.json"]:
                raise ValueError("设计计划校验失败")
            # Lazy import avoids the production/store import cycle. This is the
            # same strict validator used by the worker, without treating its
            # user-requested page suggestion as the actual total.
            from .production import validate_design_plan
            try:
                plan = validate_design_plan(json.loads(content), SimpleNamespace(min_pages=1, max_pages=20))
            except (ValueError, TypeError):
                pass  # Older manifests may not contain a validated plan.
            else:
                total = len(plan.slides)
                pages &= {f"svg_output/{slide.id}.svg" for slide in plan.slides}
        return {"pages_completed": len(pages), "pages_total": total}

    def commit(self, stage: str, paths: list[str]) -> dict:
        self.context.check_workspace()
        if not re.fullmatch(r"[a-z][a-z0-9_.:-]{0,79}", stage):
            raise ValueError("无效的演示文稿阶段")
        job_id, attempt = self.job["id"], self.job["owner_token"]
        self.repository.check_owner(job_id, attempt, self.context)
        checkpoint = self.repository.get(job_id, self.context)["checkpoint"]
        current = self._checkpoint(checkpoint)
        if checkpoint.get("external_outcome") == "unknown":
            raise JobConflict("模型请求结果不明，不能覆盖检查点")
        version = current.get("source_version", 0) + 1
        manifest = {"version": 1, "job_id": job_id, "stage": stage, "source_version": version, "files": self._hashes(paths)}
        progress = self._production_progress(manifest["files"]) if self.namespace == "production" else {}
        content = encoded(manifest).encode("utf-8")
        digest = hashlib.sha256(content).hexdigest()
        name = f"manifests/{digest}.json"
        self.files.write(name, content)
        # A crash before this transaction leaves an unreferenced candidate, never
        # a usable checkpoint. Re-read under the write lock to preserve all fences.
        with connect() as conn:
            conn.execute("BEGIN IMMEDIATE")
            self.repository.assert_owner(conn, job_id, attempt)
            checkpoint = json.loads(conn.execute("SELECT checkpoint_json FROM background_jobs WHERE id=?", (job_id,)).fetchone()[0])
            if checkpoint.get("external_outcome") == "unknown":
                raise JobConflict("模型请求结果不明，不能覆盖检查点")
            target = self._checkpoint(checkpoint)
            if target.get("source_version", 0) != version - 1:
                raise JobConflict("项目清单已被更新")
            updated = dict(target, stage=stage, source_version=version, manifest_path=name, manifest_sha256=digest, **progress)
            if self.namespace:
                checkpoint[self.namespace] = updated
            else:
                checkpoint = updated
            conn.execute("UPDATE background_jobs SET checkpoint_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=?", (encoded(checkpoint), job_id))
        return {"path": name, "sha256": digest, "source_version": version}

    def load(self) -> dict:
        self.context.check_workspace()
        checkpoint = self._checkpoint(self.repository.get(self.job["id"], self.context)["checkpoint"])
        name, digest = checkpoint.get("manifest_path"), checkpoint.get("manifest_sha256")
        if not isinstance(digest, str) or not _HASH.fullmatch(digest) or name != f"manifests/{digest}.json":
            raise JobConflict("任务没有已提交的项目清单")
        try:
            content = self.files.read(name, limit=100_000)
            if hashlib.sha256(content).hexdigest() != digest:
                raise ValueError("项目清单校验失败")
            manifest = json.loads(content)
            if not isinstance(manifest, dict) or set(manifest) != {"version", "job_id", "stage", "source_version", "files"}:
                raise ValueError("项目清单格式无效")
            if manifest["version"] != 1 or manifest["job_id"] != self.job["id"] or manifest["stage"] != checkpoint.get("stage") or manifest["source_version"] != checkpoint.get("source_version"):
                raise ValueError("项目清单不属于当前检查点")
            if not isinstance(manifest["files"], dict) or self._hashes(list(manifest["files"])) != manifest["files"]:
                raise ValueError("项目源文件校验失败")
        except (OSError, TypeError, KeyError) as exc:
            raise ValueError("项目清单或源文件校验失败") from exc
        return manifest
