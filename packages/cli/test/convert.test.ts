import { createHash } from "node:crypto";
import {
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
import { validateDocument } from "@xcursus/core";
import { run } from "../src/index.js";
import { loadProject } from "../src/io.js";
import type { ConvertReport } from "../src/convert.js";

const example = new URL("../../../examples/impress-import/", import.meta.url)
  .pathname;
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
async function temp() {
  const dir = await mkdtemp(join(tmpdir(), "xcursus-convert-test-"));
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
async function copyExample() {
  const dir = await temp();
  await mkdir(join(dir, "images"));
  for (const file of ["deck.html", "images/ring.png", "images/axes.svg"])
    await copyFile(join(example, file), join(dir, file));
  return dir;
}

describe("xcursus convert impress", () => {
  it("writes a JSON candidate with its assets and a report, leaving the input intact", async () => {
    const dir = await copyExample();
    const out = await temp();
    const before = await readFile(join(dir, "deck.html"));
    const result = await cli(
      "convert",
      "impress",
      join(dir, "deck.html"),
      "--out",
      join(out, "deck.json"),
      "--profile",
      "bundle",
    );
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain("6 scenes");
    expect(result.err).toContain("warning RESOURCE_REMOTE");
    expect(await readFile(join(dir, "deck.html"))).toEqual(before);
    expect((await readdir(out)).sort()).toEqual([
      "deck.json",
      "deck.json.report.json",
      "images",
    ]);
    expect(await readFile(join(out, "images/ring.png"))).toEqual(
      await readFile(join(dir, "images/ring.png")),
    );
    // The candidate is an ordinary project: the CLI loads and verifies it.
    const project = await loadProject(join(out, "deck.json"));
    expect(project.resources.map((r) => [r.path, r.status])).toEqual([
      ["images/ring.png", "verified"],
      ["images/axes.svg", "verified"],
    ]);
    const validate = await cli("validate", join(out, "deck.json"));
    expect(validate.code).toBe(0);
    const report = JSON.parse(
      await readFile(join(out, "deck.json.report.json"), "utf8"),
    ) as ConvertReport;
    expect(report.input.sha256).toBe(sha(before));
    expect(report.output.sha256).toBe(
      sha(await readFile(join(out, "deck.json"))),
    );
    expect(report.profile).toBe("bundle");
    expect(report.profileExplicit).toBe(true);
    expect(report.baseline.commit).toBe(
      "dc3cf69747e0b1b0d1fe534509d09c3c48030e68",
    );
    expect(report.summary).toMatchObject({
      scenes: 6,
      nodes: 6,
      assets: 2,
      errors: 0,
    });
    expect(report.steps.map((s) => s.stepId)).toEqual([
      "welcome",
      "beside",
      "below",
      "depth",
      "sources",
      "overview",
    ]);
    const codes = report.diagnostics.map((d) => d.code);
    for (const code of [
      "CSS_NOT_CONVERTED",
      "STYLESHEET_IGNORED",
      "SCRIPT_RESOURCE_IGNORED",
      "SCRIPT_REMOVED",
      "SUBSTEP_FLATTENED",
      "NOTES_IMPORTED",
      "LINK_DROPPED",
      "RESOURCE_REMOTE",
      "STEP_SIZE_DEFAULT",
    ])
      expect(codes, code).toContain(code);
    expect(report.css.join("\n")).toContain(".step:not(.active)");
    expect(
      report.resources.find((r) => r.reference === "js/impress.js"),
    ).toMatchObject({
      kind: "script",
      status: "ignored",
    });
    const doc = JSON.parse(await readFile(join(out, "deck.json"), "utf8"));
    expect(validateDocument(doc).ok).toBe(true);
    expect(doc.scenes[0].notes).toBe(
      "Introduce the idea of a canvas larger than the screen.",
    );
    expect(
      doc.assets.every((a: { sha256?: string }) =>
        /^[a-f0-9]{64}$/.test(a.sha256!),
      ),
    ).toBe(true);
  });

  it("writes a .xcursus archive that opens like any other", async () => {
    const dir = await copyExample();
    const out = join(await temp(), "deck.xcursus");
    const result = await cli(
      "convert",
      "impress",
      join(dir, "deck.html"),
      "--out",
      out,
    );
    expect(result.code, result.err).toBe(0);
    expect(result.out).toContain("profile bundle, assumed");
    const project = await loadProject(out);
    expect(project.kind).toBe("archive");
    expect(project.document.scenes).toHaveLength(6);
    expect(project.blobs.size).toBe(2);
  });

  it("next to the HTML, identical assets are not rewritten", async () => {
    const dir = await copyExample();
    const result = await cli(
      "convert",
      "impress",
      join(dir, "deck.html"),
      "--out",
      join(dir, "deck.json"),
    );
    expect(result.code, result.err).toBe(0);
    expect((await readdir(join(dir, "images"))).sort()).toEqual([
      "axes.svg",
      "ring.png",
    ]);
  });

  it("refuses existing outputs without --overwrite, and the input always", async () => {
    const dir = await copyExample();
    const out = join(dir, "deck.json");
    expect(
      (await cli("convert", "impress", join(dir, "deck.html"), "--out", out))
        .code,
    ).toBe(0);
    const json = await readFile(out);
    const again = await cli(
      "convert",
      "impress",
      join(dir, "deck.html"),
      "--out",
      out,
    );
    expect(again.code).toBe(3);
    expect(again.err).toContain("already exists");
    expect(await readFile(out)).toEqual(json);
    expect(
      (
        await cli(
          "convert",
          "impress",
          join(dir, "deck.html"),
          "--out",
          out,
          "--overwrite",
        )
      ).code,
    ).toBe(0);
    // A different file where an asset would go is never silently replaced.
    const other = await temp();
    await mkdir(join(other, "images"));
    await writeFile(join(other, "images/ring.png"), "different");
    const clash = await cli(
      "convert",
      "impress",
      join(dir, "deck.html"),
      "--out",
      join(other, "deck.json"),
    );
    expect(clash.code).toBe(3);
    expect(clash.err).toContain("different file");
    expect(await readdir(other)).toEqual(["images"]);
    expect(await readFile(join(other, "images/ring.png"), "utf8")).toBe(
      "different",
    );
    // The input itself, even with --overwrite.
    const html = join(dir, "copy.json");
    await copyFile(join(dir, "deck.html"), html);
    const self = await cli(
      "convert",
      "impress",
      html,
      "--out",
      html,
      "--overwrite",
    );
    expect(self.code).toBe(3);
    expect(self.err).toContain("input");
  });

  it("reads only confined local files and never follows links out of the folder", async () => {
    const dir = await temp();
    const outside = await temp();
    await writeFile(
      join(outside, "secret.png"),
      await readFile(join(example, "images/ring.png")),
    );
    await symlink(join(outside, "secret.png"), join(dir, "linked.png"));
    await writeFile(
      join(dir, "deck.html"),
      `<!doctype html><div id="impress"><div class="step">
        <img src="linked.png" alt="a"><img src="../${outside.split("/").at(-1)}/secret.png" alt="b">
        <img src="/etc/hosts" alt="c"></div></div>`,
    );
    const out = join(await temp(), "deck.json");
    const result = await cli(
      "convert",
      "impress",
      join(dir, "deck.html"),
      "--out",
      out,
    );
    expect(result.code, result.err).toBe(0);
    const report = JSON.parse(
      await readFile(`${out}.report.json`, "utf8"),
    ) as ConvertReport;
    expect(report.summary.assets).toBe(0);
    expect(report.resources.map((r) => r.status)).toEqual([
      "missing",
      "outside",
      "outside",
    ]);
  });

  it("structural errors and bad arguments write nothing", async () => {
    const dir = await temp();
    await writeFile(
      join(dir, "plain.html"),
      "<!doctype html><p>not a deck</p>",
    );
    const out = join(dir, "out.json");
    const noRoot = await cli(
      "convert",
      "impress",
      join(dir, "plain.html"),
      "--out",
      out,
    );
    expect(noRoot.code).toBe(1);
    expect(noRoot.err).toContain("IMPRESS_ROOT_MISSING");
    expect(await readdir(dir)).toEqual(["plain.html"]);
    for (const argv of [
      ["convert", "pptx", "x.html", "--out", out],
      [
        "convert",
        "impress",
        join(dir, "plain.html"),
        "--out",
        join(dir, "x.pdf"),
      ],
      [
        "convert",
        "impress",
        join(dir, "plain.html"),
        "--out",
        join(dir, "x.spatialdeck"),
      ],
      [
        "convert",
        "impress",
        join(dir, "plain.html"),
        "--out",
        out,
        "--profile",
        "full",
      ],
      [
        "convert",
        "impress",
        join(dir, "plain.html"),
        "--out",
        out,
        "--fps",
        "30",
      ],
      ["convert", "impress", join(dir, "missing.html"), "--out", out],
      ["convert", "impress", "--out", out],
    ]) {
      const r = await cli(...argv);
      expect(r.code, argv.join(" ")).toBe(1);
    }
    expect(await readdir(dir)).toEqual(["plain.html"]);
    const missingDir = await cli(
      "convert",
      "impress",
      join(example, "deck.html"),
      "--out",
      join(dir, "nope", "deck.json"),
    );
    expect(missingDir.code).toBe(3);
  });

  it("is listed in the help", async () => {
    const help = await cli("--help");
    expect(help.out).toContain("xcursus convert impress <input.html>");
  });
});
