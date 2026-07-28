# 61 — The command corpus

> **Status:** Proposed

Companion document: `docs/10-core/16-command-finder.md` (the machine). That document
specifies matching, ranking and rendering. **This one specifies the document an author
writes**, field by field, with defaults, validation and eight worked entries.

Owner brief §6.1 gives the seed:

```yaml
cmd: show security ipsec security-associations
vendor: junos-srx
phase: ipsec
intent: [tunnel-up, phase2-state, verify-vpn]
answers: "Is Phase 2 installed and passing traffic?"
risk: read-only
read_field: "State — want Installed"
next_if_bad: [ipsec.inactive-tunnels]
related: [ipsec.statistics, ike.sa]
rosetta: { panos: "show vpn ipsec-sa", ios: "show crypto ipsec sa" }
```

Everything here extends that. Four things change shape, all called out as proposed changes
in §16: `vendor` → `platform` (conventions), `intent` → `concepts`, `risk: read-only` →
`risk: ReadOnly` (conventions pin exactly three spellings), and `rosetta` moves out of the
entry into its own document (finder §18).

**The reader this format is written for** is the same one `63-rulepack-spec.md` names: a
network engineer who can explain why PFS on one side and absent on the other fails Phase 2
while Phase 1 stays up, and who has never written a parser. If a field in this spec needs
programming knowledge to fill in correctly, that field is wrong.

---

## 0. Contents

| § | |
|---|---|
| 1 | What a command entry is |
| 2 | Layout on disk, and `corpus.toml` |
| 3 | The entry document — complete field reference |
| 4 | `risk`, and destructive-command handling |
| 5 | Slots and interpolation |
| 6 | `output_fields` — describing what to read |
| 7 | The graph — `next_if_bad`, `related`, `requires`, `supplies` |
| 8 | Concepts — the `concepts/` documents |
| 9 | Rosetta documents |
| 10 | Ladders, and the containment gate |
| 11 | Explainers on an entry |
| 12 | `sources` |
| 13 | Authoring workflow |
| 14 | CI validation — the gates |
| 15 | Eight worked entries |
| 16 | Proposed changes to the brief's example |
| 17 | Entries the card implies that are not written here |
| 18 | What this format costs |
| 19 | Open decisions |
| 20 | Disagreements |

---

## 1. What a command entry is

One document describing **one question a person has and the one command that answers it**.
Not a man page, not a syntax reference, not a wrapper around vendor documentation. The format
forces seven questions and fails the build if any is unanswered:

| Question | Field |
|---|---|
| What do I type? | `cmd` |
| What question does it answer? | `answers` |
| What words would somebody use to ask that? | `concepts`, `aka` |
| What is it safe to run? | `risk` (+ `blast_radius` when not `ReadOnly`) |
| What do I look at in the output? | `read_field`, `output_fields` |
| What do I run if it is bad? | `next_if_bad` |
| Who checked this, on what? | `reviewed_by`, `verified_on` |

An entry that cannot answer all seven is not ready, and that is a build failure rather than
a judgement call — the same posture the rule packs take.

### 1.1 The normative validator

The normative schema is JSON Schema generated from the Rust types (`schemars`), published
with each corpus tool release as `schemas/command-<tool-version>.json`. This document is the
human-readable specification. Where they disagree, one of them is a bug and both get fixed.

### 1.2 One entry per *invocation*, not per command word

