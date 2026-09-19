# `@types/react-dom` — recorded 2026-09-16

**Owner-approved** as a consequence of the React + TypeScript stack decision of 2026-09-11, same
basis as `@types/react.md`.

| | |
|---|---|
| **Job** | TypeScript type declarations for `react-dom` — `client/src/main.tsx`'s `createRoot` call type-checks against this |
| **Version** | `19.3.0`, pinned in `client/package-lock.json`, matching the `react-dom` version it declares |
| **Publisher** | DefinitelyTyped / npm `types` account, same as `@types/node` and `@types/react` (checked via `npm view @types/react-dom`, 2026-09-16) |
| **Licence** | MIT — compatible with ADR-0004 |
| **Ships or tooling** | **Tooling only.** `devDependencies`. Erased by the compiler, no runtime presence |
| **Install scripts** | None on this package's lockfile entry (checked 2026-09-16) |
| **Native/postinstall code** | None. Pure `.d.ts` declaration files |
| **Determinism** | Not evaluated — no runtime behaviour |

## Its own dependency

`peerDependencies` on `@types/react` — already recorded, same version.

## Why not first-party

Same reasoning as `@types/react.md`.

## Advisories

**Checked 2026-09-16**: `npm audit --json` over the whole lockfile — 0 vulnerabilities. Goes stale
immediately.
