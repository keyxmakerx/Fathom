# ADR-0002 — The hard invariants are amended, and the residual scale is pinned

> **Status:** Accepted
> **Date:** 2026-07-28
> **Register entry:** new — raised by `81` §9 O11, §10, §13.2, §13.3; `83` §8; `85` §15.1, §15.2
> **Reversal cost:** R2 — the invariants are quoted in `36`, `37` and every security document
> **Supersedes:** —

## Context

`conventions.md` pins ten hard invariants. `83` §8 audited all ten. Five hold cleanly (2, 5, 6, 8,
and 1 with one registered carve-out). Five do not:

| # | Invariant | State |
|---|---|---|
| 3 | *"never accepts a credential"* | **Breached in four different ways, and four documents propose four incompatible repairs** |
| 4 | *"the server never holds a key"* | Breached as literally written; the member log holds public X25519/Ed25519 keys (`33` §3.5) |
| 7 | *"stable opaque IDs, never paths or names"* | Bent, unregistered — `12` §11.1 persists a name-derived key in a workspace object |
| 9 | *"determinism where it is observable"* | Ambiguous under a CRDT, and a literal CI check would compare AI egress-log bytes and fail |
| 10 | *"corpus human-authored with `reviewed_by`"* | Breached today; every seed entry carries a placeholder |

Invariant 3 is the worst-shaped and the most quoted. `81` §9 O11 enumerates the four repairs:

| Document | Proposal |
|---|---|
| `31` §14.1 | *"Exactly two secrets exist in the product… no third may be added without amending this"* |
| `32` §21.3 | Supersedes `31` §14.1; enumerates six workspace secrets plus one transmitted secret |
| `33` §18.3 | Adds a **third** category — the sync account credential — which `32` §21.3's wording forbids |
| `14` §9.9 | Establishes that the application *does* accept a real credential, transiently, on every paste |

`32` §21.3's text is the best of the four **and is already stale**, because it was written without
`33`'s account credential. Meanwhile `31` §14.3 invented a `none | bounded | material | total`
residual scale, four documents adopted it verbatim, and nobody wrote it down as a convention.

## Decision

**Adopt one text for each contested invariant, and pin the residual scale. This is one edit to
`conventions.md`, made once, and every proposing document then deletes its proposal.**

**Invariant 1 — no egress by default.** Amended per `34` §13.1: add `sandbox` and the per-directive
allowlist, and record the tier-1 carve-out explicitly as `21` §18.1 asks. An explicit carve-out is
not a breach; an implicit one is.

**Invariant 3 — credentials.** Adopt `32` §21.3's structure, extended to cover `33`'s account
credential and `14` §9.9's transient case. The replacement text:

> **The application stores no device credential.** No PSK, certificate private key, SNMP community,
> TACACS key or device password is ever written to a workspace, a sync blob, a git object or an
> export. Emitted configuration uses placeholders. A pasted capture may *contain* a credential; it
> is redacted at the ingest gate and the unredacted text never reaches the encryptor (`14` §9.9).
> The secrets the application does hold are enumerated in `32` §21.3 and `33` §18.3, and that
> enumeration is exhaustive: adding one requires amending this invariant.

**Invariant 4 — key material.** Adopt `32` §21.2's replacement: the server holds no *secret* key
material. Public keys in the member log are not an exception to be explained away; they are a
different thing, and the invariant should say which thing it means.

**Invariant 7 — identifiers.** Amended per ADR-0010: the graph contains no natural-key references;
the tier-1 identity tuple's hash may be persisted as a **recovery** key by `12` §11.4 and by nothing
else.

**Invariant 9 — determinism.** Two additions, both already argued by their proposers:

> Determinism is a property of *emitted* artifacts — config, findings, finder ranking, exports. The
> AI session log and the egress log are quarantined records: inside the workspace, never inputs to
> an emitter, excluded from every determinism assertion (`81` §13.2).
>
> "Same workspace" means the same **converged** workspace state (`17` §21.1). The tuple is
> workspace + corpus version + **rule-pack version set** + build (`24` §11.1).

