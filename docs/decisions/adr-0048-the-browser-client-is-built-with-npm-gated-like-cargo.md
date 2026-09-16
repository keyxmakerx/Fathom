# ADR-0048 — The browser client is built with npm, gated like Cargo

**Status:** Accepted, 2026-09-16 — recording a decision the owner made on 2026-09-11 that two
earlier records still contradict.
**Owner direction, 2026-09-11** (`docs/REBUILD-PLAN.md`, `CLAUDE.md` "The stack"): React and Vite for
the client, React Flow for the diagram, latest stable of each.
**Amends:** ADR-0019 (*"no npm in any artifact-producing stage"*) and ADR-0032 §3's cap *"C6 = 0
npm"*. Both stay accepted for what they still govern: no npm package touches the Rust build or any
artifact the server produces. What they no longer govern is the browser client, which since
2026-09-11 is an npm build by decision.

---

## 1. What was true, and what changed

ADR-0019 chose a first-party render layer and no npm anywhere, for a client the Rust server
assembled as HTML. That client was retired in August 2026 (`docs/REBUILD-PLAN.md`). The rebuilt
client is React under Vite, which is an npm build by definition, and React Flow is its diagram.
The owner decided that on 2026-09-11; the records were not updated, and on 2026-09-16 the
dependency work found `react`, `react-dom`, `vite`, `typescript` and `vitest` installed with no
approval record and no gate reading `package-lock.json` at all — the strongest security fact in the
repository (every third-party package recorded, ADR-0032) did not apply to the half of the product
that runs in people's browsers.

## 2. The decision

1. **The browser client is an npm build.** ADR-0019's ban and ADR-0032's `C6 = 0` are amended to
   read: *no npm package in any stage that produces a server artifact or touches `crates/`*. The
   client's `dist/` is a browser artifact and is out of their scope.
2. **The same regime applies to it.** `scripts/gate-npm.sh` refuses any direct package in
   `client/package.json` without a record at `deps/decisions/npm/<name>.md` (scoped packages as
   `@scope__name.md`), and refuses any package in `client/package-lock.json` not resolved from the
   npm registry or lacking an integrity hash. It runs in CI beside `gate-zero`, has its own tests,
   and is in `CLAUDE.md`'s gate list. A record's audit line comes from `npm audit` on a named date
   or reads *could not establish*; nothing in a record is from memory.
3. **What the Rust regime has that npm does not.** There is no `cargo-vet` equivalent: records
   attest to registry metadata — publisher, licence, install scripts — not to a human having read
   the source. The records say so per package rather than implying otherwise. The seven-day
   cooldown does not apply, by the owner's version policy of 2026-09-11; `--ignore-scripts` and an
   exact pin do.
4. **React Flow** (`@xyflow/react`) is installed under this record, pinned exactly, with its
   twenty-package closure listed in `deps/decisions/npm/@xyflow__react.md`. Nothing imports it until
   Session 4 builds the rack.

## 3. Why record it now rather than later

Two accepted records contradicting a third decision is how a rule stops binding without anyone
choosing that. The gate would have refused React Flow; without this record, a reader of ADR-0019
would have been right to refuse React.
