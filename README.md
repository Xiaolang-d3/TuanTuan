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
| **多模型连接** | 填写 Base URL 与 API Key，获取模型目录，跨服务选择文本与图片默认模型；参数、协议及备用规则按需展开。支持 OpenAI 兼容接口、Responses、Images、Anthropic、Gemini 与 Ollama。 |

### 模型配置与服务层

进入「设置 → 模型设置」，添加服务并填写 Base URL 和 API Key，保存后获取模型。名称和接口协议可保持自动；目录中的「使用文本」「使用图片」分别保存默认用途，服务筛选只影响当前列表。聊天选模同样列出所有启用服务，同名模型按所属服务区分。请求参数保存在各自模型档案中，可在「参数」里按需修改。

目录读取不执行生成。提供商声明、名称推断和未知输出分别保留；支持看图不代表支持生图，声明能力也不能启用尚未接入的接口。OpenAI 兼容目录会尝试 `kind=all` 获取 Magpie 等网关的图片/视频条目；仅在服务明确拒绝该目录参数时退回标准读取。视频模型可以展示，视频生成执行暂未接入。

模型服务层位于 `backend/app/models/`：`service.py` 汇合 Provider factory、协议适配、确定性用途选择与既有用量快照；`selection.py` 负责候选资格和选择理由，`catalog_discovery.py` 保存按连接版本隔离的目录证据。`POST /agent/model-selection/preview` 仅预演选择，不解密凭证或调用模型。用量继续来自已有调用记录，不新增第二套计数器；高级诊断中的统计按当前绑定模型展示。Agent Runtime 的任务、工具和阶段生命周期保持不变，入口绑定使用统一选择结果，不依赖 Magpie 进程。

工作区数据库升级到 v36，新增模型目录缓存表；升级前按既有机制备份，旧连接、密钥引用、参数及任务快照保留。旧任务恢复仍使用已绑定版本并校验当前可用性；图片生成结果不明确时不会因路由而自动重复提交。
| **开发者资讯首页** | 浏览 AI / Agent 动态、GitHub 日榜与周榜、关注仓库的 Releases 和工程实践；收藏线索，或带入对话继续分析。 |

多用户托管在单台服务器时，设置 `TUANTUAN_DEPLOYMENT_MODE=hosted` 和 `TUANTUAN_SECRET_MASTER_KEY`，各用户可在“设置 → 模型设置”中保存自己的模型连接。用 `python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"` 生成主密钥；通过服务器安全配置注入并单独备份，禁止提交到仓库。备份用户工作区时须保留其中的 `.model-secrets` 目录，并恢复到原数据路径（凭证引用与路径绑定）；主密钥丢失后，用户需要重新配置密钥。新用户不会自动继承服务器的模型环境变量，已有环境密钥引用仍保持兼容。

托管模式允许用户直接添加任意公网 HTTPS 模型服务，无需管理员逐域名添加白名单。模型目录、聊天、流式输出、生图与备用路由均使用受保护的连接：每次建立 TCP 连接时验证全部 DNS 结果、直连已验证的公网 IP，并保留原域名的 Host、TLS SNI 和证书校验；拒绝本机、内网、云元数据及保留地址，禁止服务端跳转和环境代理绕过。本地模式仍支持 HTTP 和局域网模型。部署时继续保留出站防火墙作为额外防护，并使用 HTTPS 保护用户到服务器的连接。旧 `TUANTUAN_MODEL_ALLOWED_HOSTS` 不再决定服务地址授权，也不能放行内网地址。

### Mac 拉取式生产部署的安全配置

`scripts/deployment.py` 的服务进程和冒烟检查固定使用 `hosted` 模式，不继承操作员的模型密钥或部署模式。Mac 生产服务继续显式使用系统 keyring 保存模型凭证，兼容原有引用，不会自动改成加密文件存储；备份数据目录不能替代备份系统钥匙串。

