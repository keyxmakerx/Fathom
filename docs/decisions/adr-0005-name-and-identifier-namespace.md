# ADR-0005 — Rename, and remove the product name from the identifier namespace

> **Status:** Accepted
> **Date:** 2026-07-28
> **Register entry:** `73` §3.4 (D04), §13 disagreement 5
> **Reversal cost:** R3 today; R1 after this ADR is executed; R5 the day a public artifact carries a name
> **Supersedes:** —

## Context

The brief calls *Fathom* a working codename and says *"placeholder; rename freely"*. The register
finds the name is not free: `73` §12 documents at least four active users of it — a privacy-focused
web analytics company, an AI meeting notetaker, an industrial cybersecurity firm, and a pipe-flow
modelling product released in 1994 — plus multiple registered `FATHOM` marks including one covering
computer networking hardware.

The engineering half is the part that is expensive and the part nobody has to wait for.
`conventions.md` § *Identifiers* specifies node IDs as `fathom:<kind-lower>:<ulid>`. Invariant 7
says every ID is stable forever and is referenced by rules, explainers, emitters, suppressions and
diagram elements. So **every ID ever minted writes the product name into a file the user keeps**,
and a rename after the first workspace exists becomes a data migration that must be correct on the
first attempt because the input is the only copy.

That is an R3 cost incurred for a decorative reason, and it is avoidable today at zero cost.

## Decision

**Two separate actions, taken at different times.**

**1. Now, before `fathom-id`'s first commit: decouple the identifier namespace from the product
name.** `conventions.md` § *Identifiers* changes to `<kind-lower>:<ulid>` for node IDs. Rule IDs,
command corpus IDs and explainer IDs already carry no product name and do not change. This drops
the cost of any future rename from R3 to R1 and it costs one edit.

**2. Before anything is published: rename.** The register's recommendation is *Plumb*, with
*Leadline* as the fallback if clearance fails — both are sounding instruments, both keep the
brief's own metaphor, and both are shorter than the incumbent. This ADR does not finalise the
string, because a name is a legal decision with an engineering input rather than the reverse. It
finalises the two things that are engineering:

- The name may not appear in any identifier, file magic, MIME type, ID prefix or on-disk key.
- Clearance — live USPTO TSDR and EUIPO status, class and goods, plus domain and package-registry
  availability — is completed before the string is committed anywhere public.

The file extension and the container magic (`17` §3, `32` §13.2) are chosen at ADR-0012 and must
be name-free by construction.

## Consequences

### Positive

- The most expensive part of a rename disappears before it can be incurred. After action 1, renaming
  is a find-and-replace in prose plus a new artifact filename.
- `74`'s trademark story becomes possible: a distinctive mark is enforceable against a confusable
  fork, which is the only lever ADR-0004 leaves against a closed, telemetry-bearing derivative.
- It removes the class of bug where a user's ten-year-old workspace refers to a product that no
  longer exists under that name.

### Negative

- **Opaque IDs get slightly less debuggable.** `fathom:device:01J...` in a log or a git diff is
  self-describing; `device:01J...` is not, and a bare `<kind-lower>:<ulid>` will collide visually
  with other colon-delimited identifiers in the same file — including explainer IDs, which use the
  same separator. This is a real ergonomic cost paid every time somebody reads a raw record.
- **A rename costs every published reference.** The critiques, the design language extraction, the
  prototype, and every cross-document citation in 43 documents say "Fathom". Executing action 2
  means a mechanical edit across the entire corpus, and a mechanical edit across 4 MB of prose will
  break at least one code fence.
- **Deferring the string keeps a placeholder in circulation.** The corpus will continue to be
  authored under a name that is going away, which guarantees that some of it will be missed. The
  alternative — choosing now — requires clearance work nobody has done.
- **Clearance may fail twice.** Both candidate names are common English words in an industry that
  has been naming products for forty years. There is no guarantee of an available, distinctive,
  short, metaphor-preserving name, and the fallback is a coined word that carries none of the
  meaning the brief liked.

## Alternatives considered

| Option | Strongest argument for it | Why rejected |
|---|---|---|
| **Keep `Fathom`** | The brief's metaphor is good, the name is already in every document, and nobody has sent a letter | Four active users, one of them in networking hardware, and a registered mark covering the category. The cost lands at the worst moment — when a customer has it in a procurement record, which is R5 |
| **Keep the name in identifiers and accept the migration** | IDs are more legible; a migration is specified anyway (`11` §11.3) | The migration is the riskiest operation in the product (`83` M5 — it rewrites the user's only copy) and this would run it for a cosmetic reason. Paying R3 to avoid an ergonomic annoyance is the wrong trade |
| **A fixed non-word prefix (`fm:`, `fx:`)** | Keeps IDs self-describing without naming the product | A two-letter prefix is a name; it will be read as one, and it collides as readily. If it is meaningless it adds nothing over dropping it |
| **Rename now, before clearance** | Stops authoring under a doomed name immediately | Committing a string publicly before clearance is how R3 becomes R5. The identifier decoupling captures almost all of the value with none of the risk |
| **Coin a word** | Guaranteed clearance, guaranteed distinctiveness | Loses the brief's metaphor, which is the one thing the owner wrote down as liking. Held as the fallback if both sounding-instrument names fail |

## Revisit if

- Clearance fails on both candidates — the decision becomes coining, and this ADR is amended rather
  than superseded.
- A public artifact ships under any name before clearance completes. At that point the decision has
  been made by publication and its reversal cost is R5.
- Counsel advises that the mark is unenforceable under ADR-0003's no-entity structure, in which case
  the rename's second justification disappears and only the collision argument remains — still
  sufficient, but it makes *Plumb* versus *Leadline* a matter of taste rather than of law.
