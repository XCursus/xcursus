import {
  failure,
  serializeDocument,
  success,
  validateDocument,
  updateCapabilities,
  getWorldMatrix,
  worldPositionToLocal,
} from "@xcursus/core";
import type { ProjectDocument, Result } from "@xcursus/core";
import type { DocumentEdit } from "../commands/index.js";
export interface MapCamera {
  x: number;
  y: number;
  zoom: number;
}
export interface EditorSession {
  document: ProjectDocument;
  selection: string | null;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  dragging: boolean;
  map: MapCamera;
  historyBytes: number;
  historyLength: number;
}
interface Command {
  before: ProjectDocument;
  after: ProjectDocument;
  selectionBefore: string | null;
  selectionAfter: string | null;
  bytes: number;
}
/** Deep-freezes new values only: frozen subtrees were frozen whole by this function. */
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) freeze(v);
  }
  return value;
}
const serialized = new WeakMap<ProjectDocument, string>();
/** Documents in the store are frozen, so their JSON can be memoized by identity. */
export function documentJSON(document: ProjectDocument): string {
  let json = serialized.get(document);
  if (json === undefined) {
    json = JSON.stringify(document);
    if (Object.isFrozen(document)) serialized.set(document, json);
  }
  return json;
}
const utf8Length = (text: string) => new TextEncoder().encode(text).byteLength;
export class EditorStore {
  private document: ProjectDocument;
  private selection: string | null;
  private saved: ProjectDocument | null;
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  private drag:
    { document: ProjectDocument; selection: string | null } | undefined;
  private session: { key: string; command: Command } | undefined;
  private listeners = new Set<() => void>();
  private map: MapCamera = { x: 0, y: 0, zoom: 0.25 };
  private snapshot!: EditorSession;
  constructor(
    input: unknown,
    private limits = { commands: 100, bytes: 20 * 1024 * 1024 },
  ) {
    const result = validateDocument(input);
    if (!result.ok) throw new Error(result.diagnostics[0]?.message);
    this.document = freeze(result.value);
    this.selection = this.document.scenes[0]?.id ?? null;
    this.saved = this.document;
    this.publish();
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  /** Shallow: the document is already frozen and dirty is an identity check, so selection and pan stay O(1). */
  private publish() {
    this.snapshot = Object.freeze({
      document: this.document,
      selection: this.selection,
      dirty: this.document !== this.saved,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      dragging: !!this.drag,
      map: this.map,
      historyBytes: [...this.undoStack, ...this.redoStack].reduce(
        (n, c) => n + c.bytes,
        0,
      ),
      historyLength: this.undoStack.length,
    });
    for (const l of this.listeners) l();
  }
  select(id: string | null) {
    if (id === null || this.document.scenes.some((s) => s.id === id)) {
      this.selection = id;
      this.publish();
    }
  }
  setMap(map: MapCamera) {
    if (
      Object.values(map).every(Number.isFinite) &&
      map.zoom >= 0.02 &&
      map.zoom <= 2
    ) {
      this.map = Object.freeze({ ...map });
      this.publish();
    }
  }
  private record(before: ProjectDocument, selectionBefore: string | null) {
    this.session = undefined;
    const beforeJSON = documentJSON(before);
    if (beforeJSON === documentJSON(this.document)) {
      this.document = before;
      this.publish();
      return;
    }
    const command: Command = {
      before,
      after: this.document,
      selectionBefore,
      selectionAfter: this.selection,
      bytes: utf8Length(beforeJSON) + utf8Length(documentJSON(this.document)),
    };
    this.redoStack = [];
    this.undoStack.push(command);
    this.trim();
    this.publish();
  }
  private trim() {
    let bytes = this.undoStack.reduce((n, c) => n + c.bytes, 0);
    while (
      this.undoStack.length > this.limits.commands ||
      bytes > this.limits.bytes
    )
      bytes -= this.undoStack.shift()!.bytes;
  }
  /** Validated candidate, frozen; undefined when the edit is a no-op. */
  private apply(edit: DocumentEdit): Result<ProjectDocument | undefined> {
    const edited = edit(structuredClone(this.document));
    if (!edited.ok) return edited;
    updateCapabilities(edited.value);
    const valid = validateDocument(edited.value);
    if (!valid.ok) return valid;
    const json = JSON.stringify(valid.value);
    if (json === documentJSON(this.document)) return success(undefined);
    const frozen = freeze(valid.value);
    serialized.set(frozen, json);
    return success(frozen);
  }
  /**
   * Continuous text edits with the same key (one editing session of a field)
   * merge into a single undo command until endCoalesce() or any other command.
   */
  coalesce(key: string, edit: DocumentEdit): Result<void> {
    if (this.drag) return failure("DRAG_ACTIVE", "Finish or cancel the drag.");
    const session = this.session;
    if (
      !session ||
      session.key !== key ||
      this.undoStack.at(-1) !== session.command ||
      this.redoStack.length
    ) {
      this.session = undefined;
      const top = this.undoStack.at(-1);
      const result = this.execute(edit);
      const command = this.undoStack.at(-1);
      if (result.ok && command && command !== top)
        this.session = { key, command };
      return result;
    }
    const next = this.apply(edit);
    if (!next.ok) return next;
    if (!next.value) return success(undefined);
    const command = session.command;
    if (documentJSON(next.value) === documentJSON(command.before)) {
      // The session returned to its start: no command remains.
      this.undoStack.pop();
      this.session = undefined;
      this.document = command.before;
    } else {
      this.document = next.value;
      command.after = next.value;
      command.selectionAfter = this.selection;
      command.bytes =
        utf8Length(documentJSON(command.before)) +
        utf8Length(documentJSON(next.value));
      this.trim();
      if (this.undoStack.at(-1) !== command) this.session = undefined;
    }
    this.publish();
    return success(undefined);
  }
  endCoalesce() {
    this.session = undefined;
  }
  execute(edit: DocumentEdit, selectNew = false): Result<void> {
    if (this.drag) return failure("DRAG_ACTIVE", "Finish or cancel the drag.");
    const before = this.document,
      selection = this.selection;
    const next = this.apply(edit);
    if (!next.ok) return next;
    if (!next.value) return success(undefined);
    this.document = next.value;
    if (selectNew)
      this.selection =
        this.document.scenes.find(
          (s) => !before.scenes.some((old) => old.id === s.id),
        )?.id ?? this.selection;
    if (!this.document.scenes.some((s) => s.id === this.selection)) {
      const index = before.scenes.findIndex((s) => s.id === selection);
      this.selection =
        this.document.scenes[
          Math.min(Math.max(index, 0), this.document.scenes.length - 1)
        ]?.id ?? null;
    }
    this.record(before, selection);
    return success(undefined);
  }
  undo() {
    this.session = undefined;
    if (this.drag) this.cancelDrag();
    const command = this.undoStack.pop();
    if (!command) return;
    this.redoStack.push(command);
    this.document = command.before;
    this.selection = command.selectionBefore;
    this.publish();
  }
  redo() {
    this.session = undefined;
    if (this.drag) this.cancelDrag();
    const command = this.redoStack.pop();
    if (!command) return;
    this.undoStack.push(command);
    this.document = command.after;
    this.selection = command.selectionAfter;
    this.publish();
  }
  beginDrag(id: string) {
    if (this.drag) return;
    this.session = undefined;
    this.select(id);
    if (this.selection === id) {
      this.drag = { document: this.document, selection: id };
      this.publish();
    }
  }
  moveDrag(x: number, y: number): Result<void> {
    if (!this.drag) return failure("DRAG_INACTIVE", "No drag in progress.");
    const candidate = structuredClone(this.drag.document);
    const scene = candidate.scenes.find((s) => s.id === this.drag!.selection)!;
    scene.position = [x, y, scene.position[2]];
    const valid = validateDocument(candidate);
    if (!valid.ok) return valid;
    this.document = freeze(valid.value);
    this.publish();
    return success(undefined);
  }
  moveWorldDrag(x: number, y: number): Result<void> {
    if (!this.drag) return failure("DRAG_INACTIVE", "No drag in progress.");
    const candidate = structuredClone(this.drag.document),
      scene = candidate.scenes.find((s) => s.id === this.drag!.selection)!;
    const world = getWorldMatrix(candidate, scene.id);
    if (!world.ok) return world;
    const local = worldPositionToLocal(candidate, scene.id, [
      x,
      y,
      world.value[14]!,
    ]);
    if (!local.ok) return local;
    scene.position = local.value;
    const valid = validateDocument(candidate);
    if (!valid.ok) return valid;
    this.document = freeze(valid.value);
    this.publish();
    return success(undefined);
  }
  /**
   * Gesture on any document data (a frame drag, resize or rotation): previews
   * without history from the snapshot taken here, one command at endDrag,
   * cancelDrag restores. Autosave waits while it lasts.
   */
  beginGesture(): boolean {
    if (this.drag) return false;
    this.session = undefined;
    this.drag = { document: this.document, selection: this.selection };
    this.publish();
    return true;
  }
  previewGesture(edit: DocumentEdit): Result<void> {
    if (!this.drag) return failure("DRAG_INACTIVE", "No drag in progress.");
    const edited = edit(structuredClone(this.drag.document));
    if (!edited.ok) return edited;
    updateCapabilities(edited.value);
    const valid = validateDocument(edited.value);
    if (!valid.ok) return valid;
    this.document = freeze(valid.value);
    this.publish();
    return success(undefined);
  }
  endDrag() {
    const drag = this.drag;
    if (!drag) return;
    this.drag = undefined;
    this.record(drag.document, drag.selection);
  }
  cancelDrag() {
    if (!this.drag) return;
    this.document = this.drag.document;
    this.selection = this.drag.selection;
    this.drag = undefined;
    this.publish();
  }
  replace(input: unknown, saved = true): Result<void> {
    const valid = validateDocument(input);
    if (!valid.ok) return valid;
    this.document = freeze(valid.value);
    this.selection = this.document.scenes[0]?.id ?? null;
    this.undoStack = [];
    this.redoStack = [];
    this.drag = undefined;
    this.session = undefined;
    this.saved = saved ? this.document : null;
    this.publish();
    return success(undefined);
  }
  markSaved(document = this.document) {
    this.saved = document;
    this.publish();
  }
  serialize() {
    return serializeDocument(this.document);
  }
}
export function parseFinite(text: string): Result<number> {
  if (!text.trim() || !Number.isFinite(Number(text)))
    return failure("INVALID_NUMBER", "Enter a finite number.");
  return success(Number(text));
}
