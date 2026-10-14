import { beforeEach, describe, expect, it } from "vitest";

import { extractWithMatureParsers } from "../src/capture/mature-parser";
import { isPageSnapshot } from "../src/capture/capture-service";

describe("mature parser integration", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    document.title = "";
    window.history.replaceState({}, "", "/tutorial");
  });

  it("uses Defuddle as the primary parser for a documentation page", () => {
    document.title = "Python 循环语句 | 菜鸟教程";
    document.body.innerHTML = `
      <header>Site navigation</header>
      <h1>菜鸟教程 -- 学的不仅是技术，更是梦想！</h1>
      <article>
        <h1>Python 循环语句</h1>
        <p>This is a sufficiently long documentation paragraph that should be selected as article content.</p>
        <pre><code class="language-python">print("hello")</code></pre>
        <img src="/diagram.png" alt="Diagram" />
      </article>
      <footer>Footer noise</footer>
    `;

    const snapshot = extractWithMatureParsers(document);

    expect(snapshot).toBeDefined();
    expect(snapshot?.extraction.structure?.parserVersion).toBe("defuddle-0.19.5");
    expect(snapshot?.title).toBe("Python 循环语句 | 菜鸟教程");
    expect(snapshot?.contentTitle).toBe("Python 循环语句");
    expect(snapshot?.blocks.some((block) => block.type === "code")).toBe(true);
    expect(snapshot?.blocks.some((block) => block.type === "image")).toBe(true);
    expect(isPageSnapshot(snapshot)).toBe(true);
    expect(snapshot?.blocks.map((block) => block.text)).not.toContain("Site navigation");
    expect(snapshot?.blocks.map((block) => block.text)).not.toContain("Footer noise");
  });

  it("recovers Runoob code and FastAPI source structures after Defuddle flattening", () => {
    document.title = "依赖项 - FastAPI";
    document.body.innerHTML = `
      <main>
        <div class="md-content__inner md-typeset">
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
        </div>
      </main>
    `;

    const snapshot = extractWithMatureParsers(document);

    expect(snapshot?.extraction.structure?.parserVersion).toBe("defuddle-0.19.5");
    expect(snapshot?.blocks.filter((block) => block.type === "list").map((block) => block.text)).toEqual([
      "/items/public/",
      "/items/private/",
      "/users/{user_id}/activate",
      "/items/pro/",
    ]);
    expect(snapshot?.blocks.at(-1)).toMatchObject({
      type: "code",
      language: "mermaid",
    });
  });

  it("recovers a Runoob Python pass example through the full parser chain", () => {
    document.title = "Python pass 语句 | 菜鸟教程";
    document.body.innerHTML = `
      <div class="article-intro" id="content">
        <h1>Python pass 语句</h1>
        <p>Python 语言 pass 语句语法格式如下：</p>
        <pre><code>pass</code></pre>
        <p>测试实例：</p>
        <div class="example">
          <h2>实例</h2>
          <div class="example_code"><div class="hl-main"><span class="hl-comment">#!/usr/bin/python</span><span class="hl-code">
</span><span class="hl-comment"># -*- coding: UTF-8 -*- </span><span class="hl-code">
 
</span><span class="hl-comment"># 输出 Python 的每个字母</span><span class="hl-code">
</span><span class="hl-reserved">for</span><span class="hl-code"> </span><span class="hl-identifier">letter</span><span class="hl-code"> </span><span class="hl-reserved">in</span><span class="hl-code"> </span><span class="hl-quotes">'</span><span class="hl-string">Python</span><span class="hl-quotes">'</span><span class="hl-code">:
   </span><span class="hl-reserved">if</span><span class="hl-code"> </span><span class="hl-identifier">letter</span><span class="hl-code"> == </span><span class="hl-quotes">'</span><span class="hl-string">h</span><span class="hl-quotes">'</span><span class="hl-code">:
      </span><span class="hl-reserved">pass</span><span class="hl-code">
      </span><span class="hl-reserved">print</span><span class="hl-code"> </span><span class="hl-quotes">'</span><span class="hl-string">这是 pass 块</span><span class="hl-quotes">'</span><span class="hl-code">
   </span><span class="hl-reserved">print</span><span class="hl-code"> </span><span class="hl-quotes">"</span><span class="hl-string">Good bye!</span><span class="hl-quotes">"</span></div></div>
        </div>
      </div>
    `;

    const snapshot = extractWithMatureParsers(document);

    expect(snapshot?.blocks.some((block) => block.type === "code" && block.text.includes("for letter in 'Python':"))).toBe(true);
  });

  it("does not leak mirrored shadow SVG labels into article paragraphs", () => {
    document.title = "依赖项 - FastAPI";
    document.body.innerHTML = `
      <main>
        <div class="md-content__inner md-typeset">
          <h1>依赖项¶</h1>
          <p>依赖关系图如下。</p>
          <div class="mermaid">
            <template data-learnflow-shadow-svg="true">
              <svg viewBox="0 0 100 50">
                <g class="node"><text>current_user</text></g>
                <g class="node"><text>active_user</text></g>
              </svg>
            </template>
          </div>
        </div>
      </main>
    `;

    const snapshot = extractWithMatureParsers(document);

    expect(snapshot?.blocks.some((block) => block.type === "diagram")).toBe(true);
    expect(snapshot?.blocks.map((block) => block.text)).not.toContain("current_user");
    expect(snapshot?.blocks.map((block) => block.text)).not.toContain("active_user");
  });

  it("keeps a rendered Mermaid diagram and an unrendered source diagram in order", () => {
    document.title = "依赖项 - FastAPI";
    document.body.innerHTML = `
      <main>
        <article id="content">
          <h1>依赖项¶</h1>
          <p>第一个图之前的说明。</p>
          <div class="mermaid">
            <template data-learnflow-shadow-svg="true">
              <svg viewBox="0 0 100 50">
                <foreignObject width="100" height="20">
                  <div xmlns="http://www.w3.org/1999/xhtml"><p>common_parameters</p></div>
                </foreignObject>
              </svg>
            </template>
          </div>
          <p>两个图之间的说明。</p>
          <pre class="mermaid"><code>graph TB
current_user --> active_user
active_user --> admin_user</code></pre>
        </article>
      </main>
    `;

    const snapshot = extractWithMatureParsers(document);

    expect(snapshot?.blocks.map((block) => block.type)).toEqual([
      "heading",
      "paragraph",
      "diagram",
      "paragraph",
      "code",
    ]);
    expect(snapshot?.blocks.at(-1)).toMatchObject({
      type: "code",
      language: "mermaid",
      text: "graph TB\ncurrent_user --> active_user\nactive_user --> admin_user",
    });
    expect(snapshot?.blocks.map((block) => block.text)).not.toContain(
      "common_parameters",
    );
  });
});
