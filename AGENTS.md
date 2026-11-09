# 仓库指南

## 项目

团团是从对话开始的智能工作伙伴。仓库根目录就是产品本身：后端在 `backend/app/`，桌面端在 `desktop/`（Tauri），前端在 `frontend/src/`，测试分别位于 `backend/tests/`、前端相邻目录和 `frontend/e2e/`。`docs/` 仅在本地维护，不纳入 Git。已有本地 `docs/agent.md` 时，改路由、工具、runtime、记忆、阶段或导入循环仍须同步更新；新克隆的仓库不要求创建该文档。

团团 Sites 版本使用独立 Git 仓库，不纳入本仓库。若本地另有该版本，资料与登录仍由本机 FastAPI 后端处理，本地转发方式见其仓库的 `README.md`。

`output/`、`tmp/` 为生成文件，被 `.gitignore` 排除。后端日志在 `backend/logs/`，前端日志在 `frontend/logs/`。Playwright CLI 会话记录在 `logs/playwright-cli/`（由 `.playwright/cli.config.json` 指定）。

## 常用命令

- `./scripts/dev.sh` 启动本地前后端，`./scripts/stop-dev.sh` 停止。
- `cd backend && .venv/bin/python -m pytest tests -q`：后端测试。
- `cd frontend && npm run test && npm run build`：前端测试与构建。
- `cd desktop && npm run dev`：桌面端开发；`npm run build` 打包。

修改独立的 Sites 版本时，在其仓库运行 `npm run test` 与 `npm run build`。

## 代码与测试

Python 使用四空格和 `snake_case`；TypeScript 使用两空格、`camelCase` 与 `PascalCase` 组件。保持改动小而聚焦，避免无关格式调整。行为变更应补充确定性的回归测试，并模拟网络或模型调用。

## 提交

使用中文 Conventional Commit（详见 `CONTRIBUTING.md`），例如 `feat(agent): 增加工具调用`。CI 以 `scripts/check-docs-sync.sh` 检查 `docs/` 未被跟踪。智能体、资料库、数据库等变更同步已有的本地 `docs/agent.md`，模型层与依赖变更同步已有的本地 `docs/model-layer.md`，但不要提交这些文档。不要提交 `.env`、令牌、个人资料、SQLite 数据、日志或构建产物。PR 说明目的、验证方式及配置/迁移影响；UI 变更附截图。Sites 版本在它自己的仓库里提交。
