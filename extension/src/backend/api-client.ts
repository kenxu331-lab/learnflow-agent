import { isPageSnapshot } from "../capture/capture-service";
import type { PageSnapshot } from "../capture/types";
import type {
  BackendClientFailure,
  BackendClientResult,
  BackendIngestResponse,
  AIRecommendationResponse,
  AIRecommendationResult,
  AIRecommendationItem,
  NoteClientResult,
  NoteCommitResponse,
  NotePreviewResponse,
  DocumentPreviewResponse,
  DocumentPreviewResult,
  DocumentCommitResponse,
  DocumentCommitResult,
  StudyChatComplete,
  StudyChatPayload,
  StudyChatResult,
  StudyConversationResponse,
  StudyConversationResult,
  StudyMessage,
  KnowledgeConsentResponse,
  KnowledgeConsentResult,
  KnowledgeJobResponse,
  KnowledgeJobsResult,
  KnowledgeTriggerResponse,
  KnowledgeTriggerResult,
  KnowledgeStatusResponse,
  KnowledgeStatusResult,
  AnnotationConsentResponse,
  AnnotationConsentResult,
  AnnotationIntentResponse,
  AnnotationIntentsResult,
  PublishCandidateResponse,
  PublishCandidatesResult,
  AnnotationCommitResponse,
  AnnotationCommitResult,
} from "./types";

export const LOCAL_INGEST_URL =
  "http://127.0.0.1:8000/api/v1/pages/ingest";
export const LOCAL_NOTE_PREVIEW_URL =
  "http://127.0.0.1:8000/api/v1/notes/preview";
export const LOCAL_NOTE_COMMIT_URL =
  "http://127.0.0.1:8000/api/v1/notes/commit";
export const LOCAL_AI_RECOMMEND_URL =
  "http://127.0.0.1:8000/api/v1/ai/notes/recommend";
export const LOCAL_DOCUMENT_PREVIEW_URL =
  "http://127.0.0.1:8000/api/v1/documents/preview";
export const LOCAL_DOCUMENT_COMMIT_URL =
  "http://127.0.0.1:8000/api/v1/documents/commit";
export const LOCAL_ANNOTATION_URL =
  "http://127.0.0.1:8000/api/v1/annotations";
export const LOCAL_STUDY_CHAT_URL = "http://127.0.0.1:8000/api/v1/study/chat";
export const LOCAL_STUDY_CONVERSATION_URL =
  "http://127.0.0.1:8000/api/v1/study/conversations";
export const LOCAL_KNOWLEDGE_URL = "http://127.0.0.1:8000/api/v1/knowledge";
export const BACKEND_TIMEOUT_MS = 10_000;
export const AI_BACKEND_TIMEOUT_MS = 75_000;

function failure(
  code: BackendClientFailure["error"]["code"],
  message: string,
): BackendClientFailure {
  return { ok: false, error: { code, message } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNoteAction(value: unknown): value is NotePreviewResponse["action"] {
  return value === "create" || value === "append" || value === "noop";
}

function isNoteStatus(value: unknown): value is NoteCommitResponse["status"] {
  return value === "created" || value === "updated" || value === "unchanged";
}

function isRecommendationCategory(value: unknown): value is AIRecommendationItem["category"] {
  return (
    value === "core_concept" ||
    value === "code_example" ||
    value === "important_detail" ||
    value === "pitfall"
  );
}

function isAIRecommendationResponse(
  value: unknown,
): value is AIRecommendationResponse {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.analysis)) {
    return false;
  }
  if (
    typeof value.analysis.model !== "string" ||
    typeof value.analysis.analyzedBlockCount !== "number" ||
    !Number.isSafeInteger(value.analysis.analyzedBlockCount) ||
    value.analysis.analyzedBlockCount < 0 ||
    typeof value.analysis.truncated !== "boolean" ||
    !Array.isArray(value.recommendations) ||
    value.recommendations.length > 12
  ) {
    return false;
  }
  return value.recommendations.every(
    (item) =>
      isRecord(item) &&
      typeof item.blockId === "string" &&
      item.blockId.trim().length > 0 &&
      isRecommendationCategory(item.category) &&
      typeof item.reason === "string" &&
      item.reason.trim().length > 0,
  );
}

