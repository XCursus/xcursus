import type {
  Block,
  ProjectDocument,
  JsonValue,
  NavigationResult,
  PlayerEvents,
  Diagnostic,
} from "@xcursus/core";
import type { AssetResolver } from "../assets/index.js";
import { defaultMessages } from "../messages.js";
import type { PlayerMessages } from "../messages.js";
export interface ContentServices {
  assets?: AssetResolver;
  navigate(target: {
    pathId: string;
    nodeId: string;
  }): Promise<NavigationResult>;
  on<K extends keyof PlayerEvents>(
    event: K,
    handler: (payload: PlayerEvents[K]) => void,
  ): () => void;
  emit(name: string, payload: JsonValue): void;
  report(diagnostic: Diagnostic): void;
  mediaError?(message: string): void;
}
export interface ContentContext {
  block: Block;
  document: ProjectDocument;
  instanceId: string;
  active: boolean;
  mediaEnabled: boolean;
  mediaMuted: boolean;
  signal: AbortSignal;
  services: ContentServices;
  /** Replaceable texts for builtin renderers; absent only when a host builds contexts itself. */
  messages?: Readonly<PlayerMessages>;
}
export interface ContentRenderer {
  mount(host: HTMLElement, context: ContentContext): void;
  update(context: ContentContext): void;
  destroy(): void;
  /**
   * Optional (additive in 0.6, plugin API stays 1.0.0): resolves when the
   * rendered content is complete, e.g. after an asset loaded or failed.
   * Capture waits for it; a renderer without it is ready after mount/update.
   */
  ready?(): Promise<void>;
}
export type RendererFactory = () => ContentRenderer;
export class RendererRegistry {
  private factories = new Map<Block["type"], RendererFactory>();
  register(type: Block["type"], factory: RendererFactory): () => void {
    if (this.factories.has(type))
      throw new Error(`Renderer already registered: ${type}`);
    this.factories.set(type, factory);
    return () => {
      if (this.factories.get(type) === factory) this.factories.delete(type);
    };
  }
  get(type: Block["type"]): RendererFactory | undefined {
    return this.factories.get(type);
  }
}
/** Accessible plain text of a block: text, alt, label or title, never Markdown/HTML/SVG/LaTeX source. */
export function blockText(
  block: Block,
  messages: Readonly<PlayerMessages> = defaultMessages,
): string {
  const d = block.data;
  return "text" in d
    ? d.text
    : "alt" in d
      ? d.alt
      : "label" in d
        ? d.label
        : "title" in d
          ? d.title
          : "pluginId" in d
            ? messages.pluginContent(d.pluginId)
            : "";
}
/** The boundary owns abort, renderer and DOM, including failed mounts/updates. */
export class ContentMount {
  private renderer: ContentRenderer | undefined;
  private controller = new AbortController();
  private last = "";
  private disposed = false;
  private failure = false;
  private active = false;
  private mediaEnabled: boolean;
  constructor(
    private host: HTMLElement,
    private context: Omit<ContentContext, "signal">,
    registry?: RendererRegistry,
  ) {
    this.mediaEnabled = context.mediaEnabled;
    const factory = registry?.get(context.block.type);
    if (!factory) {
      if (context.block.type === "text")
        host.textContent = context.block.data.text;
      else {
        host.textContent = this.messages.contentUnavailable(context.block.type);
        host.lang = this.messages.lang;
      }
      return;
    }
    try {
      this.renderer = factory();
      this.renderer.mount(host, { ...context, signal: this.controller.signal });
    } catch (error) {
      this.fail(error);
    }
  }
  private get messages() {
    return this.context.messages ?? defaultMessages;
  }
  /** True after a renderer threw: the next document update rebuilds the block. */
  get failed(): boolean {
    return this.failure;
  }
  /** True while a registered renderer owns the host content. */
  get rendered(): boolean {
    return !!this.renderer && !this.disposed;
  }
  /** Content complete for capture; failures and placeholders are ready at once. */
  async ready(): Promise<void> {
    if (this.disposed || !this.renderer?.ready) return;
    try {
      await this.renderer.ready();
    } catch {
      /* A failed asset is still a stable, captured placeholder. */
    }
  }
  update(active: boolean, mediaEnabled: boolean) {
    const key = `${active}:${mediaEnabled}`;
    if (this.disposed || key === this.last) return;
    this.last = key;
    this.active = active;
    this.mediaEnabled = mediaEnabled;
    this.call();
  }
  /** New document snapshot whose data for this block is unchanged: no remount, renderers see it via update(). */
  refresh(document: ProjectDocument) {
    if (this.disposed || this.context.document === document) return;
    this.context = { ...this.context, document };
    this.call();
  }
  private call() {
    try {
      this.renderer?.update({
        ...this.context,
        active: this.active,
        mediaEnabled: this.mediaEnabled,
        signal: this.controller.signal,
      });
    } catch (error) {
      this.fail(error);
    }
  }
  private fail(error: unknown) {
    this.destroy();
    this.failure = true;
    this.host.textContent = this.messages.contentError(String(error));
    this.host.lang = this.messages.lang;
    this.host.setAttribute("role", "status");
    this.context.services.report({
      code: "RENDERER_ERROR",
      severity: "warning",
      pointer: "",
      message: String(error),
    });
  }
  destroy() {
    if (this.disposed) return;
    this.disposed = true;
    this.controller.abort();
    try {
      this.renderer?.destroy();
    } catch {
      /* Other renderers still dispose. */
    }
    this.renderer = undefined;
    this.host.replaceChildren();
  }
}
