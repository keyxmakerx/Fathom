# Fathom — architecture corpus

**This repository contains no code.** It is the design corpus for a security-first, client-side
network engineering tool: forty-odd specification documents, eighteen accepted decision records,
six adversarial critiques, one reconciliation register, and a seed content corpus in YAML.

Fathom models a network as one typed graph and projects it into a diagram, a configuration, a set
of findings, an explanation, a verification ladder and an inventory. It never touches a device,
never accepts a credential, and never opens a connection the user did not configure.

> **Status: planning. Nothing is committed to code.** The corpus has been through one adversarial
> review round; all twelve blockers are closed in `docs/90-decisions/`. Six questions remain open
> and four of them are blocked on measurements nobody has taken — see
> `docs/00-vision/01-vision-and-thesis.md` §12.1. *Fathom* is a working codename and ADR-0005
> requires a rename before publication.

## Reading order

| | Read | Why |
|---|---|---|
| 1 | `docs/00-vision/01-vision-and-thesis.md` | The front door. Stands alone if you read nothing else |
| 2 | `.context/conventions.md` | Ten invariants and the vocabulary every document is bound by |
| 3 | `.context/design-language.md` | The three-colour legend and the voice, extracted from the owner's field card |
| 4 | `docs/80-review/80-reconciliation.md` | What was wrong and what was decided. The register of record |
| 5 | `docs/90-decisions/` | ADR-0001 … ADR-0018, binding |
| 6 | The area you are implementing | `10-core` first — everything else depends on the graph |

## `.context/` — the inputs

| File | |
|---|---|
| `owner-brief.md` | The owner's own architecture note, verbatim. Truncated mid-sentence in §7.1 |
| `conventions.md` | Terminology, the ten hard invariants, the risk enum, identifier formats |
| `design-language.md` | Palette, type, structure and voice, machine-extracted from the field card PDF |
| `field-card-srx-ipsec.txt` | The four-side SRX IPsec field card. The origin artifact and the shared worked example |

## `docs/`

### `00-vision/`
| | |
|---|---|
| `01-vision-and-thesis.md` | Thesis, pillars, problem, positioning, security, AI, risks, roadmap, open decisions |
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

### `20-ai/` — quarantined, optional, absent by default
| | |
|---|---|
| `21-ai-layer-architecture.md` | The boundary, the five verbs, the four tiers, egress machinery |
| `22-agent-catalog.md` | The subagent catalogue, tool grants, gates. Renamed by ADR-0002 |
| `23-ai-safety-and-injection.md` | Fences, detectors, the exfiltration-channel catalogue C1–C6 |
| `24-ai-determinism-and-offline.md` | Local inference, why the loopback sidecar was rejected |
| `25-ai-evaluation.md` | Suites, kill criteria written before results, no LLM-as-judge on anything that gates |

### `30-security/`
| | |
|---|---|
| `31-threat-model.md` | Actors, assets, in scope, out of scope without softening, metadata channels |
| `32-cryptography.md` | Primitives, KDF, AEAD, key commitment, the key hierarchy, keyholders, padding |
| `33-sync-protocol.md` | The wire. Deferred by ADR-0016 until multi-writer is justified |
| `34-browser-hardening.md` | CSP per deployment mode, Permissions-Policy, the platform surface |
| `35-supply-chain-and-builds.md` | Reproducible builds, signing, published hashes, the fork story |
| `36-enterprise-review-qa.md` | The questions a security reviewer asks, answered. Customer-facing |
| `37-privacy-and-compliance.md` | Processor analysis, retention, data subject rights. Customer-facing |

### `40-stack/`
| | |
|---|---|
| `41-technology-choices.md` | Rust core to WASM and native, thin TypeScript UI, Axum sync service |
| `42-no-node-runtime.md` | The explicit answer to the "no Node.js at runtime" constraint |
| `43-deployment-modes.md` | D1 single file, D2 single node, D3 cluster, D4 CLI |
| `44-performance-budgets.md` | Size, memory and latency budgets, and the work-counter gate |
| `45-testing-strategy.md` | Golden fixtures, property tests, conformance, the CI gate set |

### `50-design/`
| | |
|---|---|
| `51-design-tokens.md` | Palette derivation, the channel budget, why there is no fourth accent |
| `52-information-architecture.md` | Six views as four renderers plus a controller, a corpus surface and a layer |
| `53-interaction-and-keyboard.md` | The keymap. Owns it; `Shift` is a safety control |
| `54-component-catalog.md` | Every component, with copy as a required part |
| `55-accessibility.md` | Contrast under eight resolved cascade states, targets, forced colours |
| `56-diagram-view.md` | Layered views, deterministic layout, SVG export |

### `60-content/`
| | |
|---|---|
| `61-command-corpus-spec.md` | The command entry format, `answers`, `risk`, `blast_radius`, `rosetta` |
| `63-rulepack-spec.md` | Rule pack format, signing, lint gates, the severity budget |
| *(`62-schema-spec.md`)* | Not yet written. Required by ADR-0008 — six subsystems depend on it |

### `70-ops/`
| | |
|---|---|
| `71-roadmap.md` | Eight rungs, exit criteria, kill points. Re-cut by ADR-0006 |
| `72-risks.md` | What kills this, with leading indicators, and a five-story pre-mortem |
| `73-open-decisions.md` | D01–D23, ranked by the latest responsible moment |
| `74-governance-and-licensing.md` | Licence split, contribution policy, advisory handling, continuity |

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

### `90-decisions/` — accepted, binding
`0001` one owning document per question · `0002` invariant amendments and the residual scale ·
`0003` a tool, not a business · `0004` licence and publication · `0005` rename, and strip the name
from identifiers · `0006` v1 is the finder; the product is rungs 0–3 · `0007` property graph with
first-class edges · `0008` `schema.yaml` is a specified artifact · `0009` `fex` is the rule
condition language · `0010` identity, re-parse and suppression survival · `0011` risk is a property
of effect · `0012` one workspace container · `0013` shards, whole-record rewrite, committed
manifest · `0014` envelope and KDF corrections · `0015` the claims register · `0016` git is the
sync for v1 · `0017` the offline artifact and deployment shapes · `0018` browser platform
corrections.

## `corpus/` — seed content

| | |
|---|---|
| `commands/junos-srx-ipsec.yaml` | 91 command entries. Reclassification pending per ADR-0011 |
| `rules/ipsec-junos-srx.yaml` | 37 rules. Corrections pending; **no fixtures yet** |
| `explainers/ipsec-concepts.yaml` | 41 explainers at three depths |

> **The corpus breaches invariant 10 today.** Every entry carries a placeholder reviewer and there
> are no fixtures. Both are declared in the files' own headers and both are release blockers on
> rung 0, not comments.

## `design/prototype/`

`index.html` — a static rendering of the design language. Not the product, not a build target.
