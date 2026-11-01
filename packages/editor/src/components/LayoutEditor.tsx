import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import {
  adjustFrame,
  clampFrame,
  frameCenter,
  frameCorners,
  frameToScene,
  moveFrame,
  projectScenePoint,
  resizeFrame,
  resolveSceneCamera,
  rotateFrame,
  snapToGrid,
  unprojectScenePoint,
} from "@xcursus/core";
import type {
  Block,
  Frame,
  FrameHandle,
  Point,
  ProjectDocument,
  Scene,
} from "@xcursus/core";
import { setFrames } from "../commands/index.js";
import type { EditorStore } from "../store/index.js";

/**
 * Handles over the shared player preview. The preview is framed frontally
 * with resolveSceneCamera; every position here comes from the core
 * projection plus the measured placement of the player viewport. No block is
 * rendered by React.
 */
interface Viewport {
  left: number;
  top: number;
  scale: number;
}
function measure(
  host: HTMLElement | null,
  document: ProjectDocument,
): Viewport | null {
  const rect = host
    ?.querySelector<HTMLElement>(".xc-viewport")
    ?.getBoundingClientRect();
  if (!rect || !rect.width) return null;
  return {
    left: rect.left,
    top: rect.top,
    scale: rect.width / document.settings.viewport.width,
  };
}
/** Client pixel -> scene content point through the core inverse projection. */
export function clientToScene(
  host: HTMLElement | null,
  document: ProjectDocument,
  sceneId: string,
  point: Point,
): Point | null {
  const viewport = measure(host, document);
  const camera = resolveSceneCamera(document, sceneId);
  if (!viewport || !camera.ok) return null;
  const result = unprojectScenePoint(document, sceneId, camera.value, [
    (point[0] - viewport.left) / viewport.scale,
    (point[1] - viewport.top) / viewport.scale,
  ]);
  return result.ok ? result.value : null;
}
export function blockElement(
  host: HTMLElement | null,
  sceneId: string,
  blockId: string,
) {
  return (
    host?.querySelector<HTMLElement>(
      `.xc-scene[data-scene-id="${sceneId}"] [data-block-id="${blockId}"]`,
    ) ?? null
  );
}
/** Frames from the block rectangles of a flow scene as the player laid them out. */
export function measureFlowFrames(
  host: HTMLElement | null,
  document: ProjectDocument,
  scene: Scene,
): Record<string, Frame> | null {
  // The preview must already frame this scene where the core projection puts
  // it; a stale camera (the preview updates on the next frame) gives no frames.
  const content = host
    ?.querySelector(`.xc-scene[data-scene-id="${scene.id}"] .xc-content`)
    ?.getBoundingClientRect();
  const origin =
    content &&
    clientToScene(host, document, scene.id, [content.left, content.top]);
  const end =
    content &&
    clientToScene(host, document, scene.id, [content.right, content.bottom]);
  if (
    !origin ||
    !end ||
    Math.max(
      Math.abs(origin[0]),
      Math.abs(origin[1]),
      Math.abs(end[0] - scene.size[0]),
      Math.abs(end[1] - scene.size[1]),
    ) > 2
  )
    return null;
  const frames: Record<string, Frame> = {};
  for (const block of scene.blocks) {
    const rect = blockElement(
      host,
      scene.id,
      block.id,
    )?.getBoundingClientRect();
    const a =
      rect && clientToScene(host, document, scene.id, [rect.left, rect.top]);
    const b =
      rect &&
      clientToScene(host, document, scene.id, [rect.right, rect.bottom]);
    if (!a || !b) return null;
    frames[block.id] = clampFrame(
      {
        x: Math.round(a[0]),
        y: Math.round(a[1]),
        width: Math.round(b[0] - a[0]),
        height: Math.round(b[1] - a[1]),
        rotation: 0,
        z: 0,
      },
      scene.size,
    );
  }
  return frames;
}
const handles: Array<[FrameHandle, string, Point]> = [
  ["nw", "top left corner", [0, 0]],
  ["n", "top edge", [0.5, 0]],
  ["ne", "top right corner", [1, 0]],
  ["e", "right edge", [1, 0.5]],
  ["se", "bottom right corner", [1, 1]],
  ["s", "bottom edge", [0.5, 1]],
  ["sw", "bottom left corner", [0, 1]],
  ["w", "left edge", [0, 0.5]],
];
const arrows: Record<string, Point> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1],
};
export function frameSummary(block: Block, index: number, count: number) {
  const f = block.frame;
  const where = f
    ? `x ${Math.round(f.x)}, y ${Math.round(f.y)}, ${Math.round(f.width)} × ${Math.round(f.height)}, rotation ${Math.round(f.rotation)}°, layer ${f.z}`
    : "in the flow";
  return `Block ${index + 1} of ${count}, ${block.type}: ${where}`;
}
type Gesture = {
  pointer: number;
  kind: "move" | "rotate" | FrameHandle;
  start: Point;
  frames: Record<string, Frame>;
  primary: string;
  /** Scene point of the grabbed resize handle: the edge follows the pointer's offset, never jumps to it. */
  anchor: Point;
};
export function LayoutEditor({
  store,
  document,
  scene,
  host,
  revision,
  selection,
  onSelect,
  grid,
  announce,
}: {
  store: EditorStore;
  document: ProjectDocument;
  scene: Scene;
  host: HTMLElement | null;
  /** Increments after each preview documentchange: placement is measured again. */
  revision: number;
  selection: readonly string[];
  onSelect: (ids: string[]) => void;
  grid: number;
  announce: (text: string) => void;
}) {
  const overlay = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const [placement, setPlacement] = useState<Viewport | null>(null);
  const [flowBoxes, setFlowBoxes] = useState<
    Record<string, { left: number; top: number; width: number; height: number }>
  >({});
  const canvas = scene.layout === "canvas";
  useLayoutEffect(() => {
    const update = () => {
      const viewport = measure(host, document),
        origin = overlay.current?.getBoundingClientRect();
      if (!viewport || !origin) {
        setPlacement(null);
        return;
      }
      const next = {
        left: viewport.left - origin.left,
        top: viewport.top - origin.top,
        scale: viewport.scale,
      };
      // Measured again on every change; equal values keep the same state.
      setPlacement((previous) =>
        previous &&
        previous.left === next.left &&
        previous.top === next.top &&
        previous.scale === next.scale
          ? previous
          : next,
      );
      if (scene.layout === "flow") {
        const boxes = Object.fromEntries(
          scene.blocks.flatMap((b) => {
            const r = blockElement(
              host,
              scene.id,
              b.id,
            )?.getBoundingClientRect();
            return r
              ? [
                  [
                    b.id,
                    {
                      left: r.left - origin.left,
                      top: r.top - origin.top,
                      width: r.width,
                      height: r.height,
                    },
                  ],
                ]
              : [];
          }),
        );
        setFlowBoxes((previous) =>
          JSON.stringify(previous) === JSON.stringify(boxes) ? previous : boxes,
        );
      }
    };
    update();
    if (!host) return;
    const observer = new ResizeObserver(update);
    observer.observe(host);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [host, document, scene, revision]);
  // A gesture never outlives its scene or the editor.
  useEffect(
    () => () => {
      if (gesture.current) store.cancelDrag();
      gesture.current = null;
    },
    [store, scene.id],
  );
  const camera = resolveSceneCamera(document, scene.id);
  const project = (point: Point): Point | null => {
    if (!placement || !camera.ok) return null;
    const r = projectScenePoint(document, scene.id, camera.value, point);
    return r.ok
      ? [
          placement.left + r.value[0] * placement.scale,
          placement.top + r.value[1] * placement.scale,
        ]
      : null;
  };
  const pointer = (event: ReactPointerEvent): Point | null =>
    clientToScene(host, document, scene.id, [event.clientX, event.clientY]);
  const framesOf = (ids: readonly string[]) =>
    Object.fromEntries(
      scene.blocks
        .filter((b) => ids.includes(b.id) && b.frame)
        .map((b) => [b.id, b.frame!]),
    );
  const index = (id: string) => scene.blocks.findIndex((b) => b.id === id);
  function begin(
    event: ReactPointerEvent<HTMLElement>,
    kind: Gesture["kind"],
    ids: string[],
    primary: string,
  ) {
    const start = pointer(event);
    if (!canvas || !start || gesture.current || !store.beginGesture()) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.focus({ preventScroll: true });
    const frames = framesOf(ids),
      grabbed = frames[primary]!,
      at = handles.find(([h]) => h === kind)?.[2] ?? [0.5, 0.5];
    gesture.current = {
      pointer: event.pointerId,
      kind,
      start,
      frames,
      primary,
      anchor: frameToScene(grabbed, [
        at[0] * grabbed.width,
        at[1] * grabbed.height,
      ]),
    };
  }
  function move(event: ReactPointerEvent<HTMLElement>) {
    const g = gesture.current;
    if (!g || g.pointer !== event.pointerId) return;
    const point = pointer(event);
    if (!point) return;
    const next: Record<string, Frame> = {};
    const first = g.frames[g.primary]!;
    if (g.kind === "move") {
      let dx = point[0] - g.start[0],
        dy = point[1] - g.start[1];
      // Whole pixels without a grid, grid steps with it.
      if (grid > 0) {
        dx = snapToGrid(first.x + dx, grid) - first.x;
        dy = snapToGrid(first.y + dy, grid) - first.y;
      } else {
        dx = Math.round(dx);
        dy = Math.round(dy);
      }
      for (const [id, frame] of Object.entries(g.frames))
        next[id] = moveFrame(frame, dx, dy, scene.size);
    } else if (g.kind === "rotate")
      next[g.primary] = rotateFrame(
        first,
        g.start,
        point,
        event.shiftKey ? 15 : 1,
      );
    else
      next[g.primary] = resizeFrame(
        first,
        g.kind,
        [
          Math.round(g.anchor[0] + point[0] - g.start[0]),
          Math.round(g.anchor[1] + point[1] - g.start[1]),
        ],
        scene.size,
        grid,
      );
    store.previewGesture(setFrames(scene.id, next));
  }
  function finish(cancel: boolean) {
    const g = gesture.current;
    if (!g) return;
    gesture.current = null;
    if (cancel) {
      store.cancelDrag();
      announce("Gesture cancelled.");
      return;
    }
    store.endDrag();
    const frame = store
      .getSnapshot()
      .document.scenes.find((s) => s.id === scene.id)
      ?.blocks.find((b) => b.id === g.primary)?.frame;
    if (frame)
      announce(
        g.kind === "move"
          ? `Moved: x ${Math.round(frame.x)}, y ${Math.round(frame.y)}.`
          : g.kind === "rotate"
            ? `Rotated: ${Math.round(frame.rotation)}°.`
            : `Resized: ${Math.round(frame.width)} × ${Math.round(frame.height)}.`,
      );
  }
  const pointerProps = {
    onPointerMove: move,
    onPointerUp: () => finish(false),
    onPointerCancel: () => finish(true),
    onLostPointerCapture: () => finish(true),
  };
  /** Arrow keys: one command per press, held keys coalesce into one. */
  function nudge(
    event: ReactKeyboardEvent,
    kind: "move" | "rotate" | FrameHandle,
    ids: string[],
  ) {
    const [ax, ay] = arrows[event.key]!;
    const step = event.shiftKey ? 10 : 1;
    const next: Record<string, Frame> = {};
    for (const [id, frame] of Object.entries(framesOf(ids)))
      next[id] =
        kind === "move"
          ? moveFrame(frame, ax * step, ay * step, scene.size)
          : kind === "rotate"
            ? {
                ...frame,
                rotation: Math.max(
                  -360,
                  Math.min(
                    360,
                    frame.rotation + (ax || -ay) * (event.shiftKey ? 15 : 1),
                  ),
                ),
              }
            : adjustFrame(frame, kind, ax * step, ay * step, scene.size);
    if (!event.repeat) store.endCoalesce();
    const result = store.coalesce(
      `layout:${scene.id}:${kind}:${ids.join(",")}`,
      setFrames(scene.id, next),
    );
    const first = next[ids[0]!];
    if (result.ok && first)
      announce(
        kind === "move"
          ? `x ${Math.round(first.x)}, y ${Math.round(first.y)}`
          : kind === "rotate"
            ? `${Math.round(first.rotation)}°`
            : `${Math.round(first.width)} × ${Math.round(first.height)}`,
      );
  }
  function select(id: string, additive: boolean) {
    const next = additive
      ? selection.includes(id)
        ? selection.filter((x) => x !== id)
        : [...selection, id]
      : [id];
    onSelect(next);
    announce(
      next.length === 1
        ? `Selected block ${index(next[0]!) + 1}.`
        : `Selected ${next.length} blocks.`,
    );
  }
  function keys(event: ReactKeyboardEvent<HTMLElement>, block: Block) {
    // The Studio shortcut for deleting the scene must not fire from here.
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      event.stopPropagation();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (gesture.current) finish(true);
      else onSelect([]);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      select(block.id, event.shiftKey);
    } else if (arrows[event.key] && canvas && !gesture.current) {
      event.preventDefault();
      const ids = selection.includes(block.id) ? [...selection] : [block.id];
      if (!selection.includes(block.id)) onSelect(ids);
      nudge(event, "move", ids);
    }
  }
  function handleKeys(
    event: ReactKeyboardEvent<HTMLElement>,
    kind: "rotate" | FrameHandle,
    id: string,
  ) {
    if (
      event.key === "Escape" ||
      event.key === "Delete" ||
      event.key === "Backspace"
    ) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape" && gesture.current) finish(true);
    } else if (arrows[event.key] && !gesture.current) {
      event.preventDefault();
      nudge(event, kind, [id]);
    }
  }
  const single = selection.length === 1 ? selection[0] : undefined;
  const surface = (() => {
    const tl = project([0, 0]),
      tr = project([scene.size[0], 0]),
      bl = project([0, scene.size[1]]);
    if (!tl || !tr || !bl || !placement) return null;
    const k = Math.hypot(tr[0] - tl[0], tr[1] - tl[1]) / scene.size[0];
    return {
      left: tl[0],
      top: tl[1],
      width: Math.hypot(tr[0] - tl[0], tr[1] - tl[1]),
      height: Math.hypot(bl[0] - tl[0], bl[1] - tl[1]),
      grid: grid * k,
    };
  })();
  return (
    <div ref={overlay} className="layout-overlay" data-layout-scene={scene.id}>
      {surface && (
        <div
          className={`layout-surface ${grid ? "with-grid" : ""}`}
          style={{
            left: surface.left,
            top: surface.top,
            width: surface.width,
            height: surface.height,
            ...(grid
              ? { backgroundSize: `${surface.grid}px ${surface.grid}px` }
              : {}),
          }}
          onPointerDown={(event) => {
            if (event.button === 0 && !event.shiftKey) onSelect([]);
          }}
        />
      )}
      {scene.blocks.map((block, i) => {
        const selected = selection.includes(block.id);
        const label = frameSummary(block, i, scene.blocks.length);
        const common = {
          role: "button" as const,
          tabIndex: 0,
          "aria-pressed": selected,
          "aria-label": label,
          "aria-describedby": "layout-help",
          "data-layout-block": block.id,
          onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) =>
            keys(event, block),
        };
        if (!canvas || !block.frame) {
          const box = flowBoxes[block.id];
          return box ? (
            <div
              key={block.id}
              className={`layout-frame is-flow ${selected ? "selected" : ""}`}
              style={box}
              {...common}
              onPointerDown={(event) => {
                if (event.button === 0) select(block.id, event.shiftKey);
              }}
            >
              <span className="layout-index">{i + 1}</span>
            </div>
          ) : null;
        }
        const [tl, tr, , bl] = frameCorners(block.frame).map(project);
        if (!tl || !tr || !bl) return null;
        const frame = block.frame;
        const box = {
          left: tl[0],
          top: tl[1],
          width: Math.hypot(tr[0] - tl[0], tr[1] - tl[1]),
          height: Math.hypot(bl[0] - tl[0], bl[1] - tl[1]),
          transform: `rotate(${Math.atan2(tr[1] - tl[1], tr[0] - tl[0])}rad)`,
        };
        const centre = project(frameCenter(frame)),
          top = project(frameToScene(frame, [frame.width / 2, 0]));
        const rotateAt =
          centre && top
            ? (() => {
                const d =
                  Math.hypot(top[0] - centre[0], top[1] - centre[1]) || 1;
                return [
                  top[0] + ((top[0] - centre[0]) / d) * 28,
                  top[1] + ((top[1] - centre[1]) / d) * 28,
                ];
              })()
            : null;
        return [
          <div
            key={block.id}
            className={`layout-frame ${selected ? "selected" : ""}`}
            style={box}
            {...common}
            {...pointerProps}
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              const additive = event.shiftKey || event.metaKey || event.ctrlKey;
              if (additive) {
                select(block.id, true);
                return;
              }
              const ids = selected ? [...selection] : [block.id];
              if (!selected) select(block.id, false);
              begin(event, "move", ids, block.id);
            }}
          >
            <span className="layout-index">{i + 1}</span>
          </div>,
          single === block.id &&
            handles.map(([handle, name, [u, v]]) => {
              const at = project(
                frameToScene(frame, [u * frame.width, v * frame.height]),
              );
              return at ? (
                <button
                  key={`${block.id}-${handle}`}
                  type="button"
                  tabIndex={0}
                  className={`layout-handle handle-${handle}`}
                  data-handle={handle}
                  aria-label={`Resize block ${i + 1}: ${name}`}
                  aria-describedby="layout-help"
                  style={{ left: at[0], top: at[1] }}
                  {...pointerProps}
                  onPointerDown={(event) => {
                    if (event.button === 0)
                      begin(event, handle, [block.id], block.id);
                  }}
                  onKeyDown={(event) => handleKeys(event, handle, block.id)}
                />
              ) : null;
            }),
          single === block.id && rotateAt && (
            <button
              key={`${block.id}-rotate`}
              type="button"
              tabIndex={0}
              className="layout-handle layout-rotate"
              data-handle="rotate"
              aria-label={`Rotate block ${i + 1}: ${Math.round(frame.rotation)}°`}
              aria-describedby="layout-help"
              style={{ left: rotateAt[0], top: rotateAt[1] }}
              {...pointerProps}
              onPointerDown={(event) => {
                if (event.button === 0)
                  begin(event, "rotate", [block.id], block.id);
              }}
              onKeyDown={(event) => handleKeys(event, "rotate", block.id)}
            >
              ↻
            </button>
          ),
        ];
      })}
      <p id="layout-help" className="visually-hidden">
        Enter selects, Shift+Enter adds to the selection. Arrows: move or resize
        by 1 px, by 10 px with Shift; on the rotation handle 1° or 15°. Esc
        cancels the gesture in progress.
      </p>
    </div>
  );
}
