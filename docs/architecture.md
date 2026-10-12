# LearnFlow Agent 当前架构

## 当前状态（M01-04A）

项目采用前后端分离的本地优先结构：`backend/` 与 `extension/` 是两个独立的工程单元，各自维护依赖和构建流程。

```text
Toolbar action
        │  chrome.action.onClicked → chrome.sidePanel.open({ tabId })
        ▼
Chrome Side Panel
        │  PAGE_CAPTURE_REQUEST
        ▼
MV3 Background Service Worker
        │  activeTab + scripting
        ▼
当前 HTTP/HTTPS 页面 DOM
        │  PageSnapshot
        ▼
Side Panel 结果展示
        │  用户主动点击发送
        ▼
Background fetch + Bearer Token
        │  POST 127.0.0.1:8000/api/v1/pages/ingest
        ▼
FastAPI 校验服务
        │  用户勾选内容块 → POST /api/v1/notes/preview
        ▼
Markdown Note Service（确定性，不调用 LLM）
        │  返回 proposalId、Markdown 和 Diff
        ▼
Side Panel 用户确认
        │  POST /api/v1/notes/commit（仅 proposalId）
        ▼
Obsidian Vault/LearnFlow/*.md（受控安全写入）

FastAPI backend (backend/app/main.py)
        ├── /health
        ├── /api/v1/pages/ingest（快照校验）
        └── /api/v1/notes/preview + /commit（Markdown 预览与确认保存）
```

M01-02 在 M01-01 基础上增加用户显式触发的本地 HTTP 传输。M01-03 在此基础上增加用户显式选择和确认的 Markdown 笔记服务。页面快照、Markdown 和个人笔记都不进入日志；服务不监视标签页、不跨页面跟随、不调用 LLM、不使用 SQLite。

## 模块边界

### `backend/`

独立的 Python 3.12 uv 项目。FastAPI、Uvicorn、Pydantic 和 Pydantic Settings 已声明为运行时依赖，Pytest、HTTPX 和 Ruff 作为开发检查工具。`app/main.py` 创建 FastAPI 应用，`app/api/` 保存路由，`app/core/` 保存配置、鉴权和请求安全中间件，`app/schemas/` 保存跨语言 PageSnapshot 模型；后续服务和工具处理器都应放在后端包内，避免把业务代码散落到仓库根目录。`tests/` 使用 FastAPI TestClient 覆盖 HTTP 行为。

`app/notes/` 包含 URL/ID 解析、Vault 路径安全、Markdown 模板与受控区域合并、短期 Proposal Store 和预览/提交编排。它是确定性服务，不调用 Agent、LLM、SQLite 或 Obsidian 插件。VaultGuard 只接受已有且可访问的绝对 Vault 路径，并要求 `.obsidian` 目录；服务只能访问 `LearnFlow/` 受控子目录。

### `extension/`

独立的 TypeScript/Vite 项目。`sidepanel.html` 是 Chrome Side Panel 页面入口，`src/sidepanel/` 负责页面脚本、安全渲染、Token 配置和发送状态，`src/capture/` 定义 `PageSnapshot`、DOM extractor 和采集调度，`src/backend/` 负责 background fetch 的消息契约和固定本地 API 客户端，`src/background.ts` 注册 Manifest V3 service worker 消息处理。`public/manifest.json` 在构建时原样复制到 `dist/`，其中的路径与 Vite 输出保持一致。

当前申请 `sidePanel`、`activeTab`、`scripting`、`storage` 和 `http://127.0.0.1/*` Host Permission；没有申请 `<all_urls>`、`tabs` 或其他宽泛权限。Token 只存储在 `chrome.storage.local` 的 trusted contexts 中，background service worker 执行本地 fetch。注入函数必须自包含，因为 `chrome.scripting.executeScript({ func })` 不保留外部模块闭包。

M01-04A 在页面采集成功后增加独立的 AI 推荐区域。用户必须勾选云端发送确认并手动点击分析；请求路径为 Chrome Side Panel → Background Service Worker → 本地 FastAPI → 固定的 DeepSeek OpenAI-compatible Provider。DeepSeek Key 永不进入扩展。推荐只返回真实 `PageSnapshot.blocks[].id`、类别和理由，应用推荐只合并到现有手动选择，不自动预览或保存。

M01-03 的扩展显示内容块复选框和个人笔记输入。初始零选中；选择、输入变化或重新采集会使旧 proposal 失效，异步响应携带状态代次，不能恢复过期 proposal。预览只显示服务端生成的 Markdown 和 Diff，确认按钮只发送 proposalId。所有预览和网页文本使用 `textContent` 等安全方式渲染。

采集块的 `id` 是本次 Side Panel 交互使用的顺序标识；`stableKey` 是持久化提示，基于块类型、文本/代码语言指纹和同类块出现序号，不依赖页面绝对块序号。后端优先使用 `stableKey` 写入 marker，并按指纹出现序号兼容旧版 `block-N` marker；相同正文的不同合法重复块不会被简单合并。

后端根据规范化来源 URL 计算 SHA-256，生成 `LearnFlow/<safe-host>/<safe-slug>--<short-hash>.md`，客户端不能提供路径。首次写入先完整写入并刷盘同目录临时文件，再通过 Windows/NTFS 支持的排他硬链接发布，目标竞争出现时不会覆盖；更新使用同目录临时文件和 `os.replace`。预览时不创建目录或文件。检查与发布之间仍保留跨进程 TOCTOU 风险，因此不宣称消除 Obsidian 与其他进程的全部竞态；不支持不提供硬链接能力的文件系统回退覆盖。

`app/llm/` 定义 Provider 协议和 DeepSeek/OpenAI-compatible 实现；`app/ai_notes/` 构建有界上下文、明确的 Prompt 和模型输出业务校验。网页文本只作为不可信资料，不触发指令、工具调用、文件访问或网络目标变更。Provider 超时、鉴权、限流、上游错误、空响应、JSON/结构错误均映射为稳定 API 错误。

### `docs/`

记录架构边界、阶段性决策和后续演进方向，不承载运行时代码。

## 后续计划

1. 增加学习会话、选中文字上下文和自研 `TOOL_HANDLERS`，保持 Agent 实现不依赖 LangChain。
2. 引入 SQLite 元数据层，并在明确需求后扩展 Obsidian Markdown 生命周期管理。
3. 在明确用户授权后，为浏览器侧增加更丰富的上下文采集和端到端测试；权限随具体能力最小化增加。

4. M01-04B：在独立设计评审后实现 AI 结构化笔记 Compose；不得将 M01-04A 的推荐结果误认为已经完成 Compose。

LearnFlow v2.1 Agent Runtime 以及 Study、Note、Review Workflow 仍属于规划内容；本轮没有创建空的 Agent 模块或提前实现这些功能。
