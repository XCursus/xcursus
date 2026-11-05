# XCursus 1.0.0 release procedure

## Candidate status

Prepared for final maintainer approval, **not published or declared stable**. All six public packages, the private root and the two private apps are at 1.0.0. The development-only WebKit runner keeps its independent version. Document schema **1.3.0**, archive manifest **1.0.0**, plugin API **1.0.0** and presenter protocol **xcursus-presenter/1** are unchanged.

Audit baseline: [`c28042a0f2bbd01cc84d85b3344a431de5a977ce`](https://github.com/XCursus/xcursus/commit/c28042a0f2bbd01cc84d85b3344a431de5a977ce), verified against GitHub `main` on 5 November 2026. Local preparation: `7877582` (branch live-region correction) and `5a56c63` (versions and packaging checks), on `release/1.0-readiness`. No push, merge, tag, GitHub Release or registry write is part of this preparation. Existing untracked local files are excluded from the changes and packages.

Registry snapshot on that date: core, player, plugins, editor and CLI have `latest: 0.6.0`; none has 1.0.0. `@xcursus/impress-compat` returns HTTP 404. GitHub has no releases. These observations must be repeated before publication. `npm whoami` and `npm org ls xcursus` returned **E401** locally: authentication and current publishing rights have **not** been established. A successful pack or dry run cannot establish them.

This release covers the public GPL-3.0-or-later packages, formats, CLI and repository Studio application. It does not announce or deliver a future commercial distribution of XCursus Studio. Every package, including the embeddable player, retains the existing GPL licence.

## Acceptance criteria

- No known unresolved P0/P1, security or data-loss defect. B1–B8 remain closed with their explicitly scoped [evidence](RELEASE_BLOCKERS.md); simulated devices and automated screen readers remain labelled as such.
- All six packages build, pack and work outside the workspace. Public exports and TypeScript declarations remain compatible; shipped internal dependencies resolve to the same exact product version.
- Every historical document version migrates, the manifest and plugin contracts remain stable, and `.spatialdeck` inputs stay read-only and round-trip as `.xcursus`.
- Unit/coverage, static checks, boundaries, bundle budgets, packaging, browser and export checks pass on the selected source. Test reports distinguish an old CI run from new local results. Final remote CI must identify the exact release commit.
- The maintainer accepts the remaining [P2/P3 limitations](ROADMAP.md#known-issues): PDF rasterization of rotated scenes, restarting long camera tracks with Next, performance at the 1000-scene ceiling, software-rendered Firefox and Studio's CSP console noise. These have documented workarounds and do not change the supported export profiles.
- Tarballs contain the exact repository GPL, all declared exports, fonts and notices; the selected source is available alongside the distribution. The registry bytes must match the reviewed bytes.
- Authenticated npm access, final approval, publication and the tag are maintainer actions, not conclusions inferred from technical checks.

### Accessibility reconciliation

At `c28042a`, specification §5 and checklist item 7 promised the title **and choices** in a live announcement. The implementation wrote only the title into `.xc-live`; B4 and the screen-reader script proved that choice buttons were reachable and named when focused. That evidence did not prove automatic announcement on arrival. The P3 classification did not remove this discrepancy in the documented contract.

`7877582` supplies the visible choice labels and disabled reasons to the existing polite, atomic live region, using plain text and marking the interface language separately from the scene title. It refreshes on a path/node change even when the same scene is shown, and clears the summary after leaving a branch. No public API, navigation rule or schema changes.

Regression evidence: the previous implementation fails the live-region assertion (`TEXT` lacked `Choose the path`); player tests cover initial and arrival choices, disabled reasons, exit/prev, paths sharing a scene, document updates, language and inert hostile labels. The existing structure browser test also checks the region at a branch, after leaving it and at a disabled loop. These are DOM assertions, **not recordings of speech**. The earlier VoiceOver listening check at `5faf658` and the earlier NVDA/VoiceOver automation are historical evidence, not a new listening check of this correction.

As part of final approval, listen on the selected release build with NVDA/Chrome and VoiceOver/Safari: enter `/structure`, navigate away from and back to a branch, confirm the title and choices are announced without moving focus to a choice, then confirm each button remains reachable and named. Record browser, reader, commit and what was heard. If an engine does not announce the summary, assess that observed result before approving; do not report the DOM assertion as a speech test or silently relax specification §5. This targeted check does not reopen the completed browser/device matrix.

## Verification and evidence

Upstream baseline `c28042a` has successful [Core CI 41995557876](https://github.com/XCursus/xcursus/actions/runs/41995557876) and [Release checks 41991358428](https://github.com/XCursus/xcursus/actions/runs/41991358428), verified through the runs and job steps. They cover the baseline only. The controlled performance measurements at `0a902a9` in B6 also remain historical evidence.

Local verification of the source prepared in `7877582`/`5a56c63`, with Node 24.22.0 and pnpm 12.14.0:

| Check                                          | Result / inspectable evidence                                                                                                                                                                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Frozen install; regenerated lockfile           | Passed. `pnpm install --lockfile-only` leaves the lockfile byte-for-byte unchanged: workspace dependencies are `link:` records, not product-version records. A subsequent frozen install also passed.                                      |
| Typecheck, lint, build, boundaries             | Passed; logs in `test-results/release-1.0/`.                                                                                                                                                                                               |
| Unit tests with V8 coverage                    | **535 passed**, 33 files; statements 92.13%, branches 84.85%; every configured floor passed. Includes seeded archive/markup fuzzing, compatibility and CLI exit-code tests.                                                                |
| Package and consumer checks                    | **130/130**; six 1.0.0 tarballs, external strict TypeScript consumer (`skipLibCheck: false`), CLI/importer execution, minimal/realistic builds. `test-results/packages/report.json`.                                                       |
| npm publish dry run                            | Six local tarballs accepted by `npm publish <tgz> --dry-run --ignore-scripts --access public --tag release-1.0`; reported SHA-512 equals each packed file. No registry writes; no authentication claim.                                    |
| Minimal bundle                                 | 67,150 B JS / 1,347 B CSS gzip; within 100/20 KiB. Realistic tarball consumer: initial JS 66,381 B, total JS 170,739 B, CSS 9,102 B gzip; within 100/200/20 KiB.                                                                           |
| Production audit                               | `pnpm audit --prod --json`: zero known vulnerabilities at the check time. Development-only advisories remain separate.                                                                                                                     |
| Browser, export and axe suites                 | **312 passed** (104 per engine), zero failed, skipped or flaky. Chromium/Firefox: Playwright 1.64.1; WebKit on macOS 14: dedicated 1.61.1 runner. `test-results/e2e-summary.json`; export and axe evidence under `test-results/evidence/`. |
| Formatting and current performance measurement | Formatting passed. Current three-engine performance measurements are recorded below; measurements in this active session are informative, separate from B6's controlled gate.                                                              |
| Private security reporting                     | GitHub API read on 5 November 2026 returned `{"enabled":true}`.                                                                                                                                                                            |
| New automatic branch speech                    | Not listened to during preparation; targeted final approval check described above.                                                                                                                                                         |

The runtime sources and package contents are unchanged by documentation-only commits after `5a56c63`. Package reports and checksums must still be regenerated and sealed against the **final chosen commit** before publishing. Local ignored logs are reproducible working evidence; upload the selected reports with the release to retain them beyond CI artifact expiry.

### Current performance measurement

All observable budget checks passed on the prepared runtime at `5a56c63`: Apple M3 Max, 16 cores, 64 GiB, macOS 14.8.7, Node 24.22.0, headless, 1280×720/DPR 1, five warm-ups and twenty runs. This active session was **on battery**, with documentation-only tracked changes; these measurements are informative, not a new controlled B6 gate. Raw samples and environment are in `test-results/benchmark/benchmark-{chromium,firefox,webkit}.json`.

| Browser               | Validation p95 ms | Mount-ready p95 ms | Input → preview p95 ms | Frame interval p95 ms |
| --------------------- | ----------------: | -----------------: | ---------------------: | --------------------: |
| chromium 156.0.8078.4 |              11.3 |              334.4 |                   42.4 |                  16.8 |
| firefox 157.0         |              11.1 |              427.0 |                   36.0 |                  16.8 |
| webkit 26.5           |              13.1 |              234.0 |                   29.0 |                  17.0 |

Every engine released its owned resources after 50 mount/destroy cycles. Chromium observed no long task over 200 ms and a 0.05 MiB heap delta after GC; those observations are unavailable in the other engines.

### Public contracts reviewed

The 0.6.0 tarballs were fetched directly from the public npm registry and their declarations and export maps compared with the candidate. No public subpath was removed. Core and player declarations are identical. Plugin additions are optional network policy/constructor options and exported types; editor additions are optional `StudioProps.importImpress` and importer callback types; CLI adds `ConvertReport`. Other CLI declaration differences are an optional argument in an internal helper and comments; editor icon internals are not exported subpaths. React/React DOM peers remain `^19.3.1`, Node remains `>=24`, and libraries remain ESM-only.

| Contract                    | 1.0 commitment and check                                                                                                                                                                                                |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| core                        | Root API and four schema subpaths retained; generated types, migrations, navigation, geometry and capture covered by unit and consumer checks. All four published schema files are byte-identical to the 0.6.0 tarball. |
| player                      | Root, presenter, CSS/fonts and IIFE subpaths retained; no React/editor/importer dependency. CSS and third-party/font licences are shipped.                                                                              |
| plugins                     | SDK, rich/media/navigation/builtins/sample/archive and CSS subpaths retained; optional renderers stay lazy. API 1.0.0, opaque plugin data and legacy badge ID retained.                                                 |
| editor                      | Root and CSS retained; host import/export callbacks remain optional. No dependency on the importer or CLI is added.                                                                                                     |
| CLI                         | Root, `html` and `xcursus` bin retained; exit codes 0 success, 1 data/profile, 2 missing environment, 3 write/capture failure. Strict/partial profiles and notes exclusion remain tested.                               |
| impress-compat              | New public root/types; core, parse5 and gl-matrix only. Valid schema-1.3.0 candidates and diagnostic losses; no general impress.js fidelity promise.                                                                    |
| `.xcursus` / `.spatialdeck` | Same manifest 1.0.0 (`path` separate from ZIP `entry`); digests and limits verified, original legacy file unchanged. Export outputs are not editable interchange files.                                                 |
| Exports                     | Same shared player for offline HTML/static/PDF/WebM; manifests record only checks actually performed. PDF/video retain their declared profile and environment limits.                                                   |

## Reproduce and freeze the approved candidate

Use a checkout of the reviewed branch/commit and the pinned toolchain ([DEVELOPMENT](DEVELOPMENT.md)). Keep unrelated local work out of the release checkout. Versions are already prepared; do not run a second version bump. To reproduce the version change from the baseline, set only the root, `packages/{core,impress-compat,player,plugins,editor,cli}/package.json` and `apps/{playground,studio}/package.json` to 1.0.0, keep `workspace:*` in source manifests, then regenerate the lockfile. Do not bump the independent document/archive/plugin versions or publish the private apps.

```sh
pnpm install --lockfile-only
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test:coverage
pnpm build
pnpm check:boundaries
pnpm check:bundle
pnpm check:packages
node scripts/run-e2e.mjs
pnpm audit --prod
git diff --exit-code
```

`pnpm build` orders core → impress-compat → player → plugins → CLI → editor → playground → Studio. Browser installation is explicit if missing (`pnpm browsers:install`); PDF/video checks need Chromium, FFmpeg/ffprobe and Poppler/xpdf. Measure `pnpm benchmark --browser chromium --gate`, then repeat with `firefox` and `webkit` sequentially on a controlled machine when required; a shared-machine result is informative and labelled accordingly. After the maintainer updates release status/date in README, CHANGELOG, ROADMAP, SECURITY and this candidate status, commit the final documents and repeat checks applicable to those changes. Core CI and the Release checks workflow must identify this final source; the existing baseline runs are not substitutes.

`pnpm pack` performs the `workspace:*` → exact `1.0.0` substitution and copies LICENSE. **Do not use `npm publish` on source directories.** The publication procedure below uses already verified pnpm tarballs. `check:packages` refuses missing exports/bin, files outside the distribution allowlist, leftover workspace ranges, mismatched internal versions, missing GPL and missing embedded notices. The build also checks bundled third-party licence compatibility; review the player IIFE and CLI runtime notice files and the OFL/KaTeX font licences in the tarballs. Upstream impress.js fixtures are excluded.

Freeze the selected, verified candidate for final approval. Upload only after that approval. The following commands create local artifacts and do not publish:

```sh
export RELEASE_COMMIT="$(git rev-parse HEAD)"
test -z "$(git status --porcelain --untracked-files=no)"
export RELEASE_ARTIFACTS="$PWD/test-results/release-1.0/artifacts"
mkdir "$RELEASE_ARTIFACTS"
cp test-results/packages/tarballs/*.tgz "$RELEASE_ARTIFACTS/"
cp test-results/packages/report.json "$RELEASE_ARTIFACTS/packages-report.json"
cp test-results/e2e-summary.json "$RELEASE_ARTIFACTS/"
git archive --format=tar.gz --prefix=xcursus-1.0.0/ "$RELEASE_COMMIT" > "$RELEASE_ARTIFACTS/xcursus-1.0.0-source.tar.gz"
node --input-type=module <<'JS'
import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const dir = process.env.RELEASE_ARTIFACTS;
const procedure = await readFile('docs/RELEASE_1_0.md', 'utf8');
const notes = procedure.split('### Official 1.0.0 release notes\n')[1]
  .split('\n## Partial publication and regression response')[0].trim();
await writeFile(`${dir}/release-notes.md`, `# XCursus 1.0.0\n\n${notes}\n`);
const report = JSON.parse(await readFile(`${dir}/packages-report.json`, 'utf8'));
for (const p of report.packages) {
  const bytes = await readFile(`${dir}/${p.file}`);
  if (`sha512-${createHash('sha512').update(bytes).digest('base64')}` !== p.integrity)
    throw Error(`Tarball changed: ${p.name}`);
}
const record = {
  version: '1.0.0', commit: process.env.RELEASE_COMMIT,
  tree: execFileSync('git', ['rev-parse', `${process.env.RELEASE_COMMIT}^{tree}`], { encoding: 'utf8' }).trim(),
  lockfileSha256: createHash('sha256').update(await readFile('pnpm-lock.yaml')).digest('hex'),
  node: process.version, pnpm: execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim(),
  packages: report.packages,
};
await writeFile(`${dir}/release.json`, JSON.stringify(record, null, 2) + '\n');
const files = (await readdir(dir)).filter(f => f !== 'SHA256SUMS').sort();
const sums = await Promise.all(files.map(async f =>
  `${createHash('sha256').update(await readFile(`${dir}/${f}`)).digest('hex')}  ${f}`));
await writeFile(`${dir}/SHA256SUMS`, sums.join('\n') + '\n');
JS
(cd "$RELEASE_ARTIFACTS" && shasum -a 256 -c SHA256SUMS)
```

Review and retain these artifacts. Do not rerun packing, rebuild or edit tarballs after freezing; `check:packages` recreates its own output directory. A new source change requires new verification and a new freeze. The release record links exact tarball bytes to the source commit; `gitHead` is not guaranteed when publishing a prepacked tarball.

## Maintainer-only publication sequence

All commands in this section write to external services **only after explicit final maintainer approval**. None was run during preparation. Publication across npm packages and dist-tags is not atomic.

1. Select and review the final commit, finalize the public release status/date, obtain successful CI for it, complete the targeted listening check and accept the documented P2/P3 limits. Approve the sealed artifact set. Merge/push remains a separate maintainer action.
2. Establish fresh npm authentication and rights, with the registry explicit. `npm login --registry=https://registry.npmjs.org`, `npm whoami --registry=https://registry.npmjs.org`, `npm org ls xcursus --json --registry=https://registry.npmjs.org`; inspect the scope role, existing package collaborators and 2FA/token restrictions. Confirm that the account can create the new scoped package. A dry run is only a local packaging check; actual write permission can still be refused.
3. Repeat registry reads for all six names and 1.0.0. Any unexpected existing version requires comparison and the partial-publication procedure below, not `--force`. Confirm `v1.0.0` does not exist locally or remotely. Verify checksums immediately before publication.
4. Publish the **sealed tarballs** under the temporary dist-tag `release-1.0`, in order **core → impress-compat → player → plugins → editor → CLI**, checking each upload before proceeding. This tag is a public staging label, not an access restriction; explicit `@1.0.0` installs work immediately. For the new impress-compat package, inspect all dist-tags after its first upload rather than assuming there was a previous `latest` to preserve.

Use one explicit package command at a time:

```sh
npm publish "$RELEASE_ARTIFACTS/xcursus-core-1.0.0.tgz" --access public --tag release-1.0 --ignore-scripts --registry=https://registry.npmjs.org
npm publish "$RELEASE_ARTIFACTS/xcursus-impress-compat-1.0.0.tgz" --access public --tag release-1.0 --ignore-scripts --registry=https://registry.npmjs.org
npm publish "$RELEASE_ARTIFACTS/xcursus-player-1.0.0.tgz" --access public --tag release-1.0 --ignore-scripts --registry=https://registry.npmjs.org
npm publish "$RELEASE_ARTIFACTS/xcursus-plugins-1.0.0.tgz" --access public --tag release-1.0 --ignore-scripts --registry=https://registry.npmjs.org
npm publish "$RELEASE_ARTIFACTS/xcursus-editor-1.0.0.tgz" --access public --tag release-1.0 --ignore-scripts --registry=https://registry.npmjs.org
npm publish "$RELEASE_ARTIFACTS/xcursus-cli-1.0.0.tgz" --access public --tag release-1.0 --ignore-scripts --registry=https://registry.npmjs.org
```

Run each line only after verifying the preceding upload; do not paste the block as an unchecked batch. `--ignore-scripts` applies to the already packed upload; the required build, notices and prepack have already run. Supply 2FA through npm's normal flow. Do not put credentials or codes in reports.

After **each** upload, and again after all six, run the read-only verification below. It skips versions not uploaded yet, fails on anything other than an expected 404, and validates both metadata and downloaded bytes. After the sixth upload require **six verified packages**, with no missing version:

```sh
node --input-type=module <<'JS'
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
const release = JSON.parse(await readFile(`${process.env.RELEASE_ARTIFACTS}/release.json`, 'utf8'));
let verified = 0;
for (const p of release.packages) {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(p.name)}/1.0.0`);
  if (response.status === 404) { console.log(`Not uploaded: ${p.name}`); continue; }
  if (!response.ok) throw Error(`${p.name}: HTTP ${response.status}`);
  const m = await response.json();
  if (m.name !== p.name || m.version !== '1.0.0' || m.license !== 'GPL-3.0-or-later' ||
      m.dist.integrity !== p.integrity || (m.gitHead && m.gitHead !== release.commit))
    throw Error(`Metadata mismatch: ${p.name}`);
  for (const [dep, range] of Object.entries(m.dependencies ?? {}))
    if (range.startsWith('workspace:') || (dep.startsWith('@xcursus/') && range !== '1.0.0'))
      throw Error(`Dependency mismatch: ${p.name} ${dep}`);
  const tarball = await fetch(m.dist.tarball);
  if (!tarball.ok) throw Error(`Tarball HTTP ${tarball.status}: ${p.name}`);
  const bytes = Buffer.from(await tarball.arrayBuffer());
  if (`sha512-${createHash('sha512').update(bytes).digest('base64')}` !== p.integrity ||
      createHash('sha256').update(bytes).digest('hex') !== p.sha256)
    throw Error(`Registry bytes mismatch: ${p.name}`);
  console.log(`Verified ${p.name}@1.0.0`); verified++;
}
console.log(`${verified}/6 verified`);
if (process.env.REQUIRE_ALL === '1' && verified !== 6) process.exitCode = 1;
JS
```

Set `export REQUIRE_ALL=1` for the final pass. On a transient 404, wait for propagation and repeat the read; do not republish blindly.

5. Install **explicit versions from npm** in a fresh consumer with no workspace aliases or overrides. Copy `src/`, the two HTML entries, `tsconfig.json` and `vite.config.mjs` from the generated tarball consumer into a new directory. Create an ESM `package.json`, then install:

```sh
npm install --save-exact @xcursus/core@1.0.0 @xcursus/impress-compat@1.0.0 @xcursus/player@1.0.0 @xcursus/plugins@1.0.0 @xcursus/editor@1.0.0 @xcursus/cli@1.0.0 react@19.3.1 react-dom@19.3.1
npm install --save-dev --save-exact typescript@6.0.3 vite@8.3.5 @types/react@19.3.0 @types/node@24.19.2
./node_modules/.bin/tsc -p .
./node_modules/.bin/vite build
./node_modules/.bin/xcursus --version
npm ls @xcursus/core @xcursus/player @xcursus/plugins @xcursus/editor @xcursus/cli @xcursus/impress-compat
```

Require CLI 1.0.0 and one compatible 1.0.0 dependency graph. From that consumer, validate a repository JSON and the unchanged legacy archive, convert the impress.js example and export HTML with new output names. Serve `minimal.html`/`realistic.html` and confirm navigation, fonts and rich/media rendering. Keep the consumer lockfile and results; this run tests registry dependency resolution without the tarball consumer's pins. Run `npm audit --omit=dev` and assess any newly resolved advisory before promotion.

6. Only after all registry and consumer checks pass, promote `latest`, in the same dependency order, one command per package:

```sh
npm dist-tag add @xcursus/core@1.0.0 latest --registry=https://registry.npmjs.org
npm dist-tag add @xcursus/impress-compat@1.0.0 latest --registry=https://registry.npmjs.org
npm dist-tag add @xcursus/player@1.0.0 latest --registry=https://registry.npmjs.org
npm dist-tag add @xcursus/plugins@1.0.0 latest --registry=https://registry.npmjs.org
npm dist-tag add @xcursus/editor@1.0.0 latest --registry=https://registry.npmjs.org
npm dist-tag add @xcursus/cli@1.0.0 latest --registry=https://registry.npmjs.org
```

Read every `dist-tags` again; all six must name 1.0.0 as `latest`. Remove `release-1.0` after successful completion, keeping a record of the old tags. [npm dist-tags](https://docs.npmjs.com/cli/v11/commands/npm-dist-tag/) are mutable pointers; they do not change version contents.

## Tag, GitHub Release and post-release checks

After npm verification and promotion, use the **same** `RELEASE_COMMIT` from the sealed `release.json`. Confirm the approved commit is on the intended published branch, checksums pass, and the tag is unused. These are maintainer-only commands; no tag or release is created by the preparation:

```sh
test "$(git rev-parse HEAD)" = "$RELEASE_COMMIT"
git tag -a v1.0.0 "$RELEASE_COMMIT" -m 'XCursus 1.0.0'
test "$(git rev-parse 'v1.0.0^{commit}')" = "$RELEASE_COMMIT"
git push origin refs/tags/v1.0.0
gh release create v1.0.0 "$RELEASE_ARTIFACTS"/* --verify-tag --draft --title 'XCursus 1.0.0' --notes-file "$RELEASE_ARTIFACTS/release-notes.md"
```

The freeze step writes `release-notes.md` from the official text below and includes it in SHA256SUMS. Review the GitHub draft, tag target, public source archive, notices, tarballs and release record. Then the maintainer publishes it with `gh release edit v1.0.0 --draft=false --latest`. Never use an implicit HEAD tag or silently move a published tag.

- Download the release assets and verify SHA256SUMS; compare `release.json.commit`, `v1.0.0^{commit}`, the final successful CI SHA and the approved commit. Confirm every npm tarball's SRI and SHA-256 again. `gitHead`, if present, must agree; the sealed record and byte identity establish correspondence when it is absent.
- Confirm all six exact versions and `latest` installs from a fresh directory, CLI help/version, schema subpaths, CSS/fonts, notices, offline HTML and the read-only legacy path. Confirm npm and GitHub links in the public documentation resolve.
- Record release date, URLs, actual publication results and any exceptions here; remove candidate wording and update SECURITY's supported-version table in the approved release-status change. Retain the known limits and historical evidence.

### Official 1.0.0 release notes

XCursus 1.0.0 is the first stable release of the GPL-3.0-or-later platform for local-first spatial, non-linear presentations. Author scenes in XCursus Studio, embed the framework-free player or distribute offline HTML, a static website, PDF and WebM video using the same rendering engine.

- Six coordinated npm packages, including the new `@xcursus/impress-compat`, with TypeScript declarations and separately exported styles.
- Reviewed impress.js 2.0.0 import in Studio and `xcursus convert impress`, with explicit diagnostics for unsupported content and no execution of imported scripts.
- Branching navigation, camera tracks, canvas layout, rich local content, presenter view, offline authoring and exports with manifests and bundled licence notices.
- Document schema 1.3.0, archive manifest 1.0.0 and plugin API 1.0.0 retained. Historical JSON and `.spatialdeck` files remain readable; saves use `.xcursus`.
- Browser, accessibility, sanitization, archive, consumer and export verification; corrected branch live-region summaries, touch navigation and Firefox scene painting.

Supported profiles and limits remain explicit: WebM has no audio track; PDF may rasterize rotated scenes; trusted plugins are host code; the importer does not promise arbitrary CSS/plugin fidelity. See [distribution](https://github.com/XCursus/xcursus/blob/v1.0.0/docs/DISTRIBUTION.md), [known issues](https://github.com/XCursus/xcursus/blob/v1.0.0/docs/ROADMAP.md#known-issues) and the [changelog](https://github.com/XCursus/xcursus/blob/v1.0.0/CHANGELOG.md). This release does not announce a commercial XCursus Studio distribution.

## Partial publication and regression response

- **Authentication, access or network refusal:** stop before uploading dependants or changing `latest`. Record the exact successful versions and their hashes. Restore authentication/permissions, read the registry again and resume only the missing packages from the unchanged approved artifact set. A lost response may hide a successful upload.
- **Version already exists:** compare registry metadata and downloaded bytes. Identical approved content can be recorded as already uploaded; different content cannot be overwritten or treated as the approved release. [npm publication](https://docs.npmjs.com/cli/v11/commands/npm-publish/) makes a name/version immutable, including after unpublishing.
- **Defective uploaded content:** stop promotion and the GitHub release. Do not force a republish or routinely unpublish. Prepare and test a coordinated 1.0.1 set (internal dependencies are exact, so all six need aligned versions), document the defect and deprecate affected 1.0.0 versions as appropriate. A severe data/security issue follows [SECURITY](../SECURITY.md), with private handling until coordinated disclosure.
- **Interrupted promotion:** the six `latest` updates are not atomic. Inspect all tags, complete promotion only after verified content, or restore the five existing packages' previous `latest` values if that is the maintainer's decision. The new impress-compat has no earlier release: remove its `latest` tag if necessary and communicate the unavailable default install; never invent a rollback version. Removing a tag does not retract explicit version installs or existing lockfiles.
- **Regression after release:** retain a minimal reproduction and affected environment, classify impact, add a failing regression test, apply the smallest fix, verify and issue 1.0.1 (or the next available patch) with new immutable artifacts and tag. Keep `v1.0.0` and its assets intact, amend its release notes with a clear advisory/link when warranted, and verify both the fix and legacy compatibility. Do not represent a rolled-back dist-tag as a fix for already installed consumers.
