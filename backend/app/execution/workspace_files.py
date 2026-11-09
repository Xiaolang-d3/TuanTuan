from __future__ import annotations

import os
import stat
import uuid
from pathlib import Path

from ..extensions.manifest import safe_resource_path


def regular_file_stat(path: Path):
    result = path.stat()
    if not stat.S_ISREG(result.st_mode):
        raise ValueError("成果必须是普通文件，不能是管道、设备或目录")
    return result


def open_regular_file(path: Path):
    regular_file_stat(path)
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0))
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise ValueError("成果必须是普通文件")
        return os.fdopen(descriptor, "rb")
    except BaseException:
        os.close(descriptor)
        raise


def reject_links(path: Path, boundary: Path) -> None:
    if not path.absolute().is_relative_to(boundary.absolute()):
        raise ValueError("文件路径越过任务目录")
    for current in (path, *path.parents):
        if current.is_symlink() or (hasattr(current, "is_junction") and current.is_junction()):
            raise ValueError("任务文件不能经过链接或 junction")
        if current == boundary:
            break


class WorkspaceFiles:
    """Host-side staging only; callers must stop the container before reading outputs."""

    def __init__(self, root: Path, *, boundary: Path | None = None):
        self.root = root.absolute()
        self.boundary = (boundary or root).absolute()
        reject_links(self.root, self.boundary)
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)

    def path(self, name: str) -> Path:
        path = self.root / safe_resource_path(name)
        reject_links(path, self.boundary)
        if not path.resolve().is_relative_to(self.root.resolve()):
            raise ValueError("任务文件越界")
        return path

    def read(self, name: str, *, limit: int = 1_000_000) -> bytes:
        path = self.path(name)
        with open_regular_file(path) as file:
            content = file.read(limit + 1)
        if len(content) > limit:
            raise ValueError("文件超过允许读取的大小")
        return content

    def write(self, name: str, content: bytes, *, limit: int = 1_000_000) -> None:
        if len(content) > limit:
            raise ValueError("单次写入超过允许的大小")
        path = self.path(name)
        path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        temporary = path.parent / f".{uuid.uuid4().hex}.part"
        try:
            with temporary.open("xb") as file:
                file.write(content); file.flush(); os.fsync(file.fileno())
            reject_links(path, self.boundary)
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)
