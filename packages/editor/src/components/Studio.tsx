import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { Player } from "@xcursus/player";
import type { AssetBlobs } from "@xcursus/player";
import type { PluginDefinition } from "@xcursus/plugins";
import {
  contrastIssues,
  serializeDocument,
  validateDocument,
} from "@xcursus/core";
import type { Result, ProjectDocument } from "@xcursus/core";
import {
  convertToFlow,
  createScene,
  editImpact,
  deleteScene,
  emptyProject,
} from "../commands/index.js";
import { EditorStore } from "../store/index.js";
import {
  Autosave,
  RecoveryRepository,
  downloadName,
  archiveFormat,
  ARCHIVE_EXTENSION,
  LEGACY_ARCHIVE_EXTENSION,
  openLimitError,
  PROJECT_ACCEPT,
  pendingRecovery,
  revisionTime,
  readArchive,
  writeArchive,
  projectBlobs,
  mergeBlobs,
} from "../storage/index.js";
import type { Revision } from "../storage/index.js";
import { Dialog } from "./Dialog.js";
import { Inspector } from "./Inspector.js";
import { MapView } from "./MapView.js";
import { HierarchyTree } from "./HierarchyTree.js";
import { PathPanel } from "./PathPanel.js";
import type { NavigationSelection } from "./PathPanel.js";
import type { Capture } from "./CameraTimeline.js";
import { PlayerSurface } from "./PlayerSurface.js";
import { AssetPanel } from "./AssetPanel.js";
import { LayoutEditor } from "./LayoutEditor.js";
import { LayoutPanel } from "./LayoutPanel.js";
import { ThemePanel } from "./ThemePanel.js";
import { SceneThumb } from "./SceneThumb.js";
import { BrandMark, Icon, IconButton } from "./icons.js";
import {
  PRESENTER_SESSION_KEY,
  PresenterView,
  findPublicWindow,
  openPublicWindow,
} from "./PresenterView.js";
import { randomToken } from "@xcursus/player/presenter";
const noPlugins: readonly PluginDefinition[] = [];
const inspectorTabs = [
  ["scene", "Scene"],
  ["paths", "Paths"],
  ["theme", "Theme"],
] as const;
type InspectorTab = (typeof inspectorTabs)[number][0];
export interface StudioProps {
  store?: EditorStore;
  repository?: RecoveryRepository;
  onPlayer?: (player: Player | null, present: boolean) => void;
  /** Plugins approved by the host application for preview and presentation. */
  plugins?: readonly PluginDefinition[];
}
export function Studio({
  store: providedStore,
  repository: providedRepository,
  onPlayer,
  plugins = noPlugins,
}: StudioProps) {
  const store = useMemo(
    () => providedStore ?? new EditorStore(emptyProject()),
    [providedStore],
  );
  const repository = useMemo(
    () => providedRepository ?? new RecoveryRepository(),
    [providedRepository],
  );
  const session = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const [library, setLibrary] = useState(new Map<string, Blob>());
  const libraryRef = useRef(library);
  libraryRef.current = library;
  const blobs = useMemo(
    () => projectBlobs(session.document, library),
    [session.document, library],
  );
  function loadBlobs(doc: ProjectDocument, incoming: AssetBlobs) {
    const next = mergeBlobs(libraryRef.current, doc, incoming);
    libraryRef.current = next;
    setLibrary(next);
  }
  const [warning, setWarning] = useState(""),
    [storageWarning, setStorageWarning] = useState<string | null>(null),
    [error, setError] = useState(""),
    [present, setPresent] = useState(false),
    [presenter, setPresenter] = useState<{
      sessionId: string;
      popup: Window | null;
    } | null>(null),
    // A presenter session survives a reload of this tab: it can be resumed.
    [resumable, setResumable] = useState<string | null>(() => {
      try {
        return sessionStorage.getItem(PRESENTER_SESSION_KEY);
      } catch {
        return null;
      }
    }),
    [preview, setPreview] = useState(true);
  // Inspector tab and presentation chrome: UI state only, never part of the document.
  const [tab, setTab] = useState<InspectorTab>("scene"),
    [idle, setIdle] = useState(false),
    [presentedTitle, setPresentedTitle] = useState("");
  const presenting = useRef<Player | null>(null),
    presentingUnsubscribe = useRef<(() => void) | null>(null);
  const [dialog, setDialog] = useState<{
      title: string;
      body: string;
      action: () => void;
      confirm?: string;
    } | null>(null),
    [revisions, setRevisions] = useState<Revision[]>([]),
    [recoveryIndex, setRecoveryIndex] = useState(0);
  const [navigation, setNavigation] = useState<NavigationSelection | null>(
      null,
    ),
    [capture, setCapture] = useState<Capture | null>(null);
  // Scene editor (Impagina): UI state only, never part of the document.
  const [layoutMode, setLayoutMode] = useState(false),
    [blockSelection, setBlockSelection] = useState<string[]>([]),
    [grid, setGrid] = useState(0),
    [announcement, setAnnouncement] = useState(""),
    [previewHost, setPreviewHost] = useState<HTMLDivElement | null>(null),
    [previewRevision, setPreviewRevision] = useState(0);
  const previewUnsubscribe = useRef<(() => void) | null>(null);
  const openButton = useRef<HTMLButtonElement>(null);
  const undoButton = useRef<HTMLButtonElement>(null),
    redoButton = useRef<HTMLButtonElement>(null);
  const file = useRef<HTMLInputElement>(null),
    presentButton = useRef<HTMLButtonElement>(null),
    presentation = useRef<HTMLDivElement>(null);
  const autosave = useMemo(
    () =>
      new Autosave(repository, new Map(), setWarning, (doc) =>
        projectBlobs(doc, libraryRef.current),
      ),
    [repository],
  );
  const selected = session.document.scenes.find(
    (s) => s.id === session.selection,
  );
  const layoutScene = layoutMode && preview ? selected : undefined;
  const themeIssues = useMemo(
    () => contrastIssues(session.document).length,
    [session.document],
  );
  // Block selection belongs to one scene and drops blocks that no longer exist.
  useEffect(() => setBlockSelection([]), [session.selection, layoutMode]);
  useEffect(() => {
    setBlockSelection((ids) => {
      const kept = ids.filter((id) =>
        selected?.blocks.some((b) => b.id === id),
      );
      return kept.length === ids.length ? ids : kept;
    });
  }, [selected]);
  function previewPlayer(player: Player | null, present: boolean) {
    onPlayer?.(player, present);
    if (present) return;
    previewUnsubscribe.current?.();
    previewUnsubscribe.current = player
      ? player.on("documentchange", () => setPreviewRevision((n) => n + 1))
      : null;
  }
  function presentationPlayer(player: Player | null) {
    presenting.current = player;
    presentingUnsubscribe.current?.();
    presentingUnsubscribe.current = null;
    if (!player) return;
    const sync = () =>
      setPresentedTitle(
        store
          .getSnapshot()
          .document.scenes.find((s) => s.id === player.getState().sceneId)
          ?.title ?? "",
      );
    const off = [player.on("ready", sync), player.on("scenechange", sync)];
    presentingUnsubscribe.current = () => off.forEach((f) => f());
    // The first scene may already be active when the player is handed over.
    sync();
  }
  function report(result: Result<unknown>) {
    setError(
      result.ok ? "" : result.diagnostics.map((d) => d.message).join("; "),
    );
  }
  useEffect(() => repository.onWarning(setStorageWarning), [repository]);
  useEffect(() => {
    autosave.resume();
    let active = true;
    void repository
      .heads()
      .then((heads) => {
        // Only revisions that differ from the last saved file are proposed.
        const pending = pendingRecovery(heads);
        if (active && pending.length) setRevisions(pending);
      })
      .catch((e) => {
        if (active)
          setWarning(`Recovery unavailable: ${String(e)} Use Save JSON.`);
      });
    return () => {
      active = false;
      autosave.dispose();
      if (!providedRepository) void repository.close();
    };
  }, [repository, autosave, providedRepository]);
  useEffect(() => {
    if (session.dirty && !session.dragging) autosave.schedule(session.document);
  }, [session.document, session.dirty, session.dragging, autosave, library]);
  useEffect(() => {
    const flush = () => {
      const current = store.getSnapshot();
      if (document.hidden && current.dirty && !current.dragging)
        void autosave.flush(current.document);
    };
    document.addEventListener("visibilitychange", flush);
    const unload = (event: BeforeUnloadEvent) => {
      if (store.getSnapshot().dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", unload);
    // An offline-shell update first saves unsaved work to local recovery.
    const beforeUpdate = (event: Event) => {
      const current = store.getSnapshot();
      const wait = (event as CustomEvent<{ wait(p: Promise<unknown>): void }>)
        .detail?.wait;
      if (current.dirty && !current.dragging && wait)
        wait(autosave.flush(current.document));
    };
    window.addEventListener("xcursus:before-update", beforeUpdate);
    return () => {
      document.removeEventListener("visibilitychange", flush);
      window.removeEventListener("beforeunload", unload);
      window.removeEventListener("xcursus:before-update", beforeUpdate);
    };
  }, [autosave, store]);
  useEffect(() => {
    if (present) presentation.current?.focus();
    else {
      presentButton.current?.focus({ preventScroll: true });
      if (document.fullscreenElement) void document.exitFullscreen?.();
    }
  }, [present]);
  // The presentation controls fade after the pointer rests; focus keeps them visible.
  useEffect(() => {
    if (!present) return;
    const node = presentation.current;
    let timer = 0;
    const wake = () => {
      setIdle(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setIdle(true), 2500);
    };
    wake();
    node?.addEventListener("pointermove", wake);
    node?.addEventListener("pointerdown", wake);
    return () => {
      window.clearTimeout(timer);
      node?.removeEventListener("pointermove", wake);
      node?.removeEventListener("pointerdown", wake);
      setIdle(false);
    };
  }, [present]);
  // The browser consumes Escape to leave fullscreen: leaving fullscreen ends
  // the presentation too, so one Escape always returns to the editor.
  useEffect(() => {
    if (!present) return;
    const left = () => {
      if (!document.fullscreenElement) setPresent(false);
    };
    document.addEventListener("fullscreenchange", left);
    return () => document.removeEventListener("fullscreenchange", left);
  }, [present]);
  /** Fullscreen needs the user's gesture: requested in the click handler, best effort. */
  const presentHere = () => {
    store.endDrag();
    void document.documentElement.requestFullscreen?.().catch(() => {});
    setPresent(true);
  };
  const startPresenter = () => {
    store.endDrag();
    const sessionId = randomToken();
    try {
      sessionStorage.setItem(PRESENTER_SESSION_KEY, sessionId);
    } catch {
      /* Without sessionStorage a reload ends the session. */
    }
    setResumable(null);
    setPresenter({ sessionId, popup: openPublicWindow(sessionId) });
  };
  function confirmReplace(action: () => void) {
    if (store.getSnapshot().dirty)
      setDialog({
        title: "Discard changes?",
        body: "Changes not saved to the JSON file will be replaced. You can cancel and save before continuing.",
        action,
      });
    else action();
  }
  async function openFile(input: File) {
    const format = archiveFormat(input.name);
    const limit = openLimitError(input);
    if (limit) {
      setError(limit);
      return;
    }
    try {
      const imported = format ? await readArchive(input) : null;
      const valid = imported
        ? { ok: true as const, value: imported.document, diagnostics: [] }
        : validateDocument(await input.text());
      if (!valid.ok) {
        report(valid);
        return;
      }
      confirmReplace(() => {
        autosave.cancelPending();
        report(store.replace(valid.value));
        if (imported) loadBlobs(valid.value, imported.blobs);
        // The legacy file is read as a copy and never written back.
        setWarning(
          format === "legacy"
            ? `Imported a legacy ${LEGACY_ARCHIVE_EXTENSION} archive. The original file is unchanged; Save archive writes a ${ARCHIVE_EXTENSION} file.`
            : "",
        );
        void repository
          .heads()
          .then((heads) => {
            const head = heads.find((h) => h.projectId === valid.value.id);
            if (
              head &&
              JSON.stringify(serializeDocument(head.document)) ===
                JSON.stringify(serializeDocument(valid.value))
            )
              autosave.setRevision(
                head.projectId,
                head.revision,
                head.document,
              );
            else if (head) {
              setWarning(
                "A different recovery exists for this project. Open Recovery to compare the revisions; the active file stays untouched.",
              );
            }
          })
          .catch(() => {});
      });
    } catch (e) {
      setError(`Could not open the file: ${String(e)}`);
    }
  }
  function save() {
    const active = window.document.activeElement as HTMLElement | null;
    if (active?.matches("input,textarea,select")) active.blur();
    store.endDrag();
    const document = store.getSnapshot().document;
    const serialized = store.serialize();
    if (!serialized.ok) {
      report(serialized);
      return;
    }
    const url = URL.createObjectURL(
      new Blob([serialized.value], { type: "application/json" }),
    );
    const link = window.document.createElement("a");
    link.href = url;
    link.download = downloadName(document.metadata.title, "json");
    window.document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    store.markSaved(document);
    active?.focus({ preventScroll: true });
    void autosave.flush(document, true);
  }
  async function savePortable() {
    const active = window.document.activeElement as HTMLElement | null;
    if (active?.matches("input,textarea,select")) active.blur();
    store.endDrag();
    const doc = store.getSnapshot().document;
    try {
      const blob = await writeArchive(
        doc,
        projectBlobs(doc, libraryRef.current),
      );
      const url = URL.createObjectURL(blob),
        link = window.document.createElement("a");
      link.href = url;
      link.download = downloadName(
        doc.metadata.title,
        ARCHIVE_EXTENSION.slice(1),
      );
      window.document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      store.markSaved(doc);
      void autosave.flush(doc, true);
      setError("");
    } catch (e) {
      setError(`Could not save the archive: ${String(e)}`);
    }
  }
  function remove() {
    if (!selected) return;
    const edit = deleteScene(selected.id, true);
    const impact = editImpact(session.document, edit);
    if (!impact.ok) {
      report(impact);
      return;
    }
    setDialog({
      title: "Delete the scene?",
      body: `“${selected.title}”: ${impact.value.description}`,
      confirm: "Delete scene",
      action: () => report(store.execute(edit)),
    });
  }
  async function recoverList(reportEmpty = true) {
    try {
      setRecoveryIndex(0);
      const heads = await repository.heads();
      if (!heads.length) {
        setRevisions([]);
        if (reportEmpty) setError("No recovery available.");
        return;
      }
      const all = (
        await Promise.all(heads.map((h) => repository.revisions(h.projectId)))
      ).flat();
      setRevisions(all);
    } catch (e) {
      setWarning(String(e));
    }
  }
  /** Local deletion always asks first; the open document and saved files are untouched. */
  function confirmDelete(project: boolean) {
    const target = revisions[recoveryIndex];
    if (!target) return;
    const title = target.document.metadata.title;
    setDialog({
      title: project
        ? "Delete the local project?"
        : "Delete the local revision?",
      body: project
        ? `All local revisions of “${title}” and the assets no longer in use will be removed from this browser. The open document and saved files do not change.`
        : `Revision ${target.revision} of “${title}” will be removed from this browser. The open document and saved files do not change.`,
      confirm: project ? "Delete project" : "Delete revision",
      action: () =>
        void (async () => {
          try {
            const head = project
              ? (await repository.deleteProject(target.projectId), null)
              : await repository.deleteRevision(
                  target.projectId,
                  target.revision,
                );
            autosave.rebase(target.projectId, head?.revision ?? null);
            await recoverList(false);
          } catch (e) {
            setError(`Could not delete: ${String(e)}`);
          }
        })(),
    });
  }
  async function recover() {
    const revision = revisions[recoveryIndex];
    if (!revision) return;
    let recovered: Map<string, Blob>;
    try {
      recovered = await repository.blobs(revision);
    } catch (e) {
      setError(String(e));
      return;
    }
    setRevisions([]);
    confirmReplace(() => {
      autosave.cancelPending();
      const result = store.replace(revision.document, false);
      if (result.ok) loadBlobs(revision.document, recovered);
      report(result);
      if (result.ok)
        autosave.setRevision(
          revision.projectId,
          revision.revision,
          revision.document,
        );
    });
  }
  return (
    <main
      className={`studio ${present ? "is-presenting" : ""}`}
      onKeyDown={(event) => {
        if (event.key === "Escape" && present) {
          setPresent(false);
          return;
        }
        if (present || presenter || dialog || revisions.length) return;
        const editing = (event.target as Element).matches(
          "input,textarea,select,[contenteditable]",
        );
        if (
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === "s"
        ) {
          event.preventDefault();
          save();
        } else if (
          (event.ctrlKey || event.metaKey) &&
          !editing &&
          event.key.toLowerCase() === "z"
        ) {
          event.preventDefault();
          if (event.shiftKey) store.redo();
          else store.undo();
        } else if (
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === "o"
        ) {
          event.preventDefault();
          file.current?.click();
        } else if (
          !editing &&
          (event.key === "Delete" || event.key === "Backspace")
        ) {
          event.preventDefault();
          remove();
        }
      }}
    >
      <header className="toolbar">
        <div className="brand">
          <BrandMark />
          <h1 className="brand-name">XCursus</h1>
        </div>
        <span className="toolbar-divider" aria-hidden="true" />
        <label className="title-field">
          <span className="visually-hidden">Project title</span>
          <input
            aria-label="Project title"
            value={session.document.metadata.title}
            onChange={(e) =>
              report(
                store.coalesce("metadata.title", (document) => {
                  document.metadata.title = e.target.value;
                  return { ok: true, value: document, diagnostics: [] };
                }),
              )
            }
            onBlur={() => store.endCoalesce()}
          />
        </label>
        <nav aria-label="Document tools" className="toolbar-actions">
          <IconButton
            icon="new"
            label="New"
            onClick={() =>
              confirmReplace(() => {
                autosave.cancelPending();
                report(store.replace(emptyProject()));
                setWarning("");
              })
            }
          />
          <IconButton
            icon="open"
            label="Open"
            shortcut="⌘O · JSON, .xcursus or legacy .spatialdeck"
            ref={openButton}
            onClick={() => file.current?.click()}
          />
          <IconButton
            icon="save"
            label="Save JSON"
            shortcut="⌘S"
            onClick={save}
          />
          <IconButton
            icon="archive"
            label="Save archive"
            shortcut=".xcursus file with the assets"
            onClick={() => void savePortable()}
          />
          <span className="toolbar-divider" aria-hidden="true" />
          <IconButton
            icon="undo"
            label="Undo"
            shortcut="⌘Z"
            ref={undoButton}
            disabled={!session.canUndo}
            onClick={() => {
              store.undo();
              if (!store.getSnapshot().canUndo) redoButton.current?.focus();
            }}
          />
          <IconButton
            icon="redo"
            label="Redo"
            shortcut="⇧⌘Z"
            ref={redoButton}
            disabled={!session.canRedo}
            onClick={() => {
              store.redo();
              if (!store.getSnapshot().canRedo) undoButton.current?.focus();
            }}
          />
          <span className="toolbar-divider" aria-hidden="true" />
          <IconButton
            icon="history"
            label="Recovery"
            shortcut="local revisions"
            onClick={() => void recoverList()}
          />
          <IconButton
            icon="eye"
            label="Preview"
            pressed={preview}
            onClick={() => setPreview(!preview)}
          />
          <span className="toolbar-divider" aria-hidden="true" />
          <button
            type="button"
            tabIndex={0}
            className="tool-button quiet"
            data-tip="Notes, previews and the audience window"
            data-tip-side="left"
            onClick={startPresenter}
            disabled={!session.document.scenes.length}
          >
            <Icon name="presenter" />
            Presenter
          </button>
          <button
            type="button"
            tabIndex={0}
            ref={presentButton}
            className="primary present-button"
            onClick={presentHere}
            disabled={!session.document.scenes.length}
          >
            <Icon name="play" />
            Present
          </button>
        </nav>
        <input
          ref={file}
          type="file"
          accept={PROJECT_ACCEPT}
          aria-label="JSON project file"
          className="file-input"
          onChange={(e) => {
            const input = e.target.files?.[0];
            e.target.value = "";
            if (input)
              void openFile(input).finally(() =>
                openButton.current?.focus({ preventScroll: true }),
              );
          }}
        />
      </header>
      {(storageWarning || warning) && (
        <div className="warning" role="status">
          {[storageWarning, warning].filter(Boolean).join(" ")}
        </div>
      )}
      {error && (
        <div className="error-banner" role="alert">
          {error}
          <button
            tabIndex={0}
            aria-label="Dismiss error"
            onClick={() => setError("")}
          >
            ×
          </button>
        </div>
      )}
      <div className="workspace">
        <details open className="scene-panel">
          <summary>
            Scenes <span>{session.document.scenes.length}</span>
          </summary>
          <div
            className="panel-actions"
            role="toolbar"
            aria-label="Scene actions"
          >
            <IconButton
              icon="plus"
              label="New scene"
              onClick={() => {
                setNavigation(null);
                setCapture(null);
                report(
                  store.execute(
                    createScene(session.selection ?? undefined),
                    true,
                  ),
                );
              }}
            />
            <IconButton
              icon="copy"
              label="Duplicate scene"
              disabled={!selected}
              onClick={() => {
                setNavigation(null);
                setCapture(null);
                report(
                  store.execute(
                    createScene(session.selection ?? undefined, true),
                    true,
                  ),
                );
              }}
            />
            <IconButton
              icon="trash"
              label="Delete scene"
              shortcut="Del"
              disabled={!selected}
              onClick={remove}
            />
          </div>
          {!session.document.scenes.length && (
            <div className="empty-scenes">
              <p>No scenes yet. A scene is a rectangle in space.</p>
              <button
                type="button"
                tabIndex={0}
                className="primary"
                onClick={() =>
                  report(store.execute(createScene(undefined), true))
                }
              >
                <Icon name="plus" />
                Create the first scene
              </button>
            </div>
          )}
          <ol aria-label="Scene list">
            {session.document.scenes.map((scene, index) => (
              <li key={scene.id}>
                <button
                  tabIndex={0}
                  aria-pressed={scene.id === session.selection}
                  onClick={() => {
                    store.select(scene.id);
                    setNavigation(null);
                    setCapture(null);
                  }}
                >
                  <span className="scene-number">{index + 1}</span>
                  <SceneThumb document={session.document} scene={scene} />
                  <span className="scene-label">
                    {scene.title || "Untitled"}
                    <small>
                      {scene.layout === "canvas" ? "Canvas" : "Flow"} ·{" "}
                      {scene.blocks.length === 1
                        ? "1 block"
                        : `${scene.blocks.length} blocks`}
                      {!scene.visible && " · hidden"}
                    </small>
                  </span>
                </button>
              </li>
            ))}
          </ol>
          <HierarchyTree store={store} session={session} />
          <AssetPanel
            store={store}
            document={session.document}
            blobs={blobs}
            onBlobs={loadBlobs}
          />
          <p className="local-note">
            <Icon name="device" />
            Only on this device: save a file to keep it.
          </p>
        </details>
        <div
          className={`center-column ${layoutScene ? "is-layout" : ""} ${preview ? "" : "no-preview"}`}
        >
          {preview && (
            <section
              className={`preview-panel ${layoutScene ? "is-layout" : ""}`}
              aria-label="Preview"
            >
              <div className="panel-heading">
                <h2>Preview</h2>
                <span className="panel-context">
                  {selected?.title ?? "No scene"}
                </span>
                <button
                  type="button"
                  tabIndex={0}
                  className="tool-button layout-toggle"
                  data-tip="Arrange the blocks of the scene"
                  aria-pressed={layoutMode}
                  disabled={!selected}
                  onClick={() => {
                    store.endDrag();
                    setNavigation(null);
                    setCapture(null);
                    // The scene editor's panel lives in the Scena tab.
                    if (!layoutMode) setTab("scene");
                    setLayoutMode(!layoutMode);
                    setAnnouncement(
                      layoutMode
                        ? "Layout closed."
                        : "Layout: scene framed head-on.",
                    );
                  }}
                >
                  <Icon name="frame" />
                  Layout
                </button>
              </div>
              <div className="preview-stage">
                <PlayerSurface
                  document={session.document}
                  selection={session.selection}
                  navigation={layoutScene ? null : navigation}
                  capture={layoutScene ? null : capture}
                  blobs={blobs}
                  layout={!!layoutScene}
                  onHost={setPreviewHost}
                  onPlayer={previewPlayer}
                  plugins={plugins}
                />
                {layoutScene && (
                  <LayoutEditor
                    store={store}
                    document={session.document}
                    scene={layoutScene}
                    host={previewHost}
                    revision={previewRevision}
                    selection={blockSelection}
                    onSelect={setBlockSelection}
                    grid={grid}
                    announce={setAnnouncement}
                  />
                )}
              </div>
            </section>
          )}
          <MapView store={store} session={session} />
        </div>
        <section className="inspector-panel" aria-label="Inspector">
          <div
            className="inspector-tabs"
            role="tablist"
            aria-label="Inspector sections"
            onKeyDown={(event) => {
              const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
              if (!step) return;
              event.preventDefault();
              const i = inspectorTabs.findIndex(([id]) => id === tab),
                next = inspectorTabs.at((i + step) % inspectorTabs.length)![0];
              setTab(next);
              document
                .getElementById(`inspector-tab-${next}`)
                ?.focus({ preventScroll: true });
            }}
          >
            {inspectorTabs.map(([id, label]) => (
              <button
                key={id}
                type="button"
                role="tab"
                id={`inspector-tab-${id}`}
                aria-selected={tab === id}
                aria-controls={`inspector-panel-${id}`}
                tabIndex={tab === id ? 0 : -1}
                className="inspector-tab"
                onClick={() => setTab(id)}
              >
                {label}
                {id === "paths" && (
                  <span className="count">{session.document.paths.length}</span>
                )}
                {id === "theme" && themeIssues > 0 && (
                  <span className="count has-issues">
                    <span className="visually-hidden">warnings: </span>
                    {themeIssues}
                  </span>
                )}
              </button>
            ))}
          </div>
          {/* Every tab stays mounted: the paths panel drives the preview's navigation. */}
          <div
            role="tabpanel"
            id="inspector-panel-scene"
            aria-labelledby="inspector-tab-scene"
            className="inspector-tabpanel"
            hidden={tab !== "scene"}
          >
            {layoutScene && (
              <LayoutPanel
                store={store}
                document={session.document}
                scene={layoutScene}
                host={previewHost}
                revision={previewRevision}
                selection={blockSelection}
                onSelect={setBlockSelection}
                grid={grid}
                onGrid={setGrid}
                announcement={announcement}
                announce={setAnnouncement}
                onFlow={() =>
                  setDialog({
                    title: "Switch back to flow?",
                    body: `The positions, sizes, rotations and layers of ${layoutScene.blocks.length} blocks in “${layoutScene.title}” will be lost; the blocks are stacked again in reading order. Undo restores them.`,
                    confirm: "Switch to flow",
                    action: () => {
                      const result = store.execute(
                        convertToFlow(layoutScene.id),
                      );
                      report(result);
                      if (result.ok)
                        setAnnouncement(
                          "Scene switched to flow: frames removed.",
                        );
                    },
                  })
                }
              />
            )}
            <Inspector store={store} scene={selected} />
          </div>
          <div
            role="tabpanel"
            id="inspector-panel-paths"
            aria-labelledby="inspector-tab-paths"
            className="inspector-tabpanel"
            hidden={tab !== "paths"}
          >
            <PathPanel
              store={store}
              document={session.document}
              onNavigation={setNavigation}
              onCapture={setCapture}
            />
          </div>
          <div
            role="tabpanel"
            id="inspector-panel-theme"
            aria-labelledby="inspector-tab-theme"
            className="inspector-tabpanel"
            hidden={tab !== "theme"}
          >
            <ThemePanel store={store} document={session.document} />
          </div>
        </section>
      </div>
      <footer className="statusbar">
        <span className={`save-state ${session.dirty ? "is-dirty" : ""}`}>
          {session.dirty ? "Changes not yet saved to JSON" : "Document saved"}
        </span>
        <span>
          schema {session.document.schemaVersion} ·{" "}
          {session.document.scenes.length} scenes · {session.historyLength}{" "}
          commands
        </span>
      </footer>
      {resumable && !presenter && (
        <div className="presenter-resume" role="status">
          <span>
            Presenter session active in another window.
            {!session.document.scenes.length &&
              " Open the presented project to resume it."}
          </span>
          <button
            type="button"
            tabIndex={0}
            disabled={!session.document.scenes.length}
            onClick={() => {
              setPresenter({
                sessionId: resumable,
                popup: findPublicWindow(resumable),
              });
              setResumable(null);
            }}
          >
            Resume presenter view
          </button>
          <button
            type="button"
            tabIndex={0}
            onClick={() => {
              sessionStorage.removeItem(PRESENTER_SESSION_KEY);
              setResumable(null);
            }}
          >
            Dismiss
          </button>
        </div>
      )}
      {presenter && (
        <div className="presentation presenter-overlay">
          <PresenterView
            document={session.document}
            blobs={blobs}
            plugins={plugins}
            sessionId={presenter.sessionId}
            popup={presenter.popup}
            onClose={() => setPresenter(null)}
            onSingleWindow={() => {
              sessionStorage.removeItem(PRESENTER_SESSION_KEY);
              setPresenter(null);
              presentHere();
            }}
          />
        </div>
      )}
      {present && (
        <div
          className={`presentation ${idle ? "is-idle" : ""}`}
          ref={presentation}
          tabIndex={-1}
          role="region"
          aria-label="Presentation mode"
        >
          <div className="present-controls">
            <button
              type="button"
              tabIndex={0}
              className="present-exit"
              onClick={() => setPresent(false)}
            >
              <Icon name="arrow-left" />
              Back to the editor
            </button>
            <span className="present-divider" aria-hidden="true" />
            <IconButton
              icon="chevron-left"
              label="Previous scene"
              tip="top"
              onClick={() => void presenting.current?.prev()}
            />
            <span className="present-title">{presentedTitle}</span>
            <IconButton
              icon="chevron-right"
              label="Next scene"
              tip="top"
              onClick={() => void presenting.current?.next()}
            />
            <span className="present-divider" aria-hidden="true" />
            <span className="present-hint">
              Arrows to navigate · Esc to exit
            </span>
          </div>
          <PlayerSurface
            document={session.document}
            selection={null}
            present
            blobs={blobs}
            plugins={plugins}
            onPlayer={(player, isPresent) => {
              onPlayer?.(player, isPresent);
              presentationPlayer(player);
            }}
          />
        </div>
      )}
      {dialog && (
        <Dialog
          title={dialog.title}
          {...(dialog.confirm ? { confirm: dialog.confirm } : {})}
          onCancel={() => setDialog(null)}
          onConfirm={() => {
            dialog.action();
            setDialog(null);
          }}
        >
          <p>{dialog.body}</p>
        </Dialog>
      )}
      {!!revisions.length && !dialog && (
        <Dialog
          title="Local recovery available"
          confirm="Recover revision"
          onCancel={() => {
            setRevisions([]);
            setRecoveryIndex(0);
          }}
          onConfirm={recover}
        >
          <p>
            Choose an autosave revision. The original file stays untouched.
            Recovery is not a backup.
          </p>
          <label>
            Revision
            <select
              aria-label="Revision to recover"
              value={recoveryIndex}
              onChange={(e) => setRecoveryIndex(Number(e.target.value))}
            >
              {revisions.map((r, index) => (
                <option key={`${r.projectId}-${r.revision}`} value={index}>
                  {r.document.metadata.title} · rev. {r.revision} ·{" "}
                  {revisionTime(r.updatedAt)} · {r.document.scenes.length}{" "}
                  scenes
                </option>
              ))}
            </select>
          </label>
          <p>
            Active: {session.document.metadata.title},{" "}
            {session.document.scenes.length} scenes. Recovery:{" "}
            {revisions[recoveryIndex]?.document.scenes.length} scenes.
          </p>
          <div className="recovery-actions">
            <button
              type="button"
              tabIndex={0}
              onClick={() => confirmDelete(false)}
            >
              Delete revision
            </button>
            <button
              type="button"
              tabIndex={0}
              onClick={() => confirmDelete(true)}
            >
              Delete local project
            </button>
          </div>
        </Dialog>
      )}
    </main>
  );
}
