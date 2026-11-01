import { createPlayer, createAssetResolver } from "@xcursus/player";
import type { Player } from "@xcursus/player";
import { createBuiltinRegistry } from "@xcursus/plugins/builtins";
import {
  PROJECT_ACCEPT,
  archiveFormat,
  readArchive,
} from "@xcursus/plugins/archive";
import { success, validateDocument } from "@xcursus/core";
import project from "../../examples/layout-canvas/project.json";
import skyline from "../../examples/layout-canvas/assets/skyline.svg?url";
/** Layout example on the vanilla player; also opens projects saved by Studio. */
export async function layoutDemo() {
  const checked = validateDocument(project);
  if (!checked.ok) throw new Error(JSON.stringify(checked));
  let doc = checked.value,
    blobs = new Map<string, Blob>();
  const urls: Record<string, string> = { skyline };
  for (const asset of doc.assets) {
    const response = await fetch(urls[asset.id]!);
    blobs.set(
      asset.id,
      new Blob([await response.blob()], { type: asset.mime }),
    );
  }
  let resolver = createAssetResolver(doc.assets, blobs);
  const builtin = createBuiltinRegistry();
  const players: Player[] = [];
  const selects: HTMLSelectElement[] = [];
  const fill = (select: HTMLSelectElement) => {
    select.replaceChildren(
      ...doc.paths
        .flatMap((p) => p.nodes)
        .map((node) => {
          const option = document.createElement("option");
          option.value = node.id;
          option.textContent =
            doc.scenes.find((s) => s.id === node.sceneId)?.title ?? node.id;
          return option;
        }),
    );
  };
  for (let i = 0; i < 2; i++) {
    const section = document.createElement("section");
    section.className = "demo";
    const title = document.createElement("h2");
    title.textContent = `Layout · Player ${i + 1}`;
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
    select.setAttribute("aria-label", `Player ${i + 1} scene`);
    fill(select);
    selects.push(select);
    select.onchange = () =>
      void player.goTo({ nodeId: select.value }, { durationMs: 0 });
    controls.append(select);
    section.append(title, controls, host);
    document.querySelector("#demos")!.append(section);
    await player.mount(host, doc);
  }
  const io = document.createElement("nav");
  io.setAttribute("aria-label", "Project file");
  const status = document.createElement("p");
  status.setAttribute("role", "status");
  const open = document.createElement("input");
  open.type = "file";
  open.accept = PROJECT_ACCEPT;
  open.setAttribute("aria-label", "Open local project");
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
        const results = await Promise.all(
          players.map((p) => p.updateDocument(doc)),
        );
        const failed = results.find((r) => !r.ok);
        if (failed && !failed.ok)
          throw new Error(failed.diagnostics.map((d) => d.message).join("; "));
        selects.forEach(fill);
        status.textContent = "Project opened in the vanilla player.";
        Object.assign(window, { demoDocument: doc, layoutBlobs: blobs });
      } catch (e) {
        status.textContent = String(e);
      } finally {
        open.value = "";
      }
    })();
  io.append(open, status);
  document.querySelector("main")?.prepend(io);
  Object.assign(window, {
    demoPlayers: players,
    createDemoPlayer: (options: Parameters<typeof createPlayer>[0] = {}) =>
      createPlayer(options),
    demoDocument: doc,
    layoutRegistry: builtin.registry,
    layoutBlobs: blobs,
  });
  document.title = "XCursus · Layout";
  const header = document.querySelector("main header");
  if (header) {
    header.querySelector("p")!.textContent = "XCursus 0.5 / vanilla";
    header.querySelector("h1")!.textContent = "Layout inside the scene";
  }
}
