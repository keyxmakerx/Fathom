# 90 — Architecture Decision Records

> **Status:** Accepted
> **Date:** 2026-07-28

This directory is the answer to `70-ops/73-open-decisions.md`. The register holds the forks; this
holds the decisions. A lean in the register is not an answer — an answer lives here, in a numbered
file, with the rejected option's strongest argument recorded in its own words.

**These thirty records draw from four sources**, in this order of authority: the owner's brief; every
`DECISION` marker across the corpus; the twenty-three forks in `73`; and the six adversarial
critiques in `80-review/`. Where two documents made incompatible decisions, **the ADR is where the
conflict is resolved** — one side is picked, and the record names what must change in the losing
document.

## How these are numbered

**In the order the decisions must be made, not the order they were found.** The register's §11
coupling analysis is binding: the commercial cluster runs `D01 → D03 → D12 → D20`; the graph cluster
runs `D05 → D06 → D15 → D16 → D18/D19`, every arrow one-way; and the desktop cluster unties in one
direction only. Above all of them sits the finding all six critiques converge on — that thirty
documents were asked to be authoritative and none was told which questions it owned — which is why
ADR-0001 comes first and is the cheapest thing on the list.

The one ordering error to avoid: **do not freeze `fex`'s name environment (ADR-0009) before the
graph shape (ADR-0007) and the schema (ADR-0008) are answered.** Code written against the wrong graph
shape is rewritten in a week; two hundred rules authored against the wrong name environment is a
season.

## The record

| # | Decision | Status | Register | R |
|---|---|---|---|---|
| **[0001](adr-0001-document-ownership-and-precedence.md)** | Every settled question has one owning document; precedence, `Superseded by`, and a "building on" declaration | Accepted | new | R1 |
| **[0002](adr-0002-invariant-amendments-and-the-residual-scale.md)** | One text adopted for invariants 1, 3, 4, 7 and 9; the residual scale pinned; terms bind filenames | Accepted | new | R2 |
| **[0003](adr-0003-a-tool-not-a-business.md)** | A tool, not a business; no hosted service; the funding shape is named as the fatal unpriced risk | Accepted | D01, D20 | R5 |
| **[0004](adr-0004-licence-and-publication.md)** | Apache-2.0 core, AGPL-3.0 sync, CC BY-SA 4.0 corpus, DCO, public at the phase-0 release | Accepted | D03, D12 | R5 |
| **[0005](adr-0005-name-and-identifier-namespace.md)** | Rename, and remove the product name from the identifier namespace now — R3 becomes R1 | Accepted | D04 | R3 |
| **[0006](adr-0006-v1-is-the-finder-and-the-product-is-phases-0-to-3.md)** | v1 is the finder; the product is phases 0–3; the roadmap is re-cut as `72` §4.4 instructed | Accepted | D02, D13, D17 | R5 |
| **[0007](adr-0007-property-graph-with-first-class-edges.md)** | The IR is a property graph with first-class typed edges; node fields never hold a `NodeId` | Accepted | D05 | R4 |
| **[0008](adr-0008-the-schema-is-a-specified-artifact.md)** | `schema.yaml` is specified, owned and versioned — the biggest hole in the corpus, closed | Accepted | new | R4 |
| **[0009](adr-0009-fex-is-the-rule-condition-language.md)** | `fex`, compiled to a 28-opcode VM, total read-set extraction, no third-party evaluator in the trusted path | Accepted | D06 | R4 |
| **[0010](adr-0010-identity-reparse-and-suppression-survival.md)** | `11` owns re-identification; a rename produces a candidate, never a silent re-bind | Accepted | new | R3 |
| **[0011](adr-0011-risk-is-a-property-of-effect.md)** | `Disruptive` is defined by effect, not by mode; the caption is separable from the band | Accepted | new | R2 |
| **[0012](adr-0012-one-workspace-container.md)** | One container: `17` owns the layout, `32` owns the cryptography; neither may specify the other's half | Accepted | new | R3 |
| **[0013](adr-0013-record-granularity-frames-and-the-manifest.md)** | Fixed hash shards, whole-record rewrite, a committed manifest, and the promise from phase 1 | Accepted | D15, D16 | R3 |
| **[0014](adr-0014-envelope-and-kdf-corrections.md)** | Commitment ordering, Padmé arithmetic, sealed keyholder labels, and the KDF default at the device floor | Accepted | new | R3 |
| **[0015](adr-0015-the-claims-register.md)** | What the project stops claiming: crypto-erasure, post-quantum, "nothing withheld", and twelve more | Accepted | new | R5 |
| **[0016](adr-0016-git-is-the-sync-for-v1.md)** | Git is the sync; no multi-writer CRDT until a pilot team works around the lock | Accepted | D18, D19 | R2 |
| **[0017](adr-0017-the-offline-artifact-and-deployment-shapes.md)** | The single file is a complete single-session product; shapes are D1–D4; `44` owns the budget; measure the WASM core | Accepted | D07 | R2 |
| **[0018](adr-0018-browser-platform-corrections.md)** | WebAuthn un-denied, `img-src 'self'` priced in modes C/D, and the link rule is the only control that closes C3 | Accepted | new | R2 |
| **[0019](adr-0019-typescript-over-a-first-party-render-layer.md)** | Vanilla TypeScript over an 800-line render layer; no npm in any artifact-producing stage | Accepted | D08 | R2 |
| **[0020](adr-0020-the-ai-layer-is-a-boundary.md)** | The boundary ships; no model in v1; tier 0 is the default forever; the sidecar is a native shell | Accepted | D21, D22 | R2 |
| **[0021](adr-0021-one-catalogue-and-a-host-side-dispatcher.md)** | One catalogue — `22`'s types, `21`'s boundary — and the supervisor is a host-side dispatcher, said out loud | Accepted | new | R2 |
| **[0022](adr-0022-the-runtime-ai-surface.md)** | One runtime worker, one transcriber, three build-time tools; `ask_human` closed; `blind_accept_rate` becomes a local disarm | Accepted | new | R1 |
| **[0023](adr-0023-a-local-read-only-corpus-mcp-server.md)** | A local, read-only corpus MCP server — Fathom inside somebody else's model, rather than the reverse | **Proposed** | new | R1 |
| **[0024](adr-0024-53-owns-the-keymap.md)** | `53` owns the keymap; `⇧A` stays; one `assertive` region, and it is egress | Accepted | new | R1 |
| **[0025](adr-0025-restore-the-cards-density-and-channel-budget.md)** | Six changes that restore the card's density, geometry and one-meaning-per-device rule | Accepted | new | R1 |
| **[0026](adr-0026-theme-contrast-and-the-accessibility-claim.md)** | The `prefers-contrast` cascade is fixed and tested as a cascade; AA-in-full is qualified; dark ships on three conditions | Accepted | new | R1 |
| **[0027](adr-0027-hardware-verification-and-the-verification-stamp.md)** | Two physical boxes, and the verification stamp is required UI chrome rather than a YAML field | Accepted | D09 | R2 |
| **[0028](adr-0028-corpus-authorship-and-contribution.md)** | One voice owner and a second-author test; contribution split by genre; first-party rule packs only | Accepted | D10, D11, D14 | R5 |
| **[0029](adr-0029-domain-corrections-before-the-seed-corpus-ships.md)** | Eight rules, one explainer, the arithmetic, the cluster schema, and the fabricated corpus IDs — corrected before publication | Accepted | new | R1 |
| **[0030](adr-0030-pan-os-is-the-second-platform.md)** | PAN-OS, with a read-only ingest spike in phase 2 to settle the schema bet eighteen months early | Accepted | D23 | R4 |

