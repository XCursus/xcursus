import { parse } from "parse5";
import type { DefaultTreeAdapterTypes } from "parse5";
import type { SourceLocation } from "../diagnostics/index.js";

/** Upper bounds of the inert parse; larger inputs are refused, never truncated. */
export const HTML_LIMIT = 10 * 1024 * 1024;
export const NODE_LIMIT = 500_000;
export const DEPTH_LIMIT = 512;

export interface HtmlElement {
  kind: "element";
  /** Lowercase local name. */
  tag: string;
  namespace: "html" | "svg" | "math" | "other";
  /** Attributes as parsed: lowercase names in HTML, first occurrence wins. */
  attrs: ReadonlyMap<string, string>;
  children: HtmlNode[];
  parent: HtmlElement | null;
  /** Position in tree order, used for `compareDocumentPosition`-like checks. */
  order: number;
  depth: number;
  location?: SourceLocation;
}
export interface HtmlText {
  kind: "text";
  text: string;
  parent: HtmlElement;
}
export type HtmlNode = HtmlElement | HtmlText;

export interface ParsedHtml {
  /** The `<html>` element. */
  root: HtmlElement;
  /** Quirks mode makes class selectors ASCII case-insensitive. */
  quirks: boolean;
  /** First element for each ID, the one `getElementById` returns. */
  ids: ReadonlyMap<string, HtmlElement>;
  nodes: number;
}
export class ParseLimitError extends Error {
  constructor(
    readonly code: "HTML_TOO_LARGE" | "HTML_TOO_DEEP",
    message: string,
  ) {
    super(message);
  }
}

const namespaces: Record<string, HtmlElement["namespace"]> = {
  "http://www.w3.org/1999/xhtml": "html",
  "http://www.w3.org/2000/svg": "svg",
  "http://www.w3.org/1998/Math/MathML": "math",
};

/**
 * Parses an HTML document with parse5 into a small immutable tree. Nothing is
 * executed, loaded or rendered: scripts stay text, `<template>` contents are
 * not entered and comments are dropped. The walk is iterative, so a deeply
 * nested input fails with a limit error instead of exhausting the stack.
 */
export function parseHtml(source: string): ParsedHtml {
  if (source.length > HTML_LIMIT)
    throw new ParseLimitError("HTML_TOO_LARGE", "The HTML exceeds 10 MiB");
  const document = parse(source, {
    sourceCodeLocationInfo: true,
    scriptingEnabled: true,
  });
  const ids = new Map<string, HtmlElement>();
  let nodes = 0,
    order = 0,
    root: HtmlElement | undefined;
  const stack: Array<{
    from: DefaultTreeAdapterTypes.ParentNode;
    into: HtmlElement | null;
  }> = [{ from: document, into: null }];
  while (stack.length) {
    const { from, into } = stack.pop()!;
    const pending: typeof stack = [];
    for (const child of from.childNodes) {
      if (++nodes > NODE_LIMIT)
        throw new ParseLimitError(
          "HTML_TOO_LARGE",
          `The HTML has more than ${NODE_LIMIT} nodes`,
        );
      if (child.nodeName === "#text") {
        if (into)
          into.children.push({
            kind: "text",
            text: (child as DefaultTreeAdapterTypes.TextNode).value,
            parent: into,
          });
        continue;
      }
      if (!("tagName" in child)) continue;
      const element = child as DefaultTreeAdapterTypes.Element;
      const depth = into ? into.depth + 1 : 0;
      if (depth > DEPTH_LIMIT)
        throw new ParseLimitError(
          "HTML_TOO_DEEP",
          `Elements are nested deeper than ${DEPTH_LIMIT} levels`,
        );
      const attrs = new Map<string, string>();
      for (const { name, value } of element.attrs)
        if (!attrs.has(name)) attrs.set(name, value);
      const location = element.sourceCodeLocation;
      const node: HtmlElement = {
        kind: "element",
        tag: element.tagName.toLowerCase(),
        namespace: namespaces[element.namespaceURI] ?? "other",
        attrs,
        children: [],
        parent: into,
        order: order++,
        depth,
        ...(location
          ? {
              location: { line: location.startLine, column: location.startCol },
            }
          : {}),
      };
      if (into) into.children.push(node);
      else if (node.tag === "html") root = node;
      const id = attrs.get("id");
      if (id !== undefined && id !== "" && !ids.has(id)) ids.set(id, node);
      // Template contents live in a separate fragment that is never rendered.
      if (node.tag !== "template") pending.push({ from: element, into: node });
    }
    // Children are visited in order; reversing keeps tree order on the stack.
    stack.push(...pending.reverse());
  }
  if (!root) throw new ParseLimitError("HTML_TOO_LARGE", "No html element");
  // `order` above follows the traversal; recompute it in tree order.
  let index = 0;
  const walk: HtmlElement[] = [root];
  while (walk.length) {
    const element = walk.pop()!;
    element.order = index++;
    for (let i = element.children.length - 1; i >= 0; i--) {
      const child = element.children[i]!;
      if (child.kind === "element") walk.push(child);
    }
  }
  return { root, quirks: document.mode === "quirks", ids, nodes };
}

/** Descendants of `element` (not itself) in tree order. */
export function* descendants(element: HtmlElement): Generator<HtmlElement> {
  const stack = [...element.children].reverse();
  while (stack.length) {
    const node = stack.pop()!;
    if (node.kind !== "element") continue;
    yield node;
    for (let i = node.children.length - 1; i >= 0; i--)
      stack.push(node.children[i]!);
  }
}

/** Class tokens split on ASCII whitespace, as `classList` does. */
export function classes(element: HtmlElement): string[] {
  return (element.attrs.get("class") ?? "")
    .split(/[\t\n\f\r ]+/)
    .filter(Boolean);
}
export function hasClass(
  element: HtmlElement,
  name: string,
  quirks: boolean,
): boolean {
  return classes(element).some((c) =>
    quirks ? c.toLowerCase() === name.toLowerCase() : c === name,
  );
}

/** Concatenated text of the subtree, like `textContent`. */
export function textContent(node: HtmlNode): string {
  if (node.kind === "text") return node.text;
  let text = "";
  const stack: HtmlNode[] = [node];
  while (stack.length) {
    const current = stack.pop()!;
    if (current.kind === "text") text += current.text;
    else
      for (let i = current.children.length - 1; i >= 0; i--)
        stack.push(current.children[i]!);
  }
  return text;
}

export function findFirst(
  element: HtmlElement,
  test: (e: HtmlElement) => boolean,
): HtmlElement | undefined {
  for (const e of descendants(element)) if (test(e)) return e;
  return undefined;
}
