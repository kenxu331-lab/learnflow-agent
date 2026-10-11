import "./style.css";

import {
  PAGE_CAPTURE_REQUEST,
  type PageCaptureResponse,
  type PageSnapshot,
} from "../capture/types";
import { LOCAL_INGEST_URL } from "../backend/api-client";
import {
  PAGE_INGEST_REQUEST,
  type BackendClientResult,
} from "../backend/types";

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`LearnFlow capture UI is missing ${selector}.`);
  }
  return element;
}

const captureButton = requiredElement<HTMLButtonElement>("#capture-button");
const captureStatus = requiredElement<HTMLElement>("#capture-status");
const resultPanel = requiredElement<HTMLElement>("#result-panel");
const pageTitle = requiredElement<HTMLElement>("#page-title");
const pageUrl = requiredElement<HTMLElement>("#page-url");
const characterCount = requiredElement<HTMLElement>("#character-count");
const codeBlockCount = requiredElement<HTMLElement>("#code-block-count");
const contentPreview = requiredElement<HTMLElement>("#content-preview");
const warningPanel = requiredElement<HTMLElement>("#warning-panel");
const warningList = requiredElement<HTMLUListElement>("#warning-list");
const errorPanel = requiredElement<HTMLElement>("#error-panel");
const errorMessage = requiredElement<HTMLElement>("#error-message");
const serviceUrl = requiredElement<HTMLInputElement>("#service-url");
const apiToken = requiredElement<HTMLInputElement>("#api-token");
const saveTokenButton = requiredElement<HTMLButtonElement>("#save-token-button");
const sendButton = requiredElement<HTMLButtonElement>("#send-button");
const connectionStatus = requiredElement<HTMLElement>("#connection-status");
const sendStatus = requiredElement<HTMLElement>("#send-status");

let currentSnapshot: PageSnapshot | undefined;
let sending = false;

serviceUrl.value = LOCAL_INGEST_URL;

function renderWarnings(warnings: string[]): void {
  warningList.replaceChildren(
    ...warnings.map((warning) => {
      const item = document.createElement("li");
      item.textContent = warning;
      return item;
    }),
  );
  warningPanel.hidden = warnings.length === 0;
}

function renderSnapshot(snapshot: PageSnapshot): void {
  const preview = snapshot.blocks.map((block) => block.text).join("\n\n");
  currentSnapshot = snapshot;
  errorPanel.hidden = true;
  pageTitle.textContent = snapshot.title;
  pageUrl.textContent = snapshot.url;
  characterCount.textContent = String(snapshot.stats.characterCount);
  codeBlockCount.textContent = String(snapshot.stats.codeBlockCount);
  contentPreview.textContent = preview.slice(0, 2_000) || "没有可预览的正文。";
  renderWarnings(snapshot.extraction.warnings);
  resultPanel.hidden = false;
  sendButton.disabled = false;
}

function renderError(message: string): void {
  errorMessage.textContent = message;
  errorPanel.hidden = false;
  resultPanel.hidden = true;
  warningPanel.hidden = true;
  captureStatus.textContent = "采集失败";
  sendButton.disabled = true;
}

function setBusy(isBusy: boolean): void {
  captureButton.disabled = isBusy;
  captureButton.textContent = isBusy ? "采集中…" : "重新采集当前页面";
  captureStatus.textContent = isBusy ? "正在读取当前页面…" : "等待操作";
}

async function captureCurrentPage(): Promise<void> {
  setBusy(true);
  errorPanel.hidden = true;
  currentSnapshot = undefined;
  sendButton.disabled = true;

  try {
    const response = (await chrome.runtime.sendMessage({
      type: PAGE_CAPTURE_REQUEST,
    })) as PageCaptureResponse | undefined;

    if (!response || !response.ok) {
      renderError(response?.error.message ?? "未收到有效的采集响应，请重试。");
      return;
    }

    renderSnapshot(response.snapshot);
    captureStatus.textContent = "采集完成";
  } catch (error) {
    renderError(
      error instanceof Error ? error.message : "无法连接到扩展后台服务，请重试。",
    );
  } finally {
    captureButton.disabled = false;
    captureButton.textContent = "重新采集当前页面";
  }
}

async function loadStoredToken(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get("localApiToken");
    const token =
      typeof stored === "object" &&
      stored !== null &&
      "localApiToken" in stored &&
      typeof stored.localApiToken === "string"
        ? stored.localApiToken
        : "";
    apiToken.value = token;
    connectionStatus.textContent = token ? "Token 已加载" : "尚未配置 Token";
  } catch {
    connectionStatus.textContent = "无法读取本地 Token";
  }
}

async function saveToken(): Promise<void> {
  const token = apiToken.value.trim();
  if (!token) {
    connectionStatus.textContent = "请输入 Token 后再保存";
    return;
  }

  saveTokenButton.disabled = true;
  try {
    await chrome.storage.local.set({ localApiToken: token });
    connectionStatus.textContent = "Token 已保存";
  } catch {
    connectionStatus.textContent = "Token 保存失败";
  } finally {
    saveTokenButton.disabled = false;
  }
}

async function sendCurrentSnapshot(): Promise<void> {
  if (!currentSnapshot || sending) {
    return;
  }

  sending = true;
  sendButton.disabled = true;
  sendStatus.textContent = "发送中…";

  try {
    const response = (await chrome.runtime.sendMessage({
      type: PAGE_INGEST_REQUEST,
      snapshot: currentSnapshot,
    })) as BackendClientResult | undefined;

    if (!response || !response.ok) {
      sendStatus.textContent = response?.error.message ?? "未收到本地服务响应";
      return;
    }

    sendStatus.textContent = `已验证（${response.response.requestId}）`;
  } catch {
    sendStatus.textContent = "发送失败，请重试";
  } finally {
    sending = false;
    sendButton.disabled = !currentSnapshot;
  }
}

captureButton.addEventListener("click", () => {
  void captureCurrentPage();
});

saveTokenButton.addEventListener("click", () => {
  void saveToken();
});

sendButton.addEventListener("click", () => {
  void sendCurrentSnapshot();
});

void loadStoredToken();
