import type { Block } from "@xcursus/core";
import type { Diagnostics, ImportDiagnostic } from "../diagnostics/index.js";
import { hasClass, textContent } from "../parse/index.js";
import type { HtmlElement, HtmlNode } from "../parse/index.js";
import type { ResourceKind, ResourceResolver } from "./resources.js";

/** Elements the XCursus HTML sanitizer keeps (`@xcursus/plugins` security policy). */
const KEPT = new Set([
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
]);
const KEPT_ATTRIBUTES = new Set([
  "title",
  "colspan",
  "rowspan",
  "scope",
  "lang",
  "dir",
]);
const VOID = new Set(["br", "hr"]);
/** Removed with their content, by finding. */
const REMOVED: Record<string, Parameters<Diagnostics["add"]>[0]> = {
  script: "SCRIPT_REMOVED",
  style: "CSS_NOT_CONVERTED",
  link: "STYLESHEET_IGNORED",
  iframe: "FRAME_REMOVED",
  frame: "FRAME_REMOVED",
  frameset: "FRAME_REMOVED",
  object: "FRAME_REMOVED",
  embed: "FRAME_REMOVED",
  applet: "FRAME_REMOVED",
  portal: "FRAME_REMOVED",
  form: "FORM_REMOVED",
  input: "FORM_REMOVED",
  button: "FORM_REMOVED",
  select: "FORM_REMOVED",
  textarea: "FORM_REMOVED",
  datalist: "FORM_REMOVED",
  output: "FORM_REMOVED",
  canvas: "CANVAS_REMOVED",
  noscript: "INERT_REMOVED",
  template: "INERT_REMOVED",
  dialog: "INERT_REMOVED",
  meta: "INERT_REMOVED",
  base: "INERT_REMOVED",
  title: "INERT_REMOVED",
  map: "INERT_REMOVED",
  slot: "INERT_REMOVED",
};
/** SVG elements and attributes the XCursus SVG sanitizer keeps, compared case-insensitively. */
const SVG_TAGS = new Set(
  [
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
  ].map((t) => t.toLowerCase()),
);
const SVG_ATTRIBUTES = new Set(
  [
    "id",
    "href",
    "viewbox",
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
    "gradientunits",
    "gradienttransform",
    "font-size",
    "text-anchor",
  ].map((a) => a.toLowerCase()),
);
export const SOURCE_LIMIT = 100_000;
export const LABEL_LIMIT = 2000;
export const BLOCK_LIMIT = 100;

const escapeText = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\u00a0/g, "&nbsp;");
const escapeAttribute = (text: string) =>
  text
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/\u00a0/g, "&nbsp;");
const words = (text: string) => text.replace(/\s+/g, " ").trim();
const ABSOLUTE = /^[a-z][a-z0-9+.-]*:/i;

export interface StepContentContext {
  quirks: boolean;
  /** Elements of other steps nested inside this one: imported as their own scenes. */
  nested: ReadonlySet<HtmlElement>;
  resources: ResourceResolver;
  diagnostics: Diagnostics;
  /** JSON Pointer of the scene in the candidate. */
  pointer: string;
  step: string;
  newBlockId: () => string;
}
export interface StepContent {
  blocks: Block[];
  notes: string;
  title: string;
  /** CSS text found in the step (inline styles and `<style>`), kept for the report only. */
  css: string[];
}

/**
 * Converts the content of one step into XCursus blocks in reading order.
 * Markup the sanitizer keeps is stored as `html` blocks with only its
 * allowlisted attributes; images, inline SVG, audio and video become their
 * own blocks, splitting the markup around them; active content (scripts,
 * handlers, frames, forms, `javascript:` URLs) is never copied and every
 * removal is diagnosed. The result is still sanitized again when rendered.
 */
