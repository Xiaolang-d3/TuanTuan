import asyncio
import hashlib
from types import SimpleNamespace

import pytest

from app.jobs.repository import JobConflict
from test_ppt_final_contract import finalized
from test_ppt_generate import preparation


def build(state):
    from app.presentations.production import GenerateProduction, SPEC_REFERENCES, LOCK_REFERENCES
    p = state.p
    for name in (*SPEC_REFERENCES, *LOCK_REFERENCES):
        content = f"fixed production reference {name}".encode()
        path = f"vendor/ppt-master/{name}"
        p.vendor.write(path, content)
        p.preparer.handle.runtime.manifest["files"][path] = hashlib.sha256(content).hexdigest()
    runner = p.preparer.runner
    runner.job = p.job
    return GenerateProduction(p.repository, p.job, p.context, p.preparer.handle, runner)


def plan():
    return {"design_spec": "<!-- ppt-master-schema: design-spec/v1 -->\n" + "\n".join(
        f"## {n}. {name}\n完整内容" for n, name in zip(
            ("I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"),
            ("Project Overview", "Canvas Specification", "Visual Theme", "Typography System", "Layout Principles", "Icon Usage Specification", "Visualization Reference List", "Image Resource List", "Content Outline", "Speaker Notes Requirements"))),
        "slides": [{"id": f"P{i:02d}", "title": "测试", "content": "用户提供的内容", "kind": "text"} for i in range(1, 9)]}


def test_spec_requires_authenticated_final_contract_before_model(finalized):
    s = finalized
    producer = build(s)
    s.p.repository.checkpoint(s.p.job["id"], s.p.job["owner_token"], {"stage": "stage1_recommended"}, s.p.context)
    with pytest.raises(JobConflict):
        asyncio.run(producer.prepare_spec())
    assert len(s.p.calls) == 2


def test_invalid_spec_never_commits_or_calls_lock_stage(finalized):
    producer = build(finalized)
    finalized.p.output[0] = {"design_spec": "# fake", "slides": []}
    with pytest.raises(ValueError):
        asyncio.run(producer.prepare_spec())
    assert len(finalized.p.calls) == 3
    assert not producer.files.path("design_spec.md").exists()
    assert "production" not in finalized.p.repository.get(finalized.p.job["id"], finalized.p.context)["checkpoint"]


def test_design_spec_accepts_official_optional_visualization_section():
    from app.presentations.production import validate_design_plan
    value = plan()
    value["design_spec"] = value["design_spec"].replace("## VII. Visualization Reference List\n完整内容\n", "")
    assert len(validate_design_plan(value, SimpleNamespace(min_pages=8, max_pages=8)).slides) == 8


def test_missing_content_is_reported_as_clarification_before_audit_or_lock(finalized):
    producer = build(finalized)
    finalized.p.output[0] = {"clarification_required": True, "question": "这份知识分享具体讲什么主题？"}
    with pytest.raises(ValueError) as error:
        asyncio.run(producer.prepare_spec())
    assert getattr(error.value, "code", None) == "presentation_needs_details"
    assert "主题" in str(error.value)
    assert len(finalized.p.calls) == 3
    assert not producer.files.path("design_spec.md").exists()


def test_single_slide_clarification_never_passes_as_an_eight_page_plan():
    from app.presentations.production import validate_design_plan
    value = plan()
    value["slides"] = value["slides"][:1]
    with pytest.raises(ValueError) as error:
        validate_design_plan(value, SimpleNamespace(min_pages=8, max_pages=8))
    assert getattr(error.value, "code", None) == "presentation_page_count_mismatch"


def test_failed_fidelity_audit_blocks_lock_and_committed_spec(finalized, monkeypatch):
    producer = build(finalized)
    outputs = iter([plan(), {"passed": False, "issues": ["用户字体被改写"]}])

    async def generate(*args, **kwargs):
        return next(outputs)

    monkeypatch.setattr(producer.runner, "generate_stage", generate)
    with pytest.raises(JobConflict, match="一致"):
        asyncio.run(producer.prepare_spec())
    assert not producer.files.path("spec_lock.md").exists()
    assert "production" not in finalized.p.repository.get(finalized.p.job["id"], finalized.p.context)["checkpoint"]


