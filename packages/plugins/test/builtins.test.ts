// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { validateDocument } from "@xcursus/core";
import type { ProjectDocument } from "@xcursus/core";
import fixture from "../../../examples/content-gallery/project.json";
import { ContentMount, defaultMessages } from "@xcursus/player";
import type {
  ContentContext,
  ContentRenderer,
  RendererFactory,
} from "@xcursus/player";
import { createBuiltinRegistry, lazyRenderer } from "../src/builtins.js";
import { samplePlugin } from "../src/sample.js";

const doc = (() => {
  const r = validateDocument(fixture);
  if (!r.ok) throw new Error("fixture");
  return r.value as ProjectDocument;
})();
const block = (type: string) =>
  doc.scenes.flatMap((s) => s.blocks).find((b) => b.type === type)!;
function context(type: string, reports: string[] = []) {
  return {
    block: block(type),
    document: doc,
    instanceId: "t",
    active: true,
    mediaEnabled: false,
    mediaMuted: true,
    messages: defaultMessages,
    services: {
      navigate: async () => ({ status: "noop" as const }),
      on: () => () => {},
      emit: () => {},
      report: (d: { code: string }) => reports.push(d.code),
    },
  } as unknown as Omit<ContentContext, "signal">;
}

describe("renderers on demand (0.6)", () => {
  it("imports the module on the first mount only and reports readiness", async () => {
    let loads = 0;
    const mounted: string[] = [];
    const factory = lazyRenderer(async () => {
      loads++;
      return (): ContentRenderer => ({
        mount: (host) => void (host.textContent = "inner"),
        update: () => mounted.push("update"),
        destroy: () => mounted.push("destroy"),
      });
    });
    const hostA = document.createElement("div"),
      hostB = document.createElement("div");
    const a = factory(),
      b = factory();
    const controller = new AbortController();
    a.mount(hostA, { ...context("markdown"), signal: controller.signal });
    b.mount(hostB, { ...context("markdown"), signal: controller.signal });
    expect(hostA.textContent).toBe("");
    await a.ready!();
    await b.ready!();
    expect(hostA.textContent).toBe("inner");
    expect(hostB.textContent).toBe("inner");
    // One import per factory; once loaded, a new block mounts synchronously.
    expect(loads).toBe(1);
    const hostC = document.createElement("div");
    factory().mount(hostC, {
      ...context("markdown"),
      signal: controller.signal,
    });
    expect(hostC.textContent).toBe("inner");
    expect(loads).toBe(1);
    a.destroy();
    expect(mounted).toEqual(["destroy"]);
  });
  it("a failed import becomes the reported error state of the block", async () => {
    const reports: string[] = [];
    const host = document.createElement("div");
    const mount = new ContentMount(host, context("markdown", reports), {
      get: () => lazyRenderer(() => Promise.reject(new Error("chunk missing"))),
    } as never);
    await mount.ready();
    expect(host.textContent).toContain("chunk missing");
    expect(host.getAttribute("role")).toBe("status");
    expect(reports).toEqual(["RENDERER_ERROR"]);
  });
  it("loads the real rich renderer lazily and renders KaTeX through the DOM", async () => {
    const { registry } = createBuiltinRegistry();
    const host = document.createElement("div");
    document.body.append(host);
    const mount = new ContentMount(host, context("latex"), registry);
    await mount.ready();
    const katex = host.querySelector(".katex");
    expect(katex).not.toBeNull();
    // Positioning styles exist as CSSOM properties, never as parsed markup.
    expect(host.querySelector(".katex-html")).not.toBeNull();
    expect(host.querySelector("math")).not.toBeNull();
    // A named formula is a math region (a generic element may not carry aria-label).
    const block = context("latex").block;
    if (block.type === "latex" && block.data.alt) {
      const named = host.hasAttribute("aria-label")
        ? host
        : host.querySelector("[aria-label]");
      expect(named?.getAttribute("role")).toBe("math");
      expect(named?.getAttribute("aria-label")).toBe(block.data.alt);
    }
    mount.destroy();
  });
  it("the demo badge is not a builtin; hosts approve it explicitly", () => {
    expect(createBuiltinRegistry().plugins).toBeDefined();
    const host = document.createElement("div");
    const without = new ContentMount(
      host,
      context("plugin"),
      createBuiltinRegistry().registry,
    );
    expect(host.textContent).toContain("org.xcursus.badge");
    without.destroy();
    const approved = createBuiltinRegistry({ plugins: [samplePlugin()] });
    const host2 = document.createElement("div");
    const withBadge = new ContentMount(
      host2,
      context("plugin"),
      approved.registry,
    );
    expect(host2.classList.contains("xc-plugin-badge")).toBe(true);
    withBadge.destroy();
  });
  it("replace swaps single builtin types, e.g. for export profiles", () => {
    const placeholder: RendererFactory = () => ({
      mount: (host) => void (host.textContent = "placeholder"),
      update() {},
      destroy() {},
    });
    const { registry } = createBuiltinRegistry({
      replace: { embed: placeholder },
    });
    expect(registry.get("embed")).toBe(placeholder);
    expect(registry.get("link")).toBeDefined();
    expect(registry.get("link")).not.toBe(placeholder);
  });
});
