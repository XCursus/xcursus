import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isAnimatedImage } from "../src/animation.js";
import { classifyViolations } from "../src/capture.js";
import { standaloneHtml, verifyResources } from "../src/html.js";
import type { ExportKit } from "../src/html.js";
import { run } from "../src/index.js";
import { loadProject } from "../src/io.js";
import { referencesRemote } from "../src/profile.js";

const root = new URL("../../../examples/", import.meta.url).pathname;
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) {
    await chmod(dir, 0o755).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
});
async function temp() {
  const dir = await mkdtemp(join(tmpdir(), "xcursus-cli-test-"));
  dirs.push(dir);
  return dir;
}
async function cli(...argv: string[]) {
  const out: string[] = [],
    err: string[] = [];
  const code = await run(argv, {
    out: (t) => out.push(t),
    log: (t) => out.push(t),
    warn: (t) => err.push(t),
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
/** The fields of the fixture JSON that the tests alter. */
interface Fixture {
  schemaVersion: string;
  requiredCapabilities: string[];
  assets: Array<{
    id: string;
    path: string;
    mime: string;
    byteLength: number;
    sha256?: string;
  }>;
  scenes: Array<{ blocks: unknown[] }>;
  paths: Array<{ nodes: Array<{ holdMs: number }> }>;
}
/** A copy of the distribution fixture that a test may alter. */
async function fixture(alter?: (doc: Fixture) => void) {
  const dir = await temp();
  await mkdir(join(dir, "assets"));
  await copyFile(
    join(root, "distribution-static/assets/orbit.svg"),
    join(dir, "assets/orbit.svg"),
  );
  const doc = JSON.parse(
    await readFile(join(root, "distribution-static/project.json"), "utf8"),
  );
  alter?.(doc);
  const project = join(dir, "project.json");
  await writeFile(project, JSON.stringify(doc));
  return { dir, project, doc };
}
const itinerary = async (dir: string, value: unknown) => {
  const path = join(dir, "itinerary.json");
  await writeFile(path, JSON.stringify(value));
  return path;
};

describe("arguments and exit codes", () => {
  it("prints help and version with exit 0", async () => {
    for (const args of [[], ["--help"], ["-h"]]) {
      const r = await cli(...args);
      expect(r.code).toBe(0);
      expect(r.out).toContain("xcursus validate <project>");
      expect(r.out).toContain("Exit codes: 0 success");
    }
    expect((await cli("--version")).out).toMatch(/^\d+\.\d+\.\d+$/);
  });
  it("rejects unknown commands, options, repeated and missing values with exit 1", async () => {
    const cases: Array<[string[], string]> = [
      [["publish"], "Unknown command"],
      [["validate", "x.json", "--bogus"], "Unknown option"],
      [["validate", "x.json", "--out"], "--out needs a value"],
      [["build", "x.json"], "Missing --out"],
      [["export", "gif", "x.json", "--out", "y"], "Unknown export format"],
      [["export", "html", "a.json", "b.json", "--out", "y"], "exactly one"],
      [
        ["export", "html", "x.json", "--out", "a", "--out", "b"],
        "Repeated option",
      ],
      [
        ["export", "html", "x.json", "--out", "a", "--lang", "fr"],
        "--lang must be",
      ],
      [
        [
          "export",
          "video",
          "x.json",
          "--out",
          "a",
          "--itinerary",
          "i",
          "--fps",
          "-1",
        ],
        "--fps must be",
      ],
      [
        [
          "export",
          "video",
          "x.json",
          "--out",
          "a",
          "--itinerary",
          "i",
          "--fps",
          "3.5",
        ],
        "--fps must be",
      ],
      [["validate", "x.json", "--fps", "30"], "does not apply"],
      [["export", "pdf", "x.json", "--out", "a"], "Missing --itinerary"],
    ];
    for (const [argv, message] of cases) {
      const r = await cli(...argv);
      expect(r.code, argv.join(" ")).toBe(1);
      expect(r.err, argv.join(" ")).toContain(message);
    }
  });
});

describe("validate", () => {
  it("accepts JSON projects and archives, with a machine-readable report", async () => {
    expect(
      (await cli("validate", join(root, "layout-canvas/project.json"))).code,
    ).toBe(0);
    expect(
      (await cli("validate", join(root, "layout-canvas/layout-canvas.xcursus")))
        .code,
    ).toBe(0);
    const json = await cli(
      "validate",
      join(root, "distribution-static/project.json"),
      "--json",
    );
    expect(json.code).toBe(0);
    const report = JSON.parse(json.out);
    expect(report).toMatchObject({
      ok: true,
      schemaVersion: "1.3.0",
      kind: "json",
    });
    expect(report.resources[0]).toMatchObject({
      id: "orbit",
      status: "verified",
    });
    // Historical schemas validate as migrated copies; the source version is reported.
    const legacy = JSON.parse(
      (
        await cli(
          "validate",
          join(root, "core-three-scenes/project.json"),
          "--json",
        )
      ).out,
    );
    expect(legacy).toMatchObject({
      ok: true,
      schemaVersion: "1.3.0",
      sourceSchemaVersion: "1.0.0",
    });
  });
  it("rejects unreadable JSON, an unknown version and an undeclared capability with exit 1", async () => {
    const dir = await temp();
    const bad = join(dir, "bad.json");
    await writeFile(bad, "{ not json");
    expect((await cli("validate", bad)).code).toBe(1);
    const { project } = await fixture((d) => void (d.schemaVersion = "1.4.0"));
    const future = await cli("validate", project);
    expect(future.code).toBe(1);
    expect(future.err).toContain("UNSUPPORTED_VERSION");
    const { project: under } = await fixture(
      (d) => void (d.requiredCapabilities = ["linear"]),
    );
    expect((await cli("validate", under)).err).toContain("CAPABILITY_REQUIRED");
    expect((await cli("validate", join(dir, "missing.json"))).code).toBe(1);
  });
  it("--json reports rejected documents on stdout too", async () => {
    const { project } = await fixture((d) => void (d.schemaVersion = "1.4.0"));
    const r = await cli("validate", project, "--json");
    expect(r.code).toBe(1);
    expect(r.err).toBe("");
    const report = JSON.parse(r.out);
    expect(report).toMatchObject({
      ok: false,
      error: "The project is not a valid XCursus document",
      resources: [],
    });
    expect(report.diagnostics[0].code).toBe("UNSUPPORTED_VERSION");
    const dir = await temp();
    const bad = join(dir, "bad.json");
    await writeFile(bad, "{ not json");
    const unreadable = JSON.parse((await cli("validate", bad, "--json")).out);
    expect(unreadable.ok).toBe(false);
    expect(
      unreadable.diagnostics.length + unreadable.error.length,
    ).toBeGreaterThan(0);
  });
  it("confines assets to the project root: traversal, encoded, absolute and symlinked paths fail", async () => {
    for (const path of [
      "../outside.svg",
      "%2e%2e/outside.svg",
      "/etc/hosts",
      "assets\\orbit.svg",
    ]) {
      const { project } = await fixture((d) => void (d.assets[0]!.path = path));
      const r = await cli("validate", project);
      expect(r.code, path).toBe(1);
    }
    const { dir, project } = await fixture(
      (d) => void (d.assets[0]!.path = "assets/link.svg"),
    );
    const outside = await temp();
    await copyFile(join(dir, "assets/orbit.svg"), join(outside, "secret.svg"));
    await symlink(join(outside, "secret.svg"), join(dir, "assets/link.svg"));
    const r = await cli("validate", project);
    expect(r.code).toBe(1);
    expect(r.out).toContain("ASSET_PATH");
    // A symlinked directory in the middle of the path is refused as well, even inside the root.
    const { dir: d2, project: p2 } = await fixture(
      (d) => void (d.assets[0]!.path = "linked/orbit.svg"),
    );
    await symlink(join(d2, "assets"), join(d2, "linked"));
    const r2 = await cli("validate", p2);
    expect(r2.code).toBe(1);
  });
  it("reports missing files, wrong size, digest and MIME signature", async () => {
    const svg = await readFile(
      join(root, "distribution-static/assets/orbit.svg"),
    );
    const cases: Array<[(d: Fixture) => void, string]> = [
      [(d) => void (d.assets[0]!.path = "assets/none.svg"), "ASSET_MISSING"],
      [(d) => void (d.assets[0]!.byteLength = svg.length + 1), "ASSET_SIZE"],
      [
        (d) => void (d.assets[0]!.sha256 = sha(Buffer.from("x"))),
        "ASSET_DIGEST",
      ],
      [(d) => void (d.assets[0]!.mime = "image/png"), "ASSET_SIGNATURE"],
    ];
    for (const [alter, code] of cases) {
      const { project } = await fixture(alter);
      const r = await cli("validate", project, "--json");
      expect(r.code, code).toBe(1);
      expect(JSON.parse(r.out).diagnostics[0].code).toBe(code);
    }
  });
  it("handles quotes, spaces and apostrophes in file names without a shell", async () => {
    const { dir, doc } = await fixture();
    const name = `it's a "quoted" deck; $(touch pwned).json`;
    await mkdir(join(dir, `as "sets"`));
    await copyFile(
      join(dir, "assets/orbit.svg"),
      join(dir, `as "sets"`, `o'rbit $x.svg`),
    );
    doc.assets[0]!.path = `as "sets"/o'rbit $x.svg`;
    await writeFile(join(dir, name), JSON.stringify(doc));
    expect((await cli("validate", join(dir, name))).code).toBe(0);
    expect(await readdir(dir)).not.toContain("pwned");
  });
});

describe("outputs", () => {
  it("refuses an existing output without --overwrite and leaves it untouched", async () => {
    const { dir, project } = await fixture();
    const out = join(dir, "deck.html");
    await writeFile(out, "keep");
    const r = await cli("export", "html", project, "--out", out);
    expect(r.code).toBe(3);
    expect(r.err).toContain("--overwrite");
    expect(await readFile(out, "utf8")).toBe("keep");
    // An existing sidecar manifest counts as output too.
    await writeFile(join(dir, "other.html.manifest.json"), "keep");
    expect(
      (await cli("export", "html", project, "--out", join(dir, "other.html")))
        .code,
    ).toBe(3);
  });
  it("replaces a build directory only when it is a previous build", async () => {
    const { dir, project } = await fixture();
    const target = join(dir, "site");
    await mkdir(target);
    await writeFile(join(target, "precious.txt"), "user data");
    const r = await cli("build", project, "--out", target, "--overwrite");
    expect(r.code).toBe(3);
    expect(r.err).toContain("not a previous XCursus build");
    expect(await readFile(join(target, "precious.txt"), "utf8")).toBe(
      "user data",
    );
  });
  it("fails with exit 3 on a missing or read-only output directory and leaves no temporary file", async () => {
    const { dir, project } = await fixture();
    expect(
      (
        await cli(
          "export",
          "html",
          project,
          "--out",
          join(dir, "nope/deck.html"),
        )
      ).code,
    ).toBe(3);
    if (process.getuid?.() === 0) return; // root ignores permissions
    const locked = join(dir, "locked");
    await mkdir(locked);
    await chmod(locked, 0o555);
    dirs.push(locked);
    const r = await cli("validate", project);
    expect(r.code).toBe(0);
    const { writeAtomic } = await import("../src/io.js");
    await expect(
      writeAtomic(join(locked, "deck.html"), "x"),
    ).rejects.toMatchObject({ exitCode: 3 });
    expect(await readdir(locked)).toEqual([]);
  });
});

describe("profiles and capture inputs (before any browser starts)", () => {
  it("strict exports refuse embeds, plugins and remote resources in markup", async () => {
    const cases: Array<[(d: Fixture) => void, string]> = [
      [
        (d) =>
          d.scenes[1]!.blocks.push({
            id: "web",
            type: "embed",
            data: { url: "https://example.org/", title: "Remote" },
          }),
        "EMBED_REMOTE",
      ],
      [
        (d) => {
          d.scenes[1]!.blocks.push({
            id: "badge",
            type: "plugin",
            data: {
              pluginId: "org.xcursus.badge",
              apiVersion: "1.0.0",
              dataVersion: "1.0.0",
              payload: { label: "x" },
            },
          });
        },
        "PLUGIN_UNAVAILABLE",
      ],
      [
        (d) =>
          d.scenes[1]!.blocks.push({
            id: "font",
            type: "html",
            data: {
              source:
                '<link rel="stylesheet" href="https://fonts.example/f.css"><p>x</p>',
            },
          }),
        "REMOTE_RESOURCE",
      ],
      [
        (d) =>
          d.scenes[1]!.blocks.push({
            id: "font2",
            type: "html",
            data: {
              source:
                "<style>@font-face{src:url(https://fonts.example/a.woff2)}</style>",
            },
          }),
        "REMOTE_RESOURCE",
      ],
      [
        (d) =>
          d.scenes[1]!.blocks.push({
            id: "pic",
            type: "markdown",
            data: { source: "![remote](https://example.org/a.png)" },
          }),
        "REMOTE_RESOURCE",
      ],
    ];
    for (const [alter, code] of cases) {
      const { dir, project } = await fixture(alter);
      const out = join(dir, "deck.html");
      const r = await cli("export", "html", project, "--out", out);
      expect(r.code, code).toBe(1);
      expect(r.err).toContain(code);
      await expect(readFile(out)).rejects.toThrow();
    }
  });
  it("audio and video are outside the video profile, a link only warns", async () => {
    const { dir, project } = await fixture((d) => {
      d.assets.push({
        id: "tone",
        path: "assets/tone.wav",
        mime: "audio/wav",
        byteLength: 4,
      });
      d.scenes[1]!.blocks.push({
        id: "a",
        type: "audio",
        data: {
          assetId: "tone",
          label: "Tone",
          autoplay: false,
          loop: false,
          onExit: "pause",
        },
      });
    });
    const path = await itinerary(dir, {
      pathId: "main",
      visits: [{ nodeId: "n1" }, { nodeId: "n2" }],
    });
    const r = await cli(
      "export",
      "video",
      project,
      "--itinerary",
      path,
      "--out",
      join(dir, "v.webm"),
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain("MEDIA_PROFILE");
  });
  it("validates the itinerary against the project before capture", async () => {
    const { dir, project } = await fixture();
    const cases: Array<[unknown, string]> = [
      [
        { pathId: "main", visits: [{ nodeId: "n1" }, { nodeId: "n3" }] },
        "NOT_ADJACENT",
      ],
      [
        { pathId: "main", visits: [{ nodeId: "n1", edgeIdToNext: "e1" }] },
        "EDGE_AFTER_LAST",
      ],
      [{ pathId: "main", visits: [] }, "ITINERARY_EMPTY"],
      [{ pathId: "nope", visits: [{ nodeId: "n1" }] }, "UNKNOWN_PATH"],
      [
        {
          pathId: "main",
          visits: ["n1", "n2", "n3", "n1", "n2", "n3", "n1"].map((nodeId) => ({
            nodeId,
          })),
        },
        "VISIT_LIMIT",
      ],
    ];
    for (const [value, code] of cases) {
      const r = await cli(
        "export",
        "pdf",
        project,
        "--itinerary",
        await itinerary(dir, value),
        "--out",
        join(dir, "x.pdf"),
      );
      expect(r.code, code).toBe(1);
      expect(r.err).toContain(code);
    }
    expect(
      (
        await cli(
          "export",
          "pdf",
          project,
          "--itinerary",
          join(dir, "absent.json"),
          "--out",
          join(dir, "x.pdf"),
        )
      ).code,
    ).toBe(1);
  });
  it("a zero-duration plan cannot become a video", async () => {
    const { dir, project } = await fixture((d) => {
      for (const n of d.paths[0]!.nodes) n.holdMs = 0;
    });
    const r = await cli(
      "export",
      "video",
      project,
      "--itinerary",
      await itinerary(dir, { pathId: "main", visits: [{ nodeId: "n1" }] }),
      "--out",
      join(dir, "v.webm"),
    );
    expect(r.code).toBe(1);
    expect(r.err).toContain("ZERO_DURATION");
  });
  it("a missing FFmpeg is an environment error (exit 2), never installed", async () => {
    const { dir, project } = await fixture();
    const previous = process.env.XCURSUS_FFMPEG;
    process.env.XCURSUS_FFMPEG = join(dir, "no-ffmpeg");
    try {
      const r = await cli(
        "export",
        "video",
        project,
        "--itinerary",
        await itinerary(dir, { pathId: "main", visits: [{ nodeId: "n1" }] }),
        "--out",
        join(dir, "v.webm"),
      );
      expect(r.code).toBe(2);
      expect(r.err).toContain("ffmpeg not found");
      expect(await readdir(dir)).not.toContain("v.webm");
    } finally {
      if (previous === undefined) delete process.env.XCURSUS_FFMPEG;
      else process.env.XCURSUS_FFMPEG = previous;
    }
  });
});

describe("pack and legacy archives", () => {
  const legacy = new URL(
    "../../../tests/fixtures/legacy/layout-canvas.spatialdeck",
    import.meta.url,
  ).pathname;
  it("validates a legacy .spatialdeck archive and says how to convert it", async () => {
    const human = await cli("validate", legacy);
    expect(human.code).toBe(0);
    expect(human.out).toContain("legacy .spatialdeck archive");
    const report = JSON.parse((await cli("validate", legacy, "--json")).out);
    expect(report).toMatchObject({
      ok: true,
      kind: "archive",
      archiveFormat: "legacy",
      schemaVersion: "1.3.0",
      sourceSchemaVersion: "1.3.0",
    });
    const current = JSON.parse(
      (
        await cli(
          "validate",
          join(root, "layout-canvas/layout-canvas.xcursus"),
          "--json",
        )
      ).out,
    );
    expect(current).toMatchObject({
      kind: "archive",
      archiveFormat: "current",
    });
  });
  it("converts a legacy archive to .xcursus and leaves the original untouched", async () => {
    const dir = await temp();
    const before = sha(await readFile(legacy));
    const out = join(dir, "converted.xcursus");
    const r = await cli("pack", legacy, "--out", out);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain("from a legacy .spatialdeck archive");
    expect(sha(await readFile(legacy))).toBe(before);
    const a = JSON.parse((await cli("validate", legacy, "--json")).out);
    const b = JSON.parse((await cli("validate", out, "--json")).out);
    expect(b).toMatchObject({ ok: true, archiveFormat: "current" });
    expect(b.resources).toEqual(a.resources);
    // The converted archive packs again to the same resources.
    const again = join(dir, "again.xcursus");
    expect((await cli("pack", out, "--out", again)).code).toBe(0);
    expect(
      JSON.parse((await cli("validate", again, "--json")).out).resources,
    ).toEqual(a.resources);
  });
  it("packs a JSON project with its assets, migrating a historical schema and keeping notes", async () => {
    const { dir, project, doc } = await fixture();
    const out = join(dir, "deck.xcursus");
    const r = await cli("pack", project, "--out", out);
    expect(r.code, r.err).toBe(0);
    const report = JSON.parse((await cli("validate", out, "--json")).out);
    expect(report.resources).toEqual([
      expect.objectContaining({
        id: "orbit",
        status: "verified",
        sha256: doc.assets[0]!.sha256,
      }),
    ]);
    const old = await cli(
      "pack",
      join(root, "core-three-scenes/project.json"),
      "--out",
      join(dir, "three.xcursus"),
    );
    expect(old.code, old.err).toBe(0);
    expect(old.out).toContain("migrated from 1.0.0");
    // Private notes are authoring data: pack keeps them (exports drop them).
    const { readArchive } = await import("@xcursus/plugins/archive");
    const packed = await readArchive(
      new Blob([await readFile(join(dir, "three.xcursus"))]),
    );
    expect(packed.document.scenes[0]!.notes).toBe("Open the talk");
    expect(packed.sourceSchemaVersion).toBe("1.3.0");
  });
  it("refuses other extensions, existing outputs, the input itself and missing assets", async () => {
    const { dir, project } = await fixture();
    const wrong = await cli("pack", project, "--out", join(dir, "deck.zip"));
    expect(wrong.code).toBe(1);
    expect(wrong.err).toContain("must name a .xcursus file");
    expect(
      (await cli("pack", project, "--out", join(dir, "deck.spatialdeck"))).code,
    ).toBe(1);
    const out = join(dir, "deck.xcursus");
    expect((await cli("pack", project, "--out", out)).code).toBe(0);
    const first = sha(await readFile(out));
    const again = await cli("pack", project, "--out", out);
    expect(again.code).toBe(3);
    expect(sha(await readFile(out))).toBe(first);
    expect((await cli("pack", project, "--out", out, "--overwrite")).code).toBe(
      0,
    );
    const self = await cli("pack", out, "--out", out, "--overwrite");
    expect(self.code).toBe(3);
    expect(self.err).toContain("Refusing to replace the input project");
    await rm(join(dir, "assets/orbit.svg"));
    const missing = await cli(
      "pack",
      project,
      "--out",
      join(dir, "missing.xcursus"),
    );
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("ASSET_MISSING");
    expect(await readdir(dir)).not.toContain("missing.xcursus");
    expect(
      (await cli("pack", project, "--out", out, "--allow-partial")).code,
    ).toBe(1);
  });
  it("still honours the SPATIALDECK_FFMPEG variable of earlier releases", async () => {
    const { dir, project } = await fixture();
    const saved = {
      current: process.env.XCURSUS_FFMPEG,
      legacy: process.env.SPATIALDECK_FFMPEG,
    };
    delete process.env.XCURSUS_FFMPEG;
    process.env.SPATIALDECK_FFMPEG = join(dir, "no-ffmpeg");
    try {
      const r = await cli(
        "export",
        "video",
        project,
        "--itinerary",
        await itinerary(dir, { pathId: "main", visits: [{ nodeId: "n1" }] }),
        "--out",
        join(dir, "v.webm"),
      );
      expect(r.code).toBe(2);
      expect(r.err).toContain("ffmpeg not found");
    } finally {
      for (const [key, value] of [
        ["XCURSUS_FFMPEG", saved.current],
        ["SPATIALDECK_FFMPEG", saved.legacy],
      ] as const)
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
  });
});

/**
 * A kit with a stand-in runtime: unit tests run before the build, so the real
 * runtime is compared by the E2E suite (export.spec.ts), not here.
 */
const testKit: ExportKit = {
  version: "0.0.0-test",
  script: 'document.body.dataset.runtime = "</script><!-- inert";',
  notices: "Third-party notices",
  stylesheets: {
    player: { css: ".xc-player{display:block}", fonts: [] },
    fonts: { css: "@font-face{font-family:x}", fonts: [] },
    katex: { css: ".katex{display:inline}", fonts: [] },
  },
};

describe("HTML pipeline shared with Studio", () => {
  it("writes a self-checked page: CSP hashes, safe inline script, no notes", async () => {
    const { project } = await fixture();
    const loaded = await loadProject(project);
    const result = await standaloneHtml({
      document: loaded.document,
      resources: loaded.resources,
      blobs: loaded.blobs,
      kit: testKit,
      allowPartial: false,
      generator: "XCursus CLI test",
    });
    if (!result.ok) throw new Error("refused");
    expect(result.status).toBe("complete");
    expect(result.verification).toEqual({
      jsonBlocksParse: true,
      scriptCount: 4,
      cspHashesMatchInlineCode: true,
      privateNotesAbsent: true,
    });
    expect(result.csp).toContain("connect-src 'none'");
    // The stand-in runtime cannot close its element or open a comment.
    expect(result.html).toContain("\\x3C/script>\\x3C!-- inert");
    expect(result.html).not.toContain("PRIVATE-NOTE");
    // Only the stylesheets the fixture needs (theme font and a formula).
    expect(result.html).toContain("/* fonts.css */");
    expect(result.html).toContain("/* katex.css */");
    expect(result.needed.size).toBe(1);
  });
  it("verifies in-memory assets like the CLI: missing and altered bytes are reported", async () => {
    const { project } = await fixture();
    const loaded = await loadProject(project);
    const [id, blob] = [...loaded.blobs][0]!;
    const all = await verifyResources(loaded.document, loaded.blobs);
    expect(all.resources.map((r) => r.status)).toEqual(
      loaded.resources.map((r) => r.status),
    );
    expect(all.resources.map((r) => r.sha256)).toEqual(
      loaded.resources.map((r) => r.sha256),
    );
    const missing = await verifyResources(loaded.document, new Map());
    expect(missing.resources.find((r) => r.id === id)?.diagnostic?.code).toBe(
      "ASSET_MISSING",
    );
    const altered = await verifyResources(
      loaded.document,
      new Map([[id, new Blob([await blob.text(), " "])]]),
    );
    expect(altered.resources.find((r) => r.id === id)?.status).toBe("invalid");
    expect(altered.blobs.has(id)).toBe(false);
  });
  it("is strict by default and marks a placeholder export as partial", async () => {
    const { project } = await fixture((d) =>
      d.scenes[1]!.blocks.push({
        id: "web",
        type: "embed",
        data: { url: "https://example.org/", title: "Remote" },
      }),
    );
    const loaded = await loadProject(project);
    const input = {
      document: loaded.document,
      resources: loaded.resources,
      blobs: loaded.blobs,
      kit: testKit,
      generator: "XCursus Studio test",
    };
    const strict = await standaloneHtml({ ...input, allowPartial: false });
    expect(strict.ok).toBe(false);
    expect(strict.analysis.blocking.map((d) => d.code)).toEqual([
      "EMBED_REMOTE",
    ]);
    const partial = await standaloneHtml({ ...input, allowPartial: true });
    if (!partial.ok) throw new Error("refused");
    expect(partial.status).toBe("partial");
    expect(partial.warnings.map((d) => d.code)).toContain("EMBED_REMOTE");
    expect(partial.html).toContain(
      '<meta name="generator" content="XCursus Studio test">',
    );
    // The block stays in the public JSON; the runtime shows a placeholder.
    expect(partial.html).toContain('"placeholders":{"embed":"excluded"}');
  });
});

describe("CSP violations in the capture page", () => {
  it("blocked inline attributes only count; any other violation is an error", () => {
    // Chromium reports a style or on* attribute while the sanitizer parses
    // pasted markup, before stripping it: the output never contains it.
    expect(
      classifyViolations([
        { directive: "style-src-attr", blockedURI: "inline" },
        { directive: "script-src-attr", blockedURI: "inline" },
        { directive: "style-src-attr", blockedURI: "inline" },
      ]),
    ).toEqual({ blockedAttributes: 3, errors: [] });
    const other = classifyViolations([
      { directive: "style-src-attr", blockedURI: "inline" },
      { directive: "script-src-elem", blockedURI: "inline" },
      { directive: "img-src", blockedURI: "https://example.org/x.png" },
    ]);
    expect(other.blockedAttributes).toBe(1);
    expect(other.errors).toEqual([
      "Content Security Policy blocked inline (script-src-elem)",
      "Content Security Policy blocked https://example.org/x.png (img-src)",
    ]);
  });
});

describe("remote references in markup", () => {
  it("code in Markdown and CSS words in prose are text, not remote resources", () => {
    // A deck about web or notation formats names tags and CSS in its code.
    expect(
      referencesRemote(
        "markdown",
        "Avoid `@import` and `<script>`; `<link rel=stylesheet href=//x>`.\n\n" +
          '```html\n<link rel="stylesheet" href="https://e/f.css">\n<iframe src="https://e"></iframe>\n```\n\n' +
          "~~~~\n![remote](https://e/a.png)\n~~~~\n\n``a `<script>` b``",
      ),
    ).toBe(false);
    expect(
      referencesRemote(
        "html",
        "<p>Use @import or url(https://e/f.css) only in a stylesheet.</p>",
      ),
    ).toBe(false);
    // Still remote: markup outside code, CSS inside a style element or attribute.
    for (const [type, source] of [
      ["markdown", "Text\n\n![remote](https://e/a.png)"],
      ["markdown", '`code` then <iframe src="https://e"></iframe>'],
      ["markdown", '<span style="background:url(https://e/a.png)">x</span>'],
      ["html", '<link rel="stylesheet" href="https://e/f.css">'],
      ["html", "<style>@font-face{src:url(https://e/a.woff2)}</style>"],
      ["html", "<style>@import 'theme.css';</style>"],
      ["html", "<p style=\"background:url('//e/a.png')\">x</p>"],
      ["svg", '<svg><image href="https://e/a.png"/></svg>'],
    ] as const)
      expect(referencesRemote(type, source), source).toBe(true);
  });
});

describe("animated images in a capture", () => {
  it("recognizes GIF with several frames, APNG and animated WebP, not their still forms", async () => {
    const b64 = (text: string) => new Uint8Array(Buffer.from(text, "base64"));
    // Two-frame 2×2 images and their single-frame forms (Pillow).
    const gif = b64(
      "R0lGODdhAgACAIEAAP8AAAAAAAAAAAAAACwAAAAAAgACAAAIBgABCAQQEAA7",
    );
    const animatedGif = b64(
      "R0lGODlhAgACAIEAAP8AAAAAAAAAAAAAACH/C05FVFNDQVBFMi4wAwEAAAAh+QQACgAAACwAAAAAAgACAAAIBgABCAQQEAAh+QQBCgABACwAAAAAAgACAIEAAP8AAAAAAAAAAAAIBgABCAQQEAA7",
    );
    const apng = b64(
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACGFjVEwAAAACAAAAAPONk3AAAAAaZmNUTAAAAAAAAAACAAAAAgAAAAAAAAAAAGQD6AAAAVWPHQAAABZJREFUeJxj/M/AwMDAwMTAwMDAwAAADR0BA2rCm+kAAAAaZmNUTAAAAAEAAAACAAAAAgAAAAAAAAAAAGQD6AAAmiZlyQAAABpmZEFUAAAAAnicY2Rg+M/AwMDEwMDAwMAAAAsfAQM5oA0PAAAAAElFTkSuQmCC",
    );
    const animatedWebp = b64(
      "UklGRoQAAABXRUJQVlA4WAoAAAACAAAAAQAAAQAAQU5JTQYAAAAAAAAAAABBTk1GKAAAAAAAAAAAAAEAAAEAAGQAAAJWUDhMDwAAAC8BQAAABxD9j/4HIqL/AQBBTk1GKAAAAAAAAAAAAAEAAAEAAGQAAABWUDhMDwAAAC8BQAAABxDR//4HIqL/AQA=",
    );
    const png = b64(
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==",
    );
    // Extended WebP (VP8X) with alpha only: the animation flag is clear.
    const webp = b64(
      "UklGRlwAAABXRUJQVlA4WAoAAAAQAAAAAQAAAQAAQUxQSAUAAAAAgICAgABWUDggMAAAANABAJ0BKgIAAgABQCYloAJ0ugH4AAOwAP7y63/82BXNc+/3/9Lg/S4P0uD/0pAAAA==",
    );
    expect(isAnimatedImage(animatedGif, "image/gif")).toBe(true);
    expect(isAnimatedImage(apng, "image/png")).toBe(true);
    expect(isAnimatedImage(animatedWebp, "image/webp")).toBe(true);
    expect(isAnimatedImage(gif, "image/gif")).toBe(false);
    expect(isAnimatedImage(png, "image/png")).toBe(false);
    expect(isAnimatedImage(webp, "image/webp")).toBe(false);
    expect(isAnimatedImage(apng, "image/jpeg")).toBe(false);
  });
});
