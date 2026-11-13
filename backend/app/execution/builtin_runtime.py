"""Integrity-checked resources for the trusted, built-in PPT adapter only.

This is not a host sandbox and must never be exposed as an arbitrary command tool.
"""
from __future__ import annotations

import hashlib
import json
import platform
import re
from dataclasses import dataclass
from pathlib import Path

from ..branding import env
from ..extensions.manifest import safe_resource_path
from .workspace_files import reject_links

UPSTREAM_COMMIT = "492a52b2b845927b0924b6eaaa495fc0dfc8f646"
RUNTIME_MISSING_MESSAGE = (
    "PPT 本机运行包尚未准备好。旧版升级请将 tmp/ppt-runtime 完整复制到应用数据目录的 "
    "ppt-runtime，或设置 TUANTUAN_PPT_RUNTIME；新安装请先构建运行包。"
)
_HASH = re.compile(r"[a-f0-9]{64}\Z")


def platform_tag() -> str:
    machine = {"amd64": "x86_64", "arm64": "aarch64"}.get(platform.machine().lower(), platform.machine().lower())
    return f"{platform.system().lower()}-{machine}"


def runtime_root() -> Path:
    configured = env("TUANTUAN_PPT_RUNTIME", "")
    if configured:
        return Path(configured).absolute()
    data_dir = env("TUANTUAN_DATA_DIR", str(Path(__file__).resolve().parents[2] / "data"))
    return Path(data_dir).expanduser().absolute() / "ppt-runtime"


@dataclass(frozen=True)
class BuiltinRuntimeStatus:
    available: bool
    code: str
    reason: str
    runtime_digest: str = ""
    capabilities: tuple[str, ...] = ()


