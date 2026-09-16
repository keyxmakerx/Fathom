# `react-dom` — recorded 2026-09-16

**Owner-approved** on the same basis as `deps/decisions/npm/react.md`: the stack decision of
2026-09-11 (`CLAUDE.md` "The stack"; `docs/REBUILD-PLAN.md` "The stack").

| | |
|---|---|
| **Job** | Renders React's component tree to the browser DOM. `react` alone describes UI; `react-dom` is what puts it on screen — `client/src/main.tsx` calls `createRoot` from this package |
| **Version** | `19.3.0`, pinned in `client/package-lock.json` |
| **Publisher** | Meta — same publisher and repository as `react` (`npm view react-dom repository.url` = `git+https://github.com/react/react.git`, checked 2026-09-16) |
| **Licence** | MIT — compatible with ADR-0004 |
| **Ships or tooling** | **Ships.** `dependencies`, bundled into the built client |
| **Install scripts** | None (checked the same way as `react.md`, 2026-09-16) |
| **Native/postinstall code** | None |
| **Determinism** | Not evaluated — same reasoning as `react.md`; outside the surface the criterion targets |

## Why not first-party

Same reasoning as `react.md`: a hand-written DOM renderer is the retired architecture this rebuild
replaces, and `react` is not usable in a browser without a matching renderer.

## Its own dependency

`react-dom@19.3.0` depends on `scheduler@^0.28.0`, present in `client/package-lock.json` as a
transitive package — covered by this record under the direct/transitive split `scripts/gate-npm.sh`
uses (mirroring `scripts/gate-zero.sh`'s Cargo closure reasoning): a package only the lockfile names,
arriving solely because of a choice already recorded, needs no record of its own.

## Advisories

**Checked 2026-09-16**: same `npm audit --json` run as `react.md` — 0 vulnerabilities across the
whole lockfile, this package included. Goes stale immediately.
