import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

const css = readFileSync(resolve("src/sidepanel/message-typography.css"), "utf8");

describe("shared message typography", () => {
  beforeEach(() => {
    document.head.innerHTML = "";
    const style = document.createElement("style");
    style.textContent = css;
    document.head.append(style);
    document.body.innerHTML = `<article class="chat-message-body"><h2>章节重点</h2><p>正文 <code>Depends</code></p><pre class="markdown-code"><code>return value</code></pre></article><dialog class="message-reader"><div class="reader-body"><h2>章节重点</h2><pre class="markdown-code"><code>return value</code></pre></div></dialog>`;
  });

  it("uses a readable body size and a larger reader default", () => {
    expect(getComputedStyle(document.querySelector("article")!).fontSize).toBe("15px");
    expect(getComputedStyle(document.querySelector(".reader-body")!).fontSize).toBe("16px");
  });

  it("keeps headings and code relative to the zoomable body in both surfaces", () => {
    for (const heading of document.querySelectorAll("h2")) {
      expect(getComputedStyle(heading).fontSize).toBe("1.3em");
    }
    for (const code of document.querySelectorAll("code")) {
      expect(getComputedStyle(code).fontSize).toBe("0.875em");
    }
  });

  it("keeps long code horizontally scrollable instead of wrapping or growing the layout", () => {
    for (const pre of document.querySelectorAll("pre")) {
      const style = getComputedStyle(pre);
      expect(style.overflowX).toBe("auto");
      expect(style.whiteSpace).toBe("pre");
      expect(style.maxWidth).toBe("100%");
      expect(style.overflowWrap).toBe("normal");
    }
  });
});
