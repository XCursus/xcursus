import { expect, it } from "vitest";
import fixture from "../../../examples/structure-branching/project.json";
import { getWorldMatrix, success } from "@xcursus/core";
import {
  connectNodes,
  createNode,
  createPath,
  createScene,
  deletePath,
  deleteScene,
  editEdge,
  editImpact,
  editNode,
  editPath,
  removeGraphItem,
  reparent,
} from "../src/commands/index.js";
import { EditorStore } from "../src/store/index.js";
const store = () => new EditorStore(fixture);
it("reparent is one atomic, reversible command retaining all world matrices", () => {
  const s = store(),
    before = s.getSnapshot().document,
    world = getWorldMatrix(before, "B");
  expect(s.execute(reparent("B", "C")).ok).toBe(true);
  const next = s.getSnapshot().document;
  const after = getWorldMatrix(next, "B");
  if (!world.ok || !after.ok) throw Error();
  after.value.forEach((n, i) =>
    expect(Math.abs(n - world.value[i]!)).toBeLessThanOrEqual(1e-6),
  );
  expect(s.getSnapshot().historyLength).toBe(1);
  s.undo();
  expect(s.getSnapshot().document).toEqual(before);
  s.redo();
  expect(s.getSnapshot().document).toEqual(next);
});
it("invalid reparent and range do not change document, selection or undo history", () => {
  const s = store(),
    before = s.getSnapshot();
  expect(s.execute(reparent("A", "B")).ok).toBe(false);
  expect(s.execute(reparent("B", "missing")).ok).toBe(false);
  expect(s.getSnapshot()).toBe(before);
});
it("nested drag moves the world XY plane with one undo while keeping world Z", () => {
  const s = store(),
    before = s.getSnapshot().document;
  s.beginDrag("B");
  expect(s.moveWorldDrag(900, 125).ok).toBe(true);
  s.endDrag();
  const matrix = getWorldMatrix(s.getSnapshot().document, "B");
  expect(matrix.ok).toBe(true);
  if (matrix.ok) expect(matrix.value.slice(12, 15)).toEqual([900, 125, -150]);
  expect(s.getSnapshot().historyLength).toBe(1);
  s.undo();
  expect(s.getSnapshot().document).toEqual(before);
});
it("creates an alternative path, repeated visits, choices and track edits with exact undo", () => {
  const s = store(),
    before = s.getSnapshot().document;
  expect(s.execute(createPath("Second reading")).ok).toBe(true);
  const p = s.getSnapshot().document.paths.at(-1)!;
  for (const scene of ["A", "C", "D"])
    expect(s.execute(createNode(p.id, scene)).ok).toBe(true);
  const path = s.getSnapshot().document.paths.at(-1)!;
  expect(s.execute(editPath(p.id, { name: "Reading C" })).ok).toBe(true);
  expect(
    s.execute(
      editNode(p.id, path.nodes[1]!.id, {
        holdMs: 500,
        camera: { position: [1, 2, 3], rotation: [1, 2, 3], zoom: 2 },
      }),
    ).ok,
  ).toBe(true);
  expect(
    s.execute(
      editEdge(p.id, path.edges[0]!.id, {
        label: "Scegli C",
        condition: { kind: "manual" },
      }),
    ).ok,
  ).toBe(true);
  expect(
    s.execute(connectNodes(p.id, path.nodes[0]!.id, path.nodes[2]!.id)).ok,
  ).toBe(true);
  const saved = s.serialize();
  if (!saved.ok) throw Error();
  expect(new EditorStore(saved.value).getSnapshot().document).toEqual(
    s.getSnapshot().document,
  );
  for (let i = 0; i < 8; i++) s.undo();
  expect(s.getSnapshot().document).toEqual(before);
});
it("graph cycles require policy and explicit conditions; refused connect is atomic", () => {
  const s = store();
  const p = s.getSnapshot().document.paths[1]!;
  const before = s.getSnapshot();
  expect(s.execute(connectNodes(p.id, p.nodes[1]!.id, p.nodes[0]!.id)).ok).toBe(
    false,
  );
  expect(s.getSnapshot()).toBe(before);
  expect(
    s.execute((doc) => {
      const path = doc.paths[1]!;
      path.loopPolicy = { maxVisitsPerNode: 3 };
      path.edges[0]!.condition = { kind: "manual" };
      return success(doc);
    }).ok,
  ).toBe(true);
  expect(s.execute(connectNodes(p.id, p.nodes[1]!.id, p.nodes[0]!.id)).ok).toBe(
    true,
  );
});
it("previewed scene deletion includes visits, cues and parent changes, and undo restores every reference", () => {
  const s = store(),
    before = s.getSnapshot().document;
  const edit = deleteScene("A", true),
    preview = editImpact(before, edit);
  expect(preview.ok).toBe(true);
  if (!preview.ok) throw Error();
  expect(preview.value.description).toContain("children reparented");
  expect(s.execute(edit).ok).toBe(true);
  expect(s.getSnapshot().document).toEqual(preview.value.document);
  expect(
    s.getSnapshot().document.scenes.find((n) => n.id === "B")!.parentId,
  ).toBeNull();
  s.undo();
  expect(s.getSnapshot().document).toEqual(before);
});
it("path deletion removes associated cues and chooses valid default in one command", () => {
  const s = store(),
    before = s.getSnapshot().document;
  expect(s.execute(deletePath("branch")).ok).toBe(true);
  expect(s.getSnapshot().document.defaultPathId).toBe("alternate");
  expect(s.getSnapshot().document.cues).toEqual([]);
  s.undo();
  expect(s.getSnapshot().document).toEqual(before);
});
it.each(["node", "edge"] as const)(
  "graph %s deletion previews pruned unreachable nodes and undo restores all",
  (kind) => {
    const s = store(),
      before = s.getSnapshot().document;
    const edit = removeGraphItem(
      "alternate",
      kind === "node" ? "alt-C" : "alt-CD",
      kind,
    );
    const preview = editImpact(before, edit);
    expect(preview.ok).toBe(true);
    expect(s.execute(edit).ok).toBe(true);
    s.undo();
    expect(s.getSnapshot().document).toEqual(before);
  },
);
it("new independent scene never rewrites an existing branch graph", () => {
  const s = store(),
    before = s.getSnapshot().document.paths;
  expect(s.execute(createScene("B"), true).ok).toBe(true);
  expect(s.getSnapshot().document.paths).toEqual(before);
  expect(s.getSnapshot().document.scenes).toHaveLength(5);
});
it("no-op field commits preserve snapshot identity and do not notify preview subscribers", () => {
  const s = store(),
    snapshot = s.getSnapshot();
  let notifications = 0;
  const off = s.subscribe(() => notifications++);
  expect(s.execute((doc) => success(doc)).ok).toBe(true);
  expect(s.getSnapshot()).toBe(snapshot);
  expect(notifications).toBe(0);
  off();
});
it("scene creation preserves timed linear edges and their cues by creating an independent scene", () => {
  const s = store();
  expect(
    s.execute((doc) => {
      doc.defaultPathId = "alternate";
      doc.scenes = [
        doc.scenes.find((s) => s.id === "C")!,
        doc.scenes.find((s) => s.id === "D")!,
      ];
      doc.paths = doc.paths.filter((p) => p.id === "alternate");
      doc.paths[0]!.edges[0]!.cameraTrackId = "arc";
      doc.cues = [
        {
          id: "linear-cue",
          edgeId: "alt-CD",
          atMs: 0,
          event: "presentation.mark",
          payload: null,
        },
      ];
      return success(doc);
    }).ok,
  ).toBe(true);
  const before = s.getSnapshot().document;
  expect(s.execute(createScene("C"), true).ok).toBe(true);
  expect(s.getSnapshot().document.paths).toEqual(before.paths);
  expect(s.getSnapshot().document.cues).toEqual(before.cues);
  expect(s.getSnapshot().document.scenes).toHaveLength(3);
});
