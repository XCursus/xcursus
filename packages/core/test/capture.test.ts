import { describe, expect, it } from "vitest";
import three from "../../../examples/core-three-scenes/project.json";
import branching from "../../../examples/structure-branching/project.json";
import layout from "../../../examples/layout-canvas/project.json";
import distribution from "../../../examples/distribution-static/project.json";
import {
  NavigationMachine,
  cameraPose,
  firstPassItinerary,
  frameSchedule,
  frameTime,
  planCapture,
  publicDocument,
  resolveEdgePlan,
  resolveSceneCamera,
  sampleCapture,
  sampleTransition,
  serializeDocument,
  validateDocument,
  validateItinerary,
} from "../src/index.js";
import type {
  CameraPose,
  CapturePlan,
  ProjectDocument,
  Result,
} from "../src/index.js";
const value = <T>(r: Result<T>): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.diagnostics));
  return r.value;
};
const load = (input: unknown, alter?: (d: ProjectDocument) => void) => {
  const doc = value(validateDocument(input));
  alter?.(doc);
  return value(validateDocument(doc));
};
const codes = (r: Result<unknown>) =>
  r.ok ? [] : r.diagnostics.map((d) => [d.code, d.pointer]);
const close = (a: CameraPose, b: CameraPose, eps = 1e-9) => {
  [...a.position, ...a.rotation, a.zoom].forEach((x, i) =>
    expect(x).toBeCloseTo([...b.position, ...b.rotation, b.zoom][i]!, 9),
  );
  expect(eps).toBeGreaterThan(0);
};
/** Three visits A→B→D of the branching fixture with real holds. */
const branch = () =>
  load(branching, (d) => {
    for (const n of d.paths[0]!.nodes) n.holdMs = 500;
  });

