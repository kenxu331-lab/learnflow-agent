import "./style.css";

import {
  PAGE_CAPTURE_REQUEST,
  PAGE_SELECTION_REQUEST,
  type PageCaptureResponse,
  type PageSnapshot,
  type PageSelection,
} from "../capture/types";
import {
  getAnnotationIntents,
  getPublishCandidates,
  commitAnnotation,
  getKnowledgeJobs,
  triggerKnowledgeExtraction,
  getStudyConversation,
  LOCAL_INGEST_URL,
  streamStudyChat,
} from "../backend/api-client";
import { ensureTrustedStorageAccess } from "../backend/storage";
import {
  NOTE_COMMIT_REQUEST,
  NOTE_PREVIEW_REQUEST,
  DOCUMENT_COMMIT_REQUEST,
  AI_RECOMMEND_REQUEST,
  DOCUMENT_PREVIEW_REQUEST,
  PAGE_INGEST_REQUEST,
  type BackendClientResult,
  type AIRecommendationItem,
  type AIRecommendationResult,
  type DocumentPreviewResult,
  type DocumentCommitResult,
  type NoteClientResult,
  type StudyChatPayload,
  type StudyMessage,
  type PublishCandidateResponse,
} from "../backend/types";
import {
  STUDY_ENABLE_REQUEST,
  STUDY_GET_STATE_REQUEST,
  STUDY_GET_TAB_CONTEXT_REQUEST,
  STUDY_PAUSE_REQUEST,
  STUDY_REVOKE_REQUEST,
  STUDY_MANUAL_SNAPSHOT_REQUEST,
  STUDY_SITE_ORIGIN,
  STUDY_SITE_HOST_PERMISSION,
  isStudyStateChangedMessage,
  type StudyActionResult,
  type StudyState,
} from "../study/types";
import {
  createDefaultStudyState,
  loadStudyState,
} from "../study/session-store";
import { routeCommandIntent } from "../commands/intent-router";

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`LearnFlow capture UI is missing ${selector}.`);
  return element;
}

function optionalElement<T extends Element>(selector: string): T | null {
  return document.querySelector<T>(selector);
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
const toast = optionalElement<HTMLElement>("#toast");
const chatView = requiredElement<HTMLElement>("#chatView");
const notesView = requiredElement<HTMLElement>("#notesView");
const composerArea = requiredElement<HTMLElement>("#composerArea");
const chatInput = requiredElement<HTMLTextAreaElement>("#chatInput");
const chatSendButton = requiredElement<HTMLButtonElement>("#chat-send-button");
const slashCommandMenu = optionalElement<HTMLElement>("#slash-command-menu");
const chatUnavailableStatus = requiredElement<HTMLElement>("#chat-unready-status");
const chatMessages = optionalElement<HTMLElement>("#chat-messages");
const chatScroll = optionalElement<HTMLElement>("#chat-scroll");
const composerCaptionText = optionalElement<HTMLElement>("#composer-caption-text");
const noteActionStatus = requiredElement<HTMLElement>("#note-action-status");
const emptyNote = requiredElement<HTMLElement>("#emptyNote");
const emptyNoteHint = requiredElement<HTMLElement>("#empty-note-hint");
const noteDocument = requiredElement<HTMLElement>("#noteDocument");
const notesState = requiredElement<HTMLElement>("#notesState");
const noteCount = requiredElement<HTMLElement>("#noteCount");
const organizeNoteButton = requiredElement<HTMLButtonElement>("#organize-note-button");
const documentV2PreviewButton = requiredElement<HTMLButtonElement>(
  "#document-v2-preview-button",
);
const documentV2Status = requiredElement<HTMLElement>("#document-v2-status");
const documentV2PreviewPanel = requiredElement<HTMLElement>(
  "#document-v2-preview-panel",
);
const documentV2Source = requiredElement<HTMLElement>("#document-v2-source");
const documentV2Diagnostics = requiredElement<HTMLElement>(
  "#document-v2-diagnostics",
);
const documentExportDiagnosticsButton = requiredElement<HTMLButtonElement>(
  "#document-export-diagnostics-button",
);
const documentV2Markdown = requiredElement<HTMLElement>("#document-v2-markdown");
const documentV2Action = requiredElement<HTMLElement>("#document-v2-action");
const documentV2Path = requiredElement<HTMLElement>("#document-v2-path");
const documentV2Diff = requiredElement<HTMLElement>("#document-v2-diff");
const documentV2CommitButton = requiredElement<HTMLButtonElement>(
  "#document-v2-commit-button",
);
const documentV2CommitStatus = requiredElement<HTMLElement>(
  "#document-v2-commit-status",
);
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
let documentPreviewGeneration = 0;
let documentPreviewRequestSequence = 0;
let documentPreviewBusyRequestId: number | undefined;
let activeDocumentProposalId: string | undefined;
let documentCommitBusyRequestId: number | undefined;
let latestDocumentDiagnostics: unknown;
let latestDocumentSource = "";
let aiRecommendations: AIRecommendationItem[] = [];
let aiSelectedBlockIds = new Set<string>();
let aiBusy = false;
let aiStateGeneration = 0;
let studyState: StudyState = createDefaultStudyState();
let studyActionBusy = false;
let studyStateRevision = 0;
let currentStudyTabOrigin: string | undefined;
let chatBusy = false;
let chatAbortController: AbortController | undefined;
let chatConversationId: string | undefined;
let chatLoadGeneration = 0;
let chatLoadedKey: string | undefined;
let pendingChatLoadKey: string | undefined;
let knowledgePollTimer: number | undefined;
let knowledgeToastTimer: number | undefined;
const knowledgeJobStates = new Map<string, string>();
const knowledgePromptedRounds = new Set<string>();
type KnowledgePromptDecision =
  | "pending"
  | "extracting"
  | "completed"
  | "review"
  | "skipped";
const knowledgePromptStates = new Map<
  string,
  { round: number; decision: KnowledgePromptDecision; status?: string }
>();
const recentKnowledgeChoiceStates = new Map<
  string,
  { decision: "pending" | "shown" | "dismissed"; status?: string }
>();
const recentKnowledgeCandidates = new Map<string, PublishCandidateResponse>();
const recentKnowledgeContentShown = new Set<string>();
const archiveCandidateIds = new Set<string>();
const archiveCandidates = new Map<string, PublishCandidateResponse>();
let pendingArchiveCandidate: PublishCandidateResponse | undefined;
let pendingArchiveCandidates: PublishCandidateResponse[] | undefined;

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

function comparablePageUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return value;
  }
}

function originHost(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return new URL(value).hostname.toUpperCase();
  } catch {
    return undefined;
  }
}

