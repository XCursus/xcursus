import "fake-indexeddb/auto";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IDBFactory, IDBIndex, IDBObjectStore } from "fake-indexeddb";
import type { ProjectDocument } from "@xcursus/core";
import {
  Autosave,
  DATABASE_VERSION,
  RecoveryRepository,
  StorageConflict,
  assetKey,
  mergeBlobs,
  downloadName,
  pendingRecovery,
  revisionTime,
  projectBlobs,
} from "../src/storage/index.js";
import { emptyProject } from "../src/commands/index.js";
const NAME = "spatialdeck-studio";
afterEach(() => vi.restoreAllMocks());
function repository(factory = new IDBFactory()) {
  const repo = new RecoveryRepository(() =>
    factory.open(NAME, DATABASE_VERSION),
  );
  const warnings: Array<string | null> = [];
  repo.onWarning((message) => warnings.push(message));
  return { repo, factory, warnings };
}
function withAsset(
  doc: ProjectDocument,
  id: string,
  text: string,
  digest = true,
) {
  const bytes = new TextEncoder().encode(`WEBVTT\n\n${text}\n`);
  const blob = new Blob([bytes], { type: "text/vtt" });
  doc.assets.push({
    id,
    path: `assets/${id}/${id}.vtt`,
    mime: "text/vtt",
    byteLength: blob.size,
    ...(digest
      ? { sha256: createHash("sha256").update(bytes).digest("hex") }
      : {}),
  });
  return blob;
}
async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++)
    await new Promise((resolve) => setTimeout(resolve, 5));
  expect(check()).toBe(true);
}
function rawOpen(factory: IDBFactory, version: number) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(NAME, version);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const [name, keyPath] of [
        ["documents", "projectId"],
        ["recovery", ["projectId", "revision"]],
        ["assets", "key"],
      ] as const)
        if (!db.objectStoreNames.contains(name))
          db.createObjectStore(name, { keyPath: keyPath as string });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
