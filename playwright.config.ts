import { defineConfig, devices } from "@playwright/test";
import { e2eConfig } from "./tests/e2e/config.js";
process.env.XCURSUS_E2E_RUNNER = "current";
export default defineConfig({
  ...e2eConfig("current"),
  metadata: { runner: "@playwright/test", version: "1.64.1" },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
