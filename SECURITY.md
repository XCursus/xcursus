# Security policy

XCursus treats every project, archive, asset and imported HTML file as untrusted input. The threat model is in [PLUGINS](docs/PLUGINS.md#trust-model-and-threats) and the requirements in the [specification §10](docs/SPECIFICATION.md#10-security-and-accessibility).

## Supported versions

| Version                | Supported                  |
| ---------------------- | -------------------------- |
| `main` (1.0 candidate) | Yes                        |
| 0.6.x on npm           | Yes, until 1.0 is released |
| Earlier pre-releases   | No: upgrade to the latest  |

## Reporting a vulnerability

Please report vulnerabilities privately, not in public issues or pull requests:

1. Open <https://github.com/XCursus/xcursus/security/advisories/new> (**Security → Report a vulnerability** on the repository) to send a private report to the maintainer.
2. Describe the affected component and version, the input that triggers the problem (a minimal project, archive or HTML file if possible) and the impact you observed. Do not include real personal data.

What to expect: an acknowledgement within 7 days, an assessment and a plan within 30 days, and coordinated disclosure once a fix is released, crediting the reporter unless you prefer otherwise. If a report turns out not to be a vulnerability, it is answered and, with your agreement, moved to a public issue.

## Scope

In scope: code execution or markup injection from a document, archive, asset or imported impress.js file; sanitizer bypasses; escaping the archive or project directory (traversal, symbolic links); resource exhaustion beyond the declared limits; leaks of private notes into public outputs or the audience window; CSP weaknesses of exports; flaws of the presenter protocol.

Out of scope: plugins installed by the host application, which are trusted code by design; content a user deliberately embeds from an origin the host approved; problems that need an already compromised browser or machine; missing hardening headers on third-party hosting of the static build.

## Dependencies

Runtime dependencies are pinned in the lockfile and audited with `pnpm audit --prod` before a release. Development-only advisories are tracked in the [release blockers](docs/RELEASE_BLOCKERS.md) when they affect the toolchain.
