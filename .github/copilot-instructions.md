# 团团仓库协作约定

团团是本地优先的智能工作伙伴。英文标识统一使用 `tuantuan`，实现与产品说明以当前源码和 `README.md` 为准。先阅读 `CONTRIBUTING.md`，再按任务需要读取相关文档。

- `backend/app/`：FastAPI、账户隔离、资料库、模型连接和智能体运行时；测试在 `backend/tests/`。
- `frontend/src/`：React 19、TypeScript、Vite；单元测试与源码相邻，浏览器测试在 `frontend/e2e/`。
- `desktop/`：Tauri 壳与 Python sidecar；Web 功能改动不应顺带改动桌面打包。
- `docs/`：仅在本地维护并被 Git 忽略；新克隆的仓库不包含该目录，也不要求创建它。

## 变更与验证

开始前检查 `git status`，保留已有改动。一个分支只处理一个明确目标，遵循现有模块边界，避免无关重构和格式调整。Python 使用四空格与 `snake_case`；TypeScript 使用两空格、`camelCase` 和 `PascalCase`。

行为变化补充确定性回归测试。测试使用临时目录、临时数据库与模拟网络或模型响应，不使用个人工作区、已有账户、真实模型密钥或付费模型调用。优先运行受影响的测试，再完成相关构建与 CI 必需检查；如未执行某项验证，应说明原因，不得声称通过。

- 后端依赖：`sh backend/scripts/install_deps.sh backend/.venv dev`；在 `backend/` 运行 `EMBEDDING_BACKEND=hash .venv/bin/python -m pytest tests -q`，可先指定相关测试文件。
- 前端依赖：在 `frontend/` 运行 `npm ci`；验证用 `npm run test` 与 `npm run build`；浏览器行为变更按需运行 `npm run test:e2e`。
- 修改智能体行为或模型层时同步已有的本地 `docs/agent.md` 或 `docs/model-layer.md`，但不要提交 `docs/`；`scripts/check-docs-sync.sh` 检查该目录未被跟踪。依赖与对应锁文件一起更新。

## 数据、部署与交付

不得读取、提交或输出真实 `.env`、API Key、Cookie、令牌、SQLite 数据、个人资料、日志、会话凭据及未脱敏截图；不提交虚拟环境、`node_modules` 或构建产物。安全漏洞依照 `SECURITY.md` 私密报告。

GitHub 智能体在临时开发环境工作。不得连接或操作 `xiaocheng.online`、Cloudflare、线上 Mac、真实用户数据库或生产部署服务；部署配置可在仓库内修改并用临时数据验证，线上接管与发布由维护者执行。不要创建付费资源、添加生产密钥或注册自托管 runner。

使用 `<类型>(<范围>): <中文摘要>` 的 Conventional Commit；类型、范围用小写英文。所有变更通过 PR 合入受保护的 `main`，不得绕过失败的检查、直接强推或自行合并。遵循 PR 模板，说明问题、最终行为、验证与配置/迁移影响；UI 变更附脱敏截图。用户可见或里程碑变化按贡献规范更新 `CHANGELOG.md`。
