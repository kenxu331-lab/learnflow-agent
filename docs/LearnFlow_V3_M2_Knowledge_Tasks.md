# M2 第二步：知识任务集成（B / D）

## 范围与用户体验

本阶段接通查询已有知识、按需提炼、异步结果恢复、去重展示及真实 Claim 核验结果。继续使用自研工具循环，不执行模型代码，不引入新依赖或编排框架。

- B：“刚才有哪些知识点值得记住？”先查当前章节已有知识及本会话未处理事件。有新内容时可提交既有提炼队列；没有新增时展示已有成果或“是否查看”的是/否卡片。
- D：“检查我的理解，再提炼值得保存的内容。”先读取教程，给出公开纠正，再查询已有知识；将本轮用户观点与公开纠正写成有来源的学习事件后提交提炼，不遗漏本轮内容。
- 核验未完成显示 verifying；证据不足显示实际原因与 needs_review，不声称已归档。
- 没有新增 Agent 归档预览或写入工具。C 及 D 的自动归档预览决策留在下一阶段；原有手动预览、确认和斜杠命令保留。

## 执行流程

自然语言 → StudyChatService → Agent 选择业务工具 → 当前范围校验 → KnowledgeService / KnowledgeStore → 既有提炼队列 → 既有后台核验 → 持久化结果卡片。

新增三个工具：

| 工具 | 行为 | 不允许 |
| --- | --- | --- |
| search_knowledge | 查询当前章节知识、核验、已归档状态及当前会话是否有新内容 | 模型指定其他章节、会话或 Vault |
| extract_knowledge | 查询后提交未处理事件；D 可携带公开 analysis | 执行代码、改写旧知识、写入 Vault |
| get_extraction_result | 读取本会话任务真实状态和结果 | 越范围任务、循环模型轮询 |

工具调用的依赖结果必须已经回传模型：同一模型批次同时提出 read/search/extract，不能把尚未观察到的结果当作提炼依据，会返回可修正的工具错误。

新扩展明确传 `readonlyAgent: true, knowledgeTools: true`。只传旧 readonlyAgent 的客户端仍保持只读工具集合；S1 的非 Agent 聊天保留。知识整理的行政性问答不再作为新学习事件，防止“查询→生成新事件→再次提炼”的反馈循环。D 的公开分析通过内容键幂等登记；普通学习解释仍按原流程保存学习事件。

## 异步持久化与去重

在现有 SQLite 中增加 `agent_knowledge_tasks` 和 `study_knowledge_views`，保留原业务表及用户数据。

任务按 scope、chapter、conversation 和学习事件高水位生成唯一 input_key。应用先保存任务及消息引用，再调用原调度器。中断后可补交提交；队列已存在对应批次时复用原 jobId，不再次调用模型规划。一个会话有更早批次处理时，后续批次等待，避免并行覆盖同一批学习事件。

任务状态：submitting → queued / waiting_previous → extracting → verifying → completed / needs_review / failed。后台每两秒检查持久化任务；前端仅在有等待任务且不在流式回答时，每三秒 GET 恢复消息。前端查询不会重新发送聊天或提炼命令，多个窗口不会据此重复提交任务。

结果和终态事件使用数据库条件更新一次性提交。关闭侧栏不取消已登记提炼；重开或重启后端后从存储恢复状态。此处恢复的是业务任务与结果，不是通用 LLM 推理检查点；等待结束由应用依据真实核验状态完成卡片，不再启动一轮模型轮询或生成“模拟成功”回复。

沿用 S2 的租约、网络重试与游标规则。不重置游标，不自动重跑不可重试的失败批次；已失败批次必须显示原错误，不能被冒充成无新增内容。核验等待超过 15 分钟会进入需检查状态。Vault 范围变化时停止任务，不返回新范围下混杂的知识结果。

展示去重使用 kind + 保守规范化正文：统一换行、去除行尾空白，保留代码标点、大小写和内部空白。相同正文合并展示并保留 duplicateIds，不删除记录或版本。近似正文只标 similarTo，不自动合并结论。单次结果数量及模型工具结果长度有上限，明确提示可按关键词继续查询。

## 前端表现

StudyMessage.knowledge 携带真实结果；activity 增加 task_waiting。卡片显示知识内容、核验状态、Claim 原因、证据 ID、归档状态、重复及近似提示。展开卡片和“是/否”查看已有内容都不写文件。

自然语言提炼交给 Agent；`/提炼`、`/查看提炼`、`/归档` 等确定性快捷入口仍保留。后台任务结果随消息恢复，滚动位置尽量保留；等待期间可以继续正常聊天，不丢失旧任务的刷新状态。

