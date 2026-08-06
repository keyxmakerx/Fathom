# ADR-0033 — Motion must carry meaning; M34's blanket refusal is replaced by a three-part test

> **Status:** Proposed — awaiting owner ratification
> **Date:** 2026-08-06
> **Register entry:** `80` §3 M34; `86` §9.4 D-35, D-36
> **Reversal cost:** R1 — the tokens exist, the reduced-motion switch exists, and no code has motion in it yet
> **Supersedes:** — (amends `80` M34 and `51` §12; supersedes no ADR — there is none on this subject)

## Context

`51` §12's headline reads *"**The product has no animation** (amended per M34)"*, with a property
table marking opacity, height, transform, background-colour and border-colour all **Never**. Asked
about it, the owner answered (`70` §5, verbatim):

> *"oh yea why wouldn't we have animations? it's just we don't want animations there for animation
> sake, it should have reason, direction, and from a humans stand point easily to have context of
> why that animation was there."*

Three facts make this a reconciliation rather than a reversal, and they should be on the record
before the decision:

**1. There is no ADR to overturn.** The operative text is register entry **M34**, filed under
`80` §3 *"Minors"* — a severity class `80` §0.1 defines as *"Arithmetic, naming, dead references,
presentation."* Neither ADR-0025 nor ADR-0026 mentions motion; a search of both returns nothing.
The strongest binding decision in the repository on this subject is a Minor defect entry.

**2. The stated reason was a CSS bug, not a design principle.** `86` §9.4 D-36 found that the one
animation the corpus ever specified — a 90 ms disclosure fade — **could not run**: an element going
from `display: none` to `display: block` is not transitioned unless `transition-behavior:
allow-discrete` and a `@starting-style` rule are both present, and neither was. The reviewer offered
**two** fixes — implement it properly, or delete it — and took the second on grounds of aesthetic
economy (*"removes a token, a media query"*). The companion finding D-35 was that three documents
each separately claimed to own *"the only motion in the product"*. So the corpus did not weigh
motion against usability and reject it; it hit one broken implementation and took the cheaper of two
offered repairs. The reviewer's first option is still on the table and is already written out as
working CSS.

**3. The refusal was never total.** Three motions survive and ship by explicit decision:

- **Smooth scrolling.** `52` §5.6.4: *"Scrolling uses `behavior: 'instant'` when the distance
  exceeds two viewport heights and `'smooth'` otherwise… If `prefers-reduced-motion` is set, always
  `'instant'`."*
- **The edge-drawing gesture.** `55` §7.2: *"The line follows the pointer; that is direct
  manipulation, not animation. **Allowed**, and exempt from `prefers-reduced-motion` because it is
  a direct response to continuous input."* This is, almost exactly, the connect-two-things gesture
  the owner described in `70` §6.
- The 1.6-second copy-confirmation dwell (`54`).

`51` §12 also left the door deliberately unlocked, expressing the position as a **token set to
zero** rather than as an absence — so turning motion on is a token change, not a rebuild.

What *is* genuinely defended, with a real argument, is narrower than the headline: **no animation on
the interaction path.** `53` §10.3, citing `44` §4.2: *"a 150 ms fade is 150 ms of latency, and it
is latency somebody chose."* That is attached to hard numbers — `52` §5.6.3 budgets selection at
one frame (S1), 33 ms P95 (S2), 20 ms P95 (S3), with `dom_nodes_created` = 0 on a selection change.
Adding a 150 ms fade to a 33 ms selection makes selection 183 ms and feels slower although nothing
got slower.

## Decision

**1. The blanket refusal is replaced by the owner's three-part test.** A motion ships only if it
passes all three:

| Test | The question it must answer |
|---|---|
| **Purpose** | What does this motion tell the user that a static frame does not? |
| **Direction** | Does it show causality — what became what, what came from where? |
| **Legibility** | Can a person say why it happened, without being taught? |

A motion that cannot answer all three is *"animation for animation sake"* and does not ship. This is
the same discipline `63` §1 applies to rules (*"A rule that cannot answer all six is not ready"*)
and `54` applies to components, so it is the house pattern, not a new one.

**2. The interaction path stays instant, and this is a hard boundary, not a preference.** No motion
on hover, selection, press, focus, or any transition on the critical path to a result. `52` §5.6.3's
budgets and their work-counter gates are unchanged and remain the enforcement. Motion lives where
latency is not being measured: disclosure, view entry, the connect gesture, and explanatory
transitions.

**3. Teaching motion is the primary case, and is where the doctrine earns its place.** Fathom is
half a teaching tool, and the three tests describe teaching exactly. The motions worth building
first are the ones that show *causality across the product's own seams*: this config line became
that node; these two ports just became a cable; this finding came from that statement. `13`'s
`(line, provenance)` pairs and the graph's first-class edges already carry the data such a motion
would render — the relationship exists in the model, and motion is a way to show it.

