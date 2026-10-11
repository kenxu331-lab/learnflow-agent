# LearnFlow Agent 当前架构

## 当前状态（M01-02）

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
FastAPI 校验服务（不持久化）

FastAPI backend (backend/app/main.py)
        ├── /health
        └── /api/v1/pages/ingest（当前；仅校验）
```

M01-02 在 M01-01 基础上增加用户显式触发的本地 HTTP 传输。服务只验证快照并返回统计摘要，不保存请求体；不监视标签页、不跨页面跟随、不调用 LLM、不使用数据库、不写入 Obsidian。

## 模块边界

### `backend/`

独立的 Python 3.12 uv 项目。FastAPI、Uvicorn、Pydantic 和 Pydantic Settings 已声明为运行时依赖，Pytest、HTTPX 和 Ruff 作为开发检查工具。`app/main.py` 创建 FastAPI 应用，`app/api/` 保存路由，`app/core/` 保存配置、鉴权和请求安全中间件，`app/schemas/` 保存跨语言 PageSnapshot 模型；后续服务和工具处理器都应放在后端包内，避免把业务代码散落到仓库根目录。`tests/` 使用 FastAPI TestClient 覆盖 HTTP 行为。

### `extension/`

独立的 TypeScript/Vite 项目。`sidepanel.html` 是 Chrome Side Panel 页面入口，`src/sidepanel/` 负责页面脚本、安全渲染、Token 配置和发送状态，`src/capture/` 定义 `PageSnapshot`、DOM extractor 和采集调度，`src/backend/` 负责 background fetch 的消息契约和固定本地 API 客户端，`src/background.ts` 注册 Manifest V3 service worker 消息处理。`public/manifest.json` 在构建时原样复制到 `dist/`，其中的路径与 Vite 输出保持一致。

当前申请 `sidePanel`、`activeTab`、`scripting`、`storage` 和 `http://127.0.0.1/*` Host Permission；没有申请 `<all_urls>`、`tabs` 或其他宽泛权限。Token 只存储在 `chrome.storage.local` 的 trusted contexts 中，background service worker 执行本地 fetch。注入函数必须自包含，因为 `chrome.scripting.executeScript({ func })` 不保留外部模块闭包。

### `docs/`

记录架构边界、阶段性决策和后续演进方向，不承载运行时代码。

## 后续计划

1. 增加学习会话、选中文字上下文和自研 `TOOL_HANDLERS`，保持 Agent 实现不依赖 LangChain。
3. 引入 SQLite 元数据层与 Obsidian Markdown 存储适配器，并补充迁移和错误处理。
4. 在明确用户授权后，为浏览器侧增加更丰富的上下文采集和端到端测试；权限随具体能力最小化增加。