describe("asset persistence without recomputation", () => {
  it.each([true, false])(
    "does not re-read, re-digest or rewrite unchanged assets (declared digest: %s)",
    async (declared) => {
      const { repo } = repository();
      const doc = emptyProject(),
        blob = withAsset(doc, "cap", "hello", declared);
      const first = await repo.save(doc, 0, new Map([["cap", blob]]));
      const reads = (["arrayBuffer", "slice", "stream", "text"] as const).map(
        (m) => vi.spyOn(blob, m),
      );
      const digest = vi.spyOn(globalThis.crypto.subtle, "digest"),
        put = vi.spyOn(IDBObjectStore.prototype, "put");
      const edited = structuredClone(doc);
      edited.metadata.title = "changed";
      const second = await repo.save(
        edited,
        first.revision,
        new Map([["cap", blob]]),
      );
      for (const read of reads) expect(read).not.toHaveBeenCalled();
      expect(digest).not.toHaveBeenCalled();
      expect(
        put.mock.contexts.filter(
          (store) => (store as IDBObjectStore).name === "assets",
        ),
      ).toHaveLength(0);
      expect(second.assetKeys).toEqual(first.assetKeys);
      const restored = (await repo.blobs(second)).get("cap")!;
      expect(await restored.text()).toBe("WEBVTT\n\nhello\n");
      await repo.close();
    },
  );
  it("garbage collection never loads every revision of every project", async () => {
    const { repo } = repository();
    const other = emptyProject(),
      kept = withAsset(other, "keep", "other project");
    await repo.save(other, 0, new Map([["keep", kept]]));
    let doc = emptyProject();
    const blob = withAsset(doc, "cap", "dropped later");
    let revision = (await repo.save(doc, 0, new Map([["cap", blob]]))).revision;
    doc = structuredClone(doc);
    doc.assets = [];
    const scans: string[] = [];
    for (const target of [IDBObjectStore.prototype, IDBIndex.prototype]) {
      const original = target.getAll;
      vi.spyOn(target, "getAll").mockImplementation(function (
        this: IDBObjectStore | IDBIndex,
        ...args: Parameters<IDBObjectStore["getAll"]>
      ) {
        const store = "objectStore" in this ? this.objectStore : this;
        if (store.name === "recovery" && args[0] == null)
          scans.push(store.name);
        return original.apply(this, args as never);
      });
    }
    for (let i = 0; i < 11; i++)
      revision = (await repo.save(doc, revision)).revision;
    expect(scans).toEqual([]);
    const keys = await new Promise<IDBValidKey[]>((resolve) => {
      void (repo as unknown as { db(): Promise<IDBDatabase> })
        .db()
        .then((db) => {
          const request = db
            .transaction("assets")
            .objectStore("assets")
            .getAllKeys();
          request.onsuccess = () => resolve(request.result);
        });
    });
    expect(keys.map(String)).toEqual([
      expect.stringContaining(`${other.id}:keep:`),
    ]);
    await repo.close();
  });
});
describe("IndexedDB versionchange and blocked upgrades", () => {
  it("a newer version from another tab warns persistently and keeps work in memory", async () => {
    const { repo, factory, warnings } = repository();
    const doc = emptyProject(),
      first = await repo.save(doc, 0);
    const newer = await rawOpen(factory, DATABASE_VERSION + 1);
    newer.close();
    await until(() => warnings.some((w) => w && /newer version/.test(w)));
    await expect(repo.save(doc, first.revision)).rejects.toThrow(
      /newer version/,
    );
    expect(warnings.at(-1)).toMatch(/newer version/);
    expect(doc.schemaVersion).toBe("1.3.0");
    await repo.close();
  });
  it("database deletion from another tab closes and transparently reopens", async () => {
    const { repo, factory } = repository();
    const doc = emptyProject();
    await repo.save(doc, 0);
    await new Promise<void>((resolve, reject) => {
      const request = factory.deleteDatabase(NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("blocked"));
    });
    const again = await repo.save(doc, 0);
    expect(again.revision).toBe(1);
    expect(await repo.heads()).toHaveLength(1);
    await repo.close();
  });
  it("a blocked upgrade waits with a warning instead of failing until reload", async () => {
    const factory = new IDBFactory();
    const old = await rawOpen(factory, 2);
    const { repo, warnings } = repository(factory);
    const saving = repo.save(emptyProject(), 0);
    await until(() =>
      warnings.some((w) => w && /another XCursus Studio tab/.test(w)),
    );
    old.close();
    expect((await saving).revision).toBe(1);
    expect(warnings.at(-1)).toBeNull();
    await repo.close();
  });
  it("upgrades 0.4 data and indexes existing revisions for garbage collection", async () => {
    const factory = new IDBFactory();
    const old = await rawOpen(factory, 2);
    const doc = emptyProject();
    await new Promise<void>((resolve) => {
      const tx = old.transaction(
        ["documents", "recovery", "assets"],
        "readwrite",
      );
      const revision = {
        projectId: doc.id,
        revision: 1,
        updatedAt: 1,
        document: doc,
        assetKeys: [`${doc.id}:old:abc`],
      };
      tx.objectStore("documents").put(revision);
      tx.objectStore("recovery").put(revision);
      tx.objectStore("assets").put({
        key: `${doc.id}:old:abc`,
        id: "old",
        bytes: new ArrayBuffer(1),
        mime: "text/plain",
      });
      tx.oncomplete = () => resolve();
    });
    old.close();
    const { repo } = repository(factory);
    expect((await repo.heads())[0]!.revision).toBe(1);
    await repo.deleteProject(doc.id);
    expect(await repo.heads()).toEqual([]);
    await repo.close();
  });
});
describe("local project management and recovery proposal", () => {
  it("deletes single revisions and whole projects with their unreferenced assets", async () => {
    const { repo } = repository();
    const a = emptyProject(),
      b = emptyProject();
    const shared = withAsset(a, "x", "project a");
    const kept = withAsset(b, "y", "project b");
    await repo.save(b, 0, new Map([["y", kept]]));
    let rev = 0;
    for (let i = 0; i < 3; i++)
      rev = (await repo.save(a, rev, new Map([["x", shared]]))).revision;
    const head = await repo.deleteRevision(a.id, 3);
    expect(head?.revision).toBe(2);
    expect((await repo.revisions(a.id)).map((r) => r.revision)).toEqual([2, 1]);
    expect(
      (await repo.heads()).find((h) => h.projectId === a.id)?.revision,
    ).toBe(2);
    await repo.deleteRevision(a.id, 1);
    expect((await repo.revisions(a.id)).map((r) => r.revision)).toEqual([2]);
    await repo.deleteProject(a.id);
    expect((await repo.heads()).map((h) => h.projectId)).toEqual([b.id]);
    expect(await repo.revisions(a.id)).toEqual([]);
    const head2 = (await repo.heads())[0]!;
    expect((await repo.blobs(head2)).size).toBe(1);
    expect(await repo.deleteRevision(b.id, 1)).toBeNull();
    expect(await repo.heads()).toEqual([]);
    await repo.close();
  });
  it("a clean save marks the head so startup no longer proposes recovery", async () => {
    const { repo } = repository();
    const autosave = new Autosave(repo);
    const doc = emptyProject();
    await autosave.flush(doc);
    expect(pendingRecovery(await repo.heads())).toHaveLength(1);
    await autosave.flush(doc, true);
    const heads = await repo.heads();
    expect(heads[0]!.revision).toBe(1);
    expect(pendingRecovery(heads)).toEqual([]);
    const edited = structuredClone(doc);
    edited.metadata.title = "after save";
    await autosave.flush(edited);
    expect(pendingRecovery(await repo.heads())).toHaveLength(1);
    await autosave.flush(edited, true);
    expect(pendingRecovery(await repo.heads())).toEqual([]);
    autosave.dispose();
    await repo.close();
  });
});
describe("storage edge cases", () => {
  it("rejects stale writers atomically and only marks the current head as saved", async () => {
    const { repo } = repository();
    const doc = emptyProject();
    const first = await repo.save(doc, 0);
    await repo.save(doc, first.revision);
    await expect(repo.save(doc, first.revision)).rejects.toBeInstanceOf(
      StorageConflict,
    );
    expect(await repo.markSaved(doc.id, first.revision)).toBe(false);
    expect(await repo.markSaved(doc.id, 2)).toBe(true);
    expect(await repo.markSaved(doc.id, 2)).toBe(false);
    expect((await repo.revisions(doc.id))[0]!.saved).toBe(true);
    expect(await repo.deleteRevision(doc.id, 99)).toMatchObject({
      revision: 2,
    });
    await expect(
      repo.save({ ...doc, schemaVersion: "9.9.9" } as never, 2),
    ).rejects.toThrow(/invalid document/);
    await repo.close();
  });
  it("retries with the bytes when another tab collected a key between the two transactions", async () => {
    const { repo } = repository();
    const doc = emptyProject(),
      blob = withAsset(doc, "cap", "retry");
    const internals = repo as unknown as {
      present: (db: IDBDatabase, keys: string[]) => Promise<Set<string>>;
    };
    const present = internals.present.bind(repo);
    let calls = 0;
    internals.present = async (db, keys) => {
      calls++;
      return calls === 1 ? new Set(keys) : present(db, keys);
    };
    const saved = await repo.save(doc, 0, new Map([["cap", blob]]));
    expect(calls).toBe(2);
    expect((await repo.blobs(saved)).get("cap")?.size).toBe(blob.size);
    await repo.close();
  });
  it("Autosave reports failures, skips version errors and rebases after deletions", async () => {
    const { repo } = repository();
    const warnings: string[] = [];
    const autosave = new Autosave(repo, new Map(), (m) => warnings.push(m));
    const doc = emptyProject();
    await autosave.flush(doc);
    await autosave.flush(doc);
    expect((await repo.revisions(doc.id)).length).toBe(1);
    await repo.deleteProject(doc.id);
    autosave.rebase(doc.id, null);
    await autosave.flush(doc);
    expect((await repo.heads())[0]!.revision).toBe(1);
    autosave.rebase(doc.id, 1);
    autosave.setRevision(doc.id, 5);
    await autosave.flush({ ...doc, metadata: { ...doc.metadata, title: "x" } });
    expect(warnings.at(-1)).toMatch(/Autosave unavailable/);
    autosave.dispose();
    await repo.close();
  });
});
describe("editor Blob library", () => {
  it("keeps old Blobs reachable by asset key and maps them back by ID", () => {
    const doc = emptyProject(),
      first = withAsset(doc, "a", "one");
    const library = mergeBlobs(new Map(), doc, new Map([["a", first]]));
    expect(projectBlobs(doc, library).get("a")).toBe(first);
    const replaced = structuredClone(doc),
      second = new Blob(["two"]);
    replaced.assets[0]!.sha256 = "f".repeat(64);
    const next = mergeBlobs(library, replaced, new Map([["a", second]]));
    expect(projectBlobs(doc, next).get("a")).toBe(first);
    expect(projectBlobs(replaced, next).get("a")).toBe(second);
    const noDigest = emptyProject();
    noDigest.assets.push({
      id: "b",
      path: "assets/b/b.txt",
      mime: "text/plain",
      byteLength: 1,
    });
    expect(assetKey(noDigest.assets[0]!)).toBe("b:assets/b/b.txt:1");
    expect(projectBlobs(noDigest, next).size).toBe(0);
  });
});

describe("names shown and written by Studio", () => {
  it("download names keep one underscore per run of other characters", () => {
    expect(downloadName("Temporal System — stress-test (edited)", "json")).toBe(
      "Temporal_System_stress-test_edited.json",
    );
    expect(downloadName("Café: «draft»", "xcursus")).toBe("Café_draft.xcursus");
    expect(downloadName(" — ", "json")).toBe("xcursus.json");
  });
  it("revision times use the British English interface, not the browser locale", () => {
    const time = revisionTime(Date.UTC(2026, 9, 29, 10, 11, 22));
    expect(time).toMatch(/^\d{2}\/\d{2}\/\d{4},? \d{2}:\d{2}:\d{2}$/);
    expect(time).not.toMatch(/AM|PM/);
  });
});
