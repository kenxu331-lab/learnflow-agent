# LearnFlow V3 M1 UI

## 范围与基线

设计基线为 `prototypes/LearnFlow_Agent_Workspace_V3_Prototype.html`。本阶段重构扩展 UI，复用既有 Study Chat、章节会话、SSE 和知识 API，不修改后端业务，不实现 Agent Loop。

## 组件职责

- `extension/sidepanel.html`：紧凑品牌栏、章节来源、单一聊天滚动区、固定输入区、抽屉与确认弹窗。
- `src/sidepanel/workspace-v3.css`：原型视觉、窄栏响应式、代码横向滚动、独立宽屏布局。
- `src/sidepanel/main.ts`：沿用会话、选区、斜杠命令及 SSE 路由，接入阅读弹窗和独立窗口。
- `workspace-shell.ts`：笔记、候选、归档历史及高级工具抽屉；真实草稿与 Claim 核验展示。
- `archive-preview.ts`：只读 AnnotationPlan / Markdown Diff 预览，明确确认才交给调用方写入。
- `message-presentation.ts`：安全代码高亮及默认折叠的工具活动表现组件。
- `activity-types.ts`：M2 活动事件契约，不在真实聊天中伪造事件。
- `operation-lock.ts`：同源跨窗口 Web Locks，防止并发重复发送、提炼与归档。
- `src/backend/api-client.ts`：复用真实 API，新增草稿及归档计划读取，归档结束广播状态变化。
- `src/study/study-service.ts`：扩展工作台标签不替换当前网页采集目标。

## 执行流程

当前章节 → 既有 sessionId 派生 conversationId → SSE 消息流 → Markdown 与消息操作。

提炼命令 → 既有知识任务 → Knowledge Draft / Claim → PublishCandidate → 只读 AnnotationPlan 与 Diff → 用户确认 → AnnotationWriteService → 显示真实文件、位置、状态或冲突原因。

独立窗口使用相同扩展页面与会话存储，不生成另一套会话。Web Locks 保护执行边界，BroadcastChannel 通知其他窗口重新读取后端记录。无 Web Locks 的测试环境仅使用直接调用回退，该回退不提供跨窗口互斥。

## M2 事件契约

当前表现层支持 `tool_started`、`tool_finished`、`tool_failed`、`confirmation_required`、`task_completed`，包含 activityId、createdAt 和对应工具名、摘要或错误。默认折叠，仅展示，不执行工具。

M2 接入时需补充 runId、conversationId、chapterId、稳定 eventId / 序号及确认请求 ID。服务端应提供事件重放、任务幂等与确认状态；前端应按 eventId 去重，并以服务端事件为执行事实，不能从模型自然语言推断成功。

## 验证与边界

扩展 TypeScript、ESLint、134 项 Vitest 和 Vite Build 已通过。新增测试覆盖真实归档计划的数据展示、明确确认、冲突禁用、取消、高亮安全及折叠活动组件。

浏览器预览检查了 390px 窄栏及 1120px 宽屏：无页面横向溢出，聊天占据剩余高度，输入框位于视口底部；工具菜单及笔记抽屉可打开。

预览不是已加载的 Chrome 扩展。真实 SSE、双窗口实时一致性、长会话与实际 Vault 写入仍需用户环境联合验收，不能视为已通过人工验收。AI 注解入口保留既有未接入状态；Vault 与模型仍沿用后端配置，未新增配置接口。跨窗口浏览器锁是前端保护，不替代后端幂等机制。

## 本地加载

本阶段只改扩展，无需重部署后端。运行扩展构建后，在 Chrome 扩展管理页重新加载扩展，并关闭重开旧 Side Panel / 工作台以加载新资源。
