# 18 — Diff, verification and rollback

> **Status:** Proposed

Companion documents: `docs/10-core/11-ir-schema.md` (the graph),
`docs/10-core/12-rule-engine.md` (findings, and the natural-key reconciliation this reuses),
`docs/10-core/13-emitters-and-provenance.md` (`EmittedLine`, `StatementPath`, ordering —
this document is unreadable without §3 and §5 of that one).

Owner brief §6.7, in full:

> *"Because the tool knows what it just built, it can emit the verification ladder and the
> rollback for that specific change — the exact commands to prove it worked, and the exact
> commands to back it out. This is the existing Bring-Up Order block, generated per-change
> rather than generic, and paste-ready into a change ticket. This is a small feature that
> makes the tool legible to change-management processes, which matters more for adoption
> than it sounds."*

It is not a small feature. It is four subsystems — a semantic graph diff, a config diff that
derives a minimal change set, a ladder engine that prunes a decision tree against a change,
and a rollback generator that has to be honest about what it cannot invert — and the last of
those is where most of the design risk sits.

```
runbook = verify(diff(graph))
```

---

## 0. Contents

| § | |
|---|---|
| 1 | The four questions, and the shape of the answer |
| 2 | Graph diff |
| 3 | Config diff — the hard part |
| 4 | The verification ladder as a directed graph |
| 5 | Rollback generation |
| 6 | The change ticket |
| 7 | Worked example — adding PFS to a live tunnel |
| 8 | Complexity and budget |
| 9 | Failure modes |
| 10 | Open decisions |
| 11 | Sources consulted |
| 12 | Disagreements |

---

## 1. The four questions, and the shape of the answer

A change ticket answers four questions and a good one answers them in this order:

| Question | Produced by | Section |
|---|---|---|
| What am I changing, in terms a reviewer understands? | graph diff | §2 |
| What exactly do I paste? | config diff | §3 |
| How do I know it worked? | ladder | §4 |
| How do I get back? | rollback | §5 |

Everything in this document is a projection of `GraphDiff`. That is deliberate and it is the
same bet the owner made about the graph: one structure, several renderings. The alternative
— a diff for the UI, a separate change-set generator, a separate runbook builder — produces
three things that disagree about what changed, which is the failure mode that makes change
tooling untrusted.

### 1.1 Two things this is not

| Not | Because |
|---|---|
| A compliance engine | We compare two states of *our* graph, or our graph against a pasted config. We never compare against a device, because invariant 2 says we never touch one. Nautobot Golden Config does intended-vs-actual (owner brief §3.2); we do intended-vs-intended and intended-vs-pasted. |
| A deployment tool | The output is text. There is no apply, no orchestration, no ordering across devices enforced by anything but the words in the ticket. Where a change must land on two boxes inside one window (§7 is exactly that case) we say so in prose and the human owns it. |

---

## 2. Graph diff

### 2.1 Why not a text diff

A text diff over two emitted configs is available for free and it is wrong for four
independent reasons:

| Reason | Concretely |
|---|---|
| It cannot tell a value change from a delete plus an add | `lifetime-seconds 28800` → `3600` reads as `-1 +1` with no relation between them. |
| It cannot produce a paste | You cannot paste "this line is gone". You need `delete security ike proposal IKE-P1 lifetime-seconds`. Deriving that requires the structure the text diff threw away. |
| It is sensitive to ordering and rendering | Emitter §5 sorts output; a block-rank change reorders hundreds of lines and the text diff reports hundreds of changes. `WrapPolicy` changes every line. |
| It has no risk model | Every line is equal in a text diff. In this product the whole point is that one of those lines drops live traffic and the other does not. |

The graph diff is the semantic one. The config diff (§3) is derived *from* it plus the two
emits, not from the two texts.

### 2.2 Matching nodes across versions

The precondition for a semantic diff is knowing which node in `B` corresponds to which node
in `A`. Three tiers, tried in order, and the third is never applied without a human.

#### Tier 1 — by ULID

Both versions descend from the same workspace lineage, so a node with ULID `X` in `A` and
ULID `X` in `B` is the same node. Exact, `O(1)` per node, and it covers every diff between
two revisions of one workspace — the common case by a wide margin.

This is invariant 7 paying for itself. If nodes were keyed by name, a device rename would
make every node in the diff look new.

#### Tier 2 — by natural key

Needed whenever the two sides did not share a lineage:

- comparing the workspace against a freshly pasted `show configuration | display set`;
- comparing two sites' configurations against each other;
- comparing a device against a golden template.

The natural-key machinery already exists — rule engine §11.4 defines
`NaturalKeyHash = blake3_128(kind_name || 0x00 || canonical_join(identity_values))` and the
per-kind `identity` tuples (`IkeGateway` → `device.nk`, `name`; `TrafficSelector` →
`vpn.nk`, `name`; and so on). The diff reuses it verbatim. Building a second identity scheme
here would guarantee that a suppression and a diff disagree about whether two nodes are the
same node.

`O(N)` with a hash map.

#### Tier 3 — structural similarity, as a *suggestion only*

When tiers 1 and 2 leave residue — a node in `A` unmatched and a node in `B` unmatched — we
score candidate pairings and offer the best ones to the user.

```
score(a, b) =  0.40 · field_agreement(a, b)          # fraction of set fields with equal values
             + 0.25 · edge_agreement(a, b)           # fraction of typed neighbours already matched
             + 0.20 · name_similarity(a, b)          # normalised Damerau-Levenshtein on the identity field
             + 0.15 · position(a, b)                 # same parent, same ordinal
```

Only pairs above 0.70 are offered, only the best candidate per node is offered, and
**nothing is applied automatically.** The weights are a starting point and they are not
derived from anything — they are a guess that will need tuning against real re-parses, and
saying so is better than presenting them as a result.

The failure mode if tier 3 were automatic: two IKE gateways renamed and re-pointed in one
change get cross-matched, and the diff reports two small edits where the truth is two
deletes and two adds. A reviewer approves it, and the ticket's rollback is wrong for both.
That is a bad enough outcome to make the human confirmation non-negotiable.

### 2.3 The type

```rust
pub struct GraphDiff {
    pub base:   RevRef,       // workspace revision, or a parsed-config identity
    pub target: RevRef,
    pub nodes: Vec<NodeDelta>,        // sorted by (kind ordinal, node ULID)
    pub edges: Vec<EdgeDelta>,        // sorted by (role ordinal, from ULID, to ULID)
    pub unmatched: Unmatched,         // tier-3 residue the user did not resolve
    pub summary: DiffSummary,
}

pub enum NodeDelta {
    Added   { node: NodeId, kind: KindId, fields: SmallVec<[FieldDelta; 8]> },
    Removed { node: NodeId, kind: KindId, /* last known state, for rollback */
              snapshot: NodeSnapshot },
    Changed { node: NodeId, kind: KindId, fields: SmallVec<[FieldDelta; 4]> },
    /// A `Changed` on the kind's identity field, promoted to its own variant
    /// because it is the one reviewers must not skim past, and because the
    /// emitted change set for a rename is a delete plus an add (emitter §2.3).
    Renamed { node: NodeId, kind: KindId, from: CompactString, to: CompactString,
              fields: SmallVec<[FieldDelta; 4]> },
    /// Re-parented. Distinct from Removed+Added because the node kept its
    /// identity and its suppressions.
    Moved   { node: NodeId, kind: KindId, from_parent: NodeId, to_parent: NodeId },
}

pub struct FieldDelta {
    pub field: FieldId,
    pub before: PresenceRepr,   // the four states, rendered
    pub after:  PresenceRepr,
    pub class:  DeltaClass,
    /// Provenance of the *after* value: who changed it and how.
    pub prov: ProvenanceId,
}

pub enum EdgeDelta {
    Added   { role: EdgeRoleId, from: NodeId, to: NodeId, fields: SmallVec<[FieldDelta; 2]> },
    Removed { role: EdgeRoleId, from: NodeId, to: NodeId, snapshot: EdgeSnapshot },
    Changed { role: EdgeRoleId, from: NodeId, to: NodeId, fields: SmallVec<[FieldDelta; 2]> },
    /// The dependent kept its identity and now points somewhere else.
    /// `IpsecVpn --UsesIkeGateway--> GW-B` becomes `--> GW-C`.
    Repointed { role: EdgeRoleId, from: NodeId, old_to: NodeId, new_to: NodeId },
}
```

