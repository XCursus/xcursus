import { fileURLToPath } from "node:url";

export function e2eConfig(profile: "current" | "webkit-macos14") {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  return {
    testDir: fileURLToPath(new URL(".", import.meta.url)),
    testMatch: "**/*.spec.ts",
    fullyParallel: false,
    workers: 1,
    retries: 0,
    outputDir: `${root}/test-results/${profile}/artifacts`,
    reporter: [
      ["list"],
      ["json", { outputFile: `${root}/test-results/${profile}/results.json` }],
    ] as [["list"], ["json", { outputFile: string }]],
    use: {
      baseURL: "http://127.0.0.1:4173",
      viewport: { width: 1440, height: 1000 },
      trace: "retain-on-failure" as const,
    },
    webServer: [
      {
        command:
          "pnpm --filter @xcursus/playground exec vite preview --host 127.0.0.1 --port 4173 --strictPort",
        cwd: root,
        url: "http://127.0.0.1:4173/core",
        reuseExistingServer: !process.env.CI,
      },
      {
        command:
          "pnpm --filter @xcursus/studio exec vite preview --host 127.0.0.1 --port 4174 --strictPort",
        cwd: root,
        url: "http://127.0.0.1:4174",
        reuseExistingServer: !process.env.CI,
      },
    ],
  };
}
