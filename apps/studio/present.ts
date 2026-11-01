import { createAssetResolver, createPlayer } from "@xcursus/player";
import type { AssetResolver, Player } from "@xcursus/player";
import { connectPublic } from "@xcursus/player/presenter";
import { createBuiltinRegistry } from "@xcursus/plugins/builtins";
import { LEGACY_SAMPLE_PLUGIN_ID, samplePlugin } from "@xcursus/plugins/sample";
import "@xcursus/player/style.css";
import "@xcursus/player/fonts.css";
import "@xcursus/plugins/style.css";
import "./present.css";
// Public window of the presenter view: a display that never navigates on its
// own. Keys, outline and choices become requests to the presenter window,
// which is the only navigation authority. No editor or React here.
const session = new URLSearchParams(location.hash.slice(1)).get("session");
const stage = document.getElementById("stage")!;
const status = document.getElementById("status")!;
const fullscreen = document.getElementById("fullscreen") as HTMLButtonElement;
fullscreen.hidden = !document.fullscreenEnabled;
fullscreen.addEventListener("click", () => {
  void document.documentElement.requestFullscreen?.().catch(() => {
    status.textContent = "Full screen is not available in this browser.";
  });
});
const texts = {
  waiting: "Waiting for the presenter view…",
  connected: "Connected to the presenter view.",
  closed: "The presenter view ended the session.",
  "no-opener":
    "Open this window from the Presenter button in Studio: without the presenter view it cannot receive the presentation.",
} as const;
if (!session || !/^[0-9a-f]{32}$/.test(session))
  status.textContent = texts["no-opener"];
else {
  let resolver: AssetResolver | undefined;
  const builtins = createBuiltinRegistry({
    plugins: [samplePlugin(), samplePlugin(LEGACY_SAMPLE_PLUGIN_ID)],
  });
  const player: Player = createPlayer({
    registry: builtins.registry,
    // Audio plays only here; the presenter previews are muted.
    muted: false,
    assets: {
      resolve: (id, signal) => resolver!.resolve(id, signal),
      revision: (id) => resolver?.revision?.(id),
    },
    // Called on user input only, after the connection below exists.
    delegate: (request) => connection.request(request),
  });
  const connection = connectPublic({
    window,
    sessionId: session,
    player,
    assets: (blobs, document) => {
      resolver = createAssetResolver(document.assets, blobs);
    },
    mount: (document) => player.mount(stage, document),
    onState: (state) => {
      status.textContent = texts[state];
      document.documentElement.dataset.presenter = state;
    },
  });
  Object.assign(window, { publicPlayer: player });
  addEventListener("pagehide", () => {
    connection.dispose();
    player.destroy();
    builtins.plugins.destroy();
  });
}
