# 13 — Emitters and provenance

> **Status:** Proposed

Companion documents: `docs/10-core/11-ir-schema.md` (the graph this reads),
`docs/10-core/12-rule-engine.md` (the findings that annotate lines),
`docs/10-core/18-diff-verify-rollback.md` (what consumes a change set),
`docs/60-content/63-rulepack-spec.md` (`remediation.patch`, which feeds this).

Owner brief §5.3 has already decided the thing that matters:

> **DECISION — emitters return `(line, provenance)` pairs, never strings.**

That decision is not re-argued here. This document builds everything the decision implies
and does not yet specify: what an emitted line actually is, what orders lines, how one
graph becomes four different vendor dialects without four different code paths, what
happens to a concept a platform cannot express, how credentials stay out of the product,
and how a click on a line of config reaches a paragraph of authored prose.

The register throughout is the field card's: **name the failure mode, not the feature.**

---

## 0. Contents

| § | |
|---|---|
| 1 | What an emitter is, and what it is not |
| 2 | `EmittedLine` in full |
| 3 | `StatementPath` — the addressing scheme both this and §18 rest on |
| 4 | Blocks |
| 5 | Ordering — is it real, and what is the total order |
| 6 | Emitter architecture — DECISION: a typed trait, not templates, not a visitor |
| 7 | The emit pipeline |
| 8 | Vendor divergence — four renderings of one graph |
| 9 | Representability, and never dropping silently |
| 10 | Placeholders — invariant 3 at the line level |
| 11 | Round-tripping — the fixed-point property and its test |
| 12 | Line-level explanation — the full resolution path |
| 13 | Wrapping, rendering and the clipboard |
| 14 | Complexity, memory and budget |
| 15 | Failure modes of the emitter itself |
| 16 | Open decisions |
| 17 | Sources consulted |
| 18 | Disagreements |

---

## 1. What an emitter is, and what it is not

```
config = emit(graph, platform)
```

An **emitter** is a total function from a graph subset plus a platform to an ordered
sequence of `EmittedLine` values and an `EmitReport`. It is pure, deterministic, allocates
bounded memory, and reads nothing outside the graph, the schema and the corpus.

| Not this | Because |
|---|---|
| A template engine | §6.1. Owner brief §3.2 places Jinja fluency on the *other* side of the line Fathom is drawing; `63-rulepack-spec.md` §9.3 rejects Jinja for remediation lines on the grounds that a template with a conditional in it is a template with an untested branch pointing at someone's production firewall. Same argument, larger blast radius. |
| A serialiser | A serialiser writes every field. An emitter writes the fields the platform needs, skips defaults (schema §5.2), refuses to guess at `Unknown`, and reports what it could not say. |
| A device driver | Invariant 2. Output is text a human pastes. There is no session, no transaction, no acknowledgement, and no way to know whether the paste landed. Every design choice below assumes the output may be applied in part, out of order, or a week later. |
| A place for vendor logic that rules also need | If the emitter is the only thing that knows `aes-256-gcm` implies no separate `authentication-algorithm`, then no rule can find that error. That constraint lives in the schema (schema §4.3, the `aead` flag) and the emitter reads it. |
| A pretty-printer | Wrapping is §13 and it is a *rendering* concern applied after emit. `EmittedLine.text` is one logical line. |

### 1.1 The partial-graph obligation

Schema §9 (`Presence`) means most of the graph is `Unknown` most of the time. The emitter
therefore has three outcomes per statement, not two:

| Outcome | When | What the user sees |
|---|---|---|
| Emit | every field the statement needs is `Set` or `Default` | the line |
| Skip | the field is `Default(v)` and `--explicit-defaults` is off, or `Absent` and the platform has no positive absence form | nothing, silently — this is the only silent case, and it is silent because the emitted config is *correct* without it |
| **Block** | a required field is `Unknown`, or the field is `Conflicted` (schema §5.4) | a `Blocker` in the `EmitReport`, rendered in place, in the position the line would have occupied |

A blocker is not an error. It is the walkthrough's next question (rule engine §2.2 calls the
same state `Pending`). Rendering it *in position* is what makes a half-built config legible:
you see the shape of what you are building and the holes in it, in the order the card
teaches them.

---

## 2. `EmittedLine` in full

### 2.1 The owner's sketch, and what is missing from it

```rust
struct EmittedLine {
    text: String,
    source_node: NodeId,
    source_fields: Vec<FieldRef>,
    rules_applied: Vec<RuleId>,
    risk: Risk,          // ReadOnly | ChangesConfig | Disruptive
    order_hint: u32,
}
```

Six fields, and every one survives. What it cannot express, in the order the gaps bite:

| Missing | Consequence of leaving it out |
|---|---|
| A stable identity for the line | The UI cannot address a line across a re-emit. Click-to-explain works; click-to-explain-*after-you-edited-something* does not. |
| The statement it asserts, structurally | §18's config diff is impossible. You are left with a text diff, which cannot tell "value changed" from "line moved". |
| Whether the line asserts or retracts | There is no `delete` form at all, so a change set can only ever add. |
| Dependencies between lines | §5. On IOS this is a correctness bug, not a cosmetic one. |
| Block membership | Every emitted config is one flat wall of text with no headings — the exact opposite of the field card's grammar. |
| What re-applying the line does | §2.5. `set … proposals IKE-P1` twice is not the same as once. |
| Where a credential must go | Invariant 3 needs a machine-readable answer, not a convention in a string. |
| The explainer entry point | §12. Otherwise the resolution path is a string match against the emitted text, which breaks the moment a name changes. |

### 2.2 The type

