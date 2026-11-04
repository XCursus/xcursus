# Release blockers for 1.0

XCursus 1.0 is declared only when every [exit criterion](ROADMAP.md#exit-criteria) is met with recorded evidence. The work of 1.0 Stabilization is implemented and tested (see [VERIFICATION](VERIFICATION.md)); the items below are what is still missing. Until they are closed the repository holds a **1.0 candidate**, a pre-release, with the packages at 0.6.0. State on 4 November 2026.

Priorities: **P1** prevents declaring 1.0 (a criterion without evidence, or a defect that blocks an intended use); **P2** must be closed or explicitly accepted before 1.0.

## B1 · P1 · Real Safari, two latest versions

- **Missing evidence:** no suite or manual check has run in an installed Safari. Playwright WebKit (26.5 build, macOS 14 runner 1.61.1) passes every suite, but it is not Safari.
- **Reproduction:** Safari 26.5.2 is installed on the development Mac, but WebDriver automation needs _Allow Remote Automation_ in Safari's Develop settings and `safaridriver --enable`, a system setting the maintainer has to change. The previous major version of Safari is not available on that machine.
- **Impact:** the support policy (specification §11) names the last two stable Safari versions; Safari-specific CSS 3D, fullscreen, file-input and IndexedDB behaviour is not proven.
- **Closing criterion:** the [manual checklist](#manual-checklist) passed in the two latest stable Safari versions on macOS, versions and results recorded in VERIFICATION, or an automated WebDriver run of the browser suites with the same coverage.

## B2 · P1 · Real Edge, Firefox and the previous Chrome

- **Missing evidence:** Microsoft Edge and a release build of Firefox are not installed on the development machine. Google Chrome 156.0.8078.79 is installed and passed the full browser suite (`pnpm test:e2e:chrome`: 101 passed, 0 failed, skipped or flaky); the previous stable Chrome (155) was not run. Playwright's Firefox 157 build passes every suite but is Playwright's patched build.
- **Impact:** the policy names the last two stable versions of Chrome, Edge, Firefox and Safari.
- **Closing criterion:** the browser suites (Playwright channels `chrome`, `msedge`, or the manual checklist for Firefox) passed in the two latest stable versions of each, with versions recorded.

## B3 · P1 · Touch devices

- **Missing evidence:** no iPhone, iPad or Android device was available; only an Android 15 tablet emulator is installed, and it was not run. Touch navigation of the exported HTML (swipe, 44 px buttons) is tested with synthesized pointer events only.
- **Impact:** the matrix includes Safari on iOS/iPadOS and Chrome on Android for presenting and the outline.
- **Closing criterion:** the touch part of the [manual checklist](#manual-checklist) on a current iPad or iPhone (Safari) and an Android device (Chrome), with device, OS and browser versions recorded. An emulator run may be recorded as additional evidence, labelled as such.

## B4 · P1 · Screen reader

- **Missing evidence:** axe reports no serious or critical violation in the playground, Studio (including the import and export dialogs) and the exported HTML in three engines, but no manual screen reader test has been done. axe is not a screen reader test.
- **Closing criterion:** the screen reader part of the [manual checklist](#manual-checklist) with VoiceOver and Safari on macOS and NVDA with Firefox or Chrome on Windows, findings fixed or recorded with a severity.

## B5 · P1 · Firefox painting of children inside a large rotated parent

- **Defect:** observed in October 2026 with the stress deck `examples/stress-temporal-system`: Firefox did not paint the child scenes of `sec-gerarchia` (8400×5600, rotated 12° on X); hit-testing still found them. Chromium and WebKit paint them.
- **Reproduction:** open `examples/stress-temporal-system/project.json` in the playground or Studio in Firefox and navigate to a child of `sec-gerarchia`. A minimal probe on 2 November 2026 (one parent of the same size and rotation, one coplanar child, camera on the child, headless Playwright Firefox 157) painted the child correctly, so the trigger is not the size and rotation alone; the player already places every scene as a direct child of the world with its own world matrix, so it is not DOM nesting.
- **Impact:** wrong rendering (missing content) in a supported browser for a valid document.
- **Closing criterion:** reproduce with the stress deck in headed Firefox, isolate the condition, then fix it or apply a tested mitigation, with a regression test in the Firefox suite.

## B6 · P2 · Performance gate on a controlled machine

- **Evidence so far:** `pnpm benchmark` on the reference scenario (100 scenes × 10 text blocks of 100 characters, 1280×720, DPR 1, production build, 5 warm-ups + 20 runs) on an Apple M3 Max, 64 GiB, macOS 14.8.7, **on battery**, with other applications open. All budgets met with margin (Chromium 156 / Firefox 157 / WebKit 26.5 builds of Playwright, headless): validation p95 13.4 / 11.8 / 12.0 ms; mount-ready p95 329 / 416 / 236 ms; input → preview p95 53 / 32 / 33 ms; frame interval p95 16.7 / 16.7 / 18.0 ms over 10 transitions; no long task (observable in Chromium only); 50 mount/destroy cycles with zero owned resources in every engine and a heap delta of 0.05 MiB after GC (Chromium only). Raw samples in `test-results/benchmark/`.
- **Missing:** the specification requires the gate to run on a controlled machine (on mains power, idle, fixed browser builds); this run is informative.
- **Closing criterion:** `pnpm benchmark --gate` in Chromium, Firefox and WebKit on a controlled machine, results recorded with the environment.

## B8 · P1 · Linux CI run of the candidate

- **Missing:** every check of this candidate ran on macOS 14 (arm64). The CI workflow runs the same suite on Linux, including the new impress.js, fuzzing and accessibility tests, but needs a push.
- **Closing criterion:** a green run of `.github/workflows/ci.yml` on the candidate commit, with `git diff --exit-code` passing.

## Closed

- **B7 · Security reporting channel** (closed 4 November 2026): GitHub's private vulnerability reporting, the channel named in [SECURITY.md](../SECURITY.md), is enabled on `XCursus/xcursus` (`GET /repos/XCursus/xcursus/private-vulnerability-reporting` returns `{"enabled": true}`; it returned `false` on 2 November).

## Not blocking, recorded

- **Development tooling advisory:** `pnpm audit` reports one moderate advisory (GHSA-g3hv-75wg-m249, `minimatch` < 11.0.1) reachable only through ESLint and typescript-eslint; `pnpm audit --prod` finds no known vulnerability in shipped code. Move the lint toolchain past it when compatible releases exist.
- **P2 and P3 known issues** of the [roadmap](ROADMAP.md#known-issues) (PDF rasterization of rotated scenes, a long camera track restarted by Next, the 1000-scene ceiling, CSP console noise in Studio) have workarounds and are classified backlog.

## Manual checklist

For each browser and device, record the version and the outcome of every line.

1. **Player** (`pnpm dev:playground`, `/core` and `/layout`): the first scene is framed; arrows, Page Up/Down and Space navigate only when the player has focus; Text view lists the path and navigates without motion; Reduce motion makes transitions instant.
2. **Studio** (`pnpm dev:studio`): open `examples/layout-canvas/layout-canvas.xcursus`; move a scene on the map and undo; edit a block in the scene editor; Save archive, reload, reopen it; Recovery offers nothing after saving.
3. **impress.js import**: Import impress.js with `examples/impress-import/deck.html` and its two images; the review lists the findings; Open candidate shows six scenes with both images.
4. **Exported HTML** (`pnpm xcursus export html examples/distribution-static/project.json --out deck.html`, opened from disk with the network off): Previous, Next and Full screen work; formulas, images and the theme font render.
5. **Presenter**: Presenter opens the audience window; notes stay in the console; navigation from either window stays in sync; with pop-ups blocked the single-window fallback appears.
6. **Touch** (tablets and phones): in the exported HTML a horizontal swipe moves to the next and previous visit, buttons are easy to hit, the outline is readable at 320 px width; Studio opens a project and presents it.
7. **Screen reader**: the player announces the scene title after each move and the choices of a branch; the outline is a navigable list; Studio's toolbar buttons, dialogs (delete, export, import) and inspector fields have names, and focus returns to the opener after a dialog closes.
