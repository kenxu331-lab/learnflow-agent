import "./style.css";

import {
  PAGE_CAPTURE_REQUEST,
  type PageCaptureResponse,
  type PageSnapshot,
} from "../capture/types";
import { LOCAL_INGEST_URL } from "../backend/api-client";
import { ensureTrustedStorageAccess } from "../backend/storage";
import {
  NOTE_COMMIT_REQUEST,
  NOTE_PREVIEW_REQUEST,
  PAGE_INGEST_REQUEST,
  type BackendClientResult,
  type NoteClientResult,
} from "../backend/types";

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`LearnFlow capture UI is missing ${selector}.`);
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
const selectionPanel = requiredElement<HTMLElement>("#selection-panel");
const selectionCount = requiredElement<HTMLElement>("#selection-count");
const blockList = requiredElement<HTMLElement>("#block-list");
const personalNote = requiredElement<HTMLTextAreaElement>("#personal-note");
const previewNoteButton = requiredElement<HTMLButtonElement>("#preview-note-button");
const notePreviewPanel = requiredElement<HTMLElement>("#note-preview-panel");
const noteAction = requiredElement<HTMLElement>("#note-action");
const notePath = requiredElement<HTMLElement>("#note-path");
const markdownPreview = requiredElement<HTMLElement>("#markdown-preview");
const markdownDiff = requiredElement<HTMLElement>("#markdown-diff");
const commitNoteButton = requiredElement<HTMLButtonElement>("#commit-note-button");
const noteStatus = requiredElement<HTMLElement>("#note-status");

let currentSnapshot: PageSnapshot | undefined;
let sending = false;
let activeProposalId: string | undefined;
let selectedBlockIds = new Set<string>();
let notePreviewBusy = false;
let noteStateGeneration = 0;

serviceUrl.value = LOCAL_INGEST_URL;

function invalidateNoteProposal(status = "需要重新生成预览"): void {
  noteStateGeneration += 1;
  activeProposalId = undefined;
  notePreviewPanel.hidden = true;
  commitNoteButton.disabled = true;
  noteStatus.textContent = status;
}

function revealNotePreviewPanel(): void {
  notePreviewPanel.hidden = false;
  notePreviewPanel.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
}

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

function updateSelectionState(): void {
  selectionCount.textContent = `已选择 ${selectedBlockIds.size} 个内容块`;
  previewNoteButton.disabled = selectedBlockIds.size === 0 || notePreviewBusy;
  invalidateNoteProposal();
}

function renderBlockList(snapshot: PageSnapshot): void {
  blockList.replaceChildren(
    ...snapshot.blocks.map((block) => {
      const label = document.createElement("label");
      label.className = "block-option";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.value = block.id;
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selectedBlockIds.add(block.id);
        else selectedBlockIds.delete(block.id);
        updateSelectionState();
      });
      const summary = document.createElement("span");
      summary.className = "block-summary";
      summary.textContent = `[${block.type}] ${block.text.slice(0, 180)}`;
      label.append(checkbox, summary);
      return label;
    }),
  );
  selectionCount.textContent = "已选择 0 个内容块";
  previewNoteButton.disabled = true;
}

function renderSnapshot(snapshot: PageSnapshot): void {
  const preview = snapshot.blocks.map((block) => block.text).join("\n\n");
  currentSnapshot = snapshot;
  selectedBlockIds = new Set();
  activeProposalId = undefined;
  errorPanel.hidden = true;
  pageTitle.textContent = snapshot.title;
  pageUrl.textContent = snapshot.url;
  characterCount.textContent = String(snapshot.stats.characterCount);
  codeBlockCount.textContent = String(snapshot.stats.codeBlockCount);
  contentPreview.textContent = preview.slice(0, 2_000) || "没有可预览的正文。";
  renderWarnings(snapshot.extraction.warnings);
  resultPanel.hidden = false;
  sendButton.disabled = false;
  selectionPanel.hidden = false;
  renderBlockList(snapshot);
  notePreviewPanel.hidden = true;
  commitNoteButton.disabled = true;
  noteStatus.textContent = "需要先生成预览";
}

function renderError(message: string): void {
  errorMessage.textContent = message;
  errorPanel.hidden = false;
  resultPanel.hidden = true;
  selectionPanel.hidden = true;
  notePreviewPanel.hidden = true;
  warningPanel.hidden = true;
  captureStatus.textContent = "采集失败";
  sendButton.disabled = true;
  previewNoteButton.disabled = true;
  commitNoteButton.disabled = true;
}

function setBusy(isBusy: boolean): void {
  captureButton.disabled = isBusy;
  captureButton.textContent = isBusy ? "采集中…" : "重新采集当前页面";
  captureStatus.textContent = isBusy ? "正在读取当前页面…" : "等待操作";
}

