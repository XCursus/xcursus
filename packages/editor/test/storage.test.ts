import { afterEach, expect, it, vi } from "vitest";
import {
  Autosave,
  RecoveryRepository,
  StorageConflict,
  openLimitError,
} from "../src/storage/index.js";
import { emptyProject, randomId } from "../src/commands/index.js";
import type { Revision } from "../src/storage/index.js";
import type { ProjectDocument } from "@xcursus/core";
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("denied IndexedDB reports a failure instead of replacing the document", async () => {
  const repository = new RecoveryRepository(() => {
    throw new Error("denied");
  });
  await expect(repository.save(emptyProject(), 0)).rejects.toThrow("denied");
  await repository.close();
});
it("autosave debounces at 750ms, serializes revisions and disposes timers", async () => {
  vi.useFakeTimers();
  const saved: number[] = [];
  class Repo extends RecoveryRepository {
    override async save(
      document: ProjectDocument,
      revision: number,
    ): Promise<Revision> {
      saved.push(revision);
      return {
        projectId: document.id,
        revision: revision + 1,
        updatedAt: 0,
        document,
      };
    }
  }
  const autosave = new Autosave(new Repo()),
    document = emptyProject();
  autosave.schedule(document);
  await vi.advanceTimersByTimeAsync(749);
  expect(saved).toEqual([]);
  autosave.schedule(document);
  await vi.advanceTimersByTimeAsync(750);
  expect(saved).toEqual([0]);
  document.metadata.title = "changed";
  await autosave.flush(document);
  expect(saved).toEqual([0, 1]);
  autosave.schedule(document);
  autosave.dispose();
  await vi.advanceTimersByTimeAsync(1000);
  expect(saved).toEqual([0, 1]);
});
it.each([new Error("QuotaExceededError"), new StorageConflict()])(
  "storage failure keeps manual serialization available: %s",
  async (error) => {
    class Repo extends RecoveryRepository {
      override async save(): Promise<Revision> {
        throw error;
      }
    }
    const warnings: string[] = [];
    const document = emptyProject(),
      autosave = new Autosave(new Repo(), new Map(), (m) => warnings.push(m));
    await autosave.flush(document);
    expect(warnings[0]).toContain("Save JSON");
    expect(document.schemaVersion).toBe("1.3.0");
    autosave.dispose();
  },
);
it("open limits name the file kind that exceeded them", () => {
  const MiB = 1024 * 1024;
  expect(openLimitError({ name: "a.json", size: 10 * MiB })).toBeNull();
  expect(openLimitError({ name: "a.json", size: 10 * MiB + 1 })).toBe(
    "The JSON file exceeds 10 MiB.",
  );
  expect(openLimitError({ name: "a.xcursus", size: 220 * MiB })).toBeNull();
  expect(openLimitError({ name: "a.xcursus", size: 220 * MiB + 1 })).toBe(
    "The .xcursus archive exceeds 220 MiB.",
  );
  expect(openLimitError({ name: "a.SpatialDeck", size: 220 * MiB })).toBeNull();
  expect(openLimitError({ name: "a.spatialdeck", size: 220 * MiB + 1 })).toBe(
    "The .spatialdeck archive exceeds 220 MiB.",
  );
});
it("generates v4 IDs without randomUUID, as in non-secure contexts", () => {
  const original = globalThis.crypto;
  vi.stubGlobal("crypto", {
    getRandomValues: <T extends ArrayBufferView>(array: T) =>
      original.getRandomValues(array as never) as T,
  });
  const ids = new Set(Array.from({ length: 50 }, randomId));
  expect(ids.size).toBe(50);
  for (const id of ids)
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  expect(emptyProject().id).toMatch(/^[0-9a-f-]{36}$/);
});
