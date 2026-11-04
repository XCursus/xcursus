/**
 * Browser bootstrap of every CLI output, compiled into one classic script
 * (IIFE) from the published player and plugins: the standalone HTML, the
 * static build and the capture page used for PDF and video. No editor, no
 * React, no network in the inline profile, no project code execution.
 */
import {
  createAssetResolver,
  createPlayer,
  defaultMessages,
  italianMessages,
} from "@xcursus/player";
import type {
  AssetResolver,
  ContentRenderer,
  Player,
  RendererFactory,
} from "@xcursus/player";
import { validateDocument } from "@xcursus/core";
import type { CapturePlan, ProjectDocument } from "@xcursus/core";
import { createBuiltinRegistry } from "@xcursus/plugins/builtins";
import { isAnimatedImage } from "../animation.js";
import type { RuntimeConfig } from "../config.js";

const read = (id: string): unknown => {
  const element = document.getElementById(id);
  if (!element?.textContent) throw new Error(`Missing ${id}`);
  return JSON.parse(element.textContent);
};
const bytes = (base64: string) =>
  Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));

/** Static stand-in for content outside the output profile, declared in the manifest. */
function placeholder(kind: "excluded" | "poster"): RendererFactory {
  return (): ContentRenderer => {
    let host: HTMLElement;
    let done: Promise<void> = Promise.resolve();
    let release: (() => void) | undefined;
    return {
      mount(element, context) {
        host = element;
        const messages = context.messages ?? defaultMessages;
        const note = () => {
          const p = host.ownerDocument.createElement("p");
          p.className = "xc-export-placeholder";
          p.lang = messages.lang;
          p.textContent = messages.contentUnavailable(context.block.type);
          host.append(p);
        };
        const b = context.block;
        if (
          kind === "poster" &&
          b.type === "video" &&
          b.data.posterAssetId &&
          context.services.assets
        ) {
          const poster = b.data.posterAssetId;
          done = context.services.assets
            .resolve(poster, context.signal)
            .then(async (lease) => {
              release = () => lease.release();
              const img = host.ownerDocument.createElement("img");
              img.alt = b.data.alt;
              img.src = lease.url;
              host.append(img);
              await img.decode().catch(() => undefined);
            })
            .catch(note);
        } else note();
      },
      update() {},
      destroy() {
        release?.();
        host.replaceChildren();
      },
      ready: () => done,
    };
  };
}

/**
 * Capture renders single instants: an animated image becomes its first frame
 * (the default image of createImageBitmap), so frames do not depend on the
 * wall clock. The record follows the still so the resolver verifies it.
 */
async function freezeAnimations(
  project: ProjectDocument,
  blobs: Map<string, Blob>,
) {
  for (const asset of project.assets) {
    const blob = blobs.get(asset.id);
    if (
      !blob ||
      !isAnimatedImage(new Uint8Array(await blob.arrayBuffer()), asset.mime)
    )
      continue;
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
    bitmap.close();
    const still = await canvas.convertToBlob({ type: "image/png" });
    blobs.set(asset.id, still);
    asset.mime = "image/png";
    asset.byteLength = still.size;
    delete asset.sha256;
  }
}

const navigationTexts = {
  en: {
    label: "Presentation navigation",
    previous: "Previous",
    next: "Next",
    enter: "Full screen",
    exit: "Exit full screen",
  },
  it: {
    label: "Navigazione della presentazione",
    previous: "Precedente",
    next: "Successiva",
    enter: "Schermo intero",
    exit: "Esci da schermo intero",
  },
};
/** Interactive targets keep their own pointer gestures. */
const interactive =
  "a,button,input,select,textarea,summary,video,audio,iframe,[contenteditable],.xc-access,.xc-choices,.xc-outline";

/**
 * On-screen navigation of the presented HTML: previous and next follow the
 * player's own rules (history, choices), a horizontal swipe does the same on
 * touch screens, and full screen is offered where the browser allows it.
 * Without a keyboard every visit stays reachable.
 */
