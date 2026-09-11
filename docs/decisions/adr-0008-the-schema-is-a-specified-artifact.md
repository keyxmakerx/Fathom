# ADR-0008 — `schema.yaml` is a specified, owned, versioned artifact

> **Status:** Accepted
> **Date:** 2026-07-28
> **Register entry:** new — raised by `83` §10 M1 and §13 item 6
> **Reversal cost:** R4 — six subsystems consume it; changing its shape re-authors rules and parsers
> **Supersedes:** —

## Context

`83` §10 calls this **the biggest hole in the corpus**, and the description is precise: six
documents make load-bearing demands on a file no document owns.

| Consumer | What it demands of the schema |
|---|---|
| `11` §11.6 | States the position — *"the schema is data"* — and does not specify the file |
| `12` | Edge roles, reverse-indexing, enum neutral variant names, per-field case-insensitivity, per-kind similarity weights, identity tuples |
| `14` | The statement dictionary's binding to kinds and fields |
| `63` §5.3 | The platform enum map |
| `43` §1.3 | A build-time input to the artifact |
| `13` | Emitter accessor codegen (ADR-0007's mitigation for fallible field reads) |

`11` §17 lists its open decisions and this is not among them, which is how a hole this size stays
invisible: every document assumes a sibling specified it.

Without it, three things cannot be built: `12`'s `fex` type checker (it has no type environment),
`14`'s reconciler (it has no identity tuples to read), and `63`'s pack lint (it has no kind or field
universe to validate against). `82` §15 shows the second-order cost already arriving — `11` §6.4
references `Device.aggregate_device_count` and the `Device` field table in §6.3 does not define it.
A schema that exists only as prose in one document has no mechanism that would catch that.

## Decision

**Write `docs/60-content/62-schema-spec.md`, and make `schema.yaml` a first-class build input owned
by `11-ir-schema.md`.** The specification covers, at minimum, the six consumers above:

| Section | Contents |
|---|---|
| **Kinds** | Every node kind and edge kind, its fields, each field's type, cardinality, `Presence` semantics, and whether it is emitted |
| **Edges** | Role names, direction, cardinality at both ends, reverse-index requirements |
| **Enums** | Variants, the neutral variant name, per-platform surface strings (`63` §5.3's platform enum map lives here, not in `63`) |
| **Identity** | The ordered identity tuples per kind (`11` §10.3), which ADR-0010 makes the sole source |
| **Matching** | Per-field case-insensitivity, per-kind similarity weights for the residue matcher |
| **Emission** | Which fields require which sibling fields to be committable — the `reth_count` class of blocker (`82` §15) |
| **Versioning** | `schema_major`/`schema_minor` semantics, what a major bump permits, and the content hash published alongside |

Three properties are part of the decision:

1. **The schema is data, and the code is generated from it.** Rust types, the `fex` name environment,
   the emitter accessors and the pack lint's kind universe all derive from one file. A field that
   exists in prose and not in `schema.yaml` does not exist.
2. **`62` fills the gap in the `60-content/` numbering** that `83` M2 identifies. `15` keeps the
   explainer *design*; the explainer *file format* moves next to `61` and `63` where the other two
   corpus formats live.
3. **The statement dictionary gets its content spec in the same document** (`83` M3). `71` §5.7
   budgets ~1,750 entries and 6–9 weeks of domain time for an artifact with no schema, no ID
   convention and no review discipline. That is M1's failure mode on the largest content asset after
   the explainers.

## Consequences

### Positive

- Three blocked subsystems unblock: the `fex` type checker, the reconciler and the pack lint.
- ADR-0007's negative consequence — fallible emitter field reads — gets its stated mitigation, and
  the mitigation becomes checkable rather than promised.
- `82` §15's class of defect becomes a CI failure instead of a review finding: a field referenced by
  an emit rule and absent from the kind table fails the build.
- The schema's version becomes part of invariant 9's determinism tuple, which ADR-0002 already
  requires.

### Negative

- **This is a new document nobody budgeted, on the critical path for phases 1, 2 and 3.** It is not
  in `71`'s phase table and it is not in `83` §12's re-costing either. Realistically two to three
  weeks of specification plus the codegen, before the rule engine can be finished.
- **Codegen from a schema is a build-time dependency that fights ADR-0019's no-Node position and
  ADR-0017's reproducibility claim.** Every generator is another pinned tool whose output must be
  byte-reproducible, and `35`'s attestation programme grows a step.
- **A data-driven schema invites runtime schema loading**, which is a plugin system with better
  manners. `73` §9 already forbids executing third-party code; a third-party *schema* is the same
  hazard wearing a data hat, and this ADR does not close that door — ADR-0028's trust root does.
- **It centralises a bottleneck.** Every kind addition now touches one file that six subsystems
  regenerate from. In a one-person project that is a feature; with three people it is a merge
  conflict on every branch.
- **Writing it will reveal that `11` is incomplete.** `82` §15 already names four missing pieces for
  a chassis cluster alone. Specifying the schema means discovering how much of the IR is prose.

## Alternatives considered

| Option | Strongest argument for it | Why rejected |
|---|---|---|
| **Rust types are the schema; generate YAML from them if needed** | One source of truth, no codegen step, the compiler enforces it, and `41` §9.2's line budget stays small | `12` and `63` need the schema at *authoring* time, in a rule pack lint that runs without the binary, and `43` §1.3 needs it as a build input. A schema locked inside a compiled crate cannot be read by the pack author's editor |
| **Leave it as prose in `11` and let each consumer parse what it needs** | Zero new documents; it is the current state and four documents have already built against it | It is the current state and it is why `Device.aggregate_device_count` is referenced and undefined. Six independent readings of a prose specification produce six schemas |
| **Adopt an existing schema language (JSON Schema, CUE, Protobuf)** | Mature tooling, real validators, no bespoke format | None of them expresses identity tuples, per-kind similarity weights, or per-platform enum surfaces. The schema would be JSON Schema plus four sidecar files, which is a bespoke format with extra dependencies |
| **Defer until phase 2, when the parser needs it** | It is not needed to ship the finder, which is v1 (ADR-0006) | `73` §11's ordering rule: do not freeze `fex`'s name environment before the graph shape is settled. The schema *is* the name environment. Deferring it means authoring rules against something undefined |

## Revisit if

- The generated code diverges from `schema.yaml` in a way the build does not catch — the codegen is
  not the mechanism it claims to be and the Rust types should become the source.
- ADR-0030's PAN-OS work requires per-platform schema variation rather than per-platform enum
  surfaces, which would mean one schema is the wrong shape.
- The statement dictionary's spec, once written, has nothing structural in common with the schema —
  in which case it is a separate document and this ADR is over-scoped.
