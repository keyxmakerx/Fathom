# 83 — Critique: does the corpus compose into one system?

> **Status:** Contested

This is an adversarial read of the whole corpus from one lens only: **do these forty-odd documents
describe a single system, or forty overlapping systems that share a vocabulary?**

I am not assessing whether any individual document is good. Most of them are unusually good — see
§14, which exists so the criticism below means something. I am assessing whether the thing they
jointly specify can be built. Every finding below names a file, a section, the exact claim, why it
does not hold against another document, what breaks if it is implemented as written, and what to do.

**The governing rule of this document, stated once, in caps, at the top:**

> **TWO DOCUMENTS THAT DISAGREE ABOUT BYTES ON DISK ARE NOT TWO OPINIONS. THEY ARE TWO PRODUCTS,
> AND THE IMPLEMENTER WILL BUILD WHICHEVER ONE THEY READ SECOND.**

---

## 0. Contents

| § | |
|---|---|
| 1 | The three findings that matter |
| 2 | Method — the dependency matrix, and what it found |
| 3 | **F1 — the workspace format schism**: `17` and `32` specify two incompatible containers |
| 4 | **F2 — the offline artifact schism**: four documents, four different single files |
| 5 | **F3 — the AI catalogue schism**: `21` and `22` describe disjoint subagent rosters |
| 6 | F4 — identity, re-parse and suppression survival: three algorithms, one job |
| 7 | Point contradictions — the numbered table |
| 8 | The ten hard invariants, audited |
| 9 | Terminology compliance against `conventions.md` |
| 10 | What is missing entirely |
| 11 | What is duplicated, and the single document each topic should live in |
| 12 | Is this buildable? The real scope against the roadmap |
| 13 | What to do, in order |
| 14 | What the corpus gets right, and must not lose in revision |
| 15 | Disagreements |

---

## 1. The three findings that matter

*margin tab: read this first*

| # | Finding | Consequence |
|---|---|---|
| **F1** | **`17-workspace-format.md` and `32-cryptography.md` specify two mutually incompatible on-disk formats, in full, with code, neither aware of the other.** Different record granularity, different filenames, different AEAD (one uses the construction the other explicitly rejected), different key hierarchy, different update model (rewrite vs append), and one violates an invariant the other declares. `73` §5.1 lists the question as still open and cites only one of them. | There is no answer to "what are the bytes on disk". Two implementers produce two products. `33`, `44`, `43` and `35` each depend on a different one. §3 |
| **F2** | **The offline single file is specified four times at four sizes and two capability levels.** `34` §3.3 decides it holds *no workspace and no crypto*; `43` §3.5 decides it holds *the whole product*; `44` budgets *workspace unlock* on it as an accepted budget; `41`/`44` cap it at 4.5 MB with a 900 KB WASM ceiling while `43` estimates 5.4–6.7 MB with a 2–3 MB WASM and `35` prints 28 MB. | The flagship deployment shape — the reason the security posture exists — has no agreed definition, no agreed size, and a CI size gate that would fail every build of the artifact the deployment document specifies. §4 |
| **F3** | **`21-ai-layer-architecture.md` §5.1 and `22-agent-catalog.md` name completely disjoint sets of subagents, with zero cross-references.** `22` argues at length that two of `21`'s eight should not exist; `21`'s per-tier degradation table and both of its worked scenarios are driven by those two. | The AI layer — an explicit new owner requirement — has no agreed roster. Neither document can be implemented without contradicting the other. §5 |

None of these is a matter of taste. Each is two documents making an incompatible factual claim about
the same artifact.

---

## 2. Method — the dependency matrix, and what it found

I built the cross-document dependency graph by extracting every `NN §M` reference and every claim
that restates a sibling's decision, then checked each edge for agreement. 43 documents, 312 distinct
cross-references. The interesting result is not the list; it is its *shape*.

### 2.1 The shape of the failure

| Class of edge | Count | Agreement |
|---|---|---|
| **Deferral** — "X owns this, see `NN`" | ~180 | Almost always sound. This corpus is very good at deferring |
| **Restatement** — the same fact stated twice | ~90 | Sound where the fact is a number lifted verbatim; **broken wherever the second author re-derived it** |
| **Extension** — "`NN` decided A; this document extends it to B" | ~30 | Sound, and usually flagged as a proposed change |
| **Silent re-decision** — a second document decides a question a first document already decided, without citing it | **9** | **All nine are contradictions.** F1, F2, F3, F4 and five of §7's rows |

The nine silent re-decisions are the entire problem. They cluster in exactly one place: **wherever
two documents were both plausibly the owner of a question and neither was told which.** The corpus
has no ownership register. `73-open-decisions.md` is close to one, but it registers *forks*, not
*ownership*, and §3's finding is that a fork it lists as open has been decided twice, differently.

### 2.2 The two documents nobody appointed an owner for

