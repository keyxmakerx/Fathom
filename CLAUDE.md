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

- **A week of design is on disk and none of it is built — `docs/50-design/57-the-zoom-ladder-and-the-trace.md`,
  2026-08-18.** It began as a complaint that `rack view` sat in the band's data-entry row and
  opened into the product's shape. **Read `57` §14 before planning anything**: it sorts every
  raised item into *buildable now* (four, page-side, no decision needed), *blocked on the owner*
  (five, all cheap-now-expensive-later), and *blocked on bytes* (everything else). The honest
  summary is in its own §14: **the design has outrun the build capacity — eight unbuilt designs
  against 203 free bytes** — and every road out runs through `47`'s levers, none of which is
  proved. Four findings from it bind future work:
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
- **One schema decision is a hard blocker and it is the owner's** (`57` §13.5, open decision 8):
  **does `PhysicalPort.label` become `0..1`?** It is `card: "1"` today — the silkscreen, required.
  Under the drag-then-annotate capture the owner specified, *"there is a port and I do not know
  which"* is the normal state of every freshly-drawn cable rather than an edge case, so a schema
  that cannot say it cannot record the primary gesture. **Nothing in `57` §12 or §13 is buildable
  until this is answered.**
- **The parse-server question is answered and the answer is no server — `38` §14, 2026-08-17.**
  Six designs, each attacked by an independent reviewer. The finding in one line: *we were about
  to move a customer's firewall config off his machine because a lookup table got compiled as a
  chain of `if` statements.* The largest zero-egress lever is 1.9× the entire prize of the server
  that would have read the config. Two live defects came out of it: the shape sketch publishes the
  exact byte length of every secret it destroys (§14.9, open), and `snmp.trap-group` had exactly
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
- **PHASE 0 IS DONE, 2026-08-21** (`49` §19). All four: the secret-length leak closed; every op
  carries an author and a sequence number; a paste records what it produced and says so when a
  replay diverges; and **`OP_PASTE` adds to the design rather than replacing it**.
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

- **Friday, when usage resets: prove the three byte levers first.** `47` names three — one
  generated dispatch emitted as a table rather than a branch tree (~11,089, mechanism
  corroborated, headline unreproduced), the store's eight `BTreeMap`s as sorted vectors
  (~45,549, unreproduced), six sort sites as one shared insertion sort (~25,125, unreproduced).
  **~81,000 bytes claimed against 203 free and 602 needed for the next feature.** A run to prove
  all three was started 2026-08-17 and stopped in its first minute for cost. It is the single
  highest-leverage unproven claim in the project: **an entire category of blocked work empties
  the moment it lands**, and the first lever makes every future schema kind cheaper, which
  changes the economics of everything left. The fourth lever — moving the finder out, 220,289
  measured twice — is **held, not recommended**: today's finder reads only the public corpus, but
  the finder as *specified* (`16` §16.1) walks the user's graph, so moving it puts estate-touching
  code outside the module boundary.
- **Five things are buildable with no decision and no bytes** (`57` §14.1 pile A): move `rack
  view` out of the band so selecting a rack is how you get an elevation; build rung 4, the inside
  of a box, which is the largest design gap and needs no new kind; make inventory cells editable
  for fields that already exist, since `OP_FIELD_SET` is already there and only reach is missing;
  give the empty findings view its first job as *what the estate does not know yet* — "17
  cables have no far port"; and **give the inventory Direction A's treatment, which it never got**
  (`57` §16). A session with no owner available should go here.
- **The inventory still has the three-region defect Direction A was written to fix** — `57` §16,
  found 2026-08-18 by the owner in a rebuilt artifact: *"when you are looking at equipment and
  click on it, you have like 3 pages opened, it was too much and you couldn't see anything."*
  `.sheet[data-viewing="diagram"] .ledger { grid-template-columns: 1fr }` collapses the 62/38
  ledger **for the diagram only**; the inventory still renders kind strip + table-at-62% +
  meaning column. Fixing one of the two places a defect occurs is worse than missing it, because
  the two views now disagree about an idiom whose whole point was that they would not. The fix is
  the diagram's own, page-side, and needs no decision. **Its browser drivers will break exactly as
  the diagram's three did** — click a row, the panel turns to DETAILS, the next row is gone — and
  the three-line helper in `2026-08-16-hand-link-drive.mjs` is the fix.

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
- `cargo test --workspace --locked` — 656 tests as of 2026-08-17; green is the gate, not the
  number. Zero ignored, zero filtered: no test was weakened to reach it.
- `cargo run -p fathom-schema --bin fathom-schema-check` — exit 0, **0 failures and 0
  warnings** since 2026-08-09. The two standing `schema.identity.unexercised` warnings
  against `Site` are gone because `Site` and `Device` now declare identity tuples
  (`70` §16.3); `crates/fathom-schema/tests/shipped_tree.rs` pins the empty set, so the
  next warning of any code fails a test.
- `./scripts/gate-zero.sh` — exists since 2026-08-15; fails the build if `Cargo.lock` holds an
  external package with no `deps/decisions/<crate>.md` beside it (ADR-0032 §6).
- `cargo build --locked --release --target wasm32-unknown-unknown -p fathom-wasm` — **899,797 bytes
  against the 900,000 ceiling, which is 203 of headroom** (2026-08-17, after the `trap-group`
  detector). Measure, never estimate;
  `scripts/byte-census.sh` says where they go. **At this margin the ceiling decides what ships
  next**: the rack, the OPNsense engine, the roles and the links between them spent the last of it,
  and the only lever left is float handling (~44,825), which is ring-fenced for encryption and is
  the owner's to spend. The next feature of any size does not fit until that decision is made.
- The executing work order's own acceptance gates, exactly as written.

Interactive artifacts open from disk with zero network; the transcript face in
`fathom-app.html` reads its own CSP from the live page.
