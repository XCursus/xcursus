# @xcursus/impress-compat

Essential [impress.js](https://impress.js.org/) import for [XCursus](https://github.com/XCursus/xcursus): converts an impress.js HTML presentation into a candidate XCursus project (schema 1.3.0) with a diagnostic for everything it does not carry over. The HTML is parsed inertly with parse5: no script runs, no stylesheet applies, nothing is fetched or rendered.

```ts
import { importImpress } from "@xcursus/impress-compat";

const result = importImpress(html, {
  profile: "bundle", // js/impress.js with its plugins; "core" for src/impress.js alone
  resources: new Map([["images/a.png", bytes]]), // local files you choose to provide
});
if (!result.ok)
  console.error(result.diagnostics); // not an impress.js presentation
else {
  const { document, diagnostics, resources, files, steps } = result.value;
  // Review `diagnostics` (code, severity, JSON Pointer, source line) before use.
}
```

- Mapping follows the impress.js **2.0.0** release (tag `v2.0.0`, commit `dc3cf697`): `.step` elements in document order become scenes on one linear path; `data-x/y/z`, `data-rotate(-x/-y/-z)`, `data-rotate-order` and `data-scale` are composed as impress.js writes them and decomposed in the XCursus convention `T·Rz·Ry·Rx·S`; root `data-width`, `data-height`, `data-perspective` and `data-transition-duration` become the viewport, perspective and durations.
- Not full compatibility: CSS, scripts, plugins (goto, substep, autoplay…), `data-rel-position="relative"` and timing are reported, not reproduced. See the guide [IMPRESS.md](https://github.com/XCursus/xcursus/blob/main/docs/IMPRESS.md).
- `createImpressAdapter(player, document)` offers `goto`, `next` and `prev` with impress.js semantics (document order, wrap-around) on a mounted XCursus player; nothing is installed on `window`.
- Dependencies: `@xcursus/core`, `parse5` and `gl-matrix`. No DOM, no network, no file system; works in Node 24 and in the browser. The XCursus player never depends on this package.
- Command line: `xcursus convert impress deck.html --out deck.json` (package `@xcursus/cli`); in Studio: **Open → Import impress.js**.

Install with `npm install @xcursus/impress-compat`. Licence: GPL-3.0-or-later.
