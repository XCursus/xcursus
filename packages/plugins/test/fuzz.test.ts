// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
// Thousands of seeded inputs per test: allow more than the default 5 s.
const LONG = 120_000;
import { zipSync, strToU8 } from "fflate";
import { validateDocument } from "@xcursus/core";
import { readArchive, writeArchive } from "../src/archive.js";
import { sanitizeContent } from "../src/security.js";
import { sha256 } from "../../player/src/assets/index.js";
import fixture from "../../../examples/core-three-scenes/project.json";

/**
 * Seeded fuzzing (1.0 hardening): every run uses the same inputs, so a
 * failure is reproducible from its seed and iteration. The archive reader
 * must reject or fully verify each mutated archive; the sanitizer's output
 * must satisfy the policy invariants, also after a second parse.
 */
function prng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("ZIP reader fuzzing", () => {
  async function base() {
    const valid = validateDocument(fixture);
    if (!valid.ok) throw new Error("fixture");
    const doc = structuredClone(valid.value);
    const svg = new Blob(
      [
        '<svg xmlns="http://www.w3.org/2000/svg"><rect width="4" height="4"/></svg>',
      ],
      { type: "image/svg+xml" },
    );
    doc.assets.push({
      id: "logo",
      path: "assets/logo.svg",
      mime: "image/svg+xml",
      byteLength: svg.size,
      sha256: await sha256(svg),
    });
    const blob = await writeArchive(doc, new Map([["logo", svg]]));
    return new Uint8Array(await blob.arrayBuffer());
  }
  const mutations: Array<(b: Uint8Array, r: () => number) => Uint8Array> = [
    // Flip one to eight random bytes.
    (b, r) => {
      const out = b.slice();
      for (let n = 1 + Math.floor(r() * 8); n > 0; n--)
        out[Math.floor(r() * out.length)]! ^= 1 + Math.floor(r() * 255);
      return out;
    },
    // Truncate.
    (b, r) => b.slice(0, Math.floor(r() * b.length)),
    // Insert random bytes.
    (b, r) => {
      const at = Math.floor(r() * b.length),
        extra = Uint8Array.from({ length: 1 + Math.floor(r() * 64) }, () =>
          Math.floor(r() * 256),
        );
      return new Uint8Array([...b.slice(0, at), ...extra, ...b.slice(at)]);
    },
    // Overwrite a 32-bit field next to a header signature (sizes, offsets, CRC).
    (b, r) => {
      const out = b.slice(),
        view = new DataView(out.buffer);
      const signatures: number[] = [];
      for (let i = 0; i + 4 <= out.length; i++) {
        const v = view.getUint32(i, true);
        if (v === 0x04034b50 || v === 0x02014b50 || v === 0x06054b50)
          signatures.push(i);
      }
      const at = signatures[Math.floor(r() * signatures.length)]!;
      const field = at + 4 + 2 * Math.floor(r() * 20);
      if (field + 4 <= out.length)
        view.setUint32(
          field,
          [0, 0xffffffff, 0x7fffffff, Math.floor(r() * 2 ** 32)][
            Math.floor(r() * 4)
          ]!,
          true,
        );
      return out;
    },
    // Duplicate a slice (repeated entries, overlapping data).
    (b, r) => {
      const from = Math.floor(r() * b.length),
        length = Math.floor(r() * 256);
      return new Uint8Array([...b, ...b.slice(from, from + length)]);
    },
  ];

  it(
    "rejects or fully verifies 1500 mutated archives, each quickly",
    { timeout: LONG },
    async () => {
      const original = await base();
      const r = prng(20261102);
      let accepted = 0,
        rejected = 0,
        slowest = 0;
      for (let i = 0; i < 1500; i++) {
        const mutate = mutations[i % mutations.length]!;
        const input = mutate(original, r);
        const started = performance.now();
        try {
          const archive = await readArchive(
            new Blob([input as Uint8Array<ArrayBuffer>]),
          );
          // Accepted only when the document validates and every asset matches its digest.
          expect(validateDocument(archive.document).ok, `iteration ${i}`).toBe(
            true,
          );
          for (const asset of archive.document.assets) {
            const blob = archive.blobs.get(asset.id);
            expect(blob, `iteration ${i} ${asset.id}`).toBeDefined();
            expect(blob!.size).toBe(asset.byteLength);
            if (asset.sha256) expect(await sha256(blob!)).toBe(asset.sha256);
          }
          accepted++;
        } catch (error) {
          // A rejection is an Error with a message, never a hang or a crash of the runner.
          expect(error, `iteration ${i}`).toBeInstanceOf(Error);
          rejected++;
        }
        slowest = Math.max(slowest, performance.now() - started);
      }
      expect(rejected).toBeGreaterThan(1000);
      expect(accepted + rejected).toBe(1500);
      expect(slowest).toBeLessThan(2000);
    },
  );

  it(
    "refuses a decompression bomb before inflating it fully",
    { timeout: LONG },
    async () => {
      // 300 MiB of zeros compress to a few hundred KiB.
      const bomb = zipSync(
        {
          "project.json": strToU8(JSON.stringify(fixture)),
          "assets/a/zero.bin": new Uint8Array(300 * 1024 * 1024),
        },
        { level: 9 },
      );
      const started = performance.now();
      await expect(readArchive(new Blob([bomb]))).rejects.toThrow();
      expect(performance.now() - started).toBeLessThan(10000);
    },
  );
});

