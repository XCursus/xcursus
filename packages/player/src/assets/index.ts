import type { Asset } from "@xcursus/core";
import { Sha256 } from "./sha256.js";
export interface AssetLease {
  url: string;
  mime: string;
  blob?: Blob;
  release(): void;
}
export interface AssetResolver {
  resolve(assetId: string, signal?: AbortSignal): Promise<AssetLease>;
  /**
   * Optional identity of the resource currently behind `assetId`. When it
   * changes, an incremental update resolves the asset again even if its
   * record in the document is unchanged (for example a newly associated file).
   */
  revision?(assetId: string): string | undefined;
}
export type AssetBlobs = ReadonlyMap<string, Blob>;
export const FILE_LIMIT = 50 * 1024 * 1024;
export const TOTAL_LIMIT = 200 * 1024 * 1024;
export type AssetErrorCode =
  "missing" | "size" | "signature" | "digest" | "aborted";
/** Typed failure, so renderers can show replaceable messages. */
export class AssetError extends Error {
  constructor(
    readonly code: AssetErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AssetError";
  }
}
const CHUNK = 1024 * 1024;
const chunk = async (blob: Blob, at: number) =>
  new Uint8Array(await blob.slice(at, at + CHUNK).arrayBuffer());
const digests = new WeakMap<Blob, Promise<string>>();
/**
 * SHA-256 hex digest, computed once per Blob (Blobs are immutable). Uses
 * `crypto.subtle` when present; outside secure contexts, a local FIPS 180-4
 * implementation hashes the Blob in chunks.
 */
export function sha256(blob: Blob): Promise<string> {
  let pending = digests.get(blob);
  if (!pending) {
    pending = digest(blob);
    digests.set(blob, pending);
    pending.catch(() => digests.delete(blob));
  }
  return pending;
}
async function digest(blob: Blob): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle)
    return Array.from(
      new Uint8Array(await subtle.digest("SHA-256", await blob.arrayBuffer())),
      (b) => b.toString(16).padStart(2, "0"),
    ).join("");
  const hash = new Sha256();
  for (let at = 0; at < blob.size; at += CHUNK)
    hash.update(await chunk(blob, at));
  return hash.digest();
}
/** Streaming UTF-8: a character split across chunks is valid, malformed bytes are not. */
async function utf8(blob: Blob): Promise<string | undefined> {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let text = "";
  try {
    for (let at = 0; at < blob.size; at += CHUNK)
      text += decoder.decode(await chunk(blob, at), { stream: true });
    return text + decoder.decode();
  } catch (error) {
    if (error instanceof TypeError) return undefined;
    throw error;
  }
}
/**
 * Skips a BOM, XML declaration, processing instructions, comments and one
 * DOCTYPE (internal subset included) without interpreting DTDs or entities,
 * then requires an `<svg` root.
 */
