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
  AI_RECOMMEND_REQUEST,
  PAGE_INGEST_REQUEST,
  type BackendClientResult,
  type AIRecommendationItem,
  type AIRecommendationResult,
  type NoteClientResult,
} from "../backend/types";
import {
  STUDY_ENABLE_REQUEST,
  STUDY_GET_STATE_REQUEST,
  STUDY_PAUSE_REQUEST,
  STUDY_REVOKE_REQUEST,
  STUDY_MANUAL_SNAPSHOT_REQUEST,
  STUDY_SITE_HOST_PERMISSION,
  isStudyStateChangedMessage,
  type StudyActionResult,
  type StudyState,
} from "../study/types";
import {
  createDefaultStudyState,
  loadStudyState,
} from "../study/session-store";

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`LearnFlow capture UI is missing ${selector}.`);
  return element;
}

const panelRoot = requiredElement<HTMLElement>(".sidepanel");
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
const aiPanel = requiredElement<HTMLElement>("#ai-recommendation-panel");
const aiConsent = requiredElement<HTMLInputElement>("#ai-cloud-consent");
const learningGoal = requiredElement<HTMLTextAreaElement>("#learning-goal");
const aiRecommendButton = requiredElement<HTMLButtonElement>("#ai-recommend-button");
const aiRecommendationList = requiredElement<HTMLElement>("#ai-recommendation-list");
const applyAiRecommendationsButton = requiredElement<HTMLButtonElement>(
  "#apply-ai-recommendations",
);
const aiStatus = requiredElement<HTMLElement>("#ai-status");
const studyStatus = requiredElement<HTMLElement>("#study-status");
const studyIndicator = requiredElement<HTMLElement>("#study-indicator");
const studySite = requiredElement<HTMLElement>("#study-site");
const studyChapter = requiredElement<HTMLElement>("#study-chapter");
const studyCapturedAt = requiredElement<HTMLElement>("#study-captured-at");
const studyError = requiredElement<HTMLElement>("#study-error");
const studyEnableButton = requiredElement<HTMLButtonElement>(
  "#study-enable-button",
);
const studyPauseButton = requiredElement<HTMLButtonElement>(
  "#study-pause-button",
);
const studyRevokeButton = requiredElement<HTMLButtonElement>(
  "#study-revoke-button",
);
const studyPermissionStatus = requiredElement<HTMLElement>(
  "#study-permission-status",
);
const settingsButton = requiredElement<HTMLButtonElement>("#settingsBtn");
const settingsPanel = requiredElement<HTMLElement>("#settings");
const chatView = requiredElement<HTMLElement>("#chatView");
const notesView = requiredElement<HTMLElement>("#notesView");
const composerArea = requiredElement<HTMLElement>("#composerArea");
const chatInput = requiredElement<HTMLTextAreaElement>("#chatInput");
const chatSendButton = requiredElement<HTMLButtonElement>("#chat-send-button");
const chatUnavailableStatus = requiredElement<HTMLElement>("#chat-unready-status");
const emptyNote = requiredElement<HTMLElement>("#emptyNote");
const emptyNoteHint = requiredElement<HTMLElement>("#empty-note-hint");
const noteDocument = requiredElement<HTMLElement>("#noteDocument");
const notesState = requiredElement<HTMLElement>("#notesState");
const noteCount = requiredElement<HTMLElement>("#noteCount");
const organizeNoteButton = requiredElement<HTMLButtonElement>("#organize-note-button");
const aiAnnotateButton = requiredElement<HTMLButtonElement>("#ai-annotate-button");
const unreadySheet = requiredElement<HTMLElement>("#unready-sheet");
const unreadyMessage = requiredElement<HTMLElement>("#unready-message");
const closeUnreadyButton = requiredElement<HTMLButtonElement>("#close-unready");

