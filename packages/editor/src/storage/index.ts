import { validateDocument } from "@xcursus/core";
import type { ProjectDocument } from "@xcursus/core";
import { sha256, verifyAsset } from "@xcursus/player";
import type { AssetBlobs } from "@xcursus/player";
import {
  ARCHIVE_LIMIT,
  JSON_LIMIT,
  ARCHIVE_EXTENSION,
  LEGACY_ARCHIVE_EXTENSION,
  archiveFormat,
} from "@xcursus/plugins/archive";
import { documentJSON } from "../store/index.js";
export * from "./archive.js";
export * from "./assets.js";
/**
 * Storage identifier inherited from the product's former name (SpatialDeck).
 * It is deliberately unchanged: renaming the database would orphan the
 * autosaved revisions and resources already kept by existing installations.
 */
export const DATABASE_NAME = "spatialdeck-studio";
/** v3 adds the multiEntry `assetKeys` index used by garbage collection. */
export const DATABASE_VERSION = 3;
export interface Revision {
  projectId: string;
  revision: number;
  updatedAt: number;
  document: ProjectDocument;
  assetKeys?: string[];
  /** This exact revision was also saved to a file: startup does not propose it. */
  saved?: boolean;
}
export class StorageConflict extends Error {
  constructor() {
    super(
      "Another tab saved a newer revision. Save a JSON copy of the active work.",
    );
  }
}
const NEWER =
  "A newer version of XCursus Studio upgraded the local storage in another tab. Autosave and recovery are suspended: the work stays in memory; use Save JSON and reload the page.";
const BLOCKED =
  "Local storage is blocked by another XCursus Studio tab running an older version. Close or reload the other tabs: autosave resumes on its own and the work stays in memory.";
export class StorageVersionError extends Error {
  constructor() {
    super(NEWER);
  }
}
/** Size gate before reading a file the user opens; the message names the file kind. */
export function openLimitError(file: {
  name: string;
  size: number;
}): string | null {
  const archive = archiveFormat(file.name);
  const limit = archive ? ARCHIVE_LIMIT : JSON_LIMIT;
  if (file.size <= limit) return null;
  const mib = limit / 1024 / 1024;
  return archive
    ? `The ${archive === "legacy" ? LEGACY_ARCHIVE_EXTENSION : ARCHIVE_EXTENSION} archive exceeds ${mib} MiB.`
    : `The JSON file exceeds ${mib} MiB.`;
}
/** Download name from the project title: one underscore per run of other characters. */
export function downloadName(title: string, extension: string): string {
  const base = title.replace(/[^\p{L}\p{N}_-]+/gu, "_").replace(/^_+|_+$/g, "");
  return `${base || "xcursus"}.${extension}`;
}
/** Revision times in the language of the Studio interface, not the browser's. */
export function revisionTime(updatedAt: number): string {
  return new Date(updatedAt).toLocaleString("en-GB", {
    dateStyle: "short",
    timeStyle: "medium",
  });
}
/** Heads that differ from the last file save: the only ones proposed at startup. */
export function pendingRecovery(heads: readonly Revision[]): Revision[] {
  return heads.filter((head) => !head.saved);
}
function upgrade(db: IDBDatabase, tx: IDBTransaction) {
  if (!db.objectStoreNames.contains("documents"))
    db.createObjectStore("documents", { keyPath: "projectId" });
  const recovery = db.objectStoreNames.contains("recovery")
    ? tx.objectStore("recovery")
    : db.createObjectStore("recovery", { keyPath: ["projectId", "revision"] });
  if (!db.objectStoreNames.contains("assets"))
    db.createObjectStore("assets", { keyPath: "key" });
  if (!recovery.indexNames.contains("assetKeys"))
    recovery.createIndex("assetKeys", "assetKeys", { multiEntry: true });
}
const range = (projectId: string, last = Number.MAX_SAFE_INTEGER) =>
  IDBKeyRange.bound([projectId, 0], [projectId, last]);