function isBackendIngestResponse(value: unknown): value is BackendIngestResponse {
  if (!isRecord(value) || !isRecord(value.stats)) {
    return false;
  }
  return (
    value.status === "validated" &&
    typeof value.requestId === "string" &&
    value.requestId.trim().length > 0 &&
    value.schemaVersion === 1 &&
    isNonNegativeSafeInteger(value.stats.characterCount) &&
    isNonNegativeSafeInteger(value.stats.codeBlockCount) &&
    isNonNegativeSafeInteger(value.stats.blockCount)
  );
}

function isNotePreviewResponse(value: unknown): value is NotePreviewResponse {
  return (
    isRecord(value) &&
    typeof value.proposalId === "string" &&
    value.proposalId.trim().length > 0 &&
    isNoteAction(value.action) &&
    typeof value.noteId === "string" &&
    value.noteId.trim().length > 0 &&
    typeof value.targetRelativePath === "string" &&
    value.targetRelativePath.trim().length > 0 &&
    typeof value.markdownPreview === "string" &&
    typeof value.diff === "string" &&
    (value.expectedRevision === null ||
      (typeof value.expectedRevision === "string" &&
        value.expectedRevision.trim().length > 0)) &&
    typeof value.expiresAt === "string" &&
    value.expiresAt.trim().length > 0
  );
}

function isNoteCommitResponse(value: unknown): value is NoteCommitResponse {
  return (
    isRecord(value) &&
    isNoteStatus(value.status) &&
    typeof value.noteId === "string" &&
    value.noteId.trim().length > 0 &&
    typeof value.targetRelativePath === "string" &&
    value.targetRelativePath.trim().length > 0 &&
    typeof value.revision === "string" &&
    value.revision.trim().length > 0
  );
}

function isDocumentPreviewResponse(
  value: unknown,
): value is DocumentPreviewResponse {
  if (
    !isRecord(value) ||
    value.status !== "preview" ||
    value.schemaVersion !== 2 ||
    typeof value.proposalId !== "string" ||
    value.proposalId.trim().length === 0 ||
    !["create", "replace", "noop"].includes(value.action as string) ||
    typeof value.noteId !== "string" ||
    value.noteId.trim().length === 0 ||
    typeof value.targetRelativePath !== "string" ||
    value.targetRelativePath.trim().length === 0 ||
    typeof value.diff !== "string" ||
    (value.expectedRevision !== null && typeof value.expectedRevision !== "string") ||
    typeof value.expiresAt !== "string" ||
    value.expiresAt.trim().length === 0 ||
    typeof value.title !== "string" ||
    typeof value.sourceUrl !== "string" ||
    typeof value.markdownPreview !== "string" ||
    !isRecord(value.diagnostics)
  ) {
    return false;
  }
  const diagnostics = value.diagnostics;
  return (
    isNonNegativeSafeInteger(diagnostics.renderedBlockCount) &&
    isNonNegativeSafeInteger(diagnostics.filteredBlockCount) &&
    isNonNegativeSafeInteger(diagnostics.unsupportedBlockCount) &&
    typeof diagnostics.truncated === "boolean" &&
    Array.isArray(diagnostics.warnings) &&
    diagnostics.warnings.every((warning) => typeof warning === "string") &&
    (diagnostics.qualityStatus === "ok" ||
      diagnostics.qualityStatus === "warning" ||
      diagnostics.qualityStatus === "blocked") &&
    Array.isArray(diagnostics.issues) &&
    diagnostics.issues.every(
      (issue) =>
        isRecord(issue) &&
        (issue.severity === "warning" || issue.severity === "blocking") &&
        typeof issue.code === "string" &&
        typeof issue.message === "string" &&
        isRecord(issue.evidence),
    )
  );
}

function isDocumentCommitResponse(
  value: unknown,
): value is DocumentCommitResponse {
  return (
    isRecord(value) &&
    isNoteStatus(value.status) &&
    typeof value.noteId === "string" &&
    value.noteId.trim().length > 0 &&
    typeof value.targetRelativePath === "string" &&
    value.targetRelativePath.trim().length > 0 &&
    typeof value.revision === "string" &&
    value.revision.trim().length > 0
  );
}

function isStudySource(value: unknown): value is StudyMessage["source"] {
  return (
    isRecord(value) &&
    typeof value.sourceUrl === "string" &&
    Array.isArray(value.headingPath) &&
    value.headingPath.every((item) => typeof item === "string") &&
    (!("sourceNodeId" in value) ||
      value.sourceNodeId === null ||
      typeof value.sourceNodeId === "string") &&
    (!("sourceFingerprint" in value) ||
      value.sourceFingerprint === null ||
      typeof value.sourceFingerprint === "string")
  );
}

