from __future__ import annotations

from pydantic import BaseModel, ConfigDict, Field

from ..workspace import current_user_id, current_workspace_root


class ExtensionContext(BaseModel):
    model_config = ConfigDict(frozen=True)
    user_id: int = Field(gt=0)
    conversation_id: int | None = None
    run_id: str | None = None

    @classmethod
    def current(cls) -> "ExtensionContext":
        user_id = current_user_id()
        if user_id is None or current_workspace_root() is None:
            raise PermissionError("扩展操作需要明确的用户工作区")
        return cls(user_id=user_id)

    def check_workspace(self) -> None:
        if current_user_id() != self.user_id or current_workspace_root() is None:
            raise PermissionError("扩展用户与当前工作区不一致")


class RegistrationOwner(BaseModel):
    model_config = ConfigDict(frozen=True)
    extension_id: str = Field(min_length=1)
    revision: str = Field(min_length=1)
