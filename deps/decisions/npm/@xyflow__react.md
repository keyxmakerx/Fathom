# `@xyflow/react` — recorded 2026-09-16

Filename convention: `@scope/name` → `@scope__name.md`, recorded in
`deps/decisions/npm/00-INDEX.md`.

**Approved line.** `CLAUDE.md` "The stack" (loaded before every instruction, dated 2026-09-11):
*"Diagram: React Flow. The interface is rack-first — see `docs/UI-SPEC.md`."* `docs/REBUILD-PLAN.md`
"The stack": *"Diagram — React Flow. Purpose-built for exactly this: draggable boxes, lines between
them, pan and zoom, thousands of nodes. Replaces months of our own code."* Both are the owner's
decision of 2026-09-11 under `docs/REBUILD-PLAN.md`'s heading "Decided. Not reopening without a
reason." — the act ADR-0032 §5 item 2 requires.

| | |
|---|---|
| **Job** | The diagram surface — draggable device/rack nodes, drawn cables between them, pan/zoom. Not imported anywhere yet; wiring it into `client/src/` is Session 4's work, per this task's brief |
| **Version** | `12.11.6`, the latest stable release at install time (`npm view @xyflow/react dist-tags.latest`, 2026-09-16), installed with `npm install --save-exact @xyflow/react@12.11.6 --ignore-scripts` so `client/package.json` and `client/package-lock.json` were both written by the tool, never by hand. `--save-exact` because `docs/REBUILD-PLAN.md`'s version policy takes the latest release rather than a caret range someone has to remember to re-pin; `--ignore-scripts` per the same document's *"Install with scripts disabled... costs nothing and removes the reason the cooldown existed"* |
| **Publisher** | The xyflow project (formerly React Flow) — `maintainers`: `peterkogo <peter.gorzo@posteo.net>`, `webk1d <info@webkid.io>`; `repository.url` = `git+https://github.com/xyflow/xyflow.git` (checked via `npm view @xyflow/react`, 2026-09-16) |
| **Licence** | MIT (`"license": "MIT"` in `client/package-lock.json`) — compatible with ADR-0004 |
| **Ships or tooling** | **Ships.** Added to `dependencies`, not `devDependencies` — this is the diagram runtime itself |
| **Install scripts** | None on `@xyflow/react`'s own lockfile entry, nor on any of the 20 packages its install added — checked by grepping the whole of `client/package-lock.json` for `hasInstallScript` before and after the install, 2026-09-16: the only hit, both before and after, is the pre-existing, optional, macOS-only `fsevents` (a `vite`/`chokidar` file watcher), unrelated to this package |
| **Native/postinstall code** | None. Pure JS/TS; no `@rolldown`-style precompiled binaries in this closure |
| **Determinism** | Not evaluated against ADR-0032's criterion — client-side diagram rendering, outside the canonical graph/schema processing surface that criterion targets |

## Why not first-party

`docs/REBUILD-PLAN.md`, directly: *"The hand-written diagram"* is item 2 of "What we are replacing",
and its own reasoning names the cost this avoids: *"Everything on screen was hand-built. Dragging
boxes, drawing lines, zoom, the diagram layout — all written from scratch. Each one took weeks and
its own round of testing."*

## Its own dependency closure — what `npm install` actually added

`npm ls @xyflow/react` shows one direct dependency in the tree; the full closure, read from
`npm ls --all` and cross-checked against `client/package-lock.json`, is **20 packages**, all new to
the lockfile with this install (`npm install` itself reported *"added 20 packages"*). None carries
a record of its own under this gate's direct/transitive split — `scripts/gate-npm.sh` only requires
a record for what `client/package.json` names directly, mirroring `scripts/gate-zero.sh`'s Cargo
closure reasoning: these 20 arrived because of the one choice recorded here, not as separate choices.
Licences below are each permissive and were read from `client/package-lock.json`'s own `"license"`
field, 2026-09-16 (cross-checked against `npm view <pkg> license` for a sample):

| Package | Version | Licence |
|---|---|---|
| `@xyflow/system` | 0.0.82 | MIT |
| `zustand` | 4.5.7 | MIT |
| `classcat` | 5.0.5 | MIT |
| `use-sync-external-store` | 1.7.0 | MIT |
| `d3-drag` | 3.0.0 | ISC |
| `d3-selection` | 3.0.0 | ISC |
| `d3-zoom` | 3.0.0 | ISC |
| `d3-color` | 3.1.0 | ISC |
| `d3-dispatch` | 3.0.1 | ISC |
| `d3-interpolate` | 3.0.1 | ISC |
| `d3-timer` | 3.0.1 | ISC |
| `d3-transition` | 3.0.1 | ISC |
| `d3-ease` | 3.0.1 | BSD-3-Clause |
| `@types/d3-drag` | 3.0.7 | MIT |
| `@types/d3-selection` | 3.0.12 | MIT |
| `@types/d3-zoom` | 3.0.8 | MIT |
| `@types/d3-color` | 3.1.3 | MIT |
| `@types/d3-interpolate` | 3.0.4 | MIT |
| `@types/d3-transition` | 3.0.9 | MIT |

(19 rows — `@xyflow/react` itself is the 20th package the install added.) ISC and BSD-3-Clause are
both permissive and, like the MIT rows, raise no conflict with ADR-0004's Apache-2.0 core/UI/CLI
split; nothing copyleft entered the graph.

`react` and `react-dom` are `peerDependencies`, marked optional together with `@types/react` and
`@types/react-dom` in `@xyflow/react`'s own manifest — already recorded in this directory, already
present, no new entry.

## Advisories

**Checked 2026-09-16**, after the install: `npm audit --json` over the whole lockfile (112 packages:
27 prod, 86 dev, 47 optional) — 0 vulnerabilities at every severity. Before the install the same
command reported 92 packages (4 prod, 89 dev, 47 optional), also 0 vulnerabilities — recorded in
`deps/decisions/npm/00-INDEX.md`. A result at this date, not a standing guarantee; it goes stale
immediately, same caveat every record in this directory carries.

## Not yet imported

Per this task's brief: *"Do not import it anywhere yet; Session 4 does."* Nothing under `client/src/`
references `@xyflow/react`. This record exists so the gate would have refused it without one, ahead
of that import.
