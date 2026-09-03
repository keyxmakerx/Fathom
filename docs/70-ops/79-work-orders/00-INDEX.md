# 00 — The work-order queue

> **Status:** Living — planning-maintained; execution sessions edit only status cells (`78` §3
> step 8, §8).

**The fragment-to-store weld now exists as a row: WO-09**, authored 2026-08-08, closing `88` §5.3.
It is deliberately smaller than that finding described. It carries provenance records, ULID minting
and the containment materialisation (WO-03 §4.8, WO-04 §10 item 7(a)); it does **not** carry
reconciliation, because `schema/schema.yaml` declares `identity: []` for `Device` and nothing in the
workspace evaluates an identity tuple — that gap is WO-09 §10 item 1, and the `Device` identity
sentence it needs is the sibling of the owner-blocked `Site` one (`88` §6.13). **WO-04's G8 still
does not arm when WO-09 lands**: WO-09 §10 item 2 records a third precondition alongside WO-04 §10
item 7's two — WO-04 §4.9's golden references `reth0.0` and `st0.0` but declares no interface, so
both references stay `Pending` under `14` §7.3. The plan carries the weld in §18.

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
because it retires the ships-to-the-browser risk with no dependency on it. WO-09 sits last because
it was authored last.

**WO-05 ran on 2026-08-08 and is DONE.** Both of its escalations had been answered by planning
earlier the same day; the executing session was a different one (`78` §5 item 10). Its §4.4 pinned
vector matched the constructed bytes exactly, so trigger 3 did not fire, and nothing new was
escalated.

**WO-09 ran twice on 2026-08-08 and is BLOCKED at plan step 9.** The first run stopped at plan
step 1: `Origin::Parsed` could not be added while `fathom-workspace` serialised `Origin` as a bare
JSON string with a reader on the other side. That was filed as WO-09 §10 item 8 and answered the
same day by `17` §15.6, and the second run **executed it** — `Origin::Parsed`, `CaptureId`,
`CaptureSpan`, both `fathom-workspace` match sites, `Dictionary::entry_id`, and the whole
`fathom-weld` crate through `apply_new_device`, with G5 green and §3's containment-uniqueness fact
re-proved from the generated tables.

It then stopped on something older than either order: **`corpus/dict/junos-srx/interfaces.yaml`
binds `InterfaceLike.name` as `Identifier` while `schema/schema.yaml` declares it `InterfaceName`**,
so the first code to put ingest and the store in one call refuses the shipped fixture. Nothing in
the tree compares a dictionary `scalar:` against the declared field type, so this survived WO-03's
gate set and the whole floor. Filed as WO-09 §10 item 9 and `73` §14, with four mechanically
enumerable resolutions and no lean; §4.6's four remaining test files are unwritten and the fixture
gate is unmet. **The queue again has no runnable row:** WO-04 stays BLOCKED on WO-09 and WO-09 is
BLOCKED on planning.

**WO-09 ran a third time on 2026-08-08.** §10 item 9's answer was executed exactly — one `scalar:`
value in `corpus/dict/junos-srx/interfaces.yaml:13`, one `ValueTy` arm, one `BoundValue` variant —
and the shipped fixture now applies. `tests/apply.rs` came back with §4.6's nine names and passes,
joined by `tests/provenance.rs` (six) and `tests/determinism.rs` (one): 353 tests, zero failures,
zero ignored.

It stopped on the last of §4.6's five files. **Ten of the fixture's thirteen fragment nodes carry
`owner: None`, and none of the three that carry one is owned by `nodes[0]`**, so the applied
`Device` has degree zero across all 81 edge kinds and §4.6's *"the `IpsecVpn` closure is reachable
from the device by `out`/`inn`"* cannot hold. WO-03 §4.8 promises only that an `owner` points
earlier, never that every non-root node has one; WO-09 §4.5 step 5 presumes it does. Filed as WO-09
§10 item 10 and `73` §14 with four resolutions and no lean. `11` §7.2's *"exactly one containment
in-edge per node"* is an L1/L2 lower bound, so the store accepts the graph and the floor is green —
which is why nothing caught it. **The queue again has no runnable row.**

