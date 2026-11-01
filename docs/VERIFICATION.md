# Testing and verification

This document describes how XCursus is verified: which checks exist, what each one proves, how to reproduce it, and what remains unverified. Commands are run from the repository root after the installation in [DEVELOPMENT](DEVELOPMENT.md).

## Levels of verification

| Level                | Command                                            | Proves                                                                                              |
| -------------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Static               | `pnpm typecheck`, `pnpm lint`, `pnpm format:check` | Strict types (including generated ones), lint rules, formatting                                     |
| Unit and integration | `pnpm test`, `pnpm test:coverage`                  | Document contract, math, navigation, renderers, archive, store, storage and CLI behaviour           |
| Build and boundaries | `pnpm build`, `pnpm check:boundaries`              | Every package and app builds; dependency rules hold on sources and output                           |
| Bundle budget        | `pnpm check:bundle`                                | Minimal core+player consumer within 100 KiB gzip JS and 20 KiB gzip CSS                             |
| Packages             | `pnpm check:packages`                              | Tarballs install and type-check in an external consumer; minimal and realistic consumers build      |
| Browsers             | `pnpm test:e2e`                                    | Real rendering, interaction, persistence, exports and accessibility in Chromium, Firefox and WebKit |

A check that could not run is reported as not run, never as passed. Evidence (screenshots, round-trip JSON, measurements, axe results, exported files) is written to `test-results/` and never to tracked files.

## Unit and integration tests

Vitest, with jsdom for DOM-dependent player and plugin tests and `fake-indexeddb` for storage.

| Area       | Files                                                                             | What is verified                                                                                                                                                                                                     |
| ---------- | --------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document   | `packages/core/test/{document,structure,contents,layout,update}.test.ts`          | Every schema version, negative cases with code and JSON Pointer, semantic rules, capabilities, migration chain from each historical fixture, fixtures on disk unchanged, differential type checks                    |
| Geometry   | `packages/core/test/{math,frame}.test.ts`                                         | Matrices, quaternions and Euler conversions with tolerances, gimbal lock, auto-fit, frame geometry and round trips, projection of scene points, contrast                                                             |
| Navigation | `packages/core/test/navigation.test.ts`                                           | Linear and branching history, `prev()` on the actual history, interruption, visit limits, loops                                                                                                                      |
| Capture    | `packages/core/test/capture.test.ts`                                              | Itinerary validation, capture plan, sampler, frame schedule, public document without notes                                                                                                                           |
| Player     | `packages/player/test/{player,layout,presenter,assets,signatures,sha256}.test.ts` | Lifecycle and teardown, events and their order, messages and `lang`, incremental updates equal to a full mount, capture rendering, layout tokens, presenter protocol, asset signatures, SHA-256 against NIST vectors |
| Plugins    | `packages/plugins/test/{renderers,builtins,sdk,archive,format}.test.ts`           | Sanitization policies against hostile payloads, on-demand renderers, SDK contract, ZIP hardening (paths, headers, CRC, limits, digests), `.xcursus` round trips and legacy `.spatialdeck` import                     |
| Editor     | `packages/editor/test/{store,structure,storage,recovery}.test.ts`                 | Commands, undo/redo bounds, gestures and coalescing, structural edits, IndexedDB revisions, upgrades, conflicts, quota, deletion, recovery and open limits                                                           |
| CLI        | `packages/cli/test/cli.test.ts`                                                   | Arguments and exit codes, confinement (traversal, encoded paths, symbolic links), asset checks, atomic outputs, profiles, itineraries, `pack`, legacy archives, missing FFmpeg                                       |
| Tooling    | `scripts/e2e-plan.test.ts`                                                        | Selection of the Playwright runner per platform and filter                                                                                                                                                           |

### Coverage

`pnpm test:coverage` (V8) enforces per-area floors defined in `vitest.config.ts`:

| Area                                                    | Statements | Branches |
| ------------------------------------------------------- | ---------: | -------: |
| `packages/core/src/**`                                  |       85 % |     80 % |
| `packages/player/src/assets/**`                         |       90 % |     85 % |
| `packages/player/src/{index,content/index,messages}.ts` |       80 % |     65 % |
| `packages/plugins/src/{security,archive,media}.ts`      |       85 % |     75 % |
| `packages/editor/src/{store,storage}/**`                |       88 % |     72 % |

Branches left uncovered are mostly DOM, focus and IndexedDB engine paths, which the browser suites exercise instead. Coverage does not replace adversarial fixtures.

## Browser suites

Playwright serves production builds of the playground and Studio. Every suite runs in Chromium, Firefox and WebKit.