@dataclass(frozen=True)
class BuiltinRuntime:
    root: Path
    manifest: dict
    digest: str

    @classmethod
    def load(cls, root: Path | None = None) -> "BuiltinRuntime":
        root = (root or runtime_root()).absolute()
        reject_links(root / "manifest.json", root)
        path = root / "manifest.json"
        if path.stat().st_size > 16 * 1024 * 1024:
            raise ValueError("运行清单超过大小限制")
        manifest = json.loads(path.read_text(encoding="utf-8"))
        if manifest.get("version") != 1 or manifest.get("adapter") != "ppt-master" or manifest.get("upstream_commit") != UPSTREAM_COMMIT:
            raise ValueError("不支持的内置 PPT 运行资源版本")
        if manifest.get("platform") != platform_tag():
            raise ValueError("PPT 运行包与当前系统不匹配")
        files = manifest.get("files")
        if not isinstance(files, dict) or not files or len(files) > 50_000:
            raise ValueError("运行包缺少文件完整性清单")
        names = set()
        for name, digest in files.items():
            safe_resource_path(name)
            if name.casefold() in names or not isinstance(digest, str) or not _HASH.fullmatch(digest):
                raise ValueError("运行包清单重复或哈希无效")
            names.add(name.casefold())
        for field in ("python", "skill", "font"):
            name = safe_resource_path(manifest[field])
            if field != "skill" and name not in files:
                raise ValueError("关键资源不在完整性清单中")
        skill = manifest["skill"]
        if f"{skill}/SKILL.md" not in files:
            raise ValueError("运行包缺少完整技能资源")
        if "host/builtin_entry.py" not in files:
            raise ValueError("运行包缺少固定兼容入口")
        encoded = json.dumps(manifest, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
        return cls(root, manifest, hashlib.sha256(encoded).hexdigest())

    def path(self, name: str) -> Path:
        path = self.root / safe_resource_path(name)
        reject_links(path, self.root)
        if not path.resolve().is_relative_to(self.root.resolve()):
            raise ValueError("运行资源越界")
        return path

    def verify(self) -> None:
        expected_paths = {"manifest.json", *self.manifest["files"]}
        for path in self.root.rglob("*"):
            reject_links(path, self.root)
            if path.is_file() and path.relative_to(self.root).as_posix() not in expected_paths:
                raise ValueError("PPT 运行包中出现未登记文件")
        for name, expected in self.manifest["files"].items():
            path = self.path(name)
            if not path.is_file():
                raise ValueError("PPT 运行资源缺失，请重新准备运行包")
            digest = hashlib.sha256()
            with path.open("rb") as source:
                for chunk in iter(lambda: source.read(1024 * 1024), b""):
                    digest.update(chunk)
            if digest.hexdigest() != expected:
                raise ValueError("PPT 运行资源完整性校验失败，请重新准备运行包")

    def confirmation_command(self, root: Path, port: int) -> list[str]:
        """Host-only foreground service; never accept browser/model argv or ports."""
        if type(port) is not int or not 1024 <= port <= 65535:
            raise ValueError("确认服务端口无效")
        root = root.absolute()
        reject_links(root, Path(root.anchor))
        if not root.is_dir():
            raise ValueError("确认服务项目目录不存在")
        script = f"{self.manifest['skill']}/scripts/confirm_ui/server.py"
        names = (self.manifest["python"], "host/builtin_entry.py", script)
        if any(name not in self.manifest["files"] for name in names):
            raise ValueError("确认服务资源不在完整性清单中")
        return [str(self.path(names[0])), "-I", "-B", str(self.path(names[1])),
                str(self.path(script)), str(root.resolve()), "--port", str(port),
                "--no-browser", "--timeout", "900"]

    def command(self, command_id: str, args: dict, root: Path) -> list[str]:
        """Return fixed argv; user/model strings can never select a script or flag."""
        root = root.absolute()

        def project_path(value):
            path = root / safe_resource_path(value)
            reject_links(path, root)
            if not path.resolve().is_relative_to(root.resolve()):
                raise ValueError("PPT 任务路径越界")
            return str(path)

        if command_id == "render_preview":
            if (not isinstance(args, dict) or set(args) != {"project", "slide"}
                    or not isinstance(args["slide"], str) or not re.fullmatch(r"P(?:0[1-9]|1[0-9]|20)", args["slide"])):
                raise ValueError("无效的预览页面参数")
            name = "host/render_preview.py"
            if name not in self.manifest["files"]:
                raise ValueError("固定运行包缺少预览渲染入口，请更新运行包")
            return [str(self.path(self.manifest["python"])), "-I", "-B", str(self.path(name)),
                    project_path(f"{args['project']}/svg_output/{args['slide']}.svg"),
                    project_path(f"{args['project']}/previews/{args['slide']}.png"), str(self.path(self.manifest["font"]))]

        scripts = {
            "init": "project_manager.py",
            "apply_template": "apply_template.py",
            "analyze_images": "analyze_images.py",
            "validate_project": "project_manager.py",
            "scaffold_spec": "project_manager.py",
            "scaffold_lock": "project_manager.py",
            "finalize": "finalize_svg.py",
            "export": "svg_to_pptx.py",
            "delivery_check": "pptx_delivery_check.py",
            "quality_check": "svg_quality_checker.py",
            "check_annotations": "check_spec_annotations.py",
            "calibrate": "text_measure.py",
            "split_notes": "total_md_split.py",
        }
        if command_id not in scripts or not isinstance(args, dict):
            raise ValueError("不允许的内置 PPT 命令")
        expected = {"project", "roots"} if command_id == "apply_template" else {"project"}
        if command_id == "export" and "notes" in args:
            expected = {"project", "notes"}
            if type(args["notes"]) is not bool:
                raise ValueError("讲稿开关必须为布尔值")
        if command_id == "quality_check" and "stage" in args:
            expected = {"project", "stage"}
            if args["stage"] not in {"early", "final"}:
                raise ValueError("不允许的质量检查阶段")
        if set(args) != expected or not isinstance(args["project"], str):
            raise ValueError("PPT 命令参数不符合固定接口")
        target = project_path(args["project"])
        template_roots = []
        if command_id == "apply_template":
            roots = args["roots"]
            if not isinstance(roots, list) or not 1 <= len(roots) <= 4 or any(not isinstance(value, str) for value in roots) or len(set(roots)) != len(roots):
                raise ValueError("模板必须包含 1–4 个不同的内置资源根")
            for value in roots:
                value = safe_resource_path(value)
                parts = value.split("/")
                if len(parts) != 3 or parts[0] != "templates" or parts[1] not in {"brands", "styles", "layouts", "decks"}:
                    raise ValueError("模板只接受固定运行包中的注册资源")
                index_name = f"{self.manifest['skill']}/templates/{parts[1]}/{parts[1]}_index.json"
                if index_name not in self.manifest["files"]:
                    raise ValueError("运行包缺少模板注册索引")
                index_path = self.path(index_name)
                if index_path.stat().st_size > 1_000_000:
                    raise ValueError("模板注册索引超过限制")
                index = json.loads(index_path.read_text(encoding="utf-8"))
                if not isinstance(index, dict) or parts[2] not in index:
                    raise ValueError("模板没有在官方索引注册")
                name = f"{self.manifest['skill']}/{value}"
                if f"{name}/templates/design_spec.md" not in self.manifest["files"]:
                    raise ValueError("模板规范不在固定资源清单中")
                template_roots.append(str(self.path(name)))
        script_name = f"{self.manifest['skill']}/scripts/{scripts[command_id]}"
        if script_name not in self.manifest["files"]:
            raise ValueError("命令脚本不在运行资源清单中")
        if "host/builtin_entry.py" not in self.manifest["files"]:
            raise ValueError("PPT 运行包缺少固定兼容入口")
        argv = [str(self.path(self.manifest["python"])), "-I", "-B", str(self.path("host/builtin_entry.py")), str(self.path(script_name))]
        if command_id == "init":
            project = Path(target)
            # Pin the entire name so upstream cannot append today's date on resume.
            if not re.fullmatch(r"[\w-]+_ppt169_\d{8}", project.name):
                raise ValueError("项目名称必须固定 16:9 画布和创建日期")
            return argv + ["init", project.name, "--format", "ppt169", "--dir", str(project.parent)]
        if command_id in {"validate_project", "scaffold_spec", "scaffold_lock"}:
            argv += [{"validate_project": "validate", "scaffold_spec": "scaffold-spec", "scaffold_lock": "scaffold-lock"}[command_id]]
        output = project_path(f"{args['project']}/exports/result.pptx")
        command_target = str(Path(target) / "images") if command_id == "analyze_images" else target
        argv.append(output if command_id == "delivery_check" else command_target)
        for template in template_roots:
            argv += ["--root", template]
        if command_id == "export":
            argv += ["--output", output, "--primary-language", "zh-CN"]
            if not args.get("notes", False):
                argv += ["--no-notes"]
        if command_id == "quality_check":
            argv += ["--canonical-authoring", "--stage", args.get("stage", "final"), "--json"]
        if command_id == "calibrate":
            # text_measure owns a subcommand, unlike the project-path tools.
            argv.insert(5, "calibrate")
            argv += ["--outline"]
        return argv


def probe_ppt_runtime(root: Path | None = None) -> BuiltinRuntimeStatus:
    if env("TUANTUAN_DEPLOYMENT_MODE", "local").strip().lower() != "local":
        return BuiltinRuntimeStatus(False, "hosted_disabled", "本机 PPT 执行仅支持本地部署")
    try:
        runtime = BuiltinRuntime.load(root)
        if not runtime.path(runtime.manifest["python"]).is_file():
            return BuiltinRuntimeStatus(False, "python_missing", "PPT 专用运行环境缺少 Python，请重新准备运行包")
        runtime.verify()
    except FileNotFoundError:
        return BuiltinRuntimeStatus(False, "runtime_missing", RUNTIME_MISSING_MESSAGE)
    except (ValueError, OSError, KeyError, TypeError):
        return BuiltinRuntimeStatus(False, "integrity_failed", "PPT 运行包不完整或与当前系统不兼容，请重新准备")
    # Integrity is only one gate: the adapter/real workflow has not been accepted.
    return BuiltinRuntimeStatus(True, "resources_ready", "PPT 本机运行资源已校验，制作工作流仍需单独验收", runtime.digest)