let currentSnapshot: PageSnapshot | undefined;
let sending = false;
let activeProposalId: string | undefined;
let selectedBlockIds = new Set<string>();
let noteStateGeneration = 0;
let noteRequestSequence = 0;
let notePreviewBusyRequestId: number | undefined;
let noteCommitBusyRequestId: number | undefined;
let aiRecommendations: AIRecommendationItem[] = [];
let aiSelectedBlockIds = new Set<string>();
let aiBusy = false;
let aiStateGeneration = 0;
let studyState: StudyState = createDefaultStudyState();
let studyActionBusy = false;
let studyStateRevision = 0;

serviceUrl.value = LOCAL_INGEST_URL;

const studyStatusLabels: Record<StudyState["status"], string> = {
  DISABLED: "自动学习未启用",
  AUTHORIZED: "已授权，等待页面稳定",
  CAPTURING: "正在自动采集当前章节…",
  SOURCE_READY: "当前章节已采集",
  LOCAL_SOURCE_ONLY: "当前章节已本地采集",
  CAPTURE_FAILED: "自动采集失败",
};

function snapshotViewKey(snapshot: PageSnapshot | undefined): string {
  if (!snapshot) return "";
  return `${snapshot.url}\u0000${snapshot.capturedAt}\u0000${snapshot.stats.characterCount}`;
}

function renderStudyState(nextState: StudyState): void {
  studyState = nextState;
  studyStatus.textContent = studyStatusLabels[nextState.status];
  studyIndicator.textContent = nextState.enabled
    ? nextState.status === "CAPTURING"
      ? "…"
      : "●"
    : "○";
  studyIndicator.style.color = nextState.enabled ? "#2563eb" : "#64748b";
  studyEnableButton.hidden = nextState.enabled;
  studyPauseButton.hidden = !nextState.enabled;
  studyRevokeButton.hidden = !nextState.authorizedOrigin;
  studyChapter.textContent =
    nextState.currentSession?.pageTitle ??
    (nextState.enabled ? "正在等待当前教程章节" : "启用此网站的学习模式");
  studyCapturedAt.textContent = nextState.currentSession?.capturedAt
    ? `· ${formatCaptureTime(nextState.currentSession.capturedAt)}`
    : "";
  const warning = nextState.currentSnapshot?.extraction.warnings[0];
  studyError.hidden = !nextState.lastError && !warning;
  studyError.textContent = nextState.lastError ?? warning ?? "";
  studySite.textContent = nextState.currentSession
    ? `正在学习 · ${new URL(nextState.currentSession.sourceUrl).hostname.toUpperCase()}`
    : "尚未授权教程网站";
  studyEnableButton.textContent = nextState.authorizedOrigin
    ? "恢复自动学习"
    : "启用此网站的学习模式";

  if (nextState.currentSnapshot) {
    const currentKey = snapshotViewKey(currentSnapshot);
    if (currentKey !== snapshotViewKey(nextState.currentSnapshot)) {
      renderSnapshot(nextState.currentSnapshot);
    }
  } else if (currentSnapshot) {
    clearCurrentSnapshotView();
  }
  updateWorkspaceAvailability();
}

