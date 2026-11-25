import json
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from xml.sax.saxutils import escape
from zipfile import ZipFile

import pytest
from fastapi.testclient import TestClient
from docx import Document

from api_client import register_authenticated_client
from document_fixtures import pdf_bytes
from app import db
from app.api import extensions
from app.api import presentations as api
from app.artifacts.service import ArtifactService
from app.execution.workspace_files import WorkspaceFiles
from app.extensions.contracts import ExtensionContext
from app.jobs.service import JobService
from app.jobs.worker import JobWorker
from app.main import app
from app.presentations import quick_service, quick_worker
from app.presentations.service import PresentationService, public_presentation
from app.workspace import ensure_workspace, use_workspace

IMAGE = "registry.example.com/quick-ppt@sha256:" + "a" * 64


@pytest.fixture
def hosted(tmp_path, monkeypatch):
    monkeypatch.setattr(db, "DB_PATH", tmp_path / "default.db")
    monkeypatch.setenv("TUANTUAN_DEPLOYMENT_MODE", "hosted")
    monkeypatch.setenv("TUANTUAN_QUICK_PPT_IMAGE", IMAGE)
    # Tests advance jobs explicitly; never race the API's background worker.
    monkeypatch.setattr("app.jobs.worker.JobWorkerManager.start", lambda self: None)
    db.init_db()
    jobs = JobService()
    quick_worker.register_quick_handler(jobs)
    service = PresentationService(jobs)
    monkeypatch.setattr(service, "_model", lambda profile: {"model_name": "fixture"})
    monkeypatch.setattr(api, "presentation_service", service)
    monkeypatch.setattr(extensions, "presentation_service", service)

    async def ready(backend):
        assert backend.image == IMAGE
        return SimpleNamespace(available=True)

    monkeypatch.setattr(quick_service.ContainerBackend, "probe", ready)
    with register_authenticated_client(app, "quick-owner@example.com") as owner, register_authenticated_client(app, "quick-other@example.com") as other:
        conversation = owner.post("/conversations", json={"title": "PPT 资料"}).json()["id"]
        user_id = owner.get("/auth/me").json()["user"]["id"]
        yield owner, other, conversation, user_id, jobs


def upload(owner, conversation, name, body):
    response = owner.post("/attachments", data={"conversation_id": str(conversation), "kind": "document"}, files={"file": (name, body, "text/plain")})
    assert response.status_code in {200, 201}, response.text
    attachment_id = response.json()["id"]
    parsed = owner.post(f"/attachments/{attachment_id}/parse", data={"mode": "fast"})
    assert parsed.status_code == 200, parsed.text
    return attachment_id


def test_hosted_attachment_only_and_idempotency(hosted, monkeypatch):
    owner, other, conversation, _, _ = hosted
    capability = f"/presentations/quick/capabilities?conversation_id={conversation}"
    assert TestClient(app).get(capability).status_code == 401
    assert owner.get(capability).json()["available"] is True
    assert owner.get("/extensions").json()["execution"]["adapter"] == "quick-ppt"
    attachment_id = upload(owner, conversation, "讲稿.txt", "架构资料唯一内容：规划与执行相分离".encode())
    body = {"topic": "", "conversation_id": conversation, "attachment_ids": [attachment_id], "idempotency_key": "attachment-only"}
    first = owner.post("/presentations/quick", json=body)
    assert first.status_code == 201, first.text
    job = first.json()
    assert job["source_count"] == 1 and not job["confirmation_required"]
    assert attachment_id not in first.text and "架构资料唯一内容" not in first.text
    assert other.get(f"/presentations/{job['id']}").status_code == 404
    generic = owner.get(f"/jobs/{job['id']}")
    assert generic.status_code == 200 and attachment_id not in generic.text and "topic_hash" not in generic.text
    assert owner.get(f"/presentations?conversation_id={conversation}").json()["jobs"] == [job]

    monkeypatch.delenv("TUANTUAN_QUICK_PPT_IMAGE")
    assert owner.get(capability).json()["available"] is False
    assert owner.post("/presentations/quick", json=body).json()["id"] == job["id"]
    assert owner.post("/presentations/quick", json={**body, "topic": "不同主题"}).status_code == 409