export function convertStep(
  step: HtmlElement,
  context: StepContentContext,
): StepContent {
  const { diagnostics: d, pointer, step: stepName } = context;
  const blocks: Block[] = [];
  const notes: string[] = [];
  const css: string[] = [];
  let title = "";
  let firstText = "";
  const open: string[] = [];
  let parts: string[] = [];
  let hasContent = false;
  const dropped = new Set<string>();
  const unwrapped = new Set<string>();
  const where = (node: HtmlElement): ImportDiagnostic["source"] => ({
    step: stepName,
    ...(node.location ?? {}),
  });
  const blockPointer = () => `${pointer}/blocks/${blocks.length}`;
  const push = (block: Block) => {
    if (blocks.length >= BLOCK_LIMIT) {
      d.once(
        `${pointer}:limit`,
        "BLOCK_LIMIT",
        `Only the first ${BLOCK_LIMIT} blocks of the step are imported`,
        pointer,
        { step: stepName },
      );
      return;
    }
    blocks.push(block);
  };
  const flush = () => {
    if (hasContent) {
      // Whitespace at the edges of a block is not rendered; keep the JSON tidy.
      let source = (
        parts.join("") + [...open].reverse().map(closing).join("")
      ).trim();
      if (source.length > SOURCE_LIMIT) {
        d.add(
          "CONTENT_TRUNCATED",
          `Markup longer than ${SOURCE_LIMIT} characters is cut`,
          blockPointer(),
          { step: stepName },
        );
        source = source.slice(0, SOURCE_LIMIT);
      }
      push({ id: context.newBlockId(), type: "html", data: { source } });
    }
    parts = open.map((tag) => tag);
    hasContent = false;
  };
  const closing = (openTag: string) =>
    `</${/^<([a-z0-9]+)/.exec(openTag)![1]}>`;

  const resource = (
    node: HtmlElement,
    url: string | undefined,
    kind: ResourceKind,
  ) => {
    if (url === undefined || url.trim() === "") return undefined;
    const found = context.resources.resolve(url, kind);
    if (found.status === "asset") return found.assetId;
    const code = (
      {
        remote: "RESOURCE_REMOTE",
        data: "RESOURCE_DATA_URL",
        outside: "RESOURCE_OUTSIDE_ROOT",
        missing: "RESOURCE_MISSING",
        invalid: "RESOURCE_INVALID",
        unsupported: "RESOURCE_UNSUPPORTED",
      } as const
    )[found.status];
    d.add(code, found.message, blockPointer(), where(node));
    return undefined;
  };

  const label = (node: HtmlElement) =>
    words(node.attrs.get("aria-label") ?? node.attrs.get("title") ?? "").slice(
      0,
      LABEL_LIMIT,
    );

  const media = (node: HtmlElement) => {
    flush();
    if (node.tag === "img") {
      const assetId = resource(node, node.attrs.get("src"), "image");
      if (!assetId) return;
      const alt = node.attrs.get("alt");
      if (alt === undefined)
        d.add(
          "IMAGE_ALT_MISSING",
          "The image has no alt attribute: alternative text left empty",
          `${blockPointer()}/data/alt`,
          where(node),
          "Describe the image in Studio, or leave it empty if it is decorative",
        );
      push({
        id: context.newBlockId(),
        type: "image",
        data: {
          assetId,
          alt: words(alt ?? "").slice(0, LABEL_LIMIT),
          fit: "contain",
        },
      });
      return;
    }
    // audio or video
    const sources = [
      node.attrs.get("src"),
      ...node.children
        .filter(
          (c): c is HtmlElement => c.kind === "element" && c.tag === "source",
        )
        .map((s) => s.attrs.get("src")),
    ].filter((s): s is string => !!s && s.trim() !== "");
    let assetId: string | undefined;
    for (const src of sources) {
      assetId = resource(node, src, node.tag === "video" ? "video" : "audio");
      if (assetId) break;
    }
    if (!sources.length)
      d.add(
        "RESOURCE_MISSING",
        `The ${node.tag} element has no source`,
        blockPointer(),
        where(node),
      );
    if (!assetId) return;
    const text = label(node);
    if (!text)
      d.add(
        "MEDIA_LABEL_MISSING",
        `The ${node.tag} has no aria-label or title: label left empty`,
        `${blockPointer()}/data/label`,
        where(node),
      );
    const common = {
      assetId,
      label: text,
      autoplay: node.attrs.has("autoplay"),
      loop: node.attrs.has("loop"),
      onExit: "pause" as const,
    };
    if (node.tag === "audio") {
      push({ id: context.newBlockId(), type: "audio", data: common });
      return;
    }
    const poster = resource(node, node.attrs.get("poster"), "image");
    const track = node.children.find(
      (c): c is HtmlElement =>
        c.kind === "element" &&
        c.tag === "track" &&
        ["captions", "subtitles"].includes(
          (c.attrs.get("kind") ?? "subtitles").toLowerCase(),
        ),
    );
    const captions = track
      ? resource(track, track.attrs.get("src"), "captions")
      : undefined;
    push({
      id: context.newBlockId(),
      type: "video",
      data: {
        ...common,
        alt: text,
        ...(poster ? { posterAssetId: poster } : {}),
        ...(captions ? { captionsAssetId: captions } : {}),
      },
    });
  };

  const svg = (node: HtmlElement) => {
    flush();
    let removed = false;
    const serialize = (n: HtmlNode): string => {
      if (n.kind === "text") return escapeText(n.text);
      if (n.namespace !== "svg" || !SVG_TAGS.has(n.tag)) {
        removed = true;
        return "";
      }
      let attributes = "";
      for (const [name, value] of n.attrs) {
        const lower = name.toLowerCase().replace(/^xlink:/, "");
        const external = lower === "href" && !value.trim().startsWith("#");
        if (
          !SVG_ATTRIBUTES.has(lower) ||
          external ||
          /url\(\s*['"]?(?!#)/i.test(value)
        ) {
          removed = true;
          continue;
        }
        attributes += ` ${lower === "href" ? "href" : name}="${escapeAttribute(value)}"`;
      }
      return `<${n.tag}${attributes}>${n.children.map(serialize).join("")}</${n.tag}>`;
    };
    // parse5 keeps SVG names in their adjusted case (viewBox, linearGradient).
    const source = serialize(node);
    if (removed)
      d.add(
        "SVG_CONTENT_REMOVED",
        "Scripts, styles, animations, foreign content or external references were removed from the SVG",
        blockPointer(),
        where(node),
      );
    const titleElement = node.children.find(
      (c): c is HtmlElement => c.kind === "element" && c.tag === "title",
    );
    const alt = words(
      node.attrs.get("aria-label") ??
        (titleElement ? textContent(titleElement) : ""),
    ).slice(0, LABEL_LIMIT);
    if (!alt)
      d.add(
        "IMAGE_ALT_MISSING",
        "The SVG has no title or aria-label: alternative text left empty",
        `${blockPointer()}/data/alt`,
        where(node),
      );
    if (source.length > SOURCE_LIMIT) {
      d.add(
        "CONTENT_TRUNCATED",
        `An SVG longer than ${SOURCE_LIMIT} characters is not imported`,
        blockPointer(),
        where(node),
      );
      return;
    }
    push({ id: context.newBlockId(), type: "svg", data: { source, alt } });
  };

  const attributesOf = (node: HtmlElement) => {
    let out = "";
    for (const [name, value] of node.attrs) {
      if (/^on/i.test(name)) {
        d.add(
          "EVENT_HANDLER_REMOVED",
          `Event handler ${name} removed`,
          blockPointer(),
          where(node),
        );
        continue;
      }
      if (name === "style") {
        css.push(value);
        d.once(
          `${pointer}:style`,
          "INLINE_STYLE_NOT_CONVERTED",
          "Inline styles of the step content are not converted",
          pointer,
          where(node),
        );
        continue;
      }
      if (name === "href" && node.tag === "a") {
        const href = value.trim();
        if (/^\s*(?:javascript|vbscript|data):/i.test(href))
          d.add(
            "ACTIVE_URL_REMOVED",
            `Active link removed: ${href.slice(0, 40)}`,
            blockPointer(),
            where(node),
          );
        else if (/^https?:\/\//i.test(href)) {
          out += ` href="${escapeAttribute(href)}"`;
          continue;
        } else
          d.add(
            "LINK_DROPPED",
            ABSOLUTE.test(href)
              ? `Link kept as text: unsupported scheme in ${href.slice(0, 40)}`
              : `Link kept as text: ${href.slice(0, 80)} is internal or relative`,
            blockPointer(),
            where(node),
            "Use a link block to jump to another scene",
          );
        continue;
      }
      if (KEPT_ATTRIBUTES.has(name)) {
        out += ` ${name}="${escapeAttribute(value)}"`;
        continue;
      }
      dropped.add(name);
    }
    return out;
  };

  const walk = (node: HtmlNode) => {
    if (node.kind === "text") {
      parts.push(escapeText(node.text));
      if (/\S/.test(node.text)) {
        hasContent = true;
        if (!firstText) firstText = words(node.text);
      }
      return;
    }
    if (context.nested.has(node)) return;
    if (node.namespace === "svg") return svg(node);
    if (node.namespace === "math") {
      d.add(
        "MATHML_NOT_CONVERTED",
        "MathML is not converted; use a LaTeX block",
        blockPointer(),
        where(node),
      );
      return;
    }
    if (node.namespace !== "html") return;
    if (hasClass(node, "notes", context.quirks)) {
      const text = textContent(node)
        .split("\n")
        .map((line) => line.trim())
        .join("\n")
        .trim();
      if (text) notes.push(text);
      d.once(
        `${pointer}:notes`,
        "NOTES_IMPORTED",
        "Speaker notes (.notes) became private scene notes",
        `${pointer}/notes`,
        where(node),
      );
      return;
    }
    if (hasClass(node, "substep", context.quirks))
      d.once(
        `${pointer}:substep`,
        "SUBSTEP_FLATTENED",
        "Substeps are shown all at once: progressive reveal is not supported",
        pointer,
        where(node),
      );
    if (node.attrs.has("hidden")) {
      d.add(
        "INERT_REMOVED",
        "Hidden element removed",
        blockPointer(),
        where(node),
      );
      return;
    }
    const removal = REMOVED[node.tag];
    if (removal) {
      if (node.tag === "style") css.push(textContent(node));
      d.add(
        removal,
        `<${node.tag}> removed from the step content`,
        blockPointer(),
        where(node),
      );
      return;
    }
    if (node.tag === "img" || node.tag === "video" || node.tag === "audio")
      return media(node);
    if (node.tag === "picture") {
      const img = node.children.find(
        (c): c is HtmlElement => c.kind === "element" && c.tag === "img",
      );
      if (img) media(img);
      return;
    }
    if (/^h[1-6]$/.test(node.tag) && !title) title = words(textContent(node));
    if (!KEPT.has(node.tag)) {
      if (!["source", "track", "area", "param"].includes(node.tag))
        unwrapped.add(node.tag);
      for (const name of node.attrs.keys())
        if (/^on/i.test(name))
          d.add(
            "EVENT_HANDLER_REMOVED",
            `Event handler ${name} removed`,
            blockPointer(),
            where(node),
          );
      if (node.attrs.has("style")) css.push(node.attrs.get("style")!);
      node.children.forEach(walk);
      return;
    }
    const tag = `<${node.tag}${attributesOf(node)}>`;
    if (VOID.has(node.tag)) {
      parts.push(tag);
      if (node.tag === "hr") hasContent = true;
      return;
    }
    parts.push(tag);
    open.push(tag);
    // The parser drops a newline right after <pre>; keep the text as authored.
    const first = node.children[0];
    if (
      node.tag === "pre" &&
      first?.kind === "text" &&
      first.text.startsWith("\n")
    )
      parts.push("\n");
    node.children.forEach(walk);
    open.pop();
    parts.push(`</${node.tag}>`);
  };
  step.children.forEach(walk);
  flush();
  if (unwrapped.size)
    d.add(
      "ELEMENT_UNWRAPPED",
      `Elements kept as their content: ${[...unwrapped].sort().join(", ")}`,
      pointer,
      { step: stepName },
    );
  if (dropped.size)
    d.add(
      "ATTRIBUTES_DROPPED",
      `Attributes not carried over: ${[...dropped].sort().join(", ")}`,
      pointer,
      { step: stepName },
    );
  return {
    blocks,
    notes: notes.join("\n\n").slice(0, 100_000),
    title: (title || firstText).slice(0, 500),
    css,
  };
}
