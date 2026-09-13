# ADR-0006 — v1 is the finder; the product is phases 0–3; the roadmap is re-cut

> **Status:** Accepted
> **Date:** 2026-07-28
> **Register entry:** `73` §3.2 (D02), §4.5 (D13), §6.1 (D17)
> **Reversal cost:** R5 — a published version number and a product description are a promise
> **Supersedes:** —

> **Reversal proposed, 2026-08-06.** The owner has overruled this record's scoping on merit — *"All
> features must be included in V1, how you wish to plan that out is your discretion"* (`70` §4,
> verbatim). ADR-0031 supersedes items 1, 3, 4, 5 and 7; items 2 and 6 are not scoping and survive.
> No revisit trigger below fired, and `58` §4.4 records that deliberately — this is `75` §2's
> reopening on merit, which is permitted. **This record stays Accepted and in force until ADR-0031
> is ratified**; a session reading it today should read ADR-0031 alongside it.

## Context

"In v1" appears in five other register entries and none of them can be answered until v1 means
something. `71` §2 gives five coherent stopping points. Two independent critiques then say the plan
of record is one the project has already disproved.

`84` §8 states it plainly: **`72` §4.4 is an instruction to re-cut `71`, and `71` was not re-cut.**
`72` computes 12–15 person-weeks per platform-domain unit and concludes the v2 target of three
platforms × three domains *"is not a plan, it is an aspiration, and it should be re-cut before phase
1 rather than discovered in phase 7."* `71` still sequences seven phases past it. Two documents in
the same directory, one containing the refutation of the other's plan, and neither
`## Disagreements` section mentions the other.

`83` §12 re-costs the plan independently and finds two inputs wrong by a factor of two to three:

| | `71`'s figure | `83` §12.5 |
|---|---|---|
| Solo, to phase 7 | 106–158 wk | **170–240 wk** — four to five years |
| Team of three | 53–79 wk | **85–120 wk** |

Phase 5 alone (`71`: 16–24 solo weeks) enumerates as 48–69 weeks once the member log, conformance
runner, `fsck`, export gate, merge driver, OPAQUE and the CRDT are counted as separate lines. Phase
6 (14–22) enumerates as 30–45. And `71` §2's headline number **omits the corpus entirely**, because
§15.3 correctly says the corpus is a track rather than a phase — so the number every reader retains
excludes the largest line item.

Meanwhile `84` §3.2 finds that the wedge's five nearest relatives all stopped at the wedge, and
§7.1 finds the minimum genuinely useful thing is roughly a third of phase 0 — and `71` §3.2
instructs that it be deleted.

## Decision

**v1 is phase 0 alone, published under its own honest description. The product is phases 0–3, and
that is the default plan rather than a fallback. Phases 4, 5 and 6 become funded expansions, not
sequence.**

Concretely:

1. **v1 = the finder.** A command reference that closes the vocabulary gap, offline,
   deterministically, with what to read in the output and what to run next if it is bad. **Nothing
   about a graph.** The trap named in `73` §3.2 is binding: do not call it *"v1 of a network
   engineering platform"*.
2. **The spike ships under the real name, with a version number, a published hash and a `Staleness`
   banner** — reversing `71` §3.2's instruction to delete it, per `84` §7.3. The instruction is
   correct for a code spike and wrong for a content product. A corpus rendered by four hundred lines
   of JavaScript has no architecture to become, and it starts `71` §12.1's kill signal and `72`'s
   authoring-rate measurement three months earlier.
3. **Phases 0–3 are named as a product** in `71` §12: the finder, the walkthrough, paste and reverse
   explanation, findings, diff, verify and rollback, on one platform and one domain. 58–84 solo
   weeks by the roadmap's own numbers. It needs no CRDT, no sync service, no member log, no HPKE, no
   AI layer, no D2 and no D3.
4. **The diagram is cut to an SVG export** (D17 + `84` §9.2), saving 5–9 of 6–10 solo weeks.
5. **The CLI ships in phase 0** (D13). It costs about a week, it produces `fathom serve` — which is
   ADR-0017's mode B — and it is the only thing that makes `fathom golden` and the determinism
   claim testable.
6. **`71` §2's totals gain a corpus column.** A headline effort number that omits 20–30 person-weeks
   of expert domain time is misleading in the one place everybody looks.
7. **Rosetta is unbundled from phase 7** (`84` §9.4). A command entry with `rosetta:` mappings costs
   30–45 minutes and needs no schema, dictionary, rule, parser or emitter. **The finder's corpus may
   be wide while the graph's corpus is narrow**, and four platforms of IPsec command corpus is about
   eight person-weeks. This is a cut of a dependency, not of a feature, and it is free.