describe("itinerary validation", () => {
  it("accepts an explicit branch and fills the unique edges", () => {
    const doc = branch();
    const r = value(
      validateItinerary(doc, {
        pathId: "branch",
        visits: [{ nodeId: "A" }, { nodeId: "B" }, { nodeId: "D" }],
      }),
    );
    expect(r.visits).toEqual([
      { nodeId: "A", edgeIdToNext: "AB" },
      { nodeId: "B", edgeIdToNext: "BD" },
      { nodeId: "D" },
    ]);
  });
  it("rejects shape errors with pointers", () => {
    const doc = branch();
    const bad = (input: unknown) => codes(validateItinerary(doc, input));
    expect(bad("{")).toEqual([["INVALID_JSON", ""]]);
    expect(bad([])).toEqual([["ITINERARY_INVALID", ""]]);
    expect(bad({ pathId: "branch", visits: [], extra: 1 })).toEqual([
      ["ITINERARY_INVALID", "/extra"],
    ]);
    expect(bad({ pathId: "branch", visits: [] })).toEqual([
      ["ITINERARY_EMPTY", "/visits"],
    ]);
    expect(bad({ pathId: "../x", visits: [{ nodeId: "A" }] })).toEqual([
      ["ITINERARY_INVALID", "/pathId"],
    ]);
    expect(bad({ pathId: "branch", visits: [{ nodeId: "A", x: 1 }] })).toEqual([
      ["ITINERARY_INVALID", "/visits/0/x"],
    ]);
    expect(
      bad({ pathId: "branch", visits: [{ nodeId: "A", edgeIdToNext: 3 }] }),
    ).toEqual([["ITINERARY_INVALID", "/visits/0/edgeIdToNext"]]);
    expect(
      bad({
        pathId: "branch",
        visits: Array.from({ length: 501 }, () => ({ nodeId: "A" })),
      }),
    ).toEqual([["ITINERARY_LIMIT", "/visits"]]);
    expect(bad({ pathId: "nope", visits: [{ nodeId: "A" }] })).toEqual([
      ["UNKNOWN_PATH", "/pathId"],
    ]);
    expect(bad("x".repeat(1024 * 1024 + 1))).toEqual([["ITINERARY_LIMIT", ""]]);
  });
  it("rejects wrong adjacency, unknown or mismatched edges and an edge after the last visit", () => {
    const doc = branch();
    const bad = (visits: unknown[]) =>
      codes(validateItinerary(doc, { pathId: "branch", visits }));
    expect(bad([{ nodeId: "A" }, { nodeId: "D" }])).toEqual([
      ["NOT_ADJACENT", "/visits/1/nodeId"],
    ]);
    expect(bad([{ nodeId: "A" }, { nodeId: "Z" }])).toEqual([
      ["UNKNOWN_NODE", "/visits/1/nodeId"],
    ]);
    expect(bad([{ nodeId: "A", edgeIdToNext: "ZZ" }, { nodeId: "B" }])).toEqual(
      [["UNKNOWN_EDGE", "/visits/0/edgeIdToNext"]],
    );
    expect(bad([{ nodeId: "A", edgeIdToNext: "AC" }, { nodeId: "B" }])).toEqual(
      [["EDGE_MISMATCH", "/visits/0/edgeIdToNext"]],
    );
    expect(bad([{ nodeId: "A", edgeIdToNext: "AB" }])).toEqual([
      ["EDGE_AFTER_LAST", "/visits/0/edgeIdToNext"],
    ]);
  });
  it("requires edgeIdToNext when several edges join the same nodes", () => {
    const doc = load(branching, (d) => {
      d.paths[0]!.edges.push({
        ...structuredClone(d.paths[0]!.edges[0]!),
        id: "AB2",
      });
    });
    expect(
      codes(
        validateItinerary(doc, {
          pathId: "branch",
          visits: [{ nodeId: "A" }, { nodeId: "B" }],
        }),
      ),
    ).toEqual([["EDGE_AMBIGUOUS", "/visits/0/edgeIdToNext"]]);
    expect(
      validateItinerary(doc, {
        pathId: "branch",
        visits: [{ nodeId: "A", edgeIdToNext: "AB2" }, { nodeId: "B" }],
      }).ok,
    ).toBe(true);
  });
  it("expands a loop explicitly and enforces the runtime visit limits", () => {
    const doc = branch();
    const loop = ["A", "B", "D", "A", "C", "D"].map((nodeId) => ({ nodeId }));
    expect(
      value(validateItinerary(doc, { pathId: "branch", visits: loop })).visits
        .length,
    ).toBe(6);
    // loopPolicy.maxVisitsPerNode is 2: a third entry into D is refused.
    const third = [...loop, { nodeId: "D" }];
    expect(
      codes(validateItinerary(doc, { pathId: "branch", visits: third })),
    ).toEqual([["VISIT_LIMIT", "/visits/6/nodeId"]]);
    // The runtime agrees: the same walk hits the same limit.
    const machine = new NavigationMachine(
      doc,
      "t",
      () => 0,
      () => {},
      () => {},
    );
    machine.setReduced(true);
    return (async () => {
      for (const edgeId of ["AB", "BD", "DA", "AC", "CD"])
        expect((await machine.next({ edgeId })).status).toBe("completed");
      expect((await machine.next({ edgeId: "DD" })).status).toBe("error");
    })();
  });
});

describe("first-pass itinerary", () => {
  it("follows the only transition of each node and fills the edges", () => {
    expect(value(firstPassItinerary(load(three)))).toEqual({
      itinerary: {
        pathId: "main",
        visits: [
          { nodeId: "n1", edgeIdToNext: "e1" },
          { nodeId: "n2", edgeIdToNext: "e2" },
          { nodeId: "n3" },
        ],
      },
    });
  });
  it("stops before a node already visited instead of looping", () => {
    // n1 → n2 → n3 → n1, with a visit limit.
    const pass = value(firstPassItinerary(load(distribution)));
    expect(pass.stoppedBefore).toBe("n1");
    expect(pass.itinerary.visits.map((v) => v.nodeId)).toEqual([
      "n1",
      "n2",
      "n3",
    ]);
    expect(pass.itinerary.visits[2]!.edgeIdToNext).toBeUndefined();
  });
  it("refuses a branch, an unknown path and a path without start", () => {
    const doc = load(branching);
    expect(codes(firstPassItinerary(doc, "branch"))).toEqual([
      ["ITINERARY_BRANCH", ""],
    ]);
    expect(
      value(firstPassItinerary(doc, "alternate")).itinerary.visits,
    ).toEqual([
      { nodeId: "alt-C", edgeIdToNext: "alt-CD" },
      { nodeId: "alt-D" },
    ]);
    expect(codes(firstPassItinerary(doc, "missing"))).toEqual([
      ["UNKNOWN_PATH", ""],
    ]);
    const empty = load(three);
    empty.paths[0]!.startNodeId = null;
    expect(codes(firstPassItinerary(empty))[0]![0]).toBe("ITINERARY_EMPTY");
  });
});

