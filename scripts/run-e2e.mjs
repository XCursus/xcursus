import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { release } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { e2ePlan } from "./e2e-plan.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const install = args.includes("--install");
const summary = { platform: process.platform, release: release(), runners: [] };
try {
  const { jobs, forwarded } = e2ePlan({
    platform: process.platform,
    release: release(),
    args,
  });
  for (const job of jobs) {
    const compatible = job.profile === "webkit-macos14";
    const require = createRequire(
      new URL(
        compatible ? "../tools/webkit-macos14/package.json" : "../package.json",
        import.meta.url,
      ),
    );
    const manifest = require.resolve("@playwright/test/package.json");
    const { version } = JSON.parse(await readFile(manifest, "utf8"));
    if (version !== job.version)
      throw new Error(
        `Expected Playwright ${job.version}, received ${version}`,
      );
    const cli = join(dirname(manifest), "cli.js");
    const config = compatible
      ? "tools/webkit-macos14/playwright.config.ts"
      : "playwright.config.ts";
    const report = join(root, "test-results", job.profile, "results.json");
    if (!install) await rm(report, { force: true });
    const command = install
      ? ["install", ...job.projects, ...forwarded]
      : [
          "test",
          "--config",
          config,
          ...job.projects.map((name) => `--project=${name}`),
          ...forwarded,
        ];
    console.log(`Playwright ${version} [${job.profile}]: ${command.join(" ")}`);
    const result = spawnSync(process.execPath, [cli, ...command], {
      cwd: root,
      env: { ...process.env, XCURSUS_E2E_RUNNER: job.profile },
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    const exitCode = result.status ?? 1;
    let stats;
    if (!install) {
      try {
        stats = JSON.parse(await readFile(report, "utf8")).stats;
      } catch {
        /* CLI errors and --list may not produce a JSON report. */
      }
    }
    summary.runners.push({ ...job, exitCode, ...(stats ? { stats } : {}) });
    if (exitCode !== 0) process.exitCode = exitCode;
    if (result.signal) break;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  if (!install) {
    await mkdir(join(root, "test-results"), { recursive: true });
    await writeFile(
      join(root, "test-results", "e2e-summary.json"),
      JSON.stringify(summary, null, 2) + "\n",
    );
  }
}