function formatCaptureTime(value: string): string {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return "最近已采集";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

function updateWorkspaceAvailability(): void {
  const available = Boolean(currentSnapshot?.blocks.length);
  organizeNoteButton.disabled = !available || isNoteBusy();
  aiAnnotateButton.disabled = false;
  chatSendButton.disabled = true;
  chatInput.disabled = true;
  emptyNoteHint.textContent = available
    ? "无需逐个勾选内容块。原文整理会保留当前已采集的全部有效内容，并先生成预览。"
    : studyState.enabled
      ? "正在等待当前章节采集完成；采集成功后这里会启用原文整理。"
      : "请先在当前教程网站启用学习模式，等待章节采集完成后再整理原文。";
  chatUnavailableStatus.textContent = available
    ? "对话能力即将接入。当前不会发送问题，也不会模拟 AI 回复。"
    : "等待当前章节采集后，对话上下文将显示在这里；对话能力尚未接入。";
}

function showUnavailable(feature: string): void {
  unreadyMessage.textContent = `${feature}尚未接入。当前不会调用 DeepSeek，也不会模拟成功。`;
  unreadySheet.hidden = false;
}

function setWorkspaceTab(name: "chat" | "notes"): void {
  document.querySelectorAll<HTMLButtonElement>(".main-tabs [data-tab]").forEach((button) => {
    const active = button.dataset.tab === name;
    button.classList.toggle("active", active);
    button.setAttribute("aria-current", active ? "page" : "false");
  });
  chatView.classList.toggle("active", name === "chat");
  notesView.classList.toggle("active", name === "notes");
  composerArea.classList.toggle("hide", name !== "chat");
}

async function refreshStudyPermissionStatus(): Promise<void> {
  try {
    const granted = await chrome.permissions.contains({
      origins: [STUDY_SITE_HOST_PERMISSION],
    });
    studyPermissionStatus.textContent = granted
      ? "站点访问已授权；云端 AI 仍需单独确认。"
      : "尚未授权站点访问；云端 AI 授权与此相互独立。";
  } catch {
    studyPermissionStatus.textContent =
      "无法读取站点权限；请通过按钮重新检查。";
  }
}

async function loadStudyUi(): Promise<void> {
  const revisionAtStart = studyStateRevision;
  const loadedState = await loadStudyState();
  if (revisionAtStart === studyStateRevision) {
    renderStudyState(loadedState);
  }
  await refreshStudyPermissionStatus();
}

function sendStudyAction(
  type: typeof STUDY_ENABLE_REQUEST | typeof STUDY_PAUSE_REQUEST | typeof STUDY_REVOKE_REQUEST,
): Promise<StudyActionResult> {
  return chrome.runtime.sendMessage({ type }) as Promise<StudyActionResult>;
}

async function enableStudyMode(): Promise<void> {
  if (studyActionBusy) return;
  studyActionBusy = true;
  studyEnableButton.disabled = true;
  studyStatus.textContent = "正在请求站点访问权限…";
  try {
    // Call request directly from the button handler so Chrome can associate it
    // with the user's gesture. This exact origin is the only optional host
    // permission declared by this milestone.
    const granted = await chrome.permissions.request({
      origins: [STUDY_SITE_HOST_PERMISSION],
    });
    if (!granted) {
      studyStatus.textContent = "未获得站点访问权限，自动学习未启用";
      return;
    }
    const response = await sendStudyAction(STUDY_ENABLE_REQUEST);
    if (!response.ok) {
      studyStatus.textContent = response.error.message;
      return;
    }
    renderStudyState(response.value);
    await refreshStudyPermissionStatus();
  } catch {
    studyStatus.textContent = "站点授权失败，自动学习未启用";
  } finally {
    studyActionBusy = false;
    studyEnableButton.disabled = false;
  }
}

async function pauseStudyMode(): Promise<void> {
  if (studyActionBusy) return;
  studyActionBusy = true;
  studyPauseButton.disabled = true;
  try {
    const response = await sendStudyAction(STUDY_PAUSE_REQUEST);
    if (!response.ok) {
      studyError.hidden = false;
      studyError.textContent = response.error.message;
      return;
    }
    renderStudyState(response.value);
  } catch {
    studyError.hidden = false;
    studyError.textContent = "暂停自动学习失败，请重试。";
  } finally {
    studyActionBusy = false;
    studyPauseButton.disabled = false;
  }
}

async function revokeStudyMode(): Promise<void> {
  if (studyActionBusy) return;
  studyActionBusy = true;
  studyRevokeButton.disabled = true;
  try {
    const removed = await chrome.permissions.remove({
      origins: [STUDY_SITE_HOST_PERMISSION],
    });
    if (!removed) {
      const stillGranted = await chrome.permissions.contains({
        origins: [STUDY_SITE_HOST_PERMISSION],
      });
      if (stillGranted) {
        studyError.hidden = false;
        studyError.textContent = "未能撤销站点权限，当前学习模式未改变。";
        return;
      }
    }
    const response = await sendStudyAction(STUDY_REVOKE_REQUEST);
    if (!response.ok) {
      studyError.hidden = false;
      studyError.textContent = response.error.message;
      return;
    }
    renderStudyState(response.value);
    await refreshStudyPermissionStatus();
  } catch {
    studyError.hidden = false;
    studyError.textContent = "撤销站点权限失败，请重试。";
  } finally {
    studyActionBusy = false;
    studyRevokeButton.disabled = false;
  }
}

function invalidateNoteProposal(status = "需要重新生成预览"): void {
  noteStateGeneration += 1;
  activeProposalId = undefined;
  notePreviewBusyRequestId = undefined;
  noteCommitBusyRequestId = undefined;
  notePreviewPanel.hidden = true;
  commitNoteButton.disabled = true;
  noteStatus.textContent = status;
}

function isNoteBusy(): boolean {
  return (
    notePreviewBusyRequestId !== undefined || noteCommitBusyRequestId !== undefined
  );
}

function updateNoteBusyControls(): void {
  previewNoteButton.disabled = selectedBlockIds.size === 0 || isNoteBusy();
  if (noteCommitBusyRequestId !== undefined) {
    commitNoteButton.disabled = true;
  }
}

function revealNotePreviewPanel(phase: "loading" | "success"): void {
  emptyNote.classList.add("hide");
  noteDocument.classList.remove("hide");
  notesState.textContent = phase === "loading" ? "生成中" : "预览已生成";
  noteCount.textContent = phase === "loading" ? "0" : "1";
  setWorkspaceTab("notes");
  notePreviewPanel.hidden = false;
  notePreviewPanel.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
}

function showNotePreviewFailure(message: string): void {
  setWorkspaceTab("notes");
  emptyNote.classList.add("hide");
  noteDocument.classList.remove("hide");
  notesState.textContent = "生成失败";
  noteCount.textContent = "0";
  noteAction.textContent = "无法生成当前章节预览 · 下一步：检查本地服务、Token 和 Vault 配置后重试。";
  notePath.textContent = "";
  markdownPreview.textContent = "";
  markdownDiff.textContent = "";
  commitNoteButton.disabled = true;
  notePreviewPanel.hidden = false;
  noteStatus.textContent = message;
}

function updateAiControls(): void {
  aiRecommendButton.disabled =
    !currentSnapshot || !aiConsent.checked || aiBusy;
  applyAiRecommendationsButton.disabled =
    aiBusy || aiSelectedBlockIds.size === 0;
}

function invalidateAiRecommendations(
  status = "请先确认云端发送",
): void {
  aiStateGeneration += 1;
  aiRecommendations = [];
  aiSelectedBlockIds = new Set();
  aiRecommendationList.replaceChildren();
  aiStatus.textContent = status;
  updateAiControls();
}

function renderAiRecommendations(): void {
  const blockMap = new Map(
    (currentSnapshot?.blocks ?? []).map((block) => [block.id, block]),
  );
  aiRecommendationList.replaceChildren(
    ...aiRecommendations.map((recommendation) => {
      const label = document.createElement("label");
      label.className = "ai-recommendation";
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = aiSelectedBlockIds.has(recommendation.blockId);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          aiSelectedBlockIds.add(recommendation.blockId);
        } else {
          aiSelectedBlockIds.delete(recommendation.blockId);
        }
        updateAiControls();
      });
      const content = document.createElement("span");
      content.className = "ai-recommendation-content";
      const heading = document.createElement("strong");
      heading.textContent = `[${recommendation.category}] ${recommendation.blockId}`;
      const reason = document.createElement("span");
      reason.className = "ai-recommendation-reason";
      reason.textContent = recommendation.reason;
      const excerpt = document.createElement("span");
      excerpt.className = "ai-recommendation-excerpt";
      excerpt.textContent = `原文：${
        blockMap.get(recommendation.blockId)?.text.slice(0, 240) ?? ""
      }`;
      content.append(heading, reason, excerpt);
      label.append(checkbox, content);
      return label;
    }),
  );
  updateAiControls();
}

