# ADR-0034 — Security knowledge is never answered from memory; it is looked up, and the lookup is dated

> **Status:** **Accepted** — the owner stated it as law, 2026-08-08
> **Date:** 2026-08-08
> **Register entry:** — (new; no prior register entry proposed this)
> **Reversal cost:** R1 — it constrains how sessions work, not what the product is. Nothing built depends on it
> **Supersedes:** — (amends `.context/conventions.md`; supersedes no ADR)

## Context

Asked to approve the cryptographic library set, the owner approved it and attached a condition
(verbatim, 2026-08-08):

> *"encryption library is good, just be sure to look up and don't assume you know current zero days
> or better alternative solutions for pretty much anything but security the most. something to write
> down as law."*

Two instructions in one sentence. The first is a **method**: look it up rather than recall it. The
second is an **explicit request that the method be made binding** — *"something to write down as
law"* — which is what this record does.

**Why the owner is right, stated in the project's own terms.** Every model that works on this
repository has a training cutoff, and nothing about the way it produces text distinguishes *"I
verified this"* from *"this is what such an answer usually looks like"*. For most subjects a stale
answer is merely wrong and gets caught. For security it is worse in three specific ways:

1. **The truth changes underneath the answer.** A library with no known flaw today can have a
   critical advisory tomorrow. The sentence *"there are no known vulnerabilities in X"* is not a
   fact about X; it is a fact about a database at an instant, and it decays from the moment it is
   written.
2. **The failure is silent and confident.** A wrong scoring weight produces a visibly wrong ranking.
   A wrong belief about a cryptographic primitive produces a system that works perfectly and is
   broken, and nothing in the test suite fails.
3. **It contradicts nothing, so nothing catches it.** `.context/conventions.md` already forbids
   inventing a number, a citation or a vendor behaviour. Recalling a real library's real security
   posture from training data breaks none of those rules while being exactly as unreliable.

The rule is not distrust of any particular answer. It is that **the cost of checking is minutes and
the cost of being wrong is the product's entire reason for existing** — this is a tool whose first
priority, in the owner's own ranking (`70` §2), is security.

## Decision

**Adopt a currency rule, ranked by subject, and record every lookup with its date and source.**

**1. Never answered from memory — always looked up, every time it is asserted.** Any claim about:

- a known vulnerability, advisory or CVE, in anything;
- whether a cryptographic primitive, protocol, parameter or construction is currently considered
  sound, and whether something better now exists;
- whether a library is maintained, audited, deprecated or superseded;
- a vendor's current behaviour, syntax, defaults or lifecycle (already implied by
  `.context/conventions.md`, restated here so the security case is not read as narrower).

**2. A lookup is not a lookup unless it names its source and its date.** *"Checked, clean"* is
worthless six weeks later. The form is: what was queried, against which database or primary source,
on what date, and what came back — including an explicit **"nothing found"**, which is a result and
must be written as one rather than left as silence.

**3. Two independent sources for a negative.** *"No vulnerability found"* from a single database is
indistinguishable from a lookup that silently failed. A clean result is only reportable when two
independent sources agree. (Discharged in practice on 2026-08-08: the fifteen crates `32` §15 pins
were queried against both OSV.dev and RustSec, both clean — recorded at `70` §7.6.)

**4. Currency is a build gate, not a memory.** A dated lookup in a document is a record, not a
control: it cannot notice that it has gone stale. A dependency-vulnerability scan therefore joins
`78` §6's verification floor as a gate that runs on every change, alongside ADR-0032 §6's gate zero,
**and both land before the first external crate does.**

**5. Ranked, not absolute.** The owner's phrasing — *"for pretty much anything but security the
most"* — is a ranking and is adopted as one. Security claims are checked without exception. Other
factual claims about the outside world are checked whenever the cost of being wrong exceeds the cost
of looking. Nothing here requires re-verifying arithmetic or re-reading a file already open.

**6. "I could not establish this" is a complete and acceptable answer.** It ranks above a
confident guess, always, and it is never to be smoothed into something more assured. A session that
cannot verify a security claim says so and stops; it does not reason its way to a plausible one.

## Consequences

- Security work gets slower per claim and is worth it. The floor's four gates become five.
- Every security assertion in the corpus acquires a shelf life, and the ones already written have an
  unknown one. This ADR does not retroactively date them; `73` §14 is where that gap gets raised
  when a session next depends on one.
- `.context/conventions.md` gains a section carrying this rule, since that is the file every session
  reads first and an ADR nobody opens binds nothing in practice — the failure `88` §3 documents
  across five earlier ADRs.
- It cuts against speed in exactly the place the owner ranked first, which is the point.

## Alternatives considered

| Alternative | Why not |
|---|---|
| **Leave it as good practice, unwritten** | It is what was already happening and it is why the owner had to say it. An unwritten norm is not a control, and `88` §3 is a whole document about accepted-but-unexecuted intentions |
| **Apply it to every factual claim without ranking** | The owner explicitly ranked it — *"but security the most"*. A rule that treats a library advisory and a spelling the same gets ignored on both |
| **A single vulnerability database** | A failed query and a clean result look identical. Item 3 exists because the difference is invisible and the consequence is a false all-clear |
| **Date the lookups but do not gate the build** | A dated record cannot notice its own staleness. Item 4 exists because the only control that survives inattention is one that runs whether anyone remembers or not |

## Revisit if

- A dependency-vulnerability gate proves unable to run offline or without egress, which would put it
  in tension with invariant 1 — the gate runs in CI, not in the product, so this is not expected,
  but it is the one place this rule could collide with a hard invariant.
- The two-source requirement produces repeated false positives that cost more than they catch.
