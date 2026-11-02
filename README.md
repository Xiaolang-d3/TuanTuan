<div align="center">
  <img src="frontend/public/tuantuan-logo.png" alt="团团 Logo" width="88" height="88" />

# 团团 · 智能工作伙伴

**理解你的想法，帮你把事情做好。**

[![CI](https://github.com/Xiaolang-d3/TuanTuan/actions/workflows/ci.yml/badge.svg)](https://github.com/Xiaolang-d3/TuanTuan/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/Xiaolang-d3/TuanTuan?color=blue)](LICENSE)
[![Community Standards](https://img.shields.io/badge/Community-Standards-blue)](https://github.com/Xiaolang-d3/TuanTuan/community)

</div>

团团是一个开源、本地优先的智能工作伙伴。把问题、文件和想法带进对话，结合已有资料与公开来源完成研究、分析、起草和修改，再把有用的内容保存下来，留给下一次任务继续使用。

你可以选择自己的模型服务，决定哪些资料只存档、哪些允许长期参考，以及每轮对话是否联网。资料、会话和任务记录保存在本机；使用外部模型或搜索服务时，相关上下文或查询会发送至你配置的服务，**本地存储不等于全程离线**。

<div align="center">

[贡献指南](CONTRIBUTING.md) · [问题反馈](https://github.com/Xiaolang-d3/TuanTuan/issues/new/choose)

</div>

简历项目名称：**团团｜智能工作助手（个人项目）**

## 核心能力

| 能力 | 可以做什么 |
| --- | --- |
| **持续对话** | 围绕同一任务继续提问、分析、起草和修改；流式展示回答与执行进度，支持停止、重试和任务中断恢复。 |
| **联网研究** | 按需搜索公开信息，在回答中引用来源，并从参考来源面板打开原网页核对；支持 Tavily 或独立部署的 AgentSearch。 |
| **文件库与知识** | 导入 PDF、DOCX、TXT、Markdown 或粘贴文本，按文件夹和主题集合整理；预览原件、校正提取文字，选择一次对话使用或长期参考。 |
| **成果保存与复用** | 将对话中的有用内容存档，继续用于后续任务；推导出的知识先进入待确认队列，确认后再复用。配置兼容的生图模型后，也可在对话中生成、预览和下载图片。 |
| **多模型连接** | 管理多个模型服务和模型档案，在对话中切换；支持 OpenAI 兼容接口、Responses、Anthropic、Gemini、Ollama，以及备用模型策略。 |
| **开发者资讯首页** | 浏览 AI / Agent 动态、GitHub 日榜与周榜、关注仓库的 Releases 和工程实践；收藏线索，或带入对话继续分析。 |

多用户托管在单台服务器时，设置 `TUANTUAN_DEPLOYMENT_MODE=hosted` 和 `TUANTUAN_SECRET_MASTER_KEY`，各用户可在“设置 → 模型设置”中保存自己的模型连接。用 `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` 生成主密钥；通过服务器安全配置注入并单独备份，禁止提交到仓库。备份用户工作区时须保留其中的 `.model-secrets` 目录，并恢复到原数据路径（凭证引用与路径绑定）；主密钥丢失后，用户需要重新配置密钥。新用户不会自动继承服务器的模型环境变量，已有环境密钥引用仍保持兼容。

托管模式仅接受 HTTPS 和允许的模型服务域名：OpenAI、Anthropic、Gemini 官方域名默认允许，其他域名由管理员通过 `TUANTUAN_MODEL_ALLOWED_HOSTS`（逗号分隔）添加。本地模式不受此限制。该域名限制不能防止 DNS 重绑定和服务端重定向；部署时必须使用出站防火墙或安全代理阻止访问本机、私有网络和云元数据地址，并使用 HTTPS 保护用户到服务器的连接。

界面提供 **首页、AI 工作区、文件库、设置** 四个入口，支持浅色、深色和跟随系统外观。产品名称为团团，英文标识统一使用 `tuantuan`。

## 技术栈

- 前端：React 19、TypeScript、Vite、Vitest、Playwright
- 后端：Python 3.11+、FastAPI、Pydantic、LiteLLM SDK 与原生模型适配器
- 桌面：Tauri 2、Rust、FastAPI sidecar（当前仅 macOS ARM64 内部测试）
- 数据：SQLite、sqlite-vec、本地检索（可选 FastEmbed 向量）、本地附件；可选 MinIO
- 可选联网搜索：[Tavily](https://docs.tavily.com/documentation/api-reference/endpoint/search) API 或独立部署的 [AgentSearch](https://github.com/brcrusoe72/agent-search) 服务

## 项目结构

```text
TuanTuan/
├── backend/
│   ├── app/            # API 路由、资料库、聊天、Agent、解析及持久化
│   ├── tests/
│   ├── data/           # 本地 SQLite 与附件（不提交）
│   ├── .env.example
│   ├── requirements-dev.txt
│   ├── requirements.txt
│   ├── requirements-lock.txt # 运行时依赖的哈希锁定文件；开发用 requirements-dev-lock.txt，桌面构建加 requirements-build-lock.txt
│   └── requirements-optional.txt # 增强解析、语义向量与 OCR
├── frontend/
│   ├── src/
│   ├── e2e/
│   └── package.json
├── desktop/            # Tauri 壳、sidecar 打包与桌面冒烟测试
├── evals/              # 离线评测
├── .github/workflows/  # GitHub Actions
├── CHANGELOG.md
└── scripts/            # 本地启动与停止
```

`docs/` 为本地维护文档，不上传 Git，也不包含在仓库克隆中。开发与提交规则见 [贡献指南](CONTRIBUTING.md)。

## 从这些任务开始

- **查清一个问题**：「搜索最近的 Agent 应用进展，按方向归纳，并给出可核对的来源。」
- **读懂一份材料**：「总结这份 PDF 的主要结论，列出依据、不确定点和需要继续确认的问题。」
- **写出一份初稿**：「结合我提供的资料，起草一篇文章，再按我的反馈逐段修改。」
- **积累可用上下文**：把资料按主题整理，明确开启长期使用；把确认过的知识留给后续对话。

文件库界面新导入的资料默认**仅存档**，不会因上传就自动成为长期依据。"用于对话"带入当时的文本快照；"长期使用"允许后续检索参考。校正提取文字会更新检索依据，不改写上传原件。

功能是否可用取决于所选模型、服务权限与本地可选依赖。

## 升级与命名兼容

源码、包名、事件和新配置统一使用 `tuantuan`，产品名称为「团团」。旧版环境变量、浏览器登录与偏好、模型凭证和数据库通过兼容层读取；新旧环境变量同时存在时，以新变量为准。数据库更名同时保留 SQLite WAL/SHM 文件，桌面端继续使用已有数据目录，不自动合并不同工作区。

升级前先停止使用同一数据目录的旧后端并备份数据，再启动新版；不要让两个版本同时操作同一工作区。无需手动改写数据库内容或重新录入模型密钥。

## 本地 MinIO（可选）

附件默认保存在本地目录。使用 MinIO 时，在 `backend/.env` 中设置 `ATTACHMENT_STORAGE=minio`，并填写 `MINIO_ENDPOINT`、`MINIO_ACCESS_KEY`、`MINIO_SECRET_KEY`、`MINIO_BUCKET` 与 `MINIO_SECURE`。上传的新附件写入私有桶；预览和下载按需缓存到本地，历史本地附件仍可读取。切换存储不会自动迁移历史文件。

Windows 上可用 `powershell -File scripts/start-minio.ps1 -BinaryPath <MinIO程序路径>` 启动本地服务。若程序已放到 `backend/data/minio-server/minio.exe`，可省略 `-BinaryPath`。脚本从 `.env` 读取凭据，存储接口和管理页面分别只监听 `127.0.0.1:9000`、`127.0.0.1:9001`；数据保存在 `backend/data/minio-server/objects/`。程序可按 [MinIO 官方源码安装说明](https://github.com/minio/minio#source-only-distribution)构建。

模型看图仍将图片内容随模型请求发送，无需配置公网存储地址；是否能识别图片取决于所选模型及网关的实际能力。

## 协作与变更记录

- 贡献、分支、提交与验证规则：[`CONTRIBUTING.md`](CONTRIBUTING.md)
- 版本与里程碑摘要：[`CHANGELOG.md`](CHANGELOG.md)
- 社区行为准则：[`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md)
- 安全漏洞报告：[`SECURITY.md`](SECURITY.md)；请使用私密报告渠道。
- 问题反馈、功能建议与使用咨询：[创建 Issue](https://github.com/Xiaolang-d3/TuanTuan/issues/new/choose)

## 许可证

本项目采用 [MIT License](LICENSE)。使用、修改或分发代码时请保留许可证与版权声明。项目中单独注明许可证的第三方代码与依赖继续遵循各自的授权条款，例如 [`backend/app/password_policy-LICENSE.txt`](backend/app/password_policy-LICENSE.txt)。
