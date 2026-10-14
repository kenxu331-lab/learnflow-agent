import type {
  CalloutKind,
  CalloutMetadata,
  DiagramData,
  ImageData,
  InlineSegment,
  PageSnapshot,
  TableData,
} from "./types";
import { inlineRenderedSvgStyles } from "./rendered-svg";

const MAX_BLOCKS = 300;
const MAX_CHARACTERS = 60_000;
const MAX_CODE_CHARACTERS = 12_000;
const MAX_DIAGRAM_SVG_CHARACTERS = 200_000;
const MERMAID_SELECTOR = ".mermaid, [data-mermaid]";
const MERMAID_PLACEHOLDER_PREFIX = "LEARNFLOW_MERMAID_PLACEHOLDER_";

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function trimCode(value: string): string {
  const lines = value.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length > 0 && lines[0].trim() === "") lines.shift();
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  return lines.join("\n");
}

function addInlineSegment(segments: InlineSegment[], segment: InlineSegment): void {
  if (!segment.text) return;
  const previous = segments[segments.length - 1];
  if (previous && previous.type === segment.type && previous.url === segment.url) {
    previous.text += segment.text;
    return;
  }
  segments.push(segment);
}

function getInlineSegments(
  element: HTMLElement,
  pageUrl: string,
): InlineSegment[] | undefined {
  const segments: InlineSegment[] = [];

  function visit(node: Node, linkUrl?: string): void {
    if (node.nodeType === Node.TEXT_NODE) {
      addInlineSegment(segments, {
        type: linkUrl ? "link" : "text",
        text: (node.textContent ?? "").replace(/\s+/g, " "),
        ...(linkUrl ? { url: linkUrl } : {}),
      });
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.matches("code")) {
      addInlineSegment(segments, {
        type: "code",
        text: (node.textContent ?? "").replace(/\s+/g, " "),
        ...(linkUrl ? { url: linkUrl } : {}),
      });
      return;
    }
    if (node.matches("a")) {
      let resolvedUrl: string | undefined;
      try {
        const candidate = new URL(node.getAttribute("href") ?? "", pageUrl);
        if (candidate.protocol === "http:" || candidate.protocol === "https:") {
          resolvedUrl = candidate.toString();
        }
      } catch {
        resolvedUrl = undefined;
      }
      node.childNodes.forEach((child) => visit(child, resolvedUrl));
      return;
    }
    node.childNodes.forEach((child) => visit(child, linkUrl));
  }

  element.childNodes.forEach((child) => visit(child));
  const meaningful = segments.filter((segment) => segment.text.trim());
  return meaningful.length > 1 || meaningful.some((segment) => segment.type !== "text")
    ? meaningful
    : undefined;
}

function getLanguage(element: HTMLElement): string | undefined {
  const code = element.querySelector("code");
  const className = `${element.className} ${code?.className ?? ""}`;
  const declared =
    element.getAttribute("data-language") ??
    element.getAttribute("data-lang") ??
    code?.getAttribute("data-language") ??
    code?.getAttribute("data-lang");
  const match = declared?.match(/[\w+-]+/) ?? className.match(/(?:language|lang)-([\w+-]+)/i);
  return match?.[1] ?? match?.[0];
}

function inferLanguage(text: string): string | undefined {
  const trimmed = text.trimStart();
  return /^(?:graph|flowchart)\s+(?:TB|TD|BT|RL|LR)\b/i.test(trimmed) &&
    /(?:-->|---|==>|-\.->)/.test(trimmed)
    ? "mermaid"
    : undefined;
}

function getVariantLabel(element: HTMLElement): string | undefined {
  const set = element.closest<HTMLElement>(".tabbed-set");
  const block = element.closest<HTMLElement>(".tabbed-block");
  if (!set || !block) return undefined;
  const index = Array.from(set.querySelectorAll(".tabbed-block")).indexOf(block);
  const labels = Array.from(set.querySelectorAll<HTMLElement>(".tabbed-labels label"));
  return normalizeText(labels[index]?.textContent ?? "") || undefined;
}

