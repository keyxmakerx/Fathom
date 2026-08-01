# Fathom — architecture corpus, schema, and first code

The design corpus, declared schema and first toolchain for a security-first, client-side
network engineering tool. Fifty-odd specification documents, thirty decision records, six
adversarial critiques, a seed content corpus, a declared `schema/` tree, two Rust crates that
parse and gate it, and a full-application interactive mockup.

Fathom models a network as one typed graph and projects it into a diagram, a configuration, a set
of findings, an explanation, a verification ladder and an inventory. It never touches a device,
never accepts a credential, and never opens a connection the user did not configure — permanently
(`docs/30-security/38-the-egress-question.md` prices every future exception).

> **Status: the product was redefined mid-corpus, deliberately.** The original corpus specifies a
> teaching-and-modelling tool with the command finder as v1 (ADR-0006, `71`). The owner has since
> decided Fathom is also **the system of record for a service-provider estate** — tenants,
> services with CIDs, E-Line/E-LAN with per-location UNI IDs, physical ports and cables,
> addresses and CLLI-coded naming — with teaching co-equal. That redefinition is captured in
> `docs/70-ops/77-service-model-requirements.md` (the owner's words), analysed in
> `docs/70-ops/76-scope-expansion-analysis.md` (the revised build order), and modelled in
> `docs/10-core/19-service-and-physical-model.md`. Where `71` and `76` disagree on sequence,
> the disagreement is real and recorded — the owner has reopened decisions on merit and said so
> (`75` §2). *Fathom* is a working codename; ADR-0005 requires a rename before publication.

## Picking this up cold — the new-session path

| | Read | Why |
|---|---|---|
| 1 | `CLAUDE.md` | One page: state, rules, next actions |
| 2 | `docs/00-vision/01-vision-and-thesis.md` | The original thesis. Still the voice and the security posture |
| 3 | `.context/conventions.md` | Ten invariants and the vocabulary every document is bound by |
| 4 | `docs/70-ops/77-…` then `76-…` | The redefinition, verbatim, then the analysis and **the build order** |
| 5 | `docs/10-core/19-service-and-physical-model.md` | The IR extension: ports, cables, tenants, services, the warp, the schema mechanism |
| 6 | `docs/60-content/62-schema-spec.md` + `schema/` | The grammar and its first instance. `cargo test` gates both |
| 7 | `docs/70-ops/75-capability-register.md` | Everything intended but not yet decided or scheduled — and the two standing instructions |
| 8 | `design/prototype/fathom-app.html` | Open from disk. The whole product, interactive — the fidelity bar |

Three tasks are **owner-only** and block the rest: the S0 fixture exports (`76` §7), the four
forks in `19` §10, and the named expert review of the corpus (invariant 10). The next
engineering item is `fathom-schemagen` (`62` §17). The original reading order for the
foundational corpus follows unchanged below.

## `.context/` — the inputs

| File | |
|---|---|
| `owner-brief.md` | The owner's own architecture note, verbatim. Truncated mid-sentence in §7.1 |
| `conventions.md` | Terminology, the ten hard invariants, the risk enum, identifier formats |
| `design-language.md` | Palette, type, structure and voice, machine-extracted from the field card PDF (the PDF itself is not committed; `field-card-srx-ipsec.txt` carries its text) |
| `field-card-srx-ipsec.txt` | The four-side SRX IPsec field card. The origin artifact and the shared worked example |

## `docs/`

Every document opens with a `> **Status:**` line — `Proposed`, `Accepted`, `Contested` or
`Reconstructed`, per `.context/conventions.md`. **Reconstructed** marks content rebuilt from the
truncated owner brief: `31-threat-model.md`, `72-risks.md`, and §§7–12 of the vision document.
The six critiques in `80-review/` are `Contested` by design; the reconciliation and the ADRs
carry `Accepted`.

### `00-vision/`
| | |
|---|---|
| `01-vision-and-thesis.md` | Thesis, pillars, problem, positioning, security, AI, risks, roadmap, open decisions. §§7–12 **Reconstructed** |
| `02-prior-art-and-positioning.md` | Nine-axis survey of twenty competitors; four corrections to the brief; where Fathom is worse |
| `03-non-goals-and-scope.md` | Eighteen boundaries, each with a refused adjacent and a test |

### `10-core/` — the deterministic engine
| | |
|---|---|
| `11-ir-schema.md` | Node kinds, edge kinds, fields, provenance, identity tuples, re-identification |
| `12-rule-engine.md` | `fex`, the 28-opcode VM, incremental evaluation, suppressions |
| `13-emitters-and-provenance.md` | `(line, provenance)` pairs, statement tables, risk on every line |
| `14-parsers-and-ingest.md` | Config paste, the statement dictionary, residue ledger, redaction |
| `15-explainer-corpus.md` | Three depths, staleness, authoring rates, the voice gate |
| `16-command-finder.md` | The wedge: concept layer, BM25F, FST trie, ranking determinism |
| `17-workspace-format.md` | On-disk tree, record taxonomy, git behaviour, `fsck`, import and export |
| `18-diff-verify-rollback.md` | Graph diff, the verify ladder, rollback generation, aggregate risk |
| `19-service-and-physical-model.md` | **Post-redefinition.** Physical ports and cables split from config interfaces; tenants, services, CIDs, UNIs; the warp; the schema mechanism; naming policy |

### `20-ai/` — quarantined, optional, absent by default
| | |
|---|---|
| `21-ai-layer-architecture.md` | The boundary, the five verbs, the four tiers, egress machinery |
| `22-subagent-catalogue.md` | The subagent catalogue, tool grants, gates. Renamed per ADR-0021 (applying ADR-0002's terminology amendment) |
| `23-ai-safety-and-injection.md` | Fences, detectors, the exfiltration-channel catalogue C1–C6 |
| `24-ai-determinism-and-offline.md` | Local inference, why the loopback sidecar was rejected |
| `25-ai-evaluation.md` | Suites, kill criteria written before results, no LLM-as-judge on anything that gates |

### `30-security/`
| | |
|---|---|
| `31-threat-model.md` | Actors, assets, in scope, out of scope without softening, metadata channels. **Reconstructed** — the full form of brief §7.1, which terminated mid-sentence |
| `32-cryptography.md` | Primitives, KDF, AEAD, key commitment, the key hierarchy, keyholders, padding |
| `33-sync-protocol.md` | The wire. Deferred by ADR-0016 until multi-writer is justified |
| `34-browser-hardening.md` | CSP per deployment mode, Permissions-Policy, the platform surface |
| `35-supply-chain-and-builds.md` | Reproducible builds, signing, published hashes, the fork story |
| `36-enterprise-review-qa.md` | The questions a security reviewer asks, answered. Customer-facing |
| `37-privacy-and-compliance.md` | Processor analysis, retention, data subject rights. Customer-facing |
| `38-the-egress-question.md` | **Post-redefinition.** What never connecting buys, priced per guarantee; the trust-gated ladder for every future connected capability. Nothing in it is approval |

### `40-stack/`
| | |
|---|---|
| `41-technology-choices.md` | Rust core to WASM and native, thin TypeScript UI, Axum sync service |
| `42-no-node-runtime.md` | The explicit answer to the "no Node.js at runtime" constraint |
| `43-deployment-modes.md` | D1 single file, D2 single node, D3 cluster, D4 CLI |
| `44-performance-budgets.md` | Size, memory and latency budgets, and the work-counter gate |
| `45-testing-strategy.md` | Golden fixtures, property tests, conformance, the CI gate set |
| `46-workspace-persistence-and-identity.md` | **Post-redefinition.** The save path per browser engine (verified from primary sources); the demo posture; username as typed HKDF context; the SSO bridges |

### `50-design/`
| | |
|---|---|
| `51-design-tokens.md` | Palette derivation, the channel budget, why there is no fourth accent |
| `52-information-architecture.md` | Six views as four renderers plus a controller, a corpus surface and a layer |
| `53-interaction-and-keyboard.md` | The keymap. Owns it; `Shift` is a safety control |
| `54-component-catalog.md` | Every component, with copy as a required part |
| `55-accessibility.md` | Contrast under eight resolved cascade states, targets, forced colours |
| `56-diagram-view.md` | Layered views, deterministic layout, SVG export |
| `58-ui-direction-study.md` | Five rendered directions judged; **the paired ledger chosen**, with three named adoptions |
| `59-diagram-aggregation-and-colour.md` | **Decided:** like-kind siblings collapse above six; the diagram takes no colour (reversal path pre-written to the overlay model) |

### `60-content/`
| | |
|---|---|
| `61-command-corpus-spec.md` | The command entry format, `answers`, `risk`, `blast_radius`, `rosetta` |
| `63-rulepack-spec.md` | Rule pack format, signing, lint gates, the severity budget |
| `62-schema-spec.md` | **Written.** The `schema/` grammar: YAML subset, declaration grammars, identity terms, ~40 gates with stable codes, worked examples incl. a user-defined E-LAN |

### `70-ops/`
| | |
|---|---|
| `71-roadmap.md` | Eight phases, exit criteria, kill points. Re-cut by ADR-0006 |
| `72-risks.md` | What kills this, with leading indicators, and a five-story pre-mortem. **Reconstructed** — the brief's promised §§11–14 never arrived |
| `73-open-decisions.md` | D01–D23, ranked by the latest responsible moment |
| `74-governance-and-licensing.md` | Licence split, contribution policy, advisory handling, continuity |
| `75-capability-register.md` | **Post-redefinition.** Intent recorded, nothing decided: lifecycle, tickets, bulk action, backup, teaching-off, hooks (refused on security), planning modes, freeform, stencils, pockets — plus the two standing instructions (sunk cost never argues; real-time must not be foreclosed) |
| `76-scope-expansion-analysis.md` | **Post-redefinition.** What the new requirements hit, and the revised build order — S0 is a fit test on owner-supplied fixtures, no code |
| `77-service-model-requirements.md` | **Post-redefinition.** The owner's requirements verbatim: tenants, CIDs, E-LAN/UNI, the warp, the modelling horizon, naming. Records seven collisions; resolves none |

### `80-review/` — the adversarial round
| | |
|---|---|
| `80-reconciliation.md` | The defect register: 12 blockers, 37 majors, 45 minors, adjudicated |
| `81-critique-security.md` | Two incompatible container formats; a false crypto-erasure claim |
| `82-critique-network-domain.md` | No `set` line could ever be `Disruptive`; six wrong technical claims |
| `83-critique-coherence.md` | 312 cross-references, nine silent re-decisions, all nine contradictions |
| `84-critique-product.md` | No buyer for the differentiating pillar; the wedge's comparables all stopped |
| `85-critique-ai-layer.md` | Every worked example cites corpus that does not exist |
| `86-critique-design.md` | The design set kept the card's vocabulary and lost its grammar |

### `90-decisions/` — binding once Accepted
`README.md` in this directory is the index of record: per-ADR summaries, statuses, the ordering
rationale, and the seven ADRs that block everything else. Twenty-nine records are Accepted;
ADR-0023 is Proposed and not in force. In one line each:

`0001` one owning document per question · `0002` invariant amendments and the residual scale ·
`0003` a tool, not a business · `0004` licence and publication · `0005` rename, and strip the name
from identifiers · `0006` v1 is the finder; the product is phases 0–3 · `0007` property graph with
first-class edges · `0008` `schema.yaml` is a specified artifact · `0009` `fex` is the rule
condition language · `0010` identity, re-parse and suppression survival · `0011` risk is a property
of effect · `0012` one workspace container · `0013` shards, whole-record rewrite, committed
manifest · `0014` envelope and KDF corrections · `0015` the claims register · `0016` git is the
sync for v1 · `0017` the offline artifact and deployment shapes · `0018` browser platform
corrections · `0019` TypeScript over a first-party render layer · `0020` the AI layer is a
boundary; no model in v1; tier 0 the default forever · `0021` one subagent catalogue, and the
supervisor is a host-side dispatcher · `0022` the runtime AI surface: one worker, one
transcriber, three build-time tools · *(`0023` a local read-only corpus MCP server —
**Proposed**, not in force)* · `0024` `53` owns the keymap, and Shift is the safety modifier ·
`0025` restore the card's density, geometry and channel budget · `0026` light is the product;
the dark theme ships on three conditions; the AA claim is qualified · `0027` two physical boxes,
and the verification stamp is required UI chrome · `0028` corpus authorship and contribution ·
`0029` domain corrections before the seed corpus ships · `0030` PAN-OS is the second platform.

## `corpus/` — seed content

| | |
|---|---|
| `commands/junos-srx-ipsec.yaml` | 98 command entries (91 from the card + 7 chassis-cluster per R09) |
| `rules/ipsec-junos-srx.yaml` | 37 rules. Corrections pending; **no fixtures yet** |
| `explainers/ipsec-concepts.yaml` | 41 explainers at three depths |

> **The corpus breaches invariant 10 today.** Every entry carries a placeholder reviewer and there
> are no fixtures. Both are declared in the files' own headers and both are release blockers on
> phase 0, not comments.

## `schema/` — the declared schema (post-redefinition)

The first instance of `62`'s grammar: 48 kinds, 89 edges, 61 scalars, the platform registry,
the append-only field-key registry, the four shipped service types. `62` wins on form, `11`/`19`
win on content; every strain between them is commented at the site. Checked by
`cargo run -p fathom-schema --bin fathom-schema-check` and pinned at zero failures by
`cargo test`. One warning is deliberately left standing: `Site` has no identity tuple because no
source ever stated one — the S0 site list forces that decision.

## `crates/` — the first code

| | |
|---|---|
| `fathom-id` | ULID over Crockford base32; `CommandId` / `ConceptId`. No clock, no RNG — parts are supplied by the caller (invariant 9) |
| `fathom-schema` | The `62` §2.2 YAML-subset parser (bespoke, zero dependencies) and every mechanically-checkable `62` §18 gate |
| `fathom-schemagen` | `62` §17's generator: gates first, then deterministic codegen; stale/nondeterminism wired as cargo tests; canonical `schema.json` |
| `fathom-ir` | Stub scalar/value types at the declared impl paths, plus the checked-in generated `ir_types.rs` / `accessors.rs` — `cargo build` proves schema and code agree. 59 workspace tests; toolchain pinned |

## `design/` — from tokens to the whole product

| | |
|---|---|
| `tokens.css` | The canonical token file — a verified transcription of `51` §14. Change the document first |
| `prototype/fathom-app.html` | **The whole product as one interactive file.** Six views, the service layer, the warp both ways, the per-equipment page, both themes. Open from disk; ⌥1–⌥6, Ctrl+K |
| `prototype/finder-states.html` | Every state of the phase-0 finder |
| `prototype/index.html` | The original interface study (pre-dates the token file) |
| `concepts/01–05` | The five direction studies `58` judged; 05 is the chosen base |
| `diagrams/` | The diagram research builds; `A2-aggregated.html` carries the decided treatment |
| `walkthrough/` | The build view (teaching on/off) and the buffer/notepad study |
