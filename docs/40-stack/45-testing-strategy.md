# 45 — Testing strategy

> **Status:** Proposed

Companion documents: `42-no-node-runtime.md` §4 (the harness, and why there is no Playwright),
`44-performance-budgets.md` §8 (the perf half of CI), and the per-subsystem test sections this
document composes rather than restates — `12` §15, `13` §11, `14` §13, `32` §16, `34` §8, `35` §11,
`61` §14, `63` §15.

**The governing rule of this document, stated once, in caps, at the top:**

> **THE OUTPUT OF THIS PRODUCT IS PASTED INTO A PRODUCTION FIREWALL BY SOMEBODY WHO TRUSTED IT.
> CORRECTNESS IS NOT A QUALITY ATTRIBUTE HERE. IT IS A SAFETY PROPERTY, AND THE TEST SUITE IS THE
> ONLY THING BETWEEN A REFACTOR AND AN OUTAGE.**

The field card says the same thing in the operator's voice, on all four sides, and it says it as a
disclaimer because a paper card cannot test itself: **VERIFY AGAINST YOUR OWN BOX BEFORE ACTING.**
A tool that generates config inherits that sentence as an obligation. §11 is the section that decides
how far we can discharge it, and it ends honestly: not all the way.

---

## 0. Contents

| § | |
|---|---|
| 1 | What this document owns, and what already has an owner |
| 2 | The pyramid, with counts and wall clock |
| 3 | Unit tests in Rust |
| 4 | Property tests — the invariant catalogue |
| 5 | Golden-file tests for emitters |
| 6 | Rule fixtures |
| 7 | Snapshot tests for explainer rendering |
| 8 | Fuzzing |
| 9 | End-to-end browser tests |
| 10 | Mutation controls — the tests that test the tests |
| 11 | Cross-validation against reality |
| 12 | Crypto testing |
| 13 | Security testing |
| 14 | Corpus testing |
| 15 | Test data — the synthetic estate generator |
| 16 | CI topology and wall clock |
| 17 | Flakiness, quarantine, and the zero-retry policy |
| 18 | Coverage — what we gate and what we refuse to gate |
| 19 | What CI enforces |
| 20 | Things that bite |
| 21 | Open decisions |
| 22 | Sources |
| 23 | Disagreements |

---

## 1. What this document owns

*margin tab: read this first*

Eight documents already specify tests for their own subsystem, in more detail than a strategy document
should attempt to repeat. This one exists to do four things none of them can:

| # | This document's job |
|---|---|
| 1 | **Say what kind of test each claim needs**, so a new subsystem does not invent a fifth testing style |
| 2 | **Own the cross-cutting suites** — cross-validation (§11), the synthetic estate generator (§15), mutation controls (§10) — which belong to no single subsystem and would otherwise belong to nobody |
| 3 | **Own the CI topology** — what runs on a PR, what runs nightly, what runs per release, and the wall-clock budget for each (§16) |
| 4 | **Own the honesty** — §11's residual, §18's refusal to gate on line coverage, §15's statement that a generated oracle is circular |

The map of what is already owned, so nothing here is read as a redefinition:

| Owned by | What |
|---|---|
| `12` §15 | Rule engine fixture execution, the pack CI gate |
| `13` §11 | The round-trip laws E1–E4 and the `arb_graph` generator |
| `14` §13 | Fuzz targets A–E, `ValidConfig` / `DamagedConfig` / `ConfigWithCanaries`, the corpus taxonomy, the panic/hang policy |
| `18` §3.8 | The change-set self-check D1, and D2/D3 |
| `32` §16 | The crypto vector tree, the negative vectors, the deterministic-seal hook and its three controls |
| `34` §8 | H1–H40 — CSP, DOM sinks, storage, clipboard, SRI |
| `35` §11 | Reproducibility, `cargo-deny`, signing, the build's own gates |
| `42` §4, §9.4 | The harness (WebDriver, the first-party micro-runner), and checks 1–14 including the egress assertions |
| `61` §14, `63` §15 | Corpus and rule-pack lint gates, fixture requirements |
| `23` §9, `25` | The injection corpus; the AI layer's evaluation regime |
| `44` §8 | Work counters, benchmarks, the wall-clock ratchet |

---

## 2. The pyramid, with counts and wall clock

*margin tab: fields that matter*

The classic pyramid says most tests are unit tests and few are end to end. That shape is right here
for the wrong reason: not because unit tests are cheap, but because **almost every claim this product
makes is a claim about a pure function of data.** `emit`, `lint`, `parse`, `rank`, `diff`, `explain`
are all `fn(&Graph, …) -> T` with no I/O, no clock and no network. That is the whole reason the
architecture was chosen (`41` §2) and it is a testing dividend nobody designed for.

There is one inversion and it is deliberate. §5.

| Layer | Count at v1 | Wall clock | Runs |
|---|---|---|---|
| Rust unit tests | ~2,500 | 40 s | every PR |
| Property tests (proptest) | ~60 properties | 6 min at 256 cases; 40 min at 4,096 | PR (reduced) / nightly (full) |
| Golden-file emitter tests | ~400 fixtures | 8 s | every PR |
| Rule fixtures | ≥ 2 per rule, ≥ 500 at v1 | 20 s | every PR |
| Explainer snapshots | ~1,200 (entries × 3 depths) | 15 s | every PR |
| Crypto vectors | 12 files, ~600 cases | 5 s | every PR |
| Corpus lint (`61` gates 1–14, `63` pack build) | — | 30 s | every PR |
| WASM-in-browser unit tests | ~120 | 3 min | every PR |
| TS unit tests (first-party micro-runner, `42` §4.2 B) | ~180 | 90 s | every PR |
| End-to-end keyboard flows | ~45 | 9 min | every PR |
| Fuzzing, 5 targets | 60 s each | 5 min | every PR |
| Fuzzing, full | 30 min each | 2.5 h | nightly |
| Work counters (`44` §8.2) | 30 scenarios | 40 s | every PR |
| Wall-clock perf | 19 budgets | 20 min | nightly, REF-1 |
| Batfish differential (§11.4) | ~200 emitted configs | 12 min | nightly; PR in warning mode |
| Mutation controls (§10) | ~35 mutants | 6 min | every PR |
| Conformance lab (§11.2) | ~40 configs on real Junos | ~90 min, manual | per release |

**PR budget: ≤ 15 minutes wall clock, in parallel jobs.** Stated as a budget because it is one:
a 45-minute PR pipeline is a pipeline people learn to route around, and the routing-around is
invisible until the release that breaks.

---

## 3. Unit tests in Rust

*margin tab: the boring 2,500*

### 3.1 What a unit is here

| Unit | Example | Why not larger |
|---|---|---|
| One scalar codec | `Ipv4Prefix::parse("10.1.0.0/16")` and its `render` | `11` §4.2's laws L1/L2 are per-scalar; a failure must name the scalar |
| One dictionary entry's bind | `set security ike gateway GW-B external-interface reth0.0` → `IkeGateway.external_interface` | `14` §6.5's dictionary is 2,000 entries per platform and a wrong entry is a wrong graph. Per-entry tests are how a wrong entry is found by name |
| One `fex` builtin | `enum_is`, `field_exists_on_platform` | `12` §3's condition language; a builtin that is wrong is wrong in every rule that calls it |
| One emitter's `KindEmitter` for one field | `IpsecPolicy.perfect_forward_secrecy` → `set security ipsec policy {p} perfect-forward-secrecy keys group14` | §5 says the golden file is the specification; the unit test is what makes the golden file's *diff* readable |
| One graph store invariant | L0 checks on a mutation (`11` §—) | Cheap, and the property tests depend on the store rejecting invalid ops (§4.3) |

### 3.2 Conventions

| Convention | Reason |
|---|---|
| `#![forbid(unsafe_code)]` in every crate except `fathom-wasm`; `#![deny(clippy::unwrap_used, clippy::expect_used, clippy::panic, clippy::indexing_slicing)]` in `fathom-ingest` and `fathom-rules` | `14` §13.5 already sets this. Test code is exempted only inside `#[cfg(test)]` |
| No test reads the clock, the filesystem outside `fixtures/`, the network, or the environment | Invariant 1 and invariant 9. A test that reads `SystemTime::now()` is a test that fails once a year |
| `insta` for anything with more than five lines of expected output | A hand-written expected string in Rust source is a string nobody updates correctly |
| Every error enum variant has at least one test that produces it | §18.3. This is a coverage gate that means something, unlike line coverage |
| Fixtures are `.set`, `.yaml` or `.json` files under `fixtures/`, never inline heredocs over ~10 lines | A network engineer can review a `.set` file. They cannot review a Rust raw string literal |

### 3.3 The one thing unit tests here cannot do

A unit test proves the code does what the author thought. For a config emitter the interesting
question is whether what the author thought is what Junos does, and no amount of Rust answers that.
That gap is §5 (a golden file a human reviews), §11 (an independent oracle), and — irreducibly — a
network engineer's judgement.

---

## 4. Property tests — the invariant catalogue

*margin tab: why it exists*

### 4.1 The catalogue

`proptest`, seeded deterministically, with the seed printed on failure and the minimised case written
to `proptest-regressions/` and committed. Every entry names the failure it prevents in the product,
not the mathematical property, because the mathematical property is not what convinces a reviewer to
keep the test alive.

| # | Property | Statement | Prevents |
|---|---|---|---|
| **E1** | emit is a fixed point through parse | `render(emit(parse(render(emit(g,p))),p)) == render(emit(g,p))` and the two `EmitReport`s agree on gaps and substitutions (`13` §11.1) | The paste-in / edit / paste-out loop of brief §6.3 drifting **silently, once per round** |
| **E2** | parse normalises, it does not rewrite | For every config line `t` in the fixture corpus, `render(emit(parse(t)))` differs from `t` only by the platform's declared normalisation | A parser that "helpfully" reorders or reformats a config the user pasted |
| **E3** | emit is deterministic | Two emits, in one process and in fresh processes with randomised hasher seeds, are byte-identical with identical `LineId`s | Invariant 9. Also: a diff between two releases that is noise |
| **E4** | order is stable under unrelated edits | Changing a field on node `X` does not reorder any two lines that do not source from `X` | `44` §4.6's B11. Without it every edit is a full re-emit and every diff is unreadable |
| **D1** | the change set reaches B | `parse(render(emit(A)) ++ render(config_diff(A,B))) ≡path emit(B)` (`18` §3.8) | The lines in a change ticket not producing the configuration in the diff. This one runs **at runtime**, on every export, not only in CI |
| **D2** | empty diff | `config_diff(A,A)` contains no configuration lines | A diff engine that emits spurious lines is one nobody runs twice |
| **D3** | diff round trip | `config_diff(B,A)` after `config_diff(A,B)` returns the line index to `emit(A)`, **for changes whose `Reversibility` is `Mechanical`** | A rollback that does not roll back. The qualifier is load-bearing and §4.4 is about it |
| **P1** | parse is total | `ingest::run` returns a report for every byte string; never `Err`, never a panic, never a hang | Fuzz target A, lifted to a property with structured input |
| **P2** | the ledger tiles | `ledger.covered_bytes() == capture.text.len()` and `ledger.lines.len() == report.total_lines()` | Silent loss — a line the parser dropped without saying so |
| **P3** | re-parse is idempotent | Ingesting the same config twice produces the same node ids, no conflicts, and identical values; only provenance changes | Duplicate devices on a re-paste, which is the single most common real-world action |
| **P4** | scalar round trip | For every scalar kind, `parse(render(v)) == v` and `render(parse(t))` is `t` modulo declared normalisation | `11` §4.2 L1/L2 |
| **P5** | canonical CBOR is canonical | `decode(encode(x)) == x` and `encode` output matches RFC 8949's deterministic-encoding rules for every shape in the schema | A workspace that a second implementation cannot byte-match (`32` §16.1's whole premise) |
| **P6** | finder ranking is a total order | For any query and corpus, the ranking is deterministic and antisymmetric; no two entries tie without the declared tiebreak | Invariant 9's "identical finder ranking" clause |
| **P7** | finding identity is stable | A finding's identity survives re-parse, rename and reconciliation (`12` §10.1, §11.4) | Suppressions silently detaching, which is how a waived finding comes back and a real one stays hidden |
| **P8** | suppression is monotone | Adding a suppression never adds a finding; removing one never removes a finding | A suppression that changes the result set in the direction nobody expects |
| **P9** | CRDT merge converges | For any two op sequences from a common ancestor, merge in either order yields the same graph | `33` §—. Two engineers, one workspace, one estate |
| **P10** | no record key is ever reused | §12.4 | Nonce reuse in ChaCha20-Poly1305, which is total loss of confidentiality for the affected records |
| **P11** | emitted bytes are printable | Every emitted line is `[\x20-\x7E]` plus `\n` | `34` H33. A control character in a config pasted into a terminal |
| **P12** | no credential is ever emitted | Every emitted line matching a credential-bearing statement path carries the placeholder form | Invariant 3. `34` H34 |
| **P13** | risk is never absent | Every `EmittedLine` carries a `Risk` from the three-value enum, and every `ChangesConfig` or `Disruptive` line carries `blast_radius` and `reversible` | A line that renders with no colour band, which the user reads as safe |

