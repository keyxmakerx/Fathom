# 15 — The explainer corpus

> **Status:** Proposed

The third pillar. Owner brief §1: *"the user should finish knowing **why**, not just **what**.
This is a first-class constraint, not a documentation afterthought."*

This document decides whether that sentence is architecture or decoration. It specifies what
an explainer is attached to, how the right one is chosen for a click, what each of the three
depths contains, how the text is authored, reviewed, linted and versioned, how the entries
link to each other without becoming a wiki, how much of it a credible v1 needs, and what
happens when it falls behind — which it will.

It is also the most expensive document in this repo to act on. §11.6 puts a number on it.

---

## 0. Contents

1. [What this document decides](#1-what-this-document-decides)
2. [The subject model — what an explainer is attached to](#2-the-subject-model--what-an-explainer-is-attached-to)
3. [Resolution — which explainer answers this click](#3-resolution--which-explainer-answers-this-click)
4. [The three depths](#4-the-three-depths)
5. [The counterfactual — the required field](#5-the-counterfactual--the-required-field)
6. [The schema](#6-the-schema)
7. [Authoring and review](#7-authoring-and-review)
8. [The style guide](#8-the-style-guide)
9. [The linter](#9-the-linter)
10. [The concept graph](#10-the-concept-graph)
11. [Progressive disclosure in the UI](#11-progressive-disclosure-in-the-ui)
12. [Scale and coverage](#12-scale-and-coverage)
13. [Maintenance](#13-maintenance)
14. [The relationship to the AI layer](#14-the-relationship-to-the-ai-layer)
15. [Complexity, memory and budget](#15-complexity-memory-and-budget)
16. [Failure modes of the corpus layer itself](#16-failure-modes-of-the-corpus-layer-itself)
17. [Rejected designs](#17-rejected-designs)
18. [Open decisions](#18-open-decisions)
19. [Reconciliation with sibling documents](#19-reconciliation-with-sibling-documents)
20. [Sources consulted](#20-sources-consulted)
21. [Disagreements](#21-disagreements)

---

## 1. What this document decides

### 1.1 The claim being tested

Owner brief §4.1, consequence 2: *"Because explainers and emitters read the same node, 'click
any line of config to learn what it does' is a consequence of the architecture rather than a
feature that has to be maintained separately."*

That is true of the **plumbing** and false of the **prose**. The architecture gives you a
guaranteed, typed, stable address for every explainable thing in the product — that part is
free and doc 13 §12 already built it. What the architecture does not give you is 400 pieces
of writing that are correct, in one voice, and worth reading. Somebody writes those, and
somebody keeps writing them for as long as the product ships.

So the claim this document tests is narrower and harder:

> The teaching pillar is real if, and only if, (a) every subject a user can click has a stable
> address, (b) 100% of the subjects a shipped build can put in front of a user have an entry,
> enforced by a build gate, and (c) the entries say what breaks and what you will wrongly
> blame, enforced by a schema requirement.

(a) is architecture. (b) is a CI gate. (c) is a required field. All three are specified here.
None of them make the writing happen; they make the *absence* of writing impossible to ship
quietly, which is the only mechanism that has ever worked.

### 1.2 What "Teach" costs, stated up front

| Cost | Size | Where it lands |
|---|---|---|
| Authoring v1 | ≈ 250 person-hours (§11.6) | Before v1 ships |
| Two reviewers per entry | ~50% throughput reduction vs one | Every entry, forever |
| The 100% Tier-A coverage gate | A new emitter statement cannot ship without an explainer | Every feature PR |
| Corpus rot | Re-verification of ~60% of entries per vendor major (§13.1) | Continuously |
| Bus factor | One person owns the voice at v1 (§7.1) | Structural risk |
| Shipped size | ~320 KB compressed at v1, ~1.35 MB at v2 (§15.2) | Offline single-file build |

Nothing in this document reduces the authoring cost. Several things in it *increase* the cost
per entry — two counterfactual fields, two reviewers, a linter with 31 gates — in exchange for
entries that are worth the first cost. That is the trade and it is not a close call: a corpus
of 400 entries nobody reads is worse than 120 entries people quote, because the 400 also has
to be maintained.

### 1.3 Scope boundary

Three documents touch this material. The boundary is drawn by **ownership of the bytes**, not
by topic.

| Content | Lives in | Specified by | This doc's role |
|---|---|---|---|
| `explain.terse/explained/teaching` on a rule | `rules/<id>/rule.yaml` in a rule pack | 63 §11 | Defines the depth contract they must satisfy; projects them into the `explain:rule:` namespace |
| `answers`, `read_field`, `risk`, `rosetta` on a command | the command corpus | owner brief §6.1 | Treats `read_field` as the command's Terse depth (§2.5); owns its Explained and Teaching |
| Ladder step prose (`expect.explain`) | ladder documents | 18 §4.3 | Owns the entries those keys point at |
| The resolution ladder for a clicked config token | — | 13 §12.2 | **Extends it** (§3.3) — 13 gives four steps, this gives the full class set, the rail model and the tie-break |
| Everything else: kinds, fields, values, absences, lines, blocks, outputs, errors, symptoms, concepts, placeholders | `corpus/explain/` | **this document** | Owns it |

One namespace, three ownership regions. A reader of the UI never sees the seam; a build does,
because the coverage gate has to know which repository to blame.

---

## 2. The subject model — what an explainer is attached to

### 2.1 The test for a class

Doc 11 §6.1 has a test for when a concept earns a node kind. The same discipline applies here,
because every class costs a resolution step, a coverage denominator, a lint profile and a row
in every future exhaustive match:

> **A subject earns its own class only when it has a distinct addressing scheme, a distinct
> position in the resolution order, or a distinct required-field set.** Otherwise it is a
> field on an existing class.

Applied both ways: `value` earns a class because it is addressed by `(kind, field, variant)`
which no other class can express, and because clicking the token `responder-only` must beat the
entry for the `establish-tunnels` knob in general. `warning` does **not** earn a class — a
warning is a `note` field on whatever it is a warning about, rendered as the card's 4px accent
bar, and giving it its own address would mean two entries drift about one subject.

### 2.2 The thirteen classes

| Class | ID form | What it explains | Rots with |
|---|---|---|---|
| `kind` | `explain:kind:<Kind>` | What this object is, and which knobs it owns | our schema |
| `field` | `explain:field:<Kind>.<field>` | What this field means, platform-neutral | our schema |
| `value` | `explain:value:<Kind>.<field>=<Variant>` | What choosing *this* value does | vendor semantics |
| `absence` | `explain:absence:<Kind>.<field>@<cond>` | Why a statement you expected is not there | vendor semantics |
| `line` | `explain:line:<platform>/<path-template>` | What this statement does on this platform | **vendor syntax** |
| `block` | `explain:block:<platform>/<block-id>` | Why this group of statements exists as a group | vendor syntax |
| `placeholder` | `explain:placeholder:<TOKEN>` | Why the tool emitted `<PSK>` and not a key | never (it is our invariant) |
| `rule` | `explain:rule:<rule-id>` | Why a finding fired *(projected from the rule pack)* | rule pack |
| `command` | `explain:command:<platform>/<dotted>` | What to run and what the output means | **vendor syntax** |
| `output` | `explain:output:<platform>/<dotted>#<field>` | One named field in one command's output | **vendor output format** |
| `error` | `explain:error:<platform>/<TOKEN>` | One vendor error string, verbatim | **vendor log strings** |
| `symptom` | `explain:symptom:<dotted>` | "What I am seeing" → what causes it | physics |
| `concept` | `explain:concept:<dotted>` | The thing that spans all of the above | RFCs |
| `step` | `explain:step:<ladder-id>/<step-id>` | Why this rung of the ladder, in this order | ladder |

That is fourteen rows for thirteen classes; `rule` is listed because it shares the namespace,
but its bytes live in a rule pack (§1.3).

The **Rots with** column is not decoration. It is the axis §13 is built on: five classes rot on
a vendor's release schedule, four rot on ours, and four barely rot at all. Splitting the corpus
along that line is the only thing in §13 that actually helps.

### 2.3 The three that carry the product

Most of the classes are mechanical. Three are not.

**`concept` — the class that spans everything.** Phase 1 vs Phase 2, PFS, MTU, rekey, identity,
NAT-T, the replay window. These are not attached to a node, a field or a line, and every attempt
to attach them to one produces the same failure: the PFS explanation ends up on
`IpsecPolicy.perfect_forward_secrecy`, and then the user who clicked
`set security ike proposal IKE-P1 dh-group group14` never reads it, even though the card's third
PFS rule is precisely about the relationship between those two.

A concept is therefore **addressed by nothing and reached from everything**. It has no position
in the spine (§3.2); it only ever appears as a rail. Concretely, the card's most useful sentence —

> *"Phase 2 rides inside Phase 1. P1 can be perfectly healthy while P2 fails forever — that split
> is the most useful diagnostic fact on this card."* (side 1, `TWO PHASES, TWO JOBS`)

— is `explain:concept:ipsec.phase-split`, and it is a rail on 40+ subjects: every Phase 1 field,
every Phase 2 field, `explain:error:junos-srx/NO_PROPOSAL_CHOSEN.p2`, the `p1`/`p2` ladder steps,
`explain:symptom:p2-cycles-p1-solid`, and the `ipsec.pfs.absent` finding. One text, forty
reachable places. That ratio is the argument for the class.

**`symptom` — the front door for people who cannot name the thing.** Owner brief §2.1: *"you
cannot search for something when you do not know what it is called."* Every other class is
addressed by the name of a thing. `symptom` is addressed by what the engineer can see:

| Symptom id | Card source |
|---|---|
| `explain:symptom:handshake-ok-data-stalls` | side 4, *"Ping works. SSH connects. Then `ls` hangs"* |
| `explain:symptom:up-but-zero-traffic` | side 1, *"the tunnel reads UP while passing zero packets"* |
| `explain:symptom:encrypted-climbing-decrypted-flat` | side 3, `THE ONE-WAY TELL` |
| `explain:symptom:works-then-stops-after-quiet` | side 2, NAT-T, *"works, then stops after N minutes of quiet"* |
| `explain:symptom:p1-timeout-nothing-in-log` | side 1, *"Phase 1 times out with nothing useful in the log"* |
| `explain:symptom:flap-even-interval-round-number` | side 3, `FLAP PATTERN → CAUSE` row 1 |
| `explain:symptom:flap-only-under-load` | side 3, row 7 |

`symptom` entries are the only class whose `terse` is written as a **question or an observation
rather than a statement**, because that is what it will be matched against.

**`error` — the class that must never be paraphrased.** `NO_PROPOSAL_CHOSEN`,
`TS_UNACCEPTABLE`, `INVALID_KE_PAYLOAD`, `AUTHENTICATION_FAILED`, `IKE-ID validation failed`,
`INVALID_SPI`. These are the exact bytes the user is staring at in `show log kmd`. Doc 63 §14.1
already forbids translating them; this document adds two rules: the token in the entry id and in
the entry body must be **byte-identical to the device output**, and the linter checks every
all-caps-underscore token in any entry against the error registry (gate P14), because a typo in
`NO_PROPOSAL_CHOSEN` is invisible to a reviewer and fatal to a grep.

### 2.4 The ID grammar, formally

```
explainer-id  := "explain:" class ":" subject
class         := "kind" | "field" | "value" | "absence" | "line" | "block"
               | "placeholder" | "rule" | "command" | "output" | "error"
               | "symptom" | "concept" | "step"

subject, per class:
  kind        := Kind                                  ; PascalCase, resolves in the schema
  field       := Kind "." field_name                   ; snake_case
  value       := Kind "." field_name "=" Variant       ; PascalCase variant
  absence     := Kind "." field_name "@" condition_id
  line        := platform "/" path_template
  block       := platform "/" block_id
  placeholder := "<" UPPER ">"                         ; e.g. <PSK>
  rule        := rule_id                               ; dotted, per conventions
  command     := platform "/" dotted_path              ; per conventions
  output      := platform "/" dotted_path "#" out_field
  error       := platform "/" TOKEN [ "." qualifier ]  ; qualifier: p1 | p2 | v1 | v2
  symptom     := dotted_path
  concept     := dotted_path
  step        := ladder_id "/" step_id

path_template := segment ("." segment)*
segment       := literal | "*"
```

Rules that the grammar does not express and the linter does (§9.2, gates X1–X3):

| Rule | Reason |
|---|---|
| The whole id is lowercase except `Kind`, `Variant` and error `TOKEN`s | Ids are typed into search boxes and greps. Mixed case in the middle of a dotted path is a bug factory. |
| `path_template` uses the emitter's `StatementPath` (13 §3) with object-name segments replaced by `*`, and **never** with values replaced | `security.ipsec.policy.*.perfect-forward-secrecy.keys` is one subject; `…keys.group14` is a `value`, not a `line`. |
| Ids are stable forever | Same contract as rule ids (conventions, *Identifiers*). A withdrawn entry keeps its id. |
| No id may contain a workspace value | An id containing `VPN-DC-EAST` would leak into the gap export (§13.5). |

### 2.5 Where a class's Terse depth already exists

Two classes have their Terse depth authored elsewhere, and duplicating it would guarantee drift.

**DECISION — `command.read_field` *is* the Terse depth of a `command` explainer.** Owner brief
§6.1 defines the command entry as carrying `read_field: "State — want Installed"`. That is a
9-word statement of what to read. It is Terse, it is already reviewed, and writing a second
one in `explain:command:junos-srx/ipsec.sa.show` would produce two sentences that disagree
within a year. The explainer supplies `explained` and `teaching` only, and its `terse` field is
**forbidden** (gate X11); the renderer sources Terse from the command entry.

**DECISION — the rule pack owns all three depths for `rule`.** Doc 63 §11 already specifies them
with tighter bounds, because a rule's Terse renders inside a finding row. `explain:rule:<id>` is
a projection, not a file. This document's linter still runs the prose gates over them, with doc
63's bounds rather than §4.2's.

### 2.6 What is deliberately not a subject

| Not a subject | Why |
|---|---|
| A specific node in the user's graph | The corpus is shipped content; the workspace is user data. Mixing them makes a corpus update a workspace migration (§17, R6). Node-specific text is a `note` field on the node, which the schema already has. |
| A finding instance | The rule is the subject. An instance is rendered with its witness (12 §10.3), not explained separately. |
| A diagram element | It is a projection of a node. Clicking it resolves to the node's `kind`/`field` subject. |
| Runtime state — an SA index, an SPI value, a tunnel's up-ness | Invariant 2. We do not touch devices, so we have no honest way to explain a value we have never seen. We explain the **field of the output** (`output` class) and stop there. |
| The workspace passphrase, key derivation, sync | Explained in the security docs, linked from `explain:concept:*`, not duplicated here. |

---

## 3. Resolution — which explainer answers this click

### 3.1 The problem, stated precisely

A user clicks the token `group14` in:

```
set security ipsec policy IPSEC-POL perfect-forward-secrecy keys group14
```

Candidates that all legitimately apply:

| Candidate | Says |
|---|---|
| `explain:value:IpsecPolicy.perfect_forward_secrecy=Group14` | 2048-bit MODP. Baseline. Must be identical both ends. |
| `explain:line:junos-srx/security.ipsec.policy.*.perfect-forward-secrecy.keys` | This statement turns PFS on for Phase 2 on an SRX. |
| `explain:field:IpsecPolicy.perfect_forward_secrecy` | Whether Phase 2 runs its own DH. |
| `explain:kind:IpsecPolicy` | The Phase 2 policy object: PFS and a proposal list. |
| `explain:rule:ipsec.pfs.absent` | (fired on the sibling VPN that lacks it) |
| `explain:concept:ipsec.pfs` | The 200-word treatment from side 2. |
| `explain:concept:ike.dh-group` | Why group 2 and 5 are legacy. |

Seven answers. Showing all seven is a wall of text and is the actual, observed failure mode of
every "hover for docs" feature ever built. Showing one is often wrong, because the finding
matters more than the definition.

### 3.2 DECISION — a spine and rails

**Exactly one entry is the spine. Everything else is a rail.**

| | Spine | Rails |
|---|---|---|
| Count | exactly 1 (or 0, → §3.6) | 0–6, capped by depth |
| Chosen by | first hit down an ordered ladder | all matches, in a fixed category order |
| Classes eligible | `value`, `line`, `field`, `kind`, `block`, `output`, `error`, `symptom`, `placeholder`, `step`, `command` | `rule`, `absence`, `concept`, `symptom`, `command`, `related` links |
| Rendered as | the panel's body, at the active depth | headed sections below it, `terse`/`explained` only |
| May contain links | ≤ 2 inline at Teaching, 0 otherwise | title-only, never a body |

This generalises doc 13 §12.2's existing rule — *"Rule explainers are **appended**, never
substituted"* — from one class to a category system. The reason it generalises cleanly is that
the two categories answer different questions: the spine answers *"what is this thing I clicked"*
and the rails answer *"what else is true about it right now."*

### 3.3 The full ladder

The spine ladder is driven by **what token was clicked**, not by a fixed class rank. This is the
one place where doc 13 §12.2's four-step ladder is not enough: it always tries `line` first,
which is wrong when the user clicked a value token.

Step 1 — classify the clicked token from the `EmittedLine`'s `source_fields` spans (13 §2.2):

| `TokenRole` | Determined by | Example in the line above |
|---|---|---|
| `Keyword` | the token is a literal segment of the `StatementPath` | `perfect-forward-secrecy`, `keys` |
| `Value` | the token's span maps to a `FieldRef` carrying a scalar or enum value | `group14` |
| `ObjectName` | the span maps to a `FieldRef` with `role: Referenced` | `IPSEC-POL` |
| `Placeholder` | the token matches `<[A-Z][A-Z0-9_]*>` | `<PSK>` |
| `Chrome` | `set`, `delete`, whitespace, the continuation `\` | `set` |

Step 2 — walk that role's key cascade, first hit wins:

| `TokenRole` | Cascade |
|---|---|
| `Value` | `value` → `line` → `field` → `kind` |
| `Keyword` | `line` → `field` → `kind` |
| `ObjectName` | `kind` → `field`; **and** the panel's primary action becomes "go to `IPSEC-POL`" (13 §12.1) |
| `Placeholder` | `placeholder` → *(no fall-through; an unexplained placeholder is a build error, gate CG6)* |
| `Chrome` | `line` → `block` → `field` → `kind` |
| *(block heading clicked)* | `block` → `absence` (if a `Conditioning` field suppressed a statement) → `concept` |
| *(finder result clicked)* | `command` → `concept` |
| *(log line pasted / ladder `on_fail`)* | `error` → `symptom` → `concept` |
| *(output column clicked)* | `output` → `command` → `concept` |

Step 3 — filter each key's candidate list by platform, version and staleness (§3.4).

Step 4 — the first key with a surviving candidate is the spine. If several candidates survive
for that key, §3.5 breaks the tie.

Step 5 — assemble rails, in this fixed order, capped by depth:

| # | Rail | Source | Cap |
|---|---|---|---|
| 1 | Findings on this line | `EmittedLine.rules_applied` → `explain:rule:<id>` | 3, then "+n more" |
| 2 | Absence | the `Conditioning` field, if any | 1 |
| 3 | Concepts | spine's `explains_part_of` + `see_also` where target class is `concept` | 2 |
| 4 | Symptoms | spine's `causes` / `caused_by` edges | 2 |
| 5 | Verify | command entries whose `intent` covers this statement, interpolated | 3 |
| 6 | Related | spine's remaining `see_also` and `contrasts_with` | 4, **titles only** |

Depth caps the rail set:

| Depth | Rails shown |
|---|---|
| Terse | findings only, as one-line flags. Nothing else. |
| Explained | findings + 1 concept + 1 verify command |
| Teaching | all six categories, within the caps above |

Terse showing findings is deliberate: the senior engineer who set the tool to Terse still needs
to know the config is wrong. Depth controls *explanation*, never *warning*. That is the same
distinction conventions draw between the `Risk` enum and finding severity, applied to prose.

### 3.4 Scoping and filtering

Every entry carries the same two predicates a rule carries (63 §5, §6), for the same reason:

```yaml
platforms: [junos-srx]
versions:  "vers:junos/>=15.1|<24.1"
```

| Filter | Effect |
|---|---|
| Platform mismatch | candidate dropped |
| Version predicate false for `Device.os_version` | candidate dropped |
| `Device.os_version` is `Unknown` | candidate **kept**, and the panel shows the margin tab `version not set` |
| `status != active` | dropped |
| `staleness == Stale` (§13.2) | **dropped from the spine**, may appear as a rail with the tab `stale — <reason>` |
| `staleness == Aging` | kept, rendered with the tab `unverified since <ver>` |

The `os_version: Unknown` case is the one worth arguing about. Doc 11 §6.3 says an unknown
version makes every version-predicated *rule* `Unevaluable` — which is correct for a finding,
because a finding is a claim. It is wrong for an explainer, because refusing to explain
`external-interface` until the user tells you the Junos version is obstruction dressed as rigour.
So: rules fail closed, explainers fail open and say so. That asymmetry is deliberate and it is
the only place in this design where the two engines are treated differently.

### 3.5 The tie-break, and why it must be total

Invariant 9 requires that the same workspace, corpus version and build produce identical output.
Explanation is observable output. Two engineers reading the same line must read the same words,
or they cannot argue about it in a change review.

Candidates for one key are ordered at **build time** by:

```rust
/// Ordered descending. Derived Ord; field order is the comparison order.
#[derive(PartialEq, Eq, PartialOrd, Ord)]
struct Specificity {
    /// 3 = exact platform id, 2 = family glob (`junos-*`), 1 = `*`
    platform: u8,
    /// 3 = closed range, 2 = half-open range, 1 = `*`
    version: u8,
    /// count of non-`*` segments in a `line`/`block` path template; 0 for other classes
    literals: u8,
}
// Final tiebreak: EntryId ascending. Total, and independent of build order.
```

Because the sort happens at build time, the runtime does no comparison at all — it takes
`by_key[k][0]` after the filter pass. Determinism is a property of the artifact, not of the
renderer.

Worked: two entries claim
`explain:line:junos-srx/security.ike.gateway.*.dead-peer-detection.*`. One is
`platforms: [junos-srx], versions: "vers:junos/>=15.1"` and one is
`platforms: ["*"], versions: "*"` (a cross-platform DPD line entry). Specificity `(3,2,6)` beats
`(1,1,6)`. The generic entry is not wasted — it is what a PAN-OS click resolves to.

### 3.6 Fall-through, and the corpus gap record

**Nothing is generated.** Doc 13 §12.2 already states this and it is worth restating as a hard
rule, because the temptation to fill a gap with a template sentence is enormous and the result
is a corpus that reads like a corpus:

> If the ladder falls through, the panel shows structural facts only — kind, object name, field
> name, value, provenance, risk — and files a gap.

```rust
pub struct CorpusGap {
    pub subject: SubjectKey,          // never contains a workspace value
    pub platform: PlatformId,
    pub os_version: Option<OsVersion>,
    pub corpus_version: Version,
    pub reached_from: GapContext,     // EmittedLine | FinderQuery | LogPaste | Link | Block
    pub depth_requested: Depth,
    pub count: u32,
    pub first_seen: Date,
    pub last_seen: Date,
}
```

Gaps are stored **in the workspace** and never transmitted (invariant 1). They are the demand
signal that tells the corpus editor which of the remaining 400 entries to write first — which is
worth more than any prioritisation meeting, because it is derived from what people actually
clicked.

Exporting them is a deliberate, inspectable act:

```
$ fathom corpus gaps --export gaps.yaml
Wrote 34 gap records to gaps.yaml. No workspace values are included.
Printing the complete file so you can check that before you send it:
---
- subject: "explain:line:junos-srx/security.ipsec.vpn.*.idle-time"
  reached_from: EmittedLine
  depth_requested: Teaching
  count: 7
…
```

The CLI prints the whole file rather than a summary. A privacy claim you cannot check is a
marketing claim, and §7.4 of the brief exists because engineers have been burned by exactly
that. The export contains only subject keys, which by §2.4's grammar cannot contain a workspace
value — that is why the grammar bans it, and it is enforced by gate X3.

### 3.7 The algorithm

```rust
pub fn resolve(click: Click, ctx: &Ctx, corpus: &CorpusIndex) -> Panel {
    // 1. token role  — O(log s), s = spans on the line (≤ 6)
    let role = classify_token(click, ctx.line);

    // 2–4. spine — O(1) hash per key, ≤ 4 keys, ≤ 4 candidates each
    let mut spine = None;
    for key in cascade(role, click) {
        if let Some(e) = corpus.by_key(&key)
                               .iter()
                               .find(|e| e.passes(ctx.platform, ctx.version)
                                      && e.status == Active
                                      && e.staleness != Stale) {
            spine = Some(*e);
            break;
        }
    }
    let Some(spine) = spine else { return Panel::structural(click, ctx).file_gap() };

    // 5. rails — fixed categories, fixed caps, deterministic order
    let rails = assemble_rails(spine, ctx, ctx.depth);

    // 6. render — pre-parsed AST, no markup parser at runtime (§6.4)
    Panel { spine: render(spine, ctx.depth, ctx.slots), rails, attachments: attach(ctx) }
}
```

| Step | Cost |
|---|---|
| Token classification | binary search over ≤ 6 spans |
| Spine | ≤ 4 hash lookups × ≤ 4 predicate evaluations = ≤ 16 |
| Rails | ≤ 6 lookups + ≤ 3 command interpolations |
| Body decompression | one zstd frame (~2 KB), LRU-cached |
| Render | linear over a pre-parsed AST, ≤ 350 words |

Well inside doc 13 §12.6's 1 ms budget. Nothing here touches a model (§14).

### 3.8 Worked: three clicks on one line

```
set security ipsec vpn VPN-B establish-tunnels responder-only
```

| Click | Role | Spine | Rails at Teaching |
|---|---|---|---|
| `responder-only` | `Value` | `explain:value:IpsecVpn.establish_tunnels=ResponderOnly` — *"Never initiates. Right for a peer behind NAT; fatal on both ends at once."* | finding `ipsec.establish-tunnels.both-passive` (if it fired) · `explain:concept:ipsec.who-initiates` · `explain:symptom:tunnel-never-comes-up` · verify `junos-srx/ike.sa.show` |
| `establish-tunnels` | `Keyword` | `explain:line:junos-srx/security.ipsec.vpn.*.establish-tunnels` — the knob, its three values, the default | same rails, plus `explain:value:…=OnTraffic` and `…=Immediately` as `contrasts_with` |
| `VPN-B` | `ObjectName` | `explain:kind:IpsecVpn`; primary action "go to VPN-B" | `explain:concept:ipsec.object-chain` (the card's `THE OBJECT CHAIN`) |

Three different clicks on one 8-token line produce three different, correct answers, and none of
them required a model. That is the whole argument for `(line, provenance)` pairs (invariant 6)
in one table.

---

## 4. The three depths

### 4.1 The contract

Owner brief §5.4 gives three depths and their audiences. It does not say what is *in* them, and
without that every author writes three lengths of the same paragraph.

| | **Terse** | **Explained** | **Teaching** |
|---|---|---|---|
| Audience | knows the platform | knows networking, new to this vendor | ramping in |
| Answers | "what is this, in one line" | "why is this block here and what do I read" | "why does this exist, how does it fail, what will I wrongly blame" |
| **Must contain** | the identifying fact, or the value to want | the mechanism, and the field/output to read | the mechanism, the failure mode, the counterfactual, the misdiagnosis |
| **Must not contain** | citations, links, hedges, subordinate clauses | analogies, history, a second topic | a summary paragraph, a "in conclusion" |
| Ends with | a period | the thing to read | a rule of thumb, an imperative, or a number |
| Length | 6–16 words, ≤ 80 chars | 25–60 words, 160–400 chars | body 70–240 words |
| Rails | findings only | + 1 concept, 1 command | all six categories |
| Required extra fields | — | — | `breaks_if_wrong`, `misdiagnosed_as` (§5) |

### 4.2 Where the numbers come from

Not taste. Measured off the owner's own card, which is the only artifact in existence written in
the target voice.

**Terse.** The card's `READING THE SA OUTPUT` table is Terse depth in the wild — a lookup key and
a one-line answer, no vertical rules:

| Card cell | Words |
|---|---|
| *"Port — 500 direct, 4500 = NAT-T in path."* | 7 |
| *"State — P2 wants Installed. Anything else is not passing traffic."* | 10 |
| *"SPI — One per direction — two lines per selector is correct, not a duplicate."* | 13 |
| *"Index — P1 SA identifier. Same index a minute later = stable. New index = it rebuilt."* | 14 |

Observed range 7–14 words. Bound set to **6–16 words**, with a hard **80-character** ceiling to
stay layout-compatible with doc 63 V15, since a rule's Terse renders in a finding row.

**Explained.** The card's standalone prose notes, each of which explains one mechanism and stops:

| Card note | Words |
|---|---|
| PFS cost note — *"one extra DH exponentiation per SA per rekey…"* | 20 |
| `one-way tell` — *"Encrypted climbing, decrypted flat…"* | 27 |
| `external-interface` note — *"…not st0. Wrong on a multi-homed box…"* | 30 |
| MTU tell-tale — *"Ping works. SSH connects. Then `ls` hangs…"* | 32 |
| PFS/IKEv2 note — *"the first child SA is always keyed from the IKE SA regardless…"* | 33 |
| NAT-T prose — *"ESP is IP protocol 50 with no ports…"* | 43 |
| MTU story — *"MTU is the largest frame an interface will pass…"* | 45 |

Observed range 20–45 words. Bound set to **25–60 words / 160–400 characters**. The headroom over
the card exists because the card's reader already knows Junos and Explained's reader does not;
the 400-character ceiling is doc 63 V15's and is the binding constraint.

**Teaching.** A complete concept block on the card:

| Card block | Words |
|---|---|
| `REPLAY ERRORS` (side 4) | 73 |
| `LIFETIMES & REKEY` prose (side 2) | 85 |
| `DEAD PEER DETECTION` (side 2) | 110 |
| `PERFECT FORWARD SECRECY` whole block (side 2) | 201 |

201 words is the densest complete treatment of one subject across four sides. Since
`breaks_if_wrong` and `misdiagnosed_as` are separate fields here — and on the card they are
inside the prose (PFS rule 2; the DPD *"too tight… self-inflicted flaps"* sentence) — the body
alone runs shorter. Bound set to **body 70–240 words**, warn above 240, **error above 380**.

380 is not arbitrary either. §11.6's layout arithmetic: the Teaching rail is 380 px wide at the
card's density, about 9 words per line; a 240-word body plus a 45-word `breaks_if_wrong` plus a
40-word `misdiagnosed_as` is ~325 words ≈ 36 lines ≈ 780 px, which fits one rail screen at 1080p
without scrolling. At 380 words it does not. **The ceiling is a layout fact, not an opinion**,
and if the rail width changes the ceiling changes with it.

### 4.3 Depth is not truncation

Doc 63 §11.2 states this for rules; it is more important here because standalone entries are
longer and the temptation is proportional.

> **The three depths are three texts.** Terse is not the first sentence of Explained. Explained
> is not Teaching with the story removed.

The mechanical reason: they answer different questions (§4.1 row 2), so a truncation of one
cannot be a correct answer to another. The observable reason: a truncated Terse always begins
with the subject noun ("Perfect Forward Secrecy is…") because that is how the long version began,
whereas a written Terse begins with the fact the reader needs ("Fresh DH per Phase 2 —").

Enforced by gate P10: `terse` may not be a prefix of `explained`, and their trigram Jaccard
similarity must be below 0.6. That catches prefix truncation and most paraphrase truncation. It
does not catch a competent author who rewrites the same thought at three lengths — nothing can,
and that is a review question (§7.3, Q4).

**Write Terse last.** Not a lint rule, a working practice: Terse is the hardest of the three
because it must be the *one* fact, and you do not know which fact that is until you have written
Teaching. Authors who write Terse first write a definition, every time.

### 4.4 Worked triple 1 — Perfect Forward Secrecy

Subject: `explain:field:IpsecPolicy.perfect_forward_secrecy`.
Source: field card side 2, `PERFECT FORWARD SECRECY`. This is the one the owner brief §5.2 built
its example rule around and the one the design prototype renders.

Side by side:

| Depth | Text | Words |
|---|---|---|
| **Terse** | Fresh DH per Phase 2. Must be identical both ends, not merely compatible. | 12 |
| **Explained** | Without PFS the Phase 2 keys are derived from Phase 1 key material, so one compromised IKE SA secret unlocks every data key under it. With PFS each Phase 2 negotiation runs its own Diffie-Hellman exchange. Set the same group on both ends and confirm it in `show security ipsec security-associations detail`. | 48 |
| **Teaching** | *(below)* | 168 |

```yaml
id: explain:field:IpsecPolicy.perfect_forward_secrecy
class: field
subject: { kind: IpsecPolicy, field: perfect_forward_secrecy }
title: "Perfect forward secrecy"
platforms: ["*"]
versions: "*"
status: active
grounding: documented
reviewed_by: <named human>
reviewed_on: 2026-07-24
voice_reviewed_by: <named human>
verified_against:
  - { platform: junos-srx, version: "21.4R3-S5", on: 2026-06-11 }

terse: "Fresh DH per Phase 2. Must be identical both ends, not merely compatible."

explained: >
  Without PFS the Phase 2 keys are derived from Phase 1 key material, so one
  compromised IKE SA secret unlocks every data key under it. With PFS each
  Phase 2 negotiation runs its own Diffie-Hellman exchange. Set the same group
  on both ends and confirm it in
  `show security ipsec security-associations detail`.

teaching:
  body: >
    Without PFS, the Phase 2 keys are derived from the Phase 1 key material. One
    compromised IKE SA secret unlocks every data key derived under it — including
    traffic somebody recorded off the wire months ago.

    With PFS, each Phase 2 negotiation runs its own fresh Diffie-Hellman exchange.
    The key is mathematically independent of Phase 1 and of every previous Phase 2
    key, so breaking one yields exactly one rekey interval of traffic and nothing
    either side of it. That is the "forward" in forward secrecy: today's break
    cannot read yesterday's capture.

    The group need not equal the Phase 1 `dh-group`, but matching them removes a
    whole class of confusion. Cost is one extra DH exponentiation per SA per rekey
    — irrelevant unless hundreds of tunnels rekey together. Turn it on.

  breaks_if_wrong: >
    PFS configured on one side and absent on the other fails Phase 2 while Phase 1
    stays up and stays up. A group mismatch — group14 against group19 — fails the
    same way, and reports `INVALID_KE_PAYLOAD` rather than `NO_PROPOSAL_CHOSEN`.

  misdiagnosed_as: >
    A wrong pre-shared key. `show security ike security-associations` is clean, so
    the PSK is the next suspect and the afternoon goes into re-typing it on both
    ends. The key is fine. Check Phase 2 before you touch Phase 1.

  rules_out: >
    Under IKEv2 the first child SA is always keyed from the IKE SA regardless; PFS
    applies to later child rekeys. A capture of the initial bring-up showing no DH
    exchange is not a misconfiguration and is not evidence that PFS is off.

links:
  - { rel: explains_part_of, to: "explain:concept:ipsec.pfs" }
  - { rel: see_also,        to: "explain:concept:ike.dh-group" }
  - { rel: contrasts_with,  to: "explain:field:IkeProposal.dh_group" }
  - { rel: causes,          to: "explain:symptom:p2-cycles-p1-solid" }
  - { rel: next_if_bad,     to: "explain:command:junos-srx/ipsec.inactive-tunnels" }

sources:
  - { std: "RFC 7296", section: "1.3", note: "CREATE_CHILD_SA may carry a KE payload for a fresh DH" }
  - { std: "RFC 8247", section: "2.4", note: "DH group requirements: group14 MUST, groups 2 and 5 SHOULD NOT" }
  - { card: "srx-ipsec", side: 2, block: "PERFECT FORWARD SECRECY" }

terminal: true
```

Note what the extraction did. The card's *"THE THREE RULES"* item 2 became `breaks_if_wrong`;
the *"easily misread as a wrong pre-shared key"* device from the card's identity section became
`misdiagnosed_as` (the card applies it to identity, and the same misdiagnosis applies here —
which is exactly why `misdiagnosed_as` is a first-class searchable field, §5.6); the IKEv2 note
became `rules_out`. Nothing was invented. Teaching depth on this subject is a *rearrangement* of
the card, and that is the strongest available evidence that the card is already written at
Teaching depth and the other two depths are the ones that have to be produced.

### 4.5 Worked triple 2 — Dead peer detection

Subject: `explain:field:IkeGateway.dpd`. Source: field card side 2, `DEAD PEER DETECTION`.

| Depth | Text | Words |
|---|---|---|
| **Terse** | Probes the peer over IKE. Dead after `interval × threshold` seconds. | 10 |
| **Explained** | DPD probes the peer on the outer IKE session, never over `st0`. Time to declare a peer dead is `interval × threshold`; Junos defaults to 10 × 5, which is 50 seconds of blackhole before failover even starts. Read the current setting from `show security ike gateway <name>`. | 44 |
| **Teaching** | *(below)* | 152 |

```yaml
teaching:
  body: >
    DPD is how the box decides a peer is gone when there is nothing else to tell it.
    `optimized` probes only when we are sending and hearing nothing back, and is the
    default. `probe-idle-tunnel` probes when idle too. `always-send` probes every
    interval regardless, which is what you want for a backup tunnel you need to
    trust — an idle backup that is never probed is a backup whose state you do not
    know.

    Time to declare a peer dead is `interval × threshold`. The Junos default of
    10 × 5 is 50 seconds of blackhole before failover even begins, which is longer
    than most people assume when they leave it alone. 10 × 3 is a reasonable middle.

    DPD rides the outer IKE session on UDP 500 or 4500, never `st0`. Silence on
    `st0` does not mean the tunnel is dead, and a quiet `st0` with `optimized` set
    means nothing is being probed at all.

  breaks_if_wrong: >
    Too tight and a two-second underlay hiccup tears down a healthy tunnel. Too
    loose and traffic pours into a dead tunnel for the better part of a minute
    before anything fails over.

  misdiagnosed_as: >
    A crypto or peer problem. The flap interval is a clean round number equal to
    `interval × threshold`, so it reads as a lifetime mismatch, and a week goes into
    proposals and timers while the actual cause is packet loss in the underlay
    tearing down a tunnel that was fine. Check the flap interval against the DPD
    arithmetic before you open a proposal.

links:
  - { rel: explains_part_of, to: "explain:concept:ike.liveness" }
  - { rel: causes,           to: "explain:symptom:flap-interval-equals-dpd-product" }
  - { rel: see_also,         to: "explain:concept:underlay-loss" }
  - { rel: contrasts_with,   to: "explain:field:IpsecVpn.vpn_monitor" }

sources:
  - { std: "RFC 3706", note: "Traffic-based DPD for IKEv1; R-U-THERE / R-U-THERE-ACK" }
  - { std: "RFC 7296", section: "2.4", note: "IKEv2 liveness is built in, not a separate mechanism" }
  - { card: "srx-ipsec", side: 2, block: "DEAD PEER DETECTION" }
```

The `misdiagnosed_as` here is doing work no other field can do: it names the *shape of the
evidence* that produces the wrong conclusion (a round-number flap interval), which is the thing
that makes the misdiagnosis feel justified at the time. That is the difference between "people
sometimes blame crypto" and a sentence that changes what someone does on a Tuesday.

### 4.6 Worked triple 3 — MSS clamping and the MTU story

Subject: `explain:rule:mtu.mss-clamp.absent` (bytes owned by the rule pack, §1.3) with
`explain:concept:mtu.overhead` as its concept rail. Source: field card side 4.

| Depth | Text | Words |
|---|---|---|
| **Terse** | Handshake fine, data stalls — clamp TCP MSS to tunnel MTU minus 40. | 11 |
| **Explained** | IPsec adds roughly 50–70 bytes of headers, so a full-size 1500-byte packet no longer fits and must fragment — and firewalls in the path routinely drop fragments. Clamping MSS rewrites the TCP handshake so both ends agree to smaller segments up front. Check with `show interfaces st0.0 \| match MTU`. | 46 |
| **Teaching** | *(below)* | 196 |

```yaml
teaching:
  body: >
    MTU is the largest frame an interface will pass — standard Ethernet 1500. IPsec
    wraps every packet in new headers, so the payload that still fits shrinks:
    20 bytes of new outer IP header, 8 of ESP header, 8–16 of IV, 2–255 of pad and
    trailer, 12–16 of ICV, and another 8 if NAT-T has moved you to UDP 4500.
    Roughly 50–70 bytes, cipher-dependent. From 1500 that leaves about 1430, which
    is why tunnel MTU is conventionally clamped to 1400 for headroom.

    There are three fixes and they are not interchangeable. MSS clamping rewrites
    the TCP handshake so both ends agree to smaller segments before any data moves;
    it is surgical, it needs no ICMP, and it does nothing for UDP. Lowering the
    tunnel MTU covers UDP too, but the box now fragments before encryption, which
    costs CPU and produces fragments that can still be dropped downstream. Clearing
    the DF bit lets the network fragment the encrypted packet rather than drop it —
    the rescue when you control neither endpoint.

    Rule of thumb: MSS = tunnel MTU − 40. A 1400 MTU means clamp 1360; many shops
    use 1350 for margin.

  breaks_if_wrong: >
    Small packets fit and full-size ones vanish. The TCP handshake completes, SSH
    connects, and then `ls` hangs or a transfer stalls at 0%. Path MTU discovery is
    supposed to catch this, and it does not, because the ICMP fragmentation-needed
    message is filtered somewhere and the sender never learns to shrink.

  misdiagnosed_as: >
    An application or file-server problem. Ping works and SSH connects, so the
    tunnel is declared healthy and the ticket goes to whoever owns the application.
    Handshake fine and data stalled is MTU until proven otherwise — test it with
    `ping <dest> do-not-fragment size 1472` before you escalate anywhere.

sources:
  - { std: "RFC 1191", note: "Path MTU discovery" }
  - { std: "RFC 3948", note: "UDP encapsulation of ESP on port 4500; the +8 bytes" }
  - { card: "srx-ipsec", side: 4, block: "THE MTU STORY" }
  - { card: "srx-ipsec", side: 4, block: "OVERHEAD BUDGET" }
sources_note: >
  Overhead figures are the card's own and are marked approximate there —
  "OVERHEAD FIGURES APPROXIMATE — CIPHER-DEPENDENT". Reproduced with that
  qualification intact.
```

<!-- VERIFY: the per-layer overhead byte ranges are the field card's figures and the card
     itself marks them approximate. Confirm against RFC 4303 §2 for the ESP header/trailer
     layout and against the cipher's actual IV and ICV sizes before any of these numbers
     appear in a UI element that looks authoritative (a calculator, for instance). -->

Note the third `misdiagnosed_as` in a row that names a *person and an action*: re-typing the PSK,
opening a proposal, sending the ticket to the application team. That is the pattern, and §5.5
turns it into a lint gate.

### 4.7 A note on what Terse is for

Terse is not a shorter Explained for people in a hurry. It is the depth a senior engineer leaves
the tool on **permanently**, which means it is the depth most of the reading happens at. Two
consequences:

1. Terse must be *correct in isolation*. "Fresh DH per Phase 2" is only correct because "per
   Phase 2" is doing real work; "Provides forward secrecy" is not correct in isolation because
   it does not distinguish PFS from the base IPsec guarantee.
2. Terse carries the finding rails (§3.3). A senior engineer on Terse still sees that
   `ipsec.pfs.absent` fired. Suppressing warnings along with explanation is the most obvious
   possible bug in a depth system and it should be impossible to introduce — hence the rail
   category table is fixed data, not a per-depth conditional in the renderer.

---

## 5. The counterfactual — the required field

### 5.1 The device, named

The single best thing about the owner's card is that it almost never defines anything. It states
what happens when the thing is wrong.

> *"PFS on one side, absent on the other → Phase 2 fails while Phase 1 stays up. The classic
> 'IKE looks fine but the tunnel keeps dropping.'"*

> *"Miss #3 and Phase 1 times out with nothing useful in the log — the box drops the peer's IKE
> before processing it. Miss #1, #2, #4 or #5 and the tunnel reads UP while passing zero
> packets."*

> *"A mismatch reads as `peer's IKE-ID validation failed` or a bare `AUTHENTICATION_FAILED` —
> easily misread as a wrong pre-shared key. Check identity before you re-type the PSK."*

Two moves, always in that order: **what breaks**, then **what you will wrongly blame**. The
second is rarer and worth more. Anyone who has read the RFC can write the first. Only someone
who has lost an afternoon can write the second.

### 5.2 DECISION — two required fields at Teaching depth

```yaml
teaching:
  body: …
  breaks_if_wrong: …      # REQUIRED
  misdiagnosed_as: …      # REQUIRED
  rules_out: …            # optional
```

An entry with a `teaching` block and either field missing **fails the build** (gates P5, P6).
Not a warning. Not a `TODO`. The entry does not compile, which means either the entry ships with
both fields or it does not ship, and if it does not ship the coverage gate (§12.4) fails for its
subject and someone has to deal with it.

This is the most consequential decision in this document, so the objection deserves an answer.
The objection is: *some subjects have no interesting failure mode, and forcing a field produces
filler.* Three responses, in increasing order of how much I believe them:

1. Weak: filler is visible. `breaks_if_wrong: "It will not work correctly."` is caught by the
   non-answer blocklist and by a reviewer in four seconds.
2. Better: if you genuinely cannot say what breaks, you are explaining a **field**, not a
   **behaviour**, and the entry belongs at `explained` depth only — which is legal. Entries are
   not required to have a `teaching` block at all. They are required, *if* they have one, to
   earn it.
3. Strongest: the subjects with no interesting failure mode are the subjects nobody needed
   explained. `description` on an interface does not need a Teaching depth. Discovering that is
   a feature of the requirement, not a cost of it.

### 5.3 The types

```rust
pub struct Teaching {
    pub body: Prose,                      // 70–240 words (warn > 240, error > 380)
    pub breaks_if_wrong: Counterfactual,  // required
    pub misdiagnosed_as: Misdiagnosis,    // required
    pub rules_out: Option<Prose>,         // optional; the "this looks like a bug and is not" note
}

/// "What breaks if this is wrong." A statement about the system.
pub struct Counterfactual {
    text: Prose,                          // 12–60 words
    /// Structured, optional, and used for the diagnostic index — not rendered as fields.
    breaks: SmallVec<[BreakSite; 2]>,     // Phase1 | Phase2 | Forwarding | Commit | Failover | Logging
    /// Vendor tokens named in the text, extracted at build time, cross-checked against
    /// the error registry by gate P14.
    error_tokens: SmallVec<[ErrorToken; 3]>,
}

/// "What you will wrongly blame." A statement about the engineer.
pub struct Misdiagnosis {
    text: Prose,                          // 8–55 words
    /// The wrong subject that gets blamed. Powers the reverse index (§5.6).
    blamed: SmallVec<[SubjectKey; 2]>,
    /// The action the engineer wrongly takes. Free text, indexed.
    wrong_action: Option<Prose>,          // "re-type the PSK", "raise the lifetime"
}
```

`breaks` and `blamed` are extracted by the author, not by a parser. A parser guessing which
subject is being wrongly blamed is a model doing content authoring, which §14 forbids for exactly
this reason: the extraction feeds a search index, and a wrong index entry sends someone to the
wrong page with confidence.

### 5.4 Why two fields and not one paragraph

They are answered by different people, at different times, from different evidence.

| | `breaks_if_wrong` | `misdiagnosed_as` |
|---|---|---|
| A claim about | the system | the engineer |
| Learnable from | the RFC, the vendor doc, a lab | only from having been wrong |
| Verifiable by | reproducing it | a second practitioner recognising it |
| `grounding` typically | `documented` or `derived` | `observed` |
| If it is missing | the entry is a definition | the entry is a textbook |

Keeping them separate has three concrete payoffs. First, an author who can write the first and
not the second has told you something diagnostic about the entry, and the review workflow routes
it (§7.3, Q2). Second, `misdiagnosed_as` becomes an independent retrieval index (§5.6), which a
merged paragraph cannot. Third, the UI renders them differently: `breaks_if_wrong` is the 4px
accent bar note in the caution wash; `misdiagnosed_as` is the same bar in ink with the margin tab
`what you will wrongly blame`. The design prototype already labels the merged version *"What
breaks, and what you will wrongly blame"*, which is the right user-facing heading for the pair —
and the pair is two fields underneath it.

### 5.5 What a bad one looks like

Real rejections, with the gate that catches each.

| Rejected | Gate | Why |
|---|---|---|
| `breaks_if_wrong: "The tunnel will not come up."` | P5 (word count 6 < 12) | True of every entry in the corpus. Says nothing. |
| `breaks_if_wrong: "N/A — this is a display-only field."` | P5 (non-answer blocklist) | If it is display-only, delete the `teaching` block. |
| `breaks_if_wrong: "Without PFS, forward secrecy is not provided."` | P3 (feature-speak), P4 (no failure marker) | A definition wearing a counterfactual's clothes. Names no failure. |
| `misdiagnosed_as: "Users may be confused."` | P6 (no blame-lexicon term) | Names no wrong subject and no wrong action. |
| `misdiagnosed_as: "A PSK problem."` | P6 (word count 3 < 8) | The right answer, but it does not say why the wrong answer looks right, which is the entire value. |
| `misdiagnosed_as: "This is often misdiagnosed."` | P6 | Restates the field name. |
| `breaks_if_wrong: "Phase 2 fails."` + `misdiagnosed_as: "Phase 2 failing."` | P6 + review | The two fields must not be paraphrases; trigram similarity > 0.7 is a warning, and a reviewer rejects it. |

And one that passes lint and should still be rejected by a human:

```yaml
breaks_if_wrong: >
  If the value is wrong then the negotiation fails and the tunnel drops, which
  means traffic will not pass between the two sites as expected.
```

24 words, contains "fails" and "drops", contains "if… wrong", no banned phrases. It passes every
gate in §9 and teaches nothing, because it is true of every crypto field on the card. **The
linter enforces shape; the reviewer enforces meaning.** That sentence is the honest limit of
§9 and it is repeated there.

### 5.6 The misdiagnosis index — a second front door

Owner brief §2.1 is a retrieval problem: *"you cannot search for something when you do not know
what it is called."* §6.1 answers it for commands with the `answers` field. `misdiagnosed_as`
answers it for concepts, and it answers a harder version — the user who does not know what it is
called **and** believes they already know what is wrong.

A build-time inverted index over the terms in `misdiagnosed_as` ∪ `wrong_action` ∪
`symptom.terse` ∪ `error` tokens, so that:

| Query | Top hit |
|---|---|
| "keeps dropping" | `explain:field:IpsecPolicy.perfect_forward_secrecy` |
| "re-typed the psk twice" | `explain:field:IkeGateway.remote_identity` |
| "transfer stalls" | `explain:concept:mtu.overhead` |
| "flaps every 50 seconds" | `explain:field:IkeGateway.dpd` |
| "tunnel is up but nothing passes" | `explain:symptom:up-but-zero-traffic` |

Deterministic scoring, frozen at build time (invariant 9):

```
score(e, q) = Σ_{t ∈ terms(q)}  idf(t) · 1[t ∈ terms(e)] · w(field(t, e))

w(misdiagnosed_as) = 3.0    w(symptom.terse)  = 2.5    w(breaks_if_wrong) = 2.0
w(wrong_action)    = 3.0    w(terse)          = 1.5    w(teaching.body)   = 1.0

idf computed over the corpus at build time and serialised into the index.
Ties broken by EntryId ascending. Results capped at 12.
```

Frozen `idf` is what makes this reproducible: the same query against the same corpus version
returns the same twelve entries in the same order on every machine, forever. A live-computed
`idf` would drift with the corpus and quietly reorder results between builds.

The stemming and stop-word list are versioned data files under `corpus/lint/lexicons/en/`, and a
change to them is a **minor** corpus version bump that forces a full re-index in CI — the same
discipline §9.9 applies to the lint lexicons, for the same reason.

---

## 6. The schema

### 6.1 Layout on disk

```
corpus/
├── corpus.toml                          # manifest — mirrors 63 §3's pack.toml
├── CHANGELOG.md
├── explain/
│   ├── concept/
│   │   ├── ipsec.phase-split.yaml
│   │   ├── ipsec.pfs.yaml
│   │   ├── mtu.overhead.yaml
│   │   └── …
│   ├── field/
│   │   ├── IkeGateway.external_interface.yaml
│   │   ├── IpsecPolicy.perfect_forward_secrecy.yaml
│   │   └── …
│   ├── kind/           value/           absence/
│   ├── line/junos-srx/ block/junos-srx/ command/junos-srx/
│   ├── output/junos-srx/                error/junos-srx/
│   ├── symptom/        step/            placeholder/
│   └── bodies/                          # long teaching bodies referenced by `body: file:`
│       └── mtu.overhead.teaching.md
├── lint/
│   ├── lexicons/en/{banned,failure-markers,counterfactual,blame,hedge,imperative}.yaml
│   └── config.toml                      # gate levels, thresholds, the waiver list
├── platforms/
│   └── junos-srx/releases.yaml          # the release calendar (§13.3)
└── i18n/
    ├── en.yaml                          # generated by extraction; checked in
    └── de.yaml
```

Rules, and the reason for each:

| Rule | Reason |
|---|---|
| One file per entry, named exactly the subject portion of the id | `git log corpus/explain/field/IpsecPolicy.perfect_forward_secrecy.yaml` is the history of one explanation. Matches 63 §2's one-directory-per-rule discipline. |
| Directory = class | The class is not in the filename, so it cannot disagree with the directory. Gate X1 checks them against each other. |
| Teaching bodies over ~250 words live in `bodies/` as Markdown | YAML block scalars stop being reviewable past that length, and a Markdown file gets a proper diff. Same rule as 63 §2. |
| `i18n/en.yaml` is generated | 63 §14.2. Never hand-edited. |
| Lexicons are data, versioned with the corpus | A lint rule that lives in code cannot be reviewed by the person whose prose it governs. |

### 6.2 The complete field reference

`R` = required, `O` = optional, `R*` = required under a stated condition.

**Identity and lifecycle**

| Field | Type | R/O | Validation |
|---|---|---|---|
| `id` | explainer id | R | §2.4 grammar; matches path and directory (X1) |
| `class` | enum | R | One of the thirteen; must match the directory (X1) |
| `subject` | class-dependent map | R | Resolves against schema / statement registry / command corpus / error registry (X2) |
| `title` | string | R | ≤ 60 chars. Sentence case. Rendered as the panel heading and in link lists |
| `entry_version` | semver | R | Bumped on any prose change; lets an exported change ticket be traced to exact text |
| `status` | enum | O | `draft` \| `active` \| `deprecated` \| `withdrawn`. Default `active`. `draft` compiles, lints, never ships |
| `replaced_by` | explainer id | R* | Required when `deprecated` or `withdrawn` |

**Applicability**

| Field | Type | R/O | Validation |
|---|---|---|---|
| `platforms` | list | R | Platform registry (63 §5.1). `["*"]` allowed and requires a justification comment |
| `versions` | `vers:` or `*` | R | 63 §6.1 syntax. Map form allowed when platforms differ |
| `applies_when` | `fex` expression | O | Rare. Gates an entry on a graph fact — e.g. a NAT-T entry that only resolves when `ike_gateway.nat_detected`. Uses the rule engine's expression language (12 §3), same read-set extraction |

**Prose**

| Field | Type | R/O | Bounds |
|---|---|---|---|
| `terse` | string | R* | 6–16 words, ≤ 80 chars. **Forbidden** for `class: command` (§2.5) |
| `explained` | string | R | 25–60 words, 160–400 chars |
| `teaching` | map | O | If present: `body`, `breaks_if_wrong`, `misdiagnosed_as` all required |
| `teaching.body` | prose or `file:` | R* | 70–240 words; warn > 240; error > 380 |
| `teaching.breaks_if_wrong` | prose | R* | 12–60 words |
| `teaching.misdiagnosed_as` | prose | R* | 8–55 words |
| `teaching.rules_out` | prose | O | ≤ 60 words |
| `note` | map | O | `{ level: info\|caution, text }` — the card's 4px accent bar. One per entry, max |

**Grounding, provenance and staleness**

| Field | Type | R/O | Validation |
|---|---|---|---|
| `grounding` | enum | R | `observed` \| `documented` \| `derived` (§7.3) |
| `verified_against` | list of `{platform, version, on}` | R* | Required when `grounding: observed`. Non-empty |
| `sources` | list | R* | 63 §12.1 forms exactly. Required when `grounding` is `documented` or `derived` |
| `sources_note` | string | R* | Required when `sources` is empty (63 §12.2) |
| `reviewed_by` | string | R | A named human. Invariant 10 |
| `reviewed_on` | date | R | Warn if > 24 months (P/W gate) |
| `voice_reviewed_by` | string | R | §7.2 stage 4. May equal `reviewed_by` only for `class: line` and `class: value` |
| `authored_by` | enum | O | `human` \| `model_drafted`. Default `human`. §14.7 |
| `drafted_by` | map | R* | `{ model, version, on }`. Required when `authored_by: model_drafted` |
| `review_action` | enum | R* | `accepted` \| `edited` \| `rewritten`. Required when `authored_by: model_drafted` |

**Graph and interaction**

| Field | Type | R/O | Validation |
|---|---|---|---|
| `links` | list of `{rel, to}` | O | ≤ 7 total (G4). `rel` from §10.1's table. All targets resolve (G1) |
| `terminal` | bool | O | Default `false`. §10.3. Must be `true` or reach a terminal in ≤ 3 hops (G2) |
| `slots` | map | O | Interpolation slots, §6.5 |
| `tab` | string | O | The margin tab, ≤ 4 words, lowercase, unpunctuated. `most-missed`, `read this first`, `not VPN-specific` — the card's own vocabulary |
| `answers` | list of string | O | Free-text questions this entry answers. Feeds the finder alongside the command corpus's `answers` (owner brief §6.1) |

### 6.3 The Rust types

```rust
pub struct ExplainerEntry {
    pub id: EntryId,                      // interned u32 at build time
    pub class: Class,
    pub subject: SubjectKey,
    pub title: Interned,
    pub entry_version: Version,
    pub status: Status,

    pub platforms: PlatformPred,
    pub versions: VersionPred,
    pub applies_when: Option<CompiledFex>,

    pub terse: Option<AstRange>,          // None only for class == Command
    pub explained: AstRange,
    pub teaching: Option<Teaching>,       // §5.3
    pub note: Option<(NoteLevel, AstRange)>,

    pub grounding: Grounding,
    pub verified_against: SmallVec<[Verification; 3]>,
    pub sources: SmallVec<[Source; 4]>,
    pub review: Review,                   // reviewed_by/on, voice_reviewed_by, authored_by…

    pub links: SmallVec<[Link; 7]>,
    pub terminal: bool,
    pub slots: SmallVec<[Slot; 4]>,
    pub tab: Option<Interned>,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub enum SubjectKey {
    Kind(KindId),
    Field(KindId, FieldKey),
    Value(KindId, FieldKey, VariantId),
    Absence(KindId, FieldKey, ConditionId),
    Line(PlatformId, PathTemplateId),
    Block(PlatformId, BlockId),
    Placeholder(PlaceholderId),
    Rule(RuleId),
    Command(PlatformId, CommandId),
    Output(PlatformId, CommandId, OutFieldId),
    Error(PlatformId, ErrorTokenId, Option<Qualifier>),
    Symptom(SymptomId),
    Concept(ConceptId),
    Step(LadderId, StepId),
}

/// Everything is an interned id, not a string. Two consequences:
///  - `SubjectKey` is 12 bytes and `Copy`, so resolution allocates nothing.
///  - A dangling reference is impossible at runtime, because interning happens
///    at build time and an unresolvable id fails the build (X2).
```

`AstRange` rather than `String`: bodies are parsed to an AST at build time and stored as one
compressed blob; the entry holds a range into it. See §6.4 for why this is a security decision
and not just a size one.

```rust
pub enum Depth { Terse, Explained, Teaching }   // exactly three. Never a fourth.

pub struct Link { pub rel: Rel, pub to: EntryId }

pub enum Rel {
    ExplainsPartOf,   // directed, acyclic (G5)
    Prerequisite,     // directed, acyclic (G5)
    SeeAlso,          // symmetric, declared once
    ContrastsWith,    // symmetric, declared once
    Causes,           // directed, cycles legal — the physical world has them
    CausedBy,         // the reverse; generated, never authored
    NextIfBad,        // directed, operational; shares semantics with 63 §13
}
```

### 6.4 Body markup — a subset, and why

Bodies are written in a restricted Markdown subset and **compiled to an AST at build time**. The
client ships the AST. No Markdown parser runs on the client.

| Allowed | Notes |
|---|---|
| Paragraphs | Blank-line separated |
| `` `code` `` spans | The card's mono-in-prose texture. Every identifier must be one (P15) |
| Emphasis `*x*` | Sparingly; used for quoted device output |
| One unordered list, ≤ 5 items, no nesting | The card's numbered plumbing is a list; deeper nesting is a document, not an entry |
| One blockquote | For quoting device output verbatim |
| `cmd:` directive | Renders a command with its `Risk` legend chip. `cmd: junos-srx/ipsec.sa.show` |
| Em-dash `—` | The voice's primary device. Literal `--` is a warning (P16) |

| Forbidden | Reason |
|---|---|
| Raw HTML | The app holds network configurations in a browser. An HTML sink in content that ships as data is an XSS surface for a compromised corpus, and the threat model (brief §7.1) already concedes we cannot defend a compromised browser — so do not hand it a second door. |
| Images, diagrams, screenshots | Design language, *What the card never does*. Also: unembeddable in the single-file offline build without bloating it. |
| Headings inside an entry | An entry is one thought. If it needs an `##`, it is two entries. |
| Tables | The card uses tables heavily — but a card table is a *lookup structure*, which in this product is a `class: output` or `class: error` entry with structured rows, not prose markup. |
| Links written inline as `[x](y)` | Links are `links:` entries with a declared `rel`, so the graph gates (§10) can see them. An inline link is invisible to G1–G5. |

The last one is the load-bearing restriction. **You cannot write a link this schema cannot
count.** That is what makes §10.2's no-exit gates enforceable rather than aspirational.

### 6.5 Interpolation slots

Owner brief §6.1: *"With a workspace open, results interpolate real values — the difference
between a lookup and an answer."* The same applies to prose, with more care, because a
half-interpolated sentence is worse than a generic one.

```yaml
slots:
  wan_unit:
    from: "node.external_interface -> LogicalUnit.name"    # a typed path, not an expression
    render: mono
    when_unknown: "the WAN unit"
  peer:
    from: "node.peer.address"
    render: mono
    when_unknown: "the peer's address"

explained: >
  `external-interface` is the WAN unit the IKE packets leave by, not `st0`. On this
  gateway that is {{wan_unit}}, and Phase 1 will source from its address when it
  talks to {{peer}}.
```

Rules:

| Rule | Reason |
|---|---|
| A slot is a **typed path** relative to the subject node, never an expression | An expression language in prose is a second rule engine with no read-set extraction and no tests |
| `when_unknown` is mandatory (X9) | `Presence::Unknown` is the normal state of most of the graph (11 §5.2). A slot with no fallback renders `{{wan_unit}}` to a user, once, and then nobody trusts the panel |
| Slots occupy **noun-phrase positions only** | So a locale file can carry the sentence frame. German case endings do not survive arbitrary substitution, and 63 §14 already owns the translation architecture |
| Rendering is pure: `(entry, node snapshot, depth) → text` | Invariant 9 |
| A slot may not render a `SecretPlaceholder` value | Invariant 3. There is no value to render; the placeholder explainer handles it |

Cost, stated: interpolated prose cannot be machine-translated word-for-word, and an entry with
four slots is measurably harder to review because the reviewer must imagine four fillings. Budget
is **≤ 4 slots per entry** (X9), and most entries should have none.

### 6.6 Compilation to the shipped index

```
corpus/**.yaml
   │  parse + validate (X gates)
   ▼
   │  prose lint (P gates)  ─────────────► lint report, fails the build on any E
   ▼
   │  markdown subset → AST
   ▼
   │  intern ids, resolve links, resolve subjects against registries (X2, G1)
   ▼
   │  graph gates (G) — terminal distance, acyclicity, out-degree
   ▼
   │  build inverted index (§5.6), freeze idf
   ▼
   │  sort by_key candidate lists by Specificity (§3.5)
   ▼
   │  zstd bodies, one frame per entry
   ▼
corpus.fx  (+ blake3 tree hash, signed with the same chain as rule packs — 12 §13.2)
```

```rust
pub struct CorpusIndex {
    by_key:   FxHashMap<SubjectKey, SmallVec<[EntryId; 4]>>,  // pre-sorted by Specificity
    entries:  Vec<EntryHeader>,        // resident: ~72 B each
    bodies:   ZstdFrames,              // lazily decompressed, LRU-capped at 256 KB
    links:    CsrGraph,                // CSR adjacency; Rel in the edge payload
    misdx:    FstMap,                  // §5.6 inverted index
    terminal: BitVec,
    gaps:     (),                      // gaps live in the workspace, never here
}
```

**DECISION — the corpus ships as a separately signed, separately versioned artifact**, using the
same signing and trust chain as rule packs (12 §13.2, §13.3). Reason: corpus updates are far more
frequent than app releases, and coupling them means either shipping the app monthly or shipping
stale prose. Cost, honestly: a second signed artifact, a second version-compatibility matrix
(`corpus.toml` needs `compat.schema_range` and `compat.min_engine` exactly as `pack.toml` does),
and one more thing that can be out of date on a user's machine in a way they have to understand.

---

## 7. Authoring and review

### 7.1 Who writes it

The honest answer for v1: **the project owner**, because four sides of it already exist on paper
and nobody else has the voice. That is also the largest single risk in this document — a corpus
with a bus factor of one, at the exact point in the product where the differentiation lives.

Three mitigations, in the order they take effect:

| # | Mitigation | Effect |
|---|---|---|
| 1 | The style guide (§8) and linter (§9) exist to make the voice transferable | Turns "write like the card" into 12 rules, 6 of which a machine checks |
| 2 | The first 50 entries are written by the voice owner as the **reference set**, and every later contributor is pointed at them before they write anything | The reference set is the spec that prose cannot have |
| 3 | The voice owner moves from authoring to `voice_reviewed_by` (§7.2 stage 4) | Reviewing is 3–4× faster than writing, so the same person covers 3–4× the corpus |

Beyond v1, the realistic model is **practitioner contributors, not technical writers**. The
person who can write `misdiagnosed_as` for DPD is someone who spent a week debugging
self-inflicted flaps. A technical writer produces `explained` competently and `misdiagnosed_as`
not at all, because the field is a memory, not a research task. Recruiting is therefore aimed at
5–20 entries per contributor within one domain, not at hiring anyone to "own the docs".

### 7.2 The pipeline

| Stage | Who | Gate to exit | Batchable |
|---|---|---|---|
| 0 · Gap | the gap queue (§3.6), a coverage failure, or a feature PR | A subject key exists and is unwritten | — |
| 1 · Draft | author | All fields present; `status: draft` | — |
| 2 · Lint | CI | Every E-gate passes (§9.2) | — |
| 3 · Technical review | a named human, **not** the author | Three questions answered in the PR (§7.3) | no |
| 4 · Voice review | the corpus editor | The nine-item checklist (§7.3) | **yes**, ≤ 20 entries |
| 5 · Merge | maintainer | `status: active`, `reviewed_by`, `voice_reviewed_by`, `reviewed_on` set | — |

Stage 4 is the controversial one. Two reviewers per entry roughly halves throughput, and the
obvious saving is to merge stages 3 and 4. Do not: technical correctness and voice are different
skills and merging them reliably produces correct prose nobody reads — which is the failure mode
of every vendor documentation set in §2.3. The compromise that recovers most of the cost is that
**stage 4 alone may be batched**: 20 entries in one sitting, because voice review is pattern
matching and gets faster in bulk, whereas technical review is per-claim and does not.

**Re-review triggers.** An `active` entry returns to stage 3 when any of:

| Trigger | Detected by |
|---|---|
| A vendor major release lands in the entry's `platforms` | the release calendar (§13.3), checked at build |
| `verified_against` newest entry > 24 months old | build warning, then error at 36 |
| A linked rule's `rule_version` takes a major bump | pack compatibility check |
| The emitter's statement path for a `line` subject changes | coverage gate CG1 fails structurally |
| The entry's `sources` cite an obsoleted RFC | manual; no network at build (invariant 1) |

### 7.3 The checklists

**Technical review — three questions, answered in the PR, not just approved.**

> **Q1. Is every factual claim true on the platforms and versions declared, and how do you know?**
> An answer naming a lab box and a version is worth ten times an answer naming a document.
>
> **Q2. Have you seen this fail?** If no, name someone who has, or downgrade `grounding` to
> `documented`/`derived` and supply a source. An entry claiming `grounding: observed` with a
> reviewer who has not observed it is the exact failure this question exists to catch.
>
> **Q3. Would `misdiagnosed_as` have saved you an hour, once?** If not, it is probably a
> restatement of `breaks_if_wrong` and should be rewritten or the entry demoted to Explained-only.

**Voice review — nine items.** Each maps to §8's numbered rules.

| # | Check | §8 rule |
|---|---|---|
| 1 | Does the first sentence state a failure or a fact, not a definition? | S1 |
| 2 | Is there a named misdiagnosis, with the reason the wrong answer looks right? | S2 |
| 3 | Does at least one em-dash deliver a twist rather than pad a clause? | S3 |
| 4 | Zero hedges, zero hype, zero "simply" | S4 |
| 5 | Does it end on a rule of thumb, an imperative, or a number — not a summary? | S5 |
| 6 | Every identifier in mono; the sans wraps around it | S6 |
| 7 | No throat-clearing opener ("It is important to understand that…") | S7 |
| 8 | Are the three depths three texts, or one text at three lengths? | S8 |
| 9 | Would the card have printed this sentence? | — |

Item 9 is not a joke. It is the only check that catches prose which passes the other eight and
still sounds like documentation.

### 7.4 What a reviewer may not do

| Prohibited | Reason |
|---|---|
| Approve their own entry | Obvious, and enforced by CI on the git author vs `reviewed_by` |
| Approve `grounding: observed` for a platform they have not run | The whole value of `observed` is that a person is standing behind it |
| Soften a `breaks_if_wrong` into a hedge | "may cause issues" is how a corpus dies. A reviewer who thinks the claim is too strong must dispute the claim, not blunt it |
| Add a citation the author did not supply | 63 §12.2. A reviewer may *require* a citation; supplying one they have not checked is how a fabricated section number gets in |
| Add a `see_also` link during review | Links are cheap to add and are the mechanism of §10.2's failure. Adding one is an authoring act and goes back to stage 1 |

### 7.5 Attribution

`reviewed_by` is a name a colleague recognises (63 §4.1), never an email, never a handle, never
a team. Invariant 10 requires it for model-involved content and this document requires it for
everything, because the whole accountability argument in §14.5 rests on a person being nameable
when a Teaching-depth claim turns out to be wrong. A team name is not nameable.

---

## 8. The style guide

Derived directly from `.context/design-language.md` § *Voice*, which is itself sampled from the
card. Twelve rules. The **Enforced by** column is deliberately honest: half of these a machine
cannot check, and pretending otherwise produces a linter people learn to game.

| # | Rule | Card evidence | Enforced by |
|---|---|---|---|
| **S1** | **State the failure mode, not the feature.** | *"PFS on one side, absent on the other → Phase 2 fails while Phase 1 stays up."* | P3 (feature-speak opener), P4 (failure marker) — **shape only** |
| **S2** | **Name the misdiagnosis it prevents, and why the wrong answer looks right.** | *"easily misread as a wrong pre-shared key. Check identity before you re-type the PSK."* | P6 (blame lexicon) — shape only; review Q3 |
| **S3** | **The em-dash delivers the twist.** Set up, then pay off. | *"Too tight and a two-second underlay hiccup tears down a healthy tunnel — you then spend a week debugging self-inflicted flaps."* | P16 (bans `--`) — the rest is review item 3 |
| **S4** | **Never hedge, never hype.** | The card's one "seamless" is literal: *"Healthy rekey is seamless."* | P2 (banned list), P11 (hedge list) |
| **S5** | **End on a rule of thumb, not a summary.** | *"10 × 3 is a reasonable middle."* · *"Turn it on."* · *"Write proposals out."* · *"Correlate before you theorise."* | P12 — **warning only**, detection is fragile |
| **S6** | **Mono-in-prose.** Every identifier in mono; the sans wraps around it. | *"`external-interface` is the WAN unit the IKE packets leave by, not `st0`."* | P15 — and P15 also checks the identifier exists |
| **S7** | **Density is the point.** No throat-clearing, no scene-setting. | Every block opens on the fact | P1 (length bounds), P9 (sentence length) |
| **S8** | **Three texts, not three lengths.** | — | P10 (prefix + similarity) |
| **S9** | **One governing sentence, in the imperative, when the entry has one.** | *"BOTH ENDS MUST AGREE — EVERY VALUE, EXACTLY"* · *"VERIFY AGAINST YOUR OWN BOX BEFORE ACTING"* | not enforceable — the `note` field is where it goes |
| **S10** | **Numbers carry a unit and a source, or they do not appear.** | *"Junos defaults to 10 × 5 = 50 s"* · *"Roughly 50–70 bytes, cipher-dependent"* | P17 (bare-number warning) |
| **S11** | **Second person for the operator. Never first person.** | *"you then spend a week"* — and no "we" anywhere on four sides | P18 (`we`/`our`/`I` → error) |
| **S12** | **Vendor strings verbatim, never paraphrased, never translated.** | `NO_PROPOSAL_CHOSEN`, `IKE-ID validation failed` | P14 (registry check); 63 §14.1 for translation |

Two rules the card follows that this guide deliberately does **not** enforce:

**Ordinals as content.** The card's *"#1 the tunnel interface … #5 policy for the zone pair"* is
excellent and it is a property of a *block*, not an entry. It belongs to the emitter's block
structure (13 §4), rendered as content per the design language, and duplicating it as a prose
rule would produce numbered lists in entries that are not sequences.

**The exclusion** — *"not a timer that needs raising"*, *"Stop reading proposals."*, *"do not
chase it."* This is the card's sharpest device and it maps to the optional `rules_out` field.
It is optional, and there is no gate on its frequency, deliberately: gating a rhetorical device
produces formulaic prose, and a corpus where every entry has a ritual "this is not X" paragraph
is worse than one where a third of them have a real one.

---

## 9. The linter

### 9.1 Position

The linter is not a style bot and it is not there to make prose "professional". It exists to
enforce the four things a reviewer reliably fails to catch on the twentieth entry of an
afternoon: a missing required field, a banned construction, a length that will break the layout,
and an identifier that does not exist. Everything else is review.

Prior art worth naming: Vale is an established markup-aware prose linter whose rules are plain
YAML with extension points including existence, substitution, occurrence, capitalisation and
readability metrics. The design below is the same shape — versioned YAML lexicons, a small set
of check kinds — implemented in the Rust build rather than as an external dependency, because
invariant 1 forbids the build's runtime from reaching the network and because the gates need to
read the schema, the statement registry and the error registry, which a general-purpose prose
linter cannot.

<!-- VERIFY: Vale's current canonical repository and licence before citing it as prior art in
     any public-facing material. The search result and the project site (vale.sh) agree on the
     extension-point list; the hosting org appears to have moved. -->

### 9.2 The gate table

Levels: **E** fails the build. **W** is reported and counted; a pack-wide W budget is enforced
(§9.8).

**Structural gates (X)**

| # | Check | Level |
|---|---|---|
| X1 | `id` matches the file path and the `class` directory; grammar per §2.4 | E |
| X2 | `subject` resolves: `Kind`/`field` in the schema, `path_template` in the statement registry, `command` in the command corpus, `TOKEN` in the error registry, `Variant` in the enum registry | E |
| X3 | No duplicate `id`; no id contains a value that could be a workspace value (`[A-Z]{2,}-[A-Z0-9]+` outside the error registry) | E |
| X4 | `reviewed_by`, `reviewed_on`, `voice_reviewed_by` present and non-empty | E |
| X5 | Every `platforms` id resolves; `["*"]` carries a justification comment | E |
| X6 | `versions` parses as `vers:` or `"*"`; map form covers every declared platform | E |
| X7 | `explained` present; if `teaching` present then `body`, `breaks_if_wrong`, `misdiagnosed_as` all present | E |
| X8 | Body parses as the allowed subset (§6.4); no raw HTML, no inline links, no headings, ≤ 1 list of ≤ 5 items | E |
| X9 | Every slot path type-checks against the schema; every slot has `when_unknown`; ≤ 4 slots; no slot targets a `SecretPlaceholder` | E |
| X10 | `grounding: observed` ⇒ `verified_against` non-empty; `documented`/`derived` ⇒ `sources` non-empty or `sources_note` present | E |
| X11 | `class: command` has no `terse` (§2.5); `class: rule` has no prose fields at all (they live in the pack) | E |
| X12 | `authored_by: model_drafted` ⇒ `drafted_by` and `review_action` present | E |
| X13 | `status: draft` entries are excluded from coverage denominators and never ship enabled | E |

**Prose gates (P)**

| # | Check | Applies to | Level |
|---|---|---|---|
| P1 | Length bounds per §4.1/§6.2 | all prose fields | E |
| P2 | Banned-phrase list (§9.3) | all prose fields | E |
| P3 | Feature-speak opener: first sentence matches `^\W*(The )?\S+ (provides|allows|enables|is used to|is designed to|helps you|lets you)\b` | `explained`, `teaching.body`, `breaks_if_wrong` | E |
| P4 | ≥ 1 failure-mode marker in `teaching.body` ∪ `breaks_if_wrong` | teaching | E |
| P5 | `breaks_if_wrong` ≥ 12 words and not in the non-answer blocklist | teaching | E |
| P6 | `misdiagnosed_as` ≥ 8 words **and** contains a blame-lexicon term, an error token, or a `cmd:` reference | teaching | E |
| P7 | ≥ 1 counterfactual marker in `teaching.body` ∪ `breaks_if_wrong` | teaching | E |
| P8 | ARI ≤ 12 on `explained`, ≤ 14 on `teaching.body`, computed per §9.4, only for fields > 60 words | prose | W (E at +2) |
| P9 | No sentence > 45 words; mean sentence length ≤ 24 words | prose | W |
| P10 | `terse` is not a prefix of `explained`; trigram Jaccard(terse, explained) < 0.6; Jaccard(`breaks_if_wrong`, `misdiagnosed_as`) < 0.7 | — | W |
| P11 | Hedge list: `it is important to`, `it should be noted`, `essentially`, `basically`, `arguably`, `in most cases` | all | W |
| P12 | Final sentence of `teaching.body` is ≤ 14 words and begins with an imperative-lexicon verb, or contains a number, or matches the rule-of-thumb pattern | teaching | W |
| P13 | No citation markers in `terse` | terse | E |
| P14 | Every `[A-Z][A-Z0-9_]{4,}` token resolves in the error registry | all | E |
| P15 | Every token matching the vendor-identifier shape (`[a-z]+(-[a-z0-9]+)+`, or a known statement keyword) is inside a code span **and** exists in the platform statement registry | all | E |
| P16 | `--` used as a dash; ` - ` used as a dash | all | W |
| P17 | A bare integer > 1 with no unit, no `×`, and no adjacent identifier | all | W |
| P18 | First person: `we`, `our`, `us`, `I` as standalone words | all | E |
| P19 | Marketing list from conventions: `powerful`, `seamless`, `leverage`, `robust`, `cutting-edge`, `revolutionise` | all | E |

**Graph gates (G)** — specified in §10.5.
**Coverage gates (CG)** — specified in §12.4.

That is 13 + 19 + 5 + 7 = **44 gates**, of which 31 are errors. That is a lot to impose on a
person writing a paragraph, and the honest justification is that 25 of the 31 are structural
(does the field exist, does the identifier resolve) and never fire for a competent author. The
six that fire regularly are P2, P3, P4, P5, P6 and P15 — and each of those maps to one of the
card's own voice rules.

### 9.3 The banned list, and the exception mechanism

```yaml
# corpus/lint/lexicons/en/banned.yaml
version: 3
terms:
  - simply
  - just              # as an intensifier; see `contexts`
  - merely
  - easy
  - easily            # except in the card's own construction — see allowances
  - powerful
  - seamless
  - robust
  - leverage
  - cutting-edge
  - revolutionise
  - best-in-class
  - obviously
  - of course
  - as you know
contexts:
  just:
    # "just" is legal as a temporal or exactness adverb, banned as a minimiser
    allow_if_preceded_by: [has, had, "the", "not"]
allowances:
  - term: seamless
    id: "explain:concept:ipsec.rekey"
    reason: >
      The card's own phrasing: "Healthy rekey is seamless." Quoted, not asserted.
    approved_by: <named human>
  - term: easily
    id: "explain:field:IkeGateway.remote_identity"
    reason: >
      The card's own phrasing: "easily misread as a wrong pre-shared key."
    approved_by: <named human>
```

The exception mechanism matters more than the list. Every allowance is **per-term and per-entry**,
carries a reason and a named approver, and lives in a file the corpus editor reviews as a whole.
A global `# lint: disable` comment would be used forty times in a year and nobody would ever look
at the forty; an allowance file with fifteen rows is a document somebody reads.

### 9.4 Reading level: the metric, and its preprocessing

**DECISION — Automated Readability Index, not Flesch-Kincaid.** ARI is
`4.71 · (characters / words) + 0.5 · (words / sentences) − 21.43`, output as a US grade level.
It uses characters per word rather than syllables per word, which makes it computable exactly and
deterministically without a syllable dictionary. Flesch-Kincaid needs syllable counts, which in
every implementation are heuristic, locale-specific and disagree between libraries — and
invariant 9 does not tolerate a gate whose result depends on which library you linked. A Rust
implementation of ARI, Flesch, Flesch-Kincaid, Coleman-Liau and several others exists in
`rust_readability`; ARI is trivial enough to implement directly and pin, which is the
recommendation, because a lint threshold that moves on a dependency bump is a lint threshold that
gets disabled.

The preprocessing is where the honesty lives. Raw ARI on corpus prose is meaningless because
`set security ipsec policy IPSEC-POL perfect-forward-secrecy keys group14` is 8 "words" of 74
characters and would score off the scale. Pipeline, in order:

1. Strip `cmd:` directives and blockquotes containing device output entirely.
2. Replace every code span with a single 6-character token. (`dead-peer-detection` counts as one
   ordinary word, not as three syllable-heavy ones.)
3. Replace every interpolation slot with its `when_unknown` text.
4. Replace every error token with a single 6-character token.
5. Sentence-split on `. `, `? `, `! `, and on `— ` **only** when followed by a capital.
6. Count characters as letters and digits only.
7. Compute ARI. Report to one decimal.

Thresholds: `explained` ≤ 12, `teaching.body` ≤ 14. Both are warnings; both become errors at +2.
And the caveat that keeps this gate from being nonsense: **ARI on passages under 60 words has
high variance**, because the `words / sentences` term is dominated by a single long sentence. So
P8 does not fire below 60 words at all. That is why it is a warning on a metric and not a hard
bound on a sentence — the sentence bound is P9, which is the one that actually catches unreadable
prose.

<!-- VERIFY: the thresholds 12 and 14 are chosen, not measured. Compute ARI across the first 50
     reference entries and against the card's own prose, then set the thresholds one grade above
     the observed 90th percentile rather than leaving them at a guess. -->

### 9.5 The failure-mode detector

```yaml
# corpus/lint/lexicons/en/failure-markers.yaml
version: 2
verbs:
  [fails, failing, breaks, drops, dropped, times out, timed out, blackholes,
   tears down, torn down, stalls, hangs, vanishes, vanish, refuses, rejects,
   rejected, never comes up, never initiates, cycles, flaps, expires, silently,
   one-way, blackhole, discards, resets]
structures:
  - "reads UP while"
  - "looks fine but"
  - "works, then stops"
token_classes:
  - error_registry          # any token from the vendor error registry counts
```

P4 requires ≥ 1 marker across `teaching.body` ∪ `breaks_if_wrong`. Union, not each — because the
body may legitimately be a mechanism explanation with the failure confined to
`breaks_if_wrong`, which is the correct shape for a concept entry.

### 9.6 The counterfactual and blame detectors

```yaml
# counterfactual.yaml — P7
markers:
  [without, absent, "if you do not", "if it is not", "if this is wrong",
   missing, omitted, unset, "left at the default", "on one side",
   "and not on the other", "when this does not match", "fail to"]

# blame.yaml — P6
terms:
  [blamed, blame, "re-type", retype, "re-typing", chase, chased, suspect,
   suspected, "raise the", "raising the", replace, replaced, "reads as",
   misread, "looks like", "declared healthy", "points at", escalate,
   escalated, "opens a case", "the next suspect", "goes into", "spend"]
```

P6 additionally passes if `misdiagnosed_as` contains an error-registry token or a `cmd:`
reference, because *"reports `AUTHENTICATION_FAILED`, which sends you to the PSK"* is a correct
misdiagnosis statement that happens to use none of the blame verbs.

### 9.7 The identifier gate — the most valuable one

P15 is the gate that pays for the whole linter. It takes every token in prose matching the vendor
identifier shape and requires that it (a) sits inside a code span and (b) exists in the platform
statement registry that the emitter already maintains (13 §2.5, `corpus/statements/junos-srx.yaml`).

What it catches:

| Caught | Why it matters |
|---|---|
| `dead-peer-detect` (typo) | Invisible to a reviewer; fatal to a user's grep and to a copy-paste |
| `perfect-forward-secrecy keys` written as prose without mono | Breaks the card's mono-in-prose texture (S6) and makes the identifier unsearchable |
| `establish-tunnels always` (does not exist) | A wrong knob value asserted at Teaching depth to the audience least able to detect it |
| A statement removed from the emitter but still named in prose | The first symptom of corpus rot, caught the moment the emitter changes |

That last row is the important one: **P15 turns an emitter change into a corpus build failure**,
which is the mechanism that keeps the fast half of the corpus (§13.1) honest without anyone
remembering to check.

### 9.8 False positives, and the escape hatch that does not become a habit

Every gate above will fire wrongly at some point. The escape hatch is the allowance file (§9.3)
extended to all P-gates:

```yaml
# corpus/lint/config.toml
[[allowance]]
gate     = "P15"
id       = "explain:concept:mtu.overhead"
token    = "do-not-fragment"
reason   = "An operational `ping` argument, not a configuration statement; the statement registry only holds config."
approved_by = "<named human>"
expires  = "2027-07-01"
```

Three properties that keep it from becoming a habit:

| Property | Effect |
|---|---|
| Per-gate, per-entry, per-token — never a file-level or global disable | An allowance is a sentence about one thing, not a switch |
| `expires` is required | Allowances rot faster than entries. An expired allowance fails the build, which forces a re-decision rather than an accumulation |
| The count is published in the build report | `allowances: 14 (P15: 9, P2: 3, P17: 2)`. A number that grows is visible; a scattering of comments is not |

W-gate budget: warnings do not fail a build individually, but the corpus-wide warning rate is
capped — **≤ 0.4 warnings per active entry**, enforced as an E. Reason: a warning nobody has to
clear is a warning nobody reads, and the budget converts "we'll fix it later" into a shared debt
with a ceiling.

### 9.9 Determinism of the linter

| Requirement | Mechanism |
|---|---|
| Same input, same verdict, on any machine | No network (invariant 1). Lexicons are versioned data in-repo. No locale-dependent collation; explicit `to_lowercase` on a fixed table |
| A lexicon change cannot silently pass old entries | A lexicon version bump forces a **full re-lint of the whole corpus** in CI, not an incremental one. This is the gate that stops "add the word to the list and move on" from leaving 200 pre-existing violations in place |
| The verdict is auditable | The build report records the linter version, every lexicon version, every gate result, and every allowance used |
| The linter version is part of the corpus artifact's identity | So a finding exported in a change ticket (18 §6.3) can be reproduced exactly |

### 9.10 The honest limit

Repeating §5.5's sentence because it belongs here too:

> **The linter enforces shape. The reviewer enforces meaning.**

`breaks_if_wrong: "If the value is wrong then the negotiation fails and the tunnel drops, which
means traffic will not pass between the two sites as expected."` passes all 31 error gates and
teaches nothing. There is no version of this linter that catches it, because catching it requires
knowing that the sentence is true of forty other entries — which is a judgement about the corpus,
not about the string. §7.3's review question 3 is the only defence, and it is a human one.

A linter that claimed otherwise would be worse than this one, because authors would trust it.

---

## 10. The concept graph

### 10.1 Edge kinds

| `rel` | Direction | Cycles | Rendered as | Example |
|---|---|---|---|---|
| `explains_part_of` | directed | **forbidden** (G5) | breadcrumb above the title | `explain:field:IpsecPolicy.perfect_forward_secrecy` → `explain:concept:ipsec.pfs` |
| `prerequisite` | directed | **forbidden** (G5) | margin tab `read this first` | `explain:concept:ipsec.pfs` → `explain:concept:ipsec.phase-split` |
| `see_also` | symmetric, declared once | allowed | rail 6, titles only | PFS ↔ `explain:concept:ike.dh-group` |
| `contrasts_with` | symmetric, declared once | allowed | side-by-side, two columns | `establish-tunnels=Immediately` ↔ `=OnTraffic` |
| `causes` / `caused_by` | directed; `caused_by` generated | **allowed** | the diagnostic chain | DPD too tight → `explain:symptom:flap-interval-equals-dpd-product` |
| `next_if_bad` | directed | allowed | rail 5, as a command chip with its `Risk` colour | PFS → `explain:command:junos-srx/ipsec.inactive-tunnels` |

`causes` cycles are allowed because they exist. The card states one explicitly:

> *"A climbing count means real reordering or loss — and lost DPD probes on that same path will
> tear the tunnel down. That is how replay counters and flapping connect."* (side 4,
> `REPLAY ERRORS`)

Underlay loss causes replay counters; underlay loss causes DPD failure; DPD failure causes flaps;
flaps cause rekey overlap; rekey overlap causes replay counters. That is a genuine cycle in the
physical world, and a graph model that forbids it is modelling the diagram rather than the
network. What must not cycle is `prerequisite` — "you must understand A before B" going in a
circle is not a fact about the world, it is an authoring bug.

### 10.2 The wiki-with-no-exit failure

Stated precisely, because it is the specific way teaching layers die:

> A user clicks `perfect-forward-secrecy` because a tunnel is down. The entry ends with a link to
> DH groups. DH groups links to IKEv2 child SA rekey. That links back to PFS. Four hops later the
> user has read 700 words, learned three interesting things, fixed nothing, and forgotten which
> line they clicked. The next time, they open a browser tab instead.

The failure is not that the links are wrong. Every one of those links is correct and useful. The
failure is that **no entry in the chain answered the question that started it**, and the graph
made it easy to defer answering forever.

### 10.3 DECISION — every traversal reaches a terminal in ≤ 3 hops

```yaml
terminal: true
```

An entry is **terminal** when it ends in something actionable: a rule of thumb, a value to set, a
command to run, or a concrete number. The card is full of them — *"10 × 3 is a reasonable
middle."*, *"Turn it on."*, *"Write proposals out."*, *"Check this before touching crypto."*,
*"Correlate before you theorise."* — and every one of those sentences is the card refusing to
defer.

Three mechanisms, in order of how much work they do:

**1. Every entry answers before it links.** Structural, not advisory:

| Rule | Enforced by |
|---|---|
| Inline links are not expressible in the body markup at all | X8 (§6.4) |
| `see_also` and `contrasts_with` render **below** the body, never inside it | renderer, fixed |
| At Terse and Explained depth, no link rails render at all | §3.3's rail cap table |
| At Teaching depth, ≤ 2 links may be rendered inline in the body via the `links` list, and only for `explains_part_of` and `prerequisite` | X8 |

**2. Terminal distance.** Every `active` entry must satisfy `terminal == true` **or** reach a
terminal entry within 3 hops along `explains_part_of` ∪ `prerequisite`. Computed as a reverse BFS
from the terminal set:

```rust
/// O(V + E). Runs at build time (G2).
fn terminal_distance(g: &CsrGraph, terminals: &BitVec) -> Vec<u8> {
    let mut d = vec![u8::MAX; g.len()];
    let mut q = VecDeque::new();
    for n in terminals.iter_ones() { d[n] = 0; q.push_back(n); }
    while let Some(n) = q.pop_front() {
        // reverse edges: who points AT n along explains_part_of / prerequisite
        for m in g.in_edges(n, &[Rel::ExplainsPartOf, Rel::Prerequisite]) {
            if d[m] == u8::MAX { d[m] = d[n] + 1; q.push_back(m); }
        }
    }
    d   // any entry with d > 3 fails G2
}
```

Why 3 and not 2 or 4: a chain of `field → concept → parent concept → terminal` is four entries
and three hops, which is the deepest legitimate chain observable in the card's own structure
(a knob → its section → its side's governing rule). Four hops has no example on the card. This
is an open decision (§18, D4) because the evidence is one artifact.

**3. The anchor never moves.** The rail pins the originating subject and the config line that
started it at the top, permanently:

```
▌ you clicked
  set security ipsec policy IPSEC-POL perfect-forward-secrecy keys group14   ← always visible
─────────────────────────────────────────────────────────────────────────
  PERFECT FORWARD SECRECY                                   3 links deep ⟵ back
  …
```

The link stack is **6 deep and does not grow**: the seventh navigation replaces the sixth rather
than pushing. At depth ≥ 4 the header renders `4 links from <the line>` and one keystroke
(`Esc`) returns to the anchor. A user cannot get lost, because the thing they were doing is
still on screen.

### 10.4 Metrics

Computed at build and published in the corpus build report:

| Metric | Definition | Target |
|---|---|---|
| Terminal ratio | `|{e : e.terminal}| / |active|` | ≥ 0.35 |
| Max terminal distance | `max(d)` over active entries | ≤ 3 (hard, G2) |
| Mean out-degree | edges / entries | ≤ 3.0 |
| Max out-degree | — | ≤ 7 (hard, G4) |
| Orphan set | entries with in-degree 0 **and** no spine-eligible subject key | reported; W if > 5% |
| Hub set | entries with in-degree > 25 | reported. A hub is fine (`ipsec.phase-split` should be one); a *new* hub appearing without review is a smell |
| `prerequisite` depth | longest chain | ≤ 4 |

The out-degree cap of 7 has a reason beyond taste: **a list of eight links is a table of
contents, and a table of contents is what vendor documentation already is** (§2.3). The corpus's
entire claim is that it organises by question rather than by index. An entry that ends in twelve
links has given up on that claim.

### 10.5 The graph gates

| # | Check | Level |
|---|---|---|
| G1 | Every `links[].to` resolves to an entry in this corpus, or to a rule id in a declared pack dependency, or is marked `external: true` with a label | E |
| G2 | Every active entry has `terminal_distance ≤ 3` | E |
| G3 | Orphan ratio ≤ 5% | W |
| G4 | Out-degree ≤ 7 per entry | E |
| G5 | `explains_part_of` and `prerequisite` are each acyclic | E |
| G6 | `see_also` and `contrasts_with` are declared exactly once (the reverse is generated) | E |
| G7 | No `prerequisite` edge whose target has a *higher* terminal distance than its source | W — a prerequisite that takes you further from an answer is usually a mis-labelled `see_also` |

### 10.6 Worked: DPD → flaps → underlay loss → replay

The chain the assignment names, built entirely from the card:

```
  explain:field:IkeGateway.dpd                                    terminal: true
    │                                    ("10 × 3 is a reasonable middle.")
    │ causes
    ▼
  explain:symptom:flap-interval-equals-dpd-product                terminal: true
    │                                    (side 3, FLAP PATTERN → CAUSE, row 2)
    │ caused_by
    ▼
  explain:concept:underlay-loss                                   terminal: false
    │                                    (side 3, row 3: "Irregular, bursty")
    ├─ causes ──────────────► explain:output:junos-srx/ipsec.statistics#replay
    │                                    terminal: true
    │                        ("A small static count is noise. A climbing count
    │                          means real reordering or loss.")
    │
    └─ explains_part_of ────► explain:concept:ipsec.liveness       terminal: true
                                         ("Correlate before you theorise.")
```

Terminal distances: `dpd` 0, `flap-interval` 0, `underlay-loss` 1, `replay` 0. Maximum 1. The
cycle `underlay-loss → replay → (rekey overlap) → underlay-loss` exists along `causes` edges and
is legal; G2 is unaffected because it walks only `explains_part_of` and `prerequisite`.

The card resolves this same cycle the same way, and it is worth noticing how: it does not break
the cycle, it **exits** it, twice — *"Correlate before you theorise"* and *"If flaps track
throughput rather than time, check `lifetime-kilobytes` first."* Both are terminals. The graph
model is a formalisation of something the card already does; that is the best available evidence
that the model is right.

---

## 11. Progressive disclosure in the UI

### 11.1 The constraint

**No modal. Ever.** Not a dialog, not a lightbox, not a slide-over that dims the page, not a
tooltip that traps focus. The design language's *What the card never does* list is the
specification, and the reason is structural rather than aesthetic: the user is reading a
configuration and asking a question *about* it. A surface that covers the configuration removes
the thing the answer is about.

### 11.2 The three surfaces

| Surface | Depth | Behaviour | Card equivalent |
|---|---|---|---|
| **Margin tab** | — | 2–4 words, lowercase, muted `#5C6772`, top-right of a block. Always visible. Never a control that looks like a control | *"read this first"*, *"most-missed"*, *"why it exists"* |
| **Inline note** | Terse / Explained | 4px left accent bar + wash, directly under the line or block. **Pushes content down; never overlays.** Expands and collapses in place | The card's 4px accent-bar note |
| **Side rail** | Explained / Teaching | A persistent right column, 380 px. Never covers the config. Scrolls independently. Has no close button — it has a width, and the width can be zero | Side 2 of the card sitting next to side 1 |

The escalation path is the same gesture three times: the margin tab. Clicking it cycles
`terse → explained → teaching → terse` for that block. The design language is explicit that
*"Fathom's explainer depth toggle should feel like these [margin tabs], not like a settings
panel"*, and the prototype already renders it as three lowercase words with an underline on the
active one.

Shift-click sets the depth globally. There is no settings panel for depth, anywhere.

### 11.3 Depth memory

The effective depth for block `b` and user `u`:

```
depth(u, b) = block_override(u, b)
           ?? section_override(u, section(b))
           ?? workspace_default(u)
           ?? user_default(u)
           ?? Explained
```

Where each level lives, and why:

| Level | Stored in | Reason |
|---|---|---|
| `block_override` | workspace `settings` section, keyed by **block id** (13 §4), not node id | Blocks survive edits and re-parses; node ids survive renames but blocks survive restructuring, and a depth preference is about a *topic* |
| `section_override` | workspace settings | "Everything about MTU at Teaching, everything about Phase 1 at Terse" is a real and common state for someone learning one area |
| `workspace_default` | workspace settings | A shared teaching workspace can ship at Teaching |
| `user_default` | **local settings, not the workspace** | See below |
| Fallback | constant | `Explained` — a new user who has expressed no preference should get the middle |

**DECISION — `user_default` lives in local settings, never in the workspace.** A workspace shared
with a junior engineer must not force the senior's Terse on them, and a senior opening a
junior's workspace must not be dropped into Teaching.

The cost is real and worth naming: **a walkthrough does not reproduce.** If a senior engineer
records a change at Teaching depth to hand to a colleague, the colleague opens it at their own
depth and sees different words. The mitigation reuses machinery that already exists — the change
ticket (18 §6.3) records the depth it was rendered at, alongside the corpus version and the two
artifact hashes, and re-renders at that depth regardless of the reader's default. So the
*document* carries its depth and the *tool* carries yours.

Defaults ship at `Explained` for a fresh install. Not Terse (a new user reads nothing and
concludes the tool does not teach) and not Teaching (an experienced user reads 240 words about
`external-interface` on their first click and concludes the tool is for beginners).

### 11.4 What escalation must not do

| Rejected behaviour | Why |
|---|---|
| Auto-escalate depth from dwell time, re-clicks or hesitation | It requires behavioural instrumentation. Even computed purely locally, it is a surveillance affordance in a product whose entire pitch is that it watches nothing (invariant 1). And a UI that changes under you while you read is worse than one that is too terse |
| Infer depth from the user's apparent skill | Same objection, plus it is insulting and it will be wrong |
| Animate the expansion | Design language: no motion vocabulary on the card. The inline note appears; content below it moves down. That is the whole interaction |
| Remember depth per *node* | Nodes are numerous and identical in kind. Setting Teaching on one `IkeGateway` and expecting the next one to be Teaching is what a user actually wants — which is `section_override`, keyed by topic |
| A "learn more" link that navigates away | Progressive disclosure means the next level appears **here**. Navigation is the wiki failure (§10.2) |

### 11.5 Layout arithmetic

Why the rail is 380 px and why §4.2's 380-word ceiling exists:

| Quantity | Value | Source |
|---|---|---|
| Rail width | 380 px | Fits beside a 96-column mono config pane at the card's body size on a 1440 px viewport |
| Characters per rail line | ~58 | 380 px at the card's body size, sans with mono runs |
| Words per rail line | ~9 | at ~6.3 chars/word including the space |
| Max Teaching payload | 240 body + 45 `breaks_if_wrong` + 40 `misdiagnosed_as` = 325 words | §4.1 bounds |
| Lines | ~36 | 325 / 9 |
| Height at the card's leading | ~780 px | 36 × 21.75 px |
| Rail viewport at 1080p | ~900 px | after masthead and legend |

So a maximum-length Teaching entry plus its two counterfactual fields fits one rail screen
without scrolling, and a 380-word body does not. The bound is a layout fact. If the rail width
changes, §4.1's numbers are recomputed — they are not preferences.

Below 1100 px viewport width the rail collapses to the inline note surface and the depth control
still works; Teaching depth renders inline, pushing the config down. The config never scrolls
horizontally and the panel never overlays it, at any width.

### 11.6 Keyboard and assistive technology

| Concern | Behaviour |
|---|---|
| Reaching an explanation without a mouse | Every emitted line is focusable (the prototype already sets `tabindex` on `.cfg-line`); `?` on a focused line opens the panel; `Esc` returns to the anchor |
| Depth without a mouse | `[` and `]` step depth for the focused block; `Shift` + either sets it globally |
| Screen readers | The panel is an `aria-live="polite"` region, not a dialog. It is never a focus trap, because it is never modal. The depth control is a `role="group"` of three `aria-pressed` buttons — as the prototype has it |
| The `Risk` legend | Colour is never the only carrier. Every risk chip has its text (`READ-ONLY — SAFE ON PRODUCTION`), matching the card, which prints the legend on all four sides |
| Reduced motion | There is no motion to reduce |

### 11.7 Budget

| Step | Target |
|---|---|
| Click → panel painted | < 16 ms (one frame) |
| Resolution (§3.7) | < 1 ms |
| Body decompression, cold | < 2 ms for a ~2 KB zstd frame |
| Depth change on an open panel | < 8 ms — all three depths are in the same decompressed entry, so this is a re-render, never a fetch |
| Misdiagnosis search, 12 results | < 5 ms over the FST index |

The depth-change budget is why depth is three fields of one entry rather than three entries
(§17, R2): toggling depth must never decompress anything.

---

## 12. Scale and coverage

### 12.1 Counting from the IR

The denominator is **generated, not counted by hand**. Every Tier-A subject comes out of a
registry the build already maintains: the schema, the emitter's statement path table, the rule
pack, the command corpus, the error registry. That single fact is what makes a 100% coverage
gate possible at all.

From doc 11 §6, machine-counted:

| Quantity | Count |
|---|---|
| Node kinds declared | 38 |
| Field rows across all kind tables | 187 |
| — of which `Emit: R` | 48 |
| — of which `Emit: R*` | 24 |
| — of which `Emit: O` | 82 |
| — of which never emitted (`—`) | 29 |
| Implicit fields on every kind (`id`, `prov`, `ext`, `aka`, `unknown`, `notes`) | 6 shared entries, not 6 × 38 |

From the field card, machine-counted:

| Quantity | Count |
|---|---|
| Distinct `set`/`delete` statements printed | 47 |
| — collapsing object names to `*` and values out of the path | ~44 statement path templates |
| Distinct operational commands printed | 39 |
| Error decoder rows | 9 (+ `INVALID_SPI`) |
| `READING THE SA OUTPUT` rows | 7 |
| `FLAP PATTERN → CAUSE` rows | 7 |
| `THINGS THAT BITE` entries | 6 |
| Bring-up order steps | 9 |

### 12.2 The v1 number

**v1 scope: `junos-srx`, site-to-site IPsec and the plumbing the card covers.** That scope is not
chosen for size — it is chosen because the content already exists on paper, which removes the
largest risk (nobody knows what to write) from the largest cost.

| Class | Denominator source | v1 | Tier |
|---|---|---|---|
| `kind` | kinds inside the IPsec emit unit's closure | 22 | A |
| `field` (R/R*) | required-for-emit fields on those kinds | 44 | A |
| `field` (O) | optional fields the card names | ~50 | B |
| `value` | enum variants that change behaviour | ~38 | B |
| `line` | statement path templates: 44 on the card, ×1.6 for what a complete emitter adds | ~72 | A |
| `block` | emitter blocks (13 §4.1) | ~9 | B |
| `absence` | conditioned suppressions (AEAD, v2-only `mode`, policy-based `st0`) | 6 | B |
| `placeholder` | `<PSK>`, `<CERT>`, `<SNMP-COMMUNITY>`, `<TACACS-KEY>` | 4 | A |
| `rule` | active rules in the v1 SRX IPsec slice *(bytes in the pack)* | ~40 | A |
| `command` | 39 on the card, ×1.4 for the complete verify set | ~55 | A |
| `output` | SA output 7 + statistics counters 6 + interface/route fields | ~18 | B |
| `error` | decoder rows + `INVALID_SPI` | 10 | A |
| `symptom` | flap patterns 7 + things that bite 6 + tell-tales 3 | 16 | C |
| `step` | bring-up 9 + verify-ladder branches | ~22 | B |
| `concept` | phase split, object chain, PFS, rekey, IKE versions, identity, DPD, NAT-T, MTU overhead, PMTUD/DF, replay, MSS clamp, route vs policy based, who-initiates, vpn-monitor, selectors, AEAD, liveness, underlay loss, traceoptions hygiene, commit-confirmed, NHTB, proxy-ID, clock skew | 24 | C |
| **Total** | | **≈ 430** | |

| Tier | Count | Gate |
|---|---|---|
| **A — blocking** | 245 | 100%, build fails otherwise |
| **B — gated** | 143 | ≥ 80% at v1, ≥ 95% at v2 |
| **C — best effort** | 40 | measured, no floor |

**A credible v1 is 380–450 entries**, and it is not credible below about 300, because Tier A
alone is 245 and shipping Tier A with no concepts produces a reference card without the sentence
that makes the card good.

Authored texts: 430 entries × 3 depths + 430 × 2 counterfactual fields ≈ **2,100 pieces of
writing**. That number is the real one, and it is the number people underestimate when they say
"we'll write the docs".

**v2** — three platforms (`junos-srx`, `panos`, `ios-xe`) × three domains (IPsec, zones/policy,
routing/HA) is not 9 × 430. `kind`, `field`, `value`, `concept` and `symptom` are shared across
platforms; only `line`, `block`, `command`, `output`, `error` and `step` multiply. Working it
through: ~1,050 platform-specific + ~450 shared = **≈ 1,500–1,900 entries**.

### 12.3 The coverage metric

```
covered(s) ⟺ ∃ e : e.subject == s
                 ∧ e.status == active
                 ∧ e.staleness != Stale
                 ∧ e passes the platform predicate for at least one shipped platform
                 ∧ e.explained is present

coverage(T)  = |{ s ∈ Denom(T) : covered(s) }| / |Denom(T)|

teaching_coverage(T) = |{ s ∈ Denom(T) : covered(s) ∧ has_complete_teaching(s) }| / |Denom(T)|
   where has_complete_teaching requires body ∧ breaks_if_wrong ∧ misdiagnosed_as
```

Two metrics, not one, and reported separately. Coverage says the user is never stranded;
teaching coverage says the pillar is real. They will diverge, and the gap between them is the
most honest single number about this project's third pillar.

A third, **reachability-weighted coverage**, weights each subject by whether it appears in a
shipped walkthrough's emit output. It is computable statically — run the shipped walkthroughs
against their fixture graphs at build time and collect the emitted statement paths — and it needs
no usage data, which invariant 1 forbids anyway. It answers "what fraction of what a new user
will actually click is covered", which is the number that predicts whether the tool feels like it
teaches.

### 12.4 The CI gates

| # | Check | Level |
|---|---|---|
| CG1 | Every statement path template the shipped emitters can produce resolves to a `line` **or** `field` explainer | E |
| CG2 | Every `status: active` rule in every shipped pack has `explain.terse/explained/teaching` | E *(owned by 63 §19 V3; asserted here too because the gate runs on the composed build)* |
| CG3 | Every command corpus entry has an `explain:command:` entry with `explained` | E |
| CG4 | Every node kind has an `explain:kind:` entry | E |
| CG5 | Every `Emit: R` or `R*` field has an `explain:field:` entry | E |
| CG6 | Every placeholder token any emitter can produce has an `explain:placeholder:` entry | E |
| CG7 | Every error token referenced by any ladder's `on_fail` matcher (18 §4.3) has an `explain:error:` entry | E |
| CG8 | Tier B coverage ≥ the floor in `corpus.toml` (`0.80` at v1) | E |
| CG9 | Every enum variant of a field whose variants change behaviour has an `explain:value:` entry | W at v1, E at v2 |

CG1 is the one with teeth, and its consequence should be stated plainly because it will be
argued about within a month of shipping:

> **A new emitter statement cannot ship without an explainer.** If an engineer adds
> `set security ipsec vpn * idle-time` to the SRX emitter, the corpus build fails until somebody
> writes what it does. The teaching layer can veto a feature.

That is the correct behaviour and it is expensive. It slows every feature PR by the time it takes
to write 25–60 words plus a review. Somebody will eventually want to bypass it, under deadline,
and the bypass must exist or it will be added badly:

```toml
# corpus/lint/config.toml
[[coverage_waiver]]
gate    = "CG1"
subject = "explain:line:junos-srx/security.ipsec.vpn.*.idle-time"
reason  = "Shipped in 2.3.0 for a customer deadline. Entry drafted, awaiting technical review."
owner   = "<named human>"
expires = "2026-10-01"
```

Every waiver has an owner and an expiry, is listed in the release notes, and expires into a build
failure. Never a silent flag, never a global switch, never a default-on environment variable.

### 12.5 Phasing

| Phase | Content | Why this order |
|---|---|---|
| P0 | The **reference set**: 50 entries written by the voice owner, spanning all 13 classes | The spec that prose cannot have (§7.1). Nothing else starts until this exists |
| P1 | `command` + `output` + `error` (~83) | Owner brief §6.1: the finder is the wedge and needs no graph, no crypto, no server. This is the corpus that makes the wedge shippable |
| P2 | `line` + `placeholder` + `block` (~85) | Makes "click any line" real for the SRX IPsec walkthrough |
| P3 | `field` (R/R*) + `kind` (66) | Completes Tier A. **CG1–CG7 can now be turned on**, and after this point the gate protects itself |
| P4 | `concept` + `symptom` (40) | The rails. This is when Teaching depth stops being three lengths of the same text |
| P5 | `field` (O) + `value` + `step` + `absence` (~116) | Tier B to its floor |

P1 first is a departure from "build the deepest thing first", and it is right for the reason the
brief gives: the finder is the on-ramp that requires no trust, and its corpus is 83 entries
rather than 430.

### 12.6 Effort, honestly

Planning assumptions, clearly labelled as assumptions:

| Assumption | Value |
|---|---|
| Median authoring time, Tier A entry, author knows the domain: three depths, two counterfactual fields, links, sources | 25 min |
| Median technical review | 7 min |
| Median voice review, batched | 3 min |
| Total per entry | ~35 min |

| Scope | Entries | Hours | Calendar |
|---|---|---|---|
| P0 reference set | 50 | 30 h | 1 week, one person, nothing else |
| Tier A complete (P1–P3) | 245 | ~145 h | ~4 weeks full-time |
| v1 complete | 430 | ~250 h | **6–7 person-weeks** |
| v2 (3 platforms × 3 domains) | ~1,700 | ~990 h | **~6 person-months** |

<!-- VERIFY: every number in this table is a planning assumption, not a measurement. Time the
     first 50 entries individually, publish the actual median, and rewrite this table. If the
     real median is 45 minutes rather than 25, v1 is 10 person-weeks and the phasing in §12.5
     needs to be re-cut, not the estimate re-argued. -->

This is the largest single line item in the project and it is the one most likely to be
underestimated, because it is the only one that cannot be made faster by being a better
programmer. Six person-weeks of writing before v1 ships, and it does not stop after v1.

---

## 13. Maintenance

The most likely cause of this project failing is not a bug in the rule engine. It is that in
eighteen months the corpus describes Junos 21 and the user is running Junos 24, and every entry
is 90% right — which is the worst possible state, because 90% right is indistinguishable from
right until it costs somebody an outage.

### 13.1 The rot model — the fast half and the slow half

| Class | Rots with | Half-life estimate | v1 count |
|---|---|---|---|
| `line`, `command`, `output`, `error`, `block` | vendor releases | 2–4 years | ~164 |
| `value`, `absence`, `step` | vendor semantics and defaults | 4–8 years | ~66 |
| `kind`, `field`, `placeholder` | **our** schema — which we control | our schedule | 120 |
| `concept`, `symptom`, `rule` | RFCs and physics | a decade or more | ~80 |

<!-- VERIFY: the half-life figures are judgement, not data. They can be replaced with a real
     number after two vendor major releases by measuring how many entries actually needed an
     edit. Until then treat them as an ordering, not as durations. -->

**DECISION — split the corpus along that line and version the halves independently.** The fast
half (`line`, `command`, `output`, `error`, `block`, `value`, `absence`, `step` — about 55% of
entries) versions on a vendor cadence. The slow half (`kind`, `field`, `concept`, `symptom`,
`placeholder` — about 45%) versions on ours.

The payoff is not organisational tidiness. It is that **the resolution ladder already degrades
gracefully across the split**. When a `line` entry goes stale, §3.4 drops it from the spine and
the ladder falls through to `field` — which is in the slow half and is still correct, because
"what `external-interface` means" does not change when Junos renames a knob. The user gets a
slightly less specific but still true answer, plus the margin tab telling them why. That is
graceful degradation for free, purchased by a decision made in §3.

The cost: two version numbers, two changelogs, and a compatibility check between the halves at
load. Contained, and worth it.

### 13.2 Staleness is a field, not a policy

```rust
pub enum Staleness {
    /// Verified against a release inside the platform's supported window.
    Current,
    /// > 18 months since verification, or ≥ 2 vendor majors behind.
    Aging,
    /// > 36 months, or explicitly contradicted by a newer verification.
    Stale,
}
```

Computed at build from `verified_against` and the release calendar. Never stored by hand.

| State | Spine? | Rendered |
|---|---|---|
| `Current` | yes | normally |
| `Aging` | yes | + margin tab `unverified since 21.4` |
| `Stale` | **no** | rail only, tab `stale — <reason>`, and a gap is filed |

Three rules that follow, and each of them is a decision someone will want to reverse:

1. **Staleness is always visible.** Never hidden, never rounded away, never "we'll fix it before
   anyone notices". A wrong answer delivered confidently to the Teaching-depth audience is the
   worst outcome this whole document is trying to avoid.
2. **Stale entries are never auto-deleted.** They hold their id, their history and their
   `misdiagnosed_as` — which is usually still true even when the syntax has moved.
3. **When in doubt, withdraw.** A `Stale` entry loses its spine position automatically. If a
   maintainer is unsure whether an entry is still true, the correct action is `status: withdrawn`
   and a gap, not an edit that guesses. **Missing beats wrong**, and the coverage gate makes
   missing loud.

### 13.3 Vendor release tracking with no network

Invariant 1: the build cannot fetch a vendor release calendar. So the calendar is data in the
repo, updated by a human in a pull request:

```yaml
# corpus/platforms/junos-srx/releases.yaml
maintained_by: <named human>
updated_on: 2026-07-24
supported_window_months: 36
releases:
  - { version: "21.4R3-S5", released: 2024-02-01, major: true,  eol: 2027-06-30 }
  - { version: "22.4R3",    released: 2024-09-15, major: true }
  - { version: "23.4R2",    released: 2025-06-01, major: true }
  - { version: "24.2R1",    released: 2025-11-10, major: true }
```

<!-- VERIFY: these version strings and dates are illustrative placeholders and must be replaced
     with real Junos release data before this file is used to compute anything. Do not ship a
     staleness calculation resting on invented dates. -->

Nobody will remember to update this. So the build checks it against itself:

| Check | Level |
|---|---|
| Newest known release is > 9 months older than the build date | **W** — "the release calendar has probably not been updated" |
| Newest known release is > 15 months older than the build date | **E** — staleness computation is no longer meaningful, so it must not be presented as if it were |
| `corpus.toml`'s `expires` (default: build date + 400 days, mirroring 63 §3) has passed | Entries render with a corpus-wide staleness tab. **Never auto-disabled** — a stale corpus is far better than none, and disabling one on an air-gapped box is the worst possible behaviour |

The 15-month error is the important one. It converts "we stopped maintaining this" from a silent
condition into a build failure, which is the only mechanism that has ever produced a maintenance
decision.

### 13.4 Triage when it falls behind

It will fall behind. Four tiers, in order, with the cost of each:

| Tier | Action | Cost | When |
|---|---|---|---|
| 1 | Mark `Aging`/`Stale`. Nothing is removed | Users see tabs | Always. Automatic |
| 2 | Demote from spine (automatic for `Stale`, §13.2) | Answers get less specific | Automatic |
| 3 | `status: withdrawn`, ladder falls through, gap filed, coverage drops | The coverage gate now fails for that subject | A maintainer believes the entry is wrong |
| 4 | The Tier-A coverage gate forces a choice: **write the entry, or stop shipping the emitter statement / rule / command it explains** | A feature is removed or a person writes | Tier 3 on a Tier-A subject with nobody to fix it |

Tier 4 is brutal and it is the point. The teaching pillar is either a constraint on what ships or
it is decoration, and this document exists because the owner brief said it is a constraint. In
practice Tier 4 almost never fires as a removal — it fires as a waiver (§12.4) with an owner and
an expiry, which is the honest version of the same conversation and leaves a record.

### 13.5 Community contribution, and why it is not the answer

The obvious move for a corpus this size is to open it. Two structural problems:

| Problem | Detail |
|---|---|
| The review gate does not scale with contributions | Every entry needs a technical reviewer who has seen the failure and a voice reviewer. Contributions arrive faster than review capacity, and the queue becomes the bottleneck — visibly, and demoralisingly for contributors |
| The voice is the product | An open corpus in mixed voices is vendor documentation with a different licence. §2.3's entire complaint is that vendor documentation exists and does not teach |

What does work, and is the recommendation:

| Mechanism | Why it fits |
|---|---|
| **Gap reports** (§3.6) rather than entry PRs | A gap costs a user nothing and costs review nothing, and it is the highest-value signal in the system: it says which of the 400 to write next |
| **`misdiagnosed_as` contributions specifically** | The one field where a stranger's experience is worth more than the maintainer's, and it is one sentence, which is reviewable in 90 seconds |
| **Correction reports on a specific claim** | "This is wrong on 24.2, here is the output" is a bug report against a fact, not a prose contribution, and it routes to re-verification rather than review |
| Full entry PRs from a small named set of practitioner contributors | Works because the set is small enough to develop shared voice |

### 13.6 The plan when it falls behind, stated

Because "we will keep it up to date" is not a plan:

1. **Publish coverage and staleness in the product**, per platform and per version, on a page the
   user can reach. A visible "SRX: 100% Tier A, 71% Tier B, 14 entries aging" is survivable and
   builds trust. A hidden 71% does not survive being discovered.
2. **Never let the fast half rot silently.** P15 (§9.7) turns an emitter change into a build
   failure, and §13.3's 15-month check turns abandonment into a build failure.
3. **Withdraw before you guess.** §13.2's rule 3.
4. **Cut scope on platforms, never on depth.** If capacity halves, ship one platform at full
   Teaching depth rather than three at Explained. A tool that teaches Junos properly is a
   product; a tool that half-teaches three platforms is vendor documentation with better search.
5. **If Teaching coverage falls below 50% of Tier A for two consecutive releases, say so in the
   release notes and drop the teaching claim from the product description** until it recovers.
   The pillar is a promise, and the cost of a broken promise here is the trust that §2.4 says is
   the entire market position.

Point 5 is the one that will be unpopular and it is the one that keeps the other four honest.

---

## 14. The relationship to the AI layer

### 14.1 The position

> **A model may retrieve, select, assemble and draft. It may not author what a user is told at
> Teaching depth without a named human review gate.**

This is not a hedge against model quality and it does not soften as models improve. The argument
is about determinism, accountability and deployment shape, and none of the three gets weaker
with a better model.

### 14.2 What a model may do

| Allowed | Where it runs | Determinism |
|---|---|---|
| **Rank** free-text questions against the corpus (the vocabulary gap, §2.1) | **build time** — produces a synonym/paraphrase expansion table shipped as reviewed data | Runtime stays deterministic; owner brief §6.1's "no model at runtime" is preserved |
| **Select** which of several resolved entries to surface when a query is ambiguous | supervisor, runtime, sync build only | Non-deterministic, so it is quarantined behind the AI boundary and labelled (invariant 9) |
| **Assemble** — order rails within their fixed categories, pick a starting depth, choose which of 12 misdiagnosis hits to show first | supervisor, runtime | Same |
| **Interpolate** authored slots with workspace values | this is not a model at all; it is §6.5 | Deterministic |
| **Draft** a new entry into the review queue at stage 1 | offline, an authoring tool, never the shipped app | Human-gated |
| **Summarise for navigation only** — "these four entries are about MTU" | runtime | Labelled, never quoted as content |
| **Triage gap reports** — cluster 400 gaps into 30 themes | offline tooling | Human-gated |

### 14.3 What a model may not do

| Forbidden | Why |
|---|---|
| Author or paraphrase any text a user reads at Teaching depth without `reviewed_by` | Invariant 10, strengthened: a review that did not materially engage is recorded and counted (§14.7) |
| Synthesise `breaks_if_wrong` or `misdiagnosed_as` | These are the two fields whose value is that a person stands behind them. A plausible fabricated misdiagnosis is worse than no misdiagnosis, because it sends someone confidently to the wrong subject |
| Produce a citation | 63 §12.2. A plausible RFC section number survives review and is eventually quoted to a vendor |
| Fill a corpus gap at runtime | The gap is the demand signal (§3.6). Filling it silently removes the signal, and the corpus never gets written |
| Rewrite an authored body at render time to fit a depth | §17, R1. Depth is three texts |
| Run at all in the offline single-file build | There is no model there. See §14.6 |
| Assert a vendor behaviour | Conventions: never fabricate a vendor behaviour |

### 14.4 The review gate, mechanically

A model-drafted entry enters at stage 1 and carries:

```yaml
authored_by: model_drafted
drafted_by: { model: "<name>", version: "<version>", on: 2026-07-20 }
review_action: rewritten          # accepted | edited | rewritten
reviewed_by: <named human>
voice_reviewed_by: <named human>
```

It then goes through the identical stages 2–5 as a human draft. No shortcut, no fast path, no
"it's only a `value` entry".

**The anti-rubber-stamp mechanism.** The obvious failure is that review degenerates into
approval. Two measurements, computed at build:

```
rubber_stamp_rate = |{ e : authored_by == model_drafted
                        ∧ review_action == accepted
                        ∧ edit_distance(draft, final) < 0.15 }|
                  / |{ e : authored_by == model_drafted }|
```

| Threshold | Level |
|---|---|
| `rubber_stamp_rate` > 0.40 | **W** in the build report, named per reviewer |
| `rubber_stamp_rate` > 0.60 | **E** — the model-drafting path is disabled for that pack until a maintainer intervenes |

`edit_distance` is normalised Levenshtein over the token stream, computed against the stored
draft. This is imperfect — a reviewer can add filler to raise it — but it makes the degenerate
case visible, and visibility is the whole mechanism. Nothing here prevents a determined
rubber-stamper; it prevents an accidental one, which is the common case.

### 14.5 The defence

**1. Determinism (invariant 9).** Explanation is observable output. Owner brief §6.1 already
requires the finder to be *"identical every run, diffable between releases"*. The same must hold
for explanation, for a concrete reason: two engineers in a change review must be able to say
"the tool says X" and have that be a checkable statement. A model regenerating prose per render
makes "what the tool says" unstateable, which destroys the tool's usefulness in exactly the
setting — change review — where 18 §6 says its adoption depends.

**2. Accountability, and the asymmetry of harm.** Teaching depth is aimed precisely at the reader
least equipped to detect that it is wrong. A senior engineer reading a fabricated claim at Terse
depth will notice; the new hire the depth exists for will not, will act on it, and will repeat it.
Invariant 10 requires a name in `reviewed_by`, and a name is the only thing that makes a wrong
Teaching-depth claim traceable to a decision rather than to a sampling temperature.

**3. The voice is not reachable by improvisation.** The design language says this outright:
*"This voice is the `Teaching` depth in §5.4. It is achievable by a human writing YAML. It is
not reliably achievable by a language model improvising at runtime."* The mechanism is
observable: asked to explain PFS, a model produces "PFS provides forward secrecy for IPsec
tunnels" — the exact construction gate P3 bans — because it is trained largely on the vendor
documentation §2.3 says does not teach. The corpus's whole value is that it is *not* that
corpus.

**4. Deployment shape.** The offline single-file build has no model and never will. If Teaching
depends on a model, the offline build is a different, worse product, and the air-gapped,
defence, OT and regulated market §2.4 identifies as structurally underserved gets the degraded
version. The corpus makes all three deployment shapes teach identically, which is the only way
the third pillar survives contact with the security posture.

### 14.6 The counter-argument, taken seriously

It is a real argument and it deserves better than dismissal:

> The corpus will be incomplete forever. Tier B will sit at 80%, Tier C will never be finished,
> and the long tail is precisely where a user is most stuck — because the common subjects are the
> ones somebody already wrote. A model could produce a decent answer for the tail. Refusing on
> principle means the user gets nothing, and nothing is not obviously better than 80%-quality
> prose.

I accept the premise and reject the conclusion, but only narrowly. The compromise:

| Rule | Detail |
|---|---|
| A model-generated answer is **never the spine** | It renders below the structural facts panel, in the position a rail occupies |
| Visually distinct, using no new colour | The palette has three semantic colours and none of them may be reused (conventions). So it is muted `#5C6772`, italic, with the margin tab `generated — not reviewed`. It looks less authoritative because it *is* less authoritative |
| Never at Teaching depth | It answers at Explained density. The audience Teaching exists for is the audience that cannot check it |
| Never persisted into the corpus | It is not an entry. It has no id, no `reviewed_by`, and no cache |
| Always files the gap | Using it queues the ticket that eventually replaces it, so the fallback feeds the pipeline instead of hiding the need for it |
| Disabled entirely in the offline build, and off by default in the sync build | Opt-in, per workspace, with the egress consequences stated at the point of opting in |
| Never asserts a vendor behaviour or a citation | The prompt template forbids it and the output is filtered for citation shapes; anything matching `RFC \d+` is stripped, not rendered |

That is the honest position: not "a model can never help", but "a model may not occupy the seat
where the product's credibility lives".

### 14.7 Provenance fields, summarised

| Field | Values | Enforced by |
|---|---|---|
| `authored_by` | `human` (default) \| `model_drafted` | X12 |
| `drafted_by` | `{model, version, on}` | X12, required when `model_drafted` |
| `review_action` | `accepted` \| `edited` \| `rewritten` | X12 |
| `reviewed_by`, `voice_reviewed_by` | named humans | X4, invariant 10 |
| build report | `rubber_stamp_rate`, per pack and per reviewer | §14.4 |

---

## 15. Complexity, memory and budget

### 15.1 Time

| Operation | Complexity | Note |
|---|---|---|
| `resolve(click)` | `O(1)` — ≤ 16 hash lookups + ≤ 6 predicate evaluations | §3.7 |
| Depth change on an open panel | `O(len)` re-render, no I/O | All three depths in one entry |
| Rail assembly | `O(r)`, `r ≤ 6` | Fixed categories, fixed caps |
| Misdiagnosis search | `O(\|q\|)` FST prefix + `O(m)` scoring, `m` = postings | Frozen `idf` |
| Terminal-distance check | `O(V + E)` reverse BFS | Build time, G2 |
| Coverage computation | `O(\|subjects\|)` | Denominator is generated |
| Near-duplicate detection | `O(n²)` trigram sets — 430² ≈ 185 k comparisons | Fine at build time; MinHash LSH if the corpus passes ~3,000 entries |
| Full corpus lint | `O(total words)` with a per-gate constant | Full re-lint on any lexicon bump (§9.9) |

### 15.2 Memory and size

Per entry, text:

| Field | Bytes |
|---|---|
| `title` | ~50 |
| `terse` | ~70 |
| `explained` | ~300 |
| `teaching.body` | ~1,400 (240 words × ~5.9 B) |
| `breaks_if_wrong` | ~180 |
| `misdiagnosed_as` | ~150 |
| **Text total** | **~2,150** |
| + AST overhead ~25% | ~2,700 |

| Quantity | v1 (430) | v2 (1,700) |
|---|---|---|
| Raw AST | ~1.15 MB | ~4.6 MB |
| zstd-19, English prose | **~320 KB** | **~1.3 MB** |
| Resident header table (72 B/entry) | 31 KB | 122 KB |
| `by_key` map (~600 / ~2,400 keys) | 15 KB | 60 KB |
| Links CSR (~1,300 / ~5,000 edges) | 11 KB | 42 KB |
| Misdiagnosis FST | ~50 KB | ~180 KB |
| Body LRU cap | 256 KB | 256 KB |
| **Resident, steady state** | **≈ 360 KB** | **≈ 660 KB** |

<!-- VERIFY: the zstd ratio of ~3.6× is an assumption for English technical prose at level 19.
     Measure it on the first 50 entries; if it is closer to 2.5× the single-file build figures
     below move by about 40%. -->

Two comparisons worth holding onto:

- Doc 11 §14.2 puts a fully-parsed mid-size firewall at **≈ 1.1 MB resident**. **The entire v1
  corpus costs less resident memory than one parsed device.** The corpus is not the memory
  problem; provenance is.
- The offline single-file build embeds the corpus. At v1 that is ~320 KB compressed, ~427 KB once
  base64-encoded into the HTML; at v2, ~1.3 MB / ~1.8 MB. That is a real cost on the single-file
  deliverable and it argues for shipping one platform's corpus in the offline build rather than
  all of them — an open decision (§18, D2).

### 15.3 Latency targets

| Path | Target | Basis |
|---|---|---|
| Click → painted panel | < 16 ms | One frame. §11.7 |
| Resolution alone | < 1 ms | Matches 13 §12.6 |
| Depth toggle | < 8 ms | Re-render only |
| Misdiagnosis search, 12 results | < 5 ms | FST + fixed scoring |
| Cold corpus load (mmap + header parse) | < 40 ms | Bodies stay compressed until touched |

---

## 16. Failure modes of the corpus layer itself

| # | Failure | Symptom | Mitigation, and what it does not fix |
|---|---|---|---|
| 1 | The Tier-A gate is waived once, then always | `coverage_waiver` list grows every release | Waivers expire into build failures and appear in release notes. Does not fix a maintainer who keeps extending expiries |
| 2 | **Authors write to the linter, not to the reader** | Prose that passes 31 gates and teaches nothing (§5.5's example) | Review question 3; voice review item 9. **Nothing mechanical fixes this.** It is the single most likely quality failure |
| 3 | Depth drift | `explained` becomes truncated `teaching`; `terse` rots because nobody reads it while authoring | P10 catches prefix truncation, not paraphrase truncation. Write Terse last (§4.3) |
| 4 | Link accretion | Linking is free, writing is not; entries become hubs and answer less | G4 caps out-degree at 7; §7.4 forbids reviewers adding links. Does not cap link *quality* |
| 5 | The rail becomes the product | Users read explanations and stop reading the config | This is what teaching well costs. Depth defaults to Explained and the anchor stays pinned (§10.3), which limits it |
| 6 | Interpolation makes an entry false for one workspace | A slot fills with a value that makes the sentence untrue — "on this gateway that is `st0.0`" when the user has misconfigured `external-interface` to `st0.0` | Slots are noun-phrase-only and ≤ 4 per entry. Does not fix the case where the *fact* is what is wrong — arguably the entry should then say so, which is a rule's job |
| 7 | Localisation doubles the staleness surface | `de.yaml` lags `en.yaml` by two releases and nobody notices | 63 §14 makes missing keys a warning with English fallback. The honest answer is not to localise until the English corpus is stable |
| 8 | The gap queue becomes a backlog nobody triages | 900 open gaps, no signal | Cluster by subject and report the top 20 by count in the build report. A ranked list of 20 is a work queue; 900 is wallpaper |
| 9 | The two-reviewer requirement is quietly dropped under deadline | `voice_reviewed_by == reviewed_by` on entries where §6.2 forbids it | X4 checks it for classes other than `line` and `value`. Does not fix two people rubber-stamping each other |
| 10 | The corpus outlives the schema | `explain:field:IpsecPolicy.pfs` after the field is renamed | X2 fails the build. Renames need an alias entry, exactly as node ids do (11 §10.6) |

---

## 17. Rejected designs

| # | Rejected | Why | What rejecting it costs |
|---|---|---|---|
| R1 | One long text, summarised to Terse/Explained by a model at render time | Invariant 9 (non-deterministic output); §14.5's voice argument; the offline build has no model | Authoring cost stays at three texts per entry — roughly 2,100 pieces of writing for v1 |
| R2 | Three depths as three separate entries with three ids | They drift; coverage becomes three metrics; a depth toggle becomes a fetch | A single entry file is larger and its diffs are noisier |
| R3 | Explainers as a Markdown docs site the app links out to | Invariant 1 (no egress); the offline build cannot reach it; links rot; and the resolution ladder cannot address a URL | We maintain a bespoke content format instead of using a static site generator |
| R4 | Auto-escalating depth from dwell time or repeated clicks | Behavioural instrumentation in a product whose posture is that it watches nothing; and a UI that changes under you is worse than one that is too terse | The user has to press one key |
| R5 | Free wiki-style linking with no structure | §10.2's no-exit failure; and link gates become unenforceable without declared `rel` | Authors must classify every link, which is friction on the cheapest action |
| R6 | Explainers stored in the workspace alongside user content | The corpus is shipped content and the workspace is user data; mixing them makes every corpus update a workspace migration, and makes the encrypted document larger for no benefit | Users cannot write their own local explainers. Mitigated by the `notes` field the schema already has on every node |
| R7 | Generate `terse` from `explained` by extractive summarisation at build time | Deterministic, so it survives invariant 9 — and it still fails §4.3, because Terse answers a different question. It would produce a first-sentence-of-Explained corpus, which P10 exists to catch | This is the tempting one. Rejecting it keeps roughly a third of the authoring cost |
| R8 | A fourth depth ("reference") between Terse and Explained | Conventions fix the risk enum at three values and the design language is emphatic that the card's discipline is its three-way legend. Three depths, three risk levels, three semantic colours — the product has one number and it is three | Some content sits awkwardly between Terse and Explained |

---

## 18. Open decisions

| # | Decision | Options | Leaning |
|---|---|---|---|
| D1 | Is `value` a class, or a section inside `field`? | (a) class, as specified (b) a `variants:` map inside the `field` entry | (a). Clicking a value token must beat the knob's entry (§3.3), and a map inside a field entry cannot carry its own `platforms`/`versions` — `establish-tunnels responder-only` means different things on different platforms |
| D2 | Does the offline single-file build ship all platforms' corpora, or one? | (a) all (~1.8 MB base64 at v2) (b) one, chosen at build (c) one, with the others as sidecar files the user can add | (b) for the single-file build, (a) for Docker. Needs a decision before §12.5's P1 ships |
| D3 | Corpus as a separate signed artifact, or built into the app? | (a) separate, per §6.6 (b) built in | (a), already taken as a DECISION in §6.6, but flagged here because it adds a version matrix and someone should get to argue |
| D4 | Terminal distance ≤ 3 or ≤ 4? | — | 3, on one artifact's worth of evidence (§10.3). Revisit after the reference set: if more than ~10% of the 50 need a waiver, it is 4 |
| D5 | Does the Tier-A coverage veto apply to `status: draft` emitter statements? | (a) yes (b) no — draft statements are excluded from the denominator | (b), matching 63 §4.1's treatment of draft rules. But it creates a way to ship-by-labelling-draft, which needs a counter-check |
| D6 | Is the model fallback (§14.6) allowed in the sync build at all, or CLI-only? | (a) sync build, opt-in per workspace (b) CLI only (c) never | (a) with a hard default of off. (c) is defensible and I would not fight it |
| D7 | Should `rules_out` frequency be gated at the pack level? | (a) no gate (b) ≥ 25% of teaching entries | (a), per §8's argument that gating a rhetorical device produces ritual prose |
| D8 | Per-locale depth bounds | German runs ~20% longer; do the word bounds scale per locale, or do translations warn? | Warn, per 63 §14.1's precedent that truncating meaning is worse than wrapping |

---

## 19. Reconciliation with sibling documents

Three places where this document extends or normalises something a sibling wrote. None is a
contradiction; all three would otherwise cost an implementer a day.

**19.1 The resolution ladder.** Doc 13 §12.2 gives four steps (`line` → `field` → `kind` →
fall-through) with rule explainers appended. This document keeps that shape exactly and extends
it: thirteen classes rather than three, a token-role-driven cascade rather than a fixed one
(because clicking a value token must not resolve to the statement's entry), a rail category
system generalising the "rules are appended" rule, and a total tie-break order (§3.5) that doc 13
does not specify and invariant 9 requires.

**19.2 Shorthand ids in doc 18.** Doc 18 §4.3 uses ids that predate this grammar. They resolve
through a generated alias file; the alias file is closed, and gate X1 rejects any *new* id that
does not match §2.4.

| Written in 18 §4.3 | Canonical |
|---|---|
| `explain:ladder:guard` | `explain:step:junos-srx/ipsec.bringup/guard` |
| `explain:ladder:commit-failed` | `explain:step:junos-srx/ipsec.bringup/commit-failed` |
| `explain:sa.ike.state` | `explain:output:junos-srx/ike.sa.show#State` |
| `explain:sa.ipsec.state` | `explain:output:junos-srx/ipsec.sa.show#State` |
| `explain:ipsec.down-reason` | `explain:output:junos-srx/ipsec.inactive-tunnels#TunnelDownReason` |
| `explain:decoder:no-proposal-p1` | `explain:error:junos-srx/NO_PROPOSAL_CHOSEN.p1` |
| `explain:decoder:no-proposal-p2` | `explain:error:junos-srx/NO_PROPOSAL_CHOSEN.p2` |
| `explain:decoder:auth-failed` | `explain:error:junos-srx/AUTHENTICATION_FAILED` |
| `explain:decoder:p1-timeout` | `explain:symptom:p1-timeout-nothing-in-log` |
| `explain:st0.state` | `explain:output:junos-srx/interface.st0.terse#Admin/Link` |
| `explain:route.via-st0` | `explain:output:junos-srx/route.show#next-hop` |
| `explain:ping.through-tunnel` | `explain:command:junos-srx/ping.sourced` |
| `explain:flow.sessions` | `explain:output:junos-srx/flow.session.show#sessions` |
| `explain:plumbing:no-route` | `explain:symptom:up-but-zero-traffic` |
| `explain:plumbing:up-but-no-traffic` | `explain:symptom:up-but-zero-traffic` |

The last two mapping to one entry is not an accident of this table — they are the same symptom
reached from two rungs, which is exactly what the `symptom` class is for.

**19.3 Depth bounds.** Doc 63 §11 gives character bounds for *rule-embedded* explainers
(`terse` ≤ 80, `explained` 80–400, `teaching` ≥ 200 characters). §4.1's bounds are stated in
words and are **compatible with, and narrower than**, doc 63's for the shared range: 16 words
≤ 80 chars; 25–60 words is 160–400 chars; 70 words > 200 chars. Where they differ, doc 63's
apply to entries inside a rule pack (which render in a finding row) and §4.1's apply to
standalone entries (which render in the rail). The linter selects the bound set from the entry's
origin, not from its class.

---

## 20. Sources consulted

| Source | Used for |
|---|---|
| `.context/field-card-srx-ipsec.txt` (owner's SRX IPsec field card, 4 sides) | Every worked example, the depth word counts (§4.2), the counterfactual device (§5.1), the style guide's evidence column (§8), the concept-graph worked chain (§10.6), and the v1 denominators (§12.1) |
| `.context/design-language.md` § *Voice*, *Structure*, *What the card never does* | §8 in its entirety; the UI surfaces (§11.2); the no-fourth-colour constraint on the model fallback (§14.6) |
| `.context/owner-brief.md` §§ 2.1, 4.1, 5.2, 5.4, 6.1, 6.3 | The pillar's definition, the three depths, the vocabulary gap, the finder-first phasing |
| `docs/10-core/11-ir-schema.md` §§ 5.2, 6, 14.2 | `Presence` semantics for §3.4 and §6.5; the machine-counted kind and field totals; the memory comparison |
| `docs/10-core/12-rule-engine.md` §§ 3, 13 | The `fex` expression language reused for `applies_when`; the pack signing chain reused in §6.6 |
| `docs/10-core/13-emitters-and-provenance.md` §§ 2, 3, 4, 12 | `EmittedLine`, `StatementPath`, blocks, and the four-step ladder this document extends |
| `docs/10-core/18-diff-verify-rollback.md` §§ 4.3, 6.3 | Ladder step ids (§19.2); the change ticket recording its render depth (§11.3) |
| `docs/60-content/63-rulepack-spec.md` §§ 2, 3, 4, 11, 12, 14, 19 | Pack layout, prose bounds, citation forms, localisation, and the validation-table style |
| RFC 7296 §1.3 | CREATE_CHILD_SA may carry a KE payload for a fresh DH — the PFS entry's citation, using the correction proposed in 63 §20 |
| RFC 8247 §2.4 | DH group requirements, via 63 §17.1 |
| RFC 3706 | *A Traffic-Based Method of Detecting Dead IKE Peers* — the DPD entry. Informational; IKEv1-era, which is why the card's *"DPD bolted on / built in"* row is correct |
| RFC 7296 §2.4 | IKEv2 liveness is built in |
| RFC 3948 | *UDP Encapsulation of IPsec ESP Packets*; port 4500 shared with IKE — the NAT-T +8 bytes |
| RFC 1191 | Path MTU discovery |
| Automated Readability Index — `4.71(chars/words) + 0.5(words/sentences) − 21.43`, output as a US grade level, character-based rather than syllable-based | §9.4's metric choice |
| `rust_readability` (crates.io) — implements ARI, Flesch, Flesch-Kincaid, Coleman-Liau, Lix, Rix, Linsear Write | §9.4, as evidence the metric is available in-ecosystem; the recommendation is still to implement and pin ARI directly |
| Vale (vale.sh) — markup-aware prose linter; YAML rules with extension points including existence, substitution, occurrence, capitalisation, metric, spelling | §9.1's prior art. Not a dependency |

---

## 21. Disagreements

**None with `conventions.md`.**

Three notes recorded so they are not mistaken for deviations:

1. **Invariant 10 is strengthened, not weakened.** Conventions require a named human
   `reviewed_by` for model output in the corpus. This document adds a second named reviewer for
   voice (§7.2 stage 4), forbids model authorship of `breaks_if_wrong` and `misdiagnosed_as`
   entirely (§14.3), and measures rubber-stamping (§14.4). Strictly narrower than the invariant.

2. **The `os_version: Unknown` asymmetry (§3.4)** — rules fail closed and explainers fail open —
   is an extension, not a contradiction. Doc 11 §6.3 makes an unknown version render a
   version-predicated rule `Unevaluable`, which is correct for a claim. An explainer is not a
   claim about the user's device; refusing to explain a field until the version is entered would
   make the teaching pillar hostile to the exact user it exists for. This is the only place the
   two engines are treated differently, and it is deliberate.

3. **`sources` versus `provenance`.** This document follows 63 §21: `sources` are citations on a
   corpus entry, `provenance` is how a value entered the graph. They never appear on the same
   object. Where both occur in one sentence here, they are labelled.

One **proposed change to a sibling document**, following the conventions' rule that a
contradiction be stated rather than silently resolved:

> **Doc 13 §12.2's ladder should adopt §3.3's token-role cascade.** As written, step 1 is always
> `explain:line:…`, which resolves a click on the token `group14` to an explanation of the
> `perfect-forward-secrecy keys` statement rather than to an explanation of group 14. That is the
> wrong answer for the most common click in the product — clicking a value — and it becomes a
> visible defect the moment `value` entries exist. The fix is small and local: classify the token
> from the span it lands in, and pick the cascade from the role. Doc 13's four steps are
> otherwise unchanged and remain the `Keyword` cascade exactly.
