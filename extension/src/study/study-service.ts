import {
  captureTab,
  getCaptureTarget,
  isPageSnapshot,
  setCaptureTarget,
} from "../capture/capture-service";
import type { PageSnapshot } from "../capture/types";
import {
  createDefaultStudyState,
  loadStudyState,
  saveStudyState,
} from "./session-store";
import {
  STUDY_ENABLE_REQUEST,
  STUDY_GET_STATE_REQUEST,
  STUDY_GET_TAB_CONTEXT_REQUEST,
  STUDY_MANUAL_SNAPSHOT_REQUEST,
  STUDY_PAUSE_REQUEST,
  STUDY_REVOKE_REQUEST,
  STUDY_SITE_HOST_PERMISSION,
  STUDY_SITE_ORIGIN,
  STUDY_STATE_CHANGED,
  isStudyRequest,
  type StudyActionResult,
  type StudyFailure,
  type StudySession,
  type StudyState,
  type StudyStateChangedMessage,
  type StudyTabContext,
  type StudyTabContextResult,
} from "./types";

const RETRY_DELAYS_MS = [350, 900];
const MAX_SAVED_CHAPTERS = 20;

let studyState = createDefaultStudyState();
let stateReady: Promise<void> | undefined;
let registered = false;
const captureGenerations = new Map<number, number>();
const captureTimers = new Map<number, ReturnType<typeof setTimeout>>();
const retryCounts = new Map<number, number>();

function failure(
  code: StudyFailure["error"]["code"],
  message: string,
): StudyFailure {
  return { ok: false, error: { code, message } };
}

function getTabUrl(tab: chrome.tabs.Tab): string | undefined {
  return tab.url ?? tab.pendingUrl;
}

export function isSupportedStudyUrl(value: string | undefined): boolean {
  if (!value) {
    return false;
  }

  try {
    const url = new URL(value);
    return url.origin === STUDY_SITE_ORIGIN && url.protocol === "https:";
  } catch {
    return false;
  }
}

export function normalizeChapterUrl(value: string): string {
  const url = new URL(value);
  url.hash = "";
  if (url.pathname.length > 1) {
    url.pathname = url.pathname.replace(/\/+$/, "");
  }
  return url.toString();
}

