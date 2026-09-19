# `@types/react` — recorded 2026-09-16

**Owner-approved** as a consequence of the React + TypeScript stack decision of 2026-09-11: `react`
itself ships no TypeScript declarations.

| | |
|---|---|
| **Job** | TypeScript type declarations for `react` — every `.tsx` file in `client/src/` type-checks against this |
| **Version** | `19.3.0`, pinned in `client/package-lock.json`, matching the `react` version it declares |
| **Publisher** | DefinitelyTyped / npm `types` account, same as `@types/node` (checked via `npm view @types/react`, 2026-09-16) |
| **Licence** | MIT — compatible with ADR-0004 |
| **Ships or tooling** | **Tooling only.** `devDependencies`. Erased by the compiler, no runtime presence |
| **Install scripts** | None on this package's lockfile entry (checked 2026-09-16) |
| **Native/postinstall code** | None. Pure `.d.ts` declaration files |
| **Determinism** | Not evaluated — no runtime behaviour |

## Its own dependency

Depends on `csstype`, present in `client/package-lock.json` as a transitive package — covered by
this record under the direct/transitive split, same reasoning as `react-dom.md`'s note on
`scheduler`.

## Why not first-party

Same reasoning as `@types/node.md`: DefinitelyTyped is the community's shared, maintained answer,
and `react`'s own maintainers point users at it rather than shipping declarations in the package
itself.

## Advisories

**Checked 2026-09-16**: `npm audit --json` over the whole lockfile — 0 vulnerabilities. Goes stale
immediately.
