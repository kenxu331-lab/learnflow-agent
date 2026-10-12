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

let currentSnapshot: PageSnapshot | undefined;
let sending = false;
let activeProposalId: string | undefined;
let selectedBlockIds = new Set<string>();
let notePreviewBusy = false;
let noteStateGeneration = 0;
let aiRecommendations: AIRecommendationItem[] = [];
let aiSelectedBlockIds = new Set<string>();
let aiBusy = false;
let aiStateGeneration = 0;
let studyState: StudyState = createDefaultStudyState();
let studyActionBusy = false;

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
  studyChapter.textContent = nextState.currentSession?.pageTitle ?? "—";
  studyCapturedAt.textContent = nextState.currentSession?.capturedAt ?? "—";
  studyError.hidden = !nextState.lastError;
  studyError.textContent = nextState.lastError ?? "";
  studySite.textContent = nextState.currentSession
    ? `当前来源：${nextState.currentSession.sourceUrl}`
    : "仅支持用户授权的 fastapi.tiangolo.com 教程页面。";

  if (nextState.currentSnapshot) {
    const currentKey = snapshotViewKey(currentSnapshot);
    if (currentKey !== snapshotViewKey(nextState.currentSnapshot)) {
      renderSnapshot(nextState.currentSnapshot);
    }
  } else if (currentSnapshot) {
    clearCurrentSnapshotView();
  }
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
  studyState = await loadStudyState();
  renderStudyState(studyState);
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
  notePreviewPanel.hidden = true;
  commitNoteButton.disabled = true;
  noteStatus.textContent = status;
}

function revealNotePreviewPanel(): void {
  notePreviewPanel.hidden = false;
  notePreviewPanel.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
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

chrome.runtime?.onMessage?.addListener((message) => {
  if (isStudyStateChangedMessage(message)) {
    renderStudyState(message.state);
  }
  return false;
});

void loadStoredToken();
void loadStudyUi();
