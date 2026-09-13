# ADR-0024 — `53` owns the keymap, and Shift is the safety modifier

> **Status:** Accepted
> **Date:** 2026-07-28
> **Register entry:** new — raised by `86` D-33 (**high**), D-34
> **Reversal cost:** R1 — bindings and a CI check
> **Supersedes:** the keyboard maps in `54` §23, `54` §15, `54` §19 and `55` §4.5.6

## Context

Four documents each publish a complete or product-wide keymap. `54` §23's own header says *"every
global binding, in one place, so conflicts are visible"* — which is the claim `86` D-33 falsifies.

| Binding | `53` §3 | `54` §23/§15/§19 | `52` | `55` §4.5.6 |
|---|---|---|---|---|
| Switch view | `⌥1`…`⌥6` | **`Ctrl+1`…`Ctrl+6`** | `⌥1`…`⌥6` | — |
| Explainer depth | `⌥\` or `v` | **`Ctrl+1/2/3`** (§15) *and* `Ctrl+Shift+1/2/3` (§23) | `V` | — |
| **Accept AI proposal** | **`⇧A`** | **`A`** | — | — |
| Reject AI proposal | `⇧R` | `R` | — | — |
| `n` / `p` / `u` | filter match / platform filter / **unsuppress** | diff navigation / diff navigation / toggle context | — | — |
| `g` | sequence prefix (`g g`) | — | — | go to connection, **plus type-ahead in the same widget** |
| `Esc` in a roving list | unwind one level | collapse all disclosures | — | move focus to the heading |

`54` §15's own depth binding collides with `54` §23's own view-switch binding, so one document
contradicts itself twice over.

**The one that matters.** `53` §3.8 states a safety principle and applies it: *"Every action that
removes data or commits a security decision requires `Shift` plus its letter, and none of them is on
a single key."* `53` §3.5 adds *"`Enter` never accepts a whole proposal… `21` §15's failure mode 4 —
proposal fatigue, accepting without reading — is a real risk and the friction is the mitigation."*

`54` §19 and §23 bind bare **`a`** to Accept, and reason about it (*"only when focus is inside the
region"*) without knowing `53` exists. **In a product whose output is pasted into production
firewalls, one document makes "apply an unvalidated model-generated change" a single unmodified
letter.** Implementation will pick one at random.

A second flat contradiction sits alongside it (`86` D-34). `53` §12.3's announcement table ends:
*"Nothing, ever | `aria-live="assertive"`. **There is no event in this product that justifies
interrupting somebody.**"* `55` §4.6 specifies *"the only `alert` in the product"* for the
egress-armed transition, and `54` §20 implements `role="alert"` — which has an implicit
`aria-live="assertive"`.

## Decision

**`53-interaction-and-keyboard.md` owns the keymap. Every other document deletes its map and points
at it. `⇧A` / `⇧R` stay. One `assertive` region exists, and it is egress.**

1. **Delete the maps in `54` §23, `54` §15, `54` §19 and `55` §4.5.6**, replacing them with pointers.
   A single-source keymap is the only structure in which conflicts are actually visible, which is
   what `54` §23 claimed to be.
2. **Keep `⇧A` and `⇧R`.** `53` §3.8's principle is right and it is the only place in the design set
   where a keyboard binding is treated as a security control. Under ADR-0022 the AI proposal surface
   is much smaller, and the modifier stays regardless — the same rule covers unsuppress, delete and
   any op that commits a security decision.
3. **Resolve the four genuine collisions in `53`:**
   - `n` / `p` / `u` are **scoped**: diff-scoped only when focus is inside a diff block, using the
     focus rule `53` already provides. Unscoped, they keep `53`'s meanings.
   - `g` cannot be both a sequence prefix and an Outline command with type-ahead in one widget. The
     Outline's graph traversal moves to `⌥→` / `⌥←`, which are free inside a list.
   - `Esc` unwinds one level of `53` §3.7's ladder, everywhere. `54` §2.5's "collapse all" is a
     second press at the top of the ladder, not a competing behaviour.
   - Depth is `⌥\`; `Ctrl+1/2/3` does not exist.
4. **A CI test parses every `<kbd>` table in `docs/50-design/` and fails on any key bound to two
   actions in overlapping scopes.** Roughly fifty lines, and it is the reason to have a single map.
5. **`53` §12.3's last row becomes:** *"exactly one: the egress-armed transition (`55` §4.6).
   Nothing else, ever."* `55` is right — egress arming is the one thing that changes what leaves the
   machine, and it is the one thing worth interrupting for.

## Consequences

### Positive

- The most dangerous binding in the product is a shifted letter with a checked-op precondition,
  everywhere, rather than a coin flip decided by whichever document the implementer read second.
- One map means the next document that wants a binding has somewhere to ask, and the CI check makes
  a silent collision impossible.
- `55`'s egress `alert` survives, so the disclosure that matters most is the one interruption that
  exists — which is a coherent policy rather than an exception.
- Scoping `n`/`p`/`u` uses a mechanism `53` already specifies, so the fix costs no new concept.

### Negative

- **`⇧A` is worse ergonomics on the most repeated action in a review flow**, and the friction is the
  point, which means it is a cost paid on every legitimate accept forever. `53` §3.5's argument
  depends on proposal fatigue being the dominant failure; if it is not, the product is slower for no
  benefit and users will ask for a preference — which must be refused, because a safety modifier
  behind a setting is not a safety modifier.
- **Scoped bindings are harder to learn and harder to document.** `n` meaning two things depending on
  focus is exactly the ambiguity `86` names elsewhere as the design's failure mode, and the help
  screen has to explain focus scope to justify it.
- **Moving Outline traversal to `⌥→`/`⌥←` collides with browser and OS history navigation on some
  platforms**, which is unverified here and is the kind of thing that only shows up on a user's
  machine.
- **The CI check parses prose tables**, so it is fragile: a reformatted table breaks the build for a
  documentation edit, and the fix will be to loosen the parser.
- **Deleting three documents' keymaps removes locality.** A reader of `54` §19 now has to open `53`
  to learn what key accepts a proposal, and `54`'s per-component template has a Keyboard section that
  is now a pointer — which is correct and less useful at the point of reading.

## Alternatives considered

| Option | Strongest argument for it | Why rejected |
|---|---|---|
| **`54` owns the keymap** | It is where the components are, and a binding belongs with the thing it acts on. `54` §23 already assembled a product-wide table | That table is the one that binds bare `a` to accepting an unvalidated change to a firewall, contradicts itself between §15 and §23, and misses `d` entirely. Locality is why four maps existed |
| **Bare `a` for Accept, with a confirmation dialog** | Fast in the common case, and the dialog carries the friction | A dialog that appears on every accept is dismissed reflexively within a day — the same mechanism `85` §7.2 identifies for per-invocation consent. A modifier is friction that cannot be habituated away because it is in the muscle, not on the screen |
| **No `assertive` region at all (`53` §12.3 as written)** | An absolute rule is auditable and never argued | It means no interruption when egress arms. `55` is right that this is the one event that changes what leaves the machine, and an absolute rule that is wrong once is a rule a reviewer will assume is wrong elsewhere |
| **Two `assertive` regions (add one for `Disruptive` emission)** | Disruptive config is arguably as consequential as egress | Emission is initiated by the user in the moment; egress arming can be initiated by a grant the user gave last month. Interruption is for what you did not just do |
| **Leave the four maps and add a reconciliation section** | Least churn, and `54` already has a reconciliation section | `54`'s reconciliation section enumerates three divergences and misses this one and the view band (`86` D-31). A reconciliation known to be incomplete is worse than no reconciliation, because it is trusted |

## Revisit if

- The CI check's false-failure rate on documentation edits exceeds its true-failure rate — the check
  should parse a machine-readable keymap file that the tables are generated from, which is the better
  design and a larger change.
- Pilot users report the shifted accept as the top friction complaint. That is not automatically a
  reversal: the correct response is to reduce the number of proposals (ADR-0022 already does), not to
  remove the modifier.
- `⌥→`/`⌥←` collides with a platform binding in real use, in which case the Outline traversal needs a
  third home and `53` chooses it.
