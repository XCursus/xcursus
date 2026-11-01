import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { Browser, BrowserContext, Page } from "playwright-core";
import type { ProjectDocument } from "@xcursus/core";
import { CliError, EXIT } from "./io.js";

const run = promisify(execFile);
export interface Chromium {
  browser: Browser;
  version: string;
  playwright: string;
}
/** Chromium of the pinned Playwright; never installed automatically (exit 2 when absent). */
export async function launchChromium(): Promise<Chromium> {
  let playwright: typeof import("playwright-core");
  try {
    playwright = await import("playwright-core");
  } catch {
    throw new CliError(
      EXIT.environment,
      "playwright-core is not installed; reinstall @xcursus/cli with its dependencies.",
    );
  }
  const version = (
    createRequire(import.meta.url)("playwright-core/package.json") as {
      version: string;
    }
  ).version;
  try {
    const browser = await playwright.chromium.launch({ headless: true });
    return { browser, version: browser.version(), playwright: version };
  } catch (error) {
    const text = String(error);
    if (/Executable doesn't exist|playwright install/i.test(text))
      throw new CliError(
        EXIT.environment,
        `Chromium for Playwright ${version} is not installed. Install it explicitly with: npx playwright@${version} install chromium`,
      );
    throw new CliError(EXIT.environment, `Cannot start Chromium: ${text}`);
  }
}

export interface CaptureSession {
  context: BrowserContext;
  page: Page;
  errors: string[];
}
/** A `securitypolicyviolation` event recorded by the capture page. */
export interface Violation {
  directive: string;
  blockedURI: string;
}
/**
 * Inline `style` and `on*` attributes blocked by the CSP are expected: Chromium
 * reports them while the sanitizer parses untrusted markup that it then strips,
 * so they never reach the output. Any other violation fails the capture.
 */
export function classifyViolations(violations: readonly Violation[]): {
  blockedAttributes: number;
  errors: string[];
} {
  const attribute = (v: Violation) =>
    v.directive === "script-src-attr" || v.directive === "style-src-attr";
  return {
    blockedAttributes: violations.filter(attribute).length,
    errors: violations
      .filter((v) => !attribute(v))
      .map(
        (v) =>
          `Content Security Policy blocked ${v.blockedURI || "inline content"} (${v.directive})`,
      ),
  };
}
/** Violations recorded by the capture page since it opened. */
export async function captureViolations(page: Page): Promise<Violation[]> {
  return page.evaluate(
    () =>
      (window as unknown as { xcursusViolations?: Violation[] })
        .xcursusViolations ?? [],
  );
}
/**
 * Opens the capture page from an owned temporary directory with the network
 * off: the page is self-contained and any other request is aborted.
 */
export async function openCapturePage(
  chromium: Chromium,
  project: ProjectDocument,
  html: string,
  directory: string,
): Promise<CaptureSession> {
  const { width, height } = project.settings.viewport;
  const context = await chromium.browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    // Fixed in the environment; the plan carries its own reduced-motion choice.
    reducedMotion: "no-preference",
    serviceWorkers: "block",
    offline: true,
  });
  await context.route(/^(https?|wss?):/, (route) => route.abort());
  const page = await context.newPage();
  const errors: string[] = [];
  // CSP violations are judged from the standard event, not from console text.
  await page.addInitScript(() => {
    const seen: Violation[] = [];
    Object.assign(window, { xcursusViolations: seen });
    document.addEventListener("securitypolicyviolation", (event) =>
      seen.push({
        directive: event.effectiveDirective,
        blockedURI: event.blockedURI,
      }),
    );
  });
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      !message.text().includes("Content Security Policy")
    )
      errors.push(message.text());
  });
  const file = join(directory, "capture.html");
  await writeFile(file, html);
  await page.goto(pathToFileURL(file).href);
  await page.waitForFunction(
    () => document.documentElement.dataset.xcursus !== undefined,
    undefined,
    { timeout: 60000 },
  );
  const state = await page.evaluate(
    () => document.documentElement.dataset.xcursus,
  );
  if (state !== "ready") {
    const blocked = classifyViolations(await captureViolations(page)).errors;
    throw new CliError(
      EXIT.output,
      `The capture page did not start: ${[...errors, ...blocked].join("; ") || state}`,
    );
  }
  return { context, page, errors };
}

