#!/usr/bin/env python3
"""Build the FastAPI server into Tauri's target-specific sidecar location.

Run once on every OS/architecture that will receive a release.  Cross-platform
releases must be built on native CI runners because PyInstaller does not cross
compile Python applications.
"""

from __future__ import annotations

import platform
import os
import shutil
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
BACKEND = ROOT / "backend"
TAURI_ROOT = ROOT / "desktop" / "src-tauri"
BINARIES = TAURI_ROOT / "binaries"
RUNTIME_RESOURCES = TAURI_ROOT / "resources"


def target_triple() -> str:
    system = platform.system()
    machine = platform.machine().lower()
    machine = {"arm64": "aarch64", "amd64": "x86_64"}.get(machine, machine)
    if system == "Darwin":
        return f"{machine}-apple-darwin"
    if system == "Windows":
        return f"{machine}-pc-windows-msvc"
    if system == "Linux":
        return f"{machine}-unknown-linux-gnu"
    raise RuntimeError(f"Unsupported packaging platform: {system}")


LITELLM_EXCLUDES = (
    "litellm.proxy.proxy_server",
    "litellm.proxy.management_endpoints",
    "litellm.proxy.guardrails",
    "litellm.proxy.ui_crud_endpoints",
    "litellm_enterprise",
    "litellm_proxy_extras",
    "litellm.rust_bridge._native",
    "prisma",
    "boto3",
    "botocore",
    "google.cloud",
    "uvloop",
)
# Data files litellm reads at runtime, relative to the litellm package.
# LiteLLM reads JSON/tokenizer data next to its modules at call time (cost map,
# provider endpoints, containers/endpoints.json, tokenizers, ...). A hand-kept
# list missed files, so bundle every runtime data file except the proxy server,
# the Rust bridge (disabled via LITELLM_RUST=False) and docs/type stubs.
LITELLM_DATA_SKIP_DIRS = ("proxy", "rust_bridge", "__pycache__")
LITELLM_DATA_SKIP_SUFFIXES = (".py", ".pyc", ".pyi", ".md", ".typed")


def litellm_data_files(package: Path) -> list[Path]:
    files = []
    for path in sorted(package.rglob("*")):
        relative = path.relative_to(package)
        if not path.is_file() or relative.parts[0] in LITELLM_DATA_SKIP_DIRS or "__pycache__" in relative.parts:
            continue
        if path.suffix in LITELLM_DATA_SKIP_SUFFIXES or path.name == "py.typed":
            continue
        files.append(path)
    return files


def build_python(pyinstaller: str) -> str:
    """The interpreter PyInstaller runs under, i.e. the one whose packages get bundled."""
    sibling = Path(pyinstaller).with_name("python.exe" if platform.system() == "Windows" else "python")
    return str(sibling) if sibling.is_file() else sys.executable


DEV_ONLY_MODULES = ("pytest", "_pytest", "pluggy", "iniconfig", "pygments")


def assert_runtime_only(python: str) -> None:
    """Refuse to bundle from an environment that has development packages."""
    present = subprocess.run(
        [python, "-I", "-c", "import importlib.util as u, sys; "
                             "print(' '.join(m for m in sys.argv[1:] if u.find_spec(m)))", *DEV_ONLY_MODULES],
        capture_output=True, text=True, check=True,
    ).stdout.split()
    if present:
        raise SystemExit(f"Build environment has development packages ({', '.join(present)}); "
                         "use backend/.venv-build (runtime + build locks).")


def litellm_arguments(python: str) -> list[str]:
    # Ask the build interpreter, not the one running this script: `npm run
    # package-sidecar` uses the system python3 while PyInstaller bundles the
    # backend venv. Asking the wrong one silently produced a partial LiteLLM.
    located = subprocess.run(
        [python, "-c", "import importlib.util as u; s = u.find_spec('litellm'); "
                       "print(next(iter(s.submodule_search_locations)) if s and s.submodule_search_locations else '')"],
        capture_output=True, text=True, check=False,
    ).stdout.strip()
    if not located:
        print("litellm is not installed; the sidecar will use TUANTUAN_MODEL_BACKEND=native")
        return []
    package = Path(located)
    print(f"Bundling LiteLLM from {package}")
    arguments = ["--collect-submodules", "litellm", "--hidden-import", "app.models.litellm_core",
                 "--hidden-import", "tiktoken_ext.openai_public", "--hidden-import", "tiktoken_ext"]
    for module in LITELLM_EXCLUDES:
        arguments += ["--exclude-module", module]
    for path in litellm_data_files(package):
        target = Path("litellm") / path.relative_to(package).parent
        arguments += ["--add-data", f"{path}{os.pathsep}{target.as_posix()}"]
    return arguments


