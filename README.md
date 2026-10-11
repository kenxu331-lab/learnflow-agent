# LearnFlow Agent

LearnFlow Agent 是一个本地优先的 AI 学习助手。它将理解学习上下文、调用工具、维护学习记忆，并把学习成果沉淀到 Obsidian。

本仓库当前完成 M01-03 单页采集、页面快照安全传输，以及用户确认后的 Markdown 笔记保存。暂不包含数据库、向量库、OCR 或 LLM SDK。

## 技术栈

- 后端：Python 3.12、uv、FastAPI、Uvicorn、Pydantic、Ruff
- 浏览器扩展：TypeScript、Vite、Chrome Manifest V3、Side Panel API、原生 HTML/CSS
- 计划中的存储：Obsidian Markdown + SQLite
- 计划中的 Agent：自研 `TOOL_HANDLERS`，不使用 LangChain

## 目录结构

```text
.
├── backend/              # 独立 uv Python 项目
│   ├── app/__init__.py
│   ├── app/main.py
│   ├── app/api/health.py
│   ├── app/api/pages.py
│   ├── app/core/config.py
│   ├── app/core/auth.py
│   ├── app/core/middleware.py
│   ├── app/notes/             # Vault 安全、Markdown、提案和保存服务
│   ├── app/schemas/page_snapshot.py
│   ├── app/schemas/notes.py
│   ├── .env.example
│   ├── tests/test_health.py
│   ├── tests/test_notes.py
│   ├── tests/test_pages_ingest.py
│   ├── pyproject.toml
│   └── uv.lock
├── extension/            # 独立 npm/Vite Chrome 扩展项目
│   ├── public/manifest.json
│   ├── src/capture/
│   ├── src/backend/
│   ├── src/background.ts
│   ├── src/sidepanel/
│   ├── tests/
│   ├── sidepanel.html
│   ├── package.json
│   └── vite.config.ts
├── docs/architecture.md  # 当前架构与后续计划
└── README.md
```

## Windows 环境安装

请先安装并确保以下命令位于 `PATH`：

- Python 3.12
- uv
- Node.js 22+（包含 npm）
- Google Chrome（手工加载扩展时需要）

### 后端

在 PowerShell 中执行：

```powershell
Set-Location backend
uv sync
uv run ruff check .
uv run pytest
uv run python -c "import fastapi, pydantic; print(f'FastAPI {fastapi.__version__}; Pydantic {pydantic.__version__}')"
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

服务启动后可访问：

- 健康检查：`http://127.0.0.1:8000/health`
- Swagger UI：`http://127.0.0.1:8000/docs`

生成本地 Token：

```powershell
uv run python -c "import secrets; print(secrets.token_urlsafe(32))"
```

将输出配置为 `backend/.env` 中的 `LEARNFLOW_LOCAL_API_TOKEN=...`。`POST /api/v1/pages/ingest` 使用 `Authorization: Bearer <token>`，未配置或错误 Token 返回 401。

启用 M01-03 时，还要配置一个已有的 Obsidian 测试 Vault：

```text
LEARNFLOW_VAULT_PATH=D:\\workspace\\learnflow-test-vault
```

Windows 测试 Vault 建议先创建一个空目录，再用 Obsidian 打开，由 Obsidian 生成 `.obsidian` 目录。自动化测试只使用 pytest 临时目录，不接触私人 Vault。

### 浏览器扩展

```powershell
Set-Location extension
npm ci
npm run typecheck
npm run lint
npm run test
npm run build
```

构建产物位于 `extension/dist/`。在 Chrome 中打开 `chrome://extensions`，启用“开发者模式”，选择“加载已解压的扩展程序”，然后选择 `extension/dist/`。点击扩展图标应打开 LearnFlow Agent 侧边栏，并显示 `Environment Ready`。

### M01-01 页面采集

