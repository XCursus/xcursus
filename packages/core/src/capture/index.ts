import { diagnostic, failure, success } from "../document/index.js";
import type {
  Diagnostic,
  PathEdge,
  ProjectDocument,
  Result,
} from "../document/index.js";
import { cameraPose, resolveSceneCamera } from "../math/index.js";
import type { CameraPose } from "../math/index.js";
import { resolveEdgePlan, sampleTransition } from "../timing/index.js";
import type { TransitionPlan } from "../timing/index.js";

/**
 * Export itinerary (0.6): an explicit, finite walk through one path. It is an
 * output input, never a field of the authored document.
 */
export interface ItineraryVisit {
  nodeId: string;
  edgeIdToNext?: string;
}
export interface Itinerary {
  pathId: string;
  visits: ItineraryVisit[];
}
export const ITINERARY_VISIT_LIMIT = 500;
const ITINERARY_BYTES = 1024 * 1024;
const idPattern = /^[A-Za-z0-9_-]{1,96}$/;
const plain = (value: unknown): value is Record<string, unknown> =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

/** Shape, references, adjacency, branch choice and visit limits of an itinerary against a validated document. */
export function validateItinerary(
  document: ProjectDocument,
  input: unknown,
): Result<Itinerary> {
  let data = input;
  if (typeof input === "string") {
    if (new TextEncoder().encode(input).length > ITINERARY_BYTES)
      return failure("ITINERARY_LIMIT", "Itinerary exceeds 1 MiB");
    try {
      data = JSON.parse(input);
    } catch (error) {
      return failure("INVALID_JSON", String(error));
    }
  }
  if (!plain(data))
    return failure("ITINERARY_INVALID", "Itinerary must be an object");
  const extra = Object.keys(data).filter(
    (k) => k !== "pathId" && k !== "visits",
  );
  if (extra.length)
    return failure(
      "ITINERARY_INVALID",
      `Unknown itinerary field: ${extra[0]}`,
      `/${extra[0]}`,
    );
  if (typeof data.pathId !== "string" || !idPattern.test(data.pathId))
    return failure("ITINERARY_INVALID", "pathId must be an ID", "/pathId");
  const visits = data.visits;
  if (!Array.isArray(visits) || visits.length === 0)
    return failure(
      "ITINERARY_EMPTY",
      "An itinerary needs at least one visit",
      "/visits",
    );
  if (visits.length > ITINERARY_VISIT_LIMIT)
    return failure(
      "ITINERARY_LIMIT",
      `An itinerary has at most ${ITINERARY_VISIT_LIMIT} visits`,
      "/visits",
    );
  const result: Itinerary = { pathId: data.pathId, visits: [] };
  for (const [i, visit] of visits.entries()) {
    const at = `/visits/${i}`;
    if (!plain(visit))
      return failure("ITINERARY_INVALID", "A visit must be an object", at);
    const unknown = Object.keys(visit).find(
      (k) => k !== "nodeId" && k !== "edgeIdToNext",
    );
    if (unknown)
      return failure(
        "ITINERARY_INVALID",
        `Unknown visit field: ${unknown}`,
        `${at}/${unknown}`,
      );
    if (typeof visit.nodeId !== "string" || !idPattern.test(visit.nodeId))
      return failure(
        "ITINERARY_INVALID",
        "nodeId must be an ID",
        `${at}/nodeId`,
      );
    if (
      "edgeIdToNext" in visit &&
      (typeof visit.edgeIdToNext !== "string" ||
        !idPattern.test(visit.edgeIdToNext))
    )
      return failure(
        "ITINERARY_INVALID",
        "edgeIdToNext must be an ID",
        `${at}/edgeIdToNext`,
      );
    result.visits.push(
      typeof visit.edgeIdToNext === "string"
        ? { nodeId: visit.nodeId, edgeIdToNext: visit.edgeIdToNext }
        : { nodeId: visit.nodeId },
    );
  }
  const path = document.paths.find((p) => p.id === result.pathId);
  if (!path)
    return failure("UNKNOWN_PATH", "Unknown itinerary path", "/pathId");
  const nodes = new Set(path.nodes.map((n) => n.id));
  const diagnostics: Diagnostic[] = [];
  const counts = new Map<string, number>();
  for (const [i, visit] of result.visits.entries()) {
    const at = `/visits/${i}`;
    if (!nodes.has(visit.nodeId)) {
      diagnostics.push(
        diagnostic("UNKNOWN_NODE", "Unknown node in path", `${at}/nodeId`),
      );
      continue;
    }
    if (i === 0) counts.set(visit.nodeId, 1);
    const next = result.visits[i + 1];
    // An unknown next node is reported on its own visit, not as an adjacency error.
    if (next && !nodes.has(next.nodeId)) continue;
    if (!next) {
      if (visit.edgeIdToNext)
        diagnostics.push(
          diagnostic(
            "EDGE_AFTER_LAST",
            "The last visit has no outgoing transition",
            `${at}/edgeIdToNext`,
          ),
        );
      continue;
    }
    const candidates = path.edges.filter(
      (e) => e.from === visit.nodeId && e.to === next.nodeId,
    );
    let edge: PathEdge | undefined;
    if (visit.edgeIdToNext) {
      edge = path.edges.find((e) => e.id === visit.edgeIdToNext);
      if (!edge) {
        diagnostics.push(
          diagnostic("UNKNOWN_EDGE", "Unknown edge", `${at}/edgeIdToNext`),
        );
        continue;
      }
      if (edge.from !== visit.nodeId || edge.to !== next.nodeId) {
        diagnostics.push(
          diagnostic(
            "EDGE_MISMATCH",
            `Edge ${edge.id} does not connect ${visit.nodeId} to ${next.nodeId}`,
            `${at}/edgeIdToNext`,
          ),
        );
        continue;
      }
    } else if (candidates.length === 0) {
      diagnostics.push(
        diagnostic(
          "NOT_ADJACENT",
          `No edge from ${visit.nodeId} to ${next.nodeId}`,
          `/visits/${i + 1}/nodeId`,
        ),
      );
      continue;
    } else if (candidates.length > 1) {
      diagnostics.push(
        diagnostic(
          "EDGE_AMBIGUOUS",
          `Several edges connect ${visit.nodeId} to ${next.nodeId}: edgeIdToNext is required`,
          `${at}/edgeIdToNext`,
        ),
      );
      continue;
    } else edge = candidates[0]!;
    // Same rule as the runtime: the new entry must not exceed either limit.
    const limit = Math.min(
      path.loopPolicy?.maxVisitsPerNode ?? Infinity,
      edge.condition?.kind === "visit-limit"
        ? edge.condition.maxVisits
        : Infinity,
    );
    const count = counts.get(next.nodeId) ?? 0;
    if (count >= limit)
      diagnostics.push(
        diagnostic(
          "VISIT_LIMIT",
          `Visit limit ${limit} reached for ${next.nodeId}`,
          `/visits/${i + 1}/nodeId`,
        ),
      );
    counts.set(next.nodeId, count + 1);
    if (!visit.edgeIdToNext) visit.edgeIdToNext = edge.id;
  }
  return diagnostics.length
    ? { ok: false, diagnostics }
    : { ok: true, value: result, diagnostics: [] };
}

