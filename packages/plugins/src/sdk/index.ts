import type { JsonValue } from "@xcursus/core";
import { defaultMessages } from "@xcursus/player";
import type {
  ContentContext,
  ContentRenderer,
  RendererRegistry,
} from "@xcursus/player";
export const PLUGIN_API_VERSION = "1.0.0" as const;
export interface DataSchema {
  schema: JsonValue;
  validate(value: JsonValue): boolean;
}
export interface PluginDescriptor {
  id: string;
  version: string;
  apiVersion: "1.0.0";
  capabilities: { offline: boolean; capture: boolean };
  dataSchemas: Readonly<Record<string, DataSchema>>;
  settingsSchemas?: Readonly<Record<string, DataSchema>>;
}
export interface PluginDefinition {
  descriptor: PluginDescriptor;
  renderer(): ContentRenderer;
  /** Explicit host migration only; never automatically rewrites missing plugin data. */
  migrations?: Readonly<
    Record<
      string,
      (payload: JsonValue) => { dataVersion: string; payload: JsonValue }
    >
  >;
  dispose?(): void;
}
export interface PluginInspector {
  pluginId: string;
  label: string;
  edit(payload: JsonValue, field: string, value: string): JsonValue;
  fields: readonly string[];
}
/**
 * Whether remote content can be reached, asked each time a block renders.
 * `navigator.onLine === false` reliably means offline, but `true` only means
 * a network interface is up: a kiosk, a captive portal or a file opened from
 * disk under a CSP without connections still cannot reach anything. Hosts
 * that know better pass their own signal; the default is `navigator.onLine`.
 */
export type NetworkSignal = () => boolean;
export interface PluginHostOptions {
  online?: NetworkSignal;
}
/** Installed JS is trusted host code, not a sandbox. No URL or module field is read from a project. */
export class PluginHost {
  constructor(private readonly options: PluginHostOptions = {}) {}
  private plugins = new Map<string, PluginDefinition>();
  private unregister: (() => void) | undefined;
  private live = new Set<{ id: string; clear: () => void }>();
  register(plugin: PluginDefinition): () => void {
    const d = plugin.descriptor;
    if (
      !/^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(d.id) ||
      d.apiVersion !== PLUGIN_API_VERSION ||
      !/^\d+\.\d+\.\d+$/.test(d.version) ||
      this.plugins.has(d.id)
    )
      throw new Error("Invalid/duplicate plugin descriptor");
    this.plugins.set(d.id, plugin);
    return () => {
      if (this.plugins.get(d.id) === plugin) {
        this.plugins.delete(d.id);
        for (const owner of [...this.live])
          if (owner.id === d.id) owner.clear();
        try {
          plugin.dispose?.();
        } catch {
          /* One plugin cannot prevent other teardown. */
        }
      }
    };
  }
  attach(registry: RendererRegistry): () => void {
    if (this.unregister) throw new Error("PluginHost already attached");
    this.unregister = registry.register("plugin", () => this.renderer());
    return () => {
      this.unregister?.();
      this.unregister = undefined;
    };
  }
  private renderer(): ContentRenderer {
    let host: HTMLElement,
      current: ContentRenderer | undefined,
      identity = "",
      child: AbortController | undefined,
      removeAbort: (() => void) | undefined;
    let owner: { id: string; clear: () => void } | undefined;
    const clear = () => {
      if (owner) this.live.delete(owner);
      owner = undefined;
      removeAbort?.();
      child?.abort();
      try {
        current?.destroy();
      } catch {
        /* Resources owned by the host still release below. */
      } finally {
        current = undefined;
        identity = "";
        host.replaceChildren();
      }
    };
    const placeholder = (context: ContentContext, text: string) => {
      const messages = context.messages ?? defaultMessages;
      const span = host.ownerDocument.createElement("span");
      span.lang = messages.lang;
      span.textContent = text;
      host.append(span);
    };
    const update = (context: ContentContext) => {
      const b = context.block;
      if (b.type !== "plugin") return;
      const messages = context.messages ?? defaultMessages;
      const plugin = this.plugins.get(b.data.pluginId),
        schema = plugin?.descriptor.dataSchemas[b.data.dataVersion],
        settings = context.document.pluginSettings?.[b.data.pluginId];
      const settingsSchema = settings
        ? plugin?.descriptor.settingsSchemas?.[settings.dataVersion]
        : undefined;
      if (
        !plugin ||
        b.data.apiVersion !== PLUGIN_API_VERSION ||
        !schema ||
        !schema.validate(b.data.payload) ||
        (settings &&
          (!settingsSchema ||
            settings.apiVersion !== PLUGIN_API_VERSION ||
            !settingsSchema.validate(settings.data)))
      ) {
        clear();
        identity = "";
        placeholder(
          context,
          messages.pluginUnavailable(b.data.pluginId, b.data.dataVersion),
        );
        host.setAttribute("role", "status");
        return;
      }
      const online =
        this.options.online ??
        (() => host.ownerDocument.defaultView!.navigator.onLine);
      if (!plugin.descriptor.capabilities.offline && !online()) {
        clear();
        identity = "";
        placeholder(context, messages.pluginOffline);
        return;
      }
      const key = JSON.stringify([
        b.data.pluginId,
        b.data.apiVersion,
        b.data.dataVersion,
      ]);
      if (key !== identity) {
        clear();
        identity = key;
        child = new AbortController();
        const abort = () => child?.abort();
        context.signal.addEventListener("abort", abort, { once: true });
        removeAbort = () => context.signal.removeEventListener("abort", abort);
        owner = { id: b.data.pluginId, clear };
        this.live.add(owner);
        current = plugin.renderer();
        current.mount(host, services(context, child.signal));
      } else current?.update(services(context, child!.signal));
    };
    function services(
      context: ContentContext,
      signal: AbortSignal,
    ): ContentContext {
      const b = context.block;
      return {
        ...context,
        signal,
        services: {
          ...context.services,
          on: (event, handler) => {
            const off = context.services.on(event, handler);
            signal.addEventListener("abort", off, { once: true });
            return off;
          },
          emit: (name, payload) => {
            if (b.type === "plugin" && name.startsWith(b.data.pluginId + ":"))
              context.services.emit(name, payload);
            else throw new Error("Plugin events must be namespaced");
          },
        },
      };
    }
    return {
      mount(element, context) {
        host = element;
        update(context);
      },
      update,
      destroy: clear,
    };
  }
  destroy() {
    this.unregister?.();
    this.unregister = undefined;
    for (const owner of [...this.live]) owner.clear();
    for (const p of this.plugins.values())
      try {
        p.dispose?.();
      } catch {
        /* Dispose the remaining plugins. */
      }
    this.plugins.clear();
  }
}
