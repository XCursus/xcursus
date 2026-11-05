import {
  NavigationMachine,
  diagnostic,
  failure,
  frameMatrix,
  getWorldMatrix,
  publicDocument,
  sampleCapture,
  validateDocument,
  viewMatrix,
  isSceneVisible,
} from "@xcursus/core";
import type {
  Block,
  CameraPose,
  CapturePlan,
  CaptureSample,
  Diagnostic,
  FontId,
  NavigationOptions,
  NavigationResult,
  PlayerEvents,
  PlayerState,
  ProjectDocument,
  Result,
  Scene,
} from "@xcursus/core";
import { ContentMount, blockText } from "./content/index.js";
import type { RendererRegistry } from "./content/index.js";
import type { AssetResolver } from "./assets/index.js";
import { resolveMessages } from "./messages.js";
import { activeFirst, needsPaintOrder, paintOrder } from "./paint.js";
import type { PlayerMessages } from "./messages.js";
export * from "./content/index.js";
export * from "./assets/index.js";
export { defaultMessages, italianMessages } from "./messages.js";
export type { PlayerMessages } from "./messages.js";
export interface PlayerClock {
  now(): number;
  request(callback: () => void): number;
  cancel(id: number): void;
}
/** User navigation from the player's own controls, handed to a host with `delegate`. */
export type NavigationRequest =
  | { kind: "next"; edgeId?: string }
  | { kind: "prev" }
  | { kind: "goTo"; nodeId: string };
