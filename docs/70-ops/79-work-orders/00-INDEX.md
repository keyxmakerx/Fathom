# 00 — The work-order queue

> **Status:** Living — planning-maintained; execution sessions edit only status cells (`78` §3
> step 8, §8).

**One order in the critical path does not exist yet: the fragment-to-store weld.** WO-03 produces
a typed fragment and nothing can load it into the graph; WO-04's round-trip gate G8 — the proof
Fathom can read a config and write it back — cannot arm until the weld lands. It carries provenance
records, ULID minting and reconciliation (WO-03 §4.8, WO-04 §10 item 7(a)), and it is **not** a row
below because authoring it is planning work that has not been done. Named here so it stops being
invisible (`88` §5.3); the plan carries it in §18.

**The long-term plan is `00-PROGRAM-PLAN.md`, beside this file.** It sequences the whole product
into eleven stages, names the work orders that do not exist yet, and collects every owner decision
the build waits on into one tier-ordered list. This queue stays the operational truth: where the
plan and this table disagree about what is next, **this table wins** and the plan is corrected.

The queue `78` §8 defines: one row per work order, in queue order. The order refines `76` §7.2's
build order under `76` §7.1's principle — *"retire the cheapest expensive risk first"* — and
re-cutting it is planning work. Every session starts at `78` §3's loop: take the **topmost OPEN
row whose Depends column is all DONE**.

**Status semantics.** Each work order's own status line is the truth; this table mirrors it, and
on divergence the status line wins (`78` §8). `BLOCKED on WO-nn` and `OPEN` with unmet
dependencies behave identically under the loop — neither qualifies until the named orders are
DONE. When a session completes the last dependency of a `BLOCKED on WO-nn` row, that status line
has become stale as a matter of checkable fact: the finishing session flips it to `OPEN` (file
and row) in the same PR, as a `78` §8 factual correction. `BLOCKED` on an owner item is never
flipped by a session.

**Queue order, in one line each:** WO-06 leads because the first execution session should
exercise the whole `78` §3 loop on the order whose blast radius is prose and pinned tests;
WO-01/WO-02 are the unblockers everything downstream names; WO-07 precedes the ingest line
because it retires the ships-to-the-browser risk with no dependency on it.

| # | Work order | File | Status | Depends | Deliverable |
|---|---|---|---|---|---|
| 1 | WO-06 | `WO-06-finder-completion.md` | BLOCKED on `73` §14's form (E-01) | — | The four recorded finder MINORs closed (doc/test/prose only); every deferred `16` section mapped blocked with its blocker named |
| 2 | WO-01 | `WO-01-the-scalar-trait.md` | OPEN | — | The `Scalar` trait and the real scalar implementations in `fathom-ir`, retiring the stub caveat |
| 3 | WO-02 | `WO-02-the-graph-store.md` | OPEN | — | `fathom-graph`: the typed store — L0 write-time enforcement, three-state presence, provenance, batch-grouped op log, deterministic iteration |
| 4 | WO-07 | `WO-07-the-wasm-shell.md` | OPEN | — | `fathom-wasm`: the finder compiled to `wasm32-unknown-unknown` behind `41` §3.7's raw ABI, with import/export/size/determinism audits |
| 5 | WO-03 | `WO-03-ingest-junos-srx.md` | BLOCKED on WO-01, WO-02 | WO-01, WO-02 | junos-srx set-form ingest: framer, lexer, shaper, the non-optional redaction gate, the statement dictionary, a typed fragment with its residue ledger |
| 6 | WO-04 | `WO-04-the-emitters.md` | OPEN | WO-01, WO-02 | `fathom-emit`: graph to junos-srx set-statements with per-line provenance; the round-trip gate arms only once WO-03 and the weld order land (its §5 steps 12–13) |
| 7 | WO-05 | `WO-05-the-workspace-file.md` | BLOCKED on WO-02 | WO-02 | `fathom-canon` and the plaintext workspace face: canonical serialisation, versioned header, byte-identical round trip; sealing stays owner-gated (its §2) |
| 8 | WO-08 | `WO-08-the-inventory-face.md` | BLOCKED on WO-01, WO-02, WO-07 | WO-01, WO-02, WO-07 | The first product face: browser artifact, inventory table, inspector, per-equipment page with cabled-peer navigation over a pinned demo estate |

**Owner-blocking items** (not queue rows; listed in `CLAUDE.md`): the S0 fixture exports
(`76` §7.3), the four `19` §10 forks, the named expert review of `corpus/`. WO-03 §10.8–10.9
and WO-06's deferred-section map name where each bites.
