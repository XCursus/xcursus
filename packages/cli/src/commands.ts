import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  diagnostic,
  frameSchedule,
  frameTime,
  planCapture,
  publicDocument,
  sampleCapture,
  viewMatrix,
} from "@xcursus/core";
import type {
  CapturePlan,
  Diagnostic,
  FrameSchedule,
  ProjectDocument,
} from "@xcursus/core";
import {
  buildPage,
  exportKit,
  pageStyle,
  runtimeFiles,
  stylesheets,
  toolVersion,
} from "./assemble.js";
import {
  base64Assets,
  manifestWarnings,
  messagesFor,
  requiredAssets,
  standaloneHtml,
} from "./html.js";
import { kitStyles, standalonePage } from "./page.js";
import type { EmbeddedFont } from "./page.js";
import { isAnimatedImage } from "./animation.js";
import {
  captureViolations,
  classifyViolations,
  findEncoder,
  launchChromium,
  openCapturePage,
  runTool,
} from "./capture.js";
import type { Chromium } from "./capture.js";
import { PDFDocument } from "pdf-lib";
import {
  ARCHIVE_EXTENSION,
  LEGACY_ARCHIVE_EXTENSION,
  archiveFormat,
  writeArchive,
} from "@xcursus/plugins/archive";
import {
  CliError,
  EXIT,
  MANIFEST_NAME,
  inside,
  loadProject,
  prepareOutput,
  readItinerary,
  writeAtomic,
  writeDirectoryAtomic,
  writeFile,
} from "./io.js";
import type { LoadedProject } from "./io.js";
import { analyze, fontsUsed, profiles } from "./profile.js";
import type { Analysis, Format } from "./profile.js";
import type { RuntimeConfig } from "./config.js";

export interface CommonOptions {
  out: string;
  overwrite: boolean;
  allowPartial: boolean;
  lang?: "en" | "it";
}
export interface Report {
  log(line: string): void;
  warn(line: string): void;
}
const sha = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");
const HTML_TARGET = 25 * 1024 * 1024;
/** Relative tolerance of the rendered world matrix (CSS number serialization). */
const POSE_TOLERANCE = 1e-5;

/** Every manifest field describes what this run did; `verification` lists only checks it performed. */
export interface ExportManifest {
  format: Format;
  status: "complete" | "partial";
  toolVersion: string;
  schemaVersion: string;
  source: {
    kind: "json" | "archive";
    file: string;
    sourceSchemaVersion: string;
    documentId: string;
  };
  itinerary?: {
    pathId: string;
    visits: Array<{ nodeId: string; edgeIdToNext?: string }>;
    totalMs: number;
    reducedMotion: boolean;
  };
  profile: { supported: string[]; static: string[]; excluded: string[] };
  privateNotes: "excluded";
  resources: Array<{
    id: string;
    kind: "asset" | "font" | "runtime";
    path?: string;
    mime?: string;
    byteLength?: number;
    sha256: string | null;
    status: "embedded" | "copied" | "missing" | "invalid" | "excluded";
  }>;
  licenses: Array<{ name: string; version: string; license: string }>;
  warnings: Diagnostic[];
  unsupported: Analysis["unsupported"];
  environment: Record<string, unknown>;
  verification: Record<string, unknown>;
  output: { file: string; byteLength: number; sha256: string };
}