export interface FirstPass {
  itinerary: Itinerary;
  /** Node the walk would enter a second time; the itinerary stops before it. */
  stoppedBefore?: string;
}
/**
 * Itinerary proposed by Studio: from the start node, follow the only
 * transition of each node until a node without transitions or one already
 * visited. A node with several transitions is a choice the author makes in
 * an itinerary file, so it fails instead of being linearized.
 */
export function firstPassItinerary(
  document: ProjectDocument,
  pathId = document.defaultPathId,
): Result<FirstPass> {
  const path = document.paths.find((p) => p.id === pathId);
  if (!path) return failure("UNKNOWN_PATH", "Unknown path");
  if (!path.startNodeId)
    return failure("ITINERARY_EMPTY", `Path ${path.name} has no start scene`);
  const visits: ItineraryVisit[] = [{ nodeId: path.startNodeId }];
  const seen = new Set([path.startNodeId]);
  let stoppedBefore: string | undefined;
  for (;;) {
    const visit = visits[visits.length - 1]!;
    const outgoing = path.edges.filter((e) => e.from === visit.nodeId);
    if (outgoing.length > 1)
      return failure(
        "ITINERARY_BRANCH",
        `Node ${visit.nodeId} has ${outgoing.length} transitions: choose the branch in an itinerary file`,
      );
    const edge = outgoing[0];
    if (!edge) break;
    if (seen.has(edge.to)) {
      stoppedBefore = edge.to;
      break;
    }
    if (visits.length === ITINERARY_VISIT_LIMIT)
      return failure(
        "ITINERARY_LIMIT",
        `An itinerary has at most ${ITINERARY_VISIT_LIMIT} visits`,
      );
    visit.edgeIdToNext = edge.id;
    visits.push({ nodeId: edge.to });
    seen.add(edge.to);
  }
  const itinerary = validateItinerary(document, { pathId: path.id, visits });
  if (!itinerary.ok) return itinerary;
  return success(
    stoppedBefore
      ? { itinerary: itinerary.value, stoppedBefore }
      : { itinerary: itinerary.value },
  );
}

