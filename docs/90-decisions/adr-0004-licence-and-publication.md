# ADR-0004 — The licence split, and publication from the phase-0 release

> **Status:** Accepted
> **Date:** 2026-07-28
> **Register entry:** `73` §3.3 (D03), §4.4 (D12)
> **Reversal cost:** R5 — after the first public commit, every contributor is a veto
> **Supersedes:** —

## Context

The licence is load-bearing rather than administrative, for one reason: the product's entire
security argument is *"you can rebuild this yourself and get the same bytes"* (`35` §1.1) and
*"you can fork it if we disappear"* (`36` Q64). Both are licence properties, not engineering
properties. A licence that permits reading but not continuing turns a verifiable artifact into a
demonstrable one, which is a weaker word than it looks.

It is four decisions with different answers — core, service, corpus, packs — and one adjacent
decision about when the repository becomes public, which is what makes the licence irreversible.

Two observations from `73` §3.3 decide the core:

1. **Copyleft has almost nothing to bite on here.** AGPL-3.0 §13's network clause is about software
   a user interacts with remotely. The client runs on the user's machine with `connect-src 'none'`.
   AGPL on the client is approximately GPL-3.0 with extra procurement friction.
2. **The security posture argues for the widest possible re-use of the core.** `35`'s reproducible-
   build programme wants third-party rebuilders; `36` Q64 wants a credible fork story for a
   customer's risk register; `36` Q51 already promises *"the CLI reads it, and so would any
   independent implementation of the spec"* — a licence commitment written inside a security
   document.

On publication, `73` §4.4 lands on public-at-phase-0-release with full history, and the deciding
argument is D10's third row: an incomplete corpus entry read as reference is a correctness hazard,
not an embarrassment. Development in a private repository until there is something reviewable is
not secrecy; it is not publishing a half-verified command as though it were verified.

## Decision

**Apache-2.0 for the core, the UI and the CLI. AGPL-3.0 for `fathom-sync`. CC BY-SA 4.0 for
`corpus/`. An explicit statement that rule packs and workspaces are not derivative works. The
repository becomes public at the phase-0 release, with full history, under a DCO rather than a CLA.**

Reasoning, in the order that decided it:

1. **Apache-2.0's patent grant (§3, with termination on litigation) is worth more here than
   copyleft's protection.** The buyers this product is aimed at read licences with a patent lens,
   and `36`'s whole register is about being easy to say yes to.
2. **The thing worth protecting from repackaging is the corpus, not the code.** The code is
   ~11,000–13,000 lines of first-party infrastructure (`41` §9.2) that nobody wants in isolation.
   The corpus is the product and the part a competitor would lift. Share-alike belongs on it.
3. **AGPL on the service costs nothing**, because ADR-0003 says we do not operate one and `41` §5.5
   already isolates `fathom-sync` from the graph, rules, emit and parse crates. Apache-2.0 flows
   one-way into AGPL-3.0, which is the direction needed.
4. **A licence on a rule pack is a category error.** A pack is data consumed by an interpreter
   (`12` §3.3). Saying so in `LICENSE` pre-empts the first question a third-party publisher asks.
5. **DCO, not CLA.** A CLA preserves the option to relicense and costs drive-by contributions.
   Under ADR-0003 the relicensing option has no buyer, so the option is worth less than the
   contributors.

## Consequences

### Positive

- `35`'s reproducible-build claim and `36` Q64's fork story become true rather than aspirational.
  A stranger may rebuild, verify, fork and continue without asking.
- The corpus's share-alike keeps derived corpora open, which is the only asset with an actual moat.
- CC BY-SA on prose and Apache-2.0 on code makes the repository's licence headers legible; applying
  a software licence to authored prose fails the first time somebody asks whether `acceptable_when`
  is "source".
- Publishing with full history makes `35`'s attestation programme checkable from the first commit,
  rather than from a squashed import nobody can audit.

### Negative

- **Apache-2.0 on the core means a vendor may take the client, close it, add a telemetry endpoint
  and sell it — and users of that fork get a product violating every invariant in
  `conventions.md` while carrying our lineage.** There is no licence remedy. The trademark
  (ADR-0005) is the only lever, and under ADR-0003 there is no entity to enforce it. This is a real
  cost and the alternative (AGPL on the core) buys protection at the price of the deny-lists that
  block the exact buyers `36` targets.
- **CC BY-SA 4.0 on the corpus is share-alike on the thing people most want to quote.** An engineer
  pasting an `acceptable_when` sentence into an internal wiki is technically creating a derivative,
  and the licence they are meant to comply with is not one engineers read. Enforcement is
  impossible and non-enforcement erodes the term.
- **A three-licence repository is a procurement question at every review.** "Which parts are AGPL"
  is the second thing a legal team asks and the answer requires a directory map. `74`'s
  `LICENSE` layout has to carry that weight forever.
- **DCO forecloses relicensing permanently.** If ADR-0003 is ever reversed toward a business, the
  dual-licence path requires every contributor's consent, and `73` §3.1 is explicit that this is the
  R5 trap. Choosing contributors over optionality is a one-way door taken deliberately.
- **Publishing with full history publishes the mistakes**, including the seed corpus's placeholder
  `reviewed_by` fields and the `Contested` status on seven documents (ADR-0001). Anyone reading the
  repository before the corrections land sees a corpus that admits it breaches its own invariant 10.

## Alternatives considered

| Option | Strongest argument for it | Why rejected |
|---|---|---|
| **MIT throughout** | Maximum re-use, universally accepted, shortest text | No express patent grant. For a product sold into defence and regulated buyers, Apache-2.0's §3 is worth more than the brevity |
| **AGPL-3.0 on the core** | It is the only thing that prevents a closed, telemetry-bearing fork — the outcome named in the negative consequences | Several large organisations publish policies prohibiting AGPL dependencies. It blocks the audience the entire security posture was built to reach, in order to prevent a fork that costs us nothing operationally |
| **MPL-2.0 on the core** | File-level copyleft: a proprietary product may embed it and our files come back. A genuine middle path | The modifications that matter in the bad scenario — adding an egress endpoint — are new files, not modifications of ours. MPL protects the wrong half |
| **BUSL-1.1 or Elastic-2.0** | Preserves a commercial option during the term | Source-available is not forkable until the Change Date, which kills `36` Q64's answer. It is also excluded from most distributions' packaging policies. It converts a verifiable artifact into a demonstrable one |
| **Same licence for code and corpus** | One header, one answer, no map | Semantically wrong and it produces the "is prose source" argument at the worst moment. It also puts share-alike on the code (or permissive on the corpus), and both are backwards |
| **Proprietary corpus, open code** | The honest open-core split, and it is the only shape that funds the corpus | Directly contradicts the teaching pillar. See ADR-0003 |
| **Private repository until phase 1** | Avoids publishing an unfinished corpus as reference | The corrections in ADR-0029 close the hazard more directly, and a repository with no public history cannot support `35`'s attestation claim |

## Revisit if

- ADR-0003 is reversed toward a business — at which point the licence question reopens as
  AGPL-plus-commercial-exception with a CLA, and this ADR is superseded rather than amended.
- A closed, telemetry-bearing fork actually ships under a confusable name. That is the evidence that
  the trademark lever is required and the licence lever was insufficient.
- Counsel returns a different reading of CC BY-SA 4.0's compatibility with a GPL-3.0 combined work,
  which is the one legal dependency in this ADR that is asserted from a summary rather than the
  canonical text.
