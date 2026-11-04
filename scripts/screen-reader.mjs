import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { platform, release } from "node:os";
import { join } from "node:path";
import { nvda, voiceOver } from "@guidepup/guidepup";
import { preview } from "./preview.mjs";
import { Key, startBrowser } from "./webdriver.mjs";

// Item 7 of the release checklist (docs/RELEASE_BLOCKERS.md) with a real
// screen reader: VoiceOver with Safari on macOS, NVDA with Google Chrome on
// Windows. The test moves focus and presses keys in the page; what the
// screen reader says is read back through Guidepup and recorded. The
// machine must be prepared for automation (on CI, guidepup/setup-action);
// run `pnpm build` first.
//
//   node scripts/screen-reader.mjs [--reader voiceover|nvda]
//
// Results, with every phrase heard, go to test-results/screen-reader/.

const root = new URL("..", import.meta.url).pathname.replace(
  /^\/([A-Za-z]:)/,
  "$1",
);
const args = process.argv.slice(2);
const reader =
  (args.includes("--reader") && args[args.indexOf("--reader") + 1]) ||
  (process.platform === "win32" ? "nvda" : "voiceover");
const sr = reader === "nvda" ? nvda : voiceOver;
const out = join(root, "test-results/screen-reader");
const PLAYGROUND = "http://127.0.0.1:4173";
const STUDIO = "http://127.0.0.1:4174";
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

// ---- the page: Safari through WebDriver, or Chrome through Playwright ------

async function openBrowser() {
  if (reader === "voiceover") {
    const s = await startBrowser("safari");
    await s.setWindowRect({ x: 0, y: 0, width: 1280, height: 900 });
    return {
      version: `Safari ${s.capabilities.browserVersion}`,
      navigate: (url) => s.navigate(url),
      run: (fn, ...a) => s.run(fn, ...a),
      waitFor: (fn, options) => s.waitFor(fn, options),
      press: (key) => s.press(Key[key]),
      screenshot: () => s.screenshot(),
      quit: () => s.quit(),
    };
  }
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({
    channel: "chrome",
    headless: false,
    args: ["--force-renderer-accessibility", "--start-maximized"],
  });
  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();
  const run = (fn, ...a) => page.evaluate(`(${fn})(...${JSON.stringify(a)})`);
  return {
    version: `Chrome ${browser.version()}`,
    async navigate(url) {
      await page.goto(url);
      await page.bringToFront();
    },
    run,
    async waitFor(fn, { timeout = 10000, args: a = [], what = "" } = {}) {
      const end = Date.now() + timeout;
      for (;;) {
        const value = await run(fn, ...a).catch(() => null);
        if (value) return value;
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await delay(100);
      }
    },
    press: (key) => page.keyboard.press(key),
    screenshot: () => page.screenshot(),
    quit: () => browser.close(),
  };
}

// ---- listening --------------------------------------------------------------

/** Runs `action` and returns everything the screen reader says meanwhile. */
async function listen(action, ms = 2500) {
  await sr.clearSpokenPhraseLog().catch(() => {});
  const before = await sr.lastSpokenPhrase().catch(() => "");
  await action();
  const heard = [];
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await delay(150);
    const last = (await sr.lastSpokenPhrase().catch(() => "")) ?? "";
    if (
      last &&
      last !== heard.at(-1) &&
      !(heard.length === 0 && last === before)
    )
      heard.push(last);
  }
  const log = await sr.spokenPhraseLog().catch(() => []);
  return [...new Set([...log, ...heard])].filter(Boolean);
}
const plain = (text) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
const said = (heard, text) => plain(heard.join(" ")).includes(plain(text));

function assert(condition, message, details) {
  if (!condition)
    throw new Error(`${message}: ${JSON.stringify(details).slice(0, 1500)}`);
}
async function check(name, fn) {
  const started = Date.now();
  try {
    const details = await fn();
    results.push({ name, ok: true, ms: Date.now() - started, details });
    console.log(`  ok   ${name}`);
  } catch (error) {
    results.push({
      name,
      ok: false,
      ms: Date.now() - started,
      error: error.message,
    });
    console.log(`  FAIL ${name}\n       ${error.message}`);
    await writeFile(
      join(out, `${reader}-failure-${results.length}.png`),
      await page.screenshot(),
    ).catch(() => {});
  }
}

// Page functions: they only see their arguments.

