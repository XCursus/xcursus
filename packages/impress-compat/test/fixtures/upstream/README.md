# Upstream impress.js fixtures

Unmodified files from the official impress.js repository, <https://github.com/impress/impress.js>, tag `v2.0.0`, commit `dc3cf69747e0b1b0d1fe534509d09c3c48030e68` (21 July 2022). They are copyright Bartek Szopka, Henrik Ingo and the impress.js contributors and distributed under the MIT licence in [LICENSE](LICENSE). They are test data only: they are never part of a package, a build or the XCursus runtime.

| File                | Upstream path                         | SHA-256                                                            |
| ------------------- | ------------------------------------- | ------------------------------------------------------------------ |
| `demo.html`         | `index.html`                          | `3ff139cb86dfdd363f83d8137916f1c85fb1bdd9e7b7e68dc779a30e83adfe41` |
| `3D-rotations.html` | `examples/3D-rotations/index.html`    | `73147b5bbc4a6d6c050935207eb9859ec92b212dc82102d0cd845b6a50a92fac` |
| `cube.html`         | `examples/cube/index.html`            | `80e20ed4f8cb335c80166ed0c0e087d565f9578f2fea79c48c982d880561a921` |
| `3D-positions.html` | `examples/3D-positions/index.html`    | `081f0b3ad687d60f617b50955f4c09bad319aa6fc91d5ad5f264ad0b9fa94b3f` |
| `impress-2.0.0.js`  | `js/impress.js` (the release bundle)  | `3e198709596c89695469b84da88a012015ae74388484a727eef13c4b1af0f644` |
| `LICENSE`           | `LICENSE`                             | `e3e45d674a665726038dfedc86c8c98619984f04a96473a8220b2ec0c0f066ea` |

How they are used:

- the unit tests import the HTML files with `importImpress` and compare the geometry with the independent oracle in `../../oracle.ts`, built from the transform strings of `src/impress.js`;
- the browser suite (`tests/e2e/impress.spec.ts`) loads `impress-2.0.0.js` on the HTML fixtures in Chromium, Firefox and WebKit, reads the transforms the upstream engine computes, and compares them with the imported document rendered by the XCursus player.

The stylesheets and images the examples reference are not copied; the importer reports them as not loaded or missing, which is part of what the tests check.
