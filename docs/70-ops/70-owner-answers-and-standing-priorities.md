# 70 — Owner answers and standing priorities

> **Status:** Accepted — this document records the owner's words. The decisions they imply are
> drafted as ADR-0031, ADR-0032 and ADR-0033 and are `Proposed` until the owner ratifies them.

The companion to `77`. Where `77` records the owner's service-model requirements verbatim, this
records the owner's answers to questions put to them, verbatim, plus the standing priority order
they stated. It decides nothing. Quoting is exact, including where the phrasing is informal — the
whole value of a verbatim record is that a later reader can see what was actually said rather than
what a planning session made of it.

## 0. Contents

| § | | margin tab |
|---|---|---|
| 1 | How to use this | *read this first* |
| 2 | The standing priority order | *the tie-breaker* |
| 3 | Third-party code — the answer, verbatim | *→ ADR-0032* |
| 4 | Scope — the answer, verbatim | *→ ADR-0031* |
| 5 | Motion — the answer, verbatim | *→ ADR-0033* |
| 6 | The dynamic-correlation goal, verbatim | *the largest unspecified requirement* |
| 7 | Questions still outstanding | *two, re-asked in plain language* |
| 8 | Failure modes |  |
| 9 | Open decisions |  |
| 10 | Sources consulted |  |
| 11 | Disagreements |  |

---

## 1. How to use this

Three of the answers below are decisions and are drafted as ADRs; §6 is a requirement with no
mechanism behind it anywhere in the corpus and is therefore not an ADR but a named gap. §2 is
neither — it is a **tie-breaker**, to be applied when two defensible options conflict and no
document ranks them.

An execution session never reads this document for work. It is planning input (`78` §7).

## 2. The standing priority order

Stated by the owner on 2026-08-06, in answer to a question about where a warning should surface:

> *"the first priority is security, second priority is a combination os usability, so think UiUx
> design, animations, but also useability from your perspective that it is easy to edit add and
> understand how it all works. the second part to that second priority is dynamic ability."*

Read as a ranked list:

| Rank | Priority | What it means when it decides a tie |
|---|---|---|
| 1 | **Security** | Where a usability gain costs a security guarantee, the guarantee wins. This is consistent with invariants 1–4 and with `71` §13.1's thirteen permanent boundaries, and it is now stated as a general rule rather than inferred from them |
| 2a | **Usability — for the user** | Interface and interaction quality, including motion (§5) |
| 2b | **Usability — for the maintainer** | *"easy to edit add and understand how it all works"*. This is a first-class requirement, not a nicety: the corpus is authored by hand and its authoring rate is `72`'s named long pole |
| 2c | **Dynamic ability** | §6. Ranked by the owner as *"the second part to that second priority"* |

**RECOMMENDATION —** rank 2b is the one most likely to be quietly traded away, because its cost
lands on a future session rather than on a user. `62`'s grammar, the schema-as-artifact rule
(ADR-0008) and the corpus's provenance headers are existing expressions of it; new work should be
held to the same standard.

## 3. Third-party code — the answer, verbatim

The question put: may the project use third-party libraries, or does it stay at zero?

> *"I don't know what dependencies your referring to. however as long as they are bundled and are
> not a security risk vector I'm for it. i suppose they don't have to be bundled but I'm just
> concerned the implications here. my recommendations is look at what other enterprise solutions
> use here, and how might AI miss things and preemptively try to shore up those concerns."*

Three separable instructions:

1. **Third-party code is permitted in principle.** This settles the question five work orders each
   defer separately (`88` §5.7).
