# Fathom — session pickup

One page for a fresh session. `README.md` has the full map; this is the state, the rules,
and the next actions.

## What this is

A security-first network tool: one typed graph, six views over it, teaching and
estate-of-record as co-equal goals.

**THIS IS A SERVER PRODUCT.** The pivot was taken on 2026-08-18 and the destination is
server-hosted, multi-tenant and live-collaborative (`docs/40-stack/49-the-server-product.md`);
the single offline HTML file is being dropped. **As of 2026-09-03 the server is no longer a
plan** — `crates/fathom-server` exists, runs, and is proved against a real PostgreSQL and a
real TLS stack (WO-11). It stores nothing yet, on purpose, and that is the next order's job.

Two things follow, and getting them the wrong way round is the most likely way to misread this
corpus:

1. **Most documents here were written about the offline file**, some of them at length and
   well. Their reasoning is sound *for the artifact they were written about*. **Do not carry a
   conclusion across the pivot without re-checking its premise** — `48` §1 is the standing
   warning, and `38` is the document it most applies to.
2. **The client still exists and its rules still bind it.** The browser page makes no network
   request, takes no credential and sends no telemetry (invariants 1–3,
   `.context/conventions.md`; exceptions priced in `38`, none approved). Invariant 1 is the
   owner's rule for **the client-only mode** (`48` §1) and it is not a claim about the server.
   Invariant 4 was formally **scoped** rather than deleted on 2026-09-03 (ADR-0040): the
   server holds the keys and says so. **Device credentials are still protected by never
   arriving** — that one survives the pivot intact, and it is the sentence that stays true.

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
- **Schema: instantiated and gated.** `schema/` is real (51 kinds / 95 edges / 61
  scalars as of schema 0.5, 2026-08-29 — read the number off `fathom-schema-check`, this
  line has lagged before); `crates/fathom-schema` parses and checks it; `cargo test` pins
  zero failures.
- **Design: decided and demonstrated.** `design/prototype/fathom-app.html` is the whole
  product as one interactive file — the fidelity bar for anything built.
