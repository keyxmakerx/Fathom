# ADR-0016 — Git is the sync; no multi-writer CRDT until evidence arrives

> **Status:** Accepted
> **Date:** 2026-07-28
> **Register entry:** `73` §6.2 (D18), §6.3 (D19); supported by `84` §9.3 and `83` §12.2
> **Reversal cost:** R2 to add sync later; R3 once an op encoding is in a file
> **Supersedes:** —

## Context

Brief §6.4 states the trade honestly: inventory as a document loses fleet-scale querying and native
multi-writer concurrency, *"and git provides collaboration"*, with §7.6's CRDTs becoming load-bearing
only at several thousand devices.

`33-sync-protocol.md` then specifies a hand-rolled CRDT: four convergent types, HLC causality,
per-field-class resolution, five worked conflict classes, `Field::Conflicted` through the UI, and a
convergence property-test suite. `83` §12.2 costs the CRDT alone at **8–12 solo weeks** inside a
phase-5 total of 48–69 weeks against `71`'s budget of 16–24.

Three independent arguments converge on deferring it:

1. **`71` §8.1's own argument** is that every phase before five delivers full value on one machine,
   one user, no server. `73` §6.2 already names the exit: *"ship single-writer sync with explicit
   locking."* Taking at week 4 a decision you have already written down as the likely outcome is
   scheduling, not caution.
2. **`84` §9.3** adds that the 32-member ceiling was never the target user, and that `81` F3 gives a
   second independent reason: the merge driver as specified violates `32` §5.4's ciphertext
   invariant. ADR-0013 has now removed the frames the driver operated on, so the elegant version is
   gone regardless.
3. **The failure mode is the worst kind.** A convergence bug in a hand-rolled CRDT is silent data
   loss on a firewall policy, discovered when the policy does not do what the workspace says it does.

## Decision

**v1 and the product (ADR-0006's phases 0–3) ship a workspace file plus git. No multi-writer
convergence. Single-writer sync with an advisory lock is the next step when a sync service is built
at all. Multi-writer only on evidence.**

Four things this decision explicitly does **not** mean, recorded because `73` §6.2 is right that
they will be assumed:

| Not this | Because |
|---|---|
| No collaboration | Git is the collaboration mechanism, and it is the one the brief chose |
| No sync service ever | `33` remains the specification for when one is built. It is deferred, not deleted |
| No conflict handling | A git merge conflict on a record is opened in the application with the passphrase and merged on plaintext by `11` §8.6 — which is what `32` §5.4 requires anyway |
| That the op log is wasted | The record model, the format and the op set are unchanged either way (`73` §13 disagreement 3) |

**If and when multi-writer is built: hand-rolled, four convergent types and no more** — grow-only
set, add-wins observed-remove set, LWW register with an HLC, and a sequence type — **with Loro as the
named fallback**, decided at week 4 of that phase against `33` §4.6's property tests, not at week 12.

**`71` phase 5 is unbundled** per `73` §13 disagreement 3: phase 5 becomes *"encryption and
workspaces, retiring R-ZK"*; R-CRDT moves to a later phase gated on this decision's evidence.

## Consequences

### Positive

- 8–12 solo weeks removed from the critical path, and with them the single highest-consequence
  correctness risk in the plan.
- The conflict story becomes one an engineer already understands. Git conflicts are legible, and a
  human resolving a policy conflict deliberately is better than an algorithm resolving it silently.
- `32` §5.4's ciphertext-merge invariant needs no exception.
- The sync service, when built, is a much smaller thing: transport plus locking, not convergence.
- It aligns with ADR-0003: a tool with no organisation should not own a correctness argument that
  requires a standing team to maintain.

### Negative

- **Two engineers cannot edit the same workspace at the same time, and this is the normal case in
  every team that adopts the tool.** An advisory lock means somebody is blocked, and a blocked
  engineer copies the file, works, and reconciles by hand — which is worse than a CRDT and worse than
  a conflict, because it happens outside the tool entirely.
- **Git conflicts on a sharded ciphertext record are not resolvable in git.** Under ADR-0013 a
  conflicted shard is a binary conflict; the user must open both sides in the application. Anyone
  expecting `git merge` to work on a "git-versionable document" — which is the brief's phrase — meets
  a wall. The elegant answer to this existed (`17` §5.4's keyless driver) and two decisions have now
  removed it.
- **`33` becomes a large, specified, unbuilt document**, which is the state most likely to rot. Its
  OPAQUE analysis, its compaction design and its offline-first backlog work are good and will be
  stale by the time anyone returns to them.
- **It weakens the enterprise story concretely.** `43`'s D3 cluster deployment exists to serve teams,
  and a team product with single-writer semantics is a smaller claim than the corpus makes elsewhere.
- **Deferring the CRDT defers the decision that constrains the op encoding.** ADR-0013 fixed the
  record model, but if a CRDT arrives later it may want ops in the record, which is R3 at that point
  rather than R2 now. `73` D19's *"week 4, not week 12"* rule mitigates this only if somebody
  remembers it.

## Alternatives considered

| Option | Strongest argument for it | Why rejected |
|---|---|---|
| **Build the hand-rolled CRDT in phase 5 as `71` sequences it** | `33` §4.6's property-test approach is sound, the four types are the right four, and multi-writer is what teams expect. Building it late means building it into a format that has already shipped | 8–12 weeks plus a correctness argument the project owns forever, for a capability the brief itself says only matters at several thousand devices — against a product (ADR-0006) that ships at one platform and one domain |
| **Adopt Loro or Automerge now** | Somebody else owns the convergence proof, which is the expensive part | Both are large dependencies in the trusted path, which cuts against `35`'s minimal-surface argument and `41`'s dependency discipline. And `73` D19 is right that the op encoding ends up in the file either way, so the R3 commitment is the same |
| **Single-writer sync with a lock, in v1** | It is the named exit and it is much cheaper than a CRDT | It still requires the sync service, the account credential, OPAQUE, the index store and the operational runbooks — 6–8 weeks that ADR-0006 has already cut from v1. Git needs none of it |
| **No sync of any kind, ever** | Simplest, and the file plus git genuinely covers the target user | Forecloses the enterprise deployment shapes that `43` and `36` are written for, and those documents are a third of the security corpus. Deferral keeps the option; refusal does not |
| **Ship the keyless git merge driver anyway** | It is the best idea in `17` and it makes git actually work | ADR-0013 removed the frames it unions, and `32` §5.4 forbids merging ciphertext. It was elegant and it is not available under the format that won |

## Revisit if

- A pilot team reports the advisory lock being worked around — copied files, out-of-band edits,
  reconciliation by hand. That is the evidence multi-writer is required, and it is the only evidence
  that counts.
- A deployment passes roughly a thousand devices, where brief §6.4 says the document model stops
  being a good trade.
- ADR-0006's scope is expanded to phase 5 with funding, at which point D19 is answered at week 4
  against `33` §4.6's property tests — hand-rolled first, Loro if the property tests are still
  failing at the end of week 4.