describe("capture plan", () => {
  it("places the first visit without transition and sums holds and edges", () => {
    const doc = load(three);
    const plan = value(
      planCapture(
        doc,
        {
          pathId: "main",
          visits: [{ nodeId: "n1" }, { nodeId: "n2" }, { nodeId: "n3" }],
        },
        { reducedMotion: false },
      ),
    );
    expect(plan.totalMs).toBe(1000 + 600 + 1000 + 600 + 1000);
    expect(plan.visits.map((v) => [v.arrivalMs, v.holdMs])).toEqual([
      [0, 1000],
      [1600, 1000],
      [3200, 1000],
    ]);
    expect(plan.visits[0]!.transition).toMatchObject({
      edgeId: "e1",
      startMs: 1000,
      durationMs: 600,
    });
    expect(plan.visits[2]!.transition).toBeUndefined();
    close(plan.visits[0]!.camera, value(resolveSceneCamera(doc, "intro")));
    close(plan.visits[2]!.camera, value(resolveSceneCamera(doc, "end")));
  });
  it("re-plans reduced motion without transitions", () => {
    const doc = load(three);
    const plan = value(
      planCapture(
        doc,
        { pathId: "main", visits: [{ nodeId: "n1" }, { nodeId: "n2" }] },
        { reducedMotion: true },
      ),
    );
    expect(plan.reducedMotion).toBe(true);
    expect(plan.totalMs).toBe(2000);
    expect(plan.visits[0]!.transition?.durationMs).toBe(0);
    expect(sampleCapture(plan, 1000).nodeId).toBe("n2");
  });
  it("starts a track from the previous arrival pose, keeps the saved keyframes and ends on the track endpoint", () => {
    const doc = branch();
    const before = serializeDocument(doc);
    const plan = value(
      planCapture(
        doc,
        {
          pathId: "branch",
          visits: [{ nodeId: "A" }, { nodeId: "B" }, { nodeId: "D" }],
        },
        { reducedMotion: false },
      ),
    );
    const ab = plan.visits[0]!.transition!;
    const runtime = value(
      resolveEdgePlan(doc, "branch", "AB", plan.visits[0]!.camera),
    );
    expect(ab.plan.track!.keyframes[0]!.pose).toEqual(plan.visits[0]!.camera);
    expect(ab.plan.to).toEqual(runtime.to);
    // The endpoint of the arc track is the arrival pose of B, not B's fit.
    const track = doc.cameraTracks.find((t) => t.id === "arc")!;
    close(plan.visits[1]!.camera, cameraPose(track.keyframes.at(-1)!.pose));
    expect(plan.visits[1]!.camera).not.toEqual(
      value(resolveSceneCamera(doc, "B")),
    );
    // The B→D edge starts from that endpoint.
    expect(plan.visits[1]!.transition!.plan.from).toEqual(
      plan.visits[1]!.camera,
    );
    expect(serializeDocument(doc)).toEqual(before);
  });
  it("samples holds, transitions and the exact endpoint with the runtime sampler", () => {
    const doc = load(three);
    const plan = value(
      planCapture(
        doc,
        {
          pathId: "main",
          visits: [{ nodeId: "n1" }, { nodeId: "n2" }, { nodeId: "n3" }],
        },
        { reducedMotion: false },
      ),
    );
    expect(sampleCapture(plan, 0)).toMatchObject({
      nodeId: "n1",
      phase: "hold",
    });
    expect(sampleCapture(plan, 999.9).phase).toBe("hold");
    const mid = sampleCapture(plan, 1300);
    expect(mid).toMatchObject({
      nodeId: "n1",
      sceneId: "intro",
      phase: "transition",
      progress: 0.5,
    });
    close(
      mid.camera,
      sampleTransition(plan.visits[0]!.transition!.plan, 300).camera,
    );
    expect(sampleCapture(plan, 1600)).toMatchObject({
      nodeId: "n2",
      phase: "hold",
    });
    const end = sampleCapture(plan, plan.totalMs);
    expect(end.nodeId).toBe("n3");
    close(end.camera, value(resolveSceneCamera(doc, "end")));
    expect(() => sampleCapture(plan, -1)).toThrow(RangeError);
    expect(() => sampleCapture(plan, plan.totalMs + 1)).toThrow(RangeError);
    expect(() => sampleCapture(plan, Number.NaN)).toThrow(RangeError);
  });
  it("treats zero holds and repeated nodes as distinct visits", () => {
    const doc = load(branching);
    const plan = value(
      planCapture(
        doc,
        {
          pathId: "branch",
          visits: ["A", "B", "D", "D"].map((nodeId) => ({ nodeId })),
        },
        { reducedMotion: false },
      ),
    );
    expect(plan.visits.map((v) => v.nodeId)).toEqual(["A", "B", "D", "D"]);
    expect(plan.visits[2]!.transition!.edgeId).toBe("DD");
    expect(plan.totalMs).toBe(3600);
    // Hold 0: at the arrival instant the next transition starts from that visit.
    expect(sampleCapture(plan, 1200)).toMatchObject({
      visitIndex: 1,
      phase: "transition",
      progress: 0,
    });
  });
});