export function hasSvgRoot(text: string): boolean {
  const doctype = /<!DOCTYPE[\t\n\r ]+svg[\t\n\r >[]/iy;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  for (;;) {
    while (/[\t\n\r ]/.test(text[i] ?? "")) i++;
    if (text.startsWith("<?", i)) {
      const end = text.indexOf("?>", i + 2);
      if (end < 0) return false;
      i = end + 2;
    } else if (text.startsWith("<!--", i)) {
      const end = text.indexOf("-->", i + 4);
      if (end < 0) return false;
      i = end + 3;
    } else if (((doctype.lastIndex = i), doctype.test(text))) {
      i = skipDoctype(text, i + 9);
      if (i < 0) return false;
    } else return /^<svg[\t\n\r />]/i.test(text.slice(i, i + 5));
  }
}
function skipDoctype(text: string, i: number): number {
  let quote = "",
    subset = false;
  for (; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = "";
    } else if (subset && text.startsWith("<!--", i)) {
      const end = text.indexOf("-->", i + 4);
      if (end < 0) return -1;
      i = end + 2;
    } else if (subset && text.startsWith("<?", i)) {
      const end = text.indexOf("?>", i + 2);
      if (end < 0) return -1;
      i = end + 1;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "[") subset = true;
    else if (c === "]") subset = false;
    else if (c === ">" && !subset) return i + 1;
  }
  return -1;
}
async function signature(mime: string, blob: Blob): Promise<boolean> {
  switch (mime) {
    case "image/svg+xml": {
      const text = await utf8(blob);
      return text !== undefined && hasSvgRoot(text);
    }
    case "text/vtt": {
      const text = await utf8(blob);
      return text !== undefined && /^\ufeff?WEBVTT(?:[\t \r\n]|$)/.test(text);
    }
    case "text/plain":
      return (await utf8(blob)) !== undefined;
  }
  const bytes = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  const ascii = (offset: number, length: number) =>
    String.fromCharCode(...bytes.slice(offset, offset + length));
  const begins = (...signature: number[]) =>
    signature.every((v, i) => bytes[i] === v);
  switch (mime) {
    case "image/png":
      return begins(137, 80, 78, 71, 13, 10, 26, 10);
    case "image/jpeg":
      return begins(255, 216, 255);
    case "image/gif":
      return ["GIF87a", "GIF89a"].includes(ascii(0, 6));
    case "image/webp":
      return ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP";
    case "audio/wav":
    case "audio/x-wav":
      return ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE";
    case "audio/mpeg":
      return (
        ascii(0, 3) === "ID3" ||
        (bytes[0] === 255 && ((bytes[1] ?? 0) & 224) === 224)
      );
    case "audio/ogg":
    case "video/ogg":
      return ascii(0, 4) === "OggS";
    case "video/webm":
    case "audio/webm":
      return begins(26, 69, 223, 163);
    case "video/mp4":
    case "audio/mp4":
      return ascii(4, 4) === "ftyp";
  }
  return false;
}
async function check(asset: Asset, blob: Blob): Promise<void> {
  if (blob.size !== asset.byteLength || blob.size > FILE_LIMIT)
    throw new AssetError("size", "Invalid asset size.");
  if (!(await signature(asset.mime, blob)))
    throw new AssetError(
      "signature",
      `Asset MIME type and signature do not match: ${asset.mime}`,
    );
  if (asset.sha256 && (await sha256(blob)) !== asset.sha256)
    throw new AssetError("digest", "Wrong asset digest.");
}
const verified = new WeakMap<Blob, Map<string, Promise<void>>>();
/**
 * Read signatures, never run or render files to identify their type. The
 * outcome is memoized per Blob and expected metadata/digest.
 */
export function verifyAsset(asset: Asset, blob: Blob): Promise<void> {
  const key = `${asset.mime}\n${asset.byteLength}\n${asset.sha256 ?? ""}`;
  let outcomes = verified.get(blob);
  if (!outcomes) verified.set(blob, (outcomes = new Map()));
  let pending = outcomes.get(key);
  if (!pending) {
    pending = check(asset, blob);
    outcomes.set(key, pending);
    pending.catch(() => {});
  }
  return pending;
}
const identities = new WeakMap<Blob, number>();
let identity = 0;
/** Each resolve owns one URL. Release is idempotent and scoped to its consumer. */
export function createAssetResolver(
  assets: readonly Asset[],
  blobs: AssetBlobs,
): AssetResolver {
  return {
    async resolve(id, signal) {
      const asset = assets.find((a) => a.id === id),
        blob = blobs.get(id);
      if (!asset || !blob)
        throw new AssetError(
          "missing",
          `Missing resource: ${id}. Link the file in the Resources panel.`,
        );
      await verifyAsset(asset, blob);
      if (signal?.aborted)
        throw new AssetError("aborted", "Loading cancelled.");
      const url = URL.createObjectURL(
        blob.type === asset.mime
          ? blob
          : new Blob([blob], { type: asset.mime }),
      );
      let released = false;
      const release = () => {
        if (!released) {
          released = true;
          URL.revokeObjectURL(url);
          signal?.removeEventListener("abort", release);
        }
      };
      signal?.addEventListener("abort", release, { once: true });
      return { url, mime: asset.mime, blob, release };
    },
    revision(id) {
      const blob = blobs.get(id);
      if (!blob) return "missing";
      let n = identities.get(blob);
      if (n === undefined) identities.set(blob, (n = ++identity));
      return `blob-${n}`;
    },
  };
}
