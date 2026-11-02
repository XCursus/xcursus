import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { validateDocument } from "@xcursus/core";
import { IMPORT_CODES, importImpress } from "@xcursus/impress-compat";
import { candidate, deck } from "./helpers.js";
import { landmarks, screenPoint, stepPoint } from "./oracle.js";
import type { Pose } from "./oracle.js";
import {
  resolveSceneCamera,
  projectScenePoint,
  sceneToWorld,
} from "@xcursus/core";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/upstream/${name}`, import.meta.url), "utf8");
const codes = (list: Array<{ code: string }>) => list.map((d) => d.code);

describe("structure, IDs and DOM hierarchy", () => {
  test("missing, duplicate and invalid IDs get stable scene IDs", () => {
    const c = candidate(
      deck(
        [
          `<div class="step">no id</div>`,
          `<div class="step" id="dup">first</div>`,
          `<div class="step" id="dup">second</div>`,
          `<div class="step" id="step-1">explicit</div>`,
          `<div class="step" id="été 1">accent</div>`,
          `<div class="step" id="${"x".repeat(120)}">long</div>`,
        ].join(""),
      ),
    );
    expect(c.document.scenes.map((s) => s.id)).toEqual([
      "step-1",
      "dup",
      "dup-2",
      "step-1-2",
      "ete-1",
      "x".repeat(96),
    ]);
    expect(c.steps.map((s) => s.stepId)).toEqual([
      "step-1",
      "dup",
      "dup",
      "step-1",
      "été 1",
      "x".repeat(120),
    ]);
    const find = (code: string) =>
      c.diagnostics.filter((d) => d.code === code).map((d) => d.pointer);
    expect(find("STEP_ID_GENERATED")).toEqual(["/scenes/0/id"]);
    expect(find("STEP_ID_DUPLICATE")).toEqual(["/scenes/2/id"]);
    expect(find("STEP_ID_RENAMED")).toEqual([
      "/scenes/3/id",
      "/scenes/4/id",
      "/scenes/5/id",
    ]);
    // Node IDs follow scene IDs; the path keeps document order.
    expect(c.document.paths[0]!.nodes.map((n) => n.id)).toEqual(
      c.document.scenes.map((s) => s.id),
    );
    // Original IDs travel with the scenes.
    expect(c.document.scenes[4]!.extensions["xcursus.impress"]).toEqual({
      version: "1.0.0",
      data: { stepId: "été 1", index: 4 },
    });
  });

  test("wrappers, nested steps, steps outside the root and root content", () => {
    const html = `<!doctype html><html><body>
      <div class="step" id="outside">outside</div>
      <div id="impress">loose text
        <section class="group"><div class="step" id="wrapped" data-x="100">wrapped</div></section>
        <div class="step" id="parent" data-x="1000"><p>parent text</p>
          <div class="step" id="child" data-x="1200" data-y="50">child text</div>
        </div>
      </div></body></html>`;
    const c = candidate(html);
    expect(c.document.scenes.map((s) => s.id)).toEqual([
      "wrapped",
      "parent",
      "child",
    ]);
    const parentSource = JSON.stringify(c.document.scenes[1]!.blocks);
    expect(parentSource).toContain("parent text");
    expect(parentSource).not.toContain("child text");
    expect(JSON.stringify(c.document.scenes[2]!.blocks)).toContain(
      "child text",
    );
    // The nested step sits at its own coordinates, where the upstream camera goes.
    expect(c.document.scenes[2]!.position).toEqual([1200, 50, 0]);
    expect(c.document.scenes.every((s) => s.parentId === null)).toBe(true);
    const all = codes(c.diagnostics);
    for (const code of [
      "STEP_OUTSIDE_ROOT",
      "STEP_NESTED",
      "ROOT_CONTENT_IGNORED",
      "LANGUAGE_ASSUMED",
    ])
      expect(all).toContain(code);
    expect(c.document.metadata.language).toBe("en");
  });

  test("quirks mode matches the step class case-insensitively, as browsers do", () => {
    const quirks = importImpress(
      `<html><body><div id="impress"><div class="STEP">a</div></div></body></html>`,
      { profile: "core" },
    );
    expect(quirks.ok && quirks.value.document.scenes).toHaveLength(1);
    const standard = importImpress(
      `<!doctype html><html><body><div id="impress"><div class="STEP">a</div></div></body></html>`,
    );
    expect(standard.ok).toBe(false);
    expect(codes(standard.diagnostics)).toEqual(["IMPRESS_NO_STEPS"]);
  });

  test("structural errors return no candidate", () => {
    const cases: Array<[string, Parameters<typeof importImpress>[1], string]> =
      [
        [`<p>no root</p>`, {}, "IMPRESS_ROOT_MISSING"],
        [deck(""), {}, "IMPRESS_NO_STEPS"],
        [
          deck(`<div class="step">a</div>`),
          { rootId: "other" },
          "IMPRESS_ROOT_MISSING",
        ],
        [
          deck(`<div class="step">a</div>`),
          { baseline: "1.1.0" as "2.0.0" },
          "BASELINE_UNSUPPORTED",
        ],
        [
          deck(`<div class="step">a</div>`),
          { profile: "full" as "core" },
          "OPTIONS_INVALID",
        ],
        [
          deck(`<div class="step">a</div>`.repeat(1001)),
          {},
          "IMPRESS_TOO_MANY_STEPS",
        ],
        ["<div>".repeat(600) + "x", {}, "HTML_TOO_DEEP"],
        [" ".repeat(10 * 1024 * 1024 + 1), {}, "HTML_TOO_LARGE"],
      ];
    for (const [html, options, code] of cases) {
      const result = importImpress(html, options);
      expect(result.ok, code).toBe(false);
      expect(codes(result.diagnostics), code).toContain(code);
    }
  });

  test("a custom root ID is honoured", () => {
    const c = candidate(
      `<!doctype html><div id="deck"><div class="step">x</div></div>`,
      { rootId: "deck", profile: "core" },
    );
    expect(c.document.scenes).toHaveLength(1);
  });

  test("skip steps leave the path in the bundle, with skip-plugin durations", () => {
    const html = deck(
      [
        `<div class="step skip" id="first">shown at start</div>`,
        `<div class="step" id="a" data-x="1">a</div>`,
        `<div class="step skip" id="s1" data-x="2" data-transition-duration="300">s1</div>`,
        `<div class="step skip" id="s2" data-x="3">s2</div>`,
        `<div class="step" id="b" data-x="4">b</div>`,
        `<div class="step skip" id="s3" data-x="5">s3</div>`,
        `<div class="step" id="c" data-x="6" data-transition-duration="700">c</div>`,
      ].join(""),
    );
    const bundle = candidate(html, { profile: "bundle" });
    const path = bundle.document.paths[0]!;
    expect(path.nodes.map((n) => n.id)).toEqual(["first", "a", "b", "c"]);
    expect(path.edges.map((e) => e.transition.durationMs)).toEqual([
      1000, 300, 700,
    ]);
    expect(bundle.steps.filter((s) => !s.nodeId).map((s) => s.stepId)).toEqual([
      "s1",
      "s2",
      "s3",
    ]);
    expect(bundle.document.scenes).toHaveLength(7);
    const core = candidate(html, { profile: "core" });
    expect(core.document.paths[0]!.nodes).toHaveLength(7);
    // Unspecified profile: the skip class is one of the ambiguities.
    expect(codes(candidate(html, {}).diagnostics)).toContain(
      "PROFILE_AMBIGUOUS",
    );
  });

  test("plugin attributes and classes are reported, not converted", () => {
    const c = candidate(
      deck(
        `<div class="step stop" data-goto-next="b" data-autoplay="5">a</div>` +
          `<div class="step markdown" id="b">## b</div>`,
        ` data-autoplay="7" data-max-scale="2"`,
      ),
    );
    const all = codes(c.diagnostics);
    expect(
      all.filter((code) => code === "PLUGIN_ATTRIBUTE_IGNORED"),
    ).toHaveLength(4);
    expect(all).toContain("MARKDOWN_NOT_RENDERED");
    expect(all).toContain("WINDOW_SCALE_LIMITS_IGNORED");
  });

  test("every emitted code is declared with its severity", () => {
    const html = fixture("demo.html");
    const result = importImpress(html, { profile: "bundle" });
    expect(result.ok).toBe(true);
    for (const d of result.diagnostics)
      expect(d.severity).toBe(
        IMPORT_CODES[d.code as keyof typeof IMPORT_CODES],
      );
  });
});

