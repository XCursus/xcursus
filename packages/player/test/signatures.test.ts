import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createAssetResolver,
  sha256,
  verifyAsset,
} from "../src/assets/index.js";
import type { Asset } from "@xcursus/core";
const encoder = new TextEncoder();
const reference = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
function bytesOf(...parts: Array<string | number[] | Uint8Array>) {
  const chunks = parts.map((p) =>
    typeof p === "string"
      ? encoder.encode(p)
      : p instanceof Uint8Array
        ? p
        : Uint8Array.from(p),
  );
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
function resource(bytes: Uint8Array, mime: string, digest = true) {
  const blob = new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime });
  const asset: Asset = {
    id: "asset",
    path: "assets/asset/file",
    mime,
    byteLength: blob.size,
    ...(digest ? { sha256: reference(bytes) } : {}),
  };
  return { asset, blob };
}
/** Places `char` so that its first byte sits at `offset - split` and it crosses `offset`. */
function straddling(prefix: string, char: string, offset: number, split = 1) {
  const head = encoder.encode(prefix).length;
  return prefix + "a".repeat(offset - split - head) + char;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("asset signatures", () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>';
  it.each([
    ["BOM", bytesOf([0xef, 0xbb, 0xbf], svg)],
    [
      "XML declaration",
      bytesOf('<?xml version="1.0" encoding="UTF-8"?>\n', svg),
    ],
    [
      "comment and DOCTYPE",
      bytesOf(
        '<?xml version="1.0"?>\n<!-- Generator: editor, <html> inside -->\n',
        '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n',
        svg,
      ),
    ],
    [
      "processing instruction and internal subset",
      bytesOf(
        [0xef, 0xbb, 0xbf],
        '<?xml version="1.0"?><?xml-stylesheet href="a.css"?>',
        '<!DOCTYPE svg [ <!ENTITY ns "http://example.invalid/>"> <!-- ] > --> ]>',
        "<!-- before root -->\r\n\t",
        svg,
      ),
    ],
  ])("accepts SVG with %s before the root", async (_name, bytes) => {
    const { asset, blob } = resource(bytes, "image/svg+xml");
    await expect(verifyAsset(asset, blob)).resolves.toBeUndefined();
  });
  it.each([
    ["HTML after a comment that mentions svg", "<!-- <svg> -->\n<html></html>"],
    ["script after prolog", '<?xml version="1.0"?><!--x--><script/>'],
    ["unterminated comment", "<!-- <svg viewBox='0 0 1 1'/>"],
    ["HTML doctype", "<!DOCTYPE html><html><svg/></html>"],
    ["text before root", "hello <svg/>"],
    ["unterminated DOCTYPE", '<!DOCTYPE svg [ <!ENTITY a "x"> <svg/>'],
  ])("rejects non-SVG: %s", async (_name, text) => {
    const { asset, blob } = resource(encoder.encode(text), "image/svg+xml");
    await expect(verifyAsset(asset, blob)).rejects.toThrow(/signature/);
  });
  it.each([
    ["VTT 2-byte", "text/vtt", "WEBVTT\n\n00:00.000 --> 00:01.000\n", "è", 1],
    ["VTT 3-byte", "text/vtt", "WEBVTT\n\n00:00.000 --> 00:01.000\n", "€", 2],
    ["VTT 4-byte", "text/vtt", "﻿WEBVTT\n\n", "😀", 3],
    [
      "SVG 3-byte",
      "image/svg+xml",
      '<svg xmlns="http://www.w3.org/2000/svg"><text>',
      "€",
      1,
    ],
    ["plain 4-byte", "text/plain", "", "😀", 2],
  ])(
    "accepts %s character across byte 4096",
    async (_name, mime, prefix, char, split) => {
      let text = straddling(prefix, char, 4096, split);
      if (mime === "image/svg+xml") text += "</text></svg>";
      else text += "\nend\n";
      const bytes = encoder.encode(text);
      expect(bytes.length).toBeGreaterThan(4096);
      const { asset, blob } = resource(bytes, mime);
      await expect(verifyAsset(asset, blob)).resolves.toBeUndefined();
    },
  );
  it.each([
    ["VTT invalid byte after the first block", "text/vtt", 5000, [0xc3, 0x28]],
    ["VTT truncated at end of file", "text/vtt", -1, [0xe2, 0x82]],
    ["SVG lone continuation byte", "image/svg+xml", 4200, [0x80]],
    ["plain overlong encoding", "text/plain", 10, [0xc0, 0xaf]],
  ])("rejects really invalid UTF-8: %s", async (_name, mime, at, bad) => {
    const body =
      mime === "image/svg+xml"
        ? '<svg xmlns="http://www.w3.org/2000/svg"><text>' +
          "a".repeat(5000) +
          "</text></svg>"
        : "WEBVTT\n\n" + "a".repeat(6000);
    const good = encoder.encode(body);
    const position = at < 0 ? good.length : at;
    const bytes = bytesOf(
      good.subarray(0, position),
      bad,
      good.subarray(position),
    );
    const { asset, blob } = resource(bytes, mime);
    await expect(verifyAsset(asset, blob)).rejects.toThrow();
  });
  it("keeps rejecting wrong MIME, wrong digest and size mismatches", async () => {
    const png = bytesOf([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
    const { asset, blob } = resource(png, "image/png");
    await expect(verifyAsset(asset, blob)).resolves.toBeUndefined();
    for (const patch of [
      { mime: "image/svg+xml" },
      { mime: "text/vtt" },
      { sha256: "0".repeat(64) },
      { byteLength: png.length + 1 },
    ])
      await expect(verifyAsset({ ...asset, ...patch }, blob)).rejects.toThrow();
  });
});
describe("digest outside secure contexts", () => {
  it("computes SHA-256 locally when crypto.subtle is absent and still rejects wrong digests", async () => {
    const original = globalThis.crypto;
    vi.stubGlobal("crypto", {
      getRandomValues: <T extends ArrayBufferView>(array: T) =>
        original.getRandomValues(array as never) as T,
    });
    expect(globalThis.crypto.subtle).toBeUndefined();
    const bytes = encoder.encode("WEBVTT\n\n" + "x".repeat(70000));
    const { asset, blob } = resource(bytes, "text/vtt");
    expect(await sha256(blob)).toBe(reference(bytes));
    await expect(verifyAsset(asset, blob)).resolves.toBeUndefined();
    const other = resource(bytes, "text/vtt");
    await expect(
      verifyAsset({ ...other.asset, sha256: "f".repeat(64) }, other.blob),
    ).rejects.toThrow(/digest/i);
    const lease = await createAssetResolver(
      [asset],
      new Map([[asset.id, blob]]),
    ).resolve(asset.id);
    expect(lease.mime).toBe("text/vtt");
    lease.release();
  });
});
describe("verification cache", () => {
  it("verifies one Blob once per expected digest and invalidates on a different Blob or digest", async () => {
    const digest = vi.spyOn(globalThis.crypto.subtle, "digest");
    const bytes = encoder.encode("WEBVTT\n\ncached\n");
    const { asset, blob } = resource(bytes, "text/vtt");
    await verifyAsset(asset, blob);
    await verifyAsset(asset, blob);
    const resolver = createAssetResolver([asset], new Map([[asset.id, blob]]));
    for (let i = 0; i < 5; i++) (await resolver.resolve(asset.id)).release();
    expect(digest).toHaveBeenCalledTimes(1);
    await expect(
      verifyAsset({ ...asset, sha256: "0".repeat(64) }, blob),
    ).rejects.toThrow(/digest/i);
    const copy = new Blob([bytes], { type: "text/vtt" });
    await verifyAsset(asset, copy);
    expect(digest).toHaveBeenCalledTimes(2);
    await expect(
      verifyAsset(
        { ...asset, sha256: reference(encoder.encode("other")) },
        copy,
      ),
    ).rejects.toThrow(/digest/i);
    expect(digest).toHaveBeenCalledTimes(2);
  });
});
describe("binary signatures", () => {
  const riff = (kind: string) =>
    bytesOf("RIFF", [0, 0, 0, 0], kind, [0, 0, 0, 0]);
  it.each([
    ["image/png", bytesOf([137, 80, 78, 71, 13, 10, 26, 10, 0, 0])],
    ["image/jpeg", bytesOf([255, 216, 255, 224, 0])],
    ["image/gif", bytesOf("GIF87a", [0, 0])],
    ["image/gif", bytesOf("GIF89a", [0, 0])],
    ["image/webp", riff("WEBP")],
    ["audio/wav", riff("WAVE")],
    ["audio/x-wav", riff("WAVE")],
    ["audio/mpeg", bytesOf("ID3", [3, 0, 0])],
    ["audio/mpeg", bytesOf([255, 251, 144, 0])],
    ["audio/ogg", bytesOf("OggS", [0])],
    ["video/ogg", bytesOf("OggS", [0])],
    ["video/webm", bytesOf([26, 69, 223, 163, 0])],
    ["audio/webm", bytesOf([26, 69, 223, 163, 0])],
    ["video/mp4", bytesOf([0, 0, 0, 24], "ftypisom")],
    ["audio/mp4", bytesOf([0, 0, 0, 24], "ftypM4A ")],
  ])(
    "accepts %s and rejects the same bytes under another type",
    async (mime, bytes) => {
      const { asset, blob } = resource(bytes, mime);
      await expect(verifyAsset(asset, blob)).resolves.toBeUndefined();
      const zeros = resource(new Uint8Array(bytes.length), mime);
      await expect(verifyAsset(zeros.asset, zeros.blob)).rejects.toThrow(
        /signature/,
      );
    },
  );
  it("rejects unsupported MIME types and files over the size limit", async () => {
    const pdf = resource(bytesOf("%PDF-1.7"), "application/pdf");
    await expect(verifyAsset(pdf.asset, pdf.blob)).rejects.toThrow(/signature/);
    const { asset, blob } = resource(bytesOf("WEBVTT\n"), "text/vtt");
    await expect(
      verifyAsset({ ...asset, byteLength: 60 * 1024 * 1024 }, blob),
    ).rejects.toThrow(/asset size/);
  });
});
