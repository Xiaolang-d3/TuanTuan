import hashlib
import json
import shutil
import sys
from pathlib import Path

import pytest

from app.execution import builtin_runtime as runtime


def bundle(tmp_path):
    """Tiny installed bundle: commands validate paths without launching fixtures."""
    root = tmp_path / "中文 runtime"
    root.mkdir()
    files = {
        "vendor/ppt-master/SKILL.md": b"official fixture",
        "vendor/ppt-master/scripts/svg_to_pptx.py": b"# exporter",
        "fonts/NotoSansCJKsc-Regular.otf": b"font fixture",
        "runtime/python.exe": b"python fixture",
        "host/builtin_entry.py": b"# entry fixture",
    }
    for name, content in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
    manifest = {
        "version": 1,
        "adapter": "ppt-master",
        "upstream_commit": runtime.UPSTREAM_COMMIT,
        "python": "runtime/python.exe",
        "skill": "vendor/ppt-master",
        "font": "fonts/NotoSansCJKsc-Regular.otf",
        "platform": runtime.platform_tag(),
        "dependencies": {"python-pptx": "1.0.2", "resvg-py": "0.5.0"},
        "files": {name: hashlib.sha256(content).hexdigest() for name, content in files.items()},
    }
    (root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return root, manifest


def test_runtime_defaults_to_backend_persistent_data(monkeypatch):
    for name in ("TUANTUAN_PPT_RUNTIME", "CAREERLOOP_PPT_RUNTIME", "DENGDENG_PPT_RUNTIME",
                 "TUANTUAN_DATA_DIR", "CAREERLOOP_DATA_DIR", "DENGDENG_DATA_DIR"):
        monkeypatch.delenv(name, raising=False)
    assert runtime.runtime_root() == Path(__file__).resolve().parents[1] / "data/ppt-runtime"


def test_runtime_loads_bundle_from_configured_data_dir(tmp_path, monkeypatch):
    root, _ = bundle(tmp_path)
    data_dir = tmp_path / "app-data"
    data_dir.mkdir()
    root.rename(data_dir / "ppt-runtime")
    monkeypatch.setenv("TUANTUAN_DATA_DIR", str(data_dir))
    monkeypatch.delenv("TUANTUAN_PPT_RUNTIME", raising=False)
    assert runtime.probe_ppt_runtime().available


def test_explicit_runtime_path_overrides_data_dir(tmp_path, monkeypatch):
    root, _ = bundle(tmp_path)
    monkeypatch.setenv("TUANTUAN_DATA_DIR", str(tmp_path / "app-data"))
    monkeypatch.setenv("TUANTUAN_PPT_RUNTIME", str(root))
    assert runtime.probe_ppt_runtime().available


def test_old_default_runtime_can_be_migrated_to_persistent_data(tmp_path, monkeypatch):
    from app.presentations.service import PresentationService, PresentationUnavailable

    root, _ = bundle(tmp_path)
    project = tmp_path / "project"
    legacy = project / "tmp/ppt-runtime"
    legacy.parent.mkdir(parents=True)
    root.rename(legacy)
    monkeypatch.setattr(runtime, "__file__", str(project / "backend/app/execution/builtin_runtime.py"))
    for name in ("TUANTUAN_PPT_RUNTIME", "CAREERLOOP_PPT_RUNTIME", "DENGDENG_PPT_RUNTIME",
                 "TUANTUAN_DATA_DIR", "CAREERLOOP_DATA_DIR", "DENGDENG_DATA_DIR"):
        monkeypatch.delenv(name, raising=False)

    status = runtime.probe_ppt_runtime()
    assert status.code == "runtime_missing"
    assert "tmp/ppt-runtime" in status.reason
    with pytest.raises(PresentationUnavailable, match="tmp/ppt-runtime"):
        PresentationService(jobs=None)._runtime()

    persistent = project / "backend/data/ppt-runtime"
    persistent.parent.mkdir(parents=True)
    shutil.copytree(legacy, persistent)
    assert runtime.probe_ppt_runtime().available


def test_runtime_missing_python_is_actionable(tmp_path):
    root, _ = bundle(tmp_path)
    (root / "runtime/python.exe").unlink()
    status = runtime.probe_ppt_runtime(root)
    assert not status.available
    assert status.code == "python_missing"
    assert "运行环境" in status.reason


@pytest.mark.parametrize("name", ["fonts/NotoSansCJKsc-Regular.otf", "vendor/ppt-master/scripts/svg_to_pptx.py"])
def test_modified_vendor_or_font_is_rejected(tmp_path, name):
    root, _ = bundle(tmp_path)
    (root / name).write_bytes(b"modified")
    status = runtime.probe_ppt_runtime(root)
    assert not status.available
    assert status.code == "integrity_failed"


def test_unregistered_command_and_extra_arguments_are_rejected(tmp_path):
    root, _ = bundle(tmp_path)
    project = tmp_path / "job"
    project.mkdir()
    installed = runtime.BuiltinRuntime.load(root)
    for command, args in [("shell", {"argv": ["cmd", "/c", "whoami"]}), ("export", {"project": "project", "script": "anything.py"}), ("export", {"project": "../other"})]:
        with pytest.raises(ValueError):
            installed.command(command, args, project)


def test_export_uses_pinned_python_script_and_task_paths(tmp_path):
    root, _ = bundle(tmp_path)
    project = tmp_path / "job"
    project.mkdir()
    argv = runtime.BuiltinRuntime.load(root).command("export", {"project": "deck"}, project)
    assert argv[0] == str(root / "runtime/python.exe")
    assert argv[1] == "-I"
    assert argv[2] == "-B"
    assert argv[3] == str(root / "host/builtin_entry.py")
    assert argv[4] == str(root / "vendor/ppt-master/scripts/svg_to_pptx.py")
    assert argv[5] == str(project / "deck")
    assert "--no-notes" in argv
    assert argv[argv.index("--output") + 1] == str(project / "deck/exports/result.pptx")
    assert "-c" not in argv


def test_runtime_digest_changes_with_manifest(tmp_path):
    root, manifest = bundle(tmp_path)
    before = runtime.BuiltinRuntime.load(root).digest
    manifest["dependencies"]["python-pptx"] = "1.0.3"
    (root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    assert runtime.BuiltinRuntime.load(root).digest != before


def test_export_respects_explicit_notes_and_uses_canonical_checks(tmp_path):
    root, manifest = bundle(tmp_path)
    for script in ("total_md_split.py", "text_measure.py", "svg_quality_checker.py"):
        name = f"vendor/ppt-master/scripts/{script}"
        (root / name).write_bytes(b"# fixed tool")
        manifest["files"][name] = hashlib.sha256(b"# fixed tool").hexdigest()
    (root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    installed = runtime.BuiltinRuntime.load(root)
    argv = installed.command("export", {"project": "deck", "notes": True}, tmp_path / "job")
    assert "--no-notes" not in argv
    assert "--pptx-structure" not in argv  # The validated lock owns structure.
    assert "--no-notes" in installed.command("export", {"project": "deck", "notes": False}, tmp_path / "job")
    assert "--outline" in installed.command("calibrate", {"project": "deck"}, tmp_path / "job")
    assert "total_md_split.py" in installed.command("split_notes", {"project": "deck"}, tmp_path / "job")[4]
    check = installed.command("quality_check", {"project": "deck", "stage": "early"}, tmp_path / "job")
    assert "--canonical-authoring" in check and check[check.index("--stage") + 1] == "early"
    for args in ({"project": "deck", "notes": "false"}, {"project": "deck", "notes": 1}):
        with pytest.raises(ValueError):
            installed.command("export", args, tmp_path / "job")


def test_preview_command_accepts_only_internal_slide_and_bundled_font(tmp_path):
    root, manifest = bundle(tmp_path)
    name = "host/render_preview.py"
    (root / name).write_bytes(b"# renderer")
    manifest["files"][name] = hashlib.sha256(b"# renderer").hexdigest()
    (root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    installed = runtime.BuiltinRuntime.load(root)
    args = {"project": "deck", "slide": "P01"}
    argv = installed.command("render_preview", args, tmp_path / "job")
    assert argv[3] == str(root / name)
    assert str(tmp_path / "job/deck/svg_output/P01.svg") in argv
    assert str(tmp_path / "job/deck/previews/P01.png") in argv
    assert str(root / manifest["font"]) in argv
    for slide in ("../other", "P00", "P21", "P01.svg"):
        with pytest.raises(ValueError):
            installed.command("render_preview", {**args, "slide": slide}, tmp_path / "job")


def test_manifest_cannot_reference_external_files(tmp_path):
    root, manifest = bundle(tmp_path)
    manifest["python"] = sys.executable
    (root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    assert not runtime.probe_ppt_runtime(root).available


def test_hosted_rejects_local_runtime(tmp_path, monkeypatch):
    root, _ = bundle(tmp_path)
    monkeypatch.setenv("TUANTUAN_DEPLOYMENT_MODE", "hosted")
    assert runtime.probe_ppt_runtime(root).code == "hosted_disabled"


def installed_commands(tmp_path):
    root, manifest = bundle(tmp_path)
    for name in ["scripts/project_manager.py", "scripts/apply_template.py", "scripts/analyze_images.py", "scripts/pptx_delivery_check.py", "templates/styles/fixture/templates/design_spec.md"]:
        relative = f"vendor/ppt-master/{name}"
        path = root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"# official fixture")
        manifest["files"][relative] = hashlib.sha256(path.read_bytes()).hexdigest()
    index_name = "vendor/ppt-master/templates/styles/styles_index.json"
    index = root / index_name
    index.write_text(json.dumps({"fixture": {"summary": "fixture"}}), encoding="utf-8")
    manifest["files"][index_name] = hashlib.sha256(index.read_bytes()).hexdigest()
    (root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    return runtime.BuiltinRuntime.load(root)


def test_init_uses_pinned_project_name_and_explicit_task_directory(tmp_path):
    installed = installed_commands(tmp_path)
    task = tmp_path / "task"
    task.mkdir()
    argv = installed.command("init", {"project": "中文/deck_ppt169_20261102"}, task)
    assert argv[5:] == ["init", "deck_ppt169_20261102", "--format", "ppt169", "--dir", str(task / "中文")]
    for project in ["deck", "deck_20261102", "--dir", "../deck_ppt169_20261102"]:
        with pytest.raises(ValueError):
            installed.command("init", {"project": project}, task)


def test_template_install_uses_only_registered_builtin_resources(tmp_path):
    installed = installed_commands(tmp_path)
    task = tmp_path / "task"
    task.mkdir()
    args = {"project": "deck", "roots": ["templates/styles/fixture"]}
    argv = installed.command("apply_template", args, task)
    assert argv[5:] == [str(task / "deck"), "--root", str(installed.root / "vendor/ppt-master/templates/styles/fixture")]
    for roots in [[], ["../outside"], ["scripts"], ["templates/styles/missing"], ["templates/styles/fixture"] * 2, [str(task)]]:
        with pytest.raises(ValueError):
            installed.command("apply_template", {"project": "deck", "roots": roots}, task)
    with pytest.raises(ValueError):
        installed.command("apply_template", {**args, "script": "x"}, task)


def test_template_directory_without_registered_index_entry_is_rejected(tmp_path):
    installed = installed_commands(tmp_path)
    (installed.root / "vendor/ppt-master/templates/styles/styles_index.json").write_text("{}")
    task = tmp_path / "task"
    task.mkdir()
    with pytest.raises(ValueError, match="注册"):
        installed.command("apply_template", {"project": "deck", "roots": ["templates/styles/fixture"]}, task)


def test_image_analysis_is_fixed_to_project_images(tmp_path):
    installed = installed_commands(tmp_path)
    task = tmp_path / "task"
    task.mkdir()
    assert installed.command("analyze_images", {"project": "deck"}, task)[5:] == [str(task / "deck/images")]


def test_delivery_checker_receives_exported_pptx_not_project_directory(tmp_path):
    installed = installed_commands(tmp_path)
    task = tmp_path / "task"
    task.mkdir()
    assert installed.command("delivery_check", {"project": "deck"}, task)[5:] == [str(task / "deck/exports/result.pptx")]


def test_injected_unlisted_python_module_is_rejected(tmp_path):
    root, _ = bundle(tmp_path)
    assert runtime.probe_ppt_runtime(root).available
    (root / "runtime/injected.py").write_text("raise RuntimeError('injected')")
    status = runtime.probe_ppt_runtime(root)
    assert not status.available
    assert status.code == "integrity_failed"
