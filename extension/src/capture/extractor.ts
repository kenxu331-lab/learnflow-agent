import type { PageSnapshot } from "./types";

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
  ].join(",");

  function normalizeText(value: string): string {
    return value.replace(/\s+/g, " ").trim();
  }

  function removeExcluded(root: Element): void {
    root.querySelectorAll(excludedSelector).forEach((element) => {
      element.remove();
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
    return languageMatch?.[1];
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

  const selected = chooseRoot();
  const extractionRoot = cloneForExtraction(selected.root);
  const blocks: PageSnapshot["blocks"] = [];
  const warnings: string[] = [];
  const stableOccurrenceCounts = new Map<string, number>();
  let characterCount = 0;
  let codeBlockCount = 0;
  let truncated = false;

  function addWarning(warning: string): void {
    if (!warnings.includes(warning)) {
      warnings.push(warning);
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

  function stableKeyFor(
    type: "heading" | "paragraph" | "code" | "list",
    text: string,
    language: string | undefined,
  ): string {
    const signature = `${type}\u0000${language ?? ""}\u0000${text}`;
    const occurrence = stableOccurrenceCounts.get(signature) ?? 0;
    stableOccurrenceCounts.set(signature, occurrence + 1);
    const firstHash = hashString(signature, 2166136261);
    const secondHash = hashString(signature, 16777619);
    return `v1-${firstHash}${secondHash}-${occurrence}`;
  }

  function addBlock(
    type: "heading" | "paragraph" | "code" | "list",
    rawText: string,
    level?: number,
    language?: string,
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
      stableKey: stableKeyFor(type, text, language),
      type,
      text,
      ...(level === undefined ? {} : { level }),
      ...(language === undefined ? {} : { language }),
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
      "h1, h2, h3, h4, h5, h6, p, pre, li, [role=heading], [role=paragraph]",
    ),
  );

  for (const element of semanticNodes) {
    if (
      element.matches("p, [role=paragraph], h1, h2, h3, h4, h5, h6, [role=heading]") &&
      element.closest("li")
    ) {
      continue;
    }

    let type: "heading" | "paragraph" | "code" | "list";
    let text: string;
    let level: number | undefined;
    let language: string | undefined;

    if (element.matches("pre")) {
      type = "code";
      text = trimCode(element.textContent ?? "");
      language = getLanguage(element);
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

    if (text && !addBlock(type, text, level, language)) {
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

  const title =
    normalizeText(document.title) ||
    normalizeText(document.querySelector("h1")?.textContent ?? "") ||
    "Untitled page";

  return {
    schemaVersion: 1,
    url: window.location.href,
    title,
    capturedAt: new Date().toISOString(),
    blocks,
    extraction: {
      strategy: selected.strategy,
      truncated,
      warnings,
    },
    stats: {
      characterCount,
      codeBlockCount,
      blockCount: blocks.length,
    },
  };
}