`Removed` carries a `snapshot`. That is the single most important field in this type and it
exists for exactly one consumer: §5. **You cannot generate a rollback from a change set; you
can only generate it from a diff, because only the diff knows what was there before.**

### 2.4 `DeltaClass` — did this tighten or loosen?

```rust
pub enum DeltaClass {
    /// The change makes the security posture stricter or the failure
    /// domain smaller.
    Tighten,
    Loosen,
    /// Neither, or not comparable.
    Neutral,
    /// The schema declares no comparator for this field.
    Unknown,
}
```

Declared per field in the corpus, with a comparator and a citation. Examples:

```yaml
- kind: IpsecPolicy
  field: perfect_forward_secrecy
  comparator: presence_is_tighten     # Absent -> Set is Tighten; Set -> Absent is Loosen
  citation: "field card side 2 — 'One compromised IKE SA secret unlocks every data key derived under it'"
  reviewed_by: <named human>

- kind: IkeProposal
  field: dh_group
  comparator: ordinal_higher_is_tighten
  ordinal: { Modp1024: 10, Modp1536: 20, Modp2048: 30, Ecp256: 40, Ecp384: 50 }
  citation: "field card side 2 — 'group14 (2048) baseline; group2 and group5 are legacy'"
  reviewed_by: <named human>

- kind: IpsecProposal
  field: lifetime_seconds
  comparator: lower_is_tighten
  citation: "RFC 7296 §2.8 — rekeying limits exposure per key"
  reviewed_by: <named human>
```

**RECOMMENDATION — `Unknown` is the default and a field without a declared comparator stays
`Unknown` forever until someone writes one.** A wrongly-labelled `Tighten` is worse than no
label: it tells a reviewer the change is safe in the direction they care about, which is
precisely the sentence they will quote back at you afterwards. `dh_group` is easy;
`establish_tunnels` is not (`immediately` is tighter for a monitored tunnel and noisier for
an idle backup — the card says both), and that one should stay `Unknown`.

### 2.5 The algorithm

```
graph_diff(A, B) -> GraphDiff:
  # 1. pair
  pairs = {}
  for a in A.nodes:  if B.has(a.id): pairs[a.id] = a.id          # tier 1
  ua = A.nodes \ pairs.keys ;  ub = B.nodes \ pairs.values
  for a in ua:  if b = ub.find_by_nk(a.nk): pairs[a.id] = b.id   # tier 2
  residue = (ua, ub) minus tier-2 matches                        # tier 3 -> user

  # 2. node deltas
  for (a, b) in pairs (iterated in A-ULID order):
      fd = []
      for f in schema.fields(kind_of(a)):                        # schema order, not hash order
          if A.field(a,f) != B.field(b,f):
              fd.push(FieldDelta { .., class: classify(f, before, after) })
      if fd non-empty:
          if identity_field(kind) in fd:  Renamed{..} else Changed{..}
      if parent(a) != parent(b):  also Moved{..}
  for b in ub_unmatched: Added   { snapshot of B }
  for a in ua_unmatched: Removed { snapshot of A }

  # 3. edge deltas — same shape, keyed on (role, from, to)
  # 4. sort deterministically, summarise
```

**Complexity.** `O(N_A + N_B)` for tiers 1–2, `O(Σ fields)` for the field walk, `O(E_A + E_B)`
for edges, plus `O(D log D)` to sort the deltas, where `D` is the delta count. Tier 3 is
`O(|ua| · |ub|)` in the worst case and is capped: if either residue exceeds 200 nodes we
stop scoring and present the residue unpaired, because a 200×200 scoring matrix presented to
a human is not a review, it is a formality.

**Determinism.** Field iteration is in schema declaration order; node iteration in ULID
order; deltas sorted by a total key. No hash iteration anywhere. Invariant 9.

### 2.6 Rendering

The field card's table grammar: two columns, horizontal hairlines only, no vertical rules,
left column is the lookup key.

```
CHANGED   IpsecPolicy  IPSEC-POL                            on srx-a

  perfect-forward-secrecy      —                →  keys group14      tighten
  proposals                    IPSEC-P2         →  IPSEC-P2          ·

CHANGED   IkeGateway   GW-B                                 on srx-a

  dead-peer-detection interval 10               →  20                loosen
```

**Colour, explicitly.** Conventions forbid reusing the risk palette for diff. So:
`#14171A` ink for the after value, `#5C6772` muted for the before, a `→` in muted, and the
`tighten` / `loosen` label as a muted lowercase margin word — the card's margin-tab
treatment. No red, no green, no `+`/`-` gutter in colour. The `Risk` colours appear in this
document in exactly one place: the config block in §6, on the emitted lines, where they mean
what they have always meant.

---

## 3. Config diff — the hard part

### 3.1 The problem

Given `GraphDiff(A → B)` and a platform, produce the **smallest ordered set of pasteable
lines** that moves a device configured as `A` to `B`.

The naive approach — emit both, text-diff, hand-wave the deletions — fails for the reasons in
§2.1. The correct approach uses the structure emitter §3 already built.

### 3.2 The key insight: `StatementPath` is a primary key

Emitter §3 property P2: no two lines in one emit share a `StatementPath`. So an emit is
exactly a **map** from path to line, and a config diff is a map difference. Everything else
in this section is handling the ways a map difference is not quite enough.

```rust
type LineIndex = BTreeMap<StatementPath, EmittedLine>;   // BTree, not Hash: ordered iteration
```

`BTreeMap` rather than `HashMap` is a determinism decision, not a performance one. Ordered
iteration falls out of the container instead of out of a sort we might forget.

### 3.3 The algorithm

```
config_diff(A, B, plat, gd) -> ChangeSet:

  LA = index(emit(A, plat))
  LB = index(emit(B, plat))

  # --- 0. refuse to proceed on an unsound base --------------------------
  if emit(B).report.blockers non-empty:  return Refused(Blockers)

  ops: Vec<Op> = []

  # --- 1. additions and value changes -----------------------------------
  for (p, lb) in LB:                              # ordered iteration
      match LA.get(p):
          None                        -> ops.push(Op::Add(lb))
          Some(la) if la.text != lb.text
                                      -> ops.push(Op::Change(la, lb))
          Some(_)                     -> ()       # identical: emit NOTHING

  # --- 2. removals -------------------------------------------------------
  gone = { p : p in LA, p not in LB }
  gone = subsume(gone, plat)                      # §3.5
  for p in gone.iter().rev():                     # deepest first
      ops.push(Op::Remove(LA[p], scope_of(p, gone)))

  # --- 3. ordered-list repair -------------------------------------------
  ops.extend(reorder_ops(LA, LB, plat))           # §3.6

  # --- 4. lower ops to lines --------------------------------------------
  lines = ops.flat_map(|o| lower(o, plat))        # §3.4

  # --- 5. guard, commit, verify -----------------------------------------
  lines = guard(plat) ++ lines ++ commit(plat)    # §5.5

  # --- 6. order (emitter §5.6) ------------------------------------------
  lines = order(lines, deps(lines, gd), plat)

  # --- 7. self-check -----------------------------------------------------
  assert_reaches_b(A, lines, B, plat)             # §3.8 — refuse to export on failure

  ChangeSet { lines, aggregate_risk, rollback: rollback(gd, LA, LB, plat), .. }
```

Step 1's third arm is the one that makes the output small: **a statement whose text is
unchanged produces nothing.** That is what distinguishes a change set from a full config.

### 3.4 `lower` — turning an op into lines, and where `Idempotency` decides

This is the part that is easy to get subtly wrong and produces configurations that look
right.

| Op | `Idempotency` of the statement | Lowered to |
|---|---|---|
| `Add(lb)` | any | one `Assert(lb)` |
| `Change(la, lb)` | `Idempotent` | one `Assert(lb)`. The new value overwrites. |
| `Change(la, lb)` | `Replacing` | one `Assert(lb)`, **plus** a report note: sub-fields of the old statement that `lb` does not restate are gone. |
| `Change(la, lb)` | **`Accumulating`** | **two lines**: `Retract(la.path)` then `Assert(lb)`. A single `Assert` would *add* a member, not replace one. |
| `Change(la, lb)` | `NonIdempotent` | blocked → `DiffHazard::NonIdempotentChange`. Needs a human. |
| `Remove(la, Leaf)` | any | one `Retract(la.path, Leaf)` |
| `Remove(la, Subtree)` | any | one `Retract(p, Subtree)` if `plat.supports_subtree_retract()`, else the explicit per-object negation list |

