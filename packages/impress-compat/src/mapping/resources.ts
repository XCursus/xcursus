import { normalizedPath } from "@xcursus/core";
import type { Asset } from "@xcursus/core";

export type ResourceKind = "image" | "video" | "audio" | "captions";
export type ResourceStatus =
  | "asset"
  | "remote"
  | "data"
  | "outside"
  | "missing"
  | "invalid"
  | "unsupported";
/** A resource referenced by the HTML and what became of it. Nothing is ever fetched. */
export interface ImportResource {
  /** The reference as written in the HTML. */
  reference: string;
  kind: ResourceKind | "stylesheet" | "script" | "font";
  status: ResourceStatus | "ignored";
  /** Normalized relative path, for local references. */
  path?: string;
  /** Asset of the candidate document, when imported. */
  assetId?: string;
  mime?: string;
  byteLength?: number;
}
export type Resolution =
  | { status: "asset"; assetId: string }
  | { status: Exclude<ResourceStatus, "asset">; message: string };
export interface ResourceResolver {
  resolve(url: string, kind: ResourceKind): Resolution;
}

const EXTENSIONS: Record<ResourceKind, Record<string, string>> = {
  image: {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
  },
  video: {
    mp4: "video/mp4",
    m4v: "video/mp4",
    webm: "video/webm",
    ogv: "video/ogg",
    ogg: "video/ogg",
  },
  audio: {
    mp3: "audio/mpeg",
    wav: "audio/wav",
    ogg: "audio/ogg",
    oga: "audio/ogg",
    opus: "audio/ogg",
    m4a: "audio/mp4",
    webm: "audio/webm",
  },
  captions: { vtt: "text/vtt" },
};
const FILE_LIMIT = 50 * 1024 * 1024;

const ascii = (bytes: Uint8Array, offset: number, length: number) =>
  String.fromCharCode(...bytes.subarray(offset, offset + length));
const begins = (bytes: Uint8Array, ...signature: number[]) =>
  signature.every((v, i) => bytes[i] === v);
function utf8(bytes: Uint8Array): string | undefined {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}
/**
 * Minimal signature check, the same table as the player's asset verifier:
 * a file is never decoded, rendered or run to learn its type. Callers verify
 * the imported assets again with their own pipeline before use.
 */
export function matchesSignature(mime: string, bytes: Uint8Array): boolean {
  switch (mime) {
    case "image/png":
      return begins(bytes, 137, 80, 78, 71, 13, 10, 26, 10);
    case "image/jpeg":
      return begins(bytes, 255, 216, 255);
    case "image/gif":
      return ["GIF87a", "GIF89a"].includes(ascii(bytes, 0, 6));
    case "image/webp":
      return ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP";
    case "image/svg+xml": {
      const text = utf8(bytes);
      return text !== undefined && /<svg[\t\n\r />]/i.test(text);
    }
    case "text/vtt": {
      const text = utf8(bytes);
      return text !== undefined && /^\ufeff?WEBVTT(?:[\t \r\n]|$)/.test(text);
    }
    case "audio/wav":
      return ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WAVE";
    case "audio/mpeg":
      return (
        ascii(bytes, 0, 3) === "ID3" ||
        (bytes[0] === 255 && ((bytes[1] ?? 0) & 224) === 224)
      );
    case "audio/ogg":
    case "video/ogg":
      return ascii(bytes, 0, 4) === "OggS";
    case "video/webm":
    case "audio/webm":
      return begins(bytes, 26, 69, 223, 163);
    case "video/mp4":
    case "audio/mp4":
      return ascii(bytes, 4, 4) === "ftyp";
  }
  return false;
}

/**
 * Resolves a URL of the HTML against the directory of the HTML file. Only
 * relative paths that stay inside that directory are local resources; a
 * query or fragment is ignored, `..` may not climb above the root, and the
 * result must survive `normalizedPath` unchanged.
 */
