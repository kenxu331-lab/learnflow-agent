import type { PageSnapshot } from "../capture/types";

export const PAGE_INGEST_REQUEST = "PAGE_INGEST_REQUEST" as const;
export const NOTE_PREVIEW_REQUEST = "NOTE_PREVIEW_REQUEST" as const;
export const NOTE_COMMIT_REQUEST = "NOTE_COMMIT_REQUEST" as const;
export const AI_RECOMMEND_REQUEST = "AI_RECOMMEND_REQUEST" as const;

export interface PageIngestRequest {
  type: typeof PAGE_INGEST_REQUEST;
  snapshot: PageSnapshot;
}

export interface NotePreviewRequest {
  type: typeof NOTE_PREVIEW_REQUEST;
  snapshot: PageSnapshot;
  selectedBlockIds: string[];
  personalNote: string;
}

export interface NoteCommitRequest {
  type: typeof NOTE_COMMIT_REQUEST;
  proposalId: string;
}

export interface AiRecommendRequest {
  type: typeof AI_RECOMMEND_REQUEST;
  snapshot: PageSnapshot;
  learningGoal: string;
  cloudConsent: boolean;
}

export interface BackendIngestResponse {
  status: "validated";
  requestId: string;
  schemaVersion: 1;
  stats: PageSnapshot["stats"];
}

export interface NotePreviewResponse {
  proposalId: string;
  action: "create" | "append" | "noop";
  noteId: string;
  targetRelativePath: string;
  markdownPreview: string;
  diff: string;
  expectedRevision: string | null;
  expiresAt: string;
}

export interface NoteCommitResponse {
  status: "created" | "updated" | "unchanged";
  noteId: string;
  targetRelativePath: string;
  revision: string;
}

export type RecommendationCategory =
  | "core_concept"
  | "code_example"
  | "important_detail"
  | "pitfall";

export interface AIRecommendationItem {
  blockId: string;
  category: RecommendationCategory;
  reason: string;
}

export interface AIRecommendationResponse {
  schemaVersion: 1;
  recommendations: AIRecommendationItem[];
  analysis: {
    model: string;
    analyzedBlockCount: number;
    truncated: boolean;
  };
}

export type BackendErrorCode =
  | "NO_TOKEN"
  | "INVALID_SNAPSHOT"
  | "NETWORK_ERROR"
  | "TIMEOUT"
  | "UNAUTHORIZED"
  | "PAYLOAD_TOO_LARGE"
  | "INVALID_PAYLOAD"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "SERVER_ERROR"
  | "INVALID_RESPONSE"
  | "NOTE_CONFLICT"
  | "PROPOSAL_EXPIRED"
  | "VAULT_NOT_CONFIGURED"
  | "CLOUD_CONSENT_REQUIRED"
  | "LLM_NOT_CONFIGURED"
  | "LLM_AUTH_FAILED"
  | "LLM_RATE_LIMITED"
  | "LLM_TIMEOUT"
  | "LLM_UPSTREAM_ERROR"
  | "LLM_INVALID_RESPONSE"
  | "LLM_UNAVAILABLE"
  | "STORAGE_ERROR"
  | "UNKNOWN_ERROR";

export interface BackendClientError {
  code: BackendErrorCode;
  message: string;
}

export interface BackendClientSuccess {
  ok: true;
  response: BackendIngestResponse;
}

export interface BackendClientFailure {
  ok: false;
  error: BackendClientError;
}

export type BackendClientResult = BackendClientSuccess | BackendClientFailure;
export type NoteClientResult =
  | { ok: true; response: NotePreviewResponse | NoteCommitResponse }
  | BackendClientFailure;
export type AIRecommendationResult =
  | { ok: true; response: AIRecommendationResponse }
  | BackendClientFailure;

export function isPageIngestRequest(
  message: unknown,
): message is PageIngestRequest {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === PAGE_INGEST_REQUEST &&
    "snapshot" in message
  );
}

export function isNotePreviewRequest(
  message: unknown,
): message is NotePreviewRequest {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === NOTE_PREVIEW_REQUEST &&
    "snapshot" in message &&
    "selectedBlockIds" in message
  );
}

export function isNoteCommitRequest(
  message: unknown,
): message is NoteCommitRequest {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === NOTE_COMMIT_REQUEST &&
    "proposalId" in message &&
    typeof message.proposalId === "string"
  );
}

export function isAiRecommendRequest(
  message: unknown,
): message is AiRecommendRequest {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === AI_RECOMMEND_REQUEST &&
    "snapshot" in message &&
    "cloudConsent" in message &&
    typeof message.cloudConsent === "boolean" &&
    (!("learningGoal" in message) || typeof message.learningGoal === "string")
  );
}