def test_rejects_empty_cross_conversation_and_oversized_inputs(hosted, monkeypatch):
    owner, _, conversation, _, _ = hosted
    another = owner.post("/conversations", json={"title": "另一个对话"}).json()["id"]
    attachment_id = upload(owner, another, "讲稿.txt", b"Source material")
    body = {"conversation_id": conversation, "idempotency_key": "invalid-quick"}
    assert owner.post("/presentations/quick", json=body).status_code == 422
    assert owner.post("/presentations/quick", json={**body, "attachment_ids": [attachment_id]}).status_code == 404
    attachment_id = upload(owner, conversation, "内容.txt", "架构资料".encode())
    monkeypatch.setattr(quick_service, "MAX_SOURCE_CHARS", 5)
    result = owner.post("/presentations/quick", json={**body, "topic": "主题", "attachment_ids": [attachment_id]})
    assert result.status_code == 422 and "请保留重点" in result.text


def test_word_and_text_pdf_use_existing_attachment_parsing(hosted):
    owner, _, conversation, _, _ = hosted
    doc = Document()
    doc.add_paragraph("清楚区分规划、执行和检查")
    output = BytesIO()
    doc.save(output)
    word = upload(owner, conversation, "讲稿.docx", output.getvalue())
    pdf = upload(owner, conversation, "讲稿.pdf", pdf_bytes("Plan, execute and verify."))
    body = {"conversation_id": conversation, "attachment_ids": [word, pdf], "idempotency_key": "real-documents"}
    result = owner.post("/presentations/quick", json=body)
    assert result.status_code == 201 and result.json()["source_count"] == 2, result.text
    partial = upload(owner, conversation, "缺少正文的页面.pdf", pdf_bytes("Readable page", ""))
    rejected = owner.post("/presentations/quick", json={**body, "attachment_ids": [partial], "idempotency_key": "partial-pdf"})
    assert rejected.status_code == 422 and "部分页面无法读取" in rejected.text


def editable_deck_bytes(plan):
    p = "http://schemas.openxmlformats.org/presentationml/2006/main"
    a = "http://schemas.openxmlformats.org/drawingml/2006/main"
    r = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
    rel = "http://schemas.openxmlformats.org/package/2006/relationships"
    ct = "http://schemas.openxmlformats.org/package/2006/content-types"
    buffer = BytesIO()
    page_ids, links = [], []
    with ZipFile(buffer, "w") as package:
        for number, slide in enumerate(plan["slides"], 1):
            page_ids.append(f'<p:sldId id="{255 + number}" r:id="rId{number}"/>')
            links.append(f'<Relationship Id="rId{number}" Type="{r}/slide" Target="slides/slide{number}.xml"/>')
            values = [slide["title"], slide["takeaway"], *(item[key] for item in slide["items"] for key in ("label", "text"))]
            shapes = "".join(f'<p:sp><p:txBody><a:p><a:r><a:t>{escape(value)}</a:t></a:r></a:p></p:txBody></p:sp>' for value in values)
            package.writestr(f"ppt/slides/slide{number}.xml", f'<p:sld xmlns:p="{p}" xmlns:a="{a}"><p:cSld><p:spTree>{shapes}</p:spTree></p:cSld></p:sld>')
        package.writestr("[Content_Types].xml", f'<Types xmlns="{ct}"><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/></Types>')
        package.writestr("ppt/presentation.xml", f'<p:presentation xmlns:p="{p}" xmlns:r="{r}"><p:sldIdLst>{"".join(page_ids)}</p:sldIdLst></p:presentation>')
        package.writestr("ppt/_rels/presentation.xml.rels", f'<Relationships xmlns="{rel}">{"".join(links)}</Relationships>')
    return buffer.getvalue()


