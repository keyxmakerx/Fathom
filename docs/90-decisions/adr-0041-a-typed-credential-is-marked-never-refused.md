# ADR-0041 — A typed credential is marked, never refused

> **Status:** Accepted — the owner's decision, 2026-09-03, in his own words:
> *"if someone put a key in the description view then what can we really do, we can only
> account so much for human error… I'd say can we add like a visual indicator with a hover
> over 'this may be a password but has been place…' or something more concise but obvious the
> issue. Maybe a yellow triangle icon next to it? Because we'll have a config viewer and
> fields, so it should be present over the config viewer, and then also in the in line boxes
> for inventory."*
> **Date:** 2026-09-03. **Reversal cost:** R1 — one detector function, one wire token, one
> rendered mark. No schema change, no stored data, nothing to migrate.
> **Answers:** the hole proved by
> `docs/80-review/evidence/2026-09-03-the-gate-is-only-on-the-paste-box.mjs`.

## Contents

| § | |
|---|---|
| 1 | The hole, and how it was proved |
| 2 | **The decision** |
| 3 | Why marking beats refusing — and why my recommendation was wrong |
| 4 | Eight decisions, each with what it rejected |
| 5 | The colour, which was decided before this record |
| 6 | The shape: detector, wire, mark |
| 7 | What must stay true |
| 8 | What will be built |
| 9 | Failure modes · Open decisions · Sources consulted · Disagreements |

## 1. The hole, and how it was proved

The owner asked whether the server version would hold his device passwords. He was told no,
on the strength of `49` §3 decision 1. Three adversarial readers broke that answer, and the
strongest break was driven through the shipped artifact and read back out of the exported
journal — the file an operator keeps — per CLAUDE.md rule 0:

> **A pre-shared key typed into an interface's `description` cell is stored as typed and is in
> the export.**

The mechanism is blunt. `fathom_ingest::ingest()` is the only caller of the redaction gate, and
`OP_PASTE` is its only caller in turn (`shell.rs:219`). `field_set` does not import
`fathom_ingest` at all. Every path that is not the paste box — `OP_FIELD_SET`,
`OP_EQUIP_ADD`, the cable and port label writes, rack placement — parses raw bytes straight
into a typed slot. **The schema declares nineteen free-text `notes` and `description` fields
and every one of them is ungated by construction.**

Nobody decided this. `49`, `48` and `38` were searched for any discussion of hand-typed values
and there is none. It is not a debated risk; it is an absent one.

The export's own `warning` field made it worse by claiming the opposite. That half was fixed
first, on 2026-09-03, before this record: the warning now scopes itself to the paste box and
states plainly that a hand-typed value is stored exactly as typed.

## 2. The decision

> **A value that looks like a credential is MARKED wherever it is shown, and never refused,
> never destroyed, and never silently accepted. The mark is a word and a glyph on an inverted
> ground — not a colour, because the colours that would say this are reserved. It is reachable
> by keyboard, not only by hover. One detector, in Rust, shared by every surface.**

## 3. Why marking beats refusing — and why my recommendation was wrong

The orchestrating session recommended **refusing** the value, arguing from the owner's stated
priority of security first. **The owner overruled it and he was right**, on this project's own
doctrine, which the recommendation had forgotten:

> `70` §16, the owner's own earlier answer, executed across the product: **an incomplete or
> imperfect fact is drawn and *marked*, never refused.** `51` §9 reserves the marks; `19` §6's
> warp is the same idea for a path whose middle is unknown; `57` §12.2's one-ended cable is the
> same idea for a cable whose far end nobody knows.

Refusing would also have been **weaker than it looks**: a refusal is defeated by rewording, so
it buys the appearance of a control while costing real work. And it protects only the person
typing.

**The marker protects the person who reads it next.** That is the argument that actually
carries: the operator who typed a key knows they typed it. The colleague who opens the design
six months later does not, and a mark beside the value is the only thing that will tell them.

## 4. Eight decisions, each with what it rejected

