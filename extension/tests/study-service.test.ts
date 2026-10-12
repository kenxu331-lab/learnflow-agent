import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PageSnapshot } from "../src/capture/types";
import {
  STUDY_ENABLE_REQUEST,
  STUDY_MANUAL_SNAPSHOT_REQUEST,
  STUDY_PAUSE_REQUEST,
  STUDY_REVOKE_REQUEST,
  STUDY_SNAPSHOTS_STORAGE_KEY,
  STUDY_STORAGE_KEY,
  type StudyState,
} from "../src/study/types";

const TAB_URL = "https://fastapi.tiangolo.com/tutorial/dependencies/";
const TAB_TITLE = "Dependencies";
const tab = {
  id: 7,
  windowId: 1,
  url: TAB_URL,
  title: TAB_TITLE,
} as chrome.tabs.Tab;

function makeSnapshot(url = TAB_URL, title = TAB_TITLE): PageSnapshot {
  return {
    schemaVersion: 1,
    url,
    title,
    capturedAt: "2026-10-12T00:00:00.000Z",
    blocks: [
      { id: "block-1", type: "heading", text: title, level: 1 },
      { id: "block-2", type: "paragraph", text: "Tutorial content." },
    ],
    extraction: {
      strategy: "article",
      truncated: false,
      warnings: [],
    },
    stats: {
      characterCount: title.length + "Tutorial content.".length,
      codeBlockCount: 0,
      blockCount: 2,
    },
  };
}

function createChromeMock(
  initialState: unknown = {},
  initialSnapshots: unknown = {},
) {
  const getTab = vi.fn().mockResolvedValue(tab);
  const executeScript = vi.fn().mockResolvedValue([{ result: makeSnapshot() }]);
  const storageSet = vi.fn().mockResolvedValue(undefined);
  const storageGet = vi.fn().mockResolvedValue({
    [STUDY_STORAGE_KEY]: initialState,
    [STUDY_SNAPSHOTS_STORAGE_KEY]: initialSnapshots,
  });
  const runtimeSendMessage = vi.fn().mockResolvedValue(undefined);
  const chromeMock = {
    tabs: {
      get: getTab,
      query: vi.fn().mockResolvedValue([tab]),
      onUpdated: { addListener: vi.fn() },
      onActivated: { addListener: vi.fn() },
      onRemoved: { addListener: vi.fn() },
    },
    webNavigation: {
      onHistoryStateUpdated: { addListener: vi.fn() },
      onReferenceFragmentUpdated: { addListener: vi.fn() },
    },
    scripting: { executeScript },
    permissions: { contains: vi.fn().mockResolvedValue(true) },
    storage: {
      local: { get: storageGet, set: storageSet },
    },
    runtime: {
      sendMessage: runtimeSendMessage,
      onMessage: { addListener: vi.fn() },
    },
  };
  vi.stubGlobal("chrome", chromeMock);
  return { getTab, executeScript, storageSet, storageGet, runtimeSendMessage, chromeMock };
}

async function loadService() {
  const capture = await import("../src/capture/capture-service");
  const service = await import("../src/study/study-service");
  capture.setCaptureTarget(7);
  service.registerStudyService();
  return { capture, service };
}

function historyListener(chromeMock: ReturnType<typeof createChromeMock>["chromeMock"]) {
  return chromeMock.webNavigation.onHistoryStateUpdated.addListener.mock
    .calls[0][0] as (details: { tabId: number; url: string; frameId: number }) => void;
}

async function captureInitialPage(
  service: Awaited<ReturnType<typeof loadService>>["service"],
): Promise<void> {
  await service.handleStudyRequest({ type: STUDY_ENABLE_REQUEST });
  await vi.advanceTimersByTimeAsync(100);
}