**Terminology.** Three additions: `record` per `32` §21.1; *"threat model may be abbreviated to
'the model' inside `30-security/` only"* per `83` §9.1; and per `85` §15.1, **these terms bind
filenames, directory names, type names, identifier prefixes and CLI flags, not only prose** —
which costs one rename (`22-agent-catalog.md` → `22-subagent-catalogue.md`).

**The residual scale is pinned**, unchanged, as `31` §14.3 asks: `none | bounded | material | total`.
It has been adopted by consensus by `32`, `34`, `36` and `37`; only the convention is missing.

## Consequences

### Positive

- The five open disagreements filed against the invariants close in one edit. `81` §12 item 3 and
  `83` §13 item 9 both name this as among the cheapest high-value actions available.
- `36`'s answers to Q11, Q13 and Q52 become defensible, because the invariant a reviewer quotes back
  is the one the product implements.
- Invariant 9 becomes something CI can test rather than something CI would fail on. `44` §1.1's
  work-counter gating strategy — the best consequence of any invariant in the corpus — depends on
  exactly this clarification.

### Negative

- **Every amended invariant is weaker than the sentence it replaces, and the weaker sentences are
  the true ones.** "The application never accepts a credential" is a better sentence than the four
  clauses that replace it, and marketing-shaped truth is the thing this project spent its
  credibility buying. `14` §9.9's own imperative says it plainly: `FATHOM DOES NOT KEEP YOUR KEYS.
  IT STILL SEES THEM FOR AS LONG AS THE PASTE TAKES.` That sentence now has to be said out loud.
- **An enumerated secret list rots.** `32` §21.3 went stale between two documents in the same
  directory. The new text has the same failure mode with a wider blast radius, because it is now the
  invariant rather than a proposal, and a stale invariant is worse than a vague one.
- **Invariant 9's carve-out is a door.** Once "the AI log is exempt from determinism" is written
  down, the next non-deterministic record will argue for the same exemption. The mitigation is the
  explicit list, and the list will be argued.
- **Editing an invariant sets a precedent that invariants are editable.** They were load-bearing
  precisely because they read as fixed. Three documents having to work around one is the argument
  for changing it (`85` §15.2), and the same argument will be made next time about a weaker case.
- Retrofit cost: every document quoting the old text needs an edit, including the two customer-facing
  ones.

## Alternatives considered

| Option | Why rejected |
|---|---|
| **Keep the invariants and fix the products to match** | For invariant 3 this means: no sync account, no workspace passphrase, no paste ingest. That is not a product. The invariant was written before three of the four secrets were discovered, and reality is the thing that won |
| **Adopt `31` §14.1's "exactly two secrets"** | Already false when written — it does not know about `32`'s six or `33`'s account credential. Adopting a closed enumeration that is provably incomplete is the O11 failure repeated |
| **Adopt `32` §21.3 verbatim** | `83` §8 recommends this and it is the best of the four, but its own wording forbids `33`'s account credential, which ships. Adopting it verbatim would require deleting a feature or breaking the invariant on day one |
| **Leave the residual scale unpinned** | Four documents already use it identically. The only outcome available is that a fifth invents a fifth value, which is the exact failure the conventions exist to prevent |
| **Add a `Superseded` note to `conventions.md` instead of editing it** | Produces a convention document that must be read with a changelog. `conventions.md`'s value is that it is short enough to hold in your head |

## Revisit if

- A sixth workspace secret is discovered, which would mean the enumeration approach is the wrong
  shape and the invariant should state a *property* rather than a list.
- A CI determinism check fails on something that is neither an emitted artifact nor a quarantined
  record — the carve-out is drawn in the wrong place.
- The AI layer is cut entirely (ADR-0022's kill condition fires), at which point invariant 9's
  quarantine clause has nothing to quarantine and should be deleted rather than left as a door.