| # | decided | rejected, and why |
|---|---|---|
| D1 | **Mark. Never refuse, never destroy, never block the save.** | Refusing (defeated by rewording; hostile to a legitimate description; protects only the typist). Destroying (the paste gate's direction of error is right for a paste, where no human is present at the decision — a typed value has one) |
| D2 | **Not amber, and not any risk colour.** The mark is a glyph and a word on an **inverted** ground — `--ink` behind `--page`. | The owner's yellow triangle. `#A8571B` is the reserved `ChangesConfig` risk colour and `tokens/reserved-colour` fails the build on reuse; §5 gives the precedent and the reason |
| D3 | **The mark carries a WORD**, not only a glyph. | A bare icon. `51` §9's doctrine and ADR-0035/0038's practice: the mark for a hand-drawn line is the words *by hand*, precisely because a shape alone is guessable |
| D4 | **Focusable and announced**, with hover as the convenience on top. | Hover only, which the owner suggested. `49` §15 item 9: *"a state only a mouse can reach is not a state."* A tooltip nobody can tab to does not exist for a keyboard or screen-reader user |
| D5 | **ONE detector, in Rust, reusing the gate's own word list.** `fathom-ingest` gains a public `looks_like_credential`. | A second detector in JavaScript. `49` §1 refused exactly this for the gate — *"a second implementation … maintained by one person, guaranteed to drift"* — and the reasoning is identical here |
| D6 | **It is a HINT and is named one everywhere.** It never claims the value IS a credential. | Wording that asserts. A detector that says "this is a password" and is wrong teaches an operator to ignore it |
| D7 | **It travels with the value, not with the view.** The hint is computed where rows are built, so the config viewer inherits it when it exists rather than reimplementing it. | Marking in the inventory only, which is what the hole would then need re-finding for on the next surface |
| D8 | **False positives are accepted, and are the right direction of error.** | Tuning the detector until it never nags. A missed key costs a credential; a false mark costs a glance |

## 5. The colour, which was decided before this record

The owner asked for a yellow triangle. **Amber is not available**, and this is not a style
preference — it is a rule with a build gate behind it.

`.context/conventions.md` reserves exactly three colours for the risk enum, `#A8571B` among
them, and says: *"Do not reuse these colours for anything else (not for finding severity, not
for status, not for diff)."* `51` §1 R1 repeats it, and `tokens/reserved-colour` is a CI check
that fails a build where the token appears outside the risk selectors. `51`'s own failure table
names the exact harm: *"Two things on one screen are green and mean different things."* An amber
triangle beside a value would read as **changes config — needs a commit**.

**The precedent for what to do instead already exists in the same document.** `.egress` wanted
`--caution` for the same reason and was changed to inversion, recorded verbatim as:

> *"It reuses a reserved colour, which conventions forbid. **Inversion is louder and costs
> nothing.**"*

So the mark is an inverted glyph. It is louder than amber, it cannot be confused with a risk
badge, and it needs no new token.

## 6. The shape: detector, wire, mark

**The detector.** `fathom-ingest` exposes `pub fn looks_like_credential(text: &str) -> bool`,
built from the gate's existing instruments and **nothing new**: the `SECRET_WORD_LIST`
adjacency rule and the `base64ish` / `long_hex` / `crypt_prefix` value shapes. Reusing them is
D5's whole point — when the gate learns a shape, the hint learns it in the same commit.

**The wire.** `fathom_inventory::Row` gains `hints: String` — a comma-separated list of the
column indices whose value tripped the detector, empty when none. It rides in the row record's
**slot 7**, packed after `opinions` and separated by a space, which is the diagram box's own
precedent for that slot (`<count> <interior> <placed> <role> <group>`). Empty is the common
case and costs one byte.

**The mark.** Beside the value, in the cell: an inverted `!` glyph, focusable, carrying the
word and the sentence. Wording, which is deliberately about the STORAGE and not about the
value's nature (D6):

> **stored as typed** — this looks like it may be a password or key. Fathom does not redact
> what you type, only what you paste, so it is saved and exported exactly as written.

