# 88 — State review: the decisions that were accepted and never executed

> **Status:** Proposed

An independent review of the whole tree as it stands on 2026-08-06, against the code, the schema,
the corpus and the queue rather than against other documents. It answers one question: **if the
next session opens the queue and starts building, what does it hit?**

The answer is not "the corpus is wrong". The corpus is in unusually good shape, and §6 records what
was checked and found clean so nobody pays to re-check it. The answer is that **five of the first
six ADRs order specific, named edits to specific files, and those files never received them** — so
the binding documents every session reads first now disagree with the decisions that were supposed
to have replaced them. Everything in §3 is a consequence of that one habit.

This is a review, not an execution. Nothing in the tree was changed. Every finding names the
smallest fix and whose job it is under `78` §7, and nothing here decides anything: a finding that
proposes a decision is marked **owner** and stays open.

## 0.0 What has already been closed

On the owner's authorisation, the two one-line safety edits and every finding that was a pure
factual correction were applied in the same pull request as this document. **Nothing that touches a
fork was applied.** The floor was re-run after: fmt clean, clippy clean, 80 passed / 0 failed,
schema check exit 0 with the two standing `Site` warnings.

| Closed | What changed |
|---|---|
| §4.1 | `rust-toolchain.toml` gained `targets = ["wasm32-unknown-unknown"]`, outside the queue. WO-07 §4/§4.1/§5 step 1 now say the line is already on disk and is not that order's to touch, and §4.1 quotes `78` §5 item 7's no-exception sentence. `rustup` installed the target cleanly and `cargo build --target wasm32-unknown-unknown` is reachable, so WO-07 §3 probe 1's precondition holds here |
| §4.2 | `.context/conventions.md` § *Identifiers* is now `<kind-lower>:<ulid>` (ADR-0005 action 1). The five citations in WO-02, WO-05 and WO-08 are corrected and name the ADR; `11` §21's two are too. The three surviving `fathom:<…>` strings are in ADR-0005's own Context and `73`'s D04 — historical record of the state the decision replaced, correctly left alone |
| §5.1 | WO-01 §4 and WO-07 §4 gained the `Cargo.lock` row and the clause WO-02/04/05/08 already carry |
| §5.2 | WO-05's G3 is the path-scoped form, with WO-02's *"the unscoped tree is dirty at this step by design"* note |
| §6.1–6.5 | README 41 → 42 explainers; README *"One warning"* → *"Two warnings"*; README gained rows for `87` and this document; `78` §12 item 3 restated as closed and §3 step 2's satisfied `<!-- VERIFY -->` deleted; the four `if the index exists` hedges dropped from WO-01, WO-02 and WO-07; WO-06 §4.6's two rows now name WO-08, quoting WO-07 §8's own non-goal |
| §6.8 (part) | The five `34 §14` citations corrected to `34 §7.5` in `58`, `fathom-app.html` and `04-console.html`. `34` ends at §13; §7.5 is the import allowlist, cited as such at `34`:1525 |

**Still open and untouched:** §4.3, §4.4, §4.5, §5.3–§5.11, §6.6, §6.7, the rest of §6.8, §6.9–§6.13
— and all seven questions in §8. Every one of them either needs an owner decision or changes
something a reasonable person could do differently.

## 0. Contents

| § | | margin tab |
|---|---|---|
| 1 | Method, and what binds this document | *how it was produced* |
| 2 | The verification floor, re-run | *the tree is green* |
| 3 | The pattern: accepted, then not executed | *read this first* |
| 4 | Blockers — five | *the queue cannot run past these* |
| 5 | Majors — eleven | *real, not urgent this hour* |
| 6 | Minors — thirteen | *cheap, do them in one pass* |
| 7 | What was checked and found clean | *do not re-buy this* |
| 8 | The questions only the owner can answer | *seven, in one sitting* |
| 9 | A recommended order | *the shortest path to a runnable queue* |
| 10 | Failure modes |  |
| 11 | Open decisions |  |
| 12 | Sources consulted |  |
| 13 | Disagreements |  |

---

## 1. Method, and what binds this document

This is a **planning-shaped** review under `78` §7: it authors no work order, executes none, and
edits nothing outside this file. `78` §1 puts the answers to everything below with the owner or a
planning session.

Seven areas were reviewed independently — the pickup layer, the plan layer, the core specs against
the crates, the schema and corpus, the thirty ADRs, security and stack, and ops/design/the prior
critiques — and every finding was then handed to a separate adversarial pass instructed to refute
it by re-reading the cited files. **Forty-five candidate findings were raised; sixteen were refuted
and discarded**, including several that read well and were simply wrong (see §13 item 2). What
survives below was proved twice, against paths, line numbers and command output, and the five
blockers were then re-proved a third time by hand.

Two conventions from `.context/conventions.md` bind this document as they bind every other: no
number and no citation is invented, and severity is exactly BLOCKER / MAJOR / MINOR (`80` §0.1).

## 2. The verification floor, re-run

`78` §6's floor, run in order on 2026-08-06 against the working tree:

| Command | Result |
|---|---|
| `cargo fmt --all --check` | No output, exit 0 |
| `cargo clippy --all-targets -- -D warnings` | Clean, exit 0 |
| `cargo test --workspace --locked` | 80 passed, 0 failed |
| `cargo run -p fathom-schema --bin fathom-schema-check` | Exit 0 — `48 kinds · 89 edges · 61 scalars · 10 enums · 14 files parsed`, `0 failure(s), 2 warning(s)` |