**WO-09 ran a fourth time on 2026-08-08 and is DONE.** §10 item 10's answer was executed as written:
an ownerless non-root `FragNode` takes the containment parent the **schema** determines for its
kind, and the weld refuses with `NoContainmentEdge` if the schema ever stops determining exactly
one. The applied device is no longer degree zero — the fixture's thirteen nodes and nineteen edges
are one connected estate rooted at it, and `tests/fixture.rs` walks `out`/`inn` over all 81 edge
kinds to prove nothing sits outside that walk. §4.6's five test files all exist; the crate carries
24 tests and the floor is **354 passed / 0 failed / 0 ignored**, with the two pinned `Site` warnings
unmoved. Every §6 gate G1–G9 is green.

One correction rides with it, under `78` §8: the answer's *"no kind has more than one possible
containment parent — not one"* is wrong for three kinds (`LogicalUnit`, `ExternalPeer`,
`PhysicalPort`) and seven have none at all. The decision it made is unaffected, because its own
guard refuses exactly those cases and none is reachable from the shipped dictionary; WO-09 §12 item
15 carries the computation. **Nothing new was escalated.** Reconciliation stays unbuilt and
owner-blocked on the `Device` identity sentence (WO-09 §10 item 1), and WO-04's G8 stays unarmed on
its own three preconditions.

**WO-04 was re-taken on 2026-08-08 to test whether WO-09's landing had armed G8. It had not, and
WO-04 stays BLOCKED.** The session re-ran WO-04 §5 step 12's three preconditions against the
documents on disk: (a) holds, (b) failed **at the time that paragraph was written (2026-08-08, commit `9c58255`)** — no weld order was DONE, and no `fathom-weld` crate or
`apply_new_device` exists in the tree — and (c) fails, because WO-04 §10 item 7(b), the source of
`IpsecVpn.mode` in a re-parsed graph, is still undecided. WO-04's gates G1–G7 and G9 were all
re-run green; only G8 is outstanding, and it is outstanding on three planning decisions, not on
code. Nothing new was escalated: the questions are already filed (WO-09 §10 items 2, 5 and 8, the
last of them in `73` §14). The tree is unchanged apart from the two status records.

**That paragraph is history, not the present tense.** `crates/fathom-weld` and `apply_new_device` have existed since `fa72d80`; `cargo build --workspace` compiles them and 354 tests pass. Left in place with this note rather than rewritten, because it records why WO-04 was correctly left BLOCKED on the day it was re-taken.

**WO-04 was taken again on 2026-08-08, after WO-09 reached DONE, and stays BLOCKED — but on
nothing this queue can build.** Step 12's precondition (b) now **holds**: WO-09 is DONE and
`crates/fathom-weld/src/apply.rs:100` is `pub fn apply_new_device`. (c) fails, on one question
only — the source of `IpsecVpn.mode` in a re-parsed graph (WO-04 §10 item 7(b)); no dictionary
entry in `corpus/dict/junos-srx/` binds that field, and no planning document decides the
mechanism. The third precondition — WO-04 §4.9's golden naming `reth0.0` and `st0.0` while
declaring no interface (WO-09 §10 item 2) — is unresolved too, and the shipped weld now proves it
from code: `apply.rs:221` carries `Pending` references out as `Unresolved` and writes no edge.
G1–G7 and G9 were re-run green on the post-WO-09 tree (354 passed / 0 failed / 0 ignored; the two
pinned `Site` warnings unmoved); only G8 is outstanding, and **it is outstanding on two planning
decisions, not on a dependency**. Nothing new was escalated: both questions are already filed.
Detail in WO-04 §12 item 12.

