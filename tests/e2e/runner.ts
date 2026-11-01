import { createRequire } from "node:module";

// Only this test adapter selects a runner. The suite is shared without copies,
// skips or runtime changes to core/player. Both pinned APIs run the same tests.
const compatible = process.env.XCURSUS_E2E_RUNNER === "webkit-macos14";
const require = createRequire(
  compatible
    ? new URL("../../tools/webkit-macos14/package.json", import.meta.url)
    : import.meta.url,
);
const version = (
  require("@playwright/test/package.json") as { version: string }
).version;
const expected = compatible ? "1.61.1" : "1.64.1";
if (version !== expected) {
  throw new Error(
    `Wrong E2E runner: expected ${expected}, received ${version}`,
  );
}
const runner = require("@playwright/test") as typeof import("@playwright/test");
export const test = runner.test;
export const expect = runner.expect;
