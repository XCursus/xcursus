import { defineConfig, devices } from "@playwright/test";
import { e2eConfig } from "./tests/e2e/config.js";
// The same suites on the installed Google Chrome (channel "chrome") instead of
// Playwright's Chromium build: a real-browser run of the support matrix.
// Requires Chrome installed on the machine; results go to test-results/chrome.
process.env.XCURSUS_E2E_RUNNER = "current";
const base = e2eConfig("current");
export default defineConfig({
  ...base,
  outputDir: base.outputDir.replace("/current/", "/chrome/"),
  reporter: [
    ["list"],
    [
      "json",
      {
        outputFile: base.reporter[1][1].outputFile.replace(
          "/current/",
          "/chrome/",
        ),
      },
    ],
  ],
  metadata: {
    runner: "@playwright/test",
    version: "1.64.1",
    channel: "chrome",
  },
  projects: [
    {
      name: "chrome",
      use: { ...devices["Desktop Chrome"], channel: "chrome" },
    },
  ],
});
