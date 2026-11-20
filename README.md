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
    Web["Web 前端 · React"] --> Backend

    Backend["FastAPI 后端<br/>账号鉴权 · 接收请求 · 流式返回"] --> Agent
    Agent["Agent 任务编排<br/>理解请求 · 检索资料 · 调用工具"]
    Agent --> Data["资料与成果<br/>SQLite · 文件存储"]
    Agent --> Services["按需调用<br/>模型 · 搜索服务"]

    classDef core fill:#E8F1FF,stroke:#2563EB,color:#0F2A5F,stroke-width:2px
    class Backend,Agent core
```

用户从 Web 发起请求，Agent 按需读取资料、调用模型和工具，再返回回答或生成文档、PPT、图片等成果。

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

### 服务器端快速制作 PPT

在对话里选「PPT Master」，输入主题、粘贴正文，或添加 DOCX、文字版 PDF、TXT、Markdown。可以只传资料。发送后在当前对话查看进度、逐页预览并下载可编辑的 PPTX。单次最多 8 份资料，要求与资料合计不超过 32,000 字。若预览转换失败，已导出的 PPTX 仍可下载。

服务器需使用启用默认 seccomp 的 Linux Docker 引擎。运行后端的非 root 服务账号需要能够访问 Docker。生成容器在禁用网络的独立环境中运行。

1. 使用 `docker buildx build --push -t <registry>/<quick-ppt>:<release> -f backend/scripts/quick-ppt/Dockerfile backend` 构建并推送镜像。
2. 在后端所在机器拉取镜像的 `仓库名@sha256:…`，用 `docker image inspect` 确认该引用出现在本机 `RepoDigests` 中。
3. 将完整镜像引用设置为 `TUANTUAN_QUICK_PPT_IMAGE`。使用仓库自带发布脚本时，在发布目录的 `config.json` 中设置 `quick_ppt_image`。重启后端后，在对话里发送一个中文主题并确认预览和下载。

## 参与贡献

- [贡献指南](CONTRIBUTING.md) · [变更记录](CHANGELOG.md) · [安全政策](SECURITY.md)
- [问题反馈与功能建议](https://github.com/Xiaolang-d3/TuanTuan/issues/new/choose)

## 许可证

[MIT License](LICENSE)
