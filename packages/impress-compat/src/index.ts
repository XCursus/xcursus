import {
  defaultAppearance,
  defaultTheme,
  getWorldMatrix,
  resolveSceneCamera,
  updateCapabilities,
  validateDocument,
} from "@xcursus/core";
import type {
  PathEdge,
  PathNode,
  ProjectDocument,
  Result,
  Scene,
} from "@xcursus/core";
import { Diagnostics } from "./diagnostics/index.js";
import type { ImportDiagnostic } from "./diagnostics/index.js";
import {
  ParseLimitError,
  descendants,
  findFirst,
  hasClass,
  parseHtml,
  textContent,
} from "./parse/index.js";
import type { HtmlElement } from "./parse/index.js";
import { applyRelPlugin, readStep, targetPose } from "./mapping/geometry.js";
import type {
  ImpressProfile,
  SourcePose,
  TargetPose,
} from "./mapping/geometry.js";
import { toNumber, validateOrder } from "./mapping/numbers.js";
import { convertStep } from "./mapping/content.js";
import { Resources, localPath } from "./mapping/resources.js";
import type { ImportResource } from "./mapping/resources.js";
export { IMPORT_CODES } from "./diagnostics/index.js";
export type {
  ImportCode,
  ImportDiagnostic,
  SourceLocation,
} from "./diagnostics/index.js";
export type { ImpressProfile, SourcePose } from "./mapping/geometry.js";
export type { ImportResource } from "./mapping/resources.js";
export { createImpressAdapter } from "./adapter.js";
export type { AdapterPlayer, ImpressAdapter } from "./adapter.js";

/**
 * The upstream release the mapping follows: tag v2.0.0 of the official
 * repository (github.com/impress/impress.js), commit dc3cf697, 21 July 2022.
 * Defaults (1920×1080, perspective 1000, 1000 ms) and the numeric rules come
 * from that tag; master after it changes plugins only, not the core.
 */
export const IMPRESS_BASELINE = {
  version: "2.0.0",
  tag: "v2.0.0",
  commit: "dc3cf69747e0b1b0d1fe534509d09c3c48030e68",
  defaults: {
    width: 1920,
    height: 1080,
    perspective: 1000,
    transitionDuration: 1000,
  },
} as const;
/** Extension key written on the document and on every imported scene. */
export const IMPORT_EXTENSION = "xcursus.impress";
/** Fraction of the viewport a scene of unknown size takes, so that the auto-fit camera frames it like impress.js. */
const FIT = 0.9;

export interface ImpressImportOptions {
  /** Upstream release the HTML targets; only "2.0.0" is supported. */
  baseline?: "2.0.0";
  /**
   * Which upstream build interprets the attributes. `bundle` is `js/impress.js`
   * of the release, with the rel, skip and goto plugins; `core` is
   * `src/impress.js` alone. They differ for omitted coordinates and
   * `data-rel-*`; without an explicit choice the importer uses `bundle` and
   * warns where the two would give different results.
   */
  profile?: ImpressProfile;
  /** ID of the root element (`impress(rootId)`), "impress" by default. */
  rootId?: string;
  /**
   * Local files the presentation references, keyed by their path relative to
   * the HTML file (normalized, forward slashes). The importer reads only
   * these bytes; it never fetches anything.
   */
  resources?: ReadonlyMap<string, Uint8Array>;
  /** Match a missing path against the only provided file with the same name (file pickers without folders). */
  matchBasename?: boolean;
  /** ID of the candidate document; derived from the title when absent. */
  documentId?: string;
}
export interface ImportedStep {
  /** Position among the `.step` elements of the root, in document order. */
  index: number;
  /** ID in the HTML, or the `step-N` impress.js generates for a step without one. */
  stepId: string;
  sceneId: string;
  /** Node of the main path; absent for a step the bundle skips (`.skip`). */
  nodeId?: string;
  source: SourcePose;
  line?: number;
}
export interface ImportCandidate {
  /** Validated document at the current schema (1.3.0). */
  document: ProjectDocument;
  diagnostics: ImportDiagnostic[];
  /** Every resource the HTML references, with what became of it. */
  resources: ImportResource[];
  /** Bytes of the document assets, by asset ID. */
  files: Map<string, Uint8Array>;
  steps: ImportedStep[];
  /** Options actually applied. */
  profile: ImpressProfile;
  profileExplicit: boolean;
  baseline: typeof IMPRESS_BASELINE;
  /** CSS of the source that was not converted: `<style>` elements, inline styles. */
  css: string[];
}

