import createDOMPurify from "dompurify";
/** The sole user HTML/SVG pipeline, shared by Markdown, media and Studio. No input is inserted first. */
export function sanitizeContent(
  host: HTMLElement,
  source: string,
  kind: "html" | "svg",
  prefix: string,
): DocumentFragment {
  const purifier = createDOMPurify(host.ownerDocument.defaultView!);
  const htmlTags = [
    "p",
    "br",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "strong",
    "em",
    "b",
    "i",
    "s",
    "u",
    "code",
    "pre",
    "blockquote",
    "ul",
    "ol",
    "li",
    "a",
    "table",
    "thead",
    "tbody",
    "tfoot",
    "tr",
    "th",
    "td",
    "caption",
    "hr",
    "span",
    "div",
    "sup",
    "sub",
    "dl",
    "dt",
    "dd",
  ];
  const svgTags = [
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
    "title",
    "desc",
    "defs",
    "clippath",
    "lineargradient",
    "radialgradient",
    "stop",
    "use",
    "symbol",
    "mask",
  ];
  const fragment = purifier.sanitize(source, {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: kind === "html" ? htmlTags : svgTags,
    ALLOWED_ATTR:
      kind === "html"
        ? ["href", "title", "colspan", "rowspan", "scope", "lang", "dir"]
        : [
            "id",
            "href",
            "viewBox",
            "width",
            "height",
            "x",
            "y",
            "x1",
            "y1",
            "x2",
            "y2",
            "cx",
            "cy",
            "r",
            "rx",
            "ry",
            "d",
            "points",
            "fill",
            "fill-rule",
            "stroke",
            "stroke-width",
            "stroke-linecap",
            "stroke-linejoin",
            "opacity",
            "transform",
            "clip-path",
            "mask",
            "offset",
            "stop-color",
            "stop-opacity",
            "gradientUnits",
            "gradientTransform",
            "font-size",
            "text-anchor",
          ],
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    SANITIZE_DOM: true,
  });
  const nodes = [...fragment.querySelectorAll("*")];
  const ids = new Map<string, string>();
  for (const [i, node] of nodes.entries()) {
    const id = node.getAttribute("id");
    if (id) {
      const next = `xc-${prefix}-${i}`;
      if (!ids.has(id)) ids.set(id, next);
      node.setAttribute("id", next);
    }
  }
  for (const node of nodes) {
    if (kind === "html") {
      const href = node.getAttribute("href");
      if (href) {
        try {
          const url = new URL(href);
          if (
            !["https:", "http:"].includes(url.protocol) ||
            url.username ||
            url.password
          )
            throw new Error();
          node.setAttribute("href", url.href);
          node.setAttribute("rel", "noopener noreferrer");
          node.setAttribute("target", "_blank");
        } catch {
          node.removeAttribute("href");
        }
      }
    } else {
      for (const attr of [...node.attributes]) {
        if (attr.name === "href") {
          const next = attr.value.startsWith("#")
            ? ids.get(attr.value.slice(1))
            : undefined;
          if (next) node.setAttribute("href", `#${next}`);
          else node.removeAttribute(attr.name);
        }
        if (["fill", "stroke", "clip-path", "mask"].includes(attr.name)) {
          const value = attr.value.trim();
          if (value.startsWith("url(")) {
            const match = /^url\(#([A-Za-z0-9_-]+)\)$/.exec(value),
              next = match ? ids.get(match[1]!) : undefined;
            if (next) node.setAttribute(attr.name, `url(#${next})`);
            else node.removeAttribute(attr.name);
          } else if (
            !/^(?:none|currentColor|transparent|[a-zA-Z]+|#[a-fA-F0-9]{3,8})$/.test(
              value,
            )
          )
            node.removeAttribute(attr.name);
        }
      }
    }
  }
  return fragment;
}
