import { beforeEach, describe, expect, it } from "vitest";

import { extractPageSnapshot } from "../src/capture/extractor";

describe("extractPageSnapshot", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.title = "";
    window.history.replaceState({}, "", "/tutorial");
  });

  it("extracts headings, paragraphs, code, and lists in DOM order", () => {
    document.title = "TypeScript Tutorial";
    document.body.innerHTML = `
      <nav>Navigation should not be captured.</nav>
      <article>
        <h1>Getting Started</h1>
        <p>Use this tutorial to learn the basics.</p>
        <pre><code class="language-ts">  const answer = 42;\n    console.log(answer);\n</code></pre>
        <h2>Next steps</h2>
        <ul><li>Read the guide</li><li>Try the example</li></ul>
        <footer>Footer should not be captured.</footer>
      </article>
    `;

    const snapshot = extractPageSnapshot();

    expect(snapshot.title).toBe("TypeScript Tutorial");
    expect(snapshot.url).toBe("http://localhost:3000/tutorial");
    expect(snapshot.extraction.strategy).toBe("article");
    expect(snapshot.blocks.map((block) => block.type)).toEqual([
      "heading",
      "paragraph",
      "code",
      "heading",
      "list",
      "list",
    ]);
    expect(snapshot.blocks[2]).toMatchObject({
      type: "code",
      language: "ts",
      text: "  const answer = 42;\n    console.log(answer);",
    });
    expect(snapshot.blocks.map((block) => block.text)).not.toContain(
      "Navigation should not be captured.",
    );
    expect(snapshot.blocks.map((block) => block.text)).not.toContain(
      "Footer should not be captured.",
    );
  });

  it("chooses the best non-empty article candidate", () => {
    document.body.innerHTML = `
      <article></article>
      <article>
        <h1>Real tutorial</h1>
        <p>This article has enough meaningful content to be selected.</p>
      </article>
    `;

    const snapshot = extractPageSnapshot();

    expect(snapshot.extraction.strategy).toBe("article");
    expect(snapshot.blocks[0].text).toBe("Real tutorial");
  });

  it("uses a fallback paragraph and warning for an empty page", () => {
    document.body.innerHTML = "<nav>Only navigation</nav>";

    const snapshot = extractPageSnapshot();

    expect(snapshot.extraction.strategy).toBe("fallback");
    expect(snapshot.stats.blockCount).toBe(0);
    expect(snapshot.extraction.warnings).toContain("未提取到正文内容。");
  });

  it("truncates an oversized code block without claiming completeness", () => {
    document.body.innerHTML = `<main><pre><code class="language-python">${"  print('x')\n".repeat(2_000)}</code></pre></main>`;

    const snapshot = extractPageSnapshot();

    expect(snapshot.extraction.truncated).toBe(true);
    expect(snapshot.blocks[0].text.length).toBe(12_000);
    expect(snapshot.extraction.warnings).toContain(
      "代码块超过单块上限，代码内容不完整。",
    );
  });

  it("truncates total content at the configured character limit", () => {
    document.body.innerHTML = `<main><p>${"word ".repeat(15_000)}</p></main>`;

    const snapshot = extractPageSnapshot();

    expect(snapshot.extraction.truncated).toBe(true);
    expect(snapshot.stats.characterCount).toBe(60_000);
    expect(snapshot.extraction.warnings).toContain(
      "正文字符数已达到上限，结果已截断。",
    );
  });
});
