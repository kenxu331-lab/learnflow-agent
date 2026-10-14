# LearnFlow Agent

LearnFlow Agent 是一个本地优先的 AI 学习助手。它将理解学习上下文、调用工具、维护学习记忆，并把学习成果沉淀到 Obsidian。

本仓库当前完成 M01-04A 单页采集、页面快照安全传输、AI 重点推荐，以及用户确认后的 Markdown 笔记保存。本开发分支增加 M01-04C-01a 的零 Token Document Engine V2，同时保留 M01-04C-00 的 Chat-first 学习工作台；自动采集与可恢复学习会话来自已合并的 M01-04B。暂不包含数据库、向量库、OCR、Agent Loop 或 AI 结构化笔记生成。

## 技术栈

- 后端：Python 3.12、uv、FastAPI、Uvicorn、Pydantic、OpenAI-compatible SDK、Ruff
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
│   ├── app/llm/               # LLM Provider 抽象与 DeepSeek 兼容实现
│   ├── app/ai_notes/           # Context、Prompt 和推荐业务校验
│   ├── app/document_engine/    # PageSnapshot → Document AST → Markdown V2
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
│   ├── src/study/        # 站点授权、自动采集调度和本地学习会话
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

### M01-04A DeepSeek AI 重点推荐

M01-04A 使用后端 OpenAI-compatible Provider 调用 DeepSeek，默认模型为 `deepseek-flash`。API Key 只放在后端 `.env` 或安全环境变量中，不进入 Chrome 扩展、Git、日志或接口响应。配置示例见 `backend/.env.example`。

用户流程为：采集页面 → 明确确认云端发送 → AI 分析 → 查看推荐并逐项取消 → 应用推荐到真实内容块选择 → 继续使用 M01-03 的 Markdown 预览和确认保存。AI 推荐不会自动保存笔记，也不会调用 Vault、文件系统或工具。

新增接口为 `POST /api/v1/ai/notes/recommend`。它通过 Bearer Token、本地 Host/Origin 和 JSON 请求限制保护；测试使用 Fake Provider，不调用真实 DeepSeek。上下文超限会明确返回 `analysis.truncated`，模型输出必须经过 JSON、Pydantic、blockId 来源和业务约束校验。

M01-04A 只推荐教程重点，不生成 AI 结构化 Markdown，不实现 Agent Loop、RAG、SQLite 或 M01-04C Compose。

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

采集使用 `sidePanel`、`activeTab`、`scripting` 和 `webNavigation` 权限，不申请 `<all_urls>` 或宽泛 Host Permissions。当前支持普通 HTTP/HTTPS 教程、文档和 README 页面；`chrome://`、扩展页、开发者工具页、无正文页面和注入权限不足的页面会返回明确错误。M01-04B 的采集服务优先执行 Defuddle，失败时回退 Mozilla Readability 和既有确定性 DOM Extractor。M01-04B 在用户授权后由 Background Service Worker 自动调度该采集服务，使用顶层 `webNavigation` 历史/fragment 事件支持普通导航、前进后退和常见 SPA 路由变化；自动采集只保存在本地学习状态中，不上传 DeepSeek、不写入 Obsidian。手动采集入口继续保留。

M01-04B 对 FastAPI 保留精确的可选 Host Permission `https://fastapi.tiangolo.com/*`；其他 HTTP/HTTPS 教程站点使用用户点击扩展工具栏图标后获得的 `activeTab` 临时访问权。用户点击“在此网站启用学习模式”后，LearnFlow 只绑定当前网页来源；跨站导航不会继续自动读取，必须在新站点重新点击扩展图标。没有申请 `<all_urls>`。站点授权和云端 AI 授权分开，未授权站点不会自动注入采集脚本。成熟 DOM 解析器会保留可识别的图片远程引用、表格、链接和代码结构；图片资源暂不下载到 Vault，并在 diagnostics 中明确标记。

## 当前范围

M00-01 负责可重复的工程骨架、依赖锁定、基础检查和扩展加载入口。M00-02 增加 FastAPI 配置、健康检查和自动化测试。M01-01 增加浏览器当前页面的显式单页采集。M01-02 增加带本地 Token 鉴权的页面快照传输。M01-04B 增加授权站点自动采集和本地学习会话底座；后续阶段再加入 Agent 工具处理器、AI 问答、记忆存储和 AI 注解式 Markdown。

M01-02 的本地服务配置：在 `backend/.env` 设置 `LEARNFLOW_LOCAL_API_TOKEN`，扩展中保存同一个 Token 后，用户可主动点击“发送到本地服务”。服务只返回校验状态和统计摘要，不保存正文；网络、401、422、413 和超时错误会在侧边栏显示。

### M01-03 Markdown 笔记闭环

用户先在采集结果中勾选一个或多个内容块，可选填写个人学习笔记，然后依次点击“生成 Markdown 预览”和“确认保存”。扩展只把 `PageSnapshot` 和所选 block ID 发送到固定的本地 API；Background Service Worker 负责 HTTP 请求，网页上下文不会直接访问后端。