**The `Accumulating` case is the trap.** Emitter §2.5: `proposals` is a leaf-list, and
`set security ike policy IKE-POL proposals IKE-P2` on a policy that already has `IKE-P1`
leaves you with two proposals. The device commits, the tunnel comes up, and the negotiation
offers whichever it picks. The card's own complaint about `proposal-set standard` — *"you
cannot see what it offered without the docs"* — is this same problem arriving by a different
route, and a config-diff implementation that emits one line here reproduces it.

Note that the correct `Retract` for an accumulating statement includes the member:
`delete security ike policy IKE-POL proposals IKE-P1`, not `delete … proposals`. The
statement table's `retract_needs_value` (emitter §2.5) decides.

### 3.5 `subsume` — the deletion minimisation

If a whole `IkeGateway` is removed, we want one line, not eleven.

```
subsume(paths, plat) -> paths:
    if !plat.supports_subtree_retract():  return paths      # IOS: no prefix delete
    sorted = paths.sorted()                                 # lexicographic; parents precede children
    out = []
    for p in sorted:
        if out.last() is a proper prefix of p:  continue    # covered
        out.push(p)
    return out
```

`O(n log n)` for the sort, `O(n)` for the walk.

**The correctness precondition, and it is not free.** Subsumption is only sound if the
prefix path being retracted is *fully* being removed — i.e. every statement under it in `A`
is in `gone`. Otherwise `delete security ike gateway GW-B` removes statements we intended to
keep. So:

```
sound = ∀ p in out : { q in LA : out_prefix_of(p, q) } ⊆ gone
```

Checked, not assumed. When it fails we fall back to per-leaf deletes for that subtree and
record why in the report. The check is one range scan per candidate prefix over the
`BTreeMap`, so `O(|LA|)` total.

**Second precondition: the graph must have modelled the whole subtree.** If `A`'s
`IkeGateway` node has `Unknown` fields, then `LA` does not contain lines for them, `gone`
cannot contain them, and the soundness check above passes *vacuously* while the device has
statements we never knew about. A subtree retract then deletes more than we can account for.
This is not a bug we can fix with a better check — it is a consequence of a partial graph
(schema §9) — so it is surfaced:

> `delete security ike gateway GW-B` removes everything under `GW-B`. Fathom modelled 7
> statements there. If the device has others, they go too.

and `Reversibility::Partial { unmodelled }` propagates into §5.

### 3.6 Ordered lists

Junos security policies inside a zone pair are evaluated in configuration order, and the
card's plumbing piece #5 creates one. PAN-OS security rules are the same. IOS ACLs use
sequence numbers.

A pure path-keyed diff cannot see order at all: the policies are all present, all
unchanged, and in a different sequence. So ordered-list membership needs its own pass.

```rust
pub enum ReorderOp {
    /// Junos `insert security policies from-zone A to-zone B policy P before policy Q`
    Insert { list: StatementPath, member: CompactString, rel: InsertRel, anchor: CompactString },
}
```

Algorithm: for each ordered list that appears in both `A` and `B`, compute the **longest
common subsequence** of the member sequences; every member not in the LCS needs one move.
That is the minimum number of moves, and it is `O(n²)` in list length by classic LCS — fine,
because a zone-pair policy list of more than a few hundred entries is a different product
problem.

Two honest limits:

| Limit | |
|---|---|
| `insert` requires the anchor to exist | So reorder ops go in `Phase::C` on `CandidateResolved` platforms, after every `Assert` has created the members. Emitter §5.4 already places them there. |
| A reorder in a live policy list changes what is permitted, instantly, at commit | `Risk::Disruptive` unless the LCS shows the moved members are non-overlapping with everything they crossed — which requires match-criterion overlap analysis we do not have. Default `Disruptive`, and say why. |

### 3.7 What "minimal" means here, and what it does not

**We produce the minimum change set with respect to the statement-path decomposition.** That
is a checkable property: no line in the output can be removed without the result failing
§3.8's self-check.

It is **not** globally minimal. A counterexample: four field changes on one Junos object are
four `set` lines from us, and could be one `load replace` stanza. We choose four, and the
reason is the whole product:

| Four `set` lines | One `load replace` stanza |
|---|---|
| Each line individually risk-classified | The stanza gets one risk, which is the max, so three safe changes inherit the dangerous one's label |
| Each line individually explicable (emitter §12) | One click target for four facts |
| Each line individually invertible (§5) | The inverse is another whole stanza |
| Longer output | Shorter output |
| Merges with whatever else is on the box | **Deletes anything in the stanza we did not model** |

That last row is the disqualifying one for a partially-populated graph. `load replace`
replaces the marked stanza wholesale; any statement in it that Fathom never knew about is
silently removed. Owner brief §6.4 says the graph is partial by construction, so `load
replace` from a hand-built graph is a config-destroying operation dressed as a tidy one.

**DECISION — `load replace` export exists, is off by default, and is gated on full-parse
provenance.** It is offered only when every node in the affected stanza carries
`Origin::Parsed` from a single capture, and the export banner says: *this replaces the whole
stanza; anything the capture did not contain will be removed.*

### 3.8 The self-check — the property that makes this trustworthy

We cannot apply the change set to a device. We can apply it to ourselves.

> **D1 — the change set reaches B.**
> ```
> parse( render(emit(A)) ++ render(config_diff(A, B)) )  ≡path  emit(B)
> ```
> where `≡path` is equality of the path-keyed `LineIndex` — same paths, same texts.

This runs **at runtime, on every change set**, not only in CI, and a change set that fails it
is not exportable. The cost is one parse of text we just generated: `O(|A| + |Δ|)`,
microseconds at the sizes in §8. For that price we get a machine-checked guarantee that the
lines in the ticket produce the configuration in the diff — which is the single claim a
change reviewer is implicitly trusting.

Two things D1 does not prove, stated so nobody over-reads it:

- **It does not prove the device ends in state B.** It proves *our model of the device* does.
  If our parser and the box disagree about a statement's effect, D1 passes and the box is
  wrong. Only the fixture suite (emitter §11.3) and real use narrow that gap.
- **It says nothing about the path taken.** A change set can reach B while passing through a
  state that drops traffic. That is what `Risk` and the ordering regime (emitter §5.4) are
  for, and neither is checkable by D1.

Two supporting properties, both CI-only:

> **D2 — empty diff.** `config_diff(A, A)` contains no configuration lines. Only the guard
> and commit lines, and with `include_guard: false` it is empty. A diff engine that emits
> spurious lines for an unchanged graph is one nobody will run twice.

> **D3 — round trip.** `config_diff(B, A)` applied after `config_diff(A, B)` returns the
> line index to `emit(A)`, **for the subset of changes whose `Reversibility` is
> `Mechanical`.** The qualifier is the whole of §5.

---

## 4. The verification ladder as a directed graph

### 4.1 The card is already a decision tree

Side 1, `BRING-UP ORDER`:

```
1 commit confirmed 5 — always, remotely
2 ike security-associations      P1 up?
3 ipsec security-associations    P2 installed?
4 ipsec inactive-tunnels         if not, why
5 show interfaces st0.0 terse    up?
6 show route <remote>            via st0?
7 ping across, sourced from the LAN side
8 show security flow session     real sessions?
9 show log kmd | match <peer>    the story

Stop at the first failure. Steps 5–8 failing while 2–4 are clean is plumbing, not
crypto — no proposal tweaking will fix it.
```

That is a spine with `on_pass` edges and a stopping rule. Side 3's `VERIFY LADDER` gives the
detail commands. Side 3's `ERROR DECODER` is the `on_fail` edge table:

| In the log | Go look at |
|---|---|
| `NO_PROPOSAL_CHOSEN (P1)` | `dh-group`, encryption, hash, `authentication-method` |
| `NO_PROPOSAL_CHOSEN (P2)` | PFS group, ESP algorithms, esp vs ah |
| `INVALID_KE_PAYLOAD` | DH group mismatch — P1 `dh-group` or PFS `keys` |
| `TS_UNACCEPTABLE` | Traffic selectors do not mirror (v2) |
| `INVALID_ID_INFORMATION` | Proxy-ID mismatch (v1) |
| `AUTHENTICATION_FAILED` | PSK, cert chain, clock skew — or identity |
| `IKE-ID validation failed` | `local-identity` / `remote-identity` |
| Phase-1 timeout, no response | `host-inbound ike`, upstream ACL, peer address, NAT |
| Bad SPI / `INVALID_SPI` | ESP for an SA we no longer hold |

