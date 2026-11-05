# Development

How to set up the repository, run the applications, build, test and contribute. The structure of the code is described in [ARCHITECTURE](ARCHITECTURE.md), the public API in [API](API.md) and the test suites in [VERIFICATION](VERIFICATION.md).

## Toolchain and installation

XCursus pins **Node 24.22.0** and **pnpm 12.14.0** (`engines` and `packageManager` in `package.json`). With matching global tools:

```sh
git clone https://github.com/XCursus/xcursus.git
cd xcursus
pnpm install --frozen-lockfile
```

If the global Node or pnpm differ, install the pinned versions locally in `.tools/` (ignored by Git) without touching the global ones:

```sh
npm install --prefix .tools --no-package-lock --no-save node@24.22.0 pnpm@12.14.0
export PATH="$PWD/.tools/node_modules/.bin:$PATH"
pnpm install --frozen-lockfile
```

`strictPeerDependencies` is enabled; peer errors are fixed, never forced. The workspace holds `packages/*`, `apps/*` and `tools/webkit-macos14`.

## Running the applications

| Command               | What it starts                                                                |
| --------------------- | ----------------------------------------------------------------------------- |
| `pnpm dev:studio`     | XCursus Studio on `http://127.0.0.1:5174`, from the sources (no build needed) |
| `pnpm dev:playground` | The vanilla player pages `/core`, `/structure`, `/content` and `/layout`      |
| `pnpm xcursus …`      | The CLI from `packages/cli/dist` (run `pnpm build` first)                     |

The development servers resolve the workspace sources through Vite aliases. The Studio offline shell is registered only in production builds. In development, and in production with `?studio-debug` in the URL, Studio exposes `window.studio` for debugging and tests.

## Scripts