### 4.2 Case counts, and where they are spent

| Property | PR cases | Nightly cases | Why |
|---|---|---|---|
| E1, D1, D3 | 256 | 4,096 | The expensive ones — each case is an emit, a parse and a second emit |
| P4, P5, P6 | 1,024 | 16,384 | Cheap, pure, and the shrinking is fast |
| P9 (CRDT) | 128 | 2,048 | Each case is a schedule, not a value; the state space is enormous and 128 finds structural bugs |
| P10 | 64 schedules | 1,024 schedules | §12.4; each case simulates several devices |
| everything else | 256 | 4,096 | default |

### 4.3 The generator is the hard part, and it is where this is usually got wrong

`13` §11.2 states the rule and it is worth elevating to a strategy-level principle, because it applies
to every generator in the suite:

> **Generate operations, not values.** `arb_graph` builds a `Vec<GraphOp>` and applies it through the
> store's write API, which rejects anything that would break an invariant. Shrinking removes
> operations, so **every shrunk value is a valid graph by construction.**

The alternative — deriving `Arbitrary` on the `Graph` struct — produces failing cases that violate the
schema's own invariants, and a failing case that could never occur tells you nothing except that you
now have a test nobody trusts. That is how property tests die.

Three corollaries:

| Generator | Generates | Not |
|---|---|---|
| `arb_graph(Domain)` | op sequences through the store | `Graph` structs |
| `arb_config(Platform)` | a `ValidConfig` spec, rendered to text (`14` §13.3) | random `set` lines |
| `arb_schedule(devices, ops)` | an interleaving of ops across simulated devices | random CRDT states |
| `arb_query()` | token sequences drawn from the corpus's own term dictionary plus a controlled proportion of typos and out-of-vocabulary tokens | random strings, which test the tokeniser and nothing else |

`arb_query`'s design deserves the note: a uniformly random string exercises the normaliser and never
reaches the ranker. A query generator that never produces a query a human would type is a benchmark of
the wrong function.

### 4.4 D3's qualifier, and why the property is stated weakly on purpose

`D3` holds only for changes whose `Reversibility` is `Mechanical`. `18` §5 is the whole of that
qualifier, and the honest reading is: **a large fraction of interesting changes do not mechanically
invert.** Deleting a policy and re-adding it does not restore its position; clearing an SA does not
restore the sessions; renaming inverts in the configuration and does not invert in the world.

A property test that asserted `D3` unconditionally would fail, and the repair somebody would reach for
is to weaken the property until it passes — at which point the test is asserting whatever the
implementation happens to do. **Stating the qualifier up front is what stops that.** The test is:

```rust
proptest! {
    #[test]
    fn d3_mechanical_changes_invert(
        (a, b) in arb_graph_pair(Domain::IpsecSiteToSite),
        p in arb_platform(),
    ) {
        let fwd = config_diff(&a, &b, p);
        prop_assume!(fwd.reversibility() == Reversibility::Mechanical);
        let back = config_diff(&b, &a, p);
        let after = apply_to_index(apply_to_index(emit(&a,p).index(), &fwd), &back);
        prop_assert_eq!(after, emit(&a, p).index());
    }
}
```

and there is a **second** test asserting that non-mechanical changes are *reported* as such rather
than silently attempted. That second test is the one that matters operationally: a rollback that
claims to be a rollback and is not is worse than no rollback offered.

---

## 5. Golden-file tests for emitters

*margin tab: the inversion*

### 5.1 Why this layer is the top of the pyramid, not the bottom

**The most valuable tests in this product are not unit tests, and pretending otherwise produces a
suite that is green while the output is wrong.**

The reason is specific. An emitter unit test asserts that a field renders to a string the author
typed twice. A golden file asserts that the *whole device*, in order, with continuation backslashes,
with the object chain in the order Junos wants it, is a configuration a network engineer would sign
off. Only the second thing is reviewable by the person whose judgement we actually need.

So: **every emitter ships golden files, the golden files are checked in as vendor-syntax text, and a
change to one is a reviewed diff in the vendor's own language.**

### 5.2 Layout

```
crates/fathom-emit/tests/golden/
  junos-srx/
    ipsec-site-to-site-route-based/
      workspace.fathom          # sealed fixture, known passphrase, committed
      graph.digest              # BLAKE3 of the canonical graph — pins the input
      expected.set              # the emitted config, verbatim, with wraps
      expected.provenance.json  # LineId → (node, fields, rules, risk, order_hint)
      expected.report.json      # gaps, substitutions, blockers
      README.md                 # one paragraph: what this fixture is for, who reviewed it
    ipsec-policy-based-legacy/
    ipsec-nat-t-behind-pat/
    mtu-mss-clamp/
    chassis-cluster-reth/
  panos/
  ios-xe/
```

### 5.3 The fixture that anchors the whole suite

The first golden fixture is the field card, side 1, emitted from a graph built to match it. Verbatim,
including the continuation backslashes, because `design-language.md` item 5 requires that emitted
config wrap the way a terminal wraps:

```
set security ike proposal IKE-P1 \
  authentication-method pre-shared-keys
set security ike proposal IKE-P1 dh-group group14
set security ike proposal IKE-P1 \
  authentication-algorithm sha-256
set security ike proposal IKE-P1 \
  encryption-algorithm aes-256-cbc
set security ike proposal IKE-P1 lifetime-seconds 28800
set security ike policy IKE-POL proposals IKE-P1
set security ike policy IKE-POL pre-shared-key \
  ascii-text "<psk>"
set security ike gateway GW-B ike-policy IKE-POL
set security ike gateway GW-B address 203.0.113.10
set security ike gateway GW-B external-interface reth0.0
set security ike gateway GW-B version v2-only
set security ike gateway GW-B dead-peer-detection \
  always-send interval 10 threshold 3
```

Four properties are asserted against this one file, and each of them is a separate way the product
could be wrong:

| Assertion | What it catches |
|---|---|
| Byte equality with `expected.set` | Any emitter change, including a whitespace change |
| `ascii-text "<psk>"` and never a value | **Invariant 3.** The card itself writes `<psk>`; so do we, permanently |
| Object-chain order: proposal before policy before gateway | Junos enforces references at commit; emitting `ike policy` before its `proposal` produces a config that fails commit. Side 1: *"Junos enforces these references at commit — a missing policy name fails the commit"* |
| Every line's `risk` is `ChangesConfig` | These are `set` lines. A `set` line rendering as `ReadOnly` would show a green band on a config change, which is the exact misread the three-colour legend exists to prevent |

### 5.4 Review discipline

| Rule | Reason |
|---|---|
| A golden diff in a PR is reviewed **as vendor configuration**, by someone who could commit it | A reviewer reading a Rust diff cannot tell that `encryption-algorithm` moved above `dh-group` |
| A golden file is never regenerated wholesale in the same commit as a behaviour change | `xtask golden --accept` writes the new bytes; a commit that both changes an emitter and accepts 400 goldens is unreviewable and must be split |
| `README.md` per fixture names the scenario and the reviewer | Invariant 10's `reviewed_by` discipline, applied to fixtures |
| Every fixture that exercises a `Disruptive` line carries a comment saying why | So that a fixture directory is also a list of everything the product can emit that drops traffic |

### 5.5 Coverage gate

**Every `StatementPath` any emitter can produce appears in at least one golden file.** This is
checkable statically: the emitter registry enumerates its paths, the golden corpus is parsed, and the
set difference is the gate. A new emitter path with no golden file fails the build with the path
printed.

That gate is the reason this suite stays honest. Without it, the golden corpus is whatever somebody
happened to write in 2026 and the paths added in 2028 are untested forever.

---

## 6. Rule fixtures

*margin tab: every rule pays rent*

### 6.1 The requirement, restated because it is the whole quality control on the corpus

`63` §15: **every rule ships at least one `must_fire` fixture and at least one `must_pass` fixture**,
and rules with a `discriminator` ship a fixture that fires more than once. Fixtures live beside the
rule, not in a central `tests/` directory, so a withdrawn rule takes its evidence with it.

Fixtures are written as vendor config (`.set` text), not as graph JSON. Three consequences, all good:

| Consequence | |
|---|---|
| The fixture doubles as a parser test | A rule fixture that stops parsing is a parser regression found by the rule suite |
| A network engineer can review it | Which is the point. `ipsec.pfs.absent`'s fixture is a config with no `perfect-forward-secrecy` line |
| The fixture is a worked example | It can be shown in the explainer as *"this is what triggers this"* without a second authoring step |

### 6.2 The third fixture kind — `must_not_fire`, and why it is not the same as `must_pass`

`must_pass` means "this configuration is correct, so the rule stays quiet." **`must_not_fire` means
"this configuration looks wrong and is not, so the rule must stay quiet even though it is tempting."**
Those are different tests and only the second one prevents a linter from being disabled.

The field card supplies the canonical example, side 2:

> *"`mode` is silently ignored under `v2-only`. Seeing `mode aggressive` in a v2 config means nothing
> — do not chase it."*

So any rule about aggressive mode ships a fixture containing:

```
set security ike gateway GW-B version v2-only
set security ike policy IKE-POL mode aggressive
```

and asserts **no finding**. A rule that fires here is a rule that sends an engineer chasing a
non-problem, and `5.2`'s warning — *"tools that flag everything as critical are muted within a
week"* — arrives one week later.

Four more `must_not_fire` fixtures drawn straight from the card:

