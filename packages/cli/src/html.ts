// Standalone HTML without Node APIs (`@xcursus/cli/html`): `xcursus export
// html` and the export panel of Studio run this same pipeline, so profile,
// placeholders, CSP and self-checks cannot drift apart.
import { diagnostic, publicDocument } from "@xcursus/core";
import type { Diagnostic, ProjectDocument } from "@xcursus/core";
import { AssetError, sha256, verifyAsset } from "@xcursus/player";
import type { RuntimeConfig } from "./config.js";
import { base64, kitStyles, standalonePage } from "./page.js";
import type { EmbeddedFont, ExportKit } from "./page.js";
import { analyze } from "./profile.js";
import type { Analysis, Format, LoadedResource } from "./profile.js";

export type { ExportKit, EmbeddedFont, KitStylesheet } from "./page.js";
export type { Analysis, LoadedResource } from "./profile.js";
export { profiles } from "./profile.js";

export function messagesFor(
  document: ProjectDocument,
  lang?: "en" | "it",
): "en" | "it" {
  return (
    lang ??
    (document.metadata.language.toLowerCase().startsWith("it") ? "it" : "en")
  );
}
/** What the output records: blocking findings became placeholders, so every entry is a warning. */
export function manifestWarnings(analysis: Analysis): Diagnostic[] {
  return [...analysis.blocking, ...analysis.warnings].map((d) => ({
    ...d,
    severity: "warning",
  }));
}
/** Assets the output renders: placeholders drop theirs, a printed video keeps its poster. */
export function requiredAssets(
  document: ProjectDocument,
  analysis: Analysis,
  format: Format,
) {
  const ids = new Set<string>();
  for (const scene of document.scenes)
    for (const b of scene.blocks) {
      const kind = analysis.placeholders[b.type];
      if (b.type === "image") ids.add(b.data.assetId);
      if (b.type === "video" && kind === "poster" && b.data.posterAssetId)
        ids.add(b.data.posterAssetId);
      if ((format === "html" || format === "build") && !kind) {
        if (b.type === "audio" || b.type === "video") ids.add(b.data.assetId);
        if (b.type === "video" && b.data.posterAssetId)
          ids.add(b.data.posterAssetId);
        if (b.type === "video" && b.data.captionsAssetId)
          ids.add(b.data.captionsAssetId);
      }
    }
  return ids;
}
export async function base64Assets(
  blobs: Map<string, Blob>,
  include: (id: string) => boolean,
) {
  const data: Record<string, string> = {};
  for (const [id, blob] of blobs)
    if (include(id))
      data[id] = base64(new Uint8Array(await blob.arrayBuffer()));
  return data;
}

/**
 * Resources of a project held in memory (Studio): each declared asset is
 * checked against its size, MIME signature and digest with the same rule as
 * the CLI; an asset without bytes is missing. Returns the verified blobs only.
 */
export async function verifyResources(
  document: ProjectDocument,
  blobs: ReadonlyMap<string, Blob>,
) {
  const resources: LoadedResource[] = [],
    verified = new Map<string, Blob>();
  for (const [index, asset] of document.assets.entries()) {
    const base = {
      id: asset.id,
      path: asset.path,
      mime: asset.mime,
      byteLength: asset.byteLength,
      sha256: asset.sha256 ?? null,
    };
    const pointer = `/assets/${index}/path`;
    const blob = blobs.get(asset.id);
    if (!blob) {
      resources.push({
        ...base,
        status: "missing",
        diagnostic: diagnostic(
          "ASSET_MISSING",
          `Asset file not available: ${asset.path}`,
          pointer,
        ),
      });
      continue;
    }
    try {
      await verifyAsset(asset, blob);
    } catch (error) {
      resources.push({
        ...base,
        status: "invalid",
        diagnostic: diagnostic(
          error instanceof AssetError
            ? `ASSET_${error.code.toUpperCase()}`
            : "ASSET_INVALID",
          `${asset.path}: ${String(error)}`,
          pointer,
        ),
      });
      continue;
    }
    verified.set(asset.id, blob);
    resources.push({ ...base, sha256: await sha256(blob), status: "verified" });
  }
  return { resources, blobs: verified };
}

export interface StandaloneInput {
  /** The authoring document; private notes are removed here. */
  document: ProjectDocument;
  resources: LoadedResource[];
  /** Verified bytes only. */
  blobs: Map<string, Blob>;
  kit: ExportKit;
  lang?: "en" | "it";
  /** Strict when false: any blocking finding refuses the export. */
  allowPartial: boolean;
  generator: string;
}
export type StandaloneResult =
  | { ok: false; analysis: Analysis }
  | {
      ok: true;
      html: string;
      status: "complete" | "partial";
      analysis: Analysis;
      warnings: Diagnostic[];
      /** Public copy that the page embeds. */
      document: ProjectDocument;
      lang: "en" | "it";
      needed: Set<string>;
      fonts: EmbeddedFont[];
      csp: string;
      verification: {
        jsonBlocksParse: boolean;
        scriptCount: number;
        cspHashesMatchInlineCode: boolean;
        privateNotesAbsent: boolean;
      };
    };

/**
 * One self-contained HTML file: export runtime, styles with their fonts and
 * the verified assets inline, CSP with hashes and connect-src 'none'. The
 * page is checked before it is returned; a failed self-check throws.
 */
export async function standaloneHtml(
  input: StandaloneInput,
): Promise<StandaloneResult> {
  const analysis = analyze(input.document, input.resources, "html");
  if (analysis.blocking.length && !input.allowPartial)
    return { ok: false, analysis };
  const document = publicDocument(input.document);
  const lang = messagesFor(document, input.lang);
  const config: RuntimeConfig = {
    mode: "present",
    assets: "inline",
    messages: lang,
    placeholders: analysis.placeholders,
  };
  const { css, fonts } = kitStyles(input.kit, document);
  const needed = requiredAssets(document, analysis, "html");
  const page = await standalonePage({
    document,
    config,
    css,
    runtime: input.kit.script,
    notices: input.kit.notices,
    assets: await base64Assets(input.blobs, (id) => needed.has(id)),
    generator: input.generator,
  });
  // Checks this run performs on its own output.
  const scripts = [
    ...page.html.matchAll(
      /<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g,
    ),
  ];
  const verification = {
    jsonBlocksParse: scripts.every((m) => {
      try {
        JSON.parse(m[1]!);
        return true;
      } catch {
        return false;
      }
    }),
    scriptCount: (page.html.match(/<script\b/g) ?? []).length,
    cspHashesMatchInlineCode:
      page.csp.includes(page.scriptHash) && page.csp.includes(page.styleHash),
    privateNotesAbsent: input.document.scenes.every(
      (s) =>
        s.notes === "" ||
        !page.html.includes(JSON.stringify(s.notes).slice(1, -1)),
    ),
  };
  if (
    !verification.jsonBlocksParse ||
    !verification.cspHashesMatchInlineCode ||
    !verification.privateNotesAbsent
  )
    throw new Error("Self-check of the generated HTML failed");
  return {
    ok: true,
    html: page.html,
    status: analysis.blocking.length ? "partial" : "complete",
    analysis,
    warnings: manifestWarnings(analysis),
    document,
    lang,
    needed,
    fonts,
    csp: page.csp,
    verification,
  };
}
