import type { Diagnostic } from "@xcursus/core";

/** Line and column (1-based) in the imported HTML, from the parser's location info. */
export interface SourceLocation {
  line: number;
  column: number;
}
/**
 * A core diagnostic plus its origin in the HTML. `pointer` is a JSON Pointer
 * into the candidate document ("" for the document as a whole); `source`
 * names the step (its original ID or `#index`) and the element location.
 */
export interface ImportDiagnostic extends Diagnostic {
  source?: Partial<SourceLocation> & { step?: string };
}

type Severity = Diagnostic["severity"];
/**
 * Every code the importer emits, with its severity. Errors stop the import
 * (no candidate); warnings and infos describe what the candidate does not
 * carry over or carries over differently.
 */
export const IMPORT_CODES = {
  // Structural: no candidate.
  HTML_TOO_LARGE: "error",
  HTML_TOO_DEEP: "error",
  BASELINE_UNSUPPORTED: "error",
  OPTIONS_INVALID: "error",
  IMPRESS_ROOT_MISSING: "error",
  IMPRESS_NO_STEPS: "error",
  IMPRESS_TOO_MANY_STEPS: "error",
  CANDIDATE_INVALID: "error",
  // Configuration of the root element.
  VIEWPORT_INVALID: "warning",
  PERSPECTIVE_INVALID: "warning",
  PERSPECTIVE_SCREEN_RELATIVE: "info",
  DURATION_INVALID: "warning",
  WINDOW_SCALE_LIMITS_IGNORED: "info",
  TIMING_APPROXIMATE: "info",
  NAVIGATION_WRAP_DROPPED: "info",
  // Steps and geometry.
  PROFILE_AMBIGUOUS: "warning",
  STEP_ID_GENERATED: "info",
  STEP_ID_RENAMED: "warning",
  STEP_ID_DUPLICATE: "warning",
  STEP_NESTED: "warning",
  STEP_OUTSIDE_ROOT: "warning",
  STEP_SKIPPED: "info",
  STEP_TRANSFORM_INVALID: "warning",
  POSITION_OUT_OF_RANGE: "warning",
  SCALE_INVALID: "warning",
  SCALE_NEGATIVE: "info",
  SCALE_OUT_OF_RANGE: "warning",
  ROTATE_ORDER_INVALID: "warning",
  ROTATE_ORDER_PARTIAL: "warning",
  ROTATE_ALIAS_CONFLICT: "info",
  REL_POSITION_RELATIVE: "warning",
  REL_TO_INVALID: "warning",
  STEP_SIZE_DEFAULT: "warning",
  STEP_SIZE_INLINE: "info",
  ROOT_CONTENT_IGNORED: "warning",
  // Content.
  TITLE_FROM_ID: "info",
  LANGUAGE_ASSUMED: "info",
  NOTES_IMPORTED: "info",
  SCRIPT_REMOVED: "warning",
  CSS_NOT_CONVERTED: "warning",
  INLINE_STYLE_NOT_CONVERTED: "info",
  EVENT_HANDLER_REMOVED: "warning",
  ACTIVE_URL_REMOVED: "warning",
  LINK_DROPPED: "info",
  FRAME_REMOVED: "warning",
  FORM_REMOVED: "warning",
  CANVAS_REMOVED: "warning",
  MATHML_NOT_CONVERTED: "warning",
  INERT_REMOVED: "info",
  ELEMENT_UNWRAPPED: "info",
  ATTRIBUTES_DROPPED: "info",
  SVG_CONTENT_REMOVED: "warning",
  CONTENT_TRUNCATED: "warning",
  BLOCK_LIMIT: "warning",
  IMAGE_ALT_MISSING: "warning",
  MEDIA_LABEL_MISSING: "warning",
  // Plugins and dynamic behaviour of the upstream bundle.
  PLUGIN_ATTRIBUTE_IGNORED: "warning",
  SUBSTEP_FLATTENED: "warning",
  MARKDOWN_NOT_RENDERED: "warning",
  // Resources: nothing is fetched.
  RESOURCE_REMOTE: "warning",
  RESOURCE_DATA_URL: "warning",
  RESOURCE_OUTSIDE_ROOT: "warning",
  RESOURCE_MISSING: "warning",
  RESOURCE_INVALID: "warning",
  RESOURCE_UNSUPPORTED: "warning",
  STYLESHEET_IGNORED: "warning",
  SCRIPT_RESOURCE_IGNORED: "info",
} as const satisfies Record<string, Severity>;
export type ImportCode = keyof typeof IMPORT_CODES;

/** Collects diagnostics; `once` keys keep repeated findings from flooding the report. */
export class Diagnostics {
  readonly list: ImportDiagnostic[] = [];
  private readonly seen = new Set<string>();
  add(
    code: ImportCode,
    message: string,
    pointer = "",
    source?: ImportDiagnostic["source"],
    hint?: string,
  ): void {
    this.list.push({
      code,
      severity: IMPORT_CODES[code],
      pointer,
      message,
      ...(hint ? { hint } : {}),
      ...(source ? { source } : {}),
    });
  }
  /** Adds the diagnostic only the first time `key` is seen. */
  once(
    key: string,
    code: ImportCode,
    message: string,
    pointer = "",
    source?: ImportDiagnostic["source"],
    hint?: string,
  ): void {
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.add(code, message, pointer, source, hint);
  }
  get failed(): boolean {
    return this.list.some((d) => d.severity === "error");
  }
}