/** Expected poses read by hand from the upstream example markup (tag v2.0.0). */
const upstream: Record<
  string,
  {
    config: { width: number; height: number; perspective: number };
    poses: Pose[];
  }
> = {
  "demo.html": {
    config: { width: 1024, height: 768, perspective: 1000 },
    poses: (
      [
        [[-1000, -1500, 0], 0, 1],
        [[0, -1500, 0], 0, 1],
        [[1000, -1500, 0], 0, 1],
        [[0, 0, 0], 0, 4],
        [[850, 3000, 0], 90, 5],
        [[3500, 2100, 0], 180, 6],
        [[2825, 2325, -3000], 300, 1],
        [[3500, -850, 0], 270, 6],
        [[6700, -300, 0], 0, 6],
        [[6300, 2000, 0], 20, 4],
        [[6000, 4000, 0], 0, 2],
        [[6200, 4300, -100], [-40, 10, 0], 2],
        [[3000, 1500, 0], 0, 10],
      ] as Array<
        [[number, number, number], number | [number, number, number], number]
      >
    ).map(([t, r, s]) => ({
      translate: t,
      rotate: Array.isArray(r)
        ? { x: r[0], y: r[1], z: r[2], order: "xyz" }
        : { x: 0, y: 0, z: r, order: "xyz" },
      scale: s,
    })),
  },
  "cube.html": {
    config: { width: 1920, height: 1080, perspective: 1000 },
    poses: (
      [
        [
          [0, 0, 350],
          [0, 0, 0],
        ],
        [
          [350, 0, 0],
          [0, 90, 0],
        ],
        [
          [0, 350, 0],
          [-90, 0, 90],
        ],
        [
          [0, -350, 0],
          [90, 0, -90],
        ],
        [
          [-350, 0, 0],
          [0, -90, -180],
        ],
        [
          [0, 0, -350],
          [0, -180, -180],
        ],
        [
          [700, -100, 1000],
          [0, 0, 0],
        ],
      ] as Array<[[number, number, number], [number, number, number]]>
    ).map(([t, r]) => ({
      translate: t,
      rotate: { x: r[0], y: r[1], z: r[2], order: "xyz" },
      scale: 1,
    })),
  },
  "3D-rotations.html": {
    config: { width: 1920, height: 1080, perspective: 1000 },
    poses: [
      {
        translate: [1350, 100, 100],
        rotate: { x: 0, y: 90, z: 0, order: "xyz" },
        scale: 3,
      },
      {
        translate: [2018, 106, 3018],
        rotate: { x: 0, y: 0, z: 0, order: "xyz" },
        scale: 2,
      },
      {
        translate: [0, 0, 0],
        rotate: { x: 0, y: 0, z: 0, order: "xyz" },
        scale: 1,
      },
      ...(
        [
          [[420, -70, -250], 45, -45],
          [[700, 350, -350], 90, -90],
          [[422, 780, -250], 135, -135],
          [[0, 702, 0], 180, -180],
          [[379, 780, 270], 135, -225],
          [[700, 350, 350], 90, -270],
          [[379, -70, 270], 45, -315],
        ] as Array<[[number, number, number], number, number]>
      ).map(([t, z, y]) => ({
        translate: t,
        rotate: { x: 0, y, z, order: "zyx" },
        scale: 1,
      })),
    ] as Pose[],
  },
};