The two warnings are the standing `schema.identity.unexercised` baseline against `Site`, exactly as
`CLAUDE.md` and `78` §6 predict. **Every number `CLAUDE.md`'s *Verify before you trust* section
claims is correct today.** The floor is not where the problem is.

## 3. The pattern: accepted, then not executed

`CLAUDE.md` rule 2 says ADRs are *"binding once Accepted"*. Twenty-nine of the thirty are Accepted.
The tree treats that status as a record of a conclusion rather than as an instruction to change
files, and the result is that the first six decisions — the ones the ADR index itself calls the
ones that block everything else — are mostly unexecuted:

| ADR | What it ordered | State on disk |
|---|---|---|
| **0001** | *"`docs/00-vision/01-ownership.md` is created … before any other item in this ADR set is executed"* | `ls docs/00-vision/` returns three files; the ownership register does not exist |
| **0002** | *"one edit to `conventions.md`, made once"* — replacement texts for invariants 1, 3, 4, 7, 9, three terminology rows, and the `none \| bounded \| material \| total` residual scale | `.context/conventions.md` carries every pre-amendment text. `grep -c "bounded\|residual"` returns **0**. Only the `22-agent-catalog` → `22-subagent-catalogue` rename landed |
| **0004** | Apache-2.0 core, CC BY-SA 4.0 corpus, `LICENSE`, `NOTICE`, DCO | No `LICENSE`, `NOTICE` or `CONTRIBUTING.md`. `Cargo.toml:14` is `license = "UNLICENSED"`. 45 commits on a GitHub remote, zero `Signed-off-by` trailers |
| **0005** | *"before `fathom-id`'s first commit"*: `conventions.md` § *Identifiers* changes to `<kind-lower>:<ulid>` | `.context/conventions.md:78` still reads ``fathom:<kind-lower>:<ulid>``. The crates are clean; three work orders are not (§4.2) |
| **0006** | Six named edits to `71` — reverse §3.2's delete instruction, name phases 0–3 a product, add a corpus column to §2's totals | `rg -c 'ADR' docs/70-ops/71-roadmap.md` → **0**. `71` still ends *"delete it at the end of phase 0"*; §2's totals still read `106–158 wk` with no corpus column |

ADR-0002's own Alternatives table rejects the workaround the tree has effectively adopted: it
explicitly refuses *"Add a `Superseded` note to `conventions.md` instead of editing it"*. ADR-0001
item 1 says its register is written *before any other item in this ADR set is executed*, so the set
was never started in the order it specifies.

**Why this matters more than any single finding below.** `CLAUDE.md` rule 1 routes every session to
`.context/conventions.md` first and calls the ten invariants binding. A session therefore builds
against sentences that two Accepted decisions retired — including the security claim a reader is
most likely to quote back. Invariant 3 on disk reads *"The application never accepts a credential"*;
ADR-0002's replacement is *"The application stores no device credential"*, with an explicit carve-out
for a pasted capture that **may contain one** and is redacted at the ingest gate. Those are different
promises, and WO-03 builds the redaction gate that only the second one permits.

The cheapest structural guard is one sentence, and it is §6.9 below: an ADR is not done when it is
Accepted; it is done when the files it names have changed.

## 4. Blockers — five

### 4.1 WO-07 orders an edit that the protocol forbids with no exception