function environment(extra: Record<string, unknown> = {}) {
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    ...extra,
  };
}
/** Strict by default: blocking findings fail with exit 1 unless --allow-partial. */
function gate(
  analysis: Analysis,
  options: { allowPartial: boolean },
  report: Report,
) {
  if (analysis.blocking.length && !options.allowPartial)
    throw new CliError(
      EXIT.data,
      "The project is outside the output profile (strict). Fix it or use --allow-partial for placeholders.",
      analysis.blocking,
    );
  for (const d of [...analysis.blocking, ...analysis.warnings])
    report.warn(`warning ${d.code} ${d.pointer} ${d.message}`);
}
async function licensesOf(
  notices: string,
  fonts: { theme: boolean; katex: boolean },
) {
  // The runtime notice file lists packages as "name version\nLicense: X".
  const all = [
    ...notices.matchAll(/^={72}\n(\S+) (\S+)\nLicense: (.+)$/gm),
  ].map((m) => ({ name: m[1]!, version: m[2]!, license: m[3]! }));
  return all.filter(
    (p) => p.name !== "@fontsource/atkinson-hyperlegible" || fonts.theme,
  );
}
function resourceEntries(
  project: LoadedProject,
  analysis: Analysis,
  copied: "embedded" | "copied",
  format: Format,
): ExportManifest["resources"] {
  const excludedTypes = new Set(
    Object.entries(analysis.placeholders)
      .filter(([, kind]) => kind === "excluded")
      .map(([type]) => type),
  );
  return project.resources.map((r) => {
    const users = project.document.scenes.flatMap((s) =>
      s.blocks.filter((b) =>
        ["assetId", "posterAssetId", "captionsAssetId"].some(
          (f) => (b.data as Record<string, unknown>)[f] === r.id,
        ),
      ),
    );
    const needed =
      users.length === 0 ||
      users.some(
        (b) =>
          !excludedTypes.has(b.type) &&
          !(
            format === "pdf" &&
            b.type === "video" &&
            (b.data as { posterAssetId?: string }).posterAssetId !== r.id
          ),
      );
    return {
      id: r.id,
      kind: "asset",
      path: r.path,
      mime: r.mime,
      byteLength: r.byteLength,
      sha256: r.sha256,
      status: r.status !== "verified" ? r.status : needed ? copied : "excluded",
    };
  });
}
const fontResources = (fonts: EmbeddedFont[], status: "embedded" | "copied") =>
  fonts.map((f) => ({
    id: f.file,
    kind: "font" as const,
    path: `fonts/${f.file}`,
    mime: "font/woff2",
    byteLength: f.byteLength,
    sha256: f.sha256,
    status,
  }));
export async function validate(input: string) {
  const project = await loadProject(input);
  const problems = project.resources.flatMap((r) =>
    r.diagnostic ? [{ ...r.diagnostic, severity: "error" as const }] : [],
  );
  return { project, diagnostics: problems, ok: problems.length === 0 };
}

/**
 * Writes the project as a `.xcursus` archive: the document migrated to the
 * current schema, private notes and extensions included, with every asset
 * verified. Accepts JSON with its assets, `.xcursus` and legacy `.spatialdeck`;
 * the input is only read.
 */
export async function pack(
  input: string,
  options: { out: string; overwrite: boolean },
  report: Report,
) {
  if (archiveFormat(options.out) !== "current")
    throw new CliError(
      EXIT.data,
      `--out must name a ${ARCHIVE_EXTENSION} file: ${options.out}`,
    );
  const target = await prepareOutput(options.out, options.overwrite, "file");
  const project = await loadProject(input);
  // The source is a real path: compare against the real target when it exists.
  const existing = await realpath(target.path).catch(() =>
    resolve(target.path),
  );
  if (existing === project.source)
    throw new CliError(
      EXIT.output,
      `Refusing to replace the input project: ${project.source}`,
    );
  const problems = project.resources.flatMap((r) =>
    r.diagnostic ? [{ ...r.diagnostic, severity: "error" as const }] : [],
  );
  if (problems.length)
    throw new CliError(
      EXIT.data,
      "Every asset must be available and verified to write an archive",
      problems,
    );
  let bytes: Uint8Array;
  try {
    const blob = await writeArchive(project.document, project.blobs);
    bytes = new Uint8Array(await blob.arrayBuffer());
  } catch (error) {
    throw new CliError(EXIT.data, `Cannot write the archive: ${String(error)}`);
  }
  await writeAtomic(target.path, bytes);
  const from =
    project.sourceSchemaVersion === project.document.schemaVersion
      ? ""
      : `, migrated from ${project.sourceSchemaVersion}`;
  const legacy =
    project.archiveFormat === "legacy"
      ? `, from a legacy ${LEGACY_ARCHIVE_EXTENSION} archive`
      : "";
  report.log(
    `archive ${target.path} (schema ${project.document.schemaVersion}${from}${legacy}, ${project.resources.length} resources, ${bytes.length} bytes)`,
  );
  return {
    path: target.path,
    byteLength: bytes.length,
    schemaVersion: project.document.schemaVersion,
    sourceSchemaVersion: project.sourceSchemaVersion,
  };
}

