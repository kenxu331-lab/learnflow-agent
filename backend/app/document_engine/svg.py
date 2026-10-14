"""Small, dependency-free sanitizer for rendered Mermaid SVG assets."""

from __future__ import annotations

import re
import xml.etree.ElementTree as ET

from app.notes.errors import NoteServiceError

_SVG_NAMESPACE = "http://www.w3.org/2000/svg"
_XHTML_NAMESPACE = "http://www.w3.org/1999/xhtml"

# Keep the standalone asset readable by browsers and Obsidian. Without
# explicit registrations ElementTree rewrites the default SVG namespace as
# ``ns0:``, which is valid XML but unnecessarily breaks SVG consumers.
ET.register_namespace("", _SVG_NAMESPACE)
ET.register_namespace("html", _XHTML_NAMESPACE)

_ALLOWED_TAGS = {
    "svg",
    "g",
    "path",
    "rect",
    "circle",
    "ellipse",
    "line",
    "polyline",
    "polygon",
    "text",
    "tspan",
    "defs",
    "marker",
    "title",
    "desc",
    "use",
    "foreignObject",
    "div",
    "span",
    "p",
}
_ALLOWED_ATTRIBUTES = {
    "xmlns",
    "xmlns:xlink",
    "viewBox",
    "width",
    "height",
    "x",
    "y",
    "cx",
    "cy",
    "x1",
    "x2",
    "y1",
    "y2",
    "dx",
    "dy",
    "d",
    "points",
    "rx",
    "ry",
    "r",
    "fill",
    "fill-opacity",
    "stroke",
    "stroke-width",
    "stroke-opacity",
    "stroke-dasharray",
    "stroke-linecap",
    "stroke-linejoin",
    "opacity",
    "transform",
    "class",
    "id",
    "style",
    "marker-start",
    "marker-mid",
    "marker-end",
    "text-anchor",
    "dominant-baseline",
    "preserveAspectRatio",
    "font-size",
    "font-family",
    "font-weight",
}


def _local_name(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def _clean(element: ET.Element) -> None:
    for child in list(element):
        if _local_name(child.tag) not in _ALLOWED_TAGS:
            element.remove(child)
            continue
        _clean(child)

    for attribute, value in list(element.attrib.items()):
        local = _local_name(attribute)
        if local not in _ALLOWED_ATTRIBUTES:
            del element.attrib[attribute]
            continue
        if local in {"href", "xlink:href"} and not value.startswith("#"):
            del element.attrib[attribute]
            continue
        if local == "style" and re.search(r"url\s*\(\s*(?!#)", value, re.I):
            del element.attrib[attribute]


def sanitize_svg(svg: str) -> str:
    """Validate and strip executable/external content before Vault persistence."""

    try:
        root = ET.fromstring(svg)
    except ET.ParseError as exc:
        raise NoteServiceError(
            "invalid_diagram", "SVG 图形内容无法解析。", 422
        ) from exc
    if _local_name(root.tag) != "svg":
        raise NoteServiceError("invalid_diagram", "生成资源不是 SVG 图形。", 422)
    _clean(root)
    sanitized = ET.tostring(root, encoding="unicode", short_empty_elements=True)
    if len(sanitized) > 200_000:
        raise NoteServiceError("invalid_diagram", "SVG 图形内容超过大小限制。", 422)
    return sanitized