export interface Tool {
  path: string;
  version: string;
}
/** `XCURSUS_<TOOL>`, then the deprecated `SPATIALDECK_<TOOL>` of earlier releases, then PATH. */
async function tool(name: string, variable: string): Promise<Tool | null> {
  const legacy = variable.replace(/^XCURSUS_/, "SPATIALDECK_");
  const path = process.env[variable] || process.env[legacy] || name;
  try {
    const { stdout } = await run(path, ["-version"], { timeout: 30000 });
    return { path, version: stdout.split("\n")[0]!.trim() };
  } catch {
    return null;
  }
}
export interface Encoder {
  ffmpeg: Tool;
  ffprobe: Tool;
  codec: string;
  encoder: string;
  args: string[];
  license: string;
}
/** WebM encoders actually listed by `ffmpeg -encoders`, VP9 first; no H.264 promise. */
const candidates = [
  {
    encoder: "libvpx-vp9",
    codec: "vp9",
    license: "libvpx (BSD-3-Clause), royalty-free VP9",
    args: [
      "-c:v",
      "libvpx-vp9",
      "-b:v",
      "0",
      "-crf",
      "30",
      "-deadline",
      "good",
      "-cpu-used",
      "2",
      "-row-mt",
      "0",
    ],
  },
  {
    encoder: "libvpx",
    codec: "vp8",
    license: "libvpx (BSD-3-Clause), royalty-free VP8",
    args: ["-c:v", "libvpx", "-b:v", "4M", "-crf", "8"],
  },
  {
    encoder: "libsvtav1",
    codec: "av1",
    license: "SVT-AV1 (BSD-3-Clause-Clear), royalty-free AV1",
    args: ["-c:v", "libsvtav1", "-crf", "35", "-preset", "8"],
  },
  {
    encoder: "libaom-av1",
    codec: "av1",
    license: "libaom (BSD-2-Clause), royalty-free AV1",
    args: ["-c:v", "libaom-av1", "-crf", "30", "-b:v", "0", "-cpu-used", "6"],
  },
];
export async function findEncoder(): Promise<Encoder> {
  const ffmpeg = await tool("ffmpeg", "XCURSUS_FFMPEG");
  const ffprobe = await tool("ffprobe", "XCURSUS_FFPROBE");
  if (!ffmpeg || !ffprobe)
    throw new CliError(
      EXIT.environment,
      `${!ffmpeg ? "ffmpeg" : "ffprobe"} not found. Install FFmpeg (with ffprobe) yourself or set XCURSUS_FFMPEG and XCURSUS_FFPROBE; the CLI never downloads it.`,
    );
  let list: string;
  try {
    list = (
      await run(ffmpeg.path, ["-hide_banner", "-encoders"], { timeout: 30000 })
    ).stdout;
  } catch (error) {
    throw new CliError(
      EXIT.environment,
      `ffmpeg -encoders failed: ${String(error)}`,
    );
  }
  const available = new Set(
    list
      .split("\n")
      .map((line) => line.trim().split(/\s+/))
      .filter((parts) => parts[0]?.startsWith("V"))
      .map((parts) => parts[1]),
  );
  const chosen = candidates.find((c) => available.has(c.encoder));
  if (!chosen)
    throw new CliError(
      EXIT.environment,
      "This FFmpeg has no WebM video encoder (libvpx-vp9, libvpx, libsvtav1 or libaom-av1).",
    );
  return {
    ffmpeg,
    ffprobe,
    codec: chosen.codec,
    encoder: chosen.encoder,
    license: chosen.license,
    // Single thread and bitexact flags: identical input frames give identical files here.
    args: [
      ...chosen.args,
      "-threads",
      "1",
      "-pix_fmt",
      "yuv420p",
      "-an",
      "-fflags",
      "+bitexact",
      "-flags:v",
      "+bitexact",
      "-map_metadata",
      "-1",
    ],
  };
}
/** Runs a tool with an argument vector, never a shell. */
export async function runTool(path: string, args: string[], timeout = 600000) {
  try {
    return await run(path, args, { timeout, maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    const detail =
      error && typeof error === "object" && "stderr" in error
        ? String((error as { stderr: unknown }).stderr).slice(-2000)
        : String(error);
    throw new CliError(EXIT.output, `${path} failed: ${detail}`);
  }
}
