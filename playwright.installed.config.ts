import { defineConfig, devices } from "@playwright/test";
import { e2eConfig } from "./tests/e2e/config.js";
// The same suites on an installed Chromium-family browser instead of
// Playwright's Chromium build: a real-browser run of the support matrix.
//   XCURSUS_CHANNEL     chrome (default) or msedge, the installed release
//   XCURSUS_EXECUTABLE  a specific build instead, e.g. a previous version
//   XCURSUS_RESULTS     results folder under test-results (default: channel)
process.env.XCURSUS_E2E_RUNNER = "current";
const channel = process.env.XCURSUS_CHANNEL ?? "chrome";
const executablePath = process.env.XCURSUS_EXECUTABLE;
const name = process.env.XCURSUS_RESULTS ?? channel;
const base = e2eConfig("current");
export default defineConfig({
  ...base,
  outputDir: base.outputDir.replace("/current/", `/${name}/`),
  reporter: [
    ["list"],
    [
      "json",
      {
        outputFile: base.reporter[1][1].outputFile.replace(
          "/current/",
          `/${name}/`,
        ),
      },
    ],
  ],
  metadata: {
    runner: "@playwright/test",
    version: "1.64.1",
    channel: executablePath ? undefined : channel,
    executablePath,
  },
  projects: [
    {
      name,
      use: {
        ...devices[channel === "msedge" ? "Desktop Edge" : "Desktop Chrome"],
        ...(executablePath
          ? { launchOptions: { executablePath } }
          : { channel }),
      },
    },
  ],
});
