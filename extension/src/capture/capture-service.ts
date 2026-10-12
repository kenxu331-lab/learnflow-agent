import { extractPageSnapshot } from "./extractor";
import {
  isPageCaptureRequest,
  type CaptureErrorCode,
  type ContentBlock,
  type PageCaptureResponse,
  type PageSnapshot,
} from "./types";

function failure(code: CaptureErrorCode, message: string): PageCaptureResponse {
  return { ok: false, error: { code, message } };
}

let preferredCaptureTabId: number | undefined;

export function setCaptureTarget(tabId: number | undefined): void {
  preferredCaptureTabId = tabId;
}

export function getCaptureTarget(): number | undefined {
  return preferredCaptureTabId;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function redactDiagnosticText(message: string): string {
  return message
    .replace(
      /\b(?:https?|chrome|edge|about|devtools|chrome-extension):\/\/[^\s"'<>]+/gi,
      "<redacted-url>",
    )
    .slice(0, 500);
}

function getTabUrl(tab: chrome.tabs.Tab): string | undefined {
  return tab.url ?? tab.pendingUrl;
}

function getUrlProtocol(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  try {
    return new URL(value).protocol;
  } catch {
    return undefined;
  }
}

function isSupportedPageUrl(value: string | undefined): boolean {
  return ["http:", "https:"].includes(getUrlProtocol(value) ?? "");
}

function logCaptureStage(
  stage: string,
  tab: chrome.tabs.Tab | undefined,
  details: Record<string, unknown> = {},
): void {
  console.debug("[LearnFlow capture]", stage, {
    tabId: tab?.id ?? null,
    windowId: tab?.windowId ?? null,
    urlAvailable: Boolean(tab && getTabUrl(tab)),
    urlProtocol: tab ? getUrlProtocol(getTabUrl(tab)) ?? null : null,
    ...details,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isContentBlock(value: unknown): value is ContentBlock {
  if (!isRecord(value)) {
    return false;
  }

  const blockType = value.type;
  const level = value.level;
  return (
    typeof value.id === "string" &&
    typeof value.text === "string" &&
    typeof blockType === "string" &&
    ["heading", "paragraph", "code", "list"].includes(blockType) &&
    (!("stableKey" in value) ||
      (typeof value.stableKey === "string" &&
        value.stableKey.trim().length > 0 &&
        value.stableKey.length <= 200)) &&
    (!("level" in value) ||
      (typeof level === "number" &&
        Number.isSafeInteger(level) &&
        level >= 1 &&
        level <= 6)) &&
    (!("language" in value) || typeof value.language === "string")
  );
}

export function isPageSnapshot(value: unknown): value is PageSnapshot {
  if (!isRecord(value)) {
    return false;
  }

  if (
    value.schemaVersion !== 1 ||
    typeof value.url !== "string" ||
    typeof value.title !== "string" ||
    typeof value.capturedAt !== "string" ||
    Number.isNaN(Date.parse(value.capturedAt)) ||
    !Array.isArray(value.blocks) ||
    !isRecord(value.extraction) ||
    !isRecord(value.stats)
  ) {
    return false;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(value.url);
  } catch {
    return false;
  }

  const contentBlocks = value.blocks.filter(isContentBlock);
  if (contentBlocks.length !== value.blocks.length) {
    return false;
  }

  const extraction = value.extraction;
  const stats = value.stats;
  const expectedCharacterCount = contentBlocks.reduce(
    (total, block) => total + block.text.length,
    0,
  );
  const codeBlockCount = contentBlocks.filter(
    (block) => block.type === "code",
  ).length;
  const characterCount = stats.characterCount;
  const statsCodeBlockCount = stats.codeBlockCount;
  const blockCount = stats.blockCount;

  return (
    (parsedUrl.protocol === "http:" || parsedUrl.protocol === "https:") &&
    typeof extraction.strategy === "string" &&
    ["article", "main", "fallback"].includes(extraction.strategy) &&
    typeof extraction.truncated === "boolean" &&
    Array.isArray(extraction.warnings) &&
    extraction.warnings.every((warning) => typeof warning === "string") &&
    typeof characterCount === "number" &&
    Number.isSafeInteger(characterCount) &&
    characterCount >= 0 &&
    typeof statsCodeBlockCount === "number" &&
    Number.isSafeInteger(statsCodeBlockCount) &&
    statsCodeBlockCount >= 0 &&
    typeof blockCount === "number" &&
    Number.isSafeInteger(blockCount) &&
    blockCount >= 0 &&
    characterCount === expectedCharacterCount &&
    statsCodeBlockCount === codeBlockCount &&
    blockCount === contentBlocks.length
  );
}

interface TabLookupResult {
  tab?: chrome.tabs.Tab;
  preferredTargetClosed: boolean;
}

async function getActiveTab(): Promise<TabLookupResult> {
  if (preferredCaptureTabId !== undefined) {
    try {
      return {
        tab: await chrome.tabs.get(preferredCaptureTabId),
        preferredTargetClosed: false,
      };
    } catch {
      return { preferredTargetClosed: true };
    }
  }

  // lastFocusedWindow is reliable from a service worker; currentWindow has no
  // document window in this context and can select no window unexpectedly.
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return { tab: tabs[0], preferredTargetClosed: false };
}

function isSameTabPage(
  initialTab: chrome.tabs.Tab,
  currentTab: chrome.tabs.Tab | undefined,
  snapshotUrl?: string,
): boolean {
  if (currentTab?.id !== initialTab.id) {
    return false;
  }

  const initialUrl = getTabUrl(initialTab);
  const currentUrl = currentTab ? getTabUrl(currentTab) : undefined;

  if (initialUrl && currentUrl) {
    return currentUrl === initialUrl;
  }

  if (currentUrl && snapshotUrl) {
    return currentUrl === snapshotUrl;
  }

  // URL visibility can be limited until activeTab is granted. The injected
  // snapshot is still checked below; when both tab URLs are absent, Chrome
  // cannot provide a stronger post-capture URL comparison here.
  return true;
}

function classifyInjectionError(
  error: unknown,
  tab: chrome.tabs.Tab,
): PageCaptureResponse {
  const message = errorMessage(error);
  const knownUrl = getTabUrl(tab);

  if (/chrome:\/\/|edge:\/\/|about:|devtools:|chrome-extension:/i.test(message)) {
    return failure(
      "UNSUPPORTED_URL",
      "当前页面不受支持，只能采集 HTTP 或 HTTPS 页面。",
    );
  }

  if (
    /cannot access|permission|denied|not allowed|inaccessible|extensions gallery/i.test(
      message,
    )
  ) {
    logCaptureStage("injection-permission-denied", tab);
    return failure(
      "PERMISSION_DENIED",
      "当前页面未授予临时访问权限，请通过扩展工具栏图标打开侧边栏后重试。",
    );
  }

  if (!knownUrl) {
    logCaptureStage("injection-url-unavailable", tab);
    return failure(
      "URL_UNAVAILABLE",
      "无法获取当前标签页 URL，且采集脚本未执行；请通过扩展工具栏图标打开侧边栏后重试。",
    );
  }

  logCaptureStage("injection-failed", tab);
  return failure("INJECTION_FAILED", `页面采集脚本执行失败：${message}`);
}

async function captureFromInitialTab(
  initialTab: chrome.tabs.Tab,
  verifyActiveTarget: boolean,
  shouldContinue: () => boolean | Promise<boolean> = () => true,
): Promise<PageCaptureResponse> {
  logCaptureStage("active-tab-observed", initialTab);

  if (!Number.isInteger(initialTab.id)) {
    return failure("NO_ACTIVE_TAB", "当前标签页缺少有效的 tabId。");
  }

  const initialUrl = getTabUrl(initialTab);
  if (initialUrl && !isSupportedPageUrl(initialUrl)) {
    logCaptureStage("unsupported-tab-url", initialTab);
    return failure(
      "UNSUPPORTED_URL",
      "当前页面不受支持，只能采集 HTTP 或 HTTPS 页面。",
    );
  }

  if (!initialUrl) {
    logCaptureStage("tab-url-unavailable", initialTab);
  }

  if (!(await shouldContinue())) {
    return failure("STALE_TAB", "采集任务已取消，请重新采集当前页面。");
  }

  let injectionResults: chrome.scripting.InjectionResult<PageSnapshot>[];
  try {
    logCaptureStage("injection-start", initialTab);
    injectionResults = await chrome.scripting.executeScript({
      target: { tabId: initialTab.id as number },
      func: extractPageSnapshot,
    });
  } catch (error) {
    logCaptureStage("injection-error", initialTab, {
      originalError: redactDiagnosticText(errorMessage(error)),
    });
    return classifyInjectionError(error, initialTab);
  }

  if (!(await shouldContinue())) {
    return failure("STALE_TAB", "采集任务已取消，请重新采集当前页面。");
  }

  let currentTab: chrome.tabs.Tab | undefined;
  try {
    if (verifyActiveTarget) {
      const currentLookup = await getActiveTab();
      if (currentLookup.preferredTargetClosed) {
        logCaptureStage("preferred-tab-closed-during-capture", initialTab);
        return failure("STALE_TAB", "采集期间目标标签页已关闭，请重新采集。");
      }
      currentTab = currentLookup.tab;
    } else {
      currentTab = await chrome.tabs.get(initialTab.id as number);
    }
  } catch (error) {
    logCaptureStage("tab-closed-during-capture", initialTab, {
      originalError: redactDiagnosticText(errorMessage(error)),
    });
    return failure("STALE_TAB", "采集期间目标标签页已关闭，请重新采集。");
  }

  if (!(await shouldContinue())) {
    return failure("STALE_TAB", "采集任务已取消，请重新采集当前页面。");
  }

  const snapshot = injectionResults[0]?.result;
  if (!isPageSnapshot(snapshot)) {
    logCaptureStage("invalid-result", initialTab);
    return failure("INVALID_RESULT", "页面采集结果格式无效，请重试。");
  }

  if (!isSupportedPageUrl(snapshot.url)) {
    logCaptureStage("injected-url-unsupported", initialTab, {
      injectedUrlProtocol: getUrlProtocol(snapshot.url) ?? null,
    });
    return failure(
      "UNSUPPORTED_URL",
      "当前页面不受支持，只能采集 HTTP 或 HTTPS 页面。",
    );
  }

  if (!isSameTabPage(initialTab, currentTab, snapshot.url)) {
    logCaptureStage("stale-tab", initialTab, {
      currentUrlProtocol: currentTab
        ? getUrlProtocol(getTabUrl(currentTab)) ?? null
        : null,
    });
    return failure("STALE_TAB", "采集期间当前页面发生变化，请重新采集。");
  }

  if (initialUrl && snapshot.url !== initialUrl) {
    logCaptureStage("snapshot-url-mismatch", initialTab, {
      snapshotUrlProtocol: getUrlProtocol(snapshot.url) ?? null,
    });
    return failure("STALE_TAB", "采集结果与当前页面不一致，请重新采集。");
  }

  if (snapshot.stats.characterCount === 0 || snapshot.blocks.length === 0) {
    logCaptureStage("empty-content", initialTab);
    return failure("EMPTY_CONTENT", "当前页面没有提取到足够的正文内容。");
  }

  logCaptureStage("capture-success", initialTab, {
    blockCount: snapshot.stats.blockCount,
    characterCount: snapshot.stats.characterCount,
  });
  return { ok: true, snapshot };
}

export async function captureCurrentPage(): Promise<PageCaptureResponse> {
  let initialLookup: TabLookupResult;
  try {
    initialLookup = await getActiveTab();
  } catch (error) {
    return failure("UNKNOWN_ERROR", `无法读取当前标签页：${errorMessage(error)}`);
  }

  if (initialLookup.preferredTargetClosed) {
    logCaptureStage("preferred-tab-closed", undefined, {
      preferredTabId: preferredCaptureTabId,
    });
    return failure("STALE_TAB", "目标标签页已关闭，请重新点击扩展工具栏图标。");
  }

  const initialTab = initialLookup.tab;
  if (!initialTab) {
    logCaptureStage("no-active-tab", undefined);
    return failure("NO_ACTIVE_TAB", "没有找到可采集的当前标签页。");
  }

  return captureFromInitialTab(initialTab, true);
}

export async function captureTab(
  tabId: number,
  options: { shouldContinue?: () => boolean | Promise<boolean> } = {},
): Promise<PageCaptureResponse> {
  if (!Number.isInteger(tabId) || tabId < 0) {
    return failure("NO_ACTIVE_TAB", "当前标签页缺少有效的 tabId。");
  }

  let initialTab: chrome.tabs.Tab;
  try {
    initialTab = await chrome.tabs.get(tabId);
  } catch {
    return failure("STALE_TAB", "目标标签页已关闭，请重新采集。");
  }

  if (options.shouldContinue && !(await options.shouldContinue())) {
    return failure("STALE_TAB", "采集任务已取消，请重新采集当前页面。");
  }

  let verifiedTab: chrome.tabs.Tab;
  try {
    verifiedTab = await chrome.tabs.get(tabId);
  } catch {
    return failure("STALE_TAB", "目标标签页已关闭，请重新采集。");
  }

  if (options.shouldContinue && !(await options.shouldContinue())) {
    return failure("STALE_TAB", "采集任务已取消，请重新采集当前页面。");
  }

  const initialUrl = getTabUrl(initialTab);
  const verifiedUrl = getTabUrl(verifiedTab);
  if (initialUrl && verifiedUrl && initialUrl !== verifiedUrl) {
    return failure("STALE_TAB", "采集前页面已经变化，请重新采集。");
  }

  return captureFromInitialTab(verifiedTab, false, options.shouldContinue);
}

export function registerCaptureMessageHandler(): void {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!isPageCaptureRequest(message)) {
      return false;
    }

    void captureCurrentPage()
      .then(sendResponse)
      .catch((error: unknown) => {
        sendResponse(
          failure("UNKNOWN_ERROR", `页面采集失败：${errorMessage(error)}`),
        );
      });

    return true;
  });
}