`show security ipsec security-associations` and
`show security ipsec security-associations vpn-name ⟨vpn⟩ detail` are **two entries**. They
answer different questions ("what tunnels exist and roughly how are they" versus "tell me
everything about this one"), have different `output_fields`, and rank differently.

The counter-pressure is real: naive application of this rule produces eleven entries for the
IKE SA family and the finder returns all eleven for `show security ike`. The discipline:

> **Split when the `answers` sentence changes. Merge when it does not.**

`... detail` gets its own entry because the question changes from "is it up" to "what are the
parameters". `... index ⟨n⟩ detail` does not get one separate from `... detail` unless the
`answers` sentence genuinely differs — it does here, because the index form is the one you
use when you already have an index and want *that* SA, which is a different situation. Three
entries, not eleven. Canonicality (`weight`) orders them.

---

## 2. Layout on disk, and `corpus.toml`

```
fathom-corpus/
├── corpus.toml                          # manifest (§2.2)
├── LICENSE
├── CHANGELOG.md                         # required
├── commands/
│   ├── junos-srx/
│   │   ├── ipsec.sa.show.yaml
│   │   ├── ipsec.sa.show-vpn-detail.yaml
│   │   ├── ipsec.inactive-tunnels.yaml
│   │   ├── ike.sa.clear-peer.yaml
│   │   └── …
│   ├── panos/
│   ├── ios-xe/
│   └── fortios/
├── concepts/
│   ├── ipsec.yaml                       # one file per domain, not per concept
│   ├── ike.yaml
│   ├── mtu.yaml
│   ├── action.yaml
│   └── OWNERS                           # two named reviewers per domain
├── rosetta/
│   ├── p1-state.yaml
│   ├── p2-state.yaml
│   ├── counters.yaml
│   └── clear-sa.yaml
├── ladders/
│   └── junos-srx/
│       └── ipsec.bringup.yaml           # schema in 18-diff-verify-rollback.md §4.3
├── filters/
│   └── junos-srx.yaml                   # `| match`, `| last N`, `| display set`
├── explainers/
│   └── junos-srx/
│       └── ipsec.sa.show-vpn-detail.teaching.md   # long-form bodies
├── golden/
│   ├── queries.yaml                     # finder §9.6
│   └── outputs/
│       └── ipsec-sa-installed.txt       # real captured output, redacted (§6.4)
└── i18n/
    └── en.yaml                          # generated by extraction; checked in
```

| Rule | Reason |
|---|---|
| One file per entry, named exactly the dotted path | `git log commands/junos-srx/ike.sa.clear-peer.yaml` is the history of one command's guidance. |
| Directory is the platform; filename is the dotted path | Together they are the id (conventions: `<platform>/<dotted-path>`). No id field can disagree with its location. |
| Concepts are one file per **domain** | One file per concept produces a directory nobody reads and a graph nobody can see. A domain file is reviewable as a whole, which is the level at which concept hierarchies are actually wrong. |
| Long `teaching` bodies live in `explainers/` as Markdown | YAML block scalars stop being reviewable past a few hundred words. Same rule the rule packs use. |
| Captured output lives in `golden/outputs/`, redacted | §6.4. |

### 2.2 `corpus.toml`

```toml
[corpus]
id          = "fathom.commands"
name        = "Fathom command corpus"
version     = "0.4.0"
license     = "CC-BY-SA-4.0"
expires     = "2027-09-01"

[compat]
schema_range = "vers:fathom/>=3.0.0|<4.0.0"
min_tool     = "0.4.0"

[content]
entry_count   = 1204
concept_count = 341
rosetta_count = 88
ladder_count  = 12
platforms     = ["junos-srx", "panos", "ios-xe", "fortios"]
tree_hash     = "blake3:…"          # over the canonicalised tree
index_hash    = "blake3:…"          # over finder.idx; the finder hard-fails on mismatch

[finder]                             # the ranking weights, shipped with the index
w_concept = 3.0
w_lexical = 1.0
w_syntax  = 2.0
w_context = 1.0
kappa     = 6.0
k1        = 1.2
cutoff    = 1.00

[[maintainers]]
name = "…"
role = "reviewer"                    # reviewer | author | owner
```

`[finder]` lives here, not in the application, because the weights and the corpus are
calibrated together (finder §8.2). Changing a weight is a corpus release with a golden-set
delta in the changelog, which is what makes ranking *diffable between releases* — the
brief's own requirement.

---

## 3. The entry document — complete field reference

`R` = required, `O` = optional.

### 3.1 Identity and lifecycle

| Field | Type | R/O | Default | Validation |
|---|---|---|---|---|
| `id` | string | R | — | `<platform>/<dotted-path>` (conventions). Path segments `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`, 2–4 segments. **Must equal `platform` + the file path.** Stable forever. |
| `entry_version` | semver | R | — | Bumped when the entry's own content changes. Lets a result pasted into a change ticket six months ago be traced to the exact text that produced it. |
| `status` | enum | O | `active` | `draft` \| `active` \| `deprecated` \| `withdrawn`. `draft` is indexed but takes −0.15 in ranking (finder §8.3) and renders a `draft` margin tab. `withdrawn` is never indexed; the id is retained forever so old exports still resolve to *something*. |
| `replaced_by` | entry id | O | — | Required when `deprecated` or `withdrawn`. |
| `reviewed_by` | string | R | — | A named human. Invariant 10. A name a colleague recognises, not an email. |
| `reviewed_on` | date | R | — | ISO. Lint warns past 24 months. |
| `verified_on` | table | O | — | `{ platform, version }` — the box the author actually ran this on. Absent ⇒ the entry renders an `unverified` margin tab. This is the field that keeps the corpus honest and it is deliberately not required, because requiring it would produce fabricated values. |

### 3.2 The command

| Field | Type | R/O | Default | Validation |
|---|---|---|---|---|
| `cmd` | string | R | — | The command with `{{slot}}` placeholders. One logical line — no embedded newlines. Every `{{name}}` must have a matching entry in `slots`. |
| `mode` | enum | R | — | `operational` \| `configuration` \| `shell` \| `pipe-filter`. Junos operational vs configuration matters for both explanation and for the `run ` prefix the finder strips (finder §4.1). |
| `wraps` | list of int | O | `[]` | Token indices after which the rendered command breaks with a continuation backslash. Design language, *devices worth stealing* item 5: *"commands wrap the way they wrap in a terminal, not the way they wrap in a webpage."* Lint requires a wrap point for any `cmd` over 62 characters and rejects a wrap inside a `{{slot}}`. |
| `platform` | platform id | R | — | Exactly one, from `schema/platforms.yaml` (`63-rulepack-spec.md` §5.1). **Not a list.** A command that is textually identical on `ios-xe` and `nx-os` is two entries; see `derive_for`. |
| `derive_for` | list of platform ids | O | `[]` | Build-time generation of sibling entries with the same body, their own ids, and **no inherited `verified_on`**. The derived entry ships `unverified` until somebody runs it. This is how you get `ios` and `ios-xe` coverage without hand-copying, without claiming to have checked both. |
| `versions` | VERS string or map | O | `"*"` | Same syntax and the same Fathom-local version schemes as `63-rulepack-spec.md` §6. Out-of-range entries take −0.30 in ranking and render `not on your train`. |
| `on_unknown_version` | enum | O | `fire` | `unprovable` \| `skip` \| `fire`. Note the default is **opposite** to a rule's. A rule that might not apply should stay quiet; a command that might not apply should still be findable, because the user may be looking at a box we know nothing about. Rendered with the version caveat attached. |
| `deprecated_syntax` | list of string | O | `[]` | Older spellings that still work, indexed for the syntax matcher so half-remembered old syntax still finds the current entry. Never rendered as the answer. |

### 3.3 Classification

| Field | Type | R/O | Default | Validation |
|---|---|---|---|---|
| `risk` | enum | R | — | `ReadOnly` \| `ChangesConfig` \| `Disruptive`. Exactly three, conventions. Assigned by effect, not by `mode` (ADR-0011). §4. |
| `risk_caption_override` | string | O | — | Renders in place of the band's default caption where that caption is untrue of this entry. Words only — band, ink, wash and ordering are not overridable. ADR-0011; §4.6. |
| `domain` | enum | R | — | `ipsec` \| `ike` \| `zone` \| `policy` \| `route` \| `nat` \| `mtu` \| `flow` \| `interface` \| `ha` \| `chassis` \| `log` \| `system`. First segment of the dotted id must agree. (`chassis` added per R09 — the cluster operational entries; `ha` remains for redundancy *configuration* domains.) |
| `weight` | int 0–3 | O | `1` | **Canonicality**: how much this is *the* command for its concepts. 3 = the one you reach for; 0 = a corner case. Feeds the finder's prior (finder §8.3) at `0.10 × weight`. Lint: at most one `weight: 3` per (concept, platform) pair — if two commands are both the canonical answer to the same question, one of them is not. |
| `tags` | list of string | O | `[]` | Lowercase, hyphenated. Filtering only, never logic. `[phase1, phase2, nat-t, bring-up, day-one, mtu]`. |

### 3.4 Answering

| Field | Type | R/O | Default | Validation |
|---|---|---|---|---|
| `title` | string | O | derived from `cmd` | Short human label. Rarely needed. |
| `answers` | string | R | — | **One question, ending in `?`.** 4–20 words. The brief: *"the field that matters."* Lint gates: must end `?`; must not begin with "Shows", "Displays", "Lists", "This command"; must not contain any token from `cmd` other than a proper noun. That last gate is the one that matters — it stops the author restating the command. |
| `aka` | list of string | O | `[]` | Alternative phrasings, harvested from how people actually ask. Lifted at build time into concept surface candidates for review (finder §3.6) — **candidates, not surfaces**; a human still approves them. ≤ 12 entries. |
| `concepts` | list of ConceptId | R | — | ≥1 `Object` kind and ≥1 `Action` kind, ≤6 total. Every id must exist. This is the brief's `intent` field with a resolvable type (§16). |
| `symptoms` | list of ConceptId | O | `[]` | `Symptom`-kind concepts this command investigates. `concept:symptom.stalls-under-load` on the MTU commands. Separated from `concepts` because symptoms match a different query shape ("why does it break when…") and are weighted the same but authored by different thinking. |

### 3.5 Reading the output

| Field | Type | R/O | Default | Validation |
|---|---|---|---|---|
| `read_field` | string | R | — | The one-line answer to "what do I look at". ≤ 60 chars. The brief's example: `"State — want Installed"`. Em-dash separating the field from the wanted value is the card's own form and lint enforces the shape `<Field> — <what you want>`. |
| `output_fields` | list of table | O | `[]` | §6. Required when `risk: ReadOnly` and `weight ≥ 2` — a canonical read-only command that does not explain its own output is half an entry. |
| `sample_output` | path | O | — | Points into `golden/outputs/`. Redacted (§6.4). |

### 3.6 Slots, graph, links

Covered in §5, §7 and §11 respectively. Summary of the fields:

| Field | Type | R/O | Default | §|
|---|---|---|---|---|
| `slots` | list of table | R if `cmd` has `{{…}}` | `[]` | §5 |
| `next_if_bad` | list of id | O | `[]` | §7.1 |
| `related` | list of EntryId | O | `[]` | §7.2 |
| `requires` | list of table | O | `[]` | §7.3 |
| `supplies` | list of string | O | `[]` | §7.3 |
| `guidebook` | list of GuideId | O | `[]` | §11.2 |
| `walkthrough` | list of WalkId | O | `[]` | §11.2 |
| `related_rules` | list of RuleId | O | `[]` | §11.2 |
| `explain` | table | R | — | §11.1 |
| `sources` | list | R (or `sources_note`) | — | §12 |

### 3.7 Destructive-command fields

Required when `risk != ReadOnly`. §4.

| Field | Type | R/O | Default |
|---|---|---|---|
| `blast_radius` | string | R when `risk != ReadOnly` | — |
| `scope_required` | list of slot name | O | `[]` |
| `reversible` | enum | R when `risk != ReadOnly` | — |
| `paired_teardown` | EntryId | O | — |
| `commit_model` | enum | R when `mode: configuration` | — |

---

## 4. `risk`, and destructive-command handling

### 4.1 The three values, and nothing else

```
ReadOnly       #1F6F4A on #EEF5F1   "READ-ONLY — SAFE ON PRODUCTION"
ChangesConfig  #A8571B on #FBF3EA   "CHANGES CONFIG — NEEDS A COMMIT"
Disruptive     #8C2F2F on #F8EFEF   "DISRUPTIVE — DROPS LIVE TRAFFIC"
```

Verbatim from the conventions and from all four sides of the field card. The legend renders
identically in the finder, in the emitter output, in the change ticket and on paper. Do not
add a fourth. Do not reuse these colours for anything else.

**The assignment rule, which is not obvious and gets argued about:**

| Value | Test | Trap |
|---|---|---|
| `ReadOnly` | Running it cannot change forwarding, configuration or state that anything else reads. | `clear security ipsec statistics` is **not** ReadOnly — it zeroes counters somebody may be watching. It is `ChangesConfig`. |
| `ChangesConfig` | Changes something persistent or something an operator depends on, but does not by itself drop traffic. | `set security ike traceoptions` looks harmless and can fill `/var`, which breaks logging *and* commits. Still `ChangesConfig`, with the blast radius saying so. |
| `Disruptive` | Drops live traffic, or can. | `clear security ike security-associations` with no argument. Side 3: *"Clearing P1 tears down every child SA under it — on a hub that is every spoke at once."* |

**The definition, decided (ADR-0011) — risk is a property of effect, not of `mode`:**

> `Disruptive` **iff** committing or running the statement can interrupt an established flow,
> SA or adjacency on a device already carrying traffic.

A `mode: configuration` entry whose commit tears down an established SA is `Disruptive`;
a `mode: operational` `clear` scoped to a single SA is `Disruptive` too, because traffic on
that SA pauses. Deriving the band from the statement's mode (`configuration` ⇒
`ChangesConfig`, `clear` ⇒ `Disruptive`, else `ReadOnly`) is the defect ADR-0011 exists to
close. CI enforces the class, not just the instances (§14): any entry whose `blast_radius`
matches `/blackhole|traffic stops|drops .*(adjacency|traffic)|never comes up|stops negotiating/i`
and is not `Disruptive` fails the build.

When an author is torn, the rule is **round up**. A command wrongly labelled `Disruptive`
costs a moment's hesitation. A command wrongly labelled `ReadOnly` costs an outage, and it
costs the tool's credibility permanently.

### 4.2 `blast_radius` — mandatory, and it is the whole point

```yaml
risk: Disruptive
blast_radius: >
  Tears down the IKE SA with this peer and every child IPsec SA under it.
  On a hub that is every spoke behind this peer at once. Traffic stops until
  each tunnel renegotiates.
```

Rules:

| Rule | Reason |
|---|---|
| Required when `risk != ReadOnly` | An unexplained warning label is a label people learn to ignore. |
| States **what stops**, not that it is dangerous | "Use with caution" is not information. "Every spoke behind this peer at once" is. |
| Names the scale, where scale is the surprise | The hub case is the surprise. Somebody who has only ever run this on a spoke has no reason to expect it. |
| One paragraph, ≤ 60 words | It renders inline on the result row, not behind a disclosure. |
| Lint | Must not contain "caution", "careful", "be aware", "note that". Must contain a verb from a small consequence set (`tears down`, `drops`, `stops`, `clears`, `restarts`, `reboots`, `fills`, `interrupts`). |

### 4.3 `scope_required` — the mechanism, not just the warning

The card does not merely warn. It gives an instruction: *"Always scope by peer or index."*
That is machine-encodable:

```yaml
scope_required: [peer]
```

Effects, specified in finder §16.5:

1. The command is never rendered with the scoping slot silently omitted.
2. If the slot cannot be resolved from the workspace, it renders as `<peer-ip>` and copying
   copies the placeholder. It does not guess between two peers.
3. The **unscoped** form is a separate entry (`ike.sa.clear-all`), also `Disruptive`, with its
   own larger `blast_radius`, reachable only by the syntax matcher — never by a concept match.

Point 3 is the design decision worth defending. The unscoped command exists and engineers
sometimes need it; hiding it makes the tool a liar. But it must not appear when somebody
searches "restart the tunnel". Two entries, with only one reachable by intent, is how both
hold.

### 4.4 `reversible`

| Value | Meaning | Example |
|---|---|---|
| `self` | Running it again, or waiting, restores the prior state | `clear security ipsec security-associations` — the SA renegotiates |
| `paired` | There is a specific command that undoes it; `paired_teardown` names it | `set security ike traceoptions …` ↔ `delete security ike traceoptions` |
| `none` | Nothing restores the prior state | `clear security ipsec statistics` — the counters are gone |
| `commit-confirmed` | The Junos safety net applies; `commit confirmed N` rolls it back automatically | any `mode: configuration` entry on Junos |

`paired` entries render their teardown inline, always, in the same result. Side 3 is
emphatic about this and it is one of the most commonly skipped operational steps:

> *"Traceoptions left on will fill `/var`, which breaks logging and commits both."*
> *"`delete security ike traceoptions` … `commit`  # ALWAYS clean up"*

### 4.5 `commit_model`