export async function exportHtml(
  input: string,
  options: CommonOptions,
  report: Report,
) {
  const target = await prepareOutput(options.out, options.overwrite, "file");
  const project = await loadProject(input);
  // The profile decides before the runtime is read: a refusal needs no build output.
  gate(analyze(project.document, project.resources, "html"), options, report);
  const kit = await exportKit();
  const result = await standaloneHtml({
    document: project.document,
    resources: project.resources,
    blobs: project.blobs,
    kit,
    ...(options.lang ? { lang: options.lang } : {}),
    allowPartial: options.allowPartial,
    generator: `XCursus CLI ${toolVersion}`,
  }).catch((error: unknown) => {
    throw new CliError(EXIT.output, String(error));
  });
  if (!result.ok) throw new Error("unreachable: strict gate");
  const { analysis, document, needed, fonts, verification } = result;
  const bytes = Buffer.from(result.html, "utf8");
  const warnings = result.warnings;
  if (bytes.length > HTML_TARGET)
    warnings.push({
      code: "HTML_SIZE",
      severity: "warning",
      pointer: "",
      message: `The HTML is ${bytes.length} bytes, above the 25 MiB target; prefer a static build or an archive for large projects`,
    });
  const manifest: ExportManifest = {
    format: "html",
    status: analysis.blocking.length ? "partial" : "complete",
    toolVersion,
    schemaVersion: document.schemaVersion,
    source: {
      kind: project.kind,
      file: basename(project.source),
      sourceSchemaVersion: project.sourceSchemaVersion,
      documentId: document.id,
    },
    profile: profiles.html,
    privateNotes: "excluded",
    resources: [
      ...resourceEntries(project, analysis, "embedded", "html").map((r) =>
        r.status === "embedded" && !needed.has(r.id)
          ? { ...r, status: "excluded" as const }
          : r,
      ),
      ...fontResources(fonts, "embedded"),
      {
        id: "xcursus-runtime.js",
        kind: "runtime",
        sha256: sha(kit.script),
        status: "embedded",
      },
    ],
    licenses: await licensesOf(kit.notices, fontsUsed(document)),
    warnings,
    unsupported: analysis.unsupported,
    environment: environment(),
    verification: { ...verification, csp: result.csp },
    output: {
      file: basename(target.path),
      byteLength: bytes.length,
      sha256: sha(bytes),
    },
  };
  await writeAtomic(target.path, bytes);
  await writeAtomic(target.manifest, JSON.stringify(manifest, null, 2) + "\n");
  report.log(`html ${target.path} (${bytes.length} bytes, ${manifest.status})`);
  return manifest;
}

