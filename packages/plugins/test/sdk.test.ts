import { expect, it } from "vitest";
import { PluginHost } from "../src/sdk/index.js";
import { RendererRegistry } from "../../player/src/content/index.js";
import { samplePlugin } from "../src/sample.js";
import type { ContentContext } from "../../player/src/content/index.js";
import { validateDocument } from "@xcursus/core";
import fixture from "../../../examples/content-gallery/project.json";
it.each([
  { id: "unqualified" },
  { version: "future" },
  { apiVersion: "2.0.0" },
])("rejects unsupported plugin descriptor %j before registration", (patch) => {
  const plugin = samplePlugin();
  Object.assign(plugin.descriptor, patch);
  expect(() => new PluginHost().register(plugin)).toThrow();
});
it("unregister/destroy are idempotent and a throwing dispose cannot strand other plugins", () => {
  const host = new PluginHost(),
    a = samplePlugin(),
    b = samplePlugin();
  b.descriptor.id = "org.test.other";
  let disposed = 0;
  a.dispose = () => {
    throw new Error("dispose failed");
  };
  b.dispose = () => {
    disposed++;
  };
  const off = host.register(a);
  expect(() => host.register(a)).toThrow();
  host.register(b);
  expect(() => off()).not.toThrow();
  off();
  host.destroy();
  host.destroy();
  expect(disposed).toBe(1);
});
it("aborts every live plugin and completes all teardown when a renderer destroy throws", () => {
  const valid = validateDocument(fixture);
  if (!valid.ok) throw new Error();
  const host = new PluginHost(),
    registry = new RendererRegistry(),
    signals: AbortSignal[] = [];
  let destroyed = 0;
  const a = samplePlugin(),
    b = samplePlugin();
  b.descriptor.id = "org.test.other";
  for (const plugin of [a, b]) {
    plugin.renderer = () => ({
      mount(_host, c) {
        signals.push(c.signal);
      },
      update() {},
      destroy() {
        destroyed++;
        if (plugin === a) throw new Error("destroy failed");
      },
    });
    host.register(plugin);
  }
  host.attach(registry);
  const context = (id: string): ContentContext => ({
    block: {
      id: "p",
      type: "plugin",
      data: {
        pluginId: id,
        apiVersion: "1.0.0",
        dataVersion: "1.0.0",
        payload: { label: "valid" },
      },
    },
    document: valid.value,
    active: true,
    mediaEnabled: false,
    mediaMuted: true,
    instanceId: id,
    signal: new AbortController().signal,
    services: {
      navigate: async () => ({ status: "noop" }),
      on: () => () => {},
      emit: () => {},
      report: () => {},
    },
  });
  for (const plugin of [a, b])
    registry.get("plugin")!().mount(
      { replaceChildren() {} } as unknown as HTMLElement,
      context(plugin.descriptor.id),
    );
  expect(() => host.destroy()).not.toThrow();
  expect(destroyed).toBe(2);
  expect(signals.every((s) => s.aborted)).toBe(true);
});
