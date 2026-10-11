# LearnFlow Agent 当前架构

## 当前状态（M00-01）

项目采用前后端分离的本地优先结构：`backend/` 与 `extension/` 是两个独立的工程单元，各自维护依赖和构建流程。

```text
Chrome Side Panel (extension/dist)
        │  后续通过本地 HTTP API 通信
        ▼
FastAPI backend (backend/app)
        │
        ├── TOOL_HANDLERS（后续实现）
        ├── 学习上下文与记忆（后续实现）
        ├── SQLite 元数据（后续实现）
        └── Obsidian Markdown（后续实现）
```

本阶段只提供构建和加载骨架，不创建 API、数据库或 Agent 业务逻辑。

## 模块边界

### `backend/`

独立的 Python 3.12 uv 项目。FastAPI、Uvicorn 和 Pydantic 已声明为运行时依赖，Ruff 作为开发检查工具。`app/` 是后端 Python 包的边界，后续 API 路由、服务和工具处理器都应放在这里，避免把业务代码散落到仓库根目录。

### `extension/`

独立的 TypeScript/Vite 项目。`sidepanel.html` 是 Chrome Side Panel 页面入口，`src/sidepanel/` 负责页面脚本与样式，`src/background.ts` 是 Manifest V3 service worker。`public/manifest.json` 在构建时原样复制到 `dist/`，其中的路径与 Vite 输出保持一致。

当前只申请 `sidePanel` 权限；没有预先申请 `<all_urls>`、标签页读取或其他不属于本阶段的权限。

### `docs/`

记录架构边界、阶段性决策和后续演进方向，不承载运行时代码。

## 后续计划

1. 定义后端健康检查和最小本地 API，建立扩展到后端的通信约定。
2. 增加学习上下文、任务编排和自研 `TOOL_HANDLERS`，保持 Agent 实现不依赖 LangChain。
3. 引入 SQLite 元数据层与 Obsidian Markdown 存储适配器，并补充迁移和错误处理。
4. 为浏览器侧增加页面上下文采集、用户确认流程和端到端测试；权限随具体能力最小化增加。
