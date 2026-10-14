import type { PageSnapshot } from "../capture/types";

export const PAGE_INGEST_REQUEST = "PAGE_INGEST_REQUEST" as const;
export const NOTE_PREVIEW_REQUEST = "NOTE_PREVIEW_REQUEST" as const;
export const NOTE_COMMIT_REQUEST = "NOTE_COMMIT_REQUEST" as const;
export const AI_RECOMMEND_REQUEST = "AI_RECOMMEND_REQUEST" as const;
export const DOCUMENT_PREVIEW_REQUEST = "DOCUMENT_PREVIEW_REQUEST" as const;
export const DOCUMENT_COMMIT_REQUEST = "DOCUMENT_COMMIT_REQUEST" as const;

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

export interface DocumentPreviewRequest {
  type: typeof DOCUMENT_PREVIEW_REQUEST;
  snapshot: PageSnapshot;
}

export interface DocumentCommitRequest {
  type: typeof DOCUMENT_COMMIT_REQUEST;
  proposalId: string;
}

export interface StudyChatPayload {
  schemaVersion: 1;
  conversationId: string;
  sessionId: string;
  documentId?: string | null;
  sourceUrl: string;
  pageTitle: string;
  headingPath: string[];
  sourceNodeId?: string;
  sourceFingerprint?: string;
  selectedText?: string;
  question: string;
  cloudConsent: boolean;
  snapshot: PageSnapshot;
}

export interface StudySource {
  sourceUrl: string;
  headingPath: string[];
  sourceNodeId?: string | null;
  sourceFingerprint?: string | null;
}

export interface StudyMessage {
  schemaVersion: 1;
  messageId: string;
  role: "user" | "assistant";
  content: string;
  selectedText?: string | null;
  source?: StudySource | null;
  origin: "user" | "ai";
  createdAt: string;
}

export interface StudyConversationResponse {
  schemaVersion: 1;
  conversationId: string;
  sessionId: string;
  documentId?: string | null;
  sourceUrl: string;
  pageTitle: string;
  messages: StudyMessage[];
}

export interface StudyChatComplete {
  schemaVersion: 1;
  conversationId: string;
  message: StudyMessage;
}

export interface KnowledgeConsentResponse {
  scopeId: string;
  state: "active" | "revoked" | "unavailable";
  policyVersion?: string | null;
}

export interface KnowledgeStatusResponse {
  consent: KnowledgeConsentResponse;
  queuedJobCount: number;
  runningJobCount: number;
}

export type KnowledgeJobState =
  | "planned"
  | "blocked_consent"
  | "queued"
  | "running"
  | "completed"
  | "skipped"
  | "retryable_failed"
  | "needs_review";

export interface KnowledgeJobResponse {
  jobId: string;
  chapterId: string;
  conversationId: string;
  state: KnowledgeJobState;
  attemptCount: number;
  lastErrorCode?: string | null;
  lastErrorMessage?: string | null;
  updatedAt: string;
}

export interface KnowledgeTriggerResponse {
  scheduledJobCount: number;
  state:
    | "queued"
    | "running"
    | "completed"
    | "needs_review"
    | "skipped"
    | "no_new_events";
}

export interface AnnotationConsentResponse {
  scopeId: string;
  state: "active" | "revoked" | "unavailable";
  policyVersion?: string | null;
}

export type AnnotationIntentState =
  | "pending"
  | "applying"
  | "published"
  | "noop"
  | "needs_review"
  | "failed";

export interface AnnotationIntentResponse {
  intentId: string;
  knowledgeId: string;
  knowledgeVersion: number;
  targetNoteId: string;
  operation: "insert" | "update" | "noop";
  status: AnnotationIntentState;
  attempts: number;
  failureCode?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AnnotationCommitResponse {
  status: "published" | "noop" | "needs_review" | "failed";
  intentId?: string | null;
  failureCode?: string | null;
}

export interface PublishCandidateResponse {
  knowledgeId: string;
  knowledgeVersion: number;
  chapterId: string;
  targetNoteId: string;
  targetRelativePath?: string | null;
  sourceUrl: string;
  sourceBlockId?: string | null;
  anchorStableKey?: string | null;
  headingPath: string[];
  body: string;
  kind: string;
  verificationStatus: "supported" | "user_attributed";
  publishStatus: "eligible" | "eligible_user_insight";
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

export interface DocumentPreviewDiagnostics {
  renderedBlockCount: number;
  filteredBlockCount: number;
  unsupportedBlockCount: number;
  truncated: boolean;
  warnings: string[];
  qualityStatus: "ok" | "warning" | "blocked";
  issues: Array<{
    severity: "warning" | "blocking";
    code: string;
    message: string;
    evidence: Record<string, number | string | boolean>;
  }>;
}

export interface DocumentPreviewResponse {
  status: "preview";
  schemaVersion: 2;
  proposalId: string;
  action: "create" | "replace" | "noop";
  noteId: string;
  targetRelativePath: string;
  diff: string;
  expectedRevision: string | null;
  expiresAt: string;
  title: string;
  sourceUrl: string;
  markdownPreview: string;
  diagnostics: DocumentPreviewDiagnostics;
}

export interface DocumentCommitResponse {
  status: "created" | "updated" | "unchanged";
  noteId: string;
  targetRelativePath: string;
  revision: string;
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
  | "CONVERSATION_NOT_FOUND"
  | "CONVERSATION_SOURCE_CONFLICT"
  | "LEARNING_MEMORY_UNAVAILABLE"
  | "KNOWLEDGE_VAULT_REQUIRED"
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
export type DocumentPreviewResult =
  | { ok: true; response: DocumentPreviewResponse }
  | BackendClientFailure;
export type DocumentCommitResult =
  | { ok: true; response: DocumentCommitResponse }
  | BackendClientFailure;
export type StudyConversationResult =
  | { ok: true; response: StudyConversationResponse }
  | BackendClientFailure;
export type StudyChatResult =
  | { ok: true; response: StudyChatComplete }
  | BackendClientFailure;
export type KnowledgeStatusResult =
  | { ok: true; response: KnowledgeStatusResponse }
  | BackendClientFailure;
export type KnowledgeJobsResult =
  | { ok: true; response: KnowledgeJobResponse[] }
  | BackendClientFailure;
export type KnowledgeTriggerResult =
  | { ok: true; response: KnowledgeTriggerResponse }
  | BackendClientFailure;
export type KnowledgeConsentResult =
  | { ok: true; response: KnowledgeConsentResponse }
  | BackendClientFailure;
export type AnnotationConsentResult =
  | { ok: true; response: AnnotationConsentResponse }
  | BackendClientFailure;
export type AnnotationIntentsResult =
  | { ok: true; response: AnnotationIntentResponse[] }
  | BackendClientFailure;
export type PublishCandidatesResult =
  | { ok: true; response: PublishCandidateResponse[] }
  | BackendClientFailure;
export type AnnotationCommitResult =
  | { ok: true; response: AnnotationCommitResponse }
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

export function isDocumentPreviewRequest(
  message: unknown,
): message is DocumentPreviewRequest {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === DOCUMENT_PREVIEW_REQUEST &&
    "snapshot" in message
  );
}

export function isDocumentCommitRequest(
  message: unknown,
): message is DocumentCommitRequest {
  return (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === DOCUMENT_COMMIT_REQUEST &&
    "proposalId" in message &&
    typeof message.proposalId === "string"
  );
}
