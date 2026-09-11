# ADR-0026 — Light is the product; the dark theme ships only on three conditions; the AA claim is qualified

> **Status:** Accepted
> **Date:** 2026-07-28
> **Register entry:** new — raised by `86` D-15 (**high**), D-37 (**high**), D-14, D-16, D-25, D-26, D-28
> **Reversal cost:** R1 for the CSS; R0 for the theme decision
> **Supersedes:** `51` §5.1's dark-theme decision as unconditional; `55` §1.1's "AA in full"

## Context

`86` recomputed every contrast ratio, OKLCh coordinate, colour-vision simulation and font metric in
`51` and `55` from the hex values, independently. Most of it is exact — all 16 light figures, all 18
dark figures, `55` §2.2's 24 figures, the protanopia and deuteranopia rows, the five solved reds to
two decimal places, and every font metric against the binaries. **This is a corpus that did its
arithmetic**, which is why the places it did not are worth naming.

**The critical defect (D-15).** `55` §2.6 ships an AAA token set behind `prefers-contrast: more`,
described as *"solved, not eyeballed"*. The second rule's selector list contains
`:root:not([data-theme="light"])`, which matches whenever no explicit theme has been chosen — the
default state of every fresh workspace — and it is **not nested inside
`@media (prefers-color-scheme: dark)`**. So a user on a light screen with no explicit theme who sets
"Increase contrast" at the OS level matches both rules, the dark block wins, and the dark AAA tokens
land on `--page: #FFFFFF`:

| Token | Applied | On `--page` | Requirement |
|---|---|---|---|
| `--muted` `#9DA9B4` | | **2.40** | 4.5 |
| `--safe` `#53BA86` | | **2.40** | 4.5 |
| `--caution` `#F58C46` | | **2.41** | 4.5 |
| `--danger` on its own light wash | | **2.13** | 4.5 |

**The user who explicitly asked the operating system for more contrast is moved from a worst pair of
4.71:1 to 2.13:1** — a Level AA failure on every semantic token and every margin tab in the product,
including `DISRUPTIVE — DROPS LIVE TRAFFIC`, delivered *only* to low-vision users, by the feature
written for them. And the specified CI check cannot catch it: `55` §2.7 tests four token sets in
isolation, and the defect is in the **cascade**.

**The second high finding (D-37).** `55` §1.1 claims WCAG 2.2 AA *"in full"* plus five AAA criteria.
`54` §12 removes the focus indicator from the finder input (`#q:focus-visible { outline: none; }`)
on the grounds that *"the shell IS the focus indicator here"* — but the shell's border is present
whenever the dialog is open, regardless of where focus is, and `54` §12's own Tab cycle moves focus
to footer elements that `54` §4 says are never focusable. Nothing on screen changes when the input
gains or loses focus except the caret, and a caret is not a focus indicator. **That is SC 2.4.7
Focus Visible (Level AA)**, in the product's most-used surface, by the design set's own record.

**The theme question.** `51` §5.1's argument is the best-written section in the design set and `86`
§5 finds its answer wrong — not because dark themes are wrong, but because *this* dark theme is **two
visual languages**, discovered incrementally across three documents:

- The severity ramp must change **encoding**, not values — tone in light, width in dark, because
  `--ink` vs `--muted` is 2.381:1 in dark.
- The three risk colours become **one colour** under achromatopsia in dark (`#8E8E8E` ×3, verified).
  In light they are 1.18/1.34/1.58 apart — poor but non-zero.
- **The diagram does not participate at all**: `56` §5.7 emits `fill="#FFFFFF"`, `stroke="#5C6772"`,
  `fill="#14171A"` as literal presentation attributes, so in dark mode the product has a light-mode
  diagram — 20% of the surface fighting the theme.
- The staleness channel needs a permanent text fallback in dark, so the dark diagram is permanently
  noisier, and `56` §5.2's channel budget still lists G1 as available when in dark it is not.

