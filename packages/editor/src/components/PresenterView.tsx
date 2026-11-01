import { useCallback, useEffect, useRef, useState } from "react";
import { createAssetResolver, createPlayer } from "@xcursus/player";
import type { AssetBlobs, NavigationRequest, Player } from "@xcursus/player";
import {
  createPresenterSession,
  publicWindowName,
} from "@xcursus/player/presenter";
import type {
  PresenterCommand,
  PresenterSession,
} from "@xcursus/player/presenter";
import { createBuiltinRegistry } from "@xcursus/plugins/builtins";
import type { PluginDefinition } from "@xcursus/plugins";
import { publicDocument } from "@xcursus/core";
import { Icon, IconButton } from "./icons.js";
import type { Choice, ProjectDocument } from "@xcursus/core";

export const PRESENTER_SESSION_KEY = "xcursus-presenter-session";
/** Opens the public window on the user's gesture; null when a blocker refuses it. */
export function openPublicWindow(sessionId: string): Window | null {
  return window.open(
    `present.html#session=${sessionId}`,
    publicWindowName(sessionId),
    "popup,width=1280,height=760",
  );
}
/**
 * After this tab reloads, finds the public window of the session again by its
 * name (on the user's click). A blank window means it no longer exists: it is
 * closed and the console offers to open a new one.
 */
export function findPublicWindow(sessionId: string): Window | null {
  const found = window.open("", publicWindowName(sessionId));
  if (!found) return null;
  try {
    if (found.location.href !== "about:blank") return found;
  } catch {
    /* Not ours: treat as absent. */
  }
  found.close();
  return null;
}
const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};
/**
 * Presenter console: the only navigation authority. Its previews are muted;
 * audio plays only in the public window. Notes come from the authored
 * document and never enter a message, a public DOM or a public renderer.
 */
