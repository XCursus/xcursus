import {
  clampFrame,
  defaultAppearance,
  defaultTheme,
  failure,
  success,
  reparentScene,
  updateCapabilities,
} from "@xcursus/core";
import type {
  Block,
  BlockStyle,
  Frame,
  ProjectDocument,
  Result,
  Scene,
  SceneAppearance,
  ScenePath,
  Theme,
} from "@xcursus/core";
export type DocumentEdit = (
  document: ProjectDocument,
) => Result<ProjectDocument>;
/** RFC 4122 v4 ID; randomUUID exists only in secure contexts, getRandomValues everywhere. */
export function randomId(): string {
  const crypto = globalThis.crypto;
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = Array.from(b, (n) => n.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const id = randomId;
export function emptyProject(): ProjectDocument {
  return {
    schemaVersion: "1.3.0",
    id: id(),
    metadata: { title: "Untitled", language: "en" },
    settings: {
      viewport: { width: 1280, height: 720, perspective: 1000 },
      presentation: {
        fit: "contain",
        motion: "system",
        defaultTransition: { durationMs: 600, easing: "ease-in-out" },
      },
    },
    requiredCapabilities: ["linear"],
    scenes: [],
    cameraTracks: [],
    cues: [],
    assets: [],
    paths: [],
    defaultPathId: null,
    extensions: {},
    theme: defaultTheme(),
  };
}
function mainPath(document: ProjectDocument): Result<ScenePath> {
  let path = document.paths.find((p) => p.id === document.defaultPathId);
  if (!path) {
    path = {
      id: id(),
      name: "Main",
      startNodeId: null,
      nodes: [],
      edges: [],
    };
    document.paths.push(path);
    document.defaultPathId = path.id;
  } else {
    if (
      path.loopPolicy ||
      path.edges.some(
        (e) =>
          e.condition ||
          e.cameraTrackId ||
          document.cues.some((c) => c.edgeId === e.id),
      )
    )
      return failure(
        "PATH_STRUCTURE",
        "The path holds structural data: create a standalone scene and add the visit explicitly.",
      );
    const ordered: string[] = [];
    let next = path.startNodeId;
    const seen = new Set<string>();
    while (next && !seen.has(next)) {
      seen.add(next);
      const node = path.nodes.find((n) => n.id === next)!;
      ordered.push(node.sceneId);
      const exits = path.edges.filter((e) => e.from === next);
      if (exits.length > 1) return failure("PATH_ORDER", "The path branches.");
      next = exits[0]?.to ?? null;
    }
    if (
      next !== null ||
      JSON.stringify(ordered) !==
        JSON.stringify(
          document.scenes.filter((s) => s.visible).map((s) => s.id),
        )
    )
      return failure(
        "PATH_ORDER",
        "The main path does not follow the scene order or repeats visits. The structural edit is rejected; blocks and transforms remain editable.",
      );
  }
  return success(path);
}
function sync(document: ProjectDocument, path: ScenePath) {
  const nodes = document.scenes
    .filter((s) => s.visible)
    .map(
      (s) =>
        path.nodes.find((n) => n.sceneId === s.id) ?? {
          id: id(),
          sceneId: s.id,
          holdMs: 0,
        },
    );
  path.edges = nodes.slice(1).map(
    (n, i) =>
      path.edges.find((e) => e.from === nodes[i]!.id && e.to === n.id) ?? {
        id: id(),
        from: nodes[i]!.id,
        to: n.id,
        label: "",
        transition: structuredClone(
          document.settings.presentation.defaultTransition,
        ),
      },
  );
  path.nodes = nodes;
  path.startNodeId = nodes[0]?.id ?? null;
}
export function createScene(afterId?: string, duplicate = false): DocumentEdit {
  return (document) => {
    const path = mainPath(document);
    const source = document.scenes.find((s) => s.id === afterId);
    if (duplicate && !source)
      return failure("SELECTION", "Select a scene to duplicate.");
    const scene: Scene =
      source && duplicate
        ? {
            ...structuredClone(source),
            id: id(),
            title: `${source.title} — copy`,
            position: [
              source.position[0] + 120,
              source.position[1] + 120,
              source.position[2],
            ],
            blocks: source.blocks.map((b) => ({
              ...structuredClone(b),
              id: id(),
            })),
          }
        : {
            id: id(),
            parentId: null,
            title: `Scene ${document.scenes.length + 1}`,
            position: source
              ? [source.position[0] + 1000, source.position[1], 0]
              : [0, 0, 0],
            rotation: [0, 0, 0],
            scale: 1,
            size: [800, 450],
            visible: true,
            blocks: [
              { id: id(), type: "text", data: { text: "Write your idea." } },
            ],
            notes: "",
            extensions: {},
            layout: "flow",
            appearance: defaultAppearance(),
          };
    const index = source
      ? document.scenes.indexOf(source) + 1
      : document.scenes.length;
    document.scenes.splice(index, 0, scene);
    if (path.ok) sync(document, path.value);
    return success(document);
  };
}
export function deleteImpact(
  document: ProjectDocument,
  sceneId: string,
): string[] {
  return document.paths
    .filter(
      (p) =>
        p.id !== document.defaultPathId &&
        p.nodes.some((n) => n.sceneId === sceneId),
    )
    .map(
      (p) =>
        `${p.name} (${p.nodes.filter((n) => n.sceneId === sceneId).length} references)`,
    );
}
export function deleteScene(sceneId: string, confirmed = false): DocumentEdit {
  return (document) => {
    const impact = deleteImpact(document, sceneId);
    if (impact.length && !confirmed)
      return failure(
        "REFERENCED_SCENE",
        `Deletion rejected: the scene is also used in ${impact.join(", ")}.`,
      );
    const path = mainPath(document);
    if (!document.scenes.some((s) => s.id === sceneId))
      return failure("SELECTION", "Scene not found.");
    for (const child of document.scenes.filter((s) => s.parentId === sceneId)) {
      const changed = reparentScene(
        document,
        child.id,
        document.scenes.find((s) => s.id === sceneId)!.parentId,
      );
      if (!changed.ok) return changed;
      document = changed.value;
    }
    document.scenes = document.scenes.filter((s) => s.id !== sceneId);
    if (path.ok && !impact.length)
      sync(
        document,
        document.paths.find((p) => p.id === path.value.id)!,
      );
    else
      for (const p of document.paths) {
        p.nodes = p.nodes.filter((n) => n.sceneId !== sceneId);
        prunePath(p);
      }
    const edges = new Set(
      document.paths.flatMap((p) => p.edges.map((e) => e.id)),
    );
    document.cues = document.cues.filter((c) => edges.has(c.edgeId));
    updateCapabilities(document);
    return success(document);
  };
}
export function editScene(
  sceneId: string,
  patch: Partial<Omit<Scene, "id">>,
): DocumentEdit {
  return (document) => {
    const scene = document.scenes.find((s) => s.id === sceneId);
    if (!scene) return failure("SELECTION", "Scene not found.");
    Object.assign(scene, structuredClone(patch));
    return success(document);
  };
}

/** Graph removals retain only visits reachable from the resulting start. UI previews this exact candidate. */
function prunePath(path: ScenePath): void {
  const ids = new Set(path.nodes.map((n) => n.id));
  path.edges = path.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  if (!path.startNodeId || !ids.has(path.startNodeId))
    path.startNodeId = path.nodes[0]?.id ?? null;
  const seen = new Set<string>(),
    stack = path.startNodeId ? [path.startNodeId] : [];
  while (stack.length) {
    const n = stack.pop()!;
    if (seen.has(n)) continue;
    seen.add(n);
    stack.push(...path.edges.filter((e) => e.from === n).map((e) => e.to));
  }
  path.nodes = path.nodes.filter((n) => seen.has(n.id));
  path.edges = path.edges.filter((e) => seen.has(e.from) && seen.has(e.to));
}
export function reparent(
  sceneId: string,
  parentId: string | null,
  preserveWorld = true,
): DocumentEdit {
  return (doc) => reparentScene(doc, sceneId, parentId, preserveWorld);
}
export function createPath(name = "New path"): DocumentEdit {
  return (doc) => {
    const path: ScenePath = {
      id: id(),
      name,
      startNodeId: null,
      nodes: [],
      edges: [],
    };
    doc.paths.push(path);
    doc.defaultPathId ??= path.id;
    return success(doc);
  };
}
export function editPath(
  pathId: string,
  patch: Partial<Omit<ScenePath, "id" | "nodes" | "edges">>,
): DocumentEdit {
  return (doc) => {
    const path = doc.paths.find((p) => p.id === pathId);
    if (!path) return failure("UNKNOWN_PATH", "Path not found.");
    Object.assign(path, structuredClone(patch));
    return success(doc);
  };
}
export function deletePath(pathId: string): DocumentEdit {
  return (doc) => {
    const path = doc.paths.find((p) => p.id === pathId);
    if (!path) return failure("UNKNOWN_PATH", "Path not found.");
    doc.paths = doc.paths.filter((p) => p.id !== pathId);
    if (doc.defaultPathId === pathId)
      doc.defaultPathId = doc.paths[0]?.id ?? null;
    const edges = new Set(doc.paths.flatMap((p) => p.edges.map((e) => e.id)));
    doc.cues = doc.cues.filter((c) => edges.has(c.edgeId));
    return success(doc);
  };
}
export function createNode(
  pathId: string,
  sceneId: string,
  fromId?: string,
): DocumentEdit {
  return (doc) => {
    const path = doc.paths.find((p) => p.id === pathId);
    if (!path) return failure("UNKNOWN_PATH", "Path not found.");
    const node = { id: id(), sceneId, holdMs: 0 };
    const from = fromId ?? path.nodes.at(-1)?.id;
    path.nodes.push(node);
    if (from)
      path.edges.push({
        id: id(),
        from,
        to: node.id,
        label: "",
        transition: structuredClone(
          doc.settings.presentation.defaultTransition,
        ),
      });
    path.startNodeId ??= node.id;
    return success(doc);
  };
}
export function editNode(
  pathId: string,
  nodeId: string,
  patch: Partial<Omit<ScenePath["nodes"][number], "id">>,
): DocumentEdit {
  return (doc) => {
    const node = doc.paths
      .find((p) => p.id === pathId)
      ?.nodes.find((n) => n.id === nodeId);
    if (!node) return failure("UNKNOWN_NODE", "Node not found.");
    Object.assign(node, structuredClone(patch));
    return success(doc);
  };
}
export function connectNodes(
  pathId: string,
  from: string,
  to: string,
): DocumentEdit {
  return (doc) => {
    const path = doc.paths.find((p) => p.id === pathId);
    if (!path) return failure("UNKNOWN_PATH", "Path not found.");
    path.edges.push({
      id: id(),
      from,
      to,
      label: "New choice",
      transition: structuredClone(doc.settings.presentation.defaultTransition),
      condition: { kind: "manual" },
    });
    return success(doc);
  };
}
export function editEdge(
  pathId: string,
  edgeId: string,
  patch: Partial<ScenePath["edges"][number]>,
): DocumentEdit {
  return (doc) => {
    const edge = doc.paths
      .find((p) => p.id === pathId)
      ?.edges.find((e) => e.id === edgeId);
    if (!edge) return failure("UNKNOWN_EDGE", "Connection not found.");
    Object.assign(edge, structuredClone(patch));
    return success(doc);
  };
}
export function removeGraphItem(
  pathId: string,
  itemId: string,
  kind: "node" | "edge",
): DocumentEdit {
  return (doc) => {
    const path = doc.paths.find((p) => p.id === pathId);
    if (!path) return failure("UNKNOWN_PATH", "Path not found.");
    if (kind === "node") path.nodes = path.nodes.filter((n) => n.id !== itemId);
    else path.edges = path.edges.filter((e) => e.id !== itemId);
    prunePath(path);
    const edges = new Set(doc.paths.flatMap((p) => p.edges.map((e) => e.id)));
    doc.cues = doc.cues.filter((c) => edges.has(c.edgeId));
    return success(doc);
  };
}
export function editImpact(
  document: ProjectDocument,
  edit: DocumentEdit,
): Result<{ document: ProjectDocument; description: string }> {
  const result = edit(structuredClone(document));
  if (!result.ok) return result;
  const next = result.value;
  const nodes =
    document.paths.reduce((n, p) => n + p.nodes.length, 0) -
    next.paths.reduce((n, p) => n + p.nodes.length, 0);
  const edges =
    document.paths.reduce((n, p) => n + p.edges.length, 0) -
    next.paths.reduce((n, p) => n + p.edges.length, 0);
  const parents = document.scenes.filter(
    (s) =>
      s.parentId !== next.scenes.find((n) => n.id === s.id)?.parentId &&
      next.scenes.some((n) => n.id === s.id),
  ).length;
  return success({
    document: next,
    description: `${document.scenes.length - next.scenes.length} scenes, ${document.paths.length - next.paths.length} paths, ${nodes} visits, ${edges} connections and ${document.cues.length - next.cues.length} cues removed; ${parents} children reparented, keeping their world pose. Visits no longer reachable are removed. Undo restores all the data.`,
  });
}

/** Layout commands: tokens and frames only; frame math lives in the core. */
function sceneById(document: ProjectDocument, sceneId: string) {
  return document.scenes.find((s) => s.id === sceneId);
}
/** Initial frame of a block added to a canvas scene: centred, above the others. */
export function defaultFrame(scene: Scene): Frame {
  const width = Math.min(400, scene.size[0]),
    height = Math.min(160, scene.size[1]);
  const top = Math.max(-1, ...scene.blocks.map((b) => b.frame?.z ?? 0));
  return clampFrame(
    {
      x: (scene.size[0] - width) / 2,
      y: (scene.size[1] - height) / 2,
      width,
      height,
      rotation: 0,
      z: Math.min(1000, top + 1),
    },
    scene.size,
  );
}
export function setFrames(
  sceneId: string,
  frames: Readonly<Record<string, Frame>>,
): DocumentEdit {
  return (document) => {
    const scene = sceneById(document, sceneId);
    if (!scene) return failure("SELECTION", "Scene not found.");
    if (scene.layout !== "canvas")
      return failure("LAYOUT_FLOW", "The scene is not in canvas mode.");
    for (const [id, frame] of Object.entries(frames)) {
      const block = scene.blocks.find((b) => b.id === id);
      if (!block) return failure("SELECTION", "Block not found.");
      block.frame = structuredClone(frame);
    }
    return success(document);
  };
}
/** Applies the patch to every listed block; tokens set to undefined are removed. */
export function setBlockStyle(
  sceneId: string,
  blockIds: readonly string[],
  patch: Readonly<Partial<Record<keyof BlockStyle, string | undefined>>>,
): DocumentEdit {
  return (document) => {
    const scene = sceneById(document, sceneId);
    if (!scene) return failure("SELECTION", "Scene not found.");
    for (const id of blockIds) {
      const block = scene.blocks.find((b) => b.id === id);
      if (!block) return failure("SELECTION", "Block not found.");
      const style: Record<string, string | undefined> = {
        ...block.style,
        ...patch,
      };
      for (const key of Object.keys(style))
        if (style[key] === undefined) delete style[key];
      if (Object.keys(style).length) block.style = style as BlockStyle;
      else delete block.style;
    }
    return success(document);
  };
}
export function setAppearance(
  sceneId: string,
  patch: Partial<SceneAppearance>,
): DocumentEdit {
  return (document) => {
    const scene = sceneById(document, sceneId);
    if (!scene) return failure("SELECTION", "Scene not found.");
    scene.appearance = { ...scene.appearance, ...structuredClone(patch) };
    return success(document);
  };
}
/** One command: canvas layout with a frame for every block, measured by the caller. */
export function convertToCanvas(
  sceneId: string,
  frames: Readonly<Record<string, Frame>>,
): DocumentEdit {
  return (document) => {
    const scene = sceneById(document, sceneId);
    if (!scene) return failure("SELECTION", "Scene not found.");
    if (scene.layout === "canvas")
      return failure("LAYOUT_CANVAS", "The scene is already in canvas mode.");
    for (const block of scene.blocks) {
      const frame = frames[block.id];
      if (!frame)
        return failure(
          "FRAME_REQUIRED",
          "A block measurement is missing: try again with the preview visible.",
        );
      block.frame = clampFrame(structuredClone(frame), scene.size);
    }
    scene.layout = "canvas";
    return success(document);
  };
}
/** Removes every frame: positions, sizes, rotations and levels are lost (undo restores them). */
export function convertToFlow(sceneId: string): DocumentEdit {
  return (document) => {
    const scene = sceneById(document, sceneId);
    if (!scene) return failure("SELECTION", "Scene not found.");
    scene.layout = "flow";
    for (const block of scene.blocks) delete block.frame;
    return success(document);
  };
}
/** Reading order is the array order: moving a block never changes its frame or z. */
export function moveInReadingOrder(
  sceneId: string,
  blockId: string,
  delta: number,
): DocumentEdit {
  return (document) => {
    const scene = sceneById(document, sceneId);
    if (!scene) return failure("SELECTION", "Scene not found.");
    const from = scene.blocks.findIndex((b) => b.id === blockId),
      to = from + delta;
    if (from < 0) return failure("SELECTION", "Block not found.");
    if (to < 0 || to >= scene.blocks.length) return success(document);
    const [block] = scene.blocks.splice(from, 1) as [Block];
    scene.blocks.splice(to, 0, block);
    return success(document);
  };
}
export function editTheme(change: (theme: Theme) => void): DocumentEdit {
  return (document) => {
    change(document.theme);
    return success(document);
  };
}
