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
} from "./types";

export const LOCAL_INGEST_URL =
  "http://127.0.0.1:8000/api/v1/pages/ingest";
export const LOCAL_NOTE_PREVIEW_URL =
  "http://127.0.0.1:8000/api/v1/notes/preview";
export const LOCAL_NOTE_COMMIT_URL =
  "http://127.0.0.1:8000/api/v1/notes/commit";
export const LOCAL_AI_RECOMMEND_URL =
  "http://127.0.0.1:8000/api/v1/ai/notes/recommend";
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

function statusFailure(
  status: number,
  backendCode?: string,
): BackendClientFailure {
  if (status === 401) return failure("UNAUTHORIZED", "本地服务拒绝了访问 Token。");
  if (status === 413) return failure("PAYLOAD_TOO_LARGE", "请求体超过本地服务限制。");
  if (status === 415) return failure("UNSUPPORTED_MEDIA_TYPE", "本地服务不接受当前请求格式。");
  if (status === 422) return failure("INVALID_PAYLOAD", "本地服务拒绝了请求结构。");
  if (status === 409) return failure("NOTE_CONFLICT", "目标笔记发生冲突，请重新预览。");
  if (status === 410) {
    return failure("PROPOSAL_EXPIRED", "预览提案已过期，请重新生成预览。");
  }
  if (status === 429) return failure("LLM_RATE_LIMITED", "LLM 服务当前受到限流，请稍后重试。");
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