function isStudyMessage(value: unknown): value is StudyMessage {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    typeof value.messageId === "string" &&
    (value.role === "user" || value.role === "assistant") &&
    typeof value.content === "string" &&
    (!("selectedText" in value) ||
      value.selectedText === null ||
      typeof value.selectedText === "string") &&
    (!("source" in value) ||
      value.source === undefined ||
      value.source === null ||
      isStudySource(value.source)) &&
    (value.origin === "user" || value.origin === "ai") &&
    typeof value.createdAt === "string"
  );
}

function isStudyConversationResponse(
  value: unknown,
): value is StudyConversationResponse {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    typeof value.conversationId === "string" &&
    typeof value.sessionId === "string" &&
    (!("documentId" in value) ||
      value.documentId === undefined ||
      value.documentId === null ||
      typeof value.documentId === "string") &&
    typeof value.sourceUrl === "string" &&
    typeof value.pageTitle === "string" &&
    Array.isArray(value.messages) &&
    value.messages.every(isStudyMessage)
  );
}

function isStudyChatComplete(value: unknown): value is StudyChatComplete {
  return (
    isRecord(value) &&
    value.schemaVersion === 1 &&
    typeof value.conversationId === "string" &&
    isStudyMessage(value.message)
  );
}

function isKnowledgeConsentResponse(
  value: unknown,
): value is KnowledgeConsentResponse {
  return (
    isRecord(value) &&
    typeof value.scopeId === "string" &&
    ["active", "revoked", "unavailable"].includes(String(value.state)) &&
    (!("policyVersion" in value) ||
      value.policyVersion === null ||
      typeof value.policyVersion === "string")
  );
}

function isKnowledgeStatusResponse(
  value: unknown,
): value is KnowledgeStatusResponse {
  return (
    isRecord(value) &&
    isKnowledgeConsentResponse(value.consent) &&
    isNonNegativeSafeInteger(value.queuedJobCount) &&
    isNonNegativeSafeInteger(value.runningJobCount)
  );
}

function isKnowledgeJobResponse(value: unknown): value is KnowledgeJobResponse {
  return (
    isRecord(value) &&
    typeof value.jobId === "string" &&
    typeof value.chapterId === "string" &&
    typeof value.conversationId === "string" &&
    [
      "planned",
      "blocked_consent",
      "queued",
      "running",
      "completed",
      "skipped",
      "retryable_failed",
      "needs_review",
    ].includes(String(value.state)) &&
    isNonNegativeSafeInteger(value.attemptCount) &&
    (!('lastErrorCode' in value) ||
      value.lastErrorCode === null ||
      typeof value.lastErrorCode === "string") &&
    (!("lastErrorMessage" in value) ||
      value.lastErrorMessage === null ||
      typeof value.lastErrorMessage === "string") &&
    typeof value.updatedAt === "string"
  );
}

function isKnowledgeJobsResponse(
  value: unknown,
): value is KnowledgeJobResponse[] {
  return Array.isArray(value) && value.every(isKnowledgeJobResponse);
}

function isKnowledgeTriggerResponse(
  value: unknown,
): value is KnowledgeTriggerResponse {
  return (
    isRecord(value) &&
    isNonNegativeSafeInteger(value.scheduledJobCount) &&
    typeof value.state === "string" &&
    [
      "queued",
      "running",
      "completed",
      "needs_review",
      "skipped",
      "no_new_events",
    ].includes(value.state)
  );
}

function isAnnotationConsentResponse(
  value: unknown,
): value is AnnotationConsentResponse {
  return (
    isRecord(value) &&
    typeof value.scopeId === "string" &&
    ["active", "revoked", "unavailable"].includes(String(value.state)) &&
    (!('policyVersion' in value) ||
      value.policyVersion === null ||
      typeof value.policyVersion === "string")
  );
}

function isAnnotationIntentResponse(value: unknown): value is AnnotationIntentResponse {
  return (
    isRecord(value) &&
    typeof value.intentId === "string" &&
    typeof value.knowledgeId === "string" &&
    isNonNegativeSafeInteger(value.knowledgeVersion) &&
    typeof value.targetNoteId === "string" &&
    ["insert", "update", "noop"].includes(String(value.operation)) &&
    ["pending", "applying", "published", "noop", "needs_review", "failed"].includes(String(value.status)) &&
    isNonNegativeSafeInteger(value.attempts) &&
    typeof value.updatedAt === "string" &&
    typeof value.createdAt === "string"
  );
}

