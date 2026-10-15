# M2 第一步：只读学习 Agent

## 已实现的范围

普通学习聊天升级为单 Agent 的 native function calling 循环，不执行模型生成的代码，不增加第三方编排框架。只注册 `read_learning_context`。本阶段不接知识查询、提炼任务或归档工具；原有斜杠命令仍走既有业务链路。

调用关系：Side Panel → `streamStudyChat` → `StudyChatService` → `ReadonlyAgent` → `OpenAICompatibleProvider.stream_agent` → 已注册工具 → 工具结果回传模型 → 流式解释与来源引用。

扩展请求明确传入 `readonlyAgent: true`；旧客户端省略字段时仍走原 S1 聊天路径。这是明确的接口兼容分支，不是 Agent 失败后的自动降级。Agent 模式缺少工具协议或上游拒绝调用时返回错误，不伪装成功。

## 工具与安全边界

- 工具参数：可选 `query`（最多 200 字符）、`blockIds`（最多 8 个）、`kind`（all/code）。额外参数被拒绝。
- 只读取本次请求冻结的 PageSnapshot，不抓取新网页，不访问其他会话、文件、密钥或 Vault。
- 每次最多返回 8 个块，每块最多 3000 字符，原文总量最多 12000 字符，明确标记截断，并返回真实 sourceUrl、blockId、language、capturedAt。
- 初始上下文包含选区和受限原文索引，不将整章无条件塞入提示词；Agent 可按关键词查询索引外的块。
- 模型参数通过 Pydantic 校验；未知工具、无效参数和找不到的块作为结构化失败返回，供模型修正。
- 网页、选区、历史和工具结果始终是低信任参考资料。引用格式由提示词约束，不等于程序已经核验模型回答中的每条引用。

## 执行限制与停止

最多 6 次模型决策，每步最多 4 次工具调用；限制参数、上下文和最终回答长度。默认总超时 120 秒，可通过 `LEARNFLOW_STUDY_AGENT_TIMEOUT_SECONDS` 调整（硬上限 300 秒）。`LEARNFLOW_STUDY_AGENT_MAX_STEPS` 可调低，上限 6。

保留现有单次模型请求超时，不自动重复模型请求。未知工具或参数错误可在剩余决策预算内修正。达到限制、流未完整结束、模型失败均返回明确错误，不执行不完整的工具调用。

流式工具参数按调用 index 聚合，确认完整结束后才交给 Runtime。停止/断开会关闭异步生成器并保存已产生的回答和未完成状态，不继续下一步工具调用。进程被强制终止时没有自动续跑或孤儿任务修复，本阶段仅恢复已持久化记录。

## 事件与消息恢复

SSE 沿用 `delta`、`error`、`done`，新增 `activity`，支持：

- `tool_started`：收到并开始处理工具请求，不代表执行成功。
- `tool_finished`：只读工具返回成功，可包含零条匹配。
- `tool_failed`：工具被拒绝、参数无效或读取目标不存在。
- `task_completed`：解释完成且已保存学习记录。
- `task_failed`：超时、限制、错误或停止。

公共字段：eventId、runId、conversationId、sourceUrl、sequence、activityId、createdAt、toolName、summary、error。只记录执行事实，不发送内部思维链，也不发送工具的原文结果到 UI 日志。

SQLite 新增 `study_activities` 表，不改原有业务表字段。事件绑定 assistant message，`StudyMessage.activities` 随消息恢复。前端校验来源，按 eventId 去重，默认折叠，保持用户手动展开状态；错误时保留已输出的部分答案。

## 文件职责

- `backend/app/agent/readonly.py`：工具 schema、白名单注册表、快照查询与执行循环。
- `backend/app/llm/base.py`、`openai_compatible.py`：原生工具协议、流参数聚合及上游错误处理。
- `backend/app/study_chat/service.py`：Agent 分支、上下文预算、SSE、消息与执行状态保存。
- `backend/app/learning_memory/store.py`：附加执行事件表与恢复。
- `backend/app/schemas/activity.py`、`study.py`、`core/config.py`：事件、请求兼容字段和运行限制。
- `extension/src/backend/activity-types.ts`、`api-client.ts`、`types.ts`：共享事件类型、SSE 校验与回调。
- `extension/src/sidepanel/main.ts`、`message-presentation.ts`：真实折叠轨迹、恢复、停止与错误呈现。
- `backend/tests/test_readonly_agent.py`、`extension/tests/agent-stream.test.ts`、`sidepanel.test.ts`：新增边界及集成验证。

## 测试记录（2026-10-15）

依赖没有变更，`uv.lock` / `package-lock.json` 未修改。按锁文件离线检查通过。Windows 沙箱的异步事件循环卡住，最终后端测试在获准的沙箱外执行；缓存放在工作区 `.cache`。

实际命令（后端 uv 命令附带 `--offline --cache-dir D:/workspace/learnflow-agent/.cache/uv`）：

```powershell
uv sync --locked --offline --cache-dir D:/workspace/learnflow-agent/.cache/uv --python D:/workspace/learnflow-agent/backend/.venv/Scripts/python.exe
uv run --offline --cache-dir D:/workspace/learnflow-agent/.cache/uv ruff check .
uv run --offline --cache-dir D:/workspace/learnflow-agent/.cache/uv pytest -q --tb=line --basetemp=D:/workspace/learnflow-agent/.cache/pytest-m2-final
npm run typecheck
npm run lint
npm test -- --run
npm run build
```

- Ruff、TypeScript、ESLint、Vite Build 通过。
- 扩展 139 项测试通过。
- 后端 132 通过、14 失败；本轮新增 17 项后端测试全部通过。
- 对 HEAD `9477f19` 导出的隔离副本复跑原测试：115 通过、同样的 14 项失败。13 项由旧 fixture 把 `KnowledgeService.trigger()` 的字典返回值当整数导致；另 1 项期待 completed 而当前服务返回 no_new_events。本轮保留这些既有失败，不修改 S2/S3 业务或测试来掩盖它们。
- 现有 Starlette TestClient / httpx 弃用警告保留，未为消除警告升级依赖。

覆盖直接回答不伪造工具、原文与代码读取、来源绑定、严格参数与越权拒绝、最大步数、重复调用 ID、上下文预算、总超时、原生参数分片、未完整调用不执行、停止清理、消息恢复、无提炼及归档副作用、跨来源事件拒绝、SSE 分片与 UI 去重。

## 用户环境验收

需要重启后端、构建并重新加载扩展。使用现有配置模型测试“这个代码为什么要使用 Depends？结合原文解释一下”。缺少内容时应看到真实读取事件，随后得到解释；上下文足够时允许直接回答，不强制调用工具。

未调用真实付费模型，也未声明 Chrome 人工联合验收通过。实际模型是否支持当前工具参数、引用质量、真实双窗口行为仍需验证。B/C/D 场景中的知识工具、持久化确认及归档闭环属于后续阶段。

协议实现参考 [OpenAI 官方 function calling 文档](https://developers.openai.com/api/docs/guides/function-calling)，保留现有 OpenAI-compatible 模型配置，没有迁移到新的模型或 Responses API。