describe("upstream example decks (impress.js v2.0.0)", () => {
  for (const [name, { config, poses }] of Object.entries(upstream))
    test(`${name}: geometry and camera match the oracle`, () => {
      const result = importImpress(fixture(name), { profile: "bundle" });
      if (!result.ok) throw new Error(JSON.stringify(result.diagnostics));
      const doc = result.value.document;
      expect(validateDocument(doc).ok).toBe(true);
      expect(doc.settings.viewport).toEqual(config);
      expect(doc.scenes).toHaveLength(poses.length);
      let compared = 0;
      doc.scenes.forEach((scene, i) => {
        for (const point of landmarks(scene.size)) {
          const world = sceneToWorld(doc, scene.id, point);
          const want = stepPoint(poses[i]!, scene.size, point);
          expect(world.ok).toBe(true);
          if (world.ok)
            world.value.forEach((v, axis) => {
              expect(Math.abs(v - want[axis]!)).toBeLessThanOrEqual(
                1e-6 * Math.max(1, Math.abs(want[axis]!)),
              );
              compared++;
            });
        }
      });
      for (const [a, active] of poses.entries()) {
        const camera = resolveSceneCamera(doc, doc.scenes[a]!.id);
        if (!camera.ok) throw new Error("camera");
        doc.scenes.forEach((scene, j) => {
          for (const point of landmarks(scene.size)) {
            const want = screenPoint(
              active,
              stepPoint(poses[j]!, scene.size, point),
              config,
              [config.width, config.height],
            );
            const got = projectScenePoint(doc, scene.id, camera.value, point);
            if (!want) {
              expect(got.ok).toBe(false);
              continue;
            }
            expect(got.ok).toBe(true);
            if (got.ok)
              got.value.forEach((v, axis) => {
                expect(Math.abs(v - want[axis]!)).toBeLessThanOrEqual(
                  1e-6 * Math.max(1, Math.abs(want[axis]!)),
                );
                compared++;
              });
          }
        });
      }
      expect(compared).toBeGreaterThan(100);
    });

  test("demo.html: content, notes-free text, plugins and resources are reported", () => {
    const result = importImpress(fixture("demo.html"), { profile: "bundle" });
    if (!result.ok) throw new Error("import");
    const { document, diagnostics, resources } = result.value;
    const all = codes(diagnostics);
    expect(document.scenes[3]!.title).toContain("impress.js");
    expect(all).toContain("STYLESHEET_IGNORED");
    expect(all).toContain("SCRIPT_RESOURCE_IGNORED");
    expect(all).toContain("PLUGIN_ATTRIBUTE_IGNORED");
    expect(all).toContain("WINDOW_SCALE_LIMITS_IGNORED");
    expect(
      resources.some(
        (r) => r.kind === "script" && r.reference === "js/impress.js",
      ),
    ).toBe(true);
    // The fallback message of the demo lives outside the root.
    expect(JSON.stringify(document)).not.toContain("<script");
  });

  test("3D-positions.html: relative positioning is reported as not reproduced", () => {
    const result = importImpress(fixture("3D-positions.html"), {
      profile: "bundle",
    });
    if (!result.ok) throw new Error("import");
    expect(result.value.document.settings.viewport).toMatchObject({
      width: 2000,
      height: 1500,
    });
    expect(codes(result.diagnostics)).toContain("REL_POSITION_RELATIVE");
  });
});