/**
 * Focuses the `index`-th visible, enabled match of `selector` named `name`
 * (any when null) and returns its accessible name, as far as the test needs
 * one: aria-label, aria-labelledby, label or text.
 */
const FOCUS = (selector, name, index) => {
  const label = (e) =>
    (
      e.getAttribute("aria-label") ??
      (e.getAttribute("aria-labelledby") &&
        document.getElementById(e.getAttribute("aria-labelledby"))
          ?.textContent) ??
      e.labels?.[0]?.textContent ??
      e.textContent ??
      ""
    )
      .replace(/\s+/g, " ")
      .trim();
  const all = [...document.querySelectorAll(selector)].filter(
    (e) =>
      !e.closest("[hidden]") &&
      !e.disabled &&
      e.getClientRects().length > 0 &&
      (name === null || label(e) === name),
  );
  const e = all[index];
  if (!e) return null;
  e.focus();
  return {
    name: label(e),
    count: all.length,
    focused: document.activeElement === e,
  };
};
const focus = (selector, name = null, index = 0) =>
  page.run(FOCUS, selector, name, index);
/** Name of the open dialog and of the focused element. */
const STATE = () => {
  const label = (e) =>
    !e
      ? ""
      : (
          e.getAttribute("aria-label") ??
          (e.getAttribute("aria-labelledby") &&
            document.getElementById(e.getAttribute("aria-labelledby"))
              ?.textContent) ??
          e.textContent ??
          ""
        )
          .replace(/\s+/g, " ")
          .trim();
  const dialog = document.querySelector("dialog[open]");
  return {
    dialog: dialog ? label(dialog) || "(no name)" : null,
    focus: label(document.activeElement),
  };
};

// ---- checks ----------------------------------------------------------------

async function player() {
  await page.navigate(`${PLAYGROUND}/core`);
  await page.waitFor(() => window.demoPlayers?.length === 2, {
    what: "the players",
  });
  // Instant moves, so each announcement follows the key press.
  await page.run(() =>
    [...document.querySelectorAll("#player-1 button")]
      .find((b) => b.textContent.trim() === "Reduce motion")
      .click(),
  );
  await check("player: every move announces the scene title", async () => {
    const moves = [];
    await focus('nav[aria-label="Player 1 controls"] button', "Next");
    for (let i = 0; i < 2; i++) {
      const heard = await listen(() => page.press("Enter"));
      const title = await page.run(
        () => document.querySelector("#player-1 .xc-live").textContent,
      );
      moves.push({ title, heard });
      assert(said(heard, title), `"${title}" not announced`, heard);
    }
    return moves;
  });
  await check("player: the Text view is a list of named items", async () => {
    await focus("#player-1 button", "Text view");
    await page.press("Enter");
    await page.waitFor(
      () => !document.querySelector("#player-1 .xc-outline").hidden,
      { what: "the outline" },
    );
    let first;
    const heard = await listen(async () => {
      first = await focus("#player-1 .xc-outline button");
    });
    assert(first && said(heard, first.name), "item not announced", {
      first,
      heard,
    });
    assert(said(heard, "list"), "list not announced", heard);
    return { item: first, heard };
  });
  await page.navigate(`${PLAYGROUND}/structure`);
  await page.waitFor(() => window.demoPlayers?.length === 2, {
    what: "the players",
  });
  await check(
    "player: the choices of a branch are reachable and named",
    async () => {
      const choices = await page.waitFor(
        () => {
          const all = [
            ...document.querySelectorAll("#player-1 .xc-choices button"),
          ];
          return all.length ? all.map((b) => b.textContent.trim()) : null;
        },
        { what: "the choices" },
      );
      const heard = [];
      for (let i = 0; i < choices.length; i++) {
        const phrase = await listen(
          () => focus("#player-1 .xc-choices button", null, i),
          2000,
        );
        heard.push(phrase);
        assert(
          said(phrase, choices[i]),
          `choice "${choices[i]}" not announced`,
          phrase,
        );
      }
      return { choices, heard };
    },
  );
}

