import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { validateDocument } from "@xcursus/core";
import { importImpress, localPath } from "@xcursus/impress-compat";
import { candidate, deck } from "./helpers.js";

const png = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72,
]);
const mp4 = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50]);
const text = (s: string) => new TextEncoder().encode(s);
const codes = (list: Array<{ code: string }>) => list.map((d) => d.code);

describe("content conversion", () => {
  test("markup, headings, notes and substeps in reading order", () => {
    const c = candidate(
      deck(
        `<div class="step" id="a">
          <h1 class="title" data-foo="1">Main <em>title</em></h1>
          <p style="color:red" onclick="steal()">Text with <a href="https://example.org/x" target="_blank">a link</a>,
            <a href="#/b">an internal one</a> and <a href="javascript:alert(1)">an active one</a>.</p>
          <ul><li class="substep">one</li><li>two</li></ul>
          <table><tr><th scope="col">h</th></tr><tr><td colspan="2">c</td></tr></table>
          <pre>
  indented</pre>
          <article><small>unwrapped</small></article>
          <div class="notes">Remember
            the demo</div>
        </div>`,
      ),
    );
    const scene = c.document.scenes[0]!;
    expect(scene.title).toBe("Main title");
    expect(scene.notes).toBe("Remember\nthe demo");
    expect(scene.blocks).toHaveLength(1);
    const source = (scene.blocks[0]!.data as { source: string }).source;
    expect(source).toContain("<h1>Main <em>title</em></h1>");
    expect(source).toContain('<a href="https://example.org/x">a link</a>');
    expect(source).toContain("<a>an internal one</a>");
    expect(source).toContain("<a>an active one</a>");
    expect(source).toContain('<th scope="col">h</th>');
    expect(source).toContain('<td colspan="2">c</td>');
    // The parser drops the newline right after <pre>, as browsers do.
    expect(source).toContain("<pre>  indented</pre>");
    expect(source).not.toContain("<small>");
    expect(source).toContain("unwrapped");
    expect(source).not.toMatch(
      /style=|onclick|javascript:|class=|data-foo|Remember/,
    );
    const all = codes(c.diagnostics);
    for (const code of [
      "EVENT_HANDLER_REMOVED",
      "INLINE_STYLE_NOT_CONVERTED",
      "ACTIVE_URL_REMOVED",
      "LINK_DROPPED",
      "SUBSTEP_FLATTENED",
      "ELEMENT_UNWRAPPED",
      "ATTRIBUTES_DROPPED",
      "NOTES_IMPORTED",
    ])
      expect(all, code).toContain(code);
    expect(c.css).toContain("color:red");
  });

  test("images, inline SVG, video and audio become their own blocks", () => {
    const svgFile = text(
      '<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>',
    );
    const resources = new Map([
      ["img/logo.png", png],
      ["img/chart.svg", svgFile],
      ["media/clip.mp4", mp4],
      ["media/clip.vtt", text("WEBVTT\n\n")],
      ["media/sound.mp3", new Uint8Array([73, 68, 51, 4, 0])],
      ["img/fake.png", text("not a png")],
    ]);
    const c = candidate(
      deck(
        `<div class="step" id="m">
          <p>Before <img src="./img/logo.png" alt="Logo"> after</p>
          <img src="img/chart.svg?v=2" alt="">
          <img src="img/logo.png">
          <svg viewBox="0 0 10 10" onload="x()"><title>Square</title><rect width="10" height="10" fill="url(#g)"/><script>bad()</script><foreignObject><p>x</p></foreignObject><image href="https://evil.example/x.png"/></svg>
          <video src="media/clip.mp4" poster="img/logo.png" aria-label="Clip" autoplay loop><track kind="captions" src="media/clip.vtt"></video>
          <audio title="Sound"><source src="media/missing.ogg"><source src="media/sound.mp3"></audio>
          <img src="img/fake.png" alt="fake">
          <img src="https://cdn.example.org/a.png" alt="remote">
          <img src="data:image/png;base64,AAAA" alt="inline">
          <img src="../secret.png" alt="outside">
          <img src="img/none.jpg" alt="missing">
          <img src="img/photo.avif" alt="avif">
        </div>`,
      ),
      { profile: "core", resources },
    );
    const blocks = c.document.scenes[0]!.blocks;
    expect(blocks.map((b) => b.type)).toEqual([
      "html",
      "image",
      "html",
      "image",
      "image",
      "svg",
      "video",
      "audio",
    ]);
    expect((blocks[0]!.data as { source: string }).source).toBe(
      "<p>Before </p>",
    );
    expect((blocks[2]!.data as { source: string }).source).toBe(
      "<p> after</p>",
    );
    expect(blocks[1]!.data).toMatchObject({ alt: "Logo", fit: "contain" });
    expect(blocks[4]!.data).toMatchObject({ alt: "" });
    const svg = blocks[5]!.data as { source: string; alt: string };
    expect(svg.alt).toBe("Square");
    // Fragment references stay: the renderer rewrites or removes them per instance.
    expect(svg.source).toContain(
      '<rect width="10" height="10" fill="url(#g)">',
    );
    expect(svg.source).not.toMatch(/onload|script|foreignObject|evil|<image/i);
    expect(blocks[6]!.data).toMatchObject({
      label: "Clip",
      autoplay: true,
      loop: true,
      onExit: "pause",
    });
    const video = blocks[6]!.data as {
      posterAssetId?: string;
      captionsAssetId?: string;
    };
    expect(video.posterAssetId).toBe(
      (blocks[1]!.data as { assetId: string }).assetId,
    );
    expect(video.captionsAssetId).toBeDefined();
    // One asset per file, reused; bytes kept by asset ID.
    expect(
      c.document.assets.map((a) => [a.path, a.mime, a.byteLength]),
    ).toEqual([
      ["img/logo.png", "image/png", png.byteLength],
      ["img/chart.svg", "image/svg+xml", svgFile.byteLength],
      ["media/clip.mp4", "video/mp4", mp4.byteLength],
      ["media/clip.vtt", "text/vtt", 8],
      ["media/sound.mp3", "audio/mpeg", 5],
    ]);
    expect([...c.files.keys()]).toEqual(c.document.assets.map((a) => a.id));
    const status = Object.fromEntries(
      c.resources.map((r) => [r.reference, r.status]),
    );
    expect(status).toMatchObject({
      "img/fake.png": "invalid",
      "https://cdn.example.org/a.png": "remote",
      "data:image/png;base64,AAAA": "data",
      "../secret.png": "outside",
      "img/none.jpg": "missing",
      "img/photo.avif": "unsupported",
      "media/missing.ogg": "missing",
    });
    const all = codes(c.diagnostics);
    for (const code of [
      "IMAGE_ALT_MISSING",
      "SVG_CONTENT_REMOVED",
      "RESOURCE_INVALID",
      "RESOURCE_REMOTE",
      "RESOURCE_DATA_URL",
      "RESOURCE_OUTSIDE_ROOT",
      "RESOURCE_MISSING",
      "RESOURCE_UNSUPPORTED",
    ])
      expect(all, code).toContain(code);
    expect(validateDocument(c.document).ok).toBe(true);
  });

  test("file pickers without folders match a unique file name", () => {
    const html = deck(
      `<div class="step"><img src="images/a.png" alt="a"></div>`,
    );
    const strict = candidate(html, {
      profile: "core",
      resources: new Map([["a.png", png]]),
    });
    expect(strict.document.assets).toHaveLength(0);
    const loose = candidate(html, {
      profile: "core",
      resources: new Map([["a.png", png]]),
      matchBasename: true,
    });
    expect(loose.document.assets.map((a) => a.path)).toEqual(["images/a.png"]);
    const ambiguous = candidate(html, {
      profile: "core",
      resources: new Map([
        ["x/a.png", png],
        ["y/a.png", png],
      ]),
      matchBasename: true,
    });
    expect(ambiguous.document.assets).toHaveLength(0);
  });

  test("local paths stay inside the presentation folder", () => {
    expect(localPath("img/a%20b.png")).toEqual({ path: "img/a b.png" });
    expect(localPath("./a/../b.png#x")).toEqual({ path: "b.png" });
    for (const outside of [
      "../a.png",
      "/etc/passwd",
      "a\\b.png",
      "%2e%2e/a.png",
      "a/%2F/b",
    ])
      expect(localPath(outside), outside).toEqual({ status: "outside" });
    expect(localPath("HTTPS://x.org/a.png")).toEqual({ status: "remote" });
    expect(localPath("//x.org/a.png")).toEqual({ status: "remote" });
    expect(localPath("file:///etc/passwd")).toEqual({ status: "remote" });
    expect(localPath(" data:image/png,x")).toEqual({ status: "data" });
  });

  test("titles fall back to text, then to the step ID", () => {
    const c = candidate(
      deck(
        `<div class="step" id="t1"><p>  First   line  </p></div><div class="step" id="t2"></div>`,
      ),
    );
    expect(c.document.scenes.map((s) => s.title)).toEqual(["First line", "t2"]);
    expect(codes(c.diagnostics)).toContain("TITLE_FROM_ID");
  });
});