function navigation(
  player: Player,
  project: ProjectDocument,
  stage: HTMLElement,
  lang: "en" | "it",
) {
  const t = navigationTexts[lang];
  const nav = document.createElement("nav");
  nav.className = "xc-export-nav";
  nav.lang = lang;
  nav.setAttribute("aria-label", t.label);
  const button = (text: string, action: () => void) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = text;
    b.addEventListener("click", action);
    nav.append(b);
    return b;
  };
  const previous = button(t.previous, () => void player.prev());
  const next = button(t.next, () => void player.next());
  const update = () => {
    const state = player.getState();
    const path = project.paths.find((p) => p.id === state.pathId);
    previous.disabled = state.history.length < 2;
    next.disabled = !path?.edges.some((e) => e.from === state.nodeId);
  };
  player.on("scenechange", update);
  player.on("documentchange", update);
  update();
  if (document.fullscreenEnabled) {
    const full = button(t.enter, () => {
      void (
        document.fullscreenElement
          ? document.exitFullscreen()
          : document.documentElement.requestFullscreen()
      ).catch(() => undefined);
    });
    document.addEventListener("fullscreenchange", () => {
      full.textContent = document.fullscreenElement ? t.exit : t.enter;
    });
  }
  document.body.append(nav);
  // Touch and pen swipes; a mouse drag keeps selecting text.
  let start: { x: number; y: number; id: number } | undefined,
    last: { x: number; y: number } | undefined;
  stage.addEventListener("pointerdown", (event) => {
    last = undefined;
    start =
      event.pointerType !== "mouse" &&
      !(event.target as Element).closest(interactive)
        ? { x: event.clientX, y: event.clientY, id: event.pointerId }
        : undefined;
  });
  // The end of a swipe is where the finger last moved: Safari on iOS can
  // report a touch pointerup at (0, 0).
  stage.addEventListener("pointermove", (event) => {
    if (start && event.pointerId === start.id)
      last = { x: event.clientX, y: event.clientY };
  });
  stage.addEventListener("pointerup", (event) => {
    if (!start || event.pointerId !== start.id) return;
    const end = last ?? { x: event.clientX, y: event.clientY };
    const dx = end.x - start.x,
      dy = end.y - start.y;
    start = undefined;
    if (Math.abs(dx) < 50 || Math.abs(dx) < 1.5 * Math.abs(dy)) return;
    void (dx < 0 ? player.next() : player.prev());
  });
  stage.addEventListener("pointercancel", () => (start = undefined));
}

async function start() {
  const config = read("xcursus-config") as RuntimeConfig;
  const stage = document.getElementById("xcursus-stage")!;
  let input: unknown, blobs: Map<string, Blob>;
  if (config.assets === "inline") {
    input = read("xcursus-project");
    const data = read("xcursus-assets") as Record<string, string>;
    const checked = validateDocument(input);
    if (!checked.ok) throw new Error(checked.diagnostics[0]!.message);
    blobs = new Map(
      checked.value.assets
        .filter((a) => typeof data[a.id] === "string")
        .map((a) => [a.id, new Blob([bytes(data[a.id]!)], { type: a.mime })]),
    );
    input = checked.value;
  } else {
    // Static build: same-origin files only (connect-src 'self'), verified by the resolver.
    const response = await fetch("project.json");
    input = await response.json();
    const checked = validateDocument(input);
    if (!checked.ok) throw new Error(checked.diagnostics[0]!.message);
    const files = (read("xcursus-files") as Record<string, string>) ?? {};
    blobs = new Map();
    await Promise.all(
      checked.value.assets.map(async (a) => {
        const name = files[a.id];
        if (!name) return;
        const file = await fetch(name);
        if (file.ok)
          blobs.set(a.id, new Blob([await file.blob()], { type: a.mime }));
      }),
    );
    input = checked.value;
  }
  const project = input as ProjectDocument;
  const capture = config.mode === "capture";
  if (capture) await freezeAnimations(project, blobs);
  const builtins = createBuiltinRegistry({
    replace: Object.fromEntries(
      Object.entries(config.placeholders).map(([type, kind]) => [
        type,
        placeholder(kind),
      ]),
    ),
  });
  const assets: AssetResolver = createAssetResolver(project.assets, blobs);
  const player: Player = createPlayer({
    registry: builtins.registry,
    assets,
    messages: config.messages === "it" ? italianMessages : defaultMessages,
    ...(capture
      ? { controls: false, input: false, motion: "reduced", muted: true }
      : {}),
  });
  const mounted = await player.mount(stage, project);
  if (!mounted.ok) throw new Error(mounted.diagnostics[0]!.message);
  if (!capture)
    navigation(player, project, stage, config.messages === "it" ? "it" : "en");
  if (capture)
    Object.assign(window, {
      xcursusCapture: {
        renderAt: (plan: CapturePlan, elapsedMs: number) =>
          player.renderAt(plan, elapsedMs),
      },
    });
  document.documentElement.dataset.xcursus = "ready";
}

start().catch((error: unknown) => {
  document.documentElement.dataset.xcursus = "error";
  const stage = document.getElementById("xcursus-stage");
  if (stage) {
    const p = document.createElement("p");
    p.setAttribute("role", "alert");
    p.textContent = `XCursus: ${String(error)}`;
    stage.replaceChildren(p);
  }
});
