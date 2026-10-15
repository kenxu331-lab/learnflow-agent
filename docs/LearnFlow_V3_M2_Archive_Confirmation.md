# M2 场景 C：确认归档闭环

## 本轮交付

自然语言归档已接入真实知识候选、AnnotationPlan、合并 Markdown Diff 和 AnnotationWriteService。模型只能准备计划，只有用户点击确认才进入写入接口；预览、恢复会话和关闭弹窗均不会写入 Vault。确认卡片、选择、审批时间、状态和真实回执保存在 SQLite，恢复聊天时重新载入。

没有添加依赖、Agent 编排框架或模拟成功路径，没有提交、推送、合并。保留工作区既有 M1、B/D 改动和本地数据。

## 模块与调用关系

| 文件 | 职责 |
| --- | --- |
| `backend/app/schemas/archive.py` | 选择、准备、决定和持久化卡片的数据契约 |
| `backend/app/archive/confirmations.py` | 选择版本、不可变计划、审批状态机、中断恢复、真实回执 |
| `backend/app/archive/planning.py` | 同章候选合并、来源校验、内容摘要与整份文档 Diff |
| `backend/app/archive/locking.py` | 同一元数据库后端实例之间的跨进程锁 |
| `backend/app/api/archive.py` | 本地鉴权的 selection / prepare / get / decision 接口 |
| `backend/app/annotation_writer.py` | 新增 commit_approved_batch，一份已批准 Diff 一次替换 |
| `backend/app/learning_memory/store.py` | 增量新增选择、确认、消息关联表及恢复读取 |
| `backend/app/agent/knowledge_tools.py` | prepare_archive 只读工具及已观察候选约束 |
| `backend/app/agent/readonly.py`、`study_chat/service.py` | 能力开关、等待确认事件、持久化会话恢复 |
| `backend/app/schemas/study.py`、`schemas/activity.py` | archiveTools、selectedKnowledge、archiveConfirmations、confirmation_required |
| `backend/app/main.py`、`core/middleware.py` | 路由注册、令牌 / Origin / 请求体保护 |
| `backend/app/api/annotations.py` | 不再允许把临时 planId 当成人类审批 |
| `extension/src/backend/archive-types.ts` | 卡片与回执校验、真实按钮审批桥接 |
| `extension/src/backend/api-client.ts`、`types.ts`、`activity-types.ts` | 持久化 API、消息契约和旧命令写入桥接 |
| `extension/src/sidepanel/archive-card.ts`、`archive-preview.ts` | 可恢复卡片、合并 Diff 弹窗、明确确认 / 取消 / 稍后 |
| `extension/src/sidepanel/knowledge-results.ts`、`main.ts` | 候选勾选、选择持久化、章节隔离、窗口间刷新 |
| `extension/src/sidepanel/workspace-v3.css` | 卡片样式 |
| `backend/tests/test_archive_confirmation.py`、`extension/tests/archive-confirmation.test.ts` | 新闭环与安全边界回归 |
| `backend/tests/test_agent_knowledge.py`、`extension/tests/workspace-v3.test.ts` | 工具能力和 UI 契约集成回归 |

执行流程：候选勾选并保存选择 → 模型查询知识并调用 prepare_archive → 服务端生成并保存确认卡片 → 用户核对文件、标题、行号及合并 Diff → 点击确认 → 服务端重新校验 → 单次写入 → 保存真实回执并刷新对话。

“刚才两个”使用真实持久化勾选，不能由模型猜测。无选择时显式引用必须来自先前工具结果；不能用同批尚未观察的工具结果冒充引用。实际有选择时模型不得悄悄替换。

## 持久化与安全边界

- 计划摘要绑定会话、章节、Vault、选择版本、候选及核验指纹、文件路径、前后内容哈希、Diff 和具体计划（排除随机 planId）。显示层计划也要匹配摘要。
- 确认前重新校验候选版本、资格、来源锚点、Vault 和文件版本。发生变化返回 needs_review，要求重新预览，绝不默默换计划。
- 目前每次确认限当前章节同一文件的 1–10 条知识，30 分钟过期；不声称支持多文件事务。
- 重复相同预览复用待确认 ID。重复确认同一 ID 返回历史回执，不再次写入；新预览发现内容已存在则 noop。
- 先持久化 applying 和 approvedAt，再执行写入。崩溃后文件等于计划哈希时恢复真实回执；等于原哈希时标记 interrupted，等待再次点击；其他内容变化转 needs_review。恢复读取不会自动写入。
- 关闭 X 表示稍后，保留卡片；显式取消只更新取消状态。章节切换关闭弹窗，不能带旧章节审批写入。
- 旧斜杠命令仍可用，但当前第一方 UI 的 commitAnnotation 需要真实确认按钮的审批桥接，实际转到持久化 decision 接口。同一批旧式逐条调用只发送一次决定请求。
- 模型未注册 confirm / commit 工具，prepare_archive 之后停止工具循环并展示等待用户确认。archiveTools 为显式能力开关。
- 老的无 planId 注解 API 为兼容保留，不能宣称所有历史调用方都已经迁移。临时 planId 不再充当审批凭据。模型不拥有该写入 API 工具。

