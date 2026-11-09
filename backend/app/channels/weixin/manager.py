from __future__ import annotations

from ...workspace import current_user_id, current_workspace_root, list_user_ids, workspace_root_for
from .service import WeixinService


class WeixinManager:
    def __init__(self):
        self.channels = {}

    def current(self):
        user_id, root = current_user_id(), current_workspace_root()
        if user_id is None or root is None:
            raise ValueError("需要登录后连接微信")
        key = (user_id, str(root.resolve()))
        if key not in self.channels:
            self.channels[key] = WeixinService(user_id, root)
        return self.channels[key]

    def restore(self):
        for user_id in list_user_ids():
            root = workspace_root_for(user_id)
            if (root / '.weixin' / 'channel.sqlite3').exists():
                channel = WeixinService(user_id, root)
                self.channels[(user_id, str(root.resolve()))] = channel
                channel.start()

    async def close(self):
        for channel in self.channels.values():
            await channel.close()
        self.channels.clear()


manager = WeixinManager()