| # | Work order | File | Status | Depends | Deliverable |
|---|---|---|---|---|---|
| 1 | WO-06 | `WO-06-finder-completion.md` | DONE | — | The four recorded finder MINORs closed (doc/test/prose only); every deferred `16` section mapped blocked with its blocker named |
| 2 | WO-01 | `WO-01-the-scalar-trait.md` | DONE | — | The `Scalar` trait and the real scalar implementations in `fathom-ir`, retiring the stub caveat |
| 3 | WO-02 | `WO-02-the-graph-store.md` | DONE | — | `fathom-graph`: the typed store — L0 write-time enforcement, three-state presence, provenance, batch-grouped op log, deterministic iteration |
| 4 | WO-07 | `WO-07-the-wasm-shell.md` | DONE | — | `fathom-wasm`: the finder compiled to `wasm32-unknown-unknown` behind `41` §3.7's raw ABI, with import/export/size/determinism audits |
| 5 | WO-03 | `WO-03-ingest-junos-srx.md` | DONE | WO-01, WO-02 | junos-srx set-form ingest: framer, lexer, shaper, the non-optional redaction gate, the statement dictionary, a typed fragment with its residue ledger |
| 6 | WO-04 | `WO-04-the-emitters.md` | **OPEN** — the last blocker was answered by the owner on 2026-08-09 (`70` §16.1–§16.2): an incompletely-known path is emitted and *marked*, never refused. What remains is code, not a decision | WO-01, WO-02 | `fathom-emit`: graph to junos-srx set-statements with per-line provenance; every gate but G8 green. **Read its §5 step 12 before starting** — the round-trip gate's criterion needs restating now that emit is not refusing, and that restatement is the order's first act |
| 7 | WO-05 | `WO-05-the-workspace-file.md` | DONE | WO-02 | `fathom-canon` and the plaintext workspace face: canonical serialisation, versioned header, byte-identical round trip; sealing stays owner-gated (its §2) |
| 8 | WO-08 | `WO-08-the-inventory-face.md` | DONE | WO-01, WO-02, WO-07 | The first product face: browser artifact, inventory table, inspector, per-equipment page with cabled-peer navigation over a pinned demo estate |
| 9 | WO-09 | `WO-09-the-fragment-to-store-weld.md` | DONE | WO-02, WO-03 | `fathom-weld`: one ingest fragment applied onto the store as a **new** device — minted ULIDs, containment edges from `owner`, `Origin::Parsed` provenance, `Device.platform` stamped, pending references carried unmaterialised, one batch. Reconciliation escalated, not built |
| 10 | WO-10 | `WO-10-dhcp-relay-and-bootp.md` | **DONE — 2026-08-29.** Stopped at Step 0 on 2026-08-28 (the `routing-instance` qualifier, §10 item 3 fired as written); the owner chose a real `RoutingInstance` edge (route i, `70` §18.5); executed the same day, schema 0.4 → 0.5, all seven gates green, +1,206 module bytes measured. Its own §10 item 5 fired at execution and is ESCALATED: the qualifier is a pending reference and pending references do not survive a reload — planning's, not the queue's | — | `DhcpRelay` as a kind, `HasDhcpRelay` and `RelaysFor` as edges, and `corpus/dict/junos-srx/forwarding-options.yaml` binding both the `helpers bootp` and the `dhcp-relay` forms — the first feature the owner asked for by name that the ceiling refused, now waiting on one further modelling decision instead |
| 11 | WO-11 | `WO-11-the-server-skeleton-and-the-dependency-gate.md` | **OPEN — unblocked 2026-09-03.** Authored blocked on an undelegatable owner act (~109 crate approvals); the owner lifted that constraint the same day and asked for automated checking instead, so §5 step 0 is now a five-layer gate design built from a dated survey. Its central finding decides the order's shape: **no scanner would have caught the August 2026 crates.io attack** — the poisoned releases were deleted before an advisory existed, so every advisory-keyed tool returns clean; what catches it is `--locked` plus a human reading the lockfile diff. Still stores NOTHING (ADR-0040's key boundary is undecided) | — | `fathom-server`: a health-checking binary on PostgreSQL, plus `cargo deny` with a source allowlist, `cargo audit`, a version cooldown and the lockfile-diff rule — three of them proved by watching them fail |

**Owner-blocking items** (not queue rows; listed in `CLAUDE.md`): the S0 fixture exports
(`76` §7.3), the four `19` §10 forks, the named expert review of `corpus/`. WO-03 §10.8–10.9
and WO-06's deferred-section map name where each bites.

**One owner-blocking item added 2026-08-08, on no list before now: the `Device` identity rule.**
`schema/schema.yaml` declares `identity: []` for `Device` with the note *"no identity tuple stated
in 11 §10.3 for Device"*. `11` §10.4 step 1 scopes every re-identification match by
`owner_device(n) = D`, so without that tuple no re-parse can ever update rather than duplicate.
It is the same one-sentence answer `88` §6.13 asks for on `Site`, and it blocks the reconciliation
order that WO-09 §10 item 1 leaves unwritten.
