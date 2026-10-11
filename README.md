# LearnFlow Agent

LearnFlow Agent 是一个本地优先的 AI 学习助手。它将理解学习上下文、调用工具、维护学习记忆，并把学习成果沉淀到 Obsidian。

本仓库当前完成 M00-02 基础服务，暂不包含数据库、向量库、OCR 或 LLM SDK。

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
│   ├── app/core/config.py
│   ├── tests/test_health.py
│   ├── pyproject.toml
│   └── uv.lock
├── extension/            # 独立 npm/Vite Chrome 扩展项目
│   ├── public/manifest.json
│   ├── src/background.ts
│   ├── src/sidepanel/
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
uv run uvicorn app.main:app --reload
```

服务启动后可访问：

- 健康检查：`http://127.0.0.1:8000/health`
- Swagger UI：`http://127.0.0.1:8000/docs`

### 浏览器扩展

```powershell
Set-Location extension
npm ci
npm run typecheck
npm run lint
npm run build
```

构建产物位于 `extension/dist/`。在 Chrome 中打开 `chrome://extensions`，启用“开发者模式”，选择“加载已解压的扩展程序”，然后选择 `extension/dist/`。点击扩展图标应打开 LearnFlow Agent 侧边栏，并显示 `Environment Ready`。

## 当前范围

M00-01 负责可重复的工程骨架、依赖锁定、基础检查和扩展加载入口。M00-02 增加 FastAPI 配置、健康检查和自动化测试。后续阶段再加入 Agent 工具处理器、记忆存储、Obsidian 同步与学习流程。
