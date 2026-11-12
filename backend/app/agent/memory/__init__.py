"""跨会话用户记忆：存储、抽取、检索与注入。

设计见 output/memory/design.md。本包只做本地 SQLite 存取与模型调用封装，
任何失败都静默处理，不影响主对话链路。
"""

from .context import memory_context_messages
from .service import extract_from_conversation

__all__ = ["extract_from_conversation", "memory_context_messages"]
