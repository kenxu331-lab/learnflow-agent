import { beforeEach, describe, expect, it, vi } from "vitest";

describe("background action handling", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("opens the side panel for the tab that received the toolbar click", async () => {
    const onClicked = vi.fn();
    const sidePanelOpen = vi.fn().mockResolvedValue(undefined);
    const onMessage = vi.fn();

    vi.stubGlobal("chrome", {
      action: { onClicked: { addListener: onClicked } },
      sidePanel: { open: sidePanelOpen },
      storage: { local: { setAccessLevel: vi.fn().mockResolvedValue(undefined) } },
      runtime: { onMessage: { addListener: onMessage } },
    });

    await import("../src/background");

    const listener = onClicked.mock.calls[0][0] as (
      tab: chrome.tabs.Tab,
    ) => void;
    listener({ id: 42, windowId: 9 } as chrome.tabs.Tab);

    expect(sidePanelOpen).toHaveBeenCalledWith({ tabId: 42 });
  });
});
