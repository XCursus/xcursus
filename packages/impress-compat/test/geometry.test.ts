import { describe, expect, test } from "vitest";
import {
  cameraPose,
  projectScenePoint,
  resolveSceneCamera,
  sceneToWorld,
} from "@xcursus/core";
import type { CameraPose, ProjectDocument } from "@xcursus/core";
import type { ImportCandidate } from "@xcursus/impress-compat";
import { candidate, deck } from "./helpers.js";
import { landmarks, screenPoint, stepPoint } from "./oracle.js";
import type { Pose } from "./oracle.js";

const TOLERANCE = 1e-6;
const close = (a: number, b: number) =>
  Math.abs(a - b) <= TOLERANCE * Math.max(1, Math.abs(b));

const codes = (c: ImportCandidate) => c.diagnostics.map((d) => d.code);
const p = (
  translate: [number, number, number],
  rotate: [number, number, number] = [0, 0, 0],
  scale = 1,
  order = "xyz",
): Pose => ({
  translate,
  rotate: { x: rotate[0], y: rotate[1], z: rotate[2], order },
  scale,
});

function cameraFor(doc: ProjectDocument, sceneId: string): CameraPose {
  const node = doc.paths[0]!.nodes.find((n) => n.sceneId === sceneId)!;
  if (node.camera) return cameraPose(node.camera);
  const fit = resolveSceneCamera(doc, sceneId);
  if (!fit.ok) throw new Error(sceneId);
  return fit.value;
}

/**
 * Compares the imported document with the oracle: every landmark of every
 * scene in world space, and its projection on screen with the camera at
 * every node, in a window of the configured size (window scale 1).
 */
function assertMatches(
  c: ImportCandidate,
  expected: Pose[],
  config: { width: number; height: number; perspective: number },
  { project = true }: { project?: boolean } = {},
) {
  const doc = c.document;
  expect(doc.scenes).toHaveLength(expected.length);
  let compared = 0;
  doc.scenes.forEach((scene, i) => {
    const box = scene.size;
    for (const point of landmarks(box)) {
      const world = sceneToWorld(doc, scene.id, point);
      if (!world.ok) throw new Error(scene.id);
      const want = stepPoint(expected[i]!, box, point);
      world.value.forEach((v, axis) => {
        if (!close(v, want[axis]!))
          throw new Error(
            `${scene.id} landmark ${point} axis ${axis}: ${v} vs ${want[axis]}`,
          );
        compared++;
      });
    }
  });
  if (!project) return compared;
  for (const node of doc.paths[0]!.nodes) {
    const active =
      expected[doc.scenes.findIndex((s) => s.id === node.sceneId)]!;
    if (active.scale < 0) continue; // impress.js writes an invalid negative perspective there
    const camera = cameraFor(doc, node.sceneId);
    doc.scenes.forEach((scene, j) => {
      for (const point of landmarks(scene.size)) {
        const want = screenPoint(
          active,
          stepPoint(expected[j]!, scene.size, point),
          config,
          [config.width, config.height],
        );
        const got = projectScenePoint(doc, scene.id, camera, point);
        if (!want) {
          expect(got.ok, `${scene.id} behind the eye at ${node.id}`).toBe(
            false,
          );
          continue;
        }
        if (!got.ok) throw new Error(`${scene.id} at ${node.id} not projected`);
        got.value.forEach((v, axis) => {
          if (!close(v, want[axis]!))
            throw new Error(
              `${scene.id} at camera ${node.id}, landmark ${point}: ${v} vs ${want[axis]}`,
            );
          compared++;
        });
      }
    });
  }
  return compared;
}