function done<T>(tx: IDBTransaction, value: () => T): Promise<T> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(value());
    tx.onabort = () => reject(tx.error ?? new Error("Transaction aborted."));
  });
}
/** Deletes assets no longer referenced by any retained revision, among the given candidates only. */
function collect(tx: IDBTransaction, keys: Iterable<string>) {
  const index = tx.objectStore("recovery").index("assetKeys"),
    assets = tx.objectStore("assets");
  for (const key of new Set(keys)) {
    const count = index.count(key);
    count.onsuccess = () => {
      if (count.result === 0) assets.delete(key);
    };
  }
}
export class RecoveryRepository {
  private connection: Promise<IDBDatabase> | undefined;
  private listeners = new Set<(message: string | null) => void>();
  private warning: string | null = null;
  private newer = false;
  constructor(
    private open: () => IDBOpenDBRequest = () =>
      indexedDB.open(DATABASE_NAME, DATABASE_VERSION),
  ) {}
  /** Persistent storage states (blocked upgrade, newer version elsewhere); null clears them. */
  onWarning(listener: (message: string | null) => void): () => void {
    this.listeners.add(listener);
    if (this.warning) listener(this.warning);
    return () => {
      this.listeners.delete(listener);
    };
  }
  private warn(message: string | null) {
    if (message === this.warning) return;
    this.warning = message;
    for (const listener of [...this.listeners])
      try {
        listener(message);
      } catch {
        /* A failing listener cannot break storage. */
      }
  }
  private db(): Promise<IDBDatabase> {
    if (this.newer) return Promise.reject(new StorageVersionError());
    if (this.connection) return this.connection;
    const pending = new Promise<IDBDatabase>((resolve, reject) => {
      let request: IDBOpenDBRequest;
      try {
        request = this.open();
      } catch (e) {
        reject(e);
        return;
      }
      request.onupgradeneeded = () =>
        upgrade(request.result, request.transaction!);
      // Another tab holds an older version open: keep waiting, never fail until reload.
      request.onblocked = () => this.warn(BLOCKED);
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = (event) => {
          db.close();
          if (this.connection === pending) this.connection = undefined;
          if (event.newVersion !== null) {
            this.newer = true;
            this.warn(NEWER);
          }
        };
        db.onclose = () => {
          if (this.connection === pending) this.connection = undefined;
        };
        if (this.warning === BLOCKED) this.warn(null);
        resolve(db);
      };
      request.onerror = () => {
        if (request.error?.name === "VersionError") {
          this.newer = true;
          this.warn(NEWER);
          reject(new StorageVersionError());
        } else reject(request.error);
      };
    });
    this.connection = pending;
    pending.catch(() => {
      if (this.connection === pending) this.connection = undefined;
    });
    return pending;
  }
  async heads(): Promise<Revision[]> {
    const db = await this.db();
    const tx = db.transaction("documents", "readonly");
    const req = tx.objectStore("documents").getAll();
    return done(tx, () =>
      (req.result as Revision[]).sort((a, b) => b.updatedAt - a.updatedAt),
    );
  }
  async revisions(projectId: string): Promise<Revision[]> {
    const db = await this.db();
    const tx = db.transaction("recovery", "readonly");
    const req = tx.objectStore("recovery").getAll(range(projectId));
    return done(tx, () =>
      (req.result as Revision[]).sort((a, b) => b.revision - a.revision),
    );
  }
  private async present(db: IDBDatabase, keys: string[]) {
    const tx = db.transaction("assets", "readonly"),
      store = tx.objectStore("assets"),
      found = new Set<string>();
    for (const key of new Set(keys)) {
      const req = store.getKey(key);
      req.onsuccess = () => {
        if (req.result !== undefined) found.add(key);
      };
    }
    return done(tx, () => found);
  }
  async save(
    document: ProjectDocument,
    expectedRevision: number,
    blobs: AssetBlobs = new Map(),
    options: { saved?: boolean } = {},
    attempt = 0,
  ): Promise<Revision> {
    const validated = validateDocument(document);
    if (!validated.ok) throw new Error("Autosave: invalid document.");
    // Keys come from declared or memoized digests. Verification is memoized per Blob.
    const entries: Array<{
      key: string;
      id: string;
      mime: string;
      blob: Blob;
    }> = [];
    for (const asset of validated.value.assets) {
      const blob = blobs.get(asset.id);
      if (!blob) continue;
      await verifyAsset(asset, blob);
      entries.push({
        key: `${document.id}:${asset.id}:${asset.sha256 ?? (await sha256(blob))}`,
        id: asset.id,
        mime: asset.mime,
        blob,
      });
    }
    const db = await this.db();
    const stored = entries.length
      ? await this.present(
          db,
          entries.map((e) => e.key),
        )
      : new Set<string>();
    // Persist immutable bytes, read only for new keys. WebKit macOS 14 cannot reliably clone File-backed Blobs into IDB.
    const bytes = new Map<string, ArrayBuffer>();
    for (const e of entries)
      if (!stored.has(e.key) && !bytes.has(e.key))
        bytes.set(e.key, await e.blob.arrayBuffer());
    return new Promise((resolve, reject) => {
      const tx = db.transaction(
        ["documents", "recovery", "assets"],
        "readwrite",
      );
      let conflict = false,
        lost = false;
      let writeError: unknown;
      const head = tx.objectStore("documents"),
        recovery = tx.objectStore("recovery"),
        assets = tx.objectStore("assets");
      const request = head.get(document.id);
      const revision: Revision = {
        projectId: document.id,
        revision: expectedRevision + 1,
        updatedAt: Date.now(),
        document: validated.value,
        assetKeys: [...new Set(entries.map((e) => e.key))],
        ...(options.saved ? { saved: true } : {}),
      };
      request.onsuccess = () => {
        if (
          ((request.result as Revision | undefined)?.revision ?? 0) !==
          expectedRevision
        ) {
          conflict = true;
          tx.abort();
          return;
        }
        try {
          head.put(revision);
          recovery.put(revision);
          for (const e of entries) {
            const data = bytes.get(e.key);
            if (data) {
              assets.put({ key: e.key, id: e.id, bytes: data, mime: e.mime });
              bytes.delete(e.key);
            } else if (stored.has(e.key)) {
              // Collected by another tab since the read: retry with the bytes.
              const check = assets.getKey(e.key);
              check.onsuccess = () => {
                if (check.result === undefined && !lost) {
                  lost = true;
                  tx.abort();
                }
              };
            }
          }
          const expired = range(
            document.id,
            Math.max(0, revision.revision - 10),
          );
          const old = recovery.getAll(expired);
          old.onsuccess = () => {
            recovery.delete(expired);
            collect(
              tx,
              (old.result as Revision[]).flatMap((r) => r.assetKeys ?? []),
            );
          };
        } catch (error) {
          writeError = error;
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve(revision);
      tx.onabort = () => {
        if (lost && attempt < 1)
          resolve(
            this.save(document, expectedRevision, blobs, options, attempt + 1),
          );
        else
          reject(
            conflict
              ? new StorageConflict()
              : (writeError ?? tx.error ?? new Error("Autosave aborted.")),
          );
      };
      tx.onerror = () => {
        writeError ??= tx.error;
        try {
          tx.abort();
        } catch {
          /* Already aborting. */
        }
      };
    });
  }
  /** Records that `revision` matches a file the user saved, when it is still the head. */
  async markSaved(projectId: string, revision: number): Promise<boolean> {
    const db = await this.db();
    const tx = db.transaction(["documents", "recovery"], "readwrite");
    const documents = tx.objectStore("documents"),
      recovery = tx.objectStore("recovery");
    let marked = false;
    const head = documents.get(projectId);
    head.onsuccess = () => {
      const current = head.result as Revision | undefined;
      if (current?.revision !== revision || current.saved) return;
      marked = true;
      documents.put({ ...current, saved: true });
      const record = recovery.get([projectId, revision]);
      record.onsuccess = () => {
        if (record.result) recovery.put({ ...record.result, saved: true });
      };
    };
    return done(tx, () => marked);
  }
  /** Removes one local revision; the head moves to the newest remaining one. Returns that head, or null. */
  async deleteRevision(
    projectId: string,
    revision: number,
  ): Promise<Revision | null> {
    const db = await this.db();
    const tx = db.transaction(["documents", "recovery", "assets"], "readwrite");
    const documents = tx.objectStore("documents"),
      recovery = tx.objectStore("recovery");
    let result: Revision | null = null;
    const record = recovery.get([projectId, revision]);
    record.onsuccess = () => {
      const removed = record.result as Revision | undefined;
      recovery.delete([projectId, revision]);
      const head = documents.get(projectId);
      head.onsuccess = () => {
        const current = head.result as Revision | undefined;
        if (current && current.revision !== revision) {
          result = current;
          return;
        }
        const newest = recovery.openCursor(range(projectId), "prev");
        newest.onsuccess = () => {
          const next = newest.result?.value as Revision | undefined;
          if (next) documents.put(next);
          else documents.delete(projectId);
          result = next ?? null;
        };
      };
      if (removed) collect(tx, removed.assetKeys ?? []);
    };
    return done(tx, () => result);
  }
  /** Removes every local revision of a project and its unreferenced resources. */
  async deleteProject(projectId: string): Promise<void> {
    const db = await this.db();
    const tx = db.transaction(["documents", "recovery", "assets"], "readwrite");
    const recovery = tx.objectStore("recovery");
    const all = recovery.getAll(range(projectId));
    all.onsuccess = () => {
      recovery.delete(range(projectId));
      tx.objectStore("documents").delete(projectId);
      collect(
        tx,
        (all.result as Revision[]).flatMap((r) => r.assetKeys ?? []),
      );
    };
    return done(tx, () => undefined);
  }
  async blobs(revision: Revision): Promise<Map<string, Blob>> {
    const db = await this.db();
    const tx = db.transaction("assets", "readonly"),
      result = new Map<string, Blob>();
    for (const key of revision.assetKeys ?? []) {
      const request = tx.objectStore("assets").get(key);
      request.onsuccess = () => {
        const a = request.result as
          | { id: string; blob?: Blob; bytes?: ArrayBuffer; mime?: string }
          | undefined;
        if (a?.blob) result.set(a.id, a.blob);
        else if (a?.bytes)
          result.set(
            a.id,
            new Blob([a.bytes], {
              type: a.mime ?? "application/octet-stream",
            }),
          );
      };
    }
    return done(tx, () => result);
  }
  async close() {
    const connection = this.connection;
    this.connection = undefined;
    try {
      (await connection)?.close();
    } catch {
      /* Failed opens have no connection to close. */
    }
    this.connection = undefined;
  }
}
/** Serialized writes; the debounce is independent of React renders and storage latency. */
export class Autosave {
  private last = new Map<string, string>();
  private signature(document: ProjectDocument, blobs: AssetBlobs) {
    return documentJSON(document) + JSON.stringify([...blobs.keys()].sort());
  }
  private timer: ReturnType<typeof setTimeout> | undefined;
  private queue = Promise.resolve();
  private stopped = false;
  constructor(
    private repository: RecoveryRepository,
    private revisions = new Map<string, number>(),
    private report: (message: string) => void = () => {},
    private blobs: (document: ProjectDocument) => AssetBlobs = () => new Map(),
  ) {}
  setRevision(projectId: string, revision: number, document?: ProjectDocument) {
    this.revisions.set(projectId, revision);
    if (document)
      this.last.set(projectId, this.signature(document, this.blobs(document)));
  }
  /** Local revisions were deleted: follow the new head (null when none is left) and write again on the next flush. */
  rebase(projectId: string, head: number | null) {
    if (head === null) this.revisions.delete(projectId);
    else if (this.revisions.get(projectId) === head) return;
    else this.revisions.set(projectId, head);
    this.last.delete(projectId);
  }
  schedule(document: ProjectDocument) {
    if (this.stopped) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush(document);
    }, 750);
  }
  /** Writes a revision when the document changed; `saved` marks it as matching a file save. */
  flush(document: ProjectDocument, saved = false) {
    clearTimeout(this.timer);
    this.timer = undefined;
    const blobs = new Map(this.blobs(document));
    const key = this.signature(document, blobs);
    this.queue = this.queue.then(async () => {
      if (this.stopped) return;
      try {
        if (this.last.get(document.id) === key) {
          if (saved)
            await this.repository.markSaved(
              document.id,
              this.revisions.get(document.id) ?? 0,
            );
          return;
        }
        const rev = await this.repository.save(
          document,
          this.revisions.get(document.id) ?? 0,
          blobs,
          { saved },
        );
        this.revisions.set(document.id, rev.revision);
        this.last.set(document.id, key);
      } catch (e) {
        // The repository reports its own persistent version warning.
        if (!(e instanceof StorageVersionError))
          this.report(
            `Autosave unavailable: ${String(e)} The document stays in memory; use Save JSON.`,
          );
      }
    });
    return this.queue;
  }
  resume() {
    this.stopped = false;
  }
  cancelPending() {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
  dispose() {
    this.stopped = true;
    this.cancelPending();
  }
}