describe("sanitizer fuzzing", () => {
  const HTML_TAGS = new Set(
    "p br h1 h2 h3 h4 h5 h6 strong em b i s u code pre blockquote ul ol li a table thead tbody tfoot tr th td caption hr span div sup sub dl dt dd".split(
      " ",
    ),
  );
  const HTML_ATTRIBUTES = new Set([
    "href",
    "title",
    "colspan",
    "rowspan",
    "scope",
    "lang",
    "dir",
    "rel",
    "target",
  ]);
  const SVG_TAGS = new Set(
    "svg g path rect circle ellipse line polyline polygon text tspan title desc defs clippath lineargradient radialgradient stop use symbol mask".split(
      " ",
    ),
  );
  const fragments = [
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    '<a href="javascript:alert(1)">j</a>',
    '<a href="JaVaScRiPt&#58;alert(1)">e</a>',
    '<a href=" &#x6A;avascript:alert(1)">h</a>',
    '<a href="data:text/html;base64,PHNjcmlwdD4=">d</a>',
    '<a href="https://user:pw@example.org/">c</a>',
    '<a href="https://example.org/ok">ok</a>',
    "<iframe srcdoc='<script>alert(1)</script>'></iframe>",
    '<form action="https://x"><input name=a><button>b</button></form>',
    '<meta http-equiv="refresh" content="0;url=https://x">',
    '<base href="https://x/">',
    "<style>@import url(https://x/a.css)</style>",
    '<p style="background:url(https://x/y)">s</p>',
    '<object data="x.swf"></object><embed src="x">',
    '<svg><script>alert(1)</script><rect onload="alert(1)" width="5"/></svg>',
    '<svg><a xlink:href="javascript:alert(1)"><text>t</text></a></svg>',
    '<svg><use href="https://x/s.svg#a"/><use href="#local"/></svg>',
    '<svg><animate attributeName="href" to="javascript:alert(1)"/></svg>',
    "<svg><foreignObject><img src=x onerror=alert(1)></foreignObject></svg>",
    '<svg><rect fill="url(https://x/#g)" stroke="url(#g)"/></svg>',
    '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></p></noscript>',
    "<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>",
    '<div id="x" class="c" data-x="1" aria-label="a" onclick="alert(1)">t</div>',
    "<!--<img src=x onerror=alert(1)>-->",
    "<![CDATA[<img src=x onerror=alert(1)>]]>",
    "<template><img src=x onerror=alert(1)></template>",
    '<table><td colspan="2" scope="row">c</td></table>',
    "<details open ontoggle=alert(1)>x</details>",
    '<video poster="https://x/p.png"><source src="https://x/v.mp4"></video>',
    "&lt;script&gt;text&lt;/script&gt;",
    "<",
    "</p>",
    '"',
    "plain text",
  ];
  function check(root: ParentNode, kind: "html" | "svg", where: string) {
    for (const element of root.querySelectorAll("*")) {
      const tag = element.localName.toLowerCase();
      if (kind === "html")
        expect(HTML_TAGS.has(tag), `${where}: <${tag}>`).toBe(true);
      else expect(SVG_TAGS.has(tag), `${where}: <${tag}>`).toBe(true);
      for (const attribute of element.attributes) {
        const name = attribute.name.toLowerCase();
        expect(name.startsWith("on"), `${where}: ${name}`).toBe(false);
        expect(name, where).not.toBe("style");
        if (kind === "html") {
          expect(HTML_ATTRIBUTES.has(name), `${where}: ${name}`).toBe(true);
          if (name === "href") {
            const url = new URL(attribute.value);
            expect(["http:", "https:"]).toContain(url.protocol);
            expect(url.username + url.password).toBe("");
            expect(element.getAttribute("rel")).toBe("noopener noreferrer");
          }
        } else {
          if (name === "href" || name === "xlink:href")
            expect(
              attribute.value.startsWith("#"),
              `${where}: ${attribute.value}`,
            ).toBe(true);
          if (/url\(/i.test(attribute.value))
            expect(attribute.value, where).toMatch(/^url\(#[A-Za-z0-9_-]+\)$/);
        }
      }
    }
  }
  for (const kind of ["html", "svg"] as const)
    it(
      `${kind}: 2000 random documents satisfy the policy, also after a second parse`,
      { timeout: LONG },
      () => {
        const r = prng(kind === "html" ? 11 : 12);
        for (let i = 0; i < 2000; i++) {
          let source = kind === "svg" ? "<svg>" : "";
          for (let n = 1 + Math.floor(r() * 8); n > 0; n--)
            source += fragments[Math.floor(r() * fragments.length)];
          const host = document.createElement("div");
          const fragment = sanitizeContent(host, source, kind, `f${i}`);
          check(fragment, kind, `iteration ${i}`);
          // Serialize and parse again: mutation XSS must not survive the round trip.
          host.append(fragment);
          const again = document.createElement("div");
          again.innerHTML = host.innerHTML;
          check(again, kind, `iteration ${i} reparsed`);
          expect(
            again.querySelector(
              "script,iframe,object,embed,form,style,base,meta",
            ),
          ).toBeNull();
        }
      },
    );
});
