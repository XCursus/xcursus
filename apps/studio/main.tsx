import { createRoot } from "react-dom/client";
import {
  EditorStore,
  RecoveryRepository,
  Studio,
  emptyProject,
} from "@xcursus/editor";
import type { Player } from "@xcursus/player";
import { LEGACY_SAMPLE_PLUGIN_ID, samplePlugin } from "@xcursus/plugins/sample";
import "@xcursus/player/fonts.css";
import "@xcursus/plugins/style.css";
import { exportHtml } from "./export.js";
import { registerShell } from "./shell.js";
const store = new EditorStore(emptyProject()),
  repository = new RecoveryRepository();
// Embedding/debug API, like the vanilla playground; no second document model.
// Production exposes it only on explicit request: `?studio-debug` in the URL.
const studio = {
  store,
  repository,
  preview: null as Player | null,
  presentation: null as Player | null,
};
declare global {
  interface Window {
    studio?: typeof studio;
  }
}
if (
  import.meta.env.DEV ||
  new URLSearchParams(location.search).has("studio-debug")
)
  window.studio = studio;
createRoot(document.getElementById("root")!).render(
  <Studio
    store={store}
    repository={repository}
    // The demo badge stays available in this app as an explicitly approved plugin.
    plugins={[samplePlugin(), samplePlugin(LEGACY_SAMPLE_PLUGIN_ID)]}
    exportHtml={exportHtml}
    onPlayer={(player, present) => {
      if (present) studio.presentation = player;
      else studio.preview = player;
    }}
  />,
);
// Production only: the dev server keeps HMR and never caches.
if (!import.meta.env.DEV) void registerShell();
