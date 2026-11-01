# @xcursus/editor

React editor behind [XCursus](https://github.com/XCursus/xcursus) Studio: the `Studio` component, the command store with atomic undo/redo, the commands an integrator applies through it and IndexedDB recovery. React and React DOM (`^19.3.1`) are peer dependencies; core and player never depend on React.

```tsx
import { createRoot } from "react-dom/client";
import { Studio, EditorStore, emptyProject } from "@xcursus/editor";
import "@xcursus/editor/style.css";
import "@xcursus/plugins/style.css";
import "@xcursus/player/fonts.css";

createRoot(root).render(<Studio store={new EditorStore(emptyProject())} />);
```

The public API is delimited in `dist/index.d.ts`; components and storage internals are private. The interface is in English.

Not yet published to npm. Licence: GPL-3.0-or-later. Guides: [AUTHORING.md](https://github.com/XCursus/xcursus/blob/main/docs/AUTHORING.md), [API.md](https://github.com/XCursus/xcursus/blob/main/docs/API.md#editor).