function syncBlockCheckboxes(): void {
  blockList
    .querySelectorAll<HTMLInputElement>("input[data-block-id]")
    .forEach((checkbox) => {
      checkbox.checked = selectedBlockIds.has(checkbox.dataset.blockId ?? "");
    });
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
  previewNoteButton.disabled = selectedBlockIds.size === 0 || isNoteBusy();
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
      checkbox.dataset.blockId = block.id;
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
  invalidateNoteProposal("当前章节已更新，需要重新生成预览");
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
  aiPanel.hidden = false;
  aiConsent.checked = false;
  learningGoal.value = "";
  invalidateAiRecommendations();
  notePreviewPanel.hidden = true;
  commitNoteButton.disabled = true;
  noteStatus.textContent = "需要先生成预览";
  emptyNote.classList.remove("hide");
  noteDocument.classList.add("hide");
  notesState.textContent = "尚未生成";
  noteCount.textContent = "0";
  updateWorkspaceAvailability();
}

function clearCurrentSnapshotView(): void {
  currentSnapshot = undefined;
  selectedBlockIds = new Set();
  activeProposalId = undefined;
  resultPanel.hidden = true;
  selectionPanel.hidden = true;
  aiPanel.hidden = true;
  notePreviewPanel.hidden = true;
  warningPanel.hidden = true;
  sendButton.disabled = true;
  previewNoteButton.disabled = true;
  commitNoteButton.disabled = true;
  invalidateAiRecommendations("等待当前章节重新采集");
  invalidateNoteProposal("等待当前章节重新采集");
  emptyNote.classList.remove("hide");
  noteDocument.classList.add("hide");
  notesState.textContent = "尚未生成";
  noteCount.textContent = "0";
  updateWorkspaceAvailability();
}

