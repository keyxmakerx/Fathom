# ADR-0025 — Restore the card's density, geometry and channel budget

> **Status:** Accepted
> **Date:** 2026-07-28
> **Register entry:** new — raised by `86` §2, §3, §8, §10 (D-1, D-2, D-2a, D-5, D-6, D-8, D-13, D-29, D-30, D-31, D-32)
> **Reversal cost:** R1 — four of the six changes are CSS
> **Supersedes:** `54` §8.2's wrap default; `52` §5.2's selection channel; `54` §11's view band; `54` §12's `.pill`

## Context

The owner supplied a printed field card and one sentence: *"it's very bare bones, there's something
I love about it."* `86`'s verdict is that the design set **kept the card's vocabulary and lost the
card's grammar.** It added no colour, no radius, no shadow, no gradient and no logo — it held on the
four things a design system usually fails at — and then spent each of the card's six named devices
four or five times per screen on four or five different meanings.

The measurable part:

| | Card | Design set as specified |
|---|---|---|
| Margin tabs | **Ten, across four sides** | 8–30 on one inspector screen |
| 4px left bar | One meaning: *this block is annotated* | **Six**: note, severity, block edge, selection, AI-proposed, zone stub |
| `▸` inside a config block | — | Three: hover, expanded, selected — and the ground channel is already spent |
| Continuation backslash | Named device 5, required by `design-language.md` | **Off by default** (`54` §8.2), and `53` §6.3.1 says the opposite |
| Row height | 20px line grid | `--row-min: 24px` — **20% looser** |
| Furniture above the body | — | **≈279px**, claimed as ~150px (`52`) and ~110px (`54`) |
| Two-column grid | *"two columns, ~360pt each, 744pt content width"* | **Never renders** at the canonical sheet width with the inspector open |

The geometry failure is arithmetic. `51` §7.8 derives `--sheet: 1180px` because *"a two-column grid
at that width holds exactly 73 columns of `--t-mono`, and the emitter wraps at 72."* `54` §18 then
gives the inspector a fixed 420px column at a 32px gutter inside 48px of sheet padding:
`1180 − 48 − 420 − 32 = 680px`, and `--bp-cols` is 860px. **The width was derived from a requirement
the layout it sits in cannot satisfy.** Separately, `52` §2.3 specifies a *pinned second pane* as a
different mechanism and never mentions the inspector in 1,639 lines; the union of the two gives
340px per pane, below the number `52` itself says breaks the type.

`51` §1 R3 states the rule the whole channel budget exists to enforce — *"one channel, one owner, per
component"* — and `51` §4.2 forbids a coloured bar for selection by name. `52` §5.2 makes it the
foundation of the selection model three documents later, and `54` §22's channel audit records **two**
exceptions and misses at least four.

## Decision

**Six changes. None requires a new idea; four are CSS. Together they are the difference between the
object the owner loves and a well-behaved web application in its palette.**

1. **`--row-min` moves onto the interactive element, not the row.** `51` §8 already states this rule
   — *"padding goes on the interactive element, never on the row"* — and `54` §8.4 contradicts it by
   putting `min-height: var(--row-min)` on `.cfg-line` itself. Implemented as `51` says, the visual
   row is 20px and the target is 24px via negative-margin padding: **the card's density at no
   conformance cost.** SC 2.5.8 is met without a settings toggle.
2. **`Terminal` wrap becomes the default**; `Display` becomes the accessibility affordance `55` §6.3
   already specifies for narrow viewports, under its existing `wrap to fit` control. The
   screen-reader concern is already solved by `54` §8.2 rule 3 and `55` §4.3 rule 4 — the backslash
   lives in an `aria-hidden` span and the accessible name is the unwrapped command — and that
   solution works identically whichever flavour is the default, so the default is a free choice and
   the card decides it.
