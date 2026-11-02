import { randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { diagnostic, normalizedPath, validateDocument } from "@xcursus/core";
import type { Diagnostic, ProjectDocument } from "@xcursus/core";
import {
  AssetError,
  FILE_LIMIT,
  TOTAL_LIMIT,
  sha256,
  verifyAsset,
} from "@xcursus/player";
import {
  ARCHIVE_LIMIT,
  JSON_LIMIT,
  archiveFormat,
  readArchive,
} from "@xcursus/plugins/archive";
import type { ArchiveFormat } from "@xcursus/plugins/archive";
import type { LoadedResource, ResourceStatus } from "./profile.js";
export type { LoadedResource, ResourceStatus } from "./profile.js";

/** Exit codes of the contract: 0 success (warnings allowed), 1 data, 2 environment, 3 write/export. */
export const EXIT = { ok: 0, data: 1, environment: 2, output: 3 } as const;
export class CliError extends Error {
  constructor(
    readonly exitCode: (typeof EXIT)[keyof typeof EXIT],
    message: string,
    readonly diagnostics: Diagnostic[] = [],
  ) {
    super(message);
  }
}

export interface LoadedProject {
  kind: "json" | "archive";
  /** `current` for `.xcursus`, `legacy` for a `.spatialdeck` archive; absent for JSON. */
  archiveFormat?: ArchiveFormat;
  /** Real path of the project file or archive. */
  source: string;
  sourceSchemaVersion: string;
  document: ProjectDocument;
  /** Verified bytes only; missing or invalid resources are absent. */
  blobs: Map<string, Blob>;
  resources: LoadedResource[];
}

const within = (root: string, path: string) => path.startsWith(root + sep);

/**
 * Reads a project JSON with its asset root (the file's directory), a
 * .xcursus archive or a legacy .spatialdeck archive (same container, read
 * only; the source file is never modified). Asset paths are confined to the root: traversal,
 * absolute and encoded paths and symbolic links are rejected; bytes are
 * checked against the declared size, MIME signature and digest.
 */
export async function loadProject(input: string): Promise<LoadedProject> {
  let source: string;
  try {
    source = await realpath(resolve(input));
    if (!(await stat(source)).isFile()) throw new Error("not a file");
  } catch {
    throw new CliError(EXIT.data, `Project not found or not a file: ${input}`);
  }
  const format = archiveFormat(source);
  if (format) {
    const size = (await stat(source)).size;
    if (size > ARCHIVE_LIMIT)
      throw new CliError(EXIT.data, "Archive exceeds the size limit");
    let archive;
    try {
      archive = await readArchive(new Blob([await readFile(source)]));
    } catch (error) {
      throw new CliError(EXIT.data, `Invalid archive: ${String(error)}`, [
        diagnostic("ARCHIVE_INVALID", String(error)),
      ]);
    }
    const resources: LoadedResource[] = [];
    for (const asset of archive.document.assets)
      resources.push({
        id: asset.id,
        path: asset.path,
        mime: asset.mime,
        byteLength: asset.byteLength,
        sha256: await sha256(archive.blobs.get(asset.id)!),
        status: "verified",
      });
    return {
      kind: "archive",
      archiveFormat: format,
      source,
      // The document is the migrated copy; this is the version the archive declared.
      sourceSchemaVersion: archive.sourceSchemaVersion,
      document: archive.document,
      blobs: archive.blobs,
      resources,
    };
  }
  if ((await stat(source)).size > JSON_LIMIT)
    throw new CliError(EXIT.data, "Project JSON exceeds 10 MiB");
  const text = await readFile(source, "utf8");
  let sourceSchemaVersion = "unknown";
  try {
    const raw: unknown = JSON.parse(text);
    if (raw && typeof raw === "object" && "schemaVersion" in raw)
      sourceSchemaVersion = String(raw.schemaVersion);
  } catch {
    /* validateDocument reports the syntax error below. */
  }
  const valid = validateDocument(text);
  if (!valid.ok)
    throw new CliError(
      EXIT.data,
      "The project is not a valid XCursus document",
      valid.diagnostics,
    );
  const document = valid.value;
  const root = dirname(source);
  const blobs = new Map<string, Blob>(),
    resources: LoadedResource[] = [];
  let total = 0;
  for (const [index, asset] of document.assets.entries()) {
    const pointer = `/assets/${index}/path`;
    const base = {
      id: asset.id,
      path: asset.path,
      mime: asset.mime,
      byteLength: asset.byteLength,
      sha256: asset.sha256 ?? null,
    };
    const fail = (status: ResourceStatus, code: string, message: string) =>
      resources.push({
        ...base,
        status,
        diagnostic: diagnostic(code, message, pointer),
      });
    const relative = normalizedPath(asset.path);
    const target = relative ? resolve(root, relative) : null;
    if (!relative || !target || !within(root, target)) {
      fail(
        "invalid",
        "ASSET_PATH",
        `Asset path leaves the project root: ${asset.path}`,
      );
      continue;
    }
    let info;
    try {
      info = await lstat(target);
    } catch {
      fail("missing", "ASSET_MISSING", `Asset file not found: ${asset.path}`);
      continue;
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      fail(
        "invalid",
        "ASSET_PATH",
        `Asset is not a regular file: ${asset.path}`,
      );
      continue;
    }
    // Symbolic links are refused anywhere below the root, like in archives.
    if ((await realpath(target)) !== target) {
      fail(
        "invalid",
        "ASSET_PATH",
        `Asset path goes through a symbolic link: ${asset.path}`,
      );
      continue;
    }
    if (info.size > FILE_LIMIT || (total += info.size) > TOTAL_LIMIT) {
      fail(
        "invalid",
        "ASSET_LIMIT",
        `Asset exceeds the size limits: ${asset.path}`,
      );
      continue;
    }
    const blob = new Blob([await readFile(target)], { type: asset.mime });
    try {
      await verifyAsset(asset, blob);
    } catch (error) {
      fail(
        "invalid",
        error instanceof AssetError
          ? `ASSET_${error.code.toUpperCase()}`
          : "ASSET_INVALID",
        `${asset.path}: ${String(error)}`,
      );
      continue;
    }
    blobs.set(asset.id, blob);
    resources.push({ ...base, sha256: await sha256(blob), status: "verified" });
  }
  return {
    kind: "json",
    source,
    sourceSchemaVersion,
    document,
    blobs,
    resources,
  };
}

/** Reads an itinerary file (the content is validated by core against the document). */
export async function readItinerary(path: string): Promise<string> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > 1024 * 1024) throw new Error("size");
    return await readFile(path, "utf8");
  } catch {
    throw new CliError(EXIT.data, `Itinerary not found or too large: ${path}`);
  }
}

