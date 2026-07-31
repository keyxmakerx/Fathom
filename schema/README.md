# schema/

The declared schema — the file the whole product is generated from (ADR-0008: *"The schema
is data, and the code is generated from it. A field that exists in prose and not in
`schema.yaml` does not exist."*).

**Grammar:** `docs/60-content/62-schema-spec.md` is this tree's grammar, layout, validator
and version discipline. Content is owned by `docs/10-core/11-ir-schema.md` (config layer)
and `docs/10-core/19-service-and-physical-model.md` (physical and service layers); `62`
wins on form, the source documents win on intent, and a disagreement between them is a
defect to file, not to interpret around. The codegen (`fathom-schemagen`, `62` §17) is separate work.

**Checking:** `cargo run -p fathom-schema --bin fathom-schema-check` parses this tree
against `62` §2.2's YAML subset and enforces the mechanically-checkable `62` §18 gates
(the ones needing git history or a released snapshot are listed on every run as not yet
checkable; the ones that live elsewhere are listed as checked elsewhere). The shipped
tree's zero-failure state is pinned by `crates/fathom-schema/tests/shipped_tree.rs`, so a
schema edit that breaks a gate fails `cargo test`. Codes the spec does not name are
emitted with a `proposed:` prefix — each one is a gap to file against `62` §18, not to
silence.

**Codegen:** `cargo run -p fathom-schemagen` regenerates the `62` §17.1 artifacts from
this tree (gates first — it refuses while any failure-severity gate fires);
`cargo run -p fathom-schemagen -- --check` compares without writing. Every schema edit is
therefore: edit the tree, regenerate, commit both — `cargo test` fails otherwise, because
`crates/fathom-schemagen/tests/determinism.rs` regenerates and byte-compares the
checked-in outputs (`schema.codegen.stale`) and runs the generator twice
(`schema.codegen.nondeterministic`), and `tests/attrtype_drift.rs` holds `62` §13.3's
`AttrType` table against the shipped enum. `schema.scalar.unbound`'s compile-time half is
the generated binding inventory in `crates/fathom-ir/src/generated/ir_types.rs`: every
declared `impl:` path is referenced there, so `cargo build -p fathom-ir` is the check.

| Path | What |
|---|---|
| `schema.yaml` | Scalar bindings, classes, kinds, edges, derived edges, constraints, emission, matching, scopes, `naming_eligible` |
| `platforms.yaml` | The platform registry and the `vendors:` block (`62` §14) |
| `enums/` | One file per named enum (`62` §7); unknown arms are generated, never declared |
| `field-keys.yaml` | The append-only field-key registry — integer keys per field, assigned once, never reused (`62` §2.3, §17.1) |
| `released/` | One checked-in `schema.json` snapshot per released version (`62` §16.4). Empty: nothing has been released |
| `service-types/builtin.yaml` | The four shipped `ServiceType` declarations (`62` §20.4). Homed at `corpus/service-types/` by `62` §2.1; parked here until the corpus tree is written |
| `generated/` | `schema.json` (canonical, the content-hashed artifact) and `ir_types.ts` (the UI-boundary mirror), written by `fathom-schemagen` — never edited by hand |
| `migrations/manifest.toml` | The declared migration chain (`62` §17.1) — generated, and honestly empty pre-1.0 |

**Generated artifacts exist and are checked in** (`62` §17.2 requirement 2): the two
files above plus `crates/fathom-ir/src/generated/{ir_types.rs, accessors.rs}`; the
staleness and determinism gates run as cargo tests in `fathom-schemagen`. `released/` is
still empty and no `schema_hash` has been published — that happens at the first release.

**Version:** `0.1` — the entire config + physical + service model lands as **one minor
bump from an empty baseline** (`19` §7.5's arithmetic against `11` §11.3's table; `62`
§16). Lifecycle state and ticket references are **not shipped** (`62` §20.6–20.7 are
declarability demonstrations only). Every genuinely underdetermined declaration carries a
`# VERIFY:` marker in place; nothing was guessed silently.
