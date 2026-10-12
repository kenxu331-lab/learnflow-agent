import type { PageSnapshot } from "../capture/types";

export const STUDY_STORAGE_KEY = "learnflowStudyState" as const;
export const STUDY_SNAPSHOTS_STORAGE_KEY = "learnflowStudySnapshots" as const;

export const STUDY_GET_STATE_REQUEST = "STUDY_GET_STATE_REQUEST" as const;
export const STUDY_GET_TAB_CONTEXT_REQUEST =
  "STUDY_GET_TAB_CONTEXT_REQUEST" as const;
export const STUDY_ENABLE_REQUEST = "STUDY_ENABLE_REQUEST" as const;
export const STUDY_PAUSE_REQUEST = "STUDY_PAUSE_REQUEST" as const;
export const STUDY_REVOKE_REQUEST = "STUDY_REVOKE_REQUEST" as const;
export const STUDY_MANUAL_SNAPSHOT_REQUEST =
  "STUDY_MANUAL_SNAPSHOT_REQUEST" as const;
export const STUDY_STATE_CHANGED = "STUDY_STATE_CHANGED" as const;

export const STUDY_SITE_ORIGIN = "https://fastapi.tiangolo.com" as const;
export const STUDY_SITE_HOST_PERMISSION =
  "https://fastapi.tiangolo.com/*" as const;

export type StudyStatus =
  | "DISABLED"
  | "AUTHORIZED"
  | "CAPTURING"
  | "SOURCE_READY"
  | "LOCAL_SOURCE_ONLY"
  | "CAPTURE_FAILED";

export interface StudySession {
  sessionId: string;
  tabId: number;
  chapterId: string;
  sourceUrl: string;
  pageTitle: string;
  snapshotHash: string;
  capturedAt: string;
  updatedAt: string;
  status: StudyStatus;
  lastError?: string;
}

export interface StudyState {
  schemaVersion: 1;
  enabled: boolean;
  status: StudyStatus;
  authorizedOrigin?: string;
  activeTabId?: number;
  sessionsByChapter: Record<string, StudySession>;
  snapshotsByChapter: Record<string, PageSnapshot>;
  currentSession?: StudySession;
  currentSnapshot?: PageSnapshot;
  lastError?: string;
}

export interface StudyGetStateRequest {
  type: typeof STUDY_GET_STATE_REQUEST;
}

export interface StudyGetTabContextRequest {
  type: typeof STUDY_GET_TAB_CONTEXT_REQUEST;
}

export interface StudyEnableRequest {
  type: typeof STUDY_ENABLE_REQUEST;
}

export interface StudyPauseRequest {
  type: typeof STUDY_PAUSE_REQUEST;
}

export interface StudyRevokeRequest {
  type: typeof STUDY_REVOKE_REQUEST;
}

export interface StudyManualSnapshotRequest {
  type: typeof STUDY_MANUAL_SNAPSHOT_REQUEST;
  snapshot: PageSnapshot;
}

export type StudyRequest =
  | StudyGetStateRequest
  | StudyGetTabContextRequest
  | StudyEnableRequest
  | StudyPauseRequest
  | StudyRevokeRequest
  | StudyManualSnapshotRequest;

export interface StudyStateChangedMessage {
  type: typeof STUDY_STATE_CHANGED;
  state: StudyState;
}

export interface StudyTabContext {
  tabId: number | null;
  url: string | null;
  supported: boolean;
  hasPermission: boolean;
}

export interface StudySuccess<T> {
  ok: true;
  value: T;
}

export interface StudyFailure {
  ok: false;
  error: {
    code:
      | "NO_TARGET_TAB"
      | "URL_UNAVAILABLE"
      | "UNSUPPORTED_SITE"
      | "PERMISSION_REQUIRED"
      | "STUDY_DISABLED"
      | "CAPTURE_FAILED"
      | "STORAGE_ERROR";
    message: string;
  };
}

export type StudyActionResult = StudySuccess<StudyState> | StudyFailure;
export type StudyStateResult = StudySuccess<StudyState> | StudyFailure;
export type StudyTabContextResult = StudySuccess<StudyTabContext> | StudyFailure;

export function isStudyRequest(value: unknown): value is StudyRequest {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return false;
  }

  return (
    value.type === STUDY_GET_STATE_REQUEST ||
    value.type === STUDY_GET_TAB_CONTEXT_REQUEST ||
    value.type === STUDY_ENABLE_REQUEST ||
    value.type === STUDY_PAUSE_REQUEST ||
    value.type === STUDY_REVOKE_REQUEST ||
    value.type === STUDY_MANUAL_SNAPSHOT_REQUEST
  );
}

export function isStudyStateChangedMessage(
  value: unknown,
): value is StudyStateChangedMessage {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === STUDY_STATE_CHANGED &&
    "state" in value
  );
}