async function currentPageMismatch(snapshot: PageSnapshot): Promise<string | undefined> {
  if (!studyState.enabled) return undefined;
  try {
    const response: unknown = await chrome.runtime.sendMessage({
      type: STUDY_GET_TAB_CONTEXT_REQUEST,
    });
    if (
      typeof response !== "object" ||
      response === null ||
      !("ok" in response)
    ) {
      return undefined;
    }
    if (response.ok === false && "error" in response) {
      return typeof response.error === "object" && response.error !== null && "message" in response.error
        ? String(response.error.message)
        : "无法确认当前页面来源，请重新采集后再保存。";
    }
    if (response.ok !== true || !("value" in response)) return undefined;
    const value = response.value;
    if (
      typeof value !== "object" ||
      value === null ||
      !("url" in value) ||
      typeof value.url !== "string" ||
      !value.url
    ) {
      return undefined;
    }
    if (comparablePageUrl(value.url) !== comparablePageUrl(snapshot.url)) {
      return "当前页面已变化，已阻止把其他章节内容保存到当前来源。请重新采集后重试。";
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function renderStudyState(nextState: StudyState): void {
  if (nextState.activeOrigin) {
    currentStudyTabOrigin = nextState.activeOrigin;
  }
  const nextConversationId = nextState.currentSession
    ? conversationIdForSession(nextState.currentSession.sessionId)
    : undefined;
  const nextChatKey = nextConversationId
    ? `${nextConversationId}\u0000${snapshotViewKey(nextState.currentSnapshot)}`
    : undefined;
  if (chatConversationId && chatConversationId !== nextConversationId) {
    chatAbortController?.abort();
    chatAbortController = undefined;
    chatBusy = false;
    knowledgePromptedRounds.clear();
    knowledgePromptStates.clear();
    recentKnowledgeChoiceStates.clear();
    recentKnowledgeCandidates.clear();
    recentKnowledgeContentShown.clear();
    archiveCandidateIds.clear();
    archiveCandidates.clear();
    pendingArchiveCandidate = undefined;
    pendingArchiveCandidates = undefined;
  }
  studyState = nextState;
  studyStatus.textContent = studyStatusLabels[nextState.status];
  const visibleOrigin =
    nextState.activeOrigin ?? currentStudyTabOrigin ?? nextState.authorizedOrigin;
  const currentOriginAuthorized = Boolean(
    visibleOrigin &&
      (nextState.authorizedOrigins?.includes(visibleOrigin) ||
        nextState.authorizedOrigin === visibleOrigin),
  );
  const currentTabHasLiveStudy =
    nextState.enabled &&
    currentOriginAuthorized &&
    nextState.status !== "DISABLED";
  studyIndicator.textContent = currentTabHasLiveStudy
    ? nextState.status === "CAPTURING"
      ? "…"
      : "●"
    : "○";
  studyIndicator.style.color = currentTabHasLiveStudy ? "#2563eb" : "#64748b";
  studyEnableButton.hidden = currentTabHasLiveStudy;
  studyPauseButton.hidden = !currentTabHasLiveStudy;
  studyRevokeButton.hidden = !(nextState.authorizedOrigin || nextState.authorizedOrigins?.length);
  studyChapter.textContent =
    nextState.currentSession?.pageTitle ??
    (currentOriginAuthorized && nextState.enabled
      ? "正在等待当前教程章节"
      : "请授权当前教程网站后开始学习");
  studyCapturedAt.textContent = nextState.currentSession?.capturedAt
    ? `· ${formatCaptureTime(nextState.currentSession.capturedAt)}`
    : "";
  const warning = nextState.currentSnapshot?.extraction.warnings[0];
  studyError.hidden = !nextState.lastError && !warning;
  studyError.textContent = nextState.lastError ?? warning ?? "";
  studySite.textContent = nextState.currentSession
    ? `正在学习 · ${new URL(nextState.currentSession.sourceUrl).hostname.toUpperCase()}`
    : originHost(visibleOrigin)
      ? `当前页面 · ${originHost(visibleOrigin)}`
      : "尚未授权教程网站";
  studyEnableButton.textContent = currentOriginAuthorized
    ? "采集当前页面"
    : "授权并采集当前页面";

  if (nextState.currentSnapshot) {
    const currentKey = snapshotViewKey(currentSnapshot);
    if (currentKey !== snapshotViewKey(nextState.currentSnapshot)) {
      renderSnapshot(nextState.currentSnapshot, true);
    }
  } else if (currentSnapshot) {
    clearCurrentSnapshotView();
  }
  updateWorkspaceAvailability();
  if (chatLoadedKey !== nextChatKey) {
    void loadStudyConversationForState(nextChatKey);
  }
}

function conversationIdForSession(sessionId: string): string {
  return `conversation-${sessionId}`;
}

function escapeMarkdownHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderInlineMarkdown(value: string): string {
  let html = escapeMarkdownHtml(value);
  html = html.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noreferrer noopener">$1</a>',
  );
  html = html.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  html = html.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  return html.replaceAll("\n", "<br>");
}

function markdownToHtml(markdown: string): string {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  const output: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const fence = line.match(/^\s*```([^`]*)\s*$/);
    if (fence) {
      const language = fence[1].trim();
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
        code.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const languageClass = language
        ? ` class="language-${escapeMarkdownHtml(language)}"`
        : "";
      output.push(
        `<pre class="markdown-code"><code${languageClass}>${escapeMarkdownHtml(
          code.join("\n"),
        )}</code></pre>`,
      );
      continue;
    }
    const heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      const level = heading[1].length;
      output.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>/.test(lines[index])) {
        quote.push(lines[index].replace(/^\s*>\s?/, ""));
        index += 1;
      }
      output.push(`<blockquote>${renderInlineMarkdown(quote.join("\n"))}</blockquote>`);
      continue;
    }
    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    if (unordered) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index].match(/^\s*[-*+]\s+(.+)$/);
        if (!item) break;
        items.push(`<li>${renderInlineMarkdown(item[1])}</li>`);
        index += 1;
      }
      output.push(`<ul>${items.join("")}</ul>`);
      continue;
    }
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (ordered) {
      const items: string[] = [];
      while (index < lines.length) {
        const item = lines[index].match(/^\s*\d+[.)]\s+(.+)$/);
        if (!item) break;
        items.push(`<li>${renderInlineMarkdown(item[1])}</li>`);
        index += 1;
      }
      output.push(`<ol>${items.join("")}</ol>`);
      continue;
    }
    const paragraph: string[] = [line];
    index += 1;
    while (
      index < lines.length &&
      lines[index].trim() &&
      !/^\s*```/.test(lines[index]) &&
      !/^\s*#{1,6}\s+/.test(lines[index]) &&
      !/^\s*>/.test(lines[index]) &&
      !/^\s*[-*+]\s+/.test(lines[index]) &&
      !/^\s*\d+[.)]\s+/.test(lines[index])
    ) {
      paragraph.push(lines[index]);
      index += 1;
    }
    output.push(`<p>${renderInlineMarkdown(paragraph.join("\n"))}</p>`);
  }
  return output.join("");
}

function renderMarkdownInto(element: HTMLElement, markdown: string): void {
  element.innerHTML = markdownToHtml(markdown);
}

function appendChatMessage(message: StudyMessage): HTMLElement | undefined {
  if (!chatMessages) return undefined;
  const wrapper = document.createElement("article");
  wrapper.className = `chat-message ${message.role}`;
  const role = document.createElement("div");
  role.className = "chat-message-role";
  role.textContent = message.role === "user" ? "你" : "LearnFlow · Study Agent";
  const body = document.createElement("div");
  body.className = "chat-message-body";
  if (message.role === "assistant") {
    renderMarkdownInto(body, message.content);
  } else {
    body.textContent = message.content;
  }
  wrapper.append(role, body);
  if (message.selectedText) {
    const source = document.createElement("small");
    source.className = "chat-message-source";
    source.textContent = `引用：${message.source?.headingPath.join(" / ") || "当前章节"}`;
    wrapper.append(source);
  }
  chatMessages.append(wrapper);
  if (chatScroll) {
    chatScroll.scrollTop = chatScroll.scrollHeight;
  } else {
    wrapper.scrollIntoView?.({ behavior: "smooth", block: "nearest" });
  }
  return wrapper;
}

function removeArchiveCandidateCard(candidate: PublishCandidateResponse): void {
  const key = `${candidate.knowledgeId}:${candidate.knowledgeVersion}`;
  archiveCandidates.delete(key);
  archiveCandidateIds.delete(key);
  chatMessages
    ?.querySelectorAll<HTMLElement>(".knowledge-archive-card:not(.knowledge-recent-card)")
    .forEach((card) => {
      if (card.dataset.knowledgeKey === key) card.remove();
    });
}

async function commitArchiveCandidate(
  candidate: PublishCandidateResponse,
  status: HTMLElement,
  archiveButton: HTMLButtonElement,
  laterButton: HTMLButtonElement,
): Promise<void> {
  archiveButton.disabled = true;
  laterButton.disabled = true;
  status.textContent = "正在重新校验来源并归档…";
  const result = await commitAnnotation(candidate.knowledgeId, candidate.knowledgeVersion);
  if (!result.ok) {
    if (["NOTE_CONFLICT", "PROPOSAL_EXPIRED"].includes(result.error.code)) {
      removeArchiveCandidateCard(candidate);
      pendingArchiveCandidate = undefined;
      return;
    }
    status.textContent = result.error.message;
    archiveButton.disabled = false;
    laterButton.disabled = false;
    return;
  }
  status.textContent = result.response.status === "published"
    ? "已归档到当前笔记。"
    : result.response.status === "noop"
      ? "笔记中已经存在，无需重复写入。"
      : "来源发生变化，需要重新采集并保存当前章节。";
  if (result.response.status === "needs_review") {
    removeArchiveCandidateCard(candidate);
  } else {
    removeArchiveCandidateCard(candidate);
  }
  pendingArchiveCandidate = undefined;
}

function archiveTargetDescription(candidate: PublishCandidateResponse): string {
  const file = candidate.targetRelativePath ?? candidate.targetNoteId;
  const heading = candidate.headingPath.length
    ? candidate.headingPath.join(" / ")
    : "当前章节原文";
  return `目标文件：${file}\n写入位置：章节“${heading}”对应的原文锚点后，新增 LearnFlow 知识卡片（不替换原文）`;
}

function appendCommandSuggestionCard(
  message: string,
  correctedCommand: string,
): void {
  if (!chatMessages) return;
  const card = document.createElement("article");
  card.className = "knowledge-extraction-prompt command-suggestion-card";
  const title = document.createElement("h3");
  title.textContent = "检测到指令意图";
  const body = document.createElement("p");
  body.textContent = `${message}是否执行 ${correctedCommand}？`;
  const actions = document.createElement("div");
  actions.className = "knowledge-archive-actions";
  const execute = document.createElement("button");
  execute.className = "btn-primary";
  execute.type = "button";
  execute.textContent = `执行 ${correctedCommand}`;
  const cancel = document.createElement("button");
  cancel.className = "btn-outline";
  cancel.type = "button";
  cancel.textContent = "取消";
  const status = document.createElement("small");
  status.className = "knowledge-archive-status";
  execute.addEventListener("click", async () => {
    execute.disabled = true;
    cancel.disabled = true;
    await handleKnowledgeCommand(correctedCommand);
    status.textContent = "已进入归档确认流程。";
  });
  cancel.addEventListener("click", () => {
    execute.disabled = true;
    cancel.disabled = true;
    status.textContent = "已取消。";
  });
  actions.append(execute, cancel);
  card.append(title, body, actions, status);
  chatMessages.append(card);
}

function appendArchiveCandidateCard(candidate: PublishCandidateResponse): void {
  if (!chatMessages) return;
  const candidateKey = `${candidate.knowledgeId}:${candidate.knowledgeVersion}`;
  const existing = Array.from(
    chatMessages.querySelectorAll<HTMLElement>(".knowledge-archive-card"),
  ).some((item) => item.dataset.knowledgeKey === candidateKey);
  if (existing) return;
  archiveCandidateIds.add(candidateKey);
  const card = document.createElement("article");
  card.className = "knowledge-archive-card";
  card.dataset.knowledgeKey = candidateKey;
  const title = document.createElement("h3");
  title.textContent = candidate.publishStatus === "eligible_user_insight"
    ? "发现一条“我的理解”"
    : "发现一条可归档知识";
  const topic = document.createElement("p");
  topic.className = "knowledge-archive-topic";
  topic.textContent = `${candidate.headingPath.join(" / ")} · ${candidate.kind}`;
  const body = document.createElement("div");
  body.className = "knowledge-archive-body";
  renderMarkdownInto(body, candidate.body);
  const path = document.createElement("small");
  path.className = "knowledge-archive-path";
  path.textContent = archiveTargetDescription(candidate);
  const actions = document.createElement("div");
  actions.className = "knowledge-archive-actions";
  const archiveButton = document.createElement("button");
  archiveButton.className = "btn-primary";
  archiveButton.type = "button";
  archiveButton.textContent = "归档到笔记";
  const laterButton = document.createElement("button");
  laterButton.className = "btn-outline";
  laterButton.type = "button";
  laterButton.textContent = "稍后处理";
  const status = document.createElement("small");
  status.className = "knowledge-archive-status";
  archiveButton.addEventListener("click", async () => {
    await commitArchiveCandidate(candidate, status, archiveButton, laterButton);
  });
  laterButton.addEventListener("click", () => {
    status.textContent = "已保留，之后可在本章节继续处理。";
    archiveButton.disabled = true;
    laterButton.disabled = true;
  });
  actions.append(archiveButton, laterButton);
  card.append(title, topic, body, path, actions, status);
  chatMessages.append(card);
  chatScroll?.scrollTo({ top: chatScroll.scrollHeight, behavior: "smooth" });
}

function completedChatRoundCount(): number {
  if (!chatMessages) return 0;
  const userRounds = chatMessages.querySelectorAll("article.chat-message.user").length;
  const assistantRounds = chatMessages.querySelectorAll(
    "article.chat-message.assistant",
  ).length;
  return Math.min(userRounds, assistantRounds);
}

async function requestKnowledgeExtraction(): Promise<{
  scheduledJobCount: number;
  state:
    | "queued"
    | "running"
    | "completed"
    | "needs_review"
    | "skipped"
    | "no_new_events";
  error?: string;
}> {
  const session = studyState.currentSession;
  if (!session) {
    return {
      scheduledJobCount: 0,
      state: "no_new_events",
      error: "当前章节会话尚未准备好。",
    };
  }
  const result = await triggerKnowledgeExtraction(
    session.chapterId,
    conversationIdForSession(session.sessionId),
  );
  if (!result.ok) {
    return {
      scheduledJobCount: 0,
      state: "no_new_events",
      error: result.error.message,
    };
  }
  if (["queued", "running"].includes(result.response.state)) {
    ensureKnowledgeStatusPolling();
  } else if (result.response.state === "completed") {
    await refreshArchiveCandidateCards();
  }
  return result.response;
}

function appendKnowledgeExtractionPrompt(round: number): void {
  if (!chatMessages) return;
  const sessionId = studyState.currentSession?.sessionId;
  if (!sessionId) return;
  const promptKey = `${sessionId}:${round}`;
  const promptState = knowledgePromptStates.get(promptKey) ?? {
    round,
    decision: "pending" as const,
  };
  knowledgePromptStates.set(promptKey, promptState);
  const existing = Array.from(
    chatMessages.querySelectorAll<HTMLElement>(".knowledge-extraction-prompt"),
  ).some((item) => item.dataset.promptKey === promptKey);
  if (existing) return;
  const card = document.createElement("article");
  card.className = "knowledge-extraction-prompt";
  card.dataset.promptKey = promptKey;
  const title = document.createElement("h3");
  title.textContent = `已完成 ${round} 轮对话`;
  const body = document.createElement("p");
  body.textContent = "可以提炼本次对话中的可复用知识，是否现在提炼？";
  const actions = document.createElement("div");
  actions.className = "knowledge-archive-actions";
  const extractButton = document.createElement("button");
  extractButton.className = "btn-primary";
  extractButton.type = "button";
  extractButton.textContent = "提炼知识";
  const laterButton = document.createElement("button");
  laterButton.className = "btn-outline";
  laterButton.type = "button";
  laterButton.textContent = "暂不提炼";
  const status = document.createElement("small");
  status.className = "knowledge-archive-status";
  const isFinished = ["extracting", "completed", "skipped"].includes(
    promptState.decision,
  );
  extractButton.disabled = isFinished;
  laterButton.disabled = isFinished;
  status.textContent = promptState.status ??
    (promptState.decision === "extracting"
      ? "提炼中…完成后会显示知识卡片。"
      : promptState.decision === "completed"
        ? "本轮对话已完成提炼。"
        : promptState.decision === "skipped"
          ? "已跳过；你也可以输入 /提炼 随时手动触发。"
          : promptState.decision === "review"
            ? "上次提炼需要重试。"
            : "");
  extractButton.addEventListener("click", async () => {
    promptState.decision = "extracting";
    promptState.status = "提炼中…完成后会显示知识卡片。";
    extractButton.disabled = true;
    laterButton.disabled = true;
    status.textContent = promptState.status;
    const result = await requestKnowledgeExtraction();
    if (result.error) {
      promptState.decision = "review";
      promptState.status = result.error;
      extractButton.disabled = false;
      laterButton.disabled = false;
    } else if (result.state === "queued" || result.state === "running") {
      promptState.decision = "extracting";
      promptState.status = "提炼中…完成后会显示知识卡片。";
    } else if (result.state === "completed") {
      promptState.decision = "completed";
      promptState.status = "本轮对话已完成提炼，正在加载知识卡片。";
    } else if (result.state === "needs_review") {
      promptState.decision = "review";
      promptState.status = "上次提炼需要重试，请再次点击“提炼知识”。";
      extractButton.disabled = false;
      laterButton.disabled = false;
    } else {
      promptState.decision = "completed";
      promptState.status = "当前对话已经提炼过，没有新的对话可提炼。";
      appendRecentKnowledgeChoice();
    }
    status.textContent = promptState.status;
  });
  laterButton.addEventListener("click", () => {
    promptState.decision = "skipped";
    promptState.status = "已跳过；你也可以输入 /提炼 随时手动触发。";
    extractButton.disabled = true;
    laterButton.disabled = true;
    status.textContent = promptState.status;
  });
  actions.append(extractButton, laterButton);
  card.append(title, body, actions, status);
  chatMessages.append(card);
  chatScroll?.scrollTo({ top: chatScroll.scrollHeight, behavior: "smooth" });
}

function maybeOfferKnowledgeExtraction(): void {
  const session = studyState.currentSession;
  const rounds = completedChatRoundCount();
  if (!session || rounds < 3 || rounds % 3 !== 0) return;
  const key = `${session.sessionId}:${rounds}`;
  if (!knowledgePromptStates.has(key)) {
    knowledgePromptStates.set(key, { round: rounds, decision: "pending" });
  }
  knowledgePromptedRounds.add(key);
  appendKnowledgeExtractionPrompt(rounds);
}

function renderKnowledgeCards(): void {
  for (const prompt of knowledgePromptStates.values()) {
    appendKnowledgeExtractionPrompt(prompt.round);
  }
  if (recentKnowledgeChoiceStates.size > 0) appendRecentKnowledgeChoice();
  for (const candidate of archiveCandidates.values()) {
    appendArchiveCandidateCard(candidate);
  }
  for (const candidate of recentKnowledgeCandidates.values()) {
    appendRecentKnowledgeCard(candidate);
  }
}

function updateSlashCommandMenu(): void {
  if (!slashCommandMenu) return;
  const value = chatInput.value.trimStart();
  const visible = value.startsWith("/") && !value.includes(" ");
  slashCommandMenu.hidden = !visible;
}

async function refreshArchiveCandidateCards(): Promise<PublishCandidateResponse[]> {
  const chapterId = studyState.currentSession?.chapterId;
  const sourceUrl = studyState.currentSession?.sourceUrl ?? currentSnapshot?.url;
  if (!chapterId && !sourceUrl) return [];
  const result = await getPublishCandidates();
  if (!result.ok) return [];
  const intents = await getAnnotationIntents();
  const latestIntentStates = new Map<string, string>();
  if (intents.ok) {
    for (const intent of intents.response) {
      const key = `${intent.knowledgeId}:${intent.knowledgeVersion}`;
      const previous = latestIntentStates.get(key);
      if (!previous || intent.updatedAt >= previous.split("\u0000")[0]) {
        latestIntentStates.set(key, `${intent.updatedAt}\u0000${intent.status}`);
      }
    }
  }
  chatMessages
    ?.querySelectorAll<HTMLElement>(".knowledge-archive-card:not(.knowledge-recent-card)")
    .forEach((card) => card.remove());
  archiveCandidates.clear();
  archiveCandidateIds.clear();
  const candidates = result.response
    .filter(
      (candidate) => {
        const intentState = latestIntentStates.get(
          `${candidate.knowledgeId}:${candidate.knowledgeVersion}`,
        );
        const blocked = intentState
          ? ["published", "noop", "needs_review", "pending", "applying"].includes(
              intentState.split("\u0000")[1],
            )
          : false;
        return (
          ((chapterId && candidate.chapterId === chapterId) ||
            (sourceUrl &&
              comparablePageUrl(candidate.sourceUrl) === comparablePageUrl(sourceUrl))) &&
          !blocked
        );
      },
    );
  candidates.forEach((candidate) => {
    archiveCandidates.set(`${candidate.knowledgeId}:${candidate.knowledgeVersion}`, candidate);
    appendArchiveCandidateCard(candidate);
  });
  return candidates;
}

async function loadRecentKnowledgeCandidates(): Promise<PublishCandidateResponse[]> {
  const sourceUrl = studyState.currentSession?.sourceUrl ?? currentSnapshot?.url;
  if (!sourceUrl) return [];
  const result = await getPublishCandidates();
  if (!result.ok) return [];
  return result.response.filter(
    (candidate) =>
      comparablePageUrl(candidate.sourceUrl) === comparablePageUrl(sourceUrl),
  );
}

function appendRecentKnowledgeCard(candidate: PublishCandidateResponse): void {
  if (!chatMessages) return;
  const key = `recent:${candidate.knowledgeId}:${candidate.knowledgeVersion}`;
  const existing = Array.from(
    chatMessages.querySelectorAll<HTMLElement>(".knowledge-recent-card"),
  ).some((item) => item.dataset.knowledgeKey === key);
  if (existing) return;
  recentKnowledgeCandidates.set(key, candidate);
  recentKnowledgeContentShown.add(key);
  const card = document.createElement("article");
  card.className = "knowledge-archive-card knowledge-recent-card";
  card.dataset.knowledgeKey = key;
  const title = document.createElement("h3");
  title.textContent = "最近一次提炼内容";
  const topic = document.createElement("p");
  topic.className = "knowledge-archive-topic";
  topic.textContent = `${candidate.headingPath.join(" / ")} · ${candidate.kind}`;
  const body = document.createElement("div");
  body.className = "knowledge-archive-body";
  renderMarkdownInto(body, candidate.body);
  const path = document.createElement("small");
  path.className = "knowledge-archive-path";
  path.textContent = archiveTargetDescription(candidate);
  const status = document.createElement("small");
  status.className = "knowledge-archive-status";
  status.textContent = "仅查看最近提炼内容；如需写入，请使用知识卡片中的归档按钮。";
  card.append(title, topic, body, path, status);
  chatMessages.append(card);
}

async function showRecentKnowledgeContent(choiceKey: string): Promise<void> {
  const state = recentKnowledgeChoiceStates.get(choiceKey);
  if (!state) return;
  state.decision = "shown";
  state.status = "正在加载最近一次提炼内容…";
  const candidates = await loadRecentKnowledgeCandidates();
  if (candidates.length === 0) {
    state.status = "最近一次提炼没有生成可展示的知识候选。";
    appendChatMessage({
      schemaVersion: 1,
      messageId: `local-knowledge-recent-empty-${Date.now()}`,
      role: "assistant",
      content: state.status,
      origin: "ai",
      createdAt: new Date().toISOString(),
    });
    return;
  }
  state.status = `已加载最近一次提炼的 ${candidates.length} 条知识。`;
  candidates.forEach(appendRecentKnowledgeCard);
}

function appendRecentKnowledgeChoice(): void {
  if (!chatMessages || !studyState.currentSession) return;
  const choiceKey = `${studyState.currentSession.sessionId}:recent`;
  const state = recentKnowledgeChoiceStates.get(choiceKey) ?? {
    decision: "pending" as const,
  };
  recentKnowledgeChoiceStates.set(choiceKey, state);
  const existing = Array.from(
    chatMessages.querySelectorAll<HTMLElement>(".knowledge-recent-choice"),
  ).some((item) => item.dataset.choiceKey === choiceKey);
  if (existing) return;
  const card = document.createElement("article");
  card.className = "knowledge-extraction-prompt knowledge-recent-choice";
  card.dataset.choiceKey = choiceKey;
  const title = document.createElement("h3");
  title.textContent = "没有新的可提炼知识";
  const body = document.createElement("p");
  body.textContent = "是否查看最近一次提炼的内容？";
  const actions = document.createElement("div");
  actions.className = "knowledge-archive-actions";
  const yesButton = document.createElement("button");
  yesButton.className = "btn-primary";
  yesButton.type = "button";
  yesButton.textContent = "是";
  const noButton = document.createElement("button");
  noButton.className = "btn-outline";
  noButton.type = "button";
  noButton.textContent = "否";
  const status = document.createElement("small");
  status.className = "knowledge-archive-status";
  status.textContent = state.status ?? "";
  yesButton.addEventListener("click", async () => {
    yesButton.disabled = true;
    noButton.disabled = true;
    await showRecentKnowledgeContent(choiceKey);
    status.textContent = state.status ?? "";
  });
  noButton.addEventListener("click", () => {
    state.decision = "dismissed";
    state.status = "已跳过。";
    yesButton.disabled = true;
    noButton.disabled = true;
    status.textContent = state.status;
  });
  actions.append(yesButton, noButton);
  card.append(title, body, actions, status);
  chatMessages.append(card);
}

async function handleKnowledgeCommand(question: string): Promise<boolean> {
  const intent = routeCommandIntent(question);
  if (intent.kind === "dialogue") return false;
  if (intent.kind === "invalid-command") {
    appendChatMessage({
      schemaVersion: 1,
      messageId: `local-command-invalid-${Date.now()}`,
      role: "assistant",
      content: intent.message,
      origin: "ai",
      createdAt: new Date().toISOString(),
    });
    return true;
  }
  if (intent.kind === "suggestion") {
    appendCommandSuggestionCard(intent.message, intent.correctedCommand);
    return true;
  }
  if (intent.kind === "cancel") {
    pendingArchiveCandidate = undefined;
    pendingArchiveCandidates = undefined;
    appendChatMessage({
      schemaVersion: 1,
      messageId: `local-command-cancel-${Date.now()}`,
      role: "assistant",
      content: "已取消当前归档操作。",
      origin: "ai",
      createdAt: new Date().toISOString(),
    });
    return true;
  }
  const asksToExtract = intent.kind === "extract";
  const asksToList = intent.kind === "archive-list";
  const archiveIndex = intent.kind === "archive-one" ? intent.index - 1 : undefined;
  const archiveAll = intent.kind === "archive-all";
  const confirms = intent.kind === "confirm-archive";

  if (asksToExtract) {
    const result = await requestKnowledgeExtraction();
    appendChatMessage({
      schemaVersion: 1,
      messageId: `local-knowledge-trigger-${Date.now()}`,
      role: "assistant",
      content: result.error
        ? result.error
        : result.state === "queued" || result.state === "running"
          ? "已提交本章节手动知识提炼，当前正在提炼中。完成后会显示知识卡片。"
          : result.state === "completed"
            ? "本章节对话已经完成提炼，正在加载知识卡片。"
            : result.state === "needs_review"
              ? "上次提炼需要重试，请再次输入 /提炼。"
              : "当前对话已经提炼过，没有新的对话可提炼。",
      origin: "ai",
      createdAt: new Date().toISOString(),
    });
    if (!result.error && result.state === "no_new_events") {
      appendRecentKnowledgeChoice();
    }
    ensureKnowledgeStatusPolling();
    return true;
  }

  if (confirms && !pendingArchiveCandidate && !pendingArchiveCandidates) {
    appendChatMessage({
      schemaVersion: 1,
      messageId: `local-knowledge-no-confirmation-${Date.now()}`,
      role: "assistant",
      content: "当前没有待确认的归档操作。请先输入 /归档 1 或 /归档 all。",
      origin: "ai",
      createdAt: new Date().toISOString(),
    });
    return true;
  }

  const candidates = await refreshArchiveCandidateCards();
  if (asksToList) {
    const summary = candidates.length
      ? `当前章节有 ${candidates.length} 条待归档知识。请在下方知识卡片中点击“归档到笔记”；输入 /归档 1 也可以选择第一条后再确认。`
      : "当前章节暂时没有待确认的知识候选。";
    appendChatMessage({
      schemaVersion: 1,
      messageId: `local-knowledge-list-${Date.now()}`,
      role: "assistant",
      content: summary,
      origin: "ai",
      createdAt: new Date().toISOString(),
    });
    return true;
  }

  if (archiveIndex !== undefined) {
    const index = archiveIndex;
    const candidate = candidates[index];
    if (!candidate) {
      appendChatMessage({
        schemaVersion: 1,
        messageId: `local-knowledge-missing-${Date.now()}`,
        role: "assistant",
        content: `当前没有第 ${index + 1} 条待归档知识。`,
        origin: "ai",
        createdAt: new Date().toISOString(),
      });
      return true;
    }
    pendingArchiveCandidate = candidate;
    pendingArchiveCandidates = undefined;
    appendChatMessage({
      schemaVersion: 1,
      messageId: `local-knowledge-confirm-${Date.now()}`,
      role: "assistant",
      content: `已选中第 ${index + 1} 条知识：\n\n${candidate.body}\n\n${archiveTargetDescription(candidate)}\n\n确认后将写入上述文件，请回复“确认归档”。`,
      origin: "ai",
      createdAt: new Date().toISOString(),
    });
    return true;
  }

  if (archiveAll) {
    if (candidates.length === 0) {
      appendChatMessage({
        schemaVersion: 1,
        messageId: `local-knowledge-all-missing-${Date.now()}`,
        role: "assistant",
        content: "当前章节没有可归档的知识候选。",
        origin: "ai",
        createdAt: new Date().toISOString(),
      });
      return true;
    }
    pendingArchiveCandidate = undefined;
    pendingArchiveCandidates = candidates;
    const targets = candidates
      .map((candidate, index) => `${index + 1}. ${archiveTargetDescription(candidate)}`)
      .join("\n");
    appendChatMessage({
      schemaVersion: 1,
      messageId: `local-knowledge-all-confirm-${Date.now()}`,
      role: "assistant",
      content: `已选择全部 ${candidates.length} 条知识候选：\n\n${targets}\n\n确认后将逐条写入上述文件，请回复“确认归档”。`,
      origin: "ai",
      createdAt: new Date().toISOString(),
    });
    return true;
  }

  if (pendingArchiveCandidate) {
    const candidate = pendingArchiveCandidate;
    const result = await commitAnnotation(candidate.knowledgeId, candidate.knowledgeVersion);
    appendChatMessage({
      schemaVersion: 1,
      messageId: `local-knowledge-commit-${Date.now()}`,
      role: "assistant",
      content: result.ok && result.response.status === "published"
        ? "已确认，知识已归档到当前笔记。"
        : result.ok && result.response.status === "noop"
          ? "这条知识已经归档过了，无需重复写入。"
          : result.ok
            ? "当前来源发生变化，暂未写入；请重新采集并保存章节。"
            : result.error.message,
      origin: "ai",
      createdAt: new Date().toISOString(),
    });
    if (result.ok) pendingArchiveCandidate = undefined;
    return true;
  }
  if (pendingArchiveCandidates) {
    const candidatesToCommit = pendingArchiveCandidates;
    pendingArchiveCandidates = undefined;
    const results: string[] = [];
    for (const [index, candidate] of candidatesToCommit.entries()) {
      const result = await commitAnnotation(
        candidate.knowledgeId,
        candidate.knowledgeVersion,
      );
      const status = result.ok
        ? result.response.status === "published"
          ? "已归档"
          : result.response.status === "noop"
            ? "已存在"
            : "需要检查"
        : `失败：${result.error.message}`;
      results.push(`${index + 1}. ${status}`);
    }
    appendChatMessage({
      schemaVersion: 1,
      messageId: `local-knowledge-all-commit-${Date.now()}`,
      role: "assistant",
      content: `批量归档完成：\n\n${results.join("\n")}`,
      origin: "ai",
      createdAt: new Date().toISOString(),
    });
    return true;
  }
  return true;
}

function renderChatMessages(messages: StudyMessage[]): void {
  if (!chatMessages) return;
  chatMessages.replaceChildren();
  messages.forEach((message) => appendChatMessage(message));
  maybeOfferKnowledgeExtraction();
  renderKnowledgeCards();
}

async function loadStudyConversationForState(expectedKey?: string): Promise<void> {
  const session = studyState.currentSession;
  const conversationId = session ? conversationIdForSession(session.sessionId) : undefined;
  const generation = ++chatLoadGeneration;

  // A background capture can broadcast a state update while a Study Chat
  // response is streaming. Keep the optimistic messages visible until the
  // stream finishes; clearing the container here used to erase both turns.
  if (chatBusy) {
    pendingChatLoadKey = expectedKey;
    return;
  }

  pendingChatLoadKey = undefined;
  chatConversationId = conversationId;
  if (!conversationId || !currentSnapshot) {
    if (chatMessages) chatMessages.replaceChildren();
    chatLoadedKey = expectedKey;
    updateWorkspaceAvailability();
    return;
  }
  const result = await getStudyConversation(conversationId);
  if (generation !== chatLoadGeneration || chatConversationId !== conversationId) return;
  if (chatBusy) {
    if (chatLoadedKey !== expectedKey) {
      pendingChatLoadKey = expectedKey;
    }
    return;
  }
  if (result.ok) {
    renderChatMessages(result.response.messages);
    void refreshArchiveCandidateCards();
    chatLoadedKey = expectedKey;
    chatUnavailableStatus.textContent = result.response.messages.length
      ? "已恢复当前章节会话；你可以继续追问。"
      : "当前章节已准备好；发送时会自动引用当前选区。";
  } else if (result.error.code === "CONVERSATION_NOT_FOUND") {
    if (chatMessages) chatMessages.replaceChildren();
    chatLoadedKey = expectedKey;
    chatUnavailableStatus.textContent = "当前章节已准备好；发送时会自动引用当前选区。";
  } else if (result.error.code !== "NO_TOKEN") {
    chatUnavailableStatus.textContent = result.error.message;
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
  const hasChatContext = available && Boolean(studyState.currentSession);
  organizeNoteButton.disabled = !available || isNoteBusy();
  documentV2PreviewButton.disabled =
    !available ||
    documentPreviewBusyRequestId !== undefined ||
    documentCommitBusyRequestId !== undefined;
  documentV2CommitButton.disabled =
    !activeDocumentProposalId || documentCommitBusyRequestId !== undefined;
  aiAnnotateButton.disabled = false;
  chatSendButton.disabled =
    !hasChatContext || !chatInput.value.trim() || chatBusy;
  chatInput.disabled = !hasChatContext || chatBusy;
  if (composerCaptionText) {
    composerCaptionText.textContent = !hasChatContext
      ? "等待当前章节采集"
      : "会发送到 DeepSeek；当前选区会自动引用";
  }
  emptyNoteHint.textContent = available
    ? "无需逐个勾选内容块。原文整理会保留当前已采集的全部有效内容，并先生成预览。"
    : studyState.enabled
      ? "正在等待当前章节采集完成；采集成功后这里会启用原文整理。"
      : "请先在当前教程网站启用学习模式，等待章节采集完成后再整理原文。";
  if (!available) {
    chatUnavailableStatus.textContent = "等待当前章节采集后，对话上下文将显示在这里。";
  }
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

async function requestCaptureFromUser(): Promise<void> {
  if (studyActionBusy) return;
  const currentOriginAuthorized = Boolean(
    currentStudyTabOrigin &&
      (studyState.authorizedOrigins?.includes(currentStudyTabOrigin) ||
        studyState.authorizedOrigin === currentStudyTabOrigin),
  );
  const sameAuthorizedOrigin =
    studyState.enabled &&
    currentOriginAuthorized &&
    (!studyState.activeOrigin || studyState.activeOrigin === currentStudyTabOrigin);
  if (sameAuthorizedOrigin) {
    await captureCurrentPage();
    return;
  }
  if (typeof chrome.permissions?.request !== "function") {
    await captureCurrentPage();
    return;
  }
  await enableStudyMode();
}

async function refreshStudyPermissionStatus(): Promise<void> {
  try {
    const context: unknown = await chrome.runtime.sendMessage({
      type: STUDY_GET_TAB_CONTEXT_REQUEST,
    });
    const contextValue =
      typeof context === "object" &&
      context !== null &&
      "ok" in context &&
      context.ok === true &&
      "value" in context &&
      typeof context.value === "object" &&
      context.value !== null
        ? context.value
        : undefined;
    const currentUrl =
      contextValue &&
      "url" in contextValue &&
      typeof contextValue.url === "string"
        ? contextValue.url
        : undefined;
    currentStudyTabOrigin = currentUrl ? new URL(currentUrl).origin : undefined;
    const contextHasPermission =
      contextValue &&
      "hasPermission" in contextValue &&
      contextValue.hasPermission === true;

    const rememberedOrigin = Boolean(
      currentStudyTabOrigin &&
      (studyState.authorizedOrigins?.includes(currentStudyTabOrigin) ||
        studyState.authorizedOrigin === currentStudyTabOrigin),
    );
    const liveStudyOnCurrentTab = Boolean(
      studyState.enabled &&
        studyState.status !== "DISABLED" &&
        rememberedOrigin &&
        (!studyState.activeOrigin ||
          studyState.activeOrigin === currentStudyTabOrigin),
    );
    if (currentStudyTabOrigin && !rememberedOrigin && !contextHasPermission) {
      studyEnableButton.hidden = false;
      studyEnableButton.textContent = "授权并采集当前页面";
      studyPauseButton.hidden = true;
      studyRevokeButton.hidden = true;
      studyStatus.textContent = "当前网站尚未授权";
      studyChapter.textContent = "请授权当前教程网站后开始学习";
      studyError.hidden = false;
      studyError.textContent = "当前网站尚未授权，请点击按钮授权后开始学习。";
    } else if (currentStudyTabOrigin && (rememberedOrigin || contextHasPermission)) {
      studyEnableButton.hidden = liveStudyOnCurrentTab;
      studyPauseButton.hidden = !liveStudyOnCurrentTab;
      studyEnableButton.textContent = "采集当前页面";
      if (!liveStudyOnCurrentTab) {
        studyStatus.textContent = "当前网站已授权，点击即可继续采集";
      }
      if (!liveStudyOnCurrentTab) {
        studyChapter.textContent = "恢复此网站的学习模式";
      }
      if (!liveStudyOnCurrentTab) {
        studyError.hidden = true;
      }
    }

    if (currentStudyTabOrigin && currentStudyTabOrigin !== STUDY_SITE_ORIGIN) {
      studyPermissionStatus.textContent =
        rememberedOrigin || contextHasPermission
          ? "当前网站已授权；Study Chat 会发送当前章节上下文。"
          : contextHasPermission
            ? "当前网页已获得临时访问权；点击授权按钮开始学习。"
            : "当前网站尚未授权；请通过扩展工具栏打开侧边栏后授权。";
      return;
    }
    const granted = await chrome.permissions.contains({
      origins: [STUDY_SITE_HOST_PERMISSION],
    });
    studyPermissionStatus.textContent = granted
      ? "FastAPI 教程站点已授权；Study Chat 会发送当前章节上下文。"
      : "当前 FastAPI 教程站点尚未授权；网页采集权限与 Study Chat 发送目标独立。";
  } catch {
    studyPermissionStatus.textContent =
      "无法读取站点权限；请通过按钮重新检查。";
  }
}

function showKnowledgeToast(message: string): void {
  if (!toast) return;
  if (knowledgeToastTimer !== undefined) window.clearTimeout(knowledgeToastTimer);
  toast.textContent = message;
  toast.classList.add("show");
  knowledgeToastTimer = window.setTimeout(() => {
    toast.classList.remove("show");
  }, 5_000);
}

function knowledgeErrorMessage(code: string | null | undefined): string {
  switch (code) {
    case "knowledge_invalid_output":
      return "模型返回格式不符合要求";
    case "knowledge_output_truncated":
      return "模型输出超过 Token 上限并被截断";
    case "knowledge_unknown_evidence":
      return "引用了不存在的来源证据";
    case "knowledge_missing_fact_evidence":
      return "事实知识缺少教程证据";
    case "knowledge_missing_user_evidence":
      return "个人理解缺少用户消息依据";
    case "lease_expired":
      return "后台 Worker 租约已过期";
    default:
      return code ?? "未知错误";
  }
}

function knowledgeJobMessage(job: {
  state: string;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
}): string {
  if (job.state === "completed") return "最近一批知识提炼已完成";
  if (job.state === "skipped") return "最近一批对话没有值得沉淀的知识";
  if (job.state === "running") return "知识提炼处理中";
  if (job.state === "queued") return "知识提炼已排队";
  if (job.state === "retryable_failed") return "知识提炼暂时失败，将自动重试";
  if (job.state === "blocked_consent") return "旧版知识提炼任务等待授权迁移";
  if (job.state === "needs_review") {
    return job.lastErrorCode
      ? `知识提炼失败，需要检查：${job.lastErrorMessage ?? knowledgeErrorMessage(job.lastErrorCode)}`
      : "知识提炼完成，但草稿需要检查";
  }
  return "知识提炼任务已创建";
}

async function refreshKnowledgeJobs(): Promise<void> {
  const result = await getKnowledgeJobs();
  if (!result.ok || result.response.length === 0) return;
  const latest = result.response[0];
  const previousState = knowledgeJobStates.get(latest.jobId);
  knowledgeJobStates.set(latest.jobId, latest.state);
  if (
    previousState !== undefined &&
    previousState !== latest.state &&
    ["completed", "skipped", "needs_review"].includes(latest.state)
  ) {
    showKnowledgeToast(knowledgeJobMessage(latest));
  }
  if (latest.state === "completed") await refreshArchiveCandidateCards();
}

function ensureKnowledgeStatusPolling(): void {
  if (knowledgePollTimer !== undefined) return;
  void refreshKnowledgeJobs();
  knowledgePollTimer = window.setInterval(() => {
    void refreshKnowledgeJobs();
  }, 5_000);
}

function isSelectionResponse(value: unknown): value is {
  ok: true;
  selection: PageSelection;
} {
  if (typeof value !== "object" || value === null || !("ok" in value)) return false;
  if (value.ok !== true || !("selection" in value)) return false;
  const selection = value.selection;
  return (
    typeof selection === "object" &&
    selection !== null &&
    "text" in selection &&
    typeof selection.text === "string" &&
    selection.text.trim().length > 0 &&
    "sourceUrl" in selection &&
    typeof selection.sourceUrl === "string" &&
    "headingPath" in selection &&
    Array.isArray(selection.headingPath) &&
    selection.headingPath.every((item) => typeof item === "string") &&
    "sourceFingerprint" in selection &&
    typeof selection.sourceFingerprint === "string"
  );
}

async function readCurrentSelection(): Promise<PageSelection | undefined> {
  if (!currentSnapshot || !studyState.currentSession) return undefined;
  try {
    const response: unknown = await chrome.runtime.sendMessage({
      type: PAGE_SELECTION_REQUEST,
    });
    if (!isSelectionResponse(response)) {
      return undefined;
    }
    if (
      comparablePageUrl(response.selection.sourceUrl) !==
      comparablePageUrl(currentSnapshot.url)
    ) {
      chatUnavailableStatus.textContent = "当前选区不属于正在学习的章节，本次未引用选区。";
      return undefined;
    }
    return response.selection;
  } catch {
    return undefined;
  }
}

async function sendStudyMessage(): Promise<void> {
  const session = studyState.currentSession;
  if (!currentSnapshot || !session || chatBusy) return;
  const question = chatInput.value.trim();
  if (!question) return;
  chatBusy = true;
  updateWorkspaceAvailability();
  const selection = await readCurrentSelection();
  const conversationId = conversationIdForSession(session.sessionId);
  chatConversationId = conversationId;
  chatLoadedKey = `${conversationId}\u0000${snapshotViewKey(currentSnapshot)}`;
  const payload: StudyChatPayload = {
    schemaVersion: 1,
    conversationId,
    sessionId: session.sessionId,
    sourceUrl: session.sourceUrl,
    pageTitle: session.pageTitle,
    headingPath: selection?.headingPath ?? [],
    sourceNodeId: selection?.sourceNodeId,
    sourceFingerprint: selection?.sourceFingerprint,
    selectedText: selection?.text,
    question,
    cloudConsent: true,
    snapshot: currentSnapshot,
  };
  chatInput.value = "";
  updateWorkspaceAvailability();
  const userMessage: StudyMessage = {
    schemaVersion: 1,
    messageId: `pending-user-${Date.now()}`,
    role: "user",
    content: question,
    selectedText: selection?.text,
    source: selection
      ? {
          sourceUrl: selection.sourceUrl,
          headingPath: selection.headingPath,
          sourceNodeId: selection.sourceNodeId,
          sourceFingerprint: selection.sourceFingerprint,
        }
      : undefined,
    origin: "user",
    createdAt: new Date().toISOString(),
  };
  appendChatMessage(userMessage);
  if (await handleKnowledgeCommand(question)) {
    chatBusy = false;
    updateWorkspaceAvailability();
    return;
  }
  const assistantNode = appendChatMessage({
    schemaVersion: 1,
    messageId: `pending-assistant-${Date.now()}`,
    role: "assistant",
    content: "",
    origin: "ai",
    createdAt: new Date().toISOString(),
  });
  const assistantBody = assistantNode?.querySelector<HTMLElement>(".chat-message-body");
  const controller = new AbortController();
  chatAbortController = controller;
  let streamedAnswer = "";
  try {
    const result = await streamStudyChat(
      payload,
      (delta) => {
        streamedAnswer += delta;
        if (assistantBody) assistantBody.textContent = streamedAnswer;
      },
      controller.signal,
    );
    if (chatConversationId !== conversationId) return;
    if (!result.ok) {
      if (assistantBody) assistantBody.textContent = result.error.message;
      chatUnavailableStatus.textContent = result.error.message;
      return;
    }
    if (assistantBody) {
      renderMarkdownInto(assistantBody, result.response.message.content);
    }
    chatUnavailableStatus.textContent = "回答已保存到当前章节会话，可以继续追问。";
    maybeOfferKnowledgeExtraction();
  } finally {
    if (chatAbortController === controller) chatAbortController = undefined;
    chatBusy = false;
    updateWorkspaceAvailability();
    if (pendingChatLoadKey !== undefined) {
      const expectedKey = pendingChatLoadKey;
      pendingChatLoadKey = undefined;
      void loadStudyConversationForState(expectedKey);
    }
  }
}

async function loadStudyUi(): Promise<void> {
  const revisionAtStart = studyStateRevision;
  const loadedState = await loadStudyState();
  if (revisionAtStart === studyStateRevision) {
    renderStudyState(loadedState);
  }
}

function sendStudyAction(
  type: typeof STUDY_ENABLE_REQUEST | typeof STUDY_PAUSE_REQUEST | typeof STUDY_REVOKE_REQUEST,
): Promise<StudyActionResult> {
  return chrome.runtime.sendMessage({ type }) as Promise<StudyActionResult>;
}

async function enableStudyMode(): Promise<boolean> {
  if (studyActionBusy) return false;
  studyActionBusy = true;
  studyEnableButton.disabled = true;
  studyStatus.textContent = "正在请求站点访问权限…";
  try {
    let currentOrigin: string = STUDY_SITE_ORIGIN;
    const context = await chrome.runtime.sendMessage({
      type: STUDY_GET_TAB_CONTEXT_REQUEST,
    });
    if (
      context &&
      context.ok === true &&
      context.value &&
      typeof context.value.url === "string"
    ) {
      currentOrigin = new URL(context.value.url).origin;
    }

    const permissionOrigin = currentOrigin === STUDY_SITE_ORIGIN
      ? STUDY_SITE_HOST_PERMISSION
      : `${currentOrigin}/*`;
    const granted = await chrome.permissions.request({
      origins: [permissionOrigin],
    });
    if (!granted) {
      studyStatus.textContent = "未获得站点访问权限，自动学习未启用";
      return false;
    }
    const response = await sendStudyAction(STUDY_ENABLE_REQUEST);
    if (!response.ok) {
      studyStatus.textContent = response.error.message;
      return false;
    }
    renderStudyState(response.value);
    await refreshStudyPermissionStatus();
    return true;
  } catch {
    studyStatus.textContent = "站点授权失败，自动学习未启用";
    return false;
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
    const fastApiAuthorized =
      studyState.authorizedOrigin === STUDY_SITE_ORIGIN ||
      studyState.authorizedOrigins?.includes(STUDY_SITE_ORIGIN);
    if (fastApiAuthorized) {
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

function invalidateDocumentPreview(status = "需要先采集当前章节"): void {
  documentPreviewGeneration += 1;
  activeDocumentProposalId = undefined;
  documentPreviewBusyRequestId = undefined;
  documentCommitBusyRequestId = undefined;
  documentV2PreviewPanel.hidden = true;
  documentV2Status.textContent = status;
  documentV2Action.textContent = "";
  documentV2Path.textContent = "";
  documentV2Source.textContent = "";
  documentV2Diagnostics.textContent = "";
  documentExportDiagnosticsButton.hidden = true;
  latestDocumentDiagnostics = undefined;
  latestDocumentSource = "";
  documentV2Markdown.textContent = "";
  documentV2Diff.textContent = "";
  documentV2CommitButton.disabled = true;
  documentV2CommitButton.hidden = true;
  documentV2CommitStatus.textContent = "请先生成预览";
  updateWorkspaceAvailability();
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

function renderSnapshot(snapshot: PageSnapshot, fromStudyNavigation = false): void {
  const preview = snapshot.blocks.map((block) => block.text).join("\n\n");
  invalidateNoteProposal("当前章节已更新，需要重新生成预览");
  invalidateDocumentPreview("当前章节已更新，需要重新生成预览");
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
  documentV2Status.textContent = "可以整理并保存当前章节";
  if (fromStudyNavigation) {
    setWorkspaceTab("chat");
  }
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
  invalidateDocumentPreview("需要先采集当前章节");
  emptyNote.classList.remove("hide");
  noteDocument.classList.add("hide");
  notesState.textContent = "尚未生成";
  noteCount.textContent = "0";
  setWorkspaceTab("chat");
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
  invalidateDocumentPreview("当前章节采集失败，无法生成预览");
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
  invalidateDocumentPreview("正在等待当前章节重新采集");
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

async function legacyOrganizeCurrentChapter(): Promise<void> {
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

async function previewCurrentDocumentV2(): Promise<void> {
  if (
    !currentSnapshot ||
    currentSnapshot.blocks.length === 0 ||
    documentPreviewBusyRequestId !== undefined
  ) {
    noteActionStatus.hidden = false;
    noteActionStatus.textContent = currentSnapshot
      ? "当前章节没有可整理的内容。"
      : "当前章节尚未采集完成，暂时不能整理笔记。";
    updateWorkspaceAvailability();
    return;
  }

  const startedFromChat = chatView.classList.contains("active");
  const snapshot = currentSnapshot;
  const sourceMismatch = await currentPageMismatch(snapshot);
  if (sourceMismatch) {
    noteActionStatus.hidden = false;
    noteActionStatus.textContent = `整理失败：${sourceMismatch}`;
    return;
  }
  const generation = documentPreviewGeneration;
  const requestId = ++documentPreviewRequestSequence;
  documentPreviewBusyRequestId = requestId;
  activeDocumentProposalId = undefined;
  documentV2PreviewPanel.hidden = false;
  documentV2Status.textContent = "正在生成预览…";
  documentV2Source.textContent = "";
  documentV2Action.textContent = "";
  documentV2Path.textContent = "";
  documentV2Diagnostics.textContent = "";
  documentExportDiagnosticsButton.hidden = true;
  latestDocumentDiagnostics = undefined;
  latestDocumentSource = "";
  documentV2Markdown.textContent = "";
  documentV2Diff.textContent = "";
  documentV2CommitStatus.textContent = "正在等待预览…";
  documentV2CommitButton.disabled = true;
  documentV2CommitButton.hidden = false;
  noteActionStatus.hidden = !startedFromChat;
  if (startedFromChat) {
    noteActionStatus.textContent = "正在生成预览…请稍候。";
  }
  updateWorkspaceAvailability();

  try {
    const response = (await chrome.runtime.sendMessage({
      type: DOCUMENT_PREVIEW_REQUEST,
      snapshot,
    })) as DocumentPreviewResult | undefined;
    if (
      generation !== documentPreviewGeneration ||
      documentPreviewBusyRequestId !== requestId
    ) {
      return;
    }
    if (!response) {
      documentV2Status.textContent = "未收到本地服务响应，请确认 FastAPI 已启动后重试。";
      documentV2CommitStatus.textContent = "预览失败，无法保存";
      noteActionStatus.hidden = false;
      noteActionStatus.textContent =
        "预览失败：未收到本地服务响应，请确认 FastAPI 已启动。";
      return;
    }
    if (!response.ok) {
      documentV2Status.textContent = response.error.message;
      documentV2CommitStatus.textContent = "预览失败，无法保存";
      noteActionStatus.hidden = false;
      noteActionStatus.textContent = `整理失败：${response.error.message}。请点击“我的笔记”查看详细状态。`;
      return;
    }
    const diagnostics = response.response.diagnostics;
    activeDocumentProposalId = response.response.proposalId;
    documentV2Action.textContent = `动作：${response.response.action}`;
    documentV2Path.textContent = `目标：${response.response.targetRelativePath}`;
    documentV2Source.textContent = `来源：${response.response.sourceUrl}`;
    latestDocumentDiagnostics = response.response.diagnostics;
    latestDocumentSource = response.response.sourceUrl;
    documentExportDiagnosticsButton.hidden = false;
    documentV2Diagnostics.textContent = [
      `已整理 ${diagnostics.renderedBlockCount} 个内容块`,
      diagnostics.filteredBlockCount
        ? `过滤 ${diagnostics.filteredBlockCount} 个重复标题`
        : "",
      diagnostics.unsupportedBlockCount
        ? `未支持 ${diagnostics.unsupportedBlockCount} 个内容块`
        : "",
      diagnostics.truncated ? "来源快照已截断" : "",
      ...diagnostics.warnings,
    ]
      .filter(Boolean)
      .join(" · ");
    documentV2Markdown.textContent = response.response.markdownPreview;
    documentV2Diff.textContent = response.response.diff || "无变更";
    documentV2Status.textContent = "预览已生成";
    documentV2CommitStatus.textContent =
      response.response.action === "noop" ? "当前内容无需写入" : "请确认后保存笔记";
    documentV2CommitButton.disabled = response.response.action === "noop";
    documentV2CommitButton.hidden = response.response.action === "noop";
    noteActionStatus.hidden = false;
    noteActionStatus.textContent =
      response.response.action === "noop"
        ? "当前内容无需保存；可点击“我的笔记”查看预览。"
        : "预览已生成；可点击“我的笔记”查看内容并确认保存。";
    documentV2PreviewPanel.hidden = false;
  } catch {
    if (
      generation === documentPreviewGeneration &&
      documentPreviewBusyRequestId === requestId
    ) {
      documentV2Status.textContent =
        "无法连接本地服务；请启动 FastAPI、配置 Token 后重试。";
      documentV2CommitStatus.textContent = "预览失败，无法保存";
      noteActionStatus.hidden = false;
      noteActionStatus.textContent =
        "整理失败：无法连接本地服务，请启动 FastAPI、配置 Token 和 Vault 后重试。";
    }
  } finally {
    if (documentPreviewBusyRequestId === requestId) {
      documentPreviewBusyRequestId = undefined;
      updateWorkspaceAvailability();
    }
  }
}

async function commitDocumentV2(): Promise<void> {
  if (!activeDocumentProposalId || documentCommitBusyRequestId !== undefined) {
    return;
  }
  const generation = documentPreviewGeneration;
  const proposalId = activeDocumentProposalId;
  const requestId = ++documentPreviewRequestSequence;
  documentCommitBusyRequestId = requestId;
  documentV2CommitButton.disabled = true;
  documentV2CommitStatus.textContent = "保存中…";
  try {
    const response = (await chrome.runtime.sendMessage({
      type: DOCUMENT_COMMIT_REQUEST,
      proposalId,
    })) as DocumentCommitResult | undefined;
    if (
      generation !== documentPreviewGeneration ||
      documentCommitBusyRequestId !== requestId
    ) {
      return;
    }
    if (!response) {
      documentV2CommitStatus.textContent = "未收到保存响应，请重试。";
      return;
    }
    if (!response.ok) {
      if (
        response.error.code === "NOTE_CONFLICT" ||
        response.error.code === "PROPOSAL_EXPIRED"
      ) {
        invalidateDocumentPreview(response.error.message);
        return;
      }
      documentV2CommitStatus.textContent = response.error.message;
      return;
    }
    documentV2CommitStatus.textContent = `已保存：${response.response.status}`;
    documentV2Status.textContent = "笔记已保存";
    documentV2CommitButton.hidden = true;
    noteActionStatus.hidden = false;
    noteActionStatus.textContent = "笔记已保存；当前仍停留在学习对话。";
    activeDocumentProposalId = undefined;
  } catch {
    if (
      generation === documentPreviewGeneration &&
      documentCommitBusyRequestId === requestId
    ) {
      documentV2CommitStatus.textContent = "保存请求失败，请重试。";
    }
  } finally {
    if (documentCommitBusyRequestId === requestId) {
      documentCommitBusyRequestId = undefined;
      updateWorkspaceAvailability();
    }
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

captureButton.addEventListener("click", () => void requestCaptureFromUser());
saveTokenButton.addEventListener("click", () => void saveToken());
sendButton.addEventListener("click", () => void sendCurrentSnapshot());
chatSendButton.addEventListener("click", () => void sendStudyMessage());
chatInput.addEventListener("input", () => {
  updateWorkspaceAvailability();
  updateSlashCommandMenu();
});
chatInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    void sendStudyMessage();
  }
});
slashCommandMenu?.querySelectorAll<HTMLButtonElement>("[data-slash-command]").forEach((button) => {
  button.addEventListener("click", () => {
    chatInput.value = `/${button.dataset.slashCommand ?? ""} `;
    slashCommandMenu.hidden = true;
    chatInput.focus();
    updateWorkspaceAvailability();
  });
});
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
documentV2PreviewButton.addEventListener("click", () => void previewCurrentDocumentV2());
documentV2CommitButton.addEventListener("click", () => void commitDocumentV2());
documentExportDiagnosticsButton.addEventListener("click", () => {
  if (!latestDocumentDiagnostics) return;
  const payload = JSON.stringify(
    {
      sourceUrl: latestDocumentSource,
      diagnostics: latestDocumentDiagnostics,
    },
    null,
    2,
  );
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
  link.download = "learnflow-quality-diagnostics.json";
  link.click();
  URL.revokeObjectURL(link.href);
});

studyEnableButton.addEventListener("click", () => void requestCaptureFromUser());
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
    void (actionButton.id === "organize-note-button"
      ? legacyOrganizeCurrentChapter()
      : previewCurrentDocumentV2());
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
  if (!settingsPanel.hidden) {
    void refreshStudyPermissionStatus();
  }
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
