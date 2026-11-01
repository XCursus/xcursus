import { describe, expect, it, vi } from "vitest";
import fixture from "../../../examples/core-three-scenes/project.json";
import { validateDocument } from "@xcursus/core";
import {
  createScene,
  deleteScene,
  editScene,
  emptyProject,
} from "../src/commands/index.js";
import { EditorStore, parseFinite } from "../src/store/index.js";
function project() {
  const result = validateDocument(fixture);
  if (!result.ok) throw new Error("Invalid fixture");
  return result.value;
}
describe("editor atomic commands", () => {
  it("creates a valid empty document and an invertible first scene", () => {
    const initial = emptyProject(),
      store = new EditorStore(initial);
    expect(validateDocument(initial).ok).toBe(true);
    store.execute(createScene(), true);
    expect(store.getSnapshot().document.scenes).toHaveLength(1);
    expect(store.getSnapshot().selection).toBe(
      store.getSnapshot().document.scenes[0]!.id,
    );
    store.undo();
    expect(store.getSnapshot().document).toEqual(initial);
    store.redo();
    expect(validateDocument(store.getSnapshot().document).ok).toBe(true);
  });
  it("duplicates scene, blocks, node and edges with independent IDs", () => {
    const store = new EditorStore(project()),
      old = store.getSnapshot().document;
    store.execute(createScene("detail", true), true);
    const next = store.getSnapshot().document,
      copy = next.scenes[2]!;
    expect(copy.id).not.toBe("detail");
    expect(copy.blocks[0]!.id).not.toBe(old.scenes[1]!.blocks[0]!.id);
    expect(new Set(next.paths[0]!.nodes.map((n) => n.id)).size).toBe(4);
    expect(next.paths[0]!.nodes.map((n) => n.sceneId)).toEqual(
      next.scenes.map((s) => s.id),
    );
    store.undo();
    expect(store.getSnapshot().document).toEqual(old);
    store.redo();
    expect(store.getSnapshot().document).toEqual(next);
  });
  it("delete stitches neighbours with default transition, undo restores exact references and transitions", () => {
    const input = project();
    input.paths[0]!.edges[0]!.transition.durationMs = 123;
    const store = new EditorStore(input);
    store.select("detail");
    store.execute(deleteScene("detail"));
    const next = store.getSnapshot();
    expect(next.selection).toBe("end");
    expect(next.document.paths[0]!.edges).toHaveLength(1);
    expect(next.document.paths[0]!.edges[0]!.transition).toEqual(
      input.settings.presentation.defaultTransition,
    );
    store.undo();
    expect(store.getSnapshot().document).toEqual(input);
    expect(store.getSnapshot().selection).toBe("detail");
  });
  it("refuses deletion referenced by other paths with impact, without deleting data", () => {
    const input = project();
    input.paths.push({
      ...structuredClone(input.paths[0]!),
      id: "other",
      name: "Alternative",
    });
    const store = new EditorStore(input);
    const result = store.execute(deleteScene("detail"));
    expect(result.ok).toBe(false);
    expect(result.diagnostics[0]!.message).toContain("Alternative");
    expect(store.getSnapshot().document).toEqual(input);
  });
  it("adds independent scenes without rewriting a reordered main path", () => {
    const input = project();
    input.scenes.reverse();
    const store = new EditorStore(input);
    expect(store.execute(createScene()).ok).toBe(true);
    expect(store.getSnapshot().document.paths).toEqual(input.paths);
    expect(store.getSnapshot().document.scenes).toHaveLength(4);
    expect(
      store.execute(editScene("intro", { notes: "still editable" })).ok,
    ).toBe(true);
  });
  it("deleting every scene ends in a valid empty state, undo restores", () => {
    const store = new EditorStore(project());
    for (const id of ["intro", "detail", "end"])
      expect(store.execute(deleteScene(id)).ok).toBe(true);
    expect(store.getSnapshot().selection).toBeNull();
    expect(store.getSnapshot().document.paths[0]!.startNodeId).toBeNull();
    expect(validateDocument(store.getSnapshot().document).ok).toBe(true);
    store.undo();
    expect(store.getSnapshot().document.scenes[0]!.id).toBe("end");
  });
  it("one drag has one undo, live updates share the validated document", () => {
    const store = new EditorStore(project()),
      before = store.getSnapshot().document;
    store.beginDrag("intro");
    for (let i = 0; i < 20; i++) store.moveDrag(i * 10, i * 20);
    expect(store.getSnapshot().historyLength).toBe(0);
    store.endDrag();
    expect(store.getSnapshot().historyLength).toBe(1);
    expect(
      store.getSnapshot().document.scenes[0]!.position.slice(0, 2),
    ).toEqual([190, 380]);
    store.undo();
    expect(store.getSnapshot().document).toEqual(before);
    store.redo();
    expect(store.getSnapshot().document.scenes[0]!.position[0]).toBe(190);
  });
  it("Escape cancels drag with no command or redo loss", () => {
    const store = new EditorStore(project());
    store.execute(editScene("intro", { title: "new" }));
    store.undo();
    const before = store.getSnapshot().document;
    store.beginDrag("intro");
    store.moveDrag(200, 100);
    store.cancelDrag();
    expect(store.getSnapshot().document).toEqual(before);
    expect(store.getSnapshot().canRedo).toBe(true);
    expect(store.getSnapshot().historyLength).toBe(0);
  });
  it("edit after undo invalidates redo and redo itself preserves command bytes", () => {
    const store = new EditorStore(project());
    store.execute(editScene("intro", { title: "new" }));
    const bytes = store.getSnapshot().historyBytes;
    store.undo();
    expect(store.getSnapshot().historyBytes).toBe(bytes);
    store.execute(editScene("intro", { title: "different" }));
    expect(store.getSnapshot().canRedo).toBe(false);
  });
  it("evicts oldest commands at 100, preserves the current document", () => {
    const store = new EditorStore(project());
    for (let i = 0; i < 105; i++)
      store.execute(editScene("intro", { title: String(i) }));
    expect(store.getSnapshot().historyLength).toBe(100);
    for (let i = 0; i < 100; i++) store.undo();
    expect(store.getSnapshot().document.scenes[0]!.title).toBe("4");
    expect(store.getSnapshot().canUndo).toBe(false);
  });
  it("evicts oldest at the byte bound, including an oversized single command", () => {
    const store = new EditorStore(project(), { commands: 100, bytes: 1 });
    store.execute(editScene("intro", { title: "changed" }));
    expect(store.getSnapshot().historyBytes).toBe(0);
    expect(store.getSnapshot().canUndo).toBe(false);
    expect(store.getSnapshot().document.scenes[0]!.title).toBe("changed");
  });
  it.each([NaN, Infinity, -Infinity, 1000001])(
    "invalid coordinate %s never applies",
    (value) => {
      const store = new EditorStore(project()),
        before = store.getSnapshot().document;
      expect(
        store.execute(editScene("intro", { position: [value, 0, 0] })).ok,
      ).toBe(false);
      expect(store.getSnapshot().document).toBe(before);
    },
  );
  it.each([0, -1, 10001])("invalid scale %s never applies", (scale) => {
    const store = new EditorStore(project());
    expect(store.execute(editScene("intro", { scale })).ok).toBe(false);
    expect(store.getSnapshot().canUndo).toBe(false);
  });
  it.each(["", " ", "NaN", "Infinity", "1,2", "no"])(
    "rejects nonfinite numeric text %s",
    (text) => expect(parseFinite(text).ok).toBe(false),
  );
  it("inspector edits are invertible and serialization preserves notes, opaque extensions, blocks and order", () => {
    const input = project();
    input.extensions["org.example"] = {
      version: "1.0.0",
      data: { opaque: [1, { keep: "all" }] },
    };
    const store = new EditorStore(input);
    store.execute(
      editScene("detail", {
        position: [321, -22, 75],
        rotation: [12, 23, 34],
        scale: 1.25,
        size: [777, 444],
        notes: "speaker notes",
      }),
    );
    const serialized = store.serialize();
    expect(serialized.ok).toBe(true);
    if (!serialized.ok) return;
    const reopened = new EditorStore(serialized.value);
    expect(reopened.getSnapshot().document).toEqual(
      store.getSnapshot().document,
    );
    store.undo();
    expect(store.getSnapshot().document).toEqual(input);
  });
  it("invalid replace and cancelled open leave active state and history intact; saved snapshot tracks dirty", () => {
    const store = new EditorStore(project());
    store.execute(editScene("intro", { notes: "a" }));
    const before = store.getSnapshot();
    expect(store.replace("bad json").ok).toBe(false);
    expect(store.getSnapshot()).toBe(before);
    store.markSaved();
    expect(store.getSnapshot().dirty).toBe(false);
    store.undo();
    expect(store.getSnapshot().dirty).toBe(true);
    store.redo();
    expect(store.getSnapshot().dirty).toBe(false);
  });
  it("exposes frozen documents and never mutates caller input", () => {
    const input = project();
    const store = new EditorStore(input);
    expect(() => {
      store.getSnapshot().document.scenes[0]!.position[0] = 4;
    }).toThrow();
    store.execute(editScene("intro", { notes: "new" }));
    expect(input).toEqual(project());
  });
});
describe("0.4.1 store publication and text sessions", () => {
  function large() {
    const store = new EditorStore(project());
    for (let i = 0; i < 60; i++) store.execute(createScene());
    return store;
  }
  it("selection and map pan never serialize or deep-freeze the document", () => {
    const store = large(),
      ids = store.getSnapshot().document.scenes.map((s) => s.id);
    store.markSaved();
    const stringify = vi.spyOn(JSON, "stringify"),
      freeze = vi.spyOn(Object, "freeze");
    for (let i = 0; i < 20; i++) {
      store.select(ids[i % ids.length]!);
      store.setMap({ x: i, y: -i, zoom: 0.5 });
    }
    expect(stringify).not.toHaveBeenCalled();
    expect(freeze.mock.calls.length).toBeLessThanOrEqual(80);
    expect(store.getSnapshot().dirty).toBe(false);
    expect(Object.isFrozen(store.getSnapshot().document.scenes[5]!)).toBe(true);
    stringify.mockRestore();
    freeze.mockRestore();
  });
  it("dirty follows the saved document identity through undo and redo", () => {
    const store = new EditorStore(project());
    expect(store.getSnapshot().dirty).toBe(false);
    store.execute(editScene("intro", { title: "a" }));
    expect(store.getSnapshot().dirty).toBe(true);
    store.undo();
    expect(store.getSnapshot().dirty).toBe(false);
    store.beginDrag("intro");
    store.moveDrag(400, 400);
    store.moveDrag(
      ...(project().scenes[0]!.position.slice(0, 2) as [number, number]),
    );
    store.endDrag();
    expect(store.getSnapshot().dirty).toBe(false);
    expect(store.getSnapshot().historyLength).toBe(0);
  });
  it("continuous text edits coalesce into one command per editing session", () => {
    const store = new EditorStore(project()),
      original = store.getSnapshot().document;
    const title = (value: string) =>
      store.coalesce("metadata.title", (doc) => {
        doc.metadata.title = value;
        return { ok: true, value: doc, diagnostics: [] };
      });
    for (const value of ["N", "Nu", "Nuo", "New"])
      expect(title(value).ok).toBe(true);
    expect(store.getSnapshot().historyLength).toBe(1);
    expect(store.getSnapshot().document.metadata.title).toBe("New");
    store.endCoalesce();
    title("New title");
    expect(store.getSnapshot().historyLength).toBe(2);
    store.undo();
    expect(store.getSnapshot().document.metadata.title).toBe("New");
    store.undo();
    expect(store.getSnapshot().document).toBe(original);
    store.redo();
    store.redo();
    expect(store.getSnapshot().document.metadata.title).toBe("New title");
    title("Other");
    store.execute(editScene("intro", { notes: "interleaved" }));
    title("Again");
    expect(store.getSnapshot().historyLength).toBe(5);
    expect(title("").ok).toBe(true);
    const notes = (value: string) =>
      store.coalesce("notes:intro", editScene("intro", { notes: value }));
    notes("x");
    notes("xy");
    expect(store.getSnapshot().historyLength).toBe(6);
    store.undo();
    expect(store.getSnapshot().document.scenes[0]!.notes).toBe("interleaved");
  });
  it("a coalesced session that returns to its start leaves no command", () => {
    const store = new EditorStore(project());
    const set = (value: string) =>
      store.coalesce("t", (doc) => {
        doc.metadata.title = value;
        return { ok: true, value: doc, diagnostics: [] };
      });
    const start = store.getSnapshot().document.metadata.title;
    set(start + "!");
    set(start);
    store.endCoalesce();
    expect(store.getSnapshot().canUndo).toBe(false);
    expect(store.getSnapshot().dirty).toBe(false);
  });
});
describe("0.4.1 store edge cases", () => {
  it("coalescing refuses during drags and keeps invalid edits out of history", () => {
    const store = new EditorStore(project());
    store.beginDrag("intro");
    expect(
      store.coalesce("t", (doc) => ({ ok: true, value: doc, diagnostics: [] }))
        .ok,
    ).toBe(false);
    store.cancelDrag();
    expect(store.coalesce("t", editScene("intro", { scale: 0 })).ok).toBe(
      false,
    );
    store.coalesce("t", editScene("intro", { notes: "a" }));
    expect(store.coalesce("t", editScene("intro", { scale: -1 })).ok).toBe(
      false,
    );
    expect(store.coalesce("t", editScene("intro", { notes: "a" })).ok).toBe(
      true,
    );
    expect(store.getSnapshot().historyLength).toBe(1);
  });
  it("a coalesced command still respects the history byte budget", () => {
    const store = new EditorStore(project(), { commands: 100, bytes: 1 });
    store.coalesce("t", editScene("intro", { notes: "a" }));
    store.coalesce("t", editScene("intro", { notes: "ab" }));
    expect(store.getSnapshot().canUndo).toBe(false);
    expect(store.getSnapshot().document.scenes[0]!.notes).toBe("ab");
    store.coalesce("t", editScene("intro", { notes: "abc" }));
    expect(store.getSnapshot().document.scenes[0]!.notes).toBe("abc");
  });
});
