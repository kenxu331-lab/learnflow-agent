# Document Engine V2 质量对比

这组样例由 `backend/tests/fixtures/fastapi_body_snapshot.json` 通过当前代码生成：旧版使用 `app.notes.markdown.build_new_document`，新版使用 `DocumentPreviewService`。fixture 是基于 FastAPI body 目标 URL 的合成回归数据，不是当前 Chrome 会话导出的真实快照。

## 已解决的问题

- 新版输出只保留一个文档主标题，清理了标题末尾的网页锚点符号 `¶`。
- 标题按 Section 组织，段落、列表和代码保持源顺序。
- Python 和 JSON 代码块具有语言标识，代码缩进和重复代码均保留。
- 新版用户可读 Markdown 不包含 `LF_BLOCK`、`fingerprint`、`LEARNFLOW_CONTROLLED_*` 或 `LEARNFLOW_PERSONAL_*`。
- AST 内部仍保留源块映射，但映射不进入 Markdown 正文。

## 尚未解决的问题

- 当前 FastAPI fixture 没有包含图片、表格、富文本链接和提示框；这只说明该样例没有覆盖这些节点，不代表运行时采集器无法表达它们。复杂嵌套列表仍会记录覆盖限制。
- 截断快照会继续渲染已经收到的内容，同时通过 diagnostics 告知来源可能不完整。
- 旧版 Note Service 仍使用受控区域和 proposalId；新版预览只读，不自动迁移或写入已有 Vault 文件。
- 样例不能替代真实 Chrome/Obsidian 质量验收，真实页面补验留给 M01-04C-01d。
