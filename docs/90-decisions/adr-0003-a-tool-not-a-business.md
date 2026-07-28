# ADR-0003 — Fathom is a tool, not a business, and there is no hosted service

> **Status:** Accepted
> **Date:** 2026-07-28
> **Register entry:** `73` §3.1 (D01), §6.4 (D20)
> **Reversal cost:** R5 — it constrains ADR-0004, and ADR-0004 needs other people's consent to undo
> **Supersedes:** —

## Context

D01 asks whether this is a business or a tool. D20 asks whether the project operates a hosted sync
service. They are one decision: hosting is the activity that converts a tool into an organisation,
and the licence (ADR-0004) is the mechanism by which the answer becomes irreversible.

`84` §2 answers the brief's own §11.2 question — *why has nobody built the whole thing* — from a
direction the corpus does not take, and the answer is not supply:

| Comparable | Outcome |
|---|---|
| **Kite** | 500k developers, a measured 18% productivity gain, shut down. Their words: *"individual developers do not pay for tools"* |
| **DevDocs** | Structurally the finder, in a market 100× larger. 40k+ stars, donated to a nonprofit, *"currently searching for maintainers"* |
| **Fig** | The best-executed command-corpus wedge there has been. Absorbed into an assistant |
| **Dash** | The one durable product in the genre. Paid, solo, a decade — and it survived by charging money |

`84` §2.3 sharpens it further: the three pillars have three different buyers. Validate is bought by
security and compliance, annually. Map is bought by operations, annually. **Teach has never had a
line item.** The pillar that differentiates is the one nobody has ever purchased, and the two with
budgets are served by incumbents that `02` §13 concedes are better at them, eleven times over.

`03` §8 already contains the truest sentence in the repository: *"The sum of this table is that
Fathom has no obvious business model."* `72` §10.4 reaches the same place from the burnout direction
and files it under staffing. Neither joins them. `84` D5 is right that `72` §2's ten-row risk
register has no row for *"the project has no funding shape"*.

The register's own reasoning for D20 stands independently: hosting means uptime, support, an
on-call rotation and a legal entity, for a product whose entire security argument is that it does
not hold your data.

## Decision

**Fathom is a tool. It is licensed so that a business remains possible, and it does not become one
by accident. It does not operate a hosted sync service; self-hosting is the only supported form.**

Three things follow, and the third is new relative to the register:

1. **No hosted service, no accounts we run, no plan tiers.** `43`'s D2 and D3 are things a customer
   deploys, not things we operate. `37`'s processor analysis stays hypothetical, which is the point.
2. **The licence (ADR-0004) keeps the commercial door open** — Apache-2.0 on the core does not
   foreclose a business — but no decision downstream may assume revenue.
3. **`72` gains a §4.10, "who pays for the corpus", with three named candidates and a decision
   before phase 1**, per `84`'s recommendation, plus a register row rated **Near-certain / Fatal**
   with the leading indicator *"whether the corpus author's time is funded by anything other than
   goodwill in month twelve"*. The three candidates:

   | | Shape | What it costs |
   |---|---|---|
   | **(a)** | An employer funds the work because Fathom is internal enablement | The only shape where the content has a buyer and the buyer is the user. Scope narrows to that employer's platforms |
   | **(b)** | A vendor or training business funds it | Trades independence for survival. `02` §13's positioning does not survive it intact |
   | **(c)** | Nobody funds it | The honest scope is one platform, one domain, forever, and ADR-0006's cuts are not optional |

   **The lean is (c) until (a) appears.** (c) is the only candidate that requires nobody's agreement.

## Consequences

### Positive

- Every refusal in `03` §8 becomes coherent rather than costly: there is no revenue to forgo,
  because there was never a revenue line to protect.
- The security posture and the adoption posture become the same posture, which `84` §11.2 correctly
  identifies as rare. No account, no expiry, no update nag and no network mean the cost of waiting
  is zero. The project can be dormant for two years and still be present on the afternoon it matters,
  because it is a file.
- The worst case is survivable in a way most projects' are not: a corpus of verified entries in a
  documented format under a permissive licence, and a single HTML file that still opens in ten years.
- D20 answers itself, and with it most of `37`'s processor analysis and `43`'s multi-tenant work.

### Negative

- **This is a decision to have no money, made in advance, and the corpus is the thing that needs
  money.** `72` §4.2 computes 12–15 person-weeks per platform-domain unit, forever, authored by
  somebody who has personally seen the failure being described. `83` §12.4 sums the v1 corpus at
  20–30 person-weeks of expert domain time on the critical path for every phase after 0. Deciding
  the funding shape is (c) is deciding that this is paid for out of one person's evenings.
- **It forecloses the one shape that has been shown to work in this genre.** Dash survived by
  charging. `74` §5's Apache-2.0 recommendation plus invariant 1's ban on any usage measurement
  removes both the payment mechanism and the evidence that would justify one. There is no path from
  here to a paid product that does not reverse two other decisions.
- **`84` §6.4's finding stands and this ADR does not fix it: there is no persona in the corpus with
  a budget.** Marcus (defence integrator) is blocked by procurement, not technology, and `03` §8
  concedes that no support, SLA or indemnity *"blocks enterprise procurement outright"*. A tool that
  cannot be bought cannot be deployed in the market its security posture was built for.
- **Bus factor.** `72` §10.4 rates the single-maintainer risk fatal and this decision guarantees it.
  A tool with no organisation has no succession plan beyond the licence.
- **Self-host-only means every enterprise deployment is somebody else's operational burden**, which
  is a real reason for a customer to choose a SaaS competitor even when they prefer the posture.

## Alternatives considered

| Option | Strongest argument for it | Why rejected |
|---|---|---|
| **Business from day one, dual-licensed** | It is the only shape that funds the corpus, which is the only thing that makes the product real. Kite's failure was consumer pricing, not the idea | Requires a CLA from commit one, which `73` §3.1 shows costs contributors, and it makes AGPL-plus-commercial-exception the licence — which `84` §6.2's buyer cannot procure either. It solves funding by removing the audience |
| **Open core: free engine, paid corpus** | Directly monetises the asset a competitor would lift, and `73` §3.3 concedes the corpus is the product | It contradicts the teaching pillar at its root. A tool whose deliverable is understanding, sold by withholding understanding, is a different product. `03` §4.7 already refuses every artifact this shape needs |
| **Operate a hosted sync service** | It is the shape customers ask for, and `33`'s protocol already exists | It is the product the security posture exists to not be (`73` §9). It also converts D1's remaining time into on-call, which is the same time the corpus needs |
| **Vendor or training sponsorship** | Real money, immediately, from an organisation that already funds explanation | Every organisation that could afford to write this corpus already monetises it through something Fathom refuses to be — a vendor, a trainer or a services business (`84` §2.2). The sponsorship arrives with the sponsor's platform priorities attached |
| **Deployment and support services, no hosting** | Keeps the tool free and the artifact unchanged; `73` D01 option E | Not rejected — it is the one commercial shape still available under this decision, and it is deferred rather than taken. It needs a second person before it is real |

## Revisit if

- An employer offers to fund the corpus author's time on internal-enablement grounds — candidate (a)
  arrives, and `84` C2 fires. This is the single most valuable evidence the project can receive.
- A defence or OT integrator completes an accreditation of the offline artifact without a support
  contract (`84` C3) — procurement fit follows technical fit after all, and the structural market is
  reachable without an organisation.
- Month twelve arrives and the corpus is behind because the author's time was not funded. That is
  not a reason to reverse this decision; it is the trigger to execute candidate (c) honestly and cut
  scope to one platform and one domain, permanently.
