import { marked } from "marked";
import katex from "katex";
import { sanitizeContent } from "./security.js";
import { defaultMessages } from "@xcursus/player";
import type {
  ContentContext,
  ContentRenderer,
  RendererRegistry,
} from "@xcursus/player";
export { sanitizeContent } from "./security.js";
/** Markdown, HTML, SVG and LaTeX; `createBuiltinRegistry` loads this module on first use. */
export function richRenderer(): ContentRenderer {
  let host: HTMLElement,
    last = "";
  function update(context: ContentContext) {
    const b = context.block,
      key = JSON.stringify(b);
    if (key === last) return;
    last = key;
    host.replaceChildren();
    for (const name of ["role", "aria-label", "lang"])
      host.removeAttribute(name);
    if (b.type === "markdown" || b.type === "html" || b.type === "svg") {
      const source =
        b.type === "markdown"
          ? marked.parse(b.data.source, { async: false })
          : b.data.source;
      host.append(
        sanitizeContent(
          host,
          source,
          b.type === "svg" ? "svg" : "html",
          context.instanceId,
        ),
      );
      if (b.type === "svg") {
        host.setAttribute("role", "img");
        host.setAttribute("aria-label", b.data.alt);
      }
    } else if (b.type === "latex") {
      try {
        // KaTeX builds DOM nodes and sets its positioning styles through
        // CSSOM, so a CSP without 'unsafe-inline' styles keeps the formula
        // intact; no markup string is parsed. User HTML never reaches here.
        katex.render(b.data.source, host, {
          trust: false,
          throwOnError: true,
          maxExpand: 500,
          maxSize: 20,
          macros: Object.create(null),
          output: "htmlAndMathml",
          displayMode: b.data.display,
          strict: "error",
        });
        // A generic element cannot carry a name: the formula is a math region.
        if (b.data.alt) {
          host.setAttribute("role", "math");
          host.setAttribute("aria-label", b.data.alt);
        }
      } catch {
        const messages = context.messages ?? defaultMessages;
        host.textContent = messages.formulaInvalid(b.data.alt || b.data.source);
        host.lang = messages.lang;
        host.setAttribute("role", "status");
      }
    }
  }
  return {
    mount(element, context) {
      host = element;
      update(context);
    },
    update,
    destroy() {
      host.replaceChildren();
    },
  };
}
export function registerRich(registry: RendererRegistry): () => void {
  const off = (["markdown", "html", "svg", "latex"] as const).map((type) =>
    registry.register(type, richRenderer),
  );
  return () => off.forEach((dispose) => dispose());
}