def test_audited_spec_is_committed_separately_and_resumes_without_new_calls(finalized, monkeypatch):
    producer = build(finalized)
    calls = []
    outputs = iter([plan(), {"passed": True, "issues": []},
                    {"spec_lock": "<!-- ppt-master-schema: spec-lock/v1 -->\n# Execution Lock\n"},
                    {"passed": True, "issues": []}])

    async def generate(stage, *args, **kwargs):
        calls.append(stage)
        return next(outputs)

    monkeypatch.setattr(producer.runner, "generate_stage", generate)
    before = finalized.p.repository.get(finalized.p.job["id"], finalized.p.context)["checkpoint"].copy()
    first = asyncio.run(producer.prepare_spec())
    assert first[1]["stage"] == "spec_ready"
    assert asyncio.run(producer.prepare_spec()) == first
    assert calls == ["design_spec", "design_spec_audit", "spec_lock", "spec_lock_audit"]
    after = finalized.p.repository.get(finalized.p.job["id"], finalized.p.context)["checkpoint"]
    assert all(after[k] == v for k, v in before.items())
    assert not producer.files.path("svg_output/P01.svg").exists()


def test_modified_spec_blocks_resume_before_new_model_calls(finalized, monkeypatch):
    producer = build(finalized)
    producer.files.write("production/plan.json", b"{}")
    producer.files.write("design_spec.md", b"old")
    producer.production.commit("spec_ready", ["production/plan.json", "design_spec.md"])
    producer.files.write("design_spec.md", b"changed")
    with pytest.raises(ValueError):
        asyncio.run(producer.prepare_spec())
    assert len(finalized.p.calls) == 2


def ready_producer(finalized):
    producer = build(finalized)
    value = plan()
    producer.files.write("production/plan.json", __import__("json").dumps(value).encode())
    producer.files.write("design_spec.md", value["design_spec"].encode())
    producer.files.write("spec_lock.md", b"lock")
    producer.production.commit("spec_ready", ["production/plan.json", "design_spec.md", "spec_lock.md"])
    return producer


def test_page_authoring_validates_svg_and_commits_progress_without_receipts(finalized, monkeypatch):
    producer = ready_producer(finalized)
    from app.presentations.production import EXECUTOR_REFERENCES
    for name in EXECUTOR_REFERENCES:
        path = f"vendor/ppt-master/{name}"
        content = f"fixed executor authority {name}".encode()
        finalized.p.vendor.write(path, content)
        producer.handle.runtime.manifest["files"][path] = hashlib.sha256(content).hexdigest()
    stages = []
    async def generate(stage, inputs, *args, **kwargs):
        stages.append(stage)
        return {"svg": '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720"><text x="60" y="80">测试</text></svg>'}
    monkeypatch.setattr(producer.runner, "generate_stage", generate)
    producer.files.write("validation/text_calibration.json", b'{}')
    asyncio.run(producer.author_pages())
    assert stages == [f"page.p{i:02d}" for i in range(1, 9)]
    assert producer.production.load()["stage"] == "pages_ready"
    assert producer.files.path("svg_output/P08.svg").is_file()
    commands = [command for command, _ in finalized.p.commands]
    assert commands[-2:] == ["quality_check", "quality_check"]
    assert finalized.p.commands[-2][1]["stage"] == "early"
    assert finalized.p.commands[-1][1]["stage"] == "final"
    asyncio.run(producer.author_pages())
    assert len(stages) == 8


def test_unsafe_page_never_commits_and_repair_is_bounded(finalized, monkeypatch):
    producer = ready_producer(finalized)
    from app.presentations.production import EXECUTOR_REFERENCES
    for name in EXECUTOR_REFERENCES:
        path = f"vendor/ppt-master/{name}"
        content = name.encode()
        finalized.p.vendor.write(path, content)
        producer.handle.runtime.manifest["files"][path] = hashlib.sha256(content).hexdigest()
    stages = []
    async def generate(stage, *args, **kwargs):
        stages.append(stage)
        return {"svg": '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1280 720"><script>bad()</script></svg>'}
    monkeypatch.setattr(producer.runner, "generate_stage", generate)
    producer.files.write("validation/text_calibration.json", b'{}')
    with pytest.raises(ValueError):
        asyncio.run(producer.author_pages())
    assert stages == ["page.p01", "page.p01.repair1", "page.p01.repair2"]
    assert producer.production.load()["stage"] == "spec_ready"
    assert not producer.files.path("svg_output/P01.svg").exists()


