# XCursus specification

This document is the normative contract of XCursus: the document model, the behaviour of the player, Studio, the command line and the exports, and the security, accessibility and quality requirements they must meet. MUST, MUST NOT and MAY denote a requirement, a prohibition and an option. Features marked **planned** are part of the roadmap and are not implemented yet. A change to this contract updates the specification, the [roadmap](ROADMAP.md), the schemas and the migrations together, never silently.

Related documents: [ARCHITECTURE](ARCHITECTURE.md) (structure and design decisions), [API](API.md), [FILE_FORMAT](FILE_FORMAT.md), [DISTRIBUTION](DISTRIBUTION.md), [PLUGINS](PLUGINS.md), [VERIFICATION](VERIFICATION.md).

## 1. Scope

XCursus is an open-source, local-first platform for spatial, non-linear multimedia presentations. A TypeScript library and a visual editor, XCursus Studio, read the same document and use the same player. The published player includes neither the editor nor React. Core features, examples and local projects need no account, backend or remote service; installing dependencies and test browsers may need a network.

A scene is a rectangle placed in a bounded 3D space, not a slide that fills the screen: it can be small, rotated, nested or part of an overview.

### Use cases

1. A developer mounts a presentation in an HTML page without React, with custom controls and two independent instances.
2. A teacher builds three scenes in Studio, saves and reopens the file and finds identical content, transforms and path.
3. A researcher chooses a deep dive during a talk and returns with `prev()` to the visit actually made before.
4. An author integrates local audio, video and declarative cues; starting playback asks for the browser's media consent when needed.
5. A presenter delivers an offline HTML and a PDF of an explicit itinerary; a minimal video is a verified output with declared limits.

### Non-goals for 1.0

Collaborative cloud editing, authentication, a multi-user backend, CAD, a full PowerPoint replacement, arbitrary offline execution of web content, universal fidelity to impress.js plugins, a WebGL renderer, 3D editing with a full gizmo, professional real-time audio or guaranteed hardware sync. No mandatory analytics or telemetry.

## 2. Architecture constraints

The packages and their responsibilities are described in [ARCHITECTURE](ARCHITECTURE.md). Normative constraints:

- Every library is ESM with explicit `exports`, `.d.ts` types and separately exported CSS; importing the core has no browser side effect.
- `core` imports no DOM, React, file system, network, player or plugin. The player imports neither plugins nor the editor. React and React DOM are peers of the editor only. Optional packages never enter the default bundle. An automated check enforces these rules.
- No empty placeholder packages are created to simulate future deliverables.

### Toolchain

Exact pins, a committed `pnpm-lock.yaml` and `pnpm install --frozen-lockfile` in CI. Peer errors are never silenced with forcing flags. Nx, Turborepo, application servers or containers are not prerequisites.

| Tool                                        | Version                          | Notes                                                                             |
| ------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------- |
| Node.js                                     | 24.22.0                          | `engines.node: ">=24"` in the packages                                            |
| pnpm                                        | 12.14.0                          | `packageManager` field                                                            |
| TypeScript                                  | 6.0.3                            | `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`                |
| Vite / `@vitejs/plugin-react`               | 8.3.5 / 6.1.2                    | Apps and library mode                                                             |
| Vitest / `@vitest/coverage-v8`              | 5.0.5 / 5.0.5                    | Unit tests and coverage                                                           |
| `@playwright/test`                          | 1.64.1                           | Main E2E runner and Linux CI; `playwright-core` 1.64.1 drives Chromium in the CLI |
| `@playwright/test` (macOS 14 WebKit runner) | 1.61.1                           | Private workspace `tools/webkit-macos14`, WebKit on Darwin 23 only                |
| ESLint / `@eslint/js` / `typescript-eslint` | 10.13.0 / 10.0.1 / 8.72.0        | Flat config                                                                       |
| Prettier                                    | 3.9.10                           | Single formatter                                                                  |
| React / React DOM                           | 19.3.1                           | Editor and Studio only                                                            |
| Ajv                                         | 8.20.0                           | Standalone validators generated at build time                                     |
| gl-matrix                                   | 3.4.4                            | Matrices and quaternions                                                          |
| DOMPurify / marked / KaTeX / fflate         | 3.4.17 / 18.1.1 / 0.19.0 / 0.8.3 | Sanitization, Markdown, formulas, archive                                         |
| pdf-lib                                     | 1.17.1                           | CLI, merging PDF pages                                                            |
| parse5                                      | 8.0.1                            | **Planned**: inert HTML parsing for the impress.js importer                       |

## 3. Document, versions and contracts

### Identity and state separation