const ID = /^[A-Za-z0-9_-]{1,96}$/;
const slug = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
const words = (text: string) => text.replace(/\s+/g, " ").trim();
const failure = (diagnostics: ImportDiagnostic[]): Result<ImportCandidate> => ({
  ok: false,
  diagnostics,
});

/** Attributes the bundle's plugins read on steps or on the root, reported when present. */
const PLUGIN_ATTRIBUTES = [
  "data-goto",
  "data-goto-next",
  "data-goto-prev",
  "data-goto-key-list",
  "data-goto-next-list",
  "data-autoplay",
  "data-bookmark-key-list",
  "data-media-autoplay",
  "data-media-autostop",
  "data-media-autopause",
  "data-console-autolaunch",
  "data-console-css",
  "data-console-css-iframe",
  "data-console-now-label",
  "data-console-noslides-label",
  "data-substep-order",
];

/**
 * Converts an impress.js presentation into a candidate XCursus document. The
 * HTML is parsed inertly with parse5: no script runs, no stylesheet applies,
 * nothing is fetched or rendered. Steps become scenes in document order on
 * one linear path; positions, rotations (composed in the source order and
 * decomposed as `T·Rz·Ry·Rx·S`) and scales are converted exactly for the
 * flat step; content becomes sanitizable blocks. Structural problems return
 * no candidate; everything the candidate does not carry over is diagnosed.
 */
