import type {
  NavigationOptions,
  NavigationResult,
  PlayerState,
  ProjectDocument,
} from "@xcursus/core";

/** The part of an XCursus player the adapter drives (a mounted `createPlayer()` instance). */
export interface AdapterPlayer {
  goTo(
    target: { pathId?: string; nodeId: string },
    options?: NavigationOptions,
  ): Promise<NavigationResult>;
  getState(): Readonly<Pick<PlayerState, "pathId" | "nodeId">>;
}
export interface AdapterStep {
  index: number;
  stepId: string;
  sceneId: string;
  nodeId?: string;
}
/**
 * The subset of the impress.js API with a defined meaning on an XCursus
 * player. `next` and `prev` follow document order and wrap around like
 * impress.js (not the visit history of `player.prev()`), skipping steps that
 * are not on the path; `goto` accepts an index (negative from the end) or a
 * step ID, plus a duration in milliseconds. There is no `init`, `swipe` or
 * `tear`, no `impress:*` events and no hash navigation; mounting and
 * destroying stay with the player.
 */
export interface ImpressAdapter {
  readonly steps: readonly AdapterStep[];
  goto(step: number | string, durationMs?: number): Promise<NavigationResult>;
  next(): Promise<NavigationResult>;
  prev(): Promise<NavigationResult>;
}

const unknown = (message: string): NavigationResult => ({
  status: "error",
  diagnostic: {
    code: "IMPRESS_UNKNOWN_STEP",
    severity: "error",
    pointer: "",
    message,
  },
});

/**
 * Wraps a player showing a document produced by `importImpress` (the
 * `xcursus.impress` scene extensions carry the original step IDs and order).
 * Nothing is installed on `window`.
 */
export function createImpressAdapter(
  player: AdapterPlayer,
  document: ProjectDocument,
): ImpressAdapter {
  const path = document.paths.find((p) => p.id === document.defaultPathId);
  const nodeOf = new Map(path?.nodes.map((n) => [n.sceneId, n.id]));
  const steps: AdapterStep[] = document.scenes
    .flatMap((scene) => {
      const data = scene.extensions["xcursus.impress"]?.data as
        { stepId?: unknown; index?: unknown } | undefined;
      if (typeof data?.stepId !== "string" || typeof data.index !== "number")
        return [];
      const nodeId = nodeOf.get(scene.id);
      return [
        {
          index: data.index,
          stepId: data.stepId,
          sceneId: scene.id,
          ...(nodeId ? { nodeId } : {}),
        },
      ];
    })
    .sort((a, b) => a.index - b.index);
  const onPath = steps.filter((s) => s.nodeId);
  const go = (step: AdapterStep | undefined, durationMs?: number) => {
    if (!step) return Promise.resolve(unknown("No such step"));
    if (!step.nodeId || !path)
      return Promise.resolve(
        unknown(`Step ${step.stepId} is not on the imported path`),
      );
    return player.goTo(
      { pathId: path.id, nodeId: step.nodeId },
      durationMs === undefined ? undefined : { durationMs },
    );
  };
  const current = () => {
    const state = player.getState();
    return onPath.findIndex((s) => s.nodeId === state.nodeId);
  };
  return {
    steps,
    goto(step, durationMs) {
      if (typeof step === "number") {
        if (!Number.isInteger(step))
          return Promise.resolve(unknown("A step index is an integer"));
        return go(steps.at(step), durationMs);
      }
      return go(
        steps.find((s) => s.stepId === step),
        durationMs,
      );
    },
    next() {
      const at = current();
      return go(onPath[(at + 1) % onPath.length]);
    },
    prev() {
      const at = current();
      return go(onPath[at <= 0 ? onPath.length - 1 : at - 1]);
    },
  };
}
