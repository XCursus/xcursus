import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import {
  ARCHIVE_EXTENSION,
  LEGACY_ARCHIVE_EXTENSION,
  PROJECT_ACCEPT,
  archiveFormat,
  readArchive,
  writeArchive,
} from "../src/archive.js";
import { serializeDocument, validateDocument } from "@xcursus/core";
import type { ProjectDocument } from "@xcursus/core";
import { sha256 } from "../../player/src/assets/index.js";
import layout from "../../../examples/layout-canvas/project.json";
import gallery from "../../../examples/content-gallery/project.json";

const file = (path: string) =>
  readFile(new URL(`../../../${path}`, import.meta.url));
const blobOf = async (path: string) => new Blob([await file(path)]);
/** Entries of a ZIP as text (JSON) or digests (resources). */
async function entries(blob: Blob) {
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  return Object.fromEntries(
    await Promise.all(
      Object.entries(files).map(async ([name, bytes]) => [
        name,
        name.endsWith(".json")
          ? JSON.parse(strFromU8(bytes))
          : await sha256(new Blob([bytes as Uint8Array<ArrayBuffer>])),
      ]),
    ),
  ) as Record<string, unknown>;
}
const LEGACY = "tests/fixtures/legacy/layout-canvas.spatialdeck";

describe("archive format names", () => {
  it("names the native and the legacy archive, case-insensitively", () => {
    expect(ARCHIVE_EXTENSION).toBe(".xcursus");
    expect(LEGACY_ARCHIVE_EXTENSION).toBe(".spatialdeck");
    expect(archiveFormat("deck.xcursus")).toBe("current");
    expect(archiveFormat("Deck.XCursus")).toBe("current");
    expect(archiveFormat("deck.spatialdeck")).toBe("legacy");
    expect(archiveFormat("DECK.SPATIALDECK")).toBe("legacy");
    for (const other of [
      "deck.json",
      "deck.zip",
      "deck.xcursus.json",
      "xcursus",
      "",
    ])
      expect(archiveFormat(other)).toBeNull();
  });
  it("file pickers accept JSON, .xcursus and legacy .spatialdeck", () => {
    expect(PROJECT_ACCEPT.split(",")).toEqual([
      ".json",
      ".xcursus",
      ".spatialdeck",
      "application/json",
      "application/zip",
    ]);
  });
});

describe(".xcursus documents", () => {
  it("a new document saves and reopens without loss: notes, extensions, unknown plugin data and asset bytes", async () => {
    const checked = validateDocument(layout);
    if (!checked.ok) throw new Error("fixture");
    const document: ProjectDocument = structuredClone(checked.value);
    document.metadata.title = "New .xcursus deck";
    document.scenes[0]!.notes = "Private speaker note";
    document.extensions["org.example.data"] = {
      version: "2.1.0",
      data: { nested: [1, "two", { three: null }] },
    };
    document.requiredCapabilities = [
      ...new Set([...document.requiredCapabilities, "blocks" as const]),
    ];
    document.scenes[1]!.blocks.push({
      id: "unknown-plugin",
      type: "plugin",
      data: {
        pluginId: "org.example.unregistered",
        apiVersion: "1.0.0",
        dataVersion: "9.9.9",
        payload: { kept: ["as", "is"] },
      },
      ...(document.scenes[1]!.layout === "canvas"
        ? { frame: { x: 0, y: 0, width: 64, height: 64, rotation: 0, z: 0 } }
        : {}),
    });
    const valid = validateDocument(document);
    if (!valid.ok) throw new Error(JSON.stringify(valid.diagnostics));
    const skyline = await blobOf("examples/layout-canvas/assets/skyline.svg");
    const saved = await writeArchive(
      valid.value,
      new Map([["skyline", new Blob([skyline], { type: "image/svg+xml" })]]),
    );
    expect(saved.type).toBe("application/zip");
    const reopened = await readArchive(saved);
    expect(reopened.sourceSchemaVersion).toBe("1.3.0");
    expect(reopened.document).toEqual(valid.value);
    expect(serializeDocument(reopened.document)).toEqual(
      serializeDocument(valid.value),
    );
    expect(await sha256(reopened.blobs.get("skyline")!)).toBe(
      await sha256(skyline),
    );
    // A second save of the reopened project is byte-for-byte the same content.
    const again = await entries(
      await writeArchive(reopened.document, reopened.blobs),
    );
    expect(again).toEqual(await entries(saved));
  });
  it("the example archives open, match their JSON and verify every asset", async () => {
    for (const [name, json] of [
      ["layout-canvas", layout],
      ["content-gallery", gallery],
    ] as const) {
      const archive = await readArchive(
        await blobOf(`examples/${name}/${name}.xcursus`),
      );
      const expected = validateDocument(json);
      if (!expected.ok) throw new Error(name);
      expect(archive.document).toEqual(expected.value);
      expect(archive.sourceSchemaVersion).toBe("1.3.0");
      const manifest = (
        await entries(await blobOf(`examples/${name}/${name}.xcursus`))
      )["manifest.json"] as { assets: { id: string; sha256: string }[] };
      expect(archive.blobs.size).toBe(expected.value.assets.length);
      for (const asset of manifest.assets)
        expect(await sha256(archive.blobs.get(asset.id)!)).toBe(asset.sha256);
    }
  });
});

