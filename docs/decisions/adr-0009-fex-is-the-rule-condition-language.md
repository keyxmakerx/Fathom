# ADR-0009 — `fex` is the rule condition language; no third-party evaluator ships in the trusted path

> **Status:** Accepted
> **Date:** 2026-07-28
> **Register entry:** `73` §3.6 (D06); `12` §3
> **Reversal cost:** R4 — the pack format is signed and published; every authored rule is written in it
> **Supersedes:** —

## Context

Invariant 5 says findings are data, not code. That makes the condition language the boundary between
data and code, and it has to satisfy four constraints simultaneously:

1. **Read-set extraction must be total.** `12`'s incremental engine re-evaluates only the rules whose
   read set intersects a change. If any condition can touch a field the analyser cannot see
   statically, the incremental engine is unsound and must fall back to full evaluation. `12` §5.3's
   load-bearing sentence — *"the dynamic case does not exist, by construction"* — is what buys this.
2. **It runs inside WASM, in a browser, against attacker-influenced graph content** (parsed captures).
3. **It must be deterministic and bounded**, per invariant 9 and `44`'s work-counter gating.
4. **A rule pack is signed data, and a signature bounds who, never what** — so the language must not
   be able to express anything a signature would need to constrain.

`12` §3 derives `fex` from constraint 1 rather than choosing it from a menu, prices it honestly at
2,000–2,500 lines, and compiles it to a 28-opcode VM. `83` §14 calls it *"the best decision in the
corpus."* `73` §3.6 records it with a named reversal trigger.

One live inconsistency: `44` §5.2 hedges a size-budget row with *"if CEL is adopted as an embedded
interpreter rather than compiled to the 28-opcode VM, this row moves"* — against a decision `12`
§3.3 already took and `63` already built on (`83` P3). A hedge against a settled decision reads to
an implementer as the decision being open.

## Decision

**`fex` — an owned subset of CEL's surface syntax, compiled to a 28-opcode VM, with total static
read-set extraction and a per-evaluation step budget. No third-party expression evaluator ships in
the trusted path.**

Four properties are part of the decision and are not negotiable separately:

| Property | Why it is load-bearing |
|---|---|
| **Total read-set extraction** | Without it the incremental engine is unsound, and `44` §1.1's work-counter gate has nothing to count |
| **No dynamic field access** | `node[expr]` does not exist. This is the single rule that makes extraction total |
| **A step budget** (`12` §15.3 gate 7: 2,000 VM steps) | Bounds evaluation against a hostile pack and a large graph, and gives ADR-0021's admission criterion A1 a falsifiable threshold |
| **CEL-*shaped* syntax, not CEL** | Authors get familiar syntax and documentation; the project owns the semantics and the evaluator |

`44` §5.2's CEL hedge is deleted. The row reads *"rule condition VM — counted inside rule engine"*.

Derived-predicate builtins (`has_policy_between`, `overlaps`, `mirrors`, `carries_adjacency`,
`nat_scope_covers` per ADR-0029) are host functions with declared read sets. Adding one is a code
change with a schema-level declaration, not a pack-level extension.

## Consequences

### Positive

- The incremental engine is sound by construction rather than by testing, and a continuous linter
  over a 5,000-node graph becomes feasible in a browser.
- A signed pack from a hostile publisher can waste at most 2,000 VM steps per rule per node. The
  trust root (ADR-0028) then only has to bound *who*, which is the one thing a signature can do.
- The corpus's expression grammar is stable forever, which matters because ADR-0006 makes the corpus
  the schedule and re-authoring 200 rules is a season.
- No third-party evaluator in the trusted path means `35`'s dependency surface stays small and
  `cargo-vet`'s audit set stays reviewable.

### Negative

- **2,000–2,500 lines of language implementation is a real subsystem with a real bug surface**, and
  it is a subsystem the project owns forever, including the parser, the type checker, the compiler,
  the VM, and the error messages a corpus author reads at 23:00. Nothing about it is the product.
- **Rule authors get a language that looks like CEL and is not.** Every difference is a trap: an
  author who knows CEL will reach for a macro that does not exist, and the error message will be
  ours to write. `82` §7 already shows the cost — `ike.dh-group.weak` compares a `DhGroup` enum
  against integer literals, which under typed evaluation *"either fails to compile or silently never
  matches — and silently never matches is the outcome that ships."*
- **No dynamic access means some genuinely useful rules are unwritable.** Anything shaped "for each
  field in this kind, check X" has to be enumerated by hand or expressed as a host builtin, and the
  builtin list will grow with every domain.
- **The step budget will be hit by a legitimate rule**, probably a relational one over a large zone,
  and the resolution will be a host builtin — which moves rule logic from data into code, weakening
  invariant 5 one function at a time. The declared-read-set requirement is the only thing holding
  that line.
- **Owning the language means owning its versioning.** A `fex` grammar change is a pack-format change
  is a signature-envelope change, and packs are published artifacts.

## Alternatives considered

| Option | Strongest argument for it | Why rejected |
|---|---|---|
| **CEL, embedded (`cel-rust`)** | It is a real standard with real documentation, an existing test suite, and thousands of engineer-hours of hardening. Nobody has to learn a bespoke language, and the project writes zero language code | CEL's macros (`has`, comprehensions over dynamic receivers) make read-set extraction partial. The incremental engine then needs a conservative over-approximation, which in practice is "the whole graph" — and the continuous linter is the feature. It also puts a third-party evaluator in the path that runs attacker-influenced content |
| **Rhai / Lua / Starlark** | Mature sandboxed embedding, real ecosystems, familiar to more people than CEL | All three are general-purpose languages: they have loops, mutation and a call stack. Read-set extraction is undecidable, the step budget becomes the only bound, and a rule pack becomes a program — which is invariant 5 inverted |
| **WASM modules as rules** | Perfect isolation, any authoring language, and the sandbox already exists | A rule becomes an opaque binary, so `acceptable_when`, `why` and the remediation can no longer be read, diffed or reviewed by a network engineer. It also makes a pack an executable, which `73` §9 forbids for the supply-chain reason |
| **A fixed predicate table, no expression language** | Trivially analysable, trivially bounded, no parser | The seed pack's 37 conditions already use disjunction, quantification over collections, cross-node traversal and negation. The table would be the language, discovered incrementally and badly |
| **SQL over the relational shape** | Read sets are query plans; the analysis is free and fifty years old | Requires ADR-0007 to have gone the other way, and imports a query engine into the trusted path |

## Revisit if

- Read-set extraction turns out to be over-approximating so often that the incremental engine
  provides no benefit — the constraint that generated `fex` was not the real constraint.
- The host-builtin list passes roughly a dozen entries, which means rule logic is migrating into
  code and invariant 5 is being eroded by the mechanism meant to protect it.
- A rule that a network engineer considers ordinary cannot be expressed twice in a row. `12` §3's
  bet is that the domain's conditions are relational-but-static; two failures is evidence it is not.