function renderError(message: string): void {
  errorMessage.textContent = message;
  errorPanel.hidden = false;
  resultPanel.hidden = true;
  selectionPanel.hidden = true;
  aiPanel.hidden = true;
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
  invalidateAiRecommendations();
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
    if (studyState.enabled) {
      void chrome.runtime
        .sendMessage({
          type: STUDY_MANUAL_SNAPSHOT_REQUEST,
          snapshot: response.snapshot,
        })
        .catch(() => undefined);
    }
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

async function analyzeCurrentPage(): Promise<void> {
  if (!currentSnapshot || !aiConsent.checked || aiBusy) return;
  const generation = aiStateGeneration;
  aiBusy = true;
  updateAiControls();
  aiStatus.textContent = "正在请求云端 AI 分析…";
  try {
    const response = (await chrome.runtime.sendMessage({
      type: AI_RECOMMEND_REQUEST,
      snapshot: currentSnapshot,
      learningGoal: learningGoal.value.trim(),
      cloudConsent: true,
    })) as AIRecommendationResult | undefined;
    if (generation !== aiStateGeneration) return;
    if (!response || !response.ok) {
      aiStatus.textContent = response?.error.message ?? "AI 分析失败，请重试";
      return;
    }
    aiRecommendations = response.response.recommendations;
    aiSelectedBlockIds = new Set(
      aiRecommendations.map((recommendation) => recommendation.blockId),
    );
    renderAiRecommendations();
    aiStatus.textContent = aiRecommendations.length
      ? `已推荐 ${aiRecommendations.length} 个重点${
          response.response.analysis.truncated ? "（上下文已裁剪）" : ""
        }`
      : "AI 未推荐重点，你仍可以手动选择内容块";
  } catch {
    if (generation === aiStateGeneration) {
      aiStatus.textContent = "AI 分析请求失败，请重试";
    }
  } finally {
    aiBusy = false;
    updateAiControls();
  }
}

function applyAiRecommendations(): void {
  if (!currentSnapshot || aiSelectedBlockIds.size === 0) return;
  for (const blockId of aiSelectedBlockIds) {
    if (currentSnapshot.blocks.some((block) => block.id === blockId)) {
      selectedBlockIds.add(blockId);
    }
  }
  syncBlockCheckboxes();
  updateSelectionState();
  aiStatus.textContent = "已应用推荐，可继续调整内容块后生成 Markdown 预览";
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

async function organizeCurrentChapter(): Promise<void> {
  await refreshCurrentStudyState();
  if (!currentSnapshot || currentSnapshot.blocks.length === 0 || isNoteBusy()) {
    updateWorkspaceAvailability();
    return;
  }
  selectedBlockIds = new Set(currentSnapshot.blocks.map((block) => block.id));
  personalNote.value = "";
  updateSelectionState();
  await generateNotePreview();
}

async function refreshCurrentStudyState(): Promise<void> {
  if (!studyState.enabled) return;
  try {
    const response = await chrome.runtime.sendMessage({
      type: STUDY_GET_STATE_REQUEST,
    });
    if (isStudyStateChangedMessage(response)) {
      studyStateRevision += 1;
      renderStudyState(response.state);
    }
  } catch {
    // The existing local snapshot remains usable when the worker is unavailable.
  }
}

async function generateNotePreview(): Promise<void> {
  if (!currentSnapshot || selectedBlockIds.size === 0 || isNoteBusy()) return;
  const generation = noteStateGeneration;
  const requestId = ++noteRequestSequence;
  notePreviewBusyRequestId = requestId;
  updateNoteBusyControls();
  noteAction.textContent = "";
  notePath.textContent = "";
  markdownPreview.textContent = "";
  markdownDiff.textContent = "";
  commitNoteButton.disabled = true;
  revealNotePreviewPanel("loading");
  noteStatus.textContent = "正在生成预览…";
  try {
    const response = (await chrome.runtime.sendMessage({
      type: NOTE_PREVIEW_REQUEST,
      snapshot: currentSnapshot,
      selectedBlockIds: [...selectedBlockIds],
      personalNote: personalNote.value,
    })) as NoteClientResult | undefined;
    if (
      generation !== noteStateGeneration ||
      notePreviewBusyRequestId !== requestId
    ) {
      return;
    }
    if (!response) {
      showNotePreviewFailure("未收到本地服务响应；请确认 FastAPI 已启动后重试。");
      return;
    }
    if (!response.ok) {
      showNotePreviewFailure(response.error.message);
      return;
    }
    if (!("proposalId" in response.response)) {
      showNotePreviewFailure("本地服务返回的预览结构无效，请重试。");
      return;
    }
    activeProposalId = response.response.proposalId;
    noteAction.textContent = `动作：${response.response.action}`;
    notePath.textContent = `目标：${response.response.targetRelativePath}`;
    markdownPreview.textContent = response.response.markdownPreview;
    markdownDiff.textContent = response.response.diff || "无变更";
    revealNotePreviewPanel("success");
    commitNoteButton.disabled = response.response.action === "noop";
    noteStatus.textContent =
      response.response.action === "noop" ? "当前内容无需写入" : "请确认后保存";
  } catch {
    if (
      generation === noteStateGeneration &&
      notePreviewBusyRequestId === requestId
    ) {
      showNotePreviewFailure("无法连接本地服务；请启动 FastAPI、配置 Token 和 Vault 后重试。");
    }
  } finally {
    if (notePreviewBusyRequestId === requestId) {
      notePreviewBusyRequestId = undefined;
      updateNoteBusyControls();
      updateWorkspaceAvailability();
    }
  }
}

async function commitNote(): Promise<void> {
  if (!activeProposalId || isNoteBusy()) return;
  const generation = noteStateGeneration;
  const proposalId = activeProposalId;
  const requestId = ++noteRequestSequence;
  noteCommitBusyRequestId = requestId;
  commitNoteButton.disabled = true;
  updateNoteBusyControls();
  noteStatus.textContent = "保存中…";
  try {
    const response = (await chrome.runtime.sendMessage({
      type: NOTE_COMMIT_REQUEST,
      proposalId,
    })) as NoteClientResult | undefined;
    if (
      generation !== noteStateGeneration ||
      noteCommitBusyRequestId !== requestId
    ) {
      return;
    }
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
    notesState.textContent = "已保存";
    activeProposalId = undefined;
  } catch {
    if (
      generation === noteStateGeneration &&
      noteCommitBusyRequestId === requestId
    ) {
      noteStatus.textContent = "保存请求失败，请重试";
    }
  } finally {
    if (noteCommitBusyRequestId === requestId) {
      noteCommitBusyRequestId = undefined;
      commitNoteButton.disabled = !activeProposalId;
      updateNoteBusyControls();
      updateWorkspaceAvailability();
    }
  }
}

captureButton.addEventListener("click", () => void captureCurrentPage());
saveTokenButton.addEventListener("click", () => void saveToken());
sendButton.addEventListener("click", () => void sendCurrentSnapshot());
previewNoteButton.addEventListener("click", () => void generateNotePreview());
commitNoteButton.addEventListener("click", () => void commitNote());
personalNote.addEventListener("input", () => invalidateNoteProposal());
aiConsent.addEventListener("change", () => {
  if (!aiConsent.checked) invalidateAiRecommendations();
  else updateAiControls();
});
learningGoal.addEventListener("input", () => {
  if (aiBusy || aiRecommendations.length > 0) {
    invalidateAiRecommendations("学习目标已变化，请重新分析");
  }
});
aiRecommendButton.addEventListener("click", () => void analyzeCurrentPage());
applyAiRecommendationsButton.addEventListener("click", applyAiRecommendations);

studyEnableButton.addEventListener("click", () => void enableStudyMode());
studyPauseButton.addEventListener("click", () => void pauseStudyMode());
studyRevokeButton.addEventListener("click", () => void revokeStudyMode());

document.querySelectorAll<HTMLButtonElement>(".main-tabs [data-tab]").forEach((button) => {
  button.addEventListener("click", () => {
    const tab = button.dataset.tab;
    if (tab === "chat" || tab === "notes") setWorkspaceTab(tab);
  });
});

panelRoot.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const actionButton = target.closest<HTMLButtonElement>("button[data-action]");
  if (actionButton?.dataset.action === "make-note") {
    void organizeCurrentChapter();
  } else if (actionButton?.dataset.action === "ai-annotate") {
    showUnavailable("AI 注解当前小节");
  }
});

document.querySelectorAll<HTMLButtonElement>("button[data-prompt]").forEach((button) => {
  button.addEventListener("click", () => {
    chatInput.value = button.dataset.prompt ?? "";
    chatInput.focus();
  });
});

settingsButton.addEventListener("click", (event) => {
  event.stopPropagation();
  settingsPanel.hidden = !settingsPanel.hidden;
});
panelRoot.addEventListener("click", (event) => {
  const target = event.target;
  if (target instanceof Node && !settingsPanel.contains(target) && !settingsButton.contains(target)) {
    settingsPanel.hidden = true;
  }
});
closeUnreadyButton.addEventListener("click", () => {
  unreadySheet.hidden = true;
});
unreadySheet.addEventListener("click", (event) => {
  if (event.target === unreadySheet) unreadySheet.hidden = true;
});

chrome.runtime?.onMessage?.addListener((message) => {
  if (isStudyStateChangedMessage(message)) {
    studyStateRevision += 1;
    renderStudyState(message.state);
  }
  return false;
});

void loadStoredToken();
void loadStudyUi();