- **Four of six views are live as of 2026-08-22.** Inventory (with in-place cell editing),
  diagram (crossing reduction, orthogonal routing, five layers, `59`'s aggregation, and a
  zoom-depth ladder: select a rack for its elevation, "go inside" a device for rung 4's
  interface→zone→policy→routing bands), finder (98 command entries from Ctrl+K), and
  findings — which reports the estate's GAPS (required fields with no value), deliberately
  not called findings in the wire format because there is no rule engine. Walkthrough and
  config are still placeholders; **config was placeholder by byte-ceiling refusal (`47`
  §11), and that refusal lapsed when the ceiling was removed on 2026-08-21** — nobody has
  re-ordered the view since.
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
  reload: `docs/80-review/evidence/2026-08-15-hand-placement-drive.mjs`, 23/23 (corrected here from
  a stale "25/25" — re-run and recounted by the ADR-0039 proving session, 2026-09-02).
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
  owner work. **(Annotated 2026-09-05: the form no longer forces the borrow — see the "a server is
  not a Juniper firewall" bullet below. The REGISTRY question, a `proxmox-ve` row, is still the
  owner's.)** Driven in Chromium from an **empty page**, five boxes added by hand through the real
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
- **A pasted SRX branch config binds 57.4% of its lines**, up from 23.8% on 2026-08-14 and 47.5%
  on 2026-08-15. 29 of 122 lines bound at the start, 58 after the 2026-08-15 widening, 70 after
  `corpus/dict/junos-srx/security-policies.yaml` landed 2026-08-28 — measured per section in
  `docs/60-content/66-junos-coverage-measurement.md`, re-run and confirmed by a prover session the
  same day. `set protocols ospf` and `set protocols bgp` build `RoutingProtocol` and
  `ProtocolAdjacency`; `set security policies … policy NAME match source-address any` / `…
  destination-address any` / `… then permit` build a `PolicySet` keyed on the zone **pair** (not
  either zone alone) and a `SecurityPolicy` per named policy, ordinal assigned once at first
  creation — rung 4's policy band, empty on every Junos paste until this landed, now draws it.
  `match application …` (9 of the section's 21 lines, including the literal `any`) stays residue:
  `SecurityPolicy` has no `match_any_application` field. Everything else not named above is still
  on the residue list rather than dropped.
- **Code: the schema toolchain and the finder core are complete** (`fathom-id`,
  `fathom-schema`, `fathom-schemagen`, `fathom-ir` with checked-in generated types,
  `fathom-corpus`, `fathom-find`). **As of 2026-08-08 the queue has run: six more crates exist** —
  `fathom-graph` (the typed store), `fathom-ingest` (junos-srx set-form, with the redaction gate),
  `fathom-emit`, `fathom-wasm`, `fathom-inventory`, `fathom-artifact`, plus `fathom-layout`.
  **792 tests. Zero external dependencies ON THE CLIENT SIDE, deliberately — the server spends
  that position and nothing crosses: every external crate is declared in
  `crates/fathom-server/Cargo.toml` and nowhere else, the workspace dependency table stays empty
  so nothing can be inherited with `workspace = true`, and `fathom-wasm`'s empty
  `IMPORT_ALLOWLIST` plus `artifact_gates.rs` fail if anything does.** **Eight of nine work orders DONE** — WO-01, WO-02, WO-03, WO-05, WO-06, WO-07,
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
  the plain-English account is `overnight-report.md`. **The 900,000-byte ceiling was REMOVED on 2026-08-21** at the
  owner's direction (`49` §1 retires it with the pivot): `artifact_gates.rs` now REPORTS the
  module size on every run instead of gating it. **Do not quote a module size without
  re-running the build** — at least five totals are in circulation from the ceiling era. **The often-cited "+239,964 for persistence" prices the wrong feature**: it is the
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

- **A week of design is on disk and none of it is built — `docs/50-design/57-the-zoom-ladder-and-the-trace.md`,
  2026-08-18.** It began as a complaint that `rack view` sat in the band's data-entry row and
  opened into the product's shape. **Read `57` §14 before planning anything**, knowing its frame is
  dated: it sorted every raised item into *buildable now* / *blocked on the owner* / *blocked
  on bytes* — and the byte pile emptied when the ceiling came off (2026-08-21), while pile A
  was built out on 2026-08-21/22. What survives of §14 unchanged is the owner-blocked pile
  (five decisions, all cheap-now-expensive-later, none answered). Four findings from it still
  bind future work:
  **(a) the schema forks physical from logical and they meet at the chassis** — `Premises → Rack →
  Chassis` and `Site → Device → Chassis` hang off different roots, so "physical view or logical
  view" is the wrong question; it is one ladder that forks once, at the box.
  **(b) `19` §6.5's `trace_step` is fully specified and has never been implemented** — the cable
  walk, the sort orders, the `PassThrough` step, a 16-hop cap and seven named outcomes. Drawing a
  trace is following a decision already taken, not inventing one.
  **(c) nothing creates a `Cable`, and nothing creates a `PhysicalPort`.** Both kinds and all
  their edges are declared; no opcode builds either. The physical trace is fully expressible and
  completely unbuildable on a hand-made estate.
  **(d) "why does this packet go here" is answerable with no rules engine** — never say permitted
  or denied; from the ingress and egress interfaces the graph names the two zones, the policy set
  between them, and its policies *in the order the device reads them*. Four hundred policies
  become the twenty-seven pointing this way, exactly and not heuristically.
- **The hard schema blocker is CLOSED — `PhysicalPort.label` is `0..1` as of 2026-08-28**
  (schema 0.3 → 0.4, minor; owner's answer verbatim in `70` §18.3: *"absolutely, one of the
  main features is to be able to create essentially a lucid chart with no information"*).
  `57` §13.5's open decision 8 is answered and **everything in `57` §12–§13 — cabling mode,
  drag-then-annotate, the port prompt — is now buildable.** **`57` §14.1 B3 — nothing creates a
  `PhysicalPort` — is CLOSED too, by ADR-0038, 2026-08-29**: see the cabling-mode bullet below.
  Three more answers landed the same day (`70` §18): tenancy lives OUTSIDE the graph as server
  tables (49 §22 decision 2, closed — and enterprise LDAP/AD arrived as a new phase-1
  requirement); key custody is delegated to an ADR-0034 survey of enterprise practice (decision 1,
  IN PROGRESS); and general-purpose hosts get ENGINES, not a catch-all platform — the `proxmox`
  vendor row is registered, its platform row waiting on a `64`-style survey.
- **You can cable two boxes by hand, and the ports mint themselves as the gesture needs them
  — `OP_CABLE` (27), ADR-0038, 2026-08-29.** Before it, `Cable` and `PhysicalPort` existed only
  in `schema/`: a hand-built device had a `Chassis` and zero ports, a pasted device had no
  `Chassis` at all, and the port prompt `57` §12 asked for would have opened onto nothing. Now:
  select a device (or a chassis in the rack elevation), press *cable from here* — a sheet lists
  its ports plus *add a port* and *no cable — these just talk*; picking or minting a port holds
  it; select the far box, press *cable them*, and the cable draws, minting whatever port or
  `Chassis` the gesture needed in the same batch, marked `cable · by hand` on the canvas and in
  the Outline. An unknown far end is a legal one-ended cable that lives under its device's
  Outline row with no line on the canvas. Cutting is done from the Inventory, deliberately not a
  third strip button — resolving a specific cable's id from two clicked ports has no honest,
  non-guessing answer with what the module exposes today. Escape now releases a held link or
  cable end, closing a gap that had stood since `OP_LINK` shipped on 2026-08-16. **This is what
  `57` §14.1 B3's closure means**: the empty-port-list problem that stood between the owner's
  2026-08-18 request and a buildable gesture is gone. **Module +19,450 bytes** (969,090 →
  988,540, reported not gated, `49` §1); zero schema change (ADR-0008 — `Cable`, `Terminates`,
  `PhysicalPort`, `HasPort` and `HasChassis` were already declared). Four browser drivers green
  through a real reload: the new `2026-08-29-cabling-drive.mjs` (56/56, including a hand-tampered
  journal record that must be refused rather than silently guessed through — a real defect found
  and fixed during proving, ADR-0038's as-built note), plus both 2026-08-16 link drivers (31/31,
  18/18) re-run with no regression. **What stays open, all in ADR-0038 §9**: range cabling and
  bundles; the rung-3 faceplate (per-port drawing); `ExternalPeer` far ends (tag 3 — reserved on
  the wire, refused by the module, and now refused honestly on replay too rather than silently
  reinterpreted); type-to-link; platform port complements for `platforms.yaml`; a standalone
  *add a port* from the Inventory; and, newly recorded, `Terminates.end`'s literal A/B letter
  having no wire read path (property-tested instead) and `begin_batch` refusals still surfacing
  as raw Rust `Debug` text across several opcodes, cable included, not just this one.
- **You can drag a box's edge to cable it, not just its body to move it — ADR-0039, 2026-09-02.**
  A press in a 10-CSS-pixel band inside a box's rendered edge (`DG_PERIM_BAND`, screen space so it
  stays 10px at every zoom from 0.2x to 4x, exactly the reasoning the box's own hairline stroke
  already uses) draws a cable; a press in its body still moves it, unchanged (ADR-0035). Release
  over another box opens the SAME `OP_CABLE` picker the strip's *cable from here* / *cable them*
  opens — near then far, no second drag needed — writing the identical journal shape a keyboard
  cable produces, ids and clock/entropy excepted; release back on the origin box cancels; release
  on empty canvas reverts and says plainly that creating a box this way is not built (`49` §15 item
  3); release off-canvas or a `pointercancel` reverts too. A box whose shorter side draws under 40
  screen pixels has no band at all — the whole box stays body, per D4 — because 10px each side
  would otherwise eat a small box until the keyboard is the only way to move it. **The escape hatch
  `56` §6.3 has specified since it was written and this build never had, for EITHER drag, now
  exists**: `Esc` mid-drag reverts the preview or the provisional move and releases capture, one
  rung covering both `DG.box` and `DG.connect`. **No Rust, no opcode, no schema change** — the
  gesture terminates in `OP_CABLE` (27), unchanged; **module bytes confirmed unchanged at
  988,540**. Page **+14,870 bytes** (2,803,728 → 2,818,598). Driver
  `2026-09-02-drag-to-connect-drive.mjs` (**58/58**, up from 48/48 at first cut) through a real
  reload, including the keyboard-equivalence assertion (the same journal record shape from a drag
  and from the strip), a real off-canvas release (distinct wording from an Escape cancel — added
  by the proving pass below), and export → reload → import; `2026-08-15-hand-placement-drive.mjs`
  (23/23), `2026-08-29-cabling-drive.mjs` (56/56), `2026-08-16-hand-link-drive.mjs` (31/31) and
  `2026-08-16-the-cut-that-drew.mjs` (18/18) re-run with no regression. `56` §6.3 and §6.4 are
  annotated against what actually shipped (both predate ADR-0038/0039 and named a mechanism —
  `Op::SetLayoutHint`, `Op::AddEdge`, keys `L`/`T` — that was never built); `fathom-weld`'s stale
  *"no opcode creates a `Cable`"* comment was corrected in the same pass that filed the ADR.
  **Proven the same day, adversarially, and one evidence-only defect found and fixed — the page
  itself needed no change.** Three skeptics attacked no-regression, never-guesses, and §5's band
  arithmetic; the first two held outright. The third found the shipped band arithmetic itself
  correct but the driver's own "two zoom levels" section (which §9's failure-mode row leans on)
  materially weaker than it read: it moved the zoom by one ~20% strip-button click and silently
  passed as `'not exercised'` when no safe alternate zoom existed for a run's layout — a gate
  tested against what the assertion needed, the exact anti-pattern rule 0 above warns against.
  Rewritten to zoom on the test pair's own shared midpoint via a real wheel event (the same
  `dgZoomAt` arithmetic a physical scroll runs, a different real input than the strip buttons) and
  drive two genuinely far-apart, honestly-computed points — as close to where D4's floor takes
  over as the pair's own geometry allows, and as close to the true `DG_MAX` ceiling as it allows —
  failing outright rather than passing vacuously if neither exists. In passing this also drove a
  real off-canvas pointer release, which the first cut's own header claimed as covered but only
  Escape (a structurally different code path) actually exercised. ADR-0039 §7 carries the dated
  as-built note. What stays open, all in ADR-0039 §10: the shape autoprompt (drop-on-empty-canvas
  creating a node and its edge in one gesture, `49` §15 item 3); drop-on-a-port (needs the rung-3
  faceplate, ADR-0038 §9 item 2); a keyboard chord for connect, if `53` wants one; `?` (the
  shortcut-help sheet) is specified in `53` §3.1 and still does not exist anywhere in the page;
  alignment guides and measured distances (`49` §15 item 5) stay the move-drag's, constrained to
  `LayoutPin`-writing gestures.
- **The parse-server question is answered and the answer is no server — `38` §14, 2026-08-17.**
  Six designs, each attacked by an independent reviewer. The finding in one line: *we were about
  to move a customer's firewall config off his machine because a lookup table got compiled as a
  chain of `if` statements.* The largest zero-egress lever is 1.9× the entire prize of the server
  that would have read the config. Two live defects came out of it: the shape sketch published the
  exact byte length of every secret it destroys (**fixed 2026-08-21** — the length is gone
  from the sketch, two canaries assert byte-identical output across secret lengths, and the
  38 §14.9 row is closed), and `snmp.trap-group` had exactly
  one detector where every other declared secret has two (**fixed 2026-08-17**, +16 bytes, with an
  8-character canary). The durable rule it produced, proposed to `03` and not yet ratified:
  **nothing arriving after the build may reduce what the ingest gate destroys, only increase it —
  union, never replace.**