**Addendum, 2026-09-03 (a proving pass, same day).** The paragraph above undersold how many
places a field's value is shown. `renderMeaningFace`'s field table — the inventory's own
DETAILS pane, reached by selecting the same row this section marks in the table cell, AND the
diagram's own details panel, `dgDetails`, which calls the identical function — is a second
on-screen rendering of the value, and it inherited no mark: a skeptic drove it and found the
PSK marked in the table and silently plain one click away, in the same view, session and row.
`FieldRow.hint` (`fathom-inventory/src/element.rs`) and `FACE_FIELD`'s wire slot 5
(`fathom-wasm/src/protocol.rs`) carry the identical detector result into that table too, and
`fieldTable`'s cells wear the same `credMark()`. This was not a new decision — D7 already said
"wherever it is shown" — it is the shape in §6 catching up to what the sentence already meant.
Verified live: selecting the row the driver's section 5 marks, in `#ipaneDetails table.kv`,
shows the identical `.credmark` beside the identical value; the diagram's `#ddetHead` panel,
navigated to separately with the same node still selected, shows one `.credmark` too.
`2026-09-03-the-gate-is-only-on-the-paste-box.mjs` §6 pins the inventory-details half; the
diagram half was confirmed the same way, by hand, and is covered by code sharing rather than a
second permanent driver (`fieldTable` and `credMark` are the one function each view calls).

The same pass closed a second gap in D3/D4: `title` is mouse-hover-only in every shipping
browser, so a sighted keyboard-only reader tabbing to the glyph got a focus ring and no
readable word — `55` §1.4's own rule against exactly that kind of affordance, already argued
elsewhere on this page for the diagram's line marks. The glyph's `aria-label` sentence is now
also painted as real DOM text via `content: attr(data-tip)` on `:hover` and `:focus-visible`,
never on hover alone. §9's driver §7 pins it against the COMPUTED style after a real keyboard
`Tab`, not against the attribute merely existing.

## 7. What must stay true

- **Nothing is refused, nothing is destroyed, nothing is blocked.** A marked value saves.
- **The paste gate is untouched.** Its driver and canaries stay green, unmodified.
- **One detector.** No JavaScript copy. A test asserts the page declares no secret word list.
- **The mark reaches a keyboard.** Driven, not assumed.
- **The mark never uses a reserved colour**, and `tokens/reserved-colour` still passes.
- **The hint never leaves the client as an assertion about the value** — it is recomputed
  where rows are built, never stored in the graph, because it is an opinion and `schema/` holds
  facts (ADR-0008).

## 8. What will be built

| layer | what |
|---|---|
| `fathom-ingest` | `looks_like_credential`, public, reusing the existing detectors; unit tests over real credential shapes and over prose that must NOT trip |
| `fathom-inventory` | `Row.hints`, computed as rows are built; `element::FieldRow.hint`, computed the same way for `renderMeaningFace`'s field table (the addendum above) |
| `fathom-wasm` | `FACE_INV` slot 7 packing; `FACE_FIELD` slot 5, six slots now instead of five, and both wire tests |
| the page | the mark: inverted glyph, focusable, the word painted as real DOM text on hover AND focus (not `title` alone); rendered in the inventory cell AND in `fieldTable` (inventory details pane, diagram details panel) |
| evidence | `2026-09-03-the-gate-is-only-on-the-paste-box.mjs` extended — §5 the key is still stored (unchanged) and the mark beside it is keyboard-reachable; §6 the field table (D7's second surface) carries the same mark; §7 the word is visibly painted on real keyboard focus, not just announced |
| docs | this record; `.context/conventions.md`'s invariant 3 annotated with what the gate does and does not cover; CLAUDE.md |

## Failure modes

| failure | what stops it |
|---|---|
| the mark reuses a risk colour | D2 and `tokens/reserved-colour`, which fails the build |
| a second detector grows in the page and drifts | D5, plus a test that the page declares no word list |
| the mark is mouse-only | D4, driven by keyboard in the driver |
| the wording asserts and is wrong | D6 — it describes storage, which is always true, not the value's nature, which is a guess |
| the hint is stored and becomes a stale "fact" | §7 — recomputed, never written to the graph |
| someone tunes the detector until it never fires | D8, and the unit tests pin real credential shapes |

## Open decisions

1. **The config viewer's rendering of the mark** — the view does not exist. D7 makes the hint
   available to it; where it sits on a config line is that view's design.
2. **Whether the server re-computes the hint on read.** Under the server plan a design is shown
   to people who did not type into it. Recomputing on read is cheap and means an older client's
   detector cannot under-report. *For planning, with the server work.*
3. **The remaining two holes from the same hunt**, both untouched here and both real: a
   credential inside a URL's userinfo (`redact.rs` records it as OPEN and says a name rule
   *"categorically cannot"* reach it), and twenty-three registered platforms of which two have
   dictionaries. These are steps 3 and 4 of the owner's approved five.