describe("geometry against the impress.js 2.0.0 oracle", () => {
  const config = { width: 1600, height: 900, perspective: 1500 };
  const root = ` data-width="1600" data-height="900" data-perspective="1500"`;
  test("2D, 3D, scale, every rotation and the six rotation orders", () => {
    const angles = `data-rotate-x="30" data-rotate-y="45" data-rotate-z="60"`;
    const html = deck(
      [
        `<div class="step" id="origin">A</div>`,
        `<div class="step" id="move" data-x="1000" data-y="-500" data-z="300" data-rotate="90">B</div>`,
        `<div class="step" id="rx" data-x="2000" data-rotate-x="30">x</div>`,
        `<div class="step" id="ry" data-x="3000" data-rotate-y="-45">y</div>`,
        `<div class="step" id="rz" data-x="4000" data-rotate-z="200">z</div>`,
        `<div class="step" id="all" data-y="1000" ${angles}>all</div>`,
        ...["xyz", "xzy", "yxz", "yzx", "zxy", "zyx"].map(
          (order, i) =>
            `<div class="step" id="o-${order}" data-x="${i * 900}" data-y="2000" ${angles} data-rotate-order="${order}">${order}</div>`,
        ),
        `<div class="step" id="lock" data-y="3000" data-rotate-x="20" data-rotate-y="90" data-rotate-z="10" data-rotate-order="zyx">lock</div>`,
        `<div class="step" id="lock2" data-x="900" data-y="3000" data-rotate-x="90" data-rotate-y="90">lock2</div>`,
        `<div class="step" id="half" data-x="1800" data-y="3000" data-scale="0.5">half</div>`,
        `<div class="step" id="big" data-x="2700" data-y="3000" data-scale="3.25" data-rotate="-30">big</div>`,
        `<div class="step" id="mirror" data-x="3600" data-y="3000" data-scale="-2" data-rotate="30">mirror</div>`,
        `<div class="step" id="demo" data-x="-1234.5" data-y="987.25" data-z="-3000" data-rotate-x="-40" data-rotate-y="10" data-scale="2">3D</div>`,
      ].join(""),
      root,
    );
    const c = candidate(html);
    const angles3: [number, number, number] = [30, 45, 60];
    const expected: Pose[] = [
      p([0, 0, 0]),
      p([1000, -500, 300], [0, 0, 90]),
      p([2000, 0, 0], [30, 0, 0]),
      p([3000, 0, 0], [0, -45, 0]),
      p([4000, 0, 0], [0, 0, 200]),
      p([0, 1000, 0], angles3),
      ...["xyz", "xzy", "yxz", "yzx", "zxy", "zyx"].map((order, i) =>
        p([i * 900, 2000, 0], angles3, 1, order),
      ),
      p([0, 3000, 0], [20, 90, 10], 1, "zyx"),
      p([900, 3000, 0], [90, 90, 0]),
      p([1800, 3000, 0], [0, 0, 0], 0.5),
      p([2700, 3000, 0], [0, 0, -30], 3.25),
      p([3600, 3000, 0], [0, 0, 30], -2),
      p([-1234.5, 987.25, -3000], [-40, 10, 0], 2),
    ];
    const compared = assertMatches(c, expected, config);
    expect(compared).toBeGreaterThan(2500);
    expect(c.document.settings.viewport).toEqual({
      width: 1600,
      height: 900,
      perspective: 1500,
    });
    // Different source orders give different matrices: the Euler angles are not copied.
    const order = (id: string) =>
      c.document.scenes.find((s) => s.id === id)!.rotation;
    expect(order("o-xyz")).not.toEqual(order("o-zyx"));
    expect(order("o-xyz")).not.toEqual([30, 45, 60]);
    expect(order("o-zyx")).toEqual([30, 45, 60]);
    expect(codes(c)).toContain("SCALE_NEGATIVE");
    expect(c.document.scenes.find((s) => s.id === "mirror")!.scale).toBeCloseTo(
      2,
      12,
    );
    expect(c.document.paths[0]!.nodes.every((n) => !n.camera)).toBe(true);
  });

  test("defaults of the baseline and the default scene size", () => {
    const c = candidate(deck(`<div class="step">only</div>`));
    expect(c.document.settings.viewport).toEqual({
      width: 1920,
      height: 1080,
      perspective: 1000,
    });
    expect(c.document.scenes[0]!.size).toEqual([1728, 972]);
    expect(c.document.settings.presentation.defaultTransition).toEqual({
      durationMs: 1000,
      easing: "ease-in-out",
    });
    // The auto-fit camera equals the impress.js framing: zoom 1 / scale.
    const fit = resolveSceneCamera(c.document, "step-1");
    expect(fit.ok && fit.value.zoom).toBeCloseTo(1, 12);
  });

  test("inline sizes keep the impress.js framing with a node camera", () => {
    const html = deck(
      `<div class="step" id="a" style="width: 900px; height:700px">a</div>` +
        `<div class="step" id="b" data-x="1200" data-scale="2" data-rotate-y="30" style="width:600px;height:400px">b</div>` +
        `<div class="step" id="c" data-x="2400" style="width:900px;height:700px;padding:40px">c</div>`,
      root,
    );
    const c = candidate(html);
    expect(c.document.scenes.map((s) => s.size)).toEqual([
      [900, 700],
      [600, 400],
      [1440, 810],
    ]);
    const nodes = c.document.paths[0]!.nodes;
    expect(nodes[0]!.camera).toEqual({
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      zoom: 1,
    });
    expect(nodes[1]!.camera?.zoom).toBe(0.5);
    expect(nodes[2]!.camera).toBeUndefined();
    expect(c.document.requiredCapabilities).toContain("structure");
    assertMatches(
      c,
      [p([0, 0, 0]), p([1200, 0, 0], [0, 30, 0], 2), p([2400, 0, 0])],
      config,
    );
    expect(codes(c)).toContain("STEP_SIZE_INLINE");
    expect(codes(c)).toContain("STEP_SIZE_DEFAULT");
  });

  test("aliases and invalid or omitted values follow upstream coercion", () => {
    const html = deck(
      [
        `<div class="step" id="z-wins" data-rotate-z="30" data-rotate="60">1</div>`,
        `<div class="step" id="empty-z" data-rotate-z="" data-rotate="60">2</div>`,
        `<div class="step" id="bad-z" data-rotate-z="abc" data-rotate="60">3</div>`,
        `<div class="step" id="numbers" data-x="abc" data-y="1e3" data-z="0x10">4</div>`,
        `<div class="step" id="units" data-x=" 12 " data-y="1.5w" data-z="-0.5h">5</div>`,
        `<div class="step" id="scale-text" data-scale="abc">6</div>`,
        `<div class="step" id="partial" data-rotate-x="30" data-rotate-y="45" data-rotate-z="60" data-rotate-order="zx">7</div>`,
        `<div class="step" id="upper" data-rotate-x="30" data-rotate-y="45" data-rotate-order="ZYX">8</div>`,
        `<div class="step" id="repeat" data-rotate-x="30" data-rotate-y="45" data-rotate-z="60" data-rotate-order="xxy">9</div>`,
      ].join(""),
    );
    const c = candidate(html);
    assertMatches(
      c,
      [
        p([0, 0, 0], [0, 0, 30]),
        p([0, 0, 0], [0, 0, 60]),
        p([0, 0, 0], [0, 0, 0]),
        p([0, 1000, 16]),
        p([12, 2880, -540]),
        p([0, 0, 0]),
        p([0, 0, 0], [30, 45, 60], 1, "zx"),
        p([0, 0, 0], [30, 45, 0], 1, "xyz"),
        p([0, 0, 0], [30, 45, 60], 1, "xy"),
      ],
      { width: 1920, height: 1080, perspective: 1000 },
    );
    const at = (code: string) =>
      c.diagnostics.filter((d) => d.code === code).map((d) => d.pointer);
    expect(at("ROTATE_ALIAS_CONFLICT")).toEqual([
      "/scenes/0/rotation",
      "/scenes/1/rotation",
      "/scenes/2/rotation",
    ]);
    expect(at("ROTATE_ORDER_PARTIAL")).toEqual(["/scenes/6/rotation"]);
    expect(at("ROTATE_ORDER_INVALID")).toEqual([
      "/scenes/7/rotation",
      "/scenes/8/rotation",
    ]);
  });

  test("non-finite, zero and out-of-range values are diagnosed with a pointer", () => {
    const html = deck(
      [
        `<div class="step" id="inf" data-x="Infinity" data-rotate="10">1</div>`,
        `<div class="step" id="nan" data-x="--5w">2</div>`,
        `<div class="step" id="zero" data-scale="0">3</div>`,
        `<div class="step" id="tiny" data-scale="0.00001">4</div>`,
        `<div class="step" id="far" data-x="2000000">5</div>`,
        `<div class="step" id="slow" data-transition-duration="90000">6</div>`,
        `<div class="step" id="neg" data-transition-duration="-5">7</div>`,
        `<div class="step" id="frac" data-transition-duration="1500.5">8</div>`,
      ].join(""),
      ` data-perspective="0" data-width="0" data-transition-duration="abc"`,
    );
    const c = candidate(html);
    const find = (code: string) =>
      c.diagnostics.filter((d) => d.code === code).map((d) => d.pointer);
    expect(find("STEP_TRANSFORM_INVALID")).toEqual(["/scenes/0", "/scenes/1"]);
    expect(c.document.scenes[0]!.position).toEqual([0, 0, 0]);
    expect(find("SCALE_INVALID")).toEqual(["/scenes/2/scale"]);
    expect(c.document.scenes[2]!.scale).toBe(1);
    expect(find("SCALE_OUT_OF_RANGE")).toEqual(["/scenes/3/scale"]);
    expect(c.document.scenes[3]!.scale).toBeCloseTo(0.0001, 12);
    expect(find("POSITION_OUT_OF_RANGE")).toEqual(["/scenes/4/position/0"]);
    expect(c.document.scenes[4]!.position[0]).toBe(1000000);
    expect(find("PERSPECTIVE_INVALID")).toEqual([
      "/settings/viewport/perspective",
    ]);
    expect(c.document.settings.viewport.perspective).toBe(100000);
    expect(find("VIEWPORT_INVALID")).toEqual(["/settings/viewport/width"]);
    expect(c.document.settings.viewport.width).toBe(1920);
    // Root duration "abc" falls back to 1000 upstream; steps override it.
    const edges = c.document.paths[0]!.edges.map(
      (e) => e.transition.durationMs,
    );
    expect(edges).toEqual([1000, 1000, 1000, 1000, 60000, 0, 1501]);
    expect(find("DURATION_INVALID")).toEqual([
      "/paths/0/edges/4/transition/durationMs",
      "/paths/0/edges/5/transition/durationMs",
      "/paths/0/edges/6/transition/durationMs",
    ]);
    // In the bundle the rel plugin writes NaN back as text, which reads as 0.
    const bundled = candidate(html, { profile: "bundle" });
    expect(bundled.document.scenes[1]!.position).toEqual([0, 0, 0]);
    expect(
      bundled.diagnostics.filter((d) => d.code === "STEP_TRANSFORM_INVALID"),
    ).toHaveLength(1);
  });
});