`ProjectDocument` is pure JSON. Functions, dates, DOM nodes, temporary URLs, Blobs, stores, selection and run-time history are forbidden. IDs match `[A-Za-z0-9_-]{1,96}` and are unique within their namespace; references are explicit IDs, never array indexes. Scene order is the base editor and outline order; block order is the DOM and reading order; presentation order is the chosen path.

`PlayerState` (current visit, history, camera, transition), `EditorSession` (selection, map viewport, undo/redo, dirty state) and `ExportManifest` (resources, limitations and checks of an output) are never serialized into the document. Unknown extensions are preserved as JSON and never executed; unknown content becomes a placeholder with a diagnostic.

### Versions and capabilities

| Product       | `schemaVersion` | Capabilities it introduces | Change                                                                        |
| ------------- | --------------- | -------------------------- | ----------------------------------------------------------------------------- |
| 0.1, 0.2      | `1.0.0`         | `linear`                   | Flat scenes, text, a linear path expressed with nodes and edges               |
| 0.3           | `1.1.0`         | `structure`                | Parents, graphs, camera tracks and time cues                                  |
| 0.4, 0.4.1    | `1.2.0`         | `blocks`                   | New block types, plugin configuration and media                               |
| 0.5 and later | `1.3.0`         | `layout`                   | Block frames in canvas scenes, document theme, scene appearance, token styles |

`requiredCapabilities` lists the capabilities a document actually uses. A reader accepts only versions for which it has a schema and a migration; a future minor version is not implicitly readable. Opening an unsupported version or capability is refused without changes. Missing plugins instead get placeholders and their data is kept entirely.

