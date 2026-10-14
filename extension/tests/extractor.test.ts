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
    expect(snapshot.contentTitle).toBe("Getting Started");
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

  it("captures Runoob highlighted code in the deterministic fallback path", () => {
    document.body.innerHTML = `
      <div id="content" class="article-intro">
        <h1>Python pass 语句</h1>
        <p>测试实例：</p>
        <div class="example_code"><div class="hl-main"><span class="hl-comment">#!/usr/bin/python</span><span class="hl-code">\n</span><span class="hl-reserved">for</span><span class="hl-code"> letter in 'Python':\n   </span><span class="hl-reserved">pass</span></div></div>
      </div>
      <div id="comments"><pre>comment code must be ignored</pre></div>
    `;

    const snapshot = extractPageSnapshot();
    const code = snapshot.blocks.find((block) => block.type === "code");

    expect(code?.text).toContain("#!/usr/bin/python");
    expect(code?.text).toContain("for letter in 'Python':");
    expect(snapshot.blocks.map((block) => block.text)).not.toContain(
      "comment code must be ignored",
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

  it("keeps persistence keys stable when a block is inserted before existing content", () => {
    document.body.innerHTML = `
      <article>
        <p>Existing introduction.</p>
        <p>Existing details.</p>
      </article>
    `;
    const before = extractPageSnapshot();

    document.body.innerHTML = `
      <article>
        <h2>New preface.</h2>
        <p>Existing introduction.</p>
        <p>Existing details.</p>
      </article>
    `;
    const after = extractPageSnapshot();

    const beforeKeys = new Map(before.blocks.map((block) => [block.text, block.stableKey]));
    const afterIds = new Map(after.blocks.map((block) => [block.text, block.id]));
    expect(beforeKeys.get("Existing introduction.")).toBe(
      after.blocks.find((block) => block.text === "Existing introduction.")?.stableKey,
    );
    expect(beforeKeys.get("Existing details.")).toBe(
      after.blocks.find((block) => block.text === "Existing details.")?.stableKey,
    );
    expect(afterIds.get("Existing introduction.")).not.toBe("block-1");
  });

  it("distinguishes repeated blocks with the same text", () => {
    document.body.innerHTML = `
      <article>
        <p>Repeat this sentence.</p>
        <p>Repeat this sentence.</p>
      </article>
    `;

    const snapshot = extractPageSnapshot();
    const repeated = snapshot.blocks.filter(
      (block) => block.text === "Repeat this sentence.",
    );

    expect(repeated).toHaveLength(2);
    expect(repeated[0].stableKey).not.toBe(repeated[1].stableKey);
  });

  it("reports image gaps and structures table contents", () => {
    document.body.innerHTML = `
      <article>
        <h1>Coverage</h1>
        <p>Text remains available.</p>
        <img src="diagram.png" alt="Architecture diagram" />
        <table><tr><td>Not yet structured</td></tr></table>
      </article>
    `;

    const snapshot = extractPageSnapshot();

    expect(snapshot.extraction.warnings).toContain(
      "页面图片已保留为远程引用，但当前未下载到 Obsidian Vault。",
    );
    expect(snapshot.blocks.find((block) => block.type === "image")).toMatchObject({
      text: "Architecture diagram",
      image: { src: "http://localhost:3000/diagram.png", alt: "Architecture diagram" },
    });
    expect(snapshot.blocks.find((block) => block.type === "table")?.table).toEqual({
      headers: ["列 1"],
      rows: [["Not yet structured"]],
    });
  });

  it("preserves inline code, links, and admonition structure", () => {
    document.title = "Request forms - FastAPI";
    document.body.innerHTML = `
      <article>
        <h1>Request forms - FastAPI</h1>
        <p>Use <code>Form</code> and <a href="/docs">the docs</a>.</p>
        <div class="admonition warning">
          <p class="admonition-title">Warning</p>
          <p>Use <code>Body</code> when the request is not form data.</p>
          <pre><code class="language-bash">curl -X POST https://example.com</code></pre>
        </div>
        <div class="tabbed-set">
          <div class="tabbed-labels"><label>Python 3.10+</label></div>
          <div class="tabbed-content"><div class="tabbed-block">
            <pre><code>from fastapi import Form</code></pre>
          </div></div>
        </div>
      </article>
    `;

    const snapshot = extractPageSnapshot();
    const paragraph = snapshot.blocks.find((block) => block.type === "paragraph");
    const calloutBlocks = snapshot.blocks.filter((block) => block.callout);

    expect(paragraph?.inline).toEqual([
      { type: "text", text: "Use " },
      { type: "code", text: "Form" },
      { type: "text", text: " and " },
      { type: "link", text: "the docs", url: "http://localhost:3000/docs" },
      { type: "text", text: "." },
    ]);
    expect(calloutBlocks).toHaveLength(2);
    expect(calloutBlocks.map((block) => block.callout?.kind)).toEqual([
      "warning",
      "warning",
    ]);
    expect(calloutBlocks[1]).toMatchObject({ type: "code", language: "bash" });
    expect(snapshot.blocks.find((block) => block.variant)?.variant).toBe(
      "Python 3.10+",
    );
  });
});
