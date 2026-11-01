import { useEffect, useState } from "react";
import { success } from "@xcursus/core";
import type { PathEdge, ProjectDocument, Result } from "@xcursus/core";
import {
  createPath,
  deletePath,
  editImpact,
  editPath,
  createNode,
  editNode,
  connectNodes,
  editEdge,
  removeGraphItem,
} from "../commands/index.js";
import type { DocumentEdit } from "../commands/index.js";
import type { EditorStore } from "../store/index.js";
import { CameraTimeline } from "./CameraTimeline.js";
import type { Capture } from "./CameraTimeline.js";
import { Numeric, TextField } from "./Inspector.js";
import { Dialog } from "./Dialog.js";
import { SceneThumb } from "./SceneThumb.js";
import { Icon, IconButton } from "./icons.js";
export interface NavigationSelection {
  pathId: string;
  nodeId: string;
}
export function PathPanel({
  store,
  document,
  onNavigation,
  onCapture,
}: {
  store: EditorStore;
  document: ProjectDocument;
  onNavigation: (selection: NavigationSelection | null) => void;
  onCapture: (capture: Capture | null) => void;
}) {
  const [pathId, setPathId] = useState(document.defaultPathId),
    [nodeId, setNodeId] = useState<string | null>(null),
    [edgeId, setEdgeId] = useState<string | null>(null),
    [sceneId, setSceneId] = useState(""),
    [from, setFrom] = useState(""),
    [to, setTo] = useState(""),
    [error, setError] = useState("");
  const [deletion, setDeletion] = useState<{
    edit: DocumentEdit;
    description: string;
  } | null>(null);
  const path =
    document.paths.find((p) => p.id === pathId) ??
    document.paths.find((p) => p.id === document.defaultPathId) ??
    document.paths[0];
  const node = path?.nodes.find((n) => n.id === nodeId) ?? path?.nodes[0],
    edge =
      path?.edges.find((e) => e.id === edgeId) ??
      path?.edges.find((e) => e.from === node?.id);
  const activePathId = path?.id,
    activeNodeId = node?.id,
    activeSceneId = node?.sceneId;
  useEffect(() => {
    onNavigation(
      activePathId && activeNodeId
        ? { pathId: activePathId, nodeId: activeNodeId }
        : null,
    );
    onCapture(null);
    if (activeSceneId && store.getSnapshot().selection !== activeSceneId)
      store.select(activeSceneId);
  }, [
    activePathId,
    activeNodeId,
    activeSceneId,
    onNavigation,
    onCapture,
    store,
  ]);
  const run = (edit: DocumentEdit): Result<void> => {
    const result = store.execute(edit);
    setError(
      result.ok ? "" : result.diagnostics.map((d) => d.message).join("; "),
    );
    if (result.ok) onCapture(null);
    return result;
  };
  const remove = (edit: DocumentEdit) => {
    const impact = editImpact(document, edit);
    if (impact.ok) setDeletion({ edit, description: impact.value.description });
    else setError(impact.diagnostics.map((d) => d.message).join("; "));
  };
  const sceneOf = (id: string) => document.scenes.find((s) => s.id === id);
  const position = (id: string) =>
    (path?.nodes.findIndex((n) => n.id === id) ?? -1) + 1;
  const condition = (e: PathEdge) =>
    !e.condition
      ? "Direct advance"
      : e.condition.kind === "manual"
        ? "Manual choice"
        : `Limit ${e.condition.maxVisits} ${e.condition.maxVisits === 1 ? "visit" : "visits"}`;
  return (
    <div className="path-panel">
      <div className="structure-content">
        <div className="path-head">
          <select
            aria-label="Path to edit"
            value={path?.id ?? ""}
            onChange={(e) => {
              setPathId(e.target.value);
              setNodeId(null);
              setEdgeId(null);
            }}
          >
            <option value="" disabled>
              Choose a path
            </option>
            {document.paths.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.id === document.defaultPathId ? " · main" : ""}
              </option>
            ))}
          </select>
          <IconButton
            icon="plus"
            label="New path"
            tip="left"
            onClick={() => {
              if (run(createPath()).ok)
                setPathId(store.getSnapshot().document.paths.at(-1)!.id);
            }}
          />
        </div>
        {path && (
          <>
            <div className="inspector-group path-settings">
              <TextField
                key={path.id}
                label="Path name"
                short="Name"
                value={path.name}
                apply={(name) => run(editPath(path.id, { name }))}
              />
              <label className="kv">
                <span>Start</span>
                <select
                  aria-label="Start node"
                  value={path.startNodeId ?? ""}
                  onChange={(e) =>
                    run(
                      editPath(path.id, {
                        startNodeId: e.target.value || null,
                      }),
                    )
                  }
                >
                  <option value="">Empty</option>
                  {path.nodes.map((n) => (
                    <option key={n.id} value={n.id}>
                      {position(n.id)} · {sceneOf(n.sceneId)?.title}
                    </option>
                  ))}
                </select>
              </label>
              {path.loopPolicy ? (
                <div className="kv">
                  <span>Manual loop</span>
                  <div className="kv-controls">
                    <Numeric
                      label="Visit limit per node"
                      short="Visits"
                      value={path.loopPolicy.maxVisitsPerNode}
                      apply={(maxVisitsPerNode) =>
                        run(
                          editPath(path.id, {
                            loopPolicy: { maxVisitsPerNode },
                          }),
                        )
                      }
                    />
                    <button
                      type="button"
                      tabIndex={0}
                      className="tool-button"
                      onClick={() =>
                        run((doc) => {
                          delete doc.paths.find((p) => p.id === path.id)!
                            .loopPolicy;
                          return success(doc);
                        })
                      }
                    >
                      Remove loop policy
                    </button>
                  </div>
                </div>
              ) : (
                <div className="kv">
                  <span>Manual loop</span>
                  <button
                    type="button"
                    tabIndex={0}
                    className="tool-button"
                    onClick={() =>
                      run((doc) => {
                        const p = doc.paths.find((p) => p.id === path.id)!;
                        p.loopPolicy = { maxVisitsPerNode: 3 };
                        for (const e of p.edges)
                          e.condition = { kind: "manual" };
                        return success(doc);
                      })
                    }
                  >
                    Enable manual loop (3 visits)
                  </button>
                </div>
              )}
              <div className="path-actions">
                {document.defaultPathId === path.id ? (
                  <span className="chip">Main path</span>
                ) : (
                  <button
                    type="button"
                    tabIndex={0}
                    className="tool-button"
                    onClick={() =>
                      run((doc) => {
                        doc.defaultPathId = path.id;
                        return success(doc);
                      })
                    }
                  >
                    Use as main path
                  </button>
                )}
                <button
                  type="button"
                  tabIndex={0}
                  className="tool-button quiet danger"
                  onClick={() => remove(deletePath(path.id))}
                >
                  Delete path
                </button>
              </div>
            </div>
            <section className="inspector-group" aria-labelledby="path-visits">
              <h3 id="path-visits">
                Visits <span className="count">{path.nodes.length}</span>
              </h3>
              {path.nodes.length ? (
                <ol className="graph-list" aria-label="Path visits">
                  {path.nodes.map((n, i) => {
                    const scene = sceneOf(n.sceneId),
                      current = n.id === node?.id;
                    return (
                      <li key={n.id} className={current ? "selected" : ""}>
                        <button
                          type="button"
                          tabIndex={0}
                          className="graph-item"
                          aria-pressed={current}
                          onClick={() => {
                            setNodeId(n.id);
                            setEdgeId(null);
                            store.select(n.sceneId);
                          }}
                        >
                          <span className="node-badge">{i + 1}</span>
                          {scene && (
                            <SceneThumb document={document} scene={scene} />
                          )}
                          <span className="graph-label">
                            {scene?.title ?? "Missing scene"}
                          </span>
                          {path.startNodeId === n.id && (
                            <span className="chip">Start</span>
                          )}
                        </button>
                        {current && (
                          <div className="graph-detail">
                            <label className="kv">
                              <span>Scene</span>
                              <select
                                aria-label="Visit scene"
                                value={n.sceneId}
                                onChange={(e) =>
                                  run(
                                    editNode(path.id, n.id, {
                                      sceneId: e.target.value,
                                    }),
                                  )
                                }
                              >
                                {document.scenes.map((s) => (
                                  <option key={s.id} value={s.id}>
                                    {s.title}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <div className="kv">
                              <span>Hold</span>
                              <div className="kv-controls">
                                <Numeric
                                  label="Node hold ms"
                                  short="ms"
                                  value={n.holdMs}
                                  apply={(holdMs) =>
                                    run(editNode(path.id, n.id, { holdMs }))
                                  }
                                />
                              </div>
                            </div>
                            <div className="path-actions">
                              <button
                                type="button"
                                tabIndex={0}
                                className="tool-button quiet danger"
                                onClick={() =>
                                  remove(removeGraphItem(path.id, n.id, "node"))
                                }
                              >
                                Delete visit
                              </button>
                            </div>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <p className="panel-note">
                  No visits: add a scene to the path.
                </p>
              )}
              <div className="add-row">
                <select
                  aria-label="Scene to add to the path"
                  value={sceneId || document.scenes[0]?.id || ""}
                  onChange={(e) => setSceneId(e.target.value)}
                >
                  {document.scenes
                    .filter((s) => s.visible)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.title}
                      </option>
                    ))}
                </select>
                <button
                  type="button"
                  tabIndex={0}
                  className="tool-button"
                  disabled={!document.scenes.length}
                  onClick={() => {
                    if (
                      run(
                        createNode(
                          path.id,
                          sceneId || document.scenes[0]!.id,
                          node?.id,
                        ),
                      ).ok
                    )
                      setNodeId(
                        store
                          .getSnapshot()
                          .document.paths.find((p) => p.id === path.id)!
                          .nodes.at(-1)!.id,
                      );
                  }}
                >
                  <Icon name="plus" />
                  Add visit
                </button>
              </div>
            </section>
            <section
              className="inspector-group"
              aria-labelledby="path-connections"
            >
              <h3 id="path-connections">
                Connections <span className="count">{path.edges.length}</span>
              </h3>
              {path.edges.length ? (
                <ol className="graph-list" aria-label="Path connections">
                  {path.edges.map((e) => {
                    const current = e.id === edge?.id;
                    return (
                      <li key={e.id} className={current ? "selected" : ""}>
                        <button
                          type="button"
                          tabIndex={0}
                          className="graph-item edge"
                          aria-pressed={current}
                          onClick={() => setEdgeId(e.id)}
                        >
                          <span className="edge-nodes">
                            <span className="node-badge">
                              {position(e.from)}
                            </span>
                            <Icon name="arrow-right" />
                            <span className="visually-hidden"> to </span>
                            <span className="node-badge">{position(e.to)}</span>
                          </span>
                          <span className="graph-label">
                            {e.label || condition(e)}
                          </span>
                          <span className="graph-meta">
                            {e.transition.durationMs} ms
                          </span>
                        </button>
                        {current && (
                          <div className="graph-detail">
                            <TextField
                              key={e.id}
                              label="Choice label"
                              short="Label"
                              value={e.label}
                              apply={(label) =>
                                run(editEdge(path.id, e.id, { label }))
                              }
                            />
                            <label className="kv">
                              <span>Condition</span>
                              <select
                                aria-label="Connection condition"
                                value={e.condition?.kind ?? "always"}
                                onChange={(event) =>
                                  run((doc) => {
                                    const item = doc.paths
                                      .find((p) => p.id === path.id)!
                                      .edges.find((x) => x.id === e.id)!;
                                    if (event.target.value === "always")
                                      delete item.condition;
                                    else
                                      item.condition =
                                        event.target.value === "manual"
                                          ? { kind: "manual" }
                                          : {
                                              kind: "visit-limit",
                                              maxVisits: 3,
                                            };
                                    return success(doc);
                                  })
                                }
                              >
                                <option value="always">Direct advance</option>
                                <option value="manual">Manual choice</option>
                                <option value="visit-limit">Visit limit</option>
                              </select>
                            </label>
                            {e.condition?.kind === "visit-limit" && (
                              <div className="kv">
                                <span>Limit</span>
                                <Numeric
                                  label="Connection visit limit"
                                  short="Visits"
                                  value={e.condition.maxVisits}
                                  apply={(maxVisits) =>
                                    run(
                                      editEdge(path.id, e.id, {
                                        condition: {
                                          kind: "visit-limit",
                                          maxVisits,
                                        },
                                      }),
                                    )
                                  }
                                />
                              </div>
                            )}
                            <div className="path-actions">
                              <button
                                type="button"
                                tabIndex={0}
                                className="tool-button quiet danger"
                                onClick={() =>
                                  remove(removeGraphItem(path.id, e.id, "edge"))
                                }
                              >
                                Delete connection
                              </button>
                            </div>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <p className="panel-note">No connections: link two visits.</p>
              )}
              <fieldset className="connect-row">
                <legend className="visually-hidden">New connection</legend>
                {(["from", "to"] as const).map((kind) => (
                  <select
                    key={kind}
                    aria-label={
                      kind === "from" ? "Connection from" : "Connection to"
                    }
                    value={(kind === "from" ? from : to) || node?.id || ""}
                    onChange={(e) =>
                      (kind === "from" ? setFrom : setTo)(e.target.value)
                    }
                  >
                    {path.nodes.map((n) => (
                      <option key={n.id} value={n.id}>
                        {position(n.id)} · {sceneOf(n.sceneId)?.title}
                      </option>
                    ))}
                  </select>
                ))}
                <button
                  type="button"
                  tabIndex={0}
                  className="tool-button"
                  disabled={!node}
                  onClick={() => {
                    if (
                      run(
                        connectNodes(path.id, from || node!.id, to || node!.id),
                      ).ok
                    )
                      setEdgeId(
                        store
                          .getSnapshot()
                          .document.paths.find((p) => p.id === path.id)!
                          .edges.at(-1)!.id,
                      );
                  }}
                >
                  <Icon name="link" />
                  Link nodes
                </button>
              </fieldset>
            </section>
            <CameraTimeline
              store={store}
              document={document}
              pathId={path.id}
              nodeId={node?.id ?? null}
              edgeId={edge?.id ?? null}
              run={run}
              onCapture={onCapture}
            />
          </>
        )}
        {error && (
          <p role="alert" className="field-error">
            {error}
          </p>
        )}
      </div>
      {deletion && (
        <Dialog
          title="Delete the structure and its references?"
          confirm="Delete structure"
          onCancel={() => setDeletion(null)}
          onConfirm={() => {
            run(deletion.edit);
            setDeletion(null);
          }}
        >
          <p>{deletion.description}</p>
        </Dialog>
      )}
    </div>
  );
}
