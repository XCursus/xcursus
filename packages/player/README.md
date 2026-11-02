# @xcursus/player

Framework-free DOM/CSS 3D player of [XCursus](https://github.com/XCursus/xcursus) presentations: navigation through paths and choices, keyboard input on the focused container, text view, reduced motion, a renderer registry, a verified asset resolver and a capture clock (`renderAt`). No React, no editor.

```ts
import { createPlayer } from "@xcursus/player";
import "@xcursus/player/style.css";
import "@xcursus/player/fonts.css"; // only if a theme uses Atkinson Hyperlegible

const player = createPlayer({ input: true });
const mounted = await player.mount(document.querySelector("#deck")!, project);
if (mounted.ok) await player.next();
player.destroy();
```

- Interface texts default to English; `italianMessages` is exported as an alternative (`createPlayer({ messages: italianMessages })`).
- Rich content (Markdown, HTML, SVG, LaTeX) and media need renderers: `createBuiltinRegistry()` from `@xcursus/plugins/builtins`.
- Classic script without a bundler: `@xcursus/player/iife` (`dist/iife/xcursus-player.iife.js`, global `XCursus`) with `dist/iife/player.css`. That build embeds core, gl-matrix and the Ajv runtime; their licences are in `dist/iife/THIRD_PARTY_NOTICES.txt`.
- Theme font: Atkinson Hyperlegible 5.3.0 (SIL OFL 1.1), woff2 files in `dist/fonts/` with `OFL.txt`, fetched by the browser only when used.

Install with `npm install @xcursus/player`. Licence: GPL-3.0-or-later. API: [API.md](https://github.com/XCursus/xcursus/blob/main/docs/API.md#player).