- 部署根目录的 `config.json` 中旧 `model_allowed_hosts` 字段仅保留历史配置兼容性，无需为新公网服务增加域名；HTTP、本机和内网模型地址在生产中被拒绝，域名解析到非公网地址时也不能发起请求。
- 若需要托管微信等主密钥功能，在部署根目录单独创建 `secret-master-key` 文件，内容为按上述方式生成的 Fernet 主密钥；仅服务账号可读（macOS：`chmod 600`），独立备份，禁止提交。未配置时相关功能保持不可用；冒烟进程不会接收该密钥。
- 若旧部署已连接微信，应先备份并完成旧工作区渠道密钥的迁移；不要直接生成新密钥后覆盖旧配置，否则原加密内容无法读取。没有经过确认的迁移方案时，暂停部署并安排重新绑定。
- 已安装的 launchd 使用部署根目录中复制的 `manager.py`，发布候选包不会自动替换它。升级管理脚本须先暂停部署轮询、备份旧管理脚本与配置、用新版脚本更新 `manager.py`，并在核对密钥兼容性后安排服务重启；不要重新运行 `configure` 覆盖已有安装。
- 准备候选包时遇到网络超时、限流、服务端错误或依赖安装失败，最多尝试 3 次，按 60 秒、120 秒退避。校验/配置失败以及任何激活失败不自动重放；检查部署日志和 `last-failure.json` 后再显式运行 `once --root <部署根目录> --retry`。原有无阶段信息的失败记录仍要求人工重试。
- 文档解析在独立子进程中受时间与内存预算约束。Linux 使用地址空间限额，Windows 使用 Job Object；macOS 使用父进程读取原生 RSS、超预算终止的采样监控，可能短暂超额，监控不可用则拒绝解析。macOS 的保护不等同于内核在分配内存前拒绝请求。

界面提供 **首页、AI 工作区、文件库、设置** 四个入口，支持浅色、深色和跟随系统外观。产品名称为团团，英文标识统一使用 `tuantuan`。

## Agent 内核

对话支持两种 Agent 内核：默认使用团团自研编排内核，也可选择开源的 DeepSeek Harness（DSH）。在空白对话的输入框可直接选择内核；设置 → 模型设置中的“新对话默认内核”只影响之后新建的对话。

已有消息的对话选择另一种内核时，团团会自动建立一个空白分支，并把原对话的摘要和最近文本作为只读上下文带入。原对话不会被修改或中断：即使它正在运行或等待确认，也会继续留在原处；尚未完成的本轮用户消息不会复制到分支。附件、待审批请求和工具执行状态也不会继承，需在分支中重新添加或确认。

DSH 内核支持使用任意 HTTPS 端点的已启用 DeepSeek 模型档案，例如官方 `https://api.deepseek.com` 或你自己配置的代理网关；API Key 会随 `DEEPSEEK_BASE_URL` 传给 DSH 子进程，请只使用你信任的端点。仿冒 DeepSeek 官方域名的地址（如 `api.deepseek.com.attacker.test`）和非 HTTPS 地址会被拒绝。本期只提供对话、审批与用户提问能力；资料库、联网搜索、技能与团团自有原生工具暂不桥接。使用前需要 Node >= 24.9，并执行 `node backend/scripts/vendor-dsh-runtime.mjs` 把 npm 运行时安装到 `backend/data/dsh-runtime/`（版本与校验清单见 `backend/dsh-runtime.lock.json`）。设置环境变量 `TUANTUAN_DSH_ENABLED=1` 后，满足条件的 DSH 选项才可用；DSH 会话状态保存在 `backend/data/dsh/<用户>/<对话>/`，子进程重建时会依据已保存的对话历史恢复上下文。

DeepSeek Harness 使用 MIT 许可证（Copyright (c) 2026 DeepSeek），目前处于开发者预览，接口可能发生不兼容变更；版本锁定在 `@deepseek-ai/dsh@0.2.2-rc.1`。

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

## 扩展与技能

在「设置 → 扩展中心」导入 `SKILL.md`，或包含一个 `SKILL.md` 及其资源的技能 ZIP。技能默认停用，启用后可在聊天输入框的「技能」中选择；选择「普通对话」清除当前选择。技能及启停状态按账号保存，刷新后保留。元数据支持 YAML 多行描述；说明中的权限声明不会自动授予工具或资料访问权限。

技能 ZIP 限 2 MB，展开后限 5 MB、100 个条目，拒绝越界路径、链接和大小写重名。插件首版只保存 `api_version: 1` 的 JSON 清单，MCP 只保存连接草稿，尚不执行插件或连接工具服务。内置 PPT Master 支持 AI 生成：点击聊天输入框工具栏的「制作 PPT」，或从「技能 → PPT Master」展开制作要求，填写主题和建议页数后，任务以卡片保存在当前会话中，使用该会话的文本模型。卡片显示真实阶段，提供需求、设计两次确认入口；制作完成后可逐页预览并鉴权下载可编辑 PPTX。预览内支持选择页码、方向键翻页和直接下载。刷新、切换会话或关闭详情不会取消任务，失败时显示原因并保留要求供编辑重做。扩展中心仍保留独立制作工作台。