`WO-07-the-wasm-shell.md` §4's Deliverables table opens with `| rust-toolchain.toml | Adds the
target line, verbatim (§4.1) |`, and §5 step 1 instructs the session to apply it.

`78` §5 item 7 names `rust-toolchain.toml` in the list a session **never touches**, and then closes
the door explicitly: *"`.context/`, `CLAUDE.md`, this protocol, `docs/90-decisions/`,
`rust-toolchain.toml` and `.github/workflows/` admit no work-order exception — a work order
instructing such an edit is malformed under §8: escalate it, do not execute it."* The one exception
`78` grants is scoped to `Cargo.toml`/`Cargo.lock`. WO-07 §11 cites `78` for *"§5.7's verbatim-edit
rule for the manifests"* — the permissive half — and never the sentence that excludes the toolchain
file. None of WO-07 §7's eleven stop-and-escalate triggers covers it.

WO-07 sits at **queue position 4 with no dependencies**, so it is reachable now. A session that
obeys the protocol stops at plan step 1; a session that obeys the work order breaks the protocol.
Nobody can execute it as written.

> **Fix (planning + owner).** Make the one-line `targets = ["wasm32-unknown-unknown"]` edit to
> `rust-toolchain.toml` directly, outside the queue, then rewrite WO-07 §4 / §4.1 / §5 step 1 to say
> the line is already on disk and is not this order's to touch. Do **not** widen `78` §5 item 7 —
> the toolchain pin is exactly what the ban protects.

### 4.2 Three work orders instruct the ID form ADR-0005 exists to prevent

ADR-0005 (Accepted, R3 today / **R5 the day a public artifact carries a name**) decides that the
product name *"may not appear in any identifier, file magic, MIME type, ID prefix or on-disk key"*,
and its action 1 is one edit to `.context/conventions.md`. That edit was never made, so the binding
conventions file still specifies `fathom:<kind-lower>:<ulid>` — and the queue inherited it:

| Where | What it instructs |
|---|---|
| `WO-02-the-graph-store.md:242` | *"`Display` renders the conventions' form `fathom:<kind-lower>:<ulid>`"* |
| `WO-05-the-workspace-file.md:98, :215` | Cites the stale conventions line as binding authority, then specifies the same `Display` |
| `WO-08-the-inventory-face.md:248, :373` | Same form, in the inventory row type |

`grep -rn "adr-0005\|ADR-0005" .context/ docs/70-ops/79-work-orders/` returns **nothing** — no work
order knows the ADR exists. The crates are currently clean (`fathom-id` mints no prefix), so the
cost is still one edit.

WO-02 is the queue's main unblocker: WO-03, WO-04, WO-05 and WO-08 all depend on it. Executing it as
written writes the product name into the rendered form of every node ID, which is the exact outcome
ADR-0005 prices at R3→R5. `78` §5 item 4 forbids a session from knowingly contradicting an ADR and
§5 item 7 forbids it from editing `.context/`, so the only protocol-correct outcome is an escalation
that stalls the unblocker.

> **Fix (owner, one line; then planning).** Change `.context/conventions.md:78` to
> `<kind-lower>:<ulid>`, then correct the five citations in WO-02, WO-05 and WO-08 and add ADR-0005
> to their Binding sources tables.

### 4.3 The binding conventions file carries texts two Accepted ADRs retired

§3's table, rows ADR-0001 and ADR-0002. Stated as a blocker rather than a major because
`CLAUDE.md` rule 1 makes this file the first thing every session reads, and because the specific
sentence that is wrong is the project's headline security claim.

> **Fix (owner or planning, one sitting).** Paste ADR-0002's five replacement invariant texts, the
> residual scale and the three terminology rows into `.context/conventions.md`, and add ADR-0001's
> precedence paragraph. If the full edit is not wanted today, the minimum is invariant 3, because it
> is the one that is *false as written* and the one WO-03 will build against.

### 4.4 The queue builds the product ADR-0006 says is not v1

ADR-0006 (Accepted, R5): *"**v1 = the finder.** … **Nothing about a graph.**"* Its item 5 puts the
CLI in phase 0 as *"the only thing that makes `fathom golden` and the determinism claim testable"*.

`00-INDEX.md`'s eight rows are `76` §7.2's build order instead. Six of the eight (WO-01 scalars,
WO-02 graph store, WO-03 ingest, WO-04 emitters, WO-05 workspace file, WO-08 inventory face) are
graph work; WO-02 says so in its own words — *"`76` §7.2's S3 slice"* — and WO-08 calls itself
*"S4 slice, part one"*. WO-06 is not the finder-as-v1 but a closeout: *"Every edit is doc-comment,
test or prose-level."* There is no CLI crate and no CLI work order, so the determinism claim
(invariant 9) has no testing surface.

`76` itself flagged this and asked for a decision — §8 Q11 — and the question is unanswered.
`ls docs/90-decisions/` ends at `adr-0030`; ADR-0006 still reads `Accepted` with `Supersedes: —`,
and nothing supersedes it. The reversal was absorbed rather than recorded, which is precisely what
the register exists to prevent.

> **Fix (owner, one sentence; then planning, one ADR).** Answer `76` §8 Q11 — is v1 still the
> finder, or is it the inventory face? — and record it as ADR-0031 with ADR-0006 marked
> `Superseded by`. Either answer is defensible; leaving both documents Accepted is not.

### 4.5 The pack's highest-value rule anchors on an edge the engine cannot bind

ADR-0029 (Accepted) correction 1 ordered rule `zone.host-inbound.ike-missing` re-anchored to
`ZoneMember`. It now reads `applies_to: kind: ZoneMember`
(`corpus/rules/ipsec-junos-srx.yaml:446`).

`schema/schema.yaml:1614` declares `- edge: ZoneMember`, inside the `edges:` block. There is no
`- kind: ZoneMember` anywhere in the file. `63` §7 says of `kind`: *"Must exist in the schema.
Findings attach here"*, and `12` §4 makes it concrete — `pub anchor: KindId`, and
`pub struct Instance { pub rule: RuleId, pub anchor: NodeId }`. An edge has no `NodeId` and no
`KindIndex` entry. The bindings compound it: `zone: { via: from }` and `unit: { via: to }` are edge
ends, where `63` §7 requires `via` to be *"One edge role"*.

`87` §3 records this as *"RESOLVED (rule) — re-verified: anchored on `kind: ZoneMember`"*. The
re-verification confirmed the text and not the type.

> **Fix (owner decision, then planning).** Someone must decide in writing whether a rule may anchor
> on an edge at all. Either (a) re-anchor to `LogicalUnit` or `Zone` and read the per-interface set
> *across* the `ZoneMember` edge as a binding — editorial; or (b) extend `12` §4 and `63` §7 so an
> edge can be an anchor, which means findings attach to edge ids and is a real engine change.
> Until then `87` §3's RESOLVED should be reopened.

## 5. Majors — eleven

| # | Finding | Fix, and whose |
|---|---|---|
| 5.1 | **WO-01 and WO-07 order manifest edits without the `Cargo.lock` hunk** `78` §5 item 7's exception requires. `rg "Cargo\.lock"` returns nothing in either file; WO-02, WO-04, WO-05 and WO-08 all carry the clause. CI runs `--locked`, which fails outright on a stale lockfile | One sentence each, copied from WO-02:225. Planning |
| 5.2 | **WO-05's gate G3 cannot pass where its own plan runs it** — an unscoped `git status --porcelain` at step 12, against a tree its steps 5–11 leave dirty by design. WO-02's G3 solves the identical problem with a path-scoped form | Copy WO-02's path-scoped gate and its *"the unscoped tree is dirty at this step by design"* note. Planning |
| 5.3 | **The fragment-to-store weld work order does not exist and is on no backlog.** WO-04's dependency line names it as *"a work order that does not exist yet"*; `00-INDEX.md`'s owner-blocking paragraph and `CLAUDE.md`'s planning list both omit it. Without it WO-03 produces a typed fragment nothing can load, and WO-04's round-trip gate G8 — the proof Fathom can read a config and write it back — can never arm | Two lines today: name it in `00-INDEX.md` and `CLAUDE.md`. Authoring it is planning |
| 5.4 | **Invariant 8 (`acceptable_when` mandatory) has no mechanical check.** `rg acceptable_when crates/` returns nothing; `RuleLite` carries only `id` and `reviewed_by`. `63` §19 gates V3/V4 are error-level in prose and absent in code. All 37 rules do carry the field — by discipline, not by gate | A few lines in `fathom-corpus`: parse the field, check present and ≥40 chars. Makes `cargo test` the enforcement point today. Execution-sized once a work order names it |
| 5.5 | **`63`'s own domain enum rejects two of `63`'s own worked rules and two shipped rules.** §4.1 lists eight domains; §17.3's worked rule is `tunnel.st0.zone-unbound` and §18 lists `policy.zone-pair.missing`, and both ship. Sibling `61` §3.3 has a maintained thirteen-domain enum. Gate V1 is error-level | Extend `63` §4.1 to match `61` §3.3, or point `63` at `61` as the owner. Planning — and worth doing before the pack ships, because rule ids are stable forever |
| 5.6 | **The whole rule-pack distribution layer is prose only** — no `pack.toml` anywhere, no blake3 in any crate, no signing, no fixtures, no work order — while 37 rules sit in the tree. The corpus file says so itself: *"Until those exist these are specifications of rules, not rules"* | Not "build it now": make the absence visible. One row in `00-INDEX.md`'s owner-blocking list. Planning |
| 5.7 | **"Zero external dependencies" is the most binding constraint in the tree and no decision record owns it.** `73`'s forks run D01–D23 and none is the dependency policy; `78` §12 item 5 concedes its own citation for it was wrong. It blocks specified deliverables in **five of eight** orders — WO-06 (`fst`/zstd/blake3), WO-01 (`proptest`), WO-03 (cargo-fuzz), WO-04 (a hash crate), WO-08 (a browser driver) — each deferring it separately to "planning". ADR-0019 already decided the opposite for the UI toolchain | **One ADR unblocks five orders**: zero crates, or `35` §5.1's ≤ 30 with §5.3's per-addition review. Owner decides; planning drafts. Amend ADR-0019 in the same pass |
| 5.8 | **ADR-0004 decides three licences and a `LICENSE` file; the tree says `UNLICENSED` and has none.** No `LICENSE`, `NOTICE`, `CONTRIBUTING.md` or `SECURITY.md`; `Cargo.toml:14` is `license = "UNLICENSED"`, inherited by all six crates; 45 commits on `github.com/keyxmakerx/Fathom` with **zero** `Signed-off-by` trailers. `74` §D4 warns retrofitting a DCO *"requires re-attestation from every author"*, and that cost grows per commit | Half an hour, owner-only: `LICENSE`, `corpus/LICENSE`, `NOTICE`, `CONTRIBUTING.md`; change `UNLICENSED` to `Apache-2.0`. ADR-0004 and `74` §8 already specify the wording |
| 5.9 | **ADR-0030's PAN-OS case is unreconciled with the domain shift.** Its argument is which platform is second *for the SRX/IPsec domain*; `76` §7.2's S0 is ADR-0030's spike pattern re-aimed at Calix/Nokia — same deliverable, different vendor, now slice zero. `schema/platforms.yaml` already carries `calix`, `nokia`, `adtran`; `panos` has no corpus and no hardware. `76` §8 Q10 is unanswered | Fold into the §4.4 sitting: answer Q10 (is SRX/IPsec retired, carried, or frozen?), then one paragraph on ADR-0030. Owner |
| 5.10 | **ADR-0006's six named roadmap edits were never made.** `rg -c 'ADR' docs/70-ops/71-roadmap.md` → 0 (same for 72, 73, 74; but 75–78 and the design docs all carry ADR amendments, so the omission is localised). `71` §2's totals still read `106–158 wk` with no corpus column; §3.2 still says *"delete it at the end of phase 0"*. `71` **was** edited since — `87` §4 records propagating corpus counts into it — so it was maintained selectively while the re-cut was skipped | Execute ADR-0006's six items in `71` (the ADR states each precisely), or put a two-line superseded banner under `71`'s status line pointing at `76` §7.2. Planning. Do not leave it: `71` and the queue describe two different projects |
| 5.11 | **ADR-0026 gates the dark theme on three conditions; `design/tokens.css` ships it unconditionally.** The file calls itself *"a transcription of"* `51` §14, and `51` §5.1 states the gate correctly — but `tokens.css:111` ships the full dark palette with no note, and `rg 'prefers-contrast' design/tokens.css` returns nothing, so ADR-0026 item 1's restructured cascade has no home and its CI check has nothing to run against. Both prototypes link the file, and WO-08's artifact will | One-line change to `tokens.css`: gate the block, or add the note naming ADR-0026's three conditions. Planning |

## 6. Minors — thirteen

Ranked cheapest-first. Items 6.1–6.5 are pure factual corrections; a single pass closes them.

| # | Finding | Fix |
|---|---|---|
| 6.1 | `README.md:185` says **41 explainers**; the file has 42 (`rg -c '^- id:'`). Every other document was corrected — `01`:562, `76`:975, `87`:49 and :163, WO-07:103 — and `87`:127 records the 41→42 correction explicitly. This is the last survivor | `41` → `42` |
| 6.2 | `README.md:196–198` says **one** schema warning stands; the pinned baseline is **two** (`shipped_tree.rs:37–41`, `CLAUDE.md`:81, `78`:179, and four work orders). `78` §6 makes an unpredicted warning-set change a red gate, so a session trusting the README escalates for nothing | *"One warning"* → *"Two warnings"* |
| 6.3 | `docs/80-review/87-verification-report.md` is **invisible from the front door**. `rg -n '87' README.md CLAUDE.md` returns nothing, and README's nine-step *"Picking this up cold"* path never reaches `80-review/` at all. It is the one document that says which of the twelve blockers actually closed, and unlike `81`–`86` it is Accepted, not Contested | One row in README's `80-review/` table |
| 6.4 | `78` §12 item 3 says *"`CLAUDE.md`'s test count is stale … says 36 tests"*. The same commit that shipped `78` (`5733121`) fixed it; `36` appears nowhere in `CLAUDE.md`. §3 step 2's `<!-- VERIFY -->` is likewise satisfied — the queue directory is tracked. WO-01 §4, WO-06 G10 and WO-07 §4 still hedge *"if the index exists"* | Delete both, drop the three hedges |
| 6.5 | **WO-06's deferred-section map names the wrong blocker.** Rows `16` §10 and `16` §16 both say *"no app shell exists until WO-07"*; WO-07 §8 says *"**The browser artifact.** No HTML is assembled…"* and §1 assigns it to WO-08. The real wait is longer than the map states. (Partly a terminology collision — WO-07 calls its opcode dispatcher a "shell") | Two cells: name WO-08 |
| 6.6 | **`actions/checkout@v4` is a mutable tag**, and `35` §11.3 names exactly that as the failure: *"Every `uses:` is pinned to a full 40-character commit SHA … A tag is mutable."* `.github/ACTIONS.md` and §11.8's pin lint do not exist. The verifier's correction stands: this is not the *whole* supply chain — the job also runs `rustup toolchain install` over the network — but it is the one input the project has already written a rule against | Pin to the SHA with a version comment; add `.github/ACTIONS.md`. Arguably a dependency change (`78` §5 item 2 names *"no GitHub Action"*), so owner-approved |
| 6.7 | **`42` §9.4's egress string-scan will fail on a correct artifact.** Check 8 greps built artifacts for `http://` and allowlists only the sync origin. `56`:135 and `34`:1144 both *mandate* `createElementNS('http://www.w3.org/2000/svg', …)`, and eight files under `design/` already carry the literal. `38` §2.2 G6 leans on check 8 | Amend check 8 now, while it is prose: allowlist the two W3C namespace constants by exact string, and say a namespace URI is an identifier the browser compares, never an address |
| 6.8 | **The prototype held up as the fidelity bar ships a weaker CSP than `34` §2.2 specifies**: `script-src 'unsafe-inline'` (explicitly banned), `'unsafe-inline'` on styles, `font-src 'self'` where `34` says `data:` and calls `'self'` inert under `file://`, and no `require-trusted-types-for`. It is also two files — `<link rel="stylesheet" href="../tokens.css">`. The page is honest about the second file; `finder-states.html` carries a disclaimer that `fathom-app.html` lacks. Four citations to *"`34` §14"* point past the end of a document that stops at §13 | Add `finder-states.html`'s disclaimer to `fathom-app.html`; soften `CLAUDE.md`:30 to *"one interactive gallery page (plus the shared token stylesheet)"*; fix the four citations |
| 6.9 | **`#![forbid(unsafe_code)]` is per-file and three shipped binaries sit outside it.** The attribute is in exactly six `lib.rs` files; each `src/bin/*.rs` and each integration test is its own crate root and does not inherit it. `fathom-schema-check` — the binary CI runs on every PR — is one of them. `78` §2's wording says *"lib.rs"*, so the document is accurate; the coverage is not. Nothing else closes the hole: there is no `[workspace.lints]` and no `clippy.toml` | `[workspace.lints.rust] unsafe_code = "forbid"` in the root manifest plus `[lints] workspace = true` per crate. The 1.94.1 pin supports it. Matters most for WO-07's `fathom-wasm`, where hand-written memory handling is where unsafe gets reached for |
| 6.10 | **`16`'s stated ±0.45 prior bound is unenforced and unattainable from its own terms.** §8.1 annotates *"prior (bounded ±0.45)"* and §8.5 justifies it with two of the five terms §8.3 actually lists; summed at worst the five reach −0.95. `fathom-find/src/lib.rs:81–93` applies no clamp, so the code can return −0.65. The worst reachable value in today's 98-entry corpus is −0.40, so nothing is misranked yet | Planning picks one: correct §8.1/§8.5's number, or add the clamp — the latter changes shipped scores and needs a golden delta under `16` §8.5 |
| 6.11 | **`73` §10 specifies a decision-record convention the directory has never followed** — *"`docs/90-decisions/` exists and is empty"*, D-named files, five headings, *"anything longer is a specification"*. The directory holds thirty ADRs of 95–182 lines each, under `90-decisions/README.md`'s nine-part form. Both documents are Accepted. `78` §12 item 4 leaves the live question open | Replace §10.1–10.3 with two lines pointing at `90-decisions/README.md`, keep §10.4's cadence, and state that `73` §14 escalations are answered as ADRs. Closes `78` §12 item 4 |
| 6.12 | **The ADR review cadence has no trigger for the event that actually happened.** `90-decisions/README.md` reviews the register *"at every phase boundary, and at those points only"*. `76` §6.5 records the requirements changing outside any boundary. Three Accepted records rest on premises that event moved — ADR-0006, ADR-0029, ADR-0030 — and none was reviewed | One sentence: the register is also reviewed whenever the owner changes the requirements or the scope, with one question per record — *does this decision still rest on a premise that is still true?* The cheapest guard in this document |
| 6.13 | **The `Site` identity question, restated in plain language.** The site-list importer claims it can recognise a site by its first- or second-choice identity; the schema states no way at all to tell one site from another (`schema.yaml:130`, `identity: []`), so re-importing the site list would create duplicates. This is the standing two-warning baseline | See §8 Q7. It does **not** need the S0 config exports — it needs one sentence |

