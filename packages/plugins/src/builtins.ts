import { RendererRegistry, defaultMessages } from "@xcursus/player";
import type {
  ContentContext,
  ContentRenderer,
  RendererFactory,
} from "@xcursus/player";
import type { Block } from "@xcursus/core";
import { registerNavigation } from "./navigation.js";
import type { EmbedPolicy } from "./navigation.js";
import { PluginHost } from "./sdk/index.js";
import type { PluginDefinition } from "./sdk/index.js";

/**
 * A renderer whose module is imported the first time one of its blocks is
 * mounted. Load or mount failures become the same reported error state as a
 * synchronous renderer failure; `ready()` covers loading and the inner renderer.
 */
export function lazyRenderer(
  load: () => Promise<RendererFactory>,
): RendererFactory {
  // Shared by every block of the factory: after the first load, mounts are
  // synchronous again, like an eagerly imported renderer.
  let loaded: RendererFactory | undefined,
    pending: Promise<RendererFactory> | undefined;
  return () => {
    let host: HTMLElement,
      context: ContentContext,
      inner: ContentRenderer | undefined,
      destroyed = false;
    let loading: Promise<void> = Promise.resolve();
    const fail = (error: unknown) => {
      const messages = context.messages ?? defaultMessages;
      try {
        inner?.destroy();
      } catch {
        /* The error state below replaces the content anyway. */
      }
      inner = undefined;
      host.textContent = messages.contentError(String(error));
      host.lang = messages.lang;
      host.setAttribute("role", "status");
      context.services.report({
        code: "RENDERER_ERROR",
        severity: "warning",
        pointer: "",
        message: String(error),
      });
    };
    return {
      mount(element, next) {
        host = element;
        context = next;
        const start = (factory: RendererFactory) => {
          if (destroyed || context.signal.aborted) return;
          try {
            inner = factory();
            inner.mount(host, context);
          } catch (error) {
            fail(error);
          }
        };
        if (loaded) return start(loaded);
        pending ??= load().then((factory) => (loaded = factory));
        loading = pending.then(start, (error: unknown) => {
          // A failed import may be retried by a later mount.
          pending = undefined;
          if (!destroyed && !context.signal.aborted) fail(error);
        });
      },
      update(next) {
        context = next;
        try {
          inner?.update(next);
        } catch (error) {
          fail(error);
        }
      },
      destroy() {
        destroyed = true;
        inner?.destroy();
        inner = undefined;
      },
      async ready() {
        await loading;
        await inner?.ready?.();
      },
    };
  };
}

export interface BuiltinOptions {
  /** Embed origins approved by the host; none by default. */
  embed?: EmbedPolicy;
  /** Host-approved plugins. The demo badge is not a production builtin: pass `samplePlugin()` explicitly. */
  plugins?: readonly PluginDefinition[];
  /** Factories used instead of the builtin renderer of a type (export profiles, tests). */
  replace?: Partial<Record<Block["type"], RendererFactory>>;
}
/**
 * Builtin renderers for the eleven block types. Rich content (Markdown, HTML,
 * SVG, LaTeX) and media modules are loaded on demand, so a consumer bundler
 * emits them as separate chunks fetched only when a document uses them.
 */
export function createBuiltinRegistry(options: BuiltinOptions = {}) {
  const registry = new RendererRegistry(),
    plugins = new PluginHost();
  const replace = options.replace ?? {};
  for (const [type, factory] of Object.entries(replace))
    if (factory) registry.register(type as Block["type"], factory);
  const free = (type: Block["type"]) => !Object.hasOwn(replace, type);
  const rich = lazyRenderer(() =>
    import("./rich.js").then((m) => m.richRenderer),
  );
  for (const type of ["markdown", "html", "svg", "latex"] as const)
    if (free(type)) registry.register(type, rich);
  const media = lazyRenderer(() =>
    import("./media.js").then((m) => m.mediaRenderer),
  );
  for (const type of ["image", "audio", "video"] as const)
    if (free(type)) registry.register(type, media);
  const navigation = new RendererRegistry();
  registerNavigation(navigation, options.embed);
  for (const type of ["link", "embed"] as const)
    if (free(type)) registry.register(type, navigation.get(type)!);
  if (free("plugin")) {
    for (const plugin of options.plugins ?? []) plugins.register(plugin);
    plugins.attach(registry);
  }
  return { registry, plugins };
}