export function PresenterView({
  document,
  blobs,
  plugins,
  sessionId,
  popup,
  onClose,
  onSingleWindow,
}: {
  document: ProjectDocument;
  blobs: AssetBlobs;
  plugins: readonly PluginDefinition[];
  sessionId: string;
  popup: Window | null;
  onClose: () => void;
  onSingleWindow: () => void;
}) {
  const currentHost = useRef<HTMLDivElement>(null),
    nextHost = useRef<HTMLDivElement>(null);
  const controller = useRef<Player | null>(null),
    session = useRef<PresenterSession | null>(null),
    run = useRef<(request: NavigationRequest) => void>(() => {});
  // Node and edge IDs are unique only within their path.
  const [at, setAt] = useState<{
      pathId: string | null;
      nodeId: string | null;
    }>({ pathId: null, nodeId: null }),
    [choices, setChoices] = useState<Choice[]>([]),
    [connected, setConnected] = useState(false),
    [blocked, setBlocked] = useState(popup === null),
    [elapsed, setElapsed] = useState(0),
    [running, setRunning] = useState(false);
  const timer = useRef({ started: 0, accumulated: 0 });
  const initial = useRef({ document, blobs, plugins, popup });
  useEffect(() => {
    const { document: doc, blobs: files, plugins: approved } = initial.current;
    const assets = createAssetResolver(doc.assets, files);
    const registries = [
      createBuiltinRegistry({ plugins: approved }),
      createBuiltinRegistry({ plugins: approved }),
    ];
    const current = createPlayer({
      registry: registries[0]!.registry,
      assets,
      muted: true,
      input: false,
      // Its own choice and outline buttons go through the session too.
      delegate: (request) => run.current(request),
    });
    const next = createPlayer({
      registry: registries[1]!.registry,
      assets,
      muted: true,
      input: false,
      motion: "reduced",
      controls: false,
    });
    controller.current = current;
    let disposed = false;
    const refresh = () => {
      const state = current.getState();
      setAt({ pathId: state.pathId, nodeId: state.nodeId });
      const options = state.choices.filter((c) => !c.disabledReason);
      setChoices(state.choices);
      const path = doc.paths.find((p) => p.id === state.pathId);
      const edge =
        options.length === 1
          ? path?.edges.find((e) => e.id === options[0]!.edgeId)
          : undefined;
      // Preview the next visit only when `next` would not ask for a choice.
      if (path && edge && edge.condition?.kind !== "manual")
        void next.goTo({ pathId: path.id, nodeId: edge.to }, { durationMs: 0 });
    };
    const send = (command: PresenterCommand) => session.current?.send(command);
    run.current = (request) => {
      const state = current.getState();
      if (request.kind === "prev") {
        send({ kind: "prev" });
        void current.prev();
      } else if (request.kind === "next") {
        send(
          request.edgeId
            ? { kind: "next", edgeId: request.edgeId }
            : { kind: "next" },
        );
        void current.next(request.edgeId ? { edgeId: request.edgeId } : {});
      } else if (state.pathId) {
        send({ kind: "goTo", pathId: state.pathId, nodeId: request.nodeId });
        void current.goTo({ pathId: state.pathId, nodeId: request.nodeId });
      }
    };
    current.on("scenechange", refresh);
    current.on("choice", refresh);
    void Promise.all([
      current.mount(currentHost.current!, doc),
      next.mount(nextHost.current!, doc),
    ]).then(() => {
      if (disposed) return;
      refresh();
      session.current = createPresenterSession({
        window,
        sessionId,
        popup: initial.current.popup,
        snapshot: () => {
          const state = current.getState();
          return {
            document: publicDocument(doc),
            assets: Object.fromEntries(
              doc.assets.flatMap((a) => {
                const blob = files.get(a.id);
                return blob ? [[a.id, blob]] : [];
              }),
            ),
            pathId: state.pathId,
            visits: state.history.map((v) => v.nodeId),
          };
        },
        onRequest: (request) => run.current(request),
        onConnection: (value) => {
          setConnected(value);
          if (value) setBlocked(false);
        },
      });
    });
    return () => {
      disposed = true;
      session.current?.dispose();
      session.current = null;
      current.destroy();
      next.destroy();
      registries.forEach((r) => r.plugins.destroy());
      controller.current = null;
    };
  }, [sessionId]);
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(
      () =>
        setElapsed(
          timer.current.accumulated + performance.now() - timer.current.started,
        ),
      250,
    );
    return () => window.clearInterval(id);
  }, [running]);
  const toggleTimer = () => {
    const t = timer.current;
    if (running) {
      t.accumulated += performance.now() - t.started;
      setElapsed(t.accumulated);
    } else t.started = performance.now();
    setRunning(!running);
  };
  const resetTimer = () => {
    timer.current = { started: performance.now(), accumulated: 0 };
    setElapsed(0);
  };
  const end = useCallback(() => {
    session.current?.close();
    popup?.close();
    sessionStorage.removeItem(PRESENTER_SESSION_KEY);
    onClose();
  }, [popup, onClose]);
  const retry = () => {
    const opened = openPublicWindow(sessionId);
    if (opened) {
      session.current?.attach(opened);
      setBlocked(false);
    }
  };
  const path = document.paths.find((p) => p.id === at.pathId);
  const node = path?.nodes.find((n) => n.id === at.nodeId);
  const scene = document.scenes.find((s) => s.id === node?.sceneId);
  const eligible = choices.filter((c) => !c.disabledReason);
  const single =
    eligible.length === 1
      ? path?.edges.find((e) => e.id === eligible[0]!.edgeId)
      : undefined;
  // A manual edge needs an explicit choice even when it is the only exit, as
  // `next` would: it is offered as a choice, never previewed as «Next».
  const asChoice = eligible.length > 1 || single?.condition?.kind === "manual";
  const following = asChoice ? undefined : single;
  const nextScene = following
    ? document.scenes.find(
        (s) => s.id === path?.nodes.find((n) => n.id === following.to)?.sceneId,
      )
    : undefined;
  return (
    <div
      className="presenter"
      role="region"
      aria-label="Presenter view"
      tabIndex={-1}
      onKeyDown={(event) => {
        if ((event.target as Element).matches("input,textarea,select,button"))
          return;
        const command = {
          ArrowRight: "next",
          PageDown: "next",
          " ": "next",
          ArrowLeft: "prev",
          PageUp: "prev",
        }[event.key] as "next" | "prev" | undefined;
        if (command) {
          event.preventDefault();
          run.current({ kind: command });
        }
      }}
    >
      <header className="presenter-bar">
        <div className="presenter-identity">
          <h2>Presenter view</h2>
          <p
            role="status"
            className={`presenter-link ${connected ? "is-connected" : blocked ? "is-blocked" : ""}`}
          >
            {connected
              ? "Audience window connected"
              : blocked
                ? "Audience window not open"
                : "Waiting for the audience window…"}
          </p>
        </div>
        <div className="presenter-timer">
          <output aria-label="Elapsed time">{clock(elapsed)}</output>
          <IconButton
            icon={running ? "pause" : "play"}
            label={running ? "Pause" : "Start"}
            onClick={toggleTimer}
          />
          <IconButton icon="reset" label="Reset" onClick={resetTimer} />
        </div>
        <div className="presenter-end">
          <button
            type="button"
            tabIndex={0}
            className="tool-button danger"
            onClick={end}
          >
            End
          </button>
        </div>
      </header>
      {blocked && (
        <div className="presenter-blocked" role="alert">
          <p>
            The browser blocked the audience window. Allow pop-ups for this site
            and try again, or present in this tab (without notes or previews).
          </p>
          <button type="button" tabIndex={0} onClick={retry}>
            Try opening again
          </button>
          <button type="button" tabIndex={0} onClick={onSingleWindow}>
            Present in this tab
          </button>
        </div>
      )}
      <div className="presenter-grid">
        <section aria-label="Current scene" className="presenter-current">
          <h3>
            <span className="presenter-kicker">Now</span>
            {scene?.title ?? "—"}
          </h3>
          <div ref={currentHost} className="presenter-player" />
          <nav className="presenter-nav" aria-label="Presenter navigation">
            <button
              type="button"
              tabIndex={0}
              onClick={() => run.current({ kind: "prev" })}
            >
              <Icon name="arrow-left" />
              Back
            </button>
            <button
              type="button"
              tabIndex={0}
              className="primary"
              onClick={() => run.current({ kind: "next" })}
            >
              Next
              <Icon name="arrow-right" />
            </button>
            <span className="presenter-keys">
              Arrows, Page Up/Down or Space
            </span>
          </nav>
        </section>
        <div className="presenter-side">
          <section aria-label="Next" className="presenter-next">
            <h3>
              <span className="presenter-kicker">Next</span>
              {nextScene?.title}
            </h3>
            <div
              ref={nextHost}
              className="presenter-player"
              hidden={!following}
            />
            {asChoice && (
              <ul className="presenter-choices" aria-label="Branch choices">
                {eligible.map((c) => (
                  <li key={c.edgeId}>
                    <button
                      type="button"
                      tabIndex={0}
                      onClick={() =>
                        run.current({ kind: "next", edgeId: c.edgeId })
                      }
                    >
                      {c.label}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {eligible.length === 0 && (
              <p className="presenter-end-note">End of the path.</p>
            )}
          </section>
          <section aria-label="Speaker notes" className="presenter-notes">
            <h3>Notes</h3>
            <p>{scene?.notes || "No notes for this scene."}</p>
          </section>
        </div>
      </div>
    </div>
  );
}