function hashText(value: string): string {
  let first = 2166136261;
  let second = 16777619;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first ^= code;
    first = Math.imul(first, 16777619);
    second ^= code + index;
    second = Math.imul(second, 2166136261);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(
    second >>> 0
  ).toString(16).padStart(8, "0")}`;
}

export function deriveChapterId(sourceUrl: string): string {
  return `chapter-${hashText(normalizeChapterUrl(sourceUrl))}`;
}

export function computeSnapshotHash(snapshot: PageSnapshot): string {
  const canonical = [
    normalizeChapterUrl(snapshot.url),
    snapshot.title,
    ...snapshot.blocks.map((block) =>
      [block.type, block.level ?? "", block.language ?? "", block.text].join(
        "\u0000",
      ),
    ),
  ].join("\u0001");
  return `content-${hashText(canonical)}`;
}

async function ensureStateReady(): Promise<void> {
  if (!stateReady) {
    stateReady = loadStudyState().then((loaded) => {
      studyState = loaded;
    });
  }
  await stateReady;
}

function broadcastState(): void {
  if (typeof chrome.runtime?.sendMessage !== "function") {
    return;
  }

  const message: StudyStateChangedMessage = {
    type: STUDY_STATE_CHANGED,
    state: studyState,
  };
  try {
    const response = chrome.runtime.sendMessage(message);
    if (response && typeof response.catch === "function") {
      void response.catch(() => undefined);
    }
  } catch {
    // No side panel may be open while the service worker broadcasts state.
  }
}

async function persistState(
  options: { persistSnapshots?: boolean } = {},
): Promise<boolean> {
  const saved = await saveStudyState(studyState, options);
  if (!saved) {
    studyState = {
      ...studyState,
      status: studyState.enabled ? "CAPTURE_FAILED" : "DISABLED",
      lastError: "学习状态无法保存到本地存储。",
    };
  }
  broadcastState();
  return saved;
}

async function getTargetTab(): Promise<chrome.tabs.Tab | undefined> {
  const targetId = getCaptureTarget() ?? studyState.activeTabId;
  if (Number.isInteger(targetId)) {
    try {
      return await chrome.tabs.get(targetId as number);
    } catch {
      return undefined;
    }
  }

  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tabs[0];
  } catch {
    return undefined;
  }
}

async function hasSitePermission(): Promise<boolean> {
  if (typeof chrome.permissions?.contains !== "function") {
    return false;
  }
  try {
    return await chrome.permissions.contains({
      origins: [STUDY_SITE_HOST_PERMISSION],
    });
  } catch {
    return false;
  }
}

export async function getStudyTabContext(): Promise<StudyTabContext> {
  await ensureStateReady();
  const tab = await getTargetTab();
  const url = tab ? getTabUrl(tab) ?? null : null;
  return {
    tabId: typeof tab?.id === "number" ? tab.id : null,
    url,
    supported: isSupportedStudyUrl(url ?? undefined),
    hasPermission: await hasSitePermission(),
  };
}

function nextGeneration(tabId: number): number {
  const generation = (captureGenerations.get(tabId) ?? 0) + 1;
  captureGenerations.set(tabId, generation);
  const timer = captureTimers.get(tabId);
  if (timer !== undefined) {
    clearTimeout(timer);
    captureTimers.delete(tabId);
  }
  return generation;
}

function isCurrentGeneration(tabId: number, generation: number): boolean {
  return captureGenerations.get(tabId) === generation;
}

function scheduleCapture(tabId: number, delayMs = 250): void {
  const generation = nextGeneration(tabId);
  const timer = setTimeout(() => {
    captureTimers.delete(tabId);
    void runAutomaticCapture(tabId, generation);
  }, delayMs);
  captureTimers.set(tabId, timer);
}

function trimSavedChapters(): void {
  const chapterIds = Object.keys(studyState.sessionsByChapter);
  if (chapterIds.length <= MAX_SAVED_CHAPTERS) {
    return;
  }

  const keep = new Set(
    chapterIds
      .sort(
        (left, right) =>
          Date.parse(studyState.sessionsByChapter[right].updatedAt) -
          Date.parse(studyState.sessionsByChapter[left].updatedAt),
      )
      .slice(0, MAX_SAVED_CHAPTERS),
  );
  for (const chapterId of chapterIds) {
    if (!keep.has(chapterId)) {
      delete studyState.sessionsByChapter[chapterId];
      delete studyState.snapshotsByChapter[chapterId];
    }
  }
}

async function recordSnapshot(tabId: number, snapshot: PageSnapshot): Promise<void> {
  const chapterId = deriveChapterId(snapshot.url);
  const snapshotHash = computeSnapshotHash(snapshot);
  const previous = studyState.sessionsByChapter[chapterId];
  const now = new Date().toISOString();

  if (previous?.snapshotHash === snapshotHash) {
    const cachedSnapshot = studyState.snapshotsByChapter[chapterId] ?? snapshot;
    const currentSession = {
      ...previous,
      tabId,
      status: "SOURCE_READY" as const,
      lastError: undefined,
    };
    const pointerChanged =
      studyState.currentSession?.chapterId !== chapterId ||
      studyState.currentSession?.sessionId !== currentSession.sessionId ||
      studyState.currentSession?.tabId !== tabId ||
      studyState.currentSession?.status !== "SOURCE_READY" ||
      studyState.currentSnapshot !== cachedSnapshot ||
      studyState.status !== "SOURCE_READY" ||
      studyState.activeTabId !== tabId ||
      studyState.lastError !== undefined;
    studyState = {
      ...studyState,
      activeTabId: tabId,
      status: "SOURCE_READY",
      lastError: undefined,
      currentSession,
      currentSnapshot: cachedSnapshot,
      sessionsByChapter: pointerChanged
        ? { ...studyState.sessionsByChapter, [chapterId]: currentSession }
        : studyState.sessionsByChapter,
    };
    if (pointerChanged) {
      await persistState({ persistSnapshots: false });
    } else {
      broadcastState();
    }
    return;
  }

  const session: StudySession = {
    sessionId: previous?.sessionId ?? `session-${hashText(chapterId)}`,
    tabId,
    chapterId,
    sourceUrl: snapshot.url,
    pageTitle: snapshot.title,
    snapshotHash,
    capturedAt: snapshot.capturedAt,
    updatedAt: now,
    status: "SOURCE_READY",
  };

  studyState = {
    ...studyState,
    activeTabId: tabId,
    status: "SOURCE_READY",
    lastError: undefined,
    currentSession: session,
    currentSnapshot: snapshot,
    sessionsByChapter: { ...studyState.sessionsByChapter, [chapterId]: session },
    snapshotsByChapter: {
      ...studyState.snapshotsByChapter,
      [chapterId]: snapshot,
    },
  };
  trimSavedChapters();
  await persistState();
}

async function prepareForNavigationCapture(
  tabId: number,
  url: string | undefined,
): Promise<void> {
  const sameCurrentPage =
    url !== undefined &&
    studyState.currentSession !== undefined &&
    studyState.currentSession.tabId === tabId &&
    studyState.currentSession.sourceUrl === url;
  if (sameCurrentPage && studyState.currentSnapshot) {
    return;
  }

  studyState = {
    ...studyState,
    activeTabId: tabId,
    status: "CAPTURING",
    currentSession: undefined,
    currentSnapshot: undefined,
    lastError: undefined,
  };
  await persistState({ persistSnapshots: false });
}

function isRetryableCaptureFailure(code: string): boolean {
  return [
    "INJECTION_FAILED",
    "URL_UNAVAILABLE",
    "EMPTY_CONTENT",
    "STALE_TAB",
  ].includes(code);
}

async function markCaptureFailure(message: string): Promise<void> {
  studyState = {
    ...studyState,
    status: "CAPTURE_FAILED",
    lastError: message,
    currentSession: studyState.currentSession
      ? { ...studyState.currentSession, status: "CAPTURE_FAILED", lastError: message }
      : undefined,
  };
  await persistState();
}

async function runAutomaticCapture(
  tabId: number,
  generation: number,
): Promise<void> {
  await ensureStateReady();
  if (
    !studyState.enabled ||
    studyState.activeTabId !== tabId ||
    !isCurrentGeneration(tabId, generation)
  ) {
    return;
  }

  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    if (isCurrentGeneration(tabId, generation)) {
      await markCaptureFailure("目标标签页已关闭。");
    }
    return;
  }

  if (
    !studyState.enabled ||
    studyState.activeTabId !== tabId ||
    !isCurrentGeneration(tabId, generation)
  ) {
    return;
  }

  const url = getTabUrl(tab);
  if (!isSupportedStudyUrl(url)) {
    await prepareForNavigationCapture(tabId, undefined);
    await markCaptureFailure("当前页面不在已授权的 FastAPI 教程站点内。");
    return;
  }
  if (!(await hasSitePermission())) {
    if (!isCurrentGeneration(tabId, generation) || !studyState.enabled) {
      return;
    }
    await prepareForNavigationCapture(tabId, undefined);
    await markCaptureFailure("站点访问权限已撤销，自动学习未读取当前页面。");
    return;
  }

  if (
    !isCurrentGeneration(tabId, generation) ||
    !studyState.enabled ||
    studyState.activeTabId !== tabId
  ) {
    return;
  }

  let verifiedTab: chrome.tabs.Tab;
  try {
    verifiedTab = await chrome.tabs.get(tabId);
  } catch {
    return;
  }
  const verifiedUrl = getTabUrl(verifiedTab);
  if (
    verifiedUrl !== url ||
    !isSupportedStudyUrl(verifiedUrl) ||
    !isCurrentGeneration(tabId, generation) ||
    !studyState.enabled ||
    studyState.activeTabId !== tabId
  ) {
    if (isCurrentGeneration(tabId, generation) && studyState.enabled) {
      scheduleCapture(tabId, 0);
    }
    return;
  }

  await prepareForNavigationCapture(tabId, verifiedUrl);
  if (
    !isCurrentGeneration(tabId, generation) ||
    !studyState.enabled ||
    studyState.activeTabId !== tabId
  ) {
    return;
  }

  studyState = { ...studyState, status: "CAPTURING", lastError: undefined };
  broadcastState();

  const response = await captureTab(tabId, {
    shouldContinue: async () => {
      if (
        !isCurrentGeneration(tabId, generation) ||
        !studyState.enabled ||
        studyState.activeTabId !== tabId
      ) {
        return false;
      }
      if (!(await hasSitePermission())) {
        return false;
      }
      try {
        const currentTab = await chrome.tabs.get(tabId);
        return (
          isCurrentGeneration(tabId, generation) &&
          studyState.enabled &&
          studyState.activeTabId === tabId &&
          getTabUrl(currentTab) === verifiedUrl
        );
      } catch {
        return false;
      }
    },
  });
  if (
    !isCurrentGeneration(tabId, generation) ||
    !studyState.enabled ||
    studyState.activeTabId !== tabId
  ) {
    return;
  }

  if (!response.ok) {
    const retries = retryCounts.get(tabId) ?? 0;
    if (retries < RETRY_DELAYS_MS.length && isRetryableCaptureFailure(response.error.code)) {
      retryCounts.set(tabId, retries + 1);
      scheduleCapture(tabId, RETRY_DELAYS_MS[retries]);
      return;
    }
    retryCounts.delete(tabId);
    await markCaptureFailure(response.error.message);
    return;
  }

  retryCounts.delete(tabId);
  await recordSnapshot(tabId, response.snapshot);
}

async function enableStudyMode(): Promise<StudyActionResult> {
  await ensureStateReady();
  const tab = await getTargetTab();
  if (!tab || !Number.isInteger(tab.id)) {
    return failure("NO_TARGET_TAB", "没有找到要启用学习模式的标签页。");
  }

  const url = getTabUrl(tab);
  if (!url) {
    return failure("URL_UNAVAILABLE", "无法获取当前标签页 URL，请重新打开侧边栏。");
  }
  if (!isSupportedStudyUrl(url)) {
    return failure(
      "UNSUPPORTED_SITE",
      "当前版本只支持 fastapi.tiangolo.com 教程站点。",
    );
  }
  if (!(await hasSitePermission())) {
    return failure(
      "PERMISSION_REQUIRED",
      "请先允许 LearnFlow 访问当前教程站点。",
    );
  }

  const tabId = tab.id as number;
  setCaptureTarget(tabId);
  studyState = {
    ...studyState,
    enabled: true,
    status: "AUTHORIZED",
    authorizedOrigin: STUDY_SITE_ORIGIN,
    activeTabId: tabId,
    lastError: undefined,
  };
  await persistState();
  scheduleCapture(tabId, 50);
  return { ok: true, value: studyState };
}

async function pauseStudyMode(): Promise<StudyActionResult> {
  await ensureStateReady();
  studyState = {
    ...studyState,
    enabled: false,
    status: "DISABLED",
    lastError: undefined,
    currentSession: studyState.currentSession
      ? { ...studyState.currentSession, status: "DISABLED" }
      : undefined,
  };
  const targetId = studyState.activeTabId;
  if (targetId !== undefined) {
    nextGeneration(targetId);
  }
  await persistState();
  return { ok: true, value: studyState };
}

async function revokeStudyMode(): Promise<StudyActionResult> {
  const result = await pauseStudyMode();
  if (!result.ok) {
    return result;
  }
  studyState = {
    ...studyState,
    authorizedOrigin: undefined,
    activeTabId: undefined,
  };
  setCaptureTarget(undefined);
  await persistState();
  return { ok: true, value: studyState };
}

async function handleNavigationEvent(url: string, tabId: number): Promise<void> {
  await ensureStateReady();
  if (!studyState.enabled || !Number.isInteger(tabId) || tabId !== studyState.activeTabId) {
    return;
  }
  if (!isSupportedStudyUrl(url)) {
    await prepareForNavigationCapture(tabId, undefined);
    await markCaptureFailure("当前页面已离开已授权的 FastAPI 教程站点。");
    return;
  }
  if (!(await hasSitePermission())) {
    await prepareForNavigationCapture(tabId, undefined);
    await markCaptureFailure("站点访问权限已撤销，自动学习未读取当前页面。");
    return;
  }

  let currentTab: chrome.tabs.Tab;
  try {
    currentTab = await chrome.tabs.get(tabId);
  } catch {
    return;
  }
  if (getTabUrl(currentTab) !== url) {
    return;
  }

  if (
    studyState.currentSession?.tabId === tabId &&
    studyState.currentSession.sourceUrl === url &&
    studyState.currentSnapshot &&
    studyState.status === "SOURCE_READY"
  ) {
    return;
  }

  await prepareForNavigationCapture(tabId, url);
  if (studyState.enabled && studyState.activeTabId === tabId) {
    scheduleCapture(tabId);
  }
}

async function handleTabUpdated(
  tabId: number,
  changeInfo: chrome.tabs.TabChangeInfo,
  tab: chrome.tabs.Tab,
): Promise<void> {
  await ensureStateReady();
  if (!studyState.enabled || studyState.activeTabId !== tabId) {
    return;
  }

  const url = getTabUrl(tab);
  if (changeInfo.url && !isSupportedStudyUrl(changeInfo.url)) {
    await handleNavigationEvent(changeInfo.url, tabId);
    return;
  }
  if (url && isSupportedStudyUrl(url)) {
    if (changeInfo.status === "complete" || changeInfo.url) {
      await handleNavigationEvent(url, tabId);
    }
  }
}

async function handleTabActivated(tabId: number): Promise<void> {
  await ensureStateReady();
  if (!studyState.enabled) {
    return;
  }

  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return;
  }
  const url = getTabUrl(tab);
  setCaptureTarget(tabId);
  if (!isSupportedStudyUrl(url) || !(await hasSitePermission())) {
    await prepareForNavigationCapture(tabId, undefined);
    await markCaptureFailure("当前标签页未授权，自动学习已暂停本页采集。");
    return;
  }

  studyState = {
    ...studyState,
    activeTabId: tabId,
    status: "AUTHORIZED",
    lastError: undefined,
  };
  await persistState();
  await handleNavigationEvent(url as string, tabId);
}

async function handleTabRemoved(tabId: number): Promise<void> {
  await ensureStateReady();
  if (studyState.activeTabId !== tabId) {
    return;
  }
  nextGeneration(tabId);
  await markCaptureFailure("当前学习标签页已关闭，请重新选择教程页面。");
  studyState = { ...studyState, activeTabId: undefined };
  await persistState();
}

async function recordManualSnapshot(snapshot: PageSnapshot): Promise<void> {
  await ensureStateReady();
  if (!studyState.enabled || !isPageSnapshot(snapshot)) {
    return;
  }

  const tabId = studyState.activeTabId;
  if (tabId === undefined || !isSupportedStudyUrl(snapshot.url)) {
    return;
  }
  if (!(await hasSitePermission())) {
    return;
  }

  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return;
  }
  if (getTabUrl(tab) !== snapshot.url) {
    return;
  }
  await recordSnapshot(tabId, snapshot);
}

export async function handleStudyRequest(
  message: unknown,
  _sender: chrome.runtime.MessageSender = {},
): Promise<StudyActionResult | StudyTabContextResult | StudyStateChangedMessage> {
  void _sender;
  if (!isStudyRequest(message)) {
    return {
      type: STUDY_STATE_CHANGED,
      state: studyState,
    };
  }

  switch (message.type) {
    case STUDY_GET_STATE_REQUEST:
      await ensureStateReady();
      return { type: STUDY_STATE_CHANGED, state: studyState };
    case STUDY_GET_TAB_CONTEXT_REQUEST:
      return { ok: true, value: await getStudyTabContext() };
    case STUDY_ENABLE_REQUEST:
      return enableStudyMode();
    case STUDY_PAUSE_REQUEST:
      return pauseStudyMode();
    case STUDY_REVOKE_REQUEST:
      return revokeStudyMode();
    case STUDY_MANUAL_SNAPSHOT_REQUEST:
      await recordManualSnapshot(message.snapshot);
      return { type: STUDY_STATE_CHANGED, state: studyState };
  }
}

export function getCurrentStudyState(): StudyState {
  return studyState;
}

export function registerStudyService(): void {
  if (registered) {
    return;
  }
  registered = true;

  void ensureStateReady().then(() => {
    if (studyState.enabled && studyState.activeTabId !== undefined) {
      scheduleCapture(studyState.activeTabId, 100);
    }
  });

  chrome.tabs?.onUpdated?.addListener((tabId, changeInfo, tab) => {
    void handleTabUpdated(tabId, changeInfo, tab);
  });
  chrome.tabs?.onActivated?.addListener(({ tabId }) => {
    void handleTabActivated(tabId);
  });
  chrome.tabs?.onRemoved?.addListener((tabId) => {
    void handleTabRemoved(tabId);
  });
  chrome.webNavigation?.onHistoryStateUpdated?.addListener((details) => {
    if (details.frameId !== 0) {
      return;
    }
    void handleNavigationEvent(details.url, details.tabId);
  });
  chrome.webNavigation?.onReferenceFragmentUpdated?.addListener((details) => {
    if (details.frameId !== 0) {
      return;
    }
    void handleNavigationEvent(details.url, details.tabId);
  });
  chrome.runtime?.onMessage?.addListener((message, sender, sendResponse) => {
    if (!isStudyRequest(message)) {
      return false;
    }
    void handleStudyRequest(message, sender)
      .then(sendResponse)
      .catch(() => sendResponse(failure("STORAGE_ERROR", "学习状态处理失败，请重试。")));
    return true;
  });
}
