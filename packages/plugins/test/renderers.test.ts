// @vitest-environment jsdom
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { validateDocument } from "@xcursus/core";
import type { Block, ProjectDocument } from "@xcursus/core";
import fixture from "../../../examples/content-gallery/project.json";
import { AssetError, RendererRegistry, defaultMessages } from "@xcursus/player";
import type {
  AssetResolver,
  ContentContext,
  PlayerMessages,
} from "@xcursus/player";
import { registerMedia } from "../src/media.js";
import { registerRich } from "../src/rich.js";
import { registerNavigation } from "../src/navigation.js";
import { sanitizeContent } from "../src/security.js";
import { PluginHost } from "../src/sdk/index.js";
import { samplePlugin } from "../src/sample.js";
const messages: PlayerMessages = {
  ...defaultMessages,
  lang: "en",
  formulaInvalid: (text) => `Invalid formula: ${text}`,
  mediaLoading: "Loading local resource…",
  mediaPlay: (label) => `Play ${label}`,
  mediaRejected: "Playback refused.",
  mediaDecodeError: "Media cannot be decoded.",
  imageDecodeError: "Image cannot be decoded.",
  assetMissing: (id) => `Missing resource: ${id}`,
  assetInvalid: (id) => `Invalid resource: ${id}`,
  embedUnauthorized: "Embed disabled: origin not allowed.",
  embedDisabled: "External web content disabled.",
  embedConsent: (title) => `Allow embed: ${title}`,
  embedOffline: "Embed unavailable offline.",
  embedActive: "Isolated embed, scripts disabled.",
  embedRevoke: "Revoke embed consent",
  embedRevoked: "Embed disabled.",
  pluginUnavailable: (id, version) => `Plugin unavailable: ${id} (${version})`,
  pluginOffline: "Plugin unavailable offline.",
};
let doc: ProjectDocument;
beforeAll(() => {
  const result = validateDocument(fixture);
  if (!result.ok) throw new Error("fixture");
  doc = result.value;
  let n = 0;
  URL.createObjectURL = () => `blob:test/${++n}`;
  URL.revokeObjectURL = () => {};
});
beforeEach(() => {
  for (const method of ["load", "pause"] as const)
    vi.spyOn(window.HTMLMediaElement.prototype, method).mockImplementation(
      () => {},
    );
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const blockOf = (sceneId: string) =>
  structuredClone(doc.scenes.find((s) => s.id === sceneId)!.blocks[0]!);
function mount(
  registry: RendererRegistry,
  block: Block,
  patch: Partial<ContentContext> = {},
  withMessages = true,
) {
  const host = document.createElement("div");
  document.body.append(host);
  const errors: string[] = [];
  const controller = new AbortController();
  const context: ContentContext = {
    block,
    document: doc,
    instanceId: "test",
    active: true,
    mediaEnabled: false,
    mediaMuted: true,
    signal: controller.signal,
    services: {
      navigate: async () => ({ status: "completed" }),
      on: () => () => {},
      emit() {},
      report() {},
      mediaError: (message) => errors.push(message),
    },
    ...(withMessages ? { messages } : {}),
    ...patch,
  };
  const renderer = registry.get(block.type)!();
  renderer.mount(host, context);
  return { host, renderer, errors, context, controller };
}
const resolver = (blobs: Record<string, Blob>): AssetResolver => ({
  async resolve(id) {
    const blob = blobs[id];
    if (!blob) throw new AssetError("missing", `missing ${id}`);
    return { url: `blob:${id}`, mime: blob.type, blob, release() {} };
  },
});
describe("media renderer", () => {
  it("marks video playsinline and localizes controls, loading and missing assets", async () => {
    const registry = new RendererRegistry();
    registerMedia(registry);
    const video = blockOf("video");
    const pending = mount(registry, video, {
      services: {
        navigate: async () => ({ status: "completed" }),
        on: () => () => {},
        emit() {},
        report() {},
        assets: resolver({
          motion: new Blob(["mp4"], { type: "video/mp4" }),
          diagram: new Blob(
            ['<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'],
            { type: "image/svg+xml" },
          ),
          captions: new Blob(["WEBVTT\n"], { type: "text/vtt" }),
        }),
      },
    });
    expect(pending.host.textContent).toContain("Loading local resource…");
    await flush();
    const element = pending.host.querySelector("video")!;
    expect(element.hasAttribute("playsinline")).toBe(true);
    expect(pending.host.querySelector("button")!.textContent).toBe(
      `Play ${video.type === "video" ? video.data.label : ""}`,
    );
    expect(
      pending.host.querySelector<HTMLElement>("button")!.lang ||
        pending.host.lang,
    ).toBe("en");
    const missing = mount(registry, blockOf("audio"), {
      services: {
        navigate: async () => ({ status: "completed" }),
        on: () => () => {},
        emit() {},
        report() {},
        mediaError: () => {},
        assets: resolver({}),
      },
    });
    await flush();
    expect(missing.host.textContent).toContain("Missing resource: tone");
  });
  it("reports refused playback and decode failures with replaceable messages", async () => {
    const registry = new RendererRegistry();
    registerMedia(registry);
    vi.spyOn(window.HTMLMediaElement.prototype, "play").mockRejectedValue(
      new Error("NotAllowedError"),
    );
    const audio = blockOf("audio");
    const view = mount(registry, audio, {
      services: {
        navigate: async () => ({ status: "completed" }),
        on: () => () => {},
        emit() {},
        report() {},
        mediaError: (m) => view.errors.push(m),
        assets: resolver({ tone: new Blob(["RIFF"], { type: "audio/wav" }) }),
      },
    });
    await flush();
    view.host.querySelector("button")!.click();
    await flush();
    expect(view.host.textContent).toContain("Playback refused.");
    view.host.querySelector("audio")!.dispatchEvent(new Event("error"));
    view.host
      .querySelector<HTMLMediaElement>("audio")!
      .onerror?.(new Event("error"));
    expect(view.host.textContent).toContain("Media cannot be decoded.");
    view.renderer.destroy();
  });
  it("falls back to default Italian messages when the context has none", async () => {
    const registry = new RendererRegistry();
    registerMedia(registry);
    const view = mount(
      registry,
      blockOf("audio"),
      {
        services: {
          navigate: async () => ({ status: "completed" }),
          on: () => () => {},
          emit() {},
          report() {},
          mediaError: () => {},
          assets: resolver({}),
        },
      },
      false,
    );
    await flush();
    expect(view.host.textContent).toContain(
      defaultMessages.assetMissing("tone"),
    );
  });
});
describe("rich, navigation and plugin placeholders", () => {
  it("localizes invalid formulas", () => {
    const registry = new RendererRegistry();
    registerRich(registry);
    const latex = blockOf("latex");
    if (latex.type === "latex") latex.data.source = "\\notacommand{";
    const view = mount(registry, latex);
    expect(view.host.textContent).toContain("Invalid formula:");
  });
  it("localizes embed states and consent", () => {
    const registry = new RendererRegistry();
    registerNavigation(registry, { allowedOrigins: ["https://example.org"] });
    const embed = blockOf("embed");
    if (embed.type === "embed") embed.data.url = "https://denied.example.net/";
    const denied = mount(registry, embed);
    expect(denied.host.textContent).toContain(
      "Embed disabled: origin not allowed.",
    );
    if (embed.type === "embed") embed.data.url = "https://example.org/page";
    const allowed = mount(registry, embed);
    expect(allowed.host.textContent).toContain(
      "External web content disabled.",
    );
    expect(allowed.host.querySelector("button")!.textContent).toContain(
      "Allow embed:",
    );
  });
  it("localizes missing plugin placeholders", () => {
    const registry = new RendererRegistry(),
      host = new PluginHost();
    host.register(samplePlugin());
    host.attach(registry);
    const plugin = blockOf("plugin");
    if (plugin.type === "plugin") plugin.data.pluginId = "org.example.absent";
    const view = mount(registry, plugin);
    expect(view.host.textContent).toBe(
      "Plugin unavailable: org.example.absent (1.0.0)",
    );
    host.destroy();
  });
});
describe("sanitization pipeline", () => {
  it("removes active HTML and keeps safe structure", () => {
    const host = document.createElement("div");
    const fragment = sanitizeContent(
      host,
      '<p onclick="x()">ok <a href="javascript:alert(1)">bad</a> <a href="https://user:pw@example.org/">cred</a> <a href="https://example.org/a">good</a></p><script>bad()</script><iframe src="https://example.org"></iframe><style>p{}</style><form><input></form>',
      "html",
      "p",
    );
    host.append(fragment);
    expect(host.querySelector("script,iframe,style,form,input")).toBeNull();
    expect(host.querySelector("[onclick]")).toBeNull();
    const links = [...host.querySelectorAll("a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual([
      null,
      null,
      "https://example.org/a",
    ]);
    expect(links[2]!.rel).toBe("noopener noreferrer");
  });
  it("rewrites local SVG references per instance and drops external or active ones", () => {
    const host = document.createElement("div");
    host.append(
      sanitizeContent(
        host,
        '<svg><defs><linearGradient id="g"/><clipPath id="c"/></defs><rect fill="url(#g)" clip-path="url(#c)" stroke="url(https://x/#a)"/><use href="#g"/><use href="https://example.org/x.svg#a"/><rect fill="expression(alert(1))"/><foreignObject><p>x</p></foreignObject><animate attributeName="x"/><script>bad()</script></svg>',
        "svg",
        "inst",
      ),
    );
    const ids = [...host.querySelectorAll("[id]")].map((e) => e.id);
    expect(ids.every((id) => id.startsWith("xc-inst-"))).toBe(true);
    const rect = host.querySelector("rect")!;
    expect(rect.getAttribute("fill")).toBe(`url(#${ids[0]})`);
    expect(rect.getAttribute("stroke")).toBeNull();
    const uses = [...host.querySelectorAll("use")];
    expect(uses[0]!.getAttribute("href")).toBe(`#${ids[0]}`);
    expect(uses[1]!.getAttribute("href")).toBeNull();
    expect(host.querySelectorAll("rect")[1]!.getAttribute("fill")).toBeNull();
    expect(host.querySelector("foreignObject,animate,script")).toBeNull();
  });
});
describe("media lifecycle", () => {
  const services = (assets: AssetResolver, errors: string[] = []) => ({
    navigate: async () => ({ status: "completed" as const }),
    on: () => () => {},
    emit() {},
    report() {},
    mediaError: (m: string) => errors.push(m),
    assets,
  });
  it("autoplays only when enabled and active, stops or pauses on exit and releases every lease", async () => {
    const registry = new RendererRegistry();
    registerMedia(registry);
    const play = vi
      .spyOn(window.HTMLMediaElement.prototype, "play")
      .mockResolvedValue(undefined);
    const released: string[] = [];
    const assets: AssetResolver = {
      async resolve(id) {
        return {
          url: `blob:${id}`,
          mime: id === "diagram" ? "image/svg+xml" : "video/mp4",
          blob: new Blob(
            id === "diagram"
              ? ['<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>']
              : ["data"],
            { type: id === "diagram" ? "image/svg+xml" : "video/mp4" },
          ),
          release: () => released.push(id),
        };
      },
    };
    const audio = blockOf("audio");
    const view = mount(registry, audio, {
      active: false,
      services: services(assets),
    });
    await flush();
    const element = view.host.querySelector("audio")!;
    const time = vi.spyOn(element, "currentTime", "set");
    view.renderer.update({ ...view.context, active: true, mediaEnabled: true });
    await flush();
    expect(play).toHaveBeenCalledTimes(1);
    view.renderer.update({
      ...view.context,
      active: false,
      mediaEnabled: true,
    });
    expect(time).toHaveBeenCalledWith(0);
    const video = blockOf("video");
    const clip = mount(registry, video, { services: services(assets) });
    await flush();
    expect(clip.host.querySelector("video")!.poster).toMatch(/^blob:test/);
    expect(clip.host.querySelector("track")!.srclang).toBe("en");
    clip.renderer.update({ ...clip.context, active: false });
    expect(time).toHaveBeenCalledTimes(1);
    clip.renderer.destroy();
    view.renderer.destroy();
    expect(released.sort()).toEqual(["captions", "diagram", "motion", "tone"]);
  });
  it("renders local SVG images through the sanitizer and reports invalid ones", async () => {
    const registry = new RendererRegistry();
    registerMedia(registry);
    const image = blockOf("image");
    const errors: string[] = [];
    const ok = mount(registry, image, {
      services: services(
        resolver({
          diagram: new Blob(
            [
              '<svg xmlns="http://www.w3.org/2000/svg"><script>x()</script><rect/></svg>',
            ],
            { type: "image/svg+xml" },
          ),
        }),
        errors,
      ),
    });
    await flush();
    expect(ok.host.querySelector("img")!.alt).toBe(
      image.type === "image" ? image.data.alt : "",
    );
    ok.host.querySelector("img")!.onerror?.(new Event("error"));
    expect(ok.host.textContent).toContain("Image cannot be decoded.");
    const bad = mount(registry, image, {
      services: services(
        resolver({
          diagram: new Blob(["<html/>"], { type: "image/svg+xml" }),
        }),
        errors,
      ),
    });
    await flush();
    expect(bad.host.textContent).toContain("Invalid resource: diagram");
    const none = mount(registry, image, {
      services: {
        navigate: async () => ({ status: "completed" }),
        on: () => () => {},
        emit() {},
        report() {},
        mediaError: (m) => errors.push(m),
      },
    });
    expect(none.host.textContent).toContain("Missing resource: diagram");
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });
  it("aborted loads never report errors or keep leases", async () => {
    const registry = new RendererRegistry();
    registerMedia(registry);
    const released: string[] = [];
    let unblock = () => {};
    const gate = new Promise<void>((resolve) => (unblock = resolve));
    const errors: string[] = [];
    const view = mount(registry, blockOf("audio"), {
      services: services(
        {
          async resolve(id) {
            await gate;
            return {
              url: `blob:${id}`,
              mime: "audio/wav",
              release: () => released.push(id),
            };
          },
        },
        errors,
      ),
    });
    view.controller.abort();
    view.renderer.destroy();
    unblock();
    await flush();
    expect(released).toEqual(["tone"]);
    expect(errors).toEqual([]);
  });
});