def main() -> None:
    if platform.system() != "Darwin" or platform.machine().lower() not in {"arm64", "aarch64"}:
        raise SystemExit("The current internal desktop package supports macOS ARM64 only.")
    # Build venv = runtime lock + PyInstaller (requirements-build-lock.txt),
    # hash-installed and .pth-scanned by install_deps.sh on every build.
    build_venv = BACKEND / ".venv-build"
    subprocess.run([str(BACKEND / "scripts" / "install_deps.sh"), str(build_venv), "build"], check=True)
    pyinstaller = str(build_venv / "bin" / "pyinstaller")
    assert_runtime_only(build_python(pyinstaller))
    dist = RUNTIME_RESOURCES
    work = ROOT / "desktop" / ".sidecar-build"
    build_env = dict(os.environ)
    build_env["PYINSTALLER_CONFIG_DIR"] = str(ROOT / "desktop" / ".pyinstaller-cache")
    subprocess.run(
        [
            pyinstaller, "--noconfirm", "--clean", "--onedir", "--name", "tuantuan-runtime",
            "--paths", str(BACKEND), "--distpath", str(dist), "--workpath", str(work),
            "--specpath", str(work),
            "--add-data", f"{BACKEND / 'app' / 'password_policy.json'}{os.pathsep}app",
            "--add-data", f"{BACKEND / 'app' / 'password_policy-LICENSE.txt'}{os.pathsep}app",
            "--add-data", f"{BACKEND / 'app' / 'speech-models-NOTICE.txt'}{os.pathsep}app",
            "--add-data", f"{BACKEND / 'app' / 'speech-models.json'}{os.pathsep}app",
            "--add-data", f"{BACKEND / 'app' / '_vendor' / 'funasr_onnx' / 'LICENSE'}{os.pathsep}app/_vendor/funasr_onnx",
            "--add-data", f"{BACKEND / 'app' / 'agent' / 'skills' / 'image-design' / 'SKILL.md'}{os.pathsep}app/agent/skills/image-design",
            "--add-data", f"{BACKEND / 'app' / 'agent' / 'skills' / 'daily-news-curator' / 'SKILL.md'}{os.pathsep}app/agent/skills/daily-news-curator",
            # These are development or optional-model dependencies.  Runtime
            # imports are lazy and already fall back when an optional parser is
            # not installed; including them turns a compact local API into a
            # multi-gigabyte desktop sidecar.
            "--exclude-module", "pytest",
            "--exclude-module", "torch",
            "--exclude-module", "torchvision",
            "--exclude-module", "tensorflow",
            "--exclude-module", "docling",
            "--exclude-module", "docling_core",
            "--exclude-module", "docling_ibm_models",
            "--exclude-module", "transformers",
            "--exclude-module", "fastembed",
            "--exclude-module", "pandas",
            "--exclude-module", "scipy",
            "--exclude-module", "spacy",
            # Image OCR and document parsing remain optional. Offline speech
            # includes NumPy and the native FunASR ONNX components below.
            "--exclude-module", "rapidocr",
            "--exclude-module", "cv2",
            # FunASR ONNX inference and Kaldi feature extraction.
            "--collect-all", "onnxruntime",
            "--collect-all", "kaldi_native_fbank",
            "--collect-all", "av",
            "--exclude-module", "shapely",
            # LiteLLM model layer (docs/model-layer.md).  litellm is imported
            # lazily, so PyInstaller cannot see it: collect the SDK's Python
            # modules and only the data files it reads at runtime (offline cost
            # map, Anthropic beta headers, provider tables, tokenizers).  The
            # proxy server, its admin UI, enterprise hooks and the optional Rust
            # extension are never used by 团团 and stay out of the bundle.
            *litellm_arguments(build_python(pyinstaller)),
            str(BACKEND / "app" / "desktop_server.py"),
        ],
        check=True,
        cwd=BACKEND,
        env=build_env,
    )
    BINARIES.mkdir(parents=True, exist_ok=True)
    destination = BINARIES / f"tuantuan-server-{target_triple()}"
    subprocess.run(
        [
            "cc",
            "-arch",
            "arm64",
            "-Os",
            str(TAURI_ROOT / "sidecar-launcher.c"),
            "-o",
            str(destination),
        ],
        check=True,
    )
    print(destination)


if __name__ == "__main__":
    main()
