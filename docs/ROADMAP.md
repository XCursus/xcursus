# Roadmap

XCursus is a **1.0 candidate**, still a pre-release: the work of 1.0 Stabilization is implemented and tested, and 1.0 is declared only when the [release blockers](RELEASE_BLOCKERS.md) are closed. Releases 0.1 to 0.6 were published under the name SpatialDeck; the product, packages and native file format were renamed to XCursus after 0.6 (see [FILE_FORMAT](FILE_FORMAT.md#legacy-spatialdeck-archives) for compatibility). Changes are listed in the [changelog](../CHANGELOG.md).

## Released milestones

| Release             | Date        | Schema | Delivered                                                                                                                                                 |
| ------------------- | ----------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0.1 Core            | 21 Oct 2026 | 1.0.0  | Core and framework-free player: validation, geometry, linear navigation with history and interruption, input, focus, outline, teardown; vanilla demo; CI  |
| 0.2 Editor          | 21 Oct 2026 | 1.0.0  | Studio: scene list, XY map, inspector, undo/redo, shared player preview, JSON files, IndexedDB autosave and recovery                                      |
| 0.3 Structure       | 22 Oct 2026 | 1.1.0  | Scene hierarchy with world-preserving reparenting, branching paths, choices and limited loops, node cameras, camera tracks, cues, timeline, overview      |
| 0.4 Content         | 22 Oct 2026 | 1.2.0  | Eleven block types, local assets, sanitization pipeline, media, plugin SDK 1.0.0, portable archive                                                        |
| 0.4.1 Consolidation | 22 Oct 2026 | 1.2.0  | Asset signature and digest fixes, incremental preview, replaceable player texts and `lang`, IndexedDB hardening, project deletion, axe and coverage in CI |
| 0.5 Layout          | 23 Oct 2026 | 1.3.0  | Canvas scenes with block frames, document theme, scene appearance, token styles, scene editor, layout diagnostics, Atkinson Hyperlegible                  |
| 0.6 Distribution    | 26 Oct 2026 | 1.3.0  | CLI, standalone HTML, static build, PDF, WebM video, presenter view, offline Studio shell, publishable package layout, English defaults                   |

After 0.6 and before the rename: a redesigned dark Studio interface (27 October), fixes from a stress test with a large real deck (29 October), and the English Studio interface, playground and examples (31 October). The rename (1 November) introduced the `.xcursus` format, legacy `.spatialdeck` import and the `xcursus pack` command.

## 1.0 Stabilization

Status on 5 November 2026: **candidate with two open blockers**, VoiceOver's announcement of a move and the performance gate, both to be checked on a Mac. Schema 1.3.0 is unchanged.

| Scope             | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| impress.js import | Done: `@xcursus/impress-compat`, `xcursus convert impress`, Studio **Import impress.js** with review; mapping of impress.js 2.0.0 with `bundle` and `core` profiles; independent oracle and the upstream engine in three browsers ([IMPRESS](IMPRESS.md))                                                                                                                                                                                                                                 |
| Hardening         | Done: seeded fuzzing of the ZIP reader and of the HTML and SVG policies; host-provided network signal for plugins and embeds; declared embed limits; the two P1 export defects fixed; axe on exported HTML; dependency audit (production: no known vulnerability)                                                                                                                                                                                                                         |
| Browser matrix    | Done ([blockers](RELEASE_BLOCKERS.md#closed)): Chromium, Firefox and WebKit on macOS 14 and Linux CI; Safari 27.2 and 26.5.2, Firefox 159 and 158 release builds through WebDriver; every suite on Chrome 157 and 156 and Edge 156 and 155; touch in the iOS Simulator (iPhone, iPad) and the Android Emulator (phone, tablet); NVDA with Chrome and VoiceOver with WebKit through Guidepup, on GitHub's runners by the maintainer's decision; VoiceOver's announcement of a move is open |
| Performance       | Every budget met in three engines on the development Mac on battery; on the runners Chromium and WebKit meet every budget and Firefox, rendering 3D in software, does not; the gate on the Mac on mains power is open. Realistic-consumer threshold set                                                                                                                                                                                                                                   |
| Project documents | Done: [CHANGELOG](../CHANGELOG.md), [CONTRIBUTING](../CONTRIBUTING.md), [SECURITY](../SECURITY.md), with GitHub's private vulnerability reporting enabled                                                                                                                                                                                                                                                                                                                                 |
| Release candidate | Prepared in the repository at version 0.6.0 of the packages; no tag, publish or deploy                                                                                                                                                                                                                                                                                                                                                                                                    |

Evaluated and deferred after 1.0 (no schema change needed, decision recorded):

- **AVIF and FLAC assets**: decoded by every desktop target browser (Safari since 16.4 for AVIF); support needs signatures in the player verifier, Studio's file types, the importer and the export profiles, plus fixtures. Deferred to the backlog.
- **MOV assets**: not supported. QuickTime is reliably played only by Safari; Firefox does not play it and Chrome depends on the codec inside.
- **Node and pnpm ranges**: the published packages accept `node >=24`; the repository keeps exact pins (`engines`, `packageManager`, CI) so that installs, generated files and tests are reproducible. Widening the development pins is a backlog item.

### Exit criteria

1.0 is declared only when every criterion is met with recorded evidence; otherwise a candidate is prepared with a documented list of blockers.

- [x] Player independent of editor and React; editor without competing math or rendering (`check:boundaries`, `check:packages`).
- [x] Historical fixtures of every schema version migrate without loss or rendering differences.
- [x] Canvas layout, theme and token styles verified in the player, Studio and every export; reading order and drag alternative tested.
- [x] Branch, loop, history and interruption navigation, hierarchies and keyframes verified.
- [x] Builtin content, sanitization and trust model documented and tested, including fuzzing.
- [x] JSON, archive and recovery verified with real files, quota errors and missing assets.
- [x] Embed, offline HTML, PDF and video produced and inspected, with accurate manifests.
- [x] Presenter with no notes in the audience view and with a pop-up fallback.
- [x] Essential impress.js import with mapping and warnings, without claims of full compatibility.
- [ ] Browser matrix: the two latest stable versions of Chrome, Edge, Firefox and Safari, touch on iOS and Android, NVDA, and VoiceOver except its announcement of a move (5 November 2026; simulated devices and automated screen readers on GitHub's runners, by the maintainer's decision of 4 November); **VoiceOver's announcement of a move is a blocker**.
- [ ] Budgets measured with hardware, browser and build recorded: **met on the development Mac on battery and, for Chromium and WebKit, on the runners; the gate on a controlled machine with a GPU is open**.
- [x] Complete CI, installable packages, public types, licences and attributions, reproducible documentation (green Linux CI on the candidate, 4 November 2026).
- [x] No known unresolved P0 or P1 issue, data loss or security risk; backlog classified (the Firefox painting defect is fixed, 4 November 2026).

## Known issues

Defects found by testing that are still open, by severity (P1 blocks an intended use or shows wrong data; P2 has a workaround; P3 is polish).

| Severity | Issue                                                                                                                                                                                                                                          |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2       | In the PDF, scenes with a world rotation are rasterized even when the camera frames them head-on, so their text is neither selectable nor searchable and files grow large.                                                                     |
| P2       | Pressing **Next** during a long camera track restarts it from its first keyframe; repeated presses lengthen the transition.                                                                                                                    |
| P2       | At the maximum of 1000 scenes the exported HTML takes several seconds to become ready, the overview about 2 s, and selecting a scene in Studio 1–3 s; the Paths tab creates a very large DOM.                                                  |
| P2       | Firefox without GPU acceleration renders 3D in software: the 100-scene reference deck takes about 5 s to mount on an M3 Max and 11–12 s on CI machines, and transitions drop below 30 frames per second. Chromium and Safari are not affected. |
| P3       | The choices of a branch are not announced when the player arrives at it; a screen reader user reaches them with Tab or the reader's navigation, where each choice is announced by name.                                                        |
| P3       | Studio logs CSP reports in the console whenever it parses HTML that contains inline `style` or `on*` attributes (removed by the sanitizer), which can hide other errors.                                                                       |

## Backlog

Planned improvements without a committed release:

- **Time inside scenes**: progressive builds of blocks, cues with a builtin visible or audible effect, synchronizing audio with camera tracks.
- **Camera authoring**: capturing the current view as a pose, a visual timeline or curve editor, a graph view of paths.
- **Typography and style**: larger size steps and per-block font, background, border and padding tokens; taller images in flow scenes.
- **Sanitization for diagrams**: a reviewed extension of the SVG allowlist (font attributes, dash arrays, markers, opacity, `preserveAspectRatio`) and of table formatting in HTML.
- **Structure**: block groups, scene templates or sections, a hierarchical scene list and a "fit to world" map control.
- **Distribution**: approved plugins in the CLI, exporting a subset of a document, presenter tools in exported HTML, bundled fonts to make PDF and video identical across machines, faster video capture.
- **Formats**: AVIF and FLAC assets (evaluated for 1.0, see above); embeds that need scripts, isolated on a separate origin.
- **impress.js import**: `data-rel-position="relative"`, goto-plugin branches as XCursus choices, substeps once progressive builds exist, Markdown steps of the extras.
- **Toolchain**: accept a range of Node and pnpm versions instead of exact pins; move the ESLint toolchain past the `minimatch` advisory (development only).

Out of scope for 1.0, as listed in the [specification](SPECIFICATION.md#non-goals-for-10): collaborative cloud editing, accounts, a WebGL renderer, full 3D gizmos and real-time audio sync.
