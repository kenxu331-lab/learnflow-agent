import { isPageSnapshot } from "../capture/capture-service";
import {
  STUDY_STORAGE_KEY,
  STUDY_SNAPSHOTS_STORAGE_KEY,
  type StudySession,
  type StudyState,
  type StudyStatus,
} from "./types";

export function createDefaultStudyState(): StudyState {
  return {
    schemaVersion: 1,
    enabled: false,
    status: "DISABLED",
    sessionsByChapter: {},
    snapshotsByChapter: {},
  };
}

function isStudyStatus(value: unknown): value is StudyStatus {
  return [
    "DISABLED",
    "AUTHORIZED",
    "CAPTURING",
    "SOURCE_READY",
    "LOCAL_SOURCE_ONLY",
    "CAPTURE_FAILED",
  ].includes(value as StudyStatus);
}

function isStudySession(value: unknown): value is StudySession {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const session = value as Record<string, unknown>;
  return (
    typeof session.sessionId === "string" &&
    typeof session.tabId === "number" &&
    Number.isSafeInteger(session.tabId) &&
    session.tabId >= 0 &&
    typeof session.chapterId === "string" &&
    typeof session.sourceUrl === "string" &&
    typeof session.pageTitle === "string" &&
    typeof session.snapshotHash === "string" &&
    typeof session.capturedAt === "string" &&
    typeof session.updatedAt === "string" &&
    isStudyStatus(session.status) &&
    (!('lastError' in session) ||
      session.lastError === undefined ||
      typeof session.lastError === "string")
  );
}

export function parseStudyState(
  value: unknown,
  snapshotsValue?: unknown,
): StudyState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return createDefaultStudyState();
  }

  const candidate = value as Record<string, unknown>;
  const state: StudyState = {
    schemaVersion: 1,
    enabled: candidate.enabled === true,
    status: isStudyStatus(candidate.status) ? candidate.status : "DISABLED",
    sessionsByChapter: {},
    snapshotsByChapter: {},
  };

  if (typeof candidate.authorizedOrigin === "string") {
    state.authorizedOrigin = candidate.authorizedOrigin;
  }
  if (
    typeof candidate.activeTabId === "number" &&
    Number.isSafeInteger(candidate.activeTabId) &&
    candidate.activeTabId >= 0
  ) {
    state.activeTabId = candidate.activeTabId;
  }
  if (isStudySession(candidate.currentSession)) {
    state.currentSession = candidate.currentSession;
  }
  if (isPageSnapshot(candidate.currentSnapshot)) {
    state.currentSnapshot = candidate.currentSnapshot;
  }
  if (
    typeof candidate.sessionsByChapter === "object" &&
    candidate.sessionsByChapter !== null &&
    !Array.isArray(candidate.sessionsByChapter)
  ) {
    for (const [chapterId, session] of Object.entries(
      candidate.sessionsByChapter,
    )) {
      if (isStudySession(session)) {
        state.sessionsByChapter[chapterId] = session;
      }
    }
  }
  const snapshotsCandidate =
    snapshotsValue ?? candidate.snapshotsByChapter;
  if (
    typeof snapshotsCandidate === "object" &&
    snapshotsCandidate !== null &&
    !Array.isArray(snapshotsCandidate)
  ) {
    for (const [chapterId, snapshot] of Object.entries(snapshotsCandidate)) {
      if (isPageSnapshot(snapshot)) {
        state.snapshotsByChapter[chapterId] = snapshot;
      }
    }
  }

  if (state.currentSession) {
    state.sessionsByChapter[state.currentSession.chapterId] = state.currentSession;
  }
  if (state.currentSnapshot && state.currentSession) {
    state.snapshotsByChapter[state.currentSession.chapterId] = state.currentSnapshot;
  }
  if (!state.currentSnapshot && state.currentSession) {
    state.currentSnapshot =
      state.snapshotsByChapter[state.currentSession.chapterId];
  }
  if (typeof candidate.lastError === "string") {
    state.lastError = candidate.lastError;
  }

  if (!state.enabled) {
    state.status = "DISABLED";
  }
  return state;
}

export async function loadStudyState(): Promise<StudyState> {
  const storage = chrome.storage?.local;
  if (!storage?.get) {
    return createDefaultStudyState();
  }

  try {
    const stored = await storage.get([
      STUDY_STORAGE_KEY,
      STUDY_SNAPSHOTS_STORAGE_KEY,
    ]);
    return parseStudyState(
      stored?.[STUDY_STORAGE_KEY],
      stored?.[STUDY_SNAPSHOTS_STORAGE_KEY],
    );
  } catch {
    return createDefaultStudyState();
  }
}

export async function saveStudyState(
  state: StudyState,
  options: { persistSnapshots?: boolean } = {},
): Promise<boolean> {
  const storage = chrome.storage?.local;
  if (!storage?.set) {
    return false;
  }

  try {
    const metadataState = {
      ...state,
      currentSnapshot: undefined,
      snapshotsByChapter: {},
    };
    const payload: Record<string, unknown> = {
      [STUDY_STORAGE_KEY]: metadataState,
    };
    if (options.persistSnapshots !== false) {
      payload[STUDY_SNAPSHOTS_STORAGE_KEY] = state.snapshotsByChapter;
    }
    await storage.set(payload);
    return true;
  } catch {
    return false;
  }
}
