# Project files and the `.xcursus` format

An XCursus project exists in two authoring representations:

| Representation  | Contents                                                           | Typical use                                                        |
| --------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Project JSON    | The document only; assets are referenced by relative path          | Version control, diffs, hand editing, the static build input       |
| `.xcursus` file | A ZIP archive with the document, every asset and a digest manifest | The portable native format: one file that reopens anywhere offline |

The JSON document is canonical: the archive carries exactly the same document, so a project can move between the two forms without loss. Distribution formats (standalone HTML, static build, PDF, WebM) are separate outputs described in [DISTRIBUTION](DISTRIBUTION.md); they drop private notes and are not meant to be reopened for editing.

## The project document

`ProjectDocument` is pure JSON: no functions, dates, DOM nodes, temporary URLs or Blobs. Identifiers match `[A-Za-z0-9_-]{1,96}` and are unique within their collection; references are explicit IDs, never array positions. Editor state (selection, map view, undo history) and player state (current visit, camera) are never written into the document. The complete contract, including semantic rules that a JSON Schema cannot express, is in the [specification](SPECIFICATION.md#3-document-versions-and-contracts).

### Schema versions

Every document declares `schemaVersion`. The current version is **1.3.0**; earlier versions are read and migrated.

| `schemaVersion` | Introduced with | Adds                                                                                  | Capability that marks its use |
| --------------- | --------------- | ------------------------------------------------------------------------------------- | ----------------------------- |
| `1.0.0`         | 0.1             | Flat scenes, text blocks, linear paths expressed as nodes and edges                   | `linear`                      |
| `1.1.0`         | 0.3             | Scene parents, branching graphs, node cameras, camera tracks, declarative cues        | `structure`                   |
| `1.2.0`         | 0.4             | Eleven block types, assets, plugin blocks and plugin settings                         | `blocks`                      |
| `1.3.0`         | 0.5             | Canvas scenes with block frames, document theme, scene appearance, block style tokens | `layout`                      |

`requiredCapabilities` lists the capabilities a document actually uses. A reader accepts only versions it has a schema and a migration for: a future version is rejected without changes, never read optimistically.

The JSON Schemas ship with `@xcursus/core`: `@xcursus/core/schema` is the current one, `@xcursus/core/schema/1.0.0` … `/1.3.0` are the versioned files (`packages/core/schema/`). Their `$id` is `urn:xcursus:project:<version>`; documents do not reference it.

### Migration

`validateDocument` and `migrateDocument` accept every supported version and return a **new** document at the current version, applying `1.0.0 → 1.1.0 → 1.2.0 → 1.3.0` with validation before and after:

- `1.0.0 → 1.1.0` adds `parentId: null` to scenes and empty `cameraTracks` and `cues`; paths and text are unchanged.
- `1.1.0 → 1.2.0` keeps text blocks unchanged and adds empty `pluginSettings`.
- `1.2.0 → 1.3.0` adds the default theme, `layout: "flow"` and the default appearance to every scene; blocks are unchanged and the rendering is identical.

A migration never enables a capability the document does not use, never renames IDs and never rewrites the file it was read from. Studio and the CLI migrate in memory; saving writes a new file at the current version.

### Serialization

`serializeDocument` produces deterministic JSON: object keys sorted, arrays in their original order, a final newline. It refuses an invalid document. Unknown extension data (`extensions`, plugin payloads and settings) is kept as opaque JSON and round-trips unchanged. Projects converted from impress.js carry the extension `xcursus.impress` (version `1.0.0`): on the document the upstream baseline, commit, profile and root ID, on each scene the original step ID and its index, used by the impress.js adapter ([IMPRESS](IMPRESS.md)). It is informative and can be removed.

### Project JSON with assets alongside

Asset records hold `{id, path, mime, byteLength, sha256?}`. `path` is a safe relative path (no `..`, absolute, percent-encoded or backslash forms), resolved against the directory of the JSON file. Absolute paths, `file:`, `blob:` and `data:` URLs are never written into a document. When a JSON project is opened in a browser, Studio asks for missing files and checks each one against the declared size, signature and digest before linking it.

## The `.xcursus` archive

A `.xcursus` file is a ZIP archive (`application/zip`) with this layout:

```
project.json                     the document, serialized at the current schema version
assets/<asset id>/<file name>    one entry per asset; the name is normalized to [A-Za-z0-9._-]
manifest.json                    archive manifest, version 1.0.0
```

The manifest lists every asset once:

```json
{
  "version": "1.0.0",
  "assets": [
    {
      "id": "skyline",
      "path": "assets/skyline.svg",
      "entry": "assets/skyline/skyline.svg",
      "mime": "image/svg+xml",
      "byteLength": 510,
      "sha256": "07f2bc7d…"
    }
  ]
}
```

`path` stays the canonical path recorded in the document, so the archived JSON is identical to the JSON saved next to its files; `entry` is the portable location inside the ZIP. Formats that are already compressed (PNG, JPEG, GIF, WebP, MP3, Ogg, WebM, MP4, woff2, ZIP) are stored; text, JSON and SVG are deflated.

### Reading

`readArchive` (`@xcursus/plugins/archive`) is the only reader, shared by Studio, the playground and the CLI. It:

- inspects the central directory and every local header before inflating anything, and requires them to agree on names, sizes, methods and CRCs, with no overlapping, hidden or unindexed data;
- rejects ZIP64, encryption, multi-disk archives, explicit directories, symbolic links, traversal, absolute or backslash paths, percent encoding, non-NFC names and duplicates;
- inflates incrementally and enforces the limits on the actual output: 220 MiB per archive, 10 MiB per JSON entry, 50 MiB per asset, 200 MiB decompressed in total, 10 000 entries;
- validates and migrates `project.json`, then checks every manifest record against the document and every asset against its declared size, MIME signature and SHA-256 digest;
- refuses extra files that the manifest does not declare.

Any failure rejects the whole archive: Studio keeps the current project, the CLI exits with code 1. Nothing is ever extracted to the file system.

The result is the migrated document, the verified asset Blobs and `sourceSchemaVersion`, the version declared by the archived `project.json` before migration.

### Writing

`writeArchive` always writes the current schema version and requires every asset of the document to be present and verified; a missing file is reported by name instead of producing an incomplete archive. It streams the ZIP in 1 MiB chunks and yields to the event loop between chunks, so Studio stays responsive with large media. Entry timestamps record the save time, so two saves of the same project have the same entries and content but not the same bytes.

Producers:

- **Studio**: **Save archive** downloads `<title>.xcursus`.
- **CLI**: `xcursus pack <project> --out <file.xcursus>` writes the project, migrated to the current schema, from a JSON file with its assets, a `.xcursus` or a legacy `.spatialdeck` archive. Private notes and extensions are kept: this is an authoring save, not an export. The output must end in `.xcursus`, an existing output needs `--overwrite`, and the input itself can never be the output.
- **Library**: `writeArchive(document, blobs)` from `@xcursus/plugins/archive`, with `ARCHIVE_EXTENSION` for the file name.

## Legacy `.spatialdeck` archives

XCursus was previously published as SpatialDeck, whose releases 0.4 to 0.6 saved archives with the `.spatialdeck` extension. Those archives use the same container and the same manifest version 1.0.0, so they are read by the same code with the same checks:

| Tool       | Behaviour with a `.spatialdeck` file                                                                                                                                               |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Studio     | **Open** accepts it and shows a notice: the original file is unchanged, and **Save archive** writes a `.xcursus` file.                                                             |
| Playground | **Open local project** / **Open local gallery** accept it.                                                                                                                         |
| CLI        | Every command accepts it as `<project>`. `validate` reports `"archiveFormat": "legacy"` and suggests `xcursus pack`; `pack` converts it to `.xcursus`.                             |
| Library    | `archiveFormat(name)` returns `"current"` for `.xcursus`, `"legacy"` for `.spatialdeck` and `null` otherwise (case-insensitive); `PROJECT_ACCEPT` is the file-input `accept` list. |

What a conversion changes and what it keeps:

- The archive entries, the manifest and the asset bytes are unchanged; only the file extension differs. A document written with an earlier schema version is migrated as described above, exactly as when the same document is opened from JSON.
- Nothing is dropped silently: unknown extensions, plugin payloads and plugin settings round-trip as opaque data, and a block whose plugin is not registered is shown as a placeholder with its data intact.
- The legacy file is only read. No XCursus tool writes `.spatialdeck` files or modifies the file it opened.

Identifiers from the former name that are kept on purpose:

- **Demo plugin ID.** The demo badge plugin is now `org.xcursus.badge`. Studio and the playground also register it under its former ID `org.spatialdeck.badge` (`LEGACY_SAMPLE_PLUGIN_ID`), so earlier documents that use it still render. Plugin IDs are document data and are never rewritten.
- **Studio local storage.** The IndexedDB database keeps the name `spatialdeck-studio`, so autosaved revisions made before the rename stay available for recovery.
- **Offline shell.** The Studio service worker deletes the `spatialdeck-studio-*` caches of earlier releases on activation and accepts their update message, so an older open tab can still hand over to the new version.
- **Environment variables.** The CLI reads `XCURSUS_FFMPEG` and `XCURSUS_FFPROBE`, and falls back to the deprecated `SPATIALDECK_FFMPEG` and `SPATIALDECK_FFPROBE`.

Limits: the format is recognized by the file extension. A legacy archive renamed to another extension (for example `.zip`) is treated as JSON and refused; rename it to `.xcursus` or `.spatialdeck`. Exported HTML files and static builds made by SpatialDeck carry their own runtime and keep working as they are; to change them, reopen the authoring project and export again.

## Compatibility policy

- Readers keep accepting archive manifest 1.0.0 and every published document schema version.
- A new document schema version always comes with a migration from the previous one, historical fixtures and tests that open them with unchanged rendering.
- A minor schema bump never allows an older reader to ignore unknown fields: it rejects the document instead.
- Exports are rebuilt from the authoring project; they are not an interchange format.