## 7. What was checked and found clean

Recorded so the owner does not pay to re-check it.

- **Invariants 1–4 hold everywhere reachable.** A repo-wide search for `fetch(`, `XMLHttpRequest`,
  `WebSocket`, `EventSource`, `sendBeacon`, `import(`, `@import` and any `http(s)://` literal across
  `crates/`, `design/`, `schema/`, `corpus/` and `.github/` returns 23 lines in 10 files, and every
  one is either the SVG namespace constant or prose asserting the absence. No `<script src>`, no
  `integrity=`, no remote `@font-face`. In the crates: no `std::net`, no `TcpStream`, no
  `Command::new`. `design/prototype/fathom-app.html` carries `connect-src 'none'` and audits its own
  CSP from the live page.
- **Invariant 3 is enforced at the type level, which is better than a policy.**
  `schema/schema.yaml:38` binds a scalar `SecretPlaceholder`; `:583` gives `IkePolicy.pre_shared_key`
  that type; `fathom-ir/src/scalar.rs:148` defines it as a zero-sized unit struct. A PSK has nowhere
  to be stored.
- **Determinism (invariant 9) holds across all six crates**, not just `fathom-id`: zero `HashMap` or
  `HashSet` anywhere in `crates/`, no `SystemTime`, `Instant`, `rand` or `getrandom`.
  `fathom-corpus/src/detln.rs` is a hand-rolled `ln` over IEEE basic operations with its reason
  stated and three worked constants pinned. The finder's ordering key never touches a float.
