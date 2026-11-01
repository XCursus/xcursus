# Roadmap

XCursus is at **0.6**, a pre-release. Releases 0.1 to 0.6 were published under the name SpatialDeck; the product, packages and native file format were renamed to XCursus after 0.6 (see [FILE_FORMAT](FILE_FORMAT.md#legacy-spatialdeck-archives) for compatibility). The next milestone is **1.0 Stabilization**.

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

Scope:

- **impress.js import**: `xcursus convert impress` producing a candidate project and a report, with the mapping and diagnostics described in the [specification §9](SPECIFICATION.md#9-impressjs-import-planned).
- **Hardening**: fuzzing of the ZIP parser and of the sanitization policies; review of the offline signal used by plugins; the known issues below.
- **Browser matrix**: real Chrome, Edge and Safari according to the support policy, touch devices and a screen reader, recorded with versions.
- **Performance**: the budgets of the [specification §12](SPECIFICATION.md#12-tests-ci-and-budgets) measured on a controlled machine, and a justified threshold for the realistic consumer.
- **Project documents**: CHANGELOG, CONTRIBUTING and SECURITY policy.
- **Release candidate** with schema 1.3.0 unchanged unless a schema change is explicitly decided.

### Exit criteria

1.0 is declared only when every criterion is met with recorded evidence; otherwise a candidate is prepared with a documented list of blockers.

- [ ] Player independent of editor and React; editor without competing math or rendering.
- [ ] Historical fixtures of every schema version migrate without loss or rendering differences.
- [ ] Canvas layout, theme and token styles verified in the player, Studio and every export; reading order and drag alternative tested.
- [ ] Branch, loop, history and interruption navigation, hierarchies and keyframes verified.
- [ ] Builtin content, sanitization and trust model documented and tested, including fuzzing.
- [ ] JSON, archive and recovery verified with real files, quota errors and missing assets.
- [ ] Embed, offline HTML, PDF and video produced and inspected, with accurate manifests.
- [ ] Presenter with no notes in the audience view and with a pop-up fallback.
- [ ] Essential impress.js import with mapping and warnings, without claims of full compatibility.
- [ ] Browser matrix: Chromium, Firefox and WebKit automated; real Chrome, Edge and Safari, touch and screen reader checks recorded or listed as blockers.
- [ ] Budgets measured with hardware, browser and build recorded.
- [ ] Complete CI, installable packages, public types, licences and attributions, reproducible documentation.
- [ ] No known unresolved P0 or P1 issue, data loss or security risk; backlog classified.

### Before publishing packages

The packages are `private` and unpublished. Publishing to npm requires confirming ownership of the `@xcursus` scope (the registry returned 404 for the scope and its packages on 1 November 2026, so ownership cannot be verified yet) and an explicit decision to publish.

## Known issues

Defects found by testing that are still open, by severity (P1 blocks an intended use or shows wrong data; P2 has a workaround; P3 is polish).

| Severity | Issue                                                                                                                                                                                                      |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1       | The export profile applies to the whole document: content the itinerary never visits (an embed, a plugin, an audio block) still blocks a strict PDF or video.                                              |
| P1       | Exported HTML and static builds have no on-screen previous/next buttons, tap or swipe navigation, or full-screen control; without a keyboard only the text view is usable.                                 |
| P1       | Firefox does not paint child scenes inside a large rotated parent scene (observed with an 8400×5600 parent rotated 12° on X); hit-testing still finds them. Smaller or unrotated parents are not affected. |
| P2       | In the PDF, scenes with a world rotation are rasterized even when the camera frames them head-on, so their text is neither selectable nor searchable and files grow large.                                 |
| P2       | Pressing **Next** during a long camera track restarts it from its first keyframe; repeated presses lengthen the transition.                                                                                |
| P2       | At the maximum of 1000 scenes the exported HTML takes several seconds to become ready, the overview about 2 s, and selecting a scene in Studio 1–3 s; the Paths tab creates a very large DOM.              |
| P3       | Studio logs CSP reports in the console whenever it parses HTML that contains inline `style` or `on*` attributes (removed by the sanitizer), which can hide other errors.                                   |

## Backlog

Planned improvements without a committed release:

- **Time inside scenes**: progressive builds of blocks, cues with a builtin visible or audible effect, synchronizing audio with camera tracks.
- **Camera authoring**: capturing the current view as a pose, a visual timeline or curve editor, a graph view of paths.
- **Typography and style**: larger size steps and per-block font, background, border and padding tokens; taller images in flow scenes.
- **Sanitization for diagrams**: a reviewed extension of the SVG allowlist (font attributes, dash arrays, markers, opacity, `preserveAspectRatio`) and of table formatting in HTML.
- **Structure**: block groups, scene templates or sections, a hierarchical scene list and a "fit to world" map control.
- **Distribution**: approved plugins in the CLI, exporting a subset of a document, presenter tools in exported HTML, bundled fonts to make PDF and video identical across machines, faster video capture.
- **Formats**: AVIF, FLAC and MOV assets; embeds that need scripts, isolated on a separate origin.
- **Toolchain**: accept a range of Node and pnpm versions instead of exact pins.

Out of scope for 1.0, as listed in the [specification](SPECIFICATION.md#non-goals-for-10): collaborative cloud editing, accounts, a WebGL renderer, full 3D gizmos and real-time audio sync.