`51` §5.1's strongest supporting citation also does not exist (D-26): it cites *"§6.7 of the owner's
brief (change-window work)"* for a deployment environment, and brief §6.7 is *Verification and
rollback generation* — it names no environment, no NOC and no time of day. `conventions.md`: *"never
fabricate a reference."* And its second argument (*"there is no server to remember a preference"*) is
void by `51` §5.6, which stores the theme in `Settings`.

## Decision

**Fix the cascade, qualify the claim, and make the dark theme conditional on three things landing.**

1. **The `prefers-contrast` cascade is restructured**, and the CI check moves from token sets to
   **rendered cascade**: compute the resolved value of every token under each of the eight
   (theme × contrast × forced-colors) states in a headless browser, then assert. That is what `55`
   §2.7's specification has to be.

   ```css
   @media (prefers-contrast: more) {
     :root, :root[data-theme="light"] { /* light AAA set */ }
   }
   @media (prefers-contrast: more) and (prefers-color-scheme: dark) {
     :root:not([data-theme="light"]) { /* dark AAA set */ }
   }
   @media (prefers-contrast: more) {
     :root[data-theme="dark"] { /* dark AAA set */ }
   }
   ```

2. **`55` §1.1 changes to** *"targets AA in full; one known exception is tracked at `54` §26 and
   blocks the claim until closed."* The exception is closed by giving the finder input a real
   indicator — `#q:focus-visible { background: var(--surface) }` plus a 2px `--ink` bottom rule on
   the input row, which is the card's own vocabulary — and by making the footer's two spans a real
   `<button>` or dropping the claimed Tab cycle.

3. **The dark theme ships only if all three of these land. Otherwise light only, and say why.**
   - **One severity encoding in both themes** — `55` §2.5 F3's own recommendation: width in both,
     delete the tone ramp. Two grammars is the cost that makes this a second design rather than a
     second palette. (Note `86` §13.1: F3's WCAG framing is over-claimed — 1.4.11 measures against
     *adjacent* colours and two bars in different rows are not adjacent — but the recommendation is
     right on the usability argument alone, and it should be made on that argument.)
   - **The diagram themes.** Draw the live tree with `class` only and resolve colour in the
     stylesheet from tokens; serialise the export by resolving each class against the **light** token
     set explicitly, and state in the export header that exports are light-only. One function, and it
     also satisfies `55` §7.3's forced-colours rules, which currently assume class-based styling that
     `56` §5.7 does not use.
   - **The cascade is tested as a cascade** — item 1.

4. **Arithmetic corrections, and the tables are generated from the CI check rather than hand-typed**:
   `55` §2.3's dark own-wash figures for caution and danger are **5.22**, not 5.15 and 5.14 — `51` is
   right, `55` is wrong, and `55` §2.1's independence claim is false as printed. `55` §2.6's "worst
   CR" column prints `7.00`/`7.01` where the values are 7.02–7.13 and 3.04–3.08; print the computed
   values or print `≥ 7.0`. `51` §5.4's prototype `--danger` is **5.98:1**, not 7.4:1 — a 24% error
   in the direction that makes the argument work, repeated in `51` §18 and `54` §28. The conclusion
   (adopt `#EA6260`) survives for a different reason: the prototype's value is the same lightness at
   lower chroma, so the correct criticism is `51` §5.3 M4, not §5.2's pink failure mode.

5. **`55` §3.2's tritanopia rows are deleted**, with the note that the Viénot single-plane method
   does not support tritanopia — which the section's own `VERIFY` already argues — or re-run with
   Brettel's two-plane method for **both** themes. The published values (`#5353BC` for a mid green)
   do not reproduce under any standard simulation, and a fabricated-looking number in a document
   whose value is that its numbers are real costs more than the row is worth.

6. **`51` §5.1's brief citation is deleted** and the argument made on its own merits, which are
   adequate: engineers work change windows at night, terminals are dark, and a 992px white sheet
   beside a dark terminal is a flashbulb. That is true and needs no reference.

## Consequences

### Positive

