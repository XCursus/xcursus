import { diagnostic } from "@xcursus/core";
import type { Block, Diagnostic, ProjectDocument } from "@xcursus/core";

export type ResourceStatus = "verified" | "missing" | "invalid";
/** An asset of the project after its bytes were read and checked. */
export interface LoadedResource {
  id: string;
  path: string;
  mime: string;
  byteLength: number;
  sha256: string | null;
  status: ResourceStatus;
  diagnostic?: Diagnostic;
}

export type Format = "html" | "build" | "pdf" | "video";
export interface Unsupported {
  sceneId: string;
  blockId: string;
  type: Block["type"];
  reason: string;
}
export interface Analysis {
  /** Fail the export in strict mode; warnings with --allow-partial. */
  blocking: Diagnostic[];
  warnings: Diagnostic[];
  unsupported: Unsupported[];
  placeholders: Partial<Record<Block["type"], "excluded" | "poster">>;
}

/**
 * Published profiles (CLI help, README and manifest list the same rules):
 * - html/build: every builtin block with local assets; no embeds or plugins.
 * - pdf: static content of the arrival pose; video as poster, audio excluded.
 * - video: text, Markdown, HTML, SVG, LaTeX, images, links as static text and
 *   camera transitions only.
 */
export const profiles: Record<
  Format,
  { supported: string[]; static: string[]; excluded: string[] }
> = {
  html: {
    supported: [
      "text",
      "markdown",
      "html",
      "svg",
      "latex",
      "image",
      "audio",
      "video",
      "link",
    ],
    static: [],
    excluded: [
      "embed (remote web content)",
      "plugin (no plugin is registered by the CLI)",
      "remote resources in markup",
    ],
  },
  build: {
    supported: [
      "text",
      "markdown",
      "html",
      "svg",
      "latex",
      "image",
      "audio",
      "video",
      "link",
    ],
    static: [],
    excluded: [
      "embed (remote web content)",
      "plugin (no plugin is registered by the CLI)",
      "remote resources in markup",
    ],
  },
  pdf: {
    supported: ["text", "markdown", "html", "svg", "latex", "image", "link"],
    static: ["video (poster or placeholder)", "audio (placeholder)"],
    excluded: [
      "audio playback",
      "video playback",
      "interactions",
      "animations",
      "cues",
      "embed",
      "plugin",
      "private notes",
    ],
  },
  video: {
    supported: ["text", "markdown", "html", "svg", "latex", "image", "link"],
    static: [],
    excluded: [
      "audio",
      "video",
      "embed",
      "plugin",
      "cues",
      "interactions",
      "sound track",
    ],
  },
};

