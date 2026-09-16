# `react` — recorded 2026-09-16

**Owner-approved** on the stack decision of 2026-09-11 (`CLAUDE.md` "The stack": *"Client: React +
Vite, plain CSS"*; `docs/REBUILD-PLAN.md` "The stack": *"Screen — React with Vite... Checked
September 2026: no framework is being abandoned or rewritten, nothing new has broken through, and
React is the least likely of any option to disappear."*). This record exists because ADR-0032 §5's
per-package approval was written down for `Cargo.lock` and never extended to `package.json`; this
fills that gap for a package already in the tree, not a newly proposed one.

| | |
|---|---|
| **Job** | The client's UI component model — every screen in `client/src/` is a tree of React components |
| **Version** | `19.3.0`, pinned in `client/package-lock.json` |
| **Publisher** | Meta — `maintainers` on the npm registry: `fb <opensource+npm@fb.com>`, `react-bot <react-core@meta.com>`; `repository.url` = `git+https://github.com/react/react.git` (checked via `npm view react`, 2026-09-16) |
| **Licence** | MIT (`"license": "MIT"` in `client/package-lock.json`) — compatible with ADR-0004's Apache-2.0 core/UI/CLI split |
| **Ships or tooling** | **Ships.** `dependencies`, not `devDependencies` — bundled into the built client |
| **Install scripts** | None. No `hasInstallScript` flag on this package's lockfile entry — checked by grepping `client/package-lock.json`, 2026-09-16. (The npm equivalent of ADR-0032 §5's `build.rs` question: whether installing the package runs arbitrary code on the build machine. It does not, here.) |
| **Native/postinstall code** | None |
| **Determinism** | Not evaluated against ADR-0032's determinism criterion — that criterion targets crates affecting Fathom's canonical graph/schema processing (e.g. hash-map iteration order). `react` is client-side UI rendering, outside that surface. Noted for the record's shape, not because a finding was made |

## Why not first-party

`docs/REBUILD-PLAN.md`: *"Rust-for-the-screen was considered and rejected — there is no mature
diagram tool for it, so we would hand-build the canvas again, which is the mistake we are
correcting."* Writing a component/render layer in-house is exactly the retired-August-2026
architecture this rebuild replaces (`CLAUDE.md`: *"the browser side still carries an architecture
retired in August 2026 and is being replaced"*).

## Advisories

**Checked 2026-09-16**: `cd client && npm audit --json` over the whole lockfile (92 packages: 4
prod, 89 dev, 47 optional) reported 0 vulnerabilities at every severity (info through critical). A
result at that date, not a standing guarantee — it goes stale immediately, same caveat every Rust
record here carries.

## Version policy

`docs/REBUILD-PLAN.md` "Version policy", owner decision 2026-09-11: web packages take the latest
stable release rather than the Rust workspace's seven-day cooldown, because nothing is in production
and no customer data exists yet. `19.3.0` is whatever `npm install` resolved against that policy on
the date the client was scaffolded, read from `client/package-lock.json`, not chosen here.
