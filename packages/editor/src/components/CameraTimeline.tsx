import { useState } from "react";
import {
  cameraPose,
  sampleTransition,
  inspectCamera,
  authoredCameraPose,
  resolveSceneCamera,
  resolveEdgePlan,
  success,
} from "@xcursus/core";
import type {
  AuthoredCameraPose,
  CameraTrack,
  ProjectDocument,
  Result,
  TransitionPlan,
} from "@xcursus/core";
import { randomId } from "../commands/index.js";
import type { DocumentEdit } from "../commands/index.js";
import type { EditorStore } from "../store/index.js";
import { Numeric, TextField } from "./Inspector.js";
import { Icon } from "./icons.js";
export interface Capture {
  plan: TransitionPlan;
  elapsedMs: number;
}
function PoseFields({
  pose,
  prefix,
  apply,
}: {
  pose: AuthoredCameraPose;
  prefix: string;
  apply: (pose: AuthoredCameraPose) => Result<void>;
}) {
  return (
    <div className="pose-fields">
      {(["position", "rotation"] as const).map((property) => (
        <div className="numeric-row" key={property}>
          {["X", "Y", "Z"].map((axis, i) => (
            <Numeric
              key={axis}
              label={`${prefix} ${property === "position" ? "position" : "rotation"} ${axis}`}
              value={pose[property][i]!}
              apply={(value) => {
                const next = structuredClone(pose);
                next[property][i] = value;
                return apply(next);
              }}
            />
          ))}
        </div>
      ))}
      <Numeric
        label={`${prefix} zoom`}
        value={pose.zoom}
        apply={(zoom) => apply({ ...pose, zoom })}
      />
    </div>
  );
}
export function CameraTimeline({
  store,
  document,
  pathId,
  edgeId,
  nodeId,
  run,
  onCapture,
}: {
  store: EditorStore;
  document: ProjectDocument;
  pathId: string;
  edgeId: string | null;
  nodeId: string | null;
  run: (edit: DocumentEdit) => Result<void>;
  onCapture: (capture: Capture | null) => void;
}) {
  const [warnings, setWarnings] = useState<string[]>([]);
  const path = document.paths.find((p) => p.id === pathId)!,
    edge = path.edges.find((e) => e.id === edgeId),
    node = path.nodes.find((n) => n.id === nodeId);
  const track = document.cameraTracks.find((t) => t.id === edge?.cameraTrackId);
  const position = (id: string) => path.nodes.findIndex((n) => n.id === id) + 1;
  const editTrack = (patch: Partial<CameraTrack>) =>
    run((doc) => {
      Object.assign(
        doc.cameraTracks.find((t) => t.id === track!.id)!,
        structuredClone(patch),
      );
      return success(doc);
    });
  const targetPose = (id: string) => {
    const n = path.nodes.find((n) => n.id === id)!;
    if (n.camera) return n.camera;
    const pose = resolveSceneCamera(document, n.sceneId);
    return pose.ok
      ? authoredCameraPose(pose.value)
      : {
          position: [0, 0, 0] as [number, number, number],
          rotation: [0, 0, 0] as [number, number, number],
          zoom: 1,
        };
  };
  const addTrack = () =>
    run((doc) => {
      const from = targetPose(edge!.from),
        to = targetPose(edge!.to),
        mid: AuthoredCameraPose = {
          position: from.position.map(
            (n, i) => (n + to.position[i]!) / 2,
          ) as AuthoredCameraPose["position"],
          rotation: [...from.rotation],
          zoom: Math.sqrt(from.zoom * to.zoom),
        };
      const id = randomId();
      doc.cameraTracks.push({
        id,
        keyframes: [
          { at: 0, pose: from },
          { at: 0.5, pose: mid },
          { at: 1, pose: to },
        ],
        interpolation: "linear",
        easing: "linear",
      });
      doc.paths
        .find((p) => p.id === pathId)!
        .edges.find((e) => e.id === edgeId)!.cameraTrackId = id;
      return success(doc);
    });
  return (
    <details className="timeline-panel" open>
      <summary>Camera and timeline</summary>
      {node && (
        <fieldset>
          <legend>Node camera</legend>
          <button
            type="button"
            tabIndex={0}
            className="tool-button"
            onClick={() =>
              run((doc) => {
                const n = doc.paths
                  .find((p) => p.id === pathId)!
                  .nodes.find((n) => n.id === nodeId)!;
                if (n.camera) delete n.camera;
                else n.camera = structuredClone(targetPose(node.id));
                return success(doc);
              })
            }
          >
            {node.camera ? "Use scene framing" : "Independent camera"}
          </button>
          {node.camera && (
            <PoseFields
              prefix="Node"
              pose={node.camera}
              apply={(camera) =>
                run((doc) => {
                  doc.paths
                    .find((p) => p.id === pathId)!
                    .nodes.find((n) => n.id === nodeId)!.camera = camera;
                  return success(doc);
                })
              }
            />
          )}
        </fieldset>
      )}
      {edge ? (
        <>
          <p className="panel-note">
            Transition {position(edge.from)} → {position(edge.to)}
            {edge.label && ` · ${edge.label}`}
          </p>
          <div className="prop-grid two">
            <Numeric
              label="Transition duration ms"
              value={edge.transition.durationMs}
              apply={(durationMs) =>
                run((doc) => {
                  doc.paths
                    .find((p) => p.id === pathId)!
                    .edges.find((e) => e.id === edgeId)!.transition.durationMs =
                    durationMs;
                  return success(doc);
                })
              }
            />
            <label>
              Transition easing
              <select
                aria-label="Transition easing"
                value={edge.transition.easing}
                onChange={(e) =>
                  run((doc) => {
                    doc.paths
                      .find((p) => p.id === pathId)!
                      .edges.find((e) => e.id === edgeId)!.transition.easing = e
                      .target.value as "linear" | "ease-in-out";
                    return success(doc);
                  })
                }
              >
                <option value="linear">Linear</option>
                <option value="ease-in-out">Ease in/out</option>
              </select>
            </label>
          </div>
          <label>
            Camera track
            <select
              aria-label="Camera track"
              value={edge.cameraTrackId ?? ""}
              onChange={(e) =>
                run((doc) => {
                  const item = doc.paths
                    .find((p) => p.id === pathId)!
                    .edges.find((e) => e.id === edgeId)!;
                  if (e.target.value) item.cameraTrackId = e.target.value;
                  else delete item.cameraTrackId;
                  return success(doc);
                })
              }
            >
              <option value="">No track</option>
              {document.cameraTracks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.id}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            tabIndex={0}
            className="tool-button"
            onClick={addTrack}
          >
            <Icon name="plus" />
            Create a three-keyframe track
          </button>
          {track && (
            <>
              <label>
                Position interpolation
                <select
                  aria-label="Position interpolation"
                  value={track.interpolation}
                  onChange={(e) =>
                    editTrack({
                      interpolation: e.target
                        .value as CameraTrack["interpolation"],
                    })
                  }
                >
                  <option value="linear">Linear</option>
                  <option value="cubic">Catmull-Rom</option>
                </select>
              </label>
              <label>
                Track easing
                <select
                  aria-label="Track easing"
                  value={track.easing}
                  onChange={(e) =>
                    editTrack({
                      easing: e.target.value as CameraTrack["easing"],
                    })
                  }
                >
                  <option value="linear">Linear</option>
                  <option value="ease-in-out">Ease in/out</option>
                </select>
              </label>
              <ol className="keyframes" aria-label="Camera keyframes">
                {track.keyframes.map((k, index) => (
                  <li key={`${track.id}-${index}`}>
                    <details open={index === 1}>
                      <summary>
                        Keyframe {index + 1} ·{" "}
                        {Math.round(k.at * edge.transition.durationMs)} ms
                      </summary>
                      <Numeric
                        label={`Keyframe ${index + 1} normalized time`}
                        value={k.at}
                        apply={(at) =>
                          editTrack({
                            keyframes: track.keyframes.map((p, i) =>
                              i === index ? { ...p, at } : p,
                            ),
                          })
                        }
                      />
                      <PoseFields
                        prefix={`Keyframe ${index + 1}`}
                        pose={k.pose}
                        apply={(pose) =>
                          editTrack({
                            keyframes: track.keyframes.map((p, i) =>
                              i === index ? { ...p, pose } : p,
                            ),
                          })
                        }
                      />
                      {index > 0 && index < track.keyframes.length - 1 && (
                        <button
                          type="button"
                          tabIndex={0}
                          className="tool-button quiet danger"
                          onClick={() =>
                            editTrack({
                              keyframes: track.keyframes.filter(
                                (_, i) => i !== index,
                              ),
                            })
                          }
                        >
                          Remove keyframe {index + 1}
                        </button>
                      )}
                    </details>
                  </li>
                ))}
              </ol>
              <button
                type="button"
                tabIndex={0}
                className="tool-button"
                disabled={track.keyframes.length >= 200}
                onClick={() => {
                  const keys = structuredClone(track.keyframes);
                  let longest = 0;
                  for (let i = 1; i < keys.length - 1; i++)
                    if (
                      keys[i + 1]!.at - keys[i]!.at >
                      keys[longest + 1]!.at - keys[longest]!.at
                    )
                      longest = i;
                  const a = keys[longest]!,
                    b = keys[longest + 1]!;
                  keys.splice(longest + 1, 0, {
                    at: (a.at + b.at) / 2,
                    pose: structuredClone(a.pose),
                  });
                  editTrack({ keyframes: keys });
                }}
              >
                Add keyframe
              </button>
            </>
          )}
          <label>
            Scrub camera
            <input
              type="range"
              aria-label="Scrub camera"
              min="0"
              max="1000"
              defaultValue="0"
              key={`${edge.id}-${JSON.stringify(track)}`}
              onChange={(e) => {
                const plan = resolveEdgePlan(
                  store.getSnapshot().document,
                  pathId,
                  edge.id,
                );
                if (plan.ok) {
                  setWarnings(
                    inspectCamera(
                      document,
                      sampleTransition(
                        plan.value,
                        (plan.value.durationMs * Number(e.target.value)) / 1000,
                      ).camera,
                    ).map((d) => d.message),
                  );
                  onCapture({
                    plan: plan.value,
                    elapsedMs:
                      (plan.value.durationMs * Number(e.target.value)) / 1000,
                  });
                }
              }}
            />
          </label>
          <button
            type="button"
            tabIndex={0}
            className="tool-button"
            onClick={() => onCapture(null)}
          >
            End camera inspection
          </button>
          {warnings.map((message) => (
            <p role="status" key={message}>
              {message}
            </p>
          ))}
          {node?.camera &&
            inspectCamera(document, cameraPose(node.camera)).map((d) => (
              <p role="status" key={d.pointer}>
                {d.message}
              </p>
            ))}
          <p className="panel-note">
            Scrubbing only moves the preview camera, without visits or cues. The
            first keyframe is resolved from the starting pose; the endpoint is
            kept.
          </p>
          <fieldset>
            <legend>Declarative cues</legend>
            {document.cues
              .filter((c) => c.edgeId === edge.id)
              .map((c) => (
                <div className="cue-row" key={c.id}>
                  <TextField
                    label={`Cue event ${c.id}`}
                    value={c.event}
                    apply={(event) =>
                      run((doc) => {
                        doc.cues.find((cue) => cue.id === c.id)!.event = event;
                        return success(doc);
                      })
                    }
                  />
                  <Numeric
                    label={`Cue time ${c.id} ms`}
                    value={c.atMs}
                    apply={(atMs) =>
                      run((doc) => {
                        doc.cues.find((cue) => cue.id === c.id)!.atMs = atMs;
                        return success(doc);
                      })
                    }
                  />
                  <TextField
                    label={`Payload cue ${c.id}`}
                    code
                    value={JSON.stringify(c.payload)}
                    apply={(text) => {
                      try {
                        const payload: unknown = JSON.parse(text);
                        return run((doc) => {
                          doc.cues.find((cue) => cue.id === c.id)!.payload =
                            payload as typeof c.payload;
                          return success(doc);
                        });
                      } catch {
                        return {
                          ok: false,
                          diagnostics: [
                            {
                              code: "INVALID_JSON",
                              severity: "error",
                              pointer: "",
                              message: "Invalid payload JSON.",
                            },
                          ],
                        };
                      }
                    }}
                  />
                  <button
                    type="button"
                    tabIndex={0}
                    className="tool-button quiet danger"
                    onClick={() =>
                      run((doc) => {
                        doc.cues = doc.cues.filter((cue) => cue.id !== c.id);
                        return success(doc);
                      })
                    }
                  >
                    Remove cue
                  </button>
                </div>
              ))}
            <button
              type="button"
              tabIndex={0}
              className="tool-button"
              onClick={() =>
                run((doc) => {
                  doc.cues.push({
                    id: randomId(),
                    edgeId: edge.id,
                    atMs: 0,
                    event: "presentation.mark",
                    payload: null,
                  });
                  return success(doc);
                })
              }
            >
              <Icon name="plus" />
              Add cue
            </button>
          </fieldset>
        </>
      ) : (
        <p className="panel-note">
          Select a connection to edit its duration, track and cues.
        </p>
      )}
    </details>
  );
}
