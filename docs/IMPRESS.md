# impress.js import

XCursus imports presentations written for [impress.js](https://impress.js.org/) into a **candidate** project: steps become scenes on one path, their positions, rotations and scales are converted exactly, and everything that is not carried over is listed with a stable code. It is an essential import, not compatibility with impress.js: CSS, scripts, plugins and timing are reported, never reproduced. The candidate opens only after review.

The importer is the package [`@xcursus/impress-compat`](../packages/impress-compat/README.md); the command line (`xcursus convert impress`) and Studio (**Import impress.js**) both use it.

## Safety

The HTML is untrusted input and is only read as data.

- It is parsed with [parse5](https://github.com/inikulin/parse5) 8.0.1 into an inert tree: no script runs, no stylesheet applies, no element is rendered, nothing is fetched. `<template>` contents and `<noscript>` are not entered.
- Only local files referenced by relative paths inside the folder of the HTML file are read, and only by the caller: the command line reads them confined to that folder (no `..` above it, no absolute or encoded paths, no symbolic links); Studio uses the files the author chooses. Remote URLs, `data:` URLs and paths leaving the folder are reported and never loaded.
- Active content is never copied into the candidate: scripts, `on*` handlers, `javascript:`/`vbscript:`/`data:` links, frames, objects, forms, `meta`, `base`, `style` elements and attributes, SVG scripts, animations, `foreignObject` and external references are removed and diagnosed. The remaining markup keeps only what the XCursus sanitizer allows, and is sanitized again when rendered.
- Limits: 10 MiB of HTML, 500 000 nodes, nesting depth 512, 1000 steps, 50 MiB per resource and 200 MiB in total (command line). Larger inputs are refused, not truncated.

## Baseline and profiles

The mapping follows the **impress.js 2.0.0** release of the official repository: tag `v2.0.0`, commit `dc3cf69747e0b1b0d1fe534509d09c3c48030e68` (21 July 2022), MIT licence. The defaults (`data-width` 1920, `data-height` 1080, `data-perspective` 1000, `data-transition-duration` 1000) and the numeric rules (`Number()` coercion, a fallback only for `NaN`, `w` and `h` multiples of the configured size, `validateOrder`) are those of that tag. The `master` branch after it (July 2026: commit `b44b969`) changes plugins and documentation, not the core.

impress.js is distributed in two forms that read the same markup differently:

| Profile  | Upstream file                                                | Omitted coordinate                                                   | `data-rel-*`, `.skip`                  |
| -------- | ------------------------------------------------------------ | -------------------------------------------------------------------- | -------------------------------------- |
| `bundle` | `js/impress.js` of the release, with all the bundled plugins | the previous step's value, plus inherited `data-rel-*` offsets (rel) | relative offsets; skipped by next/prev |
| `core`   | `src/impress.js` alone                                       | `0`                                                                  | ignored                                |

Choose the profile explicitly (`--profile`, the Studio select, or `profile` in the API). Without a choice the importer assumes `bundle`, which most presentations load, and emits `PROFILE_AMBIGUOUS` listing the steps the two profiles would place differently.

## Mapping

| impress.js                                                                    | XCursus                                                                                                                                                                                                                                                            |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `.step` elements inside the root (`#impress`, or `rootId`), in document order | One scene each, in that order, all at the top level; one node each on the path `main`, edges in document order                                                                                                                                                     |
| `id`                                                                          | Scene and node ID when it matches `[A-Za-z0-9_-]{1,96}` and is unique; otherwise a derived ID (`STEP_ID_RENAMED`, `STEP_ID_DUPLICATE`). A step without ID is `step-N`, as impress.js names it. The original ID is kept in the scene extension `xcursus.impress`    |
| `data-x`, `data-y`, `data-z`                                                  | Scene position: the centre of the step, in CSS pixels                                                                                                                                                                                                              |
| `data-rotate-x/y/z`, `data-rotate` (alias of `-z`), `data-rotate-order`       | The rotation is composed as impress.js writes it (`rotateA(a) rotateB(b) rotateC(c)` in the source order, only the listed axes) and decomposed in the XCursus convention `Rz·Ry·Rx`. Euler angles are never copied between conventions                             |
| `data-scale`                                                                  | Positive uniform scale; a negative `scale(-s)` is a half turn about Z with scale `s` (exact for the flat step)                                                                                                                                                     |
| Root `data-width`, `data-height`                                              | Viewport; the window fit of impress.js and of XCursus is the same `contain`                                                                                                                                                                                        |
| Root `data-perspective`                                                       | Viewport perspective                                                                                                                                                                                                                                               |
| Root and step `data-transition-duration`                                      | Default transition and the duration of each edge (the duration of the step moved to), easing `ease-in-out`                                                                                                                                                         |
| The camera at a step (inverse of its transform, zoom `1 / scale`)             | The XCursus auto-fit camera: a scene of unknown size is 90 % of the viewport, so the auto-fit zoom is exactly `1 / scale`. A step whose inline style gives `width` and `height` in px keeps that size and gets an explicit node camera with the impress.js framing |
| Heading, then first text of the step                                          | Scene title (hidden: the content keeps its own heading); the step ID when there is no text                                                                                                                                                                         |
| Markup of the step                                                            | `html` blocks with the allowlisted elements and attributes; images, inline SVG, audio and video become their own blocks in reading order, splitting the markup around them                                                                                         |
| `.notes` (speaker console)                                                    | Private scene notes                                                                                                                                                                                                                                                |
| `.skip` (bundle)                                                              | The scene exists but is not on the path (the first step stays the start, as at `init`); edge durations follow the skip plugin                                                                                                                                      |

Scenes use the `plain` appearance (no card, transparent) so that, as in impress.js, the visible surface is the content. The document is validated at schema 1.3.0 before it is returned; capabilities are computed from what it uses.

### Coordinate conventions

Both systems use CSS pixels with X to the right, Y down and Z towards the viewer, and rotate about the centre of the step. impress.js writes `translate(-50%,-50%) translate3d(x,y,z) rotate… scale(s)` on each step and the inverse on the canvas; XCursus composes `T·Rz·Ry·Rx·S` once per scene ([specification §4](SPECIFICATION.md#4-geometry-camera-and-rendering)). The conversion composes the source matrix in double precision and decomposes it with the core (`decomposeSceneMatrix`), which verifies the reconstruction within 1e-6; gimbal-lock poses are handled there.

## What is reported, not converted

Every finding is an `ImportDiagnostic`: `{code, severity, pointer, message, hint?, source?}`, where `pointer` is a JSON Pointer into the candidate and `source` names the step and the line and column in the HTML. Errors return no candidate.

| Severity | Codes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| error    | `HTML_TOO_LARGE`, `HTML_TOO_DEEP`, `BASELINE_UNSUPPORTED`, `OPTIONS_INVALID`, `IMPRESS_ROOT_MISSING`, `IMPRESS_NO_STEPS`, `IMPRESS_TOO_MANY_STEPS`, `CANDIDATE_INVALID`                                                                                                                                                                                                                                                                                                                                                        |
| warning  | geometry: `PROFILE_AMBIGUOUS`, `STEP_TRANSFORM_INVALID`, `POSITION_OUT_OF_RANGE`, `SCALE_INVALID`, `SCALE_OUT_OF_RANGE`, `ROTATE_ORDER_INVALID`, `ROTATE_ORDER_PARTIAL`, `REL_POSITION_RELATIVE`, `REL_TO_INVALID`, `STEP_NESTED`, `STEP_OUTSIDE_ROOT`, `STEP_ID_RENAMED`, `STEP_ID_DUPLICATE`, `STEP_SIZE_DEFAULT`, `VIEWPORT_INVALID`, `PERSPECTIVE_INVALID`, `DURATION_INVALID`, `ROOT_CONTENT_IGNORED`                                                                                                                     |
| warning  | content and resources: `SCRIPT_REMOVED`, `CSS_NOT_CONVERTED`, `EVENT_HANDLER_REMOVED`, `ACTIVE_URL_REMOVED`, `FRAME_REMOVED`, `FORM_REMOVED`, `CANVAS_REMOVED`, `MATHML_NOT_CONVERTED`, `SVG_CONTENT_REMOVED`, `CONTENT_TRUNCATED`, `BLOCK_LIMIT`, `IMAGE_ALT_MISSING`, `MEDIA_LABEL_MISSING`, `PLUGIN_ATTRIBUTE_IGNORED`, `SUBSTEP_FLATTENED`, `MARKDOWN_NOT_RENDERED`, `RESOURCE_REMOTE`, `RESOURCE_DATA_URL`, `RESOURCE_OUTSIDE_ROOT`, `RESOURCE_MISSING`, `RESOURCE_INVALID`, `RESOURCE_UNSUPPORTED`, `STYLESHEET_IGNORED` |
| info     | `PERSPECTIVE_SCREEN_RELATIVE`, `TIMING_APPROXIMATE`, `NAVIGATION_WRAP_DROPPED`, `WINDOW_SCALE_LIMITS_IGNORED`, `STEP_ID_GENERATED`, `STEP_SKIPPED`, `STEP_SIZE_INLINE`, `SCALE_NEGATIVE`, `ROTATE_ALIAS_CONFLICT`, `TITLE_FROM_ID`, `LANGUAGE_ASSUMED`, `NOTES_IMPORTED`, `INLINE_STYLE_NOT_CONVERTED`, `LINK_DROPPED`, `INERT_REMOVED`, `ELEMENT_UNWRAPPED`, `ATTRIBUTES_DROPPED`, `SCRIPT_RESOURCE_IGNORED`                                                                                                                  |

The full list with severities is exported as `IMPORT_CODES`.

Declared differences, by design:

- **CSS is not evaluated.** Sizes, colours, fonts, `.step:not(.active)` effects, the `past`/`present`/`future` classes and selectors on `body` have no XCursus equivalent; the CSS text is kept in the report (`css`) for reference. Restyle with the document theme.
- **Step size** comes from CSS, so it is unknown: 90 % of the viewport unless the step has an inline `width` and `height` in px (without padding or border). Resize scenes in Studio where the content needs it.
- **Perspective**: impress.js keeps it constant in screen pixels, XCursus in presentation units; depth looks the same when the window has the configured size.
- **Timing**: durations are kept; the curve is not (impress.js uses CSS `ease-in-out` and delays the zoom by half the duration).
- **Navigation**: one linear path in document order. The wrap-around from the last step to the first, hash URLs, `data-goto*`, `.stop`, substeps and autoplay are not converted.
- **Nested steps** become separate scenes at their own coordinates, where the impress.js camera goes; impress.js draws them relative to their parent.
- **`data-rel-position="relative"`** (offsets along the previous step's rotated axes, with rounding to 0.01) is not reproduced: offsets are applied along the world axes and the step is reported.
- **Markdown steps** (`.markdown` of the extras) and MathML are imported as text or removed, and reported.

## Command line

```sh
pnpm xcursus convert impress deck.html --out deck.json --profile bundle
pnpm xcursus convert impress deck.html --out deck.xcursus
```

`--out` names a `.json` project, written with its assets at the paths it declares (next to the JSON), or a `.xcursus` archive. Next to every output the command writes `<out>.report.json`: input and output digests, baseline, profile and whether it was explicit, a summary, every step with its scene, node and line, every diagnostic and resource, the CSS that was not converted, and the limits of the conversion. Existing outputs (the project, its report, or a different file where an asset would go) are refused without `--overwrite`; the input is never replaced; a structural error writes nothing. Exit codes as for the other commands: 0 (warnings allowed), 1 not importable or invalid arguments, 3 write failure. `--root <id>` selects another root element.

## Studio

**Import impress.js** in the toolbar opens a dialog: choose the HTML file, optionally the images and media it uses (matched by file name, since a file picker gives no folders) and the impress.js build. **Convert** shows the candidate (scenes, nodes, assets), the resources that were not imported and every finding with its step and line. The open document does not change while you review. **Open candidate** replaces it only after the usual confirmation when there are unsaved changes, which are first written to local recovery. Save the candidate as JSON or as an archive to keep it.

## API

```ts
import { importImpress, createImpressAdapter } from "@xcursus/impress-compat";

const result = importImpress(html, { profile: "bundle", resources });
if (result.ok) {
  const { document, diagnostics, resources, files, steps, css } = result.value;
}
```

`importImpress(html, options)` returns `Result<ImportCandidate>` synchronously. Options: `baseline` (`"2.0.0"`), `profile`, `rootId`, `resources` (`ReadonlyMap<relativePath, Uint8Array>`), `matchBasename`, `documentId`. The candidate holds `document` (validated, schema 1.3.0), `diagnostics`, `resources` (every reference with its status: `asset`, `remote`, `data`, `outside`, `missing`, `invalid`, `unsupported`, `ignored`), `files` (asset bytes by asset ID), `steps` (original ID, scene, node, source pose, line), `profile`, `profileExplicit`, `baseline` and `css`. Callers verify the asset bytes again with their own pipeline before use (the command line uses the player's verifier and records SHA-256 digests).

`createImpressAdapter(player, document)` wraps a mounted XCursus player with the part of the impress.js API that has a defined meaning: `goto(indexOrId, durationMs?)` (a negative index counts from the end), `next()` and `prev()` in document order with wrap-around, as impress.js does (not the visit history of `player.prev()`), skipping steps that are not on the path. There is no `init`, `swipe` or `tear`, no `impress:*` events, no hash navigation and nothing on `window`. Unknown steps resolve with `{status: "error"}` and the code `IMPRESS_UNKNOWN_STEP`.

## How it is verified

- **Independent oracle** (`packages/impress-compat/test/oracle.ts`): builds the transform strings impress.js 2.0.0 writes for steps and canvas and evaluates them with its own CSS Transforms arithmetic. Unit tests compare every landmark (corners and centre) of every scene in world space and on screen, with the camera at every step, within 1e-6: 2D and 3D positions, every single-axis rotation, all six rotation orders, partial orders, gimbal lock, scales including negative ones, inline sizes, aliases, invalid and omitted values, the rel plugin (`data-rel-x/y/z`, `data-rel-rotate-*`, `data-rel-to`, `data-rel-reset`), the core profile, and the upstream examples.
- **The upstream engine as oracle** (`tests/e2e/impress.spec.ts`): the unmodified `js/impress.js` of the tag runs in Chromium, Firefox and WebKit on the upstream demo, the cube, the 3D rotations example and the XCursus example; the corners of every step on screen, at every step, are compared with the imported document drawn by the XCursus player and with the core projection.
- **Hostile input**: scripts, handlers, active URLs, frames, forms, SVG scripting and remote resources, with network APIs stubbed to fail: nothing runs, nothing is requested, nothing active reaches the document; the same in Studio with request logging.
- **Command line and Studio**: outputs, reports, overwrite refusal, confinement and symbolic links; review without touching the open document, confirmation, recovery of unsaved work, axe audit of the dialog.

Upstream fixtures are copied unmodified with their licence and provenance in `packages/impress-compat/test/fixtures/upstream/`; expected values are written from the markup and the upstream rules, never generated by the importer.