| Question | Documents that decided it | Documents that assumed one of them |
|---|---|---|
| **The bytes of a sealed workspace** | `17` §§2–7 and `32` §§5–7, incompatibly | `33` (assumes `17`), `44` (assumes both, incoherently), `43` §2.1 (assumes `17`), `35` (assumes `32`'s envelope), `73` D15 (cites `32` only) |
| **What the single HTML file contains** | `34` §3.3 and `43` §3.5, incompatibly | `44` (assumes `43`), `41` §3.10 (assumes `43`), `21` §7.0 (assumes neither), `16`, `35` (assume a third thing) |

Fix both by appointing an owner and making every other document a deferral. §11 says which.

---

## 3. F1 — the workspace format schism

### 3.1 The two specifications, side by side

`17-workspace-format.md` and `32-cryptography.md` are both `Status: Proposed`, both dated the same
day, both complete, and both specify the full on-disk container. They agree on almost nothing.

| | `32-cryptography.md` | `17-workspace-format.md` |
|---|---|---|
| **Unit of encryption** | §6.2: sharded, `node_shard = blake3(node_id) mod 64`, `S_edges = 16`. **Fixed at 64 node records from an empty workspace to a 5 000-node one** | §4.2: `RecordKind::DeviceGraph { device }`, `DeviceProv`, `DeviceHistory` — **four records per device**, plus 64 `Fabric` shards |
| **Record count, 500 devices** | ~90 (§13.4: *"all 90 records"*) | §13.2: **~2 100** |
| **Filenames** | §6.5: the record id is *"a shard index (`0x00`–`0x3f`) or a capture ULID"*, in the clear | §6.3: **keyed pseudonyms**, `base32(blake3_keyed(K_name, …))`, 26 chars, in 1 024 buckets |
| **AEAD** | §5.2/D4: ChaCha20-Poly1305 (RFC 8439), **nonce is 12 zero bytes**, per-record 32-byte salt → HKDF. XChaCha20 **explicitly rejected** because *"XChaCha is a CFRG draft, not an RFC"* | §5.1/§5.2: **XChaCha20-Poly1305, 24-byte random nonce** — the exact construction `32` rejected — with a `VERIFY` note conceding the draft status and deferring to *"the key-management document in 30-security/"* |
| **Key commitment** | §5.6: `K_enc ‖ K_cmt = HKDF-Expand(prk, info, 48)` | §5.6: `commit = blake3_keyed(K_rec, "fathom/v1/commit" ‖ nonce)[0..16]` |
| **Key hierarchy** | §3.1: passphrase → `A2id` → keyholder parent key → keyholder envelope → `RK_e` → HKDF → `WK_e` → per-record. **Key epochs are first class** | §6.3/`33` §3.4: passphrase → Argon2id → KEK → unwrap → `WK` → `K_rec`, `K_name`, `K_manifest`, `K_admin`, `K_capture`. **No epoch exists.** `K_name` and `K_capture` have no counterpart in `32` |
| **Update model** | §13.4: *"Never re-seal a record whose canonical plaintext is unchanged"* — records are **rewritten whole** | §5: records are **append-only frame sets**; an edit appends 69 bytes + body and never rewrites |
| **Header** | §7.1: **112 bytes**, fixed, with `format_version`, `schema_major/minor`, `record_id`, `key_epoch`, `key_id`, salt, commit tag | §5.1: **32-byte file header + 69-byte frame header** with `hlc`, `actor`, nonce, commit, `body_len`. No `key_epoch`, no `key_id`, no schema version in the frame |
| **Merge** | §5.4: **`> INVARIANT — ciphertext is never merged.`** *"The sync layer transports whole records. It never combines two envelopes"* | §12.4: the git merge driver **unions two files' frames into one file, keylessly**, and §1 calls this *"the most important result in this document"* |
| **Manifest** | §6.3: a sealed record class `0x00`, **rewritten every save**, carrying a version vector | §7.4: **`manifest.fm` is in `.gitignore`** and is derivable without a key |
| **Container shapes** | D8: `workspace.fathom` (single file) or `workspace.fathom.d/` (exploded, **fixed file set**) | §2.1: `site-b.fathom/` (directory, **file set grows with devices**) or packed `site-b.fathom` |

### 3.2 Why this is not reconcilable by a merge

Three of these rows are load-bearing in opposite directions:

1. **Sharding by node-ID hash exists to hide the device count** (`32` §6.1: *"in an exploded
   directory, the filename set is metadata… Anyone with read access to that repository can count
   devices by counting files"*). `17`'s device-subtree records **publish the device count in the
   file count**, exactly, forever, in git history — the failure `32` §6.1 spends two pages
   preventing. `17` §6.3's keyed pseudonyms hide the *names* but not the *count*, and `17` §6.3
   concedes it: *"the number of records… For a workspace in git, every historical commit preserves
   that signal permanently."* Neither document argues against the other because neither read it.
2. **`32`'s "never merge ciphertext" invariant and `17`'s keyless frame-union merge driver cannot
   both be implemented.** `17`'s driver combines frames from two sealed files into a third file
   without a key. Under `32`'s record model there are no frames to union — a record is one envelope,
   and combining two envelopes is precisely what the invariant forbids. `32` §5.4's Case 2 says the
   merge is *"a plaintext problem, handled by `11-ir-schema.md` §8.6, and it happens after both
   envelopes are opened"*. That is a different product from `17` §1's *"Git merges frames. Fathom
   merges values."*
3. **`33-sync-protocol.md` is built entirely on `17`.** Its wire types are `FrameDigest`,
   `UploadFrame`, `set_digest` over sorted frame digests, `baseline_at`, and `GET /frames?have=[…]`
   *"because frames are a set and not a sequence (`17` §5.3)"*. **None of that exists under `32`.**
   `33` §3.4 also states, of the key hierarchy, that *"Full key management belongs to a document in
   `30-security/` that has not been written"* — while `32-cryptography.md` sits in that directory
   specifying it differently.

### 3.3 The blast radius, document by document

| Document | Which format it assumes | What breaks if the other wins |
|---|---|---|
| `33-sync-protocol.md` | `17` | The entire API surface. Nine operations, five of which take or return frames |
| `44-performance-budgets.md` | **both, incoherently** | §4.8.5 states *"Records at unlock: 4"* (1 device) and *"12"* (20 devices). `32` §6.3's floor is **85 records** before any provenance or capture — 64 node shards + 16 edge shards + manifest + keyholders + memberlog + suppressions + settings + layout. `17`'s figure at 20 devices is ~70. Neither is 4 or 12. Consequently §4.8.3's move 5 (*"Defer per-record AEAD above 30 records"*) never takes its own eager branch under `32`, and the "below 30 records, verify everything" safety case is dead on arrival |
| `44` §4.8.6 | proposes device-sharding as a **new** change | `17` §4.2 **already decided** device-sharding. `44`'s open decision O1 (*"Changes `32` §6 and `17`'s record model"*) proposes to `17` what `17` specifies |
| `43-deployment-modes.md` §2.1 | `17` (*"the workspace directory; git; `fathom pack`"*) | The backup and restore runbooks in §9 |
| `35-supply-chain-and-builds.md` | `32`'s envelope | Nothing, if `32` wins |
| `73-open-decisions.md` §5.1 D15 | `32` only — **`17` is not cited** | The register believes this is one decision with a lean. It is two decisions already taken |
| `81-critique-security.md` §3.2, §3.4, §3.5 | `32` | Three of that critique's findings are about a format that may not be the one built |

### 3.4 The fix

**Appoint `17-workspace-format.md` as the sole owner of the container and the record model, and
`32-cryptography.md` as the sole owner of primitives, key hierarchy, key management and the sealed
envelope's cryptographic content.** Then:

| Action | Where |
|---|---|
| Delete `32` §6 (the record model) and §13.2–13.3 (on-disk shapes, git), replacing them with a one-paragraph deferral to `17` | `32` |
| Delete `17` §5.6 (its own key-commitment construction) and §5.2's AEAD choice, replacing them with a deferral to `32` §5. **`17`'s 24-byte nonce field must go**, and its frame overhead arithmetic (§13.1, §17) must be recomputed at `32`'s 112-byte header | `17` |
| Reconcile the two update models. This is the real decision and it cannot be deferred: **append-only frames or whole-record rewrite.** They imply different git economics, different sync protocols and different merge stories. `17`'s frames are the more defensible design *given* the CRDT in `33`; `32`'s "never re-seal an unchanged record" rule is compatible with frames and should be kept as-is | a new joint section |
| Re-open `73` D15 and restate the fork as *"per-device records with pseudonymous filenames (`17`), or fixed hash shards (`32`)"*, with the device-count leak as the deciding axis | `73` §5.1 |
| Recompute every record count, byte figure and open-time estimate in `44` §4.8 against whichever wins | `44` |

**Until this is resolved, no work on `33`, `35`'s A9 BOM, or `44`'s open-path budgets is safe.**

---

## 4. F2 — the offline artifact schism

### 4.1 Four documents, four different single files

`81` §7.3 already found that *"the single-file decision is forked three ways"*. It is forked four
ways, and the fourth fork is a CI gate that would fail.

| Document | What `fathom-<ver>.html` is | Size |
|---|---|---|
| **`34` §3.3** (Status: the decision, argued at length) | *"The command finder, the corpus, the explainers, the rule prose, the risk legend, the guidebook. All read-only reference content."* Explicitly: **"No workspace, no passphrase entry, no envelope code, no ciphertext, no storage"** | not budgeted |
| **`43` §3.5** (marked **PROPOSED CHANGE to `34` §3.3**) | *"a complete product for one session… opens a packed workspace… holds the graph in memory, runs every engine, emits configuration… writes a sealed workspace back out"* | §3.2: **5.4–6.7 MB** at v1, **8–10 MB** at v2, of which `fathom_core.wasm` is **2.0–3.0 MB** |
| **`44`** (no proposal marker; §3's table header says *"mode A (offline single file) except where noted"*) | Budgets **B14 workspace unlock**, **B15 unlock → first device interactive**, **B16 unlock → all findings settled**, and §4.8's whole KDF reconciliation, all on mode A | §5.3: **≈3.38 MB total, target ≤3.5 MB, hard ceiling (B17) 4.5 MB**; §5.2: **WASM ≤700 KB target, ≤900 KB hard ceiling** |
| **`35` §13.2** | a worked `fathom verify` output | prints `SIZE 28,114,552 bytes` — **28 MB** |
| **`16` §9.4** | assumes *"a target single file in the tens of megabytes"* | tens of MB |

`43` §3.2 spots part of this and flags it: *"Either those figures are illustrative, or the intended
corpus is several times larger… One of them is wrong and the number appears in published material."*
It does not spot that its own WASM estimate is **three to four times `41` §3.10's and `44` §5.2's
budget**, or that `44`'s CI check **P6** (*"A1 ≤ 4.5 MB; WASM ≤ 900 KB; per-component budgets"*,
blocks the merge) would reject every build of the artifact `43` specifies.

### 4.2 The consequences, which are not just embarrassment

**(a) `44` has silently adopted a proposal and then declared no disagreements.** `44` §13 says
*"None with `conventions.md`"* and lists exactly two proposed changes, both to `32`. It does not
mention that its entire §4.8 — the section it calls *"the most important paragraph in this
document"* — presumes `43` §3.5's proposed change to `34` §3.3 has been accepted. It has not been.
Under `34` as written, **B14, B15 and B16 do not exist**, because mode A never unlocks anything.

**(b) `32` §4.3's `p = 1` decision loses its stated justification.** The argument is:

> *"WASM threads require `SharedArrayBuffer`, which requires cross-origin isolation, which requires
> the `COOP: same-origin` and `COEP: require-corp` **HTTP headers**. A `file://` document has no HTTP
> headers. The offline single-file build — the deployment shape this project exists for — can never
> be cross-origin isolated."*

Under `34` §3.3, the single file never runs Argon2id. The artifact that *does* — mode B, served from
loopback by `fathom serve` — sets, per `34` §2.2, **`Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp`**. It is cross-origin isolated. Every browser artifact
that can open a workspace has real threads available. The premise of D2 is false for the artifact it
governs. `p = 1` may still be the right answer — `32` §4.3's arguments 1 and 3 stand on their own —
but **argument 2, the one presented as decisive, must be withdrawn or the decision re-argued.**

**(c) The same fact is used twice in opposite directions.** `44` §6.3 uses "mode A cannot be
cross-origin isolated" to explain why mode A cannot measure its own memory, *and* budgets mode A's
memory during unlock. Both cannot be true of the same artifact.

**(d) The AI tier ceiling is stated three ways.** `21` §7.0's table says the **single-file build
supports tier 2a** (in-page WebGPU inference). `34` §2.1 says mode A is **tier 0**. `43` §2.1 says D1
is **tier 0**. `21` §7.2a additionally decides *"weights are loaded from a local file the user
selects"* at **1–2 GB for a 3 B model at 4-bit** — which collides with `44` §6.2's hard ceiling of
1.5 GB resident for any workspace, and with `34` §3.3's decision that the single file holds nothing
to reason about. `21`'s row is stale and should read `no`.

**(e) The font count is stated three ways.** `43` §3.2: *"Liberation Sans ×3 + DejaVu Sans Mono ×2…
5 faces"*, citing `34` §8.4. `41` §3.10: *"four font faces"*. `44` §5.4: **DECISION — ship the mono
faces, do not ship the sans**, i.e. **two**. `44`'s is the only one argued; the other two are
assertions. Adopt `44`'s and correct the other two.

### 4.3 The fix

1. **Resolve `34` §3.3 versus `43` §3.5 before anything else in `40-stack/`.** `73` §3.7 D07 already
   decided *"A and B, both, from one build"* and states that *"`43` §3.5 already extended A from a
   reference-only lookup to a complete single-session product"* — so the register believes the
   extension is accepted. **`34` §3.3 has not been edited to say so.** Edit it, or reverse D07.
2. **Reconcile the size figures to one table, in `44`.** Every other document cites it. Delete
   `43` §3.2's independent budget and `41` §3.10's independent totals; keep `41`'s per-component
   *split* and move the numbers to `44` §5.2, which already adopts it *"verbatim"* and then differs
   (950 KB vs 933 KB, four faces vs two).
3. **Decide whether the WASM core is 700 KB or 2–3 MB.** These differ by a factor of four and the
   difference is not roundable. `43`'s estimate enumerates the same component list `41` does and
   arrives four times higher; one of the two enumerations is wrong, and `41` §3.10's own `VERIFY`
   admits it is *"a budget, not a measurement"*. **This is the single most consequential unmeasured
   number in the corpus**: it decides B17, B18, the artifact shape, and whether mode A is viable at
   all. It is a two-day spike.
4. **Correct `21` §7.0's single-file row to `no` for tier 2a**, and `21` §7.6's degradation table
   with it.

---

## 5. F3 — the AI catalogue schism

### 5.1 Two rosters, no mapping

`21-ai-layer-architecture.md` §5.1 gives "the catalogue" — eight subagents, by identifier:

`intent.router`, `corpus.scout`, `constraint.negotiator`, `config.triage`, `symptom.correlator`,
`adversary.redteam`, `finding.narrator`, `gap.reporter`.

`22-agent-catalog.md` gives ten sections, `S1`–`S10`, by a different naming scheme:

S1 intake and triage · S2 config comprehension · S3 diagnostic reasoning · S4 explainer selection ·
S5 rule-authoring assistant · S6 interop advisor · S7 change-narrative writer · S8 adversarial
reviewer · S9 corpus gap finder · S10 redaction-detector proposer.

**`22` contains not one occurrence of any of `21`'s eight identifiers.** There is no mapping table in
either direction. A reader with both open cannot tell whether `S6` is `constraint.negotiator` or a
new thing.

### 5.2 Worse: `22` argues two of `21`'s eight out of existence

| `22` section | Verdict | `21` still depends on it |
|---|---|---|
| §5 — S3, diagnostic reasoning | *"**never** (as a reasoner)"* | `21` §5.1 lists `symptom.correlator` as shipping; §7.6 budgets its per-tier quality (*"poor / fair / good"*); **§13.5 of the worked Scenario B is driven by it** |
| §6 — S4, explainer selection | *"**never** … replaced by §6.4"*, with the argument that *"the resolution problem is already solved, totally"* by `15` §3.3's total tie-break | `21` §5.1 lists `corpus.scout` as shipping; §7.6 budgets it at every tier; §14 scores its value; **`21` §5.1 gives it `NoHit` as a trigger** |

And `22` adds three subagents `21`'s catalogue does not contain at all — S5 (rule-authoring), S7
(change-narrative), S10 (redaction-detector) — of which two are **build-time agents with filesystem
and test-execution capabilities** (`BUILD_FS_READ`, `BUILD_RUN_TESTS`, `BUILD_WRITE_DRAFT`).

### 5.3 The boundary statement is *nearly* identical everywhere, and the exception matters

The good news: R1 and R2 are restated consistently. `21` §2.1 (*"May not: write the graph · emit
config · author findings · rank the finder · reach the filesystem, the network, or a shell"*),
`23` §3.1 (*"the model cannot write to the graph, and cannot emit config"*), `22` §—'s injection
table (*"R1 — there is no write tool"*) and `31` row 15 all agree. That is a genuine achievement of
parallel authorship and it should be protected.

The exception: **`21`'s "may not reach the filesystem… or a shell" is stated without qualification,
and `22`'s build-time agents do both.** `22` §—'s guard (*"`site == Runtime` ⇒ `grant & BUILD_* ==
0`. A build-time flag on a runtime spec is a hard [failure]"*) is the right control, but `21` never
introduces the runtime/build-time split, so as written the two documents contradict. `21` §5.1's
only build-time row is `gap.reporter` (*"build time only, never at runtime"*), which shows the
concept exists in `21`'s head and did not make it into the boundary statement.

### 5.4 The fix

| Action | Where |
|---|---|
| **Delete `21` §5.1's catalogue and replace it with a deferral to `22`.** `22` is 3 782 lines of argued admission decisions; `21`'s eight-row table is a sketch that predates them | `21` §5.1 |
| Rewrite `21` §7.6's per-tier degradation table against `22`'s actual roster, dropping the rows for agents `22` rejects | `21` §7.6 |
| **Rewrite Scenario B (`21` §13).** It is driven by `symptom.correlator`, which `22` §5 declines to build. Either the scenario is wrong or `22` §5 is; the scenario is the more persuasive artifact and the weaker argument | `21` §13 |
| Amend `21` §2.1's boundary statement to read *"reach the filesystem, the network, or a shell **at runtime**"*, and introduce the runtime/build-time split there rather than in `22` §—'s tool table | `21` §2.1 |
| Add a two-column mapping table (`21` name ⇄ `22` `Sn`) to the top of `22` | `22` §2 |

---

## 6. F4 — identity, re-parse and suppression survival

The lens asked specifically about "the node-ID stability requirement versus re-parse identity
resolution versus suppression survival". All three are specified. They are specified three times.

### 6.1 Two re-identification algorithms

| | `11-ir-schema.md` §10.3–10.4 | `12-rule-engine.md` §11.4 |
|---|---|---|
| Key structure | An **ordered list** of identity tuples per kind, *"most specific first"*, up to 3 tiers, with `owner()`, `edge()` and `edge_in()` terms | **One** `identity` tuple per kind — `Device: hostname`, `IkeGateway: device.nk, name`, … |
| Key form | not hashed; tuples are matched by hash join per tier | `NaturalKeyHash = blake3_128(kind_name ‖ 0x00 ‖ canonical_join(identity_values))` |
| Rename handling | tier 2/3 tuples exist **precisely to survive a rename**; `if t > 1: record a rename candidate` and `M[p] := that node` — **the match is made** | *"the pair is unmatched. Rename guessing uses a second pass — same kind, same parent, ≥80 % field equality — and produces a **suggestion** in the plan, **never a silent re-bind**"* |
| Residue threshold | weighted Jaccard + 0.3 × edge-signature overlap; accept iff `best ≥ 0.75` **and** `best − second ≥ 0.15`; skip if `\|rG\|·\|rP\| > 4096` | ≥80 % field equality, same parent |
| Persistence | **§10.3: *"Identity tuples are… never used for lookup, never used by rules, never persisted as a key."*** | **§11.1 persists it**: `Scope::Finding { anchor: NodeId, anchor_nk: NaturalKeyHash, … }` on every suppression |

The last row is a flat contradiction of an explicit prohibition, and it propagates:
`17-workspace-format.md` §16.2 has `fsck --repair` *"re-bind orphaned suppressions whose `anchor_nk`
matches exactly one node (`12-rule-engine.md` §11.4)"*, so the persisted key is now load-bearing in a
third document.

`14-parsers-and-ingest.md` §— gets this right: its stage 7 is *"identity tuples (already in the IR
schema, IR §10.3) — **0 lines of code**"*. `14` defers correctly; `12` re-derived.

### 6.2 Invariant 7 is bent, and the bending is argued but not registered

Invariant 7: *"Every node, edge and field carries a stable opaque ID. Rules, explainers, emitters and
diagram elements reference IDs, never paths or names."*

`12` §11.4's cost table answers this directly and well:

> *"Natural keys are names… This does not violate it: the graph itself contains no natural-key
> references. The key exists only in the reconciliation matcher and the suppression recovery path."*

That is a good argument. But a suppression is a first-class workspace object (`conventions.md`
terminology: *"a recorded, reasoned waiver of a finding"*), it is stored in the workspace
(`17` §9), it is exported to reviewers (`17` §15.2 `--format review`), and it now contains a
name-derived key. The argument should be **registered under `## Disagreements`** with a proposed
clarification to invariant 7, not left in a cost table. `12` §18 does not raise it.

### 6.3 A behavioural contradiction nobody will notice until it ships

Same operation, two specified behaviours:

| Scenario | `11` §10.4 | `12` §11.4 |
|---|---|---|
| `IkeGateway GW-B` renamed to `GW-DC-EAST`, same peer address, same external interface, re-parse | Tier 2 tuple `[owner(Device), peer.address, edge(ExternalInterface)]` matches. **Auto-matched. ULID preserved. Rename recorded.** | Tier-1 key changed ⇒ unmatched ⇒ rename guess ⇒ **user is prompted. Nothing is bound without confirmation.** |

`11` §10.6 then claims *"Suppressions: **yes** [survive a rename] — keyed by `(rule_id, ElementId)`"*,
which is only true under `11`'s auto-match. Under `12`'s, a rename orphans every suppression on that
node until a human clicks. One of these is the product's behaviour and the other is not.

### 6.4 The fix

| Action | Where |
|---|---|
| **`11` §10.3–10.4 is the owner.** Delete `12` §11.4's parallel natural-key scheme and its per-kind table; replace with `NaturalKeyHash = blake3_128` **computed over `11` §10.3's tier-1 tuple**, and a deferral for everything else | `12` §11.4 |
| Amend `11` §10.3's *"never persisted as a key"* to *"never persisted as a graph reference; the tier-1 tuple's hash may be persisted as a **recovery** key by `12` §11.4, and by nothing else"* | `11` §10.3 |
| Resolve the rename behaviour explicitly. **`12`'s "never a silent re-bind" is the safer rule and `11` §10.4's own justification agrees** (*"a wrong match silently rewrites the history of an object that is not the one you are looking at"*) — so `11` §10.4 step 3's `if t > 1` branch should produce a *candidate*, not a binding, and `11` §10.6's suppression row should say "yes, after confirmation" | `11` §10.4, §10.6 |
| Register the invariant-7 clarification under `## Disagreements` | `12` §18 |

---

## 7. Point contradictions — the numbered table

Everything below is a single checkable disagreement. File, section, claim, why, consequence, fix.

| # | Claim | Where | Why it is wrong | Consequence | Fix |
|---|---|---|---|---|---|
| **P1** | `Permissions-Policy: … publickey-credentials-get=(), …` in modes B, C and D; CI check **H11** asserts *"every listed feature is denied"* | `34` §2.2, §2.4, §H11 | An empty allowlist on `publickey-credentials-get` denies WebAuthn assertions **to the top-level document**, not just to frames. `32` D13 ships **WebAuthn PRF as an additional keyholder, on by default**, and `32` §12.3 requires *"Register the credential, then immediately perform a `get()` to obtain the PRF output"* | The hardware-key keyholder is structurally impossible in every browser artifact that can open a workspace, and CI enforces the impossibility. A user who enrols a passkey gets a workspace they cannot open with it | Either remove `publickey-credentials-get` from the deny list in modes B–D (leaving it at its `self` default), or delete `32` D13/§12. `34` should also state whether `publickey-credentials-create` is intentionally *not* denied — as written, enrolment works and unlock does not, which is the worst of the three options |
| **P2** | `[diff "fathom"] … cachetextconv = true` | `17` §12.7, the ini block | The prose **four lines below** says *"`fathom git install` sets `cachetextconv = false` by default and says why"*. `32` §13.3 ships `cachetextconv = false`, and `32` §17.12 classifies `true` as *"One line in a config file, **total confidentiality loss** for the repository"* | Anyone implementing from `17`'s code block ships the configuration `32` calls a total loss. This is the highest severity-to-effort ratio finding in the corpus: one word | Change `true` to `false` in `17` §12.7's block |
| **P3** | *"If CEL (`12` §3) is adopted as an embedded interpreter rather than compiled to the 28-opcode VM, this row moves"* | `44` §5.2 | `12` §3.3 **decided** against CEL — *"DECISION — Fathom defines `fex`… No third-party expression evaluator ships in the trusted path"* — and `63` §— builds its whole spec on `fex`. There is no live CEL option | A size-budget row hedges against a decision that was made, which reads to an implementer as the decision being open | Delete the hedge; keep the row as *"Rule condition VM — counted inside rule engine"* |
| **P4** | *"the single file… carries the finder index, the rule pack, **four font faces** and the JS"*; *"roughly **950 KB**"* of base64 WASM | `41` §3.10 | `44` §5.4 decides **two** faces; `43` §3.2 says **five**. 700 KB × 4/3 = **933 KB**, which is `44` §5.3's figure | Three font budgets and two base64 arithmetics for one artifact | Adopt `44` §5.4 and §5.3 everywhere |
| **P5** | *"Records at unlock: 4 / 12"*; *"Defer per-record AEAD **above 30 records**"* | `44` §4.8.3 move 5, §4.8.5 | `32` §6.2 fixes the node record count at **64 regardless of workspace size**; the class floor is ≥85. `17` §13.2 gives ~2 100 at 500 devices | The eager-verification branch is unreachable; the stated safety property (*"below 30 records, verify everything"*) never holds | Recompute after F1 is resolved. If `32` wins, the threshold must be expressed in bytes, not records |
| **P6** | *"Decrypt the **`graph` section** ~11.6 MB"*, *"**Lazy sections** … load `provenance`, `history` and `captures` per device on demand"* | `44` §4.8.2, §4.8.3 move 4 | Neither `32` nor `17` has a "graph section". Per-device lazy loading of provenance is **`17`'s** model; `44` §4.8.6 simultaneously states that **`32`'s** hash shards make per-device laziness *"impossible"* | `44` §4.8 contains both formats' consequences in adjacent paragraphs and reaches an "open decision" (O1) that `17` has already closed | Rewrite §4.8 against one format |
| **P7** | `32` §D14: *"Primary store, offline: The file. **OPFS is a working cache** and never the only copy"* | `32` D14, §13.1 | `43` §3.5 decides D1 *"uses **no browser storage of any kind** — no OPFS, no IndexedDB, no Cache API, no `localStorage`, no cookies, no service worker"*, and `73` §3.7 D07's table records *"Browser storage: **None, by decision**"* | `32` specifies a caching tier that the deployment decision forbids, and `43` §3.12 prices the resulting **total loss of crash recovery** — a cost `32` never sees | Delete the OPFS branch from `32` D14, or re-open D07 |
| **P8** | Deployment shapes lettered `A`–`E` | `34` §2.1, and adopted by `44` (mode A, modes B–D, modes C–D), `35`, `21` §7.5 | `43` §1.1 pins `D1`–`D4` and **RECOMMENDS retiring `34`'s letters**, noting *"a reader who has both open cannot tell 'mode B' (a served bundle) from 'D2' (Docker)"* | Two live namings, and `44`'s "modes B–D" means something different from `43`'s "D2–D4" | Adopt `D1`–`D4` corpus-wide, or reject `43` §1.1's recommendation explicitly. Do not leave both |
| **P9** | `21` §7.0: single-file build supports **tier 2a**; `21` §7.2a: weights are a **1–2 GB** user-selected local file | `21` §7.0, §7.2a | `34` §2.1 and `43` §2.1 both cap the single file at **tier 0**; `44` §6.2's hard ceiling is **1.5 GB resident, any workspace**; `34` §3.3 leaves nothing in that artifact to reason about | The AI document promises a capability two other documents forbid and a third cannot fit | Set the row to `no` |
| **P10** | *"Full key management belongs to a document in `30-security/` that **has not been written**"* | `33` §3.4 | `32-cryptography.md` is that document, in that directory, 2 129 lines | `33` proceeds to specify its own key hierarchy (`K_name`, `K_capture`, `K_admin`, no epochs), which is then inherited by `17` §6.3 | Replace with a deferral to `32` §3 once F1 is resolved |
| **P11** | Seed rule pack: 13 of 37 rules at `severity: high` = **35 %** | `corpus/rules/ipsec-junos-srx.yaml` | `63` §— gate **V25**: *"Pack-wide: ≤15 % of active rules are `severity: high`"*, severity `error` | The only shipped pack fails the only pack gate, by more than 2× | The file's own header argues the gate is wrong for a domain pack. **That argument belongs in `63` as a proposed amendment** (e.g. a per-domain exemption with a stated cap), not as a comment in a data file that CI will reject |
| **P12** | Every corpus entry carries `reviewed_by:` | `corpus/*` (37 rules, 91 commands, all explainers) | The rule pack header states plainly: *"`reviewed_by: <named reviewer>` is a placeholder and **invariant 10 is not satisfied** until it is replaced."* No fixtures exist, which `63` §15 requires | The corpus currently breaches invariant 10 and cannot pass `35` §9.3's `reviewed_by` gate or `12` §15.3's fixture gates | Honest as declared. It must be tracked as a release blocker in `71`, not only in a YAML comment |
| **P13** | Rule pack header: *"13 of **36** rules here are `high`"* | `corpus/rules/ipsec-junos-srx.yaml` | The file contains **37** rules (13 high, 13 medium, 8 low, 3 info) | A count in the document that governs the gate is wrong, which is how a gate exemption gets mis-sized | Recount |
| **P14** | Dark theme redefines the three risk colours: `--safe: #35A06E`, `--caution: #D97328`, `--danger: #EA6260` | `51` §—, the dark token block | `conventions.md`'s risk-enum block pins the three pairs by hex; `design-language.md` calls the palette *"ground truth, machine-extracted… not an interpretation"* and the legend *"the card's single most disciplined move"* | Defensible — `51` does the contrast work properly and the substitutions are hue-matched — but it is a redefinition of a pinned constant, made silently | Register it under `51`'s `## Disagreements` with the proposed conventions amendment (*"the three pairs are pinned for the light theme; a dark theme substitutes hue-matched pairs at equal or better contrast, listed here"*) |
| **P15** | Cross-reference `docs/10-core/61-command-corpus-spec.md` | (one document) | The file is `docs/60-content/61-command-corpus-spec.md` | Dangling reference | Correct the path |

---

## 8. The ten hard invariants, audited

| # | Invariant | Verdict | Detail |
|---|---|---|---|
| 1 | **No egress by default** | **Holds, with one registered carve-out** | `21` §18.1 raises it properly: tier 1 needs an explicit carve-out, not an implicit one. `34`'s CSPs are consistent per mode. `81` §7.1 finds `img-src 'self'` in modes C/D is an egress channel — that is a real breach and belongs to that critique |
| 2 | **Never touches a network device** | **Holds everywhere.** No document proposes SSH, NETCONF or an API. `43` §1.4 F6 and `03` reinforce it | — |
| 3 | **Never accepts a credential** | **Breached in spirit, and the breach is registered.** `32` §21.3 correctly identifies that the invariant welds two claims together and that `32` adds four more workspace secrets. Its proposed replacement is good and should be adopted | Adopt `32` §21.3 verbatim into `conventions.md` |
| 4 | **The server never holds a key** | **Breached as literally written; registered.** `32` §21.2 is right: the member log holds public X25519/Ed25519 keys and the sync service holds them (`33` §3.5's `MemberEntry.pubkey`). Adopt `32` §21.2's replacement | — |
| 5 | **Findings are data, not code. One rule engine** | **Holds.** `12` §3's `fex` decision is the strongest single piece of engineering in the corpus and it enforces this structurally | — |
| 6 | **Emitters return `(line, provenance)`** | **Holds.** `13`, `43` §1.4 F6, `21` §6.2's `emit.dry_run` all return `EmittedLine` | — |
| 7 | **Stable opaque IDs; never paths or names** | **Bent, unregistered.** §6.2. `12` §11.1 persists a name-derived key in a first-class workspace object, against `11` §10.3's explicit prohibition | Register and clarify |
| 8 | **`acceptable_when` mandatory on every rule** | **Holds in the corpus** — 37 rules, 37 `acceptable_when`. `82` §18 assesses their *quality*, which is the harder question | — |
| 9 | **Determinism where it is observable** | **Holds, and `17` §21.1's amendment is necessary.** With a CRDT, "same workspace" is ambiguous; `17`'s proposed "*same converged workspace state*" is correct and turns the invariant into something CI can test. **`44` §1.1's entire work-counter gating strategy depends on it** and is the best consequence of it in the corpus | Adopt `17` §21.1 |
| 10 | **Corpus human-authored, `reviewed_by` recorded** | **Breached today** (P12), declared. Also strained by `22`'s S5 rule-authoring subagent and S10 redaction-detector proposer — both draft corpus content. `22` handles it correctly (`drafts/` only, human `git mv`), but neither `22` nor `63` states that a model-drafted entry must record **both** the drafting agent and the human reviewer | Add a `drafted_by` field to `63` §— alongside `reviewed_by`, and require it when `drafts/` was the origin |

---

## 9. Terminology compliance against `conventions.md`

Compliance is **high** — noticeably higher than I expected of parallel authorship. The banned words
that would have been easy to slip (`ruleset`, `knowledge base`, `mute`, `per-vendor engine`) do not
appear anywhere. Three patterns of violation remain.

### 9.1 `model` used for something other than an ML model

`conventions.md`: *"**model** | an ML model, only | anything else"*. Occurrences meaning "design
position", "pattern" or "threat model shorthand":

| File | Line | Text |
|---|---|---|
| `docs/30-security/37-privacy-and-compliance.md` | 1079 | *"Never — this is the model"* |
| `docs/30-security/35-supply-chain-and-builds.md` | 1870 | *"Never — this is the model"* |
| `docs/30-security/31-threat-model.md` | 1287 | *"Never — this is the model"* |
| `docs/30-security/34-browser-hardening.md` | 1205, 1341, 1722 | *"outside the model"* (×3) |
| `docs/30-security/33-sync-protocol.md` | 1352 | *"just below the point the model breaks"* |
| `docs/50-design/55-accessibility.md` | 541 | *"is the model for every diagnostic table"* |
| `docs/60-content/61-command-corpus-spec.md` | 430 | *"names this table shape as the model for every…"* |
| `docs/00-vision/02-prior-art-and-positioning.md`, `docs/10-core/11-ir-schema.md` §6.4 | — | *"the model"* for the graph, in prose inherited from the brief |

Most are abbreviations of "threat model", which is a defined term the conventions did not exempt.
**The cheapest fix is to exempt it**: add a row to the terminology table reading
*"**threat model** | the enumerated adversaries and boundaries in `31` | may be abbreviated to 'the
model' inside `30-security/` only"*. Fix `55` §541 and `61` §430 to "the pattern"; fix `33` §1352 to
"the document model".

### 9.2 `record` — the same gap, found independently by two authors

`32` §2.3 and §21.1, and `17` §—'s opening note, both need a word for *a unit of encryption in the
container*, both choose `record`, and both write a paragraph explaining why they are allowed to. That
is two authors paying the same tax because the conventions have a hole. **`32` §21.1's proposed row
is correct and should be adopted**, and `17`'s opening note then deleted.

### 9.3 `agent` unqualified

`conventions.md`: *"**supervisor** / **subagent** … | 'agent' unqualified"*. Violations are rare and
mostly compound nouns that are legitimate (`EDR agent`, `agent process`, `user agent`). The one to
fix: `docs/00-vision/03-non-goals-and-scope.md` §— uses *"the agent"* for a subagent.

### 9.4 What passed

- No document says `ruleset`, `knowledge base`, `mute`, or `ignore` for a suppression.
- `platform` vs `vendor` is used correctly throughout; `82` uses `vendor` only where it means the
  company.
- `finding` is never called an issue, error or violation.
- The `Risk` enum is never used for severity. `12` §9 (*"Severity, confidence, category — and why
  none of them is `Risk`"*) and `44` §13 both check themselves against this explicitly. `82` §§1–2
  find that the enum is *misapplied* to specific commands, which is a domain error, not a
  terminology one.

---

## 10. What is missing entirely

These are the subsystems every document assumes someone else specified.

| # | Missing | Who assumes it exists | Why it matters |
|---|---|---|---|
| **M1** | **`schema.yaml` — the format, the authoring rules, and the versioning of the schema itself** | `11` §11.6 (*"the schema is data"*) states the position but does not specify the file. `12` depends on the schema declaring **edge roles**, **reverse-indexing**, **enum neutral variant names**, **per-field case-insensitivity**, **per-kind similarity weights** and **identity tuples**. `63` §5.3 depends on the platform enum map. `14` depends on the statement dictionary's binding to it. `43` §1.3 makes it a build-time input | **This is the biggest hole in the corpus.** Six documents make load-bearing demands on a file no document owns. `11` §17 lists open decisions and this is not among them. Without it, `12`'s `fex` type checker, `14`'s reconciler and `63`'s pack lint cannot be built |
| **M2** | **A `62-*.md` in `60-content/`.** The directory is `61-command-corpus-spec.md`, `63-rulepack-spec.md` — no 62 | `15-explainer-corpus.md` sits in `10-core/` and covers the explainer *design*; nothing covers the explainer *file format* the way `61` and `63` cover theirs | Either move `15`'s format sections to a `62`, or renumber. The gap looks like a lost document and someone will write a duplicate |
| **M3** | **The statement dictionary's content spec.** `14` §6 uses it; `71` §5.7 budgets *"~1,750 entries, 6–9 weeks of domain time"*; `22`'s `DICT_LOOKUP` tool reads it | No document specifies its schema, its ids, its review discipline, or its relationship to `61`'s command corpus | 1 750 authored entries with no format spec is the same failure mode as M1, on the largest content asset after the explainers |
| **M4** | **The workspace creation flow.** Four separate documents make an **irreversible creation-time** decision: `32` §6.2 (`S`, the shard count), `17` §10.1 (`opaque_frames`), `44` §4.8.4 (`DeviceFloor`), `43` §1.3 (AI tier ceiling, build-time) | Each says "this is a creation-time question with the trade stated, not a setting buried in preferences" | Nobody specifies the screen. Four irreversible questions, each argued in a different document, presented to a user who has just decided to try the tool. **`52-information-architecture.md` does not have a creation flow.** This is a product-defining omission |
| **M5** | **The migration runner.** `11` §11.3 defines what each version bump means; `32` §7.3 defines suite migration and *"re-seals opportunistically on write"*; `17` §13.5 mentions *"a schema migration saved"* rewrites every record | No document specifies who executes a migration, whether it is online or offline, what happens if it fails halfway through an encrypted document with no undo (`11` §10.5: *"there is no undo across an encrypted-document save"*), or how it is tested | The riskiest operation in the product — rewriting the user's only copy — has no owner |
| **M6** | **A unified diagnostics and error surface.** `32` has a crypto error taxonomy (`WrongKey`/`Tampered`/`Malformed`/…), `12` §3.8 has "engine diagnostics", `41` §3.9 has an error model at the boundary, `14` has residue, `17` §16 has `fsck` | Nothing maps these into one thing the user sees. `55-accessibility.md` needs one to specify announcements | The user meets six error vocabularies |
| **M7** | **An ownership register.** `73` registers open *decisions*; nothing registers which document *owns* a settled question | §2.1 shows all nine contradictions come from unowned questions. A one-page table would have prevented F1, F2, F3 and F4 |

---

## 11. What is duplicated, and the single document each topic should live in

| Topic | Duplicated in | **Owner** | Note |
|---|---|---|---|
| Record-granularity trade table | `32` §6.1, `17` §4.1, `73` §5.1 D15 | **`17`** | Three near-identical tables with different conclusions |
| Padmé padding | `31` §7.6, `32` §6.4 (with code), `17` §5.7 (with a 512-byte floor `32` lacks) | **`32`** | `17`'s small-frame floor is a real improvement; move it into `32` §6.4 |
| Key commitment | `32` §5.6, `17` §5.6 | **`32`** | Two constructions |
| Key hierarchy | `32` §3, `33` §3.4, `17` §6.3 (`K_name`) | **`32`** | |
| Git integration | `32` §13.3, `17` §12 | **`17`** | `32` §17.12's `cachetextconv` warning is better written; move the *warning* to `17` and delete the rest |
| Argon2 parameters | `32` §4.2, `44` §4.8, `43` §3.9 | **`32`** | `44`'s `DeviceFloor` proposal is sound; land it in `32` |
| Single-file size budget | `41` §3.10, `43` §3.2, `44` §5.3, `35` §13.2, `16` §9.4 | **`44`** | Five figures |
| CSP per mode/tier | `34` §2.2, `21` §7.5, `43` §3.7 | **`34`** | `21` already proposes one correction to itself; make it a deferral instead |
| Deployment mode lettering | `34` §2.1, `43` §1.1, `35`, `44` | **`43`** | |
| Re-identification | `11` §10.4, `12` §11.4 | **`11`** | §6 |
| Suppression shape | `12` §11.1, `17` §9 (correctly defers) | **`12`** | Already right |
| Subagent catalogue | `21` §5.1, `22` | **`22`** | §5 |
| Determinism invariant restatement | `12` §3.1, `24` §—, `43` §1.4, `44` §1.1 | **`conventions.md`** | Restatements agree; leave them, they are load-bearing locally |
| Field-card worked example (SRX side 1) | `11` §15, `12` §4.4, `13` §—, `14` §—, `44` §4.3, `63` §—, `32` §16.1 | **shared, deliberately** | This is the corpus's best habit, not duplication. Keep it |

---

## 12. Is this buildable? The real scope against the roadmap

### 12.1 The roadmap's own numbers

`71` §2: **106–158 weeks solo; 53–79 weeks for a team of three.** `71` states plainly that solo this
is *"a two-to-three-year project and the corpus does not finish at the end of it"*, and offers three
honest exits (after phases 0, 1 and 3). The estimate methodology in §14 is disciplined: it names its
line-rate assumption (150–250 lines/day of tested systems Rust), carries a `VERIFY` demanding it be
replaced with a measurement in phase 0's first four weeks, and explains why team-of-three is not
solo ÷ 3.

**That methodology is right. Two of the inputs are wrong.**

### 12.2 Phase 5 is under-estimated by a factor of two to three

`71` §8.6: **solo 16–24 weeks** for *"encryption, workspaces, sync"* — retiring R-ZK and R-CRDT, and
delivering D2 and D3.

What that phase actually contains, as specified:

| Component | Specified in | Honest solo estimate |
|---|---|---|
| The envelope, KDF, AEAD, commitment, Padmé, calibration, memory hygiene | `32` §§3–7, 14 | 4–6 wk |
| Keyholder table, HPKE multi-recipient wrapping, **hash-chained member log with Ed25519 quorum signatures replayed from genesis**, epoch rotation with **eager blocking re-seal**, recovery codes with a 40-bit checksum, Shamir escrow, WebAuthn PRF | `32` §§9–12 | **8–12 wk** |
| The test-vector tree (12 vector families) + `fathom-crypto-conformance` runner + negative-vector error taxonomy | `32` §16 | 3–4 wk |
| The container: two shapes, frames, keyed pseudonyms, manifest rebuild, atomic writes, `fsck`, `fsck --repair`, import (5 formats), the plaintext export gate and export log | `17` §§2–7, 14–16 | **6–9 wk** |
| The **keyless git merge driver**, `fathom git install`, the textconv, the unmerged-index recovery path, and the compaction-versus-git policy | `17` §12, §13.6 | 3–4 wk |
| The **hand-rolled CRDT**: four convergent types, HLC causality, per-field-class resolution, five worked conflict classes, `Field::Conflicted` through the UI, and the convergence property-test suite `33` §4.6 calls the way we *"buy back confidence"* | `33` §§4–7 | **8–12 wk** |
| Offline-first: backlog review, reconnection, **reconnecting across a schema major**, clock skew | `33` §8 | 3–4 wk |
| Compaction: claims, client-driven, safety for an offline client, triggers | `33` §9 | 3–4 wk |
| The sync service: OPAQUE (RFC 9807) in Rust **and in WASM**, nine endpoints, Merkle index, quota, rate limiting, SSE | `33` §§2–3, 10; `41` §5 | **6–8 wk** |
| D2 and D3: image, compose, Helm, HA index store, object store, IdP integration, and **five operational runbooks** | `43` §§5–6, 9 | 4–6 wk |
| **Total** | | **48–69 weeks** |

That is **three times** the roadmap's 16–24. The roadmap's phase-5 breakdown (§8.6) does not
enumerate the member log, the conformance runner, `fsck`, the export gate, the merge driver, OPAQUE,
or D3's cluster work as separate lines. It also budgets *"external review and rework: 2–4 weeks
elapsed, mostly waiting"* — for a scheme with a hand-rolled member log and a novel key-commitment
construction, a real cryptographic review is 6–10 weeks elapsed and the rework is not free.

### 12.3 Phase 6 is under-estimated by roughly the same factor

`71` §9.6: **solo 14–22 weeks** for the AI layer, tiers 0→3.

`22-agent-catalog.md` alone is 3 782 lines specifying ten subagents, each with a dispatch trigger, a
tool grant, a failure table and an eval. `25-ai-evaluation.md` is 1 704 lines of eval harness.
`23-ai-safety-and-injection.md` is a full injection-defence programme. `21` §7 specifies **four
deployment tiers**, including in-page WebGPU inference (§7.2a) and a loopback sidecar (§7.2b) with
its own CORS and private-network-access story. `21` §6.6's broker, §8's egress pre-flight with
per-field classification, and §8.6's egress log are each multi-week subsystems.

Honest solo estimate: **30–45 weeks**, and that assumes the eval harness in `25` is scoped down.

### 12.4 The corpus track is the real schedule, and the roadmap knows it

`71` §15.3 gets this right: the corpus is a track, not a phase, and R-CORPUS is flagged *"Fatal,
slow"*. But the numbers are optimistic in a way that compounds:

- `15` §12.6's estimate: **6–7 person-weeks for v1 explainers**, doubling to ~11–12 if the median
  entry costs 60 minutes rather than 35. **No entry has been authored and timed.** `71` §12.1 makes
  this a re-plan trigger, correctly.
- `71` §10.6: PAN-OS IPsec alone is *"6–8 person-weeks"*, and the full second-platform corpus is
  *"roughly six person-months"*.
- M3's statement dictionary is 1 750 entries at 6–9 weeks of domain time.
- The seed rule pack (37 rules) exists but has **no fixtures and no reviewer** (P11, P12), and `12`
  §15.3 requires fourteen gates per rule. Budget 45–90 minutes per rule for fixtures alone.

Summed, the v1 corpus is **20–30 person-weeks of expert domain time**, and it is on the critical
path for every phase after 0.

### 12.5 The honest total

| | `71`'s figure | This review's figure |
|---|---|---|
| Solo, to phase 7 | 106–158 wk | **170–240 wk** — four to five years |
| Team of three, to phase 7 | 53–79 wk | **85–120 wk** — two to two and a half years |
| Team of five | not estimated | **65–90 wk**, and the marginal returns are poor past four: `41` §9.1's boundary, `32`'s crypto and `33`'s CRDT are each one person's serial critical path and they cannot be parallelised against each other |

**One person cannot build this as specified.** Not because any part is beyond one person, but
because the corpus alone is a second full-time job and the roadmap's own §15.3 says so. A team of
five can, in roughly two years, **if** two of the five are network engineers writing corpus rather
than engineers writing Rust.

### 12.6 The scope reduction that actually works

`71` §12's exits are the right instrument and they are under-used. The strongest version:

> **Ship phases 0–3, stop, and defer 5 and 6 indefinitely.**
> That is the finder, the graph, one platform, the walkthrough, paste, inventory, findings, diff,
> verify and rollback — **58–84 weeks solo** by the roadmap's own numbers, and it is a coherent,
> differentiated, shippable product. It needs no CRDT, no sync service, no member log, no HPKE, no
> AI layer, no D2, no D3, and no OPAQUE. The workspace is a passphrase-sealed file on disk with a
> single keyholder, which is `32` minus §§9–12 — perhaps four weeks of crypto rather than twenty.

The corpus does not currently name this exit. `71` §12.4's "after phase 3" kill point asks whether to
*stop*; it does not present "phases 0–3 plus single-user encryption" as a **product**. It is the best
product in the plan and it should be the default plan, with 5 and 6 as funded expansions.

**What that gives up, stated:** multi-user, sync, the AI layer the owner explicitly asked for, and
the enterprise deployment shapes. The AI layer is the hardest thing to give up because it is a direct
owner instruction — but `21` §7.1's *"Tier 0 — no AI, and not second-class"* is exactly the argument
for deferring it, made by the AI document itself.

---

## 13. What to do, in order

| # | Action | Blocks |
|---|---|---|
| 1 | **Resolve F1.** One container specification. `17` owns the container, `32` owns the crypto, and one of the two update models wins | `33`, `35` A9, `44` §4.8, `43` §9, any implementation |
| 2 | **Resolve F2.** Edit `34` §3.3 to reflect `73` D07, or reverse D07. Then reconcile the five size figures into `44` §5.3 | `41`, `43`, `44`, `35`, `16` |
| 3 | **Measure the WASM core.** 700 KB or 3 MB is a factor of four and it decides the artifact | F2, B17, B18 |
| 4 | **Fix P2** — one word, total confidentiality consequence | nothing; do it now |
| 5 | **Resolve P1** — WebAuthn PRF or `publickey-credentials-get=()`, not both | `32` §12, `34` H11 |
| 6 | **Write M1** — the `schema.yaml` specification | `12`, `14`, `63`, `11` §11.6 |
| 7 | **Resolve F3.** `22` owns the roster; rewrite `21` §5.1, §7.6 and §13 | phase 6 |
| 8 | **Resolve F4.** `11` owns re-identification; `12` §11.4 becomes a deferral plus a recovery key | `12`, `14`, `17` §16 |
| 9 | **Adopt the four registered invariant amendments**: `32` §21.1 (record), `32` §21.2 (secret key material), `32` §21.3 (credential), `17` §21.1 (converged determinism), and `17` §21.2's identifier additions | `conventions.md` |
| 10 | **Add M7, the ownership register**, as `docs/00-vision/01-ownership.md` — one table, one line per settled question, naming the owning document | everything after |
| 11 | **Write M4**, the workspace creation flow, into `52` | phase 5, and the product |
| 12 | **Re-plan phases 5 and 6** against §12's figures, and name the phases 0–3 exit as a product | `71` |

---

## 14. What the corpus gets right, and must not lose in revision

Criticism is worth nothing without calibration, so:

- **`12-rule-engine.md` §3 is the best decision in the corpus.** Deriving a purpose-built expression
  language from the requirement that *read-set extraction must be total*, then pricing it honestly at
  2 000–2 500 lines, is exactly how an architectural decision should read. §5.3 (*"The dynamic case
  does not exist, by construction… Write it on the wall"*) is the load-bearing sentence of the whole
  incremental engine and it is defended properly.
- **`44` §1.1's work-counter insight is the best consequence of any invariant.** *"Because the
  product is deterministic, its work is a checked-in artefact."* A gate that fails in forty seconds
  on a free runner with a message naming the query is worth more than every stopwatch in the
  document, and §9's *"a perf test that fails 3 % of the time gets `continue-on-error` within a
  month"* is the reason.
- **`32` §4.7 refuses to oversell its own subject.** A cryptography document whose conclusion is
  *"Argon2id multiplies the attacker's per-guess cost by a constant. It does not add bits"* — and
  which then makes the generated passphrase the default path — is doing the honest thing at its own
  expense.
- **`17` §5.4's keyless merge driver is a genuinely elegant result**, and §5.5 prices its disclosure
  without flinching. If F1 resolves in `32`'s favour, this idea should be carried over, not lost.
- **`33` §3.5's sentence** — *"Removing a member from the list removes their ability to write to the
  server. It does not remove their ability to read"* — is the kind of thing most E2EE products blur,
  and it is stated in the register the owner asked for.
- **`43` §1.1 noticed a naming collision and resolved it in public**, which is the behaviour that
  would have prevented F1 and F2 had it been applied to the format and the artifact.
- **The field card is used as a source, not as decoration.** `11` §15, `12` §4.4, `82`'s entire
  method and `32` §16.1's `99-workspace/` acceptance test all reach for the same worked SRX example.
  That shared fixture is the strongest structural force for coherence in the corpus and it is why the
  *domain* layer holds together far better than the *format* layer.
- **`71` §14.3, `73`'s reversal-cost scale, and `03`'s non-goals** are three instruments most
  projects never build. They are why the contradictions above are findable at all.

The corpus's failure is not carelessness. It is that thirty documents were asked to be authoritative
and none was told which questions it owned. Every contradiction in §§3–7 is at a boundary where two
careful authors each reasonably believed the question was theirs.

---

## 15. Disagreements

**15.1 — `conventions.md` needs an ownership rule, not only a terminology table.**

*The convention:* *"Many documents in `docs/` are authored independently. These conventions are
pinned so they compose. **Do not redefine any of these.**"*

*The objection:* the pinned list covers vocabulary, invariants, colours and identifiers. It does not
cover **decisions**. Nothing in it stops two documents from specifying the same bytes differently,
which is what happened four times. The instruction "do not redefine any of these" was obeyed —
`conventions.md`'s own contents were not redefined by anybody — and the corpus still failed to
compose.

*Proposed addition, under a new heading:*

> ## Ownership
>
> Every settled question has exactly one owning document, listed in
> `docs/00-vision/01-ownership.md`. A document that is not the owner of a question **defers** to the
> owner in one sentence and does not restate the answer, except to lift a specific number verbatim
> with a citation. A document that believes the owner is wrong adds a `## Disagreements` entry; it
> does not specify an alternative.
>
> If you find yourself writing a second full specification of something a sibling document also
> specifies, you have found a missing row in the ownership register. Add it before you write.

**15.2 — the `## Disagreements` mechanism works, and it is not enough.**

Every disagreement raised through the mechanism (`32` §21, `17` §§20–21, `44` §13, `21` §18, `43`
§13) is well-argued and easy to act on. **Not one of the four schisms in this review was raised
through it**, because the mechanism only fires when an author *notices* a conflict — and a document
that re-decides a question in good faith has, by definition, not noticed.

*Proposed addition to the document conventions:*

> Before writing, list every sibling document that touches your subject and read its decision table
> (§1 of most documents). Record in your own §1 which sibling decisions you are **building on** by
> name and section. A document with no such list is a document that has not checked.

**15.3 — `Status:` needs a fifth value.**

*The convention:* *"Every doc opens with a `> **Status:**` line: `Proposed`, `Accepted`, `Contested`,
or `Reconstructed`."*

*The objection:* `17` and `32` are both `Proposed`, which is accurate and useless — it does not tell a
reader that they are proposing *incompatible* things. `73`'s register tracks decisions; the status
line should track a document's relationship to the register.

*Proposed replacement:* add **`Superseded by NN §M`** and require that a document whose core decision
is contradicted by a sibling carry `Contested`, naming the sibling. Under that rule, `17`, `32`, `21`,
`22`, `34`, `43` and `44` would all currently read `Contested`, which is the honest state of the
corpus and the fastest way to stop someone implementing from the wrong one.