- The feature written for low-vision users stops making their contrast 2.2× worse, and the class of
  defect — a cascade bug invisible to per-set testing — is closed by testing the thing users
  actually get.
- The accessibility document's headline sentence becomes true. It is the sentence a VPAT or a
  procurement questionnaire quotes, and `55`'s entire value is that its numbers are real.
- The dark theme's real cost is priced once, in one place, instead of being discovered incrementally
  across three documents.
- Generating the contrast tables from the CI check removes the drift that produced two wrong cells in
  the table headed *"the real numbers"*.

### Negative

- **Conditioning the dark theme on three deliverables probably means no dark theme in v1.** The
  diagram is cut to an export under ADR-0006, so "the diagram themes" is work on a deferred view, and
  the honest consequence is that the 02:00 change-window user gets a white sheet. `51` §5.1's
  case-for is real and this decision does not answer it; it answers it more cheaply, with a single
  dimmed light palette or the browser's own filter, and both are worse than a designed dark theme.
- **Deleting the tone ramp for severity costs the light theme something it did well.** Width in both
  themes is a compromise made for the theme that may not ship, and if the dark theme is dropped the
  compromise should be revisited — which nobody will remember to do.
- **Qualifying "AA in full" is the right call and it is the sentence a competitor quotes.** A
  procurement questionnaire that reads *"targets AA in full; one known exception"* scores worse than
  one that reads *"AA in full"*, and the exception is one CSS rule away from being closed. It stays
  qualified until it is closed, and that ordering is deliberately uncomfortable.
- **Rendered-cascade testing needs a headless browser in CI**, which is a new dependency in a build
  whose whole discipline is a small pinned toolchain (`42`, ADR-0019). `42` §— already permits
  WebDriver for the cross-browser matrix, so this is an extension rather than a new class, and it is
  still one more thing that can be red on a release day.
- **Deleting the tritanopia rows leaves a gap a reviewer will ask about**, and the honest answer —
  "the standard method does not support it and we would rather print nothing than print something
  wrong" — is correct and reads as incomplete.

## Alternatives considered

| Option | Strongest argument for it | Why rejected |
|---|---|---|
| **Ship the dark theme unconditionally (`51` §5.1)** | The best-written argument in the design set, and the 02:00 NOC case is real | It is two visual languages, not two palettes, and one of the six views does not participate at all. `86` §5.1's cost table is assembled from the documents' own admissions and nobody added it up |
| **Light only, permanently** | The card is a printed artifact, ink on paper, with a fixed white point, and this product is a reproduction of it. Simplest, most faithful, halves the cascade state count | It refuses a real user need with an aesthetic argument. The three conditions are achievable and the theme is good when they land |
| **A single dimmed light palette** | Answers the NOC case with no second grammar: reduce the page toward `#F2F4F6` luminance and hold every ink/wash relationship | It is the fallback if the three conditions are not funded, and it is genuinely worse than the designed dark theme, which is why it is the fallback and not the plan |
| **Fix the cascade selector only, keep `55` §2.7's per-set CI check** | One line, and the defect is one line | The check would still pass on the next cascade bug. The defect class is the cascade; testing sets tests the thing that was already right |
| **Keep `55` §1.1's "AA in full" and fix the finder focus first** | Same end state, no awkward interim sentence | It means the claim is false for as long as the fix takes, in the document a third party relies on. `55`'s value is honesty and an optimistic sentence at the top is the one thing it cannot have |

## Revisit if

- The three dark-theme conditions land, at which point the theme ships and this ADR is amended rather
  than superseded.
- Rendered-cascade testing finds a second defect of the same class, which would mean the token
  architecture (four sets across three media features) is too complex to be safe and should collapse
  to two.
- `86` §13.1's reading of SC 1.4.11 is contradicted by an auditor — the severity-encoding decision
  would then have a conformance argument behind it as well as a usability one, and the light theme's
  tone ramp would have to go regardless of whether dark ships.
- The owner sees the light-only product at 02:00 and disagrees. Their sentence about the card is the
  specification, and so is this one.