function getTableData(element: HTMLTableElement): TableData | undefined {
  const rows = Array.from(element.querySelectorAll<HTMLTableRowElement>("tr"));
  if (rows.length === 0) return undefined;
  const cells = (row: HTMLTableRowElement): string[] =>
    Array.from(row.querySelectorAll<HTMLElement>("th, td")).map((cell) =>
      normalizeText(cell.textContent ?? ""),
    );
  const first = cells(rows[0]);
  const hasHeader = rows[0].querySelector("th") !== null;
  return {
    headers: hasHeader ? first : first.map((_, index) => `列 ${index + 1}`),
    rows: (hasHeader ? rows.slice(1) : rows).map(cells),
  };
}

function resolveImage(element: HTMLImageElement, pageUrl: string): ImageData | undefined {
  const rawSource =
    element.currentSrc ||
    element.getAttribute("src") ||
    element.getAttribute("data-src") ||
    element.getAttribute("data-lazy-src") ||
    element.getAttribute("data-original");
  if (!rawSource) return undefined;
  try {
    const source = new URL(rawSource, pageUrl);
    if (source.protocol !== "http:" && source.protocol !== "https:") return undefined;
    return {
      src: source.toString().slice(0, 2048),
      alt: (element.getAttribute("alt") ?? "").slice(0, 500),
      ...(element.getAttribute("title")
        ? { title: element.getAttribute("title")?.slice(0, 500) }
        : {}),
    };
  } catch {
    return undefined;
  }
}

function isRenderedMermaidSvg(element: SVGElement): boolean {
  if (element.closest(".mermaid, [data-mermaid]")) return true;
  const role = element.getAttribute("aria-roledescription") ?? "";
  return (
    /flowchart|graph/i.test(role) ||
    (element.querySelector(".node, [id^='flowchart-']") !== null &&
      element.querySelector(".edgePath, [id^='L-']") !== null)
  );
}