## The seven that block everything else

If only seven of these are executed, these seven, in this order. Six of the seven are edits, not
engineering.

| # | ADR | Why first |
|---|---|---|
| 1 | **0012** | Until the container is one specification, six documents describe a product that cannot be built, and no work on `33`, `35`'s BOM or `44`'s budgets is safe |
| 2 | **0015** | The crypto-erasure claim is false, customer-facing, load-bearing for a data-protection argument, and one paragraph to remove |
| 3 | **0001 + 0002** | Four correct disagreements against invariant 3 produced zero decisions. That is the governance failure, and it is the cheapest thing on the list |
| 4 | **0017** | `36` has already promised an air-gapped customer one side of a live fork |
| 5 | **0011** | No `set` line in the corpus can be `Disruptive`. The colour that means *drops live traffic* never appears on the changes that drop live traffic |
| 6 | **0029** | Three `high` `definite` false positives on a correctly built firewall, and a one-click fix that widens an attack surface |
| 7 | **0008** | Six subsystems make load-bearing demands on a file no document owns |

## What is not reopened

`73` §9's no-list stands unchanged and is not re-litigated here: no connection to a device, no
credential accepted, no egress by default, no key at the server, findings as data, `(line,
provenance)` pairs, stable opaque IDs, mandatory `acceptable_when`, observable determinism, a
human-reviewed corpus, exactly three risk bands, inventory and intent as one schema, inventory as a
document, the diagram as a view and never a source of truth, no plugin system, no learned ranking, no
"apply this fix for me", no silent auto-update, and no hosted multi-tenant SaaS holding plaintext.

Where an ADR above touches one of these, it **clarifies wording** (ADR-0002) or **corrects an
implementation that did not match** (ADR-0011). None of them reverses one. A future document
proposing any reversal is proposing a different product and should say so.

## The form

Every record carries: Title · Status · Date · Register entry · Reversal cost · Supersedes · Context ·
Decision · Consequences, positive **and** negative · Alternatives considered, each with its strongest
argument in its own terms and why it lost · Revisit if.

Three rules from `73` §10.3 govern the set:

| Rule | Why |
|---|---|
| **The rejected option's strongest argument is recorded, in its own words** | A record that only argues for the winner is advocacy. Six months later the question is always *"did we know about X?"*, and the answer has to be checkable |
| **"Revisit if" is written before the evidence arrives** | Otherwise it is written after, and it will be written to exclude it |
| **A superseding decision links backwards; the old file is never deleted** | `Status: Superseded by ADR-nnnn`. The history of a fork is more useful than its current state, because the same argument returns |

The negative-consequences section is mandatory and is the part worth reading. Several of these
decisions are bad in a named way and were taken anyway: ADR-0003 decides in advance to have no money
for the thing that needs money; ADR-0006 ships substantially less than the brief describes; ADR-0013
deletes the most elegant single result in the corpus; ADR-0020 defers a capability the owner asked
for by name; ADR-0026 probably means no dark theme in v1. Each says so where a reader will find it.

## Cadence

Reviewed at every phase boundary, and at those points only — two questions per record: has its
revisit trigger fired, and has its evidence arrived. A register reviewed continuously becomes a
discussion; a register reviewed at phase boundaries becomes a checklist.

*Side 4 of the field card, on debugging: "Correlate before you theorise."*