`migrateDocument(input)` returns a new copy and diagnostics, applying `1.0.0 → 1.1.0 → 1.2.0 → 1.3.0` with validation before and after. It never rewrites files or alters the original, never downgrades and never loses data. The individual steps are listed in [FILE_FORMAT](FILE_FORMAT.md#migration). Historical fixtures stay in the repository and MUST open in the current version with unchanged rendering.

### Schemas

The JSON Schemas (draft 2020-12) in `packages/core/schema/project-<version>.schema.json` are the structural contract of each version; every object has `additionalProperties: false` except opaque extension, cue and plugin data. TypeScript types are generated from the current schema, so the schema and the types cannot diverge. Validators are generated as standalone code at build time: no schema is compiled with dynamic code generation at run time, and no `$ref` is loaded remotely.

### Semantic rules of 1.0.0

Beyond the schema: finite numbers (also through the API), unique IDs, existing references, safe asset paths and cumulative limits. In `1.0.0` every path is a single chain reachable from its start, without cycles, with at most one entry and one exit per node; the first node has no entries. The scene of every node exists and is effectively visible. Node and edge IDs are unique within the path; blocks within the scene; scenes, paths, assets, tracks and cues within their collections. An empty path has `startNodeId: null`; a document without paths has `defaultPathId: null`; a non-null default identifies an existing path. Without a default path the player mounts in the empty state and allows `setPath`. `holdMs` is serialized but ignored by manual navigation: it is not autoplay. World poses composed through parents are checked for finiteness and range too.

### Extensions of 1.1.0 — structure

| Entity      | Added fields and rules                                                                                                                         |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Scene       | `parentId: ID \| null`; chains of at most 32; self-parents, cycles and missing parents forbidden                                               |
| Document    | `cameraTracks` (≤ 1000) and `cues` (≤ 10 000)                                                                                                  |
| Node        | `camera?: CameraPose`, a world pose independent of the target scene                                                                            |
| Edge        | `cameraTrackId?`, `condition?: {kind: "manual"} \| {kind: "visit-limit", maxVisits: 1..1000}`                                                  |
| Path        | `loopPolicy?: {maxVisitsPerNode: 1..1000}`, mandatory if the graph has cycles; every connection of a cycle needs an explicit condition         |
| CameraPose  | `{position, rotation, zoom: 0.0001..10000}` in world space, rotations in degrees                                                               |
| CameraTrack | `{id, keyframes: [{at: 0..1, pose}], interpolation: "linear" \| "cubic", easing}`; 2–200 keyframes, first at 0, last at 1, strictly increasing |
| Cue         | `{id, edgeId, atMs: 0..60000, event, payload}`; namespaced declarative event, time within the edge duration                                    |

Branching paths require the `structure` capability. Spatial hierarchy and navigation graph are independent: being a child does not imply being the next stop. A `manual` edge needs an explicit edge choice even when it is the only exit, so `next()` without a choice returns `choice-required`. `visit-limit.maxVisits` and `loopPolicy.maxVisitsPerNode` count the completed visits to the destination node in the current history; once a limit is reached the edge is disabled with a reason. `prev()` does not consume an entry and restores the previous visit with its recorded pose. Limits never prevent stopping or changing path. No condition uses `eval` or JavaScript expressions.

### Extensions of 1.2.0 — content

Every block is `{id, type, data}`; builtin `data` objects reject undefined fields.

| `type`     | `data`                                                                                                    |
| ---------- | --------------------------------------------------------------------------------------------------------- |
| `text`     | `{text}`, unchanged since 1.0.0                                                                           |
| `markdown` | `{source}`; the resulting HTML is always sanitized                                                        |
| `html`     | `{source}`; source kept, sanitized view                                                                   |
| `svg`      | `{source, alt}`; sanitized, without external references                                                   |
| `latex`    | `{source, display, alt}`; KaTeX without trust and with expansion limits                                   |
| `image`    | `{assetId, alt, fit: "contain" \| "cover"}`                                                               |
| `audio`    | `{assetId, label, autoplay, loop, onExit: "pause" \| "stop"}`                                             |
| `video`    | Audio fields plus `{alt, posterAssetId?, captionsAssetId?}`; local WebVTT captions                        |
| `link`     | `{label, target: {pathId, nodeId}}`; navigation through the API, never an HTML handler                    |
| `embed`    | `{url, title}`; HTTPS only, explicit consent and an authorized origin                                     |
| `plugin`   | `{pluginId, apiVersion: "1.0.0", dataVersion, payload}`; validated by the registered plugin's data schema |

Sources are at most 100 000 characters; labels and alternative texts at most 2000. The optional `pluginSettings: Record<pluginId, {apiVersion, dataVersion, data}>` uses namespaced keys. A block outside the union is a schema error; extensibility goes through `type: "plugin"`. A missing or incompatible plugin is never loaded from a URL: it shows a placeholder and its data round-trips.

### Extensions of 1.3.0 — layout

| Entity   | Added fields and rules                                                                                                                                                                                                                                     |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document | `theme`, mandatory; the migration writes the default theme that reproduces the 1.2.0 rendering                                                                                                                                                             |
| Theme    | `{palette: [{id, value: "#rrggbb"}] (1–32, unique IDs), colors: {text, background, accent, backdrop}, fonts: {body, heading}, typeScale: {body: 8..200, title: 8..400}}`                                                                                   |
| FontId   | Closed list of local fonts with a recorded licence: `system-sans`, `system-serif`, `system-mono`, `atkinson-hyperlegible`                                                                                                                                  |
| Scene    | `layout: "flow" \| "canvas"`; `appearance: {variant: "card" \| "plain", background: PaletteId \| null, titleVisible}`                                                                                                                                      |
| Block    | `frame?`; `style?: {align?, verticalAlign?, size?: "xs".."xxl", color?: PaletteId}`                                                                                                                                                                        |
| Frame    | `{x, y, width, height, rotation, z}` in local pixels of the content rectangle, origin at the top left; `x, y ≥ 0`; `width, height ≥ 8`; `x + width ≤ size[0]`; `y + height ≤ size[1]`; rotation −360..360 around the frame centre; integer `z` −1000..1000 |

In `flow` scenes blocks MUST NOT have a frame; in `canvas` scenes every block MUST have one. Frames outside the rectangle, non-finite numbers and unknown palette IDs are structural errors. Array order remains the reading, DOM, Tab and outline order; `z` governs only visual stacking, ties resolved by array order. No style field is CSS: tokens are applied as allowlisted classes and CSSOM properties. Colours are lowercase `#rrggbb` only.

`layout` is required when a scene is canvas, a block has a style, an appearance differs from the default or the theme differs from the default. The `1.2.0 → 1.3.0` migration writes the default theme (text `#172035`, background `#ffffff`, accent `#215baf`, backdrop `#e8edf4`, `system-sans`, body 28, title 46), `layout: "flow"` and the default appearance, without enabling `layout`; the rendering of migrated documents MUST stay identical.

Canvas content is clipped to the scene rectangle on the content wrapper, never on the `preserve-3d` wrappers. Overflowing text stays clipped with an editorial diagnostic. `titleVisible: false` removes the title from the spatial view but keeps it as the scene's accessible name and in the outline. Palette contrast below 4.5:1 (text) or 3:1 (components) produces a warning; colours are never corrected silently. Block groups, scene templates and per-element animations are outside 1.3.0.

### Errors, diagnostics and limits

`Diagnostic = {code, severity, pointer, message, hint?}` with a stable code and a JSON Pointer. Operations return `{ok: true, value, diagnostics}` or `{ok: false, diagnostics}`; navigation uses `NavigationResult` (section 5).

- Unreadable JSON, an unknown version, non-finite numbers or missing structural references: an error, and the current document is not replaced.
- Zero scenes or paths, or an empty path: a valid authoring document; the player mounts in the empty state with disabled controls.
- A declared asset whose file is missing, an unsupported codec or a missing plugin: a warning and an accessible placeholder. An `assetId` absent from the asset registry is a structural error. A strict export fails when its format requirement is not met.
- A scene made invisible while still referenced: the change is refused, or an atomic command removes it from the paths after a concrete confirmation; stops are never skipped silently.
- Defensive limits: 10 MiB of UTF-8 JSON, depth 64, 1000 scenes, 100 blocks per scene, 2000 assets, 50 MiB per file, 200 MiB uncompressed in total, 10 000 archive entries with limits applied after decompression. Traversal, symbolic links and duplicate normalized names are rejected. These are safety limits, not performance guarantees.

## 4. Geometry, camera and rendering

### Conventions

Units are logical CSS pixels at zoom 1, degrees for the author and milliseconds for time. X points right, Y down, Z towards the viewer; the origin is the centre of space. The viewport has the aspect ratio `viewport.width / viewport.height` (default 1280×720) and is letterboxed with `contain`.

Homogeneous column vectors and column-major 4×4 matrices; a single `matrix3d` conversion in the player. `rotation: [rx, ry, rz]` means `Rz(rz)·Ry(ry)·Rx(rx)`. `Mlocal = T(position)·Rz·Ry·Rx·S(scale)` with a positive uniform scale. The pivot is the centre of the scene; the content rectangle spans `[-w/2, -h/2]` to `[w/2, h/2]`. `Mworld(scene) = Mworld(parent)·Mlocal(scene)`; effective visibility is the conjunction of the scene and its parents. Reparenting preserves the world pose with `inverse(MparentNew)·MworldOld`; a non-invertible or out-of-range result refuses the command with no partial mutation.

Euler angles are the authoring representation; the core composes and interpolates normalized quaternions (short-arc slerp, q/−q handling) and never interpolates matrix elements. Entered degrees are kept as entered; a turn beyond 180° needs intermediate keyframes.

Block frames (1.3.0) are local 2D geometry: they do not enter `Mworld` and introduce no second pivot. Editor and player use the same core functions to convert between frame and scene coordinates.

### Camera

`CameraPose.position` is the world point at the centre of the framing plane, `rotation` orients that plane and `zoom` is magnification. `C = T(position)·Rz·Ry·Rx`; `V = S(zoom)·inverse(C)`. The player applies `P(perspective)·V·Mworld`, a translation to the viewport centre and an outer fit scale `min(containerWidth / viewport.width, containerHeight / viewport.height)`, with a single perspective and `perspective-origin` at the centre.

`resolveSceneCamera(document, sceneId)` aligns the camera with the scene's world rotation and sets `zoom = 0.9 · min(viewportWidth / sceneWidth, viewportHeight / sceneHeight) / worldScale`. `node.camera` and track endpoints are world poses independent of the target; a track endpoint different from the auto-fit produces no final snap. An edge without a track interpolates the current camera towards `node.camera` or the scene fit.

At run time the track's `at = 0` keyframe is replaced by the current visual pose, so an interruption causes no jump; scrubbing and export use the same resolved plan. Points on or behind the perspective plane are reported in the editor and remain reachable through the outline. Overview, pan and zoom are temporary inspection poses that are never saved.

### Time and rendering

The core exposes pure sampling from monotonic time; the player uses `requestAnimationFrame` as its clock. `linear(t) = t`, `ease-in-out(t) = 3t² − 2t³`. Position is linear (or Catmull-Rom on tracks, with duplicated ends), rotation is slerp, zoom is interpolated in log space. A track applies its own easing once; the edge easing is used only without a track.

Transitions are frozen in hidden tabs and resume without skipping cues. Cues fire once per transition, only when the threshold is crossed forwards; cancellation suppresses future cues. Zero duration runs cues once in `(atMs, id)` order. `prefers-reduced-motion: reduce` or the `reduced` setting forces zero durations while keeping destination, history and events; an author cannot force animation against the user's preference.

Content is native, selectable DOM; no canvas or WebGL for text. Inactive scenes stay visible where intended but are `inert` and `aria-hidden`. An accessible linear outline shows sanitized content and navigation in the order of the chosen path. Wrappers avoid properties that flatten `preserve-3d` (`filter`, group opacity, overflow).

## 5. Public API and navigation machine

The API surface is listed in [API](API.md). Behavioural contract:

- `mount` resolves after `ready`; mounting an active instance again is an error. `destroy` is idempotent, cancels pending work, emits `destroy`, releases every owned resource (rAF, observers, listeners, Blob URLs, DOM) and restores the host attributes it touched; afterwards commands return `PLAYER_DESTROYED` while `getState` and `destroy` stay allowed.
- Operational errors resolve with an outcome; promises never reject on navigation errors. A throwing user handler is isolated and reported.
- `getState()` returns a read-only snapshot with no reference into the engine.

### History, concurrency and focus

- The initial visit is a history record with a unique `visitId`, path, node, scene and final camera pose; repeated scenes have distinct visits.
- Destination and history are committed **only when the transition completes**. A later valid command cancels the current one and restarts from the visual pose sampled at that instant (latest wins, no hidden queue). An invalid command does not cancel a valid one in progress. Repeated `next()` during a transition refers to the last completed node.
- `navigationcancel` and the `cancelled` result happen once; a cancelled destination never enters the history. An `AbortSignal` freezes the current pose and keeps the last completed visit.
- `prev()` uses the actual history: after A→B→D it returns to B whatever the array order. Without a predecessor it is a noop.
- `next()` with several eligible edges and no `edgeId` returns `choice-required` without moving; there is no implicit selection by array order. No edge at the end of a path is a noop.
- `goTo` adds a visit; switching path clears the history like `setPath`. `goTo` to the current node is a noop; an explicit loop edge creates a new visit to the same node. `setView` and `setCamera` interrupt motion without adding visits.
- `updateDocument` validates first, cancels the transition and replaces atomically; the current node is kept when it still exists, otherwise the start is selected, and the history is cleared down to the resulting visit. The update is incremental (only changed scenes and blocks are rebuilt, unchanged assets are not resolved or hashed again) with the observable result of an atomic replacement.

Event order of a navigation: any `navigationcancel` of the replaced plan, `navigationstart`, then at commit `scenechange` and `navigationend`, then the `completed` result. A noop emits neither start nor end; `choice-required` emits only `choice`. With zero duration the order is the same.

Input is bound to the focusable container; there are no mandatory global listeners. Shortcuts are ignored in inputs, text areas, contenteditable and media controls; the key map is configurable. Focus moves to the scene title when an explicit user action completes; the editor preview never steals focus. A short `aria-live` region announces the title and choices. Two players on a page never intercept the same keys unless focused.

## 6. Studio and persistence

Desktop layout: a toolbar (new, open, save, undo/redo, present), the scene list on the left, the preview and the XY map in the centre, the inspector on the right. Readable typography, visible focus, empty states and contextual errors. The map uses the shared projection and is not a second player; Z and rotations are edited in the inspector. Tablets keep collapsible panels; phones focus on opening, presenting and an essential inspector.

- **Commands.** Every mutation is an atomic, validated command with undo; history is bounded (100 commands or 20 MiB). A drag previews continuously and commits one command on release; Escape restores. Non-finite numbers or a scale ≤ 0 are refused. Duplicating generates new IDs; deleting updates references in the same command, and deleting hierarchies or graph items shows the concrete impact and asks for confirmation with no silent cascade.
- **Scene editor.** The Layout mode frames the player preview head-on and overlays handles computed by the core: selection, move, resize, rotate, arrows (1 px, 10 px with Shift), numeric fields equivalent to dragging, align and distribute, grid, layers and a reading-order list. Each gesture is one command; Escape cancels it. **Convert to canvas** creates frames from the measured flow layout in one command; switching back to flow confirms the loss of positions. Diagnostics cover clipped text, frames covering interactive controls and insufficient contrast. While dragging, the preview stays within the input→preview budget of section 12.
- **Storage.** IndexedDB holds autosave revisions and asset bytes in atomic transactions: 750 ms debounce, flush on save, the last 10 revisions per project, garbage collection of resources no revision references. Quota or permission errors show a persistent warning while in-memory work and manual download stay available. Startup offers recovery only when it differs from the last saved file and never replaces a file automatically. Two tabs on the same project detect the conflict and keep their work; there is no implicit synchronization. Users can delete revisions and local projects. IndexedDB is not a backup.
- **Files.** Open and save JSON through a file input and a Blob download; the portable `.xcursus` archive bundles document and assets ([FILE_FORMAT](FILE_FORMAT.md)); legacy `.spatialdeck` archives are read and saved again as `.xcursus`. Absolute paths, `file:`, `blob:` and `data:` URLs are never recorded in the document. Opening an archive never extracts to the file system.
- **Offline.** The production build installs a versioned offline shell with explicit updates; the player and the exported HTML never depend on the service worker.

## 7. Content, assets and plugins

- **Sanitization.** Markdown, HTML and SVG go through a single DOMPurify pipeline with allowlists and URL checks, reused by the player, the editor and the exports. HTML allows semantic elements, tables and essential formatting; scripts, `on*` handlers, forms, frames, `object`/`embed`, `javascript:` URLs, `meta` refresh, `style`, `class` and remote CSS are removed. External links need a user action and `rel="noopener noreferrer"`. SVG forbids scripts, `foreignObject`, SMIL, external references, handlers and CSS; local IDs are rewritten per instance. Raw HTML inside Markdown goes through the same pipeline. Exports never relax the policy.
- **Formulas.** KaTeX with `trust: false`, `maxExpand: 500`, `maxSize: 20`, fresh macros per block and `htmlAndMathml` output; only library-generated positioning styles are kept, applied through the CSSOM.
- **Token styles.** Palette, fonts, type scale, appearance and block style are validated values, never CSS strings. Theme fonts are local files with a recorded licence, loaded only when used and embeddable in exports.
- **Assets.** Declared MIME type and minimal signature checks, never executing a file to detect its type. Signature checks accept SVG with a prologue, comments or a DOCTYPE and UTF-8 text split across read chunks. SHA-256 uses `crypto.subtle` or a local implementation outside secure contexts. Temporary URLs are leased and released by the resolver. A missing asset keeps a stable size and offers a recovery action. Audio and video have native accessible controls, captions where relevant and handling of a rejected `play()`; audible autoplay is never guaranteed and an **Enable media** button provides the user gesture. Exit pauses by default; `stop` resets the time. Previews are muted; only one audience view plays audio.
- **Plugins.** API 1.0.0: a descriptor `{id, version, apiVersion, capabilities, dataSchemas}` and a renderer `{mount, update, destroy, ready?}` with a host element, limited services, an abort signal and asset access; a separate editor entry point for inspectors. No mandatory global registry; namespaced events; errors isolated per block. A host-installed plugin is trusted code with the page's authority, **not a sandbox**; a document can never request the download or execution of code. Embeds are off by default: HTTPS origin allowlist, per-frame consent, `sandbox` without `allow-same-origin` or scripts.
- **Hardware integrations.** Web MIDI is optional, feature-detected and permission-gated. OSC has no browser transport and is outside the 1.0 requirements. Cues do not guarantee sample-accurate audio sync.

Details and the threat model: [PLUGINS](PLUGINS.md).

## 8. Distribution, export and presenter

### Command line

Binary `xcursus`, documented in [DISTRIBUTION](DISTRIBUTION.md):

| Command                                                                   | Result                                                              |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `xcursus validate <project> [--json]`                                     | Schema, semantics and asset availability                            |
| `xcursus pack <project> --out <file.xcursus>`                             | The authoring project as a `.xcursus` archive at the current schema |
| `xcursus build <project> --out <directory>`                               | Static web bundle with runtime, JSON and assets, never Studio       |
| `xcursus export html <project> --out <file>`                              | Standalone HTML, no fetch needed                                    |
| `xcursus export pdf <project> --itinerary <file> --out <file>`            | One page per visit of a finite itinerary                            |
| `xcursus export video <project> --itinerary <file> --fps 30 --out <file>` | Deterministic minimal video of the static profile                   |
| `xcursus convert impress <input.html> --out <project.json>`               | **Planned** for 1.0: a candidate project and a sidecar report       |

The CLI reuses the core for parsing and validation and the player for rendering and capture. An existing output fails unless `--overwrite`; writes go through a temporary file and an atomic rename; no asset path may leave the project root; no input is interpolated into a shell. Exit codes: 0 success (warnings allowed), 1 invalid document, asset or capability, 2 missing environment or dependency, 3 write or export failure. The CLI never installs FFmpeg or browsers.

### Outputs

- **Embed.** Reusable ESM and CSS, and a classic IIFE generated from the same player; not a second engine.
- **Standalone HTML.** JSON escaped against `</script>`, runtime, CSS, fonts and allowed assets inline; no external imports, fetches, CDNs or service worker. A static outline and `<noscript>`. A CSP with hashes, `connect-src 'none'`, no `unsafe-eval` and no `unsafe-inline`. It opens from `file://` with the network disabled. Target size 25 MiB, with a warning above.
- **Static build.** The same runtime over HTTP(S), fetching `project.json` and assets from the same origin.
- **Packaging.** Third-party libraries stay external dependencies; artefacts that embed their code (IIFE, standalone HTML, export runtime) include generated licence notices. Manifests carry `license: "GPL-3.0-or-later"`, description, repository, homepage, keywords, `sideEffects`, `engines` and a README; the React peer is a range. Optional renderers load on demand; KaTeX fonts ship as woff2 files. The bundle budget is measured on a minimal and on a realistic consumer, and an E2E suite installs the `pnpm pack` tarballs in an external consumer.
- **Manifest.** Every export writes an `ExportManifest` `{format, status, toolVersion, schemaVersion, itinerary?, resources, licenses, warnings, unsupported, environment, verification, output}`. Strict exports reject remote resources, plugins without the offline capability and non-embeddable media or fonts; `--allow-partial` writes explicit placeholders and a `partial` manifest. Private notes are excluded from every export.

### Itinerary, PDF and video

An itinerary `{pathId, visits: [{nodeId, edgeIdToNext?}]}` has at most 500 visits with validated IDs and adjacencies; a cycle is exported only as expanded visits. `edgeIdToNext` is required when not unique and absent on the last visit. Total time is the sum of the holds and of the edges between visits, with no transition after the last.

- **PDF.** Chromium prints the arrival pose of each visit with the same player and renderers, one page of the viewport's size, after waiting for fonts, images and renderers. Videos become posters or placeholders, audio and interactions are excluded with warnings, notes never appear.
- **Video.** A minimal static profile: text, images, SVG, formulas and deterministic camera transitions, no audio track, dynamic media or embeds. WebM with an encoder actually present in the local FFmpeg. `N = ceil(durationMs · fps / 1000)` frames sampled at `t = i · 1000 / fps`; the encoded duration is `N / fps` within one frame; poses match the sampler. Capture fixes the reduced-motion preference in the plan. Identical pixels are guaranteed only in the same fixed environment. No FFmpeg binary is distributed.

Codec, font, resource, timeout or dependency errors produce a diagnosed failure, never an empty file presented as success.

### Presenter mode

Private notes, current scene and node, a preview of the next visit (or the choices of an ambiguous branch) and a monotonic timer. The audience window opens on a user gesture; a blocked pop-up shows instructions and a single-window fallback. The session uses a random ID, a handshake, validated messages and origin and source checks; the console is the single navigation authority, with sequence numbers to avoid feedback loops, and reconnection resynchronizes from a snapshot. Notes never reach the public DOM. This is not cryptographic protection if the authoring project itself is distributed. Full support needs a local host or HTTPS; `file://` HTML falls back to a single window.

## 9. impress.js import (planned)

**Planned** for 1.0, not implemented. The paradigm of spatial HTML steps is a reference; the XCursus architecture stays independent.

| impress.js attribute or API                                                      | Planned conversion                                                      |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `data-x`, `data-y`, `data-z`                                                     | Position of the centre in CSS units                                     |
| `data-rotate`, `data-rotate-x/y/z`, `data-rotate-order`                          | Composed in the source order, then decomposed in the XCursus convention |
| `data-scale`                                                                     | Positive uniform scale; invalid values diagnosed                        |
| Root `data-width`, `data-height`, `data-perspective`, `data-transition-duration` | Viewport, perspective and duration                                      |
| `.step`, IDs and DOM order                                                       | Scenes, nodes and main path                                             |
| `init`, `next`, `prev`, `goto`                                                   | An optional facade on top of a local player                             |

Requirements for the importer: inert parsing with parse5, never opening imported HTML as a page; matrix and landmark comparison for the six rotation orders; explicit warnings for zero perspective, scale limits, relative positioning, arbitrary CSS, remote fonts, scripts, plugins and frames; no automatic download of resources; no claim of general visual or timing fidelity; upstream licences preserved.

## 10. Security and accessibility

Project, import and asset input is untrusted. Boundaries: data validation in the core, DOM sanitization in the player, confined file resolution in the CLI, plugins approved by the host and isolated frames. Protect against prototype pollution, traversal (including percent-encoded and backslash forms), zip bombs, active URLs, SVG scripting, resource exhaustion and cyclic references. Registries use Maps or prototype-less objects. No `innerHTML` with unsanitized source; no `eval`, `Function` or dynamic import from data. No secrets in fixtures or logs.

Target: WCAG 2.2 AA for the interface and builtin content, verified with automated checks and targeted manual tests; this is not a certification of user content. Keyboard-only use for essential operations, a numeric alternative to dragging, visible focus restored after dialogs, accessible names, errors associated with fields, contrast 4.5:1 for text and 3:1 for components, 200% browser zoom, a usable layout at 320 CSS px, no focus traps, adequate touch targets. A reachable outline and a reduced-motion control are always present. Images need alternative text (empty only if decorative), videos captions or a transcript where required, audio a label; omissions are diagnosed, never filled with invented text. Reading order is independent of visual position (WCAG 1.3.2, 2.4.3); dragging has an alternative (2.5.7). In canvas scenes, reflow at 320 px is provided by the outline. The absence of axe violations is not equivalent to screen reader testing.

## 11. Browser support

Policy: the last two stable versions, at release time, of desktop Chrome, Edge, Firefox and Safari. Builds use an explicit browser target.

| Surface          | Target and test                              | Limits and fallback                                           |
| ---------------- | -------------------------------------------- | ------------------------------------------------------------- |
| Core             | Node 24 and modern browsers                  | No DOM API; declared numeric limits                           |
| Player           | Playwright Chromium, Firefox and WebKit      | Playwright WebKit is not an installed Safari                  |
| Studio           | Desktop matrix; E2E in the three engines     | Download and file input instead of the File System Access API |
| Tablet and phone | Safari on iPadOS/iOS and Chrome on Android   | Presenting and outline; limited precision editing             |
| Presenter        | Pop-up on a local host or HTTPS              | Blocked pop-ups and `file://`: single-window fallback         |
| MIDI             | Where feature detection and permission allow | No promise on Safari or Firefox                               |
| PDF and video    | Chromium of the pinned Playwright version    | Local FFmpeg for video                                        |
| Standalone HTML  | `file://` on the desktop targets             | No backend, fetch, service worker or storage                  |

A target that cannot be tested is reported as not verified and its criterion stays open. Without CSS 3D, or with a reduced-motion preference, content remains readable and navigable through the outline.

## 12. Tests, CI and budgets

Root scripts: `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` (Vitest run), `pnpm test:coverage`, `pnpm build`, `pnpm check:boundaries`, `pnpm check:bundle`, `pnpm check:packages`, `pnpm test:e2e`, `pnpm dev:studio`, `pnpm dev:playground` and `pnpm xcursus`. Test browsers are installed explicitly (`pnpm browsers:install`). The E2E launcher starts and stops its own servers.

- **Unit:** schema, semantics and migrations, matrices and camera, state machine and history, sampler, errors.
- **Integration:** multi-instance player, events, plugin lifecycle, resolver, persistence, archive, CLI.
- **E2E:** pixels, projection landmarks and real browser interactions; editor → save → open → player; offline exports; packages installed from tarballs.

Mocks are used only for isolated time, errors and permissions, never as proof that audio, export, UI or hardware work. Screenshots use justified thresholds plus geometric landmarks; snapshots are never updated to hide a regression. CI runs the full suite on Linux with actions pinned by SHA, never publishes and fails if a check modifies a tracked file. Coverage floors: core ≥ 85% statements and ≥ 80% branches, with dedicated floors for player assets, plugins and editor store and storage.

### Budgets

These are thresholds to meet, not claims of measured performance. Reference scenario: 100 scenes with 10 text blocks of 100 characters, a 100-node path, no media, a 1280×720 viewport, DPR 1, local fonts, a recorded machine, production build; five warm-ups and twenty measurements, reporting p50 and p95.

| Metric                     | Threshold                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| Minimal core+player bundle | ≤ 100 KiB gzip JS, ≤ 20 KiB gzip CSS, React and editor absent                               |
| 100-scene document         | p95 mount-ready ≤ 1000 ms; validation ≤ 100 ms                                              |
| Editor interaction         | p95 input → preview ≤ 100 ms, also with 50 MiB of media and while dragging 30 canvas blocks |
| Camera                     | p95 frame interval ≤ 34 ms, no long task > 200 ms during 10 transitions                     |
| Teardown                   | Zero owned resources after 50 mount/destroy cycles; retained heap delta ≤ 5 MiB after GC    |
| Video export               | Exact frame count, duration within one frame, endpoint pose within 1e-6                     |
| Realistic consumer         | Measured with rich and media renderers; a justified threshold is set before 1.0             |

Timings on shared CI runners are informative; the performance gate runs on a controlled machine. Budgets are never lowered just to make a build pass.

## 13. Versioning and release

Product releases (0.1, 0.2, 0.3, 0.4, 0.4.1, 0.5, 0.6, then 1.0) are independent from the document schema, the archive manifest and the plugin API versions. Package APIs follow SemVer; before 1.0 every breaking change requires a migration, a changelog entry and fixtures, and from 1.0 an API break requires a major version. Deprecations are explicit, not permanent silent aliases.

Accepted, declared limitations: a 2D map with Z edited in the inspector; video without audio; offline HTML only for the supported profile; trusted JavaScript plugins; no bundled OSC bridge. An unimplemented feature is never presented as complete behind a disabled control.

1.0 requires every exit criterion of the [roadmap](ROADMAP.md#10-stabilization), licences and attributions, distributable sources, reproducible instructions and no open security, data-loss, P0 or P1 issue. Otherwise a candidate is prepared with a documented list of blockers, without declaring it stable.
