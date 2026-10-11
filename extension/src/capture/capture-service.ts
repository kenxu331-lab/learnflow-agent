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

function isContentBlock(value: unknown): value is ContentBlock {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const block = value as Record<string, unknown>;
  return (
    typeof block.id === "string" &&
    typeof block.text === "string" &&
    ["heading", "paragraph", "code", "list"].includes(String(block.type))
  );
}

export function isPageSnapshot(value: unknown): value is PageSnapshot {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const snapshot = value as Record<string, unknown>;
  const extraction = snapshot.extraction as Record<string, unknown> | undefined;
  const stats = snapshot.stats as Record<string, unknown> | undefined;

  return (
    snapshot.schemaVersion === 1 &&
    typeof snapshot.url === "string" &&
    typeof snapshot.title === "string" &&
    typeof snapshot.capturedAt === "string" &&
    Array.isArray(snapshot.blocks) &&
    snapshot.blocks.every(isContentBlock) &&
    extraction !== undefined &&
    ["article", "main", "fallback"].includes(String(extraction.strategy)) &&
    typeof extraction.truncated === "boolean" &&
    Array.isArray(extraction.warnings) &&
    extraction.warnings.every((warning) => typeof warning === "string") &&
    stats !== undefined &&
    typeof stats.characterCount === "number" &&
    typeof stats.codeBlockCount === "number" &&
    typeof stats.blockCount === "number"
  );
}

async function getActiveTab(): Promise<chrome.tabs.Tab | undefined> {
  if (preferredCaptureTabId !== undefined) {
    return chrome.tabs.get(preferredCaptureTabId);
  }

  // lastFocusedWindow is reliable from a service worker; currentWindow has no
  // document window in this context and can select no window unexpectedly.
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tabs[0];
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

export async function captureCurrentPage(): Promise<PageCaptureResponse> {
  let initialTab: chrome.tabs.Tab | undefined;
  try {
    initialTab = await getActiveTab();
  } catch (error) {
    return failure("UNKNOWN_ERROR", `无法读取当前标签页：${errorMessage(error)}`);
  }

  if (!initialTab) {
    logCaptureStage("no-active-tab", undefined);
    return failure("NO_ACTIVE_TAB", "没有找到可采集的当前标签页。");
  }

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

  let currentTab: chrome.tabs.Tab | undefined;
  try {
    currentTab = await getActiveTab();
  } catch (error) {
    return failure("UNKNOWN_ERROR", `无法确认采集页面状态：${errorMessage(error)}`);
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
