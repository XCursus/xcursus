/**
 * Independent oracle for the impress.js geometry: it builds the CSS transform
 * strings impress.js 2.0.0 writes (`initStep` for steps, `goto` for root and
 * canvas) from a source pose and evaluates them with its own CSS Transforms
 * arithmetic. It shares no code with the importer or with the XCursus core.
 */
export type M4 = number[]; // column-major, like CSS matrix3d()
export type V3 = [number, number, number];
export interface Pose {
  translate: V3;
  rotate: { x: number; y: number; z: number; order: string };
  scale: number;
}

const identity = (): M4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
export function multiply(a: M4, b: M4): M4 {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      for (let k = 0; k < 4; k++)
        out[c * 4 + r]! += a[k * 4 + r]! * b[c * 4 + k]!;
  return out;
}
const rad = (deg: number) => (deg * Math.PI) / 180;
/** CSS Transforms 2: rotateX/Y/Z(a) as matrix3d, column-major. */
const functions: Record<string, (args: number[]) => M4> = {
  translate3d: ([x, y, z]) => [
    1,
    0,
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    0,
    1,
    0,
    x!,
    y!,
    z!,
    1,
  ],
  translate: ([x, y]) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x!, y ?? 0, 0, 1],
  rotateX: ([a]) => {
    const c = Math.cos(rad(a!)),
      s = Math.sin(rad(a!));
    return [1, 0, 0, 0, 0, c, s, 0, 0, -s, c, 0, 0, 0, 0, 1];
  },
  rotateY: ([a]) => {
    const c = Math.cos(rad(a!)),
      s = Math.sin(rad(a!));
    return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
  },
  rotateZ: ([a]) => {
    const c = Math.cos(rad(a!)),
      s = Math.sin(rad(a!));
    return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  },
  // 2D scale(s): sx = sy = s, z untouched.
  scale: ([sx, sy]) => [
    sx!,
    0,
    0,
    0,
    0,
    sy ?? sx!,
    0,
    0,
    0,
    0,
    1,
    0,
    0,
    0,
    0,
    1,
  ],
};
/** Evaluates a transform list of translate/translate3d/rotateX/Y/Z/scale with px, deg and % (of `box`). */
export function evaluate(css: string, box: [number, number] = [0, 0]): M4 {
  let m = identity();
  for (const [, name, args] of css.matchAll(/([a-zA-Z0-9]+)\(([^)]*)\)/g)) {
    const values = args!.split(",").map((raw, i) => {
      const v = raw.trim();
      if (v.endsWith("%")) return (Number(v.slice(0, -1)) / 100) * box[i % 2]!;
      return Number(v.replace(/px$|deg$/, ""));
    });
    const f = functions[name!];
    if (!f) throw new Error(`Unsupported transform function ${name}`);
    m = multiply(m, f(values));
  }
  return m;
}
export function apply(m: M4, [x, y, z]: V3): V3 {
  const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
  return [
    (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / w,
    (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / w,
    (m[2]! * x + m[6]! * y + m[10]! * z + m[14]!) / w,
  ];
}

// impress.js 2.0.0 string builders, as in src/impress.js.
const translate = (t: V3) => ` translate3d(${t[0]}px,${t[1]}px,${t[2]}px) `;
const rotate = (r: Pose["rotate"], revert = false) => {
  const axes = r.order.split("");
  if (revert) axes.reverse();
  return axes
    .map((a) => ` rotate${a.toUpperCase()}(${r[a as "x" | "y" | "z"]}deg)`)
    .join("");
};
const scale = (s: number) => ` scale(${s}) `;
export const stepTransform = (p: Pose) =>
  "translate(-50%,-50%)" +
  translate(p.translate) +
  rotate(p.rotate) +
  scale(p.scale);
export const canvasTransform = (p: Pose) =>
  rotate(
    {
      x: -p.rotate.x,
      y: -p.rotate.y,
      z: -p.rotate.z,
      order: p.rotate.order,
    },
    true,
  ) + translate([-p.translate[0], -p.translate[1], -p.translate[2]]);

/**
 * Canvas coordinates of a point of a step box of size `box`, given in box
 * pixels from its top-left corner: transform-origin is the box centre and
 * the static position is the canvas origin.
 */
export function stepPoint(
  pose: Pose,
  box: [number, number],
  point: [number, number],
): V3 {
  const o: V3 = [box[0] / 2, box[1] / 2, 0];
  const m = multiply(
    multiply(
      evaluate(`translate3d(${o[0]}px,${o[1]}px,0px)`),
      evaluate(stepTransform(pose), box),
    ),
    evaluate(`translate3d(${-o[0]}px,${-o[1]}px,0px)`),
  );
  return apply(m, [point[0], point[1], 0]);
}

/**
 * Screen position of a canvas point when impress.js is at `active` in a
 * window of `window` CSS pixels: root at the window centre with
 * `scale(k)` and `perspective: P / k` (origin at its 0×0 box), canvas with
 * the inverse step transform. Returns undefined behind the eye.
 */
export function screenPoint(
  active: Pose,
  point: V3,
  config: { width: number; height: number; perspective: number },
  window: [number, number],
): [number, number] | undefined {
  const windowScale = Math.min(
    window[1] / config.height,
    window[0] / config.width,
  );
  const k = windowScale / active.scale;
  const d = config.perspective / k;
  const [x, y, z] = apply(evaluate(canvasTransform(active)), point);
  if (z >= d) return undefined;
  const f = d / (d - z);
  return [window[0] / 2 + k * x * f, window[1] / 2 + k * y * f];
}

/** Corners and centre of a box, in box pixels. */
export const landmarks = (box: [number, number]): Array<[number, number]> => [
  [0, 0],
  [box[0], 0],
  [box[0], box[1]],
  [0, box[1]],
  [box[0] / 2, box[1] / 2],
];