export interface PlayerOptions {
  input?: boolean;
  keymap?: Readonly<Record<string, "next" | "prev">>;
  motion?: "system" | "reduced";
  clock?: PlayerClock;
  onError?: (diagnostic: Diagnostic) => void;
  registry?: RendererRegistry;
  assets?: AssetResolver;
  muted?: boolean;
  onContentEvent?: (
    name: string,
    payload: import("@xcursus/core").JsonValue,
  ) => void;
  /** Replaces any subset of the player and builtin renderer texts; defaults are English, `italianMessages` is the Italian set. */
  messages?: Partial<PlayerMessages>;
  /**
   * `false` omits the access controls and choice buttons so the stage fills
   * the host: for capture and print pages only, never for an audience.
   */
  controls?: boolean;
  /**
   * When set, keys, outline and choice buttons do not navigate: the request
   * goes to the host, which owns navigation (the public window of the
   * presenter view). API commands still navigate.
   */
  delegate?: (request: NavigationRequest) => void;
}
export interface Player {
  mount(container: HTMLElement, document: unknown): Promise<Result<void>>;
  updateDocument(document: unknown): Promise<Result<void>>;
  destroy(): void;
  goTo(
    target: { pathId?: string; nodeId: string },
    options?: NavigationOptions,
  ): Promise<NavigationResult>;
  next(options?: { edgeId?: string }): Promise<NavigationResult>;
  prev(): Promise<NavigationResult>;
  setPath(pathId: string): Promise<NavigationResult>;
  setView(view: "scene" | "overview"): Result<void>;
  setCamera(pose: CameraPose): Result<void>;
  /**
   * Manual clock for capture (0.6): renders the plan at `elapsedMs` with the
   * core sampler and the same renderers, then resolves once renderers, fonts
   * and two paints are ready. No visit, cue, media or focus side effect.
   */
  renderAt(plan: CapturePlan, elapsedMs: number): Promise<Result<void>>;
  getState(): Readonly<PlayerState>;
  on<K extends keyof PlayerEvents>(
    event: K,
    handler: (payload: PlayerEvents[K]) => void,
  ): () => void;
}
interface BlockView {
  key: string;
  host: HTMLElement;
  mount: ContentMount;
  /** Frame and style tokens last applied to the host; layout never remounts a renderer. */
  layout: string;
  /** True while the host carries frame or colour properties. */
  styled: boolean;
  /** An asset failed to resolve: the next document update tries the block again. */
  unresolved(): boolean;
}
interface SceneView {
  wrapper: HTMLElement;
  content: HTMLElement;
  title: HTMLElement;
  transform: string;
  appearance: string;
  blocks: Map<string, BlockView>;
}
const assetFields = ["assetId", "posterAssetId", "captionsAssetId"] as const;
/** Allowlisted font stacks: the document names a FontId, never a CSS value. */
const fontStacks: Readonly<Record<FontId, string>> = {
  "system-sans": "system-ui, sans-serif",
  "system-serif": 'ui-serif, Georgia, "Times New Roman", serif',
  "system-mono": 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  "atkinson-hyperlegible":
    '"XCursus Atkinson Hyperlegible", system-ui, sans-serif',
};
const hexColor = /^#[0-9a-f]{6}$/;
/** Renderers see content only: frame and style are applied by the player to the host. */
const contentBlock = (block: Block): Block => {
  if (!block.frame && !block.style) return block;
  const content = { ...block };
  delete content.frame;
  delete content.style;
  return content;
};
const styleClasses = (block: Block) => {
  const style = block.style ?? {};
  return [
    ...(block.frame ? ["xc-framed"] : []),
    ...(style.align ? [`xc-align-${style.align}`] : []),
    ...(style.verticalAlign ? [`xc-valign-${style.verticalAlign}`] : []),
    ...(style.size ? [`xc-size-${style.size}`] : []),
  ];
};
const tokenClass = /^xc-(?:framed|align-|valign-|size-)/;
export function createPlayer(options: PlayerOptions = {}): Player {
  const instanceId = Array.from(
    globalThis.crypto.getRandomValues(new Uint32Array(4)),
  ).join("-");
  const messages = resolveMessages(options.messages);
  let machine: NavigationMachine | undefined,
    host: HTMLElement | undefined,
    root: HTMLElement | undefined,
    viewport: HTMLElement | undefined,
    world: HTMLElement | undefined,
    outline: HTMLElement | undefined,
    live: HTMLElement | undefined,
    emptyMessage: HTMLElement | undefined,
    outlineButton: HTMLButtonElement | undefined,
    mediaButton: HTMLButtonElement | undefined,
    stageElement: HTMLElement | undefined,
    choicesElement: HTMLElement | undefined,
    focusOrigin: Element | null = null;
  let doc: ProjectDocument | undefined,
    // Renderers and plugins receive this copy: private notes stay out of the public runtime.
    shared: ProjectDocument | undefined,
    captured: CaptureSample | null = null,
    clock: PlayerClock | undefined,
    frame: number | undefined,
    destroyed = false,
    updating = false,
    outlineOpen = false,
    spatialSupported = true,
    focusRequested = false,
    focusAllowed = false,
    // Gecko only: wrappers carry an explicit paint order (see paint.ts).
    planeOrder = false;
  // Render memo: per-frame work is the camera; everything else runs when its inputs change.
  let revision = 0,
    layout = 0,
    renderedCamera: CameraPose | null = null,
    chromeKey = "",
    activationKey = "",
    outlineSource = "",
    outlineKey = "",
    outlineNode: string | null | undefined,
    choicesSource = "",
    choicesRendered = "",
    liveKey = "",
    paintKey = "",
    paintGeometry = "",
    paintBase: string[] = [],
    // Scene wrappers created or removed; block layout does not count.
    sceneViews = 0;
  let mediaEnabled = false;
  const scenes = new Map<string, SceneView>();
  const clearContents = () => {
    for (const view of scenes.values())
      for (const block of view.blocks.values()) block.mount.destroy();
  };
  let media: MediaQueryList | undefined,
    manualReduced = options.motion === "reduced",
    oldTabindex: string | null = null;
  const cleanup: Array<() => void> = [];
  const handlers = new Map<
    keyof PlayerEvents,
    Set<(payload: unknown) => void>
  >();
  const report = (d: Diagnostic) => {
    try {
      options.onError?.(d);
    } catch {
      /* A failing error sink is isolated. */
    }
  };
  const emit = <K extends keyof PlayerEvents>(
    name: K,
    payload: PlayerEvents[K],
  ) => {
    for (const handler of [...(handlers.get(name) ?? [])])
      try {
        handler(payload);
      } catch (error) {
        const d = diagnostic("HANDLER_ERROR", String(error));
        report(d);
        if (name !== "diagnostic")
          emit("diagnostic", { instanceId, diagnostic: d });
      }
  };
  const state = (): PlayerState =>
    machine?.getState() ?? {
      view: "scene",
      status: destroyed ? "destroyed" : "unmounted",
      pathId: null,
      nodeId: null,
      sceneId: null,
      history: [],
      camera: null,
      transition: null,
      choices: [],
      diagnostics: [],
    };
  const unavailable = (): Promise<NavigationResult> =>
    Promise.resolve({
      status: "error",
      diagnostic: diagnostic(
        destroyed ? "PLAYER_DESTROYED" : "PLAYER_UNMOUNTED",
        destroyed ? "Player is destroyed" : "Player is not mounted",
      ),
    });
  const element = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className = "",
  ) => {
    const el = host!.ownerDocument.createElement(tag);
    el.className = className;
    return el;
  };
  let resizeView = () => {};
  /** Everything a builtin rendering of the block depends on besides the block itself. */
  const blockKey = (d: ProjectDocument, block: Block) => {
    const data = block.data as Partial<
      Record<(typeof assetFields)[number], string>
    >;
    return JSON.stringify([
      contentBlock(block),
      assetFields.flatMap((field) => {
        const id = data[field];
        return id
          ? [
              [
                id,
                d.assets.find((a) => a.id === id) ?? null,
                options.assets?.revision?.(id) ?? null,
              ],
            ]
          : [];
      }),
      block.type === "audio" || block.type === "video"
        ? d.metadata.language
        : null,
      block.type === "plugin"
        ? (d.pluginSettings?.[block.data.pluginId] ?? null)
        : null,
    ]);
  };
  const createBlock = (
    d: ProjectDocument,
    scene: Scene,
    block: Block,
    key: string,
  ): BlockView => {
    const blockHost = element(block.type === "text" ? "p" : "div", "xc-block");
    blockHost.dataset.blockId = block.id;
    blockHost.dataset.blockType = block.type;
    let unresolved = false;
    const resolver = options.assets;
    const assets: AssetResolver | undefined = resolver && {
      resolve: async (id, signal) => {
        try {
          return await resolver.resolve(id, signal);
        } catch (error) {
          if (!signal?.aborted) unresolved = true;
          throw error;
        }
      },
      ...(resolver.revision
        ? { revision: (id: string) => resolver.revision!(id) }
        : {}),
    };
    const mount = new ContentMount(
      blockHost,
      {
        block: contentBlock(block),
        document: shared ?? publicDocument(d),
        instanceId: `${instanceId}-${scene.id}-${block.id}`,
        active: false,
        mediaEnabled,
        mediaMuted: options.muted === true,
        messages,
        services: {
          ...(assets ? { assets } : {}),
          navigate: (target) => player.goTo(target),
          on: player.on,
          emit: (name, payload) => options.onContentEvent?.(name, payload),
          report: (diag) => {
            report(diag);
            emit("diagnostic", { instanceId, diagnostic: diag });
          },
          mediaError: (message) => {
            const diag = {
              ...diagnostic("MEDIA_ERROR", message),
              severity: "warning" as const,
            };
            report(diag);
            emit("mediaerror", {
              instanceId,
              sceneId: scene.id,
              blockId: block.id,
              ...("assetId" in block.data
                ? { assetId: block.data.assetId }
                : {}),
              diagnostic: diag,
            });
          },
        },
      },
      options.registry,
    );
    layout++;
    // Renderers loaded on demand finish later: outline and activation follow.
    void mount.ready().then(() => {
      if (
        destroyed ||
        scenes.get(scene.id)?.blocks.get(block.id)?.mount !== mount
      )
        return;
      layout++;
      render();
    });
    return {
      key,
      host: blockHost,
      mount,
      layout: "",
      styled: false,
      unresolved: () => unresolved,
    };
  };
  const paletteColor = (d: ProjectDocument, id: string | null | undefined) => {
    const value = d.theme.palette.find((p) => p.id === id)?.value;
    return value && hexColor.test(value) ? value : null;
  };
  /** Theme tokens become custom properties set through CSSOM with validated values. */
  const applyTheme = (d: ProjectDocument) => {
    if (!root) return;
    const { colors, fonts, typeScale } = d.theme;
    const properties: Array<[string, string | null]> = [
      ["--xc-text", paletteColor(d, colors.text)],
      ["--xc-background", paletteColor(d, colors.background)],
      ["--xc-accent", paletteColor(d, colors.accent)],
      ["--xc-backdrop", paletteColor(d, colors.backdrop)],
      ["--xc-font-body", fontStacks[fonts.body] ?? null],
      ["--xc-font-heading", fontStacks[fonts.heading] ?? null],
      ["--xc-size-body", `${typeScale.body}px`],
      ["--xc-size-title", `${typeScale.title}px`],
    ];
    for (const [name, value] of properties)
      if (value === null) root.style.removeProperty(name);
      else if (root.style.getPropertyValue(name) !== value)
        root.style.setProperty(name, value);
  };
  /** Frame and style tokens: CSSOM values from the core frame matrix, classes from an allowlist. */
  const placeBlock = (d: ProjectDocument, view: BlockView, block: Block) => {
    const color = paletteColor(d, block.style?.color);
    const key = JSON.stringify([
      block.frame ?? null,
      block.style ?? null,
      color,
    ]);
    if (key === view.layout) return;
    view.layout = key;
    const host = view.host;
    for (const name of [...host.classList])
      if (tokenClass.test(name)) host.classList.remove(name);
    host.classList.add(...styleClasses(block));
    const f = block.frame;
    // Flow blocks without tokens keep the 1.2.0 DOM: no style attribute at all.
    if (!f && !color && !view.styled) return;
    view.styled = !!f || !!color;
    host.style.width = f ? `${f.width}px` : "";
    host.style.height = f ? `${f.height}px` : "";
    host.style.transform = f ? `matrix(${frameMatrix(f).join(",")})` : "";
    host.style.zIndex = f ? String(f.z) : "";
    host.style.color = color ?? "";
  };
  const removeBlock = (view: BlockView) => {
    view.mount.destroy();
    view.host.remove();
    layout++;
  };
  /** Incremental equivalent of rebuilding the world: unchanged scenes and blocks keep their DOM, renderers and leases. */
  const syncScenes = () => {
    if (!doc || !world || !viewport) return;
    const d = doc;
    applyTheme(d);
    if (mediaButton)
      mediaButton.hidden = !d.scenes.some((s) =>
        s.blocks.some((b) => b.type === "audio" || b.type === "video"),
      );
    viewport.style.width = `${d.settings.viewport.width}px`;
    viewport.style.height = `${d.settings.viewport.height}px`;
    viewport.style.perspective = `${d.settings.viewport.perspective}px`;
    const ids = new Set(d.scenes.map((s) => s.id));
    for (const [id, view] of scenes)
      if (!ids.has(id)) {
        for (const block of view.blocks.values()) removeBlock(block);
        view.wrapper.remove();
        scenes.delete(id);
        sceneViews++;
      }
    let previous: ChildNode | null = null;
    for (const scene of d.scenes) {
      let view = scenes.get(scene.id);
      if (!view) {
        const wrapper = element("div", "xc-scene");
        wrapper.dataset.sceneId = scene.id;
        const content = element("article", "xc-content");
        const title = element("h2");
        title.tabIndex = -1;
        title.id = `xc-title-${instanceId}-${scene.id}`;
        // A hidden title stays the accessible name of the scene.
        content.setAttribute("aria-labelledby", title.id);
        content.append(title);
        wrapper.append(content);
        view = {
          wrapper,
          content,
          title,
          transform: "",
          appearance: "",
          blocks: new Map(),
        };
        scenes.set(scene.id, view);
        layout++;
        sceneViews++;
      }
      view.wrapper.hidden = !isSceneVisible(d, scene.id);
      const matrix = getWorldMatrix(d, scene.id);
      const transform = matrix.ok ? `matrix3d(${matrix.value.join(",")})` : "";
      if (transform !== view.transform) {
        view.wrapper.style.transform = transform;
        view.transform = transform;
      }
      view.content.style.width = `${scene.size[0]}px`;
      view.content.style.height = `${scene.size[1]}px`;
      if (view.title.textContent !== scene.title)
        view.title.textContent = scene.title;
      const background = paletteColor(d, scene.appearance.background);
      const appearance = JSON.stringify([
        scene.layout,
        scene.appearance.variant,
        scene.appearance.titleVisible,
        background,
      ]);
      if (appearance !== view.appearance) {
        view.appearance = appearance;
        view.content.classList.toggle(
          "xc-layout-canvas",
          scene.layout === "canvas",
        );
        view.content.classList.toggle(
          "xc-variant-plain",
          scene.appearance.variant === "plain",
        );
        view.title.classList.toggle(
          "xc-title-hidden",
          !scene.appearance.titleVisible,
        );
        // Without a visible title, focus lands on the labelled scene itself.
        if (scene.appearance.titleVisible)
          view.content.removeAttribute("tabindex");
        else view.content.tabIndex = -1;
        if (background)
          view.content.style.setProperty("--xc-scene-background", background);
        else view.content.style.removeProperty("--xc-scene-background");
      }
      const keep = new Set(scene.blocks.map((b) => b.id));
      for (const [id, block] of view.blocks)
        if (!keep.has(id)) {
          removeBlock(block);
          view.blocks.delete(id);
        }
      let before: ChildNode = view.title;
      for (const block of scene.blocks) {
        const key = blockKey(d, block);
        let current = view.blocks.get(block.id);
        if (
          current &&
          (current.key !== key || current.mount.failed || current.unresolved())
        ) {
          removeBlock(current);
          current = undefined;
        }
        if (!current) {
          current = createBlock(d, scene, block, key);
          view.blocks.set(block.id, current);
        } else current.mount.refresh(shared ?? publicDocument(d));
        placeBlock(d, current, block);
        if (before.nextSibling !== current.host)
          view.content.insertBefore(current.host, before.nextSibling);
        before = current.host;
      }
      const expected: ChildNode | null = previous
        ? previous.nextSibling
        : world.firstChild;
      if (expected !== view.wrapper) world.insertBefore(view.wrapper, expected);
      previous = view.wrapper;
    }
  };
  /** Rendered text for markup blocks, accessible text for the others; never the source. */
  const outlineText = (sceneId: string, block: Block) => {
    const view = scenes.get(sceneId)?.blocks.get(block.id);
    if (
      (block.type === "markdown" ||
        block.type === "html" ||
        block.type === "plugin") &&
      view?.mount.rendered
    )
      return (view.host.textContent ?? "").replace(/\s+/g, " ").trim();
    return blockText(block, messages);
  };
  const renderOutline = (s: Readonly<PlayerState>) => {
    if (!outline || !doc) return;
    const d = doc;
    const path = d.paths.find((p) => p.id === s.pathId);
    const visited = new Set<string>(),
      ordered = [];
    const stack = path?.startNodeId ? [path.startNodeId] : [];
    while (stack.length && path) {
      const id = stack.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      const node = path.nodes.find((n) => n.id === id)!;
      ordered.push(node);
      stack.push(
        ...path.edges
          .filter((e) => e.from === id)
          .map((e) => e.to)
          .reverse(),
      );
    }
    const entries = ordered.map((node) => {
      const scene = d.scenes.find((sc) => sc.id === node.sceneId)!;
      return {
        nodeId: node.id,
        title: scene.title,
        texts: scene.blocks
          .map((b) => outlineText(scene.id, b))
          .filter((t) => t !== ""),
      };
    });
    const key = JSON.stringify(entries);
    if (key === outlineKey) return;
    outlineKey = key;
    outlineNode = undefined;
    outline.replaceChildren();
    for (const entry of entries) {
      const li = element("li"),
        button = element("button");
      button.type = "button";
      button.textContent = entry.title;
      button.dataset.nodeId = entry.nodeId;
      li.append(button);
      for (const text of entry.texts) {
        const p = element("p");
        p.textContent = text;
        li.append(p);
      }
      outline.append(li);
    }
  };
  const disabledText = (
    path: ProjectDocument["paths"][number] | undefined,
    edgeId: string,
    fallback: string,
  ) => {
    const edge = path?.edges.find((e) => e.id === edgeId);
    const limit = Math.min(
      path?.loopPolicy?.maxVisitsPerNode ?? Infinity,
      edge?.condition?.kind === "visit-limit"
        ? edge.condition.maxVisits
        : Infinity,
    );
    if (!edge || !Number.isFinite(limit)) return fallback;
    // The audience reads scene titles, never node IDs.
    const sceneId = path?.nodes.find((n) => n.id === edge.to)?.sceneId;
    const title = doc?.scenes.find((s) => s.id === sceneId)?.title.trim();
    return messages.visitLimit(limit, title || edge.to);
  };
  const render = () => {
    if (!root || !machine || !doc || destroyed || updating) return;
    const current = machine.peek();
    // A captured sample replaces visit and camera without touching the machine.
    const s: Readonly<PlayerState> = captured
      ? {
          ...current,
          view: "scene",
          status: "idle",
          nodeId: captured.nodeId,
          sceneId: captured.sceneId,
          camera: captured.camera,
        }
      : current;
    if (
      focusRequested &&
      focusOrigin &&
      host?.ownerDocument.activeElement !== focusOrigin &&
      (focusOrigin.isConnected ||
        host?.ownerDocument.activeElement !== host?.ownerDocument.body)
    )
      focusAllowed = false;
    const showEmpty = s.status === "empty" && s.view === "scene";
    const chrome = `${showEmpty}|${s.status === "empty"}|${outlineOpen}|${spatialSupported}`;
    if (chrome !== chromeKey) {
      chromeKey = chrome;
      if (emptyMessage) emptyMessage.hidden = !showEmpty;
      if (outlineButton)
        outlineButton.disabled = !spatialSupported || s.status === "empty";
      if (stageElement) stageElement.hidden = outlineOpen || showEmpty;
    }
    if (s.camera && world && s.camera !== renderedCamera) {
      renderedCamera = s.camera;
      world.style.transform = `matrix3d(${viewMatrix(s.camera).join(",")})`;
    }
    if (planeOrder) {
      // The split-minimizing order depends on the document only, so it is
      // not recomputed as block renderers finish; the scene shown, or
      // arrived at, moves to the front (paint.ts).
      const geometry = `${revision}|${sceneViews}`;
      if (geometry !== paintGeometry) {
        paintGeometry = geometry;
        paintBase = paintOrder(doc);
      }
      const active =
        s.view === "overview"
          ? null
          : (s.transition?.to.sceneId ?? s.sceneId ?? null);
      const paint = `${geometry}|${active}`;
      if (paint !== paintKey) {
        paintKey = paint;
        activeFirst(paintBase, active).forEach((id, rank) => {
          const view = scenes.get(id);
          if (view) view.wrapper.style.zIndex = String(rank);
        });
      }
    }
    const activation = `${layout}|${s.sceneId}|${outlineOpen}|${s.view}|${mediaEnabled}`;
    if (activation !== activationKey) {
      activationKey = activation;
      for (const [id, scene] of scenes) {
        const active = id === s.sceneId;
        scene.content.inert = !active || outlineOpen;
        scene.content.setAttribute(
          "aria-hidden",
          String(!active || outlineOpen),
        );
        scene.wrapper.dataset.active = String(active);
        const visible = active && !outlineOpen && s.view === "scene";
        for (const block of scene.blocks.values())
          block.mount.update(visible, mediaEnabled);
      }
    }
    const outlineInputs = `${revision}|${layout}|${s.pathId}`;
    if (outlineInputs !== outlineSource) {
      outlineSource = outlineInputs;
      renderOutline(s);
    }
    if (outline && outlineNode !== s.nodeId) {
      outlineNode = s.nodeId;
      outline.querySelectorAll("button").forEach((button) => {
        button.setAttribute(
          "aria-current",
          String(button.dataset.nodeId === s.nodeId),
        );
      });
    }
    const source = `${revision}|${s.pathId}|${s.nodeId}|${s.history.length}|${s.history.at(-1)?.visitId ?? ""}`;
    if (choicesElement && source !== choicesSource) {
      choicesSource = source;
      const choices = machine.getChoices();
      const path = doc.paths.find((p) => p.id === s.pathId);
      const showChoices =
        choices.length > 1 ||
        choices.some(
          (c) =>
            c.disabledReason ||
            path?.edges.find((e) => e.id === c.edgeId)?.condition?.kind ===
              "manual",
        );
      const choiceKey = JSON.stringify([
        s.pathId,
        s.nodeId,
        choices,
        showChoices,
      ]);
      if (choiceKey !== choicesRendered) {
        choicesRendered = choiceKey;
        choicesElement.replaceChildren();
        choicesElement.hidden = !showChoices;
        if (showChoices) {
          const label = element("p");
          label.textContent = messages.choicePrompt;
          label.lang = messages.lang;
          choicesElement.append(label);
          for (const choice of choices) {
            const button = element("button");
            button.type = "button";
            button.dataset.edgeId = choice.edgeId;
            button.textContent = choice.disabledReason
              ? messages.choiceDisabled(
                  choice.label,
                  disabledText(path, choice.edgeId, choice.disabledReason),
                )
              : choice.label;
            button.disabled = !!choice.disabledReason;
            choicesElement.append(button);
          }
        }
      }
    }
    const announced = `${revision}|${s.sceneId}`;
    if (live && announced !== liveKey) {
      liveKey = announced;
      const scene = doc.scenes.find((sc) => sc.id === s.sceneId);
      const title = scene?.title ?? messages.emptyPresentation;
      live.lang = scene ? doc.metadata.language : messages.lang;
      if (live.textContent !== title) live.textContent = title;
    }
    if (
      s.status === "transitioning" &&
      frame === undefined &&
      clock &&
      !host?.ownerDocument.hidden
    )
      frame = clock.request(() => {
        frame = undefined;
        machine?.tick();
      });
    if (
      (s.status !== "transitioning" || host?.ownerDocument.hidden) &&
      frame !== undefined
    ) {
      clock?.cancel(frame);
      frame = undefined;
    }
  };
  const release = () => {
    if (!captured) return;
    captured = null;
    renderedCamera = null;
    activationKey = "";
    liveKey = "";
    render();
  };
  const invoke = (command: () => Promise<NavigationResult>) => {
    release();
    if (host?.ownerDocument.activeElement === host) focusRequested = true;
    return command().then((result) => {
      if (result.status !== "completed" && state().status !== "transitioning")
        focusRequested = false;
      return result;
    });
  };
  const player: Player = {
    async mount(container, input) {
      if (destroyed) return failure("PLAYER_DESTROYED", "Player is destroyed");
      if (machine)
        return failure("ALREADY_MOUNTED", "Player is already mounted");
      const validated = validateDocument(input);
      if (!validated.ok) return validated;
      host = container;
      doc = validated.value;
      const win = container.ownerDocument.defaultView;
      if (!win)
        return failure("NO_WINDOW", "Container must belong to a window");
      planeOrder = needsPaintOrder(win);
      spatialSupported =
        win.CSS.supports("transform-style", "preserve-3d") &&
        win.CSS.supports("perspective", "1000px");
      outlineOpen = !spatialSupported;
      clock = options.clock ?? {
        now: () => win.performance.now(),
        request: (callback) => win.requestAnimationFrame(callback),
        cancel: (id) => win.cancelAnimationFrame(id),
      };
      oldTabindex = host.getAttribute("tabindex");
      if (oldTabindex === null) host.tabIndex = 0;
      shared = publicDocument(doc);
      root = element("section", "xc-player");
      root.setAttribute(
        "aria-label",
        doc.metadata.title || messages.presentation,
      );
      root.lang = doc.metadata.language;
      const controls = element("div", "xc-access");
      controls.lang = messages.lang;
      const outlineToggle = element("button");
      outlineButton = outlineToggle;
      outlineToggle.type = "button";
      outlineToggle.textContent = messages.outline;
      outlineToggle.setAttribute("aria-expanded", String(outlineOpen));
      outlineToggle.disabled = !spatialSupported;
      const motionToggle = element("button");
      motionToggle.type = "button";
      motionToggle.textContent = messages.reduceMotion;
      motionToggle.setAttribute("aria-pressed", String(manualReduced));
      const overview = element("button");
      overview.type = "button";
      overview.textContent = messages.overview;
      const inspection = element("details", "xc-inspection");
      const summary = element("summary");
      summary.textContent = messages.camera;
      inspection.append(summary);
      const tools = element("div", "xc-camera-tools");
      const tool = (label: string, action: () => void) => {
        const button = element("button");
        button.type = "button";
        button.textContent = label;
        button.addEventListener("click", action);
        tools.append(button);
        cleanup.push(() => button.removeEventListener("click", action));
      };
      tool(messages.sceneView, () => {
        player.setView("scene");
      });
      for (const [label, x, y, factor] of [
        [messages.panLeft, -100, 0, 1],
        [messages.panRight, 100, 0, 1],
        [messages.panUp, 0, -100, 1],
        [messages.panDown, 0, 100, 1],
        [messages.zoomIn, 0, 0, 1.25],
        [messages.zoomOut, 0, 0, 0.8],
      ] as const)
        tool(label, () => {
          const camera = state().camera;
          if (camera)
            player.setCamera({
              ...camera,
              position: [
                camera.position[0] + x / camera.zoom,
                camera.position[1] + y / camera.zoom,
                camera.position[2],
              ],
              zoom: camera.zoom * factor,
            });
        });
      inspection.append(tools);
      controls.append(outlineToggle, motionToggle, overview, inspection);
      controls.hidden = options.controls === false;
      {
        const enable = element("button");
        enable.type = "button";
        enable.textContent = messages.enableMedia;
        mediaButton = enable;
        const activate = () => {
          mediaEnabled = true;
          enable.setAttribute("aria-pressed", "true");
          render();
        };
        enable.addEventListener("click", activate);
        cleanup.push(() => enable.removeEventListener("click", activate));
        controls.append(enable);
      }
      const stage = element("div", "xc-stage");
      stageElement = stage;
      emptyMessage = element("p", "xc-empty");
      emptyMessage.textContent = messages.emptyPath;
      emptyMessage.lang = messages.lang;
      emptyMessage.hidden = true;
      stage.setAttribute("aria-label", messages.stage);
      viewport = element("div", "xc-viewport");
      world = element("div", "xc-world");
      viewport.append(world);
      stage.append(viewport);
      outline = element("ol", "xc-outline");
      outline.id = `xc-outline-${instanceId}`;
      outline.hidden = !outlineOpen;
      stage.hidden = outlineOpen;
      outlineToggle.setAttribute("aria-controls", outline.id);
      live = element("p", "xc-live");
      live.setAttribute("aria-live", "polite");
      live.setAttribute("aria-atomic", "true");
      syncScenes();
      const choices = element("nav", "xc-choices");
      choices.setAttribute("aria-label", messages.choices);
      choices.hidden = true;
      choicesElement = options.controls === false ? undefined : choices;
      root.append(
        controls,
        stage,
        outline,
        live,
        emptyMessage,
        ...(choicesElement ? [choices] : []),
      );
      host.append(root);
      const listen = (
        target: EventTarget,
        event: string,
        handler: EventListener,
      ) => {
        target.addEventListener(event, handler);
        cleanup.push(() => target.removeEventListener(event, handler));
      };
      const resize = () => {
        if (!host || !viewport || !doc) return;
        stage.style.top = `${controls.offsetHeight}px`;
        // The bar wraps on narrow players: the outline fills what is left.
        if (outline)
          outline.style.maxHeight = `calc(100% - ${controls.offsetHeight}px)`;
        const bounds = stage.getBoundingClientRect();
        const fit = Math.min(
          bounds.width / doc.settings.viewport.width,
          bounds.height / doc.settings.viewport.height,
        );
        viewport.style.transform = `translate(-50%, -50%) scale(${fit})`;
      };
      machine = new NavigationMachine(
        doc,
        instanceId,
        () => clock!.now(),
        emit,
        render,
      );
      player.on("navigationstart", () => {
        if (focusRequested) {
          focusOrigin = host?.ownerDocument.activeElement ?? null;
          focusAllowed = true;
        }
      });
      player.on("scenechange", () => {
        if (focusRequested) {
          focusRequested = false;
          if (
            !focusAllowed ||
            (host?.ownerDocument.activeElement !== focusOrigin &&
              host?.ownerDocument.activeElement !== host?.ownerDocument.body)
          )
            return;
          if (outlineOpen)
            outline
              ?.querySelector<HTMLButtonElement>('[aria-current="true"]')
              ?.focus({ preventScroll: true });
          else if (state().sceneId) {
            const view = scenes.get(state().sceneId!);
            const target = view?.title.classList.contains("xc-title-hidden")
              ? view.content
              : view?.title;
            target?.focus({ preventScroll: true });
          }
        }
      });
      const applyMotion = () =>
        machine?.setReduced(
          outlineOpen ||
            manualReduced ||
            doc?.settings.presentation.motion === "reduced" ||
            media?.matches === true,
        );
      media = win.matchMedia("(prefers-reduced-motion: reduce)");
      listen(media, "change", applyMotion);
      listen(container.ownerDocument, "visibilitychange", () =>
        machine?.setHidden(container.ownerDocument.hidden),
      );
      listen(outlineToggle, "click", () => {
        outlineOpen = !outlineOpen;
        outline!.hidden = !outlineOpen;
        stage.hidden = outlineOpen;
        outlineToggle.setAttribute("aria-expanded", String(outlineOpen));
        applyMotion();
        render();
      });
      listen(motionToggle, "click", () => {
        manualReduced = !manualReduced;
        motionToggle.setAttribute("aria-pressed", String(manualReduced));
        applyMotion();
      });
      listen(overview, "click", () => {
        const result = player.setView("overview");
        if (!result.ok)
          emit("diagnostic", {
            instanceId,
            diagnostic: result.diagnostics[0]!,
          });
      });
      listen(choices, "click", (event) => {
        const button = (event.target as Element).closest<HTMLButtonElement>(
          "button[data-edge-id]",
        );
        if (button?.dataset.edgeId) {
          if (options.delegate)
            return options.delegate({
              kind: "next",
              edgeId: button.dataset.edgeId,
            });
          focusRequested = true;
          void player.next({ edgeId: button.dataset.edgeId });
        }
      });
      listen(outline, "click", (event) => {
        const button = (event.target as Element).closest<HTMLButtonElement>(
          "button[data-node-id]",
        );
        if (button?.dataset.nodeId) {
          if (options.delegate)
            return options.delegate({
              kind: "goTo",
              nodeId: button.dataset.nodeId,
            });
          focusRequested = true;
          void player.goTo({ nodeId: button.dataset.nodeId });
        }
      });
      if (options.input !== false)
        listen(container, "keydown", (event) => {
          const key = event as KeyboardEvent;
          if (
            key.defaultPrevented ||
            key.altKey ||
            key.ctrlKey ||
            key.metaKey ||
            key.shiftKey ||
            key
              .composedPath()
              .some(
                (target) =>
                  target instanceof win.Element &&
                  target.matches(
                    'input,textarea,select,[contenteditable]:not([contenteditable="false"]),audio,video,button,a',
                  ),
              )
          )
            return;
          const command = (options.keymap ?? {
            ArrowRight: "next",
            ArrowDown: "next",
            PageDown: "next",
            " ": "next",
            ArrowLeft: "prev",
            ArrowUp: "prev",
            PageUp: "prev",
          })[key.key];
          if (command) {
            key.preventDefault();
            if (options.delegate) return options.delegate({ kind: command });
            focusRequested = true;
            void player[command]();
          }
        });
      resizeView = resize;
      const observer = new win.ResizeObserver(resize);
      observer.observe(container);
      observer.observe(controls);
      cleanup.push(() => observer.disconnect());
      applyMotion();
      machine.setHidden(container.ownerDocument.hidden);
      render();
      resize();
      emit("ready", { instanceId });
      return { ok: true, value: undefined, diagnostics: [] };
    },
    async updateDocument(input) {
      if (destroyed) return failure("PLAYER_DESTROYED", "Player is destroyed");
      if (!machine) return failure("PLAYER_UNMOUNTED", "Player is not mounted");
      if (updating)
        return failure("UPDATE_IN_PROGRESS", "Document update is in progress");
      const validated = validateDocument(input);
      if (!validated.ok) return validated;
      updating = true;
      focusRequested = false;
      machine.replaceDocument(validated.value);
      if (destroyed) {
        updating = false;
        return failure(
          "PLAYER_DESTROYED",
          "Player was destroyed during update",
        );
      }
      doc = validated.value;
      shared = publicDocument(doc);
      release();
      revision++;
      root?.setAttribute(
        "aria-label",
        doc.metadata.title || messages.presentation,
      );
      if (root) root.lang = doc.metadata.language;
      syncScenes();
      machine.setReduced(
        outlineOpen ||
          manualReduced ||
          doc.settings.presentation.motion === "reduced" ||
          media?.matches === true,
      );
      resizeView();
      updating = false;
      render();
      emit("documentchange", { instanceId });
      return { ok: true, value: undefined, diagnostics: [] };
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      machine?.destroy();
      if (frame !== undefined) {
        clock?.cancel(frame);
        frame = undefined;
      }
      cleanup.splice(0).forEach((dispose) => dispose());
      clearContents();
      root?.remove();
      if (host) {
        if (oldTabindex === null) host.removeAttribute("tabindex");
        else host.setAttribute("tabindex", oldTabindex);
      }
      emit("destroy", { instanceId });
      handlers.clear();
      scenes.clear();
      host = undefined;
      root = undefined;
      viewport = undefined;
      world = undefined;
      outline = undefined;
      live = undefined;
      emptyMessage = undefined;
      outlineButton = undefined;
      stageElement = undefined;
      mediaButton = undefined;
      choicesElement = undefined;
      focusOrigin = null;
      doc = undefined;
      shared = undefined;
      captured = null;
      media = undefined;
      clock = undefined;
    },
    goTo: (target, opts) =>
      machine ? invoke(() => machine!.goTo(target, opts)) : unavailable(),
    next: (opts) =>
      machine ? invoke(() => machine!.next(opts)) : unavailable(),
    prev: () => (machine ? invoke(() => machine!.prev()) : unavailable()),
    setPath: (pathId) =>
      machine ? invoke(() => machine!.setPath(pathId)) : unavailable(),
    setView: (view) =>
      machine
        ? (release(), machine.setView(view))
        : failure(
            destroyed ? "PLAYER_DESTROYED" : "PLAYER_UNMOUNTED",
            "Player is unavailable",
          ),
    setCamera: (pose) =>
      machine
        ? (release(), machine.setCamera(pose))
        : failure(
            destroyed ? "PLAYER_DESTROYED" : "PLAYER_UNMOUNTED",
            "Player is unavailable",
          ),
    async renderAt(plan, elapsedMs) {
      if (!machine || !doc || !host || destroyed)
        return failure(
          destroyed ? "PLAYER_DESTROYED" : "PLAYER_UNMOUNTED",
          "Player is unavailable",
        );
      const d = doc;
      if (
        plan?.documentId !== d.id ||
        !Array.isArray(plan.visits) ||
        !d.paths.some((p) => p.id === plan.pathId) ||
        plan.visits.some((v) => !scenes.has(v?.sceneId))
      )
        return failure(
          "CAPTURE_PLAN_MISMATCH",
          "The capture plan was made for another document",
        );
      if (machine.peek().status === "transitioning")
        return failure(
          "CAPTURE_BUSY",
          "A navigation is in progress; capture players do not navigate",
        );
      let sample: CaptureSample;
      try {
        sample = sampleCapture(plan, elapsedMs);
      } catch (error) {
        return failure("INVALID_CAPTURE_TIME", String(error));
      }
      captured = sample;
      render();
      const win = host.ownerDocument.defaultView!;
      const frame = () =>
        new Promise<void>((resolve) =>
          typeof win.requestAnimationFrame === "function"
            ? win.requestAnimationFrame(() => resolve())
            : win.setTimeout(resolve, 16),
        );
      let timer: number | undefined;
      const timeout = new Promise<"timeout">((resolve) => {
        timer = win.setTimeout(() => resolve("timeout"), 20000);
      });
      const settle = async () => {
        await Promise.all(
          [...scenes.values()].flatMap((view) =>
            [...view.blocks.values()].map((b) => b.mount.ready()),
          ),
        );
        const fonts = host?.ownerDocument.fonts;
        // Layout first, so the text of this pose has requested its faces.
        root?.getBoundingClientRect();
        for (let i = 0; fonts && i < 3; i++) {
          await fonts.ready;
          if (fonts.status !== "loading") break;
        }
        await frame();
        await frame();
      };
      const outcome = await Promise.race([settle(), timeout]);
      win.clearTimeout(timer);
      if (destroyed || captured !== sample)
        return failure("CAPTURE_CANCELLED", "Capture superseded");
      return outcome === "timeout"
        ? failure("CAPTURE_TIMEOUT", "Content did not become ready in 20 s")
        : { ok: true, value: undefined, diagnostics: [] };
    },
    getState: state,
    on(event, handler) {
      if (destroyed) return () => {};
      let set = handlers.get(event);
      if (!set) {
        set = new Set();
        handlers.set(event, set);
      }
      const wrapped = (payload: unknown) =>
        handler(payload as PlayerEvents[typeof event]);
      set.add(wrapped);
      return () => {
        set.delete(wrapped);
      };
    },
  };
  return player;
}
