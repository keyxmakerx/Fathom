# Fathom — session pickup

One page for a fresh session. `README.md` has the full map; this is the state, the rules,
and the next actions.

## What this is

A security-first, client-side network tool: one typed graph, six views over it, teaching
and estate-of-record as co-equal goals. **It never connects to anything** — no device
access, no credentials, no telemetry, permanently (invariants 1–3,
`.context/conventions.md`; every future exception is priced in
`docs/30-security/38-the-egress-question.md` and none is approved).

## Which kind of session is this?

`docs/70-ops/78-execution-protocol.md` defines three roles. **If you are here to build,
you are an execution session**: read `78` in full, open
`docs/70-ops/79-work-orders/00-INDEX.md`, take the topmost OPEN order whose dependencies
are DONE, and execute it exactly — escalating instead of deciding anything the order
leaves open. Planning sessions (authoring orders, ADRs, schema design) and the owner's
items are listed in `78` §7; when in doubt, `78` §7's test decides.

## State (as of the plan-layer merge)

- **Specification: complete.** The foundational corpus (docs 00–74, ADRs 0001–0030) plus
  the post-redefinition set: `77` (owner requirements verbatim) → `76` (analysis + build
  order) → `19` (the IR extension) → `62` (the schema grammar).
- **Schema: instantiated and gated.** `schema/` is real (48 kinds / 89 edges / 61
  scalars); `crates/fathom-schema` parses and checks it; `cargo test` pins zero failures.
- **Design: decided and demonstrated.** `design/prototype/fathom-app.html` is the whole
  product as one interactive file — the fidelity bar for anything built.
- **Code: the schema toolchain and the finder core are complete** (`fathom-id`,
  `fathom-schema`, `fathom-schemagen`, `fathom-ir` with checked-in generated types,
  `fathom-corpus`, `fathom-find`). **As of 2026-08-08 the queue has run: six more crates exist** —
  `fathom-graph` (the typed store), `fathom-ingest` (junos-srx set-form, with the redaction gate),
  `fathom-emit`, `fathom-wasm`, `fathom-inventory`, `fathom-artifact`. **396 tests, zero external
  dependencies.** **Eight of nine work orders DONE** — WO-01, WO-02, WO-03, WO-05, WO-06, WO-07,
  WO-08 and WO-09 (the fragment-to-store weld, which now exists as `fathom-weld`). **WO-04 is the
  only one open, and as of 2026-08-09 it is OPEN rather than BLOCKED** — both its blockers are
  answered (`IpsecVpn.mode` by looking Junos up; the `reth0.0` golden by the owner, `70` §16.1).
  What remains is code.
- **The product has been opened in a browser, and it now has an input.** WO-08's sixteen manual
  rows are recorded **RUN 2026-08-08 — ALL SIXTEEN PASS** in that order's G10 block, with method
  and limits. On 2026-08-09 the **on-ramp** landed, outside the queue and at the owner's direction:
  `OP_PASTE` (`fathom-wasm`) carries pasted text plus the host's clock and entropy into
  `fathom-ingest` and `fathom-weld` and replaces the held estate, and `fathom-dev.src.html` has a
  paste sheet that renders what was understood *and every line that was not*. Driven in Chromium
  against a 26-line SRX config: 15 nodes, 23 edges, 5 residue lines named, 1 pre-shared key
  destroyed, one network request (the file). Evidence: `docs/80-review/evidence/2026-08-09-*.png`;
  the plain-English account is `overnight-report.md`. **The module is 827,029 bytes against `44` §5.2's
  900,000-byte ceiling** (re-measured 2026-08-11) — 72,971 bytes of headroom, and persistence alone
  was *measured* at +239,964. See `79-work-orders/00-ROUTE-TO-WORKABLE.md` §2 stage 1: the ceiling is an
  architecture question, not a number to raise.
- **The plan layer is live.** `78` (the execution protocol), `79-work-orders/` (eight
  orders, adversarially verified), and CI (`.github/workflows/ci.yml`) enforcing the
  verification floor on every PR.
- **Reviewed, and the owner has answered.** `88` records the state review (five blockers,
  eleven majors, thirteen minors; two blockers closed in the same PR). `70` records the
  owner's answers verbatim and their standing priority order — **security, then usability
  for both user and maintainer, then dynamic ability**. Three records are drafted from those
  answers and await ratification: ADR-0031 (all features ship; phases retired), ADR-0032
  (third-party code permitted, gated and vendored), ADR-0033 (motion must carry meaning).
  `70` §6 names the largest requirement in the corpus with no mechanism behind it: automatic
  correlation across separately-pasted configs. `70` §7 settles the platform question — Juniper is
  primary (SRX/MX/EX), with Nexus, PAN-OS and Meraki; five of the six are already registered in
  `schema/platforms.yaml`, and only `junos-srx` has any content behind it. `70` §8 finds the
  owner's load-balancing and Docker-storage requirement compatible with invariant 4: the server
  stores ciphertext it cannot read, which is what `33` and `43` D2/D3 already specify. `70` §9
  records that there is **no thin first release** — most features work before anything ships.

## Rules that bind every session

0. **ADR-0034 (2026-08-08) is law and it binds this session:** a security claim is **never**
   answered from memory. Look it up, name the source *and the date*, two independent databases for
   a clean result, and *"I could not establish this"* outranks a confident guess. Carried in
   `.context/conventions.md` § *Currency*. The ADR broke this rule in its own text on day one and
   `70` §7.6 records how — read that before assuming you are exempt.