export interface CaptureVisit {
  index: number;
  nodeId: string;
  sceneId: string;
  /** Start of the hold: the arrival pose is reached exactly here. */
  arrivalMs: number;
  holdMs: number;
  /** Resolved arrival pose, including a track endpoint that differs from the scene fit. */
  camera: CameraPose;
  /** Transition to the next visit, absent on the last one. */
  transition?: {
    edgeId: string;
    startMs: number;
    durationMs: number;
    plan: TransitionPlan;
  };
}
export interface CapturePlan {
  documentId: string;
  pathId: string;
  /** Fixed in the plan, never read from the capturing browser. Reduced plans have no transitions. */
  reducedMotion: boolean;
  totalMs: number;
  visits: CaptureVisit[];
}
export interface CaptureSample {
  visitIndex: number;
  nodeId: string;
  sceneId: string;
  phase: "hold" | "transition";
  /** Transition progress, 1 during a hold. */
  progress: number;
  camera: CameraPose;
}

/**
 * Timeline of an itinerary: the first visit is placed without transition and
 * the total is the sum of every hold plus the transitions between visits.
 * Each track starts from the previous arrival pose, as at runtime, without
 * snapping or changing the saved keyframes.
 */
export function planCapture(
  document: ProjectDocument,
  itinerary: unknown,
  options: { reducedMotion: boolean },
): Result<CapturePlan> {
  const valid = validateItinerary(document, itinerary);
  if (!valid.ok) return valid;
  const path = document.paths.find((p) => p.id === valid.value.pathId)!;
  const visits: CaptureVisit[] = [];
  let at = 0,
    previous: CaptureVisit | undefined;
  for (const [index, item] of valid.value.visits.entries()) {
    const node = path.nodes.find((n) => n.id === item.nodeId)!;
    let camera: CameraPose;
    if (previous?.transition) {
      camera = previous.transition.plan.to;
    } else {
      const pose = node.camera
        ? success(cameraPose(node.camera))
        : resolveSceneCamera(document, node.sceneId);
      if (!pose.ok) return pose;
      camera = pose.value;
    }
    const visit: CaptureVisit = {
      index,
      nodeId: node.id,
      sceneId: node.sceneId,
      arrivalMs: at,
      holdMs: node.holdMs,
      camera: structuredClone(camera),
    };
    at += node.holdMs;
    if (item.edgeIdToNext) {
      const plan = resolveEdgePlan(
        document,
        path.id,
        item.edgeIdToNext,
        visit.camera,
      );
      if (!plan.ok)
        return {
          ok: false,
          diagnostics: plan.diagnostics.map((d) => ({
            ...d,
            pointer: `/visits/${index}/edgeIdToNext`,
          })),
        };
      const durationMs = options.reducedMotion ? 0 : plan.value.durationMs;
      visit.transition = {
        edgeId: item.edgeIdToNext,
        startMs: at,
        durationMs,
        plan: { ...plan.value, durationMs },
      };
      at += durationMs;
    }
    visits.push(visit);
    previous = visit;
  }
  return success({
    documentId: document.id,
    pathId: path.id,
    reducedMotion: options.reducedMotion,
    totalMs: at,
    visits,
  });
}

