import { mat4 } from "gl-matrix";
import { decomposeSceneMatrix } from "@xcursus/core";
import type { Vec3 } from "@xcursus/core";
import type { HtmlElement } from "../parse/index.js";
import {
  attributeText,
  toNumber,
  toNumberAdvanced,
  validateOrder,
} from "./numbers.js";
import type { SizeConfig } from "./numbers.js";

/** Upstream build the attributes are read for. */
export type ImpressProfile = "bundle" | "core";

/** The pose impress.js computes for a step (`initStep`), in source terms. */
export interface SourcePose {
  translate: Vec3;
  rotate: { x: number; y: number; z: number; order: string };
  scale: number;
  transitionDuration: number;
}

type Attributes = Map<string, string>;
const relativeZero = () => ({
  position: "absolute",
  x: 0,
  y: 0,
  z: 0,
  rotate: { x: 0, y: 0, z: 0, order: "xyz" },
});
interface RelState {
  x: number;
  y: number;
  z: number;
  rotate: { x: number; y: number; z: number; order: string };
  relative: ReturnType<typeof relativeZero>;
}
export interface RelFinding {
  step: number;
  kind: "relative-position" | "rel-to-missing" | "rel-to-later";
  detail: string;
}

/**
 * The rel plugin of the 2.0.0 bundle (`src/plugins/rel/rel.js`) as a pure
 * function: for each step, in order, the attributes it rewrites before
 * `init` reads them. Omitted coordinates inherit the previous step's value
 * plus the inherited `data-rel-*` offsets. `data-rel-position="relative"`
 * (offsets along the previous step's rotated axes) is not reproduced: those
 * steps keep world-axis offsets and are reported.
 */
export function applyRelPlugin(
  steps: readonly HtmlElement[],
  config: SizeConfig,
  ids: ReadonlyMap<string, HtmlElement>,
): { attributes: Attributes[]; findings: RelFinding[] } {
  const attributes: Attributes[] = [];
  const findings: RelFinding[] = [];
  const written = new Map<HtmlElement, Attributes>();
  const read = (el: HtmlElement, name: string) =>
    (written.get(el) ?? el.attrs).get(name) ?? null;
  let prev: RelState | undefined;
  steps.forEach((el, index) => {
    const data = (name: string) => el.attrs.get(name);
    if (!prev)
      prev = {
        x: 0,
        y: 0,
        z: 0,
        rotate: { x: 0, y: 0, z: 0, order: "xyz" },
        relative: relativeZero(),
      };
    const relTo = data("data-rel-to");
    if (relTo) {
      const ref = ids.get(relTo);
      if (!ref)
        findings.push({ step: index, kind: "rel-to-missing", detail: relTo });
      else if (ref.order < el.order) {
        prev.x = toNumberAdvanced(read(ref, "data-x"), config);
        prev.y = toNumberAdvanced(read(ref, "data-y"), config);
        prev.z = toNumberAdvanced(read(ref, "data-z"), config);
        const position = read(ref, "data-rel-position") || "absolute";
        if (position !== "relative") {
          prev.rotate = { x: 0, y: 0, z: 0, order: "xyz" };
          prev.relative = relativeZero();
        } else {
          prev.rotate.y = toNumber(read(ref, "data-rotate-y"));
          prev.rotate.x = toNumber(read(ref, "data-rotate-x"));
          prev.rotate.z = toNumber(
            read(ref, "data-rotate-z") || read(ref, "data-rotate"),
          );
          prev.relative = {
            position,
            x: toNumberAdvanced(read(ref, "data-rel-x"), config, 0),
            y: toNumberAdvanced(read(ref, "data-rel-y"), config, 0),
            z: toNumberAdvanced(read(ref, "data-rel-z"), config, 0),
            rotate: {
              x: toNumberAdvanced(read(ref, "data-rel-rotate-x"), config, 0),
              y: toNumberAdvanced(read(ref, "data-rel-rotate-y"), config, 0),
              z: toNumberAdvanced(read(ref, "data-rel-rotate-z"), config, 0),
              order: read(ref, "data-rel-rotate-order") || "xyz",
            },
          };
        }
      } else
        findings.push({ step: index, kind: "rel-to-later", detail: relTo });
    }
    let inheritRotation = true;
    if (el.attrs.has("data-rel-reset")) {
      prev.relative = { ...relativeZero(), position: prev.relative.position };
      if (data("data-rel-reset") === "all") inheritRotation = false;
    }
    const order = data("data-rotate-order") || "xyz";
    const step: RelState = {
      x: toNumberAdvanced(data("data-x"), config, prev.x),
      y: toNumberAdvanced(data("data-y"), config, prev.y),
      z: toNumberAdvanced(data("data-z"), config, prev.z),
      rotate: {
        x: toNumber(data("data-rotate-x"), 0),
        y: toNumber(data("data-rotate-y"), 0),
        z: toNumber(data("data-rotate-z") || data("data-rotate"), 0),
        order,
      },
      relative: {
        position: data("data-rel-position") || prev.relative.position,
        x: toNumberAdvanced(data("data-rel-x"), config, prev.relative.x),
        y: toNumberAdvanced(data("data-rel-y"), config, prev.relative.y),
        z: toNumberAdvanced(data("data-rel-z"), config, prev.relative.z),
        rotate: {
          x: toNumber(data("data-rel-rotate-x"), prev.relative.rotate.x),
          y: toNumber(data("data-rel-rotate-y"), prev.relative.rotate.y),
          z: toNumber(data("data-rel-rotate-z"), prev.relative.rotate.z),
          order,
        },
      },
    };
    const relative = step.relative;
    if (relative.position === "relative" && inheritRotation)
      findings.push({
        step: index,
        kind: "relative-position",
        detail: "data-rel-position=relative",
      });
    if (data("data-x") !== undefined) relative.x = 0;
    if (data("data-y") !== undefined) relative.y = 0;
    if (data("data-z") !== undefined) relative.z = 0;
    if (data("data-rotate-x") !== undefined || !inheritRotation)
      relative.rotate.x = 0;
    if (data("data-rotate-y") !== undefined || !inheritRotation)
      relative.rotate.y = 0;
    if (
      data("data-rotate-z") !== undefined ||
      data("data-rotate") !== undefined ||
      !inheritRotation
    )
      relative.rotate.z = 0;
    step.x += relative.x;
    step.y += relative.y;
    step.z += relative.z;
    step.rotate.x += relative.rotate.x;
    step.rotate.y += relative.rotate.y;
    step.rotate.z += relative.rotate.z;
    const out = new Map(el.attrs);
    out.set("data-x", attributeText(step.x));
    out.set("data-y", attributeText(step.y));
    out.set("data-z", attributeText(step.z));
    out.set("data-rotate-x", attributeText(step.rotate.x));
    out.set("data-rotate-y", attributeText(step.rotate.y));
    out.set("data-rotate-z", attributeText(step.rotate.z));
    out.set("data-rotate-order", step.rotate.order);
    out.set("data-rel-position", step.relative.position);
    out.set("data-rel-x", attributeText(step.relative.x));
    out.set("data-rel-y", attributeText(step.relative.y));
    out.set("data-rel-z", attributeText(step.relative.z));
    out.set("data-rel-rotate-x", attributeText(step.relative.rotate.x));
    out.set("data-rel-rotate-y", attributeText(step.relative.rotate.y));
    out.set("data-rel-rotate-z", attributeText(step.relative.rotate.z));
    written.set(el, out);
    attributes.push(out);
    prev = step;
  });
  return { attributes, findings };
}

