import type {
  CalloutKind,
  CalloutMetadata,
  ImageData,
  InlineSegment,
  PageSnapshot,
  TableData,
} from "./types";

/**
 * Extract a page snapshot using only globals available in the injected page.
 *
 * Keep helper functions nested: Chrome serializes `func` and does not retain
 * module imports or outer lexical bindings when executeScript injects it.
 */
export function extractPageSnapshot(): PageSnapshot {
  const maxBlocks = 300;
  const maxCharacters = 60_000;
  const maxCodeCharacters = 12_000;
  const minimumCandidateCharacters = 40;
  const lowQualityCharacters = 80;
  const excludedSelector = [
    "script",
    "style",
    "noscript",
    "template",
    "svg",
    "canvas",
    "nav",
    "footer",
    "aside",
    "form",
    "[hidden]",
    '[aria-hidden="true"]',
    '[role="navigation"]',
    '[role="banner"]',
    '[role="complementary"]',
    '[role="contentinfo"]',
    '[class*="sidebar"]',
    '[id*="sidebar"]',
    '[class*="advert"]',
    '[id*="advert"]',
    '[class*="cookie"]',
    '[id*="cookie"]',
    '[class*="breadcrumb"]',
    '[class*="social"]',
    '[class*="share"]',
    '[class*="logo"]',
    '[class*="navigation"]',
    '[class~="comment"]',
    '[class~="comments"]',
    '[class~="commentlist"]',
    '[class^="comment-"]',
    '[class*=" comment-"]',
    '[id*="comment"]',
    '[class*="fixed-btn"]',
    '#footer',
    '.article-heading-ad',
  ].join(",");

  function normalizeText(value: string): string {
    return value.replace(/\s+/g, " ").trim();
  }

  function addInlineSegment(
    segments: InlineSegment[],
    segment: InlineSegment,
  ): void {
    if (!segment.text) return;
    const previous = segments[segments.length - 1];
    if (
      previous &&
      previous.type === segment.type &&
      previous.url === segment.url
    ) {
      previous.text += segment.text;
      return;
    }
    segments.push(segment);
  }

  function getInlineSegments(element: HTMLElement): InlineSegment[] | undefined {
    const segments: InlineSegment[] = [];

    function visit(node: Node, linkUrl?: string): void {
      if (node.nodeType === Node.TEXT_NODE) {
        const text = (node.textContent ?? "").replace(/\s+/g, " ");
        addInlineSegment(segments, {
          type: linkUrl ? "link" : "text",
          text,
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
        const href = node.getAttribute("href");
        let resolvedUrl: string | undefined;
        try {
          const candidate = href ? new URL(href, document.baseURI) : undefined;
          if (candidate && ["http:", "https:"].includes(candidate.protocol)) {
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

  function removeExcluded(root: Element): void {
    root.querySelectorAll(excludedSelector).forEach((element) => {
      element.remove();
    });
    root.querySelectorAll("details").forEach((details) => {
      const summary = normalizeText(
        details.querySelector("summary")?.textContent ?? "",
      );
      const content = normalizeText(details.textContent ?? "");
      if (
        /翻译|translation/i.test(summary) &&
        /AI|人类|协作|英文版本|translated/i.test(content)
      ) {
        details.remove();
      }
    });
  }

  function cloneForExtraction(root: Element): Element {
    const clone = root.cloneNode(true) as Element;
    removeExcluded(clone);
    return clone;
  }

  function scoreCandidate(candidate: Element): number {
    const clone = cloneForExtraction(candidate);
    return normalizeText(clone.textContent ?? "").length;
  }

  function chooseRoot(): {
    root: Element;
    strategy: "article" | "main" | "fallback";
  } {
    const groups: Array<{
      selectors: string[];
      strategy: "article" | "main";
    }> = [
      {
        selectors: ["#content", ".article-intro", ".article-body", ".md-content__inner"],
        strategy: "article",
      },
      { selectors: ["article"], strategy: "article" },
      { selectors: ["main", '[role="main"]'], strategy: "main" },
    ];

    for (const group of groups) {
      const candidates: Element[] = [];
      const seen = new Set<Element>();

      for (const selector of group.selectors) {
        document.querySelectorAll(selector).forEach((candidate) => {
          if (!seen.has(candidate)) {
            seen.add(candidate);
            candidates.push(candidate);
          }
        });
      }

      const validCandidates = candidates
        .map((candidate) => ({ candidate, score: scoreCandidate(candidate) }))
        .filter(({ score }) => score >= minimumCandidateCharacters)
        .sort((left, right) => right.score - left.score);

      if (validCandidates.length > 0) {
        return { root: validCandidates[0].candidate, strategy: group.strategy };
      }
    }

    return {
      root: document.body ?? document.documentElement,
      strategy: "fallback",
    };
  }

  function trimCode(value: string): string {
    const lines = value.replace(/\r\n?/g, "\n").split("\n");
    while (lines.length > 0 && lines[0].trim() === "") {
      lines.shift();
    }
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") {
      lines.pop();
    }
    return lines.join("\n");
  }

  function getLanguage(element: HTMLElement): string | undefined {
    const code = element.querySelector("code");
    const declaredLanguage =
      element.getAttribute("data-language") ??
      element.getAttribute("data-lang") ??
      element.getAttribute("data-code-language") ??
      code?.getAttribute("data-language") ??
      code?.getAttribute("data-lang");

    if (declaredLanguage) {
      return declaredLanguage.trim() || undefined;
    }

    const className = `${element.className} ${code?.className ?? ""}`;
    const languageMatch = className.match(/(?:language|lang)-([\w+-]+)/i);
    if (languageMatch?.[1]) return languageMatch[1];
    const parentClassName = element.parentElement?.className?.toString() ?? "";
    const parentMatch = parentClassName.match(/(?:language|lang)-([\w+-]+)/i);
    return parentMatch?.[1];
  }

  function inferLanguage(text: string): string | undefined {
    const trimmed = text.trimStart();
    return /^(?:graph|flowchart)\s+(?:TB|TD|BT|RL|LR)\b/i.test(trimmed) &&
      /(?:-->|---|==>|-\.->)/.test(trimmed)
      ? "mermaid"
      : undefined;
  }

  function getVariantLabel(element: HTMLElement): string | undefined {
    const tabbedSet = element.closest<HTMLElement>(".tabbed-set");
    const tabbedBlock = element.closest<HTMLElement>(".tabbed-block");
    if (!tabbedSet || !tabbedBlock) return undefined;
    const blocks = Array.from(tabbedSet.querySelectorAll<HTMLElement>(".tabbed-block"));
    const index = blocks.indexOf(tabbedBlock);
    if (index < 0) return undefined;
    const labels = Array.from(
      tabbedSet.querySelectorAll<HTMLElement>(".tabbed-labels label"),
    );
    const label = normalizeText(labels[index]?.textContent ?? "");
    return label || undefined;
  }

  function getListText(element: HTMLElement): string {
    const clone = element.cloneNode(true) as HTMLElement;
    clone.querySelectorAll("ul, ol").forEach((nestedList) => {
      nestedList.remove();
    });
    return normalizeText(clone.textContent ?? "");
  }

  function getHeadingLevel(element: HTMLElement): number | undefined {
    const headingMatch = element.tagName.match(/^H([1-6])$/i);
    if (headingMatch) {
      return Number(headingMatch[1]);
    }

    const ariaLevel = Number(element.getAttribute("aria-level"));
    return Number.isInteger(ariaLevel) && ariaLevel > 0 ? ariaLevel : undefined;
  }

  function getTableData(element: HTMLElement): TableData | undefined {
    const rows = Array.from(element.querySelectorAll<HTMLTableRowElement>("tr"));
    if (rows.length === 0) return undefined;
    const cellText = (row: HTMLTableRowElement): string[] =>
      Array.from(row.querySelectorAll<HTMLElement>("th, td")).map((cell) =>
        normalizeText(cell.textContent ?? ""),
      );
    const hasHeaderCells = rows[0].querySelector("th") !== null;
    const first = cellText(rows[0]);
    const headers = hasHeaderCells ? first : first.map((_, index) => `列 ${index + 1}`);
    const dataRows = (hasHeaderCells ? rows.slice(1) : rows).map(cellText);
    return { headers, rows: dataRows };
  }

  function getImageData(element: HTMLImageElement): ImageData | undefined {
    const rawSource =
      element.currentSrc ||
      element.getAttribute("src") ||
      element.getAttribute("data-src") ||
      element.getAttribute("data-lazy-src") ||
      element.getAttribute("data-original");
    if (!rawSource) return undefined;
    try {
      const source = new URL(rawSource, window.location.href);
      if (source.protocol !== "http:" && source.protocol !== "https:") {
        return undefined;
      }
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

  const selected = chooseRoot();
  const extractionRoot = cloneForExtraction(selected.root);
  const blocks: PageSnapshot["blocks"] = [];
  const warnings: string[] = [];
  const stableOccurrenceCounts = new Map<string, number>();
  const calloutIds = new Map<Element, string>();
  let calloutSequence = 0;
  let characterCount = 0;
  let codeBlockCount = 0;
  let truncated = false;

  function addWarning(warning: string): void {
    if (!warnings.includes(warning)) {
      warnings.push(warning);
    }
  }

  if (extractionRoot.querySelector("img, picture, video, audio")) {
    addWarning("页面图片已保留为远程引用，但当前未下载到 Obsidian Vault。");
  }
  // Tables are represented as structured blocks below.

  function hashString(value: string, seed: number): string {
    let hash = seed;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }

  function stableKeyFor(
    type: "heading" | "paragraph" | "code" | "list" | "table" | "image",
    text: string,
    language: string | undefined,
    callout: CalloutMetadata | undefined,
    variant: string | undefined,
    table: TableData | undefined,
    image: ImageData | undefined,
  ): string {
    const signature = `${type}\u0000${language ?? ""}\u0000${
      callout?.id ?? ""
    }\u0000${variant ?? ""}\u0000${image?.src ?? ""}\u0000${
      table ? "table" : ""
    }\u0000${text}`;
    const occurrence = stableOccurrenceCounts.get(signature) ?? 0;
    stableOccurrenceCounts.set(signature, occurrence + 1);
    const firstHash = hashString(signature, 2166136261);
    const secondHash = hashString(signature, 16777619);
    return `v1-${firstHash}${secondHash}-${occurrence}`;
  }

  function addBlock(
    type: "heading" | "paragraph" | "code" | "list" | "table" | "image",
    rawText: string,
    level?: number,
    language?: string,
    inline?: InlineSegment[],
    callout?: CalloutMetadata,
    variant?: string,
    table?: TableData,
    image?: ImageData,
  ): boolean {
    if (blocks.length >= maxBlocks) {
      truncated = true;
      addWarning("内容块数量已达到上限，结果已截断。");
      return false;
    }

    if (characterCount >= maxCharacters) {
      truncated = true;
      addWarning("正文字符数已达到上限，结果已截断。");
      return false;
    }

    let text = rawText;
    let blockWasTruncated = false;

    if (type === "code" && text.length > maxCodeCharacters) {
      text = text.slice(0, maxCodeCharacters);
      blockWasTruncated = true;
      addWarning("代码块超过单块上限，代码内容不完整。");
    }

    const remainingCharacters = maxCharacters - characterCount;
    if (text.length > remainingCharacters) {
      text = text.slice(0, remainingCharacters);
      blockWasTruncated = true;
      addWarning("正文字符数已达到上限，结果已截断。");
    }

    if (!text) {
      truncated = true;
      return false;
    }

    blocks.push({
      id: `block-${blocks.length + 1}`,
      stableKey: stableKeyFor(
        type,
        text,
        language,
        callout,
        variant,
        table,
        image,
      ),
      type,
      text,
      ...(level === undefined ? {} : { level }),
      ...(language === undefined ? {} : { language }),
      ...(variant === undefined ? {} : { variant }),
      ...(inline === undefined ? {} : { inline }),
      ...(callout === undefined ? {} : { callout }),
      ...(table === undefined ? {} : { table }),
      ...(image === undefined ? {} : { image }),
    });
    characterCount += text.length;

    if (type === "code") {
      codeBlockCount += 1;
    }

    if (blockWasTruncated) {
      truncated = true;
    }

    return true;
  }

  const semanticNodes = Array.from(
    extractionRoot.querySelectorAll<HTMLElement>(
      "h1, h2, h3, h4, h5, h6, p, pre, .example_code .hl-main, .mermaid, [data-mermaid], li, table, img, [role=heading], [role=paragraph]",
    ),
  );

  for (const element of semanticNodes) {
    if (
      element.matches("p, [role=paragraph], h1, h2, h3, h4, h5, h6, [role=heading]") &&
      element.closest("li")
    ) {
      continue;
    }

    let type: "heading" | "paragraph" | "code" | "list" | "table" | "image";
    let text: string;
    let level: number | undefined;
    let language: string | undefined;
    let inline: InlineSegment[] | undefined;
    let callout: CalloutMetadata | undefined;
    let variant: string | undefined;
    let table: TableData | undefined;
    let image: ImageData | undefined;

    if (
      element.matches(
        ".admonition-title, [class*='admonition-title'], [class*='callout-title'], summary",
      )
    ) {
      continue;
    }

    const calloutRoot = element.closest<HTMLElement>(
      "[class*='admonition'], [class*='callout'], [role='note'], details",
    );
    if (calloutRoot) {
      let calloutId = calloutIds.get(calloutRoot);
      if (!calloutId) {
        calloutId = `callout-${++calloutSequence}`;
        calloutIds.set(calloutRoot, calloutId);
      }
      const className = calloutRoot.className.toString().toLowerCase();
      const kind: CalloutKind = calloutRoot.matches("details")
        ? "details"
        : className.includes("danger")
        ? "danger"
        : className.includes("warning")
          ? "warning"
          : className.includes("tip")
            ? "tip"
            : className.includes("detail")
              ? "details"
              : "note";
      const title = normalizeText(
        calloutRoot.querySelector<HTMLElement>(
          ".admonition-title, [class*='admonition-title'], [class*='callout-title'], summary",
        )?.textContent ?? "",
      );
      callout = { id: calloutId, kind, ...(title ? { title } : {}) };
    }

    if (element.matches("img")) {
      type = "image";
      image = getImageData(element as HTMLImageElement);
      text = image ? image.alt || image.src : "";
    } else if (
      element.matches(
        "pre, .example_code .hl-main, .mermaid, [data-mermaid]",
      )
    ) {
      type = "code";
      text = trimCode(element.textContent ?? "");
      language = getLanguage(element) ?? inferLanguage(text);
      variant = getVariantLabel(element);
    } else if (element.matches("table")) {
      type = "table";
      table = getTableData(element);
      text = table
        ? [...table.headers, ...table.rows.flat()].join(" | ")
        : "";
    } else if (element.matches("li")) {
      type = "list";
      text = getListText(element);
    } else if (element.matches("h1, h2, h3, h4, h5, h6, [role=heading]")) {
      type = "heading";
      text = normalizeText(element.textContent ?? "");
      level = getHeadingLevel(element);
    } else {
      type = "paragraph";
      text = normalizeText(element.textContent ?? "");
    }

    if (type !== "code" && type !== "table" && type !== "image") {
      inline = getInlineSegments(element);
    }

    if (
      text &&
      !addBlock(type, text, level, language, inline, callout, variant, table, image)
    ) {
      break;
    }
  }

  if (blocks.length === 0) {
    const fallbackText = normalizeText(extractionRoot.textContent ?? "");
    if (fallbackText) {
      addBlock("paragraph", fallbackText);
    }
  }

  if (characterCount === 0) {
    addWarning("未提取到正文内容。");
  } else if (characterCount < lowQualityCharacters) {
    addWarning("正文内容较少，可能不是完整教程页面。");
  }

  const contentTitle = normalizeText(
    extractionRoot.querySelector("h1")?.textContent ?? "",
  );
  const title = normalizeText(document.title) || contentTitle || "Untitled page";

  const calloutRoots = new Set(
    Array.from(
      extractionRoot.querySelectorAll<HTMLElement>(
        "[class*='admonition'], [class*='callout'], details",
      ),
    ),
  );
  const structure = {
    parserVersion: "dom-extractor-v4",
    rootKind: selected.strategy,
    headingCount: extractionRoot.querySelectorAll(
      "h1, h2, h3, h4, h5, h6, [role=heading]",
    ).length,
    paragraphCount: extractionRoot.querySelectorAll("p, [role=paragraph]").length,
    codeBlockCount: extractionRoot.querySelectorAll("pre").length,
    listItemCount: extractionRoot.querySelectorAll("li").length,
    tableCount: extractionRoot.querySelectorAll("table").length,
    imageCount: extractionRoot.querySelectorAll("img, picture").length,
    calloutCount: calloutRoots.size,
    linkCount: extractionRoot.querySelectorAll("a[href]").length,
  } as const;

  return {
    schemaVersion: 1,
    url: window.location.href,
    title,
    ...(contentTitle ? { contentTitle } : {}),
    capturedAt: new Date().toISOString(),
    blocks,
    extraction: {
      strategy: selected.strategy,
      truncated,
      warnings,
      structure,
    },
    stats: {
      characterCount,
      codeBlockCount,
      blockCount: blocks.length,
    },
  };
}