2. **Conditioned on two things:** bundling (stated as a preference, then softened — *"they don't
   have to be bundled"*), and not being *"a security risk vector"*. The second is the binding one.
3. **Two research instructions**, both discharged in ADR-0032: survey enterprise practice, and
   adversarially anticipate what an automated session would miss.

The owner did not know what the candidate libraries were, and said so. ADR-0032 §2 therefore leads
with the inventory in plain language before it proposes any policy.

## 4. Scope — the answer, verbatim

The question put: is v1 still the command finder (ADR-0006), or the inventory face the queue
actually builds?

> *"Again I don't know what you mean? All features must be included in V1, how you wish to plan
> that out is your discretion."*

Two instructions, and the second matters as much as the first:

1. **There is no reduced first release.** The feature set is the whole product. ADR-0006's
   scoping — *"v1 = the finder … Nothing about a graph"* — is overruled on merit, which `75` §2
   and `CLAUDE.md` rule 2 expressly permit.
2. **Sequencing is delegated to planning.** *"how you wish to plan that out is your discretion."*
   The build order is therefore a planning artifact, not an owner decision, and `76` §7.2's
   S-slices and the work-order queue continue to govern it.

**What this answer does not do.** It does not reopen anything in `71` §13.1 — the thirteen
permanent product boundaries, which are refusals rather than deferrals. Invariant 2's own wording
makes the distinction: *"This is a permanent product boundary, not a phase-1 limitation."*
Removing phases removes phase-limitations only. See ADR-0031 §Decision item 4.

## 5. Motion — the answer, verbatim

The question put: the design corpus records *"the product has no animation"*; you have asked for
animations. Which stands?

> *"oh yea why wouldn't we have animations? it's just we don't want animations there for animation
> sake, it should have reason, direction, and from a humans stand point easily to have context of
> why that animation was there."*

This is a **doctrine**, and a more useful one than either "no animation" or "add animation". Read
as three tests, all of which a motion must pass:

| Test | The owner's word | What it asks |
|---|---|---|
| Purpose | *"reason"* | What does this motion tell the user that a static frame does not? |
| Direction | *"direction"* | Does it show causality — what became what, what came from where? |
| Legibility | *"easily to have context of why that animation was there"* | Can a person say why it happened, without being taught? |

Drafted as ADR-0033. The corpus's existing position turns out to be narrower than its headline
(§10, `86` §9.4), so this is largely a reconciliation rather than a reversal.

## 6. The dynamic-correlation goal, verbatim

> *"the second part to that second priority is dynamic ability. I don't know how you'll think this
> best works but if we have a switch at one location, and a we add 2 other switches, or I add
> configs of some other switch, the goal is that It is dynamic enough to connect these together if
> everything matches. I know it doesn't exactly work that way, but trying to get to that goal as
> much as possible is the hope. then I can click on equipment and paste a config and/or edit fields
> in planning mode or maintenance mode etc to add IP info and such."*

**This is the largest requirement in the corpus with no mechanism behind it.** It splits in two,
and the two halves are in very different states.

### 6.1 Half one — automatic correlation across separately-pasted configs

**Declared in scope, never designed.** `03` §4.5 draws the line exactly where the owner wants it,
and does so as a boundary statement:

> *"Multiple devices pasted, and inferred adjacency where two configs reference each other — a
> gateway whose `address` matches another device's `external-interface` address is a tunnel edge,
> and that inference is a fact about two texts, not about a network."*

and, on `show lldp neighbors` output specifically:

> *"**This one is *in scope*, and stating that is the point**: it is text the user gathered, not a
> network the tool probed. The refused version is Fathom gathering it."*

So no decision has to be won. What exists today:

| Mechanism | Crosses devices? | State |
|---|---|---|
| `infer.tunnel.pair` / `infer.tunnel.compat` — peer address in one config matches an interface address in another | Yes | IPsec only; `infer.tunnel.compat` is declared in `schema/schema.yaml`, `infer.tunnel.pair` is prose |
| `infer.port.cabled-peer` | Yes | Declared in `schema/schema.yaml` |
| `infer.port.occupies` — an interface name's slot position matched to a physical port | **No — same device only** | Specified in `19` §3.7. Emits a **suggestion, not a graph change** |
| Re-identification (`11` §10.4, ADR-0010) | **No — scoped by `owner_device`** | Specified. Answers *"is this the same gateway on the same box"*, never *"do these two boxes connect"* |
| The warp (`19` §6) | Yes, across the path | Specified in full, with six outcomes and a resolver. **Reads asserted edges only — cables and ports a human entered, never configs** |

And what does not exist at all: any correlation on LLDP or CDP neighbour output, on matching
interface descriptions, on a shared subnet or a common /30, on shared VLAN IDs, on a hostname
defined in one config and referenced in another, or on LAG peering. `rg -ci lldp corpus/` returns
nothing; the word appears in four documents, all of them scope or security discussions.

**The shape of the answer is already set, and should be copied rather than reinvented.**
`19` §3.7's rule is the template: *propose, never assert; refuse when ambiguous; show the evidence.*
Its reason for refusing to key hardware identity on interface names is the same reason
cross-device correlation must not silently write edges — doing so *"would … silently move every
cable"*.

**RECOMMENDATION —** the cheapest high-value start is LLDP/CDP neighbour paste. It is the one
input that states adjacency directly rather than implying it, the user already has it, and `03`
§4.5 has already cleared it. It needs a design document before any code, and that document is
planning work not yet scheduled.

### 6.2 Half two — click equipment, paste a config, edit fields

**Largely specified, partly prototyped, and queued.** The per-equipment page is designed and
clickable in `design/prototype/fathom-app.html`; WO-08 builds it, deliberately read-only in its
first slice. Paste-while-looking-at-a-device is specified down to its warning prompt; in-place
field editing is specified with its keyboard contract.

One collision, and it is with the owner's *word* rather than their intent. `53` refuses modes
outright — *"No modes. No mode indicator. No mode errors."* — on the grounds that a mode is a
state the user must remember they are in. The owner's *"planning mode or maintenance mode etc"*
describes the same capability `75` records as C-07, floored at phase 4 (a floor ADR-0031 removes).
Whether the capability is delivered as a mode, as a per-record state, or as a filter is a design
question that `53`'s refusal constrains but does not answer. **Not decided here.** Logged in §9.

## 7. Questions still outstanding

Two questions were asked in jargon and could not be answered. Re-asked here in plain language;
both remain open and both are owner-only.

### 7.1 Do you still work on Juniper SRX firewalls?

*(was: "is SRX/IPsec retired, carried, or frozen?")*

Everything Fathom knows today is about one subject: building and troubleshooting site-to-site
IPsec VPN tunnels on Juniper SRX firewalls. That is all 177 entries — 98 commands, 37 rules,
42 explainers — written from the owner's own four-side field card. `77` describes a different job:
Calix and Nokia access gear, CLLI-coded sites, DIA and E-Line and E-LAN with per-location UNI IDs.

The two do not overlap at all. A case-insensitive search of the whole of `corpus/` for `calix`,
`nokia`, `clli`, `fttx`, `gpon`, `olt`, `ont`, `pon`, `e-line`, `elan`, `dia` and `uni` returns
**zero matches**; `76` §6.5 puts the transfer at *"effectively zero — call it 0 of 177"*. Meanwhile
the data model has already moved: `schema/platforms.yaml` registers `calix`, `nokia` and `adtran`
as vendors, and the schema carries `Tenant`, `Service`, `ServicePath`, `PhysicalPort`, `Cable`,
`Premises` and `Site`. The knowledge has not followed.

**The question:** is the Juniper firewall work still what you do most weeks, occasionally, or
hardly at all any more?

What turns on it: two of the eight queued work orders (WO-03 ingest, WO-04 emitters) are written
end-to-end against Junos syntax; ADR-0029 orders six SRX corrections as a gate; ADR-0030 commits
2–3 weeks to Palo Alto chosen purely as a second *firewall*. All three were reasoned inside the
firewall world.

### 7.2 When Fathom finds this problem, what should it point at?

*(was: "may a rule anchor on an edge?")*

The problem is real and the field card calls it the most-missed step: on an SRX, the interface a
VPN runs over must be given permission to accept incoming IKE packets. If it is not, the firewall
silently drops the far end and the log says nothing.

The awkwardness is that the fault belongs to neither thing on its own. It is not a property of the
interface, and not a property of the zone — it is a property of the *pairing*: **this interface,
inside this zone, does not admit IKE.** Fathom must hang the warning off something, and that choice
decides what the user sees.

| If the warning attaches to… | The user sees | And the one-click fix… |
|---|---|---|
| **the interface** | A warning on `ge-0/0/0.0`, wherever that interface appears | opens IKE on that one interface |
| **the zone** | A warning on the `untrust` zone | opens IKE on **every interface in that zone** |

**The question:** when Fathom flags this, should the warning sit on the individual interface, or on
the zone it belongs to?

**A security note the owner should have before answering, given §2 rank 1.** The fix is currently
written to open IKE on one interface. If the warning moves to the zone and the fix moves with it,
the fix widens to every interface in that zone — which is the exact regression `87` R03 was written
to prevent. That argues for the interface, but it is the owner's call and the corpus is genuinely
split: four documents disagree today and no code catches the disagreement (`88` §4.5).

## 8. Failure modes

| # | Failure | Control |
|---|---|---|
| 1 | **The verbatim quotes get "tidied"** into cleaner prose and the record stops being a record | §1's rule: quoting is exact, informality included. Any edit to a quote in this document is a defect |
| 2 | **§2's priority order is used to win arguments it does not settle** — it breaks ties between defensible options, it does not license overriding a written decision | §2's preamble; `78` §4 still governs anything a work order leaves open |
| 3 | **§6.1 is read as a specification** and someone builds correlation from it | §6.1 states there is no mechanism. It is a named gap; the design document does not exist |
| 4 | **The removal of phases (ADR-0031) is read as removing `71` §13.1's refusals** | §4's closing paragraph; ADR-0031 §Decision item 4 restates it |
| 5 | **§7's two questions go unanswered and the work proceeds on a guess** | Both are listed in `88` §8 and in `CLAUDE.md`'s owner-blocking list |

## 9. Open decisions

1. **Modes, or not modes** (§6.2). `53` refuses modes; the owner named two. Whether C-07 ships as a
   mode, a per-record state or a filter is a design decision nobody has taken. Planning proposes,
   `53` owns the answer under ADR-0001's precedence rule.
2. **Where cross-device correlation is specified** (§6.1) — a new `10-core` document, or a section
   in `14`. Planning decides; it should precede any code.
3. **Whether LLDP/CDP paste needs its own corpus format** or reuses the command-output shape.
   Unowned.
4. Both questions in §7, which are owner-only.

## 10. Sources consulted

| Source | Taken |
|---|---|
| The owner, in conversation, 2026-08-06 | Every quotation in §§2–6, verbatim |
| `docs/00-vision/03-non-goals-and-scope.md` §4.5 (`N-R-5`) | Correlation and LLDP paste declared in scope; the refused adjacent |
| `docs/10-core/11-ir-schema.md` §10.4, §10.6; ADR-0010 | Re-identification is scoped by `owner_device`; the cross-device limitation row |
| `docs/10-core/19-service-and-physical-model.md` §§2.1, 3.3, 3.7, 3.9, 6.1–6.6 | *"no parser produces it"*; `infer.port.occupies` as suggestion; the warp, its resolver and its asserted-edges-only rule |
| `docs/10-core/14-parsers-and-ingest.md` §10.1 | Identity tuples scoped by `owner(Device)` |
| `docs/50-design/53-interaction-and-keyboard.md` | *"No modes. No mode indicator. No mode errors."* |
| `docs/50-design/56-diagram-view.md` §6.4 | Cables are created by a UI gesture, one op, one undo step |
| `docs/70-ops/71-roadmap.md` §13.1, §13.2 | The thirteen permanent boundaries versus the eleven deferrals |
| `docs/70-ops/75-capability-register.md` C-07 | Planning and overlay modes as recorded intent |
| `docs/70-ops/76-scope-expansion-analysis.md` §6.5, §7.2, §8 | The 0-of-177 transfer figure; the S-slices; Q10 and Q11 |
| `docs/70-ops/77-service-model-requirements.md` §§2.1, 3.1, 7 | Calix, Nokia, CLLI, DIA/E-Line/E-LAN, the naming grammar |
| `docs/80-review/86-critique-design.md` §9.4 (D-35, D-36); `80-reconciliation.md` M34 | The motion decision's actual provenance |
| `docs/80-review/88-state-review-and-recommendations.md` §§4.4, 4.5, 5.7 | The blockers these answers discharge |
| `schema/platforms.yaml`; `schema/schema.yaml`; `corpus/` (all three files) | The vendor registry; the 48 kinds; the 177 entries and their platform tags |
| `rg -ci "calix\|nokia\|clli\|fttx\|gpon\|olt\|ont\|pon\|e-line\|elan\|dia\|uni" corpus/` (run 2026-08-06) | Zero matches |

## 11. Disagreements

1. **Against the framing of the original questions.** Q3 and Q4 were put to the owner in project
   jargon and were unanswerable as asked; the owner said so twice. That is a defect in the asking,
   not in the answering. §7 is the repair, and the rule it implies is worth keeping: a question for
   the owner is phrased in terms of their work and what they would see, never in terms of the data
   model. Where a security consequence rides on the answer, it is stated before the question, as in
   §7.2.

2. **Against reading §4 as a schedule.** *"All features must be included in V1"* is a statement
   about the feature set, not about time. `ADR-0003` remains Accepted and unreversed: it decides
   nobody funds this and records that under that assumption *"the honest scope is one platform, one
   domain, forever"*. Those two can both be true — the product ships whole, and it takes as long as
   one person takes — but the tension is real and is not resolved here. ADR-0031 §Consequences
   states it as the cost it is.

3. **Against treating §6.1 as small.** It reads like a feature and it is closer to a subsystem: it
   needs an evidence model, a confidence model, a conflict-resolution rule, a UI for accepting or
   rejecting a proposal, and a provenance story for every edge it creates. `19` §3.9 already calls
   hand-entered physical data *"the single largest adoption risk in this layer"*, which is the
   strongest available argument for doing it — and is also the measure of how much rests on doing
   it correctly.