export async function build(
  input: string,
  options: CommonOptions,
  report: Report,
) {
  const target = await prepareOutput(
    options.out,
    options.overwrite,
    "directory",
  );
  const project = await loadProject(input);
  const analysis = analyze(project.document, project.resources, "build");
  gate(analysis, options, report);
  const document = publicDocument(project.document);
  const config: RuntimeConfig = {
    mode: "present",
    assets: "files",
    messages: messagesFor(document, options.lang),
    placeholders: analysis.placeholders,
  };
  const runtime = await runtimeFiles();
  const sheets = await stylesheets(document);
  const needed = requiredAssets(document, analysis, "build");
  const fonts: EmbeddedFont[] = [];
  const files: Record<string, string> = {};
  const written: Array<{ file: string; sha256: string; byteLength: number }> =
    [];
  await writeDirectoryAtomic(target.path, async (dir) => {
    const put = async (name: string, data: string | Uint8Array) => {
      const path = inside(dir, name);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, data);
      written.push({
        file: name,
        sha256: sha(data),
        byteLength: Buffer.byteLength(data),
      });
    };
    await put("xcursus-runtime.js", runtime.script);
    await put("THIRD_PARTY_NOTICES.txt", runtime.notices);
    for (const sheet of sheets) {
      await put(sheet.name, sheet.css);
      for (const font of sheet.fonts) {
        const data = await readFile(font.path);
        await put(`fonts/${font.file}`, data);
        fonts.push({
          file: font.file,
          byteLength: data.length,
          sha256: sha(data),
        });
      }
    }
    await put("export.css", pageStyle(document, false));
    await put("project.json", JSON.stringify(document, null, 2) + "\n");
    for (const asset of document.assets) {
      const blob = project.blobs.get(asset.id);
      if (!blob || !needed.has(asset.id)) continue;
      // Portable names under assets/<id>/, like the archive format.
      const name = `assets/${asset.id}/${(asset.path.split("/").at(-1) ?? "asset").normalize("NFC").replace(/[^A-Za-z0-9._-]/g, "_") || "asset"}`;
      await put(name, new Uint8Array(await blob.arrayBuffer()));
      files[asset.id] = name;
    }
    const html = buildPage(
      document,
      config,
      [...sheets.map((s) => s.name), "export.css"],
      files,
    );
    await put("index.html", html);
    const manifest: ExportManifest = {
      format: "build",
      status: analysis.blocking.length ? "partial" : "complete",
      toolVersion,
      schemaVersion: document.schemaVersion,
      source: {
        kind: project.kind,
        file: basename(project.source),
        sourceSchemaVersion: project.sourceSchemaVersion,
        documentId: document.id,
      },
      profile: profiles.build,
      privateNotes: "excluded",
      resources: [
        ...resourceEntries(project, analysis, "copied", "build").map((r) =>
          r.status === "copied" && !files[r.id]
            ? { ...r, status: "excluded" as const }
            : r,
        ),
        ...fontResources(fonts, "copied"),
        {
          id: "xcursus-runtime.js",
          kind: "runtime",
          sha256: sha(runtime.script),
          status: "copied",
        },
      ],
      licenses: await licensesOf(runtime.notices, fontsUsed(document)),
      warnings: manifestWarnings(analysis),
      unsupported: analysis.unsupported,
      environment: environment(),
      verification: { files: written.length, digests: written },
      output: {
        file: "index.html",
        byteLength: Buffer.byteLength(html),
        sha256: sha(html),
      },
    };
    await writeFile(
      join(dir, MANIFEST_NAME),
      JSON.stringify(manifest, null, 2) + "\n",
    );
  });
  report.log(`build ${target.path} (${written.length} files)`);
}

