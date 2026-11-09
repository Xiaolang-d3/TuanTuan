"""Build an offline Windows PPT runtime using a dedicated, hash-installed venv."""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import platform
import shutil
import subprocess
import sys
from pathlib import Path

UPSTREAM_COMMIT = "492a52b2b845927b0924b6eaaa495fc0dfc8f646"
FONT_SHA256 = "2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b"


def copy_resources(source: Path, destination: Path, *, exclude=()):
    for path in sorted(source.rglob("*")):
        relative = path.relative_to(source)
        if any(part in {"__pycache__", *exclude} for part in relative.parts) or path.suffix in {".pyc", ".pyo"}:
            continue
        if path.is_symlink() or (hasattr(path, "is_junction") and path.is_junction()):
            raise ValueError("运行包资源不能包含链接或 junction")
        if path.is_file():
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(path, target)


def official_skill_files(checkout: Path) -> list[str]:
    raw = subprocess.check_output(["git", "-C", str(checkout), "ls-tree", "-r", "-z", "--name-only", UPSTREAM_COMMIT, "--", "skills/ppt-master"])
    return [name.decode("utf-8").removeprefix("skills/ppt-master/") for name in raw.split(b"\x00") if name]


def assemble_bundle(destination: Path, *, python_home: Path, site_packages: Path, skill: Path, font: Path, font_license: Path, skill_files: list[str] | None = None) -> dict:
    if destination.exists():
        raise ValueError("目标目录已存在，请使用新的构建目录")
    destination.mkdir(parents=True)
    runtime = destination / "runtime"
    runtime.mkdir()
    for name in ("python.exe", "pythonw.exe", "python3.dll", "python312.dll", "vcruntime140.dll", "vcruntime140_1.dll", "LICENSE.txt"):
        if (python_home / name).is_file():
            shutil.copyfile(python_home / name, runtime / name)
    for name in ("Lib", "DLLs"):
        if (python_home / name).is_dir():
            copy_resources(python_home / name, runtime / name, exclude=("site-packages", "ensurepip", "test", "tests", "idlelib"))
    copy_resources(site_packages, runtime / "Lib/site-packages", exclude=("pip", "pip-24.3.1.dist-info", "tests"))
    if skill_files is None:
        copy_resources(skill, destination / "vendor/ppt-master")
    else:
        for name in skill_files:
            source = skill / name
            if source.is_symlink() or not source.resolve().is_relative_to(skill.resolve()):
                raise ValueError("官方技能文件不能越界")
            target = destination / "vendor/ppt-master" / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(source, target)
    host = destination / "host"
    host.mkdir()
    shutil.copyfile(Path(__file__).resolve().parents[1] / "app/execution/builtin_entry.py", host / "builtin_entry.py")
    shutil.copyfile(Path(__file__).resolve().parents[1] / "app/execution/render_preview.py", host / "render_preview.py")
    fonts = destination / "fonts"
    fonts.mkdir()
    shutil.copyfile(font, fonts / "NotoSansCJKsc-Regular.otf")
    shutil.copyfile(font_license, fonts / "OFL.txt")
    files = {}
    for path in sorted(destination.rglob("*")):
        if path.is_file():
            files[path.relative_to(destination).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    machine = {"amd64": "x86_64", "arm64": "aarch64"}.get(platform.machine().lower(), platform.machine().lower())
    manifest = {
        "version": 1, "adapter": "ppt-master", "upstream_commit": UPSTREAM_COMMIT,
        "skill_version": "6.7.3", "python": "runtime/python.exe", "skill": "vendor/ppt-master",
        "font": "fonts/NotoSansCJKsc-Regular.otf", "platform": f"{platform.system().lower()}-{machine}",
        "dependencies": {dist.metadata["Name"]: dist.version for dist in importlib.metadata.distributions() if dist.metadata["Name"].lower() != "pip"},
        "files": files,
    }
    (destination / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2), encoding="utf-8")
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkout", type=Path, required=True)
    parser.add_argument("--font", type=Path, required=True)
    parser.add_argument("--font-license", type=Path, required=True)
    parser.add_argument("--destination", type=Path, required=True)
    args = parser.parse_args()
    if sys.version_info[:2] != (3, 12) or platform.system() != "Windows" or sys.prefix == sys.base_prefix:
        raise SystemExit("Build using a dedicated CPython 3.12 Windows venv; other targets are not validated yet.")
    installed = {dist.metadata["Name"].lower() for dist in importlib.metadata.distributions()}
    if installed & {"fastapi", "pytest", "litellm", "uvicorn"}:
        raise SystemExit("Refusing to copy an API/development environment; use the dedicated PPT lock.")
    commit = subprocess.check_output(["git", "-C", str(args.checkout), "rev-parse", "HEAD"], text=True).strip()
    if commit != UPSTREAM_COMMIT:
        raise SystemExit("Upstream commit mismatch.")
    subprocess.run(["git", "-C", str(args.checkout), "diff", "--exit-code", UPSTREAM_COMMIT, "--", "skills/ppt-master"], check=True, stdout=subprocess.DEVNULL)
    if hashlib.sha256(args.font.read_bytes()).hexdigest() != FONT_SHA256:
        raise SystemExit("Pinned Noto Sans CJK SC font checksum mismatch.")
    skill_files = official_skill_files(args.checkout)
    manifest = assemble_bundle(args.destination.absolute(), python_home=Path(sys.base_prefix), site_packages=Path(sys.prefix) / "Lib/site-packages", skill=args.checkout / "skills/ppt-master", font=args.font, font_license=args.font_license, skill_files=skill_files)
    print(json.dumps({"destination": str(args.destination), "files": len(manifest["files"]), "upstream_commit": commit}))


if __name__ == "__main__":
    main()
