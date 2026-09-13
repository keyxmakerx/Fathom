# 12 — The rule engine

> **Status:** Proposed

Companion document: `docs/60-content/63-rulepack-spec.md` (the authoring format). This
document specifies the machine. That one specifies what you feed it.

Owner brief §5.2 fixes the shape of the problem in one sentence: **findings are data, not
code.** That sentence is the whole reason this document is long. If rules were code, the
engine would be a `for` loop and the design work would live in 4,000 hand-written
functions. Because rules are data, every hard question — how do you know which rules to
re-run, how do you stop a downloaded rule from executing arbitrary code, how do you tell
what a rule reads without running it — lands on the engine.

## Contents

1. [What the engine is, and is not](#1-what-the-engine-is-and-is-not)
2. [Field state: the four-valued presence model](#2-field-state-the-four-valued-presence-model)
3. [The condition language — DECISION](#3-the-condition-language--decision)
4. [Selectors: how a rule reaches more than one node](#4-selectors-how-a-rule-reaches-more-than-one-node)
5. [Static read-set extraction](#5-static-read-set-extraction)
6. [The incremental evaluation model](#6-the-incremental-evaluation-model)
7. [Latency budget and complexity](#7-latency-budget-and-complexity)
8. [Rules that need the far end](#8-rules-that-need-the-far-end)
9. [Severity, confidence, category — and why none of them is `Risk`](#9-severity-confidence-category--and-why-none-of-them-is-risk)
10. [Findings: identity, lifecycle, data shape](#10-findings-identity-lifecycle-data-shape)
11. [Suppressions](#11-suppressions)
12. [Conflict, duplication, supersession](#12-conflict-duplication-supersession)
13. [Rule pack distribution](#13-rule-pack-distribution)
14. [When a pack and the schema disagree](#14-when-a-pack-and-the-schema-disagree)
15. [Testing and the CI gate](#15-testing-and-the-ci-gate)
16. [Failure modes of the engine itself](#16-failure-modes-of-the-engine-itself)
17. [Open decisions](#17-open-decisions)
18. [Disagreements](#18-disagreements)

---

## 1. What the engine is, and is not

### 1.1 The one-line definition

```
findings = lint(graph)
```

is the owner brief's projection. Expanded, the engine is a function from
`(graph, rule packs, workspace settings)` to a **stable, ordered, deterministic** set of
findings, recomputed incrementally as the graph mutates, with every finding carrying
enough provenance to explain itself and enough structure to be suppressed, exported and
diffed.

### 1.2 What it is not

| Not this | Because |
|---|---|
| A control-plane simulator | Batfish reconstructs RIB/FIB and answers reachability (owner brief §3.1). We do not. We can say "there is no static route pointing at `st0.0`"; we cannot say "the route will lose to a more specific from OSPF." Building a routing simulator is a second product. |
| A solver | No SMT, no model checking, no constraint solving. Every rule is a bounded predicate over a bounded neighbourhood. This caps what we can express and it caps what can go wrong. |
| A scripting host | Nothing in a rule pack executes. See §3. |
| A batch report generator | Owner brief §6.6: continuous lint. Batch reports are an *export* of the live finding set, not a separate path. |
| A place to put vendor-specific logic | Invariant 5. One engine. Rules carry `platforms` and `versions`. There is no `if platform == panos` anywhere in the engine. |

### 1.3 The three consumers

The finding set is read by three surfaces and they want different things. The engine must
serve all three from one evaluation, not three.

| Consumer | Wants | Consequence for the engine |
|---|---|---|
| The walkthrough (§6.2) | "what is still undecided on the node I am editing" | Findings need a `Pending` state, not just fire/no-fire (§2, §10.2) |
| The findings panel (§6.6) | "everything wrong in the workspace, ranked, filterable" | Total order must be deterministic and cheap to recompute |
| The change runbook (§6.7) | "what did this diff introduce or clear" | Findings need stable identity across evaluations *and across re-parse* (§10.1, §11.4) |

---

## 2. Field state: the four-valued presence model

This is the first design decision and most of the rest follows from it.

The owner's example condition is `perfect_forward_secrecy == null`. That works when the
graph came from a parsed config. It is actively wrong when the user is halfway through a
guided walkthrough and has not reached the PFS question yet — the tool would flag them for
not having answered a question it has not asked. That is precisely the behaviour that gets
a linter switched off in week one.

So a field is not `Option<T>`. It is:

```rust
/// The state of one typed field on one node.
#[derive(Clone, PartialEq, Eq)]
pub enum FieldState<T> {
    /// No information. Nobody typed it, no config was parsed that would have shown it.
    Unset,
    /// A config *was* parsed and the statement is not present. We therefore know the
    /// platform default applies. This is a positive fact, not an absence of one.
    Absent { prov: Provenance },
    /// Present in config (or chosen by the user) and equal to the platform default for
    /// this platform+version. Distinguished from `Set` because "explicitly wrote the
    /// default" and "inherited the default" are different review signals.
    Default { value: T, prov: Provenance },
    /// Present and non-default.
    Set { value: T, prov: Provenance },
}
```

`Provenance` is the shared type from the graph schema (`entered | parsed | inferred`, plus
timestamp and source reference). Terminology note: `provenance` is how a value got into the
graph; the `sources` field on a rule is a *citation*. Different things, never conflated.

### 2.1 What each state means to a rule

| fex expression | `Unset` | `Absent` | `Default(v)` | `Set(v)` |
|---|---|---|---|---|
| `x` (the value) | `null` | `null` | `v` | `v` |
| `has(x)` | false | false | true | true |
| `known_absent(x)` | false | **true** | false | false |
| `is_default(x)` | false | false | true | false |
| `is_known(x)` | false | true | true | true |

A rule for a parsed config writes `known_absent(perfect_forward_secrecy)`. A rule that
should also nag during hand-authoring writes `!has(perfect_forward_secrecy)` and sets
`on_unset: pending`.

### 2.2 `on_unset` — the three policies

Every rule declares what to do when any field in its read-set is `Unset`:

| `on_unset` | Behaviour | Use for |
|---|---|---|
| `pending` (default) | The rule does not produce a finding. It produces a **Pending** entry: "PFS not yet decided on `IPSEC-POL`", rendered as a checklist line in the walkthrough and folded into a single counter in the findings panel. | Almost everything. |
| `skip` | Silent. No finding, no pending entry. | Rules that are meaningless on a partial node — e.g. a rule comparing two lifetimes when neither is entered. |
| `fire` | Treat `Unset` as `null` and evaluate normally. | Rules where absence is itself the finding regardless of how the node was populated, e.g. `zone.host-inbound.ike-missing` on a device whose config was pasted. Rare; pack lint warns if more than 10% of a pack uses it. |

This one mechanism is why the walkthrough and the linter are the same subsystem rather
than two. The walkthrough's "questions remaining" list is `findings.filter(Pending)` on the
node in focus. No new code, per owner brief §4.1.3.

### 2.3 The typing gate

`Unset` handles "not answered yet". It does not handle "being answered right now". A user
typing `10.1.` into a prefix field must not be told `10.1.` is not a valid prefix on every
keystroke.

**Settling.** The schema declares, per field, a `settled` predicate — normally "parses as
the field's type". While a focused field's raw text is unsettled:

- the field reads as its **last settled value** to all rules;
- one non-blocking, field-local hint is shown (a parse hint, not a finding);
- no finding for that field is created, cleared, or animated.

On blur, or after 400 ms of no keystrokes with settled text, the value commits and Tier A
evaluation runs (§7). Findings never move while your cursor is in the field that produced
them.

**RECOMMENDATION — treat "does not flicker while typing" as a correctness property, not
polish.** It is measurable (count finding-set mutations per keystroke; target zero for
unsettled input) and it is the difference between a tool people leave on and one they close.

---

## 3. The condition language — DECISION

### 3.1 The requirement list, in priority order

1. **A downloaded rule pack must not be able to execute anything.** Fathom's entire pitch
   is that your configurations do not leave your machine (owner brief §2.4, §7). A pack
   format that can call out, allocate unboundedly, or reach the DOM makes that pitch a lie.
   This is not a "nice to have" — it is the product.
2. **Read-set extraction must be total.** The incremental engine (§6) is only possible if,
   given a rule and *without running it*, we can name every `(node, field)` and every edge
   it could read. A language where this is sometimes impossible gives us an engine that is
   sometimes O(all rules) — which is the same as never being incremental, because a
   keystroke's latency is set by the worst case.
3. **Determinism.** Invariant 9. Same workspace + same corpus version + same build ⇒
   byte-identical findings, identical order.
4. **Authorable by a network engineer who is not a programmer.** The people who know that
   `mode aggressive` is silently ignored under `v2-only` are not, mostly, going to write
   Starlark.
5. **WASM size.** The offline build is a single file. Every dependency is bytes a user
   downloads once and carries into an air-gapped environment.
6. **Static analysability beyond read-sets** — cost bounds, type errors, dead conditions,
   duplicate detection (§12).

### 3.2 The candidates, honestly

| Option | Sandboxing | Read-set extraction | Determinism | WASM cost | Authorability | Verdict |
|---|---|---|---|---|---|---|
| **Rhai** | Requires configured limits (`max_operations`, `max_string_size`, …); Turing-complete by design | **Impossible** in general — variables, dynamic dispatch, user functions | Good if you avoid the stdlib's non-deterministic corners | Non-trivial; the crate documents minimal builds via `only_i32`, `no_float`, `no_module` | Familiar to programmers; not to engineers | **Reject.** Fails (2) outright. |
| **Starlark** (`starlark-rust`) | Hermetic by design, no I/O, deterministic; loops are bounded but present | Hard: name binding, function definitions, dynamic attribute access | Strong — it exists for reproducible builds | Large; it is a Python-shaped language with a full frontend | Python-ish, so better than most; still a programming language | **Reject.** Fails (2), and (5) is bad. |
| **CEL** (`cel-rust` / `cel-interpreter`) | Excellent. Not Turing-complete, "CEL programs cannot loop forever", side-effect-free, memory-safe, and the spec explicitly targets *"execution of untrusted expressions with reliable containment"* with defined cost bounds | **Good** — no user-defined functions, no assignment; a walk of the AST names the selects. Comprehension macros (`all`, `exists`, `filter`) are the only binding forms | Strong | Unmeasured for the Rust implementations <!-- VERIFY: build cel-interpreter to wasm32-unknown-unknown with opt-level=z, lto=fat and measure the delta over an empty cdylib. The <100 KB figure seen in blog posts is not a claim we should repeat. --> | Syntax is C-like; `pfs_group == null` reads fine | **Strong contender.** See §3.3. |
| **JSONLogic** (`datalogic-rs`, `jsonlogic-rs`) | Excellent. Data, evaluated by a fixed operator table | Trivial — `{"var": "..."}` nodes are the read-set | Strong | Small | **Bad.** `{"==": [{"var":"perfect_forward_secrecy"}, null]}` is not a thing a network engineer will write or review | **Reject as an authoring surface.** Viable as a compiled form; we have a better one. |
| **Fixed combinator vocabulary** (structured YAML predicates, no expressions) | Perfect — nothing is parsed as an expression at all | Perfect | Perfect | Zero | Fine for the first 200 rules. Then authors start nesting `all_of`/`any_of`/`not` five deep and have written Lisp in YAML with worse ergonomics | **Reject.** It does not survive contact with relational rules (§4). |

### 3.3 CEL, or our own subset of CEL's syntax?

CEL is right on every axis that matters except one: we would not own it.

Three concrete consequences of not owning it:

1. **The evaluated surface is whatever the crate implements.** CEL has timestamps,
   durations, protobuf wrapper types, `dyn`, string formatting, a standard macro set, and
   an extension mechanism. Every one of those is surface we must reason about when a rule
   comes from a pack signed by someone else's key. A subset enforced by a post-hoc
   validator is a subset enforced by *our* correct enumeration of the superset — and the
   superset changes on `cargo update`.
2. **Read-set extraction becomes a property of a dependency we do not control.** If a
   future CEL version adds a way to select a field by computed name, our incremental
   engine silently becomes unsound. That is the worst possible failure: findings that
   quietly stop updating.
3. **Rust CEL implementations are young relative to the Go reference.** Conformance gaps
   between our evaluator and everyone else's would produce rules that fire differently on
   different builds, which breaks invariant 9 across versions.

**DECISION — Fathom defines `fex`, a purpose-built expression language whose concrete
syntax is a strict subset of CEL's. We own the lexer, parser, type checker, compiler and
VM. No third-party expression evaluator ships in the trusted path.**

Why a *subset of CEL's syntax* rather than a fresh syntax: authors and reviewers get a
grammar that is already documented elsewhere, editor tooling generalises, and if `fex`
ever proves inadequate we can widen toward CEL without invalidating a single authored rule.
The direction of the escape hatch is chosen deliberately.

**The cost, stated plainly.** We take on roughly 2,000–2,500 lines of parser, checker,
compiler and VM, plus a conformance suite, plus every future request for "can I just have
regex lookahead". That is real, permanent maintenance. We are buying: an evaluated surface
we can enumerate on one page, a read-set extractor that is total by construction, and a
security story that survives an enterprise review — "the rule pack is parsed, type-checked
and compiled to a 28-opcode VM with a step budget; nothing in it is executed by a host
language" is a sentence we can defend. In a product whose premise is confidentiality, that
sentence is worth 2,500 lines.

### 3.4 `fex` — grammar

```ebnf
program     ::= expr EOF
expr        ::= ternary
ternary     ::= or [ "?" expr ":" expr ]
or          ::= and { "||" and }
and         ::= rel { "&&" rel }
rel         ::= add [ ("=="|"!="|"<"|"<="|">"|">="|"in") add ]
add         ::= unary { ("+"|"-") unary }
unary       ::= [ "!" | "-" ] postfix
postfix     ::= primary { "." IDENT | "." method "(" args ")" | "(" args ")" }
primary     ::= literal | IDENT | "(" expr ")" | list
list        ::= "[" [ expr { "," expr } ] "]"
args        ::= [ expr { "," expr } ]
method      ::= "all" | "exists" | "exists_one" | "filter" | "count"
literal     ::= INT | STR | REGEX | "true" | "false" | "null" | IP | PREFIX | DUR
```

Deliberately absent, and why:

| Absent | Reason |
|---|---|
| Assignment, `let`, user functions | Every one of them makes the read-set a dataflow problem instead of a syntax walk. |
| Floats | No field in the graph needs one. MTU, MSS, lifetimes, DH groups, ports and prefix lengths are all integers. No NaN, no `-0.0`, no locale-dependent formatting, no cross-platform rounding. This buys determinism for free. |
| String concatenation | Building strings is the template's job (`63-rulepack-spec.md` §7), not the condition's. A condition that builds a string is a condition trying to be a remediation. |
| `map()` | It produces a list you must then reduce, and every reduction we need is already covered by `exists`/`filter`/`count`/`min`/`max`. Cutting it keeps the value lattice closed. |
| Loops of any form | Termination is not a runtime property we want to enforce; it is a grammar property. |
| Timestamps / "now" | Non-deterministic by construction. Invariant 9. Rules that want "this cert expires soon" get an explicit workspace-supplied `workspace.as_of` date, which the export records. |

### 3.5 `fex` — value lattice

```rust
#[derive(Clone, PartialEq, Eq, PartialOrd)]
pub enum Value {
    Null,
    Bool(bool),
    Int(i64),                 // checked arithmetic; overflow is an evaluation error
    Str(Interned),            // interned; comparison is a u32 compare
    Enum(EnumId, VariantId),  // schema-declared, platform-mapped (see 63 §5.3)
    Dur(i64),                 // seconds, signed
    Addr(IpAddr),             // v4 or v6
    Prefix(IpNet),
    List(Rc<[Value]>),        // only produced by selector `many` bindings and `filter`
    Node(NodeId),             // opaque; only field access and identity comparison
}
```

Comparison across kinds is a **type error at compile time**, never a runtime `false`. This
matters: `lifetime_seconds == "3600"` should fail the pack build, not silently never fire.
A rule that never fires is the most expensive kind of bug in a linter, because nothing
tells you.

`Null` participates only in `==`/`!=` and in `has()`/`known_absent()`. `null < 5` is a
compile error. No three-valued logic, no SQL-style `NULL` propagation — the checker forces
the author to say what they mean about absence.

### 3.6 `fex` — the name environment, and the security property

An identifier resolves to exactly one of:

1. a **selector binding** declared in `applies_to.with` (§4);
2. a **field of the anchor node**, written bare (implicit `self.`);
3. a **builtin function** from the closed table (§3.7);
4. a **workspace constant** under `workspace.` (`workspace.as_of`, `workspace.strictness`,
   `workspace.platform_hint`) — a fixed, documented, small set.

There is no `graph`, no `nodes`, no `find()`, no way to name a node the selector did not
bind. Stated as a property:

> **The selector is the only capability.** A condition can read exactly the neighbourhood
> its selector declared, and the selector is a declarative form the engine compiles to
> index probes. A rule cannot reach a node it did not ask for, and a pack reviewer can see
> everything a rule can touch by reading eight lines of YAML.

That property is what makes §5 total.

### 3.7 Builtins

Closed table. Each entry has a signature, a step cost, and a purity guarantee. Adding one
is an engine release, not a pack release.

| Builtin | Signature | Cost | Notes |
|---|---|---|---|
| `has(f)` | `field → bool` | 1 | `Default` or `Set`. Not a value read — see §2.1 |
| `known_absent(f)` | `field → bool` | 1 | Parsed config proves absence |
| `is_default(f)` | `field → bool` | 1 | |
| `is_known(f)` | `field → bool` | 1 | `!Unset` |
| `len(x)` | `list\|str → int` | 1 | |
| `count(x)` | `list → int` | 1 | alias of `len` on lists for readability |
| `min(x)` / `max(x)` | `list<int> → int` | \|x\| | error on empty list |
| `contains(p, a)` | `prefix, addr → bool` | 1 | |
| `overlaps(p, q)` | `prefix, prefix → bool` | 1 | |
| `is_subnet_of(p, q)` | `prefix, prefix → bool` | 1 | |
| `prefix_len(p)` | `prefix → int` | 1 | |
| `is_default_route(p)` | `prefix → bool` | 1 | `0.0.0.0/0` or `::/0` |
| `is_rfc1918(p)` | `prefix → bool` | 1 | RFC 1918 §3 |
| `mirrors(a, b)` | `ts, ts → bool` | 2 | domain function: `a.local == b.remote && a.remote == b.local` |
| `matches(s, /re/)` | `str, regex → bool` | len(s) | Regex literal only, compiled at pack build. Linear-time engine, no backreferences, no lookaround. Cost is bounded by input length by construction |
| `starts_with(s, t)` | `str, str → bool` | 1 | |
| `ends_with(s, t)` | `str, str → bool` | 1 | |
| `lower(s)` | `str → str` | len(s) | ASCII only; identifiers in network config are ASCII |
| `platform() ` | `→ enum` | 1 | the anchor's platform |
| `version_at_least(v)` | `str → bool` | 1 | within-train only; returns `null` if incomparable (§13 of `63-rulepack-spec.md`) |
| `field_exists_on_platform(f)` | `field → bool` | 1 | schema query; lets one rule cover platforms with differing surfaces |
| `enum_is(f, "name")` | `field, str → bool` | 1 | compares against the schema's *neutral* variant name, not a vendor spelling |
| `distinct(x)` | `list → bool` | \|x\| log \|x\| | all elements unique |

`enum_is` is not sugar. Comparing `establish_tunnels == "on-traffic"` bakes a Junos
spelling into a rule that claims `platforms: [junos-srx, panos]`. `enum_is` compares
against the neutral variant declared in the schema, and the platform map handles the
spelling. Pack lint rejects `==` between an enum field and a string literal.

### 3.8 Compilation target

`fex` compiles to a stack VM with 28 opcodes. Not a tree-walker, for three reasons:

1. **Step accounting is exact.** One opcode is one step (except `CALL`, which charges the
   builtin's cost, and comprehension bodies, which charge per iteration). The budget in §7
   is enforceable without instrumentation scattered through an evaluator.
2. **The compiled pack cache** (§13.6) needs a flat, serialisable program form. Loading
   4,000 rules by re-parsing YAML on every workspace open is not acceptable; loading a
   compiled image is.
3. Straight-line bytecode over an arena beats pointer-chasing an AST on cache behaviour,
   and we run this on the frame budget.

```
PUSH_CONST k          LOAD_FIELD b,f        LOAD_BIND b           LOAD_WS w
EQ  NE  LT  LE  GT  GE                      IN_LIST
AND_SC j   OR_SC j    NOT                   JMP j    JMP_IF_FALSE j
ADD  SUB  NEG                               CALL builtin,argc
ITER_INIT b   ITER_NEXT j   ITER_ACC op   ITER_END
HAS b,f   KNOWN_ABSENT b,f   IS_DEFAULT b,f   IS_KNOWN b,f
MK_LIST n             RET
```

Errors (integer overflow, `min` of empty list, budget exceeded) do not panic and do not
produce a finding. They produce an **engine diagnostic** attributed to the rule id, and the
rule is quarantined for the remainder of the session (§14.3). A broken rule must be loud
and must not be able to take the panel down.

---

## 4. Selectors: how a rule reaches more than one node

### 4.1 Why this is the important half

Single-node rules are the easy half and the less valuable half. The findings that earn
trust are relational, and the owner named three:

- `st0.0` exists but is in no zone
- the traffic selector does not mirror the peer
- both ends are on-traffic, so nobody initiates

None is a field predicate. All three need traversal. The field card is full of more:
*"st0 has no zone, no policy, or nothing routed at it. The SA proves crypto, not
reachability"* (side 4) is three relational rules in one sentence.

### 4.2 The form

```yaml
applies_to:
  kind: LogicalUnit
  where: "matches(name, /^st0\\./)"
  with:
    zone:
      via: zone_binding          # an edge ROLE from the schema, not a path
      card: optional             # one | optional | many
    vpn:
      via: bind_interface
      reverse: true              # follow the edge backwards
      card: optional
    device:
      via: [parent_interface, parent_device]   # multi-hop chain, max depth 3
      card: one
```

Then:

```yaml
condition: "zone == null"
```

Rules:

| Element | Rule |
|---|---|
| `kind` | Exactly one. The **anchor kind**. Findings attach to the anchor. |
| `where` | A `fex` predicate over the anchor's own fields only. No bindings are in scope. It is a filter on the anchor set, evaluated before any traversal, so it must be cheap. |
| `via` | An edge **role** declared in the schema. Never a field path, never a name. Invariant 7. |
| `reverse` | Follow the edge in the non-declared direction. Requires the schema to declare the edge as reverse-indexed. |
| `card: one` | Exactly one neighbour must exist. Zero or many is a **graph integrity error**, reported as an engine diagnostic, not a finding — a rule cannot be blamed for a malformed graph. |
| `card: optional` | Binds the node or `null`. |
| `card: many` | Binds a `List<Node>`, ordered by node ULID for determinism. |
| chain depth | Maximum 3 hops. Three covers `Interface → LogicalUnit → ZoneBinding → Zone`, which is the deepest real case in the IPsec domain. Unbounded traversal is how you get a rule that reads the whole graph. |

### 4.3 Compilation

A selector compiles to a plan:

```rust
pub struct CompiledSelector {
    pub anchor: KindId,
    pub filter: Option<Program>,             // `where`
    pub binds: SmallVec<[BindPlan; 4]>,
    pub canonical: Option<CanonicalRule>,    // §4.5
}

pub struct BindPlan {
    pub name: BindId,
    pub hops: SmallVec<[Hop; 3]>,
    pub card: Cardinality,
}

pub struct Hop { pub role: EdgeRoleId, pub dir: Direction }
```

Evaluation of one instance:

```
anchor_set = KindIndex[anchor]                       # O(1) to obtain, |A| to scan
  filtered by `filter`                               # O(|A| · cost(filter))
for each a in anchor_set:
    for each bind:
        n = a
        for each hop: n = Adjacency[role, dir][n]    # O(1) amortised per hop, hash probe
    eval(condition)                                  # O(cost(condition))
```

Adjacency indexes are maintained by the graph store on every edge mutation, both
directions for reverse-indexed roles. Cost: one hash-set insert/remove per edge write, and
memory proportional to edge count. That is the price of relational rules being fast, and
it is the right price.

### 4.4 Worked: the owner's three examples

**(a) `st0.0` exists but is in no zone.** Field card side 1, plumbing piece #2; side 4,
*"Tunnel UP, zero traffic."*

```yaml
id: tunnel.st0.zone-unbound
applies_to:
  kind: LogicalUnit
  where: "matches(name, /^st0\\.[0-9]+$/)"
  with:
    zone: { via: zone_binding, card: optional }
condition: "zone == null"
```

Read-set: `{LogicalUnit.name}` ∪ `{Adjacency(self, zone_binding, out)}`. One anchor scan
over `st0.*` units, one probe each.

**(b) Traffic selector does not mirror the peer.** Field card side 3, `TS_UNACCEPTABLE`.

```yaml
id: ipsec.traffic-selector.not-mirrored
applies_to:
  kind: TrafficSelector
  with:
    vpn:      { via: parent_vpn, card: one }
    peer_ts:  { via: [parent_vpn, peer_vpn, traffic_selectors], card: many }
requires: [peer_config]
condition: "!peer_ts.exists(t, mirrors(self, t))"
```

The `peer_vpn` edge exists only when the far end's configuration is in the graph. Absent
it, `requires: [peer_config]` keeps the rule out of the finding set and puts it in the
*unprovable* list instead (§8). It does not silently pass.

**(c) Both ends on-traffic, so nobody initiates.** Field card side 4, *"Both ends
on-traffic, or both responder-only. Nobody initiates, nothing is misconfigured, tunnel
never comes up."*

```yaml
id: ipsec.establish-tunnels.both-passive
applies_to:
  kind: IpsecVpn
  with:
    peer: { via: peer_vpn, card: one }
  canonical: peer            # fire once for the pair, not once per end
requires: [peer_config]
condition: >
  (enum_is(establish_tunnels, "on_traffic") || enum_is(establish_tunnels, "responder_only"))
  && (enum_is(peer.establish_tunnels, "on_traffic") || enum_is(peer.establish_tunnels, "responder_only"))
```

Note that `on-traffic` is the Junos default (confirmed against Juniper's `establish-tunnels`
documentation), so this rule fires on two configs that neither side wrote a line for. That
is the highest-value class of finding in the whole product: *nothing is misconfigured and
it will never work.*

### 4.5 Symmetric rules fire once

A rule with two symmetric bindings would naturally fire twice — once anchored at each end.
Two identical findings on a two-device tunnel is exactly the noise that gets a panel
ignored.

`canonical: <bind>` declares the pairing. The engine evaluates the instance only when
`anchor.id < bindings[bind].id` under ULID byte order, and skips it otherwise. Because
ULIDs are stable and totally ordered, the choice of which end is the anchor is
deterministic across machines and across sessions (invariant 9). The finding names both
ends; navigation offers both.

Cost: if the peer node is deleted and re-created (fresh ULID), the anchor may flip and the
finding gets a new identity. Suppressions survive via the natural-key fallback (§11.4), but
the finding will briefly appear as new in a runbook diff. Accepted; the alternative is a
stable-pair-id side table that must be garbage-collected.

### 4.6 What selectors cannot do, and what we do instead

| Wanted | Selector can? | Alternative |
|---|---|---|
| "any node anywhere with property P" | No — no unanchored search | Anchor on the kind and let `where` filter. Cost is one scan of that kind. |
| Transitive closure ("is this zone reachable from that one") | No — depth capped at 3 | Not supported. If it becomes necessary, it belongs in a derived-graph pass that materialises reachability as edges, evaluated once per sweep, and rules then traverse those edges in one hop. Designed, not built. |
| Aggregate across the whole workspace ("more than 8 tunnels use group2") | No | A `workspace.` constant computed by a small fixed set of engine-side aggregates. Deliberately not extensible by packs: an extensible aggregate is a whole-graph read on every keystroke. |
| Compare two arbitrary devices | Only via a declared edge | Correct. If two nodes are related, the schema should say so; a rule that reaches across an undeclared relationship is a rule that will break silently when the graph shape changes. |

---

## 5. Static read-set extraction

### 5.1 What it produces

```rust
#[derive(Clone, Default)]
pub struct ReadSet {
    /// (kind, field) pairs read on the anchor or on any binding.
    pub fields: SmallVec<[FieldRef; 12]>,
    /// Edge roles traversed, with direction. Drives adjacency invalidation.
    pub adjacency: SmallVec<[(EdgeRoleId, Direction); 4]>,
    /// Kinds whose *population* the rule depends on (see §5.3). Expensive.
    pub populations: BitSet<KindId>,
    /// Workspace constants read.
    pub workspace: BitSet<WsConstId>,
    /// Evidence classes (§8).
    pub evidence: EvidenceMask,
}
```

### 5.2 The algorithm

A single post-order walk of the type-checked AST plus the selector plan. Linear in program
size; runs once at pack compile time, not at evaluation time.

```
extract(rule):
    rs = ReadSet::default()
    rs.populations.insert(rule.selector.anchor)
    for each bind in selector.binds:
        for each hop in bind.hops:
            rs.adjacency.push((hop.role, hop.dir))
    walk(rule.selector.filter, base = Anchor, rs)
    walk(rule.condition,        base = Anchor, rs)
    walk(rule.discriminator,    base = Anchor, rs)
    return rs

walk(node, base, rs):
    match node:
        LoadField(b, f)  -> rs.fields.push(FieldRef{ kind: kind_of(b), field: f })
        Has(b, f) | KnownAbsent(b,f) | IsDefault(b,f) | IsKnown(b,f)
                         -> rs.fields.push(FieldRef{ kind: kind_of(b), field: f })
        LoadWs(w)        -> rs.workspace.insert(w)
        Comprehension(src, var, body)
                         -> walk(src, base, rs); walk(body, base = elem_kind(src), rs)
        _                -> for each child: walk(child, base, rs)
```

`kind_of(b)` is known statically because every binding's kind is fixed by the schema's edge
role declaration. There is no case in which a binding's kind is unknown — that is the
property §3.6 buys.

### 5.3 The dynamic case does not exist, by construction

`ReadSet` has no `dynamic: bool` flag. There is no expression in `fex` whose read-set
cannot be resolved statically, because:

- field names are literals in the grammar, never computed;
- bindings are declared in the selector, never computed;
- comprehension sources are always a `many` binding or a `filter` over one, so the element
  kind is known;
- there are no user functions, so there is no call graph.

The checker rejects anything else at pack build time. **This is the invariant the whole
incremental engine rests on.** If a future language extension would break it, the extension
does not ship. Write it on the wall.

### 5.4 Over-approximation and why it is bounded

The static read-set is an over-approximation: a rule that reads `peer.establish_tunnels`
only when `self.establish_tunnels` is passive still lists both. That is fine for the
*static* index, which is only used to find *newly applicable* rule instances (§6.4). Live
instances use exact recorded dependencies.

The pack lint gate measures over-approximation on fixtures: static read-set size must not
exceed 2× the maximum observed dynamic read-set across all fixtures (§15.3, gate 5). A rule
that binds six neighbours and reads one is a rule that will be re-evaluated six times more
often than it needs to be, forever.

---

## 6. The incremental evaluation model

### 6.1 Why not a general incremental framework

Salsa is the obvious candidate: demand-driven, memoised, used in rust-analyzer for exactly
this "recompute quickly as you type" shape. It is the right tool for a compiler, where the
derivation graph is deep — tokens → AST → name resolution → types → diagnostics, with each
layer feeding the next.

Our derivation graph is **one layer deep**. `finding = rule(anchor, bindings)`. There is no
intermediate derived value to memoise. A general framework's per-query bookkeeping —
revision counters, dependency vectors, cycle detection, the memo table itself — costs more
than the thing it is saving, and it costs it on every one of ~300,000 rule instances.

**DECISION — hand-rolled forward invalidation with exact recorded dependencies. Not salsa,
not a general memoiser.** We are re-implementing about 15% of what salsa does, in about 400
lines, for a workload whose shape we control completely.

The cost: we own correctness of invalidation, including the phantom-dependency case (§6.5),
which is the part everyone gets wrong. §6.6 states the correctness argument explicitly so
that it can be reviewed rather than assumed.

### 6.2 Graph deltas

Every mutation the UI or parser makes produces a delta. There is no path that mutates the
graph without one; the graph store's write API returns `Result<GraphDelta, _>`.

```rust
pub enum Change {
    NodeAdded   { node: NodeId, kind: KindId },
    NodeRemoved { node: NodeId, kind: KindId },
    FieldSet    { node: NodeId, kind: KindId, field: FieldId,
                  old: FieldStateTag, new: FieldStateTag },
    EdgeAdded   { role: EdgeRoleId, from: NodeId, to: NodeId },
    EdgeRemoved { role: EdgeRoleId, from: NodeId, to: NodeId },
    WorkspaceConst { id: WsConstId },
}

pub struct GraphDelta {
    pub changes: SmallVec<[Change; 8]>,
    pub epoch: Epoch,          // monotonic; findings carry the epoch they were computed at
}
```

`FieldStateTag` is the `FieldState` discriminant plus a value hash, not the value: a delta
should be small and cheap to compare, and the engine only needs to know *that* it changed.

### 6.3 Dependency keys

```rust
#[derive(Hash, PartialEq, Eq, Clone)]
pub enum DepKey {
    Field(NodeId, FieldId),
    NodeExists(NodeId),
    /// The *set* of neighbours of `node` along `role` in `dir`. Covers additions and
    /// removals, which a per-node key cannot (§6.5).
    Adjacency(NodeId, EdgeRoleId, Direction),
    /// All nodes of a kind. The escape hatch. Every add/remove of the kind invalidates.
    Population(KindId),
    Workspace(WsConstId),
    Evidence(EvidenceClass),
}
```

Two indexes:

```rust
/// Exact. Built at evaluation time. Maps a dependency to the live rule instances
/// that actually read it.
type ReadBy = HashMap<DepKey, SmallVec<[Instance; 4]>>;

/// Static. Built once at pack load. Maps a (kind, field) to rules whose read-set
/// mentions it. Used only to discover instances that do not exist yet.
type FieldIndex = HashMap<(KindId, FieldId), BitSet<RuleId>>;
type KindIndex  = HashMap<KindId,            BitSet<RuleId>>;

#[derive(Hash, PartialEq, Eq, Clone, Copy)]
pub struct Instance { pub rule: RuleId, pub anchor: NodeId }
```

### 6.4 The invalidation algorithm

```
on_delta(delta):
    dirty: HashSet<Instance> = {}
    new_anchors: Vec<(RuleId, NodeId)> = []

    for change in delta.changes:
        match change:
            FieldSet{node, kind, field, ..} ->
                dirty ∪= ReadBy[Field(node, field)]
                # a field going Unset -> Set can make a `where` filter newly true,
                # creating an instance that never existed and therefore has no ReadBy entry
                for rule in FieldIndex[(kind, field)]:
                    if rule.selector.anchor == kind and not live(rule, node):
                        new_anchors.push((rule, node))

            NodeAdded{node, kind} ->
                for rule in KindIndex[kind]: new_anchors.push((rule, node))
                dirty ∪= ReadBy[Population(kind)]

            NodeRemoved{node, kind} ->
                dirty ∪= ReadBy[NodeExists(node)]
                dirty ∪= ReadBy[Population(kind)]
                retire_instances_anchored_at(node)

            EdgeAdded{role, from, to} | EdgeRemoved{role, from, to} ->
                dirty ∪= ReadBy[Adjacency(from, role, Out)]
                dirty ∪= ReadBy[Adjacency(to,   role, In)]
                # a new edge can bring a `card: one` binding into existence
                new_anchors ∪= anchors_newly_bindable(role, from, to)

            WorkspaceConst{id} -> dirty ∪= ReadBy[Workspace(id)]

    for (rule, node) in new_anchors:
        if selector_filter_passes(rule, node): dirty.insert(Instance{rule, node})

    schedule(dirty)
```

`schedule` splits `dirty` into tiers (§7.2) and hands Tier B/C to the worker.

### 6.5 Phantom dependencies — the case that breaks naive implementations

`tunnel.st0.zone-unbound` fires because **no** `ZoneBinding` edge exists from `st0.0`. There
is no node and no field to hang a dependency on. If dependencies were only `Field(node,
field)`, adding the zone binding would never clear the finding, and the user would sit
looking at a stale red line having just fixed the thing.

This is why `Adjacency(node, role, dir)` keys the *set*, not its members. Binding `zone`
with `card: optional` registers `Adjacency(st0_0_id, zone_binding, Out)` whether or not the
neighbour exists. `EdgeAdded` invalidates that key. The finding clears.

The same reasoning gives `NodeExists` (for a `card: one` binding whose target is deleted)
and `Population` (for rules whose `where` filter can newly match a node that did not
exist).

**RECOMMENDATION — write the phantom-dependency test first.** For every relational rule,
the fixture suite must include a `must_fire` fixture and the *same* fixture with the
missing relationship added, asserting the finding clears. Gate 5b in §15.3. This is the bug
class that produces "the tool says it is broken but it isn't" reports, which cost more
trust than a missed finding.

### 6.6 Correctness argument for short-circuit dependencies

Concern: `a.pfs == null && peer.group == 14` short-circuits when the left operand is false.
The evaluation records a dependency on `a.pfs` but not on `peer.group`. If `peer.group`
changes later, we do not re-evaluate. Is the result stale?

No, and the argument is worth writing down because it is the one people distrust:

1. The recorded dependency set is exactly the set of reads performed.
2. The result is a pure function of the values read (§3: no side effects, no ambient state,
   no clock).
3. Therefore, if none of the recorded reads changed, re-evaluating would perform the same
   reads in the same order and produce the same result.
4. `peer.group` changing cannot alter the outcome while `a.pfs` is unchanged, because the
   short-circuit means the outcome did not depend on it.
5. If `a.pfs` does change, step 1 re-runs, the evaluation may now read `peer.group`, and the
   dependency is recorded then.

This holds only because of (2). It is the reason `fex` has no clock, no randomness, and no
mutable state — those are not stylistic choices, they are what makes incrementality sound.

### 6.7 Evaluation of one instance

```rust
pub fn evaluate(
    ctx: &mut EvalCtx,       // records DepKeys as they are read
    rule: &CompiledRule,
    anchor: NodeId,
) -> Outcome {
    if !rule.platforms.matches(ctx.platform_of(anchor))       { return Outcome::NotApplicable }
    match rule.versions.matches(ctx.version_of(anchor)) {
        Match::Yes         => {}
        Match::No          => return Outcome::NotApplicable,
        Match::Incomparable | Match::UnknownVersion
                           => return Outcome::Unprovable(Reason::VersionUnknown),
    }
    if !rule.requires.satisfied_by(ctx.evidence(anchor))      {
        return Outcome::Unprovable(Reason::MissingEvidence(rule.requires.first_unmet()))
    }
    let binds = match ctx.bind(&rule.selector, anchor) {
        Ok(b)  => b,
        Err(e) => return Outcome::EngineDiagnostic(e),   // card: one violated, etc.
    };
    if ctx.any_unset_in(&rule.read_set, &binds) {
        match rule.on_unset {
            OnUnset::Pending => return Outcome::Pending,
            OnUnset::Skip    => return Outcome::NotApplicable,
            OnUnset::Fire    => {}
        }
    }
    match ctx.run(&rule.condition, &binds, rule.step_budget) {
        Ok(Value::Bool(true))  => Outcome::Finding(ctx.materialise(rule, anchor, binds)),
        Ok(Value::Bool(false)) => Outcome::Clear,
        Ok(_)                  => unreachable!("checker guarantees bool"),
        Err(e)                 => Outcome::EngineDiagnostic(e),
    }
}
```

`Outcome::Clear` still writes the recorded dependencies. A rule that is not firing must
still be woken when the thing that keeps it quiet changes.

---

## 7. Latency budget and complexity

### 7.1 The target, and what it is for

Owner brief §6.2: findings raised inline *as you go*, not at the end. §6.1 sets the bar for
the finder at "faster than opening a browser tab". The equivalent bar for findings is:
**the panel must never be the reason you wait.**

| Path | Trigger | P95 budget | Where |
|---|---|---|---|
| **Tier A** — local | field commit on the focused node | **8 ms** | main thread, inside the frame that commits the edit |
| **Tier B** — propagated | remaining invalidated instances | **150 ms** | worker |
| **Tier C** — full sweep | pack load, workspace open, schema migration, suppression expiry rollover | **1.5 s** for 20,000 nodes | worker, chunked, cancellable |
| Pack load, warm (compiled cache) | | **25 ms** | worker |
| Pack load, cold (YAML) | | **250 ms** | worker |

<!-- VERIFY: every number in this table is a design target, not a measurement. They must be
replaced with measured P95s on a defined reference machine before this document moves from
Proposed to Accepted. The reference machine should be named in the perf doc. -->

8 ms is chosen as half a 60 Hz frame, leaving the other half for layout and paint. It is a
budget for the *engine*, not for the round trip.

### 7.2 Tiering rule

`dirty` is partitioned at schedule time:

- **Tier A** = instances whose anchor is the edited node, or is one hop from it. Bounded in
  practice: for a `LogicalUnit` in the IPsec domain, roughly 15–40 instances.
- **Tier B** = everything else in `dirty`.

The split is not a heuristic about importance — it is about *where the user is looking*.
The findings you are about to glance at are the ones on the node you just edited.

Tier B results stream in. A finding that arrives 120 ms late must render with the same
treatment as one that was already there: no flash, no reorder animation, no "new" badge for
findings that are simply late rather than new. Otherwise the panel twitches constantly and
people stop reading it.

### 7.3 Complexity

Let:
- `R` = rules in the active packs (target scale: 4,000)
- `N` = nodes in the graph (target scale: 20,000)
- `A(r)` = anchor set of rule `r` after the `where` filter
- `c(r)` = worst-case step count of `r`'s condition (bounded by its step budget)
- `b(r)` = number of selector bindings (≤ 6 by lint)

**Full sweep (Tier C):**

```
O( Σ_r ( |Kind(anchor(r))| · cost(filter_r) + |A(r)| · (b(r) + c(r)) ) )
```

The first term is why `where` filters must be cheap: they run over the whole kind
population. The second is the real work.

Concretely: rules are not uniformly distributed over kinds. In a pack modelled on the
field card, the `IpsecVpn`, `IkeGateway` and `IpsecPolicy` kinds carry most of the rules,
and a 20,000-node estate has perhaps 400 of those. A reasonable estimate for
`Σ_r |A(r)|` at that scale is **200,000–400,000 instance evaluations**, not `R · N`.

At an assumed 1–3 µs per evaluation (bind probes plus a few hundred VM steps) that is
**0.2–1.2 s**, which is why Tier C's budget is 1.5 s and why it is chunked and cancellable
rather than blocking.
<!-- VERIFY: the 1–3 µs per-evaluation figure is an estimate from the opcode count and
probe count, not a benchmark. Measure with a synthetic pack of 500 rules over a 20k-node
graph before committing to it. -->

**Incremental (Tier A + B):**

```
O( Σ_{k ∈ changed keys} |ReadBy[k]| · (b + c)  +  |new_anchors| · (filter + b + c) )
```

`|ReadBy[k]|` for a typical field is 2–20. A field edit therefore costs tens of
microseconds of evaluation. The 8 ms Tier A budget is not tight; it is deliberately loose,
because the cost that actually bites is not evaluation, it is the finding-set diff and the
re-render. Which is the next point.

### 7.4 The cost that actually bites

Re-running rules is cheap. Recomputing the panel is not. Three controls:

1. **Findings are diffed, not rebuilt.** Each evaluation produces `Outcome`s keyed by
   `Instance`; the store applies them as a patch. The panel receives an ordered patch
   (`insert at i`, `remove at i`, `update at i`), never a new array.
2. **The total order is precomputed as a sort key.** `(severity desc, confidence desc,
   category ordinal, rule_id, anchor ULID)` packs into a 24-byte key computed once at
   materialisation. Reordering after a patch is a binary search, not a re-sort.
3. **The panel is virtualised.** A 4,000-finding workspace renders 40 rows. Obvious, but it
   has to be stated because the finding *count* is what people quote and the count is
   computed from the store, not the DOM.

### 7.5 Memory

| Structure | Size estimate at N=20,000, ~300k live instances |
|---|---|
| `ReadBy` | ~8–15 dependency keys per instance × 300k instances = 2.4–4.5 M entries. At ~40 bytes amortised (key + smallvec slot): **100–180 MB**. Too much. |

That is a real problem and it needs a real answer, not a footnote.

**Mitigation — do not record dependencies for cleared instances outside the working set.**
An instance that evaluated to `Clear` and whose anchor is not in the recently-touched
working set stores a **32-bit fingerprint of its read values** instead of a dependency list.
On a coarse invalidation (any field of the anchor's kind changed anywhere in its subtree,
detected via a per-node version counter), such instances are re-evaluated in bulk; the
fingerprint tells us whether the outcome could have changed, and only mismatches produce
patches.

Revised estimate: exact dependencies for the working set (~5,000 instances → ~2 MB), plus
4 bytes × 300k fingerprints (~1.2 MB), plus per-node version counters. **Under 10 MB.**

Cost, honestly: bulk re-evaluation of cold instances is O(instances in that kind) rather
than O(instances that actually depend on the change). It runs in Tier B, off the frame
path, and the fingerprint check means it produces no patches when nothing changed. We are
trading worst-case CPU in the background for two orders of magnitude of memory. For a
browser-resident tool that is the right trade; for a native CLI doing a one-shot sweep the
whole structure is unnecessary anyway (§7.6).

### 7.6 The CLI is a different machine

The native CLI (`fathom lint config.set`) has no incrementality problem: one graph, one
sweep, exit. It uses the same compiled rules and the same evaluator with `ReadBy` disabled
entirely. Do not let the incremental machinery leak into the batch path — it is pure
overhead there, and keeping the batch path simple is what makes it usable as the CI gate in
§15.

---

## 8. Rules that need the far end

### 8.1 The problem

The field card's most valuable diagnostics are two-sided. `BOTH ENDS MUST AGREE — EVERY
VALUE, EXACTLY` is the governing line of side 2. But Fathom will usually hold one side.
Half of every interop rule is unverifiable most of the time.

Three wrong answers:

| Wrong answer | Why it is wrong |
|---|---|
| Do not write the rule | Throws away the highest-value content in the corpus. |
| Fire it anyway with a guess | A linter that guesses is a linter that is wrong, and being wrong once about a tunnel that "must" be broken is expensive. |
| Silently skip it | Produces a clean panel that is a lie. The user reads "no findings" as "checked and fine". |

### 8.2 Evidence classes

A rule declares what it needs:

```yaml
requires: [peer_config]
```

```rust
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum EvidenceClass {
    /// The far-end device's configuration is in the graph and linked by a `peer_*` edge.
    PeerConfig,
    /// Pasted output of a show command, parsed into the graph as observations.
    RuntimeOutput,
    /// The underlay path MTU, which cannot be derived from any config.
    PathMtu,
    /// The device's software version is recorded.
    SoftwareVersion,
    /// A named upstream/downstream device's config (e.g. the NAT device in path).
    TransitConfig,
}
pub type EvidenceMask = BitSet<EvidenceClass>;
```

`SoftwareVersion` as an evidence class is not bureaucracy. Field card side 2: `mode is
silently ignored under v2-only`. A rule about `mode` is wrong without knowing the version.

### 8.3 The `Unprovable` outcome

Unmet evidence produces `Outcome::Unprovable(Reason)`, which is **not a finding** and is
**not silence**. It is a third thing, with its own store, its own count, and its own
surface.

```rust
pub struct Unprovable {
    pub rule: RuleId,
    pub anchor: NodeId,
    pub reason: UnprovableReason,
    pub prompt: MessageKey,        // rule-authored, one sentence
    pub paste_target: Option<PasteTarget>,
}

pub enum UnprovableReason {
    MissingEvidence(EvidenceClass),
    VersionUnknown,
    VersionIncomparable { recorded: String },
    QuarantinedRule(QuarantineReason),   // §14
}

pub struct PasteTarget {
    /// Corpus id of the command whose output would satisfy this.
    pub command: Option<CommandId>,
    /// Which node the pasted material should attach to.
    pub attach_to: NodeId,
    pub evidence: EvidenceClass,
}
```

### 8.4 The UI contract

The findings panel's footer is not optional chrome. It is:

```
─────────────────────────────────────────────────────────
  14 checks need the far end          [ paste peer config ]
   3 checks need a software version    [ set version ]
   1 check needs live output           show security ipsec security-associations
─────────────────────────────────────────────────────────
```

Rules for this surface:

1. The count is always shown, even when zero findings exist. **"No findings" and "no
   findings, and 14 things I could not look at" must never render the same.**
2. Clicking a line opens the paste target with the exact command pre-filled, interpolated
   with workspace context per owner brief §6.1 ("Context awareness"). For
   `ipsec.traffic-selector.not-mirrored` that is `show configuration security ipsec |
   display set` addressed to the named peer.
3. Pasting peer config runs the normal parse path, creates a second `Device` node, and the
   reconciliation step (§11.4) offers to link it as `peer_vpn`. Nothing is auto-linked:
   guessing which of three tunnels a pasted config is the far end of is exactly the kind of
   inference that produces a confidently wrong finding.
4. The exported review report (§10.4) lists unprovables in full. A change ticket that says
   "Fathom found no issues" and omits "and could not evaluate 14 rules" is a ticket that
   misrepresents the tool.

### 8.5 One-sided approximations

Some two-sided rules have a weaker one-sided form. Field card side 4: *"Default selector is
0.0.0.0/0. With no traffic-selector configured the SRX proposes any-to-any. Peers that
build one SA per subnet pair reject it outright."* You can see the missing selector from
one side; whether the peer minds is a peer question.

Model as **two rules plus supersession**, not one rule with a fudge factor:

| Rule | `requires` | Severity | Confidence |
|---|---|---|---|
| `ipsec.traffic-selector.absent` | — | medium | definite |
| `ipsec.traffic-selector.not-mirrored` | `[peer_config]` | high | definite |

with `ipsec.traffic-selector.not-mirrored` declaring `supersedes:
[ipsec.traffic-selector.absent]`. When the peer arrives, the weaker rule's finding is
withheld and the stronger one takes over. The panel does not show both. This is the general
pattern: **more evidence produces a more specific finding that replaces the general one.**

---

## 9. Severity, confidence, category — and why none of them is `Risk`

### 9.1 The distinction, stated once

| Axis | Attaches to | Answers | Values | Rendered as |
|---|---|---|---|---|
| **`Risk`** (conventions, three values, fixed) | an **emitted line** | "what happens to a live box if I paste this" | `ReadOnly` / `ChangesConfig` / `Disruptive` | The three colour pairs from the field card legend. Nothing else, ever. |
| **Severity** | a **finding** | "how much does it matter that this is true" | `info` / `low` / `medium` / `high` | Neutrals; weight and a left rule. Per conventions, never the risk palette. |
| **Confidence** | a **finding** | "how sure is the rule that this is a real problem" | `definite` / `probable` / `heuristic` | Neutrals; a rule-weight treatment |
| **Category** | a **finding** | "what kind of problem is this" | `correctness` / `security` / `interop` / `operability` / `hygiene` | Text label, muted |

They are orthogonal and the orthogonality is load-bearing:

- `mtu.mss-clamp.absent` is **medium severity**, and its remediation
  (`set security flow tcp-mss ipsec-vpn mss 1360`) is **`ChangesConfig`**.
- `ipsec.pfs.group-mismatch` is **high severity**, and its remediation is
  **`Disruptive`** — changing the PFS group tears down every SA under that policy. High
  severity, and you still do not paste it at 14:00 on a Tuesday.
- `ike.traceoptions.left-enabled` is **low severity** (field card side 3: *"Traceoptions
  left on will fill `/var`"*), and its remediation is `ChangesConfig`.
- A finding whose only remediation is "go look at this show command" is **`ReadOnly`**
  regardless of severity.

**A UI that colours the finding by severity using the green/amber/red pair has told the
user that a high-severity finding is dangerous to fix. It is not. The danger is in the
line, not in the finding.** This is the single easiest mistake to make in this product and
it undermines the one visual convention the field card holds across all four sides.

### 9.2 The severity scale, and why there is no `critical`

Four values. Adding a fifth teaches people that `high` is not really high.

| Severity | Meaning | Example from the field card |
|---|---|---|
| `high` | The configuration will not work, or has a security property the owner would not accept if they knew. | Missing `host-inbound-traffic system-services ike` — *"Phase 1 times out with nothing useful in the log"* |
| `medium` | It works, but a foreseeable and common condition breaks it. | No MSS clamp — *"Ping works. SSH connects. Then `ls` hangs."* |
| `low` | It works and will keep working; this is a maintenance or clarity cost. | `proposal-set standard` instead of written-out proposals — *"you cannot see what it offered without the docs"* |
| `info` | An observation with no defect implied. | `establish-tunnels on-traffic` on an idle backup — *"an idle backup cycles in the log by design"* |

"This will not come up at all" is **not** a fifth severity. It is
`severity: high, confidence: definite, category: correctness`, and the panel groups
`correctness + definite + high` into a **"will not work"** band at the top. Same data,
better shape, no scale inflation.

**Pack lint enforces a severity budget: at most 15% of a pack's rules may be
`severity: high`.** This is arbitrary and defensible. Owner brief §5.2: *"Tools that flag
everything as critical are muted within a week."* A quota is a blunt instrument that makes
authors argue with each other about which rules earn the tier. That argument is the point.

### 9.3 Confidence

| Confidence | Meaning |
|---|---|
| `definite` | The rule reads a structural fact. `st0.0` is in no zone, or it is. |
| `probable` | The rule reads a fact plus an assumption that holds in nearly all deployments. "DPD `interval × threshold` = 50 s is too slow for a monitored backup" assumes you care about failover time. |
| `heuristic` | Pattern-matching. "Two SRXs at the same site with no cluster configuration look like a cluster candidate" (owner brief §6.4). Useful, and honestly labelled. |

Confidence is what lets §6.4's "facts that argue back" ship without the panel filling with
speculation. `heuristic` findings are collapsed by default into a single "3 suggestions"
line and never counted in the headline number.

### 9.4 Ordering

The panel's total order is:

```
(severity desc, confidence desc, category ordinal, rule_id asc, anchor ULID asc)
```

Fully determined, no ties broken by hash iteration order, identical on every machine.
Invariant 9. The category ordinal is fixed in the schema, not per-pack, so packs cannot
reorder each other's findings.

---

## 10. Findings: identity, lifecycle, data shape

### 10.1 Identity

```rust
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct FindingKey {
    pub rule: RuleId,
    /// The anchor's ULID. Authoritative while the node lives.
    pub anchor: NodeId,
    /// Stable across re-parse. Recovery path only — see §11.4.
    pub anchor_nk: NaturalKeyHash,
    /// Present only for rules that can fire more than once on one anchor.
    pub discriminator: Option<SmallStr>,
}
```

The discriminator is a rule-authored `fex` expression returning a string, evaluated in the
same environment as the condition. `ipsec.traffic-selector.not-mirrored` uses
`discriminator: "name"` so that three non-mirroring selectors on one VPN produce three
findings, each independently suppressible, each stable if a fourth is added.

Without a discriminator, a rule fires at most once per anchor and a second firing is a pack
lint error caught by the fixture suite.

### 10.2 States

```rust
pub enum FindingState {
    Active,
    Pending,                                   // §2.2: an unanswered question, not a defect
    Suppressed { by: SuppressionId },
    Superseded { by: RuleId },                 // §12.1
}
```

Plus the separate `Unprovable` store (§8.3), which is not a finding state because an
unprovable is not a finding — it has no anchor-specific verdict.

Lifecycle:

```
              ┌──────────── field settles, condition true ────────────┐
              │                                                        v
  (nothing) ──┴─> Pending ── all fields known ──> Active ──┬──> Clear (removed)
                     ^                              │       ├──> Suppressed
                     └──── field returns to Unset ──┘       └──> Superseded
```

A finding that goes `Active → Clear` is retained in the **session finding log** for the
change runbook (§6.7): "this change cleared `zone.host-inbound.ike-missing` on `WAN`" is
exactly what belongs in a change ticket. The log is per-session, not persisted, and is
cleared on workspace close.

### 10.3 Data shape

```rust
pub struct Finding {
    pub key: FindingKey,
    pub pack: PackId,
    pub rule_version: RuleVersion,
    pub anchor: NodeId,
    /// Every selector binding, so the UI can navigate and the remediation can interpolate.
    pub bindings: SmallVec<[(BindId, BoundRef); 4]>,
    pub severity: Severity,
    pub confidence: Confidence,
    pub category: Category,
    pub state: FindingState,
    /// The exact (node, field) values the condition read, captured at evaluation.
    /// This is what makes "why did this fire" answerable without re-running anything.
    pub witness: SmallVec<[(NodeId, FieldId, ValueRepr); 6]>,
    pub remediation: Option<RemediationInstance>,   // emitted lines with Risk, see §10.5
    pub sort_key: SortKey,                          // 24 bytes, precomputed
    pub epoch: Epoch,
}

pub enum BoundRef { One(NodeId), Many(Rc<[NodeId]>), Absent }
```

The **witness** is the difference between a finding you believe and one you argue with. The
panel's expanded state shows: the rule's `why`, then *"because `IPSEC-POL.perfect_forward_secrecy`
is absent (parsed from `srx-a.set`, line 47)"*. No re-evaluation, no guessing. It costs six
tuples per active finding.

### 10.4 Export

The review export is a deterministic document containing: workspace identity and content
hash, corpus and pack versions with content hashes, engine version, `workspace.as_of`, the
full ordered finding list with witnesses, the full suppression list with reasons and
expiries, and the full unprovable list. It is byte-identical for the same inputs
(invariant 9) so it can be committed and diffed.

Format: the same YAML dialect as the corpus, so it is readable in a change ticket without
tooling. Not JSON: this is a document a human reviews.

### 10.5 Remediation instances

Per invariant 6, remediation lines are produced by the **emitter**, not by string
interpolation in the rule, wherever the rule expresses its fix as a graph patch. See
`63-rulepack-spec.md` §7. The engine's job here is small and specific:

```rust
pub struct RemediationInstance {
    pub form: RemediationForm,
    pub lines: Vec<EmittedLine>,       // the owner brief's (line, provenance) pair type
    pub rollback: Option<Vec<EmittedLine>>,
    pub verify: Vec<CommandId>,        // corpus ids; interpolated with workspace context
    pub aggregate_risk: Risk,          // max over `lines`; drives the panel's action button
}
pub enum RemediationForm { Patch, Literal }
```

`aggregate_risk` is the maximum `Risk` over the emitted lines, ordered
`ReadOnly < ChangesConfig < Disruptive`. It is the only place the engine touches the risk
enum, and it does not compute risk — it takes it from the emitter.

---

## 11. Suppressions

### 11.1 The shape

```rust
pub struct Suppression {
    pub id: SuppressionId,
    pub scope: Scope,
    pub selector: RuleSelector,
    pub reason: String,
    pub author: String,          // free text, workspace-local, NOT authenticated (§11.6)
    pub created: Date,
    pub expires: Option<Date>,
    pub last_matched: Option<Date>,
    pub match_count: u32,
    pub review: ReviewState,
}

pub enum Scope {
    /// One finding. The narrow, correct default.
    Finding { anchor: NodeId, anchor_nk: NaturalKeyHash, discriminator: Option<SmallStr> },
    /// Every finding of this rule on this node.
    Node    { node: NodeId, node_nk: NaturalKeyHash },
    /// Every finding of this rule everywhere in the workspace.
    Workspace,
}

pub enum RuleSelector {
    Exact(RuleId),
    /// One glob, one level, within a declared domain: `ipsec.pfs.*`. Not `*`.
    Prefix(RuleIdPrefix),
}

pub enum ReviewState { Fresh, Acknowledged { by: String, on: Date }, Orphaned { since: Date } }
```

There is deliberately no `Kind` scope ("suppress this rule on all `IpsecVpn` nodes"). It
sits between `Node` and `Workspace` and in practice people reach for it to mean
`Workspace` while feeling like they were careful. Two scopes plus a rule prefix cover the
real cases.

### 11.2 Required reason

`reason` is mandatory, minimum 20 characters after trimming, and the field is empty by
default with no suggestions offered. Rejected values: whitespace-only, and a short blocklist
(`n/a`, `na`, `none`, `asdf`, `test`, `.`, `-`, `todo`, `x`).

**Honest limit:** validation cannot make someone write a good reason. Someone will type
"not applicable to us here ok" and pass. The blocklist buys nothing against a determined
user, and it is not meant to. The actual control is §11.5 — reasons are surfaced, counted
and exported. A bad reason is embarrassing in a review; a validator is just an obstacle.

### 11.3 Expiry

| Severity of the suppressed rule | Expiry |
|---|---|
| `high` | Mandatory. Default 90 days. Maximum 180. |
| `medium` | Mandatory. Default 90 days. Maximum 365. |
| `low`, `info` | Optional. Default none. |

On expiry the finding returns to `Active` and the suppression moves to `Orphaned`. It is
not auto-renewed and there is no "renew all" action. Renewing is per-suppression and
re-prompts for the reason with the old one shown — you have to look at it again.

**Trade-off:** this is friction, and friction on a security control gets routed around. The
routing-around move here is a `Workspace`-scoped suppression with a 365-day expiry on a
`medium` rule, which is legal and near-permanent. We accept that; the alternative is a tool
nobody can ship a change through. What we do not accept is invisibility (§11.5).

### 11.4 Surviving a re-parse

The hard one. Node IDs are ULIDs minted at node creation (conventions, *Identifiers*). Paste
`show configuration | display set` again and a naive implementation mints fresh ULIDs for
everything, and every suppression in the workspace breaks at once.

**Re-parse is a reconciliation, not a replace.**

```
reparse(new_config, existing_graph):
    candidate = parse(new_config)                  # fresh ULIDs, disconnected
    pairs     = match_by_natural_key(candidate, existing_graph)
    unmatched_new, unmatched_old = residue(pairs)
    plan      = ReconciliationPlan { pairs, unmatched_new, unmatched_old, renames_guessed }
    → present plan to the user as a diff; apply on confirmation
```

**Natural keys.** The schema declares, per kind, an `identity` tuple of fields:

| Kind | `identity` |
|---|---|
| `Device` | `hostname` |
| `Interface` | `device.nk`, `name` |
| `LogicalUnit` | `interface.nk`, `unit` |
| `Zone` | `device.nk`, `name` |
| `IkeGateway` | `device.nk`, `name` |
| `IpsecVpn` | `device.nk`, `name` |
| `TrafficSelector` | `vpn.nk`, `name` |

```
NaturalKeyHash = blake3_128( kind_name || 0x00 || canonical_join(identity_values) )
```

Canonicalisation: NFC, ASCII-lowercase for identifiers that vendors treat
case-insensitively (declared per field in the schema), no trimming beyond leading/trailing
whitespace.

**Matching applies ULIDs from the existing graph to matched candidates.** The existing
node's ULID survives; its fields are updated with new provenance. Suppressions bound to
that ULID never notice.

**When the key changes** (device renamed, VPN object renamed): the pair is unmatched.
Rename guessing uses a second pass — same kind, same parent, ≥80% field equality — and
produces a *suggestion* in the plan, never a silent re-bind. The user confirms. Provenance
records `renamed_from`.

**When a node genuinely disappears:** its suppressions become `Orphaned` and are retained.
They are not deleted, because the node may come back on the next paste (someone pasted a
partial config), and silently discarding a recorded waiver is worse than showing a stale
one. Orphans older than 180 days are offered for bulk deletion, never taken.

**The fallback path.** `Suppression.anchor_nk` exists for the case where reconciliation was
declined or a workspace was reconstructed from an export. On load, a suppression whose
`anchor` ULID is not present is re-bound to the unique node with a matching
`anchor_nk` — **and only if it is unique.** If two nodes share a natural key (two devices
with the same hostname, which happens), the suppression stays orphaned and says why. We do
not guess between two nodes.

**Costs, named:**

| Cost | Detail |
|---|---|
| Natural keys are names | Invariant 7 says rules and edges reference IDs, never names. This does not violate it: the graph itself contains no natural-key references. The key exists only in the reconciliation matcher and the suppression recovery path, and neither is a graph reference. This is the one place a name is load-bearing, and it is load-bearing precisely because the user's mental model is names. |
| Collisions | Two `Device` nodes named `srx-a` in different sites collide. Mitigated by including the parent chain in the key where the schema has one; `Device` does not, so `Device` collisions are possible and are surfaced, not resolved. |
| Churn | Renaming a VPN object breaks its key. That is correct behaviour — a renamed object is arguably a different object — but it means a suppression can need re-confirming after a rename. The reconciliation plan makes this one click, not a mystery. |

### 11.5 Making waivers visible

A suppression that nobody looks at is a finding that was deleted with extra steps.

| Surface | Content |
|---|---|
| Panel | A persistent `Suppressed (n)` band, collapsed, always present, never zero-suppressed away when n > 0. |
| Panel, expiring | `3 suppressions expire within 14 days` as a distinct line. |
| Review export (§10.4) | Every suppression in full: rule, scope, reason, author, dates, match count. |
| Change runbook (§6.7) | Any suppression covering a finding on a node touched by the diff. If you are changing the thing, you see the waiver on it. |
| Orphan sweep | Suppressions with `match_count == 0` after two full sweeps, or `last_matched` older than 180 days, marked `Orphaned` and listed. Either the config was fixed (delete it) or the rule stopped matching for a reason worth knowing. |

**RECOMMENDATION — the workspace's suppression list is the artifact a security reviewer
asks for.** Design the export around that reader, not around the person creating the
suppression.

### 11.6 What suppressions are not

`author` is free text stored in the workspace. It is **not** an authenticated identity.
Fathom has no accounts on the client (invariant 4: the server holds ciphertext only), so
there is no cryptographic basis for "who waived this". Anyone with the workspace passphrase
can write any name. Say so in the UI next to the field, once, quietly. Claiming an audit
trail we cannot back is worse than not having one — and the real audit trail is the git
history of the encrypted workspace, which is the team's, not ours.

---

## 12. Conflict, duplication, supersession

### 12.1 Supersession

```yaml
supersedes: [ipsec.pfs.group-weak]
```

If rule `A` supersedes `B`, and both would fire on the same anchor **with the same
discriminator**, `B`'s finding is set to `Superseded { by: A }` and hidden. It is not
deleted: the export lists it, because "we also would have told you X, but Y is the real
problem" is useful in a post-mortem.

Canonical example, straight from the card: `ipsec.pfs.absent` supersedes
`ipsec.pfs.group-weak`. There is no group to be weak if PFS is absent. Without supersession
the panel shows two findings for one missing line.

Rules:

- Supersession applies **only within the same anchor and discriminator**. Cross-anchor
  supersession is not expressible, because "the same thing" across two nodes is not
  well-defined.
- A rule may supersede rules in other packs, by id. This is how a stricter org pack
  replaces a first-party rule without forking it.
- The supersession relation must be a **DAG**. Cycles are a pack-lint error at build and a
  load-time error when the cycle spans packs (in which case the *lower-precedence* pack's
  edges are dropped and a diagnostic is raised, so a hostile pack cannot disable
  everything by declaring a cycle).

### 12.2 Ordering

Within one anchor:

1. Topologically sort the applicable rules by the supersession DAG (superseding rules
   first).
2. Break ties by `rule_id` lexicographic order.
3. Evaluate in that order; a rule that fires marks its superseded set.

Deterministic and independent of pack load order. Cost: a topological sort per anchor kind,
computed once at pack load and cached as a per-kind rule ordering vector.

### 12.3 `requires_finding` — conditional rules

```yaml
requires_finding: [ike.gateway.nat-detected]
```

Fire only if another rule already fired. Used for rules that only make sense in a context
another rule establishes: *"the NAT device's UDP idle timer is shorter than the keepalive"*
only matters if NAT-T is in path.

Constraints:
- The referenced rule must fire on the **same anchor or on a declared binding**, not
  anywhere in the graph.
- `requires_finding` and `supersedes` edges share one DAG and one acyclicity check.
- Adds a second evaluation pass over the anchor's rule list. Bounded by the DAG depth,
  which lint caps at 3.

**Cost, honestly:** this is the mechanism most likely to be abused into a rule dependency
tree that nobody can reason about. Lint caps depth at 3 and requires a `why_chained`
comment on every use, which is not a technical control — it is a review speed bump.

### 12.4 `next_if_bad` — navigation, not logic

Borrowed from the command corpus schema (owner brief §6.1). It has **no effect on
evaluation**. It is the "if this, then that" ladder, rendered as links in the expanded
finding and folded into the generated verification runbook. Field card side 1's Bring-Up
Order and side 3's Verify Ladder are exactly this structure, already authored.

Keeping it inert is deliberate: the moment `next_if_bad` affects whether something fires,
it becomes a dependency, and the ordering guarantees in §12.2 get harder for no benefit.

### 12.5 Duplicate detection at build time

Two rules with the same anchor kind and equivalent conditions are a build error.
Equivalence is decided by a cheap normal form, not a solver:

1. Type-check and constant-fold.
2. Canonicalise commutative operands by a stable hash order (`a && b` ≡ `b && a`).
3. Normalise `!(a == b)` → `a != b`, `!(a < b)` → `a >= b`, and De Morgan to a canonical
   polarity.
4. Compare the resulting bytecode after renumbering constants.

**This catches copy-paste, which is the case that actually happens. It does not catch
semantic equivalence** — `dh_group in [2, 5]` and `dh_group == 2 || dh_group == 5` normalise
differently and both will ship. We are not going to pretend otherwise, and we are not going
to put an SMT solver in the build to catch a class of duplication that a reviewer catches
for free.

### 12.6 Rule id collisions across packs

Two packs defining the same rule id: the higher-precedence pack wins, the shadowed rule is
listed in a `Shadowed rules (n)` diagnostic, and both pack ids are named. Precedence:

```
workspace-local overrides  >  org packs (in the order the workspace declares)  >  first-party
```

**Only presentation may be overridden under someone else's rule id.** An `overrides`
document may change `severity`, `confidence`, `enabled`, `acceptable_when` and message
strings. It may **not** change `condition`, `applies_to`, `requires` or `platforms`.
Changing logic requires a new rule id.

The reason is trust, not purity: if `ipsec.pfs.absent` can mean different things in two
workspaces, then a finding id in a change ticket means nothing, cross-team comparison means
nothing, and a fixture suite proves nothing.

---

## 13. Rule pack distribution

### 13.1 The artifact

A pack is authored as a directory (`63-rulepack-spec.md` §2) and distributed as a single
`.fpack` file.

| Property | Choice | Reason |
|---|---|---|
| Container | tar, entries sorted by path, all timestamps zero, uid/gid zero, mode normalised to 0644/0755 | Reproducible builds. The same source tree must produce the same bytes on any machine, or the published hash is meaningless. |
| Compression | zstd, level 19, no dictionary | Deterministic output for a fixed level and version. <!-- VERIFY: confirm zstd output is byte-stable across the versions we would ship; if not, pin the exact zstd version in the build and record it in the manifest. --> |
| Uncompressed cap | 64 MiB | Decompression bomb guard. Enforced by a counting reader, not by trusting the header. |
| Entry cap | 5,000 files | Same. |
| Path rules | Relative only; no `..`, no absolute, no symlinks, no device files, NFC-normalised, rejected if two entries normalise to the same path | Zip-slip and case-collision classes. |

### 13.2 Signing

**Ed25519 detached signature, minisign-compatible format.**

```
fathom.ipsec-2.4.1.fpack
fathom.ipsec-2.4.1.fpack.minisig
```

Why minisign format specifically: a user can verify our pack with `minisign -Vm
fathom.ipsec-2.4.1.fpack -P <key>` without running Fathom. For a product whose claim is
"you do not have to trust us", the ability to check our work with someone else's tool is
worth more than a bespoke format. The trusted comment carries `pack id`, `version` and the
BLAKE3-256 content hash, and is covered by minisign's second global signature — so the
metadata is signed, not decorative.

The signature covers the `.fpack` bytes. The manifest inside separately records the
BLAKE3-256 of the canonicalised rule tree, so a pack can be verified end-to-end after
extraction.

### 13.3 Trust

```rust
pub struct TrustedKey {
    pub key: Ed25519PublicKey,
    pub label: String,               // user-supplied, shown everywhere the key is
    pub added: Date,
    /// Which pack ids this key may sign. Reverse-DNS prefixes.
    pub scope: Vec<PackIdPrefix>,    // e.g. ["acme.internal.*"]
    pub source: KeySource,
}
pub enum KeySource { BuiltIn, ImportedByUser { fingerprint_confirmed: bool } }
```

- The first-party key is compiled into the binary. Not fetched, not configurable, not
  overridable — replacing it requires a new build, which is the point.
- **No trust-on-first-use.** Installing a pack signed by an unknown key fails. Adding a key
  is a separate, deliberate action requiring the full public key and a typed confirmation of
  its fingerprint.
- Scopes are enforced: a key scoped to `acme.internal.*` cannot sign `fathom.ipsec`. This
  stops an internal key compromise from shadowing first-party rules (§12.6).

**Cost:** an internal team publishing their own pack has to distribute a key and get every
engineer to import it once. That is real friction and some teams will not do it. The
mitigation is that an org can build its own binary with its key baked in (the build is
reproducible, §7.7 of the owner brief), which is the correct answer for anyone who cares
enough to have their own pack.

### 13.4 Versioning

| Field | Form | Notes |
|---|---|---|
| `pack.id` | reverse-DNS, `[a-z0-9.-]+` | `fathom.ipsec`, `acme.internal.baseline` |
| `pack.version` | semver | Content hash published alongside (conventions, *Identifiers*) |
| `pack.schema_range` | `vers:` range over the graph schema version | e.g. `vers:fathom/>=3.0.0\|<4.0.0` |
| `pack.min_engine` / `max_engine` | semver | The `fex` language version and builtin table version, not the app version |

Semver for a rule pack means:

| Change | Bump |
|---|---|
| New rule | minor |
| Rule severity raised, or condition broadened so it fires more | **major** |
| Rule severity lowered, or condition narrowed so it fires less | minor |
| Explainer, `acceptable_when`, `sources`, translations | patch |
| Rule withdrawn (`status: withdrawn`) | **major** |
| Rule id removed entirely | **forbidden** — ids are stable forever (conventions). Withdraw, do not delete. |

Raising a severity is a major bump because it can break someone's CI gate. That is the
correct definition of breaking for this artifact.

### 13.5 Offline install

The entire path is local. No network, ever, in either build (invariant 1).

```
1. User drops  pack.fpack  and  pack.fpack.minisig  onto the workspace.
2. Verify signature against the trust store.       fail → reject, name the key id
3. Check the key's scope covers pack.id.           fail → reject, name the scope
4. Extract with the caps in §13.1.                 fail → reject, name the cap
5. Verify manifest content hash over the tree.     fail → reject
6. Check schema_range against the live schema.     fail → §14
7. Check min_engine/max_engine.                    fail → reject, name the versions
8. Compile every rule (parse, type-check, read-set).
      per-rule failure → quarantine that rule (§14.3), continue
9. Check rule id collisions against installed packs (§12.6).
10. Check supersession DAG acyclicity across all installed packs.
11. Stage. Show a summary: n rules, n quarantined, n shadowed, n severity-high.
12. Activate on confirmation. Full sweep (Tier C).
```

Step 11 is not a formality. A pack that quarantines 400 rules on install should not
activate silently and leave the user believing they are covered.

### 13.6 The compiled cache

Opening a workspace must not re-parse 4,000 YAML documents. After step 8, the compiled
image is written to local storage:

```
key   = blake3(pack_content_hash || engine_version || schema_version)
value = flat, zero-copy-loadable image: interned strings, bytecode arena,
        selector plans, read-sets, message key table
```

The cache is **derived data with no security value**. It is keyed by the hash of
already-verified content; a mismatch means recompile, not a warning. It is never the source
of truth for whether a pack was signed — that is re-checked from the stored `.fpack` and
signature on every activation. If the cache is corrupted or tampered with, the worst case is
a hash mismatch and a 250 ms recompile.

### 13.7 Revocation, honestly

**Offline revocation is not solvable and we are not going to pretend it is.**

| Available control | What it buys | What it does not |
|---|---|---|
| `pack.expires` (default: build date + 400 days) | Past the date, the app shows a persistent warning and the pack's findings are labelled as stale. It does not disable them — silently disabling security rules is worse. | Nothing for a pack that is still in date. |
| Revocation list shipped with each app release | An app that updates learns about a bad key or a bad pack version. | Nothing for an air-gapped install that never updates. |
| Key scoping (§13.3) | Bounds the blast radius of a compromised key to its pack namespace. | Does not undo a pack already installed. |

**Residual risk, accepted and documented:** an air-gapped Fathom install with a compromised
third-party pack key can be fed bad rules indefinitely. The consequence is bounded by what a
rule can do — produce a wrong finding or a wrong remediation line. It cannot exfiltrate,
cannot execute, cannot read outside its selector. That bound is the mitigation, and it is
why §3's decision is worth its cost.

---

## 14. When a pack and the schema disagree

The graph schema evolves. Packs are authored against a schema version. They will diverge,
and the divergence must be **loud, partial and enumerable** — never a silent stop.

### 14.1 The cases

| Case | Detected at | Behaviour |
|---|---|---|
| Rule references a `kind` that does not exist | compile (step 8) | Quarantine the rule. |
| Rule references a field that does not exist on that kind | compile | Quarantine the rule. |
| Field exists, type changed (`Int` → `Enum`) | compile, by the type checker | Quarantine the rule. |
| Field exists, enum gained a variant the rule does not mention | compile | **Allow.** Additive. But lint warns if the rule uses `enum_is` in a way that is now non-exhaustive. |
| Schema is newer and only added kinds/fields/variants | load (step 6) | **Allow.** Additive changes are backward compatible; `schema_range` upper bounds should be generous. |
| Schema is newer with a removed or retyped field | load | The `schema_range` check fails and the pack does not install. |
| Schema is older than `schema_range` requires | load | Pack does not install. Message names both versions and the app version that would carry the schema. |
| Edge role renamed | compile | Quarantine. Schema migrations must provide a role alias table for one major version to avoid mass quarantine. |

### 14.2 Additive is the contract

**RECOMMENDATION — the schema commits to additive-only change within a major version.**
Adding kinds, fields and enum variants is free. Removing or retyping is a major bump and
takes every pack with it. This is the same contract protobuf makes and for the same reason:
the content outlives the code.

### 14.3 Quarantine

```rust
pub struct QuarantinedRule {
    pub rule: RuleId,
    pub pack: PackId,
    pub reason: QuarantineReason,
    pub detail: String,          // "field IpsecPolicy.pfs_group not in schema 3.2.0"
    pub since: Date,
}
pub enum QuarantineReason {
    UnknownKind, UnknownField, TypeMismatch, UnknownEdgeRole,
    UnknownBuiltin, BudgetExceededAtRuntime, EvaluationError, SupersessionCycle,
}
```

Surfacing:

- Pack install summary (§13.5 step 11) shows the count and lets you read the list.
- The findings panel footer includes quarantined rules in the "could not evaluate" band
  (§8.4) with reason `QuarantinedRule`.
- The review export lists them in full.

A quarantined rule is a rule that is not protecting you. It gets exactly the same visibility
as a rule that could not run for lack of the far end, because from the user's position they
are the same fact: **something you thought was being looked at, is not.**

`BudgetExceededAtRuntime` and `EvaluationError` are runtime quarantines: a rule that blows
its step budget or overflows an integer on a real graph is disabled for the session and
reported. It does not get to blow the budget 300,000 times in a sweep.

---

## 15. Testing and the CI gate

### 15.1 The principle

**Every rule ships with fixtures that must fire and fixtures that must pass.** No rule
enters a pack without both. This is not a coverage target; it is an admission gate, and CI
fails the build, not a report.

The reason is specific to this product: a rule that never fires is invisible. Nothing in
production tells you. Without a `must_fire` fixture, a rule whose condition has a type error
that the checker happened not to catch, or whose selector binds a role that is never
populated in practice, ships and does nothing, forever.

### 15.2 Fixture format

Fixtures live beside the rule (`63-rulepack-spec.md` §2). Two input forms:

```yaml
# rules/ipsec.pfs.absent/fixtures/fire-cbc-no-pfs.yaml
fixture: must_fire
rule: ipsec.pfs.absent
platform: junos-srx
version: "21.4R3-S5.4"
input:
  form: set_config              # preferred: exercises the parser too
  text: |
    set security ipsec proposal IPSEC-P2 protocol esp
    set security ipsec proposal IPSEC-P2 encryption-algorithm aes-256-cbc
    set security ipsec proposal IPSEC-P2 authentication-algorithm sha-256
    set security ipsec proposal IPSEC-P2 lifetime-seconds 3600
    set security ipsec policy IPSEC-POL proposals IPSEC-P2
    set security ipsec vpn VPN-B ike ipsec-policy IPSEC-POL
expect:
  - rule: ipsec.pfs.absent
    anchor: { kind: IpsecPolicy, identity: ["srx-a", "IPSEC-POL"] }
    severity: high
    witness_contains: { field: perfect_forward_secrecy, state: Absent }
    remediation_emits_contains: "perfect-forward-secrecy keys group14"
```

```yaml
# rules/ipsec.pfs.absent/fixtures/pass-pfs-group14.yaml
fixture: must_pass
rule: ipsec.pfs.absent
platform: junos-srx
version: "21.4R3-S5.4"
input:
  form: graph                   # explicit nodes; use when the parser is not the point
  nodes:
    - kind: IpsecPolicy
      identity: ["srx-a", "IPSEC-POL"]
      fields:
        perfect_forward_secrecy: { state: Set, value: group14 }
expect_absent: [ipsec.pfs.absent]
```

`form: set_config` is preferred and lint warns when a rule has only `form: graph` fixtures.
The card is written in `set` syntax; the fixtures should be too, and they then double as
parser tests.

### 15.3 The CI gates

Each is a hard failure.

| # | Gate | Rationale |
|---|---|---|
| 1 | Every `status: active` rule has ≥1 `must_fire` and ≥1 `must_pass` fixture | §15.1 |
| 2 | **Remediation round-trip.** For every `must_fire` fixture: apply the rule's own remediation to the graph (via the patch, or by re-parsing the emitted lines), re-run, assert the rule no longer fires *and* no new finding from the same pack appeared. | Proves the remediation actually fixes the thing. Cheap only because we own both directions — this is the payoff of `intent ⇄ config` (owner brief §3.5). |
| 3 | **Golden clean.** One curated, correct configuration per platform must produce **zero** findings from the whole pack. A new rule that fires on it fails the build; the PR must either fix the rule or amend the golden config with a stated reason. | The single best defence against the "flags everything" failure. |
| 4 | **Determinism.** Run the whole fixture corpus twice with node insertion order shuffled by a seeded permutation. Findings, order, witnesses and export bytes must be identical. | Invariant 9, enforced rather than hoped for. |
| 5a | **Read-set soundness.** Instrumented evaluator records actual reads; assert `actual ⊆ static` on every fixture. | An unsound read-set is silent staleness (§5.3). |
| 5b | **Phantom-dependency.** For every rule whose selector has an `optional` or `many` binding, a fixture pair: one where the relationship is absent (fires) and one where it was added by a delta (clears). The clear must arrive via incremental invalidation, not a full sweep. | §6.5. This is the bug class that produces stale red. |
| 6 | **Read-set tightness.** `\|static\| ≤ 2 × max(\|actual\|)` across fixtures. | Over-broad selectors destroy incrementality (§5.4). |
| 7 | **Step budget.** No evaluation exceeds 2,000 VM steps on any fixture; no `where` filter exceeds 50. | §7.3's complexity bound is only real if `c(r)` is bounded. |
| 8 | `acceptable_when` non-empty on every rule | Invariant 8. |
| 9 | `sources` present, or `sources: []` **with** a `sources_note` explaining why (e.g. observed vendor behaviour with no public citation). Every citation matches a syntactic form check (RFC number + section, or a vendor doc id). | Conventions: never fabricate a reference. The note forces the author to admit when there isn't one. |
| 10 | All three explainer depths present; length bounds respected; banned-phrase list clean; `reviewed_by` set to a named human | Invariant 10, and the design language's voice rules made enforceable. |
| 11 | Severity budget: ≤15% of active rules are `severity: high` | §9.2. |
| 12 | Every user-visible string resolves in `i18n/en.yaml`; no bare strings in rule files after extraction | `63-rulepack-spec.md` §9. |
| 13 | Supersession + `requires_finding` DAG acyclic, depth ≤ 3 | §12.1, §12.3. |
| 14 | Every `next_if_bad` / `related` reference resolves within the pack, or is explicitly marked `external: true` | Dangling links in a verify ladder are worse than no ladder. |

### 15.4 The snapshot corpus

Separate from fixtures: ~30 anonymised, realistic configurations, each stored with the
complete finding set as a checked-in snapshot.

- Any pack change that alters the snapshot must include the regenerated snapshot in the
  same commit. The diff *is* the blast-radius review.
- Two tracked metrics, reported on every PR: **findings per node** and **high-severity
  findings per config**. A PR raising either by more than 10% requires a justification line
  in the body. Not a gate — a number the reviewer sees.

This is how you notice that lowering one `where` filter's specificity added 400 findings
across the estate, before it ships.

### 15.5 Engine tests, separate from pack tests

| Suite | What it covers |
|---|---|
| `fex` conformance | ~400 expression cases: grammar, precedence, type errors, overflow, comprehension semantics, `has`/`known_absent` on all four field states |
| Read-set extraction | Property test: for a generated random `fex` program, instrumented evaluation reads ⊆ extracted read-set. Run under `proptest` with a shrinking corpus. |
| Incremental equivalence | **The important one.** Property test: generate a random graph and a random delta sequence; assert that the incrementally maintained finding set equals a full sweep after every delta. Any divergence is a stale-finding bug, and this is the only way to find them systematically. |
| Reconciliation | Re-parse of a mutated config preserves ULIDs for unchanged nodes; suppressions survive; renames are proposed, not applied. |
| Pack loading | Every rejection path in §13.5 has a test with a crafted bad pack: bad signature, wrong key scope, path traversal, decompression bomb, hash mismatch, cycle across packs. |

---

## 16. Failure modes of the engine itself

Stated in the register the field card uses: what breaks, what it looks like, what you do.

| Failure | What the user sees | Cause | Response |
|---|---|---|---|
| **Stale finding** | A finding that will not clear after the config is fixed | Missing phantom dependency (§6.5); a binding registered as a node key instead of an adjacency key | Gate 5b. In the field, the panel has a manual "re-sweep" that runs Tier C — and if that clears it, it is an engine bug and the app says so rather than pretending. |
| **Flicker while typing** | Findings appearing and vanishing per keystroke | A field committing before it settles (§2.3) | Settling gate; the per-keystroke finding-mutation counter is a debug metric. |
| **Selector explosion** | The whole app janks when you add a device | A rule anchored on a high-population kind with an expensive `where`, or a `many` binding over a large set | Gate 6 and 7; Tier C chunking bounds the damage to slow, not frozen. |
| **Rule that fires on everything** | Panel with 3,000 findings, user disables the pack | An over-broad condition that passed review | Gate 3 (golden clean) and §15.4's metrics catch it pre-release. Post-release: **we cannot detect it.** See below. |
| **We cannot detect a bad rule in the field** | — | Invariant 1 forbids telemetry. We have no idea which rules are being suppressed en masse. | Ship a local **"most-suppressed rules"** view in the workspace and make it one click to produce a report the user can choose to send. The user's choice, never automatic. Accepted permanent limitation of the no-egress posture, and it is the right trade. |
| **Natural key collision** | Two suppressions bind to the wrong node after re-parse | Two `Device` nodes with the same hostname | Never auto-bind on a non-unique key (§11.4). Stay orphaned and say why. |
| **Quarantine cascade** | 400 rules disabled after an app update | Schema removed or retyped a field | §14.2's additive-only contract, plus an edge-role alias table for one major version. If it happens anyway, the install summary makes it visible rather than silent. |
| **Suppression storm** | A workspace where most findings are waived | Legitimate for some estates; also the shape of a team that gave up | §11.5's surfaces make it visible in review. There is no technical fix and we should not invent one. |
| **Pack shadowing confusion** | A rule behaves differently than its documentation says | Two packs define the same id (§12.6) | Shadowed-rule diagnostic names both packs; `overrides` cannot change logic. |
| **Budget exceeded mid-sweep** | A rule silently stops working | Pathological input (a 10,000-element `many` binding) | Runtime quarantine, reported (§14.3). Never silent. |

---

## 17. Open decisions

| # | Decision | Options | Leaning |
|---|---|---|---|
| D-1 | Do rule packs get a compiled distribution form (ship `.fpc`, not YAML)? | (a) YAML only, compile on install — reviewable, slower install. (b) Ship both, verify the compiled form against the YAML hash. | (a). The reviewability of a signed YAML tree is worth 250 ms. |
| D-2 | Should `workspace.strictness` exist as a global dial that shifts severities? | (a) Yes, three presets. (b) No — use `overrides` documents. | (b). A global dial is a suppression with no reason and no record. |
| D-3 | Derived-graph passes (materialised reachability edges) for deeper traversal (§4.6) | (a) Never. (b) Engine-defined only. (c) Pack-defined. | (b) if needed. (c) reintroduces unbounded computation from untrusted content. |
| D-4 | Do we expose `fex` to users for ad-hoc queries over their own graph? | (a) No. (b) Yes, read-only, in a query bar. | (b) is attractive and cheap — the language and indexes already exist — but it needs its own budget story since a user query has no fixtures. Defer. |
| D-5 | Session finding log persistence | (a) Session only. (b) Persist into the workspace for change history. | (b) is better for §6.7 runbooks but grows the encrypted document unboundedly. Needs a retention policy first. |
| D-6 | Per-rule `enabled` in the workspace, separate from suppression | (a) No — disabling a rule is a workspace-scoped suppression and needs a reason. (b) Yes. | (a). One mechanism, one audit surface. |

---

## 18. Disagreements

None with `conventions.md`. Two notes that are not disagreements but are worth recording so
a reviewer does not read them as violations:

**(a) Natural keys and invariant 7.** Invariant 7 requires that rules, explainers, emitters
and diagram elements reference stable opaque IDs, never paths or names. This document
introduces a name-derived `NaturalKeyHash`. It is used in exactly two places: the re-parse
reconciliation matcher, and the suppression recovery path when a ULID is gone. Neither is a
graph reference, no engine subsystem resolves a node by natural key during evaluation, and
the recovery path refuses to act on a non-unique key. See §11.4.

**(b) Three-valued enums.** This document introduces `Confidence` with three values
(`definite` / `probable` / `heuristic`). Conventions reserve the three risk colours
exclusively for `Risk`. `Confidence` is rendered in neutrals with a weight and rule
treatment, as required for finding severity, and must never be given a colour. Recorded
here so the collision is deliberate and visible rather than discovered in design review.