And side 3's `FLAP PATTERN → CAUSE` is a second ladder rooted at a different symptom. None
of this needs inventing. It needs encoding.

### 4.2 The type

```rust
pub struct Ladder {
    pub id: LadderId,
    pub entry: StepId,
    pub steps: BTreeMap<StepId, Step>,     // BTree: deterministic iteration
}

pub struct Step {
    pub id: StepId,
    /// Command corpus id — conventions: `<platform>/<dotted-path>`.
    pub cmd: CommandId,
    /// Interpolation slots filled from the diff's bindings (§4.4).
    pub args: SmallVec<[ArgSlot; 3]>,
    pub risk: Risk,
    /// The card's `read_field`: what to look at in the output.
    pub expect: Expectation,
    pub on_pass: Option<StepId>,
    /// Ordered. First matching branch wins; `Always` is the fallback.
    pub on_fail: SmallVec<[Branch; 3]>,
    /// Include this step only if the guard holds over the diff (§4.5).
    pub gate: Option<Gate>,
    /// The card's margin-tab voice, e.g. "the underused one".
    pub tab: Option<&'static str>,
}

pub struct Expectation { pub field: &'static str, pub want: WantRepr, pub explain: ExplainKey }

pub struct Branch { pub when: Signal, pub goto: Goto }

pub enum Signal {
    /// A token in the log or in command output. The error decoder.
    Token(&'static str),
    /// A named field of the parsed output differs from `expect`.
    Field { field: &'static str, is: WantRepr },
    /// No signal — the catch-all.
    Always,
}

pub enum Goto {
    Step(StepId),
    /// Terminal: the answer is prose, not another command.
    Explain(ExplainKey),
    /// Terminal: this is a known finding; open it, with its remediation.
    Rule(RuleId),
    Stop(StopReason),
}
```

`Goto::Rule` is the join between the ladder and the rule engine. `INVALID_KE_PAYLOAD` →
`ipsec.pfs.group-mismatch` means the ladder does not merely tell you where to look; it opens
the finding, with its `why`, its `acceptable_when`, and its remediation patch — which is
itself an emitted change set with its own ladder. The loop closes.

### 4.3 The corpus form

Authored YAML, reviewed by a named human, versioned with the rest of the corpus.

```yaml
id: ladder:junos-srx/ipsec.bringup
title: BRING-UP ORDER
source: "field card side 1"
reviewed_by: <named human>
entry: guard

steps:

  guard:
    cmd: junos-srx/config.commit-confirmed
    args: [{ slot: minutes, const: 5 }]
    risk: ChangesConfig
    tab: "always, remotely"
    expect: { field: "commit complete", want: present, explain: explain:ladder:guard }
    on_pass: p1
    on_fail:
      - when: { Token: "error: configuration check-out failed" }
        goto: { Explain: explain:ladder:commit-failed }

  p1:
    cmd: junos-srx/ike.sa.show
    args: [{ slot: peer, from: "gateway.address" }]
    risk: ReadOnly
    expect: { field: "State", want: "UP", explain: explain:sa.ike.state }
    on_pass: p2
    on_fail:
      - when: { Token: "NO_PROPOSAL_CHOSEN" }
        goto: { Explain: explain:decoder:no-proposal-p1 }
      - when: { Token: "AUTHENTICATION_FAILED" }
        goto: { Explain: explain:decoder:auth-failed }
      - when: { Token: "IKE-ID validation failed" }
        goto: { Rule: ike.identity.mismatch }
      - when: Always
        goto: { Step: p1-timeout }

  p1-timeout:
    cmd: junos-srx/log.kmd.match-peer
    args: [{ slot: peer, from: "gateway.address" }]
    risk: ReadOnly
    tab: "the story"
    expect: { field: "-", want: any, explain: explain:decoder:p1-timeout }
    on_fail:
      - when: Always
        goto: { Rule: zone.host-inbound.ike-missing }

  p2:
    cmd: junos-srx/ipsec.sa.show-vpn-detail
    args: [{ slot: vpn, from: "vpn.name" }]
    risk: ReadOnly
    expect: { field: "State", want: "Installed", explain: explain:sa.ipsec.state }
    on_pass: st0
    on_fail:
      - when: Always
        goto: { Step: inactive }

  inactive:
    cmd: junos-srx/ipsec.inactive-tunnels
    risk: ReadOnly
    tab: "the underused one"
    expect: { field: "Tunnel Down Reason", want: any, explain: explain:ipsec.down-reason }
    on_fail:
      - when: { Token: "NO_PROPOSAL_CHOSEN" }
        goto: { Explain: explain:decoder:no-proposal-p2 }
      - when: { Token: "INVALID_KE_PAYLOAD" }
        goto: { Rule: ipsec.pfs.group-mismatch }
      - when: { Token: "TS_UNACCEPTABLE" }
        goto: { Rule: ipsec.traffic-selector.not-mirrored }

  st0:
    cmd: junos-srx/interface.st0.terse
    args: [{ slot: unit, from: "vpn.bind_interface" }]
    risk: ReadOnly
    gate: { touches: [LogicalUnit, IpsecVpn.bind_interface, Zone] }
    expect: { field: "Admin/Link", want: "up/up", explain: explain:st0.state }
    on_pass: route
    on_fail: [{ when: Always, goto: { Rule: tunnel.st0.zone-unbound } }]

  route:
    cmd: junos-srx/route.show
    args: [{ slot: prefix, from: "selector.remote" }]
    risk: ReadOnly
    gate: { touches: [StaticRoute, TrafficSelector, LogicalUnit] }
    expect: { field: "next-hop", want: "st0.*", explain: explain:route.via-st0 }
    on_pass: ping
    on_fail: [{ when: Always, goto: { Explain: explain:plumbing:no-route } }]

  ping:
    cmd: junos-srx/ping.sourced
    args:
      - { slot: dest,   from: "selector.remote_probe" }
      - { slot: source, from: "lan.address" }
    risk: ReadOnly
    gate: { touches: [TrafficSelector, StaticRoute, SecurityPolicy, Zone] }
    expect: { field: "packet loss", want: "0%", explain: explain:ping.through-tunnel }
    on_pass: sessions
    on_fail: [{ when: Always, goto: { Explain: explain:plumbing:up-but-no-traffic } }]

  sessions:
    cmd: junos-srx/flow.session.show
    risk: ReadOnly
    gate: { touches: [SecurityPolicy, Zone] }
    expect: { field: "sessions", want: ">0", explain: explain:flow.sessions }
    on_pass: confirm

  confirm:
    cmd: junos-srx/config.commit
    risk: ChangesConfig
    tab: "do not forget this"
    expect: { field: "commit complete", want: present, explain: explain:ladder:confirm }
```

The card's own stopping rule — *"Stop at the first failure"* — is structural: `on_pass` is
`Option`, and a failed step follows `on_fail` and terminates the spine. The card's
diagnostic — *"Steps 5–8 failing while 2–4 are clean is plumbing, not crypto — no proposal
tweaking will fix it"* — is `explain:plumbing:up-but-no-traffic`, reached from exactly those
steps.

### 4.4 Interpolation — the difference between a lookup and an answer

Owner brief §6.1: *"With a workspace open, results interpolate real values —
`...vpn-name VPN-DC-EAST detail`, paste-ready."* Here it is not a convenience, it is the
point: a generic ladder is the card, which the engineer already has printed out. A ladder
with their names in it is the deliverable.

```rust
pub struct ArgSlot {
    pub slot: &'static str,
    pub src: ArgSource,
}
pub enum ArgSource {
    Const(&'static str),
    /// A dotted path over the *diff's* binding set, not over the graph.
    /// `vpn.name`, `gateway.address`, `selector.remote`.
    Binding(&'static str),
}
```

Bindings come from the diff: every `NodeDelta` contributes its node and its reference
closure to depth 2 under the schema's role names. So `vpn.name` resolves because the diff
touched an `IpsecPolicy`, whose reverse `UsesIpsecPolicy` edge reaches the `IpsecVpn`.

Unresolvable slot → the step is emitted with the slot left as `<vpn-name>` in the
placeholder convention of emitter §10, and the report records it. Not silently dropped, and
not guessed.

### 4.5 Pruning — `verify(diff)` and not `verify(everything)`