| Suite                   | What is verified                                                                                                                                                                                                                                              |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core.spec.ts`          | Scene geometry against the core projection within 1 CSS pixel, two independent players, navigation and interruption, destroy and remount without leftovers, focus, reduced motion, CSP without `unsafe-eval`                                                  |
| `editor.spec.ts`        | Studio: creating, dragging and editing scenes with one undo per gesture, save → reopen in a new session → player with identical model, camera and landmarks, recovery after reload, denied quota, two tabs                                                    |
| `structure.spec.ts`     | Branches and actual `prev`, limited loops, reparenting that preserves world geometry, camera tracks, cues, timeline scrubbing without visits, historical documents opened as migrated copies                                                                  |
| `contents.spec.ts`      | All eleven block types with local media offline, isolated SVG IDs, MathML, hostile payloads kept inert, missing assets and malformed archives that never replace the project, archive round trip between Studio and the player                                |
| `consolidation.spec.ts` | Assets with digests over plain HTTP on a non-localhost host, Studio with about 50 MiB of media within the input → preview budget, replaced texts and `lang`, production CSP, IndexedDB upgrades across tabs, project deletion, conditional recovery           |
| `layout.spec.ts`        | Canvas landmarks on rotated and nested scenes, clipping, `z`, DOM and Tab order, tokens under a strict CSP, theme fonts loaded only when used, unchanged rendering of migrated documents, the scene editor by pointer and keyboard, 30-block drag performance |
| `a11y.spec.ts`          | axe-core 4.14.0 (WCAG 2.0, 2.1, 2.2 A–AA and best practices) on the playground, Studio, the content gallery and the layout example: no serious or critical violation allowed                                                                                  |
| `distribution.spec.ts`  | Tarball consumer, standalone HTML from `file://` with all network requests blocked, strict and partial exports, static build, PDF and video inspection, environment errors from the installed CLI                                                             |
| `presenter.spec.ts`     | Audience window and console in sync, notes never in the audience DOM, timer, reloads resynchronized from snapshots, foreign messages ignored, blocked pop-up fallback                                                                                         |
| `pwa.spec.ts`           | Offline reload of Studio with the project from IndexedDB, explicit update that keeps data and removes only Studio's own old caches (including those of releases made under the former name)                                                                   |
| `format.spec.ts`        | Studio's file picker, a legacy `.spatialdeck` opened, saved as `.xcursus` and reopened with the same document and asset bytes, the native example archive in Studio and in the vanilla player                                                                 |

### Reproducible procedures

- **Geometry.** Landmarks (scene corners, frame corners) are read with `getBoundingClientRect` and compared with `projectScenePoint` from the core; the tolerance is 1 CSS pixel.
- **Round trip.** A project is saved through a real download, reopened in a fresh browser context and compared as a model, as a camera pose and as landmarks in the player.
- **Offline HTML.** The exported file is opened from `file://` with every `http(s)` and `ws(s)` request intercepted and counted, plus offline emulation where the engine supports it with `file://`. The test requires zero requests, zero `securitypolicyviolation` events, rendered formulas, images and theme fonts, and private notes absent from source and DOM.
- **PDF.** The CLI exports the `distribution-static` fixture with `itinerary.json` (three visits) and `itinerary-repeat.json` (a repeated visit); the test checks the page count and size, extracts text with `pdftotext`, rasterizes each page and compares them (different visits differ, a repeated visit matches its first occurrence).
- **Video.** The same fixture at 30 fps: ffprobe must read the planned number of frames and the planned duration within one frame; recorded poses must equal the core sampler within 1e-6 and the rendered matrix within a relative 1e-5; two runs in the same environment produce identical frames.
- **Packages.** `pnpm check:packages` installs the tarballs in `test-results/packages/consumer` with no alias to the sources and type-checks every public API with `skipLibCheck: false`; the E2E suite then serves that consumer and runs the CLI from its installed tarball.
- **Rendering identity across builds.** `scripts/flow-identity.mjs` compares pixels and geometry of the historical fixtures between two builds of the playground; the procedure is documented in the script. It is not part of the automatic suites because it needs a second build.

## Exports and CLI

The export pipeline is verified at three levels: unit tests of the CLI (no browser), the E2E distribution suite with the CLI installed from its tarball, and checks the CLI performs on its own output and records in the `verification` field of every manifest (CSP hashes, absence of notes, page count, frame count, rendered poses). A manifest never claims a check it did not run; offline behaviour is proven only by the E2E suite.

## Legacy compatibility

Backward compatibility with SpatialDeck is verified with an archive written by SpatialDeck 0.6, kept unchanged in `tests/fixtures/legacy/layout-canvas.spatialdeck`:

- the library reads it, verifies every asset and reports its source schema version (`format.test.ts`);
- saving it again produces the same entries, manifest and asset bytes (`format.test.ts`);
- a legacy archive with a 1.2.0 document is migrated in memory and its plugin data is preserved (`format.test.ts`);
- the CLI validates it, reports `archiveFormat: "legacy"` and converts it with `pack`, leaving the original byte-for-byte unchanged (`cli.test.ts`);
- Studio opens it with a notice, saves `<title>.xcursus`, and a new session reopens that file with the same document and asset digests (`format.spec.ts`);
- the offline shell removes caches named after the former product (`pwa.spec.ts`).

Historical JSON fixtures at schema 1.0.0 (`examples/core-three-scenes`, `examples/editor-roundtrip`), 1.1.0 (`examples/structure-branching`) and 1.2.0 (`examples/content-gallery`) are opened and migrated by both the unit and the browser suites.

## Recorded results

| Date        | Revision                                        | Environment                                                                                                                                          | Unit | E2E | Outcome                       |
| ----------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---: | --: | ----------------------------- |
| 21 Oct 2026 | `07916cc` (0.1)                                 | Linux CI, Playwright 1.64.1 ([run 39596586324](https://github.com/XCursus/xcursus/actions/runs/39596586324))                                         |   85 |  30 | passed                        |
| 22 Oct 2026 | 0.4                                             | Linux CI ([run 39730492795](https://github.com/XCursus/xcursus/actions/runs/39730492795))                                                            |  233 | 120 | passed                        |
| 26 Oct 2026 | `5ad6a89` (0.6)                                 | Linux CI, Chromium, Firefox 157.0, WebKit 27.2 ([run 40323855783](https://github.com/XCursus/xcursus/actions/runs/40323855783))                      |  458 | 246 | passed                        |
| 1 Nov 2026  | XCursus rename (branch `chore/xcursus-rebrand`) | macOS 14.8.7 (Darwin 23.6.0, arm64), Node 24.22.0, pnpm 12.14.0; Chromium and Firefox with Playwright 1.64.1, WebKit with the macOS 14 runner 1.61.1 |  478 | 273 | passed, zero skipped or flaky |

Measurements from the 1 November 2026 run:

| Measurement (gzip level 9)                            | Value                                                                                                                                  |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Minimal core+player bundle (`check:bundle`)           | 66 385 B JS, 1 345 B CSS (budgets 102 400 B and 20 480 B); theme fonts separate, 53 488 B of woff2                                     |
| Minimal consumer from the tarballs                    | 59 705 B JS, 1 682 B CSS; no React, editor or rich renderers                                                                           |
| Realistic consumer (content gallery from the archive) | 65 681 B JS and 9 100 B CSS initially; 170 038 B JS once the on-demand renderers load; 23 font files, 309 656 B, loaded only when used |
| Package checks (`check:packages`)                     | 80 of 80                                                                                                                               |

The rename run has not yet been executed on Linux CI: it happens when the branch is pushed.

## Not verified and known limits

- **Browsers.** WebKit is tested through Playwright, not an installed Safari. Mobile devices, touch input and screen readers have not been tested. On macOS 14 the WebKit runner paints 3D-rotated scenes flattened in screenshots while the measured geometry is correct, so WebKit assertions rely on geometry rather than pixels of 3D poses; offline emulation does not work with `file://` in that runner, where only request blocking applies.
- **Performance.** The input → preview budget is asserted on a local, uncontrolled machine and only recorded on CI. Heap after garbage collection, the 100-scene mount and frame budgets and timings on a controlled machine are not measured yet. Headless measurements of a 12-second camera spiral on a large deck gave p95 frame times above the 34 ms budget in Chromium and Firefox; they are pessimistic (software rendering) and must be repeated with a GPU.
- **Exports.** PDF and video are captured with Chromium only. Text of scenes seen in perspective may be rasterized in the PDF. Pixel identity of video frames holds only in the same environment. The presenter view is not available in `file://` HTML.
- **Accessibility.** axe reports no serious or critical violation; one moderate rule (`landmark-unique`, the playground page with two players) remains. The presenter console and the audience window are not covered by axe, and no manual screen reader check has been done.
- **CI exception.** In Linux WebKit, the CSP test of `/layout` ignores `style-src-attr` reports for the two native `<select>` elements of the playground page, which are outside the player.
- **Archive memory.** `readArchive` keeps the whole compressed archive in memory in addition to the Blobs; `writeArchive` keeps the compressed chunks until the final Blob.

Open product defects found by testing are tracked in the [roadmap](ROADMAP.md#known-issues).