function isPublishCandidateResponse(value: unknown): value is PublishCandidateResponse {
  return (
    isRecord(value) &&
    typeof value.knowledgeId === "string" &&
    isNonNegativeSafeInteger(value.knowledgeVersion) &&
    typeof value.chapterId === "string" &&
    typeof value.targetNoteId === "string" &&
    (!('targetRelativePath' in value) || value.targetRelativePath === null || typeof value.targetRelativePath === "string") &&
    typeof value.sourceUrl === "string" &&
    (!('sourceBlockId' in value) || value.sourceBlockId === null || typeof value.sourceBlockId === "string") &&
    (!('anchorStableKey' in value) || value.anchorStableKey === null || typeof value.anchorStableKey === "string") &&
    Array.isArray(value.headingPath) &&
    value.headingPath.every((item) => typeof item === "string") &&
    typeof value.body === "string" &&
    typeof value.kind === "string" &&
    ["supported", "user_attributed"].includes(String(value.verificationStatus)) &&
    ["eligible", "eligible_user_insight"].includes(String(value.publishStatus))
  );
}

function isAnnotationCommitResponse(value: unknown): value is AnnotationCommitResponse {
  return (
    isRecord(value) &&
    ["published", "noop", "needs_review", "failed"].includes(String(value.status)) &&
    (!('intentId' in value) || value.intentId === null || typeof value.intentId === "string")
  );
}

function statusFailure(
  status: number,
  backendCode?: string,
): BackendClientFailure {
  if (status === 401) return failure("UNAUTHORIZED", "本地服务拒绝了访问 Token。");
  if (status === 413) return failure("PAYLOAD_TOO_LARGE", "请求体超过本地服务限制。");
  if (status === 415) return failure("UNSUPPORTED_MEDIA_TYPE", "本地服务不接受当前请求格式。");
  if (status === 422) return failure("INVALID_PAYLOAD", "本地服务拒绝了请求结构。");
  if (status === 409 && backendCode === "vault_required") {
    return failure("KNOWLEDGE_VAULT_REQUIRED", "需先配置有效 Obsidian Vault，才能启用知识提炼。");
  }
  if (status === 409) return failure("NOTE_CONFLICT", "目标笔记发生冲突，请重新预览。");
  if (status === 410) {
    return failure("PROPOSAL_EXPIRED", "预览提案已过期，请重新生成预览。");
  }
  if (status === 429) return failure("LLM_RATE_LIMITED", "LLM 服务当前受到限流，请稍后重试。");
  if (status === 403 && backendCode === "cloud_consent_required") {
    return failure("CLOUD_CONSENT_REQUIRED", "请先确认将章节内容发送到云端 DeepSeek。");
  }
  if (status === 404 && backendCode === "conversation_not_found") {
    return failure("CONVERSATION_NOT_FOUND", "未找到当前章节会话。");
  }
  if (status === 409 && backendCode === "conversation_source_conflict") {
    return failure("CONVERSATION_SOURCE_CONFLICT", "当前会话与章节来源不一致，已阻止串线。");
  }
  if (status === 500 && backendCode === "learning_memory_unavailable") {
    return failure("LEARNING_MEMORY_UNAVAILABLE", "学习记忆暂时不可用，请稍后重试。");
  }
  if (status === 504) return failure("LLM_TIMEOUT", "LLM 分析请求超时，请稍后重试。");
  if (status === 503 && backendCode === "vault_not_configured") {
    return failure("VAULT_NOT_CONFIGURED", "本地服务尚未配置 Obsidian Vault。");
  }
  if (status === 503 && backendCode === "llm_not_configured") {
    return failure("LLM_NOT_CONFIGURED", "后端尚未配置 LLM API Key。");
  }
  if (status === 503 && backendCode === "llm_unavailable") {
    return failure("LLM_UNAVAILABLE", "无法连接 LLM 服务，请稍后重试。");
  }
  if (status === 502 && backendCode === "llm_auth_failed") {
    return failure("LLM_AUTH_FAILED", "LLM API Key 无效或无权限。");
  }
  if (status === 502 && backendCode === "llm_invalid_response") {
    return failure("LLM_INVALID_RESPONSE", "LLM 返回格式无法通过校验。");
  }
  if (status === 502) {
    return failure("LLM_UPSTREAM_ERROR", "LLM 服务处理失败，请稍后重试。");
  }
  if (status >= 500) return failure("SERVER_ERROR", "本地服务处理失败，请查看后端日志。");
  return failure("UNKNOWN_ERROR", `本地服务返回 HTTP ${status}。`);
}

