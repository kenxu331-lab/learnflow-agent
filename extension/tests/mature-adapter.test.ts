import { beforeEach, describe, expect, it } from "vitest";

import { adaptMatureHtml } from "../src/capture/mature-adapter";

describe("mature parser adapter", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.title = "";
  });

  it("maps cleaned HTML to ordered blocks and preserves image metadata", () => {
    const snapshot = adaptMatureHtml(
      `
        <h1>Request forms</h1>
        <p>Use <code>Form</code> with <a href="/docs">the docs</a>.</p>
        <div data-callout="warning">
          <div class="callout-title">Warning</div>
          <p>Keep the request shape explicit.</p>
          <pre><code class="language-python">from fastapi import Form</code></pre>
        </div>
        <img src="/images/form.png" alt="Form diagram" title="Request shape" />
        <table><tr><th>Field</th></tr><tr><td>name</td></tr></table>
      `,
      "https://fastapi.tiangolo.com/zh/tutorial/request-forms/",
      "Request forms",
      "defuddle-0.19.5",
    );

    expect(snapshot).toBeDefined();
    expect(snapshot?.extraction.structure?.parserVersion).toBe("defuddle-0.19.5");
    expect(snapshot?.blocks.map((block) => block.type)).toEqual([
      "heading",
      "paragraph",
      "paragraph",
      "code",
      "image",
      "table",
    ]);
    expect(snapshot?.blocks[1].inline).toEqual([
      { type: "text", text: "Use " },
      { type: "code", text: "Form" },
      { type: "text", text: " with " },
      {
        type: "link",
        text: "the docs",
        url: "https://fastapi.tiangolo.com/docs",
      },
      { type: "text", text: "." },
    ]);
    expect(snapshot?.blocks[4]).toMatchObject({
      type: "image",
      text: "Form diagram",
      image: {
        src: "https://fastapi.tiangolo.com/images/form.png",
        alt: "Form diagram",
        title: "Request shape",
      },
    });
  });

  it("rejects data URLs and keeps stable keys for repeated images", () => {
    const snapshot = adaptMatureHtml(
      `<img src="data:image/png;base64,not-saved" alt="unsafe" />
       <img src="/diagram.png" alt="same" /><img src="/diagram.png" alt="same" />`,
      "https://example.com/tutorial",
      "Tutorial",
      "readability-0.6.0",
    );

    expect(snapshot?.blocks.filter((block) => block.type === "image")).toHaveLength(2);
    const images = snapshot?.blocks.filter((block) => block.type === "image") ?? [];
    expect(images[0].stableKey).not.toBe(images[1].stableKey);
    expect(snapshot?.extraction.structure?.imageCount).toBe(3);
  });

  it("preserves Mermaid diagrams as renderable Mermaid code", () => {
    const snapshot = adaptMatureHtml(
      `<pre class="mermaid"><code>graph TB
current_user --> active_user
active_user --> admin_user</code></pre>`,
      "https://fastapi.tiangolo.com/zh/tutorial/dependencies/",
      "依赖项 | FastAPI",
      "defuddle-0.19.5",
    );

    expect(snapshot?.blocks).toHaveLength(1);
    expect(snapshot?.blocks[0]).toMatchObject({
      type: "code",
      language: "mermaid",
    });
  });

  it("recovers Mermaid source kept inside a template", () => {
    document.body.innerHTML = `
      <div id="content">
        <div class="mermaid">
          <template><code>graph TD
            current_user --> active_user</code></template>
        </div>
      </div>
    `;

    const snapshot = adaptMatureHtml(
      '<p>依赖关系</p><p data-learnflow-mermaid-placeholder="0">LEARNFLOW_MERMAID_PLACEHOLDER_0</p>',
      "https://fastapi.tiangolo.com/zh/tutorial/dependencies/",
      "依赖项",
      "defuddle-0.19.5",
      undefined,
      document,
    );

    expect(snapshot?.blocks).toContainEqual(
      expect.objectContaining({
        type: "code",
        language: "mermaid",
        text: "graph TD\n            current_user --> active_user",
      }),
    );
  });

  it("recovers a source snapshot captured before Mermaid replaces the host", () => {
    document.body.innerHTML = `
      <div id="content"><div class="mermaid"></div></div>
      <template data-learnflow-mermaid-source="true" data-index="0">graph TB
        current_user --> active_user</template>
    `;

    const snapshot = adaptMatureHtml(
      '<p data-learnflow-mermaid-placeholder="0">LEARNFLOW_MERMAID_PLACEHOLDER_0</p>',
      "https://fastapi.tiangolo.com/zh/tutorial/dependencies/",
      "依赖项",
      "defuddle-0.19.5",
      undefined,
      document,
    );

    expect(snapshot?.blocks).toContainEqual(
      expect.objectContaining({
        type: "code",
        language: "mermaid",
        text: "graph TB\n        current_user --> active_user",
      }),
    );
  });

  it("reports an empty Mermaid source container instead of silently dropping it", () => {
    document.body.innerHTML = `
      <div id="content">
        <pre><code>print(1)</code></pre>
        <div class="mermaid"></div>
      </div>
    `;

    const snapshot = adaptMatureHtml(
      "<p>正文</p>",
      "https://fastapi.tiangolo.com/zh/tutorial/dependencies/",
      "依赖项",
      "defuddle-0.19.5",
      undefined,
      document,
    );

    expect(snapshot?.extraction.warnings).toContain(
      "页面包含 Mermaid 容器，但当前 DOM 未提供可恢复的图源码。",
    );
    expect(snapshot?.blocks.map((block) => block.text)).not.toContain(
      "LEARNFLOW_MERMAID_PLACEHOLDER_0",
    );
  });

  it("keeps a rendered Mermaid SVG when the source text is unavailable", () => {
    document.body.innerHTML = `
      <div id="content">
        <div class="mermaid">
          <template data-learnflow-shadow-svg="true"><svg viewBox="0 0 100 100">
            <g class="node" id="flowchart-current_user-0"><text>current_user</text></g>
            <g class="node" id="flowchart-active_user-1"><text>active_user</text></g>
            <g class="edgePath" id="L-current_user-active_user-0"><path d="M0 0" /></g>
          </svg></template>
        </div>
      </div>
    `;

    const snapshot = adaptMatureHtml(
      "<p>依赖关系</p>",
      "https://fastapi.tiangolo.com/zh/tutorial/dependencies/",
      "依赖项",
      "defuddle-0.19.5",
      undefined,
      document,
    );

    expect(snapshot?.extraction.warnings).not.toContain(
      "页面包含 Mermaid 容器，但当前 DOM 未提供可恢复的图源码。",
    );
    expect(snapshot?.blocks.some((block) => block.type === "diagram")).toBe(true);
    expect(snapshot?.blocks.find((block) => block.type === "diagram")?.diagram?.svg).toContain(
      "flowchart-current_user",
    );
  });

  it("inlines Mermaid page styles into a detached SVG asset", () => {
    document.head.innerHTML = `
      <style>
        .mermaid .node rect { fill: rgb(236, 236, 255); stroke: rgb(147, 112, 219); }
      </style>
    `;
    document.body.innerHTML = `
      <div id="content">
        <div class="mermaid">
          <svg viewBox="0 0 100 50">
            <g class="node"><rect x="1" y="1" width="98" height="48" /></g>
          </svg>
        </div>
      </div>
    `;

    const snapshot = adaptMatureHtml(
      "<p>依赖关系</p>",
      "https://fastapi.tiangolo.com/zh/tutorial/dependencies/",
      "依赖项",
      "defuddle-0.19.5",
      undefined,
      document,
    );

    const diagram = snapshot?.blocks.find((block) => block.type === "diagram");
    expect(diagram?.diagram?.svg).toContain("fill: rgb(236, 236, 255)");
    expect(diagram?.diagram?.svg).toContain("stroke: rgb(147, 112, 219)");
    expect(diagram?.diagram?.svg).not.toContain("var(");
  });

  it("restores Runoob highlighted source code without importing comments", () => {
    document.body.innerHTML = `
      <div class="article-intro" id="content">
        <h1>Python While 循环语句</h1>
        <div class="example">
          <h2>实例</h2>
          <div class="example_code">
            <div class="hl-main"><span class="hl-comment">#!/usr/bin/python</span><span class="hl-code">\n\n</span><span class="hl-identifier">count</span><span class="hl-code"> = </span><span class="hl-number">0</span><span class="hl-code">\n</span><span class="hl-identifier">while</span><span class="hl-code"> (count &lt; 9):\n   </span><span class="hl-reserved">print</span><span class="hl-code"> count</span></div>
          </div>
        </div>
      </div>
      <div id="comments">
        <ol class="commentlist"><li class="comment"><pre>comment code must be ignored</pre></li></ol>
      </div>
    `;

    const snapshot = adaptMatureHtml(
      `<div><h2>实例</h2><p>count = 0 while (count &lt; 9): print count</p></div>`,
      "https://www.runoob.com/python/python-while-loop.html",
      "Python While 循环语句 | 菜鸟教程",
      "defuddle-0.19.5",
      "Python While 循环语句",
      document,
    );

    expect(snapshot?.blocks.map((block) => block.type)).toEqual([
      "heading",
      "code",
    ]);
    expect(snapshot?.blocks.at(-1)).toMatchObject({
      type: "code",
      text: "#!/usr/bin/python\n\ncount = 0\nwhile (count < 9):\n   print count",
    });
    expect(snapshot?.blocks.map((block) => block.text)).not.toContain(
      "comment code must be ignored",
    );
  });

  it("restores the Python pass example code from Runoob's live shape", () => {
    document.body.innerHTML = `
      <div class="article-intro" id="content">
        <h1>Python pass 语句</h1>
        <p>Python 语言 pass 语句语法格式如下：</p>
        <pre class="prettyprint"><code>pass</code></pre>
        <p>测试实例：</p>
        <div class="example">
          <h2 class="example">实例</h2>
          <div class="example_code">
            <div class="hl-main"><span class="hl-comment">#!/usr/bin/python</span><span class="hl-code">\n</span><span class="hl-comment"># -*- coding: UTF-8 -*- </span><span class="hl-code">\n \n</span><span class="hl-comment"># 输出 Python 的每个字母</span><span class="hl-code">\n</span><span class="hl-reserved">for</span><span class="hl-code"> </span><span class="hl-identifier">letter</span><span class="hl-code"> </span><span class="hl-reserved">in</span><span class="hl-code"> </span><span class="hl-quotes">'</span><span class="hl-string">Python</span><span class="hl-quotes">'</span><span class="hl-code">:\n   </span><span class="hl-reserved">if</span><span class="hl-code"> </span><span class="hl-identifier">letter</span><span class="hl-code"> == </span><span class="hl-quotes">'</span><span class="hl-string">h</span><span class="hl-quotes">'</span><span class="hl-code">:\n      </span><span class="hl-reserved">pass</span><span class="hl-code">\n      </span><span class="hl-reserved">print</span><span class="hl-code"> </span><span class="hl-quotes">'</span><span class="hl-string">这是 pass 块</span><span class="hl-quotes">'</span><span class="hl-code">\n   </span><span class="hl-reserved">print</span><span class="hl-code"> </span><span class="hl-quotes">"</span><span class="hl-string">Good bye!</span><span class="hl-quotes">"</span></div>
          </div>
        </div>
      </div>
      <div id="comments"><ol class="commentlist"><li class="comment"><pre>comment code must be ignored</pre></li></ol></div>
    `;

    const snapshot = adaptMatureHtml(
      `<div><h2>实例</h2><p>for letter in 'Python': if letter == 'h': pass print '这是 pass 块' print "Good bye!"</p></div>`,
      "https://www.runoob.com/python/python-pass-statement.html",
      "Python pass 语句 | 菜鸟教程",
      "defuddle-0.19.5",
      "Python pass 语句",
      document,
    );

    expect(snapshot?.blocks.filter((block) => block.type === "code")).toHaveLength(1);
    expect(snapshot?.blocks.find((block) => block.type === "code")?.text).toContain(
      "for letter in 'Python':",
    );
    expect(snapshot?.blocks.map((block) => block.text)).not.toContain(
      "comment code must be ignored",
    );
  });

  it("restores source pre blocks when a parser flattens them into paragraphs", () => {
    document.body.innerHTML = `
      <div id="content">
        <h1>Python 循环语句</h1>
        <pre class="example_code"><code>count = 0
while (count &lt; 9):
    print count</code></pre>
      </div>
      <ul class="comments"><li><pre>comment code must be ignored</pre></li></ul>
    `;

    const snapshot = adaptMatureHtml(
      `<h2>实例</h2><p>count = 0 while (count &lt; 9): print count</p>`,
      "https://www.runoob.com/python/python-while-loop.html",
      "Python 循环语句 | 菜鸟教程",
      "defuddle-0.19.5",
      "Python 循环语句",
      document,
    );

    expect(snapshot?.blocks).toHaveLength(2);
    expect(snapshot?.blocks[1]).toMatchObject({
      type: "code",
      text: "count = 0\nwhile (count < 9):\n    print count",
    });
    expect(snapshot?.blocks.map((block) => block.text)).not.toContain(
      "comment code must be ignored",
    );
  });

  it("keeps endpoint lists and Mermaid dependency diagrams", () => {
    document.body.innerHTML = `
      <div class="md-content">
        <article class="md-content__inner md-typeset">
          <h1>依赖项¶</h1>
          <pre><code>from fastapi import Depends</code></pre>
          <p>例如，假设你有 4 个 API 路径操作（端点）：</p>
          <ul>
            <li><code>/items/public/</code></li>
            <li><code>/items/private/</code></li>
            <li><code>/users/{user_id}/activate</code></li>
            <li><code>/items/pro/</code></li>
          </ul>
          <p>你可以仅通过依赖项及其子依赖项为它们添加不同的权限要求：</p>
          <div class="mermaid">graph TB
current_user --> active_user
active_user --> admin_user
admin_user --> activate_user</div>
        </article>
      </div>
      <div class="comments"><pre>comment code must be ignored</pre></div>
    `;

    const snapshot = adaptMatureHtml(
      `<article><h2>简单而强大</h2>
       <p>例如，假设你有 4 个 API 路径操作（端点）：</p>
       <p>你可以仅通过依赖项及其子依赖项为它们添加不同的权限要求：</p>
       <p>graph TB current_user --&gt; active_user active_user --&gt; admin_user admin_user --&gt; activate_user</p></article>`,
      "https://fastapi.tiangolo.com/zh/tutorial/dependencies/",
      "依赖项",
      "defuddle-0.19.5",
      "依赖项",
      document,
    );

    const endpointBlocks = snapshot?.blocks.filter(
      (block) => block.type === "list",
    ) ?? [];
    expect(endpointBlocks.map((block) => block.text)).toEqual([
      "/items/public/",
      "/items/private/",
      "/users/{user_id}/activate",
      "/items/pro/",
    ]);
    expect(snapshot?.blocks.at(-1)).toMatchObject({
      type: "code",
      language: "mermaid",
      text: "graph TB\ncurrent_user --> active_user\nactive_user --> admin_user\nadmin_user --> activate_user",
    });
    expect(snapshot?.blocks.map((block) => block.text)).not.toContain(
      "comment code must be ignored",
    );
  });

  it("restores multiple Mermaid containers at their source positions", () => {
    document.body.innerHTML = `
      <main>
        <article id="content">
          <h1>依赖项</h1>
          <div class="mermaid">
            <template data-learnflow-shadow-svg="true">
              <svg viewBox="0 0 100 50">
                <foreignObject width="100" height="20">
                  <div xmlns="http://www.w3.org/1999/xhtml"><p>common_parameters</p></div>
                </foreignObject>
              </svg>
            </template>
          </div>
          <p>两个图之间的正文。</p>
          <pre class="mermaid"><code>graph TB
current_user --> active_user
active_user --> admin_user</code></pre>
        </article>
      </main>
    `;

    const snapshot = adaptMatureHtml(
      `<h1>依赖项</h1>
       <p data-learnflow-mermaid-placeholder="0">LEARNFLOW_MERMAID_PLACEHOLDER_0</p>
       <p>两个图之间的正文。</p>
       <p data-learnflow-mermaid-placeholder="1">LEARNFLOW_MERMAID_PLACEHOLDER_1</p>`,
      "https://fastapi.tiangolo.com/zh/tutorial/dependencies/",
      "依赖项",
      "defuddle-0.19.5",
      "依赖项",
      document,
    );

    expect(snapshot?.blocks.map((block) => block.type)).toEqual([
      "heading",
      "diagram",
      "paragraph",
      "code",
    ]);
    expect(snapshot?.blocks[3]).toMatchObject({
      type: "code",
      language: "mermaid",
      text: "graph TB\ncurrent_user --> active_user\nactive_user --> admin_user",
    });
    expect(snapshot?.blocks.map((block) => block.text)).not.toContain(
      "common_parameters",
    );
  });

  it("keeps a page-level Mermaid SVG when no host class survives", () => {
    document.body.innerHTML = `
      <main>
        <article id="content">
          <ul><li>正文锚点</li></ul>
          <svg id="__mermaid_1" class="flowchart" viewBox="0 0 100 50">
            <g class="node" id="flowchart-a-0"><text>a</text></g>
            <g class="edgePath" id="L-a-b-0"><path d="M0 0" /></g>
          </svg>
        </article>
      </main>
    `;

    const snapshot = adaptMatureHtml(
      "<p>正文</p>",
      "https://fastapi.tiangolo.com/zh/tutorial/dependencies/",
      "依赖项",
      "defuddle-0.19.5",
      undefined,
      document,
    );

    expect(snapshot?.blocks.some((block) => block.type === "diagram")).toBe(true);
  });
});