async function captureCurrentPage(): Promise<void> {
  setBusy(true);
  errorPanel.hidden = true;
  invalidateNoteProposal();
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
    if (!(await ensureTrustedStorageAccess())) {
      connectionStatus.textContent = "无法启用本地存储安全配置，Token 未保存";
      return;
    }
    await chrome.storage.local.set({ localApiToken: token });
    connectionStatus.textContent = "Token 已保存";
  } catch {
    connectionStatus.textContent = "Token 保存失败";
  } finally {
    saveTokenButton.disabled = false;
  }
}

async function sendCurrentSnapshot(): Promise<void> {
  if (!currentSnapshot || sending) return;
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

async function generateNotePreview(): Promise<void> {
  if (!currentSnapshot || selectedBlockIds.size === 0 || notePreviewBusy) return;
  const generation = noteStateGeneration;
  notePreviewBusy = true;
  previewNoteButton.disabled = true;
  noteAction.textContent = "";
  notePath.textContent = "";
  markdownPreview.textContent = "";
  markdownDiff.textContent = "";
  commitNoteButton.disabled = true;
  revealNotePreviewPanel();
  noteStatus.textContent = "正在生成预览…";
  try {
    const response = (await chrome.runtime.sendMessage({
      type: NOTE_PREVIEW_REQUEST,
      snapshot: currentSnapshot,
      selectedBlockIds: [...selectedBlockIds],
      personalNote: personalNote.value,
    })) as NoteClientResult | undefined;
    if (generation !== noteStateGeneration) return;
    if (!response) {
      noteStatus.textContent = "预览失败，请重试";
      return;
    }
    if (!response.ok) {
      noteStatus.textContent = response.error.message;
      return;
    }
    if (!("proposalId" in response.response)) {
      noteStatus.textContent = "预览响应结构无效，请重试";
      return;
    }
    activeProposalId = response.response.proposalId;
    noteAction.textContent = `动作：${response.response.action}`;
    notePath.textContent = `目标：${response.response.targetRelativePath}`;
    markdownPreview.textContent = response.response.markdownPreview;
    markdownDiff.textContent = response.response.diff || "无变更";
    revealNotePreviewPanel();
    commitNoteButton.disabled = response.response.action === "noop";
    noteStatus.textContent =
      response.response.action === "noop" ? "当前内容无需写入" : "请确认后保存";
  } catch {
    if (generation === noteStateGeneration) {
      noteStatus.textContent = "预览请求失败，请重试";
    }
  } finally {
    notePreviewBusy = false;
    previewNoteButton.disabled = selectedBlockIds.size === 0;
  }
}

async function commitNote(): Promise<void> {
  if (!activeProposalId || notePreviewBusy) return;
  const generation = noteStateGeneration;
  const proposalId = activeProposalId;
  notePreviewBusy = true;
  commitNoteButton.disabled = true;
  noteStatus.textContent = "保存中…";
  try {
    const response = (await chrome.runtime.sendMessage({
      type: NOTE_COMMIT_REQUEST,
      proposalId,
    })) as NoteClientResult | undefined;
    if (generation !== noteStateGeneration) return;
    if (!response) {
      noteStatus.textContent = "保存失败，请重试";
      return;
    }
    if (!response.ok) {
      if (
        response.error.code === "NOTE_CONFLICT" ||
        response.error.code === "PROPOSAL_EXPIRED"
      ) {
        invalidateNoteProposal(response.error.message);
        return;
      }
      noteStatus.textContent = response.error.message;
      return;
    }
    if (!("status" in response.response)) {
      noteStatus.textContent = "保存响应结构无效，请重试";
      return;
    }
    noteStatus.textContent = `保存完成：${response.response.status}`;
    activeProposalId = undefined;
  } catch {
    if (generation === noteStateGeneration) {
      noteStatus.textContent = "保存请求失败，请重试";
    }
  } finally {
    notePreviewBusy = false;
    if (generation === noteStateGeneration) {
      commitNoteButton.disabled = !activeProposalId;
    }
    previewNoteButton.disabled = selectedBlockIds.size === 0;
  }
}

captureButton.addEventListener("click", () => void captureCurrentPage());
saveTokenButton.addEventListener("click", () => void saveToken());
sendButton.addEventListener("click", () => void sendCurrentSnapshot());
previewNoteButton.addEventListener("click", () => void generateNotePreview());
commitNoteButton.addEventListener("click", () => void commitNote());
personalNote.addEventListener("input", () => invalidateNoteProposal());

void loadStoredToken();
