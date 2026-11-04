import { spawn } from "node:child_process";
import { createServer } from "node:net";

// Minimal W3C WebDriver client, with no dependency: only the commands the
// release checks use. Drivers: safaridriver for Safari on macOS and in the
// iOS Simulator (one session at a time; "Allow Remote Automation" in
// Safari's Develop settings, `safaridriver --enable`), geckodriver for a
// release build of Firefox.

const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";
export const Key = {
  ArrowLeft: "",
  ArrowUp: "",
  ArrowRight: "",
  ArrowDown: "",
  PageUp: "",
  PageDown: "",
  Space: "",
  Tab: "",
  Enter: "",
  Escape: "",
};
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const freePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

async function call(base, method, path, body) {
  const response = await fetch(base + path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json().catch(() => ({ value: null }));
  if (!response.ok || json.value?.error)
    throw new Error(
      `WebDriver ${method} ${path}: ${json.value?.error ?? response.status} ${json.value?.message ?? ""}`.trim(),
    );
  return json.value;
}

/** Starts a driver on a free port; reports why when it does not answer. */
async function launch(driver, timeoutMs) {
  const port = await freePort();
  const child = spawn(driver, ["--port", String(port)], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const base = `http://127.0.0.1:${port}`;
  const end = Date.now() + timeoutMs;
  while (child.exitCode === null && Date.now() < end) {
    try {
      if ((await fetch(`${base}/status`)).ok) return { child, base };
    } catch {
      /* not listening yet */
    }
    await delay(100);
  }
  child.kill();
  return { error: stderr.trim() || "no answer" };
}

/** Driver and capabilities of each target. */
function target(browser, env) {
  const common = { unhandledPromptBehavior: "accept" };
  // SAFARI_DIAGNOSE keeps safaridriver's logs (~/Library/Logs/com.apple.WebDriver).
  const diagnose = env.SAFARI_DIAGNOSE ? { "safari:diagnose": true } : {};
  if (browser === "safari")
    return {
      driver: "/usr/bin/safaridriver",
      capabilities: { ...common, ...diagnose, browserName: "safari" },
    };
  if (browser === "ios-phone" || browser === "ios-tablet")
    return {
      driver: "/usr/bin/safaridriver",
      capabilities: {
        ...common,
        browserName: "safari",
        platformName: "iOS",
        "safari:useSimulator": true,
        "safari:deviceType": browser === "ios-phone" ? "iPhone" : "iPad",
        // A simulator booted beforehand (IOS_UDID) connects reliably.
        ...(env.IOS_UDID ? { "safari:deviceUDID": env.IOS_UDID } : {}),
        ...diagnose,
      },
    };
  if (browser === "firefox")
    return {
      driver: env.GECKODRIVER ?? "geckodriver",
      capabilities: {
        ...common,
        browserName: "firefox",
        "moz:firefoxOptions": env.FIREFOX_BINARY
          ? { binary: env.FIREFOX_BINARY }
          : {},
      },
    };
  throw new Error(`unknown browser ${browser}`);
}

/**
 * Starts the driver and opens a session: `safari`, `ios-phone`, `ios-tablet`
 * or `firefox` (FIREFOX_BINARY and GECKODRIVER select the builds). Right
 * after an earlier session Safari may still be closing its automation
 * window, and a simulator may still be booting, so a failed start is retried.
 */
export async function startBrowser(
  browser,
  { attempts = 3, env = process.env } = {},
) {
  const { driver, capabilities } = target(browser, env);
  let failure;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt) await delay(3000);
    const started = await launch(driver, 60000);
    if (!started.child) {
      failure = started.error;
      continue;
    }
    try {
      const created = await call(started.base, "POST", "/session", {
        capabilities: { alwaysMatch: capabilities },
      });
      const session = new Session(
        started.base,
        created.sessionId,
        created.capabilities,
        started.child,
      );
      await session.cmd("POST", "/timeouts", {
        script: 60000,
        pageLoad: 120000,
      });
      return session;
    } catch (error) {
      started.child.kill();
      failure = error.message;
    }
  }
  throw new Error(`no ${browser} session: ${failure}`);
}