function sanitizeRenderedSvg(element: SVGElement): string | undefined {
  const clone = element.cloneNode(true) as SVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  inlineRenderedSvgStyles(element, clone);
  clone.querySelectorAll("script, iframe, object, embed").forEach((node) => {
    node.remove();
  });
  clone.querySelectorAll<HTMLElement>("*").forEach((node) => {
    Array.from(node.attributes).forEach((attribute) => {
      const name = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (
        name.startsWith("on") ||
        ((name === "href" || name === "xlink:href") &&
          !value.startsWith("#")) ||
        (name === "style" && /url\s*\(\s*(?!#)/i.test(value))
      ) {
        node.removeAttribute(attribute.name);
      }
    });
  });
  const serialized = new XMLSerializer().serializeToString(clone);
  if (
    serialized.length > MAX_DIAGRAM_SVG_CHARACTERS ||
    !/^\s*<svg(?:\s|>)/i.test(serialized) ||
    /<script\b|\bon[a-z]+\s*=/i.test(serialized)
  ) {
    return undefined;
  }
  return serialized;
}

function isMermaidSource(value: string): boolean {
  return inferLanguage(value) === "mermaid";
}

function mermaidElements(sourceRoot: Element): HTMLElement[] {
  return Array.from(sourceRoot.querySelectorAll<HTMLElement>(MERMAID_SELECTOR))
    .filter((element) => !isCommentContent(element))
    .filter((element) => !element.parentElement?.closest(MERMAID_SELECTOR));
}

function renderedSvgForMermaidElement(element: HTMLElement): string | undefined {
  const candidates = Array.from(
    element.querySelectorAll<SVGElement>(
      "svg[aria-roledescription], svg[id^='mermaid'], svg[id^='__mermaid'], svg",
    ),
  ).filter(isRenderedMermaidSvg);
  for (const candidate of candidates) {
    const sanitized = sanitizeRenderedSvg(candidate);
    if (sanitized) return sanitized;
  }

  for (const marker of element.querySelectorAll<HTMLTemplateElement>(
    "template[data-learnflow-shadow-svg]",
  )) {
    const holder = document.createElement("div");
    holder.innerHTML = marker.innerHTML;
    const svg = holder.querySelector<SVGElement>("svg");
    const sanitized = svg ? sanitizeRenderedSvg(svg) : undefined;
    if (sanitized) return sanitized;
  }
  return undefined;
}

function collectRenderedMermaidSvgs(
  sourceDocument: Document,
  sourceRoot: Element,
): string[] {
  const seen = new Set<SVGElement>();
  const seenMarkup = new Set<string>();
  const rendered: string[] = [];
  const add = (svg: string | undefined): void => {
    if (!svg || seenMarkup.has(svg)) return;
    seenMarkup.add(svg);
    rendered.push(svg);
  };
  const roots = [sourceRoot, sourceDocument.body ?? sourceDocument.documentElement];
  for (const root of roots) {
    const candidates = Array.from(
      root.querySelectorAll<SVGElement>(
        ".mermaid svg, svg[aria-roledescription], svg[id^='mermaid'], svg[id^='__mermaid'], svg",
      ),
    );
    for (const candidate of candidates) {
      if (seen.has(candidate) || !isRenderedMermaidSvg(candidate)) continue;
      seen.add(candidate);
      add(sanitizeRenderedSvg(candidate));
    }
  }

  const markers = Array.from(
    sourceDocument.querySelectorAll<HTMLTemplateElement>(
      "template[data-learnflow-shadow-svg]",
    ),
  );
  for (const marker of markers) {
    const holder = document.createElement("div");
    holder.innerHTML = marker.innerHTML;
    const svg = holder.querySelector<SVGElement>("svg");
    const sanitized = svg ? sanitizeRenderedSvg(svg) : undefined;
    add(sanitized);
  }
  return rendered;
}

function makeRenderedDiagram(svg: string): HTMLElement {
  const wrapper = document.createElement("div");
  wrapper.setAttribute("data-learnflow-diagram", "true");
  wrapper.innerHTML = svg;
  return wrapper;
}

function makeMermaidSourceBlock(source: string): HTMLElement {
  const pre = document.createElement("pre");
  pre.className = "mermaid";
  const code = document.createElement("code");
  code.className = "language-mermaid";
  code.textContent = source;
  pre.append(code);
  return pre;
}

function findMermaidPlaceholder(
  root: HTMLElement,
  index: number,
): HTMLElement | undefined {
  const token = `${MERMAID_PLACEHOLDER_PREFIX}${index}`;
  return (
    root.querySelector<HTMLElement>(
      `[data-learnflow-mermaid-placeholder="${index}"]`,
    ) ??
    Array.from(root.querySelectorAll<HTMLElement>("*"))
      .reverse()
      .find((element) => normalizeText(element.textContent ?? "") === token)
  );
}

interface MermaidRestoreResult {
  restoredCount: number;
  unavailableCount: number;
}

function restoreMermaidBlocks(
  root: HTMLElement,
  sourceDocument: Document | undefined,
): MermaidRestoreResult {
  if (!sourceDocument) return { restoredCount: 0, unavailableCount: 0 };
  const sourceRoot = findSourceContentRoot(sourceDocument);
  if (!sourceRoot) return { restoredCount: 0, unavailableCount: 0 };

  let restoredCount = 0;
  let unavailableCount = 0;
  const globalSvgs = collectRenderedMermaidSvgs(sourceDocument, sourceRoot);
  const sourceElements = mermaidElements(sourceRoot);
  const capturedSources = capturedMermaidSources(sourceDocument);
  sourceElements.forEach((element, index) => {
    const svg = renderedSvgForMermaidElement(element);
    const source = mermaidSourceText(element) || capturedSources.get(index) || "";
    if (svg) {
      const duplicateIndex = globalSvgs.indexOf(svg);
      if (duplicateIndex >= 0) globalSvgs.splice(duplicateIndex, 1);
    }
    const fallbackSvg =
      svg ?? (!isMermaidSource(source) ? globalSvgs.shift() : undefined);
    const replacement = fallbackSvg
      ? makeRenderedDiagram(fallbackSvg)
      : isMermaidSource(source)
        ? makeMermaidSourceBlock(source)
        : undefined;
    if (!replacement) {
      // The parser placeholder is an internal positional token. If neither
      // SVG nor Mermaid source can be recovered, never expose that token as
      // tutorial prose in the saved Markdown.
      findMermaidPlaceholder(root, index)?.remove();
      unavailableCount += 1;
      return;
    }

    const placeholder = findMermaidPlaceholder(root, index);
    if (placeholder) {
      placeholder.replaceWith(replacement);
      restoredCount += 1;
      return;
    }

    // Direct adapter callers and the legacy parser can already contain the
    // Mermaid source in their parsed HTML. restoreSourceCodeBlocks handles
    // that in-place; rendered SVGs have no textual anchor, so preserve the
    // old append fallback only when no parser placeholder survived.
    if (fallbackSvg) {
      root.append(replacement);
      restoredCount += 1;
    }
  });

  // Some FastAPI builds expose the rendered SVG directly in the article
  // instead of nesting it under a .mermaid host. Preserve those diagrams even
  // when no source container survived in the live DOM.
  for (const svg of globalSvgs) {
    root.append(makeRenderedDiagram(svg));
    restoredCount += 1;
  }
  return { restoredCount, unavailableCount };
}

function comparableCodeText(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(/\s+/g, " ").trim();
}

function findSourceContentRoot(sourceDocument: Document): Element | undefined {
  const selectors = [
    "#content",
    ".article-intro",
    ".article-body",
    ".md-content__inner",
    "article",
    "main",
  ];
  for (const selector of selectors) {
    const candidate = sourceDocument.querySelector(selector);
    if (
      candidate?.querySelector(
        "pre, .example_code .hl-main, .mermaid, [data-mermaid], ul, ol",
      )
    ) {
      return candidate;
    }
  }
  return undefined;
}

interface SourceCodeEntry {
  element: HTMLElement;
  key: string;
}

function isCommentContent(element: HTMLElement): boolean {
  return Boolean(
    element.closest(
      "[class*='comment' i], [id*='comment' i], .comments, #postcomments, .commentlist",
    ),
  );
}

function sourceCodeText(element: HTMLElement): string {
  const candidates: string[] = [];
  const attributeNames = [
    "data-code",
    "data-source",
    "data-mermaid",
    "data-learnflow-mermaid-source",
  ];
  const addAttributes = (node: Element): void => {
    for (const name of attributeNames) {
      const value = node.getAttribute(name);
      if (value) candidates.push(value);
    }
  };

  addAttributes(element);
  element.querySelectorAll("template, code, pre").forEach(addAttributes);
  candidates.push(element.textContent ?? "");
  element.querySelectorAll<HTMLTemplateElement>("template").forEach((template) => {
    candidates.push(template.content.textContent ?? "");
  });

  // Some renderers keep the original Mermaid source in an HTML comment while
  // replacing the visible container with SVG. It is safe to inspect comments
  // here because only Mermaid-shaped source is accepted below.
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_COMMENT);
  let comment: Node | null;
  while ((comment = walker.nextNode())) {
    candidates.push(comment.textContent ?? "");
  }

  const normalized = candidates.map(trimCode).filter(Boolean);
  return normalized.find((candidate) => isMermaidSource(candidate)) ?? normalized[0] ?? "";
}

function mermaidSourceText(element: HTMLElement): string {
  const source = sourceCodeText(element);
  return isMermaidSource(source) ? source : "";
}

function capturedMermaidSources(sourceDocument: Document): Map<number, string> {
  const captured = new Map<number, string>();
  sourceDocument
    .querySelectorAll<HTMLTemplateElement>(
      "template[data-learnflow-mermaid-source][data-index]",
    )
    .forEach((template) => {
      const index = Number(template.getAttribute("data-index"));
      const source = trimCode(template.content.textContent ?? "");
      if (Number.isInteger(index) && index >= 0 && isMermaidSource(source)) {
        captured.set(index, source);
      }
    });
  return captured;
}

function sourceCodeEntries(sourceRoot: Element): SourceCodeEntry[] {
  const seen = new Set<Element>();
  return Array.from(
    sourceRoot.querySelectorAll<HTMLElement>(
      "pre, .example_code .hl-main, .mermaid, [data-mermaid]",
    ),
  )
    .filter((element) => {
      if (seen.has(element) || isCommentContent(element)) return false;
      seen.add(element);
      return Boolean(sourceCodeText(element));
    })
    .map((element) => ({
      element,
      key: comparableCodeText(sourceCodeText(element)),
    }))
    .filter((entry) => entry.key);
}

function makeCodeElement(entry: SourceCodeEntry): HTMLElement {
  if (entry.element.matches("pre")) {
    return entry.element.cloneNode(true) as HTMLElement;
  }

  const pre = document.createElement("pre");
  if (entry.element.matches(".mermaid, [data-mermaid]")) {
    pre.className = "mermaid";
  }
  const code = document.createElement("code");
  code.textContent = sourceCodeText(entry.element);
  pre.append(code);
  return pre;
}

function findMatchingSourceCode(
  sourceBlocks: SourceCodeEntry[],
  used: Set<number>,
  key: string,
): number {
  const exact = sourceBlocks.findIndex(
    (entry, candidateIndex) => !used.has(candidateIndex) && entry.key === key,
  );
  if (exact >= 0) return exact;

  // Runoob's highlighter marks shebang/comment lines with `.hl-comment`.
  // Defuddle removes those spans while flattening `.hl-main`, so match the
  // remaining substantial code body only for that known source container.
  if (key.length < 20) return -1;
  return sourceBlocks.findIndex(
    (entry, candidateIndex) =>
      !used.has(candidateIndex) &&
      entry.element.matches(".example_code .hl-main") &&
      entry.key.includes(key),
  );
}

function restoreSourceCodeBlocks(
  root: HTMLElement,
  sourceDocument: Document | undefined,
): number {
  if (!sourceDocument) return 0;
  const sourceRoot = findSourceContentRoot(sourceDocument);
  if (!sourceRoot) return 0;
  const emptyMermaidCount = Array.from(
    sourceRoot.querySelectorAll<HTMLElement>(".mermaid, [data-mermaid]"),
  ).filter((element) => !isCommentContent(element) && !sourceCodeText(element))
    .length;
  const sourceBlocks = sourceCodeEntries(sourceRoot);
  const used = new Set<number>();

  root.querySelectorAll<HTMLElement>("pre").forEach((block) => {
    const key = comparableCodeText(block.textContent ?? "");
    const index = findMatchingSourceCode(sourceBlocks, used, key);
    if (index >= 0) used.add(index);
  });

  root
    .querySelectorAll<HTMLElement>(
      ".example_code .hl-main, .mermaid, [data-mermaid]",
    )
    .forEach((block) => {
      const key = comparableCodeText(block.textContent ?? "");
      const index = findMatchingSourceCode(sourceBlocks, used, key);
      if (index < 0) return;
      block.replaceWith(makeCodeElement(sourceBlocks[index]));
      used.add(index);
    });

  root.querySelectorAll<HTMLElement>("p").forEach((paragraph) => {
    const key = comparableCodeText(paragraph.textContent ?? "");
    if (!key) return;
    const index = findMatchingSourceCode(sourceBlocks, used, key);
    if (index < 0) return;
    paragraph.replaceWith(makeCodeElement(sourceBlocks[index]));
    used.add(index);
  });
  return emptyMermaidCount;
}

function listSignature(element: HTMLElement): string {
  return Array.from(element.children)
    .filter((child): child is HTMLElement => child.matches("li"))
    .map((item) => normalizeText(item.textContent ?? ""))
    .join("\u0000");
}

function findParsedAnchor(root: HTMLElement, text: string): HTMLElement | undefined {
  if (!text) return undefined;
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      "h1, h2, h3, h4, h5, h6, p, pre, ul, ol, table",
    ),
  ).find((element) => normalizeText(element.textContent ?? "") === text);
}

