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

    document.querySelector<HTMLButtonElement>("#send-button")?.click();
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
});
