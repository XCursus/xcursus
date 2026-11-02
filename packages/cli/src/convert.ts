import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rm, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { serializeDocument, validateDocument } from "@xcursus/core";
import type { Diagnostic, ProjectDocument } from "@xcursus/core";
import { importImpress } from "@xcursus/impress-compat";
import type {
  ImportCandidate,
  ImportDiagnostic,
  ImpressProfile,
} from "@xcursus/impress-compat";
import { FILE_LIMIT, TOTAL_LIMIT, sha256, verifyAsset } from "@xcursus/player";
import { archiveFormat, writeArchive } from "@xcursus/plugins/archive";
import { toolVersion } from "./assemble.js";
import { CliError, EXIT, writeAtomic } from "./io.js";

export interface ConvertOptions {
  out: string;
  overwrite: boolean;
  profile?: ImpressProfile;
  rootId?: string;
}
interface Report {
  log(line: string): void;
  warn(line: string): void;
}
/** The sidecar written next to every converted project. */
export interface ConvertReport {
  tool: "xcursus convert impress";
  toolVersion: string;
  input: { file: string; byteLength: number; sha256: string; encoding: string };
  output: {
    file: string;
    kind: "json" | "archive";
    byteLength: number;
    sha256: string;
  };
  baseline: ImportCandidate["baseline"];
  profile: ImpressProfile;
  profileExplicit: boolean;
  rootId: string;
  summary: {
    scenes: number;
    nodes: number;
    assets: number;
    errors: number;
    warnings: number;
    infos: number;
  };
  steps: Array<{
    index: number;
    stepId: string;
    sceneId: string;
    nodeId: string | null;
    line: number | null;
  }>;
  diagnostics: ImportDiagnostic[];
  resources: ImportCandidate["resources"];
  /** Source CSS that was not converted, kept here for reference only. */
  css: string[];
  /** What the conversion never claims. */
  limits: string[];
}

const HTML_LIMIT = 10 * 1024 * 1024;
const digest = (data: Uint8Array | string) =>
  createHash("sha256").update(data).digest("hex");
const within = (root: string, path: string) => path.startsWith(root + sep);
const exists = (path: string) =>
  lstat(path).then(
    (info) => info,
    () => null,
  );

/** Reads a local file referenced by the HTML, confined to its folder like project assets. */
async function readLocal(
  root: string,
  path: string,
): Promise<Uint8Array | null> {
  const target = resolve(root, path);
  if (!within(root, target)) return null;
  const info = await exists(target);
  if (
    !info ||
    info.isSymbolicLink() ||
    !info.isFile() ||
    info.size > FILE_LIMIT
  )
    return null;
  // Symbolic links are refused anywhere below the folder.
  if ((await realpath(target)) !== target) return null;
  return new Uint8Array(await readFile(target));
}

/**
 * `xcursus convert impress`: converts an impress.js HTML file into a
 * candidate project (JSON with its assets, or a `.xcursus` archive) and a
 * sidecar report. The HTML is parsed inertly; only local files it references
 * inside its own folder are read; nothing is executed or fetched. A
 * structural error writes nothing (exit 1); outputs are never replaced
 * without `--overwrite`, and the input never.
 */
