# ADR-0011 — Risk is a property of effect, and the caption is separable from the band

> **Status:** Accepted
> **Date:** 2026-07-28
> **Register entry:** new — raised by `82` §1, §2, §17 (both rated **Critical, blocks ship**)
> **Reversal cost:** R2 to change the mechanism; R5 in reputation if the corpus ships mislabelled
> **Supersedes:** —

## Context

The three-colour legend is the only safety affordance in the tool and on the printed card. It
appears unchanged on all four sides, and `design-language.md` calls it *"the card's single most
disciplined move"*.

`82` §1 found that **no `set` line anywhere in the corpus can ever be `Disruptive`.** All 91 command
entries follow an undocumented mapping: `mode: configuration` ⇒ `ChangesConfig`; `clear` ⇒
`Disruptive`; everything else ⇒ `ReadOnly`. The risk was derived from the *mode* of the statement,
not from its *effect* — while the entries' own `blast_radius` prose describes the red band in words:

| Entry | `blast_radius`, verbatim | Label |
|---|---|---|
| `zone.st0.bind.set` | *"…**traffic stops until new ones exist**"* | `ChangesConfig` |
| `ipsec.vpn.bind-interface.set` | *"…**everything routed at it blackholes**"* | `ChangesConfig` |
| `interface.st0.address.set` | *"Renumbering a live unit **drops any adjacency running over it**"* | `ChangesConfig` |
| `ike.gateway.version.set` | *"A peer that only speaks the other version **stops negotiating entirely**"* | `ChangesConfig` |
| `ipsec.vpn.establish-tunnels.responder-only.set` | *"**the tunnel never comes up again** — with no error anywhere"* | `ChangesConfig` |

Worse, two sibling documents disagree on identical statements. `18` §7.2 argues at length, correctly,
that `set security ipsec policy … perfect-forward-secrecy keys group14` is **`Disruptive`, not
`ChangesConfig`** — and the command corpus labels that exact line `ChangesConfig`. `18` §7.4 labels
`clear security ipsec security-associations index <id>` **`DISRUPTIVE`**; `13` §5.5 labels the
identical command `ChangesConfig`. Three risk values for two commands across three files.

`13` §8.1 already asserts the correct principle — *"the risk of a statement is a property of what it
does"* — and the corpus does not implement it. `61` §313 states the authoring rule — *"when an author
is torn, round up"* — and the corpus rounds down, systematically, forty times.

The second defect is the caption. `conventions.md` pins `ChangesConfig` to render as
`CHANGES CONFIG — NEEDS A COMMIT`. `clear security ipsec statistics` is labelled `ChangesConfig`, and
it changes no configuration, needs no commit, and `rollback 1` will not undo it. `13` §5.5 defends
this as *"the three-value enum forces the honest call"*; `82` §2 is right that it forced a false
label and the document rationalised it.

## Decision

**Three bands, exactly as pinned. `Disruptive` is defined by effect. The caption is separable from
the band. No fourth colour.**

1. **The definition, stated in `61` §4 and enforced:**

   > `Disruptive` **iff** committing or running the statement can interrupt an established flow, SA
   > or adjacency on a device already carrying traffic.

   This is a property of what the statement does, not of whether it is `mode: configuration`,
   `operational` or `clear`.

2. **A CI gate catches the class, not just the instances.** Any entry whose `blast_radius` matches
   `/blackhole|traffic stops|drops .*(adjacency|traffic)|never comes up|stops negotiating/i` and is
   not `Disruptive` fails the build. That single gate catches all five rows above.

3. **Reclassify, at minimum** (`82` §17): `zone.st0.bind.set`, `ipsec.vpn.bind-interface.set`,
   `interface.st0.address.set`, `ike.gateway.version.set`,
   `ipsec.vpn.establish-tunnels.responder-only.set`, `ipsec.policy.pfs.set`,
   `ike.proposal.dh-group.set`, `ipsec.proposal.encryption.set`, `ike.proposal.encryption.set`,
   `interface.st0.mtu.set`, and the `ike.mode.aggressive-with-psk` remediation line
   `set security ike gateway {{…}} version v2-only`.

4. **`13` §5.5 loses to `18` §7.4.** `clear security ipsec security-associations index <n>` is
   `Disruptive`. Clearing one child SA pauses live traffic; that is the definition of the red band.
   Calling it `ChangesConfig` also asserts something false — it needs no commit.

5. **The caption becomes overridable per entry, and only the caption.** A new optional field
   `risk_caption_override` in `61` §3.2. A `ChangesConfig` entry with `mode: operational` renders
   `CHANGES STATE — NOT REVERSIBLE BY COMMIT`. **Same ink, same wash, same ordering, different
   words.** This is a proposed change to `conventions.md`, whose § *The risk enum* currently pins the
   caption text; the replacement wording is `82`'s:

   > *"Exactly three bands. The caption is the default rendering of the band and may be overridden
   > per corpus entry where the default is untrue; the ink, wash and ordering may not."*