```
ladder_for(gd, plat) -> Ladder:
    # 1. entry points
    triggered = ∅
    for d in gd.nodes ++ gd.edges:
        triggered ∪= LadderIndex[(kind_of(d), field_of(d))]     # authored, corpus-side

    # 2. spine closure
    keep = ∅
    for l in triggered:
        keep ∪= reachable(l.entry, follow = on_pass)

    # 3. gate
    keep = { s in keep : s.gate.is_none() || s.gate.holds(gd) }

    # 4. failure closure — one hop, always
    for s in keep:
        for b in s.on_fail:
            if b.goto is Step(t): keep ∪= {t}                   # kept even if gated out

    # 5. interpolate, then linearise
    return linearise(keep, gd)
```

Step 4 is the rule that stops pruning from being harmful. **A gate may remove a step from
the spine; it may never remove a step from a failure path.** If step `p2` fails, you need
`inactive` regardless of whether the diff touched inactive-tunnels — the diagnostic branch is
not optional just because you did not expect to take it. Failure-path-only steps render in
the muted treatment, indented under the step that reaches them, exactly as the card indents
its notes.

`gate.holds(gd)` is a predicate over the diff, never over device state — we have no device
state. The vocabulary is small on purpose:

| Gate | Holds when |
|---|---|
| `touches: [Kind, …]` | the diff contains a delta on any of those kinds |
| `touches: [Kind.field, …]` | …on any of those fields |
| `field_becomes: { Kind.field: value }` | a `FieldDelta` whose `after` matches |
| `platform_version: <range>` | the target node's `OsVersion` is in range |
| `all_of` / `any_of` / `not` | composition, depth ≤ 3 |

No expressions. This is the same argument as the rule engine's for `fex` being a closed
language, applied to a much smaller problem, so the answer is a fixed combinator vocabulary
rather than a language.

### 4.6 Linearisation

```
linearise(keep, gd) -> ordered steps:
    spine = DFS from entry following on_pass          # deterministic: on_pass is single-valued
    for each s in spine, in order:
        emit s
        for b in s.on_fail (declaration order):        # ordered SmallVec
            emit b indented, muted
            if b.goto is Step(t) and t not in spine: emit t indented, muted
```

Deterministic because `on_pass` is `Option<StepId>` (one successor) and `on_fail` is an
ordered vector. `O(|keep|)`.

Rendering follows the card's numbered form — ordinals as content:

```
1  commit confirmed 5                              CHANGES CONFIG — NEEDS A COMMIT
   always, remotely

2  show security ike security-associations 203.0.113.10        READ-ONLY
   want   State: UP, and the same Index a minute later
   ▸ NO_PROPOSAL_CHOSEN        dh-group, encryption, hash, authentication-method
   ▸ AUTHENTICATION_FAILED     PSK, cert chain, clock skew — or identity
                               FIRST: did you substitute <PSK:SITE-B>?
```

---

## 5. Rollback generation

### 5.1 The governing rule

> **Rollback is a function of the diff, not of the change set.**

A change set says `set security ipsec policy IPSEC-POL perfect-forward-secrecy keys
group14`. Its inverse depends entirely on what was there before, which the change set does
not contain and the diff does. This is why `NodeDelta::Removed` carries a snapshot (§2.3)
and why §5 is in this document rather than in the emitter document.

Stated as a signature:

```rust
fn rollback(gd: &GraphDiff, la: &LineIndex, lb: &LineIndex, plat: &dyn Platform)
    -> RollbackSet;

pub struct RollbackSet {
    pub lines: Vec<EmittedLine>,
    pub confidence: RollbackConfidence,
    /// One entry per change whose inverse is missing or partial. Rendered
    /// in the ticket verbatim; never summarised away.
    pub caveats: Vec<Caveat>,
    /// The platform's own mechanism, always stated even when our lines are
    /// exact. §5.6.
    pub platform_fallback: PlatformFallback,
}

pub enum RollbackConfidence {
    Exact,
    Approximate { missing: Vec<StatementPath> },
    None { reasons: Vec<NoInverse> },
}
```

The set's confidence is the **minimum** over its lines. One `None` makes the whole rollback
`None`, because a partial rollback that silently omits the part it could not do is worse than
no rollback — the operator believes they are back and they are not.

### 5.2 The inverse table

| Change | Base state (from the diff) | Inverse | Confidence |
|---|---|---|---|
| `Assert(p, v)` | statement absent | `Retract(p, Leaf)` | `Exact` |
| `Assert(p, v)` | `Set(old)` | `Assert(p, old)` | `Exact` |
| `Assert(p, v)` | `Default(old)` | `Retract(p, Leaf)` — restoring the default means removing the statement | `Exact` |
| `Assert(p, v)` | **`Unknown`** | — | **`None { BaseUnknown }`** — §5.3 |
| `Retract(p, Leaf)` | `Set(old)` | `Assert(p, old)` | `Exact` |
| `Retract(p, Subtree)` | subtree fully modelled | re-assert every line of `LA` under `p` | `Exact` |
| `Retract(p, Subtree)` | subtree partially modelled | re-assert what we have | `Approximate { missing }` |
| `Deactivate(p)` | active | `Activate(p)` | `Exact` |
| `Reorder(member, rel, anchor)` | old position known | the inverse `insert` | `Exact` if the anchor still exists after rollback, else `Approximate` |
| `Assert` of a placeholder-bearing line | anything | — | **`None { CredentialNeverHeld }`** |
| `Operational` (`clear`, `ping`) | — | — | **`None { NotConfigState }`**, and no rollback line is generated because none is needed to restore *configuration* |

### 5.3 `BaseUnknown` — the dangerous one

This is the rollback bug that a three-state field model cannot even express, and it is the
strongest practical argument for schema §5.2's four states.

Suppose the graph has `IkeGateway.nat_keepalive = Unknown` — nobody entered it, nothing was
parsed that would have shown it. The user sets it to 20. The change set is:

```
set security ike gateway GW-B nat-keepalive 20
```

What is the inverse?

- `delete security ike gateway GW-B nat-keepalive` **removes a statement that may have been
  there before we touched it.** If the box had `nat-keepalive 5`, we have just changed it to
  the default while claiming to have rolled back.
- Asserting anything else means inventing a value.

There is no correct inverse. `Unknown` means we do not know, and a rollback generator that
treats `Unknown` like `Absent` produces a confident wrong answer — the exact failure class
this project keeps designing against.

So: `NoInverse::BaseUnknown`, and the caveat in the ticket is specific:

```
NO SAFE ROLLBACK — nat-keepalive on GW-B

  Fathom did not know this statement's previous state, so it cannot restore
  it. Before applying, capture:

      show configuration security ike gateway GW-B | display set

  and keep it with this ticket. `rollback 1` on the box is unaffected and
  remains the authoritative back-out.
```

Note the mitigation is not "we will guess". It is "go get the fact, here is the command",
which is a thing the tool is well placed to say because it knows exactly which fact is
missing.

### 5.4 The other four with no safe inverse

**Credentials.** Invariant 3 guaranteed we never held the PSK, so we cannot restore it. The
rollback line is emitted with the placeholder — `set security ike policy IKE-POL
pre-shared-key ascii-text "<PSK-PREVIOUS>"` — and marked `None`. The ticket says: *you must
have the previous key. Fathom does not and never did.* That is the cost of invariant 3 and
it is worth paying; the alternative is a product that holds every PSK its users have.

**Partially-modelled deletion.** §3.5's second precondition. We restore what we modelled and
we enumerate what we did not.

**External effect.** A rename inverts perfectly in the configuration and does not invert in
the world: monitoring keyed on `VPN-B`, the peer's documentation, a script that greps for
the name. `NoInverse::ExternalEffect`, and the caveat names the class rather than
pretending to enumerate the instances.

**Not config state.** `clear security ipsec security-associations` cannot be un-cleared. The
card's warning applies to the forward direction too: *"Clearing P1 tears down every child SA
under it — on a hub that is every spoke at once."* No inverse exists and none is needed for
the configuration; what is needed is that the ticket does not pretend the operation was
free.

**Time-dependent effects, which are the honest general case.** Narrowing a traffic selector
drops the sessions outside it. Restoring the selector restores the configuration and does
not restore the sessions. Every `Disruptive` line in a change set has this property to some
degree, and the ticket's rollback section carries one standing sentence:

