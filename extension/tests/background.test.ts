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

  it("routes AI recommendations through the background only with consent", async () => {
    const onClicked = vi.fn();
    const sidePanelOpen = vi.fn().mockResolvedValue(undefined);
    const onMessage = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          schemaVersion: 1,
          recommendations: [],
          analysis: {
            model: "fake-deepseek-flash",
            analyzedBlockCount: 0,
            truncated: false,
          },
        }),
        { status: 200 },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("chrome", {
      action: { onClicked: { addListener: onClicked } },
      sidePanel: { open: sidePanelOpen },
      storage: {
        local: {
          setAccessLevel: vi.fn().mockResolvedValue(undefined),
          get: vi.fn().mockResolvedValue({ localApiToken: "local-token" }),
        },
      },
      runtime: { onMessage: { addListener: onMessage } },
    });

    await import("../src/background");

    const listener = onMessage.mock.calls[1][0] as (
      message: unknown,
      sender: unknown,
      sendResponse: (response: unknown) => void,
    ) => boolean;
    const sendResponse = vi.fn();
    const handled = listener(
      {
        type: "AI_RECOMMEND_REQUEST",
        snapshot: { schemaVersion: 1 },
        learningGoal: "重点学习",
        cloudConsent: true,
      },
      {},
      sendResponse,
    );

    expect(handled).toBe(true);
    await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8000/api/v1/ai/notes/recommend",
      expect.objectContaining({ method: "POST" }),
    );
  });
});
