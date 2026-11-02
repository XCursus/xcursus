# CLI, export and presentation

This guide covers how an XCursus project leaves the editor: the `xcursus` command line (including the impress.js import), the standalone offline HTML, the static web build, the PDF and the minimal WebM video of an explicit itinerary, the npm packages, the presenter view and the offline Studio shell. Every output is rendered by the same DOM/CSS 3D player; there is no second renderer. How these outputs are tested, and their known limits, is in [VERIFICATION](VERIFICATION.md#exports-and-cli).

## Running the CLI

From the repository (Node 24.22.0, pnpm 12.14.0):

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm xcursus --help
pnpm xcursus validate examples/distribution-static/project.json
pnpm xcursus pack examples/distribution-static/project.json --out deck.xcursus
pnpm xcursus export html examples/distribution-static/project.json --out deck.html
pnpm xcursus build examples/distribution-static/project.json --out site
pnpm xcursus export pdf examples/distribution-static/project.json --itinerary examples/distribution-static/itinerary.json --out deck.pdf
pnpm xcursus export video examples/distribution-static/project.json --itinerary examples/distribution-static/itinerary.json --fps 30 --out deck.webm
pnpm xcursus convert impress examples/impress-import/deck.html --out deck.json --profile bundle
```

`pnpm xcursus` runs `packages/cli/dist/cli.js`, so it needs `pnpm build` first. Installed from npm (`npm install --global @xcursus/cli`, or `npx @xcursus/cli …`) the binary is `xcursus`.

| Command                                                           | Output                                                                                           | Needs                                                |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------- |
| `validate <project> [--json]`                                     | Diagnostics on stdout (JSON also for a rejected document), exit 0/1                              | Node                                                 |
| `pack <project> --out <file.xcursus>`                             | The authoring project as a `.xcursus` archive: current schema, notes and assets included         | Node                                                 |
| `build <project> --out <dir>`                                     | `index.html`, runtime, styles, fonts, `project.json`, `assets/`, `export-manifest.json`, notices | Node; serve over HTTP(S)                             |
| `export html <project> --out <file>`                              | One self-contained HTML + `<file>.manifest.json`                                                 | Node                                                 |
| `export pdf <project> --itinerary <file> --out <file>`            | One page per visit + manifest                                                                    | Chromium for Playwright 1.64.1                       |
| `export video <project> --itinerary <file> --fps 30 --out <file>` | WebM without audio + manifest                                                                    | Chromium, `ffmpeg` and `ffprobe` with a WebM encoder |
| `convert impress <input.html> --out <project.json\|file.xcursus>` | Candidate project with its local assets + `<out>.report.json`; see [IMPRESS](IMPRESS.md)         | Node                                                 |

`<project>` is a project JSON, whose assets are resolved inside its own directory, a `.xcursus` archive or a legacy `.spatialdeck` archive saved by SpatialDeck, the former name of XCursus (read only, see [FILE_FORMAT](FILE_FORMAT.md#legacy-spatialdeck-archives)). Exit codes: **0** success (warnings allowed), **1** invalid project, itinerary or capability, **2** missing environment (Chromium, FFmpeg), **3** write or export failure. An existing output needs `--overwrite`; a build directory is replaced only if it holds a previous `export-manifest.json`. Files are written to a temporary sibling and renamed atomically; a failed export leaves no output. Tools run with an argument vector, never through a shell. Nothing is installed automatically: `npx playwright@1.64.1 install chromium` (or `pnpm exec playwright install chromium` here) and FFmpeg come from the user. `XCURSUS_FFMPEG` and `XCURSUS_FFPROBE` select specific binaries (the former `SPATIALDECK_FFMPEG` and `SPATIALDECK_FFPROBE` are still read as a fallback).

`pack` is the authoring counterpart of the exports: it keeps private notes and extensions, refuses a project with a missing or invalid asset, requires an output ending in `.xcursus` and never replaces its own input. It is the command-line way to convert a JSON project or a legacy archive to the native format:

```sh
pnpm xcursus pack old-deck.spatialdeck --out deck.xcursus
```

`validate --json` reports `kind` (`json` or `archive`), `archiveFormat` (`current` or `legacy`) for archives, the current `schemaVersion` and the `sourceSchemaVersion` declared by the file.

Options: `--allow-partial` (placeholders, status `partial`), `--reduced-motion` (PDF/video planned without transitions), `--lang en|it` (player interface texts; default from `metadata.language`), `--frames <empty dir>` (video: keep the captured PNG frames).

## Inputs and confinement

- Project JSON: validated and migrated in memory to 1.3.0; the file is never rewritten. Asset paths must be safe relative paths (no `..`, absolute, encoded or backslash paths) and may not go through a symbolic link anywhere below the project directory. Each file is checked against the declared size, MIME signature and SHA-256 when declared; the manifest records the computed digest.
- Archive (`.xcursus` or legacy `.spatialdeck`): the same reader as Studio (`readArchive`): central/local header coherence, CRC, digests, limits after inflation, no traversal, no links. The archive is only read.
- Limits: JSON 10 MiB, 50 MiB per asset, 200 MiB in total, itinerary 1 MiB and 500 visits.

## Profiles

Exports are **strict** by default. A blocking finding fails with exit 1 and writes nothing; `--allow-partial` replaces the content with a visible placeholder ("Content unavailable (type)") and records it in `warnings` and `unsupported`.

For PDF and video the profile applies to the scenes the itinerary visits, which are the subject of the pages and frames. Content outside the profile in scenes the itinerary never visits (an embed, a plugin, an audio block in a skipped branch) does not refuse a strict export: it becomes the same placeholder, in case the scene appears in the background of a frame, and is listed in `warnings` (`OUTSIDE_ITINERARY`) and in `unsupported` with the reason "scene not visited by the itinerary". Missing assets of those scenes are warnings too. The HTML and the static build present every scene, so for them the whole document counts.

| Content                                                                                                                                                                         | HTML / build                                                       | PDF                                          | Video                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------- | -------------------------- |
| text, Markdown, HTML, SVG, LaTeX, image                                                                                                                                         | yes                                                                | yes                                          | yes                        |
| link                                                                                                                                                                            | yes, interactive                                                   | static text (warning `LINK_STATIC`)          | static text                |
| audio                                                                                                                                                                           | yes, local file                                                    | placeholder (warning `AUDIO_EXCLUDED`)       | blocking (`MEDIA_PROFILE`) |
| video                                                                                                                                                                           | yes, local file, poster, captions                                  | poster image or placeholder (`VIDEO_POSTER`) | blocking (`MEDIA_PROFILE`) |
| embed                                                                                                                                                                           | blocking (`EMBED_REMOTE`)                                          | blocking                                     | blocking                   |
| plugin                                                                                                                                                                          | blocking (`PLUGIN_UNAVAILABLE`): the CLI registers no plugin       | blocking                                     | blocking                   |
| remote resource in markup (`<link>`, remote `src`, frames, remote Markdown image; `@import` and remote `url()` inside `<style>` or a `style` attribute; never in Markdown code) | blocking (`REMOTE_RESOURCE`); the sanitizer would remove it anyway | blocking                                     | blocking                   |
| missing or invalid asset used by the output                                                                                                                                     | blocking (`ASSET_MISSING`, `ASSET_DIGEST`, …)                      | blocking                                     | blocking                   |
| cues                                                                                                                                                                            | emitted by the live player                                         | ignored (`CUES_IGNORED`)                     | ignored                    |

Private scene notes are removed from every output (`publicDocument`); the manifest says `"privateNotes": "excluded"`. The authored project keeps them.

PDF and video fail with exit 3 on any error of the capture page and on any Content Security Policy violation, with one exception: Chromium reports the inline `style` and `on*` attributes of HTML or Markdown (typically pasted from an editor) while the sanitizer parses the source, before it removes them. They never reach the output, so they are counted in the warning `CSP_ATTRIBUTE_BLOCKED` (severity `warning`; the status does not change). Violations are read from the standard `securitypolicyviolation` event, not from console text.

## Standalone HTML

One file with the export runtime (a classic IIFE script built from the published player and plugins ESM), the player and KaTeX stylesheets with their woff2 fonts as `data:` URLs (one format, only the stylesheets the document needs), the public project JSON and the verified assets as base64 data blocks turned into `Blob` URLs at run time. A `<noscript>` outline lists the titles and accessible texts of the default path. Third-party licences are embedded in `<template id="xcursus-notices">`; the header comment states the GPL-3.0-or-later licence of the runtime and the source repository.

Content Security Policy (meta element):

```
default-src 'none'; script-src 'sha256-…'; style-src 'sha256-…'; img-src blob:; media-src blob:;
font-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none';
base-uri 'none'; form-action 'none'
```

**KaTeX inline styles:** no `'unsafe-inline'` for styles. KaTeX formulas are built with `katex.render`, which creates DOM nodes and assigns its positioning styles through CSSOM properties; CSP governs parsed `style` attributes and `<style>` elements, not CSSOM, and the player already applies transforms and theme tokens through CSSOM. The previous `renderToString` + `innerHTML` sink is gone. Two KaTeX features set a `style` attribute on MathML nodes with `setAttribute` (`\pmb` and `\fcolorbox`); under this CSP those attributes are blocked and reported, with no visual effect because the MathML copy is visually hidden. They are not used by the fixtures.

Navigation without a keyboard: the page shows **Previous** and **Next** buttons (44 px targets, disabled when there is no previous visit or no connection from the current scene), a **Full screen** button where the browser allows it, and a horizontal swipe on touch screens moves to the next or previous visit (a mouse drag keeps selecting text; links, buttons, media and the player controls keep their own gestures). The keyboard, the text view and the player controls work as before. The texts follow `--lang` (English or Italian). The static build has the same controls.

Studio writes the same file: see [Export from Studio](#export-from-studio).

The JSON blocks escape `<`, `>`, `&`, U+2028 and U+2029, so a `</script>` in the content stays text; the inline runtime has every `</script` and `<!--` rewritten to `\x3C…`. The file opens from `file://` with the network disabled. Size target: 25 MiB (warning `HTML_SIZE` above). `file://` has no reliable origin: the presenter view is not available there (single window only).

## Export from Studio

**Export** in the Studio toolbar opens a panel with two parts.

- **Standalone HTML** is written in the browser by the same pipeline as `xcursus export html` (`@xcursus/cli/html`): same profile and strict refusal, same placeholders with **Replace unsupported content with placeholders**, same CSP, notices and self-checks, same interface languages. The assets held by Studio are verified against their declared size, MIME signature and digest first. Only the generator named in the header comment and the `generator` meta differs (`XCursus Studio` instead of `XCursus CLI`); the E2E suite compares the two files byte for byte. The runtime, its notices and the stylesheets with inlined fonts come from `export-kit.json`, written at build time from the built CLI and precached by the offline shell, so the export works offline too. The panel names every refused item; no manifest is written (use the CLI for one).
- **PDF and video** need Chromium and FFmpeg, so they stay on the command line. The panel saves the archive (**Save archive**) and proposes an itinerary for the chosen path (**Download itinerary**): from the start scene it follows the only transition of each scene and stops before a scene already visited, saying so; a scene with several transitions is a choice, so no itinerary is proposed and the file has to be written by hand. The panel then shows the two commands with the saved file names, ready to copy.

## Static build

`index.html` with `script-src 'self'`, `style-src 'self'`, `font-src 'self'` and `connect-src 'self'`: the runtime fetches `project.json` and the assets listed in a data block, verifies them like the archive reader and plays. Fonts are files. Serve it over HTTP(S); `fetch` from `file://` is not supported by browsers. `THIRD_PARTY_NOTICES.txt` sits next to the runtime.

## Itinerary

```json
{
  "pathId": "main",
  "visits": [{ "nodeId": "n1" }, { "nodeId": "n2" }, { "nodeId": "n3" }]
}
```

At most 500 visits, finite, with explicit repetitions for loops. Consecutive visits must be connected by an edge of the path; `edgeIdToNext` is required when several edges join the same nodes and must be absent on the last visit. Visit limits (`loopPolicy`, `visit-limit`) are checked with the runtime rule. The first visit is placed without transition; the total is the sum of every `holdMs` plus the edges between visits. A track starts from the previous arrival pose, never from its saved first keyframe, and its endpoint is the arrival pose. Core API: `validateItinerary`, `firstPassItinerary` (the itinerary Studio proposes), `planCapture`, `sampleCapture`, `frameSchedule` (see [API](API.md#capture)).

## PDF

Chromium for Playwright 1.64.1, viewport equal to the document viewport, DPR 1. For each visit the player renders the arrival pose with `renderAt` (renderers, fonts and two paints ready) and Chromium prints that single page; the pages are then joined with pdf-lib without re-rendering. Printing several 3D-transformed pages in one Chromium document misplaced the content, so a per-visit print is used. Text of a frontal scene stays vector text; Chromium may rasterise layers seen in perspective. A flow scene does not grow: when its content is taller than the scene, the page shows only what fits and the manifest gets the warning `CONTENT_OVERFLOW` for that scene. Page size: the viewport in CSS pixels (1280×720 → 960×540 pt). The CLI counts pages and page boxes in its own output and refuses a mismatch.

## Video

Only the static profile: text, Markdown, HTML, SVG, LaTeX, images, links as static text and camera transitions; no audio track. N = ceil(totalMs × fps / 1000) frames at t = i × 1000 / fps (i = 0…N−1), rendered with `renderAt` and captured as PNG, then encoded by FFmpeg with the first WebM encoder listed by `ffmpeg -encoders` among libvpx-vp9, libvpx (VP8), libsvtav1 and libaom-av1, single-threaded with bitexact flags. `ffprobe` counts the frames and reads the duration: the export fails unless the count is N, the duration N / fps within one frame and the size the viewport. The exact end instant is not a frame: give the last visit a hold of at least one frame to show its arrival pose (warning `FINAL_HOLD_SHORT` otherwise). The plan fixes reduced motion (`--reduced-motion` re-plans without transitions), independently of the capturing browser. Same environment, same frames: the manifest records a digest of all PNG frames. Animated images (GIF with several frames, APNG, animated WebP) would play on the wall clock, so PDF and video capture them as their first frame and the manifest records `ANIMATION_FROZEN`. H.264 is not offered; the FFmpeg binary is not distributed. Codec licences: libvpx and the AV1 encoders are BSD-licensed and royalty-free; the FFmpeg build itself is the user's.

## ExportManifest

```
{ format, status: complete|partial, toolVersion, schemaVersion, source, itinerary?, profile,
  privateNotes: "excluded", resources: [{id, kind, path?, mime?, byteLength?, sha256, status}],
  licenses, warnings, unsupported, environment, verification, output: {file, byteLength, sha256} }
```

`verification` lists only checks the run performed on its own output: parsed JSON blocks, CSP hashes and absence of notes (HTML); file digests (build); page count, page boxes and the rendered pose matrix against the sampler (PDF); ffprobe frames, duration and size and the pose matrix (video). It never claims an offline test: that is the E2E suite's job.

## Packages

| Package                   | Contents                                                                            | Third-party code                                                                                                          |
| ------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `@xcursus/core`           | ESM, types, JSON Schemas                                                            | imports `gl-matrix`, Ajv runtime helpers                                                                                  |
| `@xcursus/player`         | ESM, types, `style.css`, `fonts.css` + woff2/OFL, `presenter` subpath, `iife` build | IIFE embeds core, gl-matrix, Ajv runtime: `dist/iife/THIRD_PARTY_NOTICES.txt`                                             |
| `@xcursus/plugins`        | ESM per entry, lazy rich/media chunks, `style.css` (KaTeX, woff2 files + licence)   | imports DOMPurify, marked, KaTeX, fflate                                                                                  |
| `@xcursus/editor`         | ESM, types, `style.css`; React `^19.3.1` peers                                      | none                                                                                                                      |
| `@xcursus/cli`            | Node ESM, `xcursus` bin, export runtime, browser-safe `html` subpath                | runtime embeds player, renderers, DOMPurify, marked, KaTeX, Ajv, gl-matrix, fonts: `dist/runtime/THIRD_PARTY_NOTICES.txt` |
| `@xcursus/impress-compat` | ESM, types; no DOM, network or file system                                          | imports parse5 (MIT, with entities BSD-2-Clause) and gl-matrix                                                            |

The npm scope is `@xcursus`. Every manifest has `license: GPL-3.0-or-later`, description, repository, homepage, keywords, `sideEffects`, `engines` and a README; `pnpm pack` adds the repository `LICENSE`. Internal dependencies become the same version in the tarball. A build plugin fails if a library chunk contains a module from `node_modules`; IIFE builds generate their notice file from the bundled modules and fail on a missing or incompatible licence. The packages are published on npm. Scope ownership is settled: since 2 November 2026 the `xcursus` organization exists on npm, with the maintainer account `fv-c` as owner (`npm org ls xcursus`), and the five packages of 0.6 are published at 0.6.0. `@xcursus/impress-compat` is new in the 1.0 candidate and not published yet; `@xcursus/cli` depends on it, so it is published right after the core. The manifests no longer carry `"private": true` and set `"publishConfig": {"access": "public"}` (scoped packages are private by default on npm); `check:packages` verifies both in every tarball. Publishing a release is an explicit maintainer step, never done by the build, the tests or CI. Use `pnpm publish`, not `npm publish`: pnpm turns the `workspace:*` dependencies into the release version and runs the `prepack` script that copies `LICENSE`. Publish in dependency order after `pnpm build` and `pnpm check:packages`, from a machine signed in with `npm login` (the account asks for a two-factor code on every write):

```sh
for p in core impress-compat player plugins editor cli; do (cd packages/$p && pnpm publish); done
```

Inside this repository the packages resolve as workspace packages; `pnpm pack` produces the same tarballs that are published.

`pnpm check:packages` packs the six packages, installs the tarballs in `test-results/packages/consumer` (own pnpm workspace, packages from the local store when present and registry metadata only when missing, third-party runtime dependencies pinned to the repository lockfile versions, no source aliases), type-checks without `skipLibCheck`, builds a minimal and a realistic consumer and measures them; the E2E suite serves that consumer and runs the CLI installed from its tarball.

## Presenter view (Studio)

**Presenter** in the Studio toolbar opens the audience window (`present.html`, a page without React) on the click and turns Studio into the presenter console: current scene, next visit preview or branch choices, private notes, a monotonic timer (start, pause, reset) and navigation. The console is the only navigation authority; keys, outline and choices in the audience window become requests to it. Messages use `postMessage` between opener and popup with origin and source checks, a random 128-bit session ID, a strict schema and increasing sequence numbers per page load. The console also probes the popup with a random nonce that the audience window repeats in its messages: after the presenter tab reloads, WebKit reports the wrong `event.source` and only a reference found again by window name can reach the audience window, so **Resume presenter view** finds the window by name on the click and the nonce proves the replies come from it. A reloaded audience window or presenter tab resynchronizes from a snapshot of the public document (notes removed) and the resource blobs. Previews are muted; audio plays only in the audience window. A blocked popup shows instructions, a retry and a single-window presentation. **Full screen** in the audience window and **Present** request the browser fullscreen on the user's gesture. Limits: no guarantee against operating-system mirroring; multi-display placement is the browser's; full support needs a local host or HTTPS (not `file://`).

## Offline Studio shell

The production Studio registers a versioned service worker (`sw.js`, generated at build time with the list of built files). After the first load the shell works offline and projects reopen from IndexedDB. A new version installs in the background and waits: a notice offers **Update and reload**, which first flushes unsaved work to local recovery; only then the new worker activates and deletes older `xcursus-studio-*` caches (and the `spatialdeck-studio-*` caches of releases made under the former name), never other caches or IndexedDB data. The player, the playground and the exported HTML do not use the worker. Development (`pnpm dev:studio`) never registers it.