| Fixture | Assertion | Card |
|---|---|---|
| IKEv2 initial bring-up with no DH in the first child SA | No PFS finding | Side 2: *"Under IKEv2 the first child SA is always keyed from the IKE SA regardless… A capture of the initial bring-up showing no DH is not a misconfiguration"* |
| GCM proposal with no `authentication-algorithm` | No "missing hash" finding | Side 1: *"GCM is AEAD, so there is no separate authentication-algorithm"* |
| Two ESP SPI lines per selector | No "duplicate SA" finding | Side 3: *"One per direction — two lines per selector is correct, not a duplicate"* |
| Differing IKEv2 lifetimes on the two ends | No finding, or informational at most | Side 2: *"IKEv2 … A mismatch is legal, not an error"* |

**RECOMMENDATION — `must_not_fire` fixtures are mandatory for any rule whose subject appears in the
field card's `THINGS THAT BITE` or `FLAP PATTERN → CAUSE` tables**, because those are exactly the
places where a plausible-looking signal has a benign explanation.

### 6.3 Two-sided rules

The card's governing line for side 2 is `BOTH ENDS MUST AGREE — EVERY VALUE, EXACTLY`, and `12` §8
already owns the problem that Fathom usually holds one side. The fixture requirement follows:

| Rule shape | Fixtures required |
|---|---|
| One-sided (`ipsec.pfs.absent`) | `must_fire`, `must_pass` |
| Two-sided (`ipsec.pfs.group-mismatch`) | `must_fire` with both devices present; `must_pass` with both present and matching; **and a `must_abstain` fixture with only one side present**, asserting the rule reports "cannot check" rather than passing |

The third one is the important one. A two-sided rule that silently passes when it can only see one
side is a rule that says "no findings" about a config it never checked, and that is the most dangerous
output this product can produce.

---

## 7. Snapshot tests for explainer rendering

*margin tab: what the log means*

### 7.1 What is snapshotted

`insta` snapshots, one per `(explainer id, depth)` triple, plus a rendered-DOM snapshot for the block
kinds.

| Snapshot | Asserts |
|---|---|
| `explain:rule:ipsec.pfs.absent @ terse` | One line, no prose, matching the finding's title |
| `… @ explained` | The why, the symptom-if-mismatched, the remediation for the current platform, the `acceptable_when` |
| `… @ teaching` | The full body including analogy, counterfactual and rule of thumb |
| `explain:field:IkeGateway.external_interface @ *` | The card's own point: *"the WAN unit the IKE packets leave by, not `st0`"* |
| DOM snapshot per `CorpusBlock` kind | `34` §5.2's rendering model — nodes built, never markup. The snapshot is a serialised element tree, which is what makes an injected `<img src=x onerror=…>` visible as text in the diff |

### 7.2 The three rules that keep snapshot tests from becoming wallpaper

Snapshot suites rot in a predictable way: a change produces 300 diffs, somebody runs `--accept`,
and from then on the snapshots record whatever the code does.

| Rule | Mechanism |
|---|---|
| **A snapshot diff over 25 files splits the PR** | CI check: if `insta` reports > 25 changed snapshots, fail with "split this change". Painful on purpose |
| **Depth is not truncation** | `61` §—'s lint already warns when `terse` is a prefix of `explained`. The snapshot suite asserts the stronger form: for every entry, `explained` must contain at least one sentence that is not in `terse` and says something the command text does not |
| **Voice lint runs on the rendered output, not only on the source YAML** | `15` §—'s S1–S10 and P-codes apply to what the user reads. A template that assembles two compliant fragments into a non-compliant sentence is invisible to a source-level lint |

### 7.3 The voice gates that are actually checkable

`15` §— defines the style rules; the mechanical subset the snapshot suite can enforce:

| Code | Check | Verdict |
|---|---|---|
| P-banned | No "simply", "just", "powerful", "seamless" (except the literal *"Healthy rekey is seamless"*), "robust", "leverage", "cutting-edge" | **fail** |
| P-hedge | No "may", "might", "could potentially" in `terse` | fail |
| P12 | The final sentence of `teaching.body` is ≤ 14 words and either begins with an imperative-lexicon verb, contains a number, or matches the rule-of-thumb pattern | **warn** — detection is fragile and `15` says so |
| P17 | Every number carries a unit and a source | warn |
| S-failure | Every `explained` body contains at least one sentence naming a failure mode or a misdiagnosis | warn, reviewed |

The last one is the one that matters and it is the one that cannot be fully mechanised. *"PFS provides
forward secrecy"* passes every regex. *"PFS on one side and absent on the other fails Phase 2 while
Phase 1 stays up"* is the sentence we want. The gate is a warning plus a human reviewer, and §18 is
honest that this is a review obligation, not a test.

---

## 8. Fuzzing

*margin tab: hostile by definition*

### 8.1 Targets

`14` §13.2 specifies five targets and this document adopts them unchanged: **A** totality, **B**
accounting under structured damage, **C** redaction soundness with canaries, **D** round trip, **E**
re-parse idempotence. Three targets are added here for surfaces `14` does not own:

| Target | Input | Asserts |
|---|---|---|
| **F — rule condition VM** | `Arbitrary` compiled rule + `Arbitrary` graph fragment | No panic, no unbounded loop, step budget always respected, and `Outcome` is one of the declared variants. `12` §3's containment claim is only a claim until this runs |
| **G — envelope open** | `Arbitrary` byte string in the envelope's shape | Every input yields exactly one of `32` §16.2's declared errors. Never a panic, never a partial plaintext, never `WrongKey` for a malformed header (which would leak the difference between "wrong key" and "corrupt file") |
| **H — packed boundary decode** | `Arbitrary` byte string in the T2 packed-record shape (`41` §3.3) | The TypeScript reader never reads out of bounds, never loops unboundedly, and never constructs a DOM node from a length field. Run in the browser harness, because the reader is TS |

### 8.2 Corpus management

| Corpus | Source | Committed? |
|---|---|---|
| Seed | Field card (all four sides), vendor-documentation examples with per-fixture provenance, synthetic estates (§15) | yes |
| Damage | Every historical crash, minimised, named after the crash id | **yes — permanently.** `14` §13.6's rule |
| Growth | libFuzzer's own corpus from nightly runs | no; cached between nightly runs, rebuilt on cache loss |

**The crash-to-fixture pipeline is the part that must be automatic**, because it is the part that
otherwise does not happen:

```
nightly fuzz finds a crash
  → cargo fuzz tmin                      minimise
  → xtask fuzz promote <target> <input>  writes fuzz/corpus/<target>/damage/<id>.bin
                                         plus a Rust regression test that loads it by name
  → opens a PR with both, and the crash's stack trace in the body
```

A crash becomes a committed regression test in the same motion that reports it. A crash that is fixed
without a committed input is a crash that comes back.

### 8.3 Schedule

| When | What | Blocking |
|---|---|---|
| Every PR | 60 s per target over the committed corpus, no mutation growth | **yes** — a PR that reintroduces a known crash fails in five minutes |
| Nightly | 30 min per target, with mutation | yes, for the next release: a new crash blocks promotion |
| Weekly | 4 h per target, plus a fresh-corpus run from seeds only | no; produces a report |
| Pre-release | The full committed corpus over all eight targets, plus the last 30 days of growth corpus | **yes** |

### 8.4 What fuzzing here does and does not buy

`14` §13.1 makes the point precisely and it bears repeating at strategy level: **the code is Rust with
`forbid(unsafe_code)` in a WASM sandbox, so classic memory corruption is not the threat.** What
fuzzing buys is panics (a trapped WASM instance is lost unsaved work), hangs, unbounded allocation,
and — through targets C, D and E — the two failures that actually hurt: a secret surviving the
redaction gate, and a confidently wrong bind.

What it does not buy: **a wrong bind that the round-trip oracle also gets wrong.** If the dictionary
says `set security ike gateway X version v2-only` means something it does not, target D happily proves
that we can parse and re-emit our own misunderstanding. That is §11's problem, not fuzzing's.

---

## 9. End-to-end browser tests

*margin tab: no Playwright*

### 9.1 The harness

`42` §4.3 settles this: `fantoccini`/`thirtyfour` over WebDriver, plus `chromiumoxide` over CDP where
network interception or tracing is needed, driven from `cargo test`. No Node, no Playwright. `42`
§4.4 already prices what that costs — auto-waiting, the trace viewer, WebKit on Linux — and this
document does not re-litigate it.

Three harness obligations that follow, and that are this document's to enforce:

| Obligation | Mechanism |
|---|---|
| **No `sleep`.** Ever | `wait_until(predicate, timeout)` is the only waiting primitive. A grep gate rejects `thread::sleep` and `Duration::from_millis` outside the harness's own implementation |
| **Zero retries** | `42` §4.4. A flaky test is a bug in the test. §17 |
| **Fixture loading is one URL parameter** | `?fixture=srx-ipsec-site-to-site` (`42` §—), dev-build only, asserted absent from release artifacts by the same symbol scan as `44` P8 |

### 9.2 The flows, and why they are keyboard-first

The product is keyboard-driven by design — brief §6.1's `Ctrl+K` from anywhere, and a UI with no
icons, no modals-with-animation and no pointer-only affordances (`design-language.md`). A mouse-driven
e2e suite would test a product nobody uses.

| # | Flow | Steps | Asserts |
|---|---|---|---|
| E1 | Cold start to first answer | Load A1, `Ctrl+K`, type `check if a tunnel is up`, `Enter` | Top result is `show security ipsec security-associations`; the risk band is **ReadOnly** with the legend text `READ-ONLY — SAFE ON PRODUCTION`; `read_field` renders as `State — want Installed` |
| E2 | Finder, half-remembered syntax | `Ctrl+K`, type `show security ike... something` | The command-tree prefix path fires; the matched prefix is highlighted |
| E3 | Finder, cross-vendor | Type `Junos version of show crypto ipsec sa` | The Rosetta mapping resolves |
| E4 | Finder, contextual | Open a workspace, repeat E1 | The result interpolates the real VPN name — `... vpn-name VPN-B detail` — and the copy is paste-ready |
| E5 | Reverse lookup | Paste a command into the finder | The explainer renders backwards |
| E6 | Walkthrough, site-to-site IPsec | Answer the questions with the keyboard only, no pointer events | Findings appear **inline as you go** (brief §6.2), not at the end; the PFS finding appears at the moment PFS is skipped |
| E7 | Paste a config | Paste field-card side 1 into the ingest surface | Graph populated, diagram drawn, findings listed, residue line shown |
| E8 | Emit and copy | Emit a device, copy a block | One `text/plain` flavour, no trailing newline, byte-identical to what is displayed (`34` H30–H32) |
| E9 | Diff, verify, rollback | Change a value, export a change set | The change set carries the verification ladder and the rollback; D1 ran and passed |
| E10 | Suppress a finding | Suppress with a reason | The suppression is stored in the workspace with its reason and is visible to a reviewer |
| E11 | Unlock, lock, unlock | Full cycle | `44` B14–B16; and no plaintext in any store before unlock (`34` H26) |
| E12 | Depth toggle | Toggle `terse` / `explained` / `teaching` globally and per block | Content density changes; the toggle reads like a margin tab, not a settings panel |
| E13 | Egress | Every flow above, with CDP network interception armed | **Zero requests.** §13.4 |
| E14 | No-route | Every flow above, in a network namespace with no route | Nothing fails that should not |
| E15 | Keyboard-only traversal | Tab through every interactive element in every view | No trap, every element reachable, focus visible |

### 9.3 Browser matrix