- **The counts are exact.** 48 kinds, 81 + 8 derived = 89 edges, 61 scalars, 10 enums, 3 classes,
  4 import scopes, 299 field keys, version 0.1 — counted directly from `schema.yaml` and matching
  `shipped_tree.rs:49–57`, `CLAUDE.md` and `schema/README.md`. 98 commands, 37 rules. 80 tests.
  README's reconciliation figures (12 blockers, 37 majors, 45 minors) verify.
- **`62`'s grammar holds in its own instance.** §2.3's fixed top-level key order is exact; §2.4's
  *"`doc:` is mandatory on kinds and edges"* holds for all 137 blocks, zero exceptions.
- **The plan layer's mechanics are sound.** All eight status lines match `00-INDEX.md` exactly. The
  dependency edges are acyclic and the queue order is a valid topological sort. `ci.yml`'s four gate
  commands are byte-identical to `78` §6's floor, as `78` §6 claims.
- **The ADRs compose with each other.** All thirty were read and the adjacent pairs most likely to
  collide were cross-checked (0003/0004; 0012/0013/0014; 0016 vs 0013; the 0020–0023 AI cluster;
  0011 vs the risk enum; 0019 vs 0017). No two contradict without a supersession link. Every
  contradiction found is ADR-versus-tree, which is the healthier failure. ADR-0023 is correctly
  `Proposed` and the tree does not behave as if it were Accepted.
