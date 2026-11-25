<div align="center">
  <img src="frontend/public/tuantuan-logo.png" alt="团团 Logo" width="88" height="88" />

# 团团 · 智能工作伙伴

**理解你的想法，帮你把事情做好。**

[![CI](https://github.com/Xiaolang-d3/TuanTuan/actions/workflows/ci.yml/badge.svg)](https://github.com/Xiaolang-d3/TuanTuan/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/github/license/Xiaolang-d3/TuanTuan?color=blue)](LICENSE)
[![Community Standards](https://img.shields.io/badge/Community-Standards-blue)](https://github.com/Xiaolang-d3/TuanTuan/community)

</div>

## 项目架构

![团团项目架构：用户通过对话提出任务，团团理解需求并按需使用资料、模型和工具，最后交付回答、文档、演示文稿或图片。](assets/project-architecture.svg)

从对话开始，团团理解你的需求，按需查阅资料、使用工具，再把回答和成果带回给你。

## 技术栈

- **前端**：React 19、TypeScript、Vite、assistant-ui
- **后端**：Python 3.11+、FastAPI、Uvicorn、Pydantic、LiteLLM、OpenAI SDK
- **桌面端**：Tauri 2、Rust
- **数据与存储**：SQLite、sqlite-vec、MinIO
- **测试**：pytest、Vitest、Playwright

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

## 参与贡献

- [贡献指南](CONTRIBUTING.md) · [变更记录](CHANGELOG.md) · [安全政策](SECURITY.md)
- [问题反馈与功能建议](https://github.com/Xiaolang-d3/TuanTuan/issues/new/choose)

## 许可证

[MIT License](LICENSE)