export function importImpress(
  html: string,
  options: ImpressImportOptions = {},
): Result<ImportCandidate> {
  const d = new Diagnostics();
  if (options.baseline !== undefined && options.baseline !== "2.0.0") {
    d.add(
      "BASELINE_UNSUPPORTED",
      `Only the impress.js ${IMPRESS_BASELINE.version} baseline is supported`,
    );
    return failure(d.list);
  }
  if (
    options.profile !== undefined &&
    options.profile !== "bundle" &&
    options.profile !== "core"
  ) {
    d.add("OPTIONS_INVALID", 'profile must be "bundle" or "core"');
    return failure(d.list);
  }
  if (typeof html !== "string") {
    d.add("OPTIONS_INVALID", "The input must be HTML text");
    return failure(d.list);
  }
  const profile: ImpressProfile = options.profile ?? "bundle";
  const rootId = options.rootId ?? "impress";
  let parsed;
  try {
    parsed = parseHtml(html);
  } catch (error) {
    if (error instanceof ParseLimitError) {
      d.add(error.code, error.message);
      return failure(d.list);
    }
    throw error;
  }
  const { quirks, ids } = parsed;
  const root = ids.get(rootId);
  if (!root) {
    d.add(
      "IMPRESS_ROOT_MISSING",
      `No element with id="${rootId}": not an impress.js presentation, or a different root`,
    );
    return failure(d.list);
  }
  const isStep = (e: HtmlElement) =>
    e.namespace === "html" && hasClass(e, "step", quirks);
  const steps = [...descendants(root)].filter(isStep);
  const outside = [...descendants(parsed.root)].filter(
    (e) => isStep(e) && !steps.includes(e) && e !== root,
  );
  if (outside.length)
    d.add(
      "STEP_OUTSIDE_ROOT",
      `${outside.length} .step element(s) outside #${rootId} are not part of the presentation`,
    );
  if (!steps.length) {
    d.add("IMPRESS_NO_STEPS", `#${rootId} contains no .step element`);
    return failure(d.list);
  }
  if (steps.length > 1000) {
    d.add(
      "IMPRESS_TOO_MANY_STEPS",
      `${steps.length} steps exceed the limit of 1000 scenes`,
    );
    return failure(d.list);
  }

  // Root configuration (`buildConfig`).
  const rootData = (name: string) => root.attrs.get(name);
  const defaults = IMPRESS_BASELINE.defaults;
  const config = {
    width: toNumber(rootData("data-width"), defaults.width),
    height: toNumber(rootData("data-height"), defaults.height),
    perspective: toNumber(rootData("data-perspective"), defaults.perspective),
    transitionDuration: toNumber(
      rootData("data-transition-duration"),
      defaults.transitionDuration,
    ),
  };
  const viewport = { width: config.width, height: config.height };
  for (const axis of ["width", "height"] as const)
    if (
      !Number.isFinite(viewport[axis]) ||
      viewport[axis] < 1 ||
      viewport[axis] > 100000
    ) {
      d.add(
        "VIEWPORT_INVALID",
        `data-${axis}="${rootData(`data-${axis}`)}" is not a size between 1 and 100000: ${defaults[axis]} used`,
        `/settings/viewport/${axis}`,
        { ...root.location },
      );
      viewport[axis] = defaults[axis];
    }
  let perspective = config.perspective;
  if (!Number.isFinite(perspective) || perspective <= 0) {
    d.add(
      "PERSPECTIVE_INVALID",
      `data-perspective="${rootData("data-perspective")}": browsers disagree on a zero or invalid perspective (none or 1px); the flattest perspective, 100000, is used`,
      "/settings/viewport/perspective",
      { ...root.location },
    );
    perspective = 100000;
  } else if (perspective < 1 || perspective > 100000) {
    d.add(
      "PERSPECTIVE_INVALID",
      `data-perspective=${perspective} is outside 1..100000 and was clamped`,
      "/settings/viewport/perspective",
      { ...root.location },
    );
    perspective = Math.min(100000, Math.max(1, perspective));
  }
  d.add(
    "PERSPECTIVE_SCREEN_RELATIVE",
    "impress.js keeps the perspective constant in screen pixels; XCursus keeps it in presentation units, so depth looks the same only when the window matches the configured size",
    "/settings/viewport/perspective",
  );
  if (
    rootData("data-max-scale") !== undefined ||
    rootData("data-min-scale") !== undefined
  )
    d.add(
      "WINDOW_SCALE_LIMITS_IGNORED",
      "data-max-scale and data-min-scale limit the window fit of impress.js; XCursus always fits the viewport to the window",
      "/settings/presentation/fit",
    );
  const duration = (value: number, pointer: string, what: string) => {
    if (
      Number.isFinite(value) &&
      Number.isInteger(value) &&
      value >= 0 &&
      value <= 60000
    )
      return value;
    const fixed = Number.isFinite(value)
      ? Math.min(60000, Math.max(0, Math.round(value)))
      : defaults.transitionDuration;
    d.add(
      "DURATION_INVALID",
      `${what} ${value} ms is not an integer between 0 and 60000: ${fixed} ms used`,
      pointer,
    );
    return fixed;
  };
  const defaultDuration = duration(
    config.transitionDuration,
    "/settings/presentation/defaultTransition/durationMs",
    "data-transition-duration",
  );
  d.add(
    "TIMING_APPROXIMATE",
    "Transitions keep their durations but not the impress.js timing (CSS ease-in-out with zoom delayed by half the duration)",
    "/settings/presentation/defaultTransition",
  );
  d.add(
    "NAVIGATION_WRAP_DROPPED",
    "impress.js wraps from the last step to the first and back; the imported path ends at the last step",
    "/paths/0",
  );
  for (const name of PLUGIN_ATTRIBUTES)
    if (root.attrs.has(name))
      d.add(
        "PLUGIN_ATTRIBUTE_IGNORED",
        `${name} on the root is read by an upstream plugin and is not converted`,
        "",
        { ...root.location },
      );

  // Geometry under the requested profile and, to detect ambiguity, the other one.
  const geometry = (which: ImpressProfile) => {
    if (which === "core")
      return { attributes: steps.map((s) => new Map(s.attrs)), findings: [] };
    return applyRelPlugin(steps, config, ids);
  };
  const chosen = geometry(profile);
  const poses = chosen.attributes.map((attrs) => readStep(attrs, config));
  const other = geometry(
    profile === "bundle" ? "core" : "bundle",
  ).attributes.map((attrs) => readStep(attrs, config));
  // `init` shows the first step even when it is skipped by next and prev.
  const skipped = (s: HtmlElement) =>
    profile === "bundle" && s !== steps[0] && hasClass(s, "skip", quirks);
  if (!options.profile) {
    const differing = steps
      .map((s, i) => ({ s, i }))
      .filter(
        ({ s, i }) =>
          JSON.stringify(poses[i]) !== JSON.stringify(other[i]) ||
          hasClass(s, "skip", quirks),
      );
    if (differing.length)
      d.add(
        "PROFILE_AMBIGUOUS",
        `The bundle (rel and skip plugins) and the core alone read ${differing.length} step(s) differently: ${differing
          .slice(0, 10)
          .map(({ s, i }) => s.attrs.get("id") || `#${i + 1}`)
          .join(
            ", ",
          )}${differing.length > 10 ? ", …" : ""}. The bundle was assumed; choose the profile explicitly`,
        "/scenes",
        undefined,
        'Pass profile "bundle" (js/impress.js) or "core" (src/impress.js only)',
      );
  }

  // Scene IDs: the HTML ID when valid and unique, else a derived one.
  const usedIds = new Set<string>();
  const sceneIds = steps.map((step, i) => {
    const original = step.attrs.get("id") ?? "";
    const generated = `step-${i + 1}`;
    const source = original || generated;
    let id = ID.test(source) ? source : slug(source) || generated;
    if (usedIds.has(id)) {
      const base = id.slice(0, 90);
      let n = 2;
      while (usedIds.has(`${base}-${n}`)) n++;
      d.add(
        original && ids.get(original) !== step
          ? "STEP_ID_DUPLICATE"
          : "STEP_ID_RENAMED",
        `Step ID "${source}" is already used: scene "${base}-${n}"`,
        `/scenes/${i}/id`,
        { step: source, ...step.location },
      );
      id = `${base}-${n}`;
    } else if (!original)
      d.add(
        "STEP_ID_GENERATED",
        `Step without an ID: "${id}", as impress.js names it`,
        `/scenes/${i}/id`,
        { step: generated, ...step.location },
      );
    else if (id !== original)
      d.add(
        "STEP_ID_RENAMED",
        `Step ID "${original}" is not a valid XCursus ID: scene "${id}"`,
        `/scenes/${i}/id`,
        { step: original, ...step.location },
      );
    usedIds.add(id);
    return id;
  });
  const stepNames = steps.map((s, i) => s.attrs.get("id") || `step-${i + 1}`);

  for (const finding of chosen.findings) {
    const step = steps[finding.step]!;
    const source = { step: stepNames[finding.step]!, ...step.location };
    if (finding.kind === "relative-position")
      d.add(
        "REL_POSITION_RELATIVE",
        'data-rel-position="relative" offsets along the previous step\'s rotated axes, which is not reproduced: the offsets are applied along the world axes',
        `/scenes/${finding.step}/position`,
        source,
      );
    else
      d.add(
        "REL_TO_INVALID",
        finding.kind === "rel-to-missing"
          ? `data-rel-to="${finding.detail}" names no element: ignored, as upstream does`
          : `data-rel-to="${finding.detail}" names a later element: ignored, as upstream does`,
        `/scenes/${finding.step}/position`,
        source,
      );
  }

  const resources = new Resources(
    options.resources ?? new Map(),
    options.matchBasename ?? false,
  );
  // Document-level references: stylesheets, scripts and fonts are never loaded.
  for (const element of descendants(parsed.root)) {
    if (element.namespace !== "html") continue;
    if (
      element.tag === "link" &&
      /\bstylesheet\b/i.test(element.attrs.get("rel") ?? "")
    ) {
      const href = element.attrs.get("href") ?? "";
      resources.report.push({
        reference: href,
        kind: "stylesheet",
        status: "ignored",
      });
      d.add(
        "STYLESHEET_IGNORED",
        `Stylesheet not applied: ${href.slice(0, 120)}`,
        "",
        { ...element.location },
        "Layout, colours and fonts of the original CSS are not converted; restyle with the document theme",
      );
    } else if (
      element.tag === "script" &&
      !element.attrs.has("src") &&
      !steps.some((s) => isInside(element, s))
    ) {
      d.add(
        "SCRIPT_REMOVED",
        "Inline script not run: behaviour programmed in JavaScript is not converted",
        "",
        { ...element.location },
      );
    } else if (element.tag === "script" && element.attrs.has("src")) {
      const src = element.attrs.get("src")!;
      resources.report.push({
        reference: src,
        kind: "script",
        status: "ignored",
      });
      d.add(
        "SCRIPT_RESOURCE_IGNORED",
        `Script not loaded: ${src.slice(0, 120)}`,
        "",
        { ...element.location },
      );
    }
  }
  const css: string[] = [];
  for (const element of descendants(parsed.root))
    if (
      element.namespace === "html" &&
      element.tag === "style" &&
      !steps.some((s) => isInside(element, s))
    ) {
      css.push(textContent(element));
      d.add(
        "CSS_NOT_CONVERTED",
        "A <style> element is not converted: layout, colours, fonts, animations and selectors that depend on body or step classes (past, present, future, active) have no XCursus equivalent",
        "",
        { ...element.location },
      );
      if (/@import|@font-face|url\(/i.test(textContent(element)))
        d.add(
          "RESOURCE_REMOTE",
          "The stylesheet references fonts or files (@import, @font-face, url()) that are not loaded",
          "",
          { ...element.location },
        );
    }
  // Content directly in the root that is not a step is visible upstream at the canvas origin.
  for (const child of root.children)
    if (
      (child.kind === "text" && /\S/.test(child.text)) ||
      (child.kind === "element" &&
        !isStep(child) &&
        !hasStepInside(child, steps) &&
        !["script", "style", "link", "template"].includes(child.tag))
    ) {
      d.add(
        "ROOT_CONTENT_IGNORED",
        "Content of the root outside any step is not imported",
        "",
        child.kind === "element" ? { ...child.location } : undefined,
      );
      break;
    }

  const scenes: Scene[] = [];
  const imported: ImportedStep[] = [];
  const nodes: PathNode[] = [];
  let blockCounter = 0;
  const stepSet = new Set(steps);
  steps.forEach((step, i) => {
    const pointer = `/scenes/${i}`;
    const name = stepNames[i]!;
    const source = { step: name, ...step.location };
    let parent = step.parent;
    while (parent && parent !== root) {
      if (stepSet.has(parent)) {
        d.add(
          "STEP_NESTED",
          `Step inside step "${parent.attrs.get("id") || "?"}": imported as a separate scene at its own coordinates, where the impress.js camera goes; upstream it is drawn relative to its parent`,
          `${pointer}/position`,
          source,
        );
        break;
      }
      parent = parent.parent;
    }
    const pose = poses[i]!;
    if (step.attrs.has("data-rotate-z") && step.attrs.has("data-rotate"))
      d.add(
        "ROTATE_ALIAS_CONFLICT",
        step.attrs.get("data-rotate-z")
          ? `Both data-rotate-z and data-rotate are set: data-rotate-z wins (z = ${pose.rotate.z}), as upstream`
          : `data-rotate-z is empty, so data-rotate applies (z = ${pose.rotate.z}), as upstream`,
        `${pointer}/rotation`,
        source,
      );
    const order = step.attrs.get("data-rotate-order");
    if (order !== undefined) {
      const valid = validateOrder(order);
      if (
        !/^[xyz]+$/.test(order) ||
        new Set(order).size !== order.length ||
        valid !== order
      )
        d.add(
          "ROTATE_ORDER_INVALID",
          `data-rotate-order="${order}" is read as "${valid}"`,
          `${pointer}/rotation`,
          source,
        );
      else if (valid.length < 3)
        d.add(
          "ROTATE_ORDER_PARTIAL",
          `data-rotate-order="${order}" applies only the ${[...valid].join(", ")} rotation(s), as upstream; the other angles are ignored`,
          `${pointer}/rotation`,
          source,
        );
    }
    let target: TargetPose | undefined;
    const values = [
      ...pose.translate,
      pose.rotate.x,
      pose.rotate.y,
      pose.rotate.z,
      pose.scale,
    ];
    if (!values.every(Number.isFinite)) {
      d.add(
        "STEP_TRANSFORM_INVALID",
        "A coordinate, angle or scale is not a finite number, so impress.js cannot apply the transform: the scene is placed at the origin without rotation",
        pointer,
        source,
      );
      target = { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 };
    } else {
      let scale = pose.scale;
      if (scale === 0) {
        d.add(
          "SCALE_INVALID",
          "data-scale=0 makes the step invisible and its camera undefined: scale 1 used",
          `${pointer}/scale`,
          source,
        );
        scale = 1;
      } else if (scale < 0)
        d.add(
          "SCALE_NEGATIVE",
          `data-scale=${scale} mirrors the step through its centre: converted to a half turn about Z with scale ${-scale}`,
          `${pointer}/rotation`,
          source,
        );
      if (Math.abs(scale) < 0.0001 || Math.abs(scale) > 10000) {
        const clamped =
          Math.sign(scale) * Math.min(10000, Math.max(0.0001, Math.abs(scale)));
        d.add(
          "SCALE_OUT_OF_RANGE",
          `data-scale=${scale} is outside 0.0001..10000: ${clamped} used`,
          `${pointer}/scale`,
          source,
        );
        scale = clamped;
      }
      const translate = pose.translate.map((v, axis) => {
        if (Math.abs(v) <= 1000000) return v;
        d.add(
          "POSITION_OUT_OF_RANGE",
          `Coordinate ${"xyz"[axis]}=${v} is outside ±1000000 and was clamped`,
          `${pointer}/position/${axis}`,
          source,
        );
        return Math.sign(v) * 1000000;
      }) as [number, number, number];
      target = targetPose({ ...pose, translate, scale });
      if (!target) {
        d.add(
          "STEP_TRANSFORM_INVALID",
          "The pose cannot be represented within the document ranges: the scene is placed at the origin",
          pointer,
          source,
        );
        target = { position: [0, 0, 0], rotation: [0, 0, 0], scale: 1 };
      }
    }
    // Size: inline width and height in px, otherwise the default framing.
    const inline = inlineSize(step.attrs.get("style"));
    let size: [number, number];
    let fixedCamera = false;
    if (inline) {
      size = inline;
      fixedCamera = true;
      d.add(
        "STEP_SIZE_INLINE",
        `Scene size ${inline[0]}×${inline[1]} from the inline style; its node keeps the impress.js framing with an explicit camera`,
        `${pointer}/size`,
        source,
      );
    } else {
      size = [viewport.width * FIT, viewport.height * FIT];
      d.once(
        "size-default",
        "STEP_SIZE_DEFAULT",
        `Step sizes come from CSS, which is not evaluated: scenes without an inline width and height in px are ${FIT * 100}% of the viewport (${size[0]}×${size[1]}), so that the camera frames them like impress.js`,
        "/scenes",
        source,
        "Resize the scenes in Studio where the content needs it",
      );
    }
    for (const name of PLUGIN_ATTRIBUTES)
      if (step.attrs.has(name))
        d.add(
          "PLUGIN_ATTRIBUTE_IGNORED",
          `${name} is read by an upstream plugin and is not converted: navigation follows document order`,
          pointer,
          source,
        );
    if (hasClass(step, "stop", quirks))
      d.add(
        "PLUGIN_ATTRIBUTE_IGNORED",
        "The stop class of the bundle (no next from this step) is not converted",
        pointer,
        source,
      );
    if (hasClass(step, "markdown", quirks))
      d.add(
        "MARKDOWN_NOT_RENDERED",
        "A markdown step is rendered by an upstream extra; its source is imported as text",
        pointer,
        source,
      );
    const nested = new Set(
      steps.filter((s) => s !== step && isInside(s, step)),
    );
    const content = convertStep(step, {
      quirks,
      nested,
      resources,
      diagnostics: d,
      pointer,
      step: name,
      newBlockId: () => `b${++blockCounter}`,
    });
    css.push(...content.css);
    let title = content.title;
    if (!title) {
      title = name;
      d.add(
        "TITLE_FROM_ID",
        "The step has no heading or text: its ID is the scene title",
        `${pointer}/title`,
        source,
      );
    }
    const id = sceneIds[i]!;
    scenes.push({
      id,
      title: words(title).slice(0, 500),
      position: target.position,
      rotation: target.rotation,
      scale: target.scale,
      size,
      visible: true,
      blocks: content.blocks,
      notes: content.notes,
      extensions: {
        [IMPORT_EXTENSION]: {
          version: "1.0.0",
          data: { stepId: name, index: i },
        },
      },
      parentId: null,
      layout: "flow",
      appearance: {
        ...defaultAppearance(),
        variant: "plain",
        titleVisible: false,
      },
    });
    const entry: ImportedStep = {
      index: i,
      stepId: name,
      sceneId: id,
      source: pose,
      ...(step.location ? { line: step.location.line } : {}),
    };
    if (skipped(step))
      d.add(
        "STEP_SKIPPED",
        "The skip class of the bundle leaves the step out of next and previous: the scene is not on the path",
        pointer,
        source,
      );
    else {
      entry.nodeId = id;
      nodes.push({
        id,
        sceneId: id,
        holdMs: 0,
        ...(fixedCamera
          ? {
              camera: {
                position: target.position,
                rotation: target.rotation,
                zoom: 1 / target.scale,
              },
            }
          : {}),
      });
    }
    imported.push(entry);
  });
  if (imported.some((s) => s.nodeId === undefined) && !nodes.length) {
    d.add(
      "IMPRESS_NO_STEPS",
      "Every step is skipped: there is nothing to present",
    );
    return failure(d.list);
  }
  // `goto` uses the duration of the step it moves to; after skipped steps the
  // skip plugin keeps the first skipped step's duration unless the landing
  // step sets its own data-transition-duration.
  const durations = new Map<string, number>();
  let skippedDuration: number | undefined;
  imported.forEach((s, i) => {
    const own = poses[i]!.transitionDuration;
    if (s.nodeId === undefined) {
      skippedDuration ??= own;
      return;
    }
    const attribute = Number(steps[i]!.attrs.get("data-transition-duration"));
    durations.set(
      s.sceneId,
      skippedDuration === undefined ||
        (!Number.isNaN(attribute) &&
          steps[i]!.attrs.has("data-transition-duration"))
        ? own
        : skippedDuration,
    );
    skippedDuration = undefined;
  });
  const edges: PathEdge[] = nodes.slice(1).map((node, i) => ({
    id: `e${i + 1}`,
    from: nodes[i]!.id,
    to: node.id,
    label: "",
    transition: {
      // `goto` uses the duration of the step it moves to.
      durationMs: duration(
        durations.get(node.sceneId)!,
        `/paths/0/edges/${i}/transition/durationMs`,
        `data-transition-duration of "${node.sceneId}"`,
      ),
      easing: "ease-in-out",
    },
  }));
  const titleElement = findFirst(
    parsed.root,
    (e) => e.tag === "title" && e.namespace === "html",
  );
  const documentTitle =
    words(titleElement ? textContent(titleElement) : "") ||
    scenes[0]?.title ||
    "Imported presentation";
  const language = (parsed.root.attrs.get("lang") ?? "").trim();
  const document: ProjectDocument = {
    schemaVersion: "1.3.0",
    id:
      options.documentId && ID.test(options.documentId)
        ? options.documentId
        : slug(documentTitle).toLowerCase() || "impress-import",
    metadata: {
      title: documentTitle.slice(0, 500),
      language: language.length >= 2 && language.length <= 64 ? language : "en",
    },
    settings: {
      viewport: { ...viewport, perspective },
      presentation: {
        fit: "contain",
        motion: "system",
        defaultTransition: {
          durationMs: defaultDuration,
          easing: "ease-in-out",
        },
      },
    },
    requiredCapabilities: ["linear"],
    scenes,
    assets: resources.assets,
    paths: [
      {
        id: "main",
        name: "impress.js order",
        startNodeId: nodes[0]?.id ?? null,
        nodes,
        edges,
      },
    ],
    defaultPathId: "main",
    extensions: {
      [IMPORT_EXTENSION]: {
        version: "1.0.0",
        data: {
          baseline: IMPRESS_BASELINE.version,
          commit: IMPRESS_BASELINE.commit,
          profile,
          rootId,
        },
      },
    },
    cameraTracks: [],
    cues: [],
    theme: defaultTheme(),
  };
  if (!language)
    d.add(
      "LANGUAGE_ASSUMED",
      'The HTML declares no lang: "en" is assumed',
      "/metadata/language",
    );
  updateCapabilities(document);
  const valid = validateDocument(document);
  if (!valid.ok) {
    d.add(
      "CANDIDATE_INVALID",
      "The converted document does not validate; this is a defect of the importer",
    );
    return failure([...d.list, ...valid.diagnostics]);
  }
  // Every scene must be framable by the core, as the player will do.
  for (const scene of valid.value.scenes)
    if (
      !getWorldMatrix(valid.value, scene.id).ok ||
      !resolveSceneCamera(valid.value, scene.id).ok
    ) {
      d.add("CANDIDATE_INVALID", `Scene ${scene.id} cannot be framed`);
      return failure(d.list);
    }
  return {
    ok: true,
    value: {
      document: valid.value,
      diagnostics: d.list,
      resources: resources.report,
      files: resources.files,
      steps: imported,
      profile,
      profileExplicit: options.profile !== undefined,
      baseline: IMPRESS_BASELINE,
      css,
    },
    diagnostics: d.list,
  };
}

function isInside(element: HtmlElement, ancestor: HtmlElement): boolean {
  for (let p = element.parent; p; p = p.parent) if (p === ancestor) return true;
  return false;
}
function hasStepInside(element: HtmlElement, steps: HtmlElement[]): boolean {
  return steps.some((s) => isInside(s, element));
}
/** Width and height in px from an inline style without box-model properties that change the border box. */
function inlineSize(style: string | undefined): [number, number] | undefined {
  if (!style) return undefined;
  const declarations = new Map<string, string>();
  for (const part of style.split(";")) {
    const at = part.indexOf(":");
    if (at < 0) continue;
    declarations.set(
      part.slice(0, at).trim().toLowerCase(),
      part
        .slice(at + 1)
        .replace(/!important/i, "")
        .trim()
        .toLowerCase(),
    );
  }
  if (
    [...declarations.keys()].some((k) =>
      /^(?:padding|border|box-sizing|min-|max-)/.test(k),
    )
  )
    return undefined;
  const px = (value: string | undefined) => {
    const m = value ? /^(\d+(?:\.\d+)?)px$/.exec(value) : null;
    const n = m ? Number(m[1]) : Number.NaN;
    return n >= 8 && n <= 100000 ? n : undefined;
  };
  const width = px(declarations.get("width")),
    height = px(declarations.get("height"));
  return width !== undefined && height !== undefined
    ? [width, height]
    : undefined;
}
export { localPath };
