import importlib.util
import subprocess
from pathlib import Path

import pytest


def builder():
    path = Path(__file__).parents[1] / "scripts/build_ppt_runtime.py"
    spec = importlib.util.spec_from_file_location("ppt_runtime_builder", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_bundle_builder_refuses_existing_destination(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    target = tmp_path / "existing"
    target.mkdir()
    (target / "keep.txt").write_text("keep")
    with pytest.raises(ValueError, match="已存在"):
        builder().assemble_bundle(target, python_home=source, site_packages=source, skill=source, font=source / "font", font_license=source / "license")
    assert (target / "keep.txt").read_text() == "keep"


def test_bundle_builder_excludes_api_and_installer_packages(tmp_path):
    home = tmp_path / "python"
    packages = tmp_path / "site-packages"
    skill = tmp_path / "skill"
    for path, value in {
        home / "python.exe": b"python",
        home / "python312.dll": b"dll",
        home / "Lib/os.py": b"# os",
        home / "Lib/site-packages/private.py": b"do not copy",
        packages / "pptx/__init__.py": b"# pptx",
        packages / "pip/__init__.py": b"# pip",
        skill / "SKILL.md": b"skill",
        skill / "LICENSE": b"MIT",
    }.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(value)
    font, license = tmp_path / "font.otf", tmp_path / "OFL.txt"
    font.write_bytes(b"font")
    license.write_text("OFL")
    root = tmp_path / "bundle"
    manifest = builder().assemble_bundle(root, python_home=home, site_packages=packages, skill=skill, font=font, font_license=license)
    assert (root / "runtime/Lib/site-packages/pptx/__init__.py").is_file()
    assert not (root / "runtime/Lib/site-packages/private.py").exists()
    assert not (root / "runtime/Lib/site-packages/pip").exists()
    assert "runtime/python312.dll" in manifest["files"]
    assert manifest["python"] == "runtime/python.exe"


def test_official_file_list_excludes_untracked_scripts(tmp_path):
    source = tmp_path / "source"
    source.mkdir()
    (source / "python.exe").write_bytes(b"python")
    skill = tmp_path / "skill"
    skill.mkdir()
    (skill / "SKILL.md").write_text("official")
    (skill / "injected.py").write_text("not official")
    font = tmp_path / "font"
    font.write_bytes(b"font")
    manifest = builder().assemble_bundle(tmp_path / "bundle", python_home=source, site_packages=source, skill=skill, font=font, font_license=font, skill_files=["SKILL.md"])
    assert "vendor/ppt-master/SKILL.md" in manifest["files"]
    assert "vendor/ppt-master/injected.py" not in manifest["files"]


def test_git_file_list_preserves_chinese_and_space_paths(tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "--quiet", str(repo)], check=True)
    file = repo / "skills/ppt-master/中文 空格/资源.md"
    file.parent.mkdir(parents=True)
    file.write_text("official", encoding="utf-8")
    subprocess.run(["git", "-C", str(repo), "add", "."], check=True)
    tree = subprocess.check_output(["git", "-C", str(repo), "write-tree"], text=True).strip()
    module = builder()
    monkeypatch.setattr(module, "UPSTREAM_COMMIT", tree)
    assert module.official_skill_files(repo) == ["中文 空格/资源.md"]
