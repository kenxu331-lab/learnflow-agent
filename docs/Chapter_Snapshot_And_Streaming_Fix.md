# 章节正文串线与空白回答修复（2026-10-15）

## 已确认的现象

只读检查本地学习数据库后确认：`/zh/tutorial/response-status-code/` 会话保存的页面标题是“依赖项 - FastAPI”，正文也是依赖注入。模型对快照不匹配的说明有数据依据，并非仅凭 URL 判断。

没有改写、删除历史聊天或用户笔记。错误快照对应的旧回答不会被自动删除。

## 修复链路

1. 采集结束时，将快照标题与当前浏览器标签标题比对，不一致则返回可重试的 STALE_TAB，而非接受新 URL 配旧正文。
2. 同源不同路径导航时，若新快照沿用旧标题，且正文完全相同或高度重合（至少 3 块、80% 匹配），暂不发布为新章节，使用既有有限重试等待页面切换。该检查是保守的时序保护，不是语义核验；确实重复内容的页面也可能需要等待或提示重新采集。
3. 监听延迟的标签页 title 更新；即使 URL 未再次变化，也会校验并重新采集。
4. 缓存恢复新增标题一致性校验；手动采集绕过缓存，保持原 sessionId，可修复已污染的章节缓存。
5. 成熟解析器每次先清空中间结果，避免复用上次解析遗留值。
6. 回答请求使用 AbortController 身份确认所有权。旧请求的 delta、activity、返回结果与 finally 不能覆盖新请求的状态。错误或停止仍保留已生成的部分回答。
7. 新消息立即显示等待状态，工具活动到达后更新进度，避免仅显示空白助手节点。

实际输出仍走原来的 SSE：delta 逐段显示，done 后渲染最终 Markdown；没有改成等完整回答后显示。上游模型首 token 延迟和代理缓冲仍需真实环境观察。

## 文件

- `extension/src/capture/capture-service.ts`：URL 之外的标题一致性检查。
- `extension/src/capture/mature-extractor.ts`：解析前清理中间结果。
- `extension/src/study/study-service.ts`：导航时序、缓存校验、强制刷新与有限重试。
- `extension/src/sidepanel/main.ts`：请求所有权、等待状态和流式更新。
- 对应 `capture-service.test.ts`、`study-service.test.ts`、`sidepanel.test.ts`：跨层回归测试。

## 验证与边界

自动化验证：新 URL＋旧标题正文被拒绝；URL 先更新且 DOM 延迟时不保存旧正文；title 事件触发恢复采集；手动采集真实刷新并保留会话 ID；首段 delta 在 done 前可见；被取消的旧请求晚返回不会重置新章节的生成状态。

执行扩展 TypeScript、ESLint、Vitest 和 Vite Build。无需修改后端或依赖。真实 Chrome 页面时序、模型延迟仍未做人工联合验收。

命令为 `npm run typecheck`、`npm run lint`、`npm test -- --run --silent`、`npm run build`。

重新加载扩展后，打开响应状态码页面，待页面稳定，通过输入框旁“＋ → 高级工具 → 手动采集当前页面”（或暂停后再次采集）刷新旧快照，再发送问题。历史错误回答会保留，新请求会使用更新后的快照。无需重启后端；如果后端还未加载此前 M2 的代码，则仍需为 M2 单独重启。

## 技术回顾

三个要点：URL 更新不代表 SPA 的 DOM 已完成切换；缓存键一致不代表缓存内容仍有效；取消请求后旧 Promise 的 finally 仍会运行，因此需要请求所有权校验。

面试问题：如何防止 SPA 采集得到新 URL 配旧正文？为什么 AbortController 不能替代请求代际或身份检查？如何测试首段 SSE 在最终完成前可见？
