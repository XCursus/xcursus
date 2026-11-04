import { getWorldMatrix } from "@xcursus/core";
import type { ProjectDocument } from "@xcursus/core";

type Point = [number, number, number];
interface Plane {
  id: string;
  index: number;
  area: number;
  corners: Point[];
  origin: Point;
  normal: Point;
}
/** Planes considered for the split-minimizing order; smaller scenes follow by area. */
const LARGEST = 64;

const sub = (a: Point, b: Point): Point => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2],
];
const dot = (a: Point, b: Point) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Whether `plane` cuts through the rectangle of `other` (both world space). */
function splits(plane: Plane, other: Plane): boolean {
  let below = false,
    above = false;
  for (const corner of other.corners) {
    const distance = dot(plane.normal, sub(corner, plane.origin));
    if (distance < -0.5) below = true;
    else if (distance > 0.5) above = true;
  }
  return below && above;
}

/**
 * Paint order of the scene wrappers for an engine that sorts 3D planes by
 * inserting them, in paint order, into a splitting tree (Gecko). Every
 * inserted plane cuts the later planes that cross it; when a very large
 * plane is cut, the fragments lose precision and scenes just in front of it
 * (child scenes above a section) can be drawn behind it. Planes that cut the
 * least area of the others are therefore painted first, largest first on
 * ties, and smaller scenes follow from the largest. Depth still decides what
 * is in front; only the order in which the engine sorts changes.
 *
 * The relation "plane A cuts rectangle B" is affine-invariant, so this
 * order depends on the document only, never on the camera. Returns scene IDs.
 */
export function paintOrder(document: ProjectDocument): string[] {
  const planes: Plane[] = document.scenes.map((scene, index) => {
    const world = getWorldMatrix(document, scene.id);
    if (!world.ok)
      return {
        id: scene.id,
        index,
        area: 0,
        corners: [],
        origin: [0, 0, 0],
        normal: [0, 0, 1],
      };
    const m = world.value;
    const [w, h] = scene.size;
    const at = (x: number, y: number): Point => [
      m[0]! * x + m[4]! * y + m[12]!,
      m[1]! * x + m[5]! * y + m[13]!,
      m[2]! * x + m[6]! * y + m[14]!,
    ];
    const scale = Math.hypot(m[0]!, m[1]!, m[2]!);
    const length = Math.hypot(m[8]!, m[9]!, m[10]!) || 1;
    return {
      id: scene.id,
      index,
      area: w * h * scale * scale,
      corners: [
        at(-w / 2, -h / 2),
        at(w / 2, -h / 2),
        at(w / 2, h / 2),
        at(-w / 2, h / 2),
      ],
      origin: [m[12]!, m[13]!, m[14]!],
      normal: [m[8]! / length, m[9]! / length, m[10]! / length],
    };
  });
  const bySize = [...planes].sort(
    (a, b) => b.area - a.area || a.index - b.index,
  );
  const large = bySize.slice(0, LARGEST);
  const order: Plane[] = [];
  // Greedy: the next plane is the one cutting the least area of those left.
  while (large.length) {
    let best = 0,
      bestCut = Infinity;
    large.forEach((plane, i) => {
      let cut = 0;
      for (const other of large)
        if (other !== plane && splits(plane, other)) cut += other.area;
      if (cut < bestCut) {
        best = i;
        bestCut = cut;
      }
    });
    order.push(...large.splice(best, 1));
  }
  return [...order, ...bySize.slice(LARGEST)].map((p) => p.id);
}

/**
 * A cut plane is also drawn with hairline seams along the cuts, so the scene
 * being shown is painted before everything and is never cut.
 */
export const activeFirst = (order: string[], active: string | null) =>
  active !== null && order.includes(active)
    ? [active, ...order.filter((id) => id !== active)]
    : order;

/**
 * Whether the engine needs the explicit paint order: Gecko, recognised by a
 * property only it supports. Other engines keep document order untouched.
 */
export const needsPaintOrder = (
  win: (Window & typeof globalThis) | null | undefined,
): boolean => {
  try {
    return !!win?.CSS?.supports?.("-moz-appearance", "none");
  } catch {
    return false;
  }
};
