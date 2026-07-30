# schema/

The declared schema — the file the whole product is generated from (ADR-0008: *"The schema
is data, and the code is generated from it. A field that exists in prose and not in
`schema.yaml` does not exist."*).

**Grammar:** `docs/60-content/62-schema-spec.md` is this tree's grammar, layout, validator
and version discipline. Content is owned by `docs/10-core/11-ir-schema.md` (config layer)
and `docs/10-core/19-service-and-physical-model.md` (physical and service layers); `62`
wins on form, the source documents win on intent, and a disagreement between them is a
defect to file, not to interpret around. This tree is **data** — the repo still contains
no application code; the codegen (`fathom-schemagen`, `62` §17) is separate work.

| Path | What |
|---|---|
| `schema.yaml` | Scalar bindings, classes, kinds, edges, derived edges, constraints, emission, matching, scopes, `naming_eligible` |
| `platforms.yaml` | The platform registry and the `vendors:` block (`62` §14) |
| `enums/` | One file per named enum (`62` §7); unknown arms are generated, never declared |
| `field-keys.yaml` | The append-only field-key registry — integer keys per field, assigned once, never reused (`62` §2.3, §17.1) |
| `released/` | One checked-in `schema.json` snapshot per released version (`62` §16.4). Empty: nothing has been released |
| `service-types/builtin.yaml` | The four shipped `ServiceType` declarations (`62` §20.4). Homed at `corpus/service-types/` by `62` §2.1; parked here until the corpus tree is written |

**Generated artifacts do not exist yet.** None of `ir_types.rs`, `accessors.rs`,
`schema.json`, `ir_types.ts` or `migrations/manifest.toml` (`62` §17.1) has been generated;
`released/` is empty and no `schema_hash` has been published.

**Version:** `0.1` — the entire config + physical + service model lands as **one minor
bump from an empty baseline** (`19` §7.5's arithmetic against `11` §11.3's table; `62`
§16). Lifecycle state and ticket references are **not shipped** (`62` §20.6–20.7 are
declarability demonstrations only). Every genuinely underdetermined declaration carries a
`# VERIFY:` marker in place; nothing was guessed silently.