3. **One second surface, at 62/38.** The inspector and the pinned pane are the same thing: `52`
   §2.3's ratios on 1132px of content give 702/430, which is `54` §18's 420px inspector to within a
   rounding step. They already agree; nobody noticed. **The card's two-column body is a property of a
   view's body, not of the sheet**, and it requires the second surface closed — which is fine,
   because the card is a reading artifact and the inspector is an editing one. `51` §7.8's derivation
   is restated honestly rather than presented as a consequence.
4. **Furniture cut to ~210px** (26% of an 800px viewport, stated as 210 rather than 150): merge
   `52` §9.4's ribbon into `54` §3's subtitle (−29px), delete the eyebrow because the view band is
   the same control (−20px), tighten the legend's spacing to the card's own leading (−20px).
5. **Budget the margin tab: at most three per screen region, and a tab may only weight a section,
   never annotate a row.** Row-level metadata — provenance dates, field origin, delta class, review
   state — moves into the two-column hairline table, which is the card's actual device for per-row
   facts and which `54` §9 already specifies correctly. `54` §18's inspector is already a table; the
   provenance column becomes a plain `<td>` in `--muted`, not thirty 11px italic tabs.
6. **One meaning per device, enforced in CI:**
   - **Selection is `▸` plus ground**, as `51` §4.2 already decided. `52` §5.2 and `54` §12 change.
   - **The block's default ground moves to `--page`** so selected rows can take `--surface`; `▸`
     then means selection only and hover keeps its one ground step.
   - **`dashed` is exclusive to AI.** `51` §4.8's `unanswered, required` row changes to **dotted**,
     matching `51` §9's `--rule-style-pending` and `54` §2.4's implementation. CI: `dashed` may
     appear only in selectors matching `.prop*`, `.dg-proposed`.
   - **Delete `.pill`.** `51` §4.5 rejected the badge by name — *"a pill is a shape, shapes need a
     fill, a fill needs a colour, and the only colours available are reserved"* — and `.pill.caution`
     puts `--caution` at 10px on `--caution-wash` at **4.73:1**, 0.02 from the pair `54` §6 declares
     impermissible at that size. The risk word goes at the end of the command line in semantic ink at
     11px on `--page`: 5.19:1, no fill, no box. That is what the card does.
   - **The risk mark becomes a 4px accent bar in the line's gutter**, not a 6px square, which makes
     `54` §19's absence signal a 4px hole rather than a 6px one and snaps to the grid.
   - **The legend becomes ink-on-wash with a 4px accent bar**, deleting `.swatch` — the card's own
     device, and it removes an `aria-hidden` element `54` §6 is already apologising for.

**Two reconciliations that were claimed and are not true** (`86` D-31, D-32): the view band takes
`52` §9.3's treatment (lowercase italic margin tabs, `▸` marker, no 3px underline) over `54` §11's
tab bar, and the egress indicator takes `54` §20's inverted band over `52` §8.5's 1px `▲` strip.
`54`'s reconciliation section is then re-run against all of `52`, because it is now known to be
incomplete on two counts and its other three entries are therefore unaudited.

**And add a ninth part to `54` §1's component template: Copy.** Every user-visible string, authored,
with the same discipline invariant 10 applies to explainers, linted against the five voice
characteristics in `design-language.md`. `54` §12's empty-state string is the worked example of what
passing looks like.

## Consequences

### Positive

- The default screen becomes the card's density rather than 83% of it, without touching WCAG
  conformance — item 1 is the whole trade removed by implementing a rule `51` already wrote.
- The most recognisable typographic mark on side 1 appears in the product's primary output by
  default.
- R3 — the rule the entire channel budget exists to enforce — becomes true. On a findings list with
  a row selected, the reader stops looking at a 4px ink bar meaning `high severity` beside a 4px ink
  bar meaning `you clicked this`, on the screen `51` §1 says *"nobody can read under pressure, and
  this product is read under pressure."*