未提交的 PPT 要求按会话暂存在页面内存中，切换会话、查看模型设置或收起表单后可继续编辑；提交成功后清空，完整刷新页面后不保留。不同登录连接的草稿互相隔离。

制作卡片显示当前模型请求对应的动作和已等待时间，以及已校验并提交的页面数量；实际总页数来自设计计划，未知时不以建议页数替代。失败或中断后仍显示已保存的页数。刷新只读取状态，编辑要求后重做会创建新任务；请求结果不明时不会自动重复提交。长要求可展开完整查看，重做继续使用原文。点击成果封面可直接预览，缩略图支持定位，方向键与 Home/End 可翻页；关闭后重新打开会回到当前卡片上次查看的页面，点击封面则打开第 1 页。位置仅保存在当前卡片内存中，不跨刷新或会话切换保存。逐页预览在整份制作完成后提供，可编辑大纲、在线页面编辑和逐页修改尚未接入。

PPT 制作当前支持 Windows 本地部署。先按固定的 PPT Master 版本（`492a52b2b845927b0924b6eaaa495fc0dfc8f646`）构建独立运行包，再在 `backend/.env` 配置 `TUANTUAN_PPT_RUNTIME` 为运行包的绝对路径。`backend/scripts/build_ppt_runtime.py` 接受 `--checkout`、`--font`、`--font-license` 与 `--destination`；构建须使用独立的 Windows CPython 3.12 虚拟环境，按 `backend/requirements-ppt-lock.txt` 以 `--require-hashes` 安装依赖。运行包与操作系统匹配，并包含完整性清单、固定中文字体和宿主预览入口；旧运行包缺少该入口时会拒绝创建制作任务。修改运行包后应重新构建，不直接修改已绑定任务的资源。

本地制作默认启用，仍需在模型设置中配置可用的文本模型。工作台会检查运行包与模型，缺少条件时说明原因；配置后点击「重新检查」。管理员可设置 `TUANTUAN_PPT_PREPARATION_ENABLED=false` 或 `TUANTUAN_PPT_GENERATION_ENABLED=false` 关闭新建制作；环境变量修改后须重启后端，托管部署始终禁用本机执行。生成需求建议、设计和页面会调用绑定的模型并计入用量。当前范围为中文 16:9、1–20 页、自由设计、连续制作、用户图片或无图，以及可选讲稿。模板、额外设计规格审批、动画、音频、拆分制作与原生数据对象编辑仍未支持；确认页选择未支持的能力时会提示纠正，不提交回执。图表和表格以可编辑形状交付。PNG 是 SVG 预览，字体和 Office 最终显示效果仍须在 PowerPoint/WPS 中检查。

PPT 单次模型调用默认等待 300 秒，可通过 `TUANTUAN_PPT_MODEL_TIMEOUT_SECONDS` 设置 30–600 的整数秒，缺失或无效时使用 300；外层总等待额外保留 30 秒收尾，1800 秒任务活动预算继续生效。此设置独立于聊天。PPT 请求启用结构化 JSON，OpenAI Chat Completions 与 Responses 原生适配器会传递对应格式约束，仍严格校验完整结果；网关不支持时不会自动撤掉约束再次调用。结果不完整会明确提示格式错误，原始响应保留，不自动修补或重放。增加本地等待时限不能消除上游网关自身的时限或输出错误。

扩展中心底部展开「执行环境与后台任务」，可查看真实环境状态和当前账号的任务、阶段确认、取消、恢复与版本文件下载。任务只接受服务端注册的受信任适配器；关闭页面不会取消任务，崩溃恢复须先确认原执行环境停止；无法判定结果的外部操作不会自动重试。

通用隔离执行环境使用 Docker CLI，配置 `TUANTUAN_EXECUTION_IMAGE=仓库名@sha256:镜像摘要`，对应镜像必须已在本机准备好。当前要求 Linux engine、seccomp、可用的非 root 身份；Linux 后端以 root 运行时明确不可用。容器默认禁网、只读根目录、限制资源，仅挂载单个任务目录，不接收模型凭证。缺少引擎、镜像未固定或环境校验不通过时不执行，不回退宿主 shell。该配置不代表 PPT 工作流已经可用。

数据库版本升级至 34，新增扩展、任务、事件、文件成果与执行尝试记录，沿用现有升级备份流程。

## 微信消息渠道