def test_official_quality_errors_are_repaired_with_one_combined_report(finalized, monkeypatch):
    from app.execution.contracts import ProcessResult
    producer = ready_producer(finalized)
    stages, checks = [], []
    svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720"><text x="60" y="80">测试</text></svg>'

    async def generate(stage, inputs, *args, **kwargs):
        stages.append((stage, inputs))
        return {"svg": svg}

    async def run(command, args):
        if command == "quality_check":
            checks.append(args["stage"])
            if len(checks) == 1:
                return ProcessResult(1, "P01: text overflows; P01: missing bounds", "")
        return ProcessResult(0, "ok", "")

    monkeypatch.setattr(producer.runner, "generate_stage", generate)
    monkeypatch.setattr(producer.handle, "run", run)
    monkeypatch.setattr(producer, "_references", lambda *args, **kwargs: "authority")
    producer.files.write("validation/text_calibration.json", b"{}")
    asyncio.run(producer.author_pages())
    repairs = [(stage, inputs) for stage, inputs in stages if "quality" in stage]
    assert len(repairs) == 1
    assert "text overflows" in repairs[0][1]["official_quality_feedback"]
    assert "missing bounds" in repairs[0][1]["official_quality_feedback"]
    assert checks == ["early", "early", "final"]
    assert producer.production.load()["stage"] == "pages_ready"


def test_official_quality_repair_stops_after_two_rounds(finalized, monkeypatch):
    from app.execution.contracts import ProcessResult
    producer = ready_producer(finalized)
    stages = []

    async def generate(stage, *args, **kwargs):
        stages.append(stage)
        return {"svg": '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720"><text x="60" y="80">测试</text></svg>'}

    async def run(command, args):
        return ProcessResult(1, "P01: text overflows", "") if command == "quality_check" else ProcessResult(0, "ok", "")

    monkeypatch.setattr(producer.runner, "generate_stage", generate)
    monkeypatch.setattr(producer.handle, "run", run)
    monkeypatch.setattr(producer, "_references", lambda *args, **kwargs: "authority")
    producer.files.write("validation/text_calibration.json", b"{}")
    with pytest.raises(JobConflict, match="修复"):
        asyncio.run(producer.author_pages())
    assert len([stage for stage in stages if "quality" in stage]) == 2
    assert producer.production.load()["stage"] != "pages_ready"


def test_delivery_never_publishes_when_official_check_fails(finalized, monkeypatch):
    from app.execution.contracts import ProcessResult
    producer = ready_producer(finalized)
    producer.__dict__["options"] = SimpleNamespace(notes=False)
    async def pages():
        return SimpleNamespace(slides=[]), producer.production.load()
    async def run(command, args):
        return ProcessResult(1, "", "check failed")
    monkeypatch.setattr(producer, "author_pages", pages)
    monkeypatch.setattr(producer.handle, "run", run)
    published = []
    control = SimpleNamespace(publish=lambda *args: published.append(args))
    with pytest.raises(JobConflict):
        asyncio.run(producer.deliver(control))
    assert published == []


def test_delivery_requires_native_check_and_every_preview_before_publish(finalized, monkeypatch):
    from app.presentations import production
    from app.execution.contracts import ProcessResult
    from PIL import Image
    from io import BytesIO
    producer = ready_producer(finalized)
    producer.files.write("svg_output/P01.svg", b'<svg/>')
    async def pages():
        return SimpleNamespace(slides=[SimpleNamespace(id="P01")]), producer.production.load()
    async def generate(*args, **kwargs):
        return {"notes": [{"id": "P01", "text": "讲稿内容"}]}
    async def run(command, args):
        if command == "export":
            assert args["notes"] is True
            producer.files.write("exports/result.pptx", b"validated pptx fixture")
        if command == "render_preview":
            stream = BytesIO()
            Image.new("RGB", (1280, 720)).save(stream, format="PNG")
            producer.files.write("previews/P01.png", stream.getvalue())
        return ProcessResult(0, "ok", "")
    monkeypatch.setattr(producer, "author_pages", pages)
    monkeypatch.setattr(producer.runner, "generate_stage", generate)
    monkeypatch.setattr(producer, "_references", lambda *args, **kwargs: "notes authority")
    monkeypatch.setattr(producer.handle, "run", run)
    monkeypatch.setattr(production, "validate_delivery", lambda *args: {"slides": 1})
    published = []
    async def publish(path, filename, digest):
        published.append((path, filename, digest))
        assert producer.files.path("previews/P01.png").exists()
        return {"id": str(len(published)), "filename": filename, "version": 1}
    result = asyncio.run(producer.deliver(SimpleNamespace(publish=publish)))
    assert [name for _, name, _ in published] == ["result.pptx", "P01.png", "检查报告.txt"]
    assert len(result["artifacts"]) == 3
    assert producer.production.load()["stage"] == "delivery_ready"


