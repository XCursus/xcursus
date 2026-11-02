# API and integration

XCursus is published as five ESM packages under the `@xcursus` scope. They are not on npm yet (see [DISTRIBUTION](DISTRIBUTION.md#packages)); inside this repository they resolve as workspace packages, and `pnpm pack` produces installable tarballs.

| Package            | Use it to                                                                                | Reference             |
| ------------------ | ---------------------------------------------------------------------------------------- | --------------------- |
| `@xcursus/core`    | Validate, migrate and serialize documents; geometry, navigation, layout and capture math | [Core](#core)         |
| `@xcursus/player`  | Mount a presentation in any page, without a framework                                    | [Player](#player)     |
| `@xcursus/plugins` | Rich and media renderers, sanitization, the `.xcursus` archive, the plugin SDK           | [PLUGINS](PLUGINS.md) |
| `@xcursus/editor`  | Embed the React editor behind XCursus Studio                                             | [Editor](#editor)     |
| `@xcursus/cli`     | Validate, pack and export projects from Node                                             | [CLI](#cli)           |

Every library ships `.d.ts` types; CSS is exported separately (`@xcursus/player/style.css`, `@xcursus/player/fonts.css`, `@xcursus/plugins/style.css`, `@xcursus/editor/style.css`). Importing the core has no browser side effect.

## Quick example

```ts
import { createPlayer } from "@xcursus/player";
import "@xcursus/player/style.css";
import project from "./project.json";

const container = document.querySelector<HTMLElement>("#presentation")!;
const player = createPlayer({ input: true, motion: "system" });
const unsubscribe = player.on("scenechange", ({ visit }) => {
  console.log(visit.nodeId);
});
const mounted = await player.mount(container, project);
if (!mounted.ok) console.error(mounted.diagnostics);
else {
  await player.next();
  await player.goTo({ pathId: "main", nodeId: "n3" }, { durationMs: 300 });
  await player.prev();
  await player.setPath("main");
}
unsubscribe();
player.destroy();
```

The container must have positive CSS dimensions; the player fits its viewport with `contain` and observes resizes. Mounting preserves the host's children and attributes; it adds a `tabindex` only when missing and restores it on destroy. A destroyed instance cannot be mounted again: create a new one. Mounting an active instance again is an error, not an implicit replacement. Invalid values at mount leave the host untouched.

Rich content (Markdown, HTML, SVG, LaTeX), media and embeds need the renderers of `@xcursus/plugins`; see [PLUGINS](PLUGINS.md) for the registry and the trust model.

## Results and diagnostics

Operations that can fail on data return a discriminated result instead of throwing: `{ok: true, value, diagnostics}` or `{ok: false, diagnostics}`. A `Diagnostic` is `{code, severity: "error" | "warning" | "info", pointer, message, hint?}`: `code` is stable, `pointer` is a JSON Pointer into the document, `message` is English text meant for people. Navigation methods return a `NavigationResult` instead (see [Player](#player)).

## Core

`@xcursus/core` has no DOM, React, file system, network, player or plugin dependency. Type checking of the core uses only the ES2022 library and the standard Node API types.

### Documents

- `validateDocument(input: unknown)` accepts a JSON object or JSON text and returns `Result<ProjectDocument>` with an independent copy at the current schema version, or diagnostics. Historical versions (1.0.0–1.2.0) are checked against their own schema and constraints, then migrated. It never mutates the input.
- `migrateDocument(input: unknown)` validates and migrates as a copy, without changing IDs, paths, text or extensions; it is idempotent on the current version.
- `serializeDocument(document)` returns `Result<string>`: sorted keys, arrays preserved, final newline; it rejects invalid input.
- `normalizedPath(path)` returns the canonical form of a relative asset path; an unsafe path does not survive normalization unchanged, which is how the archive reader and the CLI reject it.
- Generated types: `ProjectDocument`, `Scene`, `Block` (union of eleven block types), `Asset`, `ScenePath`, `PathNode`, `PathEdge`, `CameraTrack`, `Cue`, `Theme`, `Frame`, `BlockStyle` and the rest of the schema.

Validation applies the strict schema, finiteness (`NON_FINITE_NUMBER`, with a pointer), IDs and references, target visibility, reachable graphs, cycles only with explicit policies or conditions, byte and depth limits and safe relative asset paths. Unknown extensions are preserved as opaque JSON. `holdMs` is kept and does not trigger autoplay. Format details: [FILE_FORMAT](FILE_FORMAT.md).

### Geometry and camera

- `getWorldMatrix(document, sceneId)` returns `Result<number[]>`, a column-major 4×4 matrix composed through up to 32 parent levels.
- `resolveSceneCamera(document, sceneId)` returns `Result<CameraPose>`, the auto-fit framing of a scene.
- `reparentScene(document, sceneId, parentId, preserveWorld = true)` returns a validated copy or an error without mutation; `worldPositionToLocal` supports world-space dragging.
- `cameraPose` and `authoredCameraPose` convert between the JSON pose (`AuthoredCameraPose`, Euler angles in degrees) and the runtime pose (`CameraPose`, rotation as a quaternion `[x, y, z, w]`).
- `inspectCamera` reports points on or behind the perspective plane.
- `sampleTransition({from, to, durationMs, easing}, elapsedMs)` returns `{camera, progress}`; it is pure, and invalid numeric arguments throw a `RangeError`.
- `resolveEdgePlan`, `resolveCameraTrack` and `sampleCameraTrack` resolve and sample camera tracks; the track's first keyframe is replaced at run time by the actual visual pose, without mutating the document.

Conventions (CSS units, X right, Y down, Z towards the viewer, `M = T·Rz·Ry·Rx·S`, central pivot) are specified in [SPECIFICATION §4](SPECIFICATION.md#4-geometry-camera-and-rendering).

### Layout

Frame functions work in the local pixel space of the scene's content rectangle and are shared by the player and the editor: `frameMatrix(frame)` (2D CSS matrix), `frameToScene` / `sceneToFrame` (round trip within 1e-9), `frameCenter`, `frameCorners`, `frameBounds`, `framesIntersect` (separating axes), `clampFrame`, `moveFrame`, `adjustFrame` / `resizeFrame` (opposite edge fixed), `rotateFrame`, `alignFrames`, `distributeFrames`, `stackFrames`, `snapToGrid`. `sceneToWorld`, `projectScenePoint` and `unprojectScenePoint` connect scene points to the viewport with the player's camera and perspective.

`defaultTheme()` and `defaultAppearance()` return the defaults written by the 1.2.0 → 1.3.0 migration; `usesLayout(document)` tells whether the `layout` capability is required. `contrastRatio`, `contrastIssues` and `contrastDiagnostics` report `LOW_CONTRAST` warnings (4.5:1 for text, 3:1 for components) without correcting colours.

### Capture

- `validateItinerary(document, input)` validates `{pathId, visits: [{nodeId, edgeIdToNext?}]}` (an object or JSON text, at most 500 visits) and fills in unique edges. Codes: `ITINERARY_*`, `UNKNOWN_PATH`, `UNKNOWN_NODE`, `NOT_ADJACENT`, `EDGE_AMBIGUOUS`, `EDGE_MISMATCH`, `EDGE_AFTER_LAST`, `VISIT_LIMIT`.
- `firstPassItinerary(document, pathId?)` proposes an itinerary for a path (the default path when omitted): from the start node it follows the only edge of each node and stops before a node already visited (`stoppedBefore`). A node with several edges fails with `ITINERARY_BRANCH`: the branch is the author's choice. The result is validated with `validateItinerary`.
- `planCapture(document, itinerary, {reducedMotion})` returns a `CapturePlan`: per visit the arrival time, hold, arrival pose and the transition to the next visit, plus `totalMs`. Reduced motion is fixed in the plan.
- `sampleCapture(plan, t)` is the pure sampler; `frameSchedule(plan, fps)` computes `N = ceil(totalMs·fps/1000)` frames at `frameTime(i) = i·1000/fps` and whether the final hold contains a frame.
- `publicDocument(document)` returns a copy without private notes; renderers, exports and the audience window only ever see this copy.

### Navigation machine

`NavigationMachine` (used by the player) holds the visit history of a path; `peek()` and `getChoices()` expose the next state without per-frame copies. Most integrations use the player methods instead.

## Player

```ts
createPlayer(options?: PlayerOptions): Player
```

### Options

| Option           | Type                               | Purpose                                                                                                 |
| ---------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `input`          | `boolean`                          | Keyboard navigation on the focused container                                                            |
| `keymap`         | `Record<string, "next" \| "prev">` | Replaces the default key map                                                                            |
| `motion`         | `"system" \| "reduced"`            | The system preference always wins when it asks for reduced motion                                       |
| `clock`          | `PlayerClock`                      | `now()`, `request(callback)`, `cancel(id)`; defaults to `performance.now` and `requestAnimationFrame`   |
| `onError`        | `(diagnostic) => void`             | Errors of handlers and renderers                                                                        |
| `registry`       | `RendererRegistry`                 | Content renderers; without it only text blocks render                                                   |
| `assets`         | `AssetResolver`                    | Resolves asset IDs to leased URLs (`createAssetResolver(assets, blobs)`)                                |
| `muted`          | `boolean`                          | Mutes media (previews)                                                                                  |
| `onContentEvent` | `(name, payload) => void`          | Namespaced events emitted by renderers and plugins                                                      |
| `messages`       | `Partial<PlayerMessages>`          | Replaces any interface text; `defaultMessages` (English) and `italianMessages` are exported             |
| `controls`       | `boolean`                          | `false` hides controls and choices (capture and print pages)                                            |
| `delegate`       | `(request) => void`                | Receives navigation requests from the player's own controls instead of executing them (audience window) |

`NavigationOptions` accepts an integer `durationMs` between 0 and 60 000 and an `AbortSignal`-compatible `signal`.

### Methods

| Method                              | Result                                                                                                                                                                        |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mount(container, document)`        | `Promise<Result<void>>`; the first node is shown without animation, `ready` fires before resolution                                                                           |
| `goTo({pathId?, nodeId}, options?)` | `Promise<NavigationResult>`; node IDs identify a visit even when several nodes show the same scene                                                                            |
| `next({edgeId?}?)`, `prev()`        | Navigation from the last completed visit; `prev` follows the actual history                                                                                                   |
| `setPath(pathId)`                   | Selects the start immediately and clears the history; an empty path leads to the empty state                                                                                  |
| `setView("scene" \| "overview")`    | `Result<void>`; overview frames the visible world, scene restores the visit's recorded pose                                                                                   |
| `setCamera(pose)`                   | `Result<void>`; validates, interrupts motion, adds no visit                                                                                                                   |
| `updateDocument(document)`          | `Promise<Result<void>>`; validates first, cancels the transition, keeps the current node when it still exists and clears the history; rebuilds only changed scenes and blocks |
| `renderAt(plan, elapsedMs)`         | `Promise<Result<void>>`; renders a capture sample without touching history, events, cues or media, then waits for renderers, fonts and two paints                             |
| `getState()`                        | Independent snapshot: status, view, path/node/scene, history, camera, transition, choices, diagnostics                                                                        |
| `on(event, handler)`                | Returns an unsubscribe function; throwing handlers are isolated and reported as `HANDLER_ERROR`                                                                               |
| `destroy()`                         | Idempotent; cancels pending work, emits `destroy` and removes every owned resource                                                                                            |

`NavigationResult.status` is `completed`, `noop`, `cancelled`, `choice-required` or `error`. `choice-required` carries labelled choices and the reasons any of them is disabled. Error codes include `UNKNOWN_NODE`, `UNKNOWN_PATH`, `UNKNOWN_EDGE`, `INVALID_DURATION`, `VISIT_LIMIT`, `PLAYER_UNMOUNTED`, `PLAYER_DESTROYED`, `CAPTURE_PLAN_MISMATCH` and `CAPTURE_BUSY`. Navigation never rejects its promise on an operational error.

### Events

`ready`, `navigationstart`, `navigationcancel`, `scenechange`, `navigationend`, `choice`, `cue`, `documentchange`, `mediaerror`, `diagnostic` and `destroy`, typed and local to the instance, with `instanceId` and `transitionId` where relevant.

Order of a navigation: any `navigationcancel` of the replaced plan, `navigationstart` of the new one, then at commit `scenechange` and `navigationend`, then the `completed` result. A cancelled destination never enters the history; noops and invalid commands do not interrupt a valid plan; ten rapid `next()` calls always target the successor of the last completed visit. `cue` (`{instanceId, transitionId, cue: {id, edgeId, atMs, event, payload}}`) fires once per transition when the threshold is crossed forwards and never executes its payload. `mediaerror` is `{instanceId, sceneId, blockId, assetId?, diagnostic}`.

### Keyboard, focus and accessibility

Arrows, Page Up, Page Down and Space act only on the focused container and its content; inputs, text areas, selects, contenteditable, media and interactive controls are not intercepted. Keyboard and outline navigation move focus to the target when it completes; mounting never steals focus. Inactive scenes are `inert` and `aria-hidden`. The text view exposes the path once and navigates without motion; it is also the fallback when CSS 3D is unavailable. The root receives `metadata.language` as `lang`.

### Theming hooks

The document theme becomes custom properties on the `.xc-player` root (`--xc-text`, `--xc-background`, `--xc-accent`, `--xc-backdrop`, `--xc-font-body`, `--xc-font-heading`, `--xc-size-body`, `--xc-size-title`), set through the CSSOM from validated values. Scenes and blocks receive classes from a closed list (`xc-layout-canvas`, `xc-variant-plain`, `xc-title-hidden`, `xc-framed`, `xc-align-*`, `xc-valign-*`, `xc-size-*`); the player controls can be restyled through `.xc-access`. `@xcursus/player/fonts.css` declares the bundled Atkinson Hyperlegible family (`XCursus Atkinson Hyperlegible`); without it the system stack is used.

### Presenter protocol

`@xcursus/player/presenter` implements the presenter/audience protocol `xcursus-presenter/1`: `parsePresenterMessage` (closed schema, 128-bit session, epoch per page load, increasing sequence, note-free snapshots), `connectPublic` (audience window), `createPresenterSession` (presenter console), `publicWindowName` and `randomToken`. Behaviour is described in [DISTRIBUTION](DISTRIBUTION.md#presenter-view-studio).

### Classic script build

`@xcursus/player/iife` (`dist/iife/xcursus-player.iife.js`, with `dist/iife/player.css` and `THIRD_PARTY_NOTICES.txt`) exposes the same API as the global `XCursus` for pages without a bundler.

## Editor

`@xcursus/editor` is the React editor behind XCursus Studio. React and React DOM `^19.3.1` are peer dependencies; core and player never depend on React. The public API is delimited in `packages/editor/src/index.ts`:

- `Studio` (`StudioProps`: optional `store`, `repository`, host-approved `plugins`, `onPlayer(player, present)` and `exportHtml`), with `@xcursus/editor/style.css`. `exportHtml` is an `HtmlExporter`: `(request: {document, blobs, lang, allowPartial}) => Promise<HtmlExportResult>`, either `{ok: true, html, status, warnings}` or `{ok: false, diagnostics}`. The Export panel calls it for the standalone HTML; without it the panel shows the command line instead. The Studio app passes the CLI's pipeline (below).
- `EditorStore`: `getSnapshot()` returns a frozen document and session, `subscribe` works with `useSyncExternalStore`, `execute(edit, selectNew?)` clones, applies and validates before committing. Undo and redo keep up to **100 commands or 20 MiB** of UTF-8 snapshots. `beginDrag` / `beginGesture`, `previewGesture`, `endDrag` and `cancelDrag` turn a gesture into one command; `coalesce(key, edit)` and `endCoalesce()` merge a typing session into one command.
- Commands applied through the store: `createScene`, `editScene`, `deleteScene` (with `deleteImpact` for the confirmation preview), `reparent`, `createPath`, `editPath`, `deletePath`, `createNode`, `editNode`, `connectNodes`, `editEdge`, `removeGraphItem`, `setFrames`, `setBlockStyle`, `setAppearance`, `convertToCanvas`, `convertToFlow`, `moveInReadingOrder` and `editTheme`; `emptyProject()` creates a new document.
- Persistence: `RecoveryRepository` (IndexedDB database `DATABASE_NAME`, schema `DATABASE_VERSION` 3), `Autosave`, `StorageConflict` and `StorageVersionError`. Reading and writing project files uses `@xcursus/plugins/archive` ([FILE_FORMAT](FILE_FORMAT.md)).

Studio exposes a debug handle `window.studio` (store, repository and player references) only with the development server, or in a production build when the URL contains `?studio-debug`.

## CLI

The `xcursus` binary is documented in [DISTRIBUTION](DISTRIBUTION.md). Programmatic use:

```ts
import { run, EXIT } from "@xcursus/cli";

const code = await run(["validate", "deck.xcursus", "--json"], {
  out: (text) => process.stdout.write(text + "\n"),
  log: (text) => process.stdout.write(text + "\n"),
  warn: (text) => process.stderr.write(text + "\n"),
});
```

`run` never calls `process.exit`; it returns the exit code (`EXIT.ok` 0, `EXIT.data` 1, `EXIT.environment` 2, `EXIT.output` 3). The `ExportManifest` type describes the manifest written next to every export.
