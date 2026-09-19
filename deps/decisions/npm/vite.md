# `vite` — recorded 2026-09-16

**Owner-approved** on the stack decision of 2026-09-11 (`CLAUDE.md` "The stack": *"Client: React +
Vite"*; `docs/REBUILD-PLAN.md` "The stack": *"React with Vite, plain CSS"*).

| | |
|---|---|
| **Job** | The dev server and production bundler — `client/vite.config.ts`; `npm run dev`, `npm run build`, `npm run preview` all invoke it |
| **Version** | `8.3.0`, pinned in `client/package-lock.json` |
| **Publisher** | The Vite project — `maintainers`: `yyx990803 <yyx990803@gmail.com>` (Evan You), `vitebot <vite@voidzero.dev>`; `repository.url` = `git+https://github.com/vitejs/vite.git` (checked via `npm view vite`, 2026-09-16) |
| **Licence** | MIT — compatible with ADR-0004 |
| **Ships or tooling** | **Tooling only.** `devDependencies`. Vite's own output (static JS/CSS/HTML) ships; the `vite` package itself runs on the build machine and is not part of the served artifact |
| **Install scripts** | None on `vite`'s own lockfile entry (checked 2026-09-16). Its **optional** platform-specific `@rolldown/binding-*` dependencies (Vite 8 bundles Rolldown) are present in `client/package-lock.json` as `"optional": true` entries for every OS/arch combination; only the one matching this machine installs (`npm ci` here added 50 of the lockfile's 92 packages). None of the ones actually installed carries `hasInstallScript` |
| **Native/postinstall code** | The matching `@rolldown/binding-<platform>` package is a precompiled native binary, not source built locally — no compiler runs on this machine as part of installing it |
| **Determinism** | Not evaluated against ADR-0032's criterion — build tooling, not part of Fathom's canonical data processing |

## Why not first-party

`docs/REBUILD-PLAN.md`: *"The hand-written layout engine"* and the single offline HTML file are
exactly what this rebuild replaces; hand-writing a bundler is a strictly larger version of the same
mistake and not something any part of the corpus proposes.

## Advisories

**Checked 2026-09-16**: `npm audit --json` over the whole lockfile — 0 vulnerabilities. Goes stale
immediately.