/** `initStep` of the 2.0.0 core: the pose read from a step's attributes. */
export function readStep(
  attrs: ReadonlyMap<string, string>,
  config: SizeConfig & { transitionDuration: number },
): SourcePose {
  const data = (name: string) => attrs.get(name);
  return {
    translate: [
      toNumberAdvanced(data("data-x"), config),
      toNumberAdvanced(data("data-y"), config),
      toNumberAdvanced(data("data-z"), config),
    ],
    rotate: {
      x: toNumber(data("data-rotate-x")),
      y: toNumber(data("data-rotate-y")),
      // `data.rotateZ || data.rotate`: an empty data-rotate-z falls back.
      z: toNumber(data("data-rotate-z") || data("data-rotate")),
      order: validateOrder(data("data-rotate-order")),
    },
    scale: toNumber(data("data-scale"), 1),
    transitionDuration: toNumber(
      data("data-transition-duration"),
      config.transitionDuration,
    ),
  };
}

// Explicit number[] matrices keep double precision without changing gl-matrix globals.
const matrix = () =>
  mat4.identity(new Array<number>(16).fill(0) as unknown as mat4);
const axisRotation: Record<string, (out: mat4, rad: number) => mat4> = {
  x: (out, rad) => mat4.fromXRotation(out, rad),
  y: (out, rad) => mat4.fromYRotation(out, rad),
  z: (out, rad) => mat4.fromZRotation(out, rad),
};
/**
 * The rotation impress.js writes for a pose, `rotateA(a) rotateB(b) rotateC(c)`
 * in the source order, as the matrix product `RA·RB·RC` (CSS multiplies
 * transform functions left to right). Only the listed axes are applied.
 */
export function sourceRotation(rotate: SourcePose["rotate"]): number[] {
  const out = matrix(),
    axis = matrix();
  for (const c of rotate.order) {
    const degrees = rotate[c as "x" | "y" | "z"];
    mat4.multiply(out, out, axisRotation[c]!(axis, (degrees * Math.PI) / 180));
  }
  return Array.from(out);
}

export interface TargetPose {
  position: Vec3;
  rotation: Vec3;
  scale: number;
}
/**
 * Composes `T(translate)·R(source order)·S(scale)` and decomposes it in the
 * XCursus convention `T·Rz·Ry·Rx·S` (core `decomposeSceneMatrix`). A negative
 * scale is a 2D `scale(-s)`, that is a half turn about Z with scale `s`, so
 * it is exact for the flat step. Returns undefined when the pose is outside
 * the document ranges.
 */
export function targetPose(pose: SourcePose): TargetPose | undefined {
  const rotation = sourceRotation(pose.rotate);
  const s = Math.abs(pose.scale);
  const m = matrix();
  mat4.fromTranslation(m, pose.translate);
  mat4.multiply(m, m, rotation as unknown as mat4);
  if (pose.scale < 0) mat4.rotateZ(m, m, Math.PI);
  mat4.scale(m, m, [s, s, s]);
  const decomposed = decomposeSceneMatrix(Array.from(m));
  if (!decomposed.ok) return undefined;
  const { position, rotation: euler, scale } = decomposed.value;
  return {
    position,
    // Normalize -0 and tiny residues so that the JSON stays readable.
    rotation: euler.map((a) => clean(a)) as Vec3,
    scale,
  };
}
const clean = (n: number) => {
  const r = Math.round(n * 1e9) / 1e9;
  return Math.abs(r - n) < 1e-9 ? (r === 0 ? 0 : r) : n;
};
