from __future__ import annotations

"""用户可见的产品更新精选。

条目从 CHANGELOG.md 的 [Unreleased] 顶部条目提炼，供首页「团团动态」
区块直接展示。每条包含分类、一句话描述与版本号；接口默认取前 6 条。
"""

HIGHLIGHTS: list[dict[str, str]] = [
    {
        "category": "微信渠道",
        "text": "微信私聊直达团团：扫码绑定、语音转写、侧边栏未读角标，消息加密保存。",
        "version": "Unreleased",
    },
    {
        "category": "文档与资料",
        "text": "文档资料支持 DOCX/PDF 解析与 OCR，对话可保存为文档并离线导出 DOCX/PDF。",
        "version": "Unreleased",
    },
    {
        "category": "PPT 制作",
        "text": "本地 AI PPT 工作流默认开放：会话内提出要求，后台制作、逐页预览、可编辑 PPTX 下载。",
        "version": "Unreleased",
    },
    {
        "category": "模型服务",
        "text": "模型管理接入统一服务与模型目录，跨服务切换聊天与图片模型，按用途分别设置默认。",
        "version": "Unreleased",
    },
    {
        "category": "安全",
        "text": "登录令牌不再持久化，只保存在当前浏览器会话；所有响应补充安全头，禁止第三方嵌套。",
        "version": "Unreleased",
    },
    {
        "category": "品牌",
        "text": "产品更名为「团团」，定位智能工作伙伴：「理解你的想法，帮你把事情做好。」",
        "version": "Unreleased",
    },
]