**4. Determinism is unaffected and bounds where motion may live.** Invariant 9 governs *emitted*
artifacts — config, findings, finder ranking, exports. Motion is a property of the view and never
of an output. No animation may be an input to an emitter, and no emitted byte may depend on
whether a transition ran. This costs nothing today and must be stated because it is the constraint
that would otherwise be discovered late.

**5. Animated diagram re-layout stays refused.** `55` §7.2's argument survives this ADR intact:
*"It is the single most common vestibular trigger in a diagram editor, and at 500 nodes it is 500
concurrent transforms. Under `prefers-reduced-motion` it would have to be disabled, which means the
users most likely to need the orientation cue are the ones who cannot have it."* That is a reasoned
accessibility refusal, not a phase deferral or an aesthetic one, and item 1's test does not reach
it. Any future proposal to animate re-layout reopens `55` §7.2 on its own merits.

**6. Three edits follow, and they are small.**

| Where | Edit |
|---|---|
| `51` §12 and `design/tokens.css` | Replace *"The product has no animation"* with item 1's test. `--motion-state` gains a non-zero default; the `Never` property table becomes a *not on the interaction path* table. The existing `prefers-reduced-motion` block is unchanged — it already zeroes everything |
| `55` §1.1 and §1.4 | The AAA claim for **SC 2.3.3 Animation from Interactions** is currently justified by absence — *"`--motion-state: 0ms`. The product has no animation (M34…)"*. Re-ground it on the switch: the criterion asks that motion be disableable, and the universal `prefers-reduced-motion` handling already satisfies it. **The conformance level is not lost; the justification sentence is wrong the moment anything animates.** Same for §1.4's *"gets for free"* row |
| `80` M34 | Marked amended by this ADR, with D-36's underlying CSS defect noted as still requiring the correct implementation (`allow-discrete` + `@starting-style`) if the disclosure fade returns |

## Consequences

### Positive

- The product gets the thing the owner asked for, under a rule that is stricter and more useful than
  either extreme — *"animate what teaches"* is a brief a designer can execute and a reviewer can
  check.
- The connect-two-things gesture the owner described in `70` §6 turns out to be **already approved
  by name** and already exempt from the reduced-motion switch. That half was never a conflict.
- D-35's defect — three documents each claiming to own the only motion — is resolved properly, by
  one document owning the rule, rather than by deleting the subject.
- Cost is near zero: no code has motion in it, `rg` over `crates/` returns nothing, and CI enforces
  no motion rule.

### Negative

- **A real argument is being overruled, and it should not be misrepresented as a bug fix.** The
  latency case (`44` §4.2, `53` §10.3) is sound. Item 2 preserves it, but the boundary between
  "interaction path" and "not interaction path" is a judgement call that will be litigated per
  component, and some of those calls will be wrong.
- The accessibility claim moves from *justified by absence* — which is unfalsifiable and cheap — to
  *justified by a switch*, which must actually work and be tested. That is a real new test
  obligation, and `55`'s cascade testing does not exist yet.
- Every motion added is a token, a media-query interaction and a test. `51` §12's original economy
  argument was not wrong about cost; it was wrong about what the cost buys.
- The design set is the strongest cluster in the repository (`88` §7) and this reaches into it.
  Roughly twelve documents and fourteen design HTML files carry the no-animation position and will
  drift until they are swept.

## Alternatives considered

| Option | Why not |
|---|---|
| **Keep M34 as written** | Contradicts a direct owner instruction, and rests on a CSS bug plus an aesthetic preference rather than on a principle |
| **Allow motion everywhere, subject only to `prefers-reduced-motion`** | Discards the latency argument, which is the one genuinely good reason in the existing position, and which the owner's own rank-1 and rank-2 priorities do not contradict |
| **Fix the disclosure fade only, leaving the headline** | The narrowest possible change and it was tempting. Rejected because it leaves `51` §12 asserting *"the product has no animation"* while the product animates — the same assert-two-things defect this review has been closing everywhere else |
| **Write the doctrine into `51` without an ADR** | `51` is `Proposed` like most of the corpus; a doctrine the owner stated in their own words deserves a record that can be cited and reopened. Also, the amendment reaches `55`'s conformance claim, which is a cross-document change and therefore ADR-shaped under ADR-0001 |

## Revisit if

- A motion ships that fails item 1's third test in use — users cannot say why it happened. That is
  evidence the test is being applied loosely, not that it is wrong.
- Any `52` §5.6.3 selection budget is missed and motion is implicated.
- The `55` cascade tests are built and show the reduced-motion switch does not in fact disable
  everything, which would put the SC 2.3.3 claim genuinely at risk rather than merely re-grounded.
- A proposal for animated diagram re-layout arrives with evidence against `55` §7.2's vestibular
  argument — the only route by which item 5 reopens.