- **The design set is the strongest cluster in the repo.** `rg '#[0-9a-fA-F]{3,8}'` over
  `fathom-app.html` returns zero hex literals, zero `px` font sizes, zero durations — every value
  comes from `tokens.css`. The three reserved risk colours match `.context/conventions.md` and `51`
  §14 character for character. The prototype's structure matches `52` §1.1's *"four renderers, one
  controller, one corpus surface, and one layer"*. The only drift is §5.11, and it is one file.
- **The corpus is honest about itself.** Each bundle opens with a provenance block and a
  *"where the card did not go in cleanly"* list; `schema/README.md` is candid about `released/` being
  empty and no `schema_hash` published; `gates.rs` emits `proposed:` codes rather than inventing
  gate codes. Almost nothing in this review was hidden — §4.5 is the exception.
- **The stub caveat is honest and fully covered.** `fathom-ir/src/scalar.rs` opens by saying so in
  capitals and carries `VERIFY` markers on the representative cases. WO-01 retires it.

Invariant 10 remains breached and declared: `grep -h reviewed_by corpus/*/*.yaml` returns 219
placeholder fields (`<named human>`, `<named reviewer>`) and zero names, exactly as the files'
own headers and README state.

## 8. The questions only the owner can answer

Seven, and they fit in one sitting. Nothing else in this document is blocked on anything else.

