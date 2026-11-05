# Changelog

Notable changes by product release. Product versions are independent of the document schema, the archive manifest and the plugin API, which are versioned separately (see the [specification](docs/SPECIFICATION.md#13-versioning-and-release)). Dates are those of the release in the repository.

## Unreleased: 1.0 candidate

Schema `1.3.0`, archive manifest `1.0.0` and plugin API `1.0.0` are unchanged; documents of every earlier version open as before. Package versions stay at 0.6.0 until 1.0 is declared; the open [release blockers](docs/RELEASE_BLOCKERS.md) keep the candidate a pre-release.

### Added

- **impress.js import.** New package `@xcursus/impress-compat`: `importImpress(html, options)` converts an impress.js presentation into a candidate document validated at schema 1.3.0, with a diagnostic (stable code, JSON Pointer, source line) for everything not carried over. Mapping of the impress.js 2.0.0 release (tag `v2.0.0`), with the `bundle` (rel and skip plugins) and `core` profiles; rotations composed in the source order and decomposed in the XCursus convention; inert parsing with parse5 8.0.1, no script, stylesheet or fetch. `createImpressAdapter(player, document)` offers `goto`, `next` and `prev` with impress.js semantics. Guide: [docs/IMPRESS.md](docs/IMPRESS.md).
- `xcursus convert impress <input.html> --out <project.json|file.xcursus>` with `--profile`, `--root` and `--overwrite`, writing the candidate, its local assets and a sidecar report `<out>.report.json`.
- Studio: **Import impress.js**, a dialog that converts the chosen HTML and media, lists every finding and opens the candidate only after review; unsaved work goes to local recovery first. `StudioProps.importImpress` (`ImpressImporter`).
- Exported HTML and static builds: on-screen **Previous**, **Next** and **Full screen** buttons and touch swipes.
- Plugins and embeds: a host-provided network signal (`NetworkSignal`, option `online` of `PluginHost`, `registerNavigation` and `createBuiltinRegistry`); `navigator.onLine` remains the default.
- `pnpm benchmark` (`scripts/benchmark.mjs`): the performance budgets on the production builds with raw samples, p50/p95 and the environment; `pnpm test:e2e:chrome` and `playwright.installed.config.ts` run the browser suites on an installed Chrome or Edge or on a given build.
- Checks: a realistic-consumer budget (initial JS ≤ 100 KiB gzip, with lazy renderers ≤ 200 KiB, CSS ≤ 20 KiB); boundaries of the importer; the importer from its tarball; axe audits of the exported HTML and of the import dialog; seeded fuzzing of the ZIP reader and of the HTML and SVG sanitization policies.
- Release checks: `scripts/checklist.mjs` runs the release checklist through a dependency-free WebDriver client in Safari (`pnpm test:safari`), Firefox release builds, Safari on the iOS Simulator and Chrome on Android with real touch input; `scripts/screen-reader.mjs` runs the screen reader items with VoiceOver or NVDA through Guidepup (`@guidepup/guidepup`, development only); `scripts/browser-builds.mjs` fetches the latest and previous stable Firefox, Chrome and Edge; the `Release checks` workflow runs all of it on GitHub's runners.
- Project documents: this changelog, [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), [docs/RELEASE_BLOCKERS.md](docs/RELEASE_BLOCKERS.md). Example `examples/impress-import`.

### Changed

- PDF and video: content outside the profile in scenes the itinerary does not visit is a placeholder with an `OUTSIDE_ITINERARY` warning instead of refusing a strict export.

### Fixed

- Exported HTML on touch screens: a horizontal swipe that started on scrollable scene content or on a framed block was taken by the browser (`pointercancel`) and did not move to the next or previous visit. Found with real touch input in Chrome on Android.
- Text view on narrow players: where the control bar wraps to two rows the outline extended below the player and its end could not be read; in exported HTML its last item also stayed under the on-screen buttons.
- Exported HTML on iOS: Safari reports a touch `pointerup` at (0, 0), so swipes looked vertical and did nothing; a swipe now ends where the finger last moved.
- Studio on tablets: icon buttons showed their tooltip on the first tap and needed a second one, and the faded presentation controls needed a tap to reappear before they could be pressed; tooltips need a hover-capable pointer and the controls stay visible with touch.
- Building on Windows: the Vite configurations made paths with `URL.pathname` (`/D:/...`), so every build failed there.
- Firefox drew some child scenes behind their large section (only the section's background was visible). Gecko sorts 3D planes in paint order and loses precision when a large plane is cut; the player now gives scene wrappers a split-minimizing paint order in that engine, with the scene being shown first, without moving them in the DOM.
- LaTeX blocks with alternative text named a generic element (`aria-label` without a role, an axe `aria-prohibited-attr` violation in exported HTML); the formula is now a `math` region.
- The review list of the import dialog scrolls and is keyboard focusable.

## 0.6 Distribution, 26 October 2026, updated to 2 November 2026

Schema 1.3.0. Command line (`validate`, `pack`, `build`, `export html|pdf|video`), standalone offline HTML with a strict CSP, static build, PDF with one page per visit, deterministic WebM video, presenter view with an audience window, offline Studio shell, publishable packages and English defaults. After the release: the redesigned dark Studio interface, fixes from a stress test with a large deck, the English Studio interface, the rename from SpatialDeck to XCursus with the `.xcursus` format and legacy `.spatialdeck` import, Studio's Export panel, and the five packages published on npm at 0.6.0.

## 0.5 Layout, 23 October 2026

Schema 1.3.0: canvas scenes with block frames, document theme, scene appearance, token styles, the scene editor with snapping, alignment and layers, layout diagnostics and the Atkinson Hyperlegible font.

## 0.4.1 Consolidation, 22 October 2026

Asset signature and digest fixes, incremental preview, replaceable player texts and `lang`, IndexedDB hardening, project deletion, axe and coverage in CI.

## 0.4 Content, 22 October 2026

Schema 1.2.0: eleven block types, local assets, the sanitization pipeline, media, the plugin SDK 1.0.0 and the portable archive.

## 0.3 Structure, 22 October 2026

Schema 1.1.0: scene hierarchy with world-preserving reparenting, branching paths, choices and limited loops, node cameras, camera tracks, cues, timeline and overview.

## 0.2 Editor, 21 October 2026

Studio: scene list, XY map, inspector, undo and redo, the shared player preview, JSON files, IndexedDB autosave and recovery.

## 0.1 Core, 21 October 2026

Schema 1.0.0: the core and the framework-free player with validation, geometry, linear navigation with history and interruption, input, focus, outline and teardown; a vanilla demo; CI.