@pytest.mark.anyio
@pytest.mark.parametrize("preview_ok,deck_mode", [(True, "correct"), (False, "correct"), (True, "corrupt"), (True, "wrong_content")])
async def test_worker_verifies_editable_deck_before_publishing(hosted, monkeypatch, preview_ok, deck_mode):
    owner, other, conversation, user_id, jobs = hosted
    attachment_id = upload(owner, conversation, "资料.txt", "任务拆解；联系邮箱：private@example.test".encode())
    submission = owner.post("/presentations/quick", json={"topic": "智能体架构", "conversation_id": conversation, "attachment_ids": [attachment_id], "idempotency_key": "generate"})
    assert submission.status_code == 201, submission.text
    job_id = submission.json()["id"]
    root = ensure_workspace(user_id)
    calls = []

    async def generate(model, stage, inputs, selection, *, instructions, retry_attempts):
        calls.append(stage)
        assert inputs["requirements"] == "智能体架构"
        assert inputs["sources"] == [{"source": 1, "text": "任务拆解；联系邮箱：[邮箱已隐藏]"}]
        assert retry_attempts == 1
        item = {"label": "拆解", "text": "明确边界"}
        return {"title": "智能体架构", "slides": [
            {"layout": "cover", "title": "智能体架构", "takeaway": "执行与核验", "items": []},
            {"layout": "points", "title": "核心步骤", "takeaway": "将复杂任务变简单", "items": [item, {"label": "核验", "text": "检查结果"}]},
            {"layout": "summary", "title": "下一步", "takeaway": "先跑通一个闭环", "items": [item]},
        ]}

    monkeypatch.setattr(quick_worker.PptModelRunner, "generate_stage", generate)

    class Runner:
        stopped = False
        directory = ""

        async def exec(self, argv, timeout):
            assert argv[:3] == ["python3", "-I", "/opt/quick-ppt/run.py"]
            files = WorkspaceFiles(root / "jobs" / job_id / self.directory)
            plan = json.loads(files.read("plan.json"))
            assert plan["title"] == "智能体架构"
            if argv[-1] == "export":
                if deck_mode == "wrong_content":
                    plan["slides"][1]["items"][0]["text"] = "模型未确认的内容"
                self.deck_bytes = b"not a zip" if deck_mode == "corrupt" else editable_deck_bytes(plan)
                files.write("deck.pptx", self.deck_bytes)
            elif preview_ok:
                for page in range(1, 4):
                    files.write(f"previews/{page:02}.png", b"mock page preview")
            else:
                return SimpleNamespace(returncode=1)
            return SimpleNamespace(returncode=0)

        async def stop(self):
            self.stopped = True

    runner = Runner()

    async def prepare(backend, context, selected_job, *, attempt, directory, fence):
        assert selected_job == job_id
        assert directory == f"quick-{attempt}"
        runner.directory = directory
        fence()
        return runner

    monkeypatch.setattr(quick_worker.ContainerBackend, "prepare", prepare)
    job = await JobWorker(jobs).run_once(user_id, root)
    assert calls == ["quick_plan"] and runner.stopped
    if deck_mode != "correct":
        assert job["status"] == "failed", job
        assert "未通过交付校验" in str(job["error"])
        listing = owner.get(f"/jobs/{job_id}/artifacts")
        assert listing.status_code == 200 and listing.json()["artifacts"] == []
        return
    assert job["status"] == "succeeded", job["error"]
    with use_workspace(user_id, root):
        context = ExtensionContext.current()
        result = public_presentation(job)
        assert result["page_count"] == 3 and result["preview_available"] is preview_ok
        artifacts = result["delivery_artifacts"]
        assert len(artifacts) == (4 if preview_ok else 1)
        deck = artifacts[0]
        assert Path(deck["filename"]).suffix == ".pptx"
        assert ArtifactService(jobs.repository).resolve(deck["id"], deck["version"], context).read_bytes() == runner.deck_bytes
    route = f"/artifacts/{deck['id']}/versions/{deck['version']}/file"
    response = owner.get(route)
    assert response.status_code == 200
    assert response.content == runner.deck_bytes
    assert response.headers["content-type"] == "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    with ZipFile(BytesIO(response.content)) as downloaded:
        assert downloaded.testzip() is None
        assert "检查结果".encode() in downloaded.read("ppt/slides/slide2.xml")
    assert other.get(route).status_code == 404
