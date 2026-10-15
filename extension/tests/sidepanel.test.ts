import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { PageCaptureResponse, PageSnapshot } from "../src/capture/types";
import type { StudyState } from "../src/study/types";

const snapshot: PageSnapshot = {
  schemaVersion: 1,
  url: "https://example.com/tutorial",
  title: "Tutorial",
  capturedAt: "2026-10-11T00:00:00.000Z",
  blocks: [{ id: "block-1", type: "paragraph", text: "Tutorial text." }],
  extraction: { strategy: "article", truncated: false, warnings: [] },
  stats: { characterCount: 14, codeBlockCount: 0, blockCount: 1 },
};

const recommendationSnapshot: PageSnapshot = {
  ...snapshot,
  blocks: [
    { id: "block-1", type: "heading", text: "Core concept", level: 2 },
    { id: "block-2", type: "paragraph", text: "Supporting detail." },
  ],
  stats: { characterCount: 30, codeBlockCount: 0, blockCount: 2 },
};

function setupDom(): void {
  document.body.innerHTML = `
    <main class="sidepanel">
    <button id="settingsBtn" type="button">设置</button>
    <div id="settings" hidden></div>
    <button id="capture-button" type="button">采集当前页面</button>
    <p id="capture-status">等待操作</p>
    <section id="study-panel">
      <p id="study-status"></p>
      <span id="study-indicator"></span>
      <p id="study-site"></p>
      <p id="study-chapter"></p>
      <p id="study-captured-at"></p>
      <p id="study-error" hidden></p>
      <button id="study-enable-button" type="button">启用</button>
      <button id="study-pause-button" type="button" hidden>暂停</button>
      <button id="study-revoke-button" type="button" hidden>撤销</button>
      <p id="study-permission-status"></p>
    </section>
    <nav class="main-tabs">
      <button class="tab active" data-tab="chat" type="button"></button>
      <button class="tab" data-tab="notes" type="button"></button>
    </nav>
    <section id="chatView" class="view active">
      <div id="chatList"></div>
      <p id="chat-unready-status"></p>
      <div id="note-action-status" hidden></div>
    </section>
    <section id="notesView" class="view">
      <p id="notesState"></p><span id="noteCount">0</span>
      <button id="document-v2-preview-button" type="button" disabled>生成预览</button>
      <p id="document-v2-status"></p>
      <section id="document-v2-preview-panel" hidden>
        <p id="document-v2-action"></p><p id="document-v2-path"></p>
        <p id="document-v2-source"></p><p id="document-v2-diagnostics"></p>
        <button id="document-export-diagnostics-button" type="button" hidden>导出诊断</button>
        <pre id="document-v2-markdown"></pre><pre id="document-v2-diff"></pre>
        <button id="document-v2-commit-button" type="button" disabled>确认保存笔记</button>
        <p id="document-v2-commit-status"></p>
      </section>
      <div id="emptyNote"><p id="empty-note-hint"></p></div>
      <div id="noteDocument" class="hide"></div>
      <button id="organize-note-button" data-action="make-note" type="button" disabled>整理</button>
      <button id="ai-annotate-button" data-action="ai-annotate" type="button">注解</button>
    </section>
    <div id="composerArea"><textarea id="chatInput"></textarea><button id="chat-send-button" type="button" disabled>发送</button></div>
    <div id="unready-sheet" hidden><p id="unready-message"></p><button id="close-unready" type="button">关闭</button></div>
    <section id="result-panel" hidden>
      <p id="page-title"></p><p id="page-url"></p>
      <p id="character-count"></p><p id="code-block-count"></p>
      <pre id="content-preview"></pre>
      <div id="warning-panel" hidden><ul id="warning-list"></ul></div>
    </section>
    <input id="service-url" />
    <input id="api-token" />
    <button id="save-token-button" type="button">保存 Token</button>
    <button id="send-button" type="button" disabled>发送到本地服务</button>
    <p id="connection-status"></p>
    <p id="send-status"></p>
    <section id="selection-panel" hidden>
      <p id="selection-count"></p>
      <div id="block-list"></div>
      <textarea id="personal-note"></textarea>
      <button id="preview-note-button" type="button" disabled>预览</button>
    </section>
    <section id="ai-recommendation-panel" hidden>
      <input id="ai-cloud-consent" type="checkbox" />
      <textarea id="learning-goal"></textarea>
      <button id="ai-recommend-button" type="button" disabled>AI 分析</button>
      <div id="ai-recommendation-list"></div>
      <button id="apply-ai-recommendations" type="button" disabled>应用推荐</button>
      <p id="ai-status"></p>
    </section>
    <section id="note-preview-panel" hidden>
      <p id="note-action"></p><p id="note-path"></p>
      <pre id="markdown-preview"></pre><pre id="markdown-diff"></pre>
      <button id="commit-note-button" type="button" disabled>提交</button>
      <p id="note-status"></p>
    </section>
    <div id="error-panel" hidden><p id="error-message"></p></div>
    </main>
  `;
}

async function loadSidePanel(response: PageCaptureResponse): Promise<void> {
  setupDom();
  vi.stubGlobal("chrome", {
    runtime: { sendMessage: vi.fn().mockResolvedValue(response) },
  });
  await import("../src/sidepanel/main");
}

