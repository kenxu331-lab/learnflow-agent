import Defuddle from "defuddle";
import { Readability } from "@mozilla/readability";

import { adaptMatureHtml } from "./mature-adapter";
import type { PageSnapshot } from "./types";

const MERMAID_SELECTOR = ".mermaid, [data-mermaid]";
const MERMAID_PLACEHOLDER_PREFIX = "LEARNFLOW_MERMAID_PLACEHOLDER_";

function isMermaidSource(value: string): boolean {
  const text = value.trimStart();
  return (
    /^(?:graph|flowchart)\s+(?:TB|TD|BT|RL|LR)\b/i.test(text) &&
    /(?:-->|---|==>|-\.->)/.test(text)
  );
}

function mermaidSource(element: HTMLElement): string | undefined {
  const candidates = [element.textContent ?? ""];
  element.querySelectorAll<HTMLTemplateElement>("template").forEach((template) => {
    candidates.push(template.content.textContent ?? "");
  });
  return candidates
    .map((value) => value.replace(/\r\n?/g, "\n").trim())
    .find(isMermaidSource);
}

function isRenderedMermaidSvg(element: SVGElement): boolean {
  if (element.closest(MERMAID_SELECTOR)) return true;
  const id = element.getAttribute("id") ?? "";
  const role = element.getAttribute("aria-roledescription") ?? "";
  return (
    id.startsWith("__mermaid") ||
    /flowchart|graph/i.test(role) ||
    (element.querySelector(".node, [id^='flowchart-']") !== null &&
      element.querySelector(".edgePath, [id^='L-']") !== null)
  );
}

function cloneForParser(sourceDocument: Document): Document {
  const clone = sourceDocument.cloneNode(true) as Document;
  const mermaidElements = Array.from(
    clone.querySelectorAll<HTMLElement>(MERMAID_SELECTOR),
  ).filter(
    (element) => !element.parentElement?.closest(MERMAID_SELECTOR),
  );

  // Keep a positional anchor for every Mermaid container. The adapter later
  // replaces this marker with the rendered SVG or Mermaid source block from
  // the live document, so parsers cannot move diagrams to the end of an
  // article or flatten their SVG labels into prose.
  mermaidElements.forEach((element, index) => {
    const source = mermaidSource(element);
    if (source) {
      const pre = clone.createElement("pre");
      pre.className = "mermaid";
      pre.textContent = source;
      element.replaceWith(pre);
      return;
    }
    const placeholder = clone.createElement("p");
    placeholder.setAttribute(
      "data-learnflow-mermaid-placeholder",
      String(index),
    );
    placeholder.textContent = `${MERMAID_PLACEHOLDER_PREFIX}${index}`;
    element.replaceWith(placeholder);
  });

  // The shadow-root hook mirrors a rendered SVG into a template so the
  // extractor can recover it. It must never be parsed as article text.
  clone
    .querySelectorAll("template[data-learnflow-shadow-svg]")
    .forEach((marker) => marker.remove());
  clone
    .querySelectorAll("template[data-learnflow-mermaid-source]")
    .forEach((marker) => marker.remove());
  clone
    .querySelectorAll<SVGElement>(
      ".mermaid svg, svg[aria-roledescription], svg[id^='mermaid'], svg[id^='__mermaid'], svg",
    )
    .forEach((svg) => {
      if (isRenderedMermaidSvg(svg)) svg.remove();
    });
  return clone;
}

export function extractWithMatureParsers(sourceDocument: Document): PageSnapshot | undefined {
  const pageUrl = sourceDocument.location?.href || window.location.href;
  const contentHeading = [
    "#content h1",
    ".article-intro h1",
    ".article-body h1",
    "article h1",
    "main h1",
    '[role="main"] h1',
  ]
    .map((selector) => sourceDocument.querySelector(selector)?.textContent?.trim() ?? "")
    .find(Boolean) ?? "";
  const clone = cloneForParser(sourceDocument);

  try {
    const result = new Defuddle(clone, {
      debug: false,
      markdown: false,
      removeImages: false,
      removeSmallImages: false,
      standardize: true,
      useAsync: false,
    }).parse();
    const snapshot = adaptMatureHtml(
      result.content,
      pageUrl,
      sourceDocument.title || result.title || "",
      "defuddle-0.19.5",
      contentHeading,
      sourceDocument,
    );
    if (snapshot) return snapshot;
  } catch {
    // Readability is the mature parser fallback for pages Defuddle cannot parse.
  }

  try {
    const result = new Readability(cloneForParser(sourceDocument), {
      charThreshold: 200,
      keepClasses: true,
    }).parse();
    if (!result?.content) return undefined;
    return adaptMatureHtml(
      result.content,
      pageUrl,
      sourceDocument.title || result.title || "",
      "readability-0.6.0",
      contentHeading,
      sourceDocument,
    );
  } catch {
    return undefined;
  }
}
