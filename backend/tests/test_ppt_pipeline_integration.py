"""Offline full workflow: only model responses are mocked; tools and receipts are real."""
import asyncio
import json
import os
import shutil
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace

import pytest

from app import db
from app.artifacts.service import ArtifactService
from app.attachments import service as attachments
from app.domain import ModelResponse
from app.extensions.contracts import ExtensionContext
from app.jobs.service import JobService
from app.jobs.worker import JobWorker
from app.presentations.confirmation import ConfirmationFlow, project_root
from app.presentations.confirmation_server import ConfirmationServerManager
from app.presentations.confirmation_constraints import UnsupportedPresentationInput, validate_submission
from app.presentations.contracts import PresentationRequest
from app.presentations.model_runner import PptModelRunner
from app.presentations.manifest import ProjectManifestStore
from app.presentations.service import PresentationService
from app.presentations.validation import validate_delivery
from app.workspace import use_workspace
from test_ppt_generate import PROSE, recommendation
from test_ppt_runtime_preview import installed_runtime
from test_ppt_runtime_smoke import author_fixture
from test_ppt_stage2_contracts import stage2


@pytest.mark.parametrize("loop_type", ["native", "windows-selector"] if os.name == "nt" else ["native"])
def test_real_worker_confirmations_export_and_publication(installed_runtime, tmp_path, monkeypatch, loop_type):
    from app.presentations import worker

    monkeypatch.setattr(db, "DB_PATH", tmp_path / "accounts.db")
    monkeypatch.setenv("TUANTUAN_PPT_RUNTIME", str(installed_runtime.root))
    seed = tmp_path / "fixture"
    seed.mkdir()
    author_fixture(seed)
    account = tmp_path / "account"
    stages, failures = [], []

    async def scenario():
        with use_workspace(1, account):
            db.init_db()
            context = ExtensionContext.current()
            store = attachments.AttachmentStore(local_root=tmp_path / "attachments")
            monkeypatch.setattr(attachments, "get_attachment_store", lambda: store)
            image = attachments.create_attachment(1, "image", "测试图片.png", (seed / "images/asset.png").read_bytes())
            image_name = image["id"] + ".png"

            def response(stage, inputs):
                if stage == "stage1":
                    return recommendation()
                if stage == "stage2":
                    result = stage2()
                    result["selection_sha256"] = inputs["selection_sha256"]
                    result["recommend"]["image_usage"] = ["provided"]
                    return result
                if stage.endswith("_audit"):
                    return {"passed": True, "issues": []}
                if stage == "design_spec":
                    return {"design_spec": (seed / "design_spec.md").read_text(encoding="utf-8").replace("asset.png", image_name),
                            "slides": [{"id": f"P{i:02d}", "title": title, "content": "离线集成验证", "kind": kind}
                                       for i, title, kind in [(1, "离线制作验证", "text"), (2, "图片路径验证", "image")]]}
                if stage == "spec_lock":
                    return {"spec_lock": (seed / "spec_lock.md").read_text(encoding="utf-8").replace("asset.png", image_name)}
                if stage.startswith("page."):
                    return {"svg": (seed / f"svg_output/{inputs['slide']['id']}.svg").read_text(encoding="utf-8").replace("asset.png", image_name)}
                assert stage == "speaker_notes", stage
                return {"notes": [{"id": f"P{i:02d}", "text": f"第 {i} 页讲解中文文字与图片交付。"} for i in (1, 2)]}

            class Runner(PptModelRunner):
                async def generate_stage(self, stage, inputs, selection, *, instructions):
                    stages.append(stage)
                    async def generate(request):
                        assert request.tools == [] and request.tool_choice == "none"
                        return ModelResponse(content=json.dumps(response(stage, inputs), ensure_ascii=False))
                    self.provider_factory = lambda _: SimpleNamespace(generate=generate)
                    return await super().generate_stage(stage, inputs, selection, instructions=instructions)

            monkeypatch.setattr(worker, "PptModelRunner", Runner)
            jobs = JobService()
            worker.register_preparation_handler(jobs)

            async def tracked(job, control):
                try:
                    return await worker.prepare_presentation(job, control)
                except Exception as exc:
                    from app.jobs.worker import JobPaused
                    if not isinstance(exc, JobPaused):
                        failures.append(repr(exc))
                    raise

            jobs.handlers["ppt.generate"] = tracked
            service = PresentationService(jobs, runtime_loader=lambda: installed_runtime,
                model_resolver=lambda: {"profile_id": "test", "profile_revision": 1, "connection_id": "test", "connection_revision": 1,
                                        "resolved_model_protocol": "openai", "api_key_configured": True})
            job = service.create(PresentationRequest(topic="离线制作验证", attachment_ids=[image["id"]],
                options={"page_count": 2, "image_source": "provided"}), context, "pipeline")
            executor = JobWorker(jobs)
            servers = ConfirmationServerManager()

            async def confirm(waiting, stage, payload):
                assert waiting["status"] == "waiting_user", failures
                assert not ArtifactService(jobs.repository).list_for_job(job["id"], context)
                scope = SimpleNamespace(user_id=1, job_id=job["id"], stage_id=waiting["stage_id"],
                    revision=waiting["revision"], source_version=waiting["checkpoint"]["source_version"],
                    manifest_sha256=waiting["checkpoint"]["manifest_sha256"])
                root = project_root(waiting)
                manifest = ProjectManifestStore(jobs.repository, waiting, context, root).load()
                invalid = deepcopy(payload)
                if stage == "stage1":
                    invalid["template_selection"]["mode"] = "templates"
                else:
                    invalid["proactive_custom_animations"] = True
                with pytest.raises(UnsupportedPresentationInput):
                    validate_submission(waiting, root, manifest, invalid)
                assert jobs.get(job["id"], context) == waiting
                validate_submission(waiting, root, manifest, payload)
                rec = await servers.request(1, job["id"], root, installed_runtime, stage, "GET", "/api/recommendations")
                assert rec.status_code == 200, rec.body
                if stage == "stage1":
                    payload["options_sha256"] = json.loads(rec.body)["template_options"]["options_sha256"]
                flow = ConfirmationFlow(jobs.repository)
                result = await servers.request(1, job["id"], root, installed_runtime, stage, "POST", "/api/confirm",
                    json.dumps(payload, ensure_ascii=False).encode(), before_submit=lambda: flow.reserve_submission(scope, context))
                await servers.close_job(1, job["id"])
                assert result.status_code == 200, result.body
                return flow.accept(scope, context)

            try:
                first = await executor.run_once(1, account)
                await confirm(first, "stage1", {"stage": "stage1", "canvas": "ppt169", "primary_language": "zh-CN",
                    **{key: "离线制作验证" for key in PROSE},
                    "template_selection": {"mode": "free_design", "selection_keys": []}})
                second = await executor.run_once(1, account)
                direction = stage2()["design_directions"]["candidates"][0]
                await confirm(second, "stage2", {"stage": "final", "canvas": "ppt169", "primary_language": "zh-CN",
                    **{key: "离线制作验证" for key in PROSE}, "page_count": "2", "image_usage": ["provided"],
                    "generation_mode": "continuous", "refine_spec": False, "design_spec_depth": "brief",
                    "proactive_speaker_notes": True, "proactive_custom_animations": False, "proactive_narration_audio": False,
                    "mode": "custom", "mode_behavior": "一页一个结论", "visual_style": "custom", "visual_style_behavior": "对齐留白",
                    "color": direction["color"], "typography": {**direction["typography"], "sizes": {"title": 40, "subtitle": 30, "annotation": 16}}})
                final = await executor.run_once(1, account)
            finally:
                await servers.close_all()
            assert final["status"] == "succeeded", failures
            assert stages == ["stage1", "stage2", "design_spec", "design_spec_audit", "spec_lock", "spec_lock_audit",
                              "page.p01", "page.p02", "speaker_notes"]
            artifacts = ArtifactService(jobs.repository)
            published = artifacts.list_for_job(job["id"], context)
            assert {item["filename"] for item in published} >= {"result.pptx", "P01.png", "P02.png", "检查报告.txt"}
            root = project_root(final)
            assert validate_delivery(root, root / "exports/result.pptx")["slides"] == 2
            if output := os.environ.get("PPT_PIPELINE_OUTPUT"):
                target = Path(output)
                target.mkdir(parents=True, exist_ok=True)
                for item in published:
                    shutil.copyfile(artifacts.resolve(item["id"], item["version"], context), target / item["filename"])

    if loop_type == "windows-selector":
        with asyncio.Runner(loop_factory=asyncio.SelectorEventLoop) as runner:
            runner.run(scenario())
    else:
        asyncio.run(scenario())
