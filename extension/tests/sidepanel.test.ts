import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PageCaptureResponse, PageSnapshot } from "../src/capture/types";

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
    <button id="capture-button" type="button">采集当前页面</button>
    <p id="capture-status">等待操作</p>
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
});
