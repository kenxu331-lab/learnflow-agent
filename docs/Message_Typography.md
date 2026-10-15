# 聊天回答排版优化

本轮仅调整消息阅读体验，沿用 V3 界面，不更换消息模型、Markdown 渲染器、SSE 或归档流程。无新依赖、无远程字体请求，无后端修改，无提交或推送。

## 文件与执行流程

- `extension/src/sidepanel/message-typography.css`：共用的消息字体和 Markdown 排版；侧栏正文 15px，700px 以上宽屏工作台 16px；系统字体栈兼顾中英文，行高 1.8；优化标题、段落、列表、引用、链接、行内代码和深色代码块。长代码仅在代码块内横向滚动。
- `extension/src/sidepanel/main.ts`：在现有样式之后加载排版样式；放大阅读基准从 13px 改为 16px，保留原缩放范围。
- `extension/tests/message-typography.test.ts`：正文与阅读器字号、标题和代码相对缩放、代码块滚动规则。

执行关系：Markdown 渲染和安全代码高亮保持不变 → 共用 CSS 应用于流式及恢复的消息 → 放大阅读复制相同 Markdown 内容 → 缩放只改变阅读器基准字号，标题与代码使用 em 随之变化。

## 验证及边界

执行 `npm run typecheck`、`npm run lint`、`npm test -- --run --silent`、`npm run build`。本轮不重装依赖，不运行无关后端测试。新增测试使用 jsdom 检查 CSS 规则，不代表浏览器真实布局或字体渲染验收；Chrome 中实际字形、窄屏溢出和视觉效果仍需人工核对。

最终结果：TypeScript、ESLint、Vite Build 通过；扩展全量 14 个测试文件、168 项测试通过；git diff --check 通过，仅有既有 LF / CRLF 转换提示。

取舍：使用本地系统字体，而非加载 ChatGPT 的专用字体，因此目标是接近其阅读层级，并非逐像素复刻。Windows / macOS 的字形可能不同。保留现有紫色品牌和代码高亮，不扩大至整体主题重构。标题字号改用相对单位，避免仅正文缩放但标题保持原大小。

测试过程中先修正了 Vitest 参数顺序，再修正 jsdom 下文件读取使用非 file URL 的问题；随后新增 3 项规则测试通过，生产样式未因此更改。

## 技术回顾

三个知识点：CSS 字体回退栈与本地优先；em 相对字号与阅读缩放；white-space / overflow-wrap / overflow-x 对代码布局的配合。

面试问题：为何不能只放大正文而保留固定 px 标题？如何防止长代码撑破 flex/grid 布局？为什么 jsdom 的样式测试不能替代 Chrome 视觉验收？