- `POST /api/v1/notes/preview`：服务端重新校验快照和选择，从 URL 派生稳定 note ID、目标相对路径和完整 Markdown 预览；预览不会创建目录或文件。
- `POST /api/v1/notes/commit`：只接受不透明 `proposalId`，用户明确确认后才写入；返回 `created`、`updated` 或 `unchanged`。
- Markdown 使用 YAML frontmatter、受控摘录区和个人笔记区。摘录按页面块原始顺序保存，代码缩进与围栏保留，受控标记和用户文本会做转义。页面采集同时生成稳定摘录键：包含块类型、文本/语言指纹和同类块出现序号；展示用的 `block-N` 仅用于本次勾选交互。
- 来源 URL 经规范化后计算 SHA-256：`chapterId=chapter-<hash 前 32 位>`、`noteId=learnflow-<hash 前 32 位>`。新文件优先使用网页标题命名为 `LearnFlow/<safe-host>/<title>.md`；同目录同名文件属于其他来源时才追加 `<hash 前 20 位>`。已有 `slug--hash.md` 文件会被识别并继续更新，不自动重命名或删除。
- 后端只访问 Vault 下的 `LearnFlow/` 受控目录，拒绝非 LearnFlow 文件、损坏标记、符号链接/Windows 重解析点和路径穿越。追加只修改受控区域，保留个人笔记和其他用户内容。个人笔记使用独立 fingerprint 记录，重复内容精确去重，不使用子字符串判断；旧版无 fingerprint 的笔记也按完整内容兼容判断。
- 预览提案默认 10 分钟过期，保存在单个后端进程内存中；服务重启、多 worker 或多实例不会保留提案。预览后文件被外部修改时返回 409，要求重新预览。

当前 M01-03 不保存学习会话，不使用 SQLite、LLM 或 Agent Runtime，不自动跟踪网页导航，也不把网页文本当作系统指令执行。文件检查到原子替换之间仍存在跨进程竞态，Obsidian 中手动移动或重命名笔记也不会被自动追踪。

### M01-04B 自动采集与学习会话

学习模式状态由扩展 Background Service Worker 管理，并写入 `chrome.storage.local`，因此 Service Worker 休眠或重启后可以恢复启用状态、当前章节、快照版本指纹和最近错误。当前状态至少包含 `sessionId`、`chapterId`、`sourceUrl`、`pageTitle`、`snapshotHash`、`capturedAt`、`updatedAt` 和 `status`；同一章节的重复 URL/内容不会创建新的会话记录，过期采集结果不能覆盖新章节。

自动采集使用有限防抖与重试，不因每次 DOM 微小变化触发模型请求。M01-04B 不自动调用 AI，现有 M01-04A 的 AI 推荐仍需用户单独勾选云端同意并手动点击分析。当前会话存储是扩展本地的轻量过渡方案，后续可将同一会话/快照接口迁移到后端 SQLite 来源索引；最终 Markdown 仍必须经过 M01-03 Note Service 的 Preview/Commit 和用户确认。

M01-04B 手工验收：执行 `npm.cmd run build` 后，在 `chrome://extensions` 重新加载 `extension/dist`；打开 FastAPI 教程，点击工具栏图标打开侧边栏，再点击“在此网站启用学习模式”并接受精确站点权限。页面初次加载、普通章节导航、浏览器前进/后退及站点 SPA 路由变化应更新“当前学习”状态；重复回到相同内容不应创建新会话。点击“暂停自动学习”后不应再自动读取页面；`chrome://extensions` 或未授权网站不应触发自动采集。自动采集不会自动发送 DeepSeek，也不会自动写入 Obsidian。

### M01-04C-00 对话式学习工作台

Side Panel 采用 Chat-first 布局：顶部显示真实 StudyState 和 PageSnapshot 上下文，主区域预留学习对话，底部输入区明确标记对话能力尚未接入，不会伪造 AI 回复。笔记入口“整理原文笔记”复用现有 Note Preview/Commit，并默认包含当前快照的全部有效内容块；AI 注解入口仅展示未就绪状态，不调用旧版重点推荐 API 冒充注解。旧版手动采集、AI 推荐、Token 和技术诊断仍保留在“高级工具”折叠区。

### M01-04C-01a Document Engine V2

Document Engine V2 是独立于旧版 Note Service 的确定性只读预览链路：

```text
PageSnapshot v1 → SourceNormalizer → DocumentAST → MarkdownRendererV2
```

后端新增 `POST /api/v1/documents/preview` 和 `POST /api/v1/documents/commit`。预览只接受经过 PageSnapshot 校验的 JSON，使用本地 Bearer Token 鉴权，返回新版 Markdown、proposalId 和覆盖诊断；提交只接受 proposalId，并使用现有 VaultGuard、版本检查和安全发布机制保存预览中的同一份 Markdown。两条接口都不调用 DeepSeek，AST 单独保存标题层级、段落、代码、列表和源块映射，Markdown 输出不包含 `LF_BLOCK`、fingerprint 或旧版受控区域标记。

Side Panel 现在只有一个主流程“整理并保存当前章节”：使用当前真实 StudyState/PageSnapshot 生成新版预览，并由确认按钮保存完全相同的 Markdown。章节切换会使旧的新版预览和 proposal 失效。旧版 Note Preview/Commit 后端保留兼容已有调用和旧文件，但旧版入口不再显示在主界面。

当前 PageSnapshot v1 可以表达标题、段落、代码、列表、表格、Callout、行内链接和远程图片引用；图片二进制资源、复杂嵌套列表和跨页面资源下载仍作为覆盖限制保留在诊断中。仓库中的 FastAPI body fixture 是基于目标 URL 和已知内容构造的回归样例，不是从当前 Chrome 会话导出的真实快照，真实浏览器质量仍需 M01-04C-01d 人工补验。
