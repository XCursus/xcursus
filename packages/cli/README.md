# @xcursus/cli

Command line of [XCursus](https://github.com/XCursus/xcursus): validate projects, pack them as `.xcursus` archives, build static bundles and export a standalone offline HTML, a PDF and a minimal WebM video from an explicit itinerary. It reuses core for validation and the published player for every rendering and capture; no editor or React.

```sh
xcursus validate project.json --json
xcursus pack project.json --out deck.xcursus
xcursus build project.json --out site
xcursus export html deck.xcursus --out deck.html
xcursus export pdf project.json --itinerary itinerary.json --out deck.pdf
xcursus export video project.json --itinerary itinerary.json --fps 30 --out deck.webm
xcursus convert impress deck.html --out deck.json --profile bundle
```

- Inputs: a project JSON (assets resolved inside its directory, no traversal or symbolic links), a `.xcursus` archive or a legacy `.spatialdeck` archive (read only; `pack` converts it to `.xcursus`).
- Strict by default: embeds, plugins, remote resources and media outside a format profile fail with exit 1; `--allow-partial` writes placeholders and a manifest with status `partial`.
- Every output has an `ExportManifest` (`<out>.manifest.json`, or `export-manifest.json` in a build) with resources, digests, licences, warnings, environment and the checks actually run. Private notes are never exported.
- Outputs are written through a temporary file and an atomic rename; an existing output needs `--overwrite`.
- PDF and video need Chromium for Playwright 1.64.1 (`npx playwright@1.64.1 install chromium`); video also needs `ffmpeg` and `ffprobe` with a WebM encoder (VP9 preferred). Nothing is installed automatically; a missing tool exits with 2.
- `convert impress` parses an impress.js HTML file without running it (`@xcursus/impress-compat`), reads only the local files it references inside its folder and writes a candidate project (JSON with its assets, or `.xcursus`) plus `<out>.report.json` with every finding. See [IMPRESS.md](https://github.com/XCursus/xcursus/blob/main/docs/IMPRESS.md).
- Exported HTML and static builds have on-screen previous/next buttons, touch swipes and a full-screen button besides the keyboard.
- Exit codes: 0 success, 1 invalid project/itinerary/capability, 2 missing environment, 3 write or export failure.

`@xcursus/cli/html` exports the standalone HTML pipeline without Node APIs (`standaloneHtml`, `verifyResources`, the `ExportKit` type); XCursus Studio uses it, so its HTML export is the same file.

The export runtime (`dist/runtime/xcursus-runtime.js`) embeds the player and its third-party code; licences in `dist/runtime/THIRD_PARTY_NOTICES.txt`, also embedded in every HTML export. Install with `npm install --global @xcursus/cli` (or run `npx @xcursus/cli`). Licence: GPL-3.0-or-later. Formats and limits: [DISTRIBUTION.md](https://github.com/XCursus/xcursus/blob/main/docs/DISTRIBUTION.md).