describe("M01-04B study session service", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("does not automatically capture before the exact site permission is granted", async () => {
    const { executeScript, chromeMock } = createChromeMock();
    chromeMock.permissions.contains.mockResolvedValue(false);
    const { service } = await loadService();

    const response = await service.handleStudyRequest({ type: STUDY_ENABLE_REQUEST });

    expect(response).toMatchObject({
      ok: false,
      error: { code: "PERMISSION_REQUIRED" },
    });
    expect(executeScript).not.toHaveBeenCalled();
  });

  it("does not resume automatic injection after a persisted permission is revoked", async () => {
    const persistedState: StudyState = {
      schemaVersion: 1,
      enabled: true,
      status: "AUTHORIZED",
      authorizedOrigin: "https://fastapi.tiangolo.com",
      activeTabId: 7,
      sessionsByChapter: {},
      snapshotsByChapter: {},
    };
    const { executeScript, chromeMock } = createChromeMock(persistedState);
    chromeMock.permissions.contains.mockResolvedValue(false);
    const { service } = await loadService();

    await vi.advanceTimersByTimeAsync(1_000);

    expect(executeScript).not.toHaveBeenCalled();
    expect(service.getCurrentStudyState().status).toBe("CAPTURE_FAILED");
  });

  it("captures an authorized page and persists a recoverable chapter session", async () => {
    const { executeScript, storageSet } = createChromeMock();
    const { service } = await loadService();

    await captureInitialPage(service);

    const state = service.getCurrentStudyState();
    expect(state.status).toBe("SOURCE_READY");
    expect(state.currentSession).toMatchObject({
      tabId: 7,
      sourceUrl: TAB_URL,
      status: "SOURCE_READY",
    });
    expect(state.currentSnapshot?.url).toBe(TAB_URL);
    expect(executeScript).toHaveBeenCalledTimes(1);
    expect(storageSet).toHaveBeenCalledWith(
      expect.objectContaining({
        [STUDY_STORAGE_KEY]: expect.objectContaining({
          currentSession: expect.any(Object),
        }),
        [STUDY_SNAPSHOTS_STORAGE_KEY]: expect.any(Object),
      }),
    );
  });

  it("uses only top-level webNavigation events for SPA history changes", async () => {
    const { executeScript, getTab, chromeMock } = createChromeMock();
    const nextUrl = "https://fastapi.tiangolo.com/tutorial/security/";
    const nextSnapshot = makeSnapshot(nextUrl, "Security");
    const { service } = await loadService();
    await captureInitialPage(service);

    executeScript.mockResolvedValueOnce([{ result: nextSnapshot }]);
    getTab.mockResolvedValue({ ...tab, url: nextUrl, title: "Security" });
    const onHistory = historyListener(chromeMock);
    onHistory({ tabId: 7, url: nextUrl, frameId: 1 });
    await vi.advanceTimersByTimeAsync(500);
    expect(service.getCurrentStudyState().currentSession?.sourceUrl).toBe(TAB_URL);

    onHistory({ tabId: 7, url: nextUrl, frameId: 0 });
    await vi.advanceTimersByTimeAsync(500);
    expect(service.getCurrentStudyState().currentSession?.sourceUrl).toBe(nextUrl);

    const hashUrl = `${nextUrl}#details`;
    const hashSnapshot = makeSnapshot(hashUrl, "Security details");
    executeScript.mockResolvedValueOnce([{ result: hashSnapshot }]);
    getTab.mockResolvedValue({ ...tab, url: hashUrl, title: "Security details" });
    const onFragment = chromeMock.webNavigation.onReferenceFragmentUpdated.addListener
      .mock.calls[0][0] as (details: { tabId: number; url: string; frameId: number }) => void;
    onFragment({ tabId: 7, url: hashUrl, frameId: 0 });
    await vi.advanceTimersByTimeAsync(500);
    expect(service.getCurrentStudyState().currentSession?.sourceUrl).toBe(hashUrl);
  });

  it("switches chapters and discards an older in-flight result", async () => {
    const { executeScript, getTab, chromeMock } = createChromeMock();
    let resolveOldCapture: ((value: unknown[]) => void) | undefined;
    const nextUrl = "https://fastapi.tiangolo.com/tutorial/security/";
    const nextSnapshot = makeSnapshot(nextUrl, "Security");
    executeScript.mockImplementation(
      () =>
        new Promise((resolve) => {
          if (!resolveOldCapture) {
            resolveOldCapture = resolve;
          } else {
            resolve([{ result: nextSnapshot }]);
          }
        }),
    );
    const { service } = await loadService();

    await service.handleStudyRequest({ type: STUDY_ENABLE_REQUEST });
    vi.advanceTimersByTime(100);
    await Promise.resolve();
    await vi.waitFor(() => expect(executeScript).toHaveBeenCalledTimes(1));
    getTab.mockResolvedValue({ ...tab, url: nextUrl, title: "Security" });
    historyListener(chromeMock)({ tabId: 7, url: nextUrl, frameId: 0 });
    await Promise.resolve();
    resolveOldCapture?.([{ result: makeSnapshot() }]);
    await vi.waitFor(() => expect(executeScript).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(service.getCurrentStudyState().currentSnapshot?.url).toBe(nextUrl);
    expect(service.getCurrentStudyState().currentSession?.pageTitle).toBe("Security");
    expect(Object.keys(service.getCurrentStudyState().sessionsByChapter)).toHaveLength(1);
  });

  it("cancels before injection when pause happens during tabs.get", async () => {
    const { executeScript, getTab } = createChromeMock();
    let releaseDeferredTab: ((value: chrome.tabs.Tab) => void) | undefined;
    let getTabCalls = 0;
    const deferredTab = new Promise<chrome.tabs.Tab>((resolve) => {
      releaseDeferredTab = resolve;
    });
    const { service } = await loadService();
    await service.handleStudyRequest({ type: STUDY_ENABLE_REQUEST });
    getTab.mockImplementation(async () => {
      getTabCalls += 1;
      return getTabCalls === 7 ? deferredTab : tab;
    });

    vi.advanceTimersByTime(100);
    await vi.waitFor(() => expect(getTabCalls).toBe(7));
    await service.handleStudyRequest({ type: STUDY_PAUSE_REQUEST });
    releaseDeferredTab?.(tab);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(executeScript).not.toHaveBeenCalled();
    expect(service.getCurrentStudyState().status).toBe("DISABLED");
    expect(service.getCurrentStudyState().currentSnapshot).toBeUndefined();
  });

  it("cancels before injection when revoke happens during permission lookup", async () => {
    const { executeScript, chromeMock } = createChromeMock();
    let releaseDeferredPermission: ((value: boolean) => void) | undefined;
    let permissionCalls = 0;
    const deferredPermission = new Promise<boolean>((resolve) => {
      releaseDeferredPermission = resolve;
    });
    chromeMock.permissions.contains.mockImplementation(async () => {
      permissionCalls += 1;
      return permissionCalls === 4 ? deferredPermission : true;
    });
    const { service } = await loadService();
    await service.handleStudyRequest({ type: STUDY_ENABLE_REQUEST });

    vi.advanceTimersByTime(100);
    await vi.waitFor(() => expect(permissionCalls).toBe(4));
    await service.handleStudyRequest({ type: STUDY_REVOKE_REQUEST });
    releaseDeferredPermission?.(true);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(executeScript).not.toHaveBeenCalled();
    expect(service.getCurrentStudyState().status).toBe("DISABLED");
    expect(service.getCurrentStudyState().currentSnapshot).toBeUndefined();
  });

  it("handles an ordinary completed navigation through tabs.onUpdated", async () => {
    const { executeScript, getTab, chromeMock } = createChromeMock();
    const nextUrl = "https://fastapi.tiangolo.com/tutorial/body/";
    const nextSnapshot = makeSnapshot(nextUrl, "Request Body");
    const { service } = await loadService();
    await captureInitialPage(service);

    executeScript.mockResolvedValueOnce([{ result: nextSnapshot }]);
    getTab.mockResolvedValue({ ...tab, url: nextUrl, title: "Request Body" });
    const onUpdated = chromeMock.tabs.onUpdated.addListener.mock.calls[0][0] as (
      tabId: number,
      changeInfo: chrome.tabs.TabChangeInfo,
      updatedTab: chrome.tabs.Tab,
    ) => void;
    onUpdated(7, { status: "complete", url: nextUrl }, { ...tab, url: nextUrl });
    await vi.advanceTimersByTimeAsync(500);

    expect(service.getCurrentStudyState().currentSession?.sourceUrl).toBe(nextUrl);
  });

  it("does not create another capture for a repeated identical URL notification", async () => {
    const { executeScript, chromeMock } = createChromeMock();
    const { service } = await loadService();
    await captureInitialPage(service);
    const initialCalls = executeScript.mock.calls.length;

    historyListener(chromeMock)({ tabId: 7, url: TAB_URL, frameId: 0 });
    await vi.advanceTimersByTimeAsync(500);

    expect(executeScript).toHaveBeenCalledTimes(initialCalls);
    expect(Object.keys(service.getCurrentStudyState().sessionsByChapter)).toHaveLength(1);
  });

  it("clears the old current snapshot on B failure, then records B after manual retry", async () => {
    const { executeScript, getTab, chromeMock } = createChromeMock();
    const nextUrl = "https://fastapi.tiangolo.com/tutorial/security/";
    const nextSnapshot = makeSnapshot(nextUrl, "Security");
    const { capture, service } = await loadService();
    await captureInitialPage(service);

    getTab.mockResolvedValue({ ...tab, url: nextUrl, title: "Security" });
    executeScript.mockRejectedValue(new Error("temporary injection failure"));
    historyListener(chromeMock)({ tabId: 7, url: nextUrl, frameId: 0 });
    await vi.advanceTimersByTimeAsync(4_000);

    expect(service.getCurrentStudyState().currentSnapshot).toBeUndefined();
    expect(service.getCurrentStudyState().currentSession).toBeUndefined();
    expect(Object.keys(service.getCurrentStudyState().snapshotsByChapter)).toHaveLength(1);

    executeScript.mockResolvedValue([{ result: nextSnapshot }]);
    const manualResponse = await capture.captureCurrentPage();
    expect(manualResponse).toMatchObject({ ok: true, snapshot: nextSnapshot });
    await service.handleStudyRequest({
      type: STUDY_MANUAL_SNAPSHOT_REQUEST,
      snapshot: nextSnapshot,
    });

    expect(service.getCurrentStudyState().currentSnapshot?.url).toBe(nextUrl);
    expect(service.getCurrentStudyState().currentSession?.pageTitle).toBe("Security");
    expect(Object.keys(service.getCurrentStudyState().snapshotsByChapter)).toHaveLength(2);
  });

  it("persists the current pointer on A to B to A cache hits without rewriting snapshots", async () => {
    const { executeScript, getTab, storageSet, chromeMock } = createChromeMock();
    const nextUrl = "https://fastapi.tiangolo.com/tutorial/security/";
    const nextSnapshot = makeSnapshot(nextUrl, "Security");
    const { service } = await loadService();
    await captureInitialPage(service);

    executeScript.mockResolvedValueOnce([{ result: nextSnapshot }]);
    getTab.mockResolvedValue({ ...tab, url: nextUrl, title: "Security" });
    historyListener(chromeMock)({ tabId: 7, url: nextUrl, frameId: 0 });
    await vi.advanceTimersByTimeAsync(500);

    executeScript.mockResolvedValueOnce([{ result: makeSnapshot() }]);
    getTab.mockResolvedValue(tab);
    historyListener(chromeMock)({ tabId: 7, url: TAB_URL, frameId: 0 });
    await vi.advanceTimersByTimeAsync(500);

    const lastPayload = storageSet.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(lastPayload[STUDY_STORAGE_KEY]).toBeDefined();
    expect(lastPayload[STUDY_SNAPSHOTS_STORAGE_KEY]).toBeUndefined();
    expect(service.getCurrentStudyState().currentSession?.sourceUrl).toBe(TAB_URL);

    const metadataPayload = [...storageSet.mock.calls]
      .map(([payload]) => payload as Record<string, unknown>)
      .reverse()
      .find((payload) => payload[STUDY_STORAGE_KEY])?.[STUDY_STORAGE_KEY];
    const snapshotsPayload = [...storageSet.mock.calls]
      .map(([payload]) => payload as Record<string, unknown>)
      .reverse()
      .find((payload) => payload[STUDY_SNAPSHOTS_STORAGE_KEY])?.[
        STUDY_SNAPSHOTS_STORAGE_KEY
      ];

    vi.resetModules();
    vi.unstubAllGlobals();
    const secondChrome = createChromeMock(metadataPayload, snapshotsPayload);
    const reloadedStore = await import("../src/study/session-store");
    const restored = await reloadedStore.loadStudyState();

    expect(secondChrome.storageGet).toHaveBeenCalledWith([
      STUDY_STORAGE_KEY,
      STUDY_SNAPSHOTS_STORAGE_KEY,
    ]);
    expect(restored.currentSession?.sourceUrl).toBe(TAB_URL);
    expect(restored.currentSnapshot?.url).toBe(TAB_URL);
    expect(Object.keys(restored.snapshotsByChapter)).toHaveLength(2);
  });
});
