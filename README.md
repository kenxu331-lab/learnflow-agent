# LearnFlow Agent

> **把“看懂教程”变成“留下可追溯的知识”。**
>
> 一个浏览器侧边栏里的 AI 学习助手：结合正在阅读的章节与选区回答问题，从对话中提炼知识，并在用户确认后保存到 Obsidian。

**Python · FastAPI · TypeScript · Chrome Extension · SQLite · LLM · Obsidian**

[快速开始](#快速开始) · [体验与演示](#体验与演示) · [工程亮点](#工程亮点) · [实现状态](#实现状态与边界) · [源码导航](#源码导航)

## 为什么做这个项目？

学习技术文档时，常见流程是：复制原文到聊天窗口 → 反复补充上下文 → 手动整理回答 → 再复制到笔记。对话结束后，往往分不清哪些是教程事实、哪些是自己的理解、哪些只是 AI 的解释。

LearnFlow 希望把这条链路放回阅读现场：

- **不用反复搬运上下文：** 扩展采集授权页面的正文、代码和当前选区，问答围绕当前章节展开。
- **不把聊天摘要直接当知识：** 提炼结果关联来源证据，拆成 Claim 后独立核验。
- **不让模型一句“已保存”代替写入：** 笔记由后端服务执行写入，用户先预览、再确认，界面显示实际结果。

这是一个本地优先的个人开发项目，不是托管 SaaS。使用远程模型时，获用户同意的学习上下文仍会发送给模型服务商；“本地优先”不代表完全离线。

## 体验与演示

以下是可复现的操作脚本，**不是预录的模型回答，也不是对回答质量的保证**。主分支可体验问答、命令式提炼和归档；自然语言工具调用及新工作台属于当前 M2 开发分支，尚未合入主分支，见[实现状态](#实现状态与边界)。

### 1. 阅读时直接问

打开一篇教程，启用学习模式，选中代码后提问：

> 这里为什么使用 Depends？结合当前教程解释，区分原文依据和你的补充说明。

界面流式显示回答，选区与当前章节作为上下文关联保存。目标体验是“围绕正在读的内容交流”，而不是脱离页面的通用聊天。

### 2. 从交流中留下知识

完成几轮有效问答后输入：

```text
/提炼
```

查看知识候选及核验状态；需要回看时使用 `/查看提炼`。**草稿、核验通过和已归档是不同状态**，证据不足不能被当作已验证知识。

M2 开发版进一步支持自然语言：“我们刚才讨论了这么久，有哪些知识点值得记住？”Agent 先查询已有成果，再决定是否提交提炼任务。

### 3. 保存到自己的笔记库

先使用“整理并保存当前章节”生成并确认原文章节笔记，再对已具备归档资格的知识点击归档入口，或使用：

```text
/归档 1
/归档 all
```

按当前版本的界面提示完成确认，再到 Obsidian 核对实际文件内容。**提炼或查看候选本身不会写入笔记。**

M2 开发版将此流程升级为持久化确认卡片：勾选知识 → 查看合并 Markdown Diff → 点击确认 → 检查版本后写入 → 返回真实文件和位置；关闭预览不是确认。

### 能看到怎样的产物？

正文、标题层级和代码可转为 Obsidian 可读的 Markdown；知识候选保留证据与核验状态，而不是只输出一段聊天总结。

- [Markdown 输出样例](docs/examples/fastapi_body_v2.md)
- [新旧文档输出对比](docs/examples/document_quality_comparison.md)

以上是**仓库内回归样例的静态输出**，不是当前浏览器实测截图。当前 README 不提供录屏，也不把 HTML 原型当作实际产品截图。

## 工程亮点

### 从页面到知识：保留来源，而不是只保留一段回答

确定性文档引擎将 `PageSnapshot → Document AST → Markdown`，单独处理标题、代码、列表、表格及来源映射；文档转换本身不消耗 LLM Token。学习问答通过 SSE 返回增量消息，SQLite 保存会话与学习事件。

### 提炼和核验分离

知识流水线为：

```text
学习事件与教程证据
    → Knowledge Draft
    → 原子 Claim + Evidence Registry
    → 独立证据核验
    → PublishCandidate
    → 用户确认后由写入服务归档
```

证据 ID 由应用管理，并校验模型引用是否真实存在。教程事实需要可解析的原文或选区证据；历史 AI 回答不能独立证明事实。核验是独立调用，不代表使用不同模型，也不能保证完全消除幻觉。

### 把可靠性放在业务边界

已有任务调度使用事件高水位、批次指纹、租约和有限重试管理提炼，避免把每次聊天都当成新的完整总结。写入沿用路径约束、版本检查与受控内容更新，不能由模型自由指定任意本地文件。

**M2 开发分支增量：**

- **受控业务 Agent：** 基于原生 Function Calling 和自研处理器，提供读取上下文、查询知识、提炼、查询结果和预览归档 5 类工具；限制步数、超时、参数和上下文预算，不开放 Shell 或任意文件执行。
- **可恢复任务：** 业务任务和消息卡片持久化，等待由应用恢复，不让模型不断轮询。精确去重与文本相似提示分开，避免误合并不同结论。
- **Human-in-the-loop：** 归档审批绑定知识版本、Vault、文件哈希和计划摘要；跨进程锁、意图记录和内容校验支持重复确认幂等及中断恢复。模型没有直接确认写入的工具。
- **Chat-first 工作台：** 独立消息滚动、代码高亮、放大阅读和独立宽屏窗口，复用后端会话与真实任务状态。

不引入 LangChain / LangGraph，模型负责有边界的判断与工具选择，确定性校验、任务调度和文件操作由普通业务代码承担。

## 实现状态与边界

**2026-10-15 核对：当前开发分支为 `codex/m2-archive-confirmation`，包含 M1/M2 功能代码与测试，尚未合入主分支。** 克隆主分支不能直接获得全部 M2 体验；开发分支是否已推送，以 GitHub 实际可见分支为准。

| 能力 | GitHub 主分支 | 当前 M2 开发分支，未合入主分支 |
| --- | --- | --- |
| 授权网页采集、结构化 Markdown 预览与保存 | 已有实现 | 补充采集与章节切换修复 |
| SSE 学习问答、会话持久化 | 已有实现 | 增加工具事件与工作台体验 |
| 手动提炼、Claim 核验、候选归档 | 已有实现 | 增加自然语言任务与恢复视图 |
| 有界 Function Calling Agent | 尚未集成 | 已实现，待真实模型联调验收 |
| V3 侧栏与独立宽屏工作台 | 尚未集成 | 已实现，待浏览器联合验收 |
| 持久化归档确认、审批摘要和恢复闭环 | 尚未集成 | 已实现并有专项自动化测试 |

当前不包含向量数据库、Embedding 检索、跨站语义 RAG、模型训练、多 Agent 协作或任意代码执行。知识查询主要是章节范围内的关键词过滤；相似提示是文本相似度，不是语义检索。

网页采集受浏览器权限、页面结构和正文可访问性限制，不保证任意网站均可完整采集；图片引用不等于资源已下载。模型效果受实际模型与原文质量影响，暂未发布准确率、延迟、并发或用户规模指标。

## 架构与技术栈

```text
Chrome Extension：页面/选区 → Side Panel → 本地 API
                                      ↓
FastAPI：学习会话 / LLM Provider / 提炼与证据核验
              ↕                       ↓
         SQLite 元数据          预览 → 用户确认 → Vault 安全写入
                                                ↓
                                         Obsidian Markdown
```

| 层 | 技术与职责 |
| --- | --- |
| 扩展 | TypeScript、Vite、Chrome Manifest V3、Side Panel、原生 HTML/CSS |
| 文档 | Defuddle / Mozilla Readability / DOM 提取，快照与 AST 规范化 |
| 后端 | Python 3.12、FastAPI、Pydantic、asyncio |
| 模型 | OpenAI-compatible SDK；当前配置示例使用 DeepSeek |
| 存储 | SQLite 保存状态、事件、证据和知识元数据；Markdown 保存笔记 |
| 质量 | pytest、Vitest、Ruff、TypeScript、ESLint |

## 快速开始

以下以 Windows PowerShell 为例。准备 Python 3.12、uv、Node.js 22+、Chrome，以及一个专用测试 Obsidian Vault。

### 1. 启动后端

```powershell
git clone https://github.com/kenxu331-lab/learnflow-agent.git
Set-Location learnflow-agent/backend
uv sync --locked
Copy-Item .env.example .env
uv run python -c "import secrets; print(secrets.token_urlsafe(32))"
```

编辑刚创建的 `backend/.env`，至少填写：

```dotenv
LEARNFLOW_LOCAL_API_TOKEN=填写刚生成的本地令牌
LEARNFLOW_VAULT_PATH=D:\path\to\your-test-vault
LEARNFLOW_LLM_BASE_URL=https://api.deepseek.com
LEARNFLOW_LLM_MODEL=填写服务商当前可用且兼容的模型名称
LEARNFLOW_LLM_API_KEY=填写你自己的模型密钥
```

Vault 必须已存在且包含 Obsidian 生成的 `.obsidian` 目录。密钥只配置在后端，不写入扩展或提交 Git；不确定模型名称时以服务商当前文档和账号权限为准。M2 工具调用还要求模型接口支持 Function Calling。

```powershell
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

健康检查：[http://127.0.0.1:8000/health](http://127.0.0.1:8000/health)；接口文档：[http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs)。

### 2. 加载扩展

另开终端，在仓库根目录执行：

```powershell
Set-Location extension
npm ci
npm run build
```

打开 `chrome://extensions` → 开启开发者模式 → 加载已解压的扩展程序 → 选择 `extension/dist`。

在扩展设置中保存与后端一致的本地 Token；打开教程网页，点击扩展图标并按提示授予当前站点学习权限。需要模型处理时单独确认云端发送。首次体验建议使用公开教程和测试 Vault，不使用私人笔记。

### 3. 走一遍完整流程

1. 打开 [FastAPI 依赖项教程](https://fastapi.tiangolo.com/zh/tutorial/dependencies/)，授权并采集。
2. 整理并保存当前章节，确认 Markdown 中代码和标题正常。
3. 选中一段代码提问，观察流式回答及章节关联。
4. 几轮交流后输入 `/提炼`，检查候选及核验结果。
5. 选择可归档知识、完成确认，到实际 Vault 检查内容。
6. 切换章节再切回，检查是否恢复对应会话；遇到错误保留真实状态，不把模型文本当作成功凭据。

## 验证与安全

执行检查：

```powershell
# backend 目录
uv sync --locked
uv run ruff check .
uv run pytest

# extension 目录
npm ci
npm run typecheck
npm run lint
npm test
npm run build
```

最近一次**本地 M2 开发版本**验证记录（不是主分支 CI 徽章）：扩展 168 项测试通过；后端相关专项曾有 58 项通过记录；提交前重新运行后端全量测试，结果为 168 通过、14 项既有失败。失败涉及旧测试对提炼返回值和无新增状态的预期，尚待单独处理。提交前 Ruff、TypeScript、ESLint 与扩展构建通过。

测试主要使用隔离模型替身与临时 Vault，不能据此宣称真实模型效果或 Chrome 人工联合验收已经全部通过。暂不提供虚构的准确率或性能提升数据。

安全设计包括本地服务默认监听 `127.0.0.1`、Bearer Token、Host/Origin 校验、请求体限制，以及 Vault 路径与符号链接/Windows 重解析点检查。网页内容属于不可信数据；站点访问授权与云端模型发送同意分别管理。模型调用可能产生费用。

## 源码导航

- [学习会话与 SSE](backend/app/study_chat/)：章节上下文、流式回答、消息持久化。
- [知识提炼与核验](backend/app/knowledge/)：任务调度、证据注册、草稿与发布资格。
- [学习记忆](backend/app/learning_memory/)：SQLite 会话与学习事件。
- [文档引擎](backend/app/document_engine/)：规范化、AST、Markdown 输出与质量诊断。
- [笔记安全服务](backend/app/notes/)：Vault 约束、预览与确认保存。
- [注解规划](backend/app/annotation_planner.py) / [写入服务](backend/app/annotation_writer.py)：来源锚点、计划、版本与文件操作。
- [扩展采集](extension/src/capture/) / [学习状态](extension/src/study/) / [侧栏](extension/src/sidepanel/)。
- [后端测试](backend/tests/) / [扩展测试](extension/tests/)。
- [架构文档](docs/architecture.md)与[S2 设计](docs/LearnFlow_S2_Technical_Design_V1.md)：保留历史设计背景，具体实现以源码及上方状态表为准。

当前开发分支另含 [Agent 工具调用](backend/app/agent/)、[持久化归档确认](backend/app/archive/)、[M1 工作台说明](docs/LearnFlow_V3_M1_UI.md)及[M2 归档交付文档](docs/LearnFlow_V3_M2_Archive_Confirmation.md)。这些路径仅适用于包含对应代码的开发分支。
