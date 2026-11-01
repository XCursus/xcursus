import { createPlayer, createAssetResolver } from "@xcursus/player";
import type { Player } from "@xcursus/player";
import {
  RendererRegistry,
  createAssetResolver as assetResolver,
} from "@xcursus/player";
import { PluginHost } from "@xcursus/plugins";
import { LEGACY_SAMPLE_PLUGIN_ID, samplePlugin } from "@xcursus/plugins/sample";
import { registerNavigation } from "@xcursus/plugins/navigation";
import { createBuiltinRegistry } from "@xcursus/plugins/builtins";
import {
  ARCHIVE_EXTENSION,
  PROJECT_ACCEPT,
  archiveFormat,
  readArchive,
  writeArchive,
} from "@xcursus/plugins/archive";
import { success, validateDocument } from "@xcursus/core";
import gallery from "../../examples/content-gallery/project.json";
import diagram from "../../examples/content-gallery/assets/diagram.svg?url";
import tone from "../../examples/content-gallery/assets/tone.wav?url";
import motion from "../../examples/content-gallery/assets/motion.mp4?url";
import captions from "../../examples/content-gallery/assets/captions.vtt?url";
export async function contentDemo() {
  const checked = validateDocument(gallery);
  if (!checked.ok) throw new Error(JSON.stringify(checked));
  let doc = checked.value,
    blobs = new Map<string, Blob>();
  const urls: Record<string, string> = { diagram, tone, motion, captions };
  for (const asset of doc.assets) {
    const response = await fetch(urls[asset.id]!);
    blobs.set(
      asset.id,
      new Blob([await response.blob()], { type: asset.mime }),
    );
  }
  let resolver = createAssetResolver(doc.assets, blobs);
  // The badge is a demo plugin, approved explicitly by this host.
  const builtin = createBuiltinRegistry({
    plugins: [samplePlugin(), samplePlugin(LEGACY_SAMPLE_PLUGIN_ID)],
  });
  const players: Player[] = [];
  for (let i = 0; i < 2; i++) {
    const section = document.createElement("section");
    section.className = "demo";
    const title = document.createElement("h2");
    title.textContent = `Gallery · Player ${i + 1}`;
    const host = document.createElement("div");
    host.className = "player-host";
    host.id = `player-${i + 1}`;
    const controls = document.createElement("nav");
    controls.setAttribute("aria-label", `Player ${i + 1} controls`);
    const player = createPlayer({
      registry: builtin.registry,
      assets: {
        resolve: (id, signal) => resolver.resolve(id, signal),
        revision: (id) => resolver.revision?.(id),
      },
    });
    players.push(player);
    for (const [label, action] of [
      ["Previous", () => player.prev()],
      ["Next", () => player.next()],
    ] as const) {
      const button = document.createElement("button");
      button.textContent = label;
      button.onclick = () => void action();
      controls.append(button);
    }
    const select = document.createElement("select");
    select.setAttribute("aria-label", `Player ${i + 1} content`);
    for (const scene of doc.scenes) {
      const option = document.createElement("option");
      option.value = scene.id;
      option.textContent = scene.title;
      select.append(option);
    }
    select.onchange = () =>
      void player.goTo({ nodeId: select.value }, { durationMs: 0 });
    controls.append(select);
    section.append(title, controls, host);
    document.querySelector("#demos")!.append(section);
    await player.mount(host, doc);
  }
  const io = document.createElement("nav");
  io.setAttribute("aria-label", "Gallery file");
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  const open = document.createElement("input");
  open.type = "file";
  open.accept = PROJECT_ACCEPT;
  open.setAttribute("aria-label", "Open local gallery");
  open.onchange = () =>
    void (async () => {
      try {
        const file = open.files?.[0];
        if (!file) return;
        const imported = archiveFormat(file.name)
          ? await readArchive(file)
          : null;
        const valid = imported
          ? success(imported.document)
          : validateDocument(await file.text());
        if (!valid.ok)
          throw new Error(valid.diagnostics.map((d) => d.message).join("; "));
        doc = valid.value;
        blobs = imported?.blobs ?? new Map();
        resolver = createAssetResolver(doc.assets, blobs);
        await Promise.all(players.map((p) => p.updateDocument(doc)));
        status.textContent = "Project opened in the vanilla player.";
        Object.assign(window, { demoDocument: doc });
      } catch (e) {
        status.textContent = String(e);
      } finally {
        open.value = "";
      }
    })();
  const save = document.createElement("button");
  save.textContent = "Download gallery archive";
  save.onclick = () =>
    void (async () => {
      try {
        const blob = await writeArchive(doc, blobs),
          url = URL.createObjectURL(blob),
          a = document.createElement("a");
        a.href = url;
        a.download = `content-gallery${ARCHIVE_EXTENSION}`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (e) {
        status.textContent = String(e);
      }
    })();
  io.append(open, save, status);
  document.querySelector("main")?.prepend(io);
  Object.assign(window, {
    demoPlayers: players,
    createDemoPlayer: (options: Parameters<typeof createPlayer>[0] = {}) =>
      createPlayer(options),
    demoDocument: doc,
    contentRegistry: builtin.registry,
    contentBlobs: blobs,
    contentAPI: {
      RendererRegistry,
      PluginHost,
      registerNavigation,
      createAssetResolver: assetResolver,
      readArchive,
      writeArchive,
    },
  });
  document.title = "XCursus · Content";
  const header = document.querySelector("main header");
  if (header) {
    header.querySelector("p")!.textContent = "XCursus 0.5 / vanilla";
    header.querySelector("h1")!.textContent = "Local content";
  }
}