function insertAfter(element: HTMLElement, inserted: HTMLElement): void {
  element.parentElement?.insertBefore(inserted, element.nextSibling);
}

function restoreSourceLists(
  root: HTMLElement,
  sourceDocument: Document | undefined,
): void {
  if (!sourceDocument) return;
  const sourceRoot = findSourceContentRoot(sourceDocument);
  if (!sourceRoot) return;

  const parsedSignatures = new Set(
    Array.from(root.querySelectorAll<HTMLElement>("ul, ol"))
      .map(listSignature)
      .filter(Boolean),
  );
  const sourceLists = Array.from(
    sourceRoot.querySelectorAll<HTMLElement>("ul, ol"),
  ).filter((list) => {
    if (list.closest("pre, code") || list.parentElement?.closest("li")) {
      return false;
    }
    return Boolean(listSignature(list));
  });

  for (const sourceList of sourceLists) {
    const signature = listSignature(sourceList);
    if (!signature || parsedSignatures.has(signature)) continue;

    const previousSibling = sourceList.previousElementSibling;
    const nextSibling = sourceList.nextElementSibling;
    const previousAnchor = findParsedAnchor(
      root,
      normalizeText(previousSibling?.textContent ?? ""),
    );
    const nextAnchor = findParsedAnchor(
      root,
      normalizeText(nextSibling?.textContent ?? ""),
    );
    const restored = sourceList.cloneNode(true) as HTMLElement;
    if (previousAnchor) {
      insertAfter(previousAnchor, restored);
    } else if (nextAnchor?.parentElement) {
      nextAnchor.parentElement.insertBefore(restored, nextAnchor);
    } else {
      root.append(restored);
    }
    parsedSignatures.add(signature);
  }
}

