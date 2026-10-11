import "./style.css";

import {
  PAGE_CAPTURE_REQUEST,
  type PageCaptureResponse,
  type PageSnapshot,
} from "../capture/types";

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
  pageTitle.textContent = snapshot.title;
  pageUrl.textContent = snapshot.url;
  characterCount.textContent = String(snapshot.stats.characterCount);
  codeBlockCount.textContent = String(snapshot.stats.codeBlockCount);
  contentPreview.textContent = preview.slice(0, 2_000) || "没有可预览的正文。";
  renderWarnings(snapshot.extraction.warnings);
  resultPanel.hidden = false;
}

function renderError(message: string): void {
  errorMessage.textContent = message;
  errorPanel.hidden = false;
  resultPanel.hidden = true;
  captureStatus.textContent = "采集失败";
}

function setBusy(isBusy: boolean): void {
  captureButton.disabled = isBusy;
  captureButton.textContent = isBusy ? "采集中…" : "重新采集当前页面";
  captureStatus.textContent = isBusy ? "正在读取当前页面…" : "等待操作";
}

async function captureCurrentPage(): Promise<void> {
  setBusy(true);
  errorPanel.hidden = true;

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

captureButton.addEventListener("click", () => {
  void captureCurrentPage();
});