export class Session {
  constructor(base, id, capabilities, child) {
    this.base = base;
    this.id = id;
    this.capabilities = capabilities;
    this.child = child;
  }
  cmd(method, path, body) {
    return call(this.base, method, `/session/${this.id}${path}`, body);
  }
  navigate(url) {
    return this.cmd("POST", "/url", { url });
  }
  url() {
    return this.cmd("GET", "/url");
  }
  /**
   * Runs `fn` in the page with JSON arguments; a returned promise is awaited.
   * Errors thrown in the page are rethrown here with their message.
   */
  async run(fn, ...args) {
    const script = `const done = arguments[arguments.length - 1];
      Promise.resolve()
        .then(() => (${fn}).apply(null, Array.prototype.slice.call(arguments, 0, -1)))
        .then((value) => done({ value }), (e) => done({ error: String((e && e.stack) || e) }));`;
    const result = await this.cmd("POST", "/execute/async", { script, args });
    if (result?.error) throw new Error(`in page: ${result.error}`);
    return result?.value;
  }
  /**
   * Element reference of the first match: a CSS selector, or an array of a
   * page function and its arguments returning the element (or null).
   */
  async element(query) {
    const [fn, ...args] =
      typeof query === "string"
        ? [(selector) => document.querySelector(selector), query]
        : query;
    const found = await this.cmd("POST", "/execute/sync", {
      script: `return (${fn}).apply(null, arguments);`,
      args,
    });
    if (!found?.[ELEMENT])
      throw new Error(`no element for ${JSON.stringify(args)}`);
    return found[ELEMENT];
  }
  async click(query) {
    const el = await this.element(query);
    await this.cmd("POST", `/element/${el}/click`, {});
  }
  /** Types text in an element; for a file input, absolute paths joined by "\n". */
  async sendKeys(query, text) {
    const el = await this.element(query);
    await this.cmd("POST", `/element/${el}/value`, { text });
  }
  /** Presses keys one after the other in the focused element. */
  async press(...keys) {
    const actions = keys.flatMap((value) => [
      { type: "keyDown", value },
      { type: "keyUp", value },
    ]);
    await this.cmd("POST", "/actions", {
      actions: [{ type: "key", id: "keyboard", actions }],
    });
    await this.cmd("DELETE", "/actions");
  }
  /** Mouse drag from a point to another, in viewport coordinates. */
  async drag(from, to, steps = 8) {
    const moves = Array.from({ length: steps }, (_, i) => ({
      type: "pointerMove",
      duration: 16,
      origin: "viewport",
      x: Math.round(from.x + ((to.x - from.x) * (i + 1)) / steps),
      y: Math.round(from.y + ((to.y - from.y) * (i + 1)) / steps),
    }));
    await this.cmd("POST", "/actions", {
      actions: [
        {
          type: "pointer",
          id: "mouse",
          parameters: { pointerType: "mouse" },
          actions: [
            {
              type: "pointerMove",
              duration: 0,
              origin: "viewport",
              x: Math.round(from.x),
              y: Math.round(from.y),
            },
            { type: "pointerDown", button: 0 },
            { type: "pause", duration: 50 },
            ...moves,
            { type: "pointerUp", button: 0 },
          ],
        },
      ],
    });
    await this.cmd("DELETE", "/actions");
  }
  /** A touch swipe from a point to another, in viewport coordinates. */
  async swipe(from, to, steps = 12) {
    await this.pointer("touch", from, to, steps, 25);
  }
  /** A touch tap at a point, in viewport coordinates. */
  async tap(at) {
    await this.pointer("touch", at, at, 1, 60);
  }
  async pointer(pointerType, from, to, steps, stepMs) {
    const point = (p) => ({ x: Math.round(p.x), y: Math.round(p.y) });
    const moves = Array.from({ length: steps }, (_, i) => ({
      type: "pointerMove",
      duration: stepMs,
      origin: "viewport",
      ...point({
        x: from.x + ((to.x - from.x) * (i + 1)) / steps,
        y: from.y + ((to.y - from.y) * (i + 1)) / steps,
      }),
    }));
    await this.cmd("POST", "/actions", {
      actions: [
        {
          type: "pointer",
          id: pointerType,
          parameters: { pointerType },
          actions: [
            {
              type: "pointerMove",
              duration: 0,
              origin: "viewport",
              ...point(from),
            },
            { type: "pointerDown", button: 0 },
            ...moves,
            { type: "pointerUp", button: 0 },
          ],
        },
      ],
    });
    await this.cmd("DELETE", "/actions");
  }
  windows() {
    return this.cmd("GET", "/window/handles");
  }
  window() {
    return this.cmd("GET", "/window");
  }
  switchTo(handle) {
    return this.cmd("POST", "/window", { handle });
  }
  closeWindow() {
    return this.cmd("DELETE", "/window");
  }
  setWindowRect(rect) {
    return this.cmd("POST", "/window/rect", rect);
  }
  async screenshot() {
    return Buffer.from(await this.cmd("GET", "/screenshot"), "base64");
  }
  /** Polls a page function until it returns a truthy value. */
  async waitFor(fn, { timeout = 10000, args = [], what = String(fn) } = {}) {
    const end = Date.now() + timeout;
    let last;
    for (;;) {
      try {
        last = await this.run(fn, ...args);
        if (last) return last;
      } catch (error) {
        last = error;
      }
      if (Date.now() > end)
        throw new Error(`timed out waiting for ${what} (last: ${last})`);
      await delay(100);
    }
  }
  /** Ends the session and waits for safaridriver to exit. */
  async quit() {
    try {
      await this.cmd("DELETE", "");
    } finally {
      if (this.child.exitCode === null) {
        const exited = new Promise((r) => this.child.once("exit", r));
        this.child.kill();
        await Promise.race([exited, delay(5000)]);
      }
    }
  }
}
