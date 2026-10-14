import {
  registerCaptureMessageHandler,
  setCaptureTarget,
} from "./capture/capture-service";
import {
  commitNote,
  ingestPageSnapshot,
  previewNote,
  previewDocument,
  commitDocument,
  recommendAi,
} from "./backend/api-client";
import { ensureTrustedStorageAccess } from "./backend/storage";
import { registerStudyService } from "./study/study-service";
import {
  isPageIngestRequest,
  isNoteCommitRequest,
  isNotePreviewRequest,
  isAiRecommendRequest,
  isDocumentPreviewRequest,
  isDocumentCommitRequest,
  type BackendClientFailure,
} from "./backend/types";

function getProtocol(value: string | undefined): string | null {
  if (!value) {
    return null;
  }

  try {
    return new URL(value).protocol;
  } catch {
    return null;
  }
}

export function registerActionClickHandler(): void {
  chrome.action.onClicked.addListener((tab) => {
    const tabId = tab.id;
    if (typeof tabId !== "number" || !Number.isInteger(tabId)) {
      console.warn("[LearnFlow capture] action-click-without-tab-id");
      return;
    }

    setCaptureTarget(tabId);
    console.debug("[LearnFlow capture] action-click", {
      tabId,
      windowId: tab.windowId,
      urlAvailable: Boolean(tab.url),
      urlProtocol: getProtocol(tab.url),
    });

    // This call stays directly inside the toolbar action gesture. Chrome
    // grants activeTab for that gesture before opening the side panel.
    void chrome.sidePanel.open({ tabId }).catch((error: unknown) => {
      console.warn("[LearnFlow capture] side-panel-open-failed", {
        tabId,
        windowId: tab.windowId,
        errorType: error instanceof Error ? error.name : typeof error,
      });
    });
  });
}

export function registerBackendMessageHandler(): void {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (isPageIngestRequest(message)) {
      void ingestPageSnapshot(message.snapshot)
        .then(sendResponse)
        .catch(() => sendResponse(backendUnknownError()));
      return true;
    }

    if (isNotePreviewRequest(message)) {
      void previewNote({
        snapshot: message.snapshot,
        selectedBlockIds: message.selectedBlockIds,
        personalNote: message.personalNote,
      })
        .then(sendResponse)
        .catch(() => sendResponse(backendUnknownError()));
      return true;
    }

    if (isNoteCommitRequest(message)) {
      void commitNote(message.proposalId)
        .then(sendResponse)
        .catch(() => sendResponse(backendUnknownError()));
      return true;
    }

    if (isDocumentPreviewRequest(message)) {
      void previewDocument(message.snapshot)
        .then(sendResponse)
        .catch(() => sendResponse(backendUnknownError()));
      return true;
    }

    if (isDocumentCommitRequest(message)) {
      void commitDocument(message.proposalId)
        .then(sendResponse)
        .catch(() => sendResponse(backendUnknownError()));
      return true;
    }

    if (isAiRecommendRequest(message)) {
      if (!message.cloudConsent) {
        sendResponse({
          ok: false,
          error: {
            code: "CLOUD_CONSENT_REQUIRED",
            message: "请先确认将当前页面内容发送到云端 AI 分析。",
          },
        } satisfies BackendClientFailure);
        return false;
      }
      void recommendAi({
        snapshot: message.snapshot,
        learningGoal: message.learningGoal,
      })
        .then(sendResponse)
        .catch(() => sendResponse(backendUnknownError()));
      return true;
    }

    return false;
  });
}

function backendUnknownError(): BackendClientFailure {
  return {
    ok: false,
    error: { code: "UNKNOWN_ERROR", message: "本地服务请求失败，请重试。" },
  };
}

async function configureStorageAccess(): Promise<void> {
  if (!(await ensureTrustedStorageAccess())) {
    console.warn("[LearnFlow backend] storage-access-config-failed", {
      reason: "setAccessLevel_failed",
    });
  }
}

registerActionClickHandler();
registerCaptureMessageHandler();
registerBackendMessageHandler();
registerStudyService();
void configureStorageAccess();
