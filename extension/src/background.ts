import {
  registerCaptureMessageHandler,
  setCaptureTarget,
} from "./capture/capture-service";

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

registerActionClickHandler();
registerCaptureMessageHandler();
