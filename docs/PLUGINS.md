# Renderers and plugins

The core holds only JSON, schema and semantics. The player exposes `RendererRegistry`, `ContentRenderer`, `ContentContext` and `AssetResolver`; it imports no plugins, parsers, React or editor. The app registers renderers explicitly. The minimal bundle does not include DOMPurify, marked, KaTeX or fflate.

```ts
import {
  createPlayer,
  createAssetResolver,
  RendererRegistry,
} from "@xcursus/player";
import { registerRich } from "@xcursus/plugins/rich";
import { registerMedia } from "@xcursus/plugins/media";
import { registerNavigation } from "@xcursus/plugins/navigation";
import { PluginHost } from "@xcursus/plugins";
import { samplePlugin } from "@xcursus/plugins/sample";
import "@xcursus/player/style.css";
import "@xcursus/plugins/style.css";

const registry = new RendererRegistry();
registerRich(registry);
registerMedia(registry);
registerNavigation(registry); // No authorized embed origin.
const plugins = new PluginHost();
plugins.register(samplePlugin());
plugins.attach(registry);
const player = createPlayer({
  registry,
  assets: createAssetResolver(project.assets, blobs), // Map<assetId, Blob>
  onContentEvent: (name, payload) => console.log(name, payload),
});
await player.mount(container, project);
// When the host closes:
player.destroy();
plugins.destroy();
```