interface CaptureInput {
  project: LoadedProject;
  analysis: Analysis;
  document: ProjectDocument;
  plan: CapturePlan;
  itinerary: string;
}
async function prepareCapture(
  input: string,
  itineraryFile: string,
  format: "pdf" | "video",
  options: CommonOptions & { reducedMotion: boolean },
  report: Report,
): Promise<CaptureInput> {
  const project = await loadProject(input);
  const analysis = analyze(project.document, project.resources, format);
  const itinerary = await readItinerary(itineraryFile);
  const plan = planCapture(project.document, itinerary, {
    reducedMotion: options.reducedMotion,
  });
  if (!plan.ok)
    throw new CliError(EXIT.data, "Invalid itinerary", plan.diagnostics);
  // The capture runtime shows animated images as their first frame.
  const images = new Set(
    project.document.scenes.flatMap((s) =>
      s.blocks.flatMap((b) =>
        b.type === "image"
          ? [b.data.assetId]
          : b.type === "video" && b.data.posterAssetId
            ? [b.data.posterAssetId]
            : [],
      ),
    ),
  );
  for (const [i, asset] of project.document.assets.entries()) {
    const blob = project.blobs.get(asset.id);
    if (
      images.has(asset.id) &&
      blob &&
      isAnimatedImage(new Uint8Array(await blob.arrayBuffer()), asset.mime)
    )
      analysis.warnings.push({
        ...diagnostic(
          "ANIMATION_FROZEN",
          `Animated image ${asset.id} is captured as its first frame`,
          `/assets/${i}`,
        ),
        severity: "warning",
      });
  }
  gate(analysis, options, report);
  return {
    project,
    analysis,
    document: publicDocument(project.document),
    plan: plan.value,
    itinerary,
  };
}
async function withCapture<T>(
  capture: CaptureInput,
  format: "pdf" | "video",
  lang: "en" | "it" | undefined,
  report: Report,
  task: (
    session: Awaited<ReturnType<typeof openCapturePage>>,
    chromium: Chromium,
    dir: string,
  ) => Promise<T>,
) {
  const { document, analysis, project } = capture;
  const kit = await exportKit();
  const { css, fonts } = kitStyles(kit, document);
  const needed = requiredAssets(document, analysis, format);
  const page = await standalonePage({
    document,
    config: {
      mode: "capture",
      assets: "inline",
      messages: messagesFor(document, lang),
      placeholders: analysis.placeholders,
    },
    css,
    runtime: kit.script,
    notices: kit.notices,
    assets: await base64Assets(project.blobs, (id) => needed.has(id)),
    generator: `XCursus CLI ${toolVersion}`,
    capture: true,
  });
  // Owned temporary directory: the only thing this command removes.
  const dir = await mkdtemp(join(tmpdir(), `xcursus-${format}-`));
  const chromium = await launchChromium().catch(async (error: unknown) => {
    await rm(dir, { recursive: true, force: true });
    throw error;
  });
  try {
    const session = await openCapturePage(chromium, document, page.html, dir);
    const result = await task(session, chromium, dir);
    const csp = classifyViolations(await captureViolations(session.page));
    const errors = [...session.errors, ...csp.errors];
    if (errors.length)
      throw new CliError(
        EXIT.output,
        `Errors in the capture page: ${errors.join("; ")}`,
      );
    if (csp.blockedAttributes) {
      const warning: Diagnostic = {
        ...diagnostic(
          "CSP_ATTRIBUTE_BLOCKED",
          `${csp.blockedAttributes} inline style or event attributes in the content markup were blocked by the CSP; the sanitizer removes them, so the output is unaffected`,
        ),
        severity: "warning",
      };
      analysis.warnings.push(warning);
      report.warn(`warning ${warning.code} ${warning.message}`);
    }
    return { result, fonts, runtime: kit, needed };
  } finally {
    await chromium.browser.close().catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
}
async function renderAt(
  session: Awaited<ReturnType<typeof openCapturePage>>,
  plan: CapturePlan,
  t: number,
) {
  const result = await session.page.evaluate(
    ([p, time]) =>
      (
        window as unknown as {
          xcursusCapture: {
            renderAt(
              plan: unknown,
              t: number,
            ): Promise<{ ok: boolean; diagnostics: Diagnostic[] }>;
          };
        }
      ).xcursusCapture.renderAt(p, time),
    [plan, t] as const,
  );
  if (!result.ok)
    throw new CliError(
      EXIT.output,
      `renderAt(${t}) failed: ${result.diagnostics.map((d) => d.message).join("; ")}`,
    );
  // The pose on screen must be the sampler's pose: compare the world matrix
  // relative to its magnitude, since CSSOM serializes about six significant digits.
  const rendered = await session.page.evaluate(() => {
    const world = document.querySelector<HTMLElement>(
      "#xcursus-stage .xc-world",
    );
    return world?.style.transform ?? "";
  });
  const values =
    /matrix3d\(([^)]+)\)/.exec(rendered)?.[1]?.split(",").map(Number) ?? [];
  const expected = viewMatrix(sampleCapture(plan, t).camera);
  return values.length === 16
    ? Math.max(
        ...expected.map(
          (x, i) => Math.abs(x - values[i]!) / Math.max(1, Math.abs(x)),
        ),
      )
    : Infinity;
}
const pdfPages = (bytes: Buffer) => {
  const text = bytes.toString("latin1");
  return {
    count: (text.match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length,
    mediaBoxes: [
      ...text.matchAll(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/g),
    ].map((m) => [Number(m[1]), Number(m[2])]),
  };
};

export async function exportPdf(
  input: string,
  itineraryFile: string,
  options: CommonOptions & { reducedMotion: boolean },
  report: Report,
) {
  const target = await prepareOutput(options.out, options.overwrite, "file");
  const capture = await prepareCapture(
    input,
    itineraryFile,
    "pdf",
    options,
    report,
  );
  const { plan, document } = capture;
  const { width, height } = document.settings.viewport;
  const { result, fonts, runtime, needed } = await withCapture(
    capture,
    "pdf",
    options.lang,
    report,
    async (session, chromium) => {
      let poseError = 0;
      // Chromium paginates 3D-transformed content incorrectly when a document
      // has several pages, so each visit prints the live player as one page and
      // the pages are joined afterwards without re-rendering (vector content kept).
      const book = await PDFDocument.create({ updateMetadata: false });
      const singles: number[] = [];
      const overflow = new Map<string, number>();
      for (const visit of plan.visits) {
        // Final, deterministic pose of each visit: its arrival, track endpoints included.
        poseError = Math.max(
          poseError,
          await renderAt(session, plan, visit.arrivalMs),
        );
        // A flow scene does not grow: what it cannot show is not on the page.
        const hidden = await session.page.evaluate((id) => {
          const content = window.document.querySelector<HTMLElement>(
            `.xc-scene[data-scene-id="${CSS.escape(id)}"] .xc-content`,
          );
          return content ? content.scrollHeight - content.clientHeight : 0;
        }, visit.sceneId);
        if (hidden > 1) overflow.set(visit.sceneId, hidden);
        const single = await session.page.pdf({
          width: `${width}px`,
          height: `${height}px`,
          printBackground: true,
          preferCSSPageSize: true,
          margin: { top: "0", right: "0", bottom: "0", left: "0" },
        });
        const source = await PDFDocument.load(single, {
          updateMetadata: false,
        });
        singles.push(source.getPageCount());
        for (const page of await book.copyPages(
          source,
          source.getPageIndices(),
        ))
          book.addPage(page);
      }
      book.setTitle(document.metadata.title || "XCursus");
      book.setCreator(`XCursus CLI ${toolVersion}`);
      book.setProducer("Chromium (Skia/PDF) pages joined with pdf-lib");
      const pdf = Buffer.from(await book.save({ useObjectStreams: false }));
      return {
        pdf,
        poseError,
        singles,
        overflow,
        chromium: chromium.version,
        playwright: chromium.playwright,
      };
    },
  );
  for (const [sceneId, hidden] of result.overflow) {
    const warning: Diagnostic = {
      ...diagnostic(
        "CONTENT_OVERFLOW",
        `The content of scene ${sceneId} exceeds the scene by ${hidden} px; the page shows only what fits`,
        `/scenes/${document.scenes.findIndex((s) => s.id === sceneId)}`,
      ),
      severity: "warning",
    };
    capture.analysis.warnings.push(warning);
    report.warn(
      `warning ${warning.code} ${warning.pointer} ${warning.message}`,
    );
  }
  const pages = pdfPages(result.pdf);
  const expectedBox = [width * 0.75, height * 0.75];
  const verification = {
    singlePagePrints: result.singles.every((n) => n === 1),
    pageCount: pages.count,
    expectedPages: plan.visits.length,
    pageSizePt: pages.mediaBoxes[0] ?? null,
    allPagesViewportSize:
      pages.mediaBoxes.length === pages.count &&
      pages.mediaBoxes.every(
        ([w, h]) =>
          Math.abs(w! - expectedBox[0]!) < 0.5 &&
          Math.abs(h! - expectedBox[1]!) < 0.5,
      ),
    maxPoseMatrixRelativeError: result.poseError,
  };
  if (
    !verification.singlePagePrints ||
    pages.count !== plan.visits.length ||
    !verification.allPagesViewportSize ||
    !(result.poseError < POSE_TOLERANCE)
  )
    throw new CliError(
      EXIT.output,
      `PDF self-check failed: ${JSON.stringify(verification)}`,
    );
  const manifest = captureManifest(
    await licensesOf(runtime.notices, fontsUsed(document)),
    "pdf",
    capture,
    fonts,
    runtime,
    needed,
    {
      chromium: result.chromium,
      playwright: result.playwright,
      viewport: { width, height },
      deviceScaleFactor: 1,
    },
    verification,
    target.path,
    result.pdf,
  );
  await writeAtomic(target.path, result.pdf);
  await writeAtomic(target.manifest, JSON.stringify(manifest, null, 2) + "\n");
  report.log(`pdf ${target.path} (${pages.count} pages, ${manifest.status})`);
  return manifest;
}

function captureManifest(
  licenses: ExportManifest["licenses"],
  format: "pdf" | "video",
  capture: CaptureInput,
  fonts: EmbeddedFont[],
  runtime: { script: string; notices: string },
  needed: Set<string>,
  env: Record<string, unknown>,
  verification: Record<string, unknown>,
  file: string,
  bytes: Uint8Array,
): ExportManifest {
  const { project, analysis, plan, document } = capture;
  const used = fontsUsed(document);
  return {
    format,
    status: analysis.blocking.length ? "partial" : "complete",
    toolVersion,
    schemaVersion: document.schemaVersion,
    source: {
      kind: project.kind,
      file: basename(project.source),
      sourceSchemaVersion: project.sourceSchemaVersion,
      documentId: document.id,
    },
    itinerary: {
      pathId: plan.pathId,
      // The validated itinerary, with the unique edges filled in.
      visits: plan.visits.map((v) =>
        v.transition
          ? { nodeId: v.nodeId, edgeIdToNext: v.transition.edgeId }
          : { nodeId: v.nodeId },
      ),
      totalMs: plan.totalMs,
      reducedMotion: plan.reducedMotion,
    },
    profile: profiles[format],
    privateNotes: "excluded",
    resources: [
      ...resourceEntries(project, analysis, "embedded", format).map((r) =>
        r.status === "embedded" && !needed.has(r.id)
          ? { ...r, status: "excluded" as const }
          : r,
      ),
      ...fontResources(fonts, "embedded"),
      {
        id: "xcursus-runtime.js",
        kind: "runtime",
        sha256: sha(runtime.script),
        status: "embedded",
      },
    ],
    // A PDF embeds subsets of the fonts it uses; a video only their pixels.
    licenses:
      format === "pdf"
        ? licenses.filter(
            (p) =>
              (p.name === "katex" && used.katex) ||
              (p.name === "@fontsource/atkinson-hyperlegible" && used.theme),
          )
        : [],
    warnings: manifestWarnings(analysis),
    unsupported: analysis.unsupported,
    environment: environment(env),
    verification,
    output: {
      file: basename(file),
      byteLength: bytes.length,
      sha256: sha(bytes),
    },
  };
}

export async function exportVideo(
  input: string,
  itineraryFile: string,
  options: CommonOptions & {
    reducedMotion: boolean;
    fps: number;
    framesDir?: string;
  },
  report: Report,
) {
  const target = await prepareOutput(options.out, options.overwrite, "file");
  if (options.framesDir) {
    const entries = await readdir(options.framesDir).catch(() => null);
    if (!entries || entries.length)
      throw new CliError(
        EXIT.output,
        `--frames needs an existing empty directory: ${options.framesDir}`,
      );
  }
  const capture = await prepareCapture(
    input,
    itineraryFile,
    "video",
    options,
    report,
  );
  const { plan, document } = capture;
  const schedule = frameSchedule(plan, options.fps);
  if (!schedule.ok)
    throw new CliError(EXIT.data, "Invalid video timing", schedule.diagnostics);
  const s: FrameSchedule = schedule.value;
  if (!s.finalHoldVisible)
    report.warn(
      "warning FINAL_HOLD_SHORT the last arrival pose is not a frame: give the last visit holdMs of at least one frame to show it",
    );
  // Fails with exit 2 before any capture when FFmpeg is missing.
  const encoder = await findEncoder();
  const { width, height } = document.settings.viewport;
  const temporary = join(
    target.path,
    "..",
    `.${basename(target.path)}.tmp-${process.pid}-${Date.now()}.webm`,
  );
  const { result, fonts, runtime, needed } = await withCapture(
    capture,
    "video",
    options.lang,
    report,
    async (session, chromium, dir) => {
      let poseError = 0;
      const samples = [];
      const marks = new Set([
        0,
        Math.floor(s.frameCount / 2),
        s.frameCount - 1,
      ]);
      for (const visit of plan.visits)
        marks.add(
          Math.min(
            s.frameCount - 1,
            Math.ceil((visit.arrivalMs * s.fps) / 1000),
          ),
        );
      const hashes: string[] = [];
      for (let i = 0; i < s.frameCount; i++) {
        const t = frameTime(s, i);
        poseError = Math.max(poseError, await renderAt(session, plan, t));
        const png = await session.page.screenshot({
          type: "png",
          clip: { x: 0, y: 0, width, height },
          animations: "allow",
          caret: "hide",
          scale: "css",
        });
        await writeFile(
          join(dir, `frame-${String(i).padStart(6, "0")}.png`),
          png,
        );
        hashes.push(sha(png));
        if (marks.has(i)) {
          const sample = sampleCapture(plan, t);
          samples.push({
            index: i,
            t,
            visitIndex: sample.visitIndex,
            nodeId: sample.nodeId,
            phase: sample.phase,
            progress: sample.progress,
            camera: sample.camera,
          });
        }
      }
      if (options.framesDir)
        for (let i = 0; i < s.frameCount; i++) {
          const name = `frame-${String(i).padStart(6, "0")}.png`;
          await copyFile(join(dir, name), join(options.framesDir, name));
        }
      try {
        await runTool(encoder.ffmpeg.path, [
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostdin",
          "-framerate",
          String(s.fps),
          "-start_number",
          "0",
          "-i",
          join(dir, "frame-%06d.png"),
          ...encoder.args,
          "-f",
          "webm",
          temporary,
        ]);
        const probe = JSON.parse(
          (
            await runTool(encoder.ffprobe.path, [
              "-v",
              "error",
              "-count_frames",
              "-select_streams",
              "v:0",
              "-show_entries",
              "stream=codec_name,width,height,nb_read_frames,avg_frame_rate:format=duration",
              "-of",
              "json",
              temporary,
            ])
          ).stdout,
        ) as {
          streams: Array<{
            codec_name: string;
            width: number;
            height: number;
            nb_read_frames: string;
            avg_frame_rate: string;
          }>;
          format: { duration: string };
        };
        return {
          probe,
          poseError,
          samples,
          hashes,
          chromium: chromium.version,
          playwright: chromium.playwright,
        };
      } catch (error) {
        await rm(temporary, { force: true });
        throw error;
      }
    },
  );
  const stream = result.probe.streams[0];
  const durationMs = Number(result.probe.format.duration) * 1000;
  const verification = {
    ffprobe: {
      codec: stream?.codec_name,
      width: stream?.width,
      height: stream?.height,
      frames: Number(stream?.nb_read_frames),
      durationMs,
      averageFrameRate: stream?.avg_frame_rate,
    },
    frameCountMatches: Number(stream?.nb_read_frames) === s.frameCount,
    durationWithinOneFrame: Math.abs(durationMs - s.encodedMs) <= s.frameMs,
    sizeMatches: stream?.width === width && stream?.height === height,
    maxPoseMatrixRelativeError: result.poseError,
  };
  if (
    !verification.frameCountMatches ||
    !verification.durationWithinOneFrame ||
    !verification.sizeMatches ||
    !(result.poseError < POSE_TOLERANCE)
  ) {
    await rm(temporary, { force: true });
    throw new CliError(
      EXIT.output,
      `Video self-check failed: ${JSON.stringify(verification)}`,
    );
  }
  const bytes = await readFile(temporary);
  const manifest = captureManifest(
    [],
    "video",
    capture,
    fonts,
    runtime,
    needed,
    {
      chromium: result.chromium,
      playwright: result.playwright,
      viewport: { width, height },
      deviceScaleFactor: 1,
      ffmpeg: encoder.ffmpeg.version,
      ffprobe: encoder.ffprobe.version,
      encoder: encoder.encoder,
      codec: encoder.codec,
      codecLicense: encoder.license,
      encoderArgs: encoder.args,
    },
    verification,
    target.path,
    bytes,
  );
  manifest.environment.frames = {
    fps: s.fps,
    frameCount: s.frameCount,
    frameMs: s.frameMs,
    planMs: s.planMs,
    encodedMs: s.encodedMs,
    lastFrameMs: s.lastFrameMs,
    finalHoldVisible: s.finalHoldVisible,
    quantization:
      "frames i = 0..N-1 at t = i * 1000 / fps, N = ceil(planMs * fps / 1000); the exact end instant is not a frame",
    framesSha256: sha(result.hashes.join("\n")),
    samples: result.samples,
  };
  if (!s.finalHoldVisible)
    manifest.warnings.push({
      code: "FINAL_HOLD_SHORT",
      severity: "warning",
      pointer: "",
      message:
        "The last arrival pose is not a frame; give the last visit holdMs of at least one frame",
    });
  try {
    await rename(temporary, target.path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw new CliError(
      EXIT.output,
      `Cannot write ${target.path}: ${String(error)}`,
    );
  }
  await writeAtomic(target.manifest, JSON.stringify(manifest, null, 2) + "\n");
  report.log(
    `video ${target.path} (${s.frameCount} frames, ${durationMs} ms, ${encoder.codec})`,
  );
  return manifest;
}
