import { defineConfig, devices } from "@playwright/test";
import { release } from "node:os";
import { isMacOS14 } from "../../scripts/e2e-plan.mjs";
import { e2eConfig } from "../../tests/e2e/config.js";

if (!isMacOS14(process.platform, release())) {
  throw new Error("The WebKit 1.61.1 runner is restricted to macOS 14");
}
process.env.XCURSUS_E2E_RUNNER = "webkit-macos14";
export default defineConfig({
  ...e2eConfig("webkit-macos14"),
  metadata: { runner: "@xcursus/webkit-macos14", version: "1.61.1" },
  projects: [{ name: "webkit", use: { ...devices["Desktop Safari"] } }],
});