| Browser | Runs | Note |
|---|---|---|
| Chromium stable | every PR, full suite | The reference |
| Firefox stable | every PR, E1–E11 | `geckodriver`. CDP-dependent tests (E13) are Chromium-only |
| WebKit | **per release, manually, on macOS** | `safaridriver` needs macOS. `42` §4.4 names this as a documented gap; naming it again here so it is not quietly forgotten |

---

## 10. Mutation controls — the tests that test the tests

*margin tab: most-missed*

### 10.1 The problem

A property test that passes on a broken implementation proves nothing, and this is not hypothetical:
**a nonce-uniqueness test written the obvious way passes with a constant nonce**, because a constant
nonce also never produces a *collision* in a set that only ever holds one element. A canary test
passes if the canary is never inserted. A round-trip test passes if both directions are identically
wrong.

Full mutation testing over the whole codebase is too slow to gate on. **Targeted mutation controls
are not.**

### 10.2 The rule

> **Every security-critical or correctness-critical property test ships with at least one mutant it
> must catch. The mutant lives beside the test, behind a `#[cfg(test)]` feature, and CI asserts the
> test fails on the mutant and passes on the real implementation.**

```rust
/// The control for P10 (§12.4). Compiled only under `cfg(test)`.
/// CI runs the P10 property against each mutant and asserts a failure.
#[cfg(test)]
pub enum SealMutant {
    /// Salt is a constant. The classic catastrophic bug.
    ConstantSalt,
    /// Salt is drawn from a 16-bit counter. Collides after ~2^8 seals by birthday.
    NarrowSalt,
    /// Salt is drawn per *device* rather than per *seal*.
    PerDeviceSalt,
    /// HKDF info omits the record id, so two records share a key.
    InfoMissingRecordId,
}
```

### 10.3 The catalogue

| Property | Mutants it must catch |
|---|---|
| P10 — no record key reused | `ConstantSalt`, `NarrowSalt`, `PerDeviceSalt`, `InfoMissingRecordId` |
| Target C — redaction soundness | A detector removed; the capture text written before redaction; the residue section written unredacted |
| P12 — no credential emitted | A `SecretPlaceholder` renderer that emits the underlying value |
| E1 — emit fixed point | An emitter that drops `Default(v)` inconsistently between the first and second emit |
| P2 — the ledger tiles | A parser that skips a comment line without recording it |
| D1 — the change set reaches B | A diff that omits a delete |
| H17 — hostile content renders as text | A renderer that uses `textContent` on the container instead of `createTextNode` per node |
| P6 — ranking is a total order | A tiebreak that reads a `HashMap` iteration order |

Thirty-five mutants at v1, six minutes to run, every PR. **This is the cheapest quality signal in the
suite per minute spent**, and it is the only one that answers "does this test test anything".

---

## 11. Cross-validation against reality

*margin tab: verify against your own box*

### 11.1 The question

Everything in §§3–10 proves that Fathom is self-consistent. None of it proves that
`set security ike gateway GW-B external-interface reth0.0` is a line Junos accepts, means what we
think it means, or is the right line for this graph. Four options exist. Each is evaluated on what it
proves, what it costs, and — the column that decides it — **what an ambiguous result means.**

### 11.2 Option A — a vendor VM or container in CI

**What it proves:** the strongest available oracle for *syntactic and referential* validity. If
`load set` and `commit check` succeed on real Junos, the config parses and every reference resolves.
Side 1 of the card is explicit that this is a real class of error caught at commit: *"Junos enforces
these references at commit — a missing policy name fails the commit."*

**What it costs:**

| Cost | Detail |
|---|---|
| Licensing | Juniper's freely downloadable lab images are **vJunos-router** (a virtual MX) and **vJunos-switch** (a virtual EX9214), available at no cost for non-production use with no time limit. **Neither is an SRX.** The security stanzas this product cares most about — `security ike`, `security ipsec`, `security zones`, `security policies` — are not on those platforms. The SRX image is **vSRX**, which is a 60-day evaluation download. <!-- VERIFY: current vSRX evaluation terms, whether any redistributable or CI-usable SRX image exists in 2026, and whether the evaluation licence permits automated use in a build system. This determines whether §11.2 is a CI job or a manual lab, and it is a legal question before it is a technical one. --> |
| Redistribution | We cannot ship a vendor image in our CI configuration, and a public PR pipeline cannot fetch one |
| Time | A vJunos container takes 5–15 minutes to boot. A per-PR gate is not on the table |
| Coverage | One vendor. PAN-OS and IOS-XE have their own image and licensing stories, each different |
| Semantics | `commit check` passing means the box accepted the config. It does not mean the tunnel comes up |

**What an ambiguous result means:** unambiguous. A commit failure is our bug, full stop. That is
rare and valuable.

**Verdict: adopt, off the PR path, as a manually-run conformance lab.** An operator who legally holds
an image runs `xtask conformance --platform junos-srx --image <path>`, which boots the VM, loads each
golden config from §5, runs `commit check`, records the result, and writes a **signed conformance
report** committed to the repository:

```
conformance/junos-srx/21.4R3-S5/2026-07-14.report.json
  { fixture, junos_version, commit_check: "ok" | {error}, operator, signature }
```

The report is a repository artefact with a named human on it, which is the same discipline invariant
10 applies to the corpus. Every release states which fixtures have a conformance report and against
which Junos version, and **a fixture with no report says so in the release notes** rather than
quietly implying coverage.

Note the risk framing, because it is the product's own: loading a config onto a device and committing
it is `ChangesConfig`, and the bring-up ladder's step 1 is `commit confirmed 5 — always, remotely`.
The conformance lab is running exactly the class of command the tool tells users to be careful with,
which is one more reason it points only at a disposable VM and is never pointed at anything with a
route to a real network.

### 11.3 Option B — a community corpus of real configurations

**What it proves:** coverage of syntax we did not imagine. Batfish has a decade of real multi-vendor
configs behind its grammars; that is the single largest asset we do not have.

**What it costs:** `14` §13.6 states the problem exactly and it is structural rather than practical:
**a user who trusts Fathom because it does not exfiltrate configs is not going to email us their SRX
config.** The tool's central promise and this option are in direct opposition.

**What an ambiguous result means:** a parse failure on a donated config is unambiguous and useful.
The problem is supply, not interpretation.

**Verdict: partially adopt, and do not plan around it.** Three sources, in order of yield:

1. Vendor-documentation examples, each fixture carrying its provenance and its redistribution status.
2. The opt-in donation path `14` §13.6 specifies: `fathom ingest --donate` runs the redaction gate,
   then a second and far more aggressive anonymiser, shows the user the full resulting text, and only
   then offers to *save a file* the user may send. **Nothing is transmitted by the tool** (invariant
   1). This will produce a small corpus, slowly.
3. Configs generated by the synthetic estate generator (§15), which cover syntax we thought of and
   nothing else, and which are therefore not a substitute for this option — they are the thing this
   option would supplement.

**State the weakness rather than engineering around it.** Our failure mode on unfamiliar syntax is a
residue entry and a completeness prompt (`14` §8), not a wrong answer. That design decision is doing
the work this corpus would otherwise do, and it was made for exactly this reason.

### 11.4 Option D — Batfish as an independent parser

