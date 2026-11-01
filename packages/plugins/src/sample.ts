import type { JsonValue } from "@xcursus/core";
import type { ContentContext, ContentRenderer } from "@xcursus/player";
import type { PluginDefinition, PluginInspector } from "./sdk/index.js";
const valid = (value: JsonValue) =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === 1 &&
  typeof value.label === "string" &&
  value.label.length <= 2000;
/** Identifier of the demo badge plugin. */
export const SAMPLE_PLUGIN_ID = "org.xcursus.badge";
/**
 * Identifier the same plugin had before the product was renamed. Documents
 * keep plugin IDs as data, so hosts that approve the badge also register it
 * under this ID to keep rendering earlier documents unchanged.
 */
export const LEGACY_SAMPLE_PLUGIN_ID = "org.spatialdeck.badge";
export const SAMPLE_PLUGIN_IDS: readonly string[] = [
  SAMPLE_PLUGIN_ID,
  LEGACY_SAMPLE_PLUGIN_ID,
];
export function samplePlugin(id: string = SAMPLE_PLUGIN_ID): PluginDefinition {
  return {
    descriptor: {
      id,
      version: "1.0.0",
      apiVersion: "1.0.0",
      capabilities: { offline: true, capture: false },
      dataSchemas: {
        "1.0.0": {
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["label"],
            properties: { label: { type: "string", maxLength: 2000 } },
          },
          validate: valid,
        },
      },
    },
    renderer: (): ContentRenderer => {
      let host: HTMLElement, off: (() => void) | undefined;
      function update(context: ContentContext) {
        if (context.block.type !== "plugin") return;
        host.textContent = String(
          (context.block.data.payload as { label: string }).label,
        );
        host.classList.add("xc-plugin-badge");
      }
      return {
        mount(element, context) {
          host = element;
          update(context);
          off = context.services.on("cue", ({ cue }) =>
            context.services.emit(`${id}:cue`, cue.payload),
          );
        },
        update,
        destroy() {
          off?.();
          host.classList.remove("xc-plugin-badge");
          host.replaceChildren();
        },
      };
    },
  };
}
/** Editor entrypoint has no React dependency; edits are committed by the host store. */
export const sampleInspector: PluginInspector = {
  pluginId: SAMPLE_PLUGIN_ID,
  label: "Local badge",
  fields: ["label"],
  edit(payload, field, value) {
    if (field !== "label" || !valid(payload))
      throw new Error("Invalid badge data");
    return { label: value };
  },
};