| Q | The question | Unblocks |
|---|---|---|
| ~~**Q1**~~ | **ANSWERED 2026-08-06** — third-party code is permitted, conditioned on bundling and on not being *"a security risk vector"*. Recorded verbatim at `70` §3; drafted as **ADR-0032**, which adds the two research passes the owner asked for | §5.7 discharged, pending ratification |
| ~~**Q2**~~ | **ANSWERED 2026-08-06** — *"All features must be included in V1, how you wish to plan that out is your discretion."* Recorded verbatim at `70` §4; drafted as **ADR-0031**. Broader than either option this table offered | §4.4 discharged, pending ratification |
| ~~**Q3**~~ | **ANSWERED 2026-08-06** — Juniper is primary, not retired. The owner's platforms are SRX, MX, EX, Nexus, Palo Alto and Meraki (`70` §7, verbatim). ADR-0029 stays live and **ADR-0030 is vindicated** — Palo Alto is on the owner's own list, so §5.9 narrows to *when*, not *whether*. One new question replaces it: `70` §10.3, on whether Meraki is configurable by pasteable text at all | §5.9 narrowed |
| **Q4** | **RE-ASKED** — the question was unanswerable as phrased. Restated at `70` §7.2 in product terms: *when Fathom flags the missing IKE permission, should the warning sit on the interface or on the zone?* — with the security consequence stated before the question. Still open | §4.5 — and whether `87` §3's RESOLVED stands |
| **New** | Ratify **ADR-0031, ADR-0032, ADR-0033**, all `Proposed`. They record decisions the owner has already made in substance; ratification makes them binding under `CLAUDE.md` rule 2 | §4.4, §5.7, and the motion doctrine `70` §5 records |
| **Q5** | Do you want the **ADR-0002 invariant texts** pasted into `conventions.md` now, or only invariant 3 (the one that is false as written)? | §4.3 — every session's first read |
| **Q6** | Is the repository going **public at phase 0 under Apache-2.0 / CC BY-SA 4.0** as ADR-0004 decided? If yes, the licence files want writing before the DCO retrofit gets more expensive | §5.8 — 45 commits and counting |
| **Q7** | **When you re-import your site list, what makes a row the same site** as one already in the workspace — the site code, the name, the CLLI of its premises, or something else, and in what order of preference? | §6.13 — the two standing warnings, and duplicate-free re-import |

Q7 is worth separating from the rest of the S0 fixture work. `CLAUDE.md` currently bundles it with
the Calix/Nokia/DIA config exports, which is a much larger ask; the identity answer is two or three
lines in `schema.yaml` and needs no exports at all.

## 9. A recommended order

**RECOMMENDATION —** the shortest path from here to a queue a session can actually run.

| Step | Work | Who | Effect |
|---|---|---|---|
| 1 | Answer Q1–Q7 (§8) | Owner | Unblocks steps 3, 5 and most of §5 |
| 2 | The one-line safety edits: `conventions.md`'s ID form (§4.2), `rust-toolchain.toml`'s target line (§4.1) | Owner | Removes two of the five blockers outright |
| 3 | Execute ADR-0002 into `conventions.md`; write ADR-0031 recording Q2's answer with ADR-0006 superseded | Planning | Closes §4.3 and §4.4 |
| 4 | The queue-hygiene pass: WO-07's toolchain rows, WO-01/WO-07's `Cargo.lock` clause, WO-05's G3 scope, WO-06's WO-08 correction, the ADR-0005 citations | Planning | The queue becomes executable end to end |
| 5 | One ADR on the dependency policy (Q1), amending ADR-0019 in the same pass | Planning | Closes the question five orders each defer separately |
| 6 | The factual pass: §6.1–§6.5, plus §6.11 and §6.12 | Planning | One commit, thirteen small corrections |
| 7 | The licence files (§5.8) | Owner | Stops a cost that grows per commit |

Steps 2 and 6 together are perhaps an hour and remove more risk than anything else in this list.
**Only step 1 is genuinely blocking**, and none of its seven questions requires the S0 exports.

## 10. Failure modes

| # | Failure | Control |
|---|---|---|
| 1 | **This document becomes the eighth critique nobody executes** — the exact pattern §3 names | §9's table names an owner per step; §8's seven questions are the only blocking item and they fit in one sitting |
| 2 | **A finding here is treated as a decision** | Nothing above decides. Every fix that touches a fork is marked owner and stated as a question in §8 |
| 3 | **An execution session reads this and acts on it** | `78` §7 makes every item here judgment-shaped. This document is not a work order and has no acceptance gates; a session that takes work from it has skipped `78` §3 step 3 |
| 4 | **The clean list in §7 is read as a warranty** | §7 records what was checked on 2026-08-06 by re-reading files, not what is proved by tests. Where a test pins a claim, §7 names it |
| 5 | **The blockers are read as "stop everything"** | They are not. WO-06 — the queue's leading order — is untouched by all five and remains executable today |
| 6 | **The refuted sixteen resurface** | §13 item 2 records why the strongest of them failed, so the next review does not re-raise them |

## 11. Open decisions

1. Whether this document is filed as a `80-review/` critique (`Contested` by design, like `81`–`86`)
   or as a standing review that is closed out item by item. It is written as the latter and marked
   `Proposed`; the owner decides.
2. Whether §5.4's `acceptable_when` check is worth a work order now, or waits for the rule-pack
   layer (§5.6). It is enforceable today in `fathom-corpus` for a few lines; that is an argument for
   now, not a decision.
3. Whether §6.9's workspace-lints change is folded into WO-07 (where it matters most) or taken as its
   own small order. Planning decides.
4. Whether ADR-0005's action 2 — the rename itself — is scheduled, or stays *"before anything is
   published"*. §5.8's licence work is the first thing that makes publication concrete, so the two
   are now coupled.