export function localPath(
  url: string,
): { path: string } | { status: "remote" | "data" | "outside" } {
  const trimmed = url.trim();
  if (/^data:/i.test(trimmed)) return { status: "data" };
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed) || trimmed.startsWith("//"))
    return { status: "remote" };
  const bare = trimmed.split(/[?#]/)[0]!;
  if (bare.startsWith("/") || bare.includes("\\") || bare === "")
    return { status: "outside" };
  const segments: string[] = [];
  for (const segment of bare.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (!segments.length) return { status: "outside" };
      segments.pop();
      continue;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      return { status: "outside" };
    }
    segments.push(decoded);
  }
  const joined = segments.join("/");
  const normalized = normalizedPath(joined);
  if (!normalized || normalized !== joined.normalize("NFC"))
    return { status: "outside" };
  return { path: normalized };
}

const idFrom = (path: string) =>
  `asset-${(path.split("/").at(-1) ?? "file")
    .replace(/\.[^.]*$/, "")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)}`;

/**
 * Collects the local resources the content references, registering each
 * file once as a document asset. `files` are the bytes the caller chose to
 * provide (keyed by normalized relative path); with `matchBasename`, a path
 * that is not found matches the only provided file with the same name.
 */
export class Resources implements ResourceResolver {
  readonly assets: Asset[] = [];
  readonly files = new Map<string, Uint8Array>();
  readonly report: ImportResource[] = [];
  private readonly byPath = new Map<string, string>();
  private readonly ids = new Set<string>();
  constructor(
    private readonly provided: ReadonlyMap<string, Uint8Array>,
    private readonly matchBasename: boolean,
  ) {}
  private find(path: string): [string, Uint8Array] | undefined {
    const direct = this.provided.get(path);
    if (direct) return [path, direct];
    if (!this.matchBasename) return undefined;
    const name = path.split("/").at(-1)!;
    const matches = [...this.provided].filter(
      ([key]) => key.split("/").at(-1) === name,
    );
    return matches.length === 1 ? matches[0] : undefined;
  }
  resolve(url: string, kind: ResourceKind): Resolution {
    const local = localPath(url);
    const record = (entry: Omit<ImportResource, "reference" | "kind">) =>
      this.report.push({ reference: url, kind, ...entry });
    if ("status" in local) {
      record({ status: local.status });
      const message = {
        remote: `Remote ${kind} not fetched: ${url.slice(0, 120)}`,
        data: `Inline data URL not imported for a ${kind}`,
        outside: `The ${kind} path leaves the presentation folder: ${url.slice(0, 120)}`,
      }[local.status];
      return { status: local.status, message };
    }
    const extension = local.path.split(".").at(-1)?.toLowerCase() ?? "";
    const mime = EXTENSIONS[kind][extension];
    if (!mime) {
      record({ status: "unsupported", path: local.path });
      return {
        status: "unsupported",
        message: `Unsupported ${kind} format: ${local.path}`,
      };
    }
    const known = this.byPath.get(local.path);
    if (known) {
      record({ status: "asset", path: local.path, assetId: known, mime });
      return { status: "asset", assetId: known };
    }
    const found = this.find(local.path);
    if (!found) {
      record({ status: "missing", path: local.path, mime });
      return {
        status: "missing",
        message: `Local ${kind} not provided: ${local.path}`,
      };
    }
    const [, bytes] = found;
    if (bytes.byteLength > FILE_LIMIT || !matchesSignature(mime, bytes)) {
      record({ status: "invalid", path: local.path, mime });
      return {
        status: "invalid",
        message: `The file ${local.path} is not a valid ${mime} file within 50 MiB`,
      };
    }
    const base = idFrom(local.path).replace(/-$/, "");
    let id = base;
    for (let n = 2; this.ids.has(id); n++) id = `${base.slice(0, 88)}-${n}`;
    this.ids.add(id);
    this.byPath.set(local.path, id);
    this.assets.push({
      id,
      path: local.path,
      mime,
      byteLength: bytes.byteLength,
    });
    this.files.set(id, bytes);
    record({
      status: "asset",
      path: local.path,
      assetId: id,
      mime,
      byteLength: bytes.byteLength,
    });
    return { status: "asset", assetId: id };
  }
}