- **The owner intends to fork a server version, and has redefined an invariant in passing —
  `docs/40-stack/48-the-server-fork.md`, 2026-08-18.** *"this would be after we were full server
  solution, so it wouldn't be that main rule anymore, that main rule is only for demo mode like it
  is currently."* **Invariant 1 has been read throughout this corpus as permanent; the owner's
  position is that it governs the CLIENT-ONLY mode.** `48` §1 records this without amending
  `.context/conventions.md` — that is `03`'s and the owner's (open decision 1) — but several
  documents, `38` above all, argue from the invariant as though it could never change. Their
  reasoning is sound *for the artifact they were written about*; do not carry their conclusions
  across the fork without re-checking the premise. Three findings bind planning:
  **(a) the fork is small.** Thirteen core crates are platform-neutral Rust with zero
  dependencies and their 656 tests already run natively, not in a browser. Only `fathom-wasm`
  (an opcode shell) and `fathom-artifact` (an HTML assembler) are browser-specific. **Fork the
  app, not the vocabulary** — `schema/` and the generated types stay one source of truth or the
  two sides silently stop being able to read each other's exports.
  **(b) the 900,000-byte ceiling is a WASM constraint and does not exist natively**, so all of
  `57` §14.1's pile C unblocks on the server side the moment the same crates compile for a
  binary. This does NOT help the client, where `47`'s levers remain the only lever.
  **(c) the store is single-estate and in-memory** — `OP_PASTE` replaces what is held. Many
  estates, concurrency and durable persistence are the actual scope of the fork, alongside HTTP,
  auth and storage.
- **The largest new design surface in the server version is permissions, not storage** (`48` §5),
  because it touches every read path. A permission implemented as a server-side check fails open
  when the check is wrong; a permission implemented as *"we do not hold the key"* has no such
  failure mode — but **revocation is its hard problem** and should be understood before it is
  designed: someone removed from a group still holds the key they were given, so real revocation
  means re-keying and re-encrypting everything it protected. And the axis for secrets is
  **key custody, not RAM versus disk** — `38` §14.3 already lists eleven mechanisms that defeat
  *"it only lives in memory"*.

- **THE PRODUCT PIVOTED, 2026-08-18/21 — `docs/40-stack/49-the-server-product.md` is the plan.**
  The owner took four decisions explicitly and none is open: **data lives on the server** (the
  browser is a window, not a peer), **live multi-user editing**, **multi-tenant**, and
  **thousands of devices per design**. And the consequence he accepted: **the single offline HTML
  file is dropped.** That retires the 900,000-byte ceiling, `47`'s three unproven byte levers as
  the top priority, `47` §11's refusal of the config view, and all of `57` §14.1's byte-blocked
  pile. **Read `49` before planning anything.** Five findings bind:
  **(a) `fathom-wasm` is NOT retired — it is re-scoped to the ingest gate and nothing else.**
  The pivot's own framing said to drop it; `49` §1 refuses, because it is the only vehicle that
  puts the redaction gate in the browser, and dropping it means a second gate written in
  JavaScript that drifts from the Rust one and is the copy that actually decides whether a
  password crosses the wire.
  **(b) the secrets answer is "you are already most of the way there".** Passwords are protected
  by *not having them* — the gate — and that is cheap, permanent and unbreakable by a bug.
  **NetBox deleted its secrets store in v3.0 and points at Vault; Nautobot never built one.**
  What is genuinely expensive is protecting **the map** — addressing, zones, tunnel endpoints and
  the ~50% of a config the parser does not understand — which `38` §14.4 already priced at *"the
  secrets are 2% of the file, the other 98% is the network."*
  **(c) `fathom-layout` is CUBIC and it was measured, not estimated** (`49` §8): 2,281 nodes in
  112.8 ms, 36,481 nodes in **244 seconds**. Doubling the estate multiplies time ~7.5x.
  **Aggregation shrinks the picture and not the work** — folding a 72,961-node estate yields 8
  boxes and still takes 17.3 s. The rule is **lay out a scope, never an estate**.
  **(d) firmware: Fathom CONFIGURES a firmware server rather than being one** (`49` §16.0).
  Hosting vendor images multi-tenant is a licensing question as well as an isolation one. Fathom
  generates the account file, the sshd block, the proxy site, the per-device commands and the
  checksum manifest, and never holds the bytes.
  **(e) the SSH login model is decided** (`49` §16.2): **per-device key, one shared read-only
  machine account (`fw-pull`), plus a separate per-person account for writing.** Identity is
  per-device, the account is shared — so revoking a device is deleting one line. `rssh` and
  `scponly` are rejected as unmaintained; TFTP is rejected as unauthenticated.
- **PHASE 0'S CODE IS DONE, 2026-08-21** (`49` §19). All four coded items: the secret-length
  leak closed; every op carries an author and a sequence number; a paste records what it
  produced and says so when a replay diverges; and **`OP_PASTE` adds to the design rather
  than replacing it**. (§19 phase 0 also lists two DECISION items — open decisions 1 and 2,
  invariant 4 and where tenancy lives — which are the owner's and remain open; "done" here
  means the code half, not the whole phase.)
  Four things that only a browser found, worth knowing before the next surface is built:
  **(a) `addEventListener('click', runPaste)` passed the MouseEvent as the confirm argument**, so
  every paste was silently pre-confirmed and the duplicate question could never fire — the module
  was correct at both ends and the page was answering on the operator's behalf.
  **(b) making the paste additive made three store errors reachable that had never been reachable**
  (`BatchIdReused` and friends), because welding into a fresh graph time meant nothing to collide
  with. The batch id was derived from the clock; it is derived from the entropy now, and an id
  overlap is refused in English rather than as a Rust debug string.
  **(c) a replay must never re-ask a question that was already answered.** Every op in a journal
  is an op that happened, so `importJournal` confirms; without it an import died on step 2.
  **(d) two page sentences became lies the moment the behaviour changed** — the paste hint said
  `REPLACES` and the button said `replace what is loaded`. A warning that names the wrong outcome
  is worse than none: it teaches an operator to ignore the next one.

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

