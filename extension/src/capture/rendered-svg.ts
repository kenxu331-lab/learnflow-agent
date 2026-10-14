const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const XHTML_NAMESPACE = "http://www.w3.org/1999/xhtml";

// Mermaid's theme is supplied by the host page (often through CSS variables
// in a shadow root). A saved SVG no longer has that stylesheet, so preserve
// the computed presentation values that affect how the diagram is rendered.
const SVG_STYLE_PROPERTIES = [
  "fill",
  "fill-opacity",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-dasharray",
  "stroke-linecap",
  "stroke-linejoin",
  "opacity",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "text-anchor",
  "dominant-baseline",
  "paint-order",
  "color",
  "display",
  "visibility",
] as const;

const XHTML_STYLE_PROPERTIES = [
  "color",
  "background-color",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "text-align",
  "white-space",
  "display",
  "visibility",
  "overflow",
  "box-sizing",
  "margin",
  "padding",
] as const;
const INHERITED_PROPERTIES = new Set([
  "fill",
  "fill-opacity",
  "stroke",
  "stroke-width",
  "stroke-opacity",
  "stroke-dasharray",
  "stroke-linecap",
  "stroke-linejoin",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "text-anchor",
  "dominant-baseline",
  "color",
  "line-height",
  "text-align",
  "white-space",
  "visibility",
]);

function canPersistComputedValue(value: string): boolean {
  const normalized = value.trim();
  return normalized.length > 0 && !/url\s*\(\s*(?!#)/i.test(normalized);
}

function shouldInlineProperty(
  source: Element,
  target: Element,
  property: string,
  computed: CSSStyleDeclaration,
): boolean {
  const styledTarget = target as HTMLElement | SVGElement;
  if (
    target.hasAttribute(property) ||
    styledTarget.style.getPropertyValue(property)
  ) {
    return false;
  }
  const parent = source.parentElement;
  if (!parent || parent.namespaceURI !== source.namespaceURI) return true;
  if (!INHERITED_PROPERTIES.has(property)) return true;
  try {
    return (
      computed.getPropertyValue(property).trim() !==
      getComputedStyle(parent).getPropertyValue(property).trim()
    );
  } catch {
    return true;
  }
}

/**
 * Copy the page's computed Mermaid styles onto a detached SVG clone.
 *
 * This is DOM-only so it can run both in the injected page extractor and in
 * the document_start shadow-root hook. It does not copy arbitrary CSS or
 * event handlers; only safe presentation properties are persisted.
 */
export function inlineRenderedSvgStyles(
  source: SVGElement,
  target: SVGElement,
): void {
  if (typeof getComputedStyle !== "function") return;

  const sourceElements = [source, ...Array.from(source.querySelectorAll("*"))];
  const targetElements = [target, ...Array.from(target.querySelectorAll("*"))];
  const count = Math.min(sourceElements.length, targetElements.length);

  for (let index = 0; index < count; index += 1) {
    const sourceElement = sourceElements[index];
    const targetElement = targetElements[index];
    const namespace = sourceElement.namespaceURI;
    const properties =
      namespace === XHTML_NAMESPACE
        ? XHTML_STYLE_PROPERTIES
        : namespace === SVG_NAMESPACE
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
      const value = computed.getPropertyValue(property);
      if (
        canPersistComputedValue(value) &&
        shouldInlineProperty(sourceElement, targetElement, property, computed)
      ) {
        const styledTarget = targetElement as HTMLElement | SVGElement;
        styledTarget.style.setProperty(property, value.trim());
      }
    }
  }
}

