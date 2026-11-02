# Contributing to XCursus

Thank you for helping. XCursus is a local-first project with a few firm rules: documents are data and never code, the core stays pure, and every change is proven by tests that exercise real behaviour.

## Before you start

- Read [ARCHITECTURE](docs/ARCHITECTURE.md) for the package boundaries and the design decisions, and the [specification](docs/SPECIFICATION.md) for the normative contract.
- Set up the pinned toolchain (Node 24.22.0, pnpm 12.14.0) as described in [DEVELOPMENT](docs/DEVELOPMENT.md#toolchain-and-installation) and run `pnpm install --frozen-lockfile`.
- For a security problem, do not open a public issue: follow [SECURITY.md](SECURITY.md).

## Making a change

1. Open an issue to discuss anything larger than a fix, then work on a branch and open a pull request against `main`.
2. Keep technical and documentation changes in separate, focused commits with a short subject such as `[player] keep focus on the stage after a swipe`.
3. Add a failing test with every bug fix, and tests that use real files and real browsers with every feature. Mocks are acceptable for time, errors and permissions only. Never update screenshots, expected values or fixtures to hide a regression; historical fixtures in `tests/fixtures` and `examples` stay unchanged.
4. Keep the boundaries: no DOM or React in the core, no plugin, editor or importer in the player, no code or CSS strings executed from documents, no `innerHTML` with unsanitized input.
5. Document user-visible behaviour in the relevant guide and record schema, API or format changes in the specification and the [changelog](CHANGELOG.md). A schema change needs a new schema file, a migration and fixtures ([DEVELOPMENT](docs/DEVELOPMENT.md#changing-the-document-schema)).
6. New runtime dependencies need a licence compatible with GPL-3.0-or-later, an exact or caret pin recorded in the lockfile, and an entry in the third-party notices when they are bundled.
7. Example and fixture content must be original or under a licence that allows redistribution, recorded next to it (`LICENSE.md` or a provenance README).

## Checks

Run at least these before pushing; CI runs all of them on Linux and fails if a check modifies a tracked file:

```sh
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm build
pnpm check:boundaries
pnpm check:bundle
```

Changes to the player, Studio, exports, the importer or packaging also need `pnpm check:packages` and `pnpm test:e2e` (Chromium, Firefox and WebKit; see [VERIFICATION](docs/VERIFICATION.md)). Performance-sensitive changes should compare `pnpm benchmark` before and after on the same machine. Report a check that could not run as not run, never as passed.

## Licence

By contributing you agree that your contribution is distributed under the [GPL-3.0-or-later](LICENSE) licence of the project.