> Rolling back restores the configuration. It does not restore traffic that was dropped, or
> adjacencies that reconverged, or sessions that timed out.

### 5.5 Why `commit confirmed 5` is the first line of every Junos change set

The card puts it at step 1 of the bring-up order with one word of justification —
*"always, remotely"* — and that word is the whole argument.

**The failure mode of an IPsec change is losing the path you are managing the box over.**
Not always the same tunnel you are changing: an out-of-band path through a WAN interface
whose zone you just edited, a route you just added at `st0.0` that is now more specific than
the one carrying your SSH session, a policy change on the zone pair your jump host sits in.
The card's own most-missed item is `host-inbound-traffic system-services ike` on the WAN
zone — a statement in the same stanza tree as the one that lets you in.

Every other safety net assumes you still have a session:

| Net | Assumes |
|---|---|
| our generated rollback lines | you can paste them |
| `rollback 1` | you can log in |
| a colleague | they can log in |
| console access | someone is in the building |
| `commit confirmed` | **nothing** |

`commit confirmed <minutes>` commits the candidate configuration and starts a timer; if no
confirming `commit` (or `commit check`) arrives before it expires, Junos loads and commits
the previously committed configuration by itself. The device rescues you without your
participation. That is a categorically different kind of control from the others and it is
why it goes first rather than in a "best practices" note at the end.

**Why 5 and not the default 10.** Long enough to run ladder steps 2–4 — the crypto steps,
which are where an IPsec change fails — and short enough that a lost session self-heals well
inside a change window. The card chose 5 and I see no reason to argue.

**The trap that must be in every ticket.** `commit confirmed` is confirmed by a subsequent
`commit`. Forget it, and the change silently reverts five minutes later — *and the tunnel
comes back up*, because it was working before. The engineer sees a tunnel that worked, then
briefly did not, then worked again, and files it as a transient. This is the failure mode
that the card's own flap table would decode as *"Even interval, round number → lifetime /
rekey mismatch"* if you did not know a commit had reverted, and side 4's `RUN THIS FIRST`
is the antidote: *"`show system commit`. If the newest commit lines up with the first flap in
`kmd`, you have your answer and it is not PFS. Correlate before you theorise."*

So the ladder's last step is `confirm`, with the margin tab `do not forget this`, and it is
never gated out.

### 5.6 The safety net per platform — honestly

```rust
pub enum GuardPolicy {
    /// The platform reverts by itself if we do not confirm.
    Timed { line: LineSpec, confirm: LineSpec, minutes: u16 },
    /// The platform reverts by itself, but only by rebooting.
    Blunt { line: LineSpec, cancel: LineSpec, note: ExplainKey },
    /// The platform has no unattended revert. Say so.
    None { substitute: ExplainKey },
}
```

| Platform | Guard | Confirm | Honest note |
|---|---|---|---|
| `junos-srx` | `commit confirmed 5` | `commit` | The real thing. Reverts unattended. |
| `ios-xe` (archive configured) | `configure terminal revert timer 5` | `configure confirm` | Cisco's Configuration Rollback Confirmed Change feature. Requires the configuration archive to be set up beforehand — the guard line is emitted with a precondition note, because issuing it on a box without the archive is not a safety net. |
| `ios` (classic, no archive) | `reload in 5` | `reload cancel` | **Blunt.** It reboots the router rather than reverting the configuration, and it only helps if the running configuration was never saved. Emitted only when explicitly enabled, with the note attached. |
| `panos` | **none** | — | PAN-OS has no commit-confirmed. The substitute is a named candidate snapshot before the change and a manual *Revert to running configuration* — both of which require a working session, which is exactly what the guard exists to survive without. Panorama's automatic commit recovery triggers on loss of connectivity **to Panorama**, not to you. The ticket states the gap rather than implying a protection that is not there. |

Writing "PAN-OS: none" in a generated change ticket is the kind of thing a product is
tempted to hide. It is the most useful line on the page for anyone about to make a remote
change to a Palo Alto firewall.

---

## 6. The change ticket

### 6.1 What it is for

Owner brief §6.7: *"paste-ready into a change ticket … makes the tool legible to
change-management processes, which matters more for adoption than it sounds."*

The audience is two people: the engineer, who wants the config and the ladder, and the
approver, who wants to know what breaks and how you get back. One document, ordered for the
approver, because the engineer will scroll.

### 6.2 Structure

Fixed 80-column plain text. The card's grammar: letterspaced caps become plain uppercase
heads, hairlines become `─`, the legend appears once, near the top, unchanged.

| § | Section | Mandatory | Source |
|---|---|---|---|
| — | Header: identity, revisions, content hashes, aggregate risk | yes | §6.4 |
| 1 | `INTENT` | yes | user-authored, one paragraph, empty is a refusal |
| 2 | `WHAT CHANGES` | yes | §2.6 rendering of the `GraphDiff` |
| 3 | `FINDINGS` — cleared / introduced / outstanding / suppressed-with-reason | yes | rule engine §10.2's session finding log |
| 4 | `SUBSTITUTIONS REQUIRED` | when non-empty | emitter §10.4 |
| 5 | `CONFIG` | yes | §3, risk-labelled per line, guard first |
| 6 | `VERIFY` | yes | §4 |
| 7 | `ROLLBACK` | yes | §5, including `NO SAFE ROLLBACK` blocks |
| 8 | `NOT EMITTED` | when non-empty | emitter §9.4 |
| 9 | `PROVENANCE` | yes | §6.4 |

Sections 3, 4, 7 and 8 cannot be suppressed by an export option. There is no "brief mode"
that drops the caveats, because a brief mode that drops the caveats is the mode everybody
would use.

### 6.3 Two artefacts, one hash

The plain-text ticket is for humans. A YAML sidecar carries the same content in the corpus
dialect (rule engine §10.4 already establishes YAML-not-JSON for documents a human reviews),
so a change can be re-imported, re-verified against a later graph, or diffed between
revisions. Both carry the same `content_hash`, computed over the canonical YAML, so a pasted
ticket can be checked against its sidecar.

### 6.4 Determinism and reproduction

Invariant 9: the same workspace revision plus the same corpus version plus the same build
produces a byte-identical ticket. The header records everything needed to reproduce it:

```
FATHOM CHANGE SET  01K1H8Q2M4V7YB3D6N9RXTC5FE
  workspace   dc-east            rev  b3f0…9a41
  device      srx-a              platform  junos-srx   version  21.4R3-S4.9
  corpus      2026.07.3          hash 7c1e…08d2
  rule packs  core 4.2.1 (9ab3…), ipsec 2.0.0 (11ff…)
  engine      0.9.0              as_of 2026-07-28
  reproduce   fathom emit --rev b3f0…9a41 --device srx-a --change 01K1H8…

  AGGREGATE RISK   DISRUPTIVE — DROPS LIVE TRAFFIC
```

`as_of` is the workspace-supplied date the rule engine already requires (12 §3.4) in place of
a clock. The ticket records it because a rule that fired on a certificate expiry window fired
relative to that date, and a reviewer six weeks later needs to know which date.

---

## 7. Worked example — adding PFS to a live tunnel

Everything in this section comes from the field card. The tunnel is side 1's: `VPN-B` to
peer `203.0.113.10`, gateway `GW-B` on `reth0.0`, bound to `st0.0`, selector
`10.1.0.0/16 ↔ 10.2.0.0/16`, `version v2-only`, `IPSEC-P2` with `aes-256-gcm` and
`lifetime-seconds 3600`.

The base graph was populated by pasting `show configuration | display set`, so
`IpsecPolicy.perfect_forward_secrecy` is `Absent` — a positive fact, not a hole. That detail
decides the rollback, and §7.5 shows what happens if it were `Unknown` instead.

### 7.1 The graph diff

```
CHANGED   IpsecPolicy  IPSEC-POL                            on srx-a

  perfect-forward-secrecy      —                →  keys group14      tighten

summary   1 node changed · 1 field · 0 nodes added · 0 removed · 0 edges
```