- **HANDOVER, 2026-09-05 — the owner answered everything asked, three demo defects are fixed, and
  the next work is planning, not code.** Read this bullet, then `docs/70-ops/WHAT-I-RECOMMEND-2026-09-04.md`
  (the owner's page, two screens) and `docs/70-ops/70-owner-answers-and-standing-priorities.md`
  §19–§20 (his words, verbatim) before anything else on this page.
  **WHAT WAS DECIDED, 2026-09-04.** Fourteen security and schema decisions were each researched
  by one agent and attacked by a second; every attack struck over-claims and bad citations and left
  the direction standing; the technical record with every correction applied is
  `docs/70-ops/RECOMMENDATIONS-2026-09-04.md` (3,398 lines, 6 `VERIFY` markers and 2 bare — a
  previous line said 21, counted by grepping the word). Three governance items were judged
  directly from documents already on disk. The owner then answered ten questions in one evening
  (`70` §20.1–§20.10) and five the afternoon before (`70` §19.1–§19.5). The ones that bind code:
  **open source, run by the employer, optionally behind a hardened reverse proxy** — which means
  ADR-0003's *"no hosted service, no accounts we run"* stays TRUE and it is `49`'s customer
  language that needs amending, the opposite of what `OPEN-FOR-THE-OWNER.md` §B1 feared;
  **a vault from the start and the server holds the keys, confirmed knowingly** (OpenBao Transit,
  MPL, as one more container; ADR-0040 unchanged); **secrets in compose live in env files that can
  be restricted, never inline and never with a default** — `deploy/.env` is git-ignored as of
  2026-09-04 and the README makes it `chmod 600`; **five people-roles — read-only, write, share,
  invite, admin — granted PER SITE** (the New York head-end engineer has no write on San
  Francisco), and **a drawing is Draft, Planning or Production** (server tables, distinct from the
  per-box `planned` word); **groups AND tags are two kinds**, a group a real named set that spans
  sites and does not nest, a tag a typed word Fathom reuses; **the demo runs in Docker only**;
  **a separate database for the keys was handed back to me and I recommend against it** —
  `tenant_key` in its own PostgreSQL schema is the cheap middle, `70` §20.9 says why in one
  paragraph; **the firmware bench test is on** — the owner has a real SRX and a real Arista, and
  `docs/80-review/evidence/2026-09-04-firmware-bench-test.md` is the thirty-minute script, its
  Juniper half verified line by line against `Juniper/yang` `96ad7bad` (the SRX has `request
  system download start … identity-file` and `request security ssh key-pair-identity generate`,
  now in `49` §16.1a(vi); `file copy` has no key leaf, confirmed in the `file-mgd` model), its
  Arista half exploratory because arista.com is unreachable from here and no Arista-authored
  material shows a client key. **Two mistakes of mine worth not repeating**: naming another
  product in a question read as a dependency (*"Why are we having grafana…?"*), and using the
  word *group* for equipment when it also means people. Both recorded in `WHAT-I-RECOMMEND` §2.
  **SIX SCHEMA DECISIONS EACH CLAIMED 0.6; THE ORDER THEY LAND IN IS WRITTEN** —
  `docs/70-ops/79-work-orders/00-SCHEMA-SEQUENCE-2026-09-04.md`: D1 no bump → D2 0.6 (keys
  312–314) → D4 0.7 (315–318) → D7 0.8 → D5 0.9 → D6 0.10 (319–371) → D3 0.11, the major-class
  change alone → E4 no bump. The real tail of `field-keys.yaml` is 311; read it off the file.
  **THREE DEMO DEFECTS, FOUND BY OPENING THE PRODUCT, ARE FIXED — each implemented by one agent,
  driven in Chromium through a real reload, and attacked by a second agent.**
  (1) **The findings view showed a ULID where a name exists** — commit `8481632`. My premise was
  wrong and the agent corrected it: I said a `PolicySet` had its zone pair "right there", and it
  does not — `fathom_ir::value::PolicyScope` is `pub struct PolicyScope;`, a unit struct, the zone
  pair is a dictionary dedup key only, and no `PolicySet → Zone` edge exists; **the same class as
  `57` §14(b)'s `trace_step`: fully specified in `19`, never implemented**, already recorded in
  `fathom-inventory/src/inside.rs`'s module doc and pinned by a `size_of` tripwire in
  `tests/projection.rs` that fires the day `PolicyScope` grows a shape. So a `PolicySet` stays its
  id, honestly, and the real defect was sixteen kinds whose `name`/`label`/`hostname` field the
  projection never rendered; driver `2026-09-04-the-name-the-graph-holds.mjs` 16/16.
  (2) **The diagram opened unreadable** — one pasted SRX drew 47 boxes and 60 lines at 0.29× with
  94 labels off. Established, not assumed, in `dgFoldInside`'s comment: not the five layers (a
  mask thins, it cannot fold), not a missing like-kind fold (`59` §3 needs more than six IDENTICAL
  siblings and the SRX's eight interfaces carry eight edge signatures), **the rung** — `56` §4.1's
  stubs, labels and brackets are all drawn as full boxes one column deeper per containment hop, so
  the site rung drew rung 4's contents beside every device. Now every box whose containment chain
  passes through a `Device` folds into it at rung 1; the box carries `46 inside`, the Outline row
  carries the count and lists every folded object one level down, selectable; the details pane
  says which kinds; the band and note say how many are not drawn; `show what is inside` in the
  strip draws the picture exactly as before and is offered only when something is folded (`70`
  §19.4b). A reference line with one end inside a device is re-homed to the device box
  (`dgRehome`, the one geometry the page draws on its own account, because the module's polyline
  ends where the folded box was). Positions do not move (`56` §3.6); the FIT does (`DG.ext`).
  First open is now one box at 3.55×, 0 labels off. Page-only; module bytes unchanged at
  988,825. Commit `069896c`; driver `2026-09-04-the-diagram-opens-on-the-devices.mjs` 55/55
  through a real reload, plus twenty-six diagram drivers re-run — eight of them changed to press
  `show what is inside` first, each with a dated note at the point of change, because they were
  written against interface boxes the site rung no longer draws. Finishing it found two more
  page regressions and fixed them in the same commit: `dgHold` clamped against the padded extent
  (six drags pushed the one box off-canvas at 3.55×) and `dgBoxOf` consulting the fold map while
  the fold was not applied. **Its skeptic then found four consistency defects — the band false
  at rung 4, the control offered at depth where it does nothing, the Outline row still saying
  `46 inside` while shown, a pressed control surviving the removal of everything it governed —
  repaired in `ad6f36c`: the band clause gated on the same `away` test as `labels off`, the control
  hidden at depth by a CSS rule beside `.dzoomctl`'s, the row count only while the fold is applied,
  the control offered only when something is behind it; driver 55 → 65/65, 59/65 on the parent.
  Its skeptic held on all four and found one more of the same class one panel over — the Outline
  NOTE at rung 4 still said *"press show what is inside"* over a strip where that control is hidden
  — polished in `0733288`: the whole fold clause is a span hidden by the SAME two CSS rules that hide
  the control, so the two can never be hidden separately; driver 65 → 69/69, 66/69 on `ad6f36c`.
  That skeptic held, and listed four more of the class as pre-existing and out of remit: at rung 4
  and the rack rung the note still carries site-picture counts and instructions (*"1 box standing
  for 1 object"*, *"Drag a box to place it by hand"*), the rack rung's note says *"1 rack is drawn —
  select one"* over that rack's own elevation, the details pane's `46 inside` summary reads at rung
  4, and `N lines` bypasses `plural()`. All four are one polish, not four. Its message says *805 passed*; the count on that tree was 804, corrected here and
  in the polish commit rather than by rewriting history (the `a5555ad` precedent).**
  (3) **A server had to be filed as a Juniper firewall** — commit `1e0465a`, the design in
  `RECOMMENDATIONS-2026-09-04` §15 (D1) built as specified: `Device.platform` stays `card: "1"`,
  the FORM stops demanding it (a blank is the first option), the store holds `Unknown`, the
  inventory shows `—`, findings lists *"1 of 1 Device nodes has no platform"*, and the trap the
  skeptic found is closed rather than reworded — `identity_clash` treats a REQUIRED term the estate
  holds as `Unknown` as a question, read from the generated `field_required`, so pasting that
  box's real config later ASKS instead of welding a second box. A CLEAR is built: an empty
  `OP_FIELD_SET` value runs `Graph::clear_field`. Module 988,825 → 990,109 (+1,284); 804 tests;
  driver `2026-09-04-a-server-is-not-a-juniper-firewall.mjs` 33/33, nine red and a timeout on
  the build before. The state bullet above (*"the equipment form's platform door is open"*) is
  that commit's own record. **Its skeptic found the clear path bypassed the authorability gate
  (a hand-edited journal could empty a parser-set `SecurityPolicy.action` that no editor can
  refill), leaked a raw Rust `Debug` refusal and an empty batch on an undeclared key, and had no
  floor (a Device's `hostname` — the one field the add door demands — could be cleared, and a
  hostname-less box then makes every same-platform paste ask). Decided by me, 2026-09-05: what
  the door demands cannot be cleared. Repaired in `aa7bab9`, which I read myself as the security-class change of the day: the clear runs
  `fathom_inventory::authorability(key)` — `is_authorable` with the reason attached, and
  `is_authorable` is now defined as its `is_ok()` so the two cannot disagree — and gets the SAME
  sentence a set gets; `declares(element, key)` is asked BEFORE any batch on both paths (the value
  path had the same hole for a parseable key on the wrong kind); `DOOR_DEMANDS` in `shell.rs` is the
  one list the add door and the clear both read, today `Device.hostname`, refused as *"a box needs a
  hostname — type a new one instead of clearing it"*. Module 990,109 → 991,123 (+1,014); 809 tests;
  `crates/fathom-wasm/tests/clear.rs` four tests, three red on `1e0465a`; driver 33 → 46/46, 32/46 on
  the parent, now driving the details-pane editor too. Its skeptic ran a day late (the session limit cut the
  first one off) and **held with zero defects**: 46/46 on HEAD, 32/46 on the parent, three of the
  four `clear.rs` tests red on the parent, and its own 46-check probe 46/46 against 19/46.**
  (4) **Importing your own export said the gate had learned since the file was written** — *"it
  now destroys 7 secrets in this config where the saved file recorded 8"* on a same-build round
  trip of the documented SRX fixture, pre-existing (reproduced on `8481632`'s parent), found by
  fix 1's skeptic and confirmed by fix 3's. The replay re-runs the gate over already-redacted text
  and compared that count with the one recorded over the original. **Established, not assumed,
  in `3761364`**: the fourth summary slot was `drops.entries.len()`, gate EDITS; on the raw fixture
  the gate makes eight (two encrypted-passwords, the PSK, and on the two SNMP lines the community,
  the trap-group name and three pieces of `raw_walk` collateral); on the redacted text seven fire
  again and write their own marker over themselves byte for byte — `pre_redacted` does not know the
  gate's own marker, the `:` fails its bracket clause — and the eighth, `read-only`, fired only
  because the synthetic VALUE `EXAMPLE-READ-ONLY-COMMUNITY` carries the component `community`. So
  the comparison could say nothing true: a PSK put back into the file by hand also read 7, and a
  base64 blob on a residue line read 7 + 1 = 8 — silence over a credential. **Decision (b), taken
  by the agent and confirmed by my own read: the module reports what THIS run destroyed** —
  `RedactionEntry.unchanged` (bytes written == bytes there), `DropManifest::destroyed()`, computed
  at the one moment both texts are in hand. **This changes no redaction**: edits are proposed, kept
  and written as before, and the union rule is untouched; `pre_redacted` is deliberately left not
  knowing the marker, with the reason beside it (skipping the edit would change what `bind` sees
  and move the digest on every import). A same-build round trip now shows NO note; a file with a
  value put back shows the gate note and the export from there is clean; the record totals 8 + 1.
  Module 991,123 → 991,301 (+178); 817 tests; driver `2026-09-05-a-round-trip-is-not-a-drift.mjs`
  19/19, 12/19 on the parent. Its skeptic found three wording defects — the gate note said *"opened
  exactly as saved"* above a DRIFT alert saying the file had not been touched, told the operator
  to export-and-replace over an export holding only the replayed paste, and stated a hand-edited
  record's number as the gate's own act — **fixed by me in `5d68193`**, driver 19 → 24/24,
  21/24 on `3761364`; and one observation left open: **after any import the page renders no tally
  at all** (`S.paste` is null), so an imported workspace says neither 8 nor 0 on screen — the
  recorded number survives only in the export.
  **TWO PROCESS DEFECTS FOUND WHILE DOING THIS, NEITHER FIXED:** (a) **every browser driver in
  `docs/80-review/evidence/` overwrites its own PNGs when re-run**, so re-running twenty-two old
  drivers as regression checks modified twenty-two historical evidence screenshots in the working
  tree; they were restored with `git checkout HEAD -- <paths>` and the fix-2 stage was told to do
  the same. A driver's PNG is evidence of the day it was taken; the drivers should write to a
  scratch path unless asked to refresh their evidence. (b) `2026-08-21-findings-first-job.mjs`
  had one pre-existing failing check (*"the long list of names is behind a disclosure with the
  count in the heading"*, its line ~303, 40/41) before any of today's work — re-run it before
  blaming a change for it. (c) **Something pushed `1e0465a` from this container** while every
  agent was told not to push and this session had not: the remote-tracking reflog records it as
  a push from here. Harmless — those commits were going to be pushed — but the instruction was
  not followed and nobody knows by whom. (d) **An interrupted skeptic left `skeptic_probe.rs`
  untracked inside `crates/fathom-wasm/tests/`**, where the next `cargo test` would have compiled
  it; a probe belongs under the scratchpad and is gone before the verdict. Both are now in the
  house rules the workflow scripts carry; neither is in `78`.
  **DOCKER: BUILT, NOT RUN.** `deploy/Dockerfile` has an `artifact` stage and a `web` stage
  (Caddy serving `fathom-dev.html` as the front page, `/health` proxied to the server);
  `deploy/README.md` is the quickstart with the secrets rule and three questions an enterprise
  reviewer will ask. The registry pull returns 403 at this environment's egress proxy, so the
  stack has not come up here and the README says NOT RUN; the owner runs it first.
  **F5 IS NOT IN `schema/platforms.yaml`** — thirteen vendors and ten platforms are (grep it, the
  list above has lagged before), and the owner named F5 alongside Cisco, Arista and Juniper on
  2026-09-04. A vendor row is a `64`-style survey; not urgent, not forgotten.
  **NEXT — PLANNING, IN THIS ORDER, NONE OF IT EXECUTION WORK:** an ADR amending `49` for
  open-source-and-employer-run (B1) and scoping invariant 1 to the client-only mode (C3, the
  ADR-0040 precedent); WO-13 the OpenBao Transit `MasterKeyProvider` behind WO-12's interface;
  WO-14 groups and tags at schema 0.6; WO-15 the firmware manager page, gated on the bench test;
  WO-16 the audit record; the roles-per-site permission design (`48` §5 is the reasoning, five
  roles and Draft/Planning/Production are the owner's words); and, someday, `PolicyScope` and
  `trace_step` in one order because they are the same shape of gap. Then execute WO-12.
- **HANDOVER, 2026-09-04 (second revision, written after the work below landed).**
  **WO-12 IS WRITTEN.** `docs/70-ops/79-work-orders/WO-12-the-key-boundary-and-the-first-stored-row.md`
  is on disk, its index row is in `00-INDEX.md` as row 12, and its status is **OPEN** — the next
  order, not executed work. **Read its header block and Disagreements before executing it, and read
  the paragraph below before trusting it.**
  Why it could be written with key custody still undecided: ADR-0040 D1–D4 already fixed the
  *architecture* (a data key per tenant and per design, wrapped by a master key, custody switched by
  re-wrapping keys and never re-encrypting data), and `OPEN-FOR-THE-OWNER.md` §A1's open part —
  *which service holds the master key* — is a **provider behind an interface chosen by deployment
  config**, not a storage format. A cloud key service, a vault and a protected local file are all
  opaque bytes in one provider-neutral column. The order is shaped backwards from one test: re-wrap
  a tenant's key under a second, differently-shaped provider and assert the stored ciphertext is
  byte-identical before and after. It **supersedes WO-11 G8** (*"nothing is stored"*) and repurposes
  that test into a column census rather than deleting it.
  **IT WAS ATTACKED FOUR TIMES AND EVERY ROUND FOUND REAL DEFECTS.** Round 1: 41 findings, all three
  skeptics refuted. Round 2: two errors unreachable behind gates that therefore could not pass, and
  **eleven invented citations** — a NIST sentence that exists nowhere, a wrong section cited inside a
  migration comment that ships in the tree. Round 3: a gate red on the unmodified tree, and a
  constant the whole binding rests on that was never defined. Round 4: the gate redesign red on the
  tree the order itself produces, and padding arithmetic short by four bytes in three places.
  **Three lessons generalise beyond this order and are worth carrying:**
  **(a) a fix can be a fix in name only** — sealing the binding inside the wrapped plaintext was
  meant to make a row moved between tenants report as *misbound*, and could not, because the same
  bytes were left in the KDF info and the AEAD associated data, so a swap failed authentication
  exactly like a wrong key. The binding had to MOVE, not be duplicated. A reviewer caught it by
  tracing the construction; no reading of the prose would have.
  **(b) rule 0 has a third instance, and it is in a gate nobody thought of as a safety gate.** The
  SQL-containment gate forbade twenty-one verbs inside string literals, two of which — `WITH` and
  `SET` — are ordinary English. Four error messages tripped it, so it was red before step 1.
  **(c) the redesign then reintroduced the same class of fault**, by splitting one rule into two
  ANDed halves and dropping `store.rs` from one of them, turning the gate red against the very
  module the order tells the executor to write. Splitting a rule is where its exceptions get lost.
  **The final audit found ZERO invented citations**, having opened every source the repair touched
  plus the lockfile, the crates.io index and the advisory database. Its verification is worth
  reading before adding to the order.
  **SO: this order wants a human read before anyone executes it.** Four rounds converging is not the
  same as done, and it says so in its own text. `wo-12-authoring.workflow.js` beside it is the script
  that produced it, kept for the record and for re-running a stage.
  **The two crypto crates it needs are already owner-approved** — `deps/decisions/argon2.md` and
  `chacha20poly1305.md`, 2026-08-15. Note the order does **not** take `subtle`: `ctutils` is already
  in the lockfile and `subtle` is not, and its Disagreements records the divergence from `32` §15.1.
  **The contradiction in §B1 is confirmed and sourced**: ADR-0003, *Accepted*, *"no hosted service,
  no accounts we run"*, against everything in `49`. That is the owner's, and it does not block WO-12.
  **WHERE THIS WORK LIVES — ALL OF IT IS ON `main` as of 2026-09-04.** PR #18 merged at `427757e`.
  This matters because for eighteen days it was not: PR #17 merged on 2026-08-17 and every commit
  since — the pivot, ADR-0038 to 0041, WO-10, WO-11, WO-12, this page — sat on a branch with **no
  pull request and no CI run at all**, so a session starting from `main` saw none of it. One did,
  on 2026-09-04, and had to go looking. **If this page ever again describes work you cannot find
  from `main`, check the branches before concluding it was never done.** The floor was run
  locally on the whole branch the same day: 792 tests, every gate green **except two that fired on
  the calendar** — the hyper cooldown exception expired as designed (row removed), and the
  offline lockfile check cannot pass on a cache-less runner now that the lockfile has 115 external
  crates (a locked fetch now precedes it in `ci.yml`). Both are in the commit that carries this line.
- **EVERY OPEN OWNER DECISION IS NOW ON ONE PAGE — `docs/70-ops/OPEN-FOR-THE-OWNER.md`,
  2026-09-04.** Twenty-seven questions in plain English, ranked by what blocks the server, from a
  ten-reader sweep of the whole corpus in which **every candidate was adversarially checked
  against later documents: 93 found, 42 were STALE markers already answered elsewhere, 51
  survived.** **Its §B is the most important thing on that page and it is new**: a final pass asked what a
  server product needs decided that a single offline file never did, and found **twelve questions
  nobody has ever put to the owner**, six of them blocking. The first is a **direct contradiction
  the corpus has carried since the pivot** — an accepted decision record says the project will
  never run a hosted service, and everything written since 2026-08-18 assumes it will. §A is the
  three the corpus already knew about: key custody (including for a customer with no cloud),
  whether the first release keeps an audit log, and the borrowed-code ceiling. **Do not re-derive this list; add to it and mark items answered.** The owner-blocked
  bullets scattered below and through `57` §14, `70` §10, `49` §22 and the ADRs are its sources
  and are now duplicative.

- **The three byte levers are RETIRED AS A PRIORITY** — the ceiling they existed to get
  under was removed on 2026-08-21 with the pivot (`49` §1). `47`'s measurements stand as
  history and one of the three still matters on its own merits: the generated dispatch as a
  table makes every future schema kind cheaper on both sides of the fork. Worth doing
  someday; blocking nothing. The finder-move lever stays **held** for the reason recorded:
  the finder as *specified* (`16` §16.1) walks the user's graph, so moving it puts
  estate-touching code outside the module boundary.
- **`57` §14.1's pile A is BUILT OUT — all five landed 2026-08-21/22**: `rack view` left the
  band (selecting a rack descends into its elevation); rung 4 draws the inside of a box;
  inventory cells are editable in place for fields the module says are writable (first press
  selects, second edits); the findings view reports the estate's gaps; and the inventory got
  Direction A. Each has a browser driver beside it in `docs/80-review/evidence/`. What pile A
  leaves behind: the **phone view** is still the placeholder the owner complained about — its
  branch (`worktree-wf_0a5147a2-769-3`) was verified but NOT merged after colliding with the
  cell-edit work in ten places, and needs a rebuild on the current base. Two of its
  narrow-width defects were fixed on HEAD directly on 2026-08-28 (kind-strip focus drop; the
  invisible tap response at 390px); the rest of the narrow findings wait for the rebuild.
- **The inventory's three-region defect is FIXED, 2026-08-22** (`57` §16 records the defect;
  the owner found it himself). Both views now share one collapse selector and one
  OBJECTS/DETAILS panel idiom — asserted by `2026-08-21-inventory-direction-a.mjs` (42
  checks), not just resembling each other.

- **Read `docs/70-ops/79-work-orders/00-ROUTE-TO-WORKABLE.md` for the route's shape, not its
  snapshot** (Proposed, 2026-08-10). Its numbers were measurements ON THAT DAY — *"1 of 6
  views live; zero lines of diagram; 42 Junos statements"* — and every one has since moved
  (four views live, the diagram shipped 2026-08-15, coverage measured in `66`). What is still
  load-bearing is its dependency ordering — nine stages — and §4's split between what
  genuinely needs the owner and what merely says it does. Written from six independent
  surveys each adversarially verified. **It disagrees with the program plan in three named
  places** (§5) — notably that persistence is hours-behind-a-decision, not unblocked days.
- **`00-PROGRAM-PLAN.md`** (Proposed) remains the long-term shape: eleven stages, the unwritten work
  orders, and the tier-ordered owner list. Its tier 1 is **overstated by 4×** — four of its five
  are already on disk. The queue below stays the operational truth; on disagreement the queue wins.
- **THE SERVER EXISTS AND IT STORES NOTHING — WO-11 DONE, 2026-09-03.** `crates/fathom-server`
  starts, answers `/health` after a real PostgreSQL round trip, shuts down on SIGTERM, and
  **creates exactly one table: the migrations table** (G8, and ADR-0040's key boundary is why —
  the first row written before custody is decided is the retrofit that ADR exists to prevent).
  Driven, not asserted: **17/17** against a real PostgreSQL stopped and restarted mid-run
  (`docs/80-review/evidence/2026-09-03-the-server-is-honest-when-the-database-is-down.sh`) and
  **20/20** against the composed stack over verified TLS (`…-the-stack-comes-up-and-tls-is-in-front.sh`,
  which proves verification is real by requiring an unrelated CA to be rejected). `deploy/` holds
  the compose file, a distroless Dockerfile and Caddy in front.
  **The real work of that order was the gate, and all five layers found something on a real
  arrival** — `gate-zero` (extended to know the closure pattern), `deny.toml` (source allowlist,
  licences, bans, duplicates), `cargo audit`, `scripts/lockfile-lookalikes.sh` (one-edit crate
  names — the August 2026 shape, mechanically) and `scripts/crate-cooldown.sh`. The cooldown
  caught **four young crates, three of them crates nobody chose and one published the same day**.
  **Zero external dependencies is spent: 115 in the lockfile, 91 compiling for the server, 6
  direct, 7 running code at compile time.** The client is untouched and proved so — the WASM
  module is byte-identical at **988,490 bytes** after a forced rebuild.
  **Two records were CORRECTED by what the gates found**, which is the part worth carrying
  forward: `deps/decisions/tracing.md` said a feature was "deliberately OFF" and that was false
  within one commit, because `deadpool-postgres` declares `tracing` without
  `default-features = false` and cargo unifies it back on — **a feature disabled in your manifest
  is a request, not a guarantee, and any claim of the form "we do not compile X" must be checked
  against `cargo tree`**; and the database-URL redactor printed a password when the `@` was left
  out of the URL, found by its own canary test.
  **ONE ESCALATION IS OPEN AND IT IS THE OWNER'S** (WO-11 §9.7): at 115 crates with four of
  `49` §6's sixteen rows in, `35` §5.1's ≤ 160 will not survive phase 1. Three routes are named —
  raise the cap, drop `openidconnect`, or split the cap between client and server, which are
  different binaries with different threat models and never had a reason to share one number.
  The trigger forbids exactly one thing: meeting the number by removing a control.
- **Phase 0 is complete and phase 1's first order is executed,
  2026-09-03.** ADR-0040 ratified key custody, closing `49` §22 decision 1 and the last DECISION
  item in phase 0, when the owner said *"start working on the server version"*. **The server
  holds the keys and says so**: a data key per tenant AND per design from the first stored byte,
  the wrap point built so a customer-supplied master key replaces the house key later by
  re-wrapping keys rather than re-encrypting data; destination named (customer-managed keys —
  what Slack, Salesforce, Atlassian, Miro and Lucid itself all sell), trigger named (**the first
  customer who is not the owner**). **Four sentences are forbidden in writing** until that is
  true for a customer — *zero-knowledge*, *end-to-end*, *we cannot read your data*, *only you
  hold the key* — and the one that is true stays: device credentials are protected by never
  arriving. **Invariant 4 is SCOPED, NOT DELETED** in `.context/conventions.md` (the first
  invariant in that file formally amended rather than merely re-read; ADR-0002's precedent cost
  paid in ADR-0040 §4), and **`38` §14's union rule is RATIFIED** after seventeen days cited as
  unratified — nothing arriving after the build may reduce what the ingest gate destroys, only
  increase it, with a CI check that makes it more than intent. **WO-11 was the first server order and it is DONE** —
  the owner lifted ADR-0032 §5's undelegatable-approval constraint the same day (*"Oh no you can
  use borrowed code"*) and asked for the better control instead (*"idk how we want to manage this
  if we can have git have some sort of security checker"*), so the order's step 0 became a
  five-layer gate design rather than 109 signatures. Its Disagreements §1 is now settled practice:
  109 individual owner approvals would be a WEAKER control than one closure document, because the
  only way one person finishes 109 is by skimming.
- **Engineering:** the queue. `docs/70-ops/79-work-orders/00-INDEX.md` — **ten of eleven DONE**;
  **WO-04 (the emitters) is the only open order.** **WO-10 (DHCP relay + bootp) is DONE as of
  2026-08-29** — schema 0.4 → 0.5: the `DhcpRelay` kind, `HasDhcpRelay`, `RelaysFor`, and
  `RelayServerIn`, the third edge the owner chose (*"1 now please"*, `70` §18.5) after the order
  stopped at its own Step 0 on 2026-08-28 because Juniper's grammar admits `routing-instance` on a
  `server` line. All seven gates green, +1,206 module bytes measured, six fragment tests,
  `2026-08-29-dhcp-relay-drive.mjs` 25/25. Coverage on the measured fixture is unmoved (it has no
  `forwarding-options` lines). **Executing it fired a new escalation, WO-10 §10 item 5, and it is
  the owner's next decision on this thread:** `RelayServerIn` is always a PENDING reference (nothing
  builds a `RoutingInstance` yet) and pending references are carried out of the weld, never stored
  (`14` §7.3) — so the paste shows `RoutingInstance c3 · RelayServerIn` in the inventory's pending
  table and a reload loses it. Three routes named there; the cheapest is binding
  `routing-instances`, which the routing view needs anyway. Every order carries its own plan,
  gates, and stop-and-escalate list; `78` governs.
- **A hand-typed value that looks like a password now carries a small black `!` beside it,
  and the value it sits beside is still stored and exported exactly as typed —
  ADR-0041, 2026-09-03.** The owner asked whether the server holds his device passwords, was
  told no, and a proving pass broke that answer: a PSK typed into an interface's `description`
  cell never goes near the ingest gate (`OP_PASTE` is its only caller) and sits in the export
  in plain text. His decision was to mark, never refuse — refusing is beaten by rewording and
  protects only the typist, where a mark protects the colleague who opens the design next.
  **What is NOT closed, on purpose:** the value is still stored and still exported unredacted.
  That is the decision, not a bug — `.context/conventions.md` invariant 3 is annotated,
  scope-only, to say so, and `2026-09-03-the-gate-is-only-on-the-paste-box.mjs`'s two original
  checks (the key is not in the export; it is not on screen) are written to fail and still do.
  What the mark covers: `fathom_ingest::redact::looks_like_credential` — one detector, reusing
  the paste gate's own word list and value-shape checks, nothing new — runs over every
  inventory cell and every field the inspector shows; a hit gets an inverted (`--ink`/`--page`,
  never a reserved risk colour) focusable `!` whose accessible name and, since a same-day
  proving pass found `title` is mouse-hover-only in every browser, whose VISIBLE text on
  keyboard focus too, both read: *"stored as typed — this looks like it may be a password or
  key. Fathom does not redact what you type, only what you paste, so it is saved and exported
  exactly as written."* **The mark is on every surface that renders the value, not just the
  inventory table** — the same proving pass found it missing from the inventory's own DETAILS
  pane and the diagram's own details panel (both call the identical `renderMeaningFace`) and
  that gap is closed the same day, in the same record: `FieldRow.hint` and a sixth `FACE_FIELD`
  wire slot carry the identical detector result there too. No schema change (ADR-0008 — the
  hint is an opinion, recomputed on every read, never written to the graph). `cargo test
  --workspace` 751/751 (+7 over the 744 pre-record baseline). Wasm release build 988,490 bytes
  (988,540 baseline, unchanged code path elsewhere in the module). Driven end to end:
  `2026-09-03-the-gate-is-only-on-the-paste-box.mjs` 23/25 — the two hole-proving checks fail
  by design, the other 23 (the mark's presence, wording, keyboard reach, the second-surface fix,
  and the visible-on-focus fix) pass — plus six unrelated regression drivers (drag-to-connect
  58/58, hand-placement 23/23, cabling 56/56, hand-link 31/31, the-cut-that-drew 18/18,
  inventory-direction-a 42/42) re-run with zero regression. **Open, in ADR-0041's own Open
  decisions:** the config viewer's rendering of the mark (the view does not exist yet); whether
  a server recomputes the hint on read; a credential inside a URL's userinfo, and most
  platforms still carrying no secret dictionary at all; and, added by the same-day proving
  pass, two verified but deliberately unfixed limits of the detector itself — it needs a
  `:`/`=` next to the secret word to fire, so `"password: X"` is marked and `"password X"` is
  not, and it never sees a column's own name, so a bare weak value in a plainly-labelled field
  (an SNMP community literally called `public`) passes unmarked. Both are judged real,
  deliberate trade-offs already reasoned about in `redact.rs`'s own comments, not defects —
  widening either risks flagging ordinary sentences the same reasoning was written to protect,
  and is left for whoever tunes the detector next rather than decided by editing a test.
- **A server is not a Juniper firewall — the equipment form's platform door is open, 2026-09-05.**
  Seen in Chromium 2026-09-04: the add-equipment form demanded `platform`, the dropdown offered only
  network operating systems with `junos-srx` pre-selected, so a VMware or Linux host was filed as a
  Juniper firewall and showed as one in the inventory — on the first screen of the estate the owner
  will demo (`70` §19.5, §20.4). `RECOMMENDATIONS-2026-09-04` §15 (D1) is the design and it is
  built: **`Device.platform` stays `card: "1"` — no schema change** (ADR-0008) — and the FORM submits
  with it blank (a blank is now the first option), so the store holds `Unknown`, the inventory shows
  `—`, and the findings view's existing gaps walk (card 1 + Unknown) lists *"1 of 1 Device nodes has
  no platform"* as work the inventory can take. `hostname` is still demanded at the door. **The trap
  the skeptic found is closed in the same change**: with the platform Unknown a later paste of that
  box's real config matched nothing term by term (`field_text` is `None` for `Unknown`) and welded a
  SECOND box silently, under the paste hint's promise that *"a config naming a device you already
  have will ask before it adds a second one"*. `identity_clash` now treats a **required** term the
  estate holds as `Unknown` as a question, not a mismatch — read from the generated
  `field_required`, never hand-listed, and deliberately not any `Unknown`: `management_address` is
  `0..1` and unset nearly everywhere, and the day a dictionary binds one every same-platform paste
  would otherwise ask about every box. A tier still needs one term actually EQUAL. The sentence says
  which: *"the same hostname, and its platform was never filled in, so this may be that box"*; the
  all-equal sentence is unchanged to the character and a test pins it. The hint's words did not
  move — the behaviour they describe did. **A CLEAR IS BUILT** (§15.1 fix 3 promoted it from
  "verify" to a deliverable): an empty `OP_FIELD_SET` value runs `Graph::clear_field` — `11` §8.5's
  `Unknown`, never `Absent` — journalled as an ordinary `field` entry with an empty value and
  replayed through the same frame; clearing a slot that holds nothing is refused (*"nothing to
  clear"*) so an Enter on an empty cell records no claim. Both page editors (the inventory cell and
  the details pane) that said *"clear is not built yet"* now send the blank. Boxes already added as
  `junos-srx` are NOT rewritten (a `Set` value is a stored assertion); the clear is how the owner
  takes the borrowed value out by hand. **Module 988,825 → 990,109 bytes (+1,284)**, read off the
  build. `2026-09-04-a-server-is-not-a-juniper-firewall.mjs` **33/33** through a real export →
  reload → import. Run against the build before this change it is 9 red and then a timeout: the
  blank option, the required mark, the hint, the `junos-srx` in the cell, the three findings checks,
  the sentence, the drawn box's platform — and the blank cell commit never returns because the page
  refused it. The silent second box itself cannot be driven on that build (its form could not
  submit a blank), so it is pinned in Rust instead — `paste.rs`'s
  `a_platform_less_hand_added_box_with_the_pasted_hostname_asks` fails with the wildcard branch
  neutered, checked by neutering it. What is NOT done, on purpose: no `proxmox-ve` registry row
  (its trigger is a real capture off a box — `platforms.yaml`'s own rule), no `doc:` edit to the
  schema file (it would move the generated content hash for a comment; the reasoning is in
  `shell.rs` at the door), and no hostname-only re-identification — the one answer offered is still
  *"different boxes"*, and *"same box, newer config"* is still remove-and-paste-again.
  **Repaired 2026-09-05, the same day, after a skeptic attacked the clear:** it bypassed the gates a
  SET runs, because the only place `is_authorable` was enforced (`parse_into_slot`) never saw an
  empty value. **The clear now has a floor and runs the gate, all before any batch opens.** (1) A
  `field` op with an empty value on a key nothing can type — a hand-edited journal blanking
  `SecurityPolicy.action` — is refused with the sentence a typed value gets (*"cannot be typed in
  yet"*) instead of replaying as *"opened a workspace — 6 steps replayed"*; the journal is the file
  an operator keeps, and ADR-0038's rule holds: refused, never guessed through. (2) A key the
  element's kind does not declare is refused in English, code 11, on both paths — it used to open a
  batch, surface `UndeclaredField { … }` as Rust debug text, and leave an EMPTY batch in the log.
  (3) **What the add door demands cannot be cleared**: `DOOR_DEMANDS` in `shell.rs` is the one list
  the door and the clear both read (today `Device.hostname`), so blanking a hostname is refused —
  *"a box needs a hostname — type a new one instead of clearing it"* — through the one refusal path
  both page editors already use, with no page change. Before, two steps produced a box the door would
  have refused, and a hostname-less `junos-srx` box made EVERY junos-srx paste ask *"this may be that
  box"*. Module 990,109 → 991,123 bytes (+1,014), read off the build. `crates/fathom-wasm/tests/
  clear.rs` (four tests, three red on 1e0465a) and the driver 33 → **46/46**, **32/46 on an artifact
  built from 1e0465a**, now driving the details-pane editor as well as the cell.
- **Raised by the on-ramp (2026-08-09), all three now settled:** (a) the ceiling question
  is CLOSED — removed 2026-08-21 with the pivot, and the dictionary had already moved out of
  the module to the page on 2026-08-15; (b) `OP_PASTE` is ADDITIVE as of 2026-08-21, with the
  duplicate-box question (`ERR_PASTE_CHOICE`) standing in where `70` §6's correlation is still
  unbuilt — a match asks, never merges; (c) `set system domain-name` and `set interfaces …
  description` bind (shipped 2026-08-15, before this line was last true), and `set security
  policies` (bare stanza, both `match …-address any` forms, `then permit`) binds too as of
  2026-08-28 — rung 4's policy band is no longer empty on a Junos paste that carries policy
  lines; `match application …` is the one part of that section still residue, for want of a
  `match_any_application` field.
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

The verification floor (`78` §6) is **sixteen rows as of 2026-09-04**, and CI runs every one of
them but the last. (This line read *"thirteen"* until 2026-09-04; `78` §6's table has sixteen and it
is the authority. Counted, not estimated.) **The first nine run BEFORE anything compiles**, which is the control and not a
preference: a crate's `build.rs` executes on the machine before any gate that runs after
compilation can produce a result.

The dependency gate — five layers, none of which subsumes another, all added by WO-11:

- `./scripts/gate-zero.sh` — a crate with no approval record. It now knows the **closure pattern**:
  a DIRECT dependency always needs its own `deps/decisions/<crate>.md`; a transitive one may be
  carried by an approved closure document.
- `./scripts/lockfile-lookalikes.sh` — two packages whose names are one edit apart, which is the
  August 2026 attack's shape (`proc-macro1` beside `proc-macro2`) made mechanical.
- `./scripts/crate-cooldown.sh` — any crate version published less than seven days ago. Reads the
  publication date from `static.crates.io`. Exceptions live in
  `deps/decisions/00-COOLDOWN-EXCEPTIONS.md` and **expire**.
- `cargo deny check` — source allowlist, licences, the ban list (`proc-macro1`, and `ring` /
  `aws-lc-sys` / `openssl-sys` / `native-tls`, which is C7 made mechanical), duplicate versions.
- `cargo audit --file Cargo.lock` — the RustSec database.
- The gates' own tests: `scripts/tests/gate-zero-test.sh` (10),
  `…/lockfile-lookalikes-test.sh` (10), `…/crate-cooldown-test.sh` (18),
  `…/forbidden-claims-test.sh` (11), plus `…/advisory-gate-test.sh` (3), which is `cargo audit`'s
  positive control. **There are five, not the four this line listed until 2026-09-04** —
  `forbidden-claims-test.sh` was missing here while running in both `78` §6 and `ci.yml`.

`cargo deny` and `cargo audit` are **pinned, checksummed release binaries**
(`scripts/ci/fetch-audit-tools.sh`), never `cargo install`: building either from source compiles
~200 crates and runs their build scripts, which is the hazard they exist to gate.

**And the gap that is stated everywhere it applies rather than papered over: NOTHING SANDBOXES A
BUILD SCRIPT.** Stable Rust has no equivalent of *install without running scripts*, which is
exactly how the August 2026 payload ran. The source allowlist, the reviewed lockfile diff and the
cooldown are the mitigation — not a sandbox, because there is not one.

Then the four that predate it:

- `cargo fmt --all --check` — no output.
- `cargo clippy --all-targets -- -D warnings` — clean.
- `cargo test --workspace --locked` — 817 tests as of 2026-09-05 (792 on 2026-09-03; the day's
  four fixes and three repairs added 25); green is the gate, not the number. Zero ignored, zero filtered: no test was weakened to reach it.
- `cargo run -p fathom-schema --bin fathom-schema-check` — exit 0, **0 failures and 0
  warnings** since 2026-08-09. The two standing `schema.identity.unexercised` warnings
  against `Site` are gone because `Site` and `Device` now declare identity tuples
  (`70` §16.3); `crates/fathom-schema/tests/shipped_tree.rs` pins the empty set, so the
  next warning of any code fails a test.
- `./scripts/gate-zero.sh` — exists since 2026-08-15; fails the build if `Cargo.lock` holds an
  external package with no `deps/decisions/<crate>.md` beside it (ADR-0032 §6).
- `cargo build --locked --release --target wasm32-unknown-unknown -p fathom-wasm` — builds
  clean. **The 900,000-byte ceiling was removed 2026-08-21** (`49` §1; the owner chose remove
  over raise, and `artifact_gates.rs` records why in the code): the size is now REPORTED on
  every `artifact_gates` run, not gated. Read the number off the run — do not quote one from
  a document, including this one; at least five ceiling-era totals are still in circulation.
- The executing work order's own acceptance gates, exactly as written.

**Two more gates need a running PostgreSQL and belong to the executing order rather than the
floor**, both in `docs/80-review/evidence/`: `2026-09-03-the-server-is-honest-when-the-database-is-down.sh`
(17 checks — it stops PostgreSQL and requires `/health` to say so) and
`2026-09-03-the-stack-comes-up-and-tls-is-in-front.sh` (20 checks against the composed stack).
Both need `docker`; neither runs in CI today.

Interactive artifacts open from disk with zero network; the transcript face in
`fathom-app.html` reads its own CSP from the live page.
