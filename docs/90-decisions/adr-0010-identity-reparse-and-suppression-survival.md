# ADR-0010 — `11` owns re-identification, and a rename never silently re-binds

> **Status:** Accepted
> **Date:** 2026-07-28
> **Register entry:** new — raised by `83` §6 (F4); resolves `11` §10.3–10.6 against `12` §11.4
> **Reversal cost:** R3 — the suppression anchor is persisted in every workspace
> **Supersedes:** —

## Context

Three requirements meet at one algorithm: node IDs must be stable (invariant 7), a re-parse of an
updated configuration must map new parsed nodes onto existing graph nodes, and suppressions must
survive that mapping or reviewers lose their waiver history.

All three are specified. They are specified twice, incompatibly (`83` §6):

| | `11` §10.3–10.4 | `12` §11.4 |
|---|---|---|
| Key structure | An **ordered list** of identity tuples per kind, most specific first, up to 3 tiers, with `owner()`, `edge()`, `edge_in()` terms | **One** `identity` tuple per kind |
| Key form | Not hashed; matched by hash join per tier | `NaturalKeyHash = blake3_128(kind ‖ 0x00 ‖ canonical_join(values))` |
| Rename handling | Tier 2/3 tuples exist **precisely to survive a rename**; the match is made and a rename recorded | *"the pair is unmatched… produces a suggestion in the plan, never a silent re-bind"* |
| Persistence | §10.3: *"Identity tuples are… never used for lookup, never used by rules, **never persisted as a key**"* | §11.1 **persists it**: `Scope::Finding { anchor: NodeId, anchor_nk: NaturalKeyHash, … }` on every suppression |

The last row is a flat contradiction of an explicit prohibition, and it has already propagated:
`17` §16.2's `fsck --repair` re-binds orphaned suppressions by `anchor_nk`, so the forbidden key is
load-bearing in a third document.

The behavioural divergence is the part a user meets. Rename `IkeGateway GW-B` to `GW-DC-EAST`, same
peer address, same external interface, re-parse:

- Under `11` §10.4: tier 2 tuple matches, **auto-matched, ULID preserved, rename recorded**, and
  §10.6 claims suppressions survive.
- Under `12` §11.4: tier-1 key changed, unmatched, rename *guessed*, **user is prompted**, nothing
  bound without confirmation — so every suppression on that node is orphaned until a human clicks.

One of those is the product's behaviour. `14` gets this right and defers correctly (*"identity
tuples — already in the IR schema, IR §10.3 — 0 lines of code"*); `12` re-derived.

## Decision

**`11` §10.3–10.4 owns re-identification. `12` §11.4's parallel scheme is deleted. And `12`'s safety
rule wins on behaviour: a rename produces a candidate, never a binding.**

Four edits, in order:

1. **`12` §11.4 becomes a deferral.** `NaturalKeyHash = blake3_128` computed over **`11` §10.3's
   tier-1 tuple**, and nothing else. The per-kind table in `12` is deleted.
2. **`11` §10.3's prohibition is narrowed, not broken:** *"never persisted as a graph reference; the
   tier-1 tuple's hash may be persisted as a **recovery** key by `12` §11.4, and by nothing else."*
   This is registered as an invariant-7 clarification in ADR-0002 rather than left in a cost table.
3. **`11` §10.4 step 3's `if t > 1` branch produces a candidate, not a binding.** `11`'s own
   justification agrees with `12` here — *"a wrong match silently rewrites the history of an object
   that is not the one you are looking at"* — and then the algorithm does the thing the sentence
   warns about.
4. **`11` §10.6's suppression row changes from *"yes"* to *"yes, after confirmation"*.** That is the
   honest answer and it is what the UI has to render.

The residue thresholds stay `11`'s (weighted Jaccard + 0.3 × edge-signature overlap; accept iff
`best ≥ 0.75` **and** `best − second ≥ 0.15`; skip if `|rG|·|rP| > 4096`). `12`'s "≥80% field
equality, same parent" is a coarser statement of the same idea and is deleted with the rest.

## Consequences

### Positive

- One algorithm, in the document that owns the IR, consumed by `12`, `14` and `17` §16.2 by
  reference.
- The dangerous outcome — silently rewriting the history of the wrong object — becomes structurally
  impossible rather than threshold-dependent.
- Suppression recovery still works: `fsck --repair` re-binds by `anchor_nk` where exactly one node
  matches, which is a *repair* path with a human at the other end, not a *routine* path.
- Invariant 7's clarification is registered rather than argued in a footnote, so the next author does
  not re-derive it a third time.

### Negative

- **Every re-parse of a renamed device now interrupts the user.** This is the real cost and it lands
  on the most common maintenance operation there is. An engineer who renames six interfaces during a
  standardisation pass gets six prompts, and prompt fatigue is the mechanism by which people click
  through — which is the same failure mode `85` §7.2 names for AI consent, arriving in a
  deterministic surface.
- **Suppressions are orphaned between the re-parse and the confirmation.** During that window the
  findings panel shows waived findings as live, which is alarming and is exactly when somebody is
  looking at a diff. The UI has to distinguish "orphaned pending confirmation" from "unsuppressed",
  and `83` M6 already notes the product has no unified diagnostics surface to do it in.
- **A persisted name-derived key bends invariant 7 permanently.** The argument in `12` §11.4's cost
  table is good and it remains a bend: a suppression is a first-class workspace object, it is
  exported to reviewers (`17` §15.2), and it now contains a hash of a device name. Anyone who can
  guess names can confirm them against an exported review file.
- **The three-tier tuple structure is more machinery than `12`'s single tuple**, and it must be
  specified per kind in `schema.yaml` (ADR-0008) before any of it runs.

## Alternatives considered

| Option | Strongest argument for it | Why rejected |
|---|---|---|
| **`12` §11.4 owns it (one tuple, hashed, prompt on change)** | Simpler, already implementable, and its safety rule is the right one. `12` is the strongest engineering document in the corpus | A single tier-1 tuple keyed on name means *every* rename orphans everything, so the prompt fires constantly and users learn to accept blindly. `11`'s tiers exist to make the prompt rare enough to be read |
| **`11` §10.4 as written (auto-match on tier 2/3)** | No prompts, suppressions survive transparently, and the residue thresholds are tight enough that false matches are rare | "Rare" is not "never", and the failure is silent and unrecoverable: the history of one object is written onto another, inside an encrypted document where `11` §10.5 says there is no undo across a save |
| **No re-identification: re-parse always creates new nodes** | Trivially correct, no thresholds, no prompts | Every re-parse discards every suppression, every provenance record and every diagram position. `82` §2.2's documentation-rot argument applies to the tool itself |
| **Persist the ULID in the device configuration as a comment** | Perfect stable identity, no matching at all — this is what several inventory tools do | Invariant 2: the tool never touches a device, so it cannot place the marker, and asking a user to paste an annotation back into production is a change to their configuration for our bookkeeping |
| **Match on structure only, never on names** | Immune to renames by construction | Two identical branch offices are structurally indistinguishable. Names are the only thing that separates them, which is why `11` uses them at tier 1 |

## Revisit if

- Measured prompt frequency in phase 2's pilot exceeds roughly one per re-parse — the tiers are not
  doing their job and the tuple definitions in `schema.yaml` are wrong, not the algorithm.
- `fsck --repair`'s re-bind path is used routinely rather than exceptionally, which would mean the
  confirmation flow is being skipped and recovery has become the main path.
- An export of a review file is shown to leak names through `anchor_nk` in a way that matters to a
  real customer, in which case the anchor becomes a random per-workspace-keyed HMAC and recovery
  across workspaces is lost.