export async function convertImpress(
  input: string,
  options: ConvertOptions,
  report: Report,
): Promise<ConvertReport> {
  const format = archiveFormat(options.out);
  const kind =
    format === "current"
      ? "archive"
      : !format && options.out.toLowerCase().endsWith(".json")
        ? "json"
        : null;
  if (!kind)
    throw new CliError(
      EXIT.data,
      `--out must name a .json project or a .xcursus archive: ${options.out}`,
    );
  let source: string;
  try {
    source = await realpath(resolve(input));
    const info = await stat(source);
    if (!info.isFile()) throw new Error("not a file");
    if (info.size > HTML_LIMIT)
      throw new CliError(EXIT.data, "The HTML exceeds 10 MiB");
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(EXIT.data, `Input not found or not a file: ${input}`);
  }
  const bytes = new Uint8Array(await readFile(source));
  let html: string,
    encoding = "utf-8";
  try {
    html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    html = new TextDecoder("utf-8").decode(bytes);
    encoding = "utf-8 (invalid sequences replaced)";
  }
  const base = {
    ...(options.profile ? { profile: options.profile } : {}),
    ...(options.rootId ? { rootId: options.rootId } : {}),
  };
  // First pass finds the local files the content references; the second reads them.
  const first = importImpress(html, base);
  if (!first.ok)
    throw new CliError(
      EXIT.data,
      "The HTML cannot be imported as an impress.js presentation",
      first.diagnostics,
    );
  const root = dirname(source);
  const files = new Map<string, Uint8Array>();
  let total = 0;
  for (const r of first.value.resources) {
    if (r.status !== "missing" || !r.path || files.has(r.path)) continue;
    const data = await readLocal(root, r.path);
    if (!data || (total += data.byteLength) > TOTAL_LIMIT) continue;
    files.set(r.path, data);
  }
  const result = importImpress(html, { ...base, resources: files });
  if (!result.ok)
    throw new CliError(
      EXIT.data,
      "The HTML cannot be imported as an impress.js presentation",
      result.diagnostics,
    );
  const candidate = result.value;
  // The player's verifier checks every asset again, and the digests are recorded.
  const document: ProjectDocument = structuredClone(candidate.document);
  const blobs = new Map<string, Blob>();
  for (const asset of document.assets) {
    const data = candidate.files.get(asset.id)!;
    const blob = new Blob([data as Uint8Array<ArrayBuffer>], {
      type: asset.mime,
    });
    try {
      await verifyAsset(asset, blob);
    } catch (error) {
      throw new CliError(EXIT.data, `${asset.path}: ${String(error)}`, [
        {
          code: "ASSET_INVALID",
          severity: "error",
          pointer: `/assets/${document.assets.indexOf(asset)}`,
          message: String(error),
        },
      ]);
    }
    asset.sha256 = await sha256(blob);
    blobs.set(asset.id, blob);
  }
  const checked = validateDocument(document);
  if (!checked.ok)
    throw new CliError(
      EXIT.data,
      "The candidate does not validate",
      checked.diagnostics,
    );

  // Outputs: refuse existing files unless --overwrite; never the input.
  const out = resolve(options.out);
  const reportPath = `${out}.report.json`;
  const parent = dirname(out);
  if (
    !(await stat(parent).then(
      (s) => s.isDirectory(),
      () => false,
    ))
  )
    throw new CliError(
      EXIT.output,
      `Output directory does not exist: ${parent}`,
    );
  const targets = [out, reportPath];
  for (const target of targets) {
    if ((await realpath(target).catch(() => target)) === source)
      throw new CliError(
        EXIT.output,
        `Refusing to replace the input: ${source}`,
      );
    const info = await exists(target);
    if (!info) continue;
    if (!options.overwrite)
      throw new CliError(
        EXIT.output,
        `Output already exists: ${target}. Use --overwrite to replace it.`,
      );
    if (!info.isFile())
      throw new CliError(
        EXIT.output,
        `Output is not a regular file: ${target}`,
      );
  }
  // A JSON project needs its assets next to it, at the paths it declares.
  const assetWrites: Array<{ path: string; data: Uint8Array }> = [];
  if (kind === "json")
    for (const asset of document.assets) {
      const target = resolve(parent, asset.path);
      if (!within(parent, target))
        throw new CliError(
          EXIT.output,
          `Refusing to write outside the output: ${asset.path}`,
        );
      const data = candidate.files.get(asset.id)!;
      const info = await exists(target);
      if (info) {
        if (info.isSymbolicLink() || !info.isFile())
          throw new CliError(
            EXIT.output,
            `Asset target is not a regular file: ${target}`,
          );
        // The same bytes are already there (output next to the HTML): nothing to write.
        if (digest(new Uint8Array(await readFile(target))) === asset.sha256)
          continue;
        if (!options.overwrite)
          throw new CliError(
            EXIT.output,
            `A different file already exists at ${target}. Use --overwrite to replace it.`,
          );
      }
      assetWrites.push({ path: target, data });
    }
  let output: Uint8Array;
  if (kind === "archive") {
    try {
      output = new Uint8Array(
        await (await writeArchive(checked.value, blobs)).arrayBuffer(),
      );
    } catch (error) {
      throw new CliError(
        EXIT.output,
        `Cannot write the archive: ${String(error)}`,
      );
    }
  } else {
    const json = serializeDocument(checked.value);
    if (!json.ok)
      throw new CliError(
        EXIT.data,
        "The candidate cannot be serialized",
        json.diagnostics,
      );
    output = new TextEncoder().encode(json.value);
  }
  // Asset copies made by this run are removed again if the project cannot be written.
  const written: string[] = [];
  try {
    for (const write of assetWrites) {
      await mkdir(dirname(write.path), { recursive: true });
      await writeAtomic(write.path, write.data);
      written.push(write.path);
    }
    await writeAtomic(out, output);
  } catch (error) {
    await Promise.all(written.map((path) => rm(path, { force: true })));
    throw error;
  }
  const severities = (s: Diagnostic["severity"]) =>
    candidate.diagnostics.filter((d) => d.severity === s).length;
  const sidecar: ConvertReport = {
    tool: "xcursus convert impress",
    toolVersion,
    input: {
      file: source,
      byteLength: bytes.byteLength,
      sha256: digest(bytes),
      encoding,
    },
    output: {
      file: out,
      kind,
      byteLength: output.byteLength,
      sha256: digest(output),
    },
    baseline: candidate.baseline,
    profile: candidate.profile,
    profileExplicit: candidate.profileExplicit,
    rootId: options.rootId ?? "impress",
    summary: {
      scenes: document.scenes.length,
      nodes: document.paths[0]?.nodes.length ?? 0,
      assets: document.assets.length,
      errors: severities("error"),
      warnings: severities("warning"),
      infos: severities("info"),
    },
    steps: candidate.steps.map((s) => ({
      index: s.index,
      stepId: s.stepId,
      sceneId: s.sceneId,
      nodeId: s.nodeId ?? null,
      line: s.line ?? null,
    })),
    diagnostics: candidate.diagnostics,
    resources: candidate.resources,
    css: candidate.css,
    limits: [
      "Essential import: not full impress.js compatibility.",
      "No script, plugin or stylesheet of the source was executed or applied.",
      "Visual and timing fidelity are not guaranteed; geometry follows the impress.js 2.0.0 transform rules.",
      "Review the candidate in Studio before using it.",
    ],
  };
  await writeAtomic(reportPath, `${JSON.stringify(sidecar, null, 2)}\n`);
  const counts = new Map<string, number>();
  for (const d of candidate.diagnostics)
    if (d.severity !== "info")
      counts.set(
        `${d.severity} ${d.code}`,
        (counts.get(`${d.severity} ${d.code}`) ?? 0) + 1,
      );
  for (const [key, n] of [...counts].sort())
    report.warn(n > 1 ? `${key} ×${n}` : key);
  report.log(
    `candidate ${out} (${sidecar.summary.scenes} scenes, ${sidecar.summary.nodes} on the path, ${sidecar.summary.assets} assets; ${sidecar.summary.warnings} warnings, ${sidecar.summary.infos} notes; profile ${candidate.profile}${candidate.profileExplicit ? "" : ", assumed"})`,
  );
  report.log(
    `report ${reportPath}: review it, then open the candidate in Studio`,
  );
  return sidecar;
}
