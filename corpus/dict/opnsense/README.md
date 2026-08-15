# corpus/dict/opnsense — the firewall-rules CSV

> **Status:** Accepted, 2026-08-15. Owns the reasoning behind
> `firewall-rules.yaml`; `docs/60-content/64-platform-capture-survey.md` §1.1 owns the
> capture path and its sources.

## 0. Contents

| § | | margin tab |
|---|---|---|
| 1 | Why the reasoning is here and not in the YAML | *read this first* |
| 2 | The path shape | *not a command path* |
| 3 | What is bound | *four columns and two literals* |
| 4 | What is deliberately absent, and why | *the empty-struct finding* |
| 5 | The vendor facts, with sources and dates | *ADR-0034* |
| | Failure modes | |
| | Open decisions | |
| | Sources consulted | |

---

## 1. Why the reasoning is here and not in the YAML

**A comment in a dictionary file is a shipped byte.** `fathom_ingest::dict` reaches the
corpus two ways: `Dictionary::load_platform` reads it off disk, and
`EMBEDDED_DICT_SOURCES_OPNSENSE` pulls it in with `include_str!` so the WebAssembly build
can parse without a filesystem. `include_str!` embeds the file **verbatim** — every comment
character lands in the module and is counted against `44` §5.2's 900 000-byte ceiling.

That was measured rather than assumed. The first draft of `firewall-rules.yaml` carried its
whole argument in `#` comments and was 9 154 bytes; moving the prose into this file and
leaving pointers behind took it to the size checked in beside this README. The saving is
module bytes at the ceiling, in exchange for artifact bytes in a budget with room.

The rule this establishes, which applies to `corpus/dict/junos-srx/` too and is worth
raising against it: **prose belongs beside a compiled-in corpus file, not inside it.** House
style is unchanged — the reasoning is still written down, still reviewable, still next to
the thing it explains. It is simply not paying rent in the artifact.

## 2. The path shape — it is not a command path

`fathom-ingest` was written around a `set`-form line grammar where a statement's path is the
words on the line. A CSV row has no words. `crates/fathom-ingest/src/csv.rs` synthesises one
statement per **cell**, with the path

```
[ <the row's @uuid>, <the column's header name>, <the cell's value> ]
```

and all three segments are **real bytes of the operator's file** — the uuid and the value
from the data row, the column name from the header row, which every record beneath it
shares. That is what lets the redaction gate, the binder, the deferred-edge resolver, the
line ledger and the residue list run over a table completely unmodified. What is synthesised
is the *arrangement*, never the text.

So in `firewall-rules.yaml`, `$rule` is a uuid, the literal middle segment is a column name,
and `$v` is that column's cell. A column with no entry binds nothing and its cell is named
on the residue list at its own byte span.

## 3. What is bound

| Column | Field | Note |
|---|---|---|
| `@uuid` | `SecurityPolicy.name` | Asserted by **every** entry, on purpose — see below |
| `action` | `SecurityPolicy.action` | Through the `PolicyAction` token map |
| `enabled` | `SecurityPolicy.enabled` | `1`/`0`; the most important column in the file |
| `sequence` | `SecurityPolicy.ordinal` | Gaps are legal, which is what a `sequence` is |
| `description` | `SecurityPolicy.description` | Free text |
| `source_net` = `any` | `SecurityPolicy.match_any_source` | A **literal** terminal, not a capture |
| `destination_net` = `any` | `SecurityPolicy.match_any_destination` | Likewise |

**Why every entry re-asserts `name`.** `SecurityPolicy.name` has cardinality 1, and a row
where only one column happens to be understood must still produce a named rule. WO-03 §4.8's
upsert law makes the repeat idempotent — equal values merge without a diagnostic — so the
cost is nothing and the guarantee is total.

**Why the uuid is the name.** OPNsense rules have no other stable one. Issue #9579, the
request this export exists to answer, says so in the vendor's words: the import merges rules
"back into the configuration using their unique IDs (`uuid`)". A `description` is free text
and is often empty.

**Why the two `any` entries end in a literal.** `SecurityPolicy.match_any_source`'s own
schema doc reads *"Set(true) means the vendor's any keyword — distinct from an
everything-set."* The exporter emits the literal string `any` for exactly that case and an
address or network otherwise. A cell naming a real network matches no entry — the terminal
here is a literal, not a capture — and lands on the residue list with its own bytes.

**Why the `PolicySet` is fieldless.** `HasPolicy` runs from `PolicySet` to `SecurityPolicy`
and the weld refuses to invent a containment parent, so a set has to exist. It asserts
nothing, and both omissions are honest rather than lazy:

- `PolicySet.scope` (card 1) is typed `PolicyScope`, an **empty struct** (§4).
- `PolicySet.evaluation` (card 1) offers `first_match` and `first_match_global`. **OPNsense
  is neither.** Its manual, checked 2026-08-15: *"When set to quick, the rule is handled on
  'first match' basis… When `quick` is not set, last match wins."* A pf ruleset is
  last-match-wins per rule unless that rule says otherwise, and the schema has no token for
  it. Writing `first_match` would assert something false about the operator's firewall.

`70` §16 ratified exactly this shape of answer: an incomplete path is drawn and **marked**,
never refused.

## 4. What is deliberately absent, and why — the empty-struct finding

A firewall rule's matches — source network, destination network, ports, protocol, interface,
direction — have nowhere to go. The IR types that exist for exactly them are **empty
structs**, each carrying the comment *"Shape stated nowhere read"*, in
`crates/fathom-ir/src/value.rs`:

| Type | Line | Blocks |
|---|---|---|
| `PolicyScope` | 189 | `PolicySet.scope` (card 1) — interface, direction, zone pair |
| `AddressValue` | 193 | `AddressObject.value` (card 1) — **no address object can be built at all** |
| `L4Spec` | 197 | `Application.l4` — protocol and ports |
| `NatScope` | 202 | `NatRuleSet.from`/`.to` (card 1) — all NAT |
| `NatAction` | 206 | `NatRule.then` (card 1) — all NAT |

Two of those cardinalities are the hard stop: `AddressObject.value` and `NatRule.then` are
required fields of types that cannot be constructed, so an address object and a NAT rule
cannot be created honestly by any dictionary on any platform. This is not an OPNsense
problem; it is the same wall in front of Junos `security policies` and PAN-OS security
rules. Filling those five types is schema/IR design work — a planning session's, per `78`
§5 — and it is the single largest thing standing between this engine and a useful one.

Until then the cells land on the residue list, at cell granularity, with their own bytes.
`crates/fathom-ingest/tests/opnsense_csv.rs::the_matches_the_ir_cannot_hold_are_on_the_list`
pins that by name, so the day the types get shapes, the test that has to change says why.

## 5. The vendor facts, with sources and dates

Every claim below was established by opening the URL on **2026-08-15**, per ADR-0034. None
is answered from memory, and where only one source exists that is said rather than smoothed.

| Fact | Source | Independent second |
|---|---|---|
| The export exists at Firewall → Rules → Migration assistant, CSV, since 26.1 | `thomas-krenn.com/en/wiki/OPNsense_26.1_Firewall_Rule_Migration` (page last modified 16 Feb 2026) | `docs.opnsense.org/releases/CE_26.1.html` — *"firewall: added a rule migration page (use with care)"* (28 Jan 2026); *"add import/export function"* (26.1.3, 4 Mar 2026) |
| The 50 columns and their order | `opnsense/core` issue #9861 (25 Feb 2026), a user's verbatim pasted header | `src/opnsense/scripts/filter/list_legacy_rules.php` on master builds the same keys in the same order |
| `action` ∈ `pass`/`block`/`reject`, default `pass` | `models/OPNsense/Firewall/Filter.xml` on master — `OptionValues` Pass/Block/Reject | `docs.opnsense.org/manual/firewall.html` — *"Pass: allow traffic"*, *"Block: deny traffic and don't let the client know it has been dropped"*, *"Reject: … let the client know about it"* |
| `enabled` is `'1'`/`'0'` | `list_legacy_rules.php`: `'enabled' => empty($rule['disabled']) ? '1' : '0'` | — (one source; the mapping is a two-line conditional read directly) |
| An any-match is the literal `any` | `list_legacy_rules.php`: `if (isset($rule[$field]['any'])) { $target_rule[$field.'_net'] = 'any'; }` | — (one source, same file, read directly) |
| Evaluation order is last-match-wins unless `quick` | `docs.opnsense.org/manual/firewall.html` | — (one source) |

`block` → `deny` and `reject` → `reject` is an exact mapping rather than a near one, and the
manual's own wording is what makes it so: Junos `deny` drops silently and `reject` answers,
which is the same distinction in the same order.

## Failure modes

1. **The delimiter is attested once.** `;` comes from the pasted header in issue #9861 and
   from nothing else — the exporter script emits JSON and the CSV is assembled above it, so
   the second source confirms the columns and not the separator. `csv.rs` therefore
   **sniffs** `;` or `,` from the header rather than assuming. If OPNsense ever writes a
   third, the sniff fails closed and the paste is read as Junos, which will bind nothing and
   be refused — noisy, not silent.
2. **The quoting rule is not established at all.** No document states it and the exporter
   does not do the writing. `csv.rs` implements RFC 4180 double-quote doubling *and* accepts
   unquoted fields, which is the union of the plausible behaviours rather than a guess at
   which one ships.
3. **A 0-byte export reads as a firewall with no rules.** Issue #10595 (22 July 2026, open
   and unanswered on 2026-08-15) reports exactly that on 26.7.1. `IngestRefusal::EmptyTable`
   exists for it: a header with no records is refused, by name, with the issue number in the
   message, and the held estate is left alone.
4. **`reviewed_by: <named human>` is a placeholder.** The same debt every junos-srx entry
   carries (invariant 10). It is real and it is not discharged here.

## Open decisions

- **`log` is not bound.** OPNsense's `log` column plausibly maps to
  `SecurityPolicy.log_init` — pf logs the packet that creates the state — but that is a
  semantic claim about pf that no page read on 2026-08-15 stated in those terms. Rather than
  assert it, the column is residue. Cheap to add the day somebody looks it up and can cite
  the sentence.
- **`quick` has no field.** It is per-rule evaluation order, and the schema models
  evaluation per `PolicySet`. Modelling it needs `PolicySetEvaluation` to grow a token, or
  `SecurityPolicy` to grow a field, and both are owner/planning work.
- **One paste, one device.** `OP_PASTE` replaces the held estate, so a rules CSV and the
  `config.xml` from the same box cannot be merged. That is `70` §6's unbuilt correlation
  requirement and nothing here fakes it.

## Sources consulted

- `docs.opnsense.org/manual/firewall.html` (2026-08-15)
- `docs.opnsense.org/releases/CE_26.1.html` (2026-08-15)
- `github.com/opnsense/core/issues/9579`, `/9861`, `/10595` (2026-08-15)
- `raw.githubusercontent.com/opnsense/core/master/src/opnsense/scripts/filter/list_legacy_rules.php` (2026-08-15)
- `raw.githubusercontent.com/opnsense/core/master/src/opnsense/mvc/app/models/OPNsense/Firewall/Filter.xml` (2026-08-15)
- `thomas-krenn.com/en/wiki/OPNsense_26.1_Firewall_Rule_Migration` (2026-08-15)