## 修改文件及职责

- `backend/app/agent/knowledge_tools.py`：参数模型、工具 schema、当前范围绑定、调用前置条件和模型结果预算。
- `backend/app/agent/knowledge_tasks.py`：查询适配、任务登记/恢复、批次引用、条件更新、展示去重与结果 watcher。
- `backend/app/agent/readonly.py`：按能力扩展原循环，等待时结束模型轮询，约束同批工具依赖。
- `backend/app/study_chat/service.py`：D 学习事件、等待/失败事件、消息结果与恢复。
- `backend/app/learning_memory/store.py`：附加任务/视图表及学习事件幂等登记。
- `backend/app/schemas/knowledge_view.py`、`study.py`、`activity.py`：知识结果与能力开关契约。
- `backend/app/main.py`：启动/停止结果 watcher；既有 S2/S3 业务实现未修改。
- `extension/src/backend/knowledge-view.ts`、`activity-types.ts`、`types.ts`、`api-client.ts`：结果类型、校验及恢复。
- `extension/src/sidepanel/knowledge-results.ts`、`knowledge-poller.ts`：只读卡片和受控刷新生命周期。
- `extension/src/sidepanel/main.ts`、`message-presentation.ts`、`workspace-v3.css`：自然语言分流、消息集成和表现。
- `backend/tests/test_agent_knowledge.py`、`extension/tests/knowledge-results.test.ts`、`sidepanel.test.ts`：集成及边界回归。

## 验证与已知边界

已使用真实 S2 存储、调度和核验流程，测试模型作为隔离替身；生产代码没有 Fake Provider。测试覆盖 B/D、无新增、核验失败、提炼失败、任务在提交前后中断的恢复、旧批次等待、Vault 隔离、同批工具依赖、精确/近似去重、前端只读展开、正常追问期间的轮询保持和章节切换停止轮询。

执行命令：

```powershell
uv sync --locked --offline --cache-dir D:/workspace/learnflow-agent/.cache/uv --python D:/workspace/learnflow-agent/backend/.venv/Scripts/python.exe
uv run --offline --cache-dir D:/workspace/learnflow-agent/.cache/uv ruff check .
uv run --offline --cache-dir D:/workspace/learnflow-agent/.cache/uv pytest -q --tb=line --basetemp=D:/workspace/learnflow-agent/.cache/pytest-knowledge-release
npm run typecheck
npm run lint
npm test -- --run --silent
npm run build
```

依赖及锁文件没有变更。Windows 后端异步测试在获准的沙箱外执行。原有 14 项后端基线失败保留：13 项旧 fixture 把 trigger 字典返回值当整数，1 项期待 completed 而当前返回 no_new_events；上一阶段已用 HEAD 9477f19 隔离副本复现。本轮没有改这些测试来掩盖失败，也没有改 S2/S3 业务策略。Starlette/httpx 弃用警告保留。

最终执行结果：依赖核对、Ruff、TypeScript、ESLint、Vite Build 通过；扩展 157 项测试全部通过；后端全量 146 通过、14 项既有失败。本轮新增 14 项后端集成测试和 6 项前端结果/轮询测试通过，原只读与聊天专项也通过。

未调用真实付费模型，未宣称 Chrome 人工联合验收通过。模型是否稳定选择工具、公开纠正和语义去重质量仍需真实模型测试。现有历史快照及草稿不自动清理或修正；受之前错误快照影响的知识需要重新采集和人工审查。提炼需沿用既有有效 Vault 范围和云端配置。取消聊天不会取消已经登记的后台提炼。

本实现依据 [OpenAI 官方 function calling 文档](https://developers.openai.com/api/docs/guides/function-calling) 保留模型与应用的执行边界，不引入新 API 或 Code Agent。

## 本地体验

重启后端并重新加载扩展（关闭重开旧侧栏和工作台）。先进行一次普通学习问答，再问“我们刚才讨论了这么久，有哪些知识点值得记住？”。随后测试“我觉得中间件只是把函数返回值传给另一个函数，对照教程检查一下，再帮我提炼值得保存的内容”。提炼期间可关闭窗口，稍后恢复查看。没有新内容时不会重新排队，失败/待核验也不能显示已归档。

## 技术回顾

三个知识点：事件高水位与批次幂等；业务任务恢复与 LLM 推理恢复的区别；精确去重和语义相似提示的不同安全边界。

面试问题：如何避免提炼“整理知识”本身导致无限反馈？提交成功后、任务引用保存前发生崩溃如何恢复？为什么同批工具调用不能假设已经观察过彼此的结果？
