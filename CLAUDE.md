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
- **Three of six views are live, as of 2026-08-15.** Inventory, diagram and finder. The diagram
  draws with crossing reduction, orthogonal channel routing, five toggled layers and `59`'s
  aggregation; the finder searches all 98 command entries from Ctrl+K. Walkthrough, config and
  findings are still placeholders — and **config is placeholder by decision, not by omission**: see
  the refusal below.
- **You can drag a box, and it stays where you put it — ADR-0035, 2026-08-15.** The owner asked
  three times and was refused three times for want of somewhere in `schema/` to store a position.
  That decision is made: **a hand-placed position is graph data.** `LayoutPin` (kind 49), contained
  by the element it places via `HasLayoutPin` from the new `Placeable` class, written by `OP_PLACE`
  (21), journalled, and surviving an export and an import. Layout stays **computed** and a pin is an
  **override** that the picture marks — a corner tick, the word `placed`, `placed by hand` on the
  Outline row, and a count in the note. A collapsed group cannot be placed. Keyboard: four `place`
  buttons in the strip, plus `Alt`+arrow as an accelerator (filed in ADR-0035 §9 for `53`, which
  owns the keymap). **Measured at +985 module bytes** against `00-ROUTE-TO-WORKABLE.md` §4's
  estimate of *"stage 8, months"* — the months were the diagram. Driven in Chromium through a real
  reload: `docs/80-review/evidence/2026-08-15-hand-placement-drive.mjs`, 25/25.