The `rich`, `media`, `navigation`, `sample`, `archive` and SDK entry points are separate. `builtins` provides `createBuiltinRegistry()` for the combination both apps use. The rich and media renderers load on demand (`lazyRenderer`, a dynamic import: separate chunks in the consumer's bundle, synchronous mounting after the first load) and the sample badge is **not** a builtin: a host that wants it approves it with `createBuiltinRegistry({ plugins: [samplePlugin()] })`. Its ID is `org.xcursus.badge` (`SAMPLE_PLUGIN_ID`); Studio and the playground also register `samplePlugin(LEGACY_SAMPLE_PLUGIN_ID)`, the same plugin under its former ID `org.spatialdeck.badge`, so documents created before the rename keep rendering it. `replace` swaps the renderer of individual types (used by the export profiles). DOMPurify, marked, KaTeX and fflate are imported dependencies, not copied into `dist`: consumers update them in their own lockfile. `@xcursus/plugins/style.css` is the KaTeX stylesheet with only the woff2 sources as local files (`dist/fonts/`, with the KaTeX licence alongside); no `data:` URLs and no duplicate formats. Formulas are built with `katex.render`, which sets positioning styles through the CSSOM: they work under a CSP without `'unsafe-inline'` for styles (0.6 decision in [DISTRIBUTION](DISTRIBUTION.md)).

## SDK contract 1.0.0

`PluginDefinition` holds `descriptor`, `renderer()`, optional `migrations` and `dispose()`. The descriptor declares a namespaced `id`, the plugin version, `apiVersion: "1.0.0"`, `capabilities: {offline,capture}` and `dataSchemas`. Each data version has `{schema,validate}`: the JSON Schema is exportable documentation, the predicate is code approved by the host. The SDK compiles neither JSON Schema nor project code at runtime. Optional document settings have a separate `settingsSchemas` registry. No migration is invented when a version is missing: `migrations` is only ever invoked explicitly by the consumer.

The renderer implements `mount(host,context)`, `update(context)` and `destroy()`. The context exposes the block, the document, a per-instance ID, the active and media state, a `signal`, the replaceable `messages` texts (since 0.4.1; absent only when the host builds the context itself: use `defaultMessages`) and services: asset resolver, navigation, subscription to player events, namespaced emission and diagnostics. `services.on` unsubscribes automatically on abort, in addition to the renderer's explicit dispose. `services.emit` accepts only `<pluginId>:<name>`. Synchronous errors in factory, mount or update are isolated to the block; a renderer with asynchronous work must handle its own Promises and honour the signal. Unregistering or destroying the host also aborts renderers that are still mounted.

Since 0.4.1 the player does not remount a block on every `updateDocument`: if the block, its referenced assets and the plugin settings do not change, the renderer receives the new document through `update(context)`. A renderer that reads other parts of `context.document` must therefore refresh in `update`, not only in `mount`. The builtins show states and placeholders with `context.messages` and mark those texts with `lang = messages.lang`.

Since 0.5 (schema 1.3.0) a block can have a `frame` and a `style`, but the renderer does not receive them: `context.block` holds only `{id,type,data}`. The player positions and sizes the host from the frame (CSSOM properties computed by the core math) and applies the style tokens as allowlisted classes on the host; a renderer must not set the host's position, size or transforms, nor remove the `xc-*` classes. Moving, resizing, rotating or restyling a block does not remount the renderer: it only receives `update()` with the new document, as for any update in which its block is unchanged. In a canvas scene the host has a fixed size and `overflow: hidden` and is a column flex container (vertical alignment is a token); images, SVG, videos and iframes that are direct children of the host fill it. Plugin API, permissions and trust model are unchanged (API 1.0.0).

Missing plugins, unavailable data versions or invalid payloads or settings produce placeholders with the data intact. A plugin API other than 1.0.0 is instead a document schema error. A project can never choose URLs, imports or scripts. The sample inspector is a separate entry point that returns payloads; the editor store validates them and records the undo/redo command. Other plugins can use the generic JSON editor.

**Network signal.** A plugin without the `offline` capability and an embed with consent need the network. `navigator.onLine === false` reliably means offline, but `true` only means that a network interface is up: a kiosk, a captive portal or a file opened from disk under a CSP without connections still reaches nothing. The host therefore provides the signal: `new PluginHost({ online })`, `registerNavigation(registry, { allowedOrigins, online })` or `createBuiltinRegistry({ online })`, where `online` is a `NetworkSignal` (`() => boolean`) asked each time a block renders (plugins) or consent is given (embeds). Without it the default is `navigator.onLine`. A change of connectivity does not re-render on its own; the host updates the document or the player when its signal changes.

`capture` and `offline` are plugin declarations; the CLI registers no plugin, so a plugin block blocks strict exports and becomes a placeholder with `--allow-partial`. The badge declares `offline:true` and `capture:false`; web content declares no offline availability. No MIDI or OSC is registered or requested.

## Trust model and threats

The document is untrusted data; HTML, Markdown and SVG are untrusted markup; a JavaScript plugin installed by the host is trusted code with the page's authority. The SDK is not a JavaScript sandbox. Never open projects through eval, dynamic import or by inserting them into the DOM up front.

`security.ts` is the only user-content pipeline: marked → DOMPurify for Markdown; DOMPurify for HTML and SVG, followed by a check of URLs and references. HTML allows semantic elements and tables but no style, class, ID, form, embedded media, script, handler, iframe, meta or object. Absolute HTTP(S) links, without credentials and with noopener/noreferrer, require a user action. SVG allows static shapes, gradients and local references rewritten per instance; no foreignObject, SMIL, CSS or external href. Local SVG images go through the same policy before a derived URL is created.

KaTeX always receives `trust:false`, `maxExpand:500`, `maxSize:20`, fresh macros and `output:"htmlAndMathml"`. Only markup generated by the trusted library keeps its math styles; there is no exception for user HTML. The preview is the same renderer and stays muted while the audience presentation is active.

Embeds are off by default. A consumer can pass `allowedOrigins` to `registerNavigation`; only HTTPS without credentials, an additional consent for each frame, `sandbox=""`, no allow-same-origin or scripts, the referrer stripped and explicit revocation. The frame's restrictive `csp` attribute is also set; its enforcement is not uniform across engines, so the verified boundary is the script-free sandbox, not a universal guarantee about remote subresources. Embeds with scripts are not supported. The Studio CSP forbids every frame. Offline remains the declared fallback.

Declared limits of embeds (1.0): no scripts, forms, pop-ups, same-origin access, storage, top navigation or permissions (camera, microphone, geolocation, fullscreen) inside the frame; only HTTPS origins listed by the host; one consent per frame and per mount, revocable, never remembered; no embed in Studio (CSP), in the standalone HTML or the static build (outside the profile: refused, or a placeholder with `--allow-partial`), in PDF or in video. The `csp` attribute of the frame is a request to the embedded page that only some engines enforce; the guarantee is the empty `sandbox`. An embed that needs scripts must be served from an origin isolated from the presentation, which XCursus does not provide.

## Assets and archive

The resolver creates owned URLs per lease; `release()` is idempotent and abort revokes the lease. IDs must be in the document registry; a missing file or incompatible codec is a recoverable state. MIME types and minimal signatures are checked for PNG, JPEG, GIF, WebP, SVG, WAV, MP3, Ogg, WebM, MP4 and VTT; `text/plain` is UTF-8. Unrecognized formats are not rendered. A signature does not certify decodability: renderers handle the browser's error separately.

Since 0.4.1 an SVG can have a BOM, an XML declaration, processing instructions, comments and an `svg` DOCTYPE (with an internal subset too) before the root; the prologue is skipped without interpreting the DTD or entities, and the markup still goes through the sanitization pipeline. SVG, VTT and text are decoded entirely as streaming UTF-8: a character split across two chunks is valid, invalid UTF-8 bytes are rejected. The digest uses `crypto.subtle` when available, otherwise a local SHA-256: assets with digests also load over HTTP outside localhost. Verification and digests are memoized per Blob and expected metadata. Resolver errors are `AssetError` (`missing`, `size`, `signature`, `digest`, `aborted`), which renderers translate with `messages.assetMissing` and `messages.assetInvalid`. A resolver can implement `revision(assetId)` to signal that the resource behind an ID has changed while its record stays the same (for example a file linked after opening): the player resolves only those blocks again; without `revision`, it still retries the blocks whose asset had not resolved.

`writeArchive` and `readArchive` live in `@xcursus/plugins/archive`, together with `ARCHIVE_EXTENSION` (`.xcursus`), `LEGACY_ARCHIVE_EXTENSION` (`.spatialdeck`, read only), `archiveFormat(name)` and the file-input list `PROJECT_ACCEPT`; the format is specified in [FILE_FORMAT](FILE_FORMAT.md). The ZIP format holds `project.json`, a version 1.0.0 `manifest.json` and `assets/<id>/<normalized-name>` files. For each asset the manifest holds `id,path,entry,mime,byteLength,sha256`: `path` stays the canonical JSON one, `entry` is the portable name inside the ZIP. Every SHA-256 digest and CRC is checked. An archive missing required resources never replaces the current project. Plain JSON keeps relative paths and allows linking missing files by hand; any authorized host can supply the resolver.

Limits: 50 MiB per file, 200 MiB decompressed in total including the JSON entries, 10 MiB per JSON, 10,000 entries. Explicit directories, ZIP64, encryption and multi-disk archives are not supported. Local and central headers must match and cover the data without overlaps or hidden files. Traversal, backslashes, absolute paths, percent encoding, non-NFC names, duplicates and symbolic links are rejected. Inflate is incremental with a check of the actual output; no file is ever extracted to the filesystem.

IndexedDB (v3 since 0.4.1) keeps revisions and resource bytes and MIME types in the same transaction. Reading recreates Blobs, avoiding the WebKit macOS 14 defect when cloning File-backed Blobs. Keys include projectId, assetId and digest; the bytes of a key already present are neither reread nor rewritten. Garbage collection counts, through the `assetKeys` index, references to only the keys that belonged to deleted revisions; undo also keeps Blobs in memory for the previous metadata. Quota errors and conflicts never make downloading depend on storage.

Pinned dependencies and licences: [DOMPurify 3.4.17](https://registry.npmjs.org/dompurify/3.4.17) MPL-2.0 OR Apache-2.0; [marked 18.1.1](https://registry.npmjs.org/marked/18.1.1), [KaTeX 0.19.0](https://registry.npmjs.org/katex/0.19.0) and [fflate 0.8.3](https://registry.npmjs.org/fflate/0.8.3) MIT. The original gallery resources carry a [CC0 dedication](../examples/content-gallery/LICENSE.md). The repository licence is unchanged.

## Readiness, public document and texts

- `ContentRenderer.ready?(): Promise<void>` is optional (plugin API 1.0.0 unchanged): it resolves when the content is complete, for example after an asset has loaded or failed. `player.renderAt` (PDF and video capture) waits for it; a renderer without `ready` is ready after mount or update. The media builtins wait for the image, the poster or the media metadata to decode.
- Renderers and plugins receive the public copy of the document in `context.document` (`publicDocument`): private scene notes are empty strings. Notes stay in the authoring project and in the presenter console.
- The default texts (`defaultMessages`) are in English; `italianMessages` is the Italian set. The builtins use `context.messages` as before.
