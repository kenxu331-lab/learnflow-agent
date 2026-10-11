import {
  registerCaptureMessageHandler,
  setCaptureTarget,
} from "./capture/capture-service";
import { ingestPageSnapshot } from "./backend/api-client";
import { ensureTrustedStorageAccess } from "./backend/storage";
import {
  isPageIngestRequest,
  type BackendClientResult,
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
    if (!isPageIngestRequest(message)) {
      return false;
    }

    void ingestPageSnapshot(message.snapshot)
      .then(sendResponse)
      .catch(() => {
        const response: BackendClientResult = {
          ok: false,
          error: {
            code: "UNKNOWN_ERROR",
            message: "本地服务请求失败，请重试。",
          },
        };
        sendResponse(response);
      });

    return true;
  });
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
void configureStorageAccess();