用户点击扩展工具栏图标时，Manifest V3 background service worker 通过 `chrome.action.onClicked` 显式调用 `chrome.sidePanel.open({ tabId })`；这个用户手势用于建立 `activeTab` 临时访问上下文。随后侧边栏的“采集当前页面”按钮发送请求，service worker 查询并校验目标标签页，在 HTTP/HTTPS 页面中通过 `chrome.scripting.executeScript` 执行自包含 DOM extractor，返回标题、URL、章节、段落、代码块和列表组成的 `PageSnapshot`。结果只在侧边栏展示，不请求 FastAPI、不写数据库、不调用 LLM，也不修改网页内容。

采集使用 `sidePanel`、`activeTab` 和 `scripting` 权限，不申请 `<all_urls>` 或宽泛 Host Permissions。当前支持普通 HTTP/HTTPS 教程、文档和 README 页面；`chrome://`、扩展页、开发者工具页、无正文页面和注入权限不足的页面会返回明确错误。M01-01 不包含跨页面跟随、选中文字提问、学习会话、AI 问答或 Obsidian 写入，这些能力留待后续模块。

## 当前范围

M00-01 负责可重复的工程骨架、依赖锁定、基础检查和扩展加载入口。M00-02 增加 FastAPI 配置、健康检查和自动化测试。M01-01 增加浏览器当前页面的显式单页采集。M01-02 增加带本地 Token 鉴权的页面快照传输。后续阶段再加入 Agent 工具处理器、学习会话、AI 问答、记忆存储和 Obsidian 同步。

M01-02 的本地服务配置：在 `backend/.env` 设置 `LEARNFLOW_LOCAL_API_TOKEN`，扩展中保存同一个 Token 后，用户可主动点击“发送到本地服务”。服务只返回校验状态和统计摘要，不保存正文；网络、401、422、413 和超时错误会在侧边栏显示。

### M01-03 Markdown 笔记闭环

用户先在采集结果中勾选一个或多个内容块，可选填写个人学习笔记，然后依次点击“生成 Markdown 预览”和“确认保存”。扩展只把 `PageSnapshot` 和所选 block ID 发送到固定的本地 API；Background Service Worker 负责 HTTP 请求，网页上下文不会直接访问后端。

- `POST /api/v1/notes/preview`：服务端重新校验快照和选择，从 URL 派生稳定 note ID、目标相对路径和完整 Markdown 预览；预览不会创建目录或文件。
- `POST /api/v1/notes/commit`：只接受不透明 `proposalId`，用户明确确认后才写入；返回 `created`、`updated` 或 `unchanged`。
- Markdown 使用 YAML frontmatter、受控摘录区和个人笔记区。摘录按页面块原始顺序保存，代码缩进与围栏保留，受控标记和用户文本会做转义。页面采集同时生成稳定摘录键：包含块类型、文本/语言指纹和同类块出现序号；展示用的 `block-N` 仅用于本次勾选交互。
- 来源 URL 经规范化后计算 SHA-256：`chapterId=chapter-<hash 前 32 位>`、`noteId=learnflow-<hash 前 32 位>`，路径为 `LearnFlow/<safe-host>/<safe-slug>--<hash 前 20 位>.md`。页面标题变化不会改变路径。
- 后端只访问 Vault 下的 `LearnFlow/` 受控目录，拒绝非 LearnFlow 文件、损坏标记、符号链接/Windows 重解析点和路径穿越。追加只修改受控区域，保留个人笔记和其他用户内容。个人笔记使用独立 fingerprint 记录，重复内容精确去重，不使用子字符串判断；旧版无 fingerprint 的笔记也按完整内容兼容判断。
- 预览提案默认 10 分钟过期，保存在单个后端进程内存中；服务重启、多 worker 或多实例不会保留提案。预览后文件被外部修改时返回 409，要求重新预览。

当前 M01-03 不保存学习会话，不使用 SQLite、LLM 或 Agent Runtime，不自动跟踪网页导航，也不把网页文本当作系统指令执行。文件检查到原子替换之间仍存在跨进程竞态，Obsidian 中手动移动或重命名笔记也不会被自动追踪。