/** Pure sampler of a capture plan, shared by renderAt, PDF and video. */
export function sampleCapture(
  plan: CapturePlan,
  elapsedMs: number,
): CaptureSample {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs > plan.totalMs)
    throw new RangeError("Elapsed time outside the capture plan");
  for (const visit of plan.visits) {
    const hold = (): CaptureSample => ({
      visitIndex: visit.index,
      nodeId: visit.nodeId,
      sceneId: visit.sceneId,
      phase: "hold",
      progress: 1,
      camera: structuredClone(visit.camera),
    });
    if (elapsedMs < visit.arrivalMs + visit.holdMs) return hold();
    const t = visit.transition;
    if (!t) return hold();
    if (elapsedMs < t.startMs + t.durationMs) {
      const sample = sampleTransition(t.plan, elapsedMs - t.startMs);
      // During a transition the current visit is still the source, as at runtime.
      return {
        visitIndex: visit.index,
        nodeId: visit.nodeId,
        sceneId: visit.sceneId,
        phase: "transition",
        progress: sample.progress,
        camera: sample.camera,
      };
    }
  }
  const last = plan.visits.at(-1)!;
  return {
    visitIndex: last.index,
    nodeId: last.nodeId,
    sceneId: last.sceneId,
    phase: "hold",
    progress: 1,
    camera: structuredClone(last.camera),
  };
}

export interface FrameSchedule {
  fps: number;
  /** N = ceil(totalMs * fps / 1000); frames i = 0..N-1 at t = i * 1000 / fps. */
  frameCount: number;
  frameMs: number;
  planMs: number;
  /** N / fps, within one frame of the plan. */
  encodedMs: number;
  lastFrameMs: number;
  /** The exact end pose is not a frame: it is visible only with a final hold of at least one frame. */
  finalHoldVisible: boolean;
}
export function frameSchedule(
  plan: CapturePlan,
  fps: number,
): Result<FrameSchedule> {
  if (!Number.isInteger(fps) || fps < 1 || fps > 120)
    return failure("INVALID_FPS", "fps must be an integer between 1 and 120");
  if (!(plan.totalMs > 0))
    return failure(
      "ZERO_DURATION",
      "A video needs a total duration above zero: give the visits holdMs or transitions",
    );
  const frameCount = Math.ceil((plan.totalMs * fps) / 1000);
  const last = plan.visits.at(-1)!;
  const lastFrameMs = ((frameCount - 1) * 1000) / fps;
  return success({
    fps,
    frameCount,
    frameMs: 1000 / fps,
    planMs: plan.totalMs,
    encodedMs: (frameCount * 1000) / fps,
    lastFrameMs,
    finalHoldVisible: lastFrameMs >= last.arrivalMs,
  });
}
export const frameTime = (schedule: FrameSchedule, index: number) =>
  (index * 1000) / schedule.fps;

/** Runtime copy for public players and exports: private notes never leave the authored project. */
export function publicDocument(document: ProjectDocument): ProjectDocument {
  return {
    ...document,
    scenes: document.scenes.map((scene) =>
      scene.notes === "" ? scene : { ...scene, notes: "" },
    ),
  };
}