async function getToken(): Promise<string | BackendClientFailure> {
  try {
    const stored = await chrome.storage.local.get("localApiToken");
    const token =
      isRecord(stored) && typeof stored.localApiToken === "string"
        ? stored.localApiToken
        : "";
    return token || failure("NO_TOKEN", "请先保存本地服务 Token。");
  } catch {
    return failure("STORAGE_ERROR", "无法读取本地服务 Token。");
  }
}

async function postLocalJson<T>(
  url: string,
  payload: unknown,
  validate: (value: unknown) => value is T,
  timeoutMs = BACKEND_TIMEOUT_MS,
): Promise<{ ok: true; value: T } | BackendClientFailure> {
  const token = await getToken();
  if (typeof token !== "string") return token;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!response.ok) {
      let backendCode: string | undefined;
      try {
        const errorBody: unknown = await response.json();
        if (isRecord(errorBody) && isRecord(errorBody.error)) {
          backendCode =
            typeof errorBody.error.code === "string"
              ? errorBody.error.code
              : undefined;
        }
      } catch {
        // The status code still provides a safe client-side error mapping.
      }
      return statusFailure(response.status, backendCode);
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return failure("INVALID_RESPONSE", "本地服务返回了无效响应。");
    }
    return validate(body)
      ? { ok: true, value: body }
      : failure("INVALID_RESPONSE", "本地服务响应结构无效。");
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return failure("TIMEOUT", "本地服务请求超时。");
    }
    return failure("NETWORK_ERROR", "无法连接本地服务，请确认 FastAPI 已启动。");
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function ingestPageSnapshot(
  snapshot: PageSnapshot,
): Promise<BackendClientResult> {
  if (!isPageSnapshot(snapshot)) {
    return failure("INVALID_SNAPSHOT", "页面快照结构无效，无法发送。");
  }
  const result = await postLocalJson(
    LOCAL_INGEST_URL,
    snapshot,
    isBackendIngestResponse,
  );
  return result.ok ? { ok: true, response: result.value } : result;
}

export async function previewNote(
  payload: Record<string, unknown>,
): Promise<NoteClientResult> {
  const result = await postLocalJson(
    LOCAL_NOTE_PREVIEW_URL,
    payload,
    isNotePreviewResponse,
  );
  return result.ok ? { ok: true, response: result.value } : result;
}

export async function commitNote(proposalId: string): Promise<NoteClientResult> {
  const result = await postLocalJson(
    LOCAL_NOTE_COMMIT_URL,
    { proposalId },
    isNoteCommitResponse,
  );
  return result.ok ? { ok: true, response: result.value } : result;
}

export async function recommendAi(
  payload: Record<string, unknown>,
): Promise<AIRecommendationResult> {
  const result = await postLocalJson(
    LOCAL_AI_RECOMMEND_URL,
    payload,
    isAIRecommendationResponse,
    AI_BACKEND_TIMEOUT_MS,
  );
  return result.ok ? { ok: true, response: result.value } : result;
}

export async function previewDocument(
  snapshot: PageSnapshot,
): Promise<DocumentPreviewResult> {
  if (!isPageSnapshot(snapshot)) {
    return failure("INVALID_SNAPSHOT", "页面快照结构无效，无法生成新版文档预览。");
  }
  const result = await postLocalJson(
    LOCAL_DOCUMENT_PREVIEW_URL,
    { snapshot },
    isDocumentPreviewResponse,
  );
  return result.ok ? { ok: true, response: result.value } : result;
}

export async function commitDocument(
  proposalId: string,
): Promise<DocumentCommitResult> {
  const result = await postLocalJson(
    LOCAL_DOCUMENT_COMMIT_URL,
    { proposalId },
    isDocumentCommitResponse,
  );
  return result.ok ? { ok: true, response: result.value } : result;
}