Required for `mode: configuration`. Values: `junos-commit` \| `immediate` \|
`candidate-commit` \| `write-mem`. Drives the "and then what" line — on Junos, every
configuration entry renders `commit confirmed 5` as its safety wrapper, because side 1 makes
it step 1 of the bring-up order: *"`commit confirmed 5` — always, remotely."*

### 4.6 `risk_caption_override` — the caption is separable from the band

Optional string (§3.3), added by ADR-0011. The three captions in §4.1 are the *default
rendering* of each band. Where the default caption is untrue of a specific entry, the entry
overrides the words — and only the words. **Same ink, same wash, same ordering, different
words.** The band itself, its colours and its position in the legend are not overridable,
and CI enforces that, not review.

The shipped case, exactly as it appears in `corpus/commands/junos-srx-ipsec.yaml`:

```yaml
# on junos-srx/ipsec.statistics.clear
risk: ChangesConfig
risk_caption_override: "CHANGES STATE — NOT REVERSIBLE BY COMMIT"
```

`clear security ipsec statistics` changes no configuration, needs no commit, and `rollback 1`
will not undo it. `CHANGES CONFIG — NEEDS A COMMIT` on that entry told an operator to commit
something that had already happened. The band is right (§4.1's ReadOnly trap); the caption
was false, so the caption moves and the band stays.

One override is a correction; two is a pattern — ADR-0011's *Revisit if* says a second
requested override reopens the convention rather than extending it.

---

## 5. Slots and interpolation

```yaml
slots:
  - name: vpn
    binds: { kind: IpsecVpn, field: name }
    accepts: [Identifier]
    placeholder: "<vpn-name>"
    required: true
  - name: peer
    binds: { kind: IkeGateway, field: address, via: [uses_ike_gateway] }
    accepts: [Ip4, Ip6]
    placeholder: "<peer-ip>"
    required: true
  - name: id
    binds: null                       # runtime-only; comes out of another command
    accepts: [Integer]
    placeholder: "<sa-index>"
    required: true
  - name: size
    binds: null
    accepts: [Integer]
    placeholder: "<icmp-payload-bytes>"
    required: true
    suggest:
      - { value: 1472, note: "1500 on the wire — the standard-Ethernet test" }
      - { value: 1372, note: "1400 on the wire — the conventional tunnel clamp" }
```

| Field | Type | R/O | Notes |
|---|---|---|---|
| `name` | ident | R | Matches `{{name}}` in `cmd`. |
| `binds` | table or `null` | R | `{ kind, field, via? }`. **Kind ids, field ids and edge roles — never names or paths** (invariant 7). `via` is ≤3 edge roles from the anchor. `null` means the value comes from another command's output, not from the graph. |
| `accepts` | list of shape | R | `Ip4` \| `Ip6` \| `Prefix` \| `Integer` \| `Identifier` \| `Word` \| `Any`. Used by the finder's reverse-query argument capture (finder §15.2) and to reject an obviously wrong chooser candidate. |
| `placeholder` | string | R | **Always angle-bracketed.** Lint enforces `^<[a-z0-9-]+>$`. Angle brackets are the card's own convention for "you supply this" (`show log kmd \| match <peer-ip>`) and a placeholder that does not look like one gets pasted into a terminal. |
| `required` | bool | O, default `true` | An optional slot renders as nothing when unresolved rather than as a placeholder. |
| `suggest` | list | O | Ordered candidate values with a one-line note, offered in the chooser when `binds: null`. This is how the MTU binary search on side 4 becomes an interaction rather than arithmetic the user does in their head. |

**Anchor:** the entry's anchor kind is inferred as the kind of the first `binds` slot, and all
other `via` chains are rooted there. An entry whose slots bind to unrelated kinds with no
`via` path between them fails lint — that entry is describing two things.

---

## 6. `output_fields` — describing what to read

Side 3's `READING THE SA OUTPUT` block, encoded. Two columns, no vertical rules, lookup key
left and answer right — the design language names this table shape as the model for every
diagnostic view.

```yaml
output_fields:
  - field: Index
    means: "P1 SA identifier."
    want: any
    tell: "Same index a minute later = stable. New index = it rebuilt."
  - field: State
    means: "Phase 2 SA state."
    want: "Installed"
    bad:
      - { value: "*", means: "Anything but Installed is not passing traffic." }
  - field: Port
    means: "Remote IKE port."
    want: any
    tell: "500 direct. 4500 means NAT-T is in path."
```

| Field | Type | R/O | Notes |
|---|---|---|---|
| `field` | string | R | The label **as the box prints it**, exact case. Not a normalised name. Somebody is reading a terminal and matching strings by eye. |
| `means` | string | R | One sentence. Lint: must not begin with "The <field> field". |
| `want` | string \| `any` | R | The value that means healthy, or `any` when there is no such value. Rendered as `— want Installed` in the card's idiom. |
| `bad` | list | O | `{ value, means }`, `value` may be `"*"` for "anything else". |
| `tell` | string | O | The diagnostic reading — the thing an experienced person notices. This is where the card's voice lives: *"Same index a minute later = stable. New index = it rebuilt."* |
| `join_key` | bool | O, default false | Marks a field that correlates this output with another command's. Side 3's governing imperative: *"THE JOIN KEY ACROSS ALL OUTPUT IS VPN NAME + PEER IP, NEVER ST0."* At most two per entry, and the renderer shows them first. |

### 6.4 `sample_output` and redaction

Captured real output, checked in under `golden/outputs/`, referenced by path. It is used for
three things: rendering an annotated example at `teaching` depth, testing the `Signal::Field`
matchers in ladders (`18-diff-verify-rollback.md` §4.2), and giving a reviewer something to
check `output_fields` against.

**Redaction is a build gate, not a convention.** CI scans every file under `golden/outputs/`
and fails on: any public IPv4 outside the documentation ranges (RFC 5737 `192.0.2.0/24`,
`198.51.100.0/24`, `203.0.113.0/24`), any global-unicast IPv6 outside `2001:db8::/32`
(RFC 3849), any hostname not under `.example`/`.example.net`/`.example.com`, and any
hex string over 24 characters that is not on an allowlist. The card itself uses
`203.0.113.10`, `198.51.100.5`, `10.1.0.0/16`, `10.2.0.0/16` and `site-b.example.net`
throughout — the corpus uses the same addresses, so every example composes.

This gate exists because §2.4 of the brief is about exactly this material, and a corpus that
leaks a real peer address is a corpus that argues against the product's central claim.

---

## 7. The graph

### 7.1 `next_if_bad`

Ordered. Each element is an `EntryId`, a `RuleId`, or an `ExplainKey`.

```yaml
next_if_bad:
  - junos-srx/ipsec.inactive-tunnels
  - explain:decoder:no-proposal-p2
```

**Unconditional and one hop.** It is the answer to "this looked wrong, now what" on a result
row, where there is no room and no signal to branch on. Conditional branching lives in
ladders (§10).

Rendered with the first element's `answers` inline, so the row reads:

```
  if bad  show security ipsec inactive-tunnels — names what is down and prints
          a Tunnel Down Reason
```

### 7.2 `related`

Unordered, symmetric in the UI, one-directional in the data. Lint materialises the reverse
at build time and warns when A lists B but B is on a different platform (that is a Rosetta
relationship, not a `related` one, and it belongs in §9).

≤ 8 entries. A command related to fifteen others is related to none of them.

### 7.3 `requires` / `supplies`

The dependency the card is full of and nothing else models: **you cannot run this until you
have run that**, because a value in the command comes out of another command's output.

```yaml
# on junos-srx/ipsec.statistics.index
requires:
  - { slot: id, from: junos-srx/ipsec.sa.show, field: Index }

# on junos-srx/ipsec.sa.show
supplies: [Index]
```

Effects:

1. The finder demotes an entry by 0.25 when a `requires` cannot be satisfied in the current
   context (finder §8.3) — which is why `show security ipsec statistics index ⟨id⟩` lands at
   rank 4 rather than rank 1 in the flagship trace despite a perfect concept match.
2. The result row renders the supplier: *"needs: an SA index — get it from `show security
   ipsec security-associations`"*.
3. CI checks the `field` named in `requires` exists in the supplier's `output_fields`, and
   that the supplier lists it in `supplies`. A dangling dependency is a build failure.

`supplies` is authored separately rather than derived, because a command supplies a value
only if the value is *usable* elsewhere, which is a judgement the author makes.

---

## 8. Concepts — the `concepts/` documents

The vocabulary layer. Machine semantics in finder §3 and §7; this is the authoring format.

```yaml
# concepts/ipsec.yaml
version: 1
domain: ipsec
reviewed_by: <named human>

concepts:

  - id: concept:obj.tunnel
    kind: object
    label: "an IPsec tunnel, as a whole"
    surfaces:
      - { text: "tunnel",  conf: 1.00 }
      - { text: "vpn",     conf: 0.90 }
      - { text: "ipsec",   conf: 0.85 }
      - { text: "crypto",  conf: 0.60 }
      - { text: "s2s",     conf: 0.80 }
      - { text: "site to site", conf: 0.95 }
    narrower: [concept:obj.ike-sa, concept:obj.ipsec-sa, concept:obj.st0]
    not_the_same_as:
      - other: concept:obj.gre
        because: >
          A GRE tunnel is not encrypted and has no SA. On Junos it is gr-0/0/0,
          not st0, and none of the security ipsec commands see it.

  - id: concept:p2.installed
    kind: state
    label: "the IPsec SA is installed"
    surfaces:
      - { text: "installed",   conf: 1.00 }
      - { text: "phase 2 up",  conf: 1.00 }
      - { text: "p2 up",       conf: 1.00 }
      - { text: "ipsec sa up", conf: 0.95 }
    broader: [concept:state.operational]
    not_the_same_as:
      - other: concept:dataplane.passing
        because: >
          Installed proves crypto, not reachability. The tunnel reads UP while
          passing zero packets when st0 has no zone, no policy, or nothing
          routed at it.
    sources:
      - { card: "srx-ipsec", side: 3, block: "READING THE SA OUTPUT" }
      - { card: "srx-ipsec", side: 4, block: "THINGS THAT BITE" }
```

### 8.1 Field reference

| Field | Type | R/O | Validation |
|---|---|---|---|
| `id` | ConceptId | R | `concept:<domain>.<name>`, lowercase, hyphenated, stable forever. |
| `kind` | enum | R | `object` \| `state` \| `action` \| `attribute` \| `symptom` \| `phase`. Wrong `kind` produces wrong ranking in ways review does not catch — finder §7.3 gates on `object`, §3.4 resolves breadth on `state`, §10 picks a ladder entry point from `action`. |
| `label` | string | R | Human phrase, indexed as text at boost 2.5 (finder §5.3). ≤ 60 chars. |
| `surfaces` | list | R, ≥1 | `{ text, conf }`. `text` is normalised at build (lowercase, whitespace-collapsed); n ≤ 4 tokens. `conf` ∈ [0,1]. |
| `narrower` / `broader` / `related` | list of ConceptId | O | Must resolve. `broader` is checked for consistency: if A lists B as `broader`, B must list A as `narrower` or the build adds it and warns. |
| `opposite` | ConceptId | O | Exactly one. Symmetric; the build materialises the reverse. |
| `not_the_same_as` | list | O | `{ other, because }`. `because` is required and is one sentence in card voice. |
| `notes` | string | O | For the reviewer, not rendered. Where you explain why the confidences are what they are. |
| `sources` | list | O | §12. |
| `reviewed_by` | string | R at document level, O per concept | Per-concept overrides the document. |

### 8.2 Authoring rules for `conf`

The confidence is **how reliably this phrase means this concept and not something else** —
not how common the phrase is.

| conf | Meaning | Example |
|---|---|---|
| 1.00 | The phrase is unambiguous in this domain | `installed` → `p2.installed`; `no proposal chosen` → `symptom.proposal-mismatch` |
| 0.85–0.95 | Nearly always this, occasionally something else | `vpn` → `obj.tunnel` (occasionally means remote-access VPN) |
| 0.70–0.80 | Genuinely ambiguous but this is the leading reading | `up` → `state.operational`, `working` → `state.operational` |
| 0.50–0.65 | A stretch, included because people say it | `green` → `state.operational`, `crypto` → `obj.tunnel` |
| < 0.50 | Do not author it. It will do more harm than good. | |

**No surface on a `state` concept that has narrower concepts may exceed 0.80.** Lint enforces
it. The reason is finder §2: somebody asking "is it up" does not know which of the four
narrower states they mean, and a high confidence there tells the finder they do.

### 8.3 Governance

| | |
|---|---|
| New `ConceptId` | Two reviewers, named in `concepts/OWNERS` for that domain. Concept ids are the join keys for Rosetta and for ladders; they are as stable as rule ids. |
| New surface on an existing concept | One reviewer. |
| Changed `kind` | Two reviewers **and** a golden-set diff in the PR description. Changing kind changes ranking globally. |
| Withdrawn concept | Never deleted. `status: withdrawn`, and every entry referencing it must be updated in the same PR or the build fails. |

---

## 9. Rosetta documents

Format and equivalence semantics are specified in finder §18. The authoring surface:

```yaml
# rosetta/p2-state.yaml
id: rosetta:p2.state
concept: concept:p2.installed
question: "Is the Phase 2 / IPsec SA installed and carrying traffic?"
reviewed_by: <named human>

platforms:
  junos-srx:
    primary: junos-srx/ipsec.sa.show
    equivalence: same
    verified_on: { platform: junos-srx, version: "<train>" }
  ios-xe:
    primary: ios-xe/ipsec.sa.show
    equivalence: broader
    also: [ios-xe/crypto.session.show]
    differs: >
      show crypto ipsec sa prints the SPIs, the selectors and the packet
      counters in one block, so it answers "installed?" and "passing traffic?"
      at once — on Junos those are two commands.
    confidence: unverified
```

| Field | R/O | Validation |
|---|---|---|
| `id` | R | `rosetta:<dotted>`. |
| `concept` | R | Exactly one, must exist, must be `state`, `attribute` or `action` kind. Object concepts do not map — `st0` and PAN-OS `tunnel.N` are not the same thing and pretending otherwise is the `reth`/LAG error. |
| `question` | R | The neutral question all platforms are answering. Ends in `?`. This is what makes the mapping checkable: if two entries do not answer the same question, they do not belong in the same document. |
| `platforms.<id>.primary` | R | An EntryId on that platform. |
| `platforms.<id>.equivalence` | R | `same` \| `narrower` \| `broader` \| `split` \| `none`. |
| `platforms.<id>.also` | R when `split`, O otherwise | Ordered. |
| `platforms.<id>.nearest` | R when `none` | The closest thing, clearly labelled as not equivalent. |
| `platforms.<id>.differs` | **R unless `same`** | One paragraph, ≤ 60 words. This is the build gate that keeps the layer honest. |
| `platforms.<id>.confidence` | O, default `unverified` | `verified` requires `verified_on`. |

**Lint:** every platform in `corpus.toml`'s `[content].platforms` must appear in every Rosetta
document, even if only as `equivalence: none`. Silence about a platform you claim to cover is
the failure this catches — the same rule `63-rulepack-spec.md` §6.1 applies to version maps.

---

## 10. Ladders, and the containment gate

Ladder documents are specified in `18-diff-verify-rollback.md` §4.3 and are **not
redefined here**. Two things this corpus adds:

### 10.1 Entry points by action concept

```yaml
# ladders/junos-srx/ipsec.bringup.yaml  (excerpt — the rest is 18-diff-verify-rollback §4.3)
answers_concepts: [concept:state.operational, concept:p1.established, concept:p2.installed]
object: concept:obj.tunnel
entry_for:
  concept:act.deploy:   guard        # commit confirmed 5 — after a change
  concept:act.verify:   p1           # a diagnostic query starts at Phase 1
  concept:act.diagnose: p1
```

A diagnostic query must not start with a configuration change. Without `entry_for`, "is the
tunnel up" walks a ladder whose first step is `commit confirmed 5`.

### 10.2 The containment gate

**If a command entry is a step in any ladder, its `next_if_bad` must be a subset of that
ladder's `on_fail` targets.** CI gate 11.

Two sources of truth for "what to do when this fails" would drift inside one release, and the
drift would be invisible, because the two are rendered in different surfaces — `next_if_bad`
on a finder row, `on_fail` when walking a ladder. The gate costs an author nothing when the
ladder is right and catches exactly the case where somebody updated one and not the other.

---

## 11. Explainers on an entry

### 11.1 Three depths, one entry

```yaml
explain:
  terse: "P2 state for one VPN. Want Installed."
  explained: >
    Scoping by vpn-name is the difference between reading one tunnel and
    scrolling past forty. detail adds the SPIs, the lifetimes and the
    bind-interface — and bind-interface is the only link back to st0, because
    the logs never mention st0.
  teaching: file:junos-srx/ipsec.sa.show-vpn-detail.teaching.md
```

Same contract, bounds and lint gates as `63-rulepack-spec.md` §11 — including the banned-phrase
list, the "failure mode present" gate on `teaching`, the "no feature-speak" gate on the
opening of `explained`, and the rule that **depth is not truncation** (lint warns when `terse`
is a strict prefix of `explained`).

One additional gate specific to commands:

> **`explained` must say something the command text does not.** Lint rejects an `explained`
> whose content words are a subset of `cmd` ∪ `answers`. "Shows the IPsec security
> associations in detail" is a restatement and it is what an author writes when they are
> filling in a field rather than teaching.

### 11.2 Links out

| Field | Target | Notes |
|---|---|---|
| `guidebook` | `guide:<dotted>` | Long-form authored explainer. Many entries share one guide; the guide's reverse list is derived at build. |
| `walkthrough` | `walk:<platform>.<task>` or `walk:…#step` | The guided builder (brief §6.2). |
| `related_rules` | `RuleId` | A command that verifies something a rule checks should say so. `ipsec.sa.show-vpn-detail` ↔ `ipsec.pfs.absent`, because that rule's `symptom_if_mismatched` is *"Phase 2 fails while Phase 1 stays up"* and this is the command that shows it. |

All three are corpus ids, resolved at build. A dangling link is a build failure, not a broken
link at runtime — this content ships offline and there is nothing to re-fetch.

---

## 12. `sources`

Identical shapes to `63-rulepack-spec.md` §12, reused verbatim so a reviewer moving between
rules and commands does not learn two formats:

```yaml
sources:
  - { card: "srx-ipsec", side: 3, block: "THE VERIFY LADDER" }
  - { card: "srx-ipsec", side: 3, block: "READING THE SA OUTPUT" }
  - { vendor: juniper, doc: "CLI reference: show security ipsec security-associations", note: "argument forms" }
  - { std: "RFC 7296", section: "1.2", note: "Child SA creation" }
```

| Kind | Fields | Validation |
|---|---|---|
| Field card | `card`, `side`, `block` | Side 1–4; `block` is the section head as printed. The primary source for the SRX corpus. |
| Vendor | `vendor`, `doc`, `note` | `vendor` from the platform registry. A human-locatable title, **never a URL** — URLs rot and the linter has no network (invariant 1). |
| Standard | `std`, `section`, `note` | Shape-checked only. |

An entry with no sources is legal and must say why:

```yaml
sources: []
sources_note: >
  Observed on a lab SRX; no vendor document states the argument form. See
  verified_on.
```

**A fabricated citation is worse than no citation** — it survives review, because nobody looks
up a plausible section number, and it is eventually quoted back to a vendor in a support case.
CI gate 9 requires one or the other.

---

## 13. Authoring workflow

### 13.1 The order that produces good entries

| # | Step | Why this order |
|---|---|---|
| 1 | **Write `answers` first, before pasting the command.** | An author who pastes the command first writes an `answers` that restates it. The lint gate in §3.4 catches the worst cases; writing in this order avoids them. |
| 2 | Find or write the concepts. | If no `Object` concept fits, you have found a gap in the concept layer and that is a separate PR with two reviewers (§8.3). Do not invent one inline. |
| 3 | Paste the command, add `{{slots}}`. | |
| 4 | Run it on a real box. Capture the output. Redact it (§6.4). | This is the step people skip and it is the step that produces `verified_on`. |
| 5 | Fill `output_fields` **from the captured output**, matching the printed labels exactly. | Field names written from memory are wrong about case and about spacing, and the user is matching by eye. |
| 6 | Set `risk`. If not `ReadOnly`, write `blast_radius` and decide `scope_required`. | |
| 7 | Write `next_if_bad`. If the entry is in a ladder, check containment (§10.2). | |
| 8 | Write the three `explain` depths as three texts, not one text three ways. | |
| 9 | `fathom-corpus check` locally. | |
| 10 | Open the PR. The bot posts the golden-query delta. | |

### 13.2 Tooling

```
fathom-corpus new junos-srx ipsec.sa.show-vpn-detail   # scaffolds with every required field
fathom-corpus lint [path]                              # gates 1–8, fast, no index build
fathom-corpus check                                    # gates 1–14, full, builds the index
fathom-corpus build                                    # finder.idx + finder.toml + hashes
fathom-corpus query "check if a tunnel is up" --explain # the scoring breakdown from finder §12
fathom-corpus diff-golden                              # top-5 delta vs the committed expectations
fathom-corpus coverage                                 # concepts with no entries; entries with no concepts
```

`query --explain` prints the per-term BM25 contributions, the per-concept contributions with
`icf`, the gate values and the prior — the same table as finder §12.9. An author who cannot
see why something ranked where it did will tune by adding surfaces at random, and that is how
the concept layer rots.

### 13.3 Review

| Change | Reviewers | Extra requirement |
|---|---|---|
| New entry, `risk: ReadOnly` | 1 | — |
| New entry, `risk != ReadOnly` | 2 | `blast_radius` reviewed specifically, called out in the review |
| New concept | 2 (from `concepts/OWNERS`) | Golden-set delta in the PR body |
| New surface | 1 | — |
| Changed concept `kind` | 2 | Golden-set delta, plus a note on what moved |
| New Rosetta document | 2, and **at least one who has used both platforms** | — |
| `verified: true` on a Rosetta mapping | 1, must be the person who ran it | `verified_on` |
| Weight change in `corpus.toml [finder]` | 2 | Full golden-set diff, in the changelog |

The "at least one who has used both platforms" rule on Rosetta is not process theatre. It is
the only defence against the failure mode named in finder §18.4, and if it cannot be
satisfied the mapping ships `unverified` and says so.

### 13.4 Release

Semver on `corpus.version`. `CHANGELOG.md` names every entry id whose `risk`, `blast_radius`,
`cmd` or `concepts` changed — those are the four fields a downstream consumer needs to diff.
`tree_hash` and `index_hash` recomputed and published. Corpus releases are independent of
application releases; `[compat]` bounds which application versions accept them.

---

## 14. CI validation — the gates

Ordered. `lint` runs 1–8; `check` runs all fifteen.

| # | Gate | Failure mode it catches |
|---|---|---|
| 1 | **Schema.** Every document validates against the generated JSON Schema. `id` equals platform + path. Every enum value is legal. | Typos, wrong field names, `risk: read-only` instead of `ReadOnly`. |
| 2 | **Reference integrity.** Every `ConceptId`, `EntryId`, `RuleId`, `GuideId`, `WalkId`, `LadderId`, `StepId` resolves. Every `{{slot}}` has a `slots` entry and vice versa. | Dangling links in offline content, which cannot be fixed at runtime. |
| 3 | **Required-field coverage.** The seven questions of §1. `blast_radius` and `reversible` present when `risk != ReadOnly`. `output_fields` present when `ReadOnly` and `weight ≥ 2`. `commit_model` present when `mode: configuration`. | Half-written entries. |
| 4 | **Voice.** Banned phrases in `answers`, `explain.*`, `blast_radius`. `answers` ends in `?`, does not begin with "Shows"/"Displays"/"Lists", and shares no non-proper-noun token with `cmd`. `explained` is not a subset of `cmd ∪ answers`. `terse` is not a prefix of `explained`. `blast_radius` contains a consequence verb and no hedging word. | Restatement, feature-speak, and "use with caution". |
| 5 | **Placeholder shape.** Every `placeholder` matches `^<[a-z0-9-]+>$`. No `{{slot}}` inside a `wraps` break. Any `cmd` over 62 chars has at least one wrap point. | Placeholders that get pasted into a terminal because they did not look like placeholders. |
| 6 | **Concept hygiene.** Every entry has ≥1 `object` and ≥1 `action` concept, ≤6 total. No `state` concept with narrower children has a surface above 0.80. No concept is attached to >15% of the corpus. No orphan concepts (zero entries). No duplicate surface text mapping to two concepts of the same `kind` without a `not_the_same_as` between them. | The two most likely corpus regressions: over-attachment and surface poisoning. |
| 7 | **Canonicality.** At most one `weight: 3` per (concept, platform). | Two commands both claiming to be *the* answer. |
| 8 | **Version predicates.** Every `versions` map covers every platform the entry claims. VERS parses under the declared scheme. | Silence about a platform you claimed to cover. |
| 9 | **Sources.** `sources` non-empty or `sources_note` present. Citation *shapes* valid (no network — invariant 1). No URLs in `vendor.doc`. | Fabricated and rotted citations. |
| 10 | **`requires`/`supplies` consistency.** Every `requires.field` exists in the supplier's `output_fields` and is listed in its `supplies`. | A dependency that points at a field nobody prints. |
| 11 | **Ladder containment.** §10.2. | Two drifting sources of truth for "what next". |
| 12 | **Rosetta completeness.** Every platform in `[content].platforms` appears in every Rosetta document. `differs` present on every non-`same` equivalence. `verified` requires `verified_on`. `split` and `none` have no derived inverse. | The whole of finder §18's honesty argument. |
| 13 | **Redaction.** §6.4, over `golden/outputs/` and over every literal in every entry. | A real peer address in a corpus that exists to argue the product is trustworthy with configs. |
| 14 | **Golden queries.** `finder.idx` built; ~120 queries run; top-5 diffed against `golden/queries.yaml`. | Ranking regressions. |
| 15 | **Risk is effect (ADR-0011).** Any entry whose `blast_radius` matches `/blackhole|traffic stops|drops .*(adjacency|traffic)|never comes up|stops negotiating/i` and is not `Disruptive` fails. | The mode-derived mapping R03 found: a corpus whose red band never lands on the `set` lines that drop traffic. Heuristic — ADR-0011's *Revisit if* demotes it to a review prompt if false failures outnumber true ones over a hundred entries. |

**Gate 14 is a report, not a failure.** It posts a diff on the PR and requires a reviewer
acknowledgement. Making it a hard failure trains authors to update the expectations without
reading them, which is how golden tests stop working. Every other gate is a hard failure.

Gates 1–8 target well under a second on a 1,200-entry corpus so they can run on save. Gate 14
is the slow one (index build plus 120 queries) and runs in CI only.

---

## 15. Eight worked entries

All eight are drawn from the four sides of the SRX field card. Junos syntax and semantics
below are the card's; PAN-OS command names are checked against vendor documentation and the
output-field semantics are explicitly not (entry 8).

`<named human>` and `<train>` stand in for values a real corpus fills.

### 15.1 `junos-srx/ipsec.sa.show-vpn-detail` — the canonical Phase 2 read

```yaml
id: junos-srx/ipsec.sa.show-vpn-detail
entry_version: 1.0.0
status: active
reviewed_by: <named human>
reviewed_on: 2026-07-28
verified_on: { platform: junos-srx, version: "<train>" }

cmd: "show security ipsec security-associations vpn-name {{vpn}} detail"
wraps: [5]
mode: operational
platform: junos-srx
versions: "*"

risk: ReadOnly
domain: ipsec
weight: 3
tags: [phase2, bring-up, verify]

answers: "Is Phase 2 installed and passing traffic on this one tunnel?"
aka:
  - "is the tunnel up"
  - "is the vpn up"
  - "phase 2 status"
  - "p2 state"
  - "is the ipsec sa installed"
  - "check one tunnel"
concepts:
  - concept:obj.tunnel
  - concept:obj.ipsec-sa
  - concept:p2.installed
  - concept:act.verify
  - concept:phase.p2

read_field: "State — want Installed"
output_fields:
  - field: State
    means: "Phase 2 SA state."
    want: "Installed"
    bad:
      - { value: "*", means: "Anything but Installed is not passing traffic." }
  - field: SPI
    means: "Security Parameter Index, one per direction."
    want: any
    tell: "Two lines per selector is correct, not a duplicate."
  - field: Lifetime
    means: "Hard and soft countdown to the next rekey."
    want: any
    tell: "Use it to time a capture around the rekey event."
  - field: Bind-interface
    means: "The st0 unit this VPN is bound to."
    want: any
    join_key: true
    tell: >
      The join back to st0. The logs never mention st0, so this is the only
      link between an SA and an interface.
  - field: Port
    means: "Remote IKE port on the underlying Phase 1 SA."
    want: any
    tell: "500 direct. 4500 means NAT-T is in path."
sample_output: golden/outputs/ipsec-sa-installed.txt

slots:
  - name: vpn
    binds: { kind: IpsecVpn, field: name }
    accepts: [Identifier]
    placeholder: "<vpn-name>"
    required: true

next_if_bad:
  - junos-srx/ipsec.inactive-tunnels
  - junos-srx/ike.sa.show
related:
  - junos-srx/ipsec.statistics.index
  - junos-srx/ike.sa.show-detail
  - junos-srx/interface.st0.terse
supplies: [Index, SPI]

guidebook: [guide:ipsec.phase2.state]
walkthrough: [walk:junos-srx.s2s-ipsec#verify]
related_rules: [ipsec.pfs.absent, ipsec.traffic-selector.not-mirrored]

explain:
  terse: "P2 state for one VPN. Want Installed."
  explained: >
    Scoping by vpn-name is the difference between reading one tunnel and
    scrolling past forty. detail adds the SPIs, the lifetimes and the
    bind-interface — and bind-interface is the only link back to st0, because
    the logs never mention st0 at all.
  teaching: >
    Phase 2 rides inside Phase 1, and the two fail independently. A healthy
    Phase 1 with a dead Phase 2 is the most common shape of a broken tunnel and
    the reason this command exists separately from the IKE one. Installed here
    means the kernel holds a key pair for this selector — it does not mean
    anything is reaching the far end. A tunnel can read Installed and pass zero
    packets when st0 has no zone, no policy, or nothing routed at it. If State
    is Installed and traffic still is not moving, stop reading proposals and go
    look at the plumbing.

sources:
  - { card: "srx-ipsec", side: 3, block: "THE VERIFY LADDER" }
  - { card: "srx-ipsec", side: 3, block: "READING THE SA OUTPUT" }
  - { card: "srx-ipsec", side: 1, block: "THE FIVE PLUMBING PIECES" }
```

### 15.2 `junos-srx/ipsec.inactive-tunnels` — the underused one

```yaml
id: junos-srx/ipsec.inactive-tunnels
entry_version: 1.0.0
status: active
reviewed_by: <named human>
reviewed_on: 2026-07-28
verified_on: { platform: junos-srx, version: "<train>" }

cmd: "show security ipsec inactive-tunnels"
mode: operational
platform: junos-srx
versions: "*"

risk: ReadOnly
domain: ipsec
weight: 2
tags: [phase2, diagnose]

title: "Inactive tunnels, with reasons"
answers: "Which tunnels are down, and what reason does the box give?"
aka:
  - "why is the tunnel down"
  - "tunnel down reason"
  - "what is broken"
  - "which tunnels are not up"
concepts:
  - concept:obj.tunnel
  - concept:state.down
  - concept:act.diagnose
symptoms:
  - concept:symptom.tunnel-down
  - concept:symptom.tunnel-flapping

read_field: "Tunnel Down Reason — often the whole answer"
output_fields:
  - field: "Tunnel Down Reason"
    means: "The box's own explanation for why this tunnel is not established."
    want: any
    tell: >
      This is the field almost nobody reads. It frequently names the exact
      mismatch and removes the need for any log reading at all.
  - field: "Total inactive tunnels"
    means: "Count of tunnels currently not established."
    want: "0"

next_if_bad:
  - explain:decoder:no-proposal-p2
  - junos-srx/log.kmd.match-peer
related:
  - junos-srx/ipsec.sa.show
  - junos-srx/ike.sa.show
  - junos-srx/log.kmd.match-peer

guidebook: [guide:ipsec.phase2.state]
related_rules: [ipsec.pfs.group-mismatch, ipsec.traffic-selector.not-mirrored]

explain:
  terse: "Names what is down and why."
  explained: >
    inactive-tunnels is the underused one. It names what is down and prints a
    Tunnel Down Reason, which is often the whole answer — before you open a
    single log.
  teaching: >
    The instinct when a tunnel is down is to go to the log. The log is a
    lifecycle narrative and it takes reading. inactive-tunnels is a table, and
    the Tunnel Down Reason column is the box telling you what it decided and
    why. Run this before show log kmd, every time. If the reason is a proposal
    mismatch you have your answer in one line; if it is empty or unhelpful,
    then go to the log — but you have lost four seconds rather than four
    minutes.

sources:
  - { card: "srx-ipsec", side: 3, block: "THE VERIFY LADDER" }
  - { card: "srx-ipsec", side: 1, block: "BRING-UP ORDER" }
```

### 15.3 `junos-srx/ike.sa.show-detail` — Phase 1, with the NAT-T tell

```yaml
id: junos-srx/ike.sa.show-detail
entry_version: 1.0.0
status: active
reviewed_by: <named human>
reviewed_on: 2026-07-28
verified_on: { platform: junos-srx, version: "<train>" }

cmd: "show security ike security-associations detail"
mode: operational
platform: junos-srx
versions: "*"

risk: ReadOnly
domain: ike
weight: 2
tags: [phase1, nat-t, identity]

answers: "What are the Phase 1 SAs, and is NAT in the path?"
aka:
  - "is phase 1 up"
  - "is ike up"
  - "is nat-t active"
  - "which side initiated"
  - "ike sa details"
concepts:
  - concept:obj.ike-sa
  - concept:p1.established
  - concept:act.verify
  - concept:phase.p1
  - concept:attr.nat-traversal

read_field: "Port — 4500 means NAT-T is active"
output_fields:
  - field: Index
    means: "Phase 1 SA identifier."
    want: any
    tell: "Same index a minute later = stable. New index = it rebuilt."
  - field: Role
    means: "Initiator or Responder."
    want: any
    tell: >
      Always Responder means your side never initiates — check
      establish-tunnels and the route at st0.
  - field: Port
    means: "Remote IKE port."
    want: any
    tell: >
      500 is direct. 4500 means NAT-T is active and ESP is wrapped in UDP,
      costing 8 bytes of MTU. A peer address that does not match the source you
      actually see also means NAT in path.
  - field: "Remote Address"
    means: "The peer as this box sees it."
    want: any
    join_key: true

next_if_bad:
  - junos-srx/ipsec.inactive-tunnels
  - junos-srx/log.kmd.match-peer
  - explain:decoder:auth-failed
related:
  - junos-srx/ike.sa.show
  - junos-srx/ike.active-peer
  - junos-srx/ipsec.sa.show
supplies: [Index]

guidebook: [guide:ike.phase1.identity, guide:ipsec.nat-traversal]
related_rules: [ike.identity.mismatch, mtu.mss-clamp.absent]

explain:
  terse: "P1 detail. Port 4500 = NAT-T."
  explained: >
    detail is where Role, Port and the identities live. Port 4500 means IKE
    detected NAT during Phase 1 and both peers moved to UDP encapsulation —
    which costs 8 bytes and turns into an MTU problem later.
  teaching: >
    ESP is IP protocol 50 and carries no ports, so a NAT device doing PAT
    cannot track it. IKE detects this during Phase 1 and both peers move to UDP
    4500, wrapping ESP in UDP. Nothing announces this; the only tell is the
    port in this output. It matters twice: it costs 8 bytes of payload, and if
    the NAT device's UDP idle timer is shorter than the keepalive the mapping
    dies and the tunnel goes one-way until the next rekey. The symptom is
    "works, then stops after N minutes of quiet", and nobody attributes that to
    a NAT timer on the first day.

sources:
  - { card: "srx-ipsec", side: 3, block: "READING THE SA OUTPUT" }
  - { card: "srx-ipsec", side: 2, block: "NAT TRAVERSAL" }
```

### 15.4 `junos-srx/ike.sa.clear-peer` — `Disruptive`, scoped

```yaml
id: junos-srx/ike.sa.clear-peer
entry_version: 1.0.0
status: active
reviewed_by: <named human>
reviewed_on: 2026-07-28
verified_on: { platform: junos-srx, version: "<train>" }

cmd: "clear security ike security-associations {{peer}}"
mode: operational
platform: junos-srx
versions: "*"

risk: Disruptive
blast_radius: >
  Tears down the IKE SA with this peer and every child IPsec SA under it. On a
  hub that is every spoke behind this peer at once. Traffic stops until each
  tunnel renegotiates.
scope_required: [peer]
reversible: self

domain: ike
weight: 2
tags: [phase1, disruptive, rekey]

answers: "How do I force Phase 1 to renegotiate with one peer?"
aka:
  - "restart the tunnel"
  - "bounce the vpn"
  - "force a rekey"
  - "clear ike sa"
  - "reset phase 1"
concepts:
  - concept:obj.ike-sa
  - concept:act.clear
  - concept:phase.p1

read_field: "No output on success — re-run show security ike security-associations"

slots:
  - name: peer
    binds: { kind: IkeGateway, field: address }
    accepts: [Ip4, Ip6]
    placeholder: "<peer-ip>"
    required: true

next_if_bad:
  - junos-srx/ike.sa.show
  - junos-srx/log.kmd.match-peer
related:
  - junos-srx/ipsec.sa.clear-vpn
  - junos-srx/ike.sa.clear-index
  - junos-srx/ike.sa.clear-all

guidebook: [guide:ipsec.clearing-and-rekey]

explain:
  terse: "Rebuilds P1 with one peer. Takes its children with it."
  explained: >
    Always scope by peer or index. Clearing Phase 1 tears down every child SA
    under it, and on a hub that is every spoke at once. Clearing Phase 2 alone
    is the cheaper move and proves the same thing.
  teaching: >
    This command is the reflex when a tunnel misbehaves and it is almost always
    the wrong first move. Phase 2 rides inside Phase 1: clearing P2 forces a
    rekey and is the cheapest way to prove a tunnel comes back cleanly, without
    touching anything else. Clearing P1 takes every child SA with it, and on a
    hub terminating forty spokes behind one peer address that is forty tunnels
    renegotiating simultaneously — which is also forty DH exponentiations
    landing on the RE at once. Reach for clear security ipsec
    security-associations first. Come here only when Phase 1 itself is the
    thing you doubt.

sources:
  - { card: "srx-ipsec", side: 3, block: "CLEARING & RENEGOTIATING" }
```

### 15.5 `junos-srx/ipsec.statistics.index` — the one-way tell

```yaml
id: junos-srx/ipsec.statistics.index
entry_version: 1.0.0
status: active
reviewed_by: <named human>
reviewed_on: 2026-07-28
verified_on: { platform: junos-srx, version: "<train>" }

cmd: "show security ipsec statistics index {{id}}"
mode: operational
platform: junos-srx
versions: "*"

risk: ReadOnly
domain: ipsec
weight: 1
tags: [phase2, counters, one-way]

answers: "Is this tunnel actually passing packets, in both directions?"
aka:
  - "is traffic flowing"
  - "packet counters"
  - "is anything coming back"
  - "esp errors"
  - "replay errors"
concepts:
  - concept:obj.tunnel
  - concept:obj.ipsec-sa
  - concept:dataplane.passing
  - concept:act.verify
symptoms:
  - concept:symptom.one-way-traffic

read_field: "Encrypted vs decrypted bytes — both must climb"
output_fields:
  - field: "Encrypted bytes"
    means: "Traffic this box has encrypted and sent into the tunnel."
    want: any
    tell: "Climbing while decrypted is flat is the one-way tell."
  - field: "Decrypted bytes"
    means: "Traffic received on this SA and successfully decrypted."
    want: any
    tell: >
      Flat while encrypted climbs means your ESP is leaving and nothing is
      coming back. That is a return-path or far-end problem, not a crypto
      problem. Stop reading proposals.
  - field: "AH authentication failures / ESP authentication failures"
    means: "Packets that arrived but failed integrity check."
    want: "0"
    tell: >
      Failures with traffic still flowing usually means corruption in path, not
      a key mismatch — a wrong key fails everything, not some of it.
  - field: "Replay errors"
    means: "Packets dropped as duplicate or outside the anti-replay window."
    want: any
    tell: >
      A small static count is noise, almost always ECMP or per-packet
      load-balancing in the underlay. A climbing count means real reordering or
      loss — and lost DPD probes on that same path will tear the tunnel down.

slots:
  - name: id
    binds: null
    accepts: [Integer]
    placeholder: "<sa-index>"
    required: true

requires:
  - { slot: id, from: junos-srx/ipsec.sa.show, field: Index }

next_if_bad:
  - junos-srx/interface.st0.terse
  - junos-srx/route.show
  - junos-srx/flow.session.show
related:
  - junos-srx/ipsec.statistics.all
  - junos-srx/ipsec.sa.show-vpn-detail

guidebook: [guide:ipsec.counters-and-replay]
related_rules: [mtu.mss-clamp.absent]

explain:
  terse: "Byte and packet counters, then the error block."
  explained: >
    Read the byte and packet counters first, then the error block. Encrypted
    climbing with decrypted flat is a return-path problem and no amount of
    proposal tuning will fix it.
  teaching: >
    Counters answer a question the SA state cannot. Installed means the kernel
    holds keys; it says nothing about whether packets are moving. The most
    valuable reading here is asymmetry: encrypted climbing while decrypted
    stays flat means your ESP is leaving and nothing is coming back, which
    points at the return path or the far end and away from crypto entirely.
    Replay errors connect to flapping in a way that is not obvious — a path
    that reorders enough to trip anti-replay is a path that drops DPD probes,
    and DPD tearing down a healthy tunnel looks exactly like a crypto failure
    in the log.

sources:
  - { card: "srx-ipsec", side: 3, block: "STATISTICS & COUNTERS" }
  - { card: "srx-ipsec", side: 4, block: "REPLAY ERRORS" }
```

### 15.6 `junos-srx/ping.dnf-sized` — the MTU binary search

```yaml
id: junos-srx/ping.dnf-sized
entry_version: 1.0.0
status: active
reviewed_by: <named human>
reviewed_on: 2026-07-28
verified_on: { platform: junos-srx, version: "<train>" }

cmd: "ping {{dest}} do-not-fragment size {{size}} count 3 source {{source}}"
wraps: [4]
mode: operational
platform: junos-srx
versions: "*"

risk: ReadOnly
domain: mtu
weight: 3
tags: [mtu, fragmentation, day-two]

answers: "What is the largest packet that survives the path?"
aka:
  - "find the mtu"
  - "test path mtu"
  - "why do big packets disappear"
  - "df bit ping"
  - "test fragmentation"
concepts:
  - concept:obj.path
  - concept:attr.mtu
  - concept:act.measure
symptoms:
  - concept:symptom.stalls-under-load
  - concept:symptom.handshake-ok-data-stalls

read_field: "Loss — 0% means this size fits"
output_fields:
  - field: "packet loss"
    means: "Whether packets of this size survived the path."
    want: "0%"
    bad:
      - value: "100%"
        means: >
          This size does not fit and DF stopped anything from fragmenting it.
          Halve the difference and try again.

slots:
  - name: dest
    binds: { kind: Address, field: value, via: [remote_selector_host] }
    accepts: [Ip4, Ip6]
    placeholder: "<remote-host>"
    required: true
  - name: size
    binds: null
    accepts: [Integer]
    placeholder: "<icmp-payload-bytes>"
    required: true
    suggest:
      - { value: 1472, note: "1500 on the wire — standard Ethernet, the first test" }
      - { value: 1372, note: "1400 on the wire — the conventional tunnel clamp" }
      - { value: 1422, note: "1450 on the wire — the midpoint if 1472 fails and 1372 passes" }
  - name: source
    binds: { kind: Address, field: value, via: [lan_unit, address] }
    accepts: [Ip4, Ip6]
    placeholder: "<lan-side-address>"
    required: false

next_if_bad:
  - junos-srx/flow.tcp-mss.show
  - junos-srx/interface.st0.mtu.show
related:
  - junos-srx/interface.st0.mtu.show
  - junos-srx/flow.tcp-mss.set-ipsec

guidebook: [guide:mtu.the-story, guide:mtu.three-fixes]
related_rules: [mtu.mss-clamp.absent, mtu.st0.unset]

explain:
  terse: "size is the ICMP payload. Add 28 for wire size."
  explained: >
    size is the ICMP payload, so add 28 (20 IP + 8 ICMP) for the wire size:
    1472 becomes 1500. If 1472 fails and 1372 passes, path MTU is around 1400 —
    binary-search between them.
  teaching: >
    A bare ping from the SRX tests the SRX's own path, not the tunnel. To test
    the tunnel you must source from an address inside the traffic selector, or
    from the LAN interface — otherwise the packet never enters the tunnel and
    you have measured the underlay. The symptom that brings people here is
    specific: ping works, SSH connects, then ls hangs or a transfer stalls at
    0%. Small packets fit and full-size ones exceed the tunnel MTU and vanish.
    Handshake fine, data stalls is MTU until proven otherwise. The reason it
    fails silently is that Path MTU Discovery depends on an ICMP
    fragmentation-needed message getting back to the sender, and that ICMP is
    filtered somewhere on almost every real path. The sender never learns to
    shrink. That is exactly why MSS clamping exists — it does not depend on
    ICMP getting through at all.

sources:
  - { card: "srx-ipsec", side: 4, block: "TEST IT FROM THE BOX" }
  - { card: "srx-ipsec", side: 4, block: "THE MTU STORY" }
  - { card: "srx-ipsec", side: 4, block: "PMTUD & THE DF BIT" }
```

### 15.7 `junos-srx/ike.traceoptions.file` — `ChangesConfig`, with a mandatory teardown

```yaml
id: junos-srx/ike.traceoptions.file
entry_version: 1.0.0
status: active
reviewed_by: <named human>
reviewed_on: 2026-07-28
verified_on: { platform: junos-srx, version: "<train>" }

cmd: "set security ike traceoptions file ike-trace size 5m files 5"
wraps: [4]
mode: configuration
platform: junos-srx
versions: "*"

risk: ChangesConfig
blast_radius: >
  Writes IKE trace output to /var. Left on, it fills /var, which breaks logging
  and commits both. flag all loads the routing engine and buries the signal.
reversible: paired
paired_teardown: junos-srx/ike.traceoptions.delete
commit_model: junos-commit

domain: ike
weight: 2
tags: [phase1, tracing, day-two]

answers: "How do I capture IKE negotiation to its own file?"
aka:
  - "turn on ike debugging"
  - "ike traceoptions"
  - "capture the negotiation"
  - "debug phase 1"
concepts:
  - concept:obj.ike-sa
  - concept:act.capture
  - concept:phase.p1

read_field: "No output — the file appears after the next negotiation"

next_if_bad:
  - junos-srx/log.iketrace.show
related:
  - junos-srx/ike.traceoptions.flag-ike
  - junos-srx/ike.traceoptions.delete
  - junos-srx/log.kmd.match-peer
  - junos-srx/system.storage.show

guidebook: [guide:ipsec.tracing]

explain:
  terse: "IKE trace to its own file. Delete it afterwards."
  explained: >
    Without a file statement IKE tracing lands in kmd, mixed with everything
    else. Set a file and a size, add flag ike, commit confirmed 5, reproduce,
    read it — then delete the traceoptions and commit. Always.
  teaching: >
    Traceoptions are the most useful and the most frequently abandoned tool on
    the box. Three things go wrong with them, in order of frequency. Without a
    file statement the output goes to kmd, where it is interleaved with every
    other daemon's story and the thing you wanted is unfindable. flag all
    produces so much output that it buries the signal and loads the routing
    engine while doing it — flag ike is what you want. And traceoptions left
    on will fill /var, which breaks logging and commits both, so the box stops
    being able to tell you what is wrong at the exact moment you need it to.
    Turn it on, reproduce, read it, delete it, commit. The teardown is part of
    the procedure, not a tidy-up.

sources:
  - { card: "srx-ipsec", side: 3, block: "LOGS & TRACEOPTIONS" }
```

The paired teardown is its own entry and renders inline with this one:

```yaml
id: junos-srx/ike.traceoptions.delete
entry_version: 1.0.0
status: active
reviewed_by: <named human>
reviewed_on: 2026-07-28
verified_on: { platform: junos-srx, version: "<train>" }

cmd: "delete security ike traceoptions"
mode: configuration
platform: junos-srx
versions: "*"

risk: ChangesConfig
blast_radius: "Stops IKE tracing. No traffic effect."
reversible: paired
paired_teardown: junos-srx/ike.traceoptions.file
commit_model: junos-commit

domain: ike
weight: 3
tags: [phase1, tracing, cleanup]

answers: "How do I turn IKE tracing back off?"
aka: ["stop ike tracing", "clean up traceoptions", "turn off debugging"]
concepts: [concept:obj.ike-sa, concept:act.capture]
read_field: "Commit must follow — the delete alone does nothing"
related: [junos-srx/ike.traceoptions.file, junos-srx/system.storage.show]

explain:
  terse: "Always clean up. Commit after."
  explained: >
    A delete without a commit changes nothing. Traceoptions left running fill
    /var, and a full /var breaks logging and commits both.
  teaching: >
    This entry exists as its own command because the failure it prevents is a
    week later and looks unrelated: commits start failing, logs stop being
    written, and nobody connects it to the trace somebody left on during an
    incident three Fridays ago. Check show system storage when /var is
    suspect. The teardown belongs in the same change window as the setup.

sources:
  - { card: "srx-ipsec", side: 3, block: "LOGS & TRACEOPTIONS" }
```

### 15.8 `panos/ipsec.sa.show` — the Rosetta counterpart, shipped honestly

```yaml
id: panos/ipsec.sa.show
entry_version: 0.1.0
status: draft                      # ranks −0.15 and renders a `draft` margin tab
reviewed_by: <named human>
reviewed_on: 2026-07-28
# verified_on deliberately absent — nobody has run this for the corpus yet

cmd: "show vpn ipsec-sa"
mode: operational
platform: panos
versions: "*"

risk: ReadOnly
domain: ipsec
weight: 3
tags: [phase2, verify]

answers: "Is the Phase 2 / IPsec SA up on this firewall?"
aka:
  - "is the tunnel up"
  - "phase 2 status"
  - "ipsec sa"
  - "check the vpn"
concepts:
  - concept:obj.tunnel
  - concept:obj.ipsec-sa
  - concept:p2.installed
  - concept:act.verify
  - concept:phase.p2

read_field: "Tunnel state — want a live SA for the named tunnel"
# output_fields deliberately empty: gate 3 requires them at weight >= 2 for an
# `active` entry, which is exactly why this ships as `draft`. It becomes active
# when somebody fills them in from real output.
output_fields: []

next_if_bad:
  - panos/ike.sa.show
related:
  - panos/ike.sa.show
  - panos/vpn.flow.show

guidebook: [guide:ipsec.phase2.state]

explain:
  terse: "PAN-OS Phase 2 SAs."
  explained: >
    PAN-OS splits the two phases across two commands the way Junos does:
    show vpn ike-sa for Phase 1 and show vpn ipsec-sa for Phase 2. The split
    that matters on Junos matters here for the same reason.
  teaching: >
    The reason this entry exists before anyone has verified its output fields
    is the Rosetta layer: a Junos engineer asking "what is the PAN-OS version of
    show security ipsec security-associations" needs an answer today, and an
    answer labelled draft and unverified is more useful than silence and less
    dangerous than a confident one. What is not yet recorded is the exact field
    names PAN-OS prints and what its state values mean — and those are what an
    engineer actually reads. Until somebody runs it, this entry tells you which
    command to type and nothing more.

sources:
  - { vendor: palo-alto, doc: "IPSec VPN administration: view the status of the tunnels", note: "show vpn ike-sa is Phase 1, show vpn ipsec-sa is Phase 2" }
sources_note: >
  Command names checked against vendor documentation. Output field names and
  state values are not recorded here because they have not been observed —
  see status: draft and the absent verified_on.
```

<!-- VERIFY: the exact field labels and state values printed by `show vpn ipsec-sa` on the
PAN-OS trains this corpus targets, and whether `show vpn flow` is the right `related` entry
for counters. Both are needed before this entry moves from `draft` to `active`. -->

**Entry 8 is included deliberately as the format's honesty machinery working**, not as a
finished entry. `status: draft`, absent `verified_on`, empty `output_fields`, and a
`sources_note` that says exactly what is and is not known. The finder still returns it, one
rank lower, with two margin tabs saying `draft` and `unverified`. That is the correct
behaviour for content nobody has checked, and it is why gate 3 makes `output_fields` a
requirement for `active` rather than for existence.

---

## 16. Proposed changes to the brief's example

Four, all called out because the brief is the authority (`.context/owner-brief.md`, preamble).

| # | Brief | Proposed | Reasoning |
|---|---|---|---|
| 1 | `vendor: junos-srx` | `platform: junos-srx` | Conventions: *"a **platform** is a vendor+family target; never say **vendor** — a vendor has many platforms."* `junos-srx` is already a platform id. This is a rename to match a binding convention, nothing more. |
| 2 | `intent: [tunnel-up, phase2-state, verify-vpn]` | `concepts: [concept:obj.tunnel, concept:p2.installed, concept:act.verify, …]` | The brief's three values *are* concepts — one object, one state, one action, which is exactly the kind taxonomy in §8. Giving them resolvable ids is what lets Rosetta hang off them (finder §18.3, `O(platforms)` not `O(platforms²)`), what lets ladders declare `answers_concepts`, and what makes `icf` computable. Bare slugs cannot do any of that. |
| 3 | `risk: read-only` | `risk: ReadOnly` | Conventions pin exactly three tokens. One spelling in YAML, in Rust, in the UI and on the card avoids a mapping table that will eventually be wrong in one direction. The *rendered* label remains the card's `READ-ONLY — SAFE ON PRODUCTION`, unchanged. |
| 4 | `rosetta: { panos: "...", ios: "..." }` on the entry | `rosetta/*.yaml` keyed by concept; `rosetta:` on the entry becomes a derived read-only field materialised at index build | Finder §18. The inline form cannot express `split` or `none`, has nowhere to put the mandatory `differs` sentence, and grows quadratically in platforms. The brief makes the identical argument for rules in §5.2 (*"`N` vendors × `M` domains grows linearly, not quadratically"*); this applies it to mappings. |

`phase: ipsec` from the brief's example is absorbed into `domain: ipsec` plus
`concept:phase.p2`, which separates "which part of the corpus this belongs to" from "which
protocol phase this is about" — two things the single field was doing at once.

---

## 17. Entries the card implies that are not written here

Written down so a corpus author has a work list and so a reviewer can see what is missing
rather than assuming it was considered.

| Entry | Card source | Note |
|---|---|---|
| `junos-srx/system.commit.show` | Side 4, `BOX-LEVEL CONTEXT` | *"RUN THIS FIRST… If the newest commit lines up with the first flap in kmd, you have your answer and it is not PFS. Correlate before you theorise."* Should be `weight: 3` on `concept:act.diagnose` for every domain, which is the only entry in the corpus that will need a cross-domain canonicality exception. |
| `junos-srx/ipsec.sa.clear-vpn` | Side 3, `CLEARING & RENEGOTIATING` | `Disruptive`, but the *cheap* one — *"Clearing P2 alone forces a rekey and is the cheapest way to prove a tunnel comes back cleanly."* Should outrank `ike.sa.clear-peer` on `concept:act.clear`. |
| `junos-srx/ike.sa.clear-all` | Side 3 | The unscoped form. `Disruptive`, reachable only by syntax match (§4.3). |
| `junos-srx/interface.st0.terse`, `route.show`, `flow.session.show` | Side 1, `BRING-UP ORDER` steps 5, 6, 8 | The plumbing half of the ladder. *"Steps 5–8 failing while 2–4 are clean is plumbing, not crypto."* |
| `junos-srx/ipsec.next-hop-tunnels` | Side 3 | NHTB. Narrow, `weight: 0`. |
| `junos-srx/flow.tcp-mss.set-ipsec` | Side 4, `WHERE TO SET IT` | `ChangesConfig`. The `all-tcp` variant needs its own entry with a much larger `blast_radius` — *"a far bigger blast radius than most people intend."* |
| `junos-srx/system.storage.show` | Side 4 | *"/var full = no logs."* The `related` target of both traceoptions entries. |
| `junos-srx/monitor.kmd.start` | Side 3 | `monitor start kmd` — and `monitor stop kmd` as its `paired_teardown`. |
| Filter entries | Side 3, throughout | `\| match`, `\| last 200`, `\| display set`. `mode: pipe-filter`, explained separately from the command (finder §15.3). |
| `panos/*`, `ios-xe/*`, `fortios/*` beyond the Rosetta primaries | — | The bulk of the authoring work, and the part that needs authors this project does not have yet. |

---

## 18. What this format costs

Stated plainly, because every one of these is a real cost and the format is not obviously
worth it if you only count the fields.

| Cost | Size | Mitigation, and whether it is enough |
|---|---|---|
| **Fifteen-ish required fields per entry.** A command entry is not five minutes. | ~30–45 minutes per entry for someone who knows the platform, plus the time to run it. 1,200 entries is person-months. | `fathom-corpus new` scaffolds; `derive_for` shares bodies across sibling platforms. Not enough. The honest answer is that the corpus is the product's cost centre and always will be. |
| **A second authoring surface (concepts) that can drift from the first.** | Gate 6 catches absence and over-attachment. It cannot catch *wrong* concepts. | The golden query set, and nothing else. Budget review time. |
| **`output_fields` requires real output.** An author who cannot get to a box cannot write a complete entry. | This is what `status: draft` is for, and entry 8 shows it working. | Adequate, at the price of a corpus with a visible draft fraction. Publishing that fraction is better than hiding it. |
| **Rosetta needs an author who knows two platforms.** | Finder §18.4. | `confidence: unverified` by default and a mandatory `differs` sentence. Procedural, not technical. Expect the first external bug reports here. |
| **The `weight: 3` uniqueness rule forces arguments.** Two authors will both believe their command is *the* answer. | Gate 7 fails the build. | Good. The argument is worth having once, at authoring time, rather than being had by every user of the finder forever. |
| **Redaction gate 13 will produce false positives.** A legitimate hex string over 24 characters trips it. | An allowlist, checked in, with a reason per entry. | Adequate, and deliberately annoying — the same posture `13-emitters-and-provenance.md` takes on its block-table gate. |
| **Entry ids are stable forever.** A badly-chosen id is permanent. | Same rule as rule ids. | The naming convention (`<domain>.<object>.<verb-or-form>`) is the only defence. Review ids specifically on a new entry. |

---

## 19. Open decisions

| # | Decision | Options | Leaning |
|---|---|---|---|
| D1 | Should `aka` phrases be auto-promoted to concept surfaces, or only proposed? | auto / propose | **Propose.** Auto-promotion means an entry author edits the global vocabulary without the two-reviewer gate in §8.3, which is precisely the surface-poisoning failure mode. |
| D2 | One corpus, or one pack per domain the way rule packs work? | one / many | **One** at v1. Splitting adds a dependency-resolution problem for concepts, which are global by nature. Revisit when a third party wants to ship commands. |
| D3 | Should `output_fields` be required on every `ReadOnly` entry, not just `weight ≥ 2`? | yes / no | **No** at v1. Requiring it everywhere would push most of the corpus into `draft` and make the draft signal meaningless. Revisit once coverage is good. |
| D4 | Do filter entries (`\| match`) live in `commands/` with `mode: pipe-filter`, or in their own tree? | mixed / separate | **Separate** (`filters/`), as laid out in §2. They compose with every command rather than being one, and mixing them makes `coverage` reports lie. |
| D5 | `derive_for` sibling platforms — same entry body, or a diff-able override block? | copy / override | Needs a real case. `ios` vs `ios-xe` will diverge in `versions` and possibly in `output_fields`, and a copy that silently drifts is worse than an override that is explicit. |
| D6 | Localisation of `answers` and `aka` | now / later | **Later**, matching finder D6. The concept layer is the harder half and it is unproven in one language. |

---

## 20. Disagreements

No convention in `.context/conventions.md` is disputed. The four changes to the *brief's
example* in §16 are proposed changes, stated with reasoning as the brief's preamble requires,
not silent deviations.

One thing worth flagging that is not a disagreement but is a load-bearing assumption:

**This format assumes the corpus author has access to the platform.** `verified_on`,
`output_fields` filled from real output, and the Rosetta `verified` flag all assume somebody
can run the command. For Junos SRX that assumption is satisfied — the field card exists
because somebody has one. For PAN-OS, IOS-XE and FortiOS it is not currently satisfied by
anyone named in this project, and entry 15.8 shows what the format does about that: it ships
the entry as `draft`, labels it in the UI, and refuses to write output-field semantics nobody
has observed.

That is the right behaviour, and it means **the multi-vendor corpus will be visibly thinner
than the Junos one for as long as that stays true.** The alternative — writing plausible
output-field descriptions from documentation and shipping them unlabelled — would make the
corpus look complete and make the product untrustworthy in exactly the way §2.4 of the brief
says the market cares about. Better to ship a thin corpus that is honest about its thinness.
