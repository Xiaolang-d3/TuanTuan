<div align="center">
  <img src="frontend/public/tuantuan-logo.png" alt="团团 Logo" width="88" height="88" />

# 团团 · 智能工作伙伴

**理解你的想法，帮你把事情做好。**

[![CI](https://github.com/Xiaolang-d3/TuanTuan/actions/workflows/ci.yml/badge.svg)](https://github.com/Xiaolang-d3/TuanTuan/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/Xiaolang-d3/TuanTuan?color=blue)](LICENSE)
[![Community Standards](https://img.shields.io/badge/Community-Standards-blue)](https://github.com/Xiaolang-d3/TuanTuan/community)

</div>

团团是一个开源、本地优先的智能工作伙伴：把问题、文件和想法带进对话，完成研究、分析、起草与修改，并把成果留存下来供后续任务复用。

模型服务、资料是否长期参考、每轮是否联网都由你决定。资料、会话与任务记录保存在本机；调用外部模型或搜索服务时，相关上下文会发送至你配置的服务——**本地存储不等于全程离线**。

## 核心能力

相比通用聊天产品，团团更在意这几件事：

- **本地优先，模型自选**：会话、资料和任务记录保存在本机；模型可接 OpenAI 兼容接口、Anthropic、Gemini 与 Ollama，不被单一厂商锁定。
- **上下文由你控制**：每份导入的资料单独选择“一次性使用”或“长期参考”，不让无关内容默认进入每一轮对话。
- **成果可留存、可复用**：对话中的结论、草稿和生成图片可存档，下一个任务直接取用，不用重新交代背景。
- **微信里接着用**：通过微信消息渠道接入，离开电脑后仍能发起和继续任务。
- **技能可扩展**：内置 PPT 生成、资讯整理、图像设计等技能，也能按需接入新的扩展。

## Agent 内核

对话支持两种 Agent 内核：默认使用团团自研编排内核，也可选择开源的 DeepSeek Harness（DSH）。在空白对话的输入框可直接选择内核；设置 → 模型设置中的“新对话默认内核”只影响之后新建的对话。

已有消息的对话选择另一种内核时，团团会自动建立一个空白分支，并把原对话的摘要和最近文本作为只读上下文带入。原对话不会被修改或中断：即使它正在运行或等待确认，也会继续留在原处；尚未完成的本轮用户消息不会复制到分支。附件、待审批请求和工具执行状态也不会继承，需在分支中重新添加或确认。

DSH 内核支持使用任意 HTTPS 端点的已启用 DeepSeek 模型档案，例如官方 `https://api.deepseek.com` 或你自己配置的代理网关；API Key 会随 `DEEPSEEK_BASE_URL` 传给 DSH 子进程，请只使用你信任的端点。仿冒 DeepSeek 官方域名的地址（如 `api.deepseek.com.attacker.test`）和非 HTTPS 地址会被拒绝。本期只提供对话、审批与用户提问能力；资料库、联网搜索、技能与团团自有原生工具暂不桥接。使用前需要 Node >= 24.9，并执行 `node backend/scripts/vendor-dsh-runtime.mjs` 把 npm 运行时安装到 `backend/data/dsh-runtime/`（版本与校验清单见 `backend/dsh-runtime.lock.json`）。设置环境变量 `TUANTUAN_DSH_ENABLED=1` 后，满足条件的 DSH 选项才可用；DSH 会话状态保存在 `backend/data/dsh/<用户>/<对话>/`，子进程重建时会依据已保存的对话历史恢复上下文。

DeepSeek Harness 使用 MIT 许可证（Copyright (c) 2026 DeepSeek），目前处于开发者预览，接口可能发生不兼容变更；版本锁定在 `@deepseek-ai/dsh@0.2.2-rc.1`。

## 项目架构

下图是团团的分层架构：前端只负责交互，FastAPI 在本机完成编排、资料与成果管理；模型、搜索与微信通过外部服务接入。

```mermaid
flowchart TB
  subgraph clients["客户端"]
    Web["Web 前端<br/>React 19 + assistant-ui"]
    Desktop["桌面端<br/>Tauri 2 + Rust"]
    WeChat["微信"]
  end

  subgraph local["本机 · FastAPI 服务"]
    API["API 层<br/>REST / SSE / 鉴权 / 用户工作区"]
    Channel["微信渠道"]
    Kernel["Agent 内核<br/>自研编排 / DSH 可选"]
    Library["资料库<br/>导入 / 解析 / 检索"]
    Tools["工具与技能<br/>联网 / PPT / 图像 / 文档"]
    Jobs["任务与审批<br/>后台作业 / 成果归档"]
    Gateway["模型网关<br/>LiteLLM + OpenAI SDK"]
  end

  subgraph data["本地数据"]
    SQLite[("SQLite + sqlite-vec")]
    Files[("附件 / 成果 / 导出文件")]
    MinIO[("MinIO（可选）")]
  end

  subgraph external["模型、搜索与微信"]
    Models["模型服务<br/>OpenAI 兼容 / Anthropic / Gemini / Ollama"]
    Search["搜索与网页"]
    ILINK["微信 iLink"]
  end

  Web --> API
  Desktop --> API
  WeChat --> ILINK
  ILINK --> Channel
  Channel --> API
  API --> Kernel
  Kernel --> Library
  Kernel --> Tools
  Kernel --> Jobs
  Kernel --> Gateway
  Tools --> Gateway
  Gateway --> Models
  Tools --> Search
  API --> SQLite
  Kernel --> SQLite
  Library --> SQLite
  Jobs --> SQLite
  Library --> Files
  Tools --> Files
  Jobs --> Files
  Files -.-> MinIO
```

一次任务从客户端进入 API，由内核规划并调用资料库、工具与模型；结果写入任务与成果，附件和导出文件留在本地。

## 技术栈

- **前端**：React 19、TypeScript、Vite、Vitest、Playwright；聊天界面基于 assistant-ui
- **后端**：Python 3.11+、FastAPI、Uvicorn、Pydantic；模型接入统一走 LiteLLM 与 OpenAI SDK
- **桌面端**：Tauri 2、Rust；在 [独立仓库](https://github.com/Xiaolang-d3/TuanTuan-Desktop)维护，使用固定版本的本仓库前后端
- **数据与存储**：SQLite、sqlite-vec，可选 MinIO
- **评测**：Promptfoo

## 项目结构

```text
TuanTuan/
├── backend/             # FastAPI 服务
│   ├── app/             # Agent、资料库、模型适配与持久化
│   └── tests/           # 后端测试
├── frontend/            # React 前端
│   ├── src/             # 页面、组件与状态
│   ├── e2e/             # Playwright 端到端测试
│   └── public/          # 静态资源
├── evals/               # 离线评测
│   ├── cases/           # 评测用例
│   └── providers/       # 评测服务适配
├── scripts/             # 启动、停止、部署与文档检查脚本
└── .github/workflows/   # CI 工作流
```

## 快速开始

```bash
./scripts/dev.sh
```

本地启动前后端；配置示例见 `backend/.env.example`，停止服务使用 `./scripts/stop-dev.sh`。

### PPT 运行包

Windows 本地 PPT 使用独立运行包，默认位置为 `backend/data/ppt-runtime`；如果设置了 `TUANTUAN_DATA_DIR`，则使用该数据目录下的 `ppt-runtime`。也可以通过 `TUANTUAN_PPT_RUNTIME` 指定其他位置。新安装需要用 `backend/scripts/build_ppt_runtime.py` 准备运行包。

从旧版升级时，将原 `tmp/ppt-runtime` 完整复制到新的默认位置；如果曾显式配置 `TUANTUAN_PPT_RUNTIME`，还需将其更新为新位置。重启后端并确认 PPT 可用后，再清理旧目录。

## 参与贡献

- [贡献指南](CONTRIBUTING.md) · [变更记录](CHANGELOG.md) · [安全政策](SECURITY.md)
- [问题反馈与功能建议](https://github.com/Xiaolang-d3/TuanTuan/issues/new/choose)

## 许可证

[MIT License](LICENSE)