`DeltaClass::Tighten` from the declared comparator in §2.4. The finding
`ipsec.pfs.absent` moves `Active → Clear` and appears in ticket §3 as *cleared by this
change* (rule engine §10.2's session log).

### 7.2 The config diff

`LA` has no path under `security.ipsec.policy.IPSEC-POL.perfect-forward-secrecy`. `LB` has
one. Step 1, first arm: one `Op::Add`. `Idempotency::Idempotent`, so `lower` produces one
line.

```
set security ipsec policy IPSEC-POL perfect-forward-secrecy keys group14
```

**Risk: `Disruptive`.** Not `ChangesConfig`. The reasoning, which goes into the ticket
because a reviewer will ask why one line is red:

> The peer must offer the identical group. Until it does, Phase 2 fails while Phase 1 stays
> up — the classic *"IKE looks fine but the tunnel keeps dropping."* This change is only
> non-disruptive if the far end is changed inside the same window.

That sentence is `ipsec.pfs.absent`'s `symptom_if_mismatched` from the owner brief's own rule
example, reused rather than rewritten.

Is the peer modelled? If yes, the rule engine's `requires: [peer_config]` machinery (12 §8)
lets Fathom check the far end and either confirm agreement or raise
`ipsec.pfs.group-mismatch`. If no, the ticket carries an `UNPROVABLE` line:

```
UNPROVABLE — the far end is not in this workspace.
  This change fails Phase 2 unless 203.0.113.10 is configured with the same
  PFS group in the same window. Fathom cannot see it and is not guessing.
```

D1 (§3.8) runs and passes: `emit(A)` plus this line, re-parsed, equals `emit(B)`.

### 7.3 The honest statement — and it is worse than "drops the tunnel"

The obvious honest statement is *this drops the tunnel*. The card supports something more
specific and more useful, and it is the reason this example is the worked one.

Side 2:

> *"Under IKEv2 the first child SA is always keyed from the IKE SA regardless; PFS applies
> to later child rekeys. A capture of the initial bring-up showing no DH is not a
> misconfiguration."*

RFC 7296 agrees: the first Child SA is negotiated inside the IKE_AUTH exchange (§1.2), and
it is the CREATE_CHILD_SA request that *"MAY optionally contain a KE payload for an
additional Diffie-Hellman exchange to enable stronger guarantees of forward secrecy for the
Child SA"* (§1.3), with Child SA rekeying specified in §1.3.3.

So on a `v2-only` gateway:

| When | What happens |
|---|---|
| At commit | The existing child SA is unaffected or renegotiates from the IKE SA. Traffic continues. <!-- VERIFY: whether Junos tears down existing child SAs at commit of an `ipsec policy` change, or lets them run to their lifetime. Test: change PFS on a lab pair with a long P2 lifetime, watch `show security ipsec security-associations` index and the kmd log at commit. The ladder in §7.4 is correct either way, but the ticket's wording should say which. --> |
| **At the first child rekey** | The initiator sends a KE payload the responder does not expect, or omits one the responder requires. Phase 2 fails. Phase 1 stays up. |
| When that is | Up to `lifetime-seconds` later — 3600 s here — or sooner if `lifetime-kilobytes` is set and the tunnel is busy. |

**The change appears to work, and breaks up to an hour later.** By then the window is
closed, the engineer has moved on, and the flap presents as *"P2 cycles, P1 solid"* — which
side 3's flap table decodes as *"Selector or PFS mismatch"*, an hour after anyone was
looking.

Under IKEv1 the failure is immediate: quick mode with PFS carries the KE payload in the
first message, so a mismatch fails Phase 2 at once. Same change, two completely different
symptoms, decided by one field.

**This is what makes the ladder-as-a-graph design earn its keep.** A generic ladder verifies
that the tunnel is up after the commit, which it is, and passes. The correct ladder for
*this* change on a `v2-only` gateway must force a child rekey inside the window. That is a
`gate` on `IkeGateway.ike_version`, and it is not something a static runbook can express.

### 7.4 The ladder

```
VERIFY — 6 steps, generated for this change

1  commit confirmed 5                              CHANGES CONFIG — NEEDS A COMMIT
   always, remotely

2  show security ipsec security-associations vpn-name VPN-B detail    READ-ONLY
   want   State: Installed, and note the current SPI values
   ▸ anything else                → step 3

3  show security ipsec inactive-tunnels                                READ-ONLY
   the underused one — it prints a Tunnel Down Reason
   ▸ NO_PROPOSAL_CHOSEN (P2)      PFS group, ESP algorithms, esp vs ah
   ▸ INVALID_KE_PAYLOAD           DH group mismatch — the PFS group is not
                                  identical at both ends        → ipsec.pfs.group-mismatch

4  show security ike security-associations 203.0.113.10                READ-ONLY
   want   UP, and the same Index as before the change
   note   P1 staying healthy while P2 fails is the expected signature of a
          PFS mismatch, not a second fault. Side 1: "Phase 2 rides inside
          Phase 1."

5  clear security ipsec security-associations index <id>                DISRUPTIVE
   gate   ike_version == v2-only
   why    Under IKEv2 the first child SA is keyed from the IKE SA without a
          fresh DH, so a PFS mismatch does NOT show up on initial bring-up.
          It shows up at the first child rekey — up to 3600 s from now.
          Forcing one rekey now moves that failure inside this window.
   do not clear P1. Clearing P1 tears down every child SA under it, and the
   replacement first child SA is keyed from the IKE SA again — which hides
   exactly the fault you are testing for.
   then   repeat step 2. State: Installed with a NEW SPI is the pass.

6  commit                                          CHANGES CONFIG — NEEDS A COMMIT
   do not forget this — without it the change reverts in 5 minutes and the
   tunnel comes back up, which reads as a transient
```

Step 5 is the whole argument for this document. It is `Disruptive` — it forces a rekey, and
traffic pauses for the renegotiation — and it is also the only thing standing between a
change that passes verification and a change that fails at 03:00. The card supplies both
halves: *"Clearing P2 alone forces a rekey and is the cheapest way to prove a tunnel comes
back cleanly"* and *"Clearing P1 tears down every child SA under it."*

Steps 5–8 of the generic bring-up order — `st0` state, route, ping, flow sessions — are
gated out, because this diff touches no `LogicalUnit`, no `StaticRoute`, no `Zone` and no
`SecurityPolicy`. Their failure branches remain reachable from the steps that are kept, per
§4.5 step 4, and render muted if step 2 fails.

### 7.5 The rollback

```
ROLLBACK — confidence: EXACT

  delete security ipsec policy IPSEC-POL perfect-forward-secrecy     DISRUPTIVE
  commit

  Authoritative alternative on this platform:
      rollback 1
      commit
  The previous committed configuration is on the box. Prefer it unless other
  commits have landed since.

  This restores the configuration. It does not restore traffic dropped
  during the outage, and if the far end has already been changed to
  group14 you must roll that back too — a one-ended PFS configuration
  fails Phase 2 in either direction.
```

`Exact` because the base state was `Absent` — parsed from a real config, so we know there was
no statement. **Had the base been `Unknown`**, §5.3 applies and the block would instead read:

```
ROLLBACK — confidence: NONE

  NO SAFE ROLLBACK — perfect-forward-secrecy on IPSEC-POL

  Fathom did not know whether this statement existed before. Deleting it
  might remove a PFS group that was already configured with a different
  value. Before applying, capture:

      show configuration security ipsec policy IPSEC-POL | display set

  `rollback 1` on the box remains the authoritative back-out.
```

Same one-line change, same graph shape, completely different rollback, decided by one of the
four `Presence` states. That is the clearest illustration in either document of why schema
§5.2 is not over-engineering.

### 7.6 What the ticket says about sequencing the two ends

There is no ordering of a PFS change across two ends that avoids a Phase 2 outage. PFS is not
negotiated down to a common denominator — side 2: *"There is no negotiating down to a common
denominator beyond picking a whole proposal that already matches."* Whichever end changes
first is mismatched with the other until the second changes.

So the ticket does not offer a safe order. It offers a bounded one:

```
SEQUENCING

  Both ends must change. There is no order that avoids an outage; there is
  only a shorter one.

  1  srx-a:   apply, commit confirmed 5
  2  peer:    apply the equivalent change
  3  srx-a:   clear security ipsec security-associations index <id>
  4  both:    verify State: Installed with new SPIs
  5  both:    commit to confirm

  Expected gap: the renegotiation, seconds. If step 2 is delayed, the gap
  runs until the first child rekey after both ends agree — up to 3600 s.
```

---

## 8. Complexity and budget

| Operation | Complexity | At workspace scale |
|---|---|---|
| Graph diff, tiers 1–2 | `O(N_A + N_B + Σ fields)` | 40 devices ≈ 12,000 nodes: single-digit ms |
| Graph diff, tier 3 | `O(\|ua\| · \|ub\|)`, capped at 200×200 | worst case 40,000 scorings, each a handful of field comparisons: tens of ms, and only on an unpaired re-parse |
| Config diff steps 1–2 | `O(\|LA\| + \|LB\|)` over `BTreeMap`s | 1,200 lines: negligible |
| `subsume` | `O(n log n)` + `O(\|LA\|)` for the soundness scan | |
| Ordered-list LCS | `O(n²)` per list | a 300-entry policy list is 90,000 cells, ~1 ms |
| Order (emitter §5.6) | `O(V log V)` | |
| D1 self-check | one parse of `O(\|A\| + \|Δ\|)` | the dominant cost of a diff, and worth it |
| Ladder selection | `O(\|steps\| + \|edges\|)` | ladders are tens of steps |
| Rollback | `O(\|Δ\|)` | |

Nothing here is on the typing path. A diff is computed on demand — opening the change view,
or exporting a ticket — so the budget is a human interaction budget (target: under 100 ms to
first render), not a frame budget.

The memory note from emitter §14.2 applies twice over: a config diff holds two `LineIndex`
structures simultaneously, so ~0.5 MB per device-emit becomes ~1 MB. Diffs are computed per
device and dropped.

---

## 9. Failure modes

| # | Failure | Symptom | Defence |
|---|---|---|---|
| 1 | Tier-3 matching applied automatically | Two renames cross-matched; the diff shows small edits where the truth is deletes and adds; the rollback is wrong | Human confirmation, always (§2.2). |
| 2 | `Accumulating` change lowered to one line | Two proposals on one policy; negotiation offers either; nothing in the config looks wrong | `Idempotency` on the statement table, `retract_needs_value`, and a fixture per accumulating field (§3.4). |
| 3 | Unsound subsumption | `delete` of a parent removes statements we meant to keep | The soundness scan in §3.5, plus the unmodelled-subtree disclosure. |
| 4 | `load replace` from a partial graph | Silent removal of everything the graph did not model | Off by default, gated on full-parse provenance (§3.7). |
| 5 | Ladder pruned so aggressively that the diagnostic branch is gone | Step 2 fails and the ticket has no next step | §4.5 step 4: gates never remove failure-path steps. |
| 6 | Rollback generated from the change set instead of the diff | Inverses that delete statements that pre-existed | §5.1 is a signature constraint, not a convention: `rollback` takes `&GraphDiff`. |
| 7 | `Unknown` base treated as `Absent` | Confident wrong rollback (§5.3) | `NoInverse::BaseUnknown`, and `Presence` has no `is_none` (schema §5.2). |
| 8 | Partial rollback presented as complete | Operator believes they are back and is not | `RollbackConfidence` is the **minimum** over lines, not the average or the mode (§5.1). |
| 9 | `commit confirmed` never confirmed | Change reverts in 5 minutes; the tunnel comes back; filed as a transient | Ladder's terminal `confirm` step, never gated, margin tab `do not forget this` (§5.5). |
| 10 | PAN-OS ticket implies a rollback timer that does not exist | Remote change made with no net | `GuardPolicy::None { substitute }` and the ticket states the gap (§5.6). |
| 11 | Verification passes on an IKEv2 PFS change that is broken | Failure surfaces an hour later, outside the window, misdiagnosed as a flap | The forced-rekey step, gated on `ike_version` (§7.4). |
| 12 | D1 disabled "for performance" | The lines in the ticket stop being guaranteed to produce the diff | D1 is inside the export path, not behind a flag. If it is too slow, the fix is a faster parser. |

---

## 10. Open decisions

| ID | Decision | Notes |
|---|---|---|
| **OD-1** | Should the diff be computable against a *pasted running config* as a first-class mode, rather than only workspace-vs-workspace? | It is the highest-value thing here (it is intended-vs-actual, which is what Nautobot Golden Config sells) and it is nearly free: parse the paste into a throwaway graph, tier-2 match, diff. The reason it is an open decision and not a decision: the result is only as good as the parser's coverage, and a diff that reports 40 spurious changes because we do not model 40 statements is worse than no diff. Needs a "statements we did not understand" count on the diff, and a threshold above which we refuse. |
| **OD-2** | Whether `DeltaClass` should exist at all in v1. | It is authored judgement, it will be wrong somewhere, and a wrong `tighten` is a load-bearing wrong. The alternative is showing only the values and letting the reviewer decide. My inclination: ship it, `Unknown` by default, and only for fields where the direction is not arguable (`dh_group`, `perfect_forward_secrecy`, `ike_version`). |
| **OD-3** | Multi-device change sets. | §7.6 shows a two-ended change presented as prose. The next step is a real object: a change set spanning devices, with per-device ordering and a shared window. It changes the ticket's shape and it changes what `aggregate_risk` means. Not v1. |
| **OD-4** | Whether the ladder should model *expected output shapes* well enough to let the user paste output back in for checking. | Tempting — it closes the loop without touching a device — and it is a large parsing surface (`show security ipsec security-associations detail` output differs across trains). If built, it must be strictly optional and must never become a reason to weaken the ladder's prose. |
| **OD-5** | Ticket format: is 80-column plain text right, or should it be Markdown? | Plain text pastes into every change system unchanged. Markdown renders in some and looks like noise in others. Current answer: plain text primary, YAML sidecar, and a Markdown renderer as a third output if anyone asks. |

---

## 11. Sources consulted

| Claim | Source |
|---|---|
| Junos `commit confirmed`: commits the candidate, rolls back automatically if not confirmed; default 10 minutes; confirmed by a subsequent `commit` or `commit check` | [Junos OS — Commit the Configuration](https://www.juniper.net/documentation/us/en/software/junos/cli/topics/topic-map/junos-configuration-commit.html) |
| `commit confirmed` range 1–65,535 minutes | [Juniper — commit command reference](https://www.juniper.net/documentation/us/en/software/junos/cli-reference/topics/ref/command/commit.html) |
| Junos `show \| compare`, `load patch`, `load replace`, `load set terminal` semantics | [Junos OS — Loading Configuration Files](https://www.juniper.net/documentation/us/en/software/junos/cli/topics/topic-map/junos-config-files-loading.html) |
| IOS-XE Configuration Rollback Confirmed Change: `configure terminal revert timer <n>`, `configure confirm`, automatic reversal if unconfirmed | [Cisco — Configuration Rollback Confirmed Change](https://www.cisco.com/c/en/us/td/docs/routers/ios/config/17-x/syst-mgmt/b-system-management/m_cm-config-rollback-confirmed-change.html) |
| PAN-OS has no commit-confirmed; *Revert to running configuration* is manual; Panorama automatic commit recovery triggers on loss of connectivity to Panorama | [Palo Alto Networks — Revert Firewall Configuration Changes](https://docs.paloaltonetworks.com/pan-os/10-1/pan-os-admin/firewall-administration/manage-configuration-backups/revert-firewall-configuration-changes) |
| IKEv2: the first Child SA is created in the IKE_AUTH exchange; the CREATE_CHILD_SA request *may* carry a KE payload for forward secrecy; Child SA rekeying is §1.3.3 | [RFC 7296](https://www.rfc-editor.org/rfc/rfc7296.html) §1.2, §1.3, §1.3.3 |
| Every operational command, error token, flap pattern, timing figure and diagnostic sentence in §4 and §7 | `.context/field-card-srx-ipsec.txt`, sides 1–4 |

---

## 12. Disagreements

None with `conventions.md`.

One place where I have deliberately made a document longer than the owner's framing
suggests, and I want it on the record rather than discovered later. Owner brief §6.7 calls
verification and rollback *"a small feature."* The verification half is small — it is a
corpus and a pruning pass over an authored graph, and the card has already done the hard
thinking. The rollback half is not small, and §5.3 is why: a rollback generator that does
not distinguish `Absent` from `Unknown` will confidently emit a `delete` that removes
configuration nobody asked it to touch, in the one situation where the operator is least able
to check — mid-incident, backing out. That is a worse failure than any the emitter can
produce, because it happens when the change has already gone wrong.

The mitigation is not more code. It is the honesty budget: `RollbackConfidence` taking the
minimum, `caveats` being unsuppressible, and the ticket carrying `NO SAFE ROLLBACK` blocks in
full. Those three make the feature useful and they also make it look worse in a demo than a
version that always prints a confident inverse. That trade is the correct one and it should
be made deliberately rather than eroded a section at a time.
