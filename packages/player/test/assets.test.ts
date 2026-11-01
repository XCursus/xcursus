import { readFile } from "node:fs/promises";
import { expect, it, vi } from "vitest";
import {
  createAssetResolver,
  verifyAsset,
  sha256,
} from "../src/assets/index.js";
import type { Asset } from "@xcursus/core";
async function resource() {
  const blob = new Blob(
    [
      await readFile(
        new URL(
          "../../../examples/content-gallery/assets/tone.wav",
          import.meta.url,
        ),
      ),
    ],
    { type: "audio/wav" },
  );
  const asset: Asset = {
    id: "tone",
    path: "assets/tone/tone.wav",
    mime: "audio/wav",
    byteLength: blob.size,
    sha256: await sha256(blob),
  };
  return { asset, blob };
}
it("owns independent Blob URLs, releases idempotently and aborts without leaking", async () => {
  const { asset, blob } = await resource(),
    resolver = createAssetResolver([asset], new Map([[asset.id, blob]])),
    revoke = vi.spyOn(URL, "revokeObjectURL"),
    controller = new AbortController();
  const a = await resolver.resolve("tone", controller.signal),
    b = await resolver.resolve("tone");
  expect(a.url).not.toBe(b.url);
  controller.abort();
  a.release();
  expect(revoke).toHaveBeenCalledTimes(1);
  b.release();
  b.release();
  expect(revoke).toHaveBeenCalledTimes(2);
  revoke.mockRestore();
  await expect(resolver.resolve("tone", controller.signal)).rejects.toThrow(
    /cancelled/,
  );
});
it("rejects missing bytes, wrong length/signature/digest and unsupported MIME", async () => {
  const { asset, blob } = await resource();
  await expect(
    createAssetResolver([asset], new Map()).resolve("tone"),
  ).rejects.toThrow(/Missing resource/);
  for (const patch of [
    { byteLength: 1 },
    { sha256: "0".repeat(64) },
    { mime: "image/png" },
    { mime: "application/javascript" },
  ])
    await expect(verifyAsset({ ...asset, ...patch }, blob)).rejects.toThrow();
});