| Script                                                             | Purpose                                                                                                                                                                                                                |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm generate`                                                    | Generates the standalone validators and the TypeScript types from the JSON Schemas, and the KaTeX stylesheet                                                                                                           |
| `pnpm typecheck`                                                   | `generate`, then `tsc --noEmit` over packages, apps, tests and scripts                                                                                                                                                 |
| `pnpm lint`                                                        | ESLint (flat config, typescript-eslint, React hooks)                                                                                                                                                                   |
| `pnpm format` / `pnpm format:check`                                | Prettier                                                                                                                                                                                                               |
| `pnpm test`                                                        | Unit and integration tests (Vitest, jsdom and fake-indexeddb where needed)                                                                                                                                             |
| `pnpm test:coverage`                                               | The same with V8 coverage and per-area floors                                                                                                                                                                          |
| `pnpm build`                                                       | Builds core, player, plugins, CLI, editor, playground and Studio in dependency order                                                                                                                                   |
| `pnpm check:boundaries`                                            | Dependency rules between packages, on sources and built output                                                                                                                                                         |
| `pnpm check:bundle`                                                | Builds a minimal consumer from `dist` and checks the gzip budget                                                                                                                                                       |
| `pnpm check:packages`                                              | Packs the packages and tests the tarballs in an external consumer                                                                                                                                                      |
| `pnpm browsers:install`                                            | Installs the Playwright browsers for the current platform                                                                                                                                                              |
| `pnpm test:e2e`                                                    | Build, package check, then the Playwright suites in Chromium, Firefox and WebKit                                                                                                                                       |
| `pnpm test:e2e:webkit:macos14`                                     | WebKit only, with the dedicated macOS 14 runner                                                                                                                                                                        |
| `pnpm test:e2e:chrome`                                             | The same suites on the installed Google Chrome; with `playwright.installed.config.ts`, `XCURSUS_CHANNEL=msedge` or `XCURSUS_EXECUTABLE=<build>` select Edge or a given build                                           |
| `pnpm test:safari`                                                 | Build, then items 1–5 of the release checklist in the installed Safari through safaridriver (once per Mac: Safari's _Allow Remote Automation_ and `safaridriver --enable`), results in `test-results/checklist/safari` |
| `node scripts/checklist.mjs --browser <target>`                    | The release checklist in `firefox` (geckodriver; `FIREFOX_BINARY`), `ios-phone` or `ios-tablet` (iOS Simulator; `IOS_UDID`) or `android` (a device or emulator on adb; `ADB`); `--only 1,3` picks items                |
| `node scripts/screen-reader.mjs --reader voiceover\|nvda`          | Item 7 with a screen reader through Guidepup; the machine must be prepared with `@guidepup/setup` (CI only: it changes system settings)                                                                                |
| `node scripts/browser-builds.mjs <browser> latest\|previous <dir>` | Downloads a stable Firefox, Chrome or Edge build for Linux (used by the `Release checks` workflow)                                                                                                                     |
| `pnpm benchmark`                                                   | Performance budgets on the production builds (`--browser chromium\|firefox\|webkit`, `--headed`, `--gate`)                                                                                                             |

No script modifies tracked files: reports, coverage, bundles, tarballs and test evidence go to `test-results/` (ignored). CI fails if a check leaves a tracked file modified.

## Generated code

`pnpm generate` (`scripts/generate.mjs`) reads `packages/core/schema/project-*.schema.json`, writes the standalone Ajv validators to `packages/core/src/document/validator.js` and derives `packages/core/src/document/types.ts` from the current schema. Never edit those two files by hand: change the schema and regenerate. The same script produces `packages/plugins/src/katex.css` with woff2 sources only.

## Changing the document schema

The schema is a public contract ([FILE_FORMAT](FILE_FORMAT.md#compatibility-policy)). A change requires:

1. a new `project-<version>.schema.json` (published schemas are never edited);
2. a migration from the previous version in `packages/core/src/document`, returning a copy and never enabling unused capabilities;
3. updates to the specification, the format guide and the examples that should use the new feature;
4. tests that open every historical fixture, migrate it and compare the rendering.

## Browser runners

```sh
pnpm browsers:install
pnpm test:e2e
pnpm test:e2e --project=webkit          # a filter works with the automatic runner selection
pnpm test:e2e:webkit:macos14            # macOS 14 only
```

On Linux and on macOS 15 or later every browser runs with Playwright 1.64.1. On macOS 14 (Darwin 23) the current WebKit build is not compatible, so WebKit runs with Playwright 1.61.1 from the private workspace `tools/webkit-macos14`, while Chromium and Firefox keep 1.64.1. `scripts/e2e-plan.mjs` chooses the plan from platform, release and filters; `scripts/run-e2e.mjs` resolves each runner from its own package and checks its version before starting it. Both runners load the same suites through `tests/e2e/runner.ts`; `tests/e2e/config.ts` shares the servers and options.

Results go to `test-results/current/` and `test-results/webkit-macos14/`, and a summary of runners, versions and counts to `test-results/e2e-summary.json`. Screenshots and JSON evidence written by the suites go to `test-results/evidence/`.

The E2E suites serve production builds of the playground (port 4173) and Studio (port 4174); PDF checks need `pdftotext` and `pdftoppm` (poppler) or the xpdf tools, video checks need `ffmpeg` and `ffprobe`.

## Packaging

The six packages build with Vite library mode and `tsc --emitDeclarationOnly`; `prepack` copies the repository `LICENSE` into each package. Third-party dependencies are external (a build plugin fails if a chunk bundles a module from `node_modules`); artefacts that embed third-party code generate their notices from an allowlist of licences compatible with GPL-3.0-or-later. `pnpm check:packages` verifies the manifests, packs the tarballs into `test-results/packages/`, installs them in an external consumer without source aliases, type-checks it with `skipLibCheck: false` and builds a minimal and a realistic consumer.

The packages are ready for npm (public access under the `@xcursus` scope) but nothing is published automatically: publishing is a manual maintainer step, described in [DISTRIBUTION](DISTRIBUTION.md#packages).

## Contributing

- Work on a branch and open a pull request against `main`. Keep technical changes and documentation changes in separate, focused commits.
- Before pushing, run at least `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm test` and `pnpm build`; changes to the player, Studio, exports or packaging also need `pnpm test:e2e`.
- Add a failing test with every bug fix, and tests that exercise real behaviour (real files, real browsers) with every feature. Do not update screenshots or expectations to hide a regression.
- Keep the boundaries: no DOM or React in the core, no plugin or editor import in the player, no code executed from documents, no CSS strings in the document model.
- Document user-visible behaviour in the relevant guide and record schema or API changes in the specification.
- New runtime dependencies need a licence compatible with GPL-3.0-or-later and an exact pin.
- Example and fixture content must be original or under a licence that allows redistribution; record it in the example's `LICENSE.md`.

## Licence

[GPL-3.0-or-later](../LICENSE) for every package, including the embeddable player.
