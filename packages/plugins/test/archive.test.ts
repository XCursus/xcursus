import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { zipSync, strToU8, unzipSync, strFromU8 } from "fflate";
import { readArchive, writeArchive } from "../src/archive.js";
import { validateDocument } from "@xcursus/core";
import { verifyAsset, sha256 } from "../../player/src/assets/index.js";
import fixture from "../../../examples/content-gallery/project.json";
async function gallery() {
  const r = validateDocument(fixture);
  if (!r.ok) throw new Error();
  const blobs = new Map<string, Blob>();
  for (const a of r.value.assets)
    blobs.set(
      a.id,
      new Blob(
        [
          await readFile(
            new URL(
              `../../../examples/content-gallery/assets/${a.path.split("/").at(-1)}`,
              import.meta.url,
            ),
          ),
        ],
        { type: a.mime },
      ),
    );
  return { document: r.value, blobs };
}
it("real archive roundtrips every source and verified local Blob", async () => {
  const { document, blobs } = await gallery(),
    archive = await writeArchive(document, blobs),
    reopened = await readArchive(archive);
  expect(reopened.document).toEqual(document);
  for (const [id, b] of blobs)
    expect(await sha256(reopened.blobs.get(id)!)).toBe(await sha256(b));
});
it.each([
  "../x",
  "/tmp/x",
  "a\\b",
  "%2e%2e/x",
  "assets/%2fx",
  "assets/a/./b",
  "assets/a//b",
  "C:/x",
  "assets/e\u0301",
])("refuses ZIP unsafe or noncanonical path %s", async (path) => {
  const zip = zipSync({ [path]: strToU8("inert") });
  await expect(readArchive(new Blob([zip]))).rejects.toThrow();
});
it("refuses symlinks, duplicates, bad local headers, encrypted entries and inflated limits", async () => {
  const original = zipSync({ "project.json": strToU8("a".repeat(100000)) });
  const central = original.findIndex(
    (_, i) =>
      original[i] === 80 &&
      original[i + 1] === 75 &&
      original[i + 2] === 1 &&
      original[i + 3] === 2,
  );
  for (const mutate of [
    (v: DataView) => v.setUint32(central + 38, 0xa1ff0000, true),
    (v: DataView) => {
      v.setUint16(central + 8, 1, true);
      v.setUint16(6, 1, true);
    },
    (v: DataView) => v.setUint32(central + 24, 52428801, true),
    (v: DataView) => {
      v.setUint32(central + 24, 32, true);
      v.setUint32(22, 32, true);
    },
    (v: DataView) => v.setUint8(30, 88),
  ]) {
    const bytes = original.slice();
    mutate(new DataView(bytes.buffer));
    await expect(readArchive(new Blob([bytes]))).rejects.toThrow();
  }
  const duplicate = zipSync({
    "assets/a.txt": strToU8("1"),
    "assets/b.txt": strToU8("2"),
  });
  const bytes = duplicate.slice();
  for (let i = 0; i < bytes.length - 12; i++) {
    if (String.fromCharCode(...bytes.slice(i, i + 12)) === "assets/b.txt")
      bytes[i + 7] = 97;
  }
  await expect(readArchive(new Blob([bytes]))).rejects.toThrow(/duplicat/);
});
it("refuses a dishonest digest, incompatible MIME, missing resources and oversized JSON", async () => {
  const { document, blobs } = await gallery(),
    a = document.assets[0]!;
  document.assets[0] = { ...a, sha256: "0".repeat(64) };
  await expect(writeArchive(document, blobs)).rejects.toThrow(/digest/i);
  document.assets[0] = a;
  await expect(
    verifyAsset({ ...a, mime: "image/png" }, blobs.get(a.id)!),
  ).rejects.toThrow(/MIME/);
  await expect(writeArchive(document, new Map())).rejects.toThrow(
    /Missing resource/,
  );
  const zip = zipSync({ "project.json": new Uint8Array(10 * 1024 * 1024 + 1) });
  await expect(readArchive(new Blob([zip]))).rejects.toThrow(/limit exceeded/i);
});
it("enforces actual file/entry/total limits before allocating inflated bodies", async () => {
  const zip = zipSync({ asset: strToU8("x") }),
    v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength),
    central = zip.findIndex(
      (_, i) => i + 4 <= zip.length && v.getUint32(i, true) === 0x02014b50,
    );
  v.setUint32(central + 24, 50 * 1024 * 1024 + 1, true);
  await expect(readArchive(new Blob([zip]))).rejects.toThrow(/limit exceeded/i);
  const many = Object.fromEntries(
    Array.from({ length: 10001 }, (_, i) => ["x" + i, new Uint8Array()]),
  );
  await expect(readArchive(new Blob([zipSync(many)]))).rejects.toThrow();
});
it("checks manifest digests and cumulative size, rejects extra files and CRC corruption", async () => {
  const { document, blobs } = await gallery(),
    archive = await writeArchive(document, blobs),
    files = unzipSync(new Uint8Array(await archive.arrayBuffer()));
  const manifest = JSON.parse(strFromU8(files["manifest.json"]!));
  manifest.assets[0].sha256 = "0".repeat(64);
  files["manifest.json"] = strToU8(JSON.stringify(manifest));
  await expect(readArchive(new Blob([zipSync(files)]))).rejects.toThrow(
    /digest/i,
  );
  const many = zipSync(
      Object.fromEntries(
        Array.from({ length: 5 }, (_, i) => ["a" + i, strToU8("x")]),
      ),
    ),
    v = new DataView(many.buffer, many.byteOffset, many.byteLength);
  for (let i = 0; i < many.length - 46; i++)
    if (v.getUint32(i, true) === 0x02014b50) {
      v.setUint32(i + 24, 50 * 1024 * 1024, true);
      v.setUint32(v.getUint32(i + 42, true) + 22, 50 * 1024 * 1024, true);
    }
  await expect(readArchive(new Blob([many]))).rejects.toThrow(
    /limit exceeded/i,
  );
  const corrupt = zipSync({ "project.json": strToU8("{}") }, { level: 0 });
  corrupt[30 + "project.json".length] = 32;
  await expect(readArchive(new Blob([corrupt]))).rejects.toThrow(/CRC/);
  const original = unzipSync(new Uint8Array(await archive.arrayBuffer()));
  original["extra.txt"] = strToU8("extra");
  await expect(readArchive(new Blob([zipSync(original)]))).rejects.toThrow(
    /extra files/i,
  );
});
it("packs arbitrary safe sidecar paths without rewriting the canonical JSON", async () => {
  const { document, blobs } = await gallery();
  document.assets[0]!.path = "pictures/safe%20diagram.svg";
  const result = await readArchive(await writeArchive(document, blobs));
  expect(result.document).toEqual(document);
});
/** Compression method of each entry, read from the central directory. */
function methods(bytes: Uint8Array) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (view.getUint32(end, true) !== 0x06054b50) end--;
  let p = view.getUint32(end + 16, true);
  const result: Record<string, number> = {};
  for (let i = 0; i < view.getUint16(end + 10, true); i++) {
    const n = view.getUint16(p + 28, true);
    const name = strFromU8(bytes.subarray(p + 46, p + 46 + n));
    result[name] = view.getUint16(p + 10, true);
    p += 46 + n + view.getUint16(p + 30, true) + view.getUint16(p + 32, true);
  }
  return result;
}
it("stores already compressed media and deflates text, JSON and SVG (0.6)", async () => {
  const { document, blobs } = await gallery();
  const bytes = new Uint8Array(
    await (await writeArchive(document, blobs)).arrayBuffer(),
  );
  const m = methods(bytes);
  expect(m["project.json"]).toBe(8);
  expect(m["manifest.json"]).toBe(8);
  const entry = (id: string) =>
    Object.keys(m).find((name) => name.startsWith(`assets/${id}/`))!;
  expect(m[entry("motion")]).toBe(0); // video/mp4
  expect(m[entry("diagram")]).toBe(8); // image/svg+xml
  expect(m[entry("tone")]).toBe(8); // audio/wav is not compressed
  // The stored MP4 is byte-identical inside the archive.
  const mp4 = new Uint8Array(await blobs.get("motion")!.arrayBuffer());
  expect(unzipSync(bytes)[entry("motion")]).toEqual(mp4);
});
it("writeArchive yields to the event loop between chunks instead of blocking", async () => {
  const { document, blobs } = await gallery();
  let ticks = 0;
  const timer = setInterval(() => ticks++, 0);
  try {
    await writeArchive(document, blobs);
  } finally {
    clearInterval(timer);
  }
  // A synchronous zipSync would complete before any interval callback ran.
  expect(ticks).toBeGreaterThan(2);
});
