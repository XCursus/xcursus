# @xcursus/core

Pure TypeScript domain of [XCursus](https://github.com/XCursus/xcursus): the project document (schema 1.0.0–1.3.0, current 1.3.0), validation with JSON Pointer diagnostics, migration in copy, camera and frame math, the navigation machine, the transition sampler, export itineraries and capture plans. No DOM, no network, no filesystem.

```ts
import {
  validateDocument,
  planCapture,
  sampleCapture,
  publicDocument,
} from "@xcursus/core";

const result = validateDocument(json); // migrated 1.3.0 copy or diagnostics
if (!result.ok) console.error(result.diagnostics);
const plan = planCapture(result.value, itinerary, { reducedMotion: false });
```

- JSON Schemas: `@xcursus/core/schema` (current) and `@xcursus/core/schema/1.0.0` … `/1.3.0`.
- Runtime dependencies: `gl-matrix` and the Ajv runtime helpers (`ajv`), imported, never copied into `dist`.
- ESM only, `sideEffects: false`. Tested with Node 24.22.0 and the browsers listed in the repository.

Install with `npm install @xcursus/core`. Licence: GPL-3.0-or-later. Documentation: [API.md](https://github.com/XCursus/xcursus/blob/main/docs/API.md) and [FILE_FORMAT.md](https://github.com/XCursus/xcursus/blob/main/docs/FILE_FORMAT.md).