describe("hostile content", () => {
  let calls = 0;
  beforeEach(() => {
    calls = 0;
    const deny = () => {
      calls++;
      throw new Error("network access");
    };
    vi.stubGlobal("fetch", deny);
    vi.stubGlobal("XMLHttpRequest", deny);
    vi.stubGlobal("WebSocket", deny);
    vi.stubGlobal("EventSource", deny);
    vi.stubGlobal("Image", deny);
  });
  afterEach(() => vi.unstubAllGlobals());

  const hostile = deck(
    `<div class="step" id="x" onmouseover="steal()">
      <script>window.pwned = 1</script>
      <script src="https://evil.example/x.js"></script>
      <img src="x" onerror="window.pwned=2" alt="x">
      <img src="https://evil.example/track.gif" srcset="https://evil.example/a.png 2x" alt="t">
      <a href="javascript:window.pwned=3">click</a>
      <a href=" JaVaScRiPt:alert(1)">click2</a>
      <a href="data:text/html,<script>alert(1)</script>">click3</a>
      <a href="vbscript:msgbox">click4</a>
      <iframe src="https://evil.example/"></iframe>
      <object data="x.swf"></object><embed src="x.swf">
      <form action="https://evil.example/"><input name="p"><button>go</button></form>
      <meta http-equiv="refresh" content="0;url=https://evil.example/">
      <base href="https://evil.example/">
      <link rel="stylesheet" href="https://evil.example/x.css">
      <style>@import url(https://evil.example/x.css); body{background:url(https://evil.example/y)}</style>
      <svg><script>alert(1)</script><a href="https://evil.example/"><text>t</text></a><animate attributeName="href" to="javascript:alert(1)"/><use href="https://evil.example/s.svg#a"/><rect style="fill:url(https://evil.example/f)"/></svg>
      <math><mi>x</mi></math>
      <template><img src="https://evil.example/t.png"></template>
      <noscript><img src="https://evil.example/n.png"></noscript>
      <p>&lt;script&gt;alert("text stays text")&lt;/script&gt; <b onclick="x()">bold</b></p>
      <div hidden>hidden</div>
      <canvas></canvas>
    </div>`,
    "",
    `<script>window.pwned = 4</script><link rel="stylesheet" href="https://fonts.example/f.css">`,
  );

  test("nothing is executed, fetched or copied as active content", () => {
    const result = importImpress(hostile, { profile: "core" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(calls).toBe(0);
    expect((globalThis as { pwned?: number }).pwned).toBeUndefined();
    const json = JSON.stringify(result.value.document);
    expect(json).not.toMatch(
      /<script|onerror|onmouseover|onclick|javascript:|vbscript:|evil\.example|<iframe|<object|<embed|<form|<input|<meta|<base|<link|<style|srcset|<animate|<template|<noscript|<canvas|hidden/i,
    );
    expect(json).toContain(
      '&lt;script&gt;alert(\\"text stays text\\")&lt;/script&gt;',
    );
    expect(result.value.document.assets).toHaveLength(0);
    const all = codes(result.diagnostics);
    for (const code of [
      "SCRIPT_REMOVED",
      "EVENT_HANDLER_REMOVED",
      "ACTIVE_URL_REMOVED",
      "FRAME_REMOVED",
      "FORM_REMOVED",
      "INERT_REMOVED",
      "STYLESHEET_IGNORED",
      "CSS_NOT_CONVERTED",
      "SVG_CONTENT_REMOVED",
      "MATHML_NOT_CONVERTED",
      "CANVAS_REMOVED",
      "RESOURCE_REMOTE",
      "SCRIPT_RESOURCE_IGNORED",
    ])
      expect(all, code).toContain(code);
    // Every finding has a stable code and a JSON Pointer string.
    for (const d of result.diagnostics) {
      expect(d.code).toMatch(/^[A-Z_]+$/);
      expect(typeof d.pointer).toBe("string");
      if (d.pointer) expect(d.pointer.startsWith("/")).toBe(true);
    }
  });

  test("random markup never throws and always validates", () => {
    let seed = 7;
    const random = () =>
      (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const pieces = [
      "<div>",
      "</div>",
      "<p>",
      "</p>",
      "<img src=a.png>",
      "<svg>",
      "</svg>",
      "<script>",
      "</script>",
      "text",
      "&amp;",
      "<a href=javascript:x>",
      "</a>",
      '<div class="step">',
      '<div class="step" data-x="1e400" data-rotate-order="zz">',
      "<table><td>",
      "<!--",
      "-->",
      "<math>",
      "<style>",
      "</style>",
      "\u0000",
      "<template>",
      "<h1>",
      '"',
      "'",
      "<",
    ];
    for (let run = 0; run < 300; run++) {
      let body = '<div class="step">';
      for (let i = 0; i < 40; i++)
        body += pieces[Math.floor(random() * pieces.length)];
      const result = importImpress(deck(body), {
        profile: random() < 0.5 ? "core" : "bundle",
      });
      if (result.ok)
        expect(validateDocument(result.value.document).ok).toBe(true);
      else
        expect(result.diagnostics.some((d) => d.severity === "error")).toBe(
          true,
        );
    }
    expect(calls).toBe(0);
  });
});
