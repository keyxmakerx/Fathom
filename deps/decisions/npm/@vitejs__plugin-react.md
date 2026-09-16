# `@vitejs/plugin-react` — recorded 2026-09-16

Filename convention: `@scope/name` → `@scope__name.md` (two underscores in place of the slash),
recorded in `deps/decisions/npm/00-INDEX.md`.

**Owner-approved** as part of the React + Vite stack decision of 2026-09-11 — this is the plugin
that makes Vite understand JSX/TSX and React Fast Refresh, without which Vite cannot build a React
client at all.

| | |
|---|---|
| **Job** | Vite plugin: JSX/TSX transform and React Fast Refresh during `npm run dev` and `npm run build` — configured in `client/vite.config.ts` |
| **Version** | `6.1.1`, pinned in `client/package-lock.json` |
| **Publisher** | The Vite project — same publisher as `vite` itself: `maintainers`: `yyx990803`, `vitebot <vite@voidzero.dev>`; `repository.url` = `git+https://github.com/vitejs/vite-plugin-react.git` (checked via `npm view @vitejs/plugin-react`, 2026-09-16) |
| **Licence** | MIT — compatible with ADR-0004 |
| **Ships or tooling** | **Tooling only.** `devDependencies`. Runs inside the Vite build; its own code never reaches the served artifact |
| **Install scripts** | None on this package's lockfile entry (checked 2026-09-16) |
| **Native/postinstall code** | None of its own. Depends on `@rolldown/pluginutils`, recorded under `vite.md`'s closure discussion |
| **Determinism** | Not evaluated against ADR-0032's criterion — build tooling |

## Why not first-party

A first-party JSX transform is precisely what the retired hand-written render layer avoided needing
and this rebuild deliberately does not repeat; Vite's plugin API is the documented extension point
for exactly this job.

## Advisories

**Checked 2026-09-16**: `npm audit --json` over the whole lockfile — 0 vulnerabilities. Goes stale
immediately.