- The copy section closes the one gap that cannot be recovered by CSS: a design system with a
  rigorous channel budget and no copy budget produces a product that looks like the card and reads
  like software.

### Negative

- **Three margin tabs per region is a hard budget on a product that has genuinely more than three
  things to say per region.** Provenance, staleness, confidence, review state and delta class are all
  real and all needed; moving them into a table makes the table wider and the inspector denser, and
  some of them have no natural column. Some information will be dropped, and the design set does not
  say which.
- **Deleting `.pill` removes the finder's only visual differentiation between results.** Three
  identical-looking mono lines with a trailing risk word are harder to scan than three lines with a
  coloured chip, and the finder is *"the feature people open ten times a day"*. The card's answer —
  words in ink — is right for print and is being asserted, not tested, for a scrolling list.
- **One second surface means the pinned-pane workflow and the inspector workflow are the same
  workflow.** `52` §2.3 argued for a pinned pane as a distinct mechanism; that capability is gone,
  and comparing two views side by side now costs the inspector.
- **Stating that the two-column body requires the inspector closed means the card's most recognisable
  structural feature is not the default view.** It is honest and it is a concession: the product's
  ordinary working state is one column.
- **Item 1's negative-margin padding technique is fragile.** A 20px visual row with a 24px hit target
  overlaps adjacent targets, and on a dense list the overlap has to be managed carefully or the wrong
  row activates — a worse accessibility outcome than the loose default it replaces.
- **Six changes across five documents, four of which claim to have already reconciled with each
  other.** The reconciliation sections have to be re-run, and `86` shows they were trusted while
  wrong on two counts.

## Alternatives considered

| Option | Strongest argument for it | Why rejected |
|---|---|---|
| **Keep `--row-min: 24px` and state the 20% cost honestly** | `86` offers it as fix option 1, it is one sentence, and the corpus is otherwise good at honest costs | It costs the density permanently for every user who never opens settings — which is most of them — when `51` §8's own rule recovers it for free. Honesty about an avoidable cost is not a substitute for avoiding it |
| **Keep `Display` wrap as the default** | Soft wrap with a hanging indent is what documentation sites do because it reads better on a narrow screen | It is what a *documentation site* does. The card's `\` is the single most recognisable mark on side 1 and `design-language.md` states the requirement in terms |
| **Keep the 4px bar for selection (`52` §5.2)** | It is the foundation of the selection model across config, inventory and findings, and it is visible at a glance | `51` §4.2 forbade it by name for a reason that holds: the same edge of the same element cannot mean two things, and `51` §4.3's "two edges, 12px apart" escape does not apply |
| **Keep `.pill` and fix only its contrast** | Contrast is the concrete defect; the form is a matter of taste | The form is what `51` §4.5 rejected, and it came back under a different name. `86` §13.2 is right that keeping a word and importing the thing is how a design language ends |
| **Widen `--sheet` so two columns and the inspector both fit** | Preserves both properties and needs no concession | Requires ~1600px, which is not the 1280×800 laptop `52` §2.1 designs against. The geometry has to give somewhere and the card is a reading artifact |
| **Re-derive `--sheet` as 1050px for the working layout** | `86` offers it, and it makes the number honest | Two sheet widths is a second constant to keep consistent across six documents. Keeping 1180 and stating the condition is simpler and equally honest |

## Revisit if

- Pilot users cannot scan finder results without the pill — that is evidence the card's print
  discipline does not transfer to a scrolling list, and the risk word needs a stronger treatment that
  is still not a shape.
- The three-tab budget forces a genuinely necessary fact off screen twice, which would mean the
  budget is the wrong instrument and the right one is a per-region information hierarchy.
- The negative-margin hit-target technique produces mis-activation in testing, in which case
  `--row-min: 24px` returns and the honest statement of the 20% cost is the fallback.
- The owner sees it and says the density is now too tight. Their sentence is the specification.