describe("frame schedule", () => {
  const plan = (totalMs: number, lastHold: number): CapturePlan => ({
    documentId: "d",
    pathId: "p",
    reducedMotion: false,
    totalMs,
    visits: [
      {
        index: 0,
        nodeId: "n",
        sceneId: "s",
        arrivalMs: totalMs - lastHold,
        holdMs: lastHold,
        camera: { position: [0, 0, 0], rotation: [0, 0, 0, 1], zoom: 1 },
      },
    ],
  });
  it("counts N = ceil(total * fps / 1000) frames with the encoded duration within one frame", () => {
    for (const [total, fps, count] of [
      [3600, 30, 108],
      [3601, 30, 109],
      [1, 30, 1],
      [1000, 24, 24],
      [1001, 25, 26],
    ] as const) {
      const s = value(frameSchedule(plan(total, total), fps));
      expect(s.frameCount).toBe(count);
      expect(s.encodedMs - total).toBeGreaterThanOrEqual(0);
      expect(s.encodedMs - total).toBeLessThan(1000 / fps);
      expect(frameTime(s, s.frameCount - 1)).toBeLessThan(total);
      expect(s.lastFrameMs).toBe(((count - 1) * 1000) / fps);
    }
  });
  it("rejects zero duration and invalid fps, and flags a final hold shorter than one frame", () => {
    expect(codes(frameSchedule(plan(0, 0), 30))).toEqual([
      ["ZERO_DURATION", ""],
    ]);
    expect(codes(frameSchedule(plan(1000, 1000), 0))).toEqual([
      ["INVALID_FPS", ""],
    ]);
    expect(codes(frameSchedule(plan(1000, 1000), 30.5))).toEqual([
      ["INVALID_FPS", ""],
    ]);
    expect(value(frameSchedule(plan(1000, 1000), 30)).finalHoldVisible).toBe(
      true,
    );
    expect(value(frameSchedule(plan(1000, 10), 30)).finalHoldVisible).toBe(
      false,
    );
  });
});

describe("public document", () => {
  it("removes every private note and keeps the authored copy intact", () => {
    const doc = load(layout);
    const notes = doc.scenes.map((s) => s.notes);
    expect(notes.some((n) => n !== "")).toBe(true);
    const pub = publicDocument(doc);
    expect(pub.scenes.every((s) => s.notes === "")).toBe(true);
    expect(doc.scenes.map((s) => s.notes)).toEqual(notes);
    expect(validateDocument(pub).ok).toBe(true);
    expect(JSON.stringify(pub)).not.toContain(notes.find((n) => n)!);
  });
});