describe("rel plugin of the bundle", () => {
  const html = deck(
    [
      `<div class="step" id="s1" data-x="100" data-y="200" data-rotate="10">1</div>`,
      `<div class="step" id="s2">2</div>`,
      `<div class="step" id="s3" data-rel-x="500">3</div>`,
      `<div class="step" id="s4">4</div>`,
      `<div class="step" id="s5" data-x="0" data-rel-y="300">5</div>`,
      `<div class="step" id="s6" data-rel-reset>6</div>`,
      `<div class="step" id="s7" data-rel-to="s3" data-rel-x="50">7</div>`,
      `<div class="step" id="s8" data-rel-rotate-y="45">8</div>`,
      `<div class="step" id="s9">9</div>`,
      `<div class="step" id="s10" data-rel-reset="all" data-rotate-x="20">10</div>`,
      `<div class="step" id="s11" data-rel-to="nope">11</div>`,
      `<div class="step" id="s12" data-rel-to="s13">12</div>`,
      `<div class="step" id="s13" data-rel-position="relative" data-rel-x="100">13</div>`,
    ].join(""),
  );
  // Derived by hand from src/plugins/rel/rel.js of the 2.0.0 tag.
  const bundle: Pose[] = [
    p([100, 200, 0], [0, 0, 10]),
    p([100, 200, 0]),
    p([600, 200, 0]),
    p([1100, 200, 0]),
    p([0, 500, 0]),
    p([0, 500, 0]),
    p([650, 200, 0]),
    p([700, 200, 0], [0, 45, 0]),
    p([750, 200, 0], [0, 45, 0]),
    p([750, 200, 0], [20, 0, 0]),
    p([750, 200, 0]),
    p([750, 200, 0]),
    p([850, 200, 0]),
  ];
  test("omitted coordinates, offsets, reset and data-rel-to", () => {
    const c = candidate(html, { profile: "bundle" });
    assertMatches(c, bundle, { width: 1920, height: 1080, perspective: 1000 });
    const find = (code: string) =>
      c.diagnostics.filter((d) => d.code === code).map((d) => d.pointer);
    expect(find("REL_TO_INVALID")).toEqual([
      "/scenes/10/position",
      "/scenes/11/position",
    ]);
    expect(find("REL_POSITION_RELATIVE")).toEqual(["/scenes/12/position"]);
    expect(codes(c)).not.toContain("PROFILE_AMBIGUOUS");
  });
  test("the core alone reads omitted coordinates as 0", () => {
    const c = candidate(html, { profile: "core" });
    assertMatches(
      c,
      [
        p([100, 200, 0], [0, 0, 10]),
        ...Array.from({ length: 3 }, () => p([0, 0, 0])),
        p([0, 0, 0]),
        ...Array.from({ length: 4 }, () => p([0, 0, 0])),
        p([0, 0, 0], [20, 0, 0]),
        ...Array.from({ length: 3 }, () => p([0, 0, 0])),
      ],
      { width: 1920, height: 1080, perspective: 1000 },
    );
  });
  test("without an explicit profile the ambiguity is reported", () => {
    const c = candidate(html, {});
    expect(c.profile).toBe("bundle");
    expect(c.profileExplicit).toBe(false);
    const ambiguous = c.diagnostics.find((d) => d.code === "PROFILE_AMBIGUOUS");
    expect(ambiguous?.severity).toBe("warning");
    expect(ambiguous?.message).toContain("s2");
    // A deck with explicit coordinates everywhere is not ambiguous.
    const plain = candidate(
      deck(
        `<div class="step" data-x="0">a</div><div class="step" data-x="5">b</div>`,
      ),
      {},
    );
    expect(codes(plain)).not.toContain("PROFILE_AMBIGUOUS");
  });
});