describe("side panel visibility state", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("initializes from the real sidepanel.html DOM contract", async () => {
    const html = readFileSync(resolve(process.cwd(), "sidepanel.html"), "utf8");
    document.body.innerHTML = new DOMParser().parseFromString(html, "text/html").body.innerHTML;
    vi.stubGlobal("chrome", {
      runtime: { sendMessage: vi.fn(), onMessage: { addListener: vi.fn() } },
      storage: { local: { get: vi.fn().mockResolvedValue({}) } },
      permissions: { contains: vi.fn().mockResolvedValue(false) },
    });

    await import("../src/sidepanel/main");

    expect(document.querySelector(".sidepanel")).not.toBeNull();
    expect(document.querySelector("#study-chapter")).not.toBeNull();
    expect(document.querySelector("#chatView")).not.toBeNull();
    expect(document.querySelector("#notesView")).not.toBeNull();
    expect(document.querySelector("#note-preview-panel")).not.toBeNull();
    expect(document.querySelector("#document-v2-preview-button")).not.toBeNull();
    expect(document.querySelector("#chatInput")).not.toBeNull();
    expect(document.querySelector("#chat-intro")).not.toBeNull();
    expect(document.querySelector("#chat-scroll")).not.toBeNull();
    expect(document.querySelector("#knowledge-consent-button")).toBeNull();
  });

  it("sends an authorized chapter question and renders streamed Study Agent text", async () => {
    let completeStream: (() => void) | undefined;
    const activity = { type: "tool_started", eventId: "run-1:1", runId: "run-1", conversationId: "conversation-session-1", sourceUrl: snapshot.url, sequence: 1, activityId: "tool-1", toolName: "read_learning_context", summary: "读取原文", error: "", createdAt: snapshot.capturedAt };
    const studyState: StudyState = {
      schemaVersion: 1,
      enabled: true,
      status: "SOURCE_READY",
      authorizedOrigin: "https://example.com",
      activeTabId: 7,
      sessionsByChapter: {
        "chapter-1": {
          sessionId: "session-1",
          tabId: 7,
          chapterId: "chapter-1",
          sourceUrl: snapshot.url,
          pageTitle: snapshot.title,
          snapshotHash: "content-1",
          capturedAt: snapshot.capturedAt,
          updatedAt: snapshot.capturedAt,
          status: "SOURCE_READY",
        },
      },
      snapshotsByChapter: { "chapter-1": snapshot },
      currentSession: {
        sessionId: "session-1",
        tabId: 7,
        chapterId: "chapter-1",
        sourceUrl: snapshot.url,
        pageTitle: snapshot.title,
        snapshotHash: "content-1",
        capturedAt: snapshot.capturedAt,
        updatedAt: snapshot.capturedAt,
        status: "SOURCE_READY",
      },
      currentSnapshot: snapshot,
    };
    const stream = new ReadableStream({
      start(controller) {
        for (let i = 0; i < 2; i++) controller.enqueue(new TextEncoder().encode(`event: activity\ndata: ${JSON.stringify(activity)}\n\n`));
        controller.enqueue(
          new TextEncoder().encode('event: delta\ndata: {"text":"流式答案"}\n\n'),
        );
        completeStream = () => { controller.enqueue(
          new TextEncoder().encode(
            `event: done\ndata: ${JSON.stringify({
              schemaVersion: 1,
              conversationId: "conversation-session-1",
              message: {
                schemaVersion: 1,
                messageId: "assistant-1",
                role: "assistant",
          content: "## 流式答案\n\n**重点**",
                origin: "ai",
                createdAt: snapshot.capturedAt,
              },
            })}\n\n`,
          ),
        );
        controller.close(); };
      },
    });
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/conversations/")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              schemaVersion: 1,
              conversationId: "conversation-session-1",
              sessionId: "session-1",
              sourceUrl: snapshot.url,
              pageTitle: snapshot.title,
              messages: [],
            }),
            { status: 200 },
          ),
        );
      }
      return Promise.resolve(
        new Response(stream, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: vi.fn(),
        onMessage: { addListener: vi.fn() },
      },
      storage: {
        local: {
          get: vi.fn().mockImplementation((keys: unknown) => {
            if (Array.isArray(keys)) {
              return Promise.resolve({
                learnflowStudyState: studyState,
                learnflowStudySnapshots: {},
              });
            }
            return Promise.resolve({
              learnflowCloudLlmConsent: false,
              localApiToken: "local-token",
            });
          }),
          set: vi.fn().mockResolvedValue(undefined),
          setAccessLevel: vi.fn().mockResolvedValue(undefined),
        },
      },
      permissions: { contains: vi.fn().mockResolvedValue(false) },
    });
    const html = readFileSync(resolve(process.cwd(), "sidepanel.html"), "utf8");
    document.body.innerHTML = new DOMParser().parseFromString(html, "text/html").body.innerHTML;
    await import("../src/sidepanel/main");

    await vi.waitFor(() => {
      expect(document.querySelector<HTMLTextAreaElement>("#chatInput")?.disabled).toBe(false);
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(document.querySelector("#chat-cloud-consent")).toBeNull();
    expect(document.querySelector("#chat-selection-button")).toBeNull();
    const input = document.querySelector<HTMLTextAreaElement>("#chatInput")!;
    input.value = "帮我提炼当前对话";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("#chat-messages")?.textContent).toContain(
        "流式答案",
      );
    });
    // First delta must be visible before the final SSE frame arrives.
    expect(document.querySelector("#chat-messages h2")).toBeNull();
    expect(input.disabled).toBe(true);
    completeStream?.();
    await vi.waitFor(() => expect(document.querySelector("#chat-messages h2")).not.toBeNull());
    expect(document.querySelector("#chat-messages strong")).not.toBeNull();
    const trace = document.querySelector<HTMLDetailsElement>("#chat-messages .activity-trace")!;
    expect(trace.open).toBe(false);
    expect(trace.textContent).toContain("read_learning_context");
    expect(trace.querySelectorAll("p")).toHaveLength(1);
    const post = fetchMock.mock.calls.find(([, options]) => options?.method === "POST");
    expect(JSON.parse(post![1].body).readonlyAgent).toBe(true);
    expect(JSON.parse(post![1].body).knowledgeTools).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8000/api/v1/study/chat",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("does not let a late cancelled chapter request reset the new chapter stream", async () => {
    const session = { sessionId: "session-a", tabId: 7, chapterId: "a", sourceUrl: snapshot.url, pageTitle: snapshot.title, snapshotHash: "hash-a", capturedAt: snapshot.capturedAt, updatedAt: snapshot.capturedAt, status: "SOURCE_READY" as const };
    const initial: StudyState = { schemaVersion: 1, enabled: true, status: "SOURCE_READY", authorizedOrigin: "https://example.com", activeTabId: 7, currentSession: session, currentSnapshot: snapshot, sessionsByChapter: { a: session }, snapshotsByChapter: { a: snapshot } };
    let listener: ((message: unknown) => void) | undefined;
    let resolveOld: ((response: Response) => void) | undefined;
    const oldResponse = new Promise<Response>((resolve) => { resolveOld = resolve; });
    let nextController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const newStream = new ReadableStream<Uint8Array>({ start(controller) { nextController = controller; } });
    let posts = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string) => {
      if (url.includes("/conversations/")) return Promise.resolve(new Response("{}", { status: 404 }));
      posts++;
      return posts === 1 ? oldResponse : Promise.resolve(new Response(newStream));
    }));
    vi.stubGlobal("chrome", {
      runtime: { sendMessage: vi.fn(), onMessage: { addListener: vi.fn((callback) => { listener = callback; }) } },
      storage: { local: { get: vi.fn().mockImplementation((keys: unknown) => Promise.resolve(Array.isArray(keys) ? { learnflowStudyState: initial, learnflowStudySnapshots: {} } : { localApiToken: "test" })), set: vi.fn().mockResolvedValue(undefined), setAccessLevel: vi.fn().mockResolvedValue(undefined) } },
      permissions: { contains: vi.fn().mockResolvedValue(true) },
    });
    document.body.innerHTML = new DOMParser().parseFromString(readFileSync(resolve(process.cwd(), "sidepanel.html"), "utf8"), "text/html").body.innerHTML;
    await import("../src/sidepanel/main");
    const input = document.querySelector<HTMLTextAreaElement>("#chatInput")!;
    await vi.waitFor(() => expect(input.disabled).toBe(false));
    const send = (question: string) => {
      input.value = question;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    };
    send("第一章问题");
    await vi.waitFor(() => expect(posts).toBe(1));
    const nextSnapshot = { ...snapshot, url: "https://example.com/chapter-b", title: "Chapter B" };
    const nextSession = { ...session, chapterId: "b", sessionId: "session-b", sourceUrl: nextSnapshot.url, pageTitle: nextSnapshot.title };
    listener?.({ type: "STUDY_STATE_CHANGED", state: { ...initial, currentSnapshot: nextSnapshot, currentSession: nextSession } });
    await vi.waitFor(() => expect(input.disabled).toBe(false));
    send("第二章问题");
    await vi.waitFor(() => expect(posts).toBe(2));
    // Simulate a transport which resolves after AbortSignal was already sent.
    resolveOld?.(new Response('event: error\ndata: {"code":"cancelled","message":"旧请求结束"}\n\n'));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(input.disabled).toBe(true);
    nextController?.enqueue(new TextEncoder().encode('event: delta\ndata: {"text":"第二章正在流式回答"}\n\n'));
    await vi.waitFor(() => expect(document.querySelector("#chat-messages")?.textContent).toContain("第二章正在流式回答"));
    expect(document.querySelector("#chat-messages")?.textContent).not.toContain("旧请求结束");
    nextController?.enqueue(new TextEncoder().encode(`event: done\ndata: ${JSON.stringify({ schemaVersion: 1, conversationId: "conversation-session-b", message: { schemaVersion: 1, messageId: "b1", role: "assistant", content: "第二章正在流式回答", origin: "ai", createdAt: snapshot.capturedAt } })}\n\n`));
    nextController?.close();
    await vi.waitFor(() => expect(input.disabled).toBe(false));
  });

  it("keeps earlier turns when study state refreshes during a later stream", async () => {
    const studyState: StudyState = {
      schemaVersion: 1,
      enabled: true,
      status: "SOURCE_READY",
      authorizedOrigin: "https://example.com",
      activeTabId: 7,
      sessionsByChapter: {
        "chapter-1": {
          sessionId: "session-1",
          tabId: 7,
          chapterId: "chapter-1",
          sourceUrl: snapshot.url,
          pageTitle: snapshot.title,
          snapshotHash: "content-1",
          capturedAt: snapshot.capturedAt,
          updatedAt: snapshot.capturedAt,
          status: "SOURCE_READY",
        },
      },
      snapshotsByChapter: { "chapter-1": snapshot },
      currentSession: {
        sessionId: "session-1",
        tabId: 7,
        chapterId: "chapter-1",
        sourceUrl: snapshot.url,
        pageTitle: snapshot.title,
        snapshotHash: "content-1",
        capturedAt: snapshot.capturedAt,
        updatedAt: snapshot.capturedAt,
        status: "SOURCE_READY",
      },
      currentSnapshot: snapshot,
    };
    let stateListener: ((message: unknown) => void) | undefined;
    let postCount = 0;
    let resolveSecondStream: ((response: Response) => void) | undefined;
    const secondStream = new Promise<Response>((resolve) => {
      resolveSecondStream = resolve;
    });
    const streamResponse = (answer: string, messageId: string): Response => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(`event: delta\ndata: ${JSON.stringify({ text: answer })}\n\n`),
          );
          controller.enqueue(
            new TextEncoder().encode(
              `event: done\ndata: ${JSON.stringify({
                schemaVersion: 1,
                conversationId: "conversation-session-1",
                message: {
                  schemaVersion: 1,
                  messageId,
                  role: "assistant",
                  content: answer,
                  origin: "ai",
                  createdAt: snapshot.capturedAt,
                },
              })}\n\n`,
            ),
          );
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    };
    const conversationMessages = (includeTurns: boolean) =>
      includeTurns
        ? [
            { schemaVersion: 1, role: "user", content: "第一轮问题", messageId: "user-1", origin: "user", createdAt: snapshot.capturedAt },
            { schemaVersion: 1, role: "assistant", content: "第一轮回答", messageId: "assistant-1", origin: "ai", createdAt: snapshot.capturedAt },
            { schemaVersion: 1, role: "user", content: "第二轮问题", messageId: "user-2", origin: "user", createdAt: snapshot.capturedAt },
            { schemaVersion: 1, role: "assistant", content: "第二轮回答", messageId: "assistant-2", origin: "ai", createdAt: snapshot.capturedAt },
          ]
        : [];
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes("/conversations/")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              schemaVersion: 1,
              conversationId: "conversation-session-1",
              sessionId: "session-1",
              sourceUrl: snapshot.url,
              pageTitle: snapshot.title,
              messages: conversationMessages(postCount > 1),
            }),
            { status: 200 },
          ),
        );
      }
      postCount += 1;
      if (postCount === 1) return Promise.resolve(streamResponse("第一轮回答", "assistant-1"));
      return secondStream;
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("chrome", {
      runtime: {
        sendMessage: vi.fn().mockResolvedValue(undefined),
        onMessage: {
          addListener: vi.fn((listener: (message: unknown) => void) => {
            stateListener = listener;
          }),
        },
      },
      storage: {
        local: {
          get: vi.fn().mockImplementation((keys: unknown) =>
            Promise.resolve(
              Array.isArray(keys)
                ? { learnflowStudyState: studyState, learnflowStudySnapshots: {} }
                : { localApiToken: "local-token" },
            ),
          ),
        },
      },
      permissions: { contains: vi.fn().mockResolvedValue(false) },
    });
    const html = readFileSync(resolve(process.cwd(), "sidepanel.html"), "utf8");
    document.body.innerHTML = new DOMParser().parseFromString(html, "text/html").body.innerHTML;
    await import("../src/sidepanel/main");

    await vi.waitFor(() => {
      expect(document.querySelector<HTMLTextAreaElement>("#chatInput")?.disabled).toBe(false);
    });
    const input = document.querySelector<HTMLTextAreaElement>("#chatInput")!;
    input.value = "第一轮问题";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => expect(document.querySelector("#chat-messages")?.textContent).toContain("第一轮回答"));

    input.value = "第二轮问题";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => expect(postCount).toBe(2));

    const refreshedSnapshot = { ...snapshot, capturedAt: "2026-10-11T00:01:00.000Z" };
    stateListener?.({
      type: "STUDY_STATE_CHANGED",
      state: { ...studyState, currentSnapshot: refreshedSnapshot, snapshotsByChapter: { "chapter-1": refreshedSnapshot } },
    });
    expect(document.querySelector("#chat-messages")?.textContent).toContain("第一轮回答");

    resolveSecondStream?.(streamResponse("第二轮回答", "assistant-2"));
    await vi.waitFor(() => {
      expect(document.querySelector("#chat-messages")?.textContent).toContain("第二轮回答");
    });
    expect(document.querySelector("#chat-messages")?.textContent).toContain("第一轮回答");
  });

  it("previews and commits the real Document Engine V2 Markdown", async () => {
    setupDom();
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, snapshot })
      .mockResolvedValueOnce({
        ok: true,
        response: {
          status: "preview",
          schemaVersion: 2,
          proposalId: "document-proposal-1",
          action: "create",
          noteId: "learnflow-1",
          targetRelativePath: "LearnFlow/example.com/tutorial--hash.md",
          diff: "+# Tutorial\n",
          expectedRevision: null,
          expiresAt: "2026-10-12T20:00:00Z",
          title: "Tutorial",
          sourceUrl: snapshot.url,
          markdownPreview: "# Tutorial\n\n来源：<https://example.com/tutorial>\n",
          diagnostics: {
            renderedBlockCount: 1,
            filteredBlockCount: 0,
            unsupportedBlockCount: 0,
            truncated: false,
            warnings: [],
            qualityStatus: "ok",
            issues: [],
          },
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        response: {
          status: "created",
          noteId: "learnflow-1",
          targetRelativePath: "LearnFlow/example.com/tutorial--hash.md",
          revision: "sha256:revision",
        },
      });
    vi.stubGlobal("chrome", {
      runtime: { sendMessage },
      storage: { local: { get: vi.fn().mockResolvedValue({}) } },
    });
    await import("../src/sidepanel/main");

    document.querySelector<HTMLButtonElement>("#capture-button")?.click();
    await vi.waitFor(() => {
      expect(
        document.querySelector<HTMLButtonElement>("#document-v2-preview-button")?.disabled,
      ).toBe(false);
    });
    document.querySelector<HTMLButtonElement>("#document-v2-preview-button")?.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("#document-v2-markdown")?.textContent).toContain(
        "# Tutorial",
      );
    });
    expect(document.querySelector<HTMLElement>("#chatView")?.classList.contains("active")).toBe(
      true,
    );
    expect(document.querySelector<HTMLElement>("#note-action-status")?.textContent).toContain(
      "预览已生成",
    );

    expect(sendMessage.mock.calls[1][0]).toEqual({
      type: "DOCUMENT_PREVIEW_REQUEST",
      snapshot,
    });
    expect(document.querySelector<HTMLElement>("#document-v2-status")?.textContent).toContain(
      "预览已生成",
    );
    expect(document.querySelector<HTMLButtonElement>("#document-v2-commit-button")?.disabled).toBe(
      false,
    );
    document.querySelector<HTMLButtonElement>("#document-v2-commit-button")?.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("#document-v2-commit-status")?.textContent).toContain(
        "已保存",
      );
    });
    expect(sendMessage.mock.calls.map(([message]) => message.type)).toEqual([
      "PAGE_CAPTURE_REQUEST",
      "DOCUMENT_PREVIEW_REQUEST",
      "DOCUMENT_COMMIT_REQUEST",
    ]);
    expect(document.querySelector<HTMLButtonElement>("#commit-note-button")?.disabled).toBe(
      true,
    );
  });

  it("starts with result, warning, and error panels hidden", () => {
    setupDom();

    expect(document.querySelector<HTMLElement>("#result-panel")?.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>("#warning-panel")?.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>("#error-panel")?.hidden).toBe(true);
  });

  it("keeps the warning panel hidden when a successful capture has no warnings", async () => {
    await loadSidePanel({ ok: true, snapshot });

    document.querySelector<HTMLButtonElement>("#capture-button")?.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("#capture-status")?.textContent).toBe(
        "采集完成",
      );
    });

    expect(document.querySelector<HTMLElement>("#result-panel")?.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>("#warning-panel")?.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>("#error-panel")?.hidden).toBe(true);
  });

  it("clears an old error after a later successful capture", async () => {
    setupDom();
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "PERMISSION_DENIED", message: "Permission denied" },
      } satisfies PageCaptureResponse)
      .mockResolvedValueOnce({ ok: true, snapshot } satisfies PageCaptureResponse);
    vi.stubGlobal("chrome", { runtime: { sendMessage } });
    await import("../src/sidepanel/main");

    const button = document.querySelector<HTMLButtonElement>("#capture-button");
    button?.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("#error-panel")?.hidden).toBe(false);
    });

    button?.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("#capture-status")?.textContent).toBe(
        "采集完成",
      );
    });

    expect(document.querySelector<HTMLElement>("#error-panel")?.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>("#result-panel")?.hidden).toBe(false);
  });

  it("keeps the snapshot visible when sending to the backend fails", async () => {
    setupDom();
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, snapshot })
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "NETWORK_ERROR", message: "本地服务不可用" },
      });
    vi.stubGlobal("chrome", {
      runtime: { sendMessage },
      storage: { local: { get: vi.fn().mockResolvedValue({}) } },
    });
    await import("../src/sidepanel/main");

    document.querySelector<HTMLButtonElement>("#capture-button")?.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("#capture-status")?.textContent).toBe(
        "采集完成",
      );
    });

    const sendButton = document.querySelector<HTMLButtonElement>("#send-button");
    expect(sendButton?.disabled).toBe(false);
    sendButton?.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("#send-status")?.textContent).toBe(
        "本地服务不可用",
      );
    });

    expect(document.querySelector<HTMLElement>("#result-panel")?.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>("#content-preview")?.textContent).toBe(
      "Tutorial text.",
    );
  });

  it("requests only the declared FastAPI site permission before enabling study mode", async () => {
    setupDom();
    const request = vi.fn().mockResolvedValue(true);
    const sendMessage = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        schemaVersion: 1,
        enabled: true,
        status: "AUTHORIZED",
        authorizedOrigin: "https://fastapi.tiangolo.com",
        url: "https://fastapi.tiangolo.com/zh/tutorial/body/",
        activeTabId: 7,
        sessionsByChapter: {},
        snapshotsByChapter: {},
      },
    });
    vi.stubGlobal("chrome", {
      runtime: { sendMessage },
      permissions: {
        request,
        contains: vi.fn().mockResolvedValue(false),
      },
      storage: { local: { get: vi.fn().mockResolvedValue({}) } },
    });
    await import("../src/sidepanel/main");

    document.querySelector<HTMLButtonElement>("#study-enable-button")?.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("#study-status")?.textContent).toBe(
        "已授权，等待页面稳定",
      );
    });

    expect(request).toHaveBeenCalledWith({
      origins: ["https://fastapi.tiangolo.com/*"],
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith({ type: "STUDY_ENABLE_REQUEST" });
  });

  it("configures trusted storage before saving a token", async () => {
    setupDom();
    const setAccessLevel = vi.fn().mockResolvedValue(undefined);
    const set = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("chrome", {
      runtime: { sendMessage: vi.fn() },
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({}),
          setAccessLevel,
          set,
        },
      },
    });
    await import("../src/sidepanel/main");

    document.querySelector<HTMLInputElement>("#api-token")!.value = "new-token";
    document.querySelector<HTMLButtonElement>("#save-token-button")?.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("#connection-status")?.textContent).toBe(
        "Token 已保存",
      );
    });

    expect(setAccessLevel).toHaveBeenCalledWith({
      accessLevel: "TRUSTED_CONTEXTS",
    });
    expect(set).toHaveBeenCalledWith({ localApiToken: "new-token" });
  });

  it("does not save a token when trusted storage configuration fails", async () => {
    setupDom();
    const set = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("chrome", {
      runtime: { sendMessage: vi.fn() },
      storage: {
        local: {
          get: vi.fn().mockResolvedValue({}),
          setAccessLevel: vi.fn().mockRejectedValue(new Error("not allowed")),
          set,
        },
      },
    });
    await import("../src/sidepanel/main");

    document.querySelector<HTMLInputElement>("#api-token")!.value = "new-token";
    document.querySelector<HTMLButtonElement>("#save-token-button")?.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("#connection-status")?.textContent).toBe(
        "无法启用本地存储安全配置，Token 未保存",
      );
    });

    expect(set).not.toHaveBeenCalled();
  });

  it("requires selection, previews first, and commits only after confirmation", async () => {
    setupDom();
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, snapshot })
      .mockResolvedValueOnce({
        ok: true,
        response: {
          proposalId: "proposal-1",
          action: "create",
          noteId: "learnflow-1",
          targetRelativePath: "LearnFlow/example.com/tutorial--hash.md",
          markdownPreview: "# Tutorial",
          diff: "+# Tutorial",
          expectedRevision: null,
          expiresAt: "2026-10-11T20:00:00Z",
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        response: {
          status: "created",
          noteId: "learnflow-1",
          targetRelativePath: "LearnFlow/example.com/tutorial--hash.md",
          revision: "sha256:revision",
        },
      });
    vi.stubGlobal("chrome", {
      runtime: { sendMessage },
      storage: { local: { get: vi.fn().mockResolvedValue({}) } },
    });
    await import("../src/sidepanel/main");

    document.querySelector<HTMLButtonElement>("#capture-button")?.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("#selection-panel")?.hidden).toBe(false);
    });

    const previewButton = document.querySelector<HTMLButtonElement>("#preview-note-button");
    expect(previewButton?.disabled).toBe(true);
    document.querySelector<HTMLInputElement>("#block-list input")?.click();
    expect(previewButton?.disabled).toBe(false);

    previewButton?.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("#note-preview-panel")?.hidden).toBe(false);
    });
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[1][0]).toMatchObject({
      type: "NOTE_PREVIEW_REQUEST",
      selectedBlockIds: ["block-1"],
    });

    document.querySelector<HTMLButtonElement>("#commit-note-button")?.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("#note-status")?.textContent).toBe(
        "保存完成：created",
      );
    });
    expect(sendMessage).toHaveBeenCalledTimes(3);
    expect(sendMessage.mock.calls[2][0]).toEqual({
      type: "NOTE_COMMIT_REQUEST",
      proposalId: "proposal-1",
    });
  });

  it("requires visible cloud consent before sending an AI recommendation request", async () => {
    setupDom();
    const sendMessage = vi.fn().mockResolvedValueOnce({
      ok: true,
      snapshot,
    });
    vi.stubGlobal("chrome", {
      runtime: { sendMessage },
      storage: { local: { get: vi.fn().mockResolvedValue({}) } },
    });
    await import("../src/sidepanel/main");

    document.querySelector<HTMLButtonElement>("#capture-button")?.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("#ai-recommendation-panel")?.hidden).toBe(
        false,
      );
    });
    const aiButton = document.querySelector<HTMLButtonElement>("#ai-recommend-button")!;
    expect(aiButton.disabled).toBe(true);
    aiButton.click();
    expect(sendMessage).toHaveBeenCalledTimes(1);

    document.querySelector<HTMLInputElement>("#ai-cloud-consent")?.click();
    expect(aiButton.disabled).toBe(false);
  });

  it("renders recommendations and merges applied block IDs without opening note preview", async () => {
    setupDom();
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, snapshot: recommendationSnapshot })
      .mockResolvedValueOnce({
        ok: true,
        response: {
          schemaVersion: 1,
          recommendations: [
            {
              blockId: "block-1",
              category: "core_concept",
              reason: "解释核心机制。",
            },
          ],
          analysis: {
            model: "fake-deepseek-flash",
            analyzedBlockCount: 2,
            truncated: false,
          },
        },
      });
    vi.stubGlobal("chrome", {
      runtime: { sendMessage },
      storage: { local: { get: vi.fn().mockResolvedValue({}) } },
    });
    await import("../src/sidepanel/main");

    document.querySelector<HTMLButtonElement>("#capture-button")?.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("#selection-panel")?.hidden).toBe(false);
    });
    const manualCheckboxes = document.querySelectorAll<HTMLInputElement>(
      "#block-list input",
    );
    manualCheckboxes[1].click();
    document.querySelector<HTMLInputElement>("#ai-cloud-consent")?.click();
    document.querySelector<HTMLButtonElement>("#ai-recommend-button")?.click();
    await vi.waitFor(() => {
      expect(document.querySelectorAll("#ai-recommendation-list input")).toHaveLength(1);
    });

    expect(document.querySelector<HTMLElement>("#ai-status")?.textContent).toContain(
      "已推荐 1 个重点",
    );
    document.querySelector<HTMLButtonElement>("#apply-ai-recommendations")?.click();
    expect(document.querySelectorAll<HTMLInputElement>("#block-list input")[0].checked).toBe(
      true,
    );
    expect(document.querySelectorAll<HTMLInputElement>("#block-list input")[1].checked).toBe(
      true,
    );
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("discards a delayed AI response after the learning goal changes", async () => {
    setupDom();
    let resolveAi: (value: unknown) => void = () => undefined;
    const pendingAi = new Promise<unknown>((resolve) => {
      resolveAi = resolve;
    });
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, snapshot })
      .mockReturnValueOnce(pendingAi);
    vi.stubGlobal("chrome", {
      runtime: { sendMessage },
      storage: { local: { get: vi.fn().mockResolvedValue({}) } },
    });
    await import("../src/sidepanel/main");

    document.querySelector<HTMLButtonElement>("#capture-button")?.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("#ai-recommendation-panel")?.hidden).toBe(
        false,
      );
    });
    document.querySelector<HTMLInputElement>("#ai-cloud-consent")?.click();
    document.querySelector<HTMLButtonElement>("#ai-recommend-button")?.click();
    const goal = document.querySelector<HTMLTextAreaElement>("#learning-goal")!;
    goal.value = "新的学习目标";
    goal.dispatchEvent(new Event("input", { bubbles: true }));

    resolveAi({
      ok: true,
      response: {
        schemaVersion: 1,
        recommendations: [
          { blockId: "block-1", category: "core_concept", reason: "旧结果" },
        ],
        analysis: {
          model: "fake-deepseek-flash",
          analyzedBlockCount: 1,
          truncated: false,
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(document.querySelectorAll("#ai-recommendation-list input")).toHaveLength(0);
    expect(document.querySelector<HTMLElement>("#ai-status")?.textContent).toBe(
      "学习目标已变化，请重新分析",
    );
  });

  it("invalidates a proposal when the note changes or a new capture starts", async () => {
    setupDom();
    const previewResponse = {
      ok: true,
      response: {
        proposalId: "proposal-1",
        action: "create",
        noteId: "learnflow-1",
        targetRelativePath: "LearnFlow/example.com/tutorial--hash.md",
        markdownPreview: "# Tutorial",
        diff: "+# Tutorial",
        expectedRevision: null,
        expiresAt: "2026-10-11T20:00:00Z",
      },
    } as const;
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, snapshot })
      .mockResolvedValueOnce(previewResponse)
      .mockResolvedValueOnce(previewResponse)
      .mockResolvedValueOnce({ ok: true, snapshot });
    vi.stubGlobal("chrome", {
      runtime: { sendMessage },
      storage: { local: { get: vi.fn().mockResolvedValue({}) } },
    });
    await import("../src/sidepanel/main");

    document.querySelector<HTMLButtonElement>("#capture-button")?.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("#selection-panel")?.hidden).toBe(false);
    });
    document.querySelector<HTMLInputElement>("#block-list input")?.click();
    document.querySelector<HTMLTextAreaElement>("#personal-note")!.value = "理解";
    document
      .querySelector<HTMLTextAreaElement>("#personal-note")
      ?.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector<HTMLButtonElement>("#preview-note-button")?.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("#note-preview-panel")?.hidden).toBe(false);
    });

    document.querySelector<HTMLTextAreaElement>("#personal-note")!.value = "修改";
    document
      .querySelector<HTMLTextAreaElement>("#personal-note")
      ?.dispatchEvent(new Event("input", { bubbles: true }));
    expect(document.querySelector<HTMLElement>("#note-preview-panel")?.hidden).toBe(true);
    expect(document.querySelector<HTMLButtonElement>("#commit-note-button")?.disabled).toBe(
      true,
    );

    document.querySelector<HTMLTextAreaElement>("#personal-note")!.value = "再次预览";
    document.querySelector<HTMLButtonElement>("#preview-note-button")?.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("#note-preview-panel")?.hidden).toBe(false);
    });
    document.querySelector<HTMLButtonElement>("#capture-button")?.click();
    expect(document.querySelector<HTMLButtonElement>("#commit-note-button")?.disabled).toBe(
      true,
    );
  });

  it("keeps selection and personal notes after a commit failure", async () => {
    setupDom();
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, snapshot })
      .mockResolvedValueOnce({
        ok: true,
        response: {
          proposalId: "proposal-1",
          action: "append",
          noteId: "learnflow-1",
          targetRelativePath: "LearnFlow/example.com/tutorial--hash.md",
          markdownPreview: "# Tutorial",
          diff: "",
          expectedRevision: "sha256:old",
          expiresAt: "2026-10-11T20:00:00Z",
        },
      })
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "NOTE_CONFLICT", message: "目标笔记发生冲突，请重新预览。" },
      });
    vi.stubGlobal("chrome", {
      runtime: { sendMessage },
      storage: { local: { get: vi.fn().mockResolvedValue({}) } },
    });
    await import("../src/sidepanel/main");

    document.querySelector<HTMLButtonElement>("#capture-button")?.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("#selection-panel")?.hidden).toBe(false);
    });
    const checkbox = document.querySelector<HTMLInputElement>("#block-list input")!;
    checkbox.click();
    const note = document.querySelector<HTMLTextAreaElement>("#personal-note")!;
    note.value = "保留这段笔记";
    note.dispatchEvent(new Event("input", { bubbles: true }));
    document.querySelector<HTMLButtonElement>("#preview-note-button")?.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("#note-preview-panel")?.hidden).toBe(false);
    });
    document.querySelector<HTMLButtonElement>("#commit-note-button")?.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("#note-status")?.textContent).toContain(
        "冲突",
      );
    });

    expect(checkbox.checked).toBe(true);
    expect(note.value).toBe("保留这段笔记");
    expect(document.querySelector<HTMLButtonElement>("#commit-note-button")?.disabled).toBe(
      true,
    );
  });

  it("invalidates an expired proposal and requires a new preview", async () => {
    setupDom();
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, snapshot })
      .mockResolvedValueOnce({
        ok: true,
        response: {
          proposalId: "expired-proposal",
          action: "create",
          noteId: "learnflow-1",
          targetRelativePath: "LearnFlow/example.md",
          markdownPreview: "# Note",
          diff: "+# Note",
          expectedRevision: null,
          expiresAt: "2026-10-11T20:00:00Z",
        },
      })
      .mockResolvedValueOnce({
        ok: false,
        error: {
          code: "PROPOSAL_EXPIRED",
          message: "预览提案已过期，请重新生成预览。",
        },
      });
    vi.stubGlobal("chrome", {
      runtime: { sendMessage },
      storage: { local: { get: vi.fn().mockResolvedValue({}) } },
    });
    await import("../src/sidepanel/main");

    document.querySelector<HTMLButtonElement>("#capture-button")?.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("#selection-panel")?.hidden).toBe(false);
    });
    document.querySelector<HTMLInputElement>("#block-list input")?.click();
    document.querySelector<HTMLButtonElement>("#preview-note-button")?.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("#note-preview-panel")?.hidden).toBe(false);
    });
    document.querySelector<HTMLButtonElement>("#commit-note-button")?.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("#note-status")?.textContent).toContain(
        "过期",
      );
    });

    expect(document.querySelector<HTMLElement>("#note-preview-panel")?.hidden).toBe(true);
    expect(document.querySelector<HTMLButtonElement>("#commit-note-button")?.disabled).toBe(
      true,
    );
  });

  it("shows noop preview without enabling the commit action", async () => {
    setupDom();
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, snapshot })
      .mockResolvedValueOnce({
        ok: true,
        response: {
          proposalId: "proposal-1",
          action: "noop",
          noteId: "learnflow-1",
          targetRelativePath: "LearnFlow/example.com/tutorial--hash.md",
          markdownPreview: "# Tutorial",
          diff: "",
          expectedRevision: "sha256:same",
          expiresAt: "2026-10-11T20:00:00Z",
        },
      });
    vi.stubGlobal("chrome", {
      runtime: { sendMessage },
      storage: { local: { get: vi.fn().mockResolvedValue({}) } },
    });
    await import("../src/sidepanel/main");

    document.querySelector<HTMLButtonElement>("#capture-button")?.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("#selection-panel")?.hidden).toBe(false);
    });
    document.querySelector<HTMLInputElement>("#block-list input")?.click();
    document.querySelector<HTMLButtonElement>("#preview-note-button")?.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("#note-status")?.textContent).toBe(
        "当前内容无需写入",
      );
    });

    expect(document.querySelector<HTMLButtonElement>("#commit-note-button")?.disabled).toBe(
      true,
    );
    document.querySelector<HTMLButtonElement>("#commit-note-button")?.click();
    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("prevents duplicate preview requests while one is pending", async () => {
    setupDom();
    let resolvePreview: (value: unknown) => void = () => undefined;
    const pendingPreview = new Promise<unknown>((resolve) => {
      resolvePreview = resolve;
    });
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, snapshot })
      .mockReturnValueOnce(pendingPreview);
    vi.stubGlobal("chrome", {
      runtime: { sendMessage },
      storage: { local: { get: vi.fn().mockResolvedValue({}) } },
    });
    await import("../src/sidepanel/main");

    document.querySelector<HTMLButtonElement>("#capture-button")?.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("#selection-panel")?.hidden).toBe(false);
    });
    document.querySelector<HTMLInputElement>("#block-list input")?.click();
    const previewButton = document.querySelector<HTMLButtonElement>(
      "#preview-note-button",
    )!;
    previewButton.click();
    previewButton.click();
    expect(sendMessage).toHaveBeenCalledTimes(2);

    resolvePreview({
      ok: true,
      response: {
        proposalId: "proposal-1",
        action: "create",
        noteId: "learnflow-1",
        targetRelativePath: "LearnFlow/example.md",
        markdownPreview: "# Note",
        diff: "+# Note",
        expectedRevision: null,
        expiresAt: "2026-10-11T20:00:00Z",
      },
    });
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("#note-preview-panel")?.hidden).toBe(false);
    });
  });

  it("shows preview errors instead of keeping the status inside a hidden panel", async () => {
    setupDom();
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, snapshot })
      .mockResolvedValueOnce({
        ok: false,
        error: {
          code: "VAULT_NOT_CONFIGURED",
          message: "本地服务尚未配置 Obsidian Vault。",
        },
      });
    vi.stubGlobal("chrome", {
      runtime: { sendMessage },
      storage: { local: { get: vi.fn().mockResolvedValue({}) } },
    });
    await import("../src/sidepanel/main");

    document.querySelector<HTMLButtonElement>("#capture-button")?.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("#selection-panel")?.hidden).toBe(false);
    });
    document.querySelector<HTMLInputElement>("#block-list input")?.click();
    document.querySelector<HTMLButtonElement>("#preview-note-button")?.click();

    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("#note-status")?.textContent).toBe(
        "本地服务尚未配置 Obsidian Vault。",
      );
    });
    expect(document.querySelector<HTMLElement>("#note-preview-panel")?.hidden).toBe(false);
    expect(document.querySelector<HTMLButtonElement>("#commit-note-button")?.disabled).toBe(
      true,
    );
  });

  it("keeps chat disabled and clearly marks AI annotation as not ready", async () => {
    setupDom();
    vi.stubGlobal("chrome", {
      runtime: { sendMessage: vi.fn() },
      storage: { local: { get: vi.fn().mockResolvedValue({}) } },
      permissions: { contains: vi.fn().mockResolvedValue(false) },
    });
    await import("../src/sidepanel/main");

    expect(document.querySelector<HTMLTextAreaElement>("#chatInput")?.disabled).toBe(true);
    document.querySelector<HTMLButtonElement>("#ai-annotate-button")?.click();
    expect(document.querySelector<HTMLElement>("#unready-sheet")?.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>("#unready-message")?.textContent).toContain(
      "AI 注解当前小节",
    );
  });

  it("organizes all current blocks through the real Note Preview request", async () => {
    setupDom();
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, snapshot: recommendationSnapshot })
      .mockResolvedValueOnce({
        ok: true,
        response: {
          proposalId: "proposal-all-blocks",
          action: "create",
          noteId: "learnflow-1",
          targetRelativePath: "LearnFlow/example.md",
          markdownPreview: "# Current chapter",
          diff: "+# Current chapter",
          expectedRevision: null,
          expiresAt: "2026-10-12T20:00:00Z",
        },
      });
    vi.stubGlobal("chrome", {
      runtime: { sendMessage },
      storage: { local: { get: vi.fn().mockResolvedValue({}) } },
      permissions: { contains: vi.fn().mockResolvedValue(false) },
    });
    await import("../src/sidepanel/main");

    document.querySelector<HTMLButtonElement>("#capture-button")?.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("#selection-panel")?.hidden).toBe(false);
    });
    document.querySelector<HTMLButtonElement>("#organize-note-button")?.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("#note-preview-panel")?.hidden).toBe(false);
    });

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls[1][0]).toMatchObject({
      type: "NOTE_PREVIEW_REQUEST",
      selectedBlockIds: ["block-1", "block-2"],
      personalNote: "",
    });
  });

  it("keeps the original-note action disabled with a persistent no-snapshot explanation", async () => {
    setupDom();
    vi.stubGlobal("chrome", {
      runtime: { sendMessage: vi.fn() },
      storage: { local: { get: vi.fn().mockResolvedValue({}) } },
      permissions: { contains: vi.fn().mockResolvedValue(false) },
    });
    await import("../src/sidepanel/main");

    expect(document.querySelector<HTMLButtonElement>("#organize-note-button")?.disabled).toBe(
      true,
    );
    expect(document.querySelector<HTMLElement>("#empty-note-hint")?.textContent).toContain(
      "启用学习模式",
    );
  });

  it("shows a persistent connection error when original-note preview fails", async () => {
    setupDom();
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, snapshot: recommendationSnapshot })
      .mockResolvedValueOnce({
        ok: false,
        error: { code: "NETWORK_ERROR", message: "本地服务不可用" },
      });
    vi.stubGlobal("chrome", {
      runtime: { sendMessage },
      storage: { local: { get: vi.fn().mockResolvedValue({}) } },
      permissions: { contains: vi.fn().mockResolvedValue(false) },
    });
    await import("../src/sidepanel/main");

    document.querySelector<HTMLButtonElement>("#capture-button")?.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLButtonElement>("#organize-note-button")?.disabled).toBe(
        false,
      );
    });
    document.querySelector<HTMLButtonElement>("#organize-note-button")?.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("#note-status")?.textContent).toContain(
        "本地服务不可用",
      );
    });
    expect(document.querySelector<HTMLElement>("#notesState")?.textContent).toBe("生成失败");
    expect(document.querySelector<HTMLElement>("#note-preview-panel")?.hidden).toBe(false);
  });

  it("previews and commits the original note through the existing proposal flow", async () => {
    setupDom();
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, snapshot: recommendationSnapshot })
      .mockResolvedValueOnce({
        ok: true,
        response: {
          proposalId: "proposal-chat-first",
          action: "create",
          noteId: "learnflow-1",
          targetRelativePath: "LearnFlow/example.md",
          markdownPreview: "# Current chapter",
          diff: "+# Current chapter",
          expectedRevision: null,
          expiresAt: "2026-10-12T20:00:00Z",
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        response: {
          status: "created",
          noteId: "learnflow-1",
          targetRelativePath: "LearnFlow/example.md",
          revision: "sha256:new",
        },
      });
    vi.stubGlobal("chrome", {
      runtime: { sendMessage },
      storage: { local: { get: vi.fn().mockResolvedValue({}) } },
      permissions: { contains: vi.fn().mockResolvedValue(false) },
    });
    await import("../src/sidepanel/main");

    document.querySelector<HTMLButtonElement>("#capture-button")?.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLButtonElement>("#organize-note-button")?.disabled).toBe(
        false,
      );
    });
    document.querySelector<HTMLButtonElement>("#organize-note-button")?.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLButtonElement>("#commit-note-button")?.disabled).toBe(
        false,
      );
    });
    expect(document.querySelector<HTMLElement>("#markdown-preview")?.textContent).toBe(
      "# Current chapter",
    );
    document.querySelector<HTMLButtonElement>("#commit-note-button")?.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("#note-status")?.textContent).toContain(
        "保存完成",
      );
    });
    expect(sendMessage.mock.calls.map(([message]) => message.type)).toEqual([
      "PAGE_CAPTURE_REQUEST",
      "NOTE_PREVIEW_REQUEST",
      "NOTE_COMMIT_REQUEST",
    ]);
  });

  it("allows chapter B to preview while chapter A preview is still pending", async () => {
    setupDom();
    const snapshotA = recommendationSnapshot;
    const snapshotB: PageSnapshot = {
      ...recommendationSnapshot,
      url: "https://example.com/chapter-b",
      title: "Chapter B",
      blocks: [{ id: "block-b", type: "paragraph", text: "B content." }],
      stats: { characterCount: 10, codeBlockCount: 0, blockCount: 1 },
    };
    const makeState = (snapshotValue: PageSnapshot, id: string): StudyState => ({
      schemaVersion: 1,
      enabled: true,
      status: "SOURCE_READY",
      authorizedOrigin: "https://fastapi.tiangolo.com",
      activeTabId: 7,
      sessionsByChapter: {},
      snapshotsByChapter: {},
      currentSession: {
        sessionId: id,
        tabId: 7,
        chapterId: id,
        sourceUrl: snapshotValue.url,
        pageTitle: snapshotValue.title,
        snapshotHash: id,
        capturedAt: snapshotValue.capturedAt,
        updatedAt: snapshotValue.capturedAt,
        status: "SOURCE_READY",
      },
      currentSnapshot: snapshotValue,
    });
    const stateA = makeState(snapshotA, "chapter-a");
    const stateB = makeState(snapshotB, "chapter-b");
    let currentState = stateA;
    let resolveA: (value: unknown) => void = () => undefined;
    let resolveB: (value: unknown) => void = () => undefined;
    const pendingA = new Promise<unknown>((resolve) => {
      resolveA = resolve;
    });
    const pendingB = new Promise<unknown>((resolve) => {
      resolveB = resolve;
    });
    const onMessage = vi.fn();
    const sendMessage = vi.fn().mockImplementation((message: { type: string; snapshot?: PageSnapshot }) => {
      if (message.type === "STUDY_GET_STATE_REQUEST") {
        return Promise.resolve({ type: "STUDY_STATE_CHANGED", state: currentState });
      }
      if (message.type === "NOTE_PREVIEW_REQUEST") {
        return message.snapshot?.url === snapshotA.url ? pendingA : pendingB;
      }
      return Promise.resolve(undefined);
    });
    vi.stubGlobal("chrome", {
      runtime: { sendMessage, onMessage: { addListener: onMessage } },
      storage: { local: { get: vi.fn().mockResolvedValue({}) } },
      permissions: { contains: vi.fn().mockResolvedValue(false) },
    });
    await import("../src/sidepanel/main");

    onMessage.mock.calls[0][0]({ type: "STUDY_STATE_CHANGED", state: stateA });
    document.querySelector<HTMLButtonElement>("#organize-note-button")?.click();
    await vi.waitFor(() => {
      expect(sendMessage.mock.calls.some(([message]) => message.type === "NOTE_PREVIEW_REQUEST")).toBe(
        true,
      );
    });

    currentState = stateB;
    onMessage.mock.calls[0][0]({ type: "STUDY_STATE_CHANGED", state: stateB });
    expect(document.querySelector<HTMLElement>("#chatView")?.classList.contains("active")).toBe(
      true,
    );
    document.querySelector<HTMLButtonElement>("#organize-note-button")?.click();
    await vi.waitFor(() => {
      expect(sendMessage.mock.calls.filter(([message]) => message.type === "NOTE_PREVIEW_REQUEST")).toHaveLength(2);
    });

    resolveA({
      ok: true,
      response: {
        proposalId: "proposal-a",
        action: "create",
        noteId: "note-a",
        targetRelativePath: "LearnFlow/a.md",
        markdownPreview: "# A",
        diff: "+# A",
        expectedRevision: null,
        expiresAt: "2026-10-12T20:00:00Z",
      },
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(document.querySelector<HTMLElement>("#markdown-preview")?.textContent).toBe("");

    resolveB({
      ok: true,
      response: {
        proposalId: "proposal-b",
        action: "create",
        noteId: "note-b",
        targetRelativePath: "LearnFlow/b.md",
        markdownPreview: "# B",
        diff: "+# B",
        expectedRevision: null,
        expiresAt: "2026-10-12T20:00:00Z",
      },
    });
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("#markdown-preview")?.textContent).toBe("# B");
    });
    expect(document.querySelector<HTMLElement>("#notesState")?.textContent).toBe("预览已生成");
  });

  it("clears an old snapshot view when StudyState reports a failed new chapter", async () => {
    setupDom();
    const onMessage = vi.fn();
    vi.stubGlobal("chrome", {
      runtime: { sendMessage: vi.fn(), onMessage: { addListener: onMessage } },
      storage: { local: { get: vi.fn().mockResolvedValue({}) } },
      permissions: { contains: vi.fn().mockResolvedValue(false) },
    });
    await import("../src/sidepanel/main");

    const stateWithSnapshot: StudyState = {
      schemaVersion: 1,
      enabled: true,
      status: "SOURCE_READY",
      authorizedOrigin: "https://fastapi.tiangolo.com",
      activeTabId: 7,
      sessionsByChapter: {},
      snapshotsByChapter: {},
      currentSession: {
        sessionId: "session-1",
        tabId: 7,
        chapterId: "chapter-1",
        sourceUrl: snapshot.url,
        pageTitle: snapshot.title,
        snapshotHash: "content-1",
        capturedAt: snapshot.capturedAt,
        updatedAt: snapshot.capturedAt,
        status: "SOURCE_READY",
      },
      currentSnapshot: snapshot,
    };
    onMessage.mock.calls[0][0]({ type: "STUDY_STATE_CHANGED", state: stateWithSnapshot });
    expect(document.querySelector<HTMLElement>("#result-panel")?.hidden).toBe(false);
    expect(document.querySelector<HTMLElement>("#study-chapter")?.textContent).toBe(
      "Tutorial",
    );

    const failedState: StudyState = {
      ...stateWithSnapshot,
      status: "CAPTURE_FAILED",
      currentSession: undefined,
      currentSnapshot: undefined,
      lastError: "B 页面采集失败",
    };
    onMessage.mock.calls[0][0]({ type: "STUDY_STATE_CHANGED", state: failedState });
    expect(document.querySelector<HTMLElement>("#result-panel")?.hidden).toBe(true);
    expect(document.querySelector<HTMLElement>("#study-error")?.textContent).toContain(
      "B 页面采集失败",
    );
  });

  it("invalidates a delayed preview response after a new chapter arrives", async () => {
    setupDom();
    let resolvePreview: (value: unknown) => void = () => undefined;
    const pendingPreview = new Promise<unknown>((resolve) => {
      resolvePreview = resolve;
    });
    const onMessage = vi.fn();
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, snapshot })
      .mockReturnValueOnce(pendingPreview);
    vi.stubGlobal("chrome", {
      runtime: { sendMessage, onMessage: { addListener: onMessage } },
      storage: { local: { get: vi.fn().mockResolvedValue({}) } },
      permissions: { contains: vi.fn().mockResolvedValue(false) },
    });
    await import("../src/sidepanel/main");

    document.querySelector<HTMLButtonElement>("#capture-button")?.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLButtonElement>("#organize-note-button")?.disabled).toBe(
        false,
      );
    });
    document.querySelector<HTMLButtonElement>("#organize-note-button")?.click();
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));

    const chapterB = { ...snapshot, url: "https://example.com/other", title: "Chapter B" };
    const stateB: StudyState = {
      schemaVersion: 1,
      enabled: true,
      status: "SOURCE_READY",
      authorizedOrigin: "https://fastapi.tiangolo.com",
      activeTabId: 7,
      sessionsByChapter: {},
      snapshotsByChapter: {},
      currentSession: {
        sessionId: "session-b",
        tabId: 7,
        chapterId: "chapter-b",
        sourceUrl: chapterB.url,
        pageTitle: chapterB.title,
        snapshotHash: "hash-b",
        capturedAt: chapterB.capturedAt,
        updatedAt: chapterB.capturedAt,
        status: "SOURCE_READY",
      },
      currentSnapshot: chapterB,
    };
    onMessage.mock.calls[0][0]({ type: "STUDY_STATE_CHANGED", state: stateB });
    resolvePreview({
      ok: true,
      response: {
        proposalId: "old-proposal",
        action: "create",
        noteId: "old-note",
        targetRelativePath: "LearnFlow/old.md",
        markdownPreview: "old chapter",
        diff: "+old",
        expectedRevision: null,
        expiresAt: "2026-10-12T20:00:00Z",
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(document.querySelector<HTMLElement>("#noteDocument")?.classList.contains("hide")).toBe(
      true,
    );
    expect(document.querySelector<HTMLButtonElement>("#commit-note-button")?.disabled).toBe(
      true,
    );
    expect(document.querySelector<HTMLElement>("#markdown-preview")?.textContent).toBe("");
  });

  it("does not let initial storage hydration overwrite a newer StudyState message", async () => {
    setupDom();
    let resolveStorage: (value: unknown) => void = () => undefined;
    const delayedStorage = new Promise<unknown>((resolve) => {
      resolveStorage = resolve;
    });
    const onMessage = vi.fn();
    const storageGet = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockReturnValueOnce(delayedStorage);
    vi.stubGlobal("chrome", {
      runtime: { sendMessage: vi.fn(), onMessage: { addListener: onMessage } },
      storage: { local: { get: storageGet } },
      permissions: { contains: vi.fn().mockResolvedValue(false) },
    });
    await import("../src/sidepanel/main");

    const liveState: StudyState = {
      schemaVersion: 1,
      enabled: true,
      status: "SOURCE_READY",
      authorizedOrigin: "https://fastapi.tiangolo.com",
      activeTabId: 7,
      sessionsByChapter: {},
      snapshotsByChapter: {},
      currentSession: {
        sessionId: "live-session",
        tabId: 7,
        chapterId: "live-chapter",
        sourceUrl: snapshot.url,
        pageTitle: "Live Chapter",
        snapshotHash: "live-hash",
        capturedAt: snapshot.capturedAt,
        updatedAt: snapshot.capturedAt,
        status: "SOURCE_READY",
      },
      currentSnapshot: { ...snapshot, title: "Live Chapter" },
    };
    onMessage.mock.calls[0][0]({ type: "STUDY_STATE_CHANGED", state: liveState });
    resolveStorage({ learnflowStudyState: { enabled: false, status: "DISABLED" } });
    await Promise.resolve();
    await Promise.resolve();

    expect(document.querySelector<HTMLElement>("#study-chapter")?.textContent).toBe(
      "Live Chapter",
    );
    expect(document.querySelector<HTMLElement>("#result-panel")?.hidden).toBe(false);
  });

  it("ignores a delayed preview response after the selection state changes", async () => {
    setupDom();
    let resolvePreview: (value: unknown) => void = () => undefined;
    const pendingPreview = new Promise<unknown>((resolve) => {
      resolvePreview = resolve;
    });
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, snapshot })
      .mockReturnValueOnce(pendingPreview);
    vi.stubGlobal("chrome", {
      runtime: { sendMessage },
      storage: { local: { get: vi.fn().mockResolvedValue({}) } },
    });
    await import("../src/sidepanel/main");

    document.querySelector<HTMLButtonElement>("#capture-button")?.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("#selection-panel")?.hidden).toBe(false);
    });
    document.querySelector<HTMLInputElement>("#block-list input")?.click();
    document.querySelector<HTMLButtonElement>("#preview-note-button")?.click();
    document.querySelector<HTMLTextAreaElement>("#personal-note")!.value = "新状态";
    document
      .querySelector<HTMLTextAreaElement>("#personal-note")
      ?.dispatchEvent(new Event("input", { bubbles: true }));

    resolvePreview({
      ok: true,
      response: {
        proposalId: "stale-proposal",
        action: "create",
        noteId: "learnflow-1",
        targetRelativePath: "LearnFlow/example.md",
        markdownPreview: "stale markdown",
        diff: "+stale",
        expectedRevision: null,
        expiresAt: "2026-10-11T20:00:00Z",
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(document.querySelector<HTMLElement>("#note-preview-panel")?.hidden).toBe(true);
    expect(document.querySelector<HTMLButtonElement>("#commit-note-button")?.disabled).toBe(
      true,
    );
    expect(document.querySelector<HTMLElement>("#markdown-preview")?.textContent).toBe("");
  });

  it("does not let a delayed commit response overwrite a new capture", async () => {
    setupDom();
    let resolveCommit: (value: unknown) => void = () => undefined;
    const pendingCommit = new Promise<unknown>((resolve) => {
      resolveCommit = resolve;
    });
    const previewResponse = {
      ok: true,
      response: {
        proposalId: "proposal-1",
        action: "create",
        noteId: "learnflow-1",
        targetRelativePath: "LearnFlow/example.md",
        markdownPreview: "# Note",
        diff: "+# Note",
        expectedRevision: null,
        expiresAt: "2026-10-11T20:00:00Z",
      },
    } as const;
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, snapshot })
      .mockResolvedValueOnce(previewResponse)
      .mockReturnValueOnce(pendingCommit)
      .mockResolvedValueOnce({ ok: true, snapshot });
    vi.stubGlobal("chrome", {
      runtime: { sendMessage },
      storage: { local: { get: vi.fn().mockResolvedValue({}) } },
    });
    await import("../src/sidepanel/main");

    document.querySelector<HTMLButtonElement>("#capture-button")?.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("#selection-panel")?.hidden).toBe(false);
    });
    document.querySelector<HTMLInputElement>("#block-list input")?.click();
    document.querySelector<HTMLButtonElement>("#preview-note-button")?.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("#note-preview-panel")?.hidden).toBe(false);
    });
    document.querySelector<HTMLButtonElement>("#commit-note-button")?.click();
    document.querySelector<HTMLButtonElement>("#capture-button")?.click();
    await vi.waitFor(() => {
      expect(document.querySelector<HTMLElement>("#capture-status")?.textContent).toBe(
        "采集完成",
      );
    });

    resolveCommit({
      ok: true,
      response: {
        status: "created",
        noteId: "learnflow-1",
        targetRelativePath: "LearnFlow/example.md",
        revision: "sha256:old",
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(document.querySelector<HTMLElement>("#note-status")?.textContent).toBe(
      "需要先生成预览",
    );
    expect(document.querySelector<HTMLElement>("#note-preview-panel")?.hidden).toBe(true);
  });

  it("discards a delayed Document Engine preview after a new chapter arrives", async () => {
    setupDom();
    let resolveDocument: (value: unknown) => void = () => undefined;
    const pendingDocument = new Promise<unknown>((resolve) => {
      resolveDocument = resolve;
    });
    const onMessage = vi.fn();
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, snapshot })
      .mockReturnValueOnce(pendingDocument);
    vi.stubGlobal("chrome", {
      runtime: { sendMessage, onMessage: { addListener: onMessage } },
      storage: { local: { get: vi.fn().mockResolvedValue({}) } },
      permissions: { contains: vi.fn().mockResolvedValue(false) },
    });
    await import("../src/sidepanel/main");

    document.querySelector<HTMLButtonElement>("#capture-button")?.click();
    await vi.waitFor(() => {
      expect(
        document.querySelector<HTMLButtonElement>("#document-v2-preview-button")?.disabled,
      ).toBe(false);
    });
    document.querySelector<HTMLButtonElement>("#document-v2-preview-button")?.click();
    await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(2));

    const chapterB: PageSnapshot = {
      ...snapshot,
      url: "https://example.com/chapter-b",
      title: "Chapter B",
      blocks: [{ id: "block-b", type: "paragraph", text: "B content." }],
      stats: { characterCount: 10, codeBlockCount: 0, blockCount: 1 },
    };
    const stateB: StudyState = {
      schemaVersion: 1,
      enabled: true,
      status: "SOURCE_READY",
      authorizedOrigin: "https://fastapi.tiangolo.com",
      activeTabId: 7,
      sessionsByChapter: {},
      snapshotsByChapter: {},
      currentSession: {
        sessionId: "session-b",
        tabId: 7,
        chapterId: "chapter-b",
        sourceUrl: chapterB.url,
        pageTitle: chapterB.title,
        snapshotHash: "hash-b",
        capturedAt: chapterB.capturedAt,
        updatedAt: chapterB.capturedAt,
        status: "SOURCE_READY",
      },
      currentSnapshot: chapterB,
    };
    onMessage.mock.calls[0][0]({ type: "STUDY_STATE_CHANGED", state: stateB });

    resolveDocument({
      ok: true,
      response: {
        status: "preview",
        schemaVersion: 2,
        proposalId: "old-document-proposal",
        action: "create",
        noteId: "old-note",
        targetRelativePath: "LearnFlow/old.md",
        diff: "+old chapter",
        expectedRevision: null,
        expiresAt: "2026-10-12T20:00:00Z",
        title: "Tutorial",
        sourceUrl: snapshot.url,
        markdownPreview: "old chapter",
        diagnostics: {
          renderedBlockCount: 1,
          filteredBlockCount: 0,
          unsupportedBlockCount: 0,
          truncated: false,
          warnings: [],
          qualityStatus: "ok",
          issues: [],
        },
      },
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(document.querySelector<HTMLElement>("#document-v2-preview-panel")?.hidden).toBe(
      true,
    );
    expect(document.querySelector<HTMLElement>("#document-v2-markdown")?.textContent).toBe("");
    expect(document.querySelector<HTMLElement>("#document-v2-status")?.textContent).toContain(
      "可以整理并保存当前章节",
    );
  });
});
