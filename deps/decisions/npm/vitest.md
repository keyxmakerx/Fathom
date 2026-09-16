# `vitest` — recorded 2026-09-16

**Owner-approved** as the client's test harness, implied by the stack decision of 2026-09-11
(`CLAUDE.md` "The stack": React + Vite) and already in use — `client/vitest.config.ts` and the
existing `*.test.ts`/`*.test.tsx` files under `client/src/` run against it today.

| | |
|---|---|
| **Job** | The client's test runner — `npm test` → `vitest run` |
| **Version** | `5.0.0`, pinned in `client/package-lock.json` |
| **Publisher** | The Vitest project — `maintainers` includes `ariperkkio`, `antfu` (Anthony Fu), `hiogawa`, `oreanno`; `repository.url` = `git+https://github.com/vitest-dev/vitest.git` (checked via `npm view vitest`, 2026-09-16) |
| **Licence** | MIT — compatible with ADR-0004 |
| **Ships or tooling** | **Test-only.** `devDependencies`. Never runs outside CI/local test runs, never reaches the built artifact |
| **Install scripts** | None on this package's lockfile entry (checked 2026-09-16) |
| **Native/postinstall code** | None directly; it depends on `vite` (recorded separately) for its module graph, which is where any platform-native binaries in the closure come from |
| **Determinism** | Not evaluated against ADR-0032's criterion — test tooling, not part of Fathom's canonical data processing |

## Why not first-party

A hand-written test runner buys nothing over an existing one and directly contradicts the
verification-floor requirement (`CLAUDE.md` "Verifying work") that tests actually run — writing the
runner is time not spent writing the tests it would run.

## Advisories

**Checked 2026-09-16**: `npm audit --json` over the whole lockfile — 0 vulnerabilities. Goes stale
immediately.