describe("legacy .spatialdeck import", () => {
  it("opens an archive written by SpatialDeck 0.6 with its resources intact", async () => {
    const legacy = await blobOf(LEGACY);
    const imported = await readArchive(legacy);
    const original = await entries(legacy);
    const project = validateDocument(original["project.json"]);
    if (!project.ok) throw new Error("legacy project");
    expect(imported.document).toEqual(project.value);
    expect(imported.document.metadata.author).toBe("SpatialDeck example");
    expect(imported.sourceSchemaVersion).toBe("1.3.0");
    const manifest = original["manifest.json"] as {
      version: string;
      assets: { id: string; entry: string; sha256: string }[];
    };
    expect(manifest.version).toBe("1.0.0");
    for (const asset of manifest.assets) {
      expect(original[asset.entry]).toBe(asset.sha256);
      expect(await sha256(imported.blobs.get(asset.id)!)).toBe(asset.sha256);
    }
  });
  it("saving the import writes the same container: project, manifest and asset entries unchanged", async () => {
    const legacy = await blobOf(LEGACY);
    const imported = await readArchive(legacy);
    const converted = await writeArchive(imported.document, imported.blobs);
    // Same entries and content: only the extension of the saved file changes.
    expect(await entries(converted)).toEqual(await entries(legacy));
    const reopened = await readArchive(converted);
    expect(reopened.document).toEqual(imported.document);
    for (const [id, blob] of imported.blobs)
      expect(await sha256(reopened.blobs.get(id)!)).toBe(await sha256(blob));
  });
  it("migrates an earlier schema in memory and reports the declared version", async () => {
    // A legacy archive holding a 1.2.0 document (written by SpatialDeck 0.4).
    const historical = { ...gallery, assets: [] } as Record<string, unknown>;
    historical.scenes = (
      gallery.scenes as { blocks: { type: string }[] }[]
    ).map((scene) => ({
      ...scene,
      blocks: scene.blocks.filter(
        (b) => !["image", "audio", "video"].includes(b.type),
      ),
    }));
    expect(historical.schemaVersion).toBe("1.2.0");
    const zip = zipSync({
      "project.json": strToU8(JSON.stringify(historical)),
      "manifest.json": strToU8(
        JSON.stringify({ version: "1.0.0", assets: [] }),
      ),
    });
    const imported = await readArchive(new Blob([zip]));
    expect(imported.sourceSchemaVersion).toBe("1.2.0");
    expect(imported.document.schemaVersion).toBe("1.3.0");
    for (const scene of imported.document.scenes) {
      expect(scene.layout).toBe("flow");
      expect(scene.appearance).toEqual({
        variant: "card",
        background: null,
        titleVisible: true,
      });
    }
    // Text, notes and plugin data survive the migration.
    const plugin = imported.document.scenes
      .flatMap((s) => s.blocks)
      .find((b) => b.type === "plugin");
    expect(plugin?.data).toEqual(
      (historical.scenes as { blocks: { type: string; data: unknown }[] }[])
        .flatMap((s) => s.blocks)
        .find((b) => b.type === "plugin")?.data,
    );
    // The bytes given to readArchive are left as they were.
    expect(strFromU8(unzipSync(zip)["project.json"]!)).toBe(
      JSON.stringify(historical),
    );
  });
  it("an invalid legacy archive is refused like any other", async () => {
    const zip = zipSync({
      "project.json": strToU8('{"schemaVersion":"9.0.0"}'),
      "manifest.json": strToU8('{"version":"1.0.0","assets":[]}'),
    });
    await expect(readArchive(new Blob([zip]))).rejects.toThrow();
  });
});