- **A home lab has servers, and now the schema does too — ADR-0037, 2026-08-16.** `Device.role`
  declared `firewall, router, switch, load_balancer, other`, so every server, NAS, hypervisor and
  access point the owner added was `other`. It now declares **`server`** and **`access_point`** as
  well (schema 0.2 → 0.3, a minor bump priced in the file's own version comment), and the role is
  offered by the equipment form, shown in the inventory, and **drawn on the diagram box** —
  right-aligned on the kind's line, with a `.dorole` span on the Outline row so the accessible tree
  carries it too. **A server stays a `Device`**: ADR-0037 §2 runs `19` §3.6's three-limb test on a
  `Server` kind and it scores zero of three — same fields, same edges, same lifecycle. **Measured at
  +497 module bytes**, of which only **+133** is the taxonomy; the other 364 is putting the answer in
  the picture, and ADR-0037 §11 disagrees with `00-ROUTE-TO-WORKABLE.md` §4b on exactly that ratio.
  **The blocker is one field to the left and it is NOT closed:** `Device.platform` is card 1 and a
  foreign key into `schema/platforms.yaml`, which registers no general-purpose host, so a hand-added
  Proxmox box must still borrow `junos-srx`. ADR-0037 §5 prices three routes and chooses none —
  owner work. Driven in Chromium from an **empty page**, five boxes added by hand through the real
  form: `docs/80-review/evidence/2026-08-16-server-role-drive.mjs`, 23/23.
- **You can connect two boxes, so a hand-built estate is a network — `OP_LINK` (24), 2026-08-16.**
  Before it, a person could add a box, name it, correct it, move it, rack it and remove it, and
  could not join it to anything: a hand-built lab was a pile of unconnected boxes, and a diagram
  of unconnected boxes is not a network diagram. Hold one end, select the other, draw or cut. The
  **schema picks the edge** — `hand_link_candidates` offers every reference kind that admits the
  two, the module writes it when exactly one survives and **refuses to guess when several do**
  (`ERR_LINK_CHOICE` plus the names; the page turns them into buttons and never picks). Journalled
  **by edge-kind name, never an ordinal**, because an exported journal outlives the build that
  wrote it. A hand-drawn line carries the word `by hand` at its midpoint and on the Outline row —
  `51` §9 reserves `dashed` for AI-proposed and `dotted` for unanswered, so the mark is a word.
  Driven through a real reload: `2026-08-16-hand-link-drive.mjs`, 31/31.
- **The chooser had three defects and all three were only visible in a browser — 2026-08-16.**
  Worth reading before writing another surface: the module was correct at both ends and **the page
  was what guessed**, so no unit test could have caught any of them. (1) `DG_ASK` recorded the pair
  and the candidate kinds and *not the verb that raised the question*, so pressing **"cut the link"
  and answering DREW one** — journalled, exported, permanent. (2) Its corollary: a link of an
  ambiguous kind **could never be cut**, because every cut re-asked and every answer drew. (3)
  Found while driving the first two: drawing a link a **paste** had already made is a correct no-op,
  but it shared its reply word with a real draw, so the page said *"drew a BindsInterface link … it
  is marked as drawn by hand"* over a line the parser had read — every clause false. `OP_LINK` now
  answers with a third word, the page says which happened, and **it does not journal a draw that
  did not occur**. Cut and draw also ask different questions now — the cut asks the graph what is
  **live**, the draw asks the schema what is **legal** — which made the empty-list refusal ambiguous
  and produced a fourth wrong sentence the existing driver caught within the hour.
  `2026-08-16-the-cut-that-drew.mjs`, 18/18.
- **A pasted SRX branch config binds 47.5% of its lines**, up from 23.8% on 2026-08-14. 29 of 122
  before, 58 after, measured per section in `docs/60-content/66-junos-coverage-measurement.md`.
  `set protocols ospf` and `set protocols bgp` now build `RoutingProtocol` and `ProtocolAdjacency`
  — the rows the owner asked for by name. Everything else is still named on the residue list rather
  than dropped.
- **Code: the schema toolchain and the finder core are complete** (`fathom-id`,
  `fathom-schema`, `fathom-schemagen`, `fathom-ir` with checked-in generated types,
  `fathom-corpus`, `fathom-find`). **As of 2026-08-08 the queue has run: six more crates exist** —
  `fathom-graph` (the typed store), `fathom-ingest` (junos-srx set-form, with the redaction gate),
  `fathom-emit`, `fathom-wasm`, `fathom-inventory`, `fathom-artifact`, plus `fathom-layout`.
  **554 tests, zero external dependencies.** **Eight of nine work orders DONE** — WO-01, WO-02, WO-03, WO-05, WO-06, WO-07,
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
  the plain-English account is `overnight-report.md`. **The module is 894,557 bytes against `44` §5.2's
  900,000-byte ceiling — 5,443 bytes of headroom** (measured 2026-08-15 at `dc34fe5`, after the finder
  and the widened dictionary landed; the diagram cost 60,096 and the dictionary move gave 26,915 back).
  **That headroom is now small enough that the ceiling is the binding constraint on every remaining
  feature, and the next one to arrive will not fit.** **Do not quote a module size without re-running
  `scripts/byte-census.sh`** — it has moved three times in four days and three different totals are in
  circulation. **The often-cited "+239,964 for persistence" prices the wrong feature**: it is the
  cost of saving the expanded model, none of it is cryptography, and the journal route measures
  +263. See `79-work-orders/00-ROUTE-TO-WORKABLE.md` §5b. See `79-work-orders/00-ROUTE-TO-WORKABLE.md` §2 stage 1: the ceiling is an
  architecture question, not a number to raise.
- **The bytes have been measured, for the first time, and one feature has been refused.**
  `docs/40-stack/47-byte-census.md` (2026-08-15) is where every module byte goes — by section, by
  crate, by removal — with `scripts/byte-census.sh` to reproduce it. Three findings bind planning:
  **243,522 bytes (27.5%) are shared B-tree/sort machinery no feature owns and no budget row can
  see**; **35% of the module belongs to no feature at all**; and **linking `fathom-emit` costs
  +93,838 at minimum and +110,668 as shipped, so the config view does not fit** — it would spend the
  project's entire remaining budget on one of six views and leave encryption nothing. That refusal is
  the first in this project's history and `47` §11 reasons about it. (An earlier line here said the
  feature "misses by 156 bytes" after every lever is spent; a second measurement of the same build
  landed 1,095 bytes **under**, the difference being inlining. Withdrawn — `47` §9.3 carries the
  correction and the rule: a lever-spent figure within ~2,000 bytes of the ceiling is not a verdict.) Two free levers remain, both measured twice: float handling (44,825) and the demo estate
  (35,178), 80,007 together and no third.
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

