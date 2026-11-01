import {
  Unzip,
  UnzipInflate,
  Zip,
  ZipDeflate,
  ZipPassThrough,
  strToU8,
} from "fflate";
import {
  normalizedPath,
  serializeDocument,
  validateDocument,
} from "@xcursus/core";
import type { ProjectDocument } from "@xcursus/core";
import { FILE_LIMIT, TOTAL_LIMIT, sha256, verifyAsset } from "@xcursus/player";
import type { AssetBlobs } from "@xcursus/player";
export const JSON_LIMIT = 10 * 1024 * 1024;
/** Largest .xcursus accepted before decompression: all resources plus project and manifest JSON. */
export const ARCHIVE_LIMIT = TOTAL_LIMIT + JSON_LIMIT * 2;
const ENTRY_LIMIT = 10000;
/** Extension of the native archive; every archive written by XCursus uses it. */
export const ARCHIVE_EXTENSION = ".xcursus";
/**
 * Extension of the archives written before the rename (SpatialDeck 0.4–0.6).
 * Read only: the ZIP container and manifest 1.0.0 are identical, so a legacy
 * archive is imported as it is and saved again as `.xcursus`.
 */
export const LEGACY_ARCHIVE_EXTENSION = ".spatialdeck";
/** `current` for `.xcursus`, `legacy` for `.spatialdeck`. */
export type ArchiveFormat = "current" | "legacy";
/** Archive format named by a file name (case-insensitive), or null for JSON and anything else. */
export function archiveFormat(name: string): ArchiveFormat | null {
  const lower = name.toLowerCase();
  if (lower.endsWith(ARCHIVE_EXTENSION)) return "current";
  if (lower.endsWith(LEGACY_ARCHIVE_EXTENSION)) return "legacy";
  return null;
}
/** File-input `accept` list for projects: JSON, native and legacy archives. */
export const PROJECT_ACCEPT = `.json,${ARCHIVE_EXTENSION},${LEGACY_ARCHIVE_EXTENSION},application/json,application/zip`;
export interface ArchiveProject {
  /** Validated copy migrated to the current schema. */
  document: ProjectDocument;
  blobs: Map<string, Blob>;
  /** `schemaVersion` declared by the archived project.json, before migration. */
  sourceSchemaVersion: string;
}
interface Entry {
  name: string;
  size: number;
  compressed: number;
  offset: number;
  method: number;
  flags: number;
  crc: number;
}
const crcTable = Array.from({ length: 256 }, (_, i) => {
  let c = i;
  for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
/** Incremental CRC-32: feed chunks, then finish with `^ 0xffffffff`. */
function crcUpdate(c: number, bytes: Uint8Array) {
  for (const b of bytes) c = crcTable[(c ^ b) & 255]! ^ (c >>> 8);
  return c;
}
/** Inspect central AND local headers before allocating decompressed output. ZIP64/multidisk/encrypted archives are deliberately unsupported. */
function inventory(bytes: Uint8Array): Entry[] {
  if (bytes.length > ARCHIVE_LIMIT) throw new Error("Archive too large.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (p: number) => view.getUint16(p, true),
    u32 = (p: number) => view.getUint32(p, true);
  let end = bytes.length - 22;
  while (
    end >= Math.max(0, bytes.length - 65557) &&
    (u32(end) !== 0x06054b50 || end + 22 + u16(end + 20) !== bytes.length)
  )
    end--;
  if (end < 0 || u32(end) !== 0x06054b50)
    throw new Error("ZIP central directory missing.");
  const count = u16(end + 10),
    start = u32(end + 16),
    length = u32(end + 12);
  if (
    u16(end + 4) ||
    u16(end + 6) ||
    u16(end + 8) !== count ||
    count > ENTRY_LIMIT ||
    start + length !== end
  )
    throw new Error("Unsupported ZIP central directory.");
  const names = new Set<string>(),
    entries: Entry[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let p = start,
    total = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > end || u32(p) !== 0x02014b50)
      throw new Error("Invalid ZIP header.");
    const flags = u16(p + 8),
      method = u16(p + 10),
      compressed = u32(p + 20),
      size = u32(p + 24),
      n = u16(p + 28),
      extra = u16(p + 30),
      comment = u16(p + 32),
      offset = u32(p + 42);
    if (
      p + 46 + n + extra + comment > end ||
      flags & ~0x0808 ||
      ![0, 8].includes(method) ||
      u16(p + 34) ||
      ((u32(p + 38) >>> 16) & 0xf000) === 0xa000
    )
      throw new Error("Unsupported ZIP entry (link, encryption or method).");
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + n));
    if (
      !name ||
      name.length > 512 ||
      normalizedPath(name) !== name ||
      name.includes("%") ||
      names.has(name)
    )
      throw new Error("Unsafe or duplicate ZIP path.");
    names.add(name);
    const json = name === "project.json" || name === "manifest.json";
    if (
      size > (json ? JSON_LIMIT : FILE_LIMIT) ||
      (total += size) > TOTAL_LIMIT
    )
      throw new Error("Decompressed ZIP limit exceeded.");
    if (
      offset + 30 > start ||
      u32(offset) !== 0x04034b50 ||
      u16(offset + 6) !== flags ||
      u16(offset + 8) !== method
    )
      throw new Error("Inconsistent local header.");
    const ln = u16(offset + 26),
      le = u16(offset + 28);
    if (
      offset + 30 + ln + le + compressed > start ||
      decoder.decode(bytes.subarray(offset + 30, offset + 30 + ln)) !== name
    )
      throw new Error("Inconsistent path or local header.");
    if (
      !(flags & 8) &&
      (u32(offset + 18) !== compressed ||
        u32(offset + 22) !== size ||
        u32(offset + 14) !== u32(p + 16))
    )
      throw new Error("Inconsistent ZIP sizes or header.");
    entries.push({
      name,
      size,
      compressed,
      offset,
      method,
      flags,
      crc: u32(p + 16),
    });
    p += 46 + n + extra + comment;
  }
  if (p !== end) throw new Error("Entry ZIP extra.");
  let cursor = 0;
  for (const entry of [...entries].sort((a, b) => a.offset - b.offset)) {
    if (entry.offset !== cursor)
      throw new Error("Overlapping or hidden ZIP entries.");
    cursor =
      entry.offset +
      30 +
      u16(entry.offset + 26) +
      u16(entry.offset + 28) +
      entry.compressed;
    if (entry.flags & 8) {
      if (u32(cursor) === 0x08074b50) cursor += 4;
      if (
        u32(cursor) !== entry.crc ||
        u32(cursor + 4) !== entry.compressed ||
        u32(cursor + 8) !== entry.size
      )
        throw new Error("Inconsistent ZIP data descriptor.");
      cursor += 12;
    }
  }
  if (cursor !== start) throw new Error("Unindexed ZIP data.");
  return entries;
}
export async function readArchive(blob: Blob): Promise<ArchiveProject> {
  if (blob.size > ARCHIVE_LIMIT) throw new Error("Archive too large.");
  const bytes = new Uint8Array(await blob.arrayBuffer()),
    entries = inventory(bytes),
    // Inflated chunks are kept as they come: Blobs are built from them without
    // concatenating a second copy of every resource.
    files = new Map<string, Uint8Array[]>();
  let total = 0,
    failure: Error | undefined;
  const unzip = new Unzip((file) => {
    const entry = entries.find((e) => e.name === file.name);
    if (!entry || files.has(file.name)) throw new Error("Unindexed entry.");
    const chunks: Uint8Array[] = [];
    let size = 0,
      crc = 0xffffffff;
    file.ondata = (error, chunk, final) => {
      if (failure) return;
      if (
        error ||
        (size += chunk.length) > entry.size ||
        (total += chunk.length) > TOTAL_LIMIT
      ) {
        failure = error ?? new Error("Limit exceeded after inflate.");
        file.terminate();
        return;
      }
      chunks.push(chunk);
      crc = crcUpdate(crc, chunk);
      if (final) {
        if (size !== entry.size) {
          failure = new Error("Inconsistent decompressed size.");
          return;
        }
        if ((crc ^ 0xffffffff) >>> 0 !== entry.crc) {
          failure = new Error("Wrong ZIP CRC.");
          return;
        }
        files.set(file.name, chunks);
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  // Bound the output of an individual synchronous inflate step as well as the total.
  for (let i = 0; i < bytes.length; i += 4096) {
    unzip.push(bytes.subarray(i, i + 4096), i + 4096 >= bytes.length);
    if (failure) throw failure;
  }
  if (files.size !== entries.length) throw new Error("Incomplete archive.");
  const decode = (name: string) => {
    const parts = files.get(name);
    if (!parts) throw new Error(`Missing ${name}`);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    return (
      parts.map((p) => decoder.decode(p, { stream: true })).join("") +
      decoder.decode()
    );
  };
  const projectText = decode("project.json");
  const valid = validateDocument(projectText);
  if (!valid.ok)
    throw new Error(valid.diagnostics.map((d) => d.message).join("; "));
  const manifest: unknown = JSON.parse(decode("manifest.json"));
  if (
    !manifest ||
    typeof manifest !== "object" ||
    !("version" in manifest) ||
    manifest.version !== "1.0.0" ||
    !("assets" in manifest) ||
    !Array.isArray(manifest.assets) ||
    manifest.assets.length !== valid.value.assets.length
  )
    throw new Error("Invalid manifest.");
  const blobs = new Map<string, Blob>(),
    seen = new Set<string>();
  for (const item of manifest.assets as unknown[]) {
    if (!item || typeof item !== "object" || Array.isArray(item))
      throw new Error("Invalid manifest asset.");
    const m = item as Record<string, unknown>,
      a = valid.value.assets.find((a) => a.id === m.id);
    if (
      !a ||
      seen.has(a.id) ||
      m.path !== a.path ||
      typeof m.entry !== "string" ||
      !m.entry.startsWith(`assets/${a.id}/`) ||
      m.mime !== a.mime ||
      m.byteLength !== a.byteLength ||
      typeof m.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(m.sha256)
    )
      throw new Error("Inconsistent manifest asset.");
    const data = files.get(m.entry);
    if (!data) throw new Error(`Missing resource: ${a.path}`);
    const assetBlob = new Blob(data as Uint8Array<ArrayBuffer>[], {
      type: a.mime,
    });
    await verifyAsset(a, assetBlob);
    if ((await sha256(assetBlob)) !== m.sha256)
      throw new Error("Wrong manifest digest.");
    blobs.set(a.id, assetBlob);
    seen.add(a.id);
  }
  if (files.size !== blobs.size + 2)
    throw new Error("Extra files not declared in the manifest.");
  // Valid JSON at this point: validateDocument parsed the same text.
  const declared = (JSON.parse(projectText) as { schemaVersion: string })
    .schemaVersion;
  return { document: valid.value, blobs, sourceSchemaVersion: declared };
}
/** Already compressed formats are stored, not deflated again. */
const STORED = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "audio/mpeg",
  "audio/ogg",
  "audio/webm",
  "video/mp4",
  "video/webm",
  "font/woff2",
  "application/zip",
]);
const WRITE_CHUNK = 1024 * 1024;
/** Lets rendering and input run between chunks of archive work. */
const yieldToEventLoop = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 0));
export async function writeArchive(
  document: ProjectDocument,
  blobs: AssetBlobs,
): Promise<Blob> {
  const valid = serializeDocument(document);
  if (!valid.ok) throw new Error("Invalid document.");
  const manifest = {
    version: "1.0.0",
    assets: [] as Array<{
      id: string;
      path: string;
      entry: string;
      mime: string;
      byteLength: number;
      sha256: string;
    }>,
  };
  const sources: Array<{ entry: string; blob: Blob; mime: string }> = [];
  let total = 0;
  for (const a of document.assets) {
    const blob = blobs.get(a.id);
    if (!blob)
      throw new Error(
        `Missing resource: ${a.id}. Link the file before saving the archive.`,
      );
    const name =
      a.path
        .split("/")
        .at(-1)!
        .normalize("NFC")
        .replace(/[^A-Za-z0-9._-]/g, "_") || "asset";
    const entry = `assets/${a.id}/${name}`;
    await verifyAsset(a, blob);
    manifest.assets.push({ ...a, entry, sha256: await sha256(blob) });
    sources.push({ entry, blob, mime: a.mime });
    total += blob.size;
  }
  const project = strToU8(valid.value),
    index = strToU8(JSON.stringify(manifest));
  if (total + project.length + index.length > TOTAL_LIMIT)
    throw new Error("Total decompressed archive limit exceeded.");
  // Streaming ZIP, one chunk at a time with a yield in between: the main
  // thread stays responsive and compressed media are stored as they are.
  const output: Uint8Array[] = [];
  let failure: Error | null = null;
  const zip = new Zip((error, data) => {
    if (error) failure = error;
    else output.push(data);
  });
  const add = async (
    name: string,
    read: (at: number) => Promise<Uint8Array>,
    size: number,
    store: boolean,
  ) => {
    const file = store
      ? new ZipPassThrough(name)
      : new ZipDeflate(name, { level: 6 });
    zip.add(file);
    if (size === 0) file.push(new Uint8Array(0), true);
    for (let at = 0; at < size; at += WRITE_CHUNK) {
      file.push(await read(at), at + WRITE_CHUNK >= size);
      await yieldToEventLoop();
      if (failure) throw failure;
    }
  };
  const slice = (bytes: Uint8Array) => async (at: number) =>
    bytes.subarray(at, at + WRITE_CHUNK);
  await add("project.json", slice(project), project.length, false);
  for (const { entry, blob, mime } of sources)
    await add(
      entry,
      async (at) =>
        new Uint8Array(await blob.slice(at, at + WRITE_CHUNK).arrayBuffer()),
      blob.size,
      STORED.has(mime),
    );
  await add("manifest.json", slice(index), index.length, false);
  zip.end();
  if (failure) throw failure;
  return new Blob(output as Uint8Array<ArrayBuffer>[], {
    type: "application/zip",
  });
}