def test_delivery_resumes_saved_notes_without_repeating_model_call(finalized, monkeypatch):
    from app.presentations import production
    from app.execution.contracts import ProcessResult
    from PIL import Image
    from io import BytesIO

    producer = ready_producer(finalized)
    producer.files.write("svg_output/P01.svg", b"<svg/>")
    producer.production.commit("pages_ready", [*producer.production.load()["files"], "svg_output/P01.svg"])
    calls, exports = [], []

    async def pages():
        return SimpleNamespace(slides=[SimpleNamespace(id="P01")]), producer.production.load()

    async def generate(stage, *args, **kwargs):
        calls.append(stage)
        return {"notes": [{"id": "P01", "text": "已经生成的讲稿"}]}

    async def run(command, args):
        if command == "export":
            exports.append(command)
            if len(exports) == 1:
                return ProcessResult(1, "", "transient local export failure")
            producer.files.write("exports/result.pptx", b"pptx")
        if command == "render_preview":
            stream = BytesIO()
            Image.new("RGB", (1280, 720)).save(stream, format="PNG")
            producer.files.write("previews/P01.png", stream.getvalue())
        return ProcessResult(0, "ok", "")

    async def publish(path, filename, digest):
        return {"id": filename, "filename": filename, "version": 1}

    monkeypatch.setattr(producer, "author_pages", pages)
    monkeypatch.setattr(producer.runner, "generate_stage", generate)
    monkeypatch.setattr(producer, "_references", lambda *args, **kwargs: "notes authority")
    monkeypatch.setattr(producer.handle, "run", run)
    monkeypatch.setattr(production, "validate_delivery", lambda *args: {"slides": 1})
    with pytest.raises(JobConflict):
        asyncio.run(producer.deliver(SimpleNamespace(publish=publish)))
    assert producer.production.load()["stage"] == "notes_ready"
    asyncio.run(producer.deliver(SimpleNamespace(publish=publish)))
    assert calls == ["speaker_notes"]
    assert "可编辑形状" in producer.files.read("validation/delivery.txt").decode()
def test_worker_dispatches_only_authenticated_final_contract(finalized, monkeypatch):
    from app.presentations.worker import prepare_presentation
    from app.presentations import production
    from types import SimpleNamespace
    p = finalized.p
    from app.extensions.runtime_snapshot import ExtensionRunSnapshot
    from app.execution.builtin_runtime import UPSTREAM_COMMIT
    p.job["snapshot"] = ExtensionRunSnapshot(version=2, user_id=p.context.user_id,
        model_selection=p.job["snapshot"]["model_selection"], grants=("builtin.ppt-master.execute",),
        execution={"backend": "local_builtin", "adapter": "ppt-master", "runtime_digest": "a" * 64,
                   "upstream_commit": UPSTREAM_COMMIT}).model_dump(mode="json")
    monkeypatch.setenv("TUANTUAN_DEPLOYMENT_MODE", "local")
    monkeypatch.setenv("TUANTUAN_PPT_PREPARATION_ENABLED", "true")
    monkeypatch.setenv("TUANTUAN_PPT_GENERATION_ENABLED", "true")
    calls = []

    async def prepare():
        calls.append("prepare")
        return p.preparer.handle

    async def deliver(instance, control):
        calls.append("deliver")
        assert instance.contract.final == finalized.result
        return {"artifacts": [{"id": "artifact", "version": 1, "filename": "result.pptx"}], "slides": 8}

    monkeypatch.setattr(production.GenerateProduction, "deliver", deliver)
    control = SimpleNamespace(service=SimpleNamespace(repository=p.repository), context=p.context,
                              prepare_builtin_execution=prepare)
    result = asyncio.run(prepare_presentation(p.job, control))
    assert calls == ["prepare", "deliver"] and result["slides"] == 8