export async function getStudyConversation(
  conversationId: string,
): Promise<StudyConversationResult> {
  const token = await getToken();
  if (typeof token !== "string") return token;
  try {
    const response = await fetch(
      `${LOCAL_STUDY_CONVERSATION_URL}/${encodeURIComponent(conversationId)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!response.ok) {
      let backendCode: string | undefined;
      try {
        const body: unknown = await response.json();
        if (
          isRecord(body) &&
          isRecord(body.error) &&
          typeof body.error.code === "string"
        ) {
          backendCode = body.error.code;
        }
      } catch {
        // Keep the status-only mapping.
      }
      return statusFailure(response.status, backendCode);
    }
    const body: unknown = await response.json();
    return isStudyConversationResponse(body)
      ? { ok: true, response: body }
      : failure("INVALID_RESPONSE", "本地服务返回的会话结构无效。");
  } catch {
    return failure("NETWORK_ERROR", "无法连接本地服务，请确认 FastAPI 已启动。");
  }
}

export async function streamStudyChat(
  payload: StudyChatPayload,
  onDelta: (text: string) => void,
  signal?: AbortSignal,
): Promise<StudyChatResult> {
  const token = await getToken();
  if (typeof token !== "string") return token;
  try {
    const response = await fetch(LOCAL_STUDY_CHAT_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(payload),
      signal,
    });
    if (!response.ok) {
      let backendCode: string | undefined;
      try {
        const body: unknown = await response.json();
        if (
          isRecord(body) &&
          isRecord(body.error) &&
          typeof body.error.code === "string"
        ) {
          backendCode = body.error.code;
        }
      } catch {
        // Keep the status-only mapping.
      }
      return statusFailure(response.status, backendCode);
    }
    if (!response.body) {
      return failure("INVALID_RESPONSE", "本地服务未返回流式响应。");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let complete: StudyChatComplete | undefined;
    let streamFailure: BackendClientFailure | undefined;
    const consumeEvent = (rawEvent: string): void => {
      const lines = rawEvent.split(/\r?\n/);
      let event = "message";
      const data: string[] = [];
      for (const line of lines) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (!data.length) return;
      try {
        const parsed: unknown = JSON.parse(data.join("\n"));
        if (
          event === "delta" &&
          isRecord(parsed) &&
          typeof parsed.text === "string"
        ) {
          onDelta(parsed.text);
        } else if (event === "done" && isStudyChatComplete(parsed)) {
          complete = parsed;
        } else if (event === "error" && isRecord(parsed)) {
          streamFailure = failure(
            typeof parsed.code === "string"
              ? mapStudyStreamCode(parsed.code)
              : "LLM_UPSTREAM_ERROR",
            typeof parsed.message === "string"
              ? parsed.message
              : "LLM 服务处理失败，请稍后重试。",
          );
        }
      } catch {
        streamFailure = failure("INVALID_RESPONSE", "流式响应格式无效。");
      }
    };

    while (true) {
      const result = await reader.read();
      buffer += decoder.decode(result.value ?? new Uint8Array(), {
        stream: !result.done,
      });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? "";
      events.forEach(consumeEvent);
      if (result.done || streamFailure) break;
    }
    if (buffer.trim()) consumeEvent(buffer);
    if (streamFailure) return streamFailure;
    return complete
      ? { ok: true, response: complete }
      : failure("INVALID_RESPONSE", "流式响应未正常结束。");
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return failure("TIMEOUT", "对话已停止。");
    }
    return failure("NETWORK_ERROR", "无法连接本地服务，请确认 FastAPI 已启动。");
  }
}

export async function getKnowledgeStatus(): Promise<KnowledgeStatusResult> {
  const token = await getToken();
  if (typeof token !== "string") return token;
  try {
    const response = await fetch(`${LOCAL_KNOWLEDGE_URL}/status`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return statusFailure(response.status);
    const body: unknown = await response.json();
    return isKnowledgeStatusResponse(body)
      ? { ok: true, response: body }
      : failure("INVALID_RESPONSE", "本地服务返回的知识状态无效。");
  } catch {
    return failure("NETWORK_ERROR", "无法连接本地服务，请确认 FastAPI 已启动。");
  }
}

export async function getKnowledgeJobs(): Promise<KnowledgeJobsResult> {
  const token = await getToken();
  if (typeof token !== "string") return token;
  try {
    const response = await fetch(`${LOCAL_KNOWLEDGE_URL}/jobs`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return statusFailure(response.status);
    const body: unknown = await response.json();
    return isKnowledgeJobsResponse(body)
      ? { ok: true, response: body }
      : failure("INVALID_RESPONSE", "本地服务返回的知识任务列表无效。");
  } catch {
    return failure("NETWORK_ERROR", "无法连接本地服务，请确认 FastAPI 已启动。");
  }
}

export async function triggerKnowledgeExtraction(
  chapterId: string,
  conversationId: string,
): Promise<KnowledgeTriggerResult> {
  const result = await postLocalJson(
    `${LOCAL_KNOWLEDGE_URL}/trigger`,
    { chapterId, conversationId },
    isKnowledgeTriggerResponse,
  );
  return result.ok ? { ok: true, response: result.value } : result;
}

export async function setKnowledgeExtractionConsent(
  enabled: boolean,
): Promise<KnowledgeConsentResult> {
  const result = await postLocalJson(
    `${LOCAL_KNOWLEDGE_URL}/consent`,
    { enabled, policyVersion: "s2-a-v1" },
    isKnowledgeConsentResponse,
  );
  return result.ok ? { ok: true, response: result.value } : result;
}

export async function getAnnotationConsent(): Promise<AnnotationConsentResult> {
  const token = await getToken();
  if (typeof token !== "string") return token;
  try {
    const response = await fetch(`${LOCAL_ANNOTATION_URL}/consent`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return statusFailure(response.status);
    const body: unknown = await response.json();
    return isAnnotationConsentResponse(body)
      ? { ok: true, response: body }
      : failure("INVALID_RESPONSE", "本地服务返回的归档授权状态无效。");
  } catch {
    return failure("NETWORK_ERROR", "无法连接本地服务，请确认 FastAPI 已启动。");
  }
}

export async function setAnnotationConsent(
  enabled: boolean,
): Promise<AnnotationConsentResult> {
  const result = await postLocalJson(
    `${LOCAL_ANNOTATION_URL}/consent`,
    { enabled, policyVersion: "s3-02-v1" },
    isAnnotationConsentResponse,
  );
  return result.ok ? { ok: true, response: result.value } : result;
}

export async function getAnnotationIntents(): Promise<AnnotationIntentsResult> {
  const token = await getToken();
  if (typeof token !== "string") return token;
  try {
    const response = await fetch(`${LOCAL_ANNOTATION_URL}/intents`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return statusFailure(response.status);
    const body: unknown = await response.json();
    return Array.isArray(body) && body.every(isAnnotationIntentResponse)
      ? { ok: true, response: body }
      : failure("INVALID_RESPONSE", "本地服务返回的归档任务列表无效。");
  } catch {
    return failure("NETWORK_ERROR", "无法连接本地服务，请确认 FastAPI 已启动。");
  }
}

export async function getPublishCandidates(): Promise<PublishCandidatesResult> {
  const token = await getToken();
  if (typeof token !== "string") return token;
  try {
    const response = await fetch(`${LOCAL_KNOWLEDGE_URL}/publish-candidates`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) return statusFailure(response.status);
    const body: unknown = await response.json();
    return Array.isArray(body) && body.every(isPublishCandidateResponse)
      ? { ok: true, response: body }
      : failure("INVALID_RESPONSE", "本地服务返回的知识候选无效。");
  } catch {
    return failure("NETWORK_ERROR", "无法连接本地服务，请确认 FastAPI 已启动。");
  }
}

export async function commitAnnotation(
  knowledgeId: string,
  knowledgeVersion: number,
): Promise<AnnotationCommitResult> {
  const result = await postLocalJson(
    `${LOCAL_ANNOTATION_URL}/commit`,
    { knowledgeId, knowledgeVersion, manualConfirmation: true },
    isAnnotationCommitResponse,
  );
  return result.ok ? { ok: true, response: result.value } : result;
}

function mapStudyStreamCode(
  code: string,
): BackendClientFailure["error"]["code"] {
  if (code === "llm_not_configured") return "LLM_NOT_CONFIGURED";
  if (code === "llm_auth_failed") return "LLM_AUTH_FAILED";
  if (code === "llm_rate_limited") return "LLM_RATE_LIMITED";
  if (code === "llm_timeout") return "LLM_TIMEOUT";
  if (code === "llm_unavailable") return "LLM_UNAVAILABLE";
  if (code === "llm_empty_response") return "LLM_INVALID_RESPONSE";
  if (code === "learning_memory_unavailable") return "LEARNING_MEMORY_UNAVAILABLE";
  return "LLM_UPSTREAM_ERROR";
}
