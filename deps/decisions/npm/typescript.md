# `typescript` — recorded 2026-09-16

**Owner-approved** on the stack decision of 2026-09-11 (`CLAUDE.md` "The stack"; `docs/REBUILD-PLAN.md`
"The stack": *"React with Vite"* implies a TypeScript client — `client/tsconfig.json` and the
`.tsx`/`.ts` sources already in `client/src/` confirm the language choice, and this is the compiler
that checks and, per `client/package.json`'s `build` script, emits it).

| | |
|---|---|
| **Job** | Type checking (`npm run typecheck` → `tsc -b --noEmit`) and, in the production build (`npm run build` → `tsc -b && vite build`), project-reference compilation ahead of Vite's bundling |
| **Version** | `7.0.2`, pinned in `client/package-lock.json` |
| **Publisher** | Microsoft — `maintainers` includes `microsoft1es <npmjs@microsoft.com>`, `typescript-bot <typescript@microsoft.com>`; `repository.url` = `git+https://github.com/microsoft/TypeScript.git` (checked via `npm view typescript`, 2026-09-16) |
| **Licence** | Apache-2.0 (`"license": "Apache-2.0"` in `client/package-lock.json`) — same licence family as Fathom's own core/UI/CLI (ADR-0004) |
| **Ships or tooling** | **Tooling only.** `devDependencies`. Its output is plain JS; the compiler itself never reaches a browser |
| **Install scripts** | None on this package's lockfile entry (checked 2026-09-16) |
| **Native/postinstall code** | None. `tsc` is pure JS |
| **Determinism** | Not evaluated against ADR-0032's criterion — build tooling, not part of Fathom's canonical data processing |

## Why not first-party

Writing a TypeScript compiler is not a serious option for this project; every alternative the
corpus ever considered for type-checked client code assumes a standard compiler exists.

## Advisories

**Checked 2026-09-16**: `npm audit --json` over the whole lockfile — 0 vulnerabilities. Goes stale
immediately.