0. **A SAFETY GATE IS TESTED AGAINST WHAT A DEVICE ACCEPTS, NEVER AGAINST WHAT THE DETECTOR
   NEEDS.** Added 2026-08-15 after a live credential leak survived four reviews. The redaction
   gate's safety net requires 24 characters; a Junos OSPF `simple-password` is documented at 1 to 8.
   The canary written to guard that exact path used a 28-character probe — chosen *because* the
   detector needs 24, and it said so in its own comment — so it passed on a value no Junos box would
   have taken while the path stayed open for every value that could really appear. The test was
   honest about its construction and asked the wrong question. Before writing a redaction test, look
   the statement's real bounds up (ADR-0034 applies: name the source and the date), and drive it
   through the shipped artifact reading the **exported journal**, which is the file an operator
   keeps. `docs/80-review/evidence/2026-08-15-credential-gate-through-the-export.mjs` is the pattern.
1. **ADR-0034 (2026-08-08) is law and it binds this session:** a security claim is **never**
   answered from memory. Look it up, name the source *and the date*, two independent databases for
   a clean result, and *"I could not establish this"* outranks a confident guess. Carried in
   `.context/conventions.md` § *Currency*. The ADR broke this rule in its own text on day one and
   `70` §7.6 records how — read that before assuming you are exempt.
2. Read `.context/conventions.md` before writing anything — the ten invariants and the
   vocabulary are binding, and the risk enum (three values, reserved colours) is never
   extended or reused. **Re-read it if you last read it before 2026-08-08:** ADR-0002 was
   executed into it and five invariants changed text, including invariant 3, which now reads
   *"stores no device credential"* and carries the ingest-gate redaction that *"never accepts
   a credential"* wrongly implied did not exist. Precedence and the residual scale are new
   sections; `docs/00-vision/01-ownership.md` is the register they point at.
3. `docs/90-decisions/` ADRs are binding once Accepted — but reopenable **on merit**:
   the owner has instructed that sunk cost never argues for keeping a decision (`75` §2).
   Real-time collaboration must never be foreclosed by new state (`75` §2.4). Reopening
   is owner/planning work, never an execution session's (`78` §5).
4. A field that is not in `schema/` does not exist (ADR-0008). Extend the schema via
   `62`'s grammar; `cargo test` must stay green.
5. House style for documents: status line, contents table, numbered sections, Failure
   modes / Open decisions / Sources consulted / Disagreements. Never invent a number or a
   citation; mark the unproven with `<!-- VERIFY: ... -->`.
6. The capability register (`75`) records intent without deciding. Adding to it is cheap;
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
- `cargo test --workspace --locked` — 655 tests as of 2026-08-16; green is the gate, not the
  number. Zero ignored, zero filtered: no test was weakened to reach it.
- `cargo run -p fathom-schema --bin fathom-schema-check` — exit 0, **0 failures and 0
  warnings** since 2026-08-09. The two standing `schema.identity.unexercised` warnings
  against `Site` are gone because `Site` and `Device` now declare identity tuples
  (`70` §16.3); `crates/fathom-schema/tests/shipped_tree.rs` pins the empty set, so the
  next warning of any code fails a test.
- `./scripts/gate-zero.sh` — exists since 2026-08-15; fails the build if `Cargo.lock` holds an
  external package with no `deps/decisions/<crate>.md` beside it (ADR-0032 §6).
- `cargo build --locked --release --target wasm32-unknown-unknown -p fathom-wasm` — **899,781 bytes
  against the 900,000 ceiling, which is 219 of headroom.** Measure, never estimate;
  `scripts/byte-census.sh` says where they go. **At this margin the ceiling decides what ships
  next**: the rack, the OPNsense engine, the roles and the links between them spent the last of it,
  and the only lever left is float handling (~44,825), which is ring-fenced for encryption and is
  the owner's to spend. The next feature of any size does not fit until that decision is made.
- The executing work order's own acceptance gates, exactly as written.

Interactive artifacts open from disk with zero network; the transcript face in
`fathom-app.html` reads its own CSP from the live page.