/** Remote references in markup; the sanitizer drops them, so an offline output would silently lose them. */
const remote = [
  /\b(?:src|srcset|poster|data|xlink:href)\s*=\s*["']?\s*(?:https?:)?\/\//i,
  /<link\b/i,
  /<(?:iframe|object|embed|script)\b/i,
  /!\[[^\]]*\]\(\s*<?(?:https?:)?\/\//i,
];
// CSS loads only from a <style> element or a style attribute.
const styles =
  /<style\b[^>]*>([\s\S]*?)(?:<\/style>|$)|\bstyle\s*=\s*("[^"]*"|'[^']*')/gi;
const cssRemote = /@import\b|url\(\s*["']?\s*(?:https?:)?\/\//i;
const svgRemote = /\bhref\s*=\s*["']?\s*(?:https?:)?\/\//i;

/**
 * Markdown without fenced code blocks and code spans: there a tag or an
 * `@import` is text shown to the reader, never markup.
 */
export function withoutMarkdownCode(source: string): string {
  const kept: string[] = [];
  let fence: string | undefined;
  for (const line of source.split("\n")) {
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
      if (
        close &&
        close[1]![0] === fence[0] &&
        close[1]!.length >= fence.length
      )
        fence = undefined;
      continue;
    }
    const open = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    // A backtick fence's info string cannot contain a backtick.
    if (open && !(open[1]![0] === "`" && open[2]!.includes("`"))) {
      fence = open[1];
      continue;
    }
    kept.push(line);
  }
  return kept.join("\n").replace(/(`+)(?!`)[\s\S]*?[^`]\1(?!`)/g, "");
}

export function referencesRemote(
  type: "markdown" | "html" | "svg",
  source: string,
): boolean {
  const markup = type === "markdown" ? withoutMarkdownCode(source) : source;
  if (remote.some((r) => r.test(markup))) return true;
  if (type === "svg" && svgRemote.test(markup)) return true;
  for (const [, element, attribute] of markup.matchAll(styles))
    if (cssRemote.test(element ?? attribute ?? "")) return true;
  return false;
}

export function analyze(
  document: ProjectDocument,
  resources: LoadedResource[],
  format: Format,
): Analysis {
  const blocking: Diagnostic[] = [],
    warnings: Diagnostic[] = [],
    unsupported: Unsupported[] = [];
  const placeholders: Analysis["placeholders"] = {};
  const block = (
    code: string,
    message: string,
    pointer: string,
    entry: Unsupported,
    placeholder: "excluded" | "poster" = "excluded",
  ) => {
    blocking.push(diagnostic(code, message, pointer));
    unsupported.push(entry);
    placeholders[entry.type] = placeholder;
  };
  const capture = format === "pdf" || format === "video";
  let links = false;
  for (const [s, scene] of document.scenes.entries())
    for (const [b, item] of scene.blocks.entries()) {
      const pointer = `/scenes/${s}/blocks/${b}`;
      const entry = (reason: string): Unsupported => ({
        sceneId: scene.id,
        blockId: item.id,
        type: item.type,
        reason,
      });
      switch (item.type) {
        case "embed":
          block(
            "EMBED_REMOTE",
            "Embeds load remote web content and are not exported offline",
            pointer,
            entry("remote web content"),
          );
          break;
        case "plugin":
          block(
            "PLUGIN_UNAVAILABLE",
            `Plugin ${item.data.pluginId} has no offline/capture renderer registered in the CLI`,
            pointer,
            entry("plugin without offline or capture capability"),
          );
          break;
        case "audio":
          if (format === "video")
            block(
              "MEDIA_PROFILE",
              "Audio is outside the minimal video profile (no sound track)",
              pointer,
              entry("audio not part of the video profile"),
            );
          else if (format === "pdf") {
            warnings.push(
              diagnostic(
                "AUDIO_EXCLUDED",
                "Audio is excluded from the PDF",
                pointer,
              ),
            );
            unsupported.push(entry("audio excluded from print"));
            placeholders.audio = "excluded";
          }
          break;
        case "video":
          if (format === "video")
            block(
              "MEDIA_PROFILE",
              "Video media is outside the minimal video profile",
              pointer,
              entry("dynamic media not part of the video profile"),
            );
          else if (format === "pdf") {
            warnings.push(
              diagnostic(
                "VIDEO_POSTER",
                item.data.posterAssetId
                  ? "Video printed as its poster image"
                  : "Video without poster printed as a placeholder",
                pointer,
              ),
            );
            unsupported.push(entry("video printed as poster or placeholder"));
            placeholders.video = "poster";
          }
          break;
        case "link":
          links = true;
          break;
        case "markdown":
        case "html":
        case "svg": {
          if (referencesRemote(item.type, item.data.source)) {
            blocking.push(
              diagnostic(
                "REMOTE_RESOURCE",
                "Markup references a remote resource (font, stylesheet, image or frame); it is removed by the sanitizer and cannot be exported offline",
                `${pointer}/data/source`,
              ),
            );
            // The block is kept; only the remote part is missing from the output.
            unsupported.push(entry("remote resource removed by the sanitizer"));
          }
          break;
        }
      }
    }
  if (capture && links)
    warnings.push(
      diagnostic(
        "LINK_STATIC",
        "Links are printed as static text; interactions are not exported",
      ),
    );
  if (capture && document.cues.length)
    warnings.push(
      diagnostic(
        "CUES_IGNORED",
        "Cues are declarative events of the live player and are not captured",
      ),
    );
  // Assets the output really renders; problems elsewhere are warnings.
  const used = new Set<string>();
  for (const scene of document.scenes)
    for (const b of scene.blocks) {
      if (b.type === "image") used.add(b.data.assetId);
      if (b.type === "video" && format === "pdf" && b.data.posterAssetId)
        used.add(b.data.posterAssetId);
      if (format !== "html" && format !== "build") continue;
      if (b.type === "audio" || b.type === "video") used.add(b.data.assetId);
      if (b.type === "video") {
        if (b.data.posterAssetId) used.add(b.data.posterAssetId);
        if (b.data.captionsAssetId) used.add(b.data.captionsAssetId);
      }
    }
  for (const resource of resources)
    if (resource.status !== "verified" && used.has(resource.id))
      blocking.push(resource.diagnostic!);
    else if (resource.status !== "verified")
      warnings.push(resource.diagnostic!);
  return { blocking, warnings, unsupported, placeholders };
}

/** Fonts the document's theme or content need, embedded with their licences. */
export function fontsUsed(document: ProjectDocument) {
  return {
    theme:
      document.theme.fonts.body === "atkinson-hyperlegible" ||
      document.theme.fonts.heading === "atkinson-hyperlegible",
    katex: document.scenes.some((s) =>
      s.blocks.some((b) => b.type === "latex"),
    ),
  };
}