async function studio() {
  await page.navigate(`${STUDIO}/?studio-debug`);
  await page.waitFor(
    () =>
      !!window.studio?.store &&
      !!document.querySelector(".preview-player .xc-player"),
    { timeout: 30000, what: "Studio" },
  );
  const json = readFileSync(
    join(root, "examples/core-three-scenes/project.json"),
    "utf8",
  );
  await page.run((text) => {
    const input = document.querySelector(
      'input[aria-label="JSON project file"]',
    );
    const data = new DataTransfer();
    data.items.add(
      new File([text], "project.json", { type: "application/json" }),
    );
    input.files = data.files;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, json);
  await page.waitFor(
    () => window.studio.store.getSnapshot().document.scenes.length === 3,
    { what: "the project" },
  );
  await page.run(() =>
    document.querySelector('[aria-label="Scene list"] li button').click(),
  );
  await check("Studio: every toolbar button has a name", async () => {
    const count = (await focus("header.toolbar button"))?.count ?? 0;
    assert(count > 5, "toolbar buttons", count);
    const buttons = [];
    for (let i = 0; i < count; i++) {
      let target;
      const heard = await listen(async () => {
        target = await focus("header.toolbar button", null, i);
      }, 1500);
      buttons.push({ name: target?.name, heard });
      assert(target?.name, "button without a name", buttons.at(-1));
      assert(said(heard, target.name), `"${target.name}" not announced`, heard);
    }
    return buttons;
  });
  await check(
    "Studio: dialogs are announced and focus returns to the opener",
    async () => {
      const dialogs = [];
      for (const opener of ["Delete scene", "Export", "Import impress.js"]) {
        assert(await focus("button", opener), `no ${opener} button`, opener);
        const opened = await listen(() => page.press("Enter"));
        await page.waitFor(() => !!document.querySelector("dialog[open]"), {
          what: `the ${opener} dialog`,
        });
        const title = (await page.run(STATE)).dialog;
        assert(said(opened, title), `dialog "${title}" not announced`, opened);
        const closed = await listen(() => page.press("Escape"));
        const back = await page.run(STATE);
        dialogs.push({ opener, title, opened, closed, back });
        assert(
          !back.dialog && back.focus === opener,
          "focus after closing",
          back,
        );
        assert(
          said(closed, opener),
          `"${opener}" not announced on return`,
          closed,
        );
      }
      return dialogs;
    },
  );
  await check("Studio: inspector fields have names", async () => {
    const selector =
      '[aria-label="Inspector"] input:not([type=hidden]), [aria-label="Inspector"] select, [aria-label="Inspector"] textarea';
    const count = Math.min((await focus(selector))?.count ?? 0, 12);
    assert(count > 3, "inspector fields", count);
    const fields = [];
    for (let i = 0; i < count; i++) {
      let target;
      const heard = await listen(async () => {
        target = await focus(selector, null, i);
      }, 1500);
      fields.push({ name: target?.name, heard });
      assert(target?.name, "field without a name", fields.at(-1));
      assert(said(heard, target.name), `"${target.name}" not announced`, heard);
    }
    return fields;
  });
}

// ---- run -------------------------------------------------------------------

const sh = (command, argv) => {
  try {
    return execFileSync(command, argv, { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
};
await mkdir(out, { recursive: true });
const servers = [
  await preview("@xcursus/playground", PLAYGROUND, root),
  await preview("@xcursus/studio", STUDIO, root),
].filter(Boolean);
let page;
const started = new Date();
try {
  await sr.start();
  page = await openBrowser();
  console.log(`${reader} · ${page.version}`);
  for (const run of [player, studio])
    try {
      await run();
    } catch (error) {
      results.push({
        name: `${run.name}: setup`,
        ok: false,
        error: error.message,
      });
      console.log(`  FAIL ${run.name}: setup\n       ${error.message}`);
    }
} finally {
  await page?.quit().catch(() => {});
  await sr.stop().catch(() => {});
  for (const server of servers) server.kill();
}
const report = {
  date: started.toISOString(),
  reader,
  environment: {
    screenReader:
      reader === "voiceover"
        ? `VoiceOver ${sh("defaults", ["read", "/System/Library/CoreServices/VoiceOver.app/Contents/Info.plist", "CFBundleShortVersionString"]) ?? ""}`.trim()
        : "NVDA (Guidepup installation)",
    browser: page?.version,
    os: `${platform()} ${release()}`,
    runner: process.env.ImageOS
      ? `${process.env.ImageOS} ${process.env.ImageVersion ?? ""}`.trim()
      : null,
    node: process.version,
  },
  passed: results.filter((r) => r.ok).length,
  failed: results.filter((r) => !r.ok).length,
  results,
};
await writeFile(
  join(out, `${reader}.json`),
  `${JSON.stringify(report, null, 2)}\n`,
);
console.log(`${report.passed} passed, ${report.failed} failed`);
process.exit(report.failed || !report.passed ? 1 : 0);