在「设置 → 消息渠道 → 微信」点击连接，用手机微信扫码并确认；需要数字验证时输入手机显示的验证码。接入依据为腾讯公开的 [openclaw-weixin 协议](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol_zh_CN.md)，无需安装 OpenClaw。

首版接收绑定用户的私聊文字和带转写文字的语音，复用当前账号的模型、联网研究、资料库和多轮会话，回答回传微信；图片、文件和视频消息会提示转到团团处理。账号是否可用仍以微信实际扫码结果为准。消息接收需要团团后端保持运行，前端页面可以关闭。

绑定后侧边栏显示「微信 Bot」，新消息显示头像右上角未读数（超过 99 显示 99+）。点击打开微信会话；消息成功加载后清除已读部分，刷新页面和同一账号重新登录会保留未读数。图片等暂不支持的消息也会在会话中保留提示。侧边栏与设置共用一条经过登录鉴权的 SSE 状态流，变化时推送；断线自动重连，并以 30 秒轮询兜底。隐藏标签页暂停通知连接，回到前台重新获取完整状态，微信接收及任务继续运行。

SSE 每 15 秒发送心跳，45 秒没有数据时客户端重连。反向代理需允许流式响应并关闭缓冲、缓存（接口已返回 `X-Accel-Buffering: no` 和 `Cache-Control: no-store`）；通过公网 Tunnel 分享时需确认中间代理没有缓冲事件。当前微信接收器及推送广播面向单进程部署，请保持一个 worker；多实例需先增加接收器租约与跨进程广播。

凭证与待处理消息加密保存在用户工作区的 `.weixin/`，备份时保留整个目录；本地加密密钥也在该目录，托管模式改用已有 `TUANTUAN_SECRET_MASTER_KEY`。解除绑定会停止接收与执行，并清除本机渠道凭证和队列；已保存的聊天记录保留。回复发送失败只重发已有回答，不重新调用模型。

## 升级与命名兼容

源码、包名、事件和新配置统一使用 `tuantuan`，产品名称为「团团」。旧版环境变量、浏览器登录与偏好、模型凭证和数据库通过兼容层读取；新旧环境变量同时存在时，以新变量为准。数据库更名会同时保留 SQLite 的 WAL/SHM 文件，桌面端继续使用已有数据目录，不自动合并两个不同的工作区。

升级前先停止使用同一数据目录的旧后端并备份数据，再启动新版；不要让两个版本同时操作同一工作区。无需手动改写数据库内容或重新录入模型密钥。

## Windows 桌面端开发

先安装 Node.js、Rust 的 MSVC 工具链、Visual Studio Build Tools 的“使用 C++ 的桌面开发”工作负载，以及 WebView2 Runtime。安装工具后重新打开终端。

在仓库根目录的 `.venv` 或 `backend/.venv` 中准备后端 Python 依赖，再执行：

```powershell
cd frontend
npm ci
cd ../desktop
npm ci
npm run dev
```

桌面开发端默认连接网页后端 `http://127.0.0.1:8000`，请先启动该后端。两端使用同一账号登录后共用账号、聊天、资料和设置；登录状态由各客户端分别保存。关闭桌面窗口不会停止共享后端。服务不可用时桌面端会提示错误，不会另建独立数据库。

在仓库根目录准备 `.venv` 后，可另开终端启动共享后端：

```powershell
cd backend
..\.venv\Scripts\python.exe -m app.server app.main:app --host 127.0.0.1 --port 8000 --reload
```

若使用 `backend/.venv`，将解释器路径改为 `.\.venv\Scripts\python.exe`。`app.server` 保留 Uvicorn 的命令行参数，并将退出等待上限设为 5 秒，避免微信实时通知等长连接阻塞热重载；可通过 `--timeout-graceful-shutdown` 调整。退出或热重载会中断超过等待上限的请求，正在进行重要任务时请等待任务完成再重启。

可用环境变量 `TUANTUAN_API_BASE` 指定本机其他端口的共享后端；仅支持 `localhost` 或 `127.0.0.1` 的根地址，不支持路径前缀。后端版本须与桌面端一致。例如：

```powershell
$env:TUANTUAN_API_BASE = "http://127.0.0.1:8000"
npm run dev
```

已有的桌面独立数据仍保存在原应用数据目录，本次不会迁移或合并。发布包未设置该变量时仍使用内置本地服务。

开发配置不需要预先打包 sidecar。`npm run build` 仍沿用原来的发布配置；Windows 安装包构建尚未适配。

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
