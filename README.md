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

## 生产聊天附件存储

可在生产服务环境中设置 `ATTACHMENT_STORAGE=cos`，让新建聊天附件写入腾讯云 COS。使用与生产服务器同地域的标准存储私有桶，并设置 `COS_REGION` 和带 APPID 的 `COS_BUCKET`。通过服务的凭证配置注入 `COS_SECRET_ID` 与 `COS_SECRET_KEY`，凭证只需对该桶的 `cos/` 前缀有上传、读取和删除对象的权限。浏览器仍通过团团的附件接口访问文件。

上线前从生产服务器验证桶域名解析和连接，并用测试附件验证上传、下载与删除。已有本地附件原地读取。需要暂停向 COS 写入时，可以把 `ATTACHMENT_STORAGE` 改回 `local`，同时保留 COS 配置，让已写入 COS 的附件继续可读。处理已写入的 COS 附件时，需要使用支持 COS 的应用版本。

## 参与贡献

- [贡献指南](CONTRIBUTING.md) · [变更记录](CHANGELOG.md) · [安全政策](SECURITY.md)
- [问题反馈与功能建议](https://github.com/Xiaolang-d3/TuanTuan/issues/new/choose)

## 许可证

[MIT License](LICENSE)