4. **`looks_like_credential`'s delimiter requirement is a real recall gap, verified and left
   as built, not fixed silently.** A proving pass showed `"password: R3dT3am!"` trips the
   detector and `"password R3dT3am!"` — the same secret, typed with a space instead of a colon
   — does not, nor does a sentence naming a live BGP MD5 key with no delimiter at all
   (`"bgp neighbor md5 password R3dT3am!"`). `adjacent_secret_word`'s own doc comment
   (`redact.rs`) already reasons about this trade-off — bare word-adjacency was deliberately
   rejected because it flags ordinary sentences (`"replaced the key switch in rack 4"`), and a
   sibling unit test pins that negative on purpose. D8 says false positives are the right
   direction of error, which argues the other way; this record does not resolve that tension
   in either direction, because doing so means either accepting more noise on ordinary prose
   or accepting the missed recall as documented above, and that is a tuning call for whoever
   owns the detector next, not something to decide by editing a test until it goes green.
5. **The detector never sees the field's own name**, only the cell text. A bare weak value in
   a column plainly labelled for it — `"public"`, `"private"`, `"s3cr3t"` in an SNMP-community
   field — carries no adjacent secret word and no shape, so it is never hinted, even though the
   column name alone would tell a person exactly what it is. Fixing this means threading the
   field name into `looks_like_credential` or a sibling predicate at every call site
   (`fathom-inventory`'s `credential_hints` over table cells, `element_page` over
   `FieldRow`s) — a wider change than this record's shape (§6) asked for, and left here rather
   than done without being asked.

## Sources consulted

| source | for |
|---|---|
| the owner, 2026-09-03 | the decision, quoted verbatim in the status line |
| `docs/80-review/evidence/2026-09-03-the-gate-is-only-on-the-paste-box.mjs` | the proof |
| `.context/conventions.md` — the risk enum, invariant 3 | the reserved colours; what invariant 3 actually promises |
| `docs/50-design/51-*.md` §1 R1, §9, and its comparison table | the colour rule, the mark vocabulary, and the `.egress` inversion precedent |
| `docs/70-ops/70-owner-answers-and-standing-priorities.md` §16 | *drawn and marked, never refused* |
| `docs/40-stack/49-the-server-product.md` §1, §15 item 9 | one implementation, not two; a mouse-only state is not a state |

## Disagreements

1. **With this session's own recommendation.** It proposed refusing the value and was wrong.
   The argument it made — security first, per the owner's standing order — is real but was
   applied to the wrong instrument: `70` §16 had already settled that this product marks rather
   than refuses, and a refusal defeated by rewording is not security, it is friction that looks
   like security. Recorded because the recommendation was made confidently and in writing.
2. **With the owner, on one detail only, and it is a rule rather than a preference.** He asked
   for a yellow triangle. §5 gives the constraint, the CI check that enforces it, and the
   inversion precedent that answers it. The shape of what he asked for — a mark beside the
   value, explained on hover, present on every surface — is adopted entirely.
3. **With the first cut of this record's own build, found by an adversarial proving pass the
   same day.** §6's addendum and Open decision 4/5 record it in full; the short form is that
   "present on every surface" was built as "present in the inventory table" and D7's own
   words — *"it travels with the value, not with the view"* — were not yet true of the
   inventory's own details pane or the diagram's. Fixed the same day, in the same record,
   rather than reopening it: the fix is `FieldRow.hint` and `FACE_FIELD` slot 5, doing for
   `renderMeaningFace` what `Row.hints` already did for the table. Recorded because a defect a
   skeptic had to find is a defect the shape section should have named.