## Consequences

### Positive

- The plan of record stops being one the corpus has already refuted. `72` §4.4's instruction is
  executed rather than filed.
- The kill signal arrives early and cheaply. `71` §12.1 — *"fewer than half the pilot group open the
  finder unprompted in week 3"* — tests the entire adoption thesis on an artifact that costs a
  fortnight rather than a quarter.
- Priya (`84` §6.1) gets her actual problem solved. Cross-vendor lookup was the wedge's best feature
  and it was scheduled behind the modelling programme with a stub in its place.
- Every later decision gets cheaper. "Is the diagram in v1" and "does v1 have multi-writer sync"
  answer themselves.
- The corpus becomes the schedule, which is what it always was.

### Negative

- **This is a decision to ship substantially less than the brief describes, and the brief is the
  authority.** One graph, six views is the owner's thesis; v1 has one view and no graph. That gap
  has to be stated to the owner as a proposed change, not discovered by them at the download page.
- **Cutting the diagram removes the product's only demonstrable surface.** `71` §7.1 concedes the
  cost is demo-ability, and a project with no diagram is much harder to explain to anyone who has
  not used it. `56` is also the strongest document in the design set (`86` §7) and this shelves it.
- **Deferring phases 5 and 6 defers the entire security posture.** Zero-knowledge encryption, the
  sync protocol and the enterprise deployment shapes are what `31`, `32`, `33`, `36` and `37` exist
  for — roughly a third of the corpus by volume — and under this decision none of it ships in the
  product. The documents remain correct and unbuilt, which is the state most likely to rot.
- **It defers the owner's explicit new requirement.** *"There needs to be a supervisor AI and sub
  agents"* is a direct instruction, and ADR-0020 keeps only the boundary. The mitigation is real
  (the boundary is the architecturally load-bearing half) and it is still a deferral of something
  the owner asked for by name.
- **Shipping a fortnight's spike under the real name means the first public artifact is the least
  good one.** `71` §3.2's fear is legitimate: a spike that survives becomes the architecture. The
  countermeasure is that phase 0 replaces it in place, and countermeasures like that fail routinely.
- **Naming phases 0–3 as the product invites the project to stop there**, which is a fine outcome
  and is not the brief's outcome.

## Alternatives considered

| Option | Strongest argument for it | Why rejected |
|---|---|---|
| **v1 = everything (`71` as written)** | It is the brief's product and the only version that supports the positioning in `02` | 170–240 solo weeks by `83` §12.5. `84` §8's third observation is decisive: solo, the project reaches its first falsification of its central bet at about the same time the free alternative has had three years of improvement |
| **v1 = 0+1** | Two pillars, and the walkthrough is `84` §4.3's one genuinely defensible view | 36–52 solo weeks before any adoption evidence exists. The kill point is at phase 0 and this spends a quarter past it before reading the instrument |
| **v1 = 0+1+2+3 (ship the product as v1)** | It is the brief's product and `71` §2's own third coherent exit | Correct as the *product* and wrong as *v1*: it delays the first release by 58–84 weeks, and `73` §3.2's point stands — every later decision gets cheaper when v1 is small. Adopted as the product, not as the version number |
| **Delete the spike as `71` §3.2 instructs** | The stated risk is real and generic | This is a content product. The corpus carries forward regardless of the renderer, and the instrument that measures the corpus's cost cannot start until something renders it |
| **Keep the diagram, cut something else** | It is the best-argued design document and `52` §5.5's worked example is convincing | `03` §4.2 already refuses the property that would make a diagram valuable, and at one platform and one domain the graph is a handful of nodes the inventory table already shows |
| **Keep Rosetta in phase 7** | It needs the second platform's corpus to be real | It needs the second platform's *command* corpus, not its schema, parser or emitter. Conflating the two is what subordinated the wedge to the modelling programme |

## Revisit if

- `84` C1 fires: a pilot engineer who does not work on the project opens a workspace twice in a
  quarter, unprompted, within six months of phase 1. The wedge converts, and phases 4–6 stop being
  speculative.
- The measured authoring median comes in at or below 25 minutes and holds across 200 entries
  (`84` C4) — the scope is roughly 40% cheaper than `72` §4.4 computes and the re-cut is too deep.
- A second full-time person joins, in which case `83` §12.5's team-of-three figure applies and
  phases 0–5 become reachable inside two years.
- Phase 0's pilots report the finder is useful *only* with a workspace open — then v1 is 0+1 and the
  standalone release was a beta.