## 技术取舍与已知风险

SQLite 与文件系统不是同一个原子事务，采用持久化意图、内容哈希和恢复状态机，不把数据库提交等同于文件成功。合并为一份文件一次替换，避免逐条写入留下部分成功。

按确认 ID 和文件路径加 OS 咨询锁，协调同一数据库的独立后端实例。Windows 可锁 EOF 之后的字节，因此锁文件不写初始化哨兵，避免竞争实例在对方已加锁时初始化失败。外部编辑器及使用不同数据库的后端不会遵守本锁；仍有外部并发修改边界，不能声称全系统事务隔离。

回执中的文件、标题和行号来自真实写入结果；行号是完成时位置，后续编辑可能改变。历史错误快照及草稿不自动清理。测试中的真实文件写入仅针对临时 Vault，不修改用户实际笔记。

## 验证结果

2026-10-15 在本地执行：

```powershell
# backend 工作目录
.\.venv\Scripts\python.exe -m ruff check .
uv run --offline --cache-dir D:/workspace/learnflow-agent/.cache/uv pytest tests/test_archive_confirmation.py tests/test_agent_knowledge.py tests/test_readonly_agent.py tests/test_study_chat.py -q --tb=short --basetemp=D:/workspace/learnflow-agent/.cache/pytest-archive-confirmation-final2
uv run --offline --cache-dir D:/workspace/learnflow-agent/.cache/uv pytest -q --tb=line --basetemp=D:/workspace/learnflow-agent/.cache/pytest-archive-release-final
# extension 工作目录
npm run typecheck
npm run lint
npm test -- --run --silent
npm run build
```

Ruff、TypeScript、ESLint、Vite Build 通过。后端相关 58 项通过（其中归档专项 22 项）；扩展 165 项通过。后端全量 168 通过、14 失败，失败与上一阶段已记录基线一致：13 项旧 fixture 将 trigger 的字典返回值断言为整数，1 项期待 completed 而实现返回 no_new_events。没有改旧测试掩盖失败。Starlette/httpx 弃用警告保留。

新测试覆盖预览不写入、双知识一次替换、重复确认、版本及资格漂移、文件及来源变化、选择变动、跨 Vault / 会话拒绝、过期与取消、审批摘要及显示 Diff 篡改、写入前后崩溃恢复、真实写入失败、双实例并发及独立子进程锁互斥、临时 planId 不构成审批、模型无确认权限、前端关闭与取消区别和错误回执拒绝。

Windows 异步后端测试经批准在沙箱外运行；首次回归暴露的锁文件初始化竞争已修复并重跑通过。复用已有依赖环境，本轮无依赖和锁文件变化，未重新 npm ci / uv sync。未进行真实模型联调或 Chrome 人工验收，不能据自动化测试声称自然语言工具选择、Side Panel / 宽屏窗口真实操作均已验收。

## 本地验收建议

重启后端、重新加载构建后的扩展，并关闭重开旧侧栏和工作台。查看真实候选、勾选两条，发送“把刚才确认的两个知识点放到对应的 Obsidian 章节”，查看卡片与 Diff，确认一次。核对实际文件路径、位置和内容；恢复会话后应仍有结果卡片，再次确认不应新增副本。另测取消、关闭后重开、文件被外部编辑、重启后恢复和章节切换。

## 技术回顾

三个知识点：审批绑定不可变业务计划而非一句模型文本；幂等键与文件内容哈希解决不同层次的重复执行；SQLite / 文件系统跨资源崩溃用意图日志和状态机恢复。

面试问题：如何防止预览后数据变化造成 TOCTOU？文件已写入但回执尚未提交时怎样安全恢复？跨进程锁为什么不能替代版本检查或外部编辑冲突处理？