function hashString(value: string, seed: number): string {
  let hash = seed;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function adaptMatureHtml(
  html: string,
  pageUrl: string,
  title: string,
  parserVersion: string,
  contentTitle?: string,
  sourceDocument?: Document,
): PageSnapshot | undefined {
  const root = document.createElement("div");
  root.innerHTML = html;
  restoreSourceCodeBlocks(root, sourceDocument);
  const mermaidRestore = restoreMermaidBlocks(root, sourceDocument);
  restoreSourceLists(root, sourceDocument);
  const blocks: PageSnapshot["blocks"] = [];
  const warnings: string[] = [];
  if (mermaidRestore.unavailableCount > 0) {
    warnings.push("页面包含 Mermaid 容器，但当前 DOM 未提供可恢复的图源码。");
  }
  const occurrences = new Map<string, number>();
  const calloutIds = new Map<Element, string>();
  let calloutSequence = 0;
  let characterCount = 0;
  let codeBlockCount = 0;
  let truncated = false;

  const stableKey = (
    type: string,
    text: string,
    language: string | undefined,
    callout: CalloutMetadata | undefined,
    variant: string | undefined,
    image: ImageData | undefined,
    table: TableData | undefined,
    diagram: DiagramData | undefined,
  ): string => {
    const signature = `${type}\u0000${language ?? ""}\u0000${
      callout?.id ?? ""
    }\u0000${variant ?? ""}\u0000${image?.src ?? ""}\u0000${
      table ? "table" : ""
    }\u0000${diagram ? hashString(diagram.svg, 2166136261) : ""}\u0000${text}`;
    const occurrence = occurrences.get(signature) ?? 0;
    occurrences.set(signature, occurrence + 1);
    return `v1-${hashString(signature, 2166136261)}${hashString(
      signature,
      16777619,
    )}-${occurrence}`;
  };

  function addBlock(
    type: PageSnapshot["blocks"][number]["type"],
    rawText: string,
    options: {
      level?: number;
      language?: string;
      inline?: InlineSegment[];
      callout?: CalloutMetadata;
      variant?: string;
      table?: TableData;
      image?: ImageData;
      diagram?: DiagramData;
    } = {},
  ): void {
    if (blocks.length >= MAX_BLOCKS || characterCount >= MAX_CHARACTERS) {
      truncated = true;
      return;
    }
    let text = rawText;
    if (type === "code" && text.length > MAX_CODE_CHARACTERS) {
      text = text.slice(0, MAX_CODE_CHARACTERS);
      truncated = true;
      warnings.push("代码块超过单块上限，代码内容不完整。");
    }
    const remaining = MAX_CHARACTERS - characterCount;
    if (text.length > remaining) {
      text = text.slice(0, remaining);
      truncated = true;
    }
    if (!text) return;
    blocks.push({
      id: `block-${blocks.length + 1}`,
      stableKey: stableKey(
        type,
        text,
        options.language,
        options.callout,
        options.variant,
        options.image,
        options.table,
        options.diagram,
      ),
      type,
      text,
      ...(options.level === undefined ? {} : { level: options.level }),
      ...(options.language === undefined ? {} : { language: options.language }),
      ...(options.inline === undefined ? {} : { inline: options.inline }),
      ...(options.callout === undefined ? {} : { callout: options.callout }),
      ...(options.variant === undefined ? {} : { variant: options.variant }),
      ...(options.table === undefined ? {} : { table: options.table }),
      ...(options.image === undefined ? {} : { image: options.image }),
      ...(options.diagram === undefined ? {} : { diagram: options.diagram }),
    });
    characterCount += text.length;
    if (type === "code") codeBlockCount += 1;
  }

  const calloutFor = (element: HTMLElement): CalloutMetadata | undefined => {
    const calloutRoot = element.closest<HTMLElement>(
      "[data-callout], [class*='admonition'], [class*='callout'], [role='note'], details",
    );
    if (!calloutRoot) return undefined;
    let id = calloutIds.get(calloutRoot);
    if (!id) {
      id = `callout-${++calloutSequence}`;
      calloutIds.set(calloutRoot, id);
    }
    const rawKind = (
      calloutRoot.getAttribute("data-callout") || calloutRoot.className.toString()
    ).toLowerCase();
    const kind: CalloutKind = calloutRoot.matches("details")
      ? "details"
      : rawKind.includes("danger") || rawKind.includes("error")
        ? "danger"
        : rawKind.includes("warning") || rawKind.includes("caution")
          ? "warning"
          : rawKind.includes("tip")
            ? "tip"
            : rawKind.includes("detail")
              ? "details"
              : "note";
    const titleElement = calloutRoot.querySelector<HTMLElement>(
      ".admonition-title, [class*='admonition-title'], [class*='callout-title'], summary",
    );
    const calloutTitle = normalizeText(titleElement?.textContent ?? "");
    return { id, kind, ...(calloutTitle ? { title: calloutTitle } : {}) };
  };

  const semanticNodes = Array.from(
    root.querySelectorAll<HTMLElement>(
      "h1, h2, h3, h4, h5, h6, p, pre, li, table, img, div[data-learnflow-diagram], [role=heading], [role=paragraph]",
    ),
  );
  for (const element of semanticNodes) {
    if (
      !element.matches("div[data-learnflow-diagram]") &&
      element.closest("div[data-learnflow-diagram]")
    ) {
      continue;
    }
    if (
      element.matches("p, [role=paragraph], h1, h2, h3, h4, h5, h6, [role=heading]") &&
      element.closest("li")
    ) {
      continue;
    }
    if (element.matches(".admonition-title, [class*='admonition-title'], [class*='callout-title'], summary")) {
      continue;
    }
    const callout = calloutFor(element);
    if (element.matches("div[data-learnflow-diagram]")) {
      const svg = element.querySelector("svg") as SVGElement | null;
      const serialized = svg ? sanitizeRenderedSvg(svg) : undefined;
      if (serialized) {
        addBlock("diagram", "Mermaid diagram", {
          callout,
          diagram: { format: "svg", svg: serialized, alt: "Mermaid diagram" },
        });
      }
      continue;
    }
    if (element.matches("img")) {
      const image = resolveImage(element as HTMLImageElement, pageUrl);
      if (image) addBlock("image", image.alt || image.src, { callout, image });
      continue;
    }
    if (element.matches("pre")) {
      const codeText = trimCode(element.textContent ?? "");
      addBlock("code", codeText, {
        language: getLanguage(element) ?? inferLanguage(codeText),
        variant: getVariantLabel(element),
        callout,
      });
    } else if (element.matches("table")) {
      const table = getTableData(element as HTMLTableElement);
      if (table) addBlock("table", [...table.headers, ...table.rows.flat()].join(" | "), { table, callout });
    } else if (element.matches("li")) {
      addBlock("list", normalizeText(element.textContent ?? ""), {
        inline: getInlineSegments(element, pageUrl),
        callout,
      });
    } else if (element.matches("h1, h2, h3, h4, h5, h6, [role=heading]")) {
      const headingMatch = element.tagName.match(/^H([1-6])$/i);
      addBlock("heading", normalizeText(element.textContent ?? ""), {
        level: headingMatch ? Number(headingMatch[1]) : 2,
        inline: getInlineSegments(element, pageUrl),
      });
    } else {
      addBlock("paragraph", normalizeText(element.textContent ?? ""), {
        inline: getInlineSegments(element, pageUrl),
        callout,
      });
    }
    if (truncated) break;
  }

  if (blocks.length === 0) return undefined;
  const normalizedContentTitle =
    normalizeText(contentTitle ?? "") ||
    normalizeText(root.querySelector("h1")?.textContent ?? "");
  const normalizedPageTitle =
    normalizeText(title) || normalizeText(document.title) || normalizedContentTitle;
  const calloutRoots = new Set(
    Array.from(root.querySelectorAll<HTMLElement>(
      "[data-callout], [class*='admonition'], [class*='callout'], details",
    )),
  );
  const imageCount = root.querySelectorAll("img").length;
  return {
    schemaVersion: 1,
    url: pageUrl,
    title: normalizedPageTitle || "Untitled page",
    ...(normalizedContentTitle ? { contentTitle: normalizedContentTitle } : {}),
    capturedAt: new Date().toISOString(),
    blocks,
    extraction: {
      strategy: "article",
      truncated,
      warnings: [...new Set(warnings)],
      structure: {
        parserVersion,
        rootKind: "article",
        headingCount: root.querySelectorAll("h1, h2, h3, h4, h5, h6, [role=heading]").length,
        paragraphCount: root.querySelectorAll("p, [role=paragraph]").length,
        codeBlockCount: root.querySelectorAll("pre").length,
        listItemCount: root.querySelectorAll("li").length,
        tableCount: root.querySelectorAll("table").length,
        imageCount,
        calloutCount: calloutRoots.size,
        linkCount: root.querySelectorAll("a[href]").length,
      },
    },
    stats: { characterCount, codeBlockCount, blockCount: blocks.length },
  };
}