1. Read `.context/conventions.md` before writing anything — the ten invariants and the
   vocabulary are binding, and the risk enum (three values, reserved colours) is never
   extended or reused. **Re-read it if you last read it before 2026-08-08:** ADR-0002 was
   executed into it and five invariants changed text, including invariant 3, which now reads
   *"stores no device credential"* and carries the ingest-gate redaction that *"never accepts
   a credential"* wrongly implied did not exist. Precedence and the residual scale are new
   sections; `docs/00-vision/01-ownership.md` is the register they point at.
2. `docs/90-decisions/` ADRs are binding once Accepted — but reopenable **on merit**:
   the owner has instructed that sunk cost never argues for keeping a decision (`75` §2).
   Real-time collaboration must never be foreclosed by new state (`75` §2.4). Reopening
   is owner/planning work, never an execution session's (`78` §5).
3. A field that is not in `schema/` does not exist (ADR-0008). Extend the schema via
   `62`'s grammar; `cargo test` must stay green.
4. House style for documents: status line, contents table, numbered sections, Failure
   modes / Open decisions / Sources consulted / Disagreements. Never invent a number or a
   citation; mark the unproven with `<!-- VERIFY: ... -->`.
5. The capability register (`75`) records intent without deciding. Adding to it is cheap;
   deciding in it is a defect.

## Next actions

- **Read `docs/70-ops/79-work-orders/00-ROUTE-TO-WORKABLE.md` first** (Proposed, 2026-08-10). It is
  the measured route: where the product actually is (**1 of 6 views live; 3 inventory kinds against
  the 9 a paste builds; zero lines of rule engine; zero lines of diagram; 42 Junos statements**),
  nine stages in dependency order, and §4's split between what genuinely needs the owner and what
  merely says it does. Written from six independent surveys each adversarially verified, so its
  numbers are measurements rather than estimates. **It disagrees with the program plan in three
  named places** (§5) — notably that persistence is hours-behind-a-decision, not unblocked days.
- **`00-PROGRAM-PLAN.md`** (Proposed) remains the long-term shape: eleven stages, the unwritten work
  orders, and the tier-ordered owner list. Its tier 1 is **overstated by 4×** — four of its five
  are already on disk. The queue below stays the operational truth; on disagreement the queue wins.
- **Engineering:** the queue. `docs/70-ops/79-work-orders/00-INDEX.md` — WO-06 (finder
  completion, the shakedown order) leads; WO-01 (the `Scalar` trait) and WO-02 (the graph
  store) unblock everything downstream. Every order carries its own plan, gates, and
  stop-and-escalate list; `78` governs.
- **Raised by the on-ramp (2026-08-09), neither queued nor decided:** (a) the module is 812 KB
  against `44` §5.2's 900 KB ceiling — decide before the second platform's dictionary lands whether
  the ceiling moves or the dictionary is handed in by the page instead of compiled in
  (`fathom_ingest::dict::EMBEDDED_DICT_SOURCES`); (b) `OP_PASTE` replaces the held estate, because
  merging a second paste is `70` §6's unbuilt correlation requirement and this session would not
  fake it; (c) `set system domain-name` and `set interfaces … description` are residue for want of
  two dictionary lines — cheap, and nobody has ordered them.
- **Planning-only, queued in the orders' §10 lists:** the crypto route for the workspace
  file (WO-05 §2 — never execution work), the dictionary reconciliation (WO-04 §10.2),
  the `73` §14 escalation register as it fills (the section now exists; it was cited from nine
  places before it did). Added 2026-08-06 by ADR-0031/0032: re-anchor
  `73`'s ranks C–F onto events (the ranking inverts, it does not merely age); the
  fragment-to-store weld order, still unwritten (`88` §5.3); and gate zero plus the
  `--locked` fix in `ci.yml` **before any dependency lands** (ADR-0032 §6).
- **Owner-only, blocking:** ADR-0031/0032/0033 are **ratified** (2026-08-08) and ADR-0034 is
  Accepted — see rule 1. Answer `70` §10's open questions — *should the IKE
  warning sit on the interface or the zone?* and *is Meraki configurable by text you can copy?*; the S0
  fixture exports (`76` §7: Calix/Nokia/DIA configs, one service record end-to-end, the site
  list); the four forks in `19` §10; the named expert review of `corpus/` (invariant 10 —
  every entry still carries `reviewed_by: <named human>`). **Two came off this list on 2026-08-09**
  — `70` §16 records both answers verbatim: incomplete paths are drawn and *marked*, never refused
  (`19` §6's warp, `51` §9's `dotted` and never `dashed`), and the `Site`/`Device` identity rule,
  which the owner rightly refused to answer as a question and which is now in `schema/`.

## Verify before you trust

The verification floor (`78` §6), in order — CI runs the first four on every PR:

- `cargo fmt --all --check` — no output.
- `cargo clippy --all-targets -- -D warnings` — clean.
- `cargo test --workspace --locked` — 396 tests as of 2026-08-11; green is the gate, not the
  number. Zero ignored, zero filtered: no test was weakened to reach it.
- `cargo run -p fathom-schema --bin fathom-schema-check` — exit 0, **0 failures and 0
  warnings** since 2026-08-09. The two standing `schema.identity.unexercised` warnings
  against `Site` are gone because `Site` and `Device` now declare identity tuples
  (`70` §16.3); `crates/fathom-schema/tests/shipped_tree.rs` pins the empty set, so the
  next warning of any code fails a test.
- The executing work order's own acceptance gates, exactly as written.

Interactive artifacts open from disk with zero network; the transcript face in
`fathom-app.html` reads its own CSP from the live page.
