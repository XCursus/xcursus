import type { Block } from "@xcursus/core";
/** Data block read by the export runtime; written by the CLI into every page. */
export interface RuntimeConfig {
  mode: "present" | "capture";
  /** Inline base64 assets (standalone HTML, capture) or files next to the page (static build). */
  assets: "inline" | "files";
  messages: "en" | "it";
  /** Block types replaced by a static placeholder; video may become its poster. */
  placeholders: Partial<Record<Block["type"], "excluded" | "poster">>;
}
