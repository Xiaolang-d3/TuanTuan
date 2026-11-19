<div align="center">
  <img src="frontend/public/tuantuan-logo.png" alt="团团 Logo" width="88" height="88" />

# 团团 · 智能工作伙伴

**理解你的想法，帮你把事情做好。**

[![CI](https://github.com/Xiaolang-d3/TuanTuan/actions/workflows/ci.yml/badge.svg)](https://github.com/Xiaolang-d3/TuanTuan/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/Xiaolang-d3/TuanTuan?color=blue)](LICENSE)
[![Community Standards](https://img.shields.io/badge/Community-Standards-blue)](https://github.com/Xiaolang-d3/TuanTuan/community)

</div>

团团是一个能够执行任务的智能体。

## 项目架构

```mermaid
flowchart TB
  User(["用户"])

  subgraph Clients["客户端层"]
    direction LR
    Web["Web 前端<br/>React 19 · assistant-ui"]
    Desktop["桌面端<br/>Tauri 2 · Rust"]
    WeChat["微信<br/>iLink 通道"]
  end

  subgraph Service["本机服务层 · FastAPI"]
    API["接入层<br/>REST / SSE · 鉴权"]
    Channel["微信渠道<br/>消息 · 语音转写"]
    Orchestrator["对话编排<br/>计划 · 工具调用 · 审批"]
    Library["资料库<br/>导入 · 解析 · 检索"]
    Jobs["任务与作业<br/>队列 · 重试 · 确认"]
    Artifacts["成果与文档<br/>版本 · DOCX/PDF 导出"]
    Tools["工具与技能<br/>搜索 · PPT · 图像"]
    Gateway["模型网关<br/>LiteLLM · OpenAI SDK"]
  end

  subgraph Data["数据层"]
    direction LR
    DB[("SQLite + sqlite-vec")]
    Files[("本地文件<br/>附件 / 成果 / 导出")]
    MinIO[("MinIO<br/>可选")]
  end

  subgraph External["外部系统"]
    direction LR
    LLM["模型服务<br/>OpenAI 兼容 / Anthropic<br/>Gemini / Ollama"]
    Search["搜索服务"]
  end

  User --> Web
  User --> Desktop
  User --> WeChat

  Web -->|HTTPS / SSE| API
  Desktop -->|HTTP / SSE| API
  WeChat -->|iLink| Channel
  Channel --> API

  API --> Orchestrator
  API --> Library
  API --> Jobs
  API --> Artifacts
  API --> Gateway

  Orchestrator --> Library
  Orchestrator --> Jobs
  Orchestrator --> Artifacts
  Orchestrator --> Tools
  Orchestrator --> Gateway

  Tools --> Gateway
  Tools -->|HTTPS| Search
  Gateway -->|HTTPS| LLM

  Library --> DB
  Jobs --> DB
  Artifacts --> DB
  Library --> Files
  Jobs --> Files
  Artifacts --> Files
  Files -.->|可选| MinIO

  classDef client fill:#E8F1FF,stroke:#2563EB,color:#0F2A5F
  classDef service fill:#EAF8EF,stroke:#16A34A,color:#0B3D1E
  classDef data fill:#FFF4E5,stroke:#EA580C,color:#5C2A05
  classDef external fill:#F5EDFF,stroke:#7C3AED,color:#3B1A66
  class Web,Desktop,WeChat client
  class API,Channel,Orchestrator,Library,Jobs,Artifacts,Tools,Gateway service
  class DB,Files,MinIO data
  class LLM,Search external
```

## 技术栈

- **前端**：React 19、TypeScript、Vite、Vitest、Playwright；聊天界面基于 assistant-ui
- **后端**：Python 3.11+、FastAPI、Uvicorn、Pydantic；模型接入统一走 LiteLLM 与 OpenAI SDK
- **桌面端**：Tauri 2、Rust；在 [独立仓库](https://github.com/Xiaolang-d3/TuanTuan-Desktop)维护，使用固定版本的本仓库前后端
- **数据与存储**：SQLite、sqlite-vec，可选 MinIO
- **测试**：pytest（含 Agent 离线评测）、Vitest、Playwright

## 项目结构

```text
TuanTuan/
├── .github/             # GitHub 协作与自动化
│   ├── workflows/       # CI、CD 和版本发布
│   └── skills/          # 部署维护手册
├── backend/             # FastAPI 与业务逻辑
│   ├── app/
│   ├── tests/
│   │   └── eval_cases/  # Agent 离线评测用例，随 pytest 运行
│   └── scripts/         # 后端依赖安装、检查和构建工具
├── frontend/            # React 前端
│   ├── src/
│   ├── public/
│   └── e2e/             # Playwright 浏览器验收
└── scripts/             # 本地启动、停止入口与 CI/CD 辅助脚本
```

## 快速开始

```bash
./scripts/dev.sh
```

本地启动前后端；配置示例见 [`backend/.env.example`](backend/.env.example)，停止服务使用 `./scripts/stop-dev.sh`。本地启动不需要 Docker；使用可选 MinIO 时，按配置示例启动 [Compose 配置](backend/docker-compose.minio.yml)。生产发布和恢复参见[部署维护手册](.github/skills/tuantuan-deploy/SKILL.md)。

### PPT 运行包

Windows 本地 PPT 使用独立运行包，默认位置为 `backend/data/ppt-runtime`；如果设置了 `TUANTUAN_DATA_DIR`，则使用该数据目录下的 `ppt-runtime`。也可以通过 `TUANTUAN_PPT_RUNTIME` 指定其他位置。新安装需要用 `backend/scripts/build_ppt_runtime.py` 准备运行包。

从旧版升级时，将原 `tmp/ppt-runtime` 完整复制到新的默认位置；如果曾显式配置 `TUANTUAN_PPT_RUNTIME`，还需将其更新为新位置。重启后端并确认 PPT 可用后，再清理旧目录。

## 参与贡献

- [贡献指南](CONTRIBUTING.md) · [变更记录](CHANGELOG.md) · [安全政策](SECURITY.md)
- [问题反馈与功能建议](https://github.com/Xiaolang-d3/TuanTuan/issues/new/choose)

## 许可证

[MIT License](LICENSE)