export interface OutputTarget {
  path: string;
  /** Sidecar manifest for file outputs. */
  manifest: string;
}
/**
 * Refuses an existing output unless `overwrite`; the parent directory must
 * exist. A directory is replaced only when it holds a previous export
 * manifest, so `--overwrite` never deletes a directory this tool did not make.
 */
export async function prepareOutput(
  out: string,
  overwrite: boolean,
  kind: "file" | "directory",
): Promise<OutputTarget> {
  const path = resolve(out);
  const manifest =
    kind === "file" ? `${path}.manifest.json` : join(path, MANIFEST_NAME);
  try {
    if (!(await stat(dirname(path))).isDirectory()) throw new Error();
  } catch {
    throw new CliError(
      EXIT.output,
      `Output directory does not exist: ${dirname(path)}`,
    );
  }
  for (const target of kind === "file" ? [path, manifest] : [path]) {
    const exists = await lstat(target).then(
      () => true,
      () => false,
    );
    if (!exists) continue;
    if (!overwrite)
      throw new CliError(
        EXIT.output,
        `Output already exists: ${target}. Use --overwrite to replace it.`,
      );
    const info = await lstat(target);
    if (kind === "file" && !info.isFile())
      throw new CliError(
        EXIT.output,
        `Output is not a regular file: ${target}`,
      );
    if (
      kind === "directory" &&
      (!info.isDirectory() ||
        !(await stat(join(target, MANIFEST_NAME)).then(
          (s) => s.isFile(),
          () => false,
        )))
    )
      throw new CliError(
        EXIT.output,
        `Refusing to replace ${target}: it is not a previous XCursus build (no ${MANIFEST_NAME}).`,
      );
  }
  return { path, manifest };
}
export const MANIFEST_NAME = "export-manifest.json";

const temporaryName = (path: string, tag: string) =>
  join(
    dirname(path),
    `.${basename(path)}.${tag}-${randomBytes(6).toString("hex")}`,
  );

/** Writes a file through a temporary sibling and an atomic rename; the temporary file is removed on failure. */
export async function writeAtomic(
  path: string,
  data: string | Uint8Array,
): Promise<void> {
  const temp = temporaryName(path, "tmp");
  try {
    const handle = await open(temp, "wx");
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw new CliError(EXIT.output, `Cannot write ${path}: ${String(error)}`);
  }
}

/** Builds a directory beside the target and swaps it in only once complete. */
export async function writeDirectoryAtomic(
  path: string,
  fill: (directory: string) => Promise<void>,
): Promise<void> {
  const temp = temporaryName(path, "tmp");
  let old: string | undefined;
  try {
    await mkdir(temp);
    await fill(temp);
    if (
      await stat(path).then(
        () => true,
        () => false,
      )
    ) {
      old = temporaryName(path, "old");
      await rename(path, old);
    }
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { recursive: true, force: true });
    if (old) await rename(old, path).catch(() => undefined);
    throw error instanceof CliError
      ? error
      : new CliError(EXIT.output, `Cannot write ${path}: ${String(error)}`);
  }
  // The replaced directory carried our manifest (checked in prepareOutput).
  if (old) await rm(old, { recursive: true, force: true });
}

/** A path inside an owned output directory; refuses names that would leave it. */
export function inside(directory: string, relative: string): string {
  const target = resolve(directory, relative);
  if (!within(directory, target))
    throw new CliError(
      EXIT.output,
      `Refusing to write outside the output: ${relative}`,
    );
  return target;
}
export { writeFile };