## 12. Sources consulted

| Source | Taken |
|---|---|
| `.context/conventions.md` (whole) | The ten invariants as they stand on disk; the identifier form; document conventions; the risk enum |
| `CLAUDE.md`, `README.md`, `schema/README.md`, `docs/90-decisions/README.md` | The front-door claims checked in §2, §6.1–6.3, §7 |
| `docs/90-decisions/adr-0001` … `adr-0030` (all thirty) | §3's table; §4.2–4.5; §5.7–5.11; the composition check in §7 |
| `docs/70-ops/78-execution-protocol.md` (whole); `79-work-orders/00-INDEX.md`; all eight `WO-*.md` | §4.1, §4.2, §5.1–5.3, §6.4, §6.5; the status, dependency and floor checks in §7 |
| `docs/10-core/11`, `12` §4, `16` §§4–9, `17`, `18`, `19` | §4.5's engine types; §6.10's prior arithmetic |
| `docs/60-content/61` §3.3, `62` §§2.1–2.4, `63` §§2–4, 7, 15, 19 | §4.5; §5.4–5.6; §7's grammar checks |
| `docs/30-security/32`, `34` §§2.2, 5.6–5.7, `35` §§5.1–5.3, 11.3, 11.8, `38` §2.2 | §5.7; §6.6–6.8 |
| `docs/40-stack/41`–`46`, esp. `42` §9.4 | §6.7 |
| `docs/50-design/51` §§5.1, 14, `52` §1.1, `55` §2.6, `56` | §5.11; §7's design checks |
| `docs/70-ops/71` §§2, 3.2, `73` §§10, 13, `74` §8, `75`, `76` §§6.5, 7.1–7.3, 8, `77` | §3; §5.9, §5.10; §6.11, §6.12 |
| `docs/80-review/80` §0.1, `87` §§1, 3, 4, 5 | The severity scale; §4.5's RESOLVED; §6.1's correction history |
| `crates/` (all six, incl. `src/bin/`, `tests/`, `src/generated/`) | §5.4; §6.9, §6.10; §7's determinism and stub findings |
| `schema/schema.yaml`, `schema/platforms.yaml`, `schema/service-types/builtin.yaml` | §4.5; §5.9; §6.13; §7's counts |
| `corpus/` (all three bundles) | §4.5; §5.4, §5.5; the invariant-10 count |
| `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`, `.github/workflows/ci.yml` | §4.1; §5.1, §5.7, §5.8; §6.6, §6.9 |
| `design/tokens.css`, `design/prototype/*.html`, `design/diagrams/*.html` | §5.11; §6.7, §6.8; §7's design checks |
| `cargo fmt` / `clippy` / `test --workspace --locked` / `fathom-schema-check`; `git log`, `git remote -v` (all run 2026-08-06) | §2's table; §5.8's commit and trailer counts |

## 13. Disagreements

1. **Against `87` §3's "RESOLVED" on `zone.host-inbound.ike-missing`.** `87` re-verified that the
   rule's text was changed as ADR-0029 ordered. It did not check that `ZoneMember` is a kind, and it
   is not. The correction is narrow — `87`'s method was text-level where this needed type-level —
   and it does not weaken the other eleven blocker judgements in that report, which were re-checked
   against the tree here and hold.

2. **Against sixteen findings this review itself raised and then discarded.** Recorded so they are
   not re-raised. The three strongest failures: (a) *"the finder's candidate cap silently drops
   entries by alphabetical id"* — the code shape was right and the mechanism was wrong; (b) *"`18`'s
   diff/verify/rollback spec is covered by no work order"* — WO-04 §8 scopes it explicitly as
   *"doc `18`'s territory, later"*, so it is deferred, not forgotten; (c) *"`78` is still Proposed
   while every ADR it outranks is Accepted"* — refuted on its premise: `Proposed` is the house status
   for the entire specification corpus (19 of 21 status lines under `00-vision/`, `10-core/` and
   `70-ops/`), so `78` is not an anomaly. A fourth, *"35's dependency-control machinery does not
   exist so the first external crate lands unchecked"*, is factually true and consequentially wrong:
   `78` §5 item 2 means no execution session can land one.

3. **On severity for §4.4 (ADR-0006 versus the queue).** A reasonable reviewer could call this MAJOR:
   nothing is broken, the queue runs, and the owner plainly changed their mind on purpose (`75` §2:
   sunk cost never argues). It is filed BLOCKER because ADR-0006 is R5 and still reads `Accepted`
   with `Supersedes: —`, so the tree currently asserts two incompatible answers to *"what is v1"* and
   the register that exists to stop that was bypassed. The fix is one sentence from the owner, which
   is a further argument for raising it rather than deferring it.

4. **On §3's framing.** Calling this "accepted, then not executed" is a judgement about a pattern,
   and patterns can be over-read. The counter-evidence is real and is recorded in §5.10: ADR
   amendments *did* land in `75`, `76`, `77`, `78` and in six design documents, and ADR-0002's
   `22-subagent-catalogue` rename *was* made. The failure is localised to `.context/conventions.md`,
   `71`–`74`, and the repository-root artifacts — which is a smaller and more fixable claim than
   "the ADRs are ignored", and it is the claim this document makes.

5. **This document has no acceptance gates, and that is deliberate.** `78` §8 requires them of a
   work order. This is not one — it is the input to authoring several. Filing it as a work order
   would be exactly the escalate-then-do failure `78` §5 item 10 names.
