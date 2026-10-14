import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  captureCurrentPage,
  isPageSnapshot,
  readCurrentPageSelection,
  registerCaptureMessageHandler,
  setCaptureTarget,
} from "../src/capture/capture-service";
import type { PageSnapshot } from "../src/capture/types";

const activeTab = {
  id: 7,
  url: "https://example.com/tutorial",
  title: "Tutorial",
  windowId: 1,
};

const snapshot: PageSnapshot = {
  schemaVersion: 1,
  url: activeTab.url,
  title: "Tutorial",
  capturedAt: "2026-10-11T00:00:00.000Z",
  blocks: [
    { id: "block-1", type: "paragraph", text: "A tutorial." },
  ],
  extraction: {
    strategy: "article",
    truncated: false,
    warnings: [],
  },
  stats: {
    characterCount: 11,
    codeBlockCount: 0,
    blockCount: 1,
  },
};

describe("captureCurrentPage", () => {
  let query: ReturnType<typeof vi.fn>;
  let executeScript: ReturnType<typeof vi.fn>;
  let getTab: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    query = vi.fn();
    executeScript = vi.fn();
    getTab = vi.fn();
    setCaptureTarget(undefined);
    vi.stubGlobal("chrome", {
      tabs: { query, get: getTab },
      scripting: { executeScript },
      runtime: { onMessage: { addListener: vi.fn() } },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("captures a valid active HTTP page", async () => {
    query.mockResolvedValue([activeTab]);
    executeScript.mockResolvedValue([{ result: snapshot }]);

    const response = await captureCurrentPage();

    expect(response).toEqual({ ok: true, snapshot });
    expect(executeScript).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: activeTab.id },
        files: ["assets/mature-extractor.js"],
      }),
    );
  });

  it("uses the injected HTTPS URL when tab.url is unavailable", async () => {
    const tabWithoutUrl = { ...activeTab, url: undefined };
    query.mockResolvedValue([tabWithoutUrl]);
    executeScript.mockResolvedValue([{ result: snapshot }]);

    const response = await captureCurrentPage();

    expect(response).toEqual({ ok: true, snapshot });
    expect(query).toHaveBeenCalledWith({
      active: true,
      lastFocusedWindow: true,
    });
  });

  it("distinguishes unavailable URL from an unsupported protocol", async () => {
    query.mockResolvedValue([{ ...activeTab, url: undefined }]);
    executeScript.mockRejectedValue(new Error("The tab is not ready."));

    const response = await captureCurrentPage();

    expect(response).toMatchObject({
      ok: false,
      error: { code: "URL_UNAVAILABLE" },
    });
  });

  it("rejects unsupported browser pages before injection", async () => {
    query.mockResolvedValue([{ ...activeTab, url: "chrome://extensions" }]);

    const response = await captureCurrentPage();

    expect(response).toMatchObject({
      ok: false,
      error: { code: "UNSUPPORTED_URL" },
    });
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("returns a distinct error when there is no active tab", async () => {
    query.mockResolvedValue([]);

    const response = await captureCurrentPage();

    expect(response).toMatchObject({
      ok: false,
      error: { code: "NO_ACTIVE_TAB" },
    });
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("maps injection permission failures to a clear error", async () => {
    query.mockResolvedValue([activeTab]);
    executeScript.mockRejectedValue(
      new Error("Cannot access contents of the page."),
    );

    const response = await captureCurrentPage();

    expect(response).toMatchObject({
      ok: false,
      error: { code: "PERMISSION_DENIED" },
    });
  });

  it("reads selected code with a chapter-aware source fingerprint", async () => {
    query.mockResolvedValue([activeTab]);
    executeScript.mockResolvedValue([
      {
        result: {
          schemaVersion: 1,
          text: "Annotated[str, Form()]",
          sourceUrl: activeTab.url,
          pageTitle: activeTab.title,
          headingPath: ["Request forms"],
          sourceNodeId: "pre-3",
          sourceFingerprint: "selection-1234abcd",
        },
      },
    ]);

    const response = await readCurrentPageSelection();

    expect(response).toMatchObject({
      ok: true,
      selection: {
        text: "Annotated[str, Form()]",
        headingPath: ["Request forms"],
        sourceNodeId: "pre-3",
      },
    });
    expect(executeScript).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: activeTab.id },
        func: expect.any(Function),
      }),
    );
  });

  it("requires an explicit selection before attaching source content", async () => {
    query.mockResolvedValue([activeTab]);
    executeScript.mockResolvedValue([{ result: null }]);

    const response = await readCurrentPageSelection();

    expect(response).toMatchObject({
      ok: false,
      error: { code: "NO_SELECTION" },
    });
  });

  it("rejects a result when the active page changes during capture", async () => {
    query
      .mockResolvedValueOnce([activeTab])
      .mockResolvedValueOnce([{ ...activeTab, url: "https://example.com/other" }]);
    executeScript.mockResolvedValue([{ result: snapshot }]);

    const response = await captureCurrentPage();

    expect(response).toMatchObject({
      ok: false,
      error: { code: "STALE_TAB" },
    });
  });

  it("rejects a snapshot whose injected URL differs from the initial tab URL", async () => {
    query.mockResolvedValue([activeTab]);
    executeScript.mockResolvedValue([
      { result: { ...snapshot, url: "https://example.com/other" } },
    ]);

    const response = await captureCurrentPage();

    expect(response).toMatchObject({
      ok: false,
      error: { code: "STALE_TAB" },
    });
  });

  it("blocks a request-forms snapshot from being saved with request-files as its source", async () => {
    const formsTab = {
      ...activeTab,
      url: "https://fastapi.tiangolo.com/zh/tutorial/request-forms/",
    };
    query.mockResolvedValue([formsTab]);
    executeScript.mockResolvedValue([
      {
        result: {
          ...snapshot,
          url: "https://fastapi.tiangolo.com/zh/tutorial/request-files/",
          title: "Request files - FastAPI",
        },
      },
    ]);

    const response = await captureCurrentPage();

    expect(response).toMatchObject({
      ok: false,
      error: { code: "STALE_TAB" },
    });
  });

  it("rejects malformed injection results", async () => {
    query.mockResolvedValue([activeTab]);
    executeScript.mockResolvedValue([{ result: { unexpected: true } }]);

    const response = await captureCurrentPage();

    expect(response).toMatchObject({
      ok: false,
      error: { code: "INVALID_RESULT" },
    });
    expect(isPageSnapshot({ unexpected: true })).toBe(false);
  });

  it("falls back when the bundled parser returns an empty injection result", async () => {
    query.mockResolvedValue([activeTab]);
    executeScript
      .mockResolvedValueOnce([{ result: null }])
      .mockResolvedValueOnce([{ result: undefined }])
      .mockResolvedValueOnce([{ result: snapshot }]);

    const response = await captureCurrentPage();

    expect(response).toEqual({ ok: true, snapshot });
    expect(executeScript).toHaveBeenCalledTimes(3);
    expect(executeScript).toHaveBeenLastCalledWith(
      expect.objectContaining({
        target: { tabId: activeTab.id },
        func: expect.any(Function),
      }),
    );
  });

  it("rejects null and inconsistent nested snapshot fields without throwing", () => {
    const invalidSnapshots: unknown[] = [
      { ...snapshot, extraction: null },
      { ...snapshot, stats: null },
      { ...snapshot, blocks: [null] },
      {
        ...snapshot,
        blocks: [{ ...snapshot.blocks[0], level: "1" }],
      },
      {
        ...snapshot,
        stats: { ...snapshot.stats, characterCount: -1 },
      },
      {
        ...snapshot,
        stats: { ...snapshot.stats, blockCount: 2 },
      },
    ];

    for (const value of invalidSnapshots) {
      expect(() => isPageSnapshot(value)).not.toThrow();
      expect(isPageSnapshot(value)).toBe(false);
    }
  });

  it("uses the preferred action tab instead of falling back to another tab", async () => {
    const preferredTab = { ...activeTab, id: 42 };
    setCaptureTarget(preferredTab.id);
    getTab.mockResolvedValue(preferredTab);
    executeScript.mockResolvedValue([{ result: snapshot }]);

    const response = await captureCurrentPage();

    expect(response).toEqual({ ok: true, snapshot });
    expect(getTab).toHaveBeenCalledTimes(2);
    expect(query).not.toHaveBeenCalled();
    expect(executeScript).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { tabId: preferredTab.id },
        files: ["assets/mature-extractor.js"],
      }),
    );
  });

  it("falls back to the live active tab when the preferred tab was closed", async () => {
    setCaptureTarget(42);
    getTab.mockRejectedValue(new Error("No tab with id: 42"));
    query.mockResolvedValue([activeTab]);
    executeScript.mockResolvedValue([{ result: snapshot }]);

    const response = await captureCurrentPage();

    expect(response).toEqual({ ok: true, snapshot });
    expect(query).toHaveBeenCalledWith({ active: true, lastFocusedWindow: true });
    expect(executeScript).toHaveBeenCalled();
  });

  it("handles capture messages and ignores unrelated messages", async () => {
    const addListener = vi.fn();
    vi.stubGlobal("chrome", {
      tabs: { query },
      scripting: { executeScript },
      runtime: { onMessage: { addListener } },
    });
    query.mockResolvedValue([activeTab]);
    executeScript.mockResolvedValue([{ result: snapshot }]);

    registerCaptureMessageHandler();

    const listener = addListener.mock.calls[0][0] as (
      message: unknown,
      sender: unknown,
      sendResponse: (response: unknown) => void,
    ) => boolean;
    const sendResponse = vi.fn();

    expect(listener({ type: "OTHER_MESSAGE" }, {}, sendResponse)).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();

    expect(
      listener({ type: "PAGE_CAPTURE_REQUEST" }, {}, sendResponse),
    ).toBe(true);
    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledWith({ ok: true, snapshot });
    });
  });
});