```rust
/// One logical line of vendor configuration, or one operational command,
/// with everything needed to explain it, order it, diff it and invert it.
#[derive(Clone, Debug)]
pub struct EmittedLine {
    // ---- identity -------------------------------------------------------
    /// Stable across re-emits of an unchanged statement. See §2.3.
    pub id: LineId,

    // ---- content --------------------------------------------------------
    /// Exactly one logical line. No newlines, no continuation backslashes,
    /// no leading indent. Rendering owns all three (§13).
    pub text: CompactString,
    /// The structural form of `text`. The diff and the rollback read this,
    /// never `text` (§3).
    pub path: StatementPath,
    pub form: LineForm,

    // ---- provenance (invariant 6) ---------------------------------------
    /// The node whose stanza this is. For `set security ipsec vpn VPN-B ike
    /// gateway GW-B` that is the `IpsecVpn`, not the `IkeGateway`.
    pub source_node: NodeId,
    /// Every (node, field) that contributed a token to `text`, in token
    /// order. The line above yields two: IpsecVpn.name and IkeGateway.name,
    /// the second with role `Referenced`.
    pub source_fields: SmallVec<[FieldRef; 4]>,
    /// Rules that produced or modified this line (rule engine §10.5).
    pub rules_applied: SmallVec<[RuleId; 2]>,
    /// Corpus entry point for click-to-explain (§12).
    pub explain: ExplainKey,

    // ---- consequence ----------------------------------------------------
    pub risk: Risk,                       // conventions: exactly three values
    pub idempotency: Idempotency,         // §2.5
    pub reversibility: Reversibility,     // §18.5 computes rollback from this

    // ---- placement ------------------------------------------------------
    pub block: BlockId,
    pub phase: Phase,                     // §5.4
    /// Within-block tiebreak. The owner brief's field, narrowed: it no
    /// longer carries cross-block ordering, which `block.rank` now owns.
    pub order_hint: u32,
    /// Hard ordering constraints. Empty on most lines.
    pub requires: SmallVec<[LineId; 2]>,

    // ---- credentials (invariant 3) --------------------------------------
    pub placeholders: SmallVec<[PlaceholderSpan; 1]>,
}
```

`SmallVec` sizes are chosen from the field card's own lines: the widest statement on side 1
is `set security ipsec vpn VPN-B traffic-selector TS1 local-ip 10.1.0.0/16 remote-ip
10.2.0.0/16`, which is four contributing fields. Beyond the inline capacity it spills to the
heap; nothing breaks, it just costs an allocation.

**Naming collision, flagged.** `12-rule-engine.md` §5.1 uses `FieldRef` for the *static*
`(kind, field)` pair in a read-set. The emitter needs the *instance*: `(node, field)`. Two
different types with one name across two documents is a bug waiting to happen. See §16,
open decision OD-1.

```rust
/// Emitter-side: an instance-level field reference.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct FieldRef {
    pub node: NodeId,
    pub field: FieldId,
    pub role: FieldRole,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum FieldRole {
    /// This field's value is the payload of the statement.
    Value,
    /// This field names the object the statement configures.
    Subject,
    /// This field names a *different* object the statement points at.
    /// Click-to-explain on this token navigates there.
    Referenced,
    /// The field did not appear in the text but determined that the line
    /// exists at all, or determined its shape. `EncryptionAlgorithm.aead`
    /// is `Conditioning` on the *absence* of an authentication-algorithm
    /// line: side 1 of the card, "GCM is AEAD, so there is no separate
    /// authentication-algorithm."
    Conditioning,
}
```

`Conditioning` is the field that pays for itself. Without it, "why is there no
`authentication-algorithm` line here?" has no answer, and that question is exactly the one
the card says people get wrong.

### 2.3 `LineId` — stability without a counter

```rust
/// blake3-128 over (platform, canonical path tokens, form discriminant).
/// NOT over `text`: a rename changes the text of every line that mentions
/// the object, and we want those lines to keep their identity so the UI
/// does not repaint the world.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct LineId(pub [u8; 16]);
```

Hmm — a rename *does* change the path, because object names are `PathToken::Name`. So a
rename does change `LineId`. That is the correct behaviour and it is worth being explicit
about: a rename is a different statement on the device. `delete security ike gateway GW-B`
plus `set security ike gateway GW-C …` is what the device sees, and pretending otherwise in
the UI would misrepresent the change. Invariant 7 protects *rules, suppressions and diagram
elements* from renames by keying them on ULIDs; it does not and should not protect emitted
lines, because the device has no ULIDs.

Consequence, stated: `LineId` is stable across re-emit of an unchanged statement, and across
value changes to *other* statements. It is not stable across a rename of the object the
statement configures, and §18's diff will show a rename as a delete plus an add unless the
graph diff independently identifies it as a `Renamed` node delta (§18.2.3) and the renderer
groups them.

### 2.4 `LineForm` — the negation form, and the rest

```rust
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LineForm {
    /// Positive assertion. Junos `set`, PAN-OS `set`, IOS the bare command.
    Assert,
    /// Removal. Junos `delete`, PAN-OS `delete`, IOS `no <command>`.
    /// Carries whether the removal is of a whole subtree or one leaf,
    /// because the two are the same syntax on Junos and different
    /// commands on IOS.
    Retract { scope: RetractScope },
    /// Junos `deactivate` / `activate`. The configuration stays in the
    /// tree, marked `inactive:`, and does nothing. No IOS or PAN-OS
    /// equivalent — see §9.
    Deactivate,
    Activate,
    /// Position change within an ordered list. Junos `insert … before|after`.
    /// The anchor must already exist.
    Reorder { anchor: StatementPath, rel: InsertRel },
    /// A show / ping / clear command. Never committed, never diffed,
    /// always `Risk::ReadOnly` unless it is a `clear` (§5.5).
    Operational,
    /// A comment. Emitted only where the platform's paste path accepts one,
    /// and never load-bearing — the config must be correct with every
    /// annotation stripped.
    Annotation,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RetractScope { Leaf, Subtree }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InsertRel { Before, After }
```

Two notes that matter more than they look.

**`Deactivate` is not `Retract` and the difference is operational.** `deactivate security
ipsec vpn VPN-B` leaves the whole object in the configuration marked `inactive:` and tears
the tunnel down; `delete` removes it. For a maintenance window the first is almost always
what you want, because reactivating is one command and re-typing an object is a change
ticket. Junos supports it; PAN-OS and IOS do not have an equivalent that preserves the
object, and that asymmetry is a §9 gap, not something to paper over.

**`Retract { scope: Subtree }` is a platform capability, not a universal one.** On Junos,
`delete security ike gateway GW-B` removes everything under that path. On PAN-OS,
`delete network ike gateway GW-B` likewise. On IOS there is no general prefix delete: you
issue the specific negation for the specific object (`no crypto ikev2 profile GW-B`), and
there are commands with no negation at all. `Platform::supports_subtree_retract()` gates
the subsumption optimisation in §18.3.5.

### 2.5 `Idempotency` — what re-applying does

This is the field the field card forces into existence. From side 2:

> *"`proposal-set standard` saves typing but is old — it still leads with DH group 2, and
> you cannot see what it offered without the docs. Write proposals out."*

The reason writing them out matters operationally is that `proposals` is a **set-valued**
statement. `set security ike policy IKE-POL proposals IKE-P1` issued twice with two
different names leaves you with two proposals on the policy and a negotiation that may pick
either. Re-issuing a scalar leaf like `lifetime-seconds` simply overwrites.

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Idempotency {
    /// Re-applying is a no-op. Scalar leaves. The overwhelming majority.
    Idempotent,
    /// Re-applying with a *different* value adds a second member.
    /// Changing the value requires delete-then-set (§18.3.4).
    Accumulating,
    /// Re-applying with a different value replaces the previous one, but
    /// the statement is not a leaf — e.g. a whole `traffic-selector TS1`
    /// re-specified. Safe to re-apply; not safe to assume the old
    /// sub-fields survived.
    Replacing,
    /// Re-applying is unsafe or meaningless. `Reorder` (the anchor may
    /// have moved), `rename`, `clear`.
    NonIdempotent,
}
```

`Idempotency` is declared on the **schema field**, per platform, in the corpus — not
inferred by the emitter. It is a claim about a vendor's data model and it needs a citation
and a named reviewer like every other such claim (invariant 10).

```yaml
# corpus/statements/junos-srx.yaml
- kind: IkePolicy
  field: proposals
  path: [security, ike, policy, "$name", proposals, "$value"]
  idempotency: Accumulating
  retract_needs_value: true      # `delete … proposals IKE-P1`, not `delete … proposals`
  citation: "Junos configuration hierarchy: `proposals` is a leaf-list."
  reviewed_by: <named human>
```

`retract_needs_value` is the second-order consequence and it is easy to get wrong: for an
accumulating statement, `delete security ike policy IKE-POL proposals` removes *all* of
them. That is occasionally what you want and usually a disaster, so the diff never emits it
without an explicit `RetractScope::Subtree` decision.

### 2.6 `Reversibility`

Computed at emit time because the emitter is the only thing that knows what the statement
does. Consumed by §18.5.

```rust
#[derive(Clone, Debug)]
pub enum Reversibility {
    /// The inverse is mechanical and complete, given the base value.
    /// Requires the diff to supply the base — see §18.5.1.
    Mechanical,
    /// The inverse exists but restores less than it removed, because the
    /// graph did not model everything under this path.
    Partial { unmodelled: SmallVec<[StatementPath; 2]> },
    /// No inverse can be generated. The reason is not a string for the UI
    /// to render prettily; it selects the sentence that goes in the ticket.
    None { reason: NoInverse },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum NoInverse {
    /// We never held the value. Invariant 3 guaranteed it.
    CredentialNeverHeld,
    /// The base state was `Unknown`. Asserting anything would invent a value;
    /// retracting might remove a statement that was there. §18.5.3.
    BaseUnknown,
    /// The effect is not in the configuration. `clear security ipsec
    /// security-associations` cannot be un-cleared.
    NotConfigState,
    /// The configuration inverts; the world does not. Dropped sessions,
    /// external references to a renamed object.
    ExternalEffect,
}
```

---

## 3. `StatementPath` — the addressing scheme

Everything structural in this document and in §18 is keyed on this type. It is worth more
than the emitted text, because the text is a rendering and the path is the fact.

```rust
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct StatementPath {
    pub plat: PlatformId,
    pub tokens: SmallVec<[PathToken; 8]>,
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum PathToken {
    /// A fixed keyword from the platform's hierarchy: "security", "ike".
    Kw(&'static str),
    /// An object name. `Identifier` semantics from schema §4.3 — validated,
    /// never normalised, case significant where the platform says so.
    Name(CompactString),
    /// A unit, a sequence number, a policy ordinal.
    Index(u32),
    /// A value that participates in the *identity* of the statement.
    /// Present only on `Accumulating` statements, where `… proposals IKE-P1`
    /// and `… proposals IKE-P2` are two statements, not one with two values.
    Member(CompactString),
}
```

### 3.1 Properties the rest of the design depends on

| P | Property | Why it is needed |
|---|---|---|
| P1 | **Total order.** `Ord` derives lexicographically over `tokens`, and `PathToken`'s derived `Ord` breaks discriminant ties first (`Kw < Name < Index < Member`). | §5.6's determinism proof. |
| P2 | **Uniqueness within one emit.** No two lines in one `EmitOutput` share a path. | §5.6, and §18.3's index. Enforced, not assumed — see §3.2. |
| P3 | **Prefix = containment.** If `p` is a prefix of `q`, the statement at `q` lives under the statement at `p`, and (on platforms with `supports_subtree_retract`) retracting `p` retracts `q`. | §18.3.5's subsumption. |
| P4 | **Round-trippable.** `render_path(p)` produces the vendor's own hierarchy text, and the parser produces the same `p` from that text. | §11. |
| P5 | **Platform-scoped.** Paths from two platforms are never compared. `plat` is in the type and there is no cross-platform `Ord`. | Junos's six-object chain and PAN-OS's four-object one have no meaningful path correspondence (§8.4). |

### 3.2 Enforcing P2

Two lines with the same path in one emit are either a duplicate or a contradiction, and
which one it is decides what happens:

```
finalise(lines):
    lines.sort_by(|l| (&l.path, l.form))
    for each run of equal (path, form):
        if all `text` equal:
            merge -> one line, union of source_fields, union of rules_applied,
                     max risk, min order_hint
        else:
            EmitConflict { path, candidates } -> report, and BLOCK the emit
```

An `EmitConflict` is not survivable by picking one. Two emitters producing different text
for the same statement means the schema has the same fact in two places, which schema §4.6
already forbids for `st0.0`. Blocking is loud and the fix is a schema fix.

Cost: one sort, `O(n log n)` on line count, on every emit. At the sizes in §14 this is
noise.

---

## 4. Blocks

The field card's grammar is: a section head in letterspaced caps, prose, a mono block, and
sometimes a 4px-accent-bar note — *the thing people miss*. Emitted config inherits that
shape exactly, because the shape is the teaching.

```rust
pub struct Block {
    pub id: BlockId,
    /// Uppercase, letterspaced by CSS, never by inserting spaces
    /// (design language, Type).
    pub title: &'static str,
    /// The card's lowercase, unpunctuated, almost apologetic marginal
    /// label: "most-missed", "verify as you go", "fields that matter".
    pub margin_tab: Option<&'static str>,
    /// Fixed per (platform, domain). Determines cross-block ordering.
    pub rank: u16,
    /// The node this block is about. Click-to-explain on the *heading*
    /// resolves here.
    pub anchor: NodeId,
    pub explain: ExplainKey,
    /// The 4px-accent-bar note. Authored, never generated.
    pub note: Option<ExplainKey>,
    /// max over member lines, ordered ReadOnly < ChangesConfig < Disruptive.
    pub risk: Risk,
    /// Count of `Blocker`s inside this block. Rendered as a margin tab:
    /// "2 unanswered".
    pub blockers: u16,
}
```

### 4.1 The block table for `junos-srx` / IPsec site-to-site

Taken directly from the card's own section order. This is the payoff of "one graph, six
views": the config the tool emits reads in the order the card teaches, because both are
projections of the same object chain.

| rank | title | margin tab | card source |
|---|---|---|---|
| 10 | `GUARD` | `always, remotely` | side 1, bring-up order step 1 |
| 20 | `PHASE 1 — PROPOSAL, POLICY, GATEWAY` | | side 1 |
| 30 | `PHASE 2 — PROPOSAL, POLICY, VPN` | | side 1 |
| 40 | `#1 THE TUNNEL INTERFACE` | | side 1, five plumbing pieces |
| 41 | `#2 ST0 INTO A ZONE` | `most-missed` | side 1 |
| 42 | `#3 LET IKE REACH THE BOX` | `most-missed` | side 1 — *"Miss #3 and Phase 1 times out with nothing useful in the log"* |
| 43 | `#4 ROUTE THE REMOTE PREFIX AT ST0` | | side 1 |
| 44 | `#5 POLICY FOR THE ZONE PAIR` | | side 1 |
| 50 | `MTU` | `not VPN-specific` | side 4 |
| 90 | `COMMIT` | | |
| 95 | `VERIFY` | `verify as you go` | side 1 + side 3, generated per §18.4 |

The ordinals are content, not `<ol>` chrome — design language, *devices worth stealing*,
item 6.

### 4.2 Blocks are authored, not derived

**RECOMMENDATION — the block table is corpus data with a named reviewer, not a function of
the graph.** A derived grouping would be "one block per node kind", which produces
`IkeProposal`, `IkePolicy`, `IkeGateway` as three headings and loses the fact that they are
one idea. The card groups them under one heading because they are one idea. That judgement
is the teaching pillar and it does not come out of a traversal.

Cost: a new node kind with no block-table entry lands in a `MISCELLANEOUS` block at rank
900, and CI fails the corpus build with the kind name. Deliberately annoying.

---

## 5. Ordering

### 5.1 The question, asked precisely

Junos side 1 of the card shows `ike proposal → ike policy → ike gateway`, each referencing
the one before it by name. Does the *order of the `set` lines* matter?

**No, on Junos. Yes, on IOS. And the difference is not a detail — it is a property of how
the platform applies configuration, and it changes the shape of the emitted change set.**

### 5.2 The evidence

**Junos.** Configuration is edited in a *candidate* database and validated as a whole at
`commit`. Juniper's CLI User Guide states plainly that you may enter statements in any
order, and that order matters only where the statements themselves form an analysed
sequence (policy terms, firewall filter terms) — and that for `insert`, the reference point
must already exist. The field card says the same thing from the operator's side:

> *"Junos enforces these references at commit — a missing policy name fails the commit.
> What it cannot catch is a name that exists but holds values the far end won't accept."*

So `set security ike policy IKE-POL proposals IKE-P1` followed later by
`set security ike proposal IKE-P1 dh-group group14` commits fine. The forward reference is
resolved at commit, not at entry.

**PAN-OS.** Also a candidate configuration committed as a whole, so the same reasoning
applies. <!-- VERIFY: whether the PAN-OS CLI rejects a reference to a not-yet-existing object at `set` time or defers it to commit. Test on a lab box: `set network tunnel ipsec T1 auto-key ike-gateway GW-DOES-NOT-EXIST` before creating the gateway. -->

**IOS / IOS-XE.** Commands apply to the running configuration as they are entered. A
forward reference is rejected at the moment you type it — `set transform-set TS` inside a
crypto map with no `TS` defined returns `transform set with tag TS does not exist`. There is
no candidate database in classic configuration mode, so a paste that arrives in the wrong
order half-applies and leaves the box in a state neither A nor B.

### 5.3 DECISION — order everywhere anyway, and say why honestly

We topologically sort on every platform, including the ones that do not require it. Three
reasons, in order of weight:

1. **Correctness on `ImmediateApply` platforms.** Non-negotiable.
2. **Partial-paste safety.** Engineers paste half a block, get interrupted, and come back.
   On a candidate-config platform an out-of-order half-paste is still fine at commit, but
   the *reader* cannot tell whether it is fine. Dependency-ordered output means every prefix
   of the change set is a coherent partial change.
3. **One code path.** A platform-conditional sort is a platform-conditional bug.

**What we must not do is claim a false reason.** The generated change ticket is read by
change managers and by engineers who will check it. A ticket that says "the proposal must
precede the policy on Junos" is wrong, and one wrong statement discredits the rest. The
explainer attached to ordering says:

> Ordered so that every object exists before it is named. On IOS this is required — a
> forward reference is rejected as you type it. On Junos and PAN-OS the candidate
> configuration resolves references at commit, so this ordering is for the reader and for
> anyone who pastes only part of it.

### 5.4 `Phase` — and why it differs per regime

```rust
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Phase { Guard = 0, A = 1, B = 2, C = 3, Commit = 4, Verify = 5 }

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OrderingRegime {
    /// Candidate configuration, references resolved at commit.
    /// junos-srx, panos.
    CandidateResolved,
    /// Applied statement by statement to the running configuration.
    /// ios, ios-xe, nx-os.
    ImmediateApply,
}
```

`A`, `B`, `C` are deliberately unnamed in the enum because their meaning is regime-dependent:

| Regime | A | B | C | Rationale |
|---|---|---|---|---|
| `CandidateResolved` | **Retract** | **Assert** | **Reorder** | Retract-first produces the cleanest `show \| compare` before commit, which is what the operator actually inspects. Nothing is live until commit, so there is no window in which the retraction has taken effect and the assertion has not. |
| `ImmediateApply` | **Assert** | **Rebind** | **Retract** | Make-before-break. Every statement takes effect the instant it is entered. Deleting the old proposal before the new one is bound would leave the profile referencing nothing, live. Additive-first, repoint, then remove the orphan. |

This is a real behavioural difference between the two change sets Fathom emits for the same
graph diff, and it is the clearest single argument for `OrderingRegime` being a first-class
platform property rather than an if-statement.

`Rebind` is not a `LineForm`; it is a classification the diff assigns (§18.3.4) to an
`Assert` whose path already exists in the base with a different value.

### 5.5 `Risk` and `clear`

`Operational` lines are `ReadOnly` with one class of exception, and the card is emphatic
about it:

> *"Clearing P1 tears down every child SA under it — on a hub that is every spoke at once.
> Always scope by peer or index. Clearing P2 alone forces a rekey and is the cheapest way to
> prove a tunnel comes back cleanly."*

So:

| Command | Risk | Note carried on the line |
|---|---|---|
| `show …` | `ReadOnly` | |
| `ping …` | `ReadOnly` | |
| `clear security ipsec security-associations` (unscoped) | `Disruptive` | forces a rekey on every tunnel on the box |
| `clear security ipsec security-associations index <n>` | `ChangesConfig` | one SA rekeys; traffic on that SA pauses |
| `clear security ike security-associations <peer-ip>` | `Disruptive` | tears down every child SA under that P1 |
| `set security ike traceoptions …` | `ChangesConfig` | and the card's warning: *"Traceoptions left on will fill `/var`"* |

`clear security ipsec statistics` is `ChangesConfig`, not `ReadOnly` — it destroys the
baseline you were about to compare against. That is not disruption, but it is not read-only
either, and the three-value enum forces the honest call.

### 5.6 The total order, and its determinism

**Sort key.**

```rust
fn key(l: &EmittedLine, blocks: &BlockTable) -> (Phase, u16, BlockId, u32, &StatementPath) {
    (l.phase, blocks[l.block].rank, l.block, l.order_hint, &l.path)
}
```

**Algorithm — canonical topological sort.** Kahn's algorithm over the dependency DAG, with
the ready set held in a binary min-heap ordered by `key`.

```
order(lines, deps, blocks) -> Vec<EmittedLine>:
    indeg[l] = |{ d : (d -> l) in deps }|
    ready    = MinHeap<key>  seeded with all l where indeg[l] == 0
    out      = []
    while ready non-empty:
        l = ready.pop_min()
        out.push(l)
        for each m in succ(l):
            indeg[m] -= 1
            if indeg[m] == 0: ready.push(m)
    if |out| < |lines|:  EmitCycle { remaining }   # §15.3
    return out
```

**Claim.** For a fixed set of lines and a fixed dependency relation, `order` produces one
unique sequence, on every machine, in every build.

**Proof.** By induction on output position `i`.

- *Base.* The ready set after seeding is determined by `indeg`, which is a function of
  `deps` alone. `key` is a strict total order on lines: `path` is a strict total order by
  P1, and by P2 no two lines share a path within one emit, so no two keys are equal.
  A min-heap over a strict total order has a unique minimum. Position 0 is determined.
- *Step.* Assume positions `0..i` are determined. Then the multiset of popped lines is
  determined, so `indeg` after `i` pops is determined, so the ready set at step `i` is
  determined, so its unique minimum is determined. Position `i` is determined. ∎

The proof rests on exactly two things, and both are enforced rather than assumed:

| Rests on | Enforced by |
|---|---|
| `key` is a strict total order | P1 (derived `Ord` on `StatementPath`) and P2 (§3.2 blocks on duplicate paths) |
| `deps` is a deterministic function of the graph | §5.7 |

**Complexity.** `O(V + E)` for the traversal plus `O(V log V)` for heap operations, where
`V` is line count and `E` dependency-edge count. §5.7 bounds `E = O(V)`, so the whole thing
is `O(V log V)`. For the field card's full side-1 build — 24 config lines — this is
irrelevant; for a 40-device workspace emit at ~6,000 lines it is under a millisecond.

### 5.7 Where `deps` comes from, and why it is bounded

Dependency edges are generated by exactly three producers, and nothing else may add one:

| Producer | Edge | Bound |
|---|---|---|
| **Reference edges in the graph** (schema §3.4, class `Reference`) | the line that *creates* the referenced object → the line that *names* it | one edge per `FieldRole::Referenced` occurrence. Bounded by `Σ\|source_fields\|`, and `source_fields` is capped by the schema's per-statement arity. In the IPsec domain the maximum is 2 (`ipsec vpn` naming both a gateway and a policy). |
| **Containment** (schema §3.4, class `Containment`) | parent-object line → child line | one edge per containment relation, and containment edges form a forest, so ≤ `V` total. |
| **Same-path retract/assert pairing** | `Retract(p)` → `Assert(p)` on `CandidateResolved`; the reverse on `ImmediateApply` | at most one per path, so ≤ `V`. |

Total `E ≤ 4V`. Nothing traverses the graph looking for reasons to add an edge, and there is
no API by which an emitter author can add an arbitrary one — `requires` is populated by the
pipeline (§7), not by `KindEmitter::emit`. That closure is what makes the bound a fact
rather than a hope.

**A cycle is a schema bug, not a user error.** If `deps` contains a cycle, two objects
reference each other and neither can be created first. On a `CandidateResolved` platform
that is fine and the cycle should not have been generated; on `ImmediateApply` it is
genuinely unresolvable and the honest output is an `EmitCycle` report naming the
participating paths, plus the lines in `key` order with a banner saying the ordering could
not be guaranteed. Not a panic, not a silent arbitrary order.

---

## 6. Emitter architecture

### 6.1 The three candidates

| Shape | What it is | Verdict |
|---|---|---|
| **Templates** | A per-platform template file per kind, rendered against node data. Jinja, Handlebars, or a bespoke minimal one. | **Reject.** |
| **Visitor** | A `GraphVisitor` trait with `visit_ike_gateway`, `visit_ipsec_vpn`, … implemented once per platform. | **Reject.** |
| **Typed emitter trait** | One trait, implemented per `(platform, kind)`, registered in a static table, driven by a fixed pipeline. | **DECISION — this.** |

**Why not templates.** Four reasons, in order of how badly they bite.

1. **A template returns a string.** Invariant 6 says emitters return `(line, provenance)`
   pairs. To keep provenance you would have to annotate inside the template — which means
   inventing a provenance syntax in a template language, which is a worse version of the
   Rust API in §7.2 with no type checking. The owner brief's own sentence applies: *"If
   emitters return strings, explanation gets bolted on afterwards and the emitters get
   rewritten."*
2. **A template with a conditional is a template with an untested branch**, and the branch
   emits into a production firewall. `63-rulepack-spec.md` §9.3 already made this call for
   remediation lines. Emitters have strictly more conditionals than remediations do —
   AEAD-vs-CBC alone (side 1: *"With CBC you must set both — a missing hash is a silent
   proposal mismatch"*) is a branch on every crypto object.
3. **`Presence` cannot be expressed in a template language without inventing one.**
   Four states, three outcomes, per field. `{% if pfs %}` collapses `Unknown` into `Absent`,
   which is exactly the bug schema §5.1 exists to prevent.
4. **A template cannot produce a `StatementPath`.** No path, no diff, no rollback, no
   subsumption. You would parse your own output to recover the structure you just had.

The honest cost of rejecting templates: adding a platform is a Rust change and a release,
not a corpus change. A network engineer who knows PAN-OS cannot add PAN-OS support without
a compiler. That is a real barrier and I am accepting it, because the alternative barrier —
a template author silently emitting a wrong line into someone's firewall — is worse. §16
OD-3 records the mitigation worth exploring.

**Why not a visitor.** A visitor with 40 `visit_*` methods and `N` platform
implementations is the same `40 × N` table as the registry, with three added problems: the
trait has to be rewritten every time a kind is added (breaking every platform at once); a
platform that does not emit a kind must still implement an empty method, so "does not
support this kind" and "forgot to implement this kind" are the same code; and the double
dispatch buys nothing, because the traversal order is fixed by the block table (§4.1), not
by the graph shape. A registry with `Option<&dyn KindEmitter>` makes the missing case
explicit and lets §9 report it.

### 6.2 The traits

```rust
/// Everything that is a property of the platform, not of a kind.
pub trait Platform: Send + Sync + 'static {
    fn id(&self) -> PlatformId;
    fn ordering(&self) -> OrderingRegime;
    fn flavour(&self) -> SyntaxFlavour;
    fn supports_subtree_retract(&self) -> bool;
    fn supports_deactivate(&self) -> bool;
    fn supports_paste_comments(&self) -> bool;

    /// Path -> the platform's assertion text, without the value.
    fn render_path(&self, p: &StatementPath) -> CompactString;
    /// The negation form for this path at this scope.
    fn render_retract(&self, p: &StatementPath, s: RetractScope) -> CompactString;
    /// Quoting and escaping for one identifier or value token.
    fn quote(&self, tok: &str, ctx: QuoteCtx) -> Cow<'_, str>;
    /// The placeholder token for a secret label (§10).
    fn placeholder(&self, label: SecretLabel, disc: Option<&str>) -> CompactString;

    /// The safety net that goes first (§18.5.5). `None` is a legitimate,
    /// reportable answer — PAN-OS has no commit-confirmed.
    fn guard(&self, o: &EmitOpts) -> GuardPolicy;
    fn commit(&self, o: &EmitOpts) -> SmallVec<[LineSpec; 2]>;

    fn emitter_for(&self, kind: KindId) -> Option<&'static dyn KindEmitter>;
}

/// One (platform, kind) pair's knowledge.
pub trait KindEmitter: Send + Sync + 'static {
    fn kind(&self) -> KindId;

    /// Static declaration of every field this emitter may read. Checked in
    /// CI against the schema: a field that no emitter on a platform reads
    /// is a coverage hole, reported by name (§9.5). This is the emitter's
    /// analogue of the rule engine's read-set (12 §5) and it exists for
    /// the same reason — so we can answer questions about the code without
    /// running it.
    fn reads(&self) -> &'static [FieldId];

    /// Concepts on this kind that this platform cannot express (§9).
    /// Declared, not discovered at runtime.
    fn gaps(&self) -> &'static [DeclaredGap];

    fn emit(&self, ctx: &mut EmitCtx<'_>, node: NodeRef<'_>) -> Result<(), EmitAbort>;
}
```

### 6.3 The builder that makes invariant 6 unforgettable

The single most important ergonomic decision in this document: **there is no way to push a
line without naming the fields that produced it.** Not a lint, not a code review
convention — a typestate.

```rust
pub struct LineBuilder<'c, P> { /* … */ _p: PhantomData<P> }
pub struct NoProv;
pub struct Prov;

impl<'c> EmitCtx<'c> {
    pub fn line(&mut self, phase: Phase) -> LineBuilder<'c, NoProv>;
}

impl<'c, P> LineBuilder<'c, P> {
    pub fn path(self, p: StatementPath) -> Self;
    pub fn value(self, v: impl IntoValueToken) -> Self;
    pub fn form(self, f: LineForm) -> Self;
    pub fn risk(self, r: Risk) -> Self;
    pub fn idempotency(self, i: Idempotency) -> Self;
    pub fn explain(self, k: ExplainKey) -> Self;
    pub fn order_hint(self, n: u32) -> Self;
    pub fn placeholder(self, label: SecretLabel) -> Self;

    /// The only transition into `Prov`.
    pub fn from(self, node: NodeId, field: FieldId, role: FieldRole)
        -> LineBuilder<'c, Prov>;

    /// Escape hatch for lines with genuinely no field behind them — a
    /// `commit`, a block separator. Takes a reason that goes in the
    /// provenance panel, so "no provenance" is itself provenance.
    pub fn structural(self, why: &'static str) -> LineBuilder<'c, Prov>;
}

impl<'c> LineBuilder<'c, Prov> {
    pub fn push(self) -> Result<LineId, EmitAbort>;
}
```

`push` exists only on `LineBuilder<Prov>`. A line with no `from` and no `structural` does
not compile. `LineBuilder` is `#[must_use]`, so a builder chain that is never pushed does
not silently vanish.

Usage, emitting the card's own `external-interface` line:

```rust
ctx.line(Phase::A)
   .path(path![sec, ike, gateway, Name(gw.name()?), "external-interface"])
   .value(unit.rendered_name()?)                 // "reth0.0" — schema §4.6, `raw` wins
   .from(gw.id(), F::IkeGateway_external_interface, FieldRole::Value)
   .from(unit.id(), F::LogicalUnit_unit,            FieldRole::Referenced)
   .risk(Risk::ChangesConfig)
   .idempotency(Idempotency::Idempotent)
   .explain(ExplainKey::field(K::IkeGateway, F::external_interface))
   .push()?;
```

The `explain` key resolves to the card's own sentence:

> *"`external-interface` is the WAN unit the IKE packets leave by, not `st0`. Wrong on a
> multi-homed box means Phase 1 sources from an address the peer has never heard of."*

### 6.4 `EmitCtx`

```rust
pub struct EmitCtx<'c> {
    pub graph: &'c Graph,
    pub plat: &'c dyn Platform,
    pub version: Option<&'c OsVersion>,   // drives version-conditional syntax
    pub opts: &'c EmitOpts,
    pub blocks: &'c BlockTable,
    cur_block: BlockId,
    out: Vec<EmittedLine>,
    report: EmitReport,
}

pub struct EmitOpts {
    pub explicit_defaults: bool,   // emit `Default(v)` values too
    pub include_guard: bool,       // §18.5.5
    pub include_verify: bool,
    pub annotate: Annotate,        // Off | Blocks | Lines
    pub wrap: WrapPolicy,          // §13
    pub scope: EmitScope,          // whole device | one node + closure | a diff
}
```

`EmitCtx` deliberately gives an emitter author no access to: the rule engine, the finding
set, the clipboard, the filesystem, time, or randomness. The absence of a clock is
load-bearing for invariant 9 — the same reason `fex` has no `now()` (rule engine §3.4).

### 6.5 Reading a field: the three-outcome API

```rust
impl NodeRef<'_> {
    /// `Set` or `Default` -> the value. `Absent` -> Ok(None).
    /// `Unknown` -> Err(EmitAbort::Blocked), which the pipeline converts
    /// into a positioned `Blocker` and continues with the next statement.
    /// `Conflicted` -> Err(EmitAbort::Conflicted).
    pub fn need<T: Scalar>(&self, f: FieldId) -> Result<T, EmitAbort>;

    /// Same, but `Unknown` is Ok(None): the statement is optional and its
    /// absence is not a hole in the config.
    pub fn opt<T: Scalar>(&self, f: FieldId) -> Result<Option<T>, EmitAbort>;

    /// Reads a value without emitting it. Used for `FieldRole::Conditioning`.
    pub fn peek<T: Scalar>(&self, f: FieldId) -> Presence<T>;
}
```

There is no `unwrap_or_default`. Schema §5.2 already removed `is_none` and `unwrap` from
`Presence`; the emitter API keeps that discipline, because a default supplied by the
emitter is a value the user never chose appearing in their firewall.

---

## 7. The emit pipeline

Five stages. Each is total; each has a report channel; none of them can produce a line
without provenance.

```
                       ┌───────────────────────────────────────────┐
graph, platform ──────▶│ 1. PLAN     select nodes, assign blocks    │
                       └───────────────┬───────────────────────────┘
                                       ▼
                       ┌───────────────────────────────────────────┐
                       │ 2. EMIT     KindEmitter::emit per node    │──▶ Blockers
                       │             (order irrelevant here)       │──▶ Gaps
                       └───────────────┬───────────────────────────┘
                                       ▼
                       ┌───────────────────────────────────────────┐
                       │ 3. RESOLVE  dedupe by path (§3.2),        │──▶ Conflicts
                       │             build deps (§5.7)             │
                       └───────────────┬───────────────────────────┘
                                       ▼
                       ┌───────────────────────────────────────────┐
                       │ 4. ORDER    canonical topo sort (§5.6)    │──▶ Cycles
                       └───────────────┬───────────────────────────┘
                                       ▼
                       ┌───────────────────────────────────────────┐
                       │ 5. RENDER   flavour, wrap, annotate (§13) │
                       └───────────────┬───────────────────────────┘
                                       ▼
                            EmitOutput { lines, blocks, report }
```

Stage 2 is deliberately order-independent — emitters may run in any order, which means they
may run in parallel if that ever matters, and it means an emitter author cannot accidentally
depend on a sibling having run first. All ordering is stage 4's job and stage 4's alone.

### 7.1 Stage 1 in detail

```
plan(graph, scope, blocks) -> Vec<(NodeId, BlockId)>:
    nodes = match scope:
        Device(d)  -> containment closure of d, in ULID order
        Node(n)    -> {n} ∪ reference closure of n, depth-limited to 4
        Diff(gd)   -> nodes touched by gd ∪ their reference closure, depth 2
    for n in nodes (ULID order):
        b = blocks.lookup(kind_of(n), domain_of(n))
             .unwrap_or(BlockId::MISC)
        yield (n, b)
```

Iteration is in **ULID order**, always, everywhere. Schema §14.3 (F7) already forbids
hash-map ordering leaking into emit; this is where that rule is actually applied. A
`HashMap` iteration anywhere in stages 1–4 is a determinism bug and CI catches it by
emitting twice in one process with a randomised hasher seed and comparing hashes.

### 7.2 `EmitOutput` — you cannot take the lines without the report

```rust
pub struct EmitOutput {
    lines: Vec<EmittedLine>,
    blocks: Vec<Block>,
    report: EmitReport,
}

impl EmitOutput {
    /// The ONLY accessor. There is no `fn lines(&self)`.
    pub fn parts(&self) -> (&[EmittedLine], &[Block], &EmitReport);

    /// Clipboard payload. Refuses when the report has unacknowledged
    /// blockers; always includes the gap and substitution manifests
    /// (§9.4, §10.4).
    pub fn to_clipboard(&self, m: ManifestPolicy) -> Result<String, ExportRefused>;
}
```

This is the API-level answer to "silently dropping is unacceptable". There is no code path
that hands a caller the config text without also handing it the list of things that are not
in the config text. It is a small thing and it is the difference between a documented
intention and an enforced one.

---

## 8. Vendor divergence

### 8.1 What is genuinely shared

| Shared | Where it lives |
|---|---|
| The graph | schema |
| The plan — which nodes, in what blocks | §7.1, block table is per (platform, domain) but the *selection* is not |
| `StatementPath` as a concept | §3; the token sequences differ, the type does not |
| `Risk` classification | The risk of a statement is a property of what it *does*, and disrupting a tunnel is disrupting a tunnel on every platform. Declared once per schema field, not once per platform. |
| Provenance, explain keys, rules applied | Corpus is keyed on schema kinds and fields, so one explainer serves four platforms |
| The ordering algorithm | §5.6. Only `Phase` semantics differ. |
| The round-trip laws | §11 |
| The placeholder convention | §10 |

### 8.2 What is not shared, and it is more than syntax

| Divergence | Example |
|---|---|
| **Object decomposition** | Junos: six objects. PAN-OS: four, with `ipsec proposal` and `ipsec policy` folded into one `ipsec-crypto-profile`. IOS IKEv2: proposal / policy / keyring / profile — a *different* four. |
| **Where a concept lives** | PFS is a field of the Junos `ipsec policy`, of the PAN-OS `ipsec-crypto-profile`, and of the IOS `ipsec profile`. Same field in the graph, three different owners. |
| **Ordering regime** | §5.2 |
| **Negation** | `delete <path>` / `delete <path>` / `no <command>`, and only two of the three support subtree retract |
| **Absence encoding** | The one that hurts: see §8.5 |
| **Ordered lists** | Junos policies within a zone pair are order-evaluated and reordered with `insert`. PAN-OS security rules are order-evaluated with `move`. IOS ACLs are order-evaluated with sequence numbers. Three mechanisms, one concept. |

### 8.3 One graph fragment, four renderings

The fragment is the card's side-1 example: `IKE-P1` / `IKE-POL` / `GW-B` / `IPSEC-P2` /
`IPSEC-POL` / `VPN-B`, bound to `st0.0`, peer `203.0.113.10`, local `198.51.100.5`,
selector `10.1.0.0/16 ↔ 10.2.0.0/16`.

**(a) `junos-srx`, `SyntaxFlavour::JunosSet`** — the card's own text, reproduced by the
emitter:

```
set security ike proposal IKE-P1 authentication-method pre-shared-keys
set security ike proposal IKE-P1 dh-group group14
set security ike proposal IKE-P1 authentication-algorithm sha-256
set security ike proposal IKE-P1 encryption-algorithm aes-256-cbc
set security ike proposal IKE-P1 lifetime-seconds 28800
set security ike policy IKE-POL proposals IKE-P1
set security ike policy IKE-POL pre-shared-key ascii-text "<PSK:SITE-B>"
set security ike gateway GW-B ike-policy IKE-POL
set security ike gateway GW-B address 203.0.113.10
set security ike gateway GW-B external-interface reth0.0
set security ike gateway GW-B version v2-only
set security ike gateway GW-B dead-peer-detection always-send interval 10 threshold 3
set security ipsec proposal IPSEC-P2 protocol esp
set security ipsec proposal IPSEC-P2 encryption-algorithm aes-256-gcm
set security ipsec proposal IPSEC-P2 lifetime-seconds 3600
set security ipsec policy IPSEC-POL perfect-forward-secrecy keys group14
set security ipsec policy IPSEC-POL proposals IPSEC-P2
set security ipsec vpn VPN-B ike gateway GW-B
set security ipsec vpn VPN-B ike ipsec-policy IPSEC-POL
set security ipsec vpn VPN-B bind-interface st0.0
set security ipsec vpn VPN-B establish-tunnels immediately
set security ipsec vpn VPN-B traffic-selector TS1 local-ip 10.1.0.0/16 remote-ip 10.2.0.0/16
```

Note what is *not* there: no `authentication-algorithm` on `IPSEC-P2`. That absence is
emitted by the `Conditioning` read of `EncryptionAlgorithm.aead` on `aes-256-gcm`
(schema §4.3), and clicking the block heading explains it in the card's words: *"GCM is
AEAD, so there is no separate authentication-algorithm. With CBC you must set both — a
missing hash is a silent proposal mismatch."*

**(b) `junos-srx`, `SyntaxFlavour::JunosBrace`** — same paths, different rendering:

```
security {
    ike {
        proposal IKE-P1 {
            authentication-method pre-shared-keys;
            dh-group group14;
            authentication-algorithm sha-256;
            encryption-algorithm aes-256-cbc;
            lifetime-seconds 28800;
        }
        policy IKE-POL {
            proposals IKE-P1;
            pre-shared-key ascii-text "<PSK:SITE-B>";
        }
        gateway GW-B {
            ike-policy IKE-POL;
            address 203.0.113.10;
            external-interface reth0.0;
            version v2-only;
            dead-peer-detection always-send interval 10 threshold 3;
        }
    }
    ipsec { /* … */ }
}
```

Algorithm: insert every `StatementPath` into a radix trie in path order; depth-first print;
an interior node prints `token {` … `}`, a leaf prints `token value;`. `O(Σ|tokens|)` time,
deterministic because the input order is deterministic. No second emitter, no second set of
knowledge — a pure function of the path set the `JunosSet` flavour already produced.

Three consequences that must be surfaced, not buried:

| | |
|---|---|
| **`Risk` moves from the line to the block.** A brace stanza is loaded and committed as a unit. Per-line risk labels are a lie in this flavour, so the renderer attaches risk to the block and greys the per-line legend. |
| **`Retract` has no representation.** There is no way to say "remove this" in a stanza dump. A change set containing retractions **cannot be rendered in brace form**, and the emitter returns `ExportRefused::FlavourCannotExpress { forms: [Retract] }` rather than producing a stanza that quietly omits the deletions. Omitting them would produce a file that, loaded with `load merge`, leaves the old configuration in place — the exact silent-drop failure this document exists to prevent. |
| **`load replace` is not offered from a partial graph.** `load replace` deletes anything in the stanza that the loaded text does not contain. From a graph populated by hand, that is everything you did not model. Gated behind full-parse provenance on every node in the stanza; see §18.3.7. |

**(c) `panos`, `SyntaxFlavour::PanosSet`:**

```
set network ike crypto-profiles ike-crypto-profiles IKE-P1 dh-group group14
set network ike crypto-profiles ike-crypto-profiles IKE-P1 hash sha256
set network ike crypto-profiles ike-crypto-profiles IKE-P1 encryption aes-256-cbc
set network ike crypto-profiles ike-crypto-profiles IKE-P1 lifetime seconds 28800
set network ike gateway GW-B protocol version ikev2
set network ike gateway GW-B protocol ikev2 ike-crypto-profile IKE-P1
set network ike gateway GW-B protocol ikev2 dpd enable yes
set network ike gateway GW-B authentication pre-shared-key key "<PSK:SITE-B>"
set network ike gateway GW-B local-address interface ethernet1/1
set network ike gateway GW-B peer-address ip 203.0.113.10
set network ike crypto-profiles ipsec-crypto-profiles IPSEC-P2 esp encryption aes-256-gcm
set network ike crypto-profiles ipsec-crypto-profiles IPSEC-P2 esp authentication none
set network ike crypto-profiles ipsec-crypto-profiles IPSEC-P2 dh-group group14
set network ike crypto-profiles ipsec-crypto-profiles IPSEC-P2 lifetime seconds 3600
set network tunnel ipsec VPN-B auto-key ike-gateway GW-B
set network tunnel ipsec VPN-B auto-key ipsec-crypto-profile IPSEC-P2
set network tunnel ipsec VPN-B tunnel-interface tunnel.1
set network tunnel ipsec VPN-B auto-key proxy-id TS1 local 10.1.0.0/16 remote 10.2.0.0/16
```

Structural notes the emitter records as `Composed` mappings:

- Junos `ipsec proposal` **and** `ipsec policy` both map into the single PAN-OS
  `ipsec-crypto-profiles` object. Two graph nodes, one platform object. `IpsecPolicy` and
  `IpsecProposal` emitters must therefore agree on the target object name, which is derived
  from the `IpsecProposal` name by rule, and the derivation is recorded in the report so the
  user is told that `IPSEC-POL` has no counterpart on the box.
- PFS is `dh-group` on the `ipsec-crypto-profile`, not a separate `perfect-forward-secrecy`
  statement.
- Junos `dead-peer-detection always-send interval 10 threshold 3` maps to PAN-OS DPD /
  liveness-check settings whose parameter set is not the same shape.
  <!-- VERIFY: the exact PAN-OS CLI paths for IKEv2 liveness check interval and for IKEv1 DPD interval/retry, and whether a "threshold"/retry count exists in both. If PAN-OS has no threshold equivalent, this becomes an `Approximated` gap with the interval preserved and the threshold reported as dropped. -->

**(d) `ios-xe`, `SyntaxFlavour::IosCli`** — route-based, so a VTI:

```
crypto ikev2 proposal IKE-P1
 encryption aes-cbc-256
 integrity sha256
 group 14
crypto ikev2 policy IKE-POL
 proposal IKE-P1
crypto ikev2 keyring KR-GW-B
 peer GW-B
  address 203.0.113.10
  pre-shared-key <PSK:SITE-B>
crypto ikev2 profile GW-B
 match identity remote address 203.0.113.10 255.255.255.255
 identity local address 198.51.100.5
 authentication remote pre-share
 authentication local pre-share
 keyring local KR-GW-B
 dpd 10 3 periodic
crypto ipsec transform-set IPSEC-P2 esp-gcm 256
 mode tunnel
crypto ipsec profile IPSEC-POL
 set transform-set IPSEC-P2
 set pfs group14
 set ikev2-profile GW-B
interface Tunnel0
 ip address 10.255.0.1 255.255.255.252
 tunnel source GigabitEthernet0/0
 tunnel mode ipsec ipv4
 tunnel destination 203.0.113.10
 tunnel protection ipsec profile IPSEC-POL
ip route 10.2.0.0 255.255.0.0 Tunnel0
```

<!-- VERIFY: `esp-gcm 256` transform-set syntax, `dpd <interval> <retries> periodic` argument order, and the availability of `crypto ikev2 keyring` peer-block syntax on the specific IOS-XE train the workspace targets. These differ across trains and the version predicate must gate them. -->

Note that IOS is the platform where §5's ordering is load-bearing: `set transform-set
IPSEC-P2` is rejected outright if `crypto ipsec transform-set IPSEC-P2` has not been entered
first. The dependency edge that guarantees this is generated by the `Reference` edge
`IpsecPolicy --UsesProposal--> IpsecProposal` in the graph — the same edge that on Junos
produces no ordering requirement at all.

### 8.4 Divergence summary

| Concept | `junos-srx` | `panos` | `ios-xe` |
|---|---|---|---|
| P1 algorithms | `ike proposal` | `ike-crypto-profiles` | `crypto ikev2 proposal` |
| P1 auth material | `ike policy … pre-shared-key` | on the gateway | `crypto ikev2 keyring` |
| P1 peer | `ike gateway` | `ike gateway` | `crypto ikev2 profile` + keyring peer |
| P2 algorithms | `ipsec proposal` | `ipsec-crypto-profiles` | `crypto ipsec transform-set` |
| P2 PFS | `ipsec policy … perfect-forward-secrecy keys` | `ipsec-crypto-profiles … dh-group` | `crypto ipsec profile … set pfs` |
| The tunnel | `ipsec vpn` + `st0.N` | `tunnel ipsec` + `tunnel.N` | `interface TunnelN` + `tunnel protection` |
| Selectors | `traffic-selector` (many) | `proxy-id` (many) | VTI negotiates any↔any |
| Zones | `security-zone`, `host-inbound-traffic` | zones, interface management profiles | none, unless ZBF is configured |
| PFS off | statement **absent** | `dh-group no-pfs` | `no set pfs` |

### 8.5 The absence-encoding trap

The last row of that table is the single most instructive divergence in this document.

On Junos, "no PFS" is the *absence* of a statement. On PAN-OS, "no PFS" is the *presence* of
`dh-group no-pfs` — Palo Alto's documentation describes `no-pfs` as the explicit selection
that makes the firewall reuse the Phase 1 key for the IPsec SA negotiation.

Under schema §5.2's four states, that means:

| Graph state of `IpsecPolicy.perfect_forward_secrecy` | Junos emits | PAN-OS emits |
|---|---|---|
| `Set(Modp2048)` | `perfect-forward-secrecy keys group14` | `dh-group group14` |
| `Absent` (parsed config, no statement) | nothing | **`dh-group no-pfs`** |
| `Default(v)` | nothing unless `--explicit-defaults` | the platform's own default — which is *not* `no-pfs`, so this row needs a per-platform default table entry and cannot be shared |
| `Unknown` | **Blocker** | **Blocker** |

Two things follow.

1. **`Absent` must be emittable.** A four-state `Presence` that only distinguishes states
   for the benefit of rules would collapse `Absent` and `Unknown` at the emitter boundary
   and produce a PAN-OS config with PFS silently on by default when the graph says it is
   off. The four states are load-bearing in the emitter, not only in the linter.
2. **A cross-platform migration is not a text transform.** Emitting a Junos-derived graph as
   PAN-OS *adds* a statement that had no counterpart. The report records it as
   `Representability::Composed`, with the note: *the source configuration expressed this by
   omission; this platform requires it to be stated.* An engineer reviewing the PAN-OS
   output and looking for a corresponding Junos line will not find one, and needs to be told
   why before they delete it.

---

## 9. Representability, and never dropping silently

### 9.1 The classification

Declared per `(platform, kind, field)` in the corpus, with a citation and a reviewer.

```rust
pub enum Representability {
    /// The platform has a statement that means exactly this.
    Exact,
    /// The platform has something close. The differences are enumerated
    /// prose, authored, not generated.
    Approximated { note: ExplainKey, loses: &'static [&'static str] },
    /// One graph concept becomes several platform statements, or several
    /// become one. Correct, but the shapes do not correspond.
    Composed { note: ExplainKey },
    /// The platform cannot express this at all.
    Unrepresentable { gap: GapKind, note: ExplainKey },
}

pub enum GapKind {
    /// The platform has no such feature.
    NoFeature,
    /// The platform has the feature but only via a mechanism outside the
    /// scope Fathom models (an external ACL, a management profile).
    OutsideModel,
    /// Fathom has not built the emitter for it yet. Distinguished from
    /// NoFeature because one is a vendor fact and the other is our backlog,
    /// and conflating them makes the product look worse than it is and the
    /// vendor look better.
    NotYetBuilt { tracking: &'static str },
}
```

### 9.2 The gap table for the IPsec domain

| Concept | `panos` | `ios-xe` | Note |
|---|---|---|---|
| `IpsecPolicy` as a distinct object | `Composed` | `Composed` | folds into the crypto profile / ipsec profile |
| `perfect_forward_secrecy = Absent` | `Composed` | `Exact` | §8.5 |
| `establish_tunnels = responder_only` | `Approximated` | `Approximated` | <!-- VERIFY: PAN-OS IKE gateway passive mode semantics vs Junos responder-only; and whether IOS-XE has any per-tunnel equivalent short of `crypto ikev2 profile` initiate suppression. --> |
| Multiple `TrafficSelector`s | `Exact` (proxy-id) | `Unrepresentable { NoFeature }` | A VTI negotiates `0.0.0.0/0 ↔ 0.0.0.0/0`. The card's own trap on side 4 — *"Default selector is 0.0.0.0/0. Peers that build one SA per subnet pair reject it outright"* — is the same fact from the other direction. Moving a multi-selector Junos VPN to an IOS VTI silently changes what is negotiated, and that is exactly what must not be silent. |
| `Zone` + `host_inbound_services: [ike]` | `Approximated` | `Unrepresentable { OutsideModel }` | On IOS, whether IKE reaches the box depends on an interface ACL or a ZBF policy that Fathom did not model. The report says: *"this platform has no equivalent statement. If an inbound ACL exists on the WAN interface it must permit UDP 500 and 4500 and IP protocol 50. Fathom cannot see it."* Which is the card's most-missed item #3, restated honestly for a platform where we cannot check it. |
| `RedundancyGroup` / `reth` | `Unrepresentable { NoFeature }` | `Unrepresentable { NoFeature }` | Owner brief §2.1: a `reth` is not a LAG. It is also not anything on the other two platforms. |
| `deactivate` | `Unrepresentable { NoFeature }` | `Unrepresentable { NoFeature }` | §2.4 |
| `lifetime_kilobytes` | `Exact` | `Exact` | |
| `df_bit` | <!-- VERIFY --> | `Exact` (`crypto ipsec df-bit clear`) | |

### 9.3 Where a gap surfaces

A gap is reported **in position**, in the block where the statement would have been, in the
same visual grammar as a note — the 4px accent bar and wash from the design language, using
the *neutral* hairline colour, never one of the three risk colours. It is not a fourth risk
level and it must not read as one.

```
  ▌ NOT EMITTED — traffic-selector TS1
    ios-xe has no per-tunnel selector on a VTI. This tunnel will negotiate
    0.0.0.0/0 ↔ 0.0.0.0/0. A peer that builds one SA per subnet pair will
    reject it. Modelled selector: 10.1.0.0/16 ↔ 10.2.0.0/16.
```

### 9.4 Where a gap cannot be escaped

Four places, and all four are enforced by types rather than by convention:

| Surface | Enforcement |
|---|---|
| The config panel | `EmitOutput::parts` returns the report alongside the lines; there is no accessor for lines alone (§7.2). |
| The clipboard | `to_clipboard` takes a `ManifestPolicy` and the only two variants are `Inline` (gaps as comments where the platform accepts them) and `Appended` (a trailing `# NOT EMITTED` block). There is no `Omit`. |
| The change ticket | §18.6 makes `NOT EMITTED` a mandatory section. A ticket with unreported gaps does not serialise. |
| The findings panel | Each `Unrepresentable` gap raises a synthetic entry sourced from the emitter, not from a rule pack, marked as such. It is not a finding — it has no `acceptable_when` and no rule id — so it lives in the separate *unprovable* store the rule engine already defines (12 §8.3) rather than pretending to be a finding. |

### 9.5 The coverage check

`KindEmitter::reads()` is static. So is the schema. Therefore:

```
for plat in platforms:
    for kind in schema.kinds:
        match plat.emitter_for(kind):
            None    -> if kind is in-scope for plat's domains: COVERAGE HOLE
            Some(e) -> for f in schema.fields(kind):
                           if f not in e.reads() and f not in e.gaps():
                               COVERAGE HOLE (kind, field, plat)
```

Run in CI. A coverage hole is a build failure with a named field, not a warning. The
mechanism costs one static array per emitter and it converts "we forgot to emit
`lifetime-kilobytes`" from a bug a customer finds into a build error a developer finds.

The honest limitation: `reads()` is hand-maintained and can be wrong in the safe direction
(claiming to read a field you do not). A proc-macro that derives `reads()` from the body of
`emit` would close that, at the cost of a proc-macro. §16 OD-4.

---

## 10. Placeholders

Invariant 3: the application never accepts a credential. §6.2 of the owner brief:

> *"There is no reason a config builder needs the actual pre-shared key. Emit
> `pre-shared-key ascii-text "<PSK>"` and let the engineer paste the real value into their
> terminal."*

### 10.1 The convention

```
placeholder    ::= "<" LABEL [ ":" DISCRIMINATOR ] ">"
LABEL          ::= [A-Z][A-Z0-9-]{1,23}
DISCRIMINATOR  ::= [A-Z0-9][A-Z0-9-]{0,31}
```

| Label | Used for |
|---|---|
| `PSK` | pre-shared keys |
| `CERT-KEY` | private key material |
| `SNMP-COMMUNITY` | |
| `TACACS-KEY`, `RADIUS-KEY` | |
| `PASSWORD` | local user passwords |
| `API-KEY` | |

The discriminator is derived from the `SecretPlaceholder`'s label plus the peer or object
name — `<PSK:SITE-B>` — so that a config with three tunnels does not present three
identical `<PSK>` tokens. It is derived from graph data that is already in the config, so
it leaks nothing that the surrounding line does not.

`SecretHint` (schema §4.5) — the free-text pointer such as `vault: net/ipsec/site-b` — is
**never** emitted into the config text. It appears only in the substitution manifest
(§10.4). Putting it in the line would put a user-controlled string into a firewall config
and into every ticket and paste downstream, and schema §4.5 already names the hint as the
place where something sensitive will eventually end up.

### 10.2 Why angle brackets, and the honest limit

Angle brackets are chosen because no platform's identifier charset includes them, so a
placeholder can never be mistaken for a legal object name, and a paste that reaches a device
in the wrong position produces a syntax error rather than a wrong configuration.

**That argument does not hold inside a quoted string, and that is the failure mode.**

```
set security ike policy IKE-POL pre-shared-key ascii-text "<PSK:SITE-B>"
```

Junos accepts this. It sets the pre-shared key to the literal eleven-character string
`<PSK:SITE-B>` and commits without complaint. Phase 1 then fails, and the card's own error
decoder says what that looks like:

> `AUTHENTICATION_FAILED` → *PSK, cert chain, clock skew — or identity.*

> *"A mismatch reads as `peer's IKE-ID validation failed` or a bare `AUTHENTICATION_FAILED`
> — easily misread as a wrong pre-shared key. Check identity before you re-type the PSK."*

So an unsubstituted placeholder produces a symptom the card explicitly warns is misdiagnosed
in the other direction. There is no emitted form that shows the shape of the statement and
also refuses to commit on every platform. I am not going to pretend otherwise.

### 10.3 What we do instead — four layers, none of which is "type your key here"

**We never offer substitution in the application.** A substitution field is a credential
field, and invariant 3 has no "but only in memory" clause. Instead:

1. **Rendering.** The placeholder span renders as inverted ink — `#FFFFFF` on `#14171A`,
   mono, letterspaced — a treatment used for nothing else in the product. It is deliberately
   neutral: the three risk colours mean three specific things (design language) and a
   placeholder is not a fourth.
2. **Counting.** The block header carries a margin tab in the card's voice:
   `2 values you must supply`. Lowercase, unpunctuated.
3. **Manifest.** Every export carries the substitution manifest (§10.4). It is not
   suppressible.
4. **The ladder knows.** This is the structural one, and it is why §18 and this document are
   one design. When a change set contains a placeholder, the verification ladder generated
   for that change gets an extra failure branch injected at the Phase 1 step:

   ```
   2  show security ike security-associations
      want: an SA to 203.0.113.10, State UP
      if AUTHENTICATION_FAILED:
        ▸ FIRST: did you substitute <PSK:SITE-B>? An unsubstituted
          placeholder commits cleanly and fails exactly like a wrong key.
        ▸ then: identity — local-identity / remote-identity (card, side 2)
        ▸ then: clock skew (card, side 4 — "clock skew kills certificates")
   ```

   That branch is inserted by the emitter's report feeding `verify(diff(graph))`, not
   authored per-tunnel. It is a direct dividend of `placeholders` being a field on
   `EmittedLine` rather than a string convention.

```rust
pub struct PlaceholderSpan {
    /// Byte range within `EmittedLine.text`.
    pub range: Range<u32>,
    pub label: SecretLabel,
    pub discriminator: Option<CompactString>,
    /// The node/field whose `SecretPlaceholder` produced this.
    pub site: FieldRef,
    /// Rendered only in the manifest, never in `text`.
    pub hint: Option<SecretHint>,
}
```

### 10.4 The substitution manifest

```
SUBSTITUTIONS REQUIRED — 2

  <PSK:SITE-B>        line 7    pre-shared key for GW-B (peer 203.0.113.10)
                                hint: vault: net/ipsec/site-b
  <PSK:SITE-C>        line 19   pre-shared key for GW-C (peer 203.0.113.20)
                                hint: —

  Fathom does not hold these values and never will. Substitute them in your
  terminal, not in a file. An unsubstituted placeholder commits cleanly and
  fails Phase 1 as AUTHENTICATION_FAILED.
```

### 10.5 The paste guard

`to_clipboard` classifies the payload:

| Payload contains | Behaviour |
|---|---|
| No placeholders | copy |
| Placeholders, `ManifestPolicy::Inline`, platform accepts paste comments | copy, with a leading comment line per placeholder |
| Placeholders, platform does **not** accept paste comments | copy, and the UI states the count in the confirmation. No comment is injected, because a comment the CLI does not understand is a syntax error in the middle of a paste, which is worse than the thing it warns about. <!-- VERIFY: whether the Junos CLI's `load set terminal` path tolerates `#`-prefixed lines. If it does, Junos moves into the row above. --> |

---

## 11. Round-tripping

### 11.1 The property, stated precisely

The naive statement — "emit then parse then emit gives you back what you started with" — is
false and it is important to say why, because someone will test the false version and then
weaken the true one to make it pass.

`parse(emit(g)) ≠ g`, always, and correctly:

| What changes | Why it is right |
|---|---|
| Provenance | `Origin::Entered` becomes `Origin::Parsed`. That is the truth about the second graph. |
| `Default(v)` → `Absent` | We did not emit the default; the parser correctly observes a config with no such statement. Schema §5.3 then re-applies the default at read time from the corpus, so the *effective* value agrees while the state does not. |
| `Unknown` → `Absent` | Same mechanism, opposite meaning, and this one is lossy: a field we did not know becomes a field we know is not configured. This is real information loss and it is the reason §18.5.3 refuses to invert a change whose base was `Unknown`. |
| Node IDs | Fresh ULIDs. Reconciliation by natural key (rule engine §11.4) is what restores identity, and it is a separate operation with a user confirmation step. |

So the property is about **text**, not graphs.

> **E1 — emit is a fixed point through parse.**
> For all graphs `g` and platforms `p` where `emit(g, p)` has no blockers:
> ```
> render(emit(parse(render(emit(g, p)), p), p)) == render(emit(g, p))
> ```
> and the two `EmitReport`s agree on gaps and substitutions.

Equivalently: the first emit may lose things; the second must lose nothing further. If
`emit ∘ parse` is not idempotent on emitted text, then the paste-in / edit / paste-out
workflow of owner brief §6.3 drifts, and it drifts *silently*, once per round.

Three supporting properties:

> **E2 — parse normalises, it does not rewrite.** For every config line `t` in the corpus
> fixture set, `render(emit(parse(t)))` differs from `t` only by the platform's declared
> normalisation. This is schema §4.2's law L2 lifted from scalars to whole lines.

> **E3 — emit is deterministic.** Two emits of the same graph, in the same process and in
> fresh processes with a randomised hasher seed, produce byte-identical output and identical
> `LineId`s. Invariant 9.

> **E4 — order is stable under unrelated edits.** Changing a field on node `X` does not
> change the relative order of any two lines that do not source from `X`. Falls out of §5.6:
> `key` depends only on `(phase, block rank, block, order_hint, path)`, none of which a
> value change touches.

### 11.2 The test

```rust
proptest! {
    #![proptest_config(ProptestConfig { cases: 4096, .. Default::default() })]

    #[test]
    fn e1_emit_is_a_fixed_point_through_parse(
        g in arb_graph(Domain::IpsecSiteToSite),
        p in arb_platform(),
    ) {
        let a = emit(&g, p);
        prop_assume!(a.report().blockers.is_empty());
        let g2 = parse(&render(&a), p).expect("our own output must parse");
        let b  = emit(&g2, p);
        prop_assert_eq!(render(&a), render(&b));
        prop_assert_eq!(a.report().gaps, b.report().gaps);
        prop_assert_eq!(a.report().substitutions, b.report().substitutions);
    }
}
```

**The generator is the hard part and it is where this test is usually got wrong.**
`arb_graph` must not build `Graph` structs directly, because a shrunk struct is almost
always schema-invalid, and a failing case that does not satisfy the schema's own invariants
tells you nothing. It builds through the graph store's write API:

```rust
fn arb_graph(d: Domain) -> impl Strategy<Value = Graph> {
    // A vector of *operations*, not a vector of nodes. Shrinking removes
    // operations, and the store rejects an operation that would break an
    // invariant, so every shrunk value is a valid graph by construction.
    prop::collection::vec(arb_graph_op(d), 1..60)
        .prop_map(|ops| {
            let mut g = Graph::new();
            for op in ops { let _ = g.apply(op); }   // rejected ops are skipped
            g
        })
}
```

Weighting matters as much as shape. A uniform generator produces mostly `Unknown` fields and
therefore mostly blocked emits, and `prop_assume!` throws them away — you get 4,096 cases
and 200 real ones. The generator biases toward completeness: 70% of fields on a node touched
by an op get a value, and one in eight graphs is a "full build" seeded from the field card's
own object chain.

### 11.3 The fixture suite, which is worth more than the property test

Schema §4.2 already establishes the rule and it applies verbatim here: **every config line
on all four sides of the field card is a fixture.** Each is parsed, the resulting graph is
emitted, and the output must match the source byte-for-byte after declared normalisation.

That is 47 configuration lines from the card, plus the operational commands, plus every
`remediation.lines` block in every shipped rule pack, plus every counterexample E1 has ever
found (frozen on discovery — a proptest failure that is not frozen as a fixture will
reappear).

When a parser or emitter regresses, the field card breaks the build. That is the correct
relationship between the printed reference and the tool.

### 11.4 What E1 cannot catch

Stated so nobody believes the property is stronger than it is:

- **Emitting the wrong thing consistently.** If the emitter writes `dh-group group2` where
  it should write `group14`, and the parser reads it back as `group2`, E1 passes. Only the
  fixture suite and the rule engine catch semantic wrongness.
- **Gaps in both directions.** A concept neither emitted nor parsed is invisible to E1.
  §9.5's coverage check is what covers that.
- **Anything about the device.** E1 is a statement about Fathom, not about Junos. Invariant
  2 means we never find out what the box thought.

---

## 12. Line-level explanation

Owner brief §4.1: *"click any line of config to learn what it does"* is a consequence of the
architecture rather than a maintained feature. Here is the consequence, end to end.

### 12.1 The path

```
  user clicks a token in a rendered line
            │
            ▼
  (1)  DOM data-line-id  ──▶  LineId
            │                     O(1)
            ▼
  (2)  LineIndex: HashMap<LineId, &EmittedLine>
            │
            ├── token offset within `text` ──▶ the FieldRef whose span covers it
            │                                  (source_fields carry token ranges)
            ▼
  (3)  FieldRef { node, field, role }
            │
            ├─▶ role == Referenced ?  offer "go to <object>" as the primary action
            │
            ▼
  (4)  ExplainKey resolution ladder — first hit wins
            │
            ▼
  (5)  corpus entry, rendered at the active Depth
            │
            ▼
  (6)  attachments: provenance, rules_applied, risk legend, verify commands
```

### 12.2 Step 4 — the resolution ladder

Tried in order. **Nothing is generated. If the ladder falls through, the panel says so.**

| # | Key | Example | Content |
|---|---|---|---|
| 1 | `explain:line:<platform>/<path template>` | `explain:line:junos-srx/security.ike.gateway.*.external-interface` | The most specific: prose about *this statement on this platform*. This is where the card's *"`external-interface` is the WAN unit the IKE packets leave by, not `st0`"* lives. |
| 2 | `explain:field:<Kind>.<field>` | `explain:field:IkeGateway.external_interface` | Platform-neutral: what the field means in the graph. Conventions, *Identifiers*. |
| 3 | `explain:kind:<Kind>` | `explain:kind:IkeGateway` | What the object is and what owns which knob. The card's `THE OBJECT CHAIN` section is exactly this corpus. |
| 4 | *(fall through)* | | Structural facts only: kind, object name, field name, value, provenance, and a one-click "no explainer yet — file a corpus gap". |

Rule explainers are **appended**, never substituted:

```
for r in line.rules_applied:
    append explain:rule:<r>            # the why / symptom_if_mismatched / acceptable_when
```

So a line that a rule touched shows both what the statement does and why a rule wanted it.
`ipsec.pfs.absent`'s `symptom_if_mismatched` — *"PFS on one side and absent on the other
fails Phase 2 while Phase 1 stays up"* — appears under the PFS line, next to the explanation
of what the PFS line is.

The `Conditioning` role has its own entry point, because the question it answers is about a
line that **is not there**:

| Key | Trigger |
|---|---|
| `explain:absence:<Kind>.<field>@<condition>` | Clicking the block heading when a `Conditioning` field suppressed a statement. `explain:absence:IpsecProposal.authentication_algorithm@aead` renders the card's *"GCM is AEAD, so there is no separate authentication-algorithm."* |

### 12.3 Step 5 — depth

Three depths, owner brief §5.4, toggled globally and per block. The per-block toggle is
rendered as a margin tab, not a control (design language, *devices worth stealing*, item 1):

```
                                                     terse · explained · teaching
▌ PHASE 1 — PROPOSAL, POLICY, GATEWAY
```

Depth selects a *field of the same corpus entry*, never a different entry and never a
summarisation pass:

```yaml
id: explain:line:junos-srx/security.ike.gateway.*.external-interface
reviewed_by: <named human>
terse: "The WAN unit IKE sources from. Not st0."
explained: >
  external-interface is the WAN unit the IKE packets leave by, not st0.
  IKE and ESP travel over the underlay to the peer's public address; st0
  carries the traffic that has already been encrypted.
teaching: >
  external-interface is the WAN unit the IKE packets leave by, not st0.
  Wrong on a multi-homed box means Phase 1 sources from an address the peer
  has never heard of — and the peer, quite correctly, ignores it. You then
  see a Phase 1 timeout with nothing useful in the local log, because
  nothing is wrong locally. The tell is on the peer: it never saw a packet
  from the address it is expecting.
sources: []
```

Three densities, one corpus, one reviewer. Invariant 10.

### 12.4 Step 6 — the attachments

| Attachment | Source |
|---|---|
| Provenance | `graph.provenance(field_ref)` — *"parsed from `srx-a.set` line 47, 2026-03-14"* or *"entered 2026-07-14"*. Schema §8. |
| Rules applied | `line.rules_applied` → the finding, with its witness (rule engine §10.3). |
| Risk | `line.risk` → the three-value legend, with the card's own wording. |
| Verify | The command corpus entries whose `intent` covers this statement, interpolated with workspace context: `show security ike security-associations 203.0.113.10 detail`. Owner brief §6.1's context awareness, reached from a config line instead of from search. |
| Rollback | `line.reversibility`, rendered as the inverse line or as the reason there is none (§18.5). |

### 12.5 The same machinery backwards

Owner brief §6.3: paste a config someone else wrote, get an annotated walkthrough. That is
the same table entered from a different key:

```
pasted text ──▶ parse ──▶ StatementPath per line ──▶ ladder step 1 key
                                                     (identical from here)
```

No second corpus, no second resolution path. The only difference is that a pasted line has
no `LineId` from an emit, so the index is keyed on path directly. This is why `path` and not
`text` is the structural field on `EmittedLine`.

### 12.6 Budget

| Step | Cost |
|---|---|
| 1–2 | one hash lookup |
| 3 | binary search over ≤ 4 spans |
| 4 | ≤ 4 hash lookups against the corpus index |
| 5 | render a pre-parsed markdown-subset AST |
| 6 | ≤ 6 index lookups |

Target: under 1 ms, well inside a frame. No I/O, no decompression on the hot path (the
corpus index is resident; entry bodies are lazily decompressed and cached). Nothing here
touches a model at runtime — owner brief §6.1 and invariant 9 both forbid it, and the
design-language note is the reason: this voice *"is not reliably achievable by a language
model improvising at runtime."*

---

## 13. Wrapping, rendering and the clipboard

### 13.1 The card's convention

Design language, *devices worth stealing*, item 5:

> **Continuation backslashes preserved.** `set security ike proposal IKE-P1 \` — commands
> wrap the way they wrap in a terminal, not the way they wrap in a webpage. Emitted config
> must do the same.

### 13.2 The problem with obeying it literally

I cannot confirm that the Junos CLI accepts backslash continuation on a pasted `set` line or
through `load set terminal`. The card is a *printed* artifact and the backslash is a print
convention there. If it is not accepted on paste, emitting wrapped lines into the clipboard
produces a broken paste — the worst possible outcome for a tool whose entire output channel
is copy-paste.

<!-- VERIFY: paste `set security ike proposal IKE-P1 \` + newline + `  dh-group group14` into a Junos CLI in configuration mode, and separately through `load set terminal`. Record the result per Junos train. Do the same for PAN-OS and IOS-XE. Until this is recorded with a version, WrapPolicy::default() stays Display. -->

### 13.3 DECISION — wrapping is a rendering property, never a line property

`EmittedLine.text` is one logical line with no newlines and no backslashes. Wrapping is
applied by the renderer.

```rust
pub enum WrapPolicy {
    /// Display wraps at the column; the clipboard payload does not.
    /// The default, and the safe one.
    Display { cols: u16 },
    /// Both display and clipboard carry `\` continuations. Opt-in, with a
    /// one-time confirmation naming the platform and stating that the
    /// paste path must be verified on the target box.
    Clipboard { cols: u16 },
    /// Never wrap.
    Off,
}
```

Default: `Display { cols: 72 }`.

Wrap rules, when wrapping:

| | |
|---|---|
| Break points | Only between complete argument groups, as declared by the statement table. `dead-peer-detection` / `always-send interval 10 threshold 3` is one break point; `interval` / `10` is not. |
| Never break | Inside a quoted string, inside an address or prefix, inside a placeholder, between a keyword and its single argument. |
| Continuation indent | Two spaces, matching the card. |
| Diff and hash | Operate on logical lines. Wrap points are never diffed and never contribute to `LineId` or to E1/E3. |

### 13.4 `SyntaxFlavour`

```rust
pub enum SyntaxFlavour {
    JunosSet,     // `set …` / `delete …` / `deactivate …`
    JunosBrace,   // stanza form; Assert only (§8.3b)
    PanosSet,     // `set …` / `delete …`
    IosCli,       // mode-nested; `no …`
}
```

`JunosBrace` and `IosCli` both need *indentation state*, which is derived from the path trie
at render time, not carried on the line. That keeps `EmittedLine` flavour-independent: one
emit, four renderings, and the diff in §18 works identically for all of them because it
operates on paths.

---

## 14. Complexity, memory and budget

### 14.1 Time

| Stage | Complexity | `V` = lines, `N` = nodes |
|---|---|---|
| 1 plan | `O(N log N)` | ULID sort of the closure |
| 2 emit | `O(Σ fields)` = `O(V)` | one pass per node, no traversal inside emitters |
| 3 resolve | `O(V log V)` | the path sort for dedupe (§3.2) |
| 4 order | `O(V log V)` | §5.6 |
| 5 render | `O(Σ\|text\|)` | |
| **total** | **`O(V log V)`** | |

### 14.2 Memory

`EmittedLine` is roughly:

| Field | Bytes |
|---|---|
| `id` | 16 |
| `text` (`CompactString`, inline ≤ 24) | 24, spilling for long lines |
| `path` (8 inline tokens) | ~200 |
| `source_node` | 16 |
| `source_fields` (4 inline × 24) | 96 |
| `rules_applied` (2 inline × 8) | 16 |
| everything else | ~40 |
| **≈** | **~410 bytes/line** |

The `path` dominates and it is the thing to attack if the WASM budget (schema F9) bites.
Two mitigations, neither implemented until measured: intern `PathToken::Kw` to a `u16` into
a static keyword table (drops ~120 bytes/line), and store the path prefix once per block
with lines carrying only the tail.

For a device with 40 tunnels the emitted config is on the order of 1,200 lines ≈ 0.5 MB
including paths. For a 40-device workspace emit, ~6,000 lines ≈ 2.5 MB. Acceptable in a
browser tab; not acceptable if we ever hold every device's emit simultaneously, so
`EmitOutput` is computed per view and dropped, not cached across devices.

### 14.3 Latency target

Emit runs on demand, not per keystroke — the config panel re-emits on graph settle (rule
engine §2.3's 400 ms settle, reused). Target: under 16 ms for a single-device emit, which
`O(V log V)` at `V ≈ 1,200` clears by a wide margin. The rule engine's per-keystroke budget
does not apply because emit is not on the typing path.

---

## 15. Failure modes of the emitter itself

| # | Failure | Symptom | Defence |
|---|---|---|---|
| 1 | An emitter reads a field its `reads()` does not declare | Coverage check passes while the field is undocumented; a schema change silently breaks emit | Debug-build assertion inside `NodeRef::need`/`opt` against the current emitter's declared set. Release builds skip it. §16 OD-4 would remove the gap entirely. |
| 2 | Two emitters produce the same path with different text | Ambiguous config | `EmitConflict`, emit blocked (§3.2). Loud by construction. |
| 3 | Dependency cycle | No valid order | `EmitCycle`, lines emitted in `key` order with an explicit banner. Never silently arbitrary. |
| 4 | A `Blocker` rendered somewhere the user does not look | A config that is missing a line and looks complete | Blockers render *in position*, and `to_clipboard` refuses while unacknowledged blockers exist. |
| 5 | A gap dropped on the export path | A concept silently absent from a config the user believes is complete | §9.4 — no accessor returns lines without the report; no `ManifestPolicy::Omit` exists. |
| 6 | Placeholder pasted unsubstituted | Commits cleanly, Phase 1 fails as `AUTHENTICATION_FAILED`, misdiagnosed as a wrong key | §10.3 — the ladder's first failure branch names it. This is mitigation, not prevention; prevention is impossible (§10.2). |
| 7 | `HashMap` iteration leaks into output | Non-deterministic emit; invariant 9 broken; two engineers get different tickets from the same workspace | CI emits twice per test with a randomised hasher seed and compares hashes (§7.1). |
| 8 | Wrapped output pasted into a CLI that rejects continuations | Half-applied paste | `WrapPolicy::Display` default (§13.3). |
| 9 | Version-conditional syntax emitted for the wrong train | Config rejected, or accepted and wrong | `EmitCtx.version`; a version-conditional emitter branch with `version: None` must `Block`, not guess. `<!-- VERIFY -->` markers in the corpus gate the branch until a train is recorded. |
| 10 | A `Default(v)` emitted as explicit and then read back as `Set(v)` | The graph drifts from "inherited" to "chosen" across a round-trip, changing what rules see | `--explicit-defaults` output is tagged in the report and E1 runs with the flag off; the flag is an export option, never the default. |

---

## 16. Open decisions

| ID | Decision | Notes |
|---|---|---|
| **OD-1** | Rename the rule engine's static `FieldRef` to `FieldKey`, freeing `FieldRef` for the emitter's instance-level `(node, field, role)`. | Two types, one name, two documents (§2.2). Cheap now, a persistent papercut later. My recommendation: rename the engine's. |
| **OD-2** | Should `Risk` be declared per schema field or per `(platform, field)`? | §8.1 asserts per-field. The counter-case: `clear security ike security-associations` is catastrophic on a hub and merely annoying on a spoke — that is *topology*-dependent, not platform-dependent, and neither model captures it. Possible answer: `Risk` is per-field, and the *note* attached to the line is context-interpolated. |
| **OD-3** | A restricted declarative form for simple statements, so a network engineer can add coverage without Rust. | Not a template language: a table of `(path template, field, renderer, risk, idempotency)` rows, compiled at build time into the same `KindEmitter` machinery, with no conditionals at all. Anything with a branch stays in Rust. This recovers most of what rejecting templates cost (§6.1) without recovering the untested branch. |
| **OD-4** | Derive `KindEmitter::reads()` with a proc-macro instead of hand-maintaining it. | Closes failure mode 1. Cost: a proc-macro in the build, and the macro has to understand the `NodeRef` accessor calls. |
| **OD-5** | Whether `JunosBrace` should support a `replace:`-tagged form for change sets. | Would let brace flavour express a change, at the price of `load replace` semantics (§8.3) — which delete unmodelled statements. My inclination is no, and to keep brace flavour a full-state view only. |
| **OD-6** | Whether emit should run in a worker. | Currently on the main thread at settle. At 6,000 lines it is fine; at a 500-device workspace-wide emit it is not. The pipeline is already pure, so moving it is mechanical — the question is whether the workspace sizes that need it are in scope at all (owner brief §6.4's honest note about several thousand devices). |

---

## 17. Sources consulted

Vendor behaviour claims in this document, with where they came from. Anything not listed
here and not marked `VERIFY` is a claim about Fathom's own design, not about a vendor.

| Claim | Source |
|---|---|
| Junos statements may be entered in any order; order matters only for analysed sequences; `insert` reference points must exist | [Junos OS CLI User Guide — Modify the Configuration of a Device](https://www.juniper.net/documentation/us/en/software/junos/cli/topics/topic-map/modifying-configuration.html) |
| Junos validates the candidate configuration at commit | [Junos OS — Commit the Configuration](https://www.juniper.net/documentation/us/en/software/junos/cli/topics/topic-map/junos-configuration-commit.html) |
| IOS rejects `set transform-set` naming an undefined transform set | [Cisco IOS Security Command Reference](https://www.cisco.com/c/en/us/td/docs/ios-xml/ios/security/a1/sec-a1-cr-book/sec-cr-c3.html) |
| PAN-OS IPsec crypto profile `no-pfs` disables PFS and reuses the Phase 1 key | [Palo Alto Networks — Define IPSec Crypto Profiles](https://docs.paloaltonetworks.com/network-security/ipsec-vpn/administration/set-up-site-to-site-vpn/define-cryptographic-profiles/define-ipsec-crypto-profiles) |
| PAN-OS IKE crypto profile CLI path and fields | [Palo Alto Networks — Define IKE Crypto Profiles](https://docs.paloaltonetworks.com/network-security/ipsec-vpn/administration/set-up-site-to-site-vpn/define-cryptographic-profiles/define-ike-crypto-profiles) |
| PAN-OS `network tunnel ipsec … auto-key ike-gateway / ipsec-crypto-profile / tunnel-interface` | [Palo Alto Networks — Set Up an IPSec Tunnel](https://docs.paloaltonetworks.com/pan-os/9-1/pan-os-admin/vpns/set-up-site-to-site-vpn/set-up-an-ipsec-tunnel) |
| Junos `deactivate` marks a stanza `inactive:` rather than removing it | Junos configuration-mode behaviour; see §17 note below |
| Everything about IPsec object relationships, failure modes, error tokens and operational commands | `.context/field-card-srx-ipsec.txt`, all four sides |

<!-- VERIFY: cite a primary Juniper documentation URL for `deactivate` / `inactive:` semantics rather than relying on secondary sources. -->

---

## 18. Disagreements

None with `conventions.md`.

One narrowing of the owner's brief, recorded rather than silently applied: §5.3's
`order_hint: u32` is described as if it carried the whole ordering. In this document it
carries only the within-block tiebreak, with cross-block ordering owned by the block table
(§4.1) and hard constraints owned by `requires` (§5.7). The field keeps its name and type.
The reason for splitting it is §5.2: a single integer cannot express "the transform-set must
exist before the profile that names it, on IOS, but not on Junos", and encoding that in a
hand-assigned integer means every emitter author has to hold the whole ordering in their
head. Three mechanisms, each locally decidable, is the cheaper design.

One citation correction, offered without confidence that it matters: owner brief §5.2's
`ipsec.pfs.absent` rule cites `RFC 7296 §1.3.2` for PFS. In RFC 7296, §1.3.2 is *Rekeying
IKE SAs with the CREATE_CHILD_SA Exchange*; the Child-SA rekey case is §1.3.3, and the
sentence about the optional KE payload *"to enable stronger guarantees of forward secrecy
for the Child SA"* sits in §1.3's preamble. The rule's citation is probably meant to be
§1.3.3 or §1.3. Worth fixing in the pack before it ships, since a rule that cites the wrong
section is a rule a reviewer stops trusting.