*(Taken before C, because C's verdict depends on how much D covers.)*

**What it proves:** Batfish ingests raw vendor configurations and builds a vendor-independent
representation, and it reports lines it did not recognise or could not convert — via `initIssues` and
`fileParseStatus` in the Python client. So we can ask an independent, mature, differently-implemented
parser one very sharp question about our output:

> **Does Batfish recognise every line we emitted?**

That single assertion is a strong syntactic check on the emitter, it needs no licence, it runs in
Docker, and it is cheap enough to run on 200 configs in twelve minutes.

A second, weaker assertion is available: compare salient facts between Fathom's graph and Batfish's
representation — interface addresses, zone membership, static routes, policy actions — for a set of
concepts both model. This is genuinely useful and it is where the ambiguity starts.

**What it costs:** Java, Docker and a Python client, which is a third toolchain. `42` Z4 permits it:
tools that produce no artifact may use any toolchain provided they run **downstream of the release
manifest, in a separate job with no write access to the artifacts.** The Batfish job is exactly that
shape.

**What an ambiguous result means — and this is the deciding column:** a Batfish parse warning on our
output means one of two things, and it does not tell you which:

| Interpretation | Example |
|---|---|
| Our output is wrong | We emitted a statement Junos does not accept |
| Batfish's Junos grammar does not cover it | Its issue tracker carries open parse gaps across vendors, which is normal for a project of that scope and not a criticism of it |

**Verdict: adopt as a warning oracle first, escalating to a gate on a per-path allowlist.** The
mechanism that makes this workable:

```
nightly:
  for each golden config in §5 and each generated estate in §15:
      run batfish, collect initIssues + fileParseStatus
      classify each unrecognised line by its StatementPath prefix
  → compare against conformance/batfish/known-gaps.toml
  → NEW unrecognised path            → fail the nightly, open an issue
  → path already in known-gaps.toml  → report only
```

`known-gaps.toml` starts large and shrinks. Each entry names the path, the date, and — the part that
makes it honest — **whether it was investigated and which way it went.** A gap attributed to Batfish
carries a link to the upstream issue; a gap attributed to us carries a fix or a reason.

The escalation rule: **once a `StatementPath` prefix has a clean conformance report from §11.2, a new
Batfish warning on that prefix is our bug and blocks.** That is how the ambiguity is resolved — by a
second oracle, not by a judgement call in CI.

### 11.5 Option C — expert review

**What it proves:** the only thing nothing else can. Every option above answers *"is this valid?"*
None of them answers *"is this right?"* A config that commits cleanly, parses in Batfish and round-
trips perfectly can still propose `dh-group group2` on a new build, clamp MSS to the wrong value, or
put `establish-tunnels on-traffic` on both ends of a tunnel — which the card lists under `THINGS THAT
BITE` as *"Nobody initiates, nothing is misconfigured, tunnel never comes up."*

**What it costs:** it does not scale, it is the scarcest resource on the project, and it is
unrepeatable.

**What an ambiguous result means:** it is a conversation, which is the point.

**Verdict: adopt as a mandatory human gate on two things and nothing else**, because a review
obligation that covers everything covers nothing:

| Requires named expert review | Why |
|---|---|
| A new emitter, or a change to an emitted statement's *shape* | The golden diff is in vendor syntax precisely so this review is possible (§5.4) |
| A new rule, or a change to a rule's `severity`, `remediation` or `acceptable_when` | Invariant 8 and `5.2`'s warning about muted linters. `63` §— already requires `reviewed_by`; this makes the reviewer's name a merge requirement, not a metadata field |

Everything else — engine changes, refactors, performance work — is reviewed as software.

### 11.6 The recommendation, and the residual

| Option | Role | Cadence | Blocking |
|---|---|---|---|
| **D — Batfish differential** | The automated syntactic oracle | nightly; PR in warning mode | escalating, per §11.4 |
| **A — conformance lab** | The authoritative syntactic oracle | per release, manual | release notes state coverage |
| **C — expert review** | The semantic oracle | per emitter and per rule change | **yes** |
| **B — real configs** | Slow accretion of the unknown | continuous, opportunistic | no |

**The residual, stated plainly:** none of this proves the configuration is operationally correct on
the user's box, with their Junos version, their upstream ACLs, their NAT rules and their peer. It
cannot. That is why the field card puts `VERIFY AGAINST YOUR OWN BOX BEFORE ACTING` on all four sides,
why the tool emits the verification ladder alongside the config (brief §6.7), and why invariant 2
means the application never touches a device. **The test suite's job is to make the output worth
verifying. The verification is still the engineer's.**

---

## 12. Crypto testing

*margin tab: fields that matter*

### 12.1 Known-answer tests

`32` §16.1 defines the vector tree and this document adds the requirement that **each vector file
declares which upstream vectors it is anchored to**, so a reader can tell our vectors from the
standards' vectors:

| Vector file | Anchored to |
|---|---|
| `01-argon2id.json` | RFC 9106's own Argon2id test vector, plus our own parameter grid |
| `02-hkdf-record.json` | RFC 5869 Appendix A vectors for HKDF-SHA-256, plus our `info` construction |
| `03/04-envelope-*.json` | RFC 8439 §2.8.2's ChaCha20-Poly1305 AEAD vector for the primitive, then our envelope on top |
| `08-hpke-wrap.json` | RFC 9180 Appendix A's vectors, then our `info`/`aad` construction on top |
| BLAKE3 usage | the BLAKE3 reference test vectors |
| `05-padme.json`, `06-cbor-canonical.json`, `10-manifest.json`, `11-recovery-code.json`, `12-shard.json` | **ours alone** — no upstream anchor exists, which is exactly why they need the most cases |

**The primitive vectors are not optional even though we use audited crates.** They are what catches a
crate upgrade that changes a default, and they are what a second implementation checks itself against.

### 12.2 Negative vectors

`32` §16.2 lists twenty and requires that each fails **with the specified error**, not merely fails.
Two additions:

1. **The error must be produced from the specified stage.** `WrongKey` from the commitment check must
   arrive *before* Poly1305 runs, and the test asserts that by instrumenting which check fired, not
   by inspecting the error type alone. Otherwise a refactor that removes the commitment check still
   passes every negative vector.
2. **Fuzz target G (§8.1) covers the space between the vectors.** Twenty hand-written negatives
   cover twenty thought-of cases; the target covers the ones nobody thought of, and its assertion is
   simply that the error is one of the declared variants.

### 12.3 Cross-implementation

`32` §16.1's `99-workspace/` is the acceptance test: a complete 40-node workspace with the passphrase
`correct horse battery staple`, committed, plus the expected canonical graph digest after opening.

**RECOMMENDATION — write a second, independent opener, in a different language, from the document
alone, by someone who did not write the Rust.**

| | |
|---|---|
| What it is | ~400 lines of Python: Argon2id, HKDF, ChaCha20-Poly1305, the envelope parser, canonical CBOR, the digest. Uses `argon2-cffi` and `cryptography`, not our code |
| What it proves | That `32` is implementable from its text. **That is the actual claim `32` makes** — *"a future native client, written by someone who has never spoken to us, must open the same workspace"* — and it is unproven until somebody does it |
| What it costs | Real engineering time on something that ships to nobody, plus a maintenance obligation on every format change |
| Where it runs | Nightly, in the Z4 job class (`42`), Python being another toolchain that produces no artifact |
| The failure it catches | An ambiguity in the specification. Those are invisible from inside the implementation, because the implementation *is* the disambiguation |

**And the differential runs both ways:** the Python opener opens our workspace, and a Python *sealer*
produces a workspace our Rust opens. One direction catches reader ambiguity; the other catches writer
ambiguity, and the two are different bugs.

### 12.4 P10 — nonce uniqueness under simulated concurrent edits

#### 12.4.1 What is actually being tested

`32` §5.3 chooses RFC 8439 ChaCha20-Poly1305 with a **12-byte zero nonce** and a per-record 256-bit
random salt HKDF'd into a fresh subkey. So the requirement — `(key, nonce)` never repeats across two
distinct plaintexts — reduces to: **`K_enc` is never reused across two distinct plaintexts**, which
reduces to a 32-byte salt collision within one key epoch of one workspace given identical header
bytes.

`32` §5.4 enumerates three cases and dismisses the birthday case correctly. **Case 2 — two devices
editing the same record concurrently — is the one that a test can actually get wrong**, because it is
the case where an implementation might "helpfully" reuse a header, cache a derived key, or seal from
a snapshot taken before another device's write.

#### 12.4.2 The test

```rust
/// A schedule is a deterministic interleaving of edits across N simulated devices
/// sharing one workspace. Each simulated device has its own crypto worker, its own
/// CSPRNG stream (seeded from the proptest seed, so failures reproduce), and its
/// own view of the record set — including stale views, which is the point.
#[derive(Debug, Clone)]
pub struct Schedule {
    pub devices: u8,                 // 2..=5
    pub steps:   Vec<Step>,          // 1..=200
}

#[derive(Debug, Clone)]
pub enum Step {
    /// Device d edits a field in record r and seals. Other devices do not see it yet.
    Edit   { d: u8, r: RecordId, field: FieldRef, value: ScalarSeed },
    /// Device d pulls: it now sees every sealed record up to `upto`.
    Sync   { d: u8, upto: usize },
    /// Key rotation, which changes WK_e — the epoch boundary that makes salt reuse
    /// across epochs harmless and reuse within one epoch fatal.
    Rotate { by: u8 },
    /// Device d re-seals a record without changing it (a re-save, a compaction).
    Reseal { d: u8, r: RecordId },
    /// Device d is restored from a backup taken at step `at` — the case that breaks
    /// every counter-based nonce scheme, and the reason 32 §5.5 rejected option C.
    Restore { d: u8, at: usize },
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 1024, .. Default::default() })]

    #[test]
    fn p10_no_record_key_is_ever_reused(sched in arb_schedule(2..=5, 1..=200)) {
        // K_enc never leaves the sealer. The harness observes the key-commitment
        // tag, which is HKDF'd from K_enc: equal tags imply equal K_enc with
        // overwhelming probability, and the tag is already in the envelope.
        let mut seen: HashMap<[u8; 16], SealSite> = HashMap::new();

        for seal in run_schedule(&sched) {
            match seen.entry(seal.commitment_tag) {
                Entry::Vacant(v)   => { v.insert(seal.site()); }
                Entry::Occupied(o) => {
                    // A repeated key is only fatal if the plaintexts differ.
                    prop_assert_eq!(
                        o.get().plaintext_digest, seal.plaintext_digest,
                        "key reuse across distinct plaintexts:\n  first: {:?}\n  second: {:?}",
                        o.get(), seal.site()
                    );
                }
            }
        }
    }
}
```

#### 12.4.3 The controls, without which the test is theatre

| Control | Why |
|---|---|
| **The mutant suite (§10.2).** P10 must fail on `ConstantSalt`, `NarrowSalt`, `PerDeviceSalt` and `InfoMissingRecordId` | A uniqueness test over a set that never collides passes on a constant nonce. **This is the single most likely way to ship a broken crypto test** |
| `NarrowSalt` uses 16 bits so a collision is reachable inside 1,024 cases | A mutant the test cannot reach in reasonable time is not a control |
| Each simulated device draws from an independent CSPRNG stream, and one schedule variant deliberately gives two devices the *same* seed | The restore-from-backup and clone-the-VM cases, which is how RNG state gets duplicated in the real world |
| `Restore` exists | `32` §5.5 rejected counter nonces partly for this. The test should demonstrate why, not assume it |
| The test asserts the **INVARIANT from `32` §5.4** separately: no code path merges two ciphertexts, patches a ciphertext, or pairs a header from one write with a ciphertext from another | A structural assertion over the sync layer's API surface, checked by a lint, because it is not observable from outcomes |

### 12.5 The test-vector hook

`32` §16.3's `seal_with_salt` is a deliberate fixed-salt injection point and it is a nonce-reuse
vulnerability if it ships. Its three controls — non-default feature, symbol scan over the release
artifact, call-site grep restricted to `tests/` — are adopted here unchanged, and the symbol scan is
listed in §19 as a blocking gate alongside `42` check 6 and `44` P8, because all three are the same
class of failure: **instrumentation escaping into a release.**

---

## 13. Security testing

*margin tab: not VPN-specific*

### 13.1 The injection corpus

`23` §9 owns it: a corpus of injection payloads embedded in realistic configuration, run against a
**scripted adversarial mock** as a structural pass/fail gate, and separately against a real small
model as a scored metric (`25` §7).

This document adds one rule about how it is run: **the structural gate runs on every PR and blocks;
the scored run is nightly and reports.** Mixing them produces a gate whose pass/fail depends on a
model's sampling, which is a gate that will be disabled.

And one rule about how it grows: **every injection technique found anywhere — a paper, an advisory, a
bug report, a red-team exercise — becomes a corpus entry within the release it is found in.** A corpus
frozen at its creation date measures how good we were in 2026.

### 13.2 Dependency audit gating

`35` §5.5 sets the `cargo-deny` policy: deny on any RustSec advisory, deny `unmaintained`, and **no
`ignore` entry without an expiry date and a written reason in the same file.** Adopted unchanged.
Three operational rules this document adds:

| Rule | Reason |
|---|---|
| `cargo deny check` runs on every PR **and** on a daily schedule against the unchanged lockfile | A new advisory against an unchanged dependency must break the build on the day it is published, not on the day somebody next opens a PR |
| An expired `ignore` entry is a **build failure**, not a warning | An expiry that only warns is a permanent exception with a date on it |
| The daily run opens a PR that bumps the lockfile, and that PR runs the full nightly suite | Otherwise the security fix waits for a human who is on holiday |

`cargo-deny` runs against the same feature resolution as the build (`35` §10.3). A `deny` run over a
different feature set audits a program we do not ship.

### 13.3 CSP and DOM regression tests

`34` §8's H1–H40 are the specification. The strategy-level points:

| Point | |
|---|---|
| **H1–H12 are golden-string comparisons, and that is correct** | A CSP is a security control whose text is the control. Comparing it to a committed golden string is the right test, and any "smarter" test is a test that can be argued with |
| **H6 recomputes the inline script hash from the built bytes** | This catches the build-rewrite drift that makes a CSP fail closed at runtime — loudly, but only for the user, which `34` correctly calls the worst place to find out |
| **H17 is the one that matters most** | A fixture graph in which *every string field* carries `<img src=x onerror=…>`, `</pre>`, `javascript:`, a bidi override and a tag-character payload, rendered through every view, asserting zero `img`/`script`/`a`/`iframe`/`object` elements and zero `on*` attributes. **This fixture is produced by the synthetic estate generator's `Hostile` hygiene mode (§15.4)**, so it stays current as views are added |
| **H9's expected failure in mode A is asserted as a known gap** | A test that asserts a *gap* is how a gap stops being forgotten. `31` §12 uses the same pattern |

### 13.4 The egress test

`42` §9.4 checks 10 and 11 specify it. It is restated here because it is the single test that most
directly defends the product's central promise, and because it is the one a future contributor is
most likely to weaken by adding an exception.

```
E13 — runtime egress assertion (Chromium, CDP)
  arm Fetch.enable and Network.enable with request interception
  run every flow E1–E12
  assert: zero Network.requestWillBeSent events in mode A
          exactly the sync origin, and nothing else, in modes C–D
  cross-check: performance.getEntriesByType('resource') is empty in mode A
  fail on: any request, including a favicon, a source map, a font, a prefetch,
           a beacon, a report-uri POST, or a WebSocket upgrade

E14 — no-route run
  the same suite, in a network namespace with no default route and no DNS
  assert: nothing fails that should not fail
```

Three rules that keep it meaningful:

| Rule | Why |
|---|---|
| **No allowlist in mode A. None.** Not for a favicon, not for a source map, not for a report endpoint | The moment there is one entry there is a mechanism, and a mechanism accumulates entries |
| The cross-check via `performance.getEntriesByType('resource')` is independent of CDP | Two instruments, because a single instrument that can be misconfigured is a single point of failure for the claim the whole product rests on |
| E13 runs the **release** artifact, not a dev build | A dev build has a fixture loader and a perf-counter export; the claim is about what ships |

### 13.5 What security testing here does not cover

Stated so the coverage is not over-read:

| Not covered | Why | Where it is owned |
|---|---|---|
| A compromised browser or extension | Defensive code runs inside the attacker's process | brief §7.1 (out of scope, explicitly) |
| Key material in a browser crash dump or swap | WASM cannot `mlock` or `madvise` | `31` §5.1, `32` §4.4 row 3 |
| A malicious rule pack signed with a stolen key | Signature verification proves provenance, not intent | `35` §8.4's advisory bundle |
| The user pasting a real PSK into a field | We never accept credentials, but we cannot stop a paste into a field that then goes nowhere. The control is that there is no such field | invariant 3 |

---

## 14. Corpus testing

*margin tab: the corpus is most of the work*

### 14.1 Schema validation

`61` §14's fourteen gates and `63`'s pack build gates are the specification. `lint` runs gates 1–8
fast with no index build; `check` runs all fourteen. Both are `cargo` binaries with no network
(invariant 1), which is why `63` §—'s citation linter checks the *shape* of an RFC reference and never
its existence.

That limitation deserves a strategy-level note: **a plausible-looking fabricated citation passes
every automated gate we can build.** `63` §12.2 already forbids a reviewer supplying a citation they
have not checked. The only real control is that citations are reviewed by a human who looks them up,
and the only mechanism is that the review checklist says so in one line. Automation cannot help here
and pretending it can is how a fabricated section number ships.

### 14.2 Link integrity across the concept graph

The corpus is a graph and it can be broken in graph-shaped ways. Six checks, each a small algorithm:

| # | Check | Algorithm | Fails when |
|---|---|---|---|
| L1 | Every referenced id exists | Set difference over `related`, `next_if_bad`, `rosetta`, `requires`, `on_fail`, `sources`, and every `explain:` target | A dangling reference |
| L2 | No orphan concepts | Every concept has ≥ 1 entry on ≥ 1 platform (`61` §—) | A concept nobody can reach |
| L3 | No orphan entries | Every entry carries ≥ 1 `Object` and ≥ 1 `Action` concept | An entry the finder cannot rank |
| L4 | Verify ladders are acyclic on `on_fail` | DFS with a colour marking over the `on_fail` edge set | A diagnostic loop — *"if this fails, check that; if that fails, check this"* — which is how a user is sent round a circle at 02:00 |
| L5 | Every `on_fail` target exists and is `ReadOnly` | Set membership plus a risk check | A failure path that tells the user to run something disruptive while they are already debugging |
| L6 | Rosetta mappings are complete and symmetric | For every Rosetta group, every platform in `corpus.toml` appears; the reverse mapping is materialised and checked | A cross-vendor lookup that works in one direction only |

L4 and L5 are the two that are specific to this corpus rather than generic link checking, and both
come straight from the card. The bring-up ladder on side 1 is *"stop at the first failure"* — a
directed graph with a stopping rule — and side 3's `ERROR DECODER` is the `on_fail` edge table. A
cycle in that graph is a real defect in a real diagnostic procedure, and it is only visible as a
graph.

### 14.3 Style lint for the explainer voice

§7.3 lists the mechanical gates. The strategy point is where the line is drawn:

| Enforceable by machine | Requires a human |
|---|---|
| Banned phrases | Whether the sentence states a *failure mode* rather than a feature |
| `answers` ends in `?`, is 4–20 words, does not begin "Shows"/"Displays"/"Lists" | Whether it is the question a confused engineer would actually type |
| `read_field` matches `<Field> — <what you want>` | Whether it is the field that matters |
| A number carries a unit | Whether the number is right |
| `terse` is not a prefix of `explained` | Whether `explained` says something the command text does not |

**Machines gate the shape; humans gate the content.** A style linter that tried to gate the content
would either pass everything or block the good sentences, and the second failure mode is how a voice
gets flattened into compliance.

### 14.4 Coverage gates

| Gate | Threshold | Fails when |
|---|---|---|
| Every rule has `must_fire` + `must_pass` | 100 % | `63` §15 |
| Every rule that touches a `THINGS THAT BITE` subject has `must_not_fire` | 100 % of that subset | §6.2 |
| Every explainer has a snapshot at all three depths | 100 % | §7 |
| Every command entry has `answers`, `read_field`, `risk` | 100 % | `61` gate 3 |
| Every `ReadOnly` entry with `weight ≥ 2` has `output_fields` | 100 % | `61` gate 3 |
| Golden query set: top-3 stability | ~120 queries, diff reviewed | `61` §—. A ranking change is a **review item, not a failure** — the reviewer decides whether it is the improvement it claims to be |
| Concept coverage | No orphan concepts, no orphan entries | L2, L3 |
| Platform parity for the IPsec domain | Every rule in the IPsec domain declares a `platforms` predicate and every listed platform has an emitter path | A rule that claims `panos` with no way to remediate on PAN-OS |

---

## 15. Test data — the synthetic estate generator

*margin tab: you cannot use real configs*

### 15.1 Why this is a first-class subsystem and not a test helper

Three separate needs converge on one artefact, and building it once is the only way any of them get
served properly:

| Need | Source |
|---|---|
| Realistic multi-device estates for tests at 1, 20, 50, 100 devices | `44` §7's scaling analysis, §9's e2e flows, §11.4's Batfish corpus |
| Fixtures that exercise rules, including rules that must *not* fire | §6 |
| A demo estate, because the first-run experience cannot be an empty form (brief §2.2, §6.3) | Product |

`14` §13.3 already defines `ValidConfig` — one or two devices, generated with `arbitrary` for fuzzing.
**This is that generator's larger sibling: `ValidConfig` generates a device for a fuzzer; the estate
generator generates a network for a human.** They share the per-device statement synthesis; they
differ in everything above it.

### 15.2 The specification

```rust
/// Deterministic: the same EstateSpec produces byte-identical output, forever.
/// The generator's version is part of the spec digest, so a generator change is
/// a visible fixture change rather than a silent one.
pub struct EstateSpec {
    pub seed:      u64,
    pub topology:  Topology,
    pub scale:     Scale,
    pub platforms: PlatformMix,
    pub versions:  VersionMix,
    pub hygiene:   Hygiene,
    pub faults:    Vec<FaultSpec>,
}

pub enum Topology {
    /// One hub, N spokes, one tunnel each. The modal enterprise WAN.
    HubAndSpoke { spokes: u16 },
    /// Two hubs, N spokes, two tunnels each. Exercises establish-tunnels,
    /// vpn-monitor and route preference — and the card's failover discussion.
    DualHub     { spokes: u16 },
    /// N sites, full mesh. Exercises selector explosion: N(N-1)/2 tunnels.
    FullMesh    { sites: u8 },
    /// A chain. Exercises transit, MSS clamping through two tunnels, and
    /// the MTU story on side 4.
    Chain       { sites: u8 },
}

pub struct Scale {
    pub interfaces_per_device:     RangeInclusive<u16>,   // 8..=48
    pub units_per_interface:       RangeInclusive<u8>,    // 1..=6
    pub zones_per_device:          RangeInclusive<u8>,    // 3..=8
    pub policies_per_zone_pair:    RangeInclusive<u16>,   // 2..=60
    pub address_objects_per_device: RangeInclusive<u16>,  // 20..=400
    pub static_routes_per_device:  RangeInclusive<u16>,   // 4..=80
    pub clustered_fraction:        f32,                   // fraction of sites as SRX clusters (reth)
}

pub enum PlatformMix {
    Single(Platform),
    /// The realistic case and the one that finds bugs: a Junos hub, PAN-OS at
    /// two branches, an IOS-XE box somebody never replaced.
    Mixed(BTreeMap<Platform, u8>),
}

pub struct VersionMix {
    /// Junos releases are not uniformly distributed in the field, and a rule
    /// correct on 21.4 and wrong on 15.1X49 is worse than no rule (brief §5.2).
    pub junos: Vec<(JunosVersion, u8)>,     // (version, weight)
    pub panos: Vec<(PanosVersion, u8)>,
    pub iosxe: Vec<(IosXeVersion, u8)>,
}

pub enum Hygiene {
    /// Consistent naming, no dead objects, no legacy. Useful for goldens,
    /// unrealistic as an input.
    Clean,
    /// The default. Some inconsistency, some cruft, some shadowed policies.
    Realistic,
    /// Fifteen years of accretion. Three naming conventions, a proposal-set
    /// from 2014, deactivated stanzas, apply-groups, comments in two languages.
    Inherited,
    /// Every string field carries an injection payload. Feeds 34 H17 and 23 §9.
    Hostile,
}
```

### 15.3 The address plan

**Every address in generated output comes from a documentation range**, so a generated config pasted
into a real box by accident cannot collide with anything real, and so a fixture can be published:

| Space | Range | Standard |
|---|---|---|
| Public / peer addresses | `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24` | RFC 5737 |
| IPv6 | `2001:db8::/32` | RFC 3849 |
| Internal | RFC 1918, allocated deterministically per site: site *n* gets `10.n.0.0/16` | RFC 1918 |
| ASNs, where BGP appears | `64512`–`65534` | RFC 6996 |
| Tunnel transit | `10.255.0.0/16`, /30 per tunnel | matches the card's `10.255.0.1/30` |

The card's own examples fall inside this plan — `203.0.113.10` as the peer, `198.51.100.5` as the
local identity, `10.1.0.0/16` and `10.2.0.0/16` as the selectors — which means the field-card fixtures
and the generated fixtures share one address language. That is worth more than it sounds when reading
a diff at 23:00.

### 15.4 Faults, and the expected-findings oracle

A fault is not "make the config wrong". **A fault is a named defect paired with the exact rules it
must trip and the exact rules it must not.**

```rust
pub struct FaultSpec {
    pub kind:        FaultKind,
    /// Which device or tunnel receives it. Deterministic from the seed.
    pub target:      TargetSelector,
    /// Rules that MUST fire, by id, on the named natural key.
    pub must_fire:   Vec<RuleId>,
    /// Rules that MUST NOT fire. Often the interesting half.
    pub must_not:    Vec<RuleId>,
}

pub enum FaultKind {
    // -- crypto, side 2 --
    PfsAbsent,                    // ipsec.pfs.absent
    PfsGroupMismatch,             // two-sided: group14 one end, group19 the other
    CbcWithoutAuthAlgorithm,      // "a missing hash is a silent proposal mismatch"
    GcmWithAuthAlgorithm,         // must_not fire: GCM is AEAD, there is no separate hash
    ProposalSetStandard,          // legacy; "it still leads with DH group 2"
    DhGroupLegacy,                // group2 / group5
    LifetimeOutOfRange,           // outside 180..=86400

    // -- plumbing, side 1 --
    HostInboundIkeMissing,        // "Phase 1 times out with nothing useful in the log"
    St0NotInZone,                 // "the tunnel reads UP while passing zero packets"
    NoRouteAtSt0,
    NoZonePairPolicy,
    NoTunnelInterface,

    // -- identity and liveness, side 2 --
    DpdTooTight,                  // interval 2 threshold 2 — "self-inflicted flaps"
    DpdDefaultOnBackupTunnel,     // 10 x 5 = 50 s of blackhole before failover starts
    IdentityMismatch,             // reads as AUTHENTICATION_FAILED; the misdiagnosis is the PSK
    ModeAggressiveUnderV2Only,    // must_not fire: "means nothing — do not chase it"

    // -- selectors and initiation, sides 1 and 3 --
    DefaultSelectorAnyAny,        // "peers that build one SA per subnet pair reject it outright"
    BothEndsOnTraffic,            // "Nobody initiates, nothing is misconfigured"
    BothEndsResponderOnly,        // "fatal on both ends at once"
    NoVpnMonitorOnRoutedTunnel,   // "a route out st0 stays good while traffic blackholes"

    // -- MTU, side 4 --
    MssClampAbsent,               // "Handshake fine, data stalls = MTU until proven otherwise"
    MssClampAllTcp,               // works, but "a far bigger blast radius than most people intend"
    TunnelMtuUnset,

    // -- operational, side 4 --
    SourceNatEatsTunnelTraffic,   // "needs an explicit no-NAT rule above it"
    TraceoptionsLeftEnabled,      // "will fill /var, which breaks logging and commits both"
    TraceoptionsFlagAll,          // "buries the signal and loads the RE"
}
```

Output:

```rust
pub struct GeneratedEstate {
    /// Sealed with a fixture passphrase. Committed for the named fixtures.
    pub workspace: SealedWorkspace,
    /// `show configuration | display set` text, per device. The ingest input.
    pub configs:   BTreeMap<DeviceName, String>,
    /// Keyed by NATURAL key, never by NodeId — ids are fresh ULIDs on every parse.
    pub expected:  ExpectedFindings,
    /// seed, spec digest, generator version, and the BLAKE3 of `configs`.
    pub manifest:  EstateManifest,
}

pub struct ExpectedFindings {
    pub must_fire: BTreeSet<(RuleId, NaturalKey)>,
    pub must_not:  BTreeSet<(RuleId, NaturalKey)>,
}
```

### 15.5 The named estates

Generated at build time, digest-pinned, and referenced by name from tests, e2e flows and demos:

| Name | Spec | Used by |
|---|---|---|
| `estate-1` | 1 SRX, `Clean`, no faults | Emitter goldens, `44` B9–B11 |
| `estate-1-faulty` | 1 SRX, `Realistic`, 6 faults from side 1's plumbing | Rule fixtures, E7 |
| `estate-20` | `HubAndSpoke{19}`, `Mixed`, `Realistic`, 14 faults | `44` B15/B16/B19, diagram at 500 nodes, E6–E10 |
| `estate-50` | `DualHub{48}`, `Mixed`, `Inherited`, 30 faults | `44` §7.2's `population_drains == 1` assertion |
| `estate-100` | `HubAndSpoke{99}`, `Mixed`, `Inherited` | `44` §4.8.6's open-path problem, memory budget |
| `estate-mesh-8` | `FullMesh{8}` — 28 tunnels | Selector explosion, two-sided rules |
| `estate-hostile` | `estate-1` with `Hygiene::Hostile` | `34` H17, `23` §9 |
| `acme-3site` | `Chain{3}`, `Clean`, 3 teaching faults, hand-tuned names | **The demo.** `fathom demo --estate acme-3site`, and the `?fixture=` first-run |

### 15.6 Determinism, and the test that protects it

```rust
#[test]
fn generator_is_stable() {
    for (name, spec) in NAMED_ESTATES {
        let e = generate(spec);
        assert_eq!(blake3(&e.manifest.configs_digest), PINNED[name],
            "generator output for `{name}` changed. If deliberate, run \
             `xtask estates regen` and review the config diff as vendor syntax.");
    }
}
```

The pinned digests live in `fixtures/estates/PINNED.toml`. A generator change that alters output is
a reviewable diff of vendor configuration — the same review discipline as §5.4, for the same reason.

### 15.7 The honest limits

Three, and none of them is fixable by making the generator better:

| Limit | |
|---|---|
| **It generates syntax we thought of.** | It will never produce the stanza nobody modelled, which is exactly the input that breaks the parser in the field. §11.3 is the only answer and it is a weak one |
| **Its findings oracle is circular for any fault it was taught to inject.** | `PfsAbsent` proves `ipsec.pfs.absent` *fires*. It does not prove the rule is *right* — that the remediation works, that the `acceptable_when` is accurate, or that the severity is calibrated. Only §11.5 does that |
| **`Realistic` is our idea of realistic.** | Real configs are stranger than generated ones in ways that are hard to characterise. `Inherited` is an attempt and it is an impression of accretion, not a sample of it |

The generator's real value is **scale and repeatability**, not realism: it is how we get a 100-device
workspace to measure, a 500-node diagram to pan, and a fault we can assert on. Treating it as evidence
that the product works on real networks is the mistake to avoid.

---

## 16. CI topology and wall clock

*margin tab: fifteen minutes or nothing*

### 16.1 Jobs

| Job | Contents | Wall clock | Blocking | Toolchain |
|---|---|---|---|---|
| `build` | `cargo build --release --locked` for wasm32 and musl; `xtask assemble` | 6 min (release profile is `codegen-units=1`, `lto=fat`; `41` §2.6 warns) | yes | Rust only, hermetic, no network (`42` check 3) |
| `test-core` | §3, §4 (reduced cases), §5, §6, §7, §12.1–12.2 | 4 min | yes | Rust |
| `test-wasm` | WASM-in-browser units, TS micro-runner | 4 min | yes | Rust + chromedriver/geckodriver |
| `e2e` | §9, E1–E15, Chromium; E1–E11 Firefox | 9 min | yes | Rust + drivers |
| `fuzz-smoke` | 60 s × 8 targets over the committed corpus | 5 min | yes | Rust |
| `mutants` | §10, 35 mutants | 6 min | yes | Rust |
| `perf-counters` | `44` §8.2, 30 scenarios | 40 s | yes | Rust |
| `size` | `44` §5.5 | 30 s | yes | Rust + twiggy |
| `corpus` | §14, `61` gates 1–14, `63` pack build | 30 s | yes | Rust |
| `supply-chain` | `cargo deny`, SBOM diff, reproducibility rebuild (`35` R1) | 7 min | yes | Rust |
| `artifact-verify` | `42` `xtask verify-artifact` checks 5–8, 12, 13; `44` P8; `32` §16.3's symbol scan | 40 s | yes | Rust + wasm-objdump |
| **PR total (parallel)** | | **≈ 12 min** | | |
| `nightly-fuzz` | 30 min × 8 targets | 2.5 h | promotion | Rust |
| `nightly-props` | §4 at full case counts | 40 min | promotion | Rust |
| `nightly-perf` | `44` §8.4 on pinned REF-1 | 20 min | alarm | Rust + drivers |
| `nightly-batfish` | §11.4 | 12 min | promotion | **Docker + Java + Python (Z4)** |
| `nightly-crossimpl` | §12.3, Python opener both directions | 3 min | promotion | **Python (Z4)** |
| `nightly-ai-eval` | `25` §8 | per `25` | per `25` | per `21` |
| `release-conformance` | §11.2, manual, on held vendor images | ~90 min | release notes | vendor images, off-CI |

### 16.2 The Z4 boundary, restated

Three jobs use a non-Rust toolchain: Batfish (Java/Docker/Python), the cross-implementation opener
(Python), and the browser drivers. `42` Z4 permits this precisely because none of them produces an
artifact — they run **downstream of the release manifest**, in a job with no write access to the
artifacts, and their failure blocks the release without their output ever entering one.

`42` names the residual risk honestly and it is worth carrying here: **a compromised checker cannot
change bytes but can suppress a failing signal.** The mitigation is that these are the *outer* layers
of the suite; nothing that gates a security invariant runs only in a Z4 job. Every claim in §13 is
also checked by a Rust job or a static scan.

---

## 17. Flakiness, quarantine, and the zero-retry policy

*margin tab: what the log means*

### 17.1 The policy

> **Zero retries. A flaky test is a bug in the test.** (`42` §4.4.)

Retries convert a real intermittent bug into an invisible one. The first time a retry is added, a race
in the product becomes a race nobody will find until a customer does.

### 17.2 Quarantine, with an expiry

Sometimes a test is flaky and the fix is not same-day. The mechanism, with the property that makes it
work:

```toml
# tests/QUARANTINE.toml
[[test]]
id      = "e2e::e06_walkthrough_ipsec"
reason  = "focus race between the findings patch and the next field; suspect 12 §7.4's patch path"
owner   = "…"
opened  = "2026-07-14"
expires = "2026-08-11"          # 28 days, maximum, no extensions without a second reviewer
issue   = "…"
```

| Rule | |
|---|---|
| A quarantined test still runs; its result is reported and does not block | So the flake rate stays visible |
| **An expired entry fails the build** | This is the whole mechanism. A quarantine without an expiry is a deleted test with extra steps |
| Maximum 5 entries at once | Above that, the suite is the problem and the build fails until it is under five |
| Extending an expiry needs a second reviewer's name in the file | Friction proportional to the decision |

### 17.3 Measuring the flake rate

Every CI run writes `(test id, outcome, duration, commit, runner)` to a checked-in append-only
JSONL under `ci/history/`. Weekly, `xtask flake-report` computes per-test failure rates over the last
200 runs. **A test above 0.5 % goes to quarantine automatically, with an issue opened.** A suite whose
flake rate is measured is a suite whose flake rate can be argued about with numbers instead of
impressions.

---

## 18. Coverage — what we gate and what we refuse to gate

*margin tab: not a percentage*

### 18.1 Line coverage is measured and never gated

`cargo llvm-cov` runs nightly and its output is published. **There is no threshold.**

The reason is not that coverage is useless — it is a good tool for finding untested code by reading
the report. The reason is that a threshold changes what people write. A 90 % gate produces tests that
execute lines, and a test that executes a line without asserting anything about it is worse than no
test, because it makes the report say the line is covered.

The specific failure this avoids: an emitter is 100 % line-covered by a test that calls every
`KindEmitter` and asserts only that the result is non-empty. That suite is green, that report is 100 %,
and the product emits wrong configuration.

### 18.2 What is gated instead

Six coverage gates, each over a *set that can be enumerated from the code or corpus*, each at 100 %:

| # | Gate | Enumerated from | Fails when |
|---|---|---|---|
| C1 | Every rule has `must_fire` + `must_pass` | the rule pack | `63` §15 |
| C2 | Every emitter `StatementPath` appears in a golden file | the emitter registry | §5.5 |
| C3 | Every explainer id has a snapshot at all three depths | the corpus | §7 |
| C4 | Every error enum variant is produced by at least one test | `#[derive(EnumIter)]` over the error enums, compared to the set observed during the suite | An error nobody has ever seen constructed — which is where the wrong message hides |
| C5 | Every `fex` builtin has a unit test per argument arity and one failure case | the builtin registry | `12` §3.4 |
| C6 | Every dictionary entry binds in at least one fixture | the dictionary | A dictionary entry that has never been exercised, which is a wrong graph waiting |

C4 and C6 are the two that will find real bugs. C4 because error paths are where untested code
concentrates, and `32` §16.2 has already shown that *which* error is produced is a security property.
C6 because `14` §6.5's dictionary is 2,000 entries per platform authored by hand, and a wrong entry
produces a confidently wrong graph — `14` §13.1's worst row.

### 18.3 The thing coverage cannot measure, said once

Every gate above measures whether a thing was *executed*. None measures whether the assertion was
*right*. §10's mutation controls are the partial answer, and §11.5's expert review is the rest of it.
There is no metric here and there is not going to be one.

---

## 19. What CI enforces

| # | Check | Blocks | Source |
|---|---|---|---|
| T1 | `cargo test --workspace --locked` clean | merge | §3 |
| T2 | Property suite clean at PR case counts | merge | §4 |
| T3 | Property suite clean at full case counts | release promotion | §4.2 |
| T4 | Every golden file matches byte for byte | merge | §5 |
| T5 | Every emitter `StatementPath` has a golden (C2) | merge | §5.5 |
| T6 | Every rule has `must_fire` + `must_pass`; `must_not_fire` where required (C1) | merge | §6 |
| T7 | Two-sided rules have a `must_abstain` fixture | merge | §6.3 |
| T8 | Explainer snapshots clean; > 25 changed snapshots fails with "split this change" | merge | §7.2 |
| T9 | Voice lint: banned phrases, `answers` shape, `read_field` shape | merge | §7.3, `61` |
| T10 | Fuzz smoke over the committed corpus, 8 targets | merge | §8.3 |
| T11 | New nightly crash blocks release promotion | release | §8.3 |
| T12 | E2E E1–E15 clean, zero retries | merge | §9 |
| T13 | **E13 egress: zero requests in mode A** | merge | §13.4 |
| T14 | **E14 no-route run: nothing fails** | merge | §13.4 |
| T15 | Mutation controls: every listed property fails on its mutants | merge | §10 |
| T16 | Crypto KATs and negative vectors clean; the correct error from the correct stage | merge | §12.1, §12.2 |
| T17 | Independent Python opener opens `99-workspace/` to the pinned digest; Python sealer's output opens in Rust | release promotion | §12.3 |
| T18 | P10 clean, and fails on all four seal mutants | merge | §12.4 |
| T19 | `seal_with_salt` and every perf-counter export absent from release artifacts | merge | `32` §16.3, `44` P8, `42` check 6 |
| T20 | Injection corpus structural gate clean | merge | §13.1, `23` §9 |
| T21 | `cargo deny check` clean; no expired `ignore` entries | merge | §13.2 |
| T22 | Daily `cargo deny` against the unchanged lockfile | daily; opens a PR | §13.2 |
| T23 | CSP golden strings, H1–H12 | merge | §13.3, `34` §8 |
| T24 | H17 hostile-content render clean, driven by `estate-hostile` | merge | §13.3 |
| T25 | Corpus gates 1–14; pack build gates | merge | §14, `61`, `63` |
| T26 | Link integrity L1–L6, including ladder acyclicity | merge | §14.2 |
| T27 | Golden query set diff posted; a change is a review item | merge (as a required review) | §14.4 |
| T28 | Estate generator digests match `PINNED.toml` | merge | §15.6 |
| T29 | Coverage gates C1–C6 at 100 % | merge | §18.2 |
| T30 | Quarantine file has no expired entries and ≤ 5 entries | merge | §17.2 |
| T31 | Batfish differential: no *new* unrecognised `StatementPath` prefix | release promotion | §11.4 |
| T32 | Release notes state which fixtures have a conformance report and against which version | release | §11.2 |

---

## 20. Things that bite

*margin tab: most-missed*

**A round-trip test that passes because both directions are wrong the same way.** `emit` writes
`aes256-cbc`, `parse` reads `aes256-cbc`, E1 is green, and Junos rejects it. Only §11's independent
oracles catch this class, and it is the single most likely way this product ships something broken.

**A property test that passes on a broken implementation.** The nonce test that never sees a collision
because there is only ever one key. §10 exists for exactly this, and if §10 is dropped for time, P10
is decorative.

**Golden files regenerated in bulk.** `xtask golden --accept` on a 400-file diff, merged in the same
commit as the behaviour change, reviewed by nobody. §5.4's split rule is the control and it will be
argued with the first time it costs somebody twenty minutes.

**A snapshot suite that has become wallpaper.** 300 diffs, `--accept`, and from then on the snapshots
record whatever the code does. §7.2's 25-file rule.

**`must_pass` fixtures that only cover the trivially-correct case.** A rule with a `must_pass` fixture
containing a config that could not possibly trip it proves nothing. The `must_not_fire` fixtures
(§6.2) are the ones with teeth, because they encode the tempting-but-benign case.

**A two-sided rule that passes when it can only see one side.** It reports "no findings" about
something it never checked. §6.3's `must_abstain`.

**The egress test with one allowlist entry.** A favicon today, a source map next month, a "crash
reporting endpoint, off by default" the month after. There is no allowlist in mode A. None.

**A `cargo deny` ignore with no expiry.** It is a permanent exception with a date on it, and the date
is decoration. `35` §5.5 already forbids it; the operational failure is that somebody adds one at
23:00 to unblock a release.

**A conformance report for a Junos version nobody runs.** A clean `commit check` on 15.1X49 says
nothing about 23.x, and brief §5.2 is explicit that *"a rule that is correct on one and wrong on
another is worse than no rule."* The report carries the version and the release notes quote it.

**Testing at five devices.** The diagram, the lint engine's population rules and the workspace open
path all behave perfectly at five devices and break between twenty and a hundred (`44` §7). A suite
whose largest fixture is `estate-1` will find none of it. **`estate-20` is in the PR suite for this
reason, not for coverage.**

**A 45-minute PR pipeline.** People route around it, and the routing-around is invisible until the
release that breaks. §16's 15-minute budget is a real constraint on what this document is allowed to
ask for.

---

## 21. Open decisions

| # | Decision | Why it matters now |
|---|---|---|
| **O1** | Whether the independent Python opener (§12.3) is built at v1 or deferred | It is the only proof that `32` is implementable from its text, and it is easiest to write while `32` is fresh. Deferring it means writing it against a format that has already shipped |
| **O2** | vSRX licensing for the conformance lab (§11.2's VERIFY) | Decides whether §11.2 is a documented manual procedure or an automatable one. It is a legal question first |
| **O3** | Whether the Batfish differential ever becomes a blocking PR gate | Depends on how large `known-gaps.toml` is after the first month. If it does not shrink, D stays a nightly warning forever and §11's recommendation weakens |
| **O4** | Whether `Hygiene::Inherited` is worth building at v1 | It is the most expensive mode and the one most likely to find parser bugs. It is also the one most likely to encode our imagination rather than reality (§15.7) |
| **O5** | Whether the golden query set's top-3 diff should ever block rather than being a review item | `61` says review item and this document agrees. Revisit if a ranking regression ships |
| **O6** | Whether WebKit coverage is a documented gap or a macOS runner (§9.3) | `42` §4.4 asks the same question and asks for a decision rather than a drift. Still undecided |

---

## 22. Sources

| Claim | Source |
|---|---|
| Round-trip laws E1–E4 and the operations-not-values generator rule | `docs/10-core/13-emitters-and-provenance.md` §11 |
| D1/D2/D3, the `Mechanical` reversibility qualifier, the runtime self-check | `docs/10-core/18-diff-verify-rollback.md` §§3.8, 5 |
| Fuzz targets A–E, `ValidConfig`/`DamagedConfig`/`ConfigWithCanaries`, the corpus taxonomy, the donation path, the panic/hang policy | `docs/10-core/14-parsers-and-ingest.md` §§9.11, 13 |
| Rule fixture requirement, pack build gates, the citation-shape limitation | `docs/60-content/63-rulepack-spec.md` §§12, 15 |
| Corpus gates 1–14, `answers`/`read_field` lint shapes, the golden query set | `docs/60-content/61-command-corpus-spec.md` §§3, 14 |
| Explainer style rules S1–S10 and the P-code lints | `docs/10-core/15-explainer-corpus.md` §8 |
| Rule engine fixture execution, the incremental model, Tier A/B/C | `docs/10-core/12-rule-engine.md` §§6, 7, 15 |
| Crypto vector tree, negative vectors, the deterministic-seal hook and its controls, the nonce argument | `docs/30-security/32-cryptography.md` §§5.3–5.4, 16 |
| H1–H40, the hostile-content fixture, the SVG export assertions | `docs/30-security/34-browser-hardening.md` §8 |
| `cargo-deny` policy, reproducibility, the Z4 job class boundary | `docs/30-security/35-supply-chain-and-builds.md` §5.5; `docs/40-stack/42-no-node-runtime.md` §7, §9.4 |
| The harness, the no-Playwright decision, the zero-retry policy, the fixture URL parameter | `docs/40-stack/42-no-node-runtime.md` §4 |
| Work counters, the perf gate split, the reference machines | `docs/40-stack/44-performance-budgets.md` §§2, 8 |
| Injection corpus and the adversarial mock; AI evaluation | `docs/20-ai/23-ai-safety-and-injection.md` §9; `docs/20-ai/25-ai-evaluation.md` |
| Batfish reports unrecognised and unsupported lines via `initIssues` / `fileParseStatus`; it builds a vendor-independent representation from raw configs | pybatfish documentation, *Snapshot Input* and *Getting Started with Batfish* |
| vJunos-router and vJunos-switch are free for non-production lab use, are virtual MX and EX9214 respectively, and are packaged for containerlab via vrnetlab; vSRX is a 60-day evaluation download | containerlab documentation, *Juniper vJunos-router* / *Juniper vJunos-switch*; Juniper's vJunos Labs and vSRX trial pages |
| Documentation address blocks; IPv6 documentation prefix; private address space; private-use ASNs | RFC 5737; RFC 3849; RFC 1918; RFC 6996 |
| ChaCha20-Poly1305 AEAD construction and test vector; HKDF and its test vectors; Argon2 and its parameters; HPKE and its vectors; deterministic CBOR | RFC 8439 §2.8; RFC 5869 App. A; RFC 9106; RFC 9180 App. A; RFC 8949 |
| IKEv2 and the PFS rationale referenced by the PFS rule | RFC 7296 |
| Field-card material — the object chain, the five plumbing pieces, the bring-up ladder, the error decoder, the flap-pattern table, `THINGS THAT BITE`, the `mode aggressive` under `v2-only` note, the GCM/CBOR hash note, the two-SPI note, the IKEv2 lifetime note | `.context/field-card-srx-ipsec.txt`, sides 1–4 |

---

## 23. Disagreements

**None with `conventions.md`.** Terminology, the three-value risk enum, the identifier schemes, the
`acceptable_when` requirement and the determinism invariant are all followed as written. The risk enum
appears in this document only where it belongs — E1's assertion on a finder result, §5.3's assertion
that `set` lines emit as `ChangesConfig`, §11.2's note that a conformance lab is running
`ChangesConfig` commands against a disposable VM, and §14.2's L5 — and is never reused for finding
severity, test status or coverage.

One convention is *strained* rather than disagreed with, and it is worth recording: **`63` §—'s
citation linter checks the shape of a reference and not its existence, because the linter has no
network (invariant 1).** That is the right call and it leaves a real hole (§14.1): a plausible
fabricated citation passes every automated gate. The only control is human review, and this document
does not propose weakening invariant 1 to close it. It proposes saying so out loud in the review
checklist, which is what §14.1 does.