6. **`commit` inherits the change set's risk.** `18` §6.4 already computes an `AGGREGATE RISK` for a
   change set; the `commit` line inside a generated ladder takes it rather than carrying the corpus's
   static `ChangesConfig`. Committing a `Disruptive` change set is a `Disruptive` act, and a fixed
   label on `commit` is meaningless.

## Consequences

### Positive

- The red band appears on the changes that actually drop traffic. Under the shipped mapping it was
  reserved for `clear`, which means an engineer scanning a generated change set for red before a
  Tuesday-afternoon window sees amber throughout and proceeds. That is the most dangerous defect the
  product can ship and this closes it.
- Two documents stop contradicting each other on the same statement, and `18` §7 — the best section
  in the domain corpus — becomes consistent with the entries it references.
- The legend stops lying in the one place it did. `CHANGES CONFIG — NEEDS A COMMIT` on an operational
  `clear` told an operator to commit something that had already happened and could not be committed.
- The CI gate makes the authoring rule mechanical, so the next 400 entries do not repeat it.

### Negative

- **The corpus becomes much redder, and a tool that shows a lot of red is a tool people stop
  reading.** This is the same mechanism as the `acceptable_when` argument in the brief: severity
  inflation gets a linter muted. Roughly a quarter of the configuration entries move to
  `Disruptive`, and the distinction between "drops this tunnel" and "drops the box" is now inside a
  single band with no way to express it.
- **A caption override is an escape hatch in a pinned constant.** ADR-0002 already amends five
  invariants; this amends the one design constraint the owner explicitly identified as the thing
  they loved. The next request will be a second override, then a per-platform caption, and the
  discipline erodes by increments. The mitigation — ink, wash and ordering are not overridable — has
  to be enforced in CI, not in review.
- **The regex gate is a heuristic and will produce false failures.** An entry whose `blast_radius`
  says *"traffic stops only if the peer is already down"* fails the gate and is correctly
  `ChangesConfig`. Authors will learn to phrase around the regex, which is Goodhart on the safety
  gate — the same dynamic `85` §5.2 identifies for the AI layer's gates.
- **Reclassification invalidates review.** Every entry whose risk changes needs its `reviewed_by`
  re-established, because the risk label is the field a reviewer is most responsible for. That is
  rework on the corpus, which is the schedule (ADR-0006).
- **`commit` inheriting aggregate risk means the same command renders three different colours in
  three tickets.** That is correct and it is confusing, and it makes the legend context-dependent for
  the one command every ladder ends with.

## Alternatives considered

| Option | Strongest argument for it | Why rejected |
|---|---|---|
| **Add a fourth band for "changes state, not config"** | It is the honest taxonomy: read-only / changes config / changes state / disruptive. The current three genuinely do not partition the space, which is why `13` §5.5 had to rationalise | `design-language.md` is explicit and the owner is explicit: three colours, no fourth, and the legend is the card's most disciplined move. A fourth band also breaks the 1:1 mapping to the printed card, and consistency between paper and tool is worth more than it appears |
| **Keep the mode-based mapping and fix the prose** | It is mechanical, it is what the corpus implements, and it never requires a judgement call | It produces a legend that is precisely wrong in the direction that hurts people. `13` §8.1 already states the correct principle; the corpus simply did not implement it |
| **Keep `13` §5.5's classification of `clear … index`** | Clearing one SA is not a configuration change and the tunnel re-establishes in seconds | It pauses live traffic, and `18` §7.4 makes the argument better. "Re-establishes in seconds" is a statement about a healthy peer, and the command is used when the peer is not healthy |
| **Per-entry free-text risk descriptions instead of an enum** | Maximum accuracy, zero false labels | Destroys the scannability that is the entire value. The user's question is "is there red on this page", and a paragraph does not answer it |
| **Derive risk automatically from the emitter's diff** | Removes the authoring judgement entirely | Only works for emitted lines, not for the 91 authored command entries, and it cannot know whether the device is carrying traffic. `18` §6.4's aggregate is the right scope for this idea and it is adopted for `commit` only |

## Revisit if

- Pilot users report that the findings and config views read as uniformly red, which would mean the
  band no longer discriminates and the taxonomy needs a fourth level after all — at which point the
  decision goes back to the owner, because it is their design constraint.
- A second caption override is requested. One is a correction; two is a pattern and the convention
  should be re-argued rather than extended again.
- The regex gate's false-failure rate exceeds its true-failure rate over a hundred entries, in which
  case it becomes a review prompt rather than a build failure.
