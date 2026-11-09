from __future__ import annotations

import re
from pathlib import PurePosixPath
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


def safe_resource_path(value: str) -> str:
    # Also reject Windows drive, ADS, backslash and normalized-dot aliases.
    if not value or "\\" in value or ":" in value or "\x00" in value or value.startswith("/"):
        raise ValueError("资源路径必须是包内相对路径")
    if any(part in {"", ".", ".."} or part.endswith((" ", ".")) for part in value.split("/")):
        raise ValueError("资源路径不能越界或包含路径别名")
    return str(PurePosixPath(value))


class AdapterReference(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    adapter: Literal["ppt-master"]


class ExtensionManifest(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True)
    api_version: Literal[1]
    id: str = Field(pattern=r"^[a-z0-9][a-z0-9._-]{0,79}$")
    name: str = Field(min_length=1, max_length=100)
    version: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=1000)
    minimum_app_version: str = "0.0.0"
    platforms: list[str] = Field(default_factory=list, max_length=10)
    skills: list[str] = Field(default_factory=list, max_length=30)
    tools: list[AdapterReference] = Field(default_factory=list, max_length=20)
    mcp_servers: list[dict] = Field(default_factory=list, max_length=10)
    dependencies: list[str] = Field(default_factory=list, max_length=30)
    permissions: list[str] = Field(default_factory=list, max_length=30)
    artifact_types: list[str] = Field(default_factory=list, max_length=20)
    files: dict[str, str] = Field(default_factory=dict, max_length=100)

    @field_validator("skills")
    @classmethod
    def validate_skills(cls, values: list[str]) -> list[str]:
        return [safe_resource_path(value) for value in values]

    @field_validator("files")
    @classmethod
    def validate_files(cls, values: dict[str, str]) -> dict[str, str]:
        seen = set()
        for path, digest in values.items():
            safe_resource_path(path)
            if path.casefold() in seen or not re.fullmatch(r"[a-f0-9]{64}", digest):
                raise ValueError("资源清单存在重复路径或无效 SHA-256")
            seen.add(path.casefold())
        return values
