const HOST_SELECTOR = ".mermaid, [data-mermaid]";
const MARKER_SELECTOR = "template[data-learnflow-shadow-svg]";
const SOURCE_SELECTOR = "template[data-learnflow-mermaid-source]";
const INSTALL_MARKER = "__LEARNFLOW_SHADOW_MERMAID_HOOK__";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const XHTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const SVG_STYLE_PROPERTIES = [
  "fill", "fill-opacity", "stroke", "stroke-width", "stroke-opacity",
  "stroke-dasharray", "stroke-linecap", "stroke-linejoin", "opacity",
  "font-family", "font-size", "font-weight", "font-style", "text-anchor",
  "dominant-baseline", "paint-order", "color", "display", "visibility",
] as const;
const XHTML_STYLE_PROPERTIES = [
  "color", "background-color", "font-family", "font-size", "font-weight",
  "font-style", "line-height", "text-align", "white-space", "display",
  "visibility", "overflow", "box-sizing", "margin", "padding",
] as const;
const INHERITED_PROPERTIES = new Set([
  "fill", "fill-opacity", "stroke", "stroke-width", "stroke-opacity",
  "stroke-dasharray", "stroke-linecap", "stroke-linejoin", "font-family",
  "font-size", "font-weight", "font-style", "text-anchor",
  "dominant-baseline", "color", "line-height", "text-align", "white-space",
  "visibility",
]);

function inlineRenderedSvgStyles(source: SVGElement, target: SVGElement): void {
  const sourceElements = [source, ...Array.from(source.querySelectorAll("*"))];
  const targetElements = [target, ...Array.from(target.querySelectorAll("*"))];
  const count = Math.min(sourceElements.length, targetElements.length);
  for (let index = 0; index < count; index += 1) {
    const sourceElement = sourceElements[index];
    const targetElement = targetElements[index] as HTMLElement | SVGElement;
    const properties =
      sourceElement.namespaceURI === XHTML_NAMESPACE
        ? XHTML_STYLE_PROPERTIES
        : sourceElement.namespaceURI === SVG_NAMESPACE
          ? SVG_STYLE_PROPERTIES
          : [];
    if (properties.length === 0) continue;
    let computed: CSSStyleDeclaration;
    try {
      computed = getComputedStyle(sourceElement);
    } catch {
      continue;
    }
    for (const property of properties) {
      const value = computed.getPropertyValue(property).trim();
      const parent = sourceElement.parentElement;
      const sameInheritedValue =
        Boolean(parent && parent.namespaceURI === sourceElement.namespaceURI) &&
        INHERITED_PROPERTIES.has(property) &&
        (() => {
          try {
            return (
              value === getComputedStyle(parent as Element).getPropertyValue(property).trim()
            );
          } catch {
            return false;
          }
        })();
      if (
        value &&
        !targetElement.hasAttribute(property) &&
        !targetElement.style.getPropertyValue(property) &&
        !sameInheritedValue &&
        !/url\s*\(\s*(?!#)/i.test(value)
      ) {
        targetElement.style.setProperty(property, value);
      }
    }
  }
}

const pageGlobal = globalThis as Record<string, unknown>;
if (pageGlobal[INSTALL_MARKER]) {
  // The hook may be installed both statically and programmatically.
} else {
  pageGlobal[INSTALL_MARKER] = true;

function publishShadowSvg(
  host: Element,
  shadowRoot: ShadowRoot,
): void {
  const svg = shadowRoot.querySelector("svg");
  if (!svg) return;
  let marker = host.querySelector<HTMLTemplateElement>(MARKER_SELECTOR);
  if (!marker) {
    marker = document.createElement("template");
    marker.setAttribute("data-learnflow-shadow-svg", "true");
    host.append(marker);
  }
  const clone = svg.cloneNode(true) as SVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  inlineRenderedSvgStyles(svg, clone);
  marker.innerHTML = clone.outerHTML;
}

function isMermaidSource(value: string): boolean {
  const text = value.trimStart();
  return (
    /^(?:graph|flowchart)\s+(?:TB|TD|BT|RL|LR)\b/i.test(text) &&
    /(?:-->|---|==>|-\.->)/.test(text)
  );
}

function mermaidSource(host: Element): string | undefined {
  const candidates: string[] = [];
  for (const name of [
    "data-code",
    "data-source",
    "data-mermaid",
    "data-learnflow-mermaid-source",
  ]) {
    const value = host.getAttribute(name);
    if (value) candidates.push(value);
  }
  candidates.push(host.textContent ?? "");
  host.querySelectorAll<HTMLTemplateElement>("template").forEach((template) => {
    candidates.push(template.content.textContent ?? "");
  });
  return candidates
    .map((value) => value.replace(/\r\n?/g, "\n").trim())
    .find(isMermaidSource);
}

function publishMermaidSource(host: Element, index: number): void {
  const source = mermaidSource(host);
  if (!source || !document.documentElement) return;
  let marker = document.documentElement.querySelector<HTMLTemplateElement>(
    `${SOURCE_SELECTOR}[data-index="${index}"]`,
  );
  if (!marker) {
    marker = document.createElement("template");
    marker.setAttribute("data-learnflow-mermaid-source", "true");
    marker.setAttribute("data-index", String(index));
    document.documentElement.append(marker);
  }
  if (marker.content.textContent !== source) marker.innerHTML = source;
}

function publishExistingMermaidSources(): void {
  document.querySelectorAll<HTMLElement>(HOST_SELECTOR).forEach((host, index) => {
    publishMermaidSource(host, index);
  });
}

const originalAttachShadow = Element.prototype.attachShadow;

function observeExistingShadowHost(host: Element): void {
  const shadowRoot = host.shadowRoot;
  if (!shadowRoot) return;
  const publish = (): void => publishShadowSvg(host, shadowRoot);
  publish();
  new MutationObserver(publish).observe(shadowRoot, {
    subtree: true,
    childList: true,
    attributes: true,
    characterData: true,
  });
}

Element.prototype.attachShadow = function attachShadowPatched(
  init: ShadowRootInit,
): ShadowRoot {
  const shadowRoot = originalAttachShadow.call(this, init);
  if (this.matches(HOST_SELECTOR)) {
    const publish = (): void => publishShadowSvg(this, shadowRoot);
    publish();
    new MutationObserver(publish).observe(shadowRoot, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    });
  }
  return shadowRoot;
};

// The study mode permission can be granted after the page has already loaded.
// In that case attachShadow has already fired, so inspect existing open roots
// as well as observing roots created later.
document.querySelectorAll<HTMLElement>(HOST_SELECTOR).forEach(
  observeExistingShadowHost,
);
publishExistingMermaidSources();
new MutationObserver(publishExistingMermaidSources).observe(document.documentElement, {
  subtree: true,
  childList: true,
  characterData: true,
});
}
