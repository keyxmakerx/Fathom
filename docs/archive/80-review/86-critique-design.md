# 86 — Critique: design

> **Status:** Contested

*margin tab: read this before defending anything*

**Lens.** The owner supplied a printed field card and one sentence: *"it's very bare bones,
there's something I love about it."* This review asks one question — do `docs/50-design/51`
through `56` preserve that object, or have they quietly rebuilt a normal web application in its
palette? Everything below is measured against `.context/design-language.md` and
`.context/field-card-srx-ipsec.txt`, not against taste.

**The governing rule of this document, stated once, in caps, at the top:**

> **THE CARD IS FOUR SIDES OF INK WITH ELEVEN COLOURS, THREE RULE WEIGHTS AND NO CONTROLS. THE
> DESIGN SET IS 10,445 LINES DESCRIBING NINETEEN COMPONENTS, ELEVEN STATE AXES, TEN VISUAL
> CHANNELS AND FOUR MUTUALLY CONTRADICTORY KEYBOARD MAPS. THAT DELTA IS THE FINDING.**

**Method.** Every contrast ratio, OKLCh coordinate, colour-vision simulation and font metric in
`51` and `55` was recomputed from the hex values, independently, using the WCAG 2.x
relative-luminance formula, the standard OKLab M1/M2 matrices, and the Viénot–Brettel–Mollon
(1999) single-plane projection. Both font binaries were measured directly with `fontTools`
against the copies on this machine (`LiberationSans-Regular.ttf`, `DejaVuSansMono.ttf`). Every
geometric claim was re-derived. Where a number here differs from the number in the source
document, the source document is wrong and the arithmetic is shown.

**What this review does not do.** It does not re-argue the reserved-colour rule, the neutral
severity ramp, or the no-shadow decision. Those are right, they are argued well in `51`, and the
documents deserve credit for them. Scepticism is spent on the places where the documents claim
fidelity they do not have.

**Credit where it is owed, stated once so the rest reads as it is meant to.** `51` §2's page
solve (744 + 24 + 24 = 792 × 612 = Letter landscape) is correct. `51` §7.3's font metrics are
correct to the unit — x-height 1082/2048, cap 1409, advance 1139, hhea 1854/−434/67 for
Liberation Sans; 1120/1493/1233 and 1901/−483/0 for DejaVu Sans Mono, all verified against the
binaries. `51` §3.4's entire light contrast matrix is correct. `51` §5.5's entire dark matrix is
correct. `51` §5.2's five solved reds are correct to two decimal places. `55` §3.2's protanopia,
deuteranopia and achromatopsia rows reproduce exactly. This is a corpus that did its arithmetic.
Which is why the places it did not are worth naming precisely.

---

## 0. Contents

| § | |
|---|---|
| 1 | Verdict |
| 2 | What the card has that the design lost |
| 3 | What the design added that the card does not have |
| 4 | The contrast audit, recomputed — every number checked |
| 5 | Dark theme — should this product have one |
| 6 | The AI surface — genuinely different, or a cheat |
| 7 | The diagram — card idiom or generic network diagram |
| 8 | The IA — usable, or six views bolted to a nav bar |
| 9 | Cross-document contradictions |
| 10 | Would it feel like the object the owner loves |
| 11 | Findings index, ranked |
| 12 | Method and sources |

---

## 1. Verdict

The design set has not added a colour, a radius, a shadow, a gradient or a logo. On the four
things a design system usually fails at, it held. `51` §10's paragraph on why a rounded 4px bar
is a lozenge is the best writing in the corpus.

It has failed somewhere less obvious and more damaging: **it kept the card's vocabulary and lost
the card's grammar.** The card's power is not that it has a 4px bar; it is that the 4px bar means
exactly one thing, appears about six times per side, and is surrounded by air the design system
would call wasted. Fathom's design set takes each of the card's six named devices and turns it
into a *system primitive*, then spends it four or five times per screen on four or five different
meanings. The margin tab becomes a badge engine. The 4px bar becomes severity *and* selection
*and* block edge *and* AI gutter. The `▸` glyph becomes selection *and* hover *and* expanded. By
the time `54` §22 audits R3 ("one channel, one owner") it has to record "two audited exceptions"
and it misses at least four more.

The measurable consequence is in §8: **at the canonical sheet width, with the inspector open, the
card's two-column grid never renders, and the default row height inflates the card's 20px line
grid by 20%.** The product's default screen is a single column at 83% of the card's density with
275px of furniture above the fold. That is not the object. That is a well-behaved web application
wearing the object's palette.

Three specific defects are worse than "design drift" and are ranked in §11: an accessibility
feature that makes contrast worse for the users who asked for more of it; four incompatible
keyboard maps, one of which removes the safety modifier from "accept an unvalidated AI change to
a firewall"; and a geometry that cannot hold its own derived sheet width.

---

## 2. What the card has that the design lost

The design-language document names six devices as "worth stealing verbatim". Here is what
survived.

| Card device | Status | Where it went |
|---|---|---|
| 1. The margin tab | **Kept, then inflated** | §2.1 |
| 2. The 4px left accent bar | **Kept, then overloaded four ways** | §2.2 |
| 3. The one-line imperative | Kept, then repurposed as app state | §2.3 |
| 4. Two-column tables, no vertical rules | **Kept, correctly and completely** | `54` §9. No finding. |
| 5. Continuation backslashes preserved | **Lost — turned off by default** | §2.4 |
| 6. Numbered plumbing, ordinals as content | **Kept, correctly** | `54` §10. No finding. |
| The two-column grid | **Lost at the canonical width** | §8.1 |
| Density | **Lost 20% by default** | §2.5 |
| The voice | Kept in the documents; unspecified in the product | §2.6 |

### 2.1 D-1 — The margin tab has been industrialised into a badge system

**File / section:** `51` §4.5, §4.2 (C10); `54` §4, §13, §14, §17, §18; `52` §9.3.

**The claim.** `51` §4.5: *"Every time this system is tempted toward a badge, the answer is a
margin tab."* `54` §4: *"This is the most reusable device on the card and the catalogue leans on
it harder than anything else."*

**Why it is wrong.** The card's margin tabs are **scarce**. Across four sides there are ten of
them — `read this first`, `most-missed`, `verify as you go`, `why it exists`, `fields that
matter`, `what the log means`, `up-ness`, `approx`, `DF ping`, `not VPN-specific`. Two or three
per side, floating at the top-right of a whole sheet, weighting a *section*. Their entire power is
that they are the only lowercase thing on a page of tracked capitals and dense mono, and that they
are rare enough to read as an aside from the author.

Count the tabs on one Fathom findings screen as specified: confidence (`54` §13), suppression
review state ×4 (`54` §14), provenance class and age (`54` §17), field provenance per row (`54`
§18 — one per field, so 5–30 of them on one inspector), `DeltaClass` per diff row (`54` §16.1),
`unsupported` on proposals (`54` §19), six view-band tabs (`52` §9.3), `overridden` on depth
(`54` §15), `blocked · needs #5` per walkthrough row (`52` §6.6), `wrapped to fit` per config
block (`55` §6.3), `4 labels hidden` / `3 nodes unverified` / `grouped by zone` (`56` §5.2 G10),
plus `54` §4's own examples. A single inspector view carries more margin tabs than all four sides
of the card combined.

`54` §4 states the authoring rules ("one to four words", "says how to weight, not what it is") and
then `54` §18's own worked HTML violates the second one four times: `hand · 2026-07-02` describes,
it does not weight. `54` §14's `acknowledged by r.oyelaran, 2026-06-01` is six words and a date.

**Consequence.** The device that made the card feel like it was written by a person becomes the
product's generic annotation slot. When everything is a margin tab, the margin tab is a
`<span class="meta">`, and 11px muted italic is a bad one — `55` §8 C2 already concedes it is *"at
the low end of legibility"* and `54` §4's cost section concedes it is *"below the 12px the rest of
the product uses."* You have taken the card's least legible register and made it carry the most
information.

**Fix.** Budget it, the way `52` §9.6 budgets header facts. **At most three margin tabs per
screen region, and a tab may only weight a section, never annotate a row.** Row-level metadata —
provenance dates, field origin, delta class, review state — moves into the two-column hairline
table, which is the card's actual device for per-row facts and which `54` §9 already specifies
correctly. `54` §18's inspector is *already* a table; the provenance column should be a plain
`<td>` in `--muted`, not thirty italic tabs.

### 2.2 D-2 — The 4px accent bar carries four meanings, and the R3 audit misses three

**File / section:** `51` §4.2, §9; `52` §5.2; `54` §8.4, §8.5, §12, §22.

**The claim.** `51` §1 R3: *"one channel, one owner, per component."* `51` §4.2, on selection:
*"`▸` in the gutter + `--surface` ground. **Never a coloured bar — that channel belongs to
severity/risk**."* `51` §9: 4px means *"this block is annotated"* and nothing else.

**Why it is wrong.** The 4px left bar is assigned, in the same design set:

| Meaning | Where |
|---|---|
| Note / warning (the card's own meaning) | `54` §7 |
| Finding **severity**, four tones | `51` §4.2; `54` §13 |
| Config **block edge**, `--hairline`, becoming `--ink` when a line is expanded | `54` §8.4 `.block`, `.cfg-line[aria-expanded="true"]` |
| **Selection**, 4px `--ink` | `52` §5.2 (`PRIMARY … 4px ink left bar`), `54` §12 (`.hit.sel { border-left-color: var(--ink) }`), `54` §5.3 (inventory row gutter bar) |
| **AI-proposed** hatched gutter | `51` §4.2, §9; `54` §19 |
| Zone **stub** in the diagram tier-3 fallback | `56` §4.4 |

That is six. `51` §4.2 forbids the fourth explicitly and `52` §5.2 does it anyway, three
documents later, as the foundation of the entire selection model. `54` §22's channel audit records
**two** exceptions — the finder's selection bar and the finder input's missing focus ring — and
does not record `52` §5.2's use of the same channel for selection in config, inventory and
findings, which is a far bigger exception because it is *everywhere*.

**Consequence.** On a findings list where one row is selected, the reader is looking at a 4px ink
bar that means `high severity` next to a 4px ink bar that means `you clicked this`. `51` §4.3's
escape hatch ("two edges, two meanings, 12px apart") does not apply, because these are the same
edge of the same element. This is precisely the screen `51` §1 R3 says *"nobody can read under
pressure, and this product is read under pressure."*

**Fix.** Pick one and enforce it in CI. The card's own answer is available and costs nothing:
**selection is `▸` plus ground, as `51` §4.2 already decided; `52` §5.2 and `54` §12 are the
documents that must change.** Then delete the "two audited exceptions" framing from `54` §22 and
re-run the audit honestly — it will find more.

### 2.2a D-3 — Inside a config block, three states share one glyph and the ground channel is already spent

**File / section:** `54` §8.4 (`.gut::after`), §8.5, §8.6; `51` §4.6.

**The claim.** `51` §4.6: selection is glyph **and** ground, *"Both, never one … glyph alone is
invisible at a glance in a 200-line block."*

**Why it is wrong.** `54` §8.4 sets `content: " \25B8"` (`▸`) on `.gut::after` for **hover** and
for **expanded**. `54` §8.5 assigns the same `▸` to **selected**. And the block's default ground
*is* `--surface`, which `54` §8.5 also assigns to "selected", and `54` §8.6 spends the remaining
ground step (`--page`) on hover and on expanded. So inside the product's single most important
component:

- `▸` means hover, expanded, or selected — three meanings, one channel;
- `--surface` ground means "default" and "selected" simultaneously;
- selection therefore degrades to glyph-only, which is the exact failure `51` §4.6 rules out.

**Consequence.** A user who has `Shift`-selected lines 40–52 of a 200-line block for copy cannot
see the selection at a glance, and the one thing that would show it is also what the cursor draws
under the mouse. `53` §6.3 makes copy the primary output mechanism of the entire product. The copy
scope is invisible.

**Fix.** Selection inside a block gets the ground it needs by moving the *block's* default ground
off `--surface`. Set `.block { background: var(--page) }` and give selected rows `--surface`. The
card's mono blocks are on `#F2F4F6` because they sit on white paper with nothing else on them; on
screen the block already has a 4px edge and a gutter marking it, so the wash is redundant and it
is the only free channel left. Then `▸` means selection only, hover keeps its one ground step, and
`aria-expanded` is carried by the disclosure being visible, which it is.

### 2.3 D-4 — The one-line imperative is repurposed as an application status line

**File / section:** `52` §7.2 screen 2; `54` §5.

**The claim.** `.context/design-language.md` device 3: the imperative is *"a disclaimer that is
also the most useful sentence on the page"* — `BOTH ENDS MUST AGREE — EVERY VALUE, EXACTLY`. `54`
§5 preserves this correctly and even authors one per view.

**Why it is wrong.** `52` §7.2 screen 2 overwrites it: *"The masthead's imperative line becomes,
and stays: `UNSAVED · IN MEMORY ONLY · NOT YET ENCRYPTED`."* That is application state, not a
governing rule about the domain. Every card imperative teaches you something about IPsec you did
not know; this one tells you the file is not saved, which the footer already says (`unsaved · 4
edits`) and which `beforeunload` also says.

**Consequence.** The slot that carries `THE JOIN KEY ACROSS ALL OUTPUT IS VPN NAME + PEER IP,
NEVER ST0` becomes a save indicator for the duration of the most common session shape in the
product (paste → findings → fix, per `52` §7.2). The user's first and longest exposure to the
imperative slot teaches them it holds chrome.

**Fix.** The imperative stays domain-governing, always. Unsaved state goes where `52` §7.2's own
table already puts three of its four controls: the footer, the margin tab row, and `beforeunload`.
`54` §5's per-view imperative table is right and should be the only source for that line.

### 2.4 D-5 — The continuation backslash, a named card device, is off by default

**File / section:** `54` §8.2 (DECISION); `53` §6.3.1; `.context/design-language.md` device 5.

**The claim.** Design-language device 5, verbatim: *"Continuation backslashes preserved. `set
security ike proposal IKE-P1 \` — commands wrap the way they wrap in a terminal, not the way they
wrap in a webpage. Emitted config must do the same."* `53` §6.3.1 restates it: *"`design-language.md`
device 5 requires the *display* to do the same."*

**Why it is wrong.** `54` §8.2's DECISION makes `Display` — *"soft wrap, hanging indent, **no
backslash**"* — the default, and `Terminal` an opt-in per-block margin tab. The two documents
contradict each other in the same folder: `53` §6.3.1 says the display preserves them and cites
`54` §8.3 as its authority; `54` §8.2 turns them off.

Note also that `51` §2 spent a page measuring the card's wrap behaviour from the source text (91
command lines, 23 wrapped, longest wrapped 51 chars, longest unwrapped 62, two-space continuation
indent — all of which I verified against the field card and all of which are correct) and derived
`--cfg-cols: 72` and the entire 1180px sheet width from it. The design then ships the wrap it
measured as an option.

**Consequence.** The default rendering of the product's primary output does not look like the
card. A hanging indent with no backslash is what a documentation site does. The `\` is the single
most recognisable typographic mark on side 1.

**Fix.** `Terminal` is the default; `Display` is the accessibility affordance `55` §6.3 already
specifies for narrow viewports, offered under its existing `wrap to fit` control. The
screen-reader concern `54` §8.2 raises is already solved by `54` §8.2 rule 3 and `55` §4.3 rule 4
— the backslash and the break live in an `aria-hidden` span and the accessible name is the
unwrapped command. That solution works identically whichever flavour is the default, so the
default is a free choice, and the card decides it.

### 2.5 D-6 — Density: the default ships at 83% of the card's

**File / section:** `51` §8 (`--row-min: 24px`); `54` §8.10 cost 2; `55` §6.1.

**The claim.** `.context/design-language.md`: *"Body copy is small and tight. This is a
*reference*, and density is the point. Do not let a design system inflate the leading."* `51` §7.6
honours this for type. `51` §8 then sets `--row-min: 24px` as the default, against a `--lh-step`
of 20px.

**Why it is wrong.** It is not wrong as accessibility policy — SC 2.5.8 is real and `55` §6.1's
position (conformant default, opt-in compact, criterion named in the setting's own text) is the
right one. It is wrong as a *characterisation*. `54` §8.10 states the cost precisely: *"`min-height:
var(--row-min)` (24px) inflates a 40-line block by 160px."* On the product's densest and most
valuable screen the default is 20% taller than the card's grid. `51` §8 and `55` §6.1 both present
this as a small trade; it is the largest single deviation from the owner's stated requirement in
the entire design set, and neither document says so in those terms.

**Consequence.** The first thing the owner sees is a config block that is one-fifth looser than
the object they love, with a settings toggle to get it back. Every user who never opens settings
uses the loose one forever.

**Fix.** Two options, and I prefer the second.

1. Keep 24px, and say plainly in `51` §8 that the default costs 20% of the card's density and why
   that is the right price. Honesty is cheap and the corpus is otherwise good at it.
2. **Put the padding on the interactive element and not on the row** — which `51` §8 already
   says it does (*"Padding goes on the interactive element, never on the row"*) and which `54`
   §8.4 then contradicts by putting `min-height: var(--row-min)` directly on `.cfg-line`, the row
   itself. If `51` §8's own sentence were implemented, the visual row could be 20px and the target
   24px via negative-margin padding, and there would be no trade at all. This is a two-line CSS
   change and it recovers the density for every user without touching conformance.

### 2.6 D-7 — The voice is specified for documents and not for the product

**File / section:** `.context/design-language.md` § *Voice*; `54` §1 (the eight-part entry
template); `54` §4 (authoring rules for tabs).

**The claim.** The design-language document devotes its longest section to voice — *"states the
failure mode, not the feature"*, *"names the misdiagnosis it prevents"*, *"ends sections with a
rule of thumb, not a summary"* — and says this voice *"is the `Teaching` depth in §5.4."*

**Why it is a gap.** `54` §1's per-component template has eight parts: Provenance, Anatomy, HTML,
CSS, States, Keyboard, Accessibility contract, Cost. There is no **Copy** part. The only place the
catalogue specifies product text as a first-class artifact is `54` §4's five authoring rules for
margin tabs and `54` §5's imperative table. Everything else — every button label, every empty
state, every confirmation, every error, every accessible name — is written ad hoc in the worked
examples, and the worked examples are inconsistent with the voice they cite. `54` §12's no-results
copy is excellent and in voice. `54` §14's `[ Acknowledge ]` / `[ Revoke ]` are generic. `55`
§4.4's generated utterance ordering is specified to the word; `54` §19's `Accept and re-emit` is
not specified anywhere as a string.

**Consequence.** The voice is the thing the owner will notice first and the only thing in this
list that cannot be recovered by a CSS change. A design system with a rigorous channel budget and
no copy budget produces a product that looks like the card and reads like software.

**Fix.** Add a ninth part to `54` §1: **Copy** — every user-visible string in the component,
authored, with the same corpus discipline invariant 10 applies to explainers. Then apply
design-language's five voice characteristics to it as a lint. `54` §12's empty-state string is the
worked example of what passing looks like.

---

## 3. What the design added that the card does not have

Challenged in order of how hard each is to justify.

### 3.1 D-8 — The `.pill`, which `51` §4.5 explicitly rejected, and which fails its own contrast rule

**File / section:** `54` §12 (`.pill`), §17; `51` §4.5; `54` §6 (contrast note).

**The claim.** `51` §4.5: *"The alternative — a `HEURISTIC` pill — was rejected because a pill is
a shape, shapes need a fill, a fill needs a colour, and the only colours available are reserved.
Every time this system is tempted toward a badge, the answer is a margin tab."*

**Why it is wrong.** `54` §12 defines `.pill` — `padding: 1px 5px`, `background: var(--*-wash)`,
`color: var(--*)`, `--t-micro` (10px), uppercase, tracked. That is a shape with a fill. It appears
in the finder on every result and in `54` §17's provenance panel on every expanded config line.
`51` §4.5's reasoning was that the fill needs a colour and the colours are reserved — but the pill
uses a *reserved* colour, so the letter of R1 holds and the spirit does not: `51` rejected the
badge as a **form**, and the form is back.

Worse, it breaks the contrast rule stated three sections earlier in the same catalogue. `54` §6
(Risk legend, Accessibility contract) says, correctly: *"`--caution` at `--t-micro` is never
permitted on `--surface` (4.71:1 is too close to the floor for 10px type) — the legend always sits
on `--page`."* `.pill.caution` puts `--caution` at `--t-micro` on `--caution-wash`. I computed
that pair: **4.73:1** — 0.02 from the value the same document just declared impermissible at that
size, and 0.23 from the AA floor.

**Consequence.** The product's most-used surface (`Ctrl+K`, "the feature people open ten times a
day") carries three-per-result 10px pills at the tightest contrast pair in the design, in a form
the token document rejected by name.

**Fix.** Delete `.pill`. The finder result already has a mono command line and a `--t-small`
answer line; the risk word goes at the end of the command line in the semantic ink at `--t-tab`
(11px) on `--page` — 5.19:1 for caution, which clears — with no fill and no box. That is what the
card does: the legend is words in ink, not chips.

### 3.2 D-9 — The legend's 14×10px solid swatch is not the card's legend

**File / section:** `54` §6 (`.swatch`); `.context/design-language.md` § *Palette*.

**The claim.** The extraction states each semantic as an `{ink, wash}` pair and gives the legend
as `READ-ONLY — SAFE ON PRODUCTION` rendered `#1F6F4A on #EEF5F1` — that is, **ink on wash**. The
role column for each ink reads *"Accent bar + label text."*

**Why it is wrong.** `54` §6 renders the legend as coloured text on `--page` with a separate
`14px × 10px` filled rectangle beside it. Both halves are inventions: the wash is dropped (the
legend item sits on `--page`), and a solid swatch block appears that the card does not have. The
card's own device for "here is what this colour means" is the **4px accent bar** — the thing
design-language calls out as device 2 and describes as *"never a box"*. A 14×10 filled rectangle
is a box.

**Consequence.** Small in isolation. Not small as precedent: the legend is the element `55` §3.1
calls *"the text alternative for the entire colour system"* and the element `54` §6 says the card
*"decided this trade four times out of four."* If the reproduction of the card's most disciplined
move is a re-drawing rather than a reproduction, nothing downstream is safe.

**Fix.** `.legend-item { background: var(--*-wash); border-left: var(--rule-accent) solid var(--*);
padding-left: var(--s2); color: var(--*); }` and delete `.swatch`. That is the card, exactly: a
4px bar, a wash, and the words. It also removes an `aria-hidden` element, which `54` §6's own
accessibility contract is currently apologising for.

### 3.3 D-10 — The 6px risk dot

**File / section:** `54` §8.4 (`.risk-dot`), §10, §16.2; `52` §3.4.2.

**The claim.** `51` §4.2 assigns risk *"6px swatch or 4px bar in the semantic ink."* `54` §8.4
implements a 6px square.

**Why it is questionable.** The card has no dots. It has accent bars, washes, hairlines and
ordinals. A 6px square in a gutter is the standard web-application status dot, and it is the one
place in the whole set where a component was chosen for its familiarity rather than derived from a
device on the card. `54` §22's audit column for the config block reads `**Risk** (dot)` without
comment.

It is also 6px at a 4px grid base (`51` §8: *"Eight steps, and no step between them is
available"*), sitting on `margin-top: 7px` — a value that appears nowhere in the token file.

**Consequence.** Mild, and it is the least serious item in this section. But `54` §19's entire AI
strategy rests on *the absence of this dot* being legible ("Rule 1 … the absence is itself a
signal"), which means the dot has to be an unmissable fixture of every config line. A 6px grey-out
square in a 34px gutter is not unmissable, and it is the wrong device to hang that much meaning on.

**Fix.** Make it the card's own mark: a 4px `--rule-accent` bar in the semantic ink on the line's
left edge, inside the block's gutter — which is exactly what `51` §4.3 says the collision rule is
(*"the config block's gutter is the risk channel"*) and which makes `54` §19's absence signal a
4px-wide hole rather than a 6px one. Snap the offset to `--s1`.

### 3.4 D-11 — A checkbox, a `✓`, and a `▲`, in a product that states four times that it has no icons

**File / section:** `54` §10 (verify ladder checkbox); `52` §8.5 (`▲` egress strip); `55` §1.4.

**The claim.** `55` §1.4: *"Meaning conveyed by an icon with no label | Why it cannot occur here:
There are no icons. `design-language.md`: 'No logos. No icons. No illustrations.'"* `52` §9.5
forbids *"Icons of any kind"*. `56` §5.1 says the diagram has *"no icons"*.

**Why it is wrong.** `54` §10 States: *"That variant adds a checkbox — the only checkbox in the
product … a 12px square with a 1px `--muted` border, and a `✓` in `--ink` when checked."* A `✓` in
a 12px box is an icon by any reading that makes `55` §1.4's claim meaningful. `52` §8.5's egress
strip opens with `▲`. `54` §9's sortable table appends `▴`/`▾`. `55` §6.3 adds a `↳` glyph for
wrapped continuations.

The checkbox has a second problem nobody costed: **12px square, in a product whose entire §8
argues about 24px targets.** `55` §6.5 walks through every target in the product and does not list
it. It fails SC 2.5.8 outright and it does not obviously qualify for the spacing or inline
exceptions, since it sits at the start of a `--s3`-gapped list item.

**Consequence.** The "no icons" claim is load-bearing in three documents' accessibility arguments.
It is false as specified, which means those arguments are unaudited.

**Fix.** The verify ladder does not need a checkbox. The card's own device for "I have done this
one" is the ordinal, and the product already has strikethrough (C9) and the `▸` gutter. Make a
completed step's ordinal struck and its text `--muted`; make the row itself the 24px target with
`aria-pressed`. Then restate `55` §1.4 as *"no pictorial icons; a small closed set of typographic
glyphs, enumerated in `54` §22"* and enumerate them — `▌ ▸ ▴ ▾ + − ~ · ! ↳ ▲ →` — because an
un-enumerated glyph set grows.

### 3.5 D-12 — A third floating layer, and a tooltip on every diagram node

**File / section:** `54` §17 ("The one exception: the diagram surface"); `56` §5.7 (`<title>`);
`51` §11; `55` §1.4, §4.5.1, §4.8.

**The claim.** `51` §11: *"There are no floating panels … A tooltip does not exist."* and
*"`z-index` is a three-value enum, declared here so nobody invents a fourth."* `55` §1.4: *"Content
hidden behind hover | Why it cannot occur here: There are no tooltips and no popovers."* `55`
§4.5.1 rejects `<title>` on shapes as an approach, giving as its first reason: *"`<title>` produces
a tooltip on hover."*

**Why it is wrong.** Two additions, in two documents:

1. `54` §17 adds `.prov[popover]` using the **native `popover` attribute**. The HTML top layer is
   above every `z-index`, so this is a fourth stacking layer created by an attribute rather than
   by the enum `51` §11 declared to prevent exactly that.
2. `56` §5.7's worked SVG puts `<title>Device SRX-345-DC-EAST, junos-srx, chassis cluster. Parsed
   11 months ago.</title>` on every node, and `56` §2.4 relies on it as the mitigation for label
   truncation: *"the full text is in the node's `<title>`."* That is a browser tooltip on hover,
   on up to 500 elements.

And the mitigation does not work for the users it is written for, because `55` §4.8 makes the
whole `<svg>` `aria-hidden="true"`. A `<title>` inside an `aria-hidden` subtree is not in the
accessibility tree. So the truncated-name mitigation is **mouse-hover-only** — which is the precise
failure `55` §1.4 lists as impossible.

**Consequence.** Three documents assert a property the fourth violates, and the violation lands on
the one interaction (`hover to see the truncated name`) that keyboard and screen-reader users
cannot perform.

**Fix.** Delete `<title>` from the SVG nodes; `56` §2.4's real mitigations (the Outline row, the
inspector, the digest) are already specified and already sufficient. For `54` §17's diagram
variant, do what `51` §11 says: it is a column, not an overlay. The diagram already has an
inspector (`54` §18); node provenance goes there, and the "one exception" disappears.

### 3.6 D-13 — `dashed` is claimed exclusive to AI and is used for deterministic form state

**File / section:** `51` §9, §4.8; `54` §2.4, §19.

**The claim.** `51` §9: *"**Nothing produced by the deterministic pipeline is ever drawn with a
dashed rule**, so a dashed rule anywhere on the screen means exactly one thing."* `54` §19 makes
the dashed border *"the primary visual signal because it is the only visual one that survives
forced colours."*

**Why it is wrong.** `51` §4.8's own validation table, five sections earlier, assigns
`unanswered, required` the treatment **"1px dashed `--hairline`"**. A required field nobody has
answered yet is produced by the deterministic pipeline. So the exclusivity claim is false inside
`51` itself.

`54` §2.4 then implements it a third way — `.field[data-state="unanswered"] input {
border-bottom-style: var(--rule-style-pending) }`, which is **dotted**. Three statements, three
answers: `51` §4.8 dashed, `51` §9 exclusive-to-AI, `54` §2.4 dotted.

**Consequence.** The signal that tells a user which parts of a firewall configuration were written
by a language model is specified as exclusive and is not. If `51` §4.8 ships as written, an
unanswered walkthrough field and an AI proposal carry the same border style on the same screen,
which is `54` §25 failure 4 arriving through the front door.

**Fix.** `51` §4.8's `unanswered` row changes to dotted, matching `51` §9's
`--rule-style-pending` and `54` §2.4's implementation. Then add the CI check `51` §3.3 already has
the pattern for: `dashed` may appear only inside selectors matching `.prop*`, `.dg-proposed`.

---

## 4. The contrast audit, recomputed

*margin tab: the real numbers, again*

Every ratio in `51` §3.4, `51` §5.5, `55` §2.2, `55` §2.3, `55` §2.6 and every simulated colour in
`55` §3.2 was recomputed from the hex values. Results.

### 4.1 What is correct

| Document | Table | Verdict |
|---|---|---|
| `51` §3.4 | Light: ink/muted/safe/caution/danger/hairline on page, surface, own wash | **All 16 figures exact** |
| `51` §5.5 | Dark: same shape | **All 18 figures exact** |
| `55` §2.2 | Light, with the `--surface-2` column added | **All 24 figures exact**, including the 1.28–1.32 hairline range |
| `55` §2.2/§2.3 | Adjacency pairs (3.117, 3.98, 2.381, 4.31) | **Exact** |
| `55` §2.4 F4 | Pairwise semantic contrast, both themes | **Exact** |
| `55` §3.2 | Protanopia and deuteranopia rows, both themes, all six hexes and all twelve ratios | **Reproduce exactly** under Viénot 1999 |
| `55` §3.2 | Achromatopsia rows: `#626262 #6D6D6D #4F4F4F` light, `#8E8E8E ×3` dark | **Exact** |
| `51` §5.2 | The five solved reds at 4.6 / 5.5 / 6.0 / 7.0 / 8.19 | **Exact to 0.01** |
| `51` §7.3 | Every font metric | **Exact against the binaries** |
| `51` §2 | Page geometry, pt→px, wrap analysis | **Exact against the field card** |

This is unusually good work and the review should say so before it says the rest.

### 4.2 D-14 — `55` §2.3's dark own-wash column is wrong for caution and danger, and contradicts `51`

**File / section:** `55` §2.3; `55` §2.1.

**The claim.** `55` §2.1: *"Every figure below was computed … independently of `51` §3.4. Where
the two documents agree, they agree to the second decimal."* `55` §2.3 then gives dark own-wash
figures of **5.15** for `--caution` and **5.14** for `--danger`.

**Why it is wrong.**

| Pair | `51` §5.5 | `55` §2.3 | Recomputed |
|---|---|---|---|
| `--safe` `#35A06E` on `#132019` | 5.13 | 5.13 | **5.13** |
| `--caution` `#D97328` on `#29180E` | 5.22 | **5.15** | **5.22** |
| `--danger` `#EA6260` on `#271817` | 5.22 | **5.14** | **5.22** |

`51` is right; `55` is wrong; and the two documents do *not* agree to the second decimal, which
makes the independence claim in `55` §2.1 false as printed. The conclusions survive (5.13 is still
the worst dark pair, so `55` §2.4's verdict row is unaffected), but the audit's own credibility
statement does not.

**Consequence.** `55` is the document a security reviewer or a procurement accessibility
questionnaire will be pointed at. Two wrong figures in the table headed *"the real numbers"*, in a
document that opens by claiming independent verification, is the kind of thing that costs the
whole set its credibility in a review where you do not get to explain.

**Fix.** Correct the two cells to 5.22. Then implement `55` §2.7's `every_permitted_pair_clears_aa`
test *and generate the tables from it*, so the document cannot drift from the code again. A
hand-typed contrast table in a document that also specifies a CI check for contrast is a
self-inflicted wound.

### 4.3 D-15 — CRITICAL: `prefers-contrast: more` makes contrast **worse** for light-theme users

**File / section:** `55` §2.6, closing CSS block; `55` §7.4.

**The claim.** `55` §2.6 ships an AAA-conformant token set behind `prefers-contrast: more`,
described as *"solved, not eyeballed"*, and `55` §2.7 specifies a CI test
`contrast_more_clears_aaa`.

**The code, as printed:**

```css
@media (prefers-contrast: more) {
  :root:not([data-theme="dark"]) {
    --muted: #48525D; --safe: #015E3A; --caution: #843E00; --hairline: #878C91;
  }
  :root[data-theme="dark"], :root:not([data-theme="light"]) {
    /* dark AAA set, see the table above */
  }
}
```

**Why it is wrong.** The second rule's selector list contains `:root:not([data-theme="light"])`,
which matches whenever no explicit theme has been chosen — the default state of every fresh
workspace. It is not nested inside `@media (prefers-color-scheme: dark)`. So a user on a light
screen, with no explicit theme, who has set "Increase contrast" at the operating-system level,
matches **both** rules; the dark block is later, so it wins; and the dark AAA tokens land on
`--page: #FFFFFF`.

Recomputed, that is what they get:

| Token | Value applied | On `--page` `#FFFFFF` | On `--surface` | Requirement |
|---|---|---|---|---|
| `--muted` | `#9DA9B4` | **2.40** | 2.17 | 4.5 |
| `--safe` | `#53BA86` | **2.40** | 2.18 | 4.5 |
| `--caution` | `#F58C46` | **2.41** | 2.18 | 4.5 |
| `--danger` | `#FF827D` | **2.40** | 2.18 | 4.5 |
| `--danger` on its own light wash `#F8EFEF` | | **2.13** | | 4.5 |

**Consequence.** The user who explicitly asked the operating system for more contrast is moved
from a worst pair of 4.71:1 to a worst pair of **2.13:1** — a Level AA failure on every semantic
token and every margin tab in the product, including `DISRUPTIVE — DROPS LIVE TRAFFIC`. This is a
regression of roughly 2.2× in the wrong direction, delivered *only* to low-vision users, by the
feature written for them.

**And the specified CI check cannot catch it.** `55` §2.7 tests "four token sets: light, dark,
light-more, dark-more" — each set against its own grounds, in isolation. The defect is in the
**cascade**, not in any set. `contrast_more_clears_aaa` passes.

**Fix.** Two changes, both one line.

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

And the CI check has to move from token sets to **rendered cascade**: compute the resolved value of
each token under each of the eight (theme × contrast × forced-colors) states in a headless browser,
then assert. That is `55` §2.7's real specification and it is not what §2.7 currently says.

### 4.4 D-16 — `55` §3.2's tritanopia row does not reproduce, and the dark table drops it silently

**File / section:** `55` §3.2.

**The claim.** Light theme, tritanopia: `--safe` `#1F6F4A` → `#5353BC`; `--caution` `#A8571B` →
`#878700`; `--danger` `#8C2F2F` → `#6A6A00`, ratios 1.64 / 1.09 / 1.49.

**Why it is wrong.** Under the Viénot 1999 single-plane projection — the method the section names,
and the method whose protan and deutan rows reproduce exactly — the tritan row computes as
`#2E6B6B`, `#AA5151`, `#8C2F2F`, ratios 1.18 / 1.33 / 1.57. Nothing near the published values.
`#5353BC` is a saturated blue-violet standing in for a mid green; tritanopes confuse blue/green
and yellow/violet, and a green does not become violet under any standard simulation.

The section carries a VERIFY comment correctly noting that Viénot's single-plane form is invalid
for tritanopia — but the numbers printed are not the single-plane form either, so the caveat does
not explain them.

Separately: the **dark** table in the same section has four rows and no tritanopia row at all, with
no note saying why. A reader comparing the two tables will assume the dark theme was not tested
against tritanopia; a reader who does not compare will not notice.

**Consequence.** Contained — the section's three conclusions rest on the protan, deutan and
achromatopsia rows, which are all correct, and conclusion 1 ("best mutual separation under any
deficiency is 1.82:1") is unaffected. But it is a fabricated-looking number in a document whose
value is that its numbers are real, and `.context/conventions.md` says *"Never fabricate a
reference, a benchmark number, or a vendor behaviour."*

**Fix.** Either delete both tritan rows and say the method does not support them (which the VERIFY
already argues), or re-run with Brettel's two-plane method or Machado 2009's severity-parameterised
matrices, for **both** themes, and print what comes out.

### 4.5 D-17 — `55` §2.6's "worst CR" column is stated as solved and is 0.03–0.13 off

**File / section:** `55` §2.6.

**The claim.** *"Solved, not eyeballed. For each token: hold the OKLCh hue … and move lightness
until the token clears 7:1 against every ground it is permitted to land on."* The tables print
7.01 / 7.01 / 7.00 / 7.25 / 3.00 (light) and 7.00 ×4 / 3.00 (dark).

**Recomputed worst permitted ground:**

| Token | Printed | Actual |
|---|---|---|
| light `--muted` `#48525D` | 7.01 | **7.04** |
| light `--safe` `#015E3A` | 7.01 | **7.12** |
| light `--caution` `#843E00` | 7.00 | **7.13** |
| light `--hairline` `#878C91` | 3.00 | **3.08** |
| dark `--muted` `#9DA9B4` | 7.00 | **7.02** |
| dark `--caution` `#F58C46` | 7.00 | **7.08** |
| dark `--danger` `#FF827D` | 7.00 | **7.11** |
| dark `--hairline` `#626870` | 3.00 | **3.04** |

**Consequence.** Low. Every value clears its threshold, so nothing is broken. It is listed because
a table of values all reading exactly `7.00`/`7.01` reads as *computed*, and readers will treat
neighbouring numbers with the same trust. Precision that was not measured is a claim.

**Fix.** Print the computed values, or print `≥ 7.0` and stop implying three significant figures.

### 4.6 D-18 — `51` §5.4 mis-states the prototype's `--danger` by 24%, and the misstatement is the whole argument

**File / section:** `51` §5.4, repeated in `51` §18 and `54` §28 note 2.

**The claim.** *"`--danger: #D07A78` there is at 7.4:1 and is the pink failure mode described in
§5.2."*

**Why it is wrong.** Against the prototype's own dark page `#101316` (`design/prototype/index.html`
line 67), `#D07A78` computes to **5.98:1**. Against the new dark page `#0F1215` it is **6.03:1**.
Not 7.4:1 by any pairing I can find.

And the argument does not survive the correction. `51` §5.2's case is that *preserving paper
contrast parity* (8.19:1) forces pink, and its own table labels 5.5–6.0 as "bright red". The
prototype's value sits at 5.98 — inside that band — and its OKLCh lightness is 0.672 against the
chosen `#EA6260`'s 0.667. **They are the same lightness.** The real difference is chroma: 0.108
versus 0.170. So the prototype's value is not "the pink failure mode of §5.2"; it is the same
lightness at lower saturation, which is a defensible-but-duller choice, and the correct criticism
of it is `51` §5.3 M4 (colourfulness falls with luminance), not §5.2.

**Consequence.** A document supersedes a prototype file on the strength of a measured number, and
the number is wrong by 24% in the direction that makes the argument work. The conclusion (adopt
`#EA6260`) is still right, for a different reason. But this is the one place in the set where a
number appears to have been produced to fit a conclusion, and it is repeated in two other
documents.

**Fix.** Correct to 5.98:1 in all three places and restate the reason: the prototype's value is
under-chromatic at that lightness, per M4, and reads grey-red on a dark ground. That argument is
true and is available.

### 4.7 Smaller arithmetic

| # | File / § | Claim | Actual | Consequence |
|---|---|---|---|---|
| D-19 | `51` §7.4 | All-caps mono at `0.96em` runs *"3.4% taller"* than surrounding capitals | **1.7%** — `0.96 × 0.7290 / 0.6880 = 1.0172` | The `.m-caps` exception is justified by a number twice its real size. The exception is still worth having; the justification is not what it says |
| D-20 | `51` §7.8 | `--measure: 68ch` *"≈ 460px at 13px"* | **491.6px** — `68 × 0.55615 × 13` | 7% wide. `51`'s own §7.3 gives the `0` advance it needed. Prose measure is 76ch-equivalent, not 68 |
| D-21 | `51` §5.3 M4 | *"Boost chroma 20–45% over paper"* | **20–34%** — its own next clause says `1.20–1.34×`, which is right | Self-contradiction in one sentence |
| D-22 | `51` §5.4 | dark `--hairline` at OKL **0.295**; dark `--surface` at **0.220**; dark `--ink` at **0.913** | **0.310 / 0.225 / 0.916** | The derivation record is what a future editor re-solves from. It should be re-derivable |
| D-23 | `51` §5.3 M2 | dark `--ink` `#DFE4E8` is *"the ink hue at OKL 0.913"* | hue **241.7°**, not the ink's 248.2° | `51` §3.1 sets its own tolerance at 5°; this is 6.5° and is the one neutral that misses it |
| D-24 | `52` §9.6 | The header budget is *"at most 14 discrete facts … Currently: [enumeration]. That is at the ceiling"* | The enumeration as written sums to **18** (1+1+1+1+3+1+3+6+1) | The budget is already exceeded by 29% on the day it was written, and the document says it is at the ceiling |

---

## 5. Dark theme — should this product have one?

*margin tab: the honest answer*

**`51` §5.1's argument is the best-written section in the design set and its answer is wrong.**

Not because dark themes are wrong. Because *this* dark theme, as specified across `51`, `55` and
`56`, is not one theme with two palettes. It is **two visual languages**, and the documents
discover this incrementally without ever adding it up.

### 5.1 What the dark theme actually costs, assembled from the documents' own admissions

| Cost | Source | Assessment |
|---|---|---|
| The severity ramp must change **encoding**, not just values — tone in light, width in dark | `55` §2.5 F3: `--ink` vs `--muted` is 2.381:1 in dark and fails 1.4.11 | Verified: 2.381. This is a second visual grammar for the product's most-scanned list |
| The three risk colours become **one colour** under achromatopsia and on any monochrome output | `55` §3.2: `#8E8E8E` ×3, verified exact | In light they are 1.18/1.34/1.58 apart — poor but non-zero. In dark, zero |
| The diagram does not participate at all | `56` §5.7 emits `fill="#FFFFFF" stroke="#5C6772"` and `fill="#14171A"` as literal presentation attributes | See D-25 below |
| Print forces light regardless | `51` §13.3 | Correct, and it means the product's export-a-field-card feature — the thing that closes the loop with the artifact — never sees the dark theme |
| A second contrast surface forever | `51` §5.1's own case-against | It also doubles the cascade-state count that D-15 shows is already untested |
| The staleness channel needs a permanent text fallback in dark | `56` §8.1 property 2 | `--ink`/`--muted` at 2.38:1 cannot carry the freshness step, so `--dg-age { display: block }` at every zoom — the dark diagram is permanently noisier |

### 5.2 D-25 — The diagram is theme-blind, and this is the fact that decides the question

**File / section:** `56` §5.7, §9.3; `51` §3.3 (`tokens/no-raw-hex`).

**The claim.** `56` §5.7 presents *"One node and one edge, exactly as the builder produces them"*
with hard-coded `#FFFFFF`, `#5C6772`, `#14171A`.

**Why it is wrong.** Those are the **light** token values. `51` §3.3's `tokens/no-raw-hex` check
exists precisely to prevent this, and the diagram is exempted by being SVG presentation attributes
rather than a stylesheet — which is a loophole, not an argument. Under `prefers-color-scheme:
dark` the page is `#0F1215` and the diagram draws white boxes with near-black text on it: legible,
inverted relative to everything around it, and the single most visually prominent element on the
screen fighting the theme.

`56` cannot simply switch to `var()`, either, because `56` §9.3's export must freeze concrete
values into a file that leaves the workspace, and `34` §5.6's closed tag set forbids `<style>`.
So the diagram needs **two** resolutions of every colour — live (theme-aware, via `class` +
stylesheet) and exported (frozen light) — which nobody has specified.

**Consequence.** In dark mode the product has a light-mode diagram. On a five-view product where
one view is `render(graph)`, that is 20% of the surface area not themed.

**Fix.** Draw the live tree with `class` only and resolve colour in the stylesheet from tokens;
serialise the export by resolving each class against the **light** token set explicitly, and state
in the export header that exports are light-only (which the plaintext banner in `56` §9.3 already
has room for). That is one function, and it also satisfies `55` §7.3's forced-colours rules, which
currently assume class-based styling that `56` §5.7 does not use.

### 5.3 The recommendation

**Ship the dark theme only if all three of these land. Otherwise ship light only, and say why.**

1. **One severity encoding in both themes.** `55` §2.5 F3 already recommends this ("width in both,
   and delete the tone ramp"). Take it. Two grammars is the cost that makes the theme a second
   design rather than a second palette.
2. **The diagram themes** (D-25). A themed product with an unthemed primary view is worse than an
   unthemed product.
3. **The cascade is tested as a cascade** (D-15), not as four isolated token sets.

If any of the three is not funded, the honest position is the one `51` §5.1's *case against* makes
and then talks itself out of: **the card is a printed artifact, ink on paper, with a fixed white
point, and this product is a reproduction of it.** The 02:00-NOC argument is real, and it is
answered more cheaply and with no second grammar by a **single dimmed light palette** — reduce the
page from `#FFFFFF` toward `#F2F4F6`-ish luminance, hold every ink/wash *relationship* — or by
telling the user their operating system and browser already have a dark filter that will not
require Fathom to maintain a parallel design.

### 5.4 D-26 — `51` §5.1's strongest supporting citation does not exist

**File / section:** `51` §5.1, case-for item 1.

**The claim.** *"This is not a preference, it is the actual deployment environment named in §6.7
of the owner's brief (change-window work)."*

**Why it is wrong.** Owner brief §6.7 is *Verification and rollback generation*. In full it says
the tool can emit the verify ladder and rollback for a specific change, that this is the Bring-Up
Order block generated per-change, and that it *"makes the tool legible to change-management
processes."* It names no deployment environment, no NOC, no lighting condition and no time of day.
The brief nowhere describes where the product is used.

**Consequence.** `.context/conventions.md`: *"Never fabricate a reference."* This is a citation to
the owner's own document, in support of the most expensive open decision in the design set, for a
claim that document does not make. It is the kind of thing that, if the owner checks one citation,
they will check this one.

**Also in the same section, item 2:** *"There is no server to remember a preference … `prefers-color-scheme`
is the only signal available."* `51` §5.6, one page later: *"The theme choice is workspace-local
and lives in `Settings` (`17-workspace-format.md`)."* The product stores the preference. The
argument is void by the same document.

**Fix.** Delete the citation and make the argument on its own merits, which are adequate: engineers
work change windows at night, terminals are dark, and a 992px white sheet beside a dark terminal is
a flashbulb. That is true and needs no reference.

---

## 6. The AI surface — genuinely different, or a cheat?

*margin tab: the question the owner asked*

**Answer: it does not invent a fourth colour, and it deserves credit for that. But the signal it
nominates as primary is not exclusive, and the two devices that actually work are the two it
demotes.**

`54` §19 lists five devices and ranks them: the dashed border is *"the primary visual signal
because it is the only visual one that survives forced colours"*; the banner text and the ARIA
label are *"the ones that always work"* but are treated as the fallback.

Three problems, in order.

1. **Dashed is not exclusive** — D-13 above. `51` §4.8 assigns dashed to an unanswered required
   field. Until that is corrected, the primary signal is shared with deterministic form state.
2. **The hatch dies under forced colours** and `54` §19's own table says so. So under forced
   colours the visual signal is a border-style difference at 1–2px, on a screen where every colour
   has collapsed to `CanvasText`. That is thin.
3. **The device that actually carries it is `Rule 1` — the absence of the risk dot — and it is
   listed nowhere in the five-device table.** `54` §19 states it as a rule and then does not count
   it as a signal. It is the best idea in the section: every deterministic config line in the
   product has a coloured mark in the gutter; a proposal has a hole. That is a categorical
   difference, it survives forced colours (there was nothing to override), it survives print, it
   survives monochrome, and it survives colour-vision deficiency — because the difference is
   *presence*, not hue.

**Where it does cheat, mildly.** `.prop { background: var(--surface-2) }` plus
`.prop-cfg { background: var(--page) }` inside a page whose default ground is `--page` means the
proposal's own config block is the *same ground as the rest of the page* and one step lighter than
the surrounding proposal — i.e. proposed config is drawn on a **lighter** ground than emitted
config (`--surface`). Lighter reads as *cleaner*. `54` §19's cost section is proud that the surface
is *"the ugliest thing in the product"*; the ground assignment quietly works against that.

**Fix.**

- Promote the absent risk dot to device 0 in `54` §19's table, with its own row and its own
  survival column (`yes/yes/yes` — and it is the only device that scores three yesses).
- Draw proposed config on `--surface`, the same ground as emitted config, so the only differences
  are the ones that are *supposed* to be differences: the dash, the hole in the gutter, and the
  banner.
- Fix D-13 so the dash means one thing.
- Keep everything else. `54` §19 Rule 2 (the `#`-prefixed clipboard payload) is genuinely good and
  is the kind of detail that makes a security reviewer trust the rest.

---

## 7. The diagram — card idiom, or generic network diagram?

*margin tab: better than expected*

**Answer: it is in the card's idiom, and it is the strongest document in the set.** `56` §2.4's
decision that every label is mono — derived from the impossibility of `<foreignObject>` and then
justified four independent ways — is exactly how the card would have solved it. §4.4's zone
bracket with three tiers of degradation, §4.6's conduit-instead-of-dashed-line (forced by `51`
§9's dash reservation and, as the document says, better than the dash would have been), §4.2's
reth-versus-LAG bracket asymmetry, and §5.2's channel budget are all real design rather than
network-diagram convention. There are no clouds, no router icons, no colour, and no legend of
shapes.

Three findings.

### 7.1 D-25, above — it does not theme.

### 7.2 D-27 — Layer bands, brackets and boxes are five geometric forms doing what a legend would

**File / section:** `56` §5.2 G7, §4.3–§4.5.

**The claim.** G7: *"Band form | vertical bracket / horizontal bracket / closed box | Zone / VLAN /
routing instance"*, and §4.5: *"Orientation is the only difference, and it is enough to tell a VLAN
band from a zone bracket at a glance without a legend."*

**Why it is questionable.** It is not enough, and the document half-knows it — §4.4 tier 2 labels
brackets `WAN 1/3`, `WAN 2/3`, and tier 3 abandons brackets for per-unit stubs. So the reader must
distinguish: vertical bracket (zone), horizontal bracket (VLAN), closed box (routing instance),
site band, device box, half-height open-right box (external peer), 4px stub (tier-3 zone), plus
conduit / two-rail / one-rail edges and bracket-both-ends versus bracket-one-end. That is ten
geometric forms with no legend, in a product whose central discipline is that **the one legend it
has appears on every screen unchanged**.

The card's answer to "what is this thing" is never geometry. It is a word.

**Consequence.** The picture is beautiful and unlearnable without documentation, which is the one
failure mode the card was built to avoid.

**Fix.** Not a legend of shapes — that would be worse. Use the device the card actually uses:
**every band, bracket and box already has a label; make the label carry the kind.** `WAN` becomes
`zone WAN`; `inet.0` is not drawn anyway; a VLAN band reads `vlan 10`. Three extra characters,
lowercase, in the label that is already there, and G7 stops carrying meaning alone. `56` §5.5
already sets band labels at `--t-micro` uppercase tracked; the kind prefix goes in lowercase, which
is the margin-tab register and reads as the aside it is.

### 7.3 D-28 — `56` §8.1 property 2 quotes a contrast figure that fails in the theme it is discussing

**File / section:** `56` §8.1.

**The claim.** *"`--muted` on `--page` is 5.77:1, comfortably above 1.4.11's 3:1 for a meaningful
graphic, and `--ink` vs `--muted` is 3.12:1 in light."* Both verified correct (5.77, 3.117).

**Why it is incomplete.** In dark, `--muted` on `--page` is 6.16:1 (fine) but `--ink` vs `--muted`
is 2.381:1, and the document says so in the next clause — then fixes it by forcing the age label on
at every zoom. That is the right fix. What it misses: `56` §5.2 G1 is *"the only unallocated
channel"* in the diagram's budget, and in dark it is not a usable channel at all. So the dark
diagram has **nine** channels, not ten, and G1's meaning is carried entirely by G8 (the second
label line) — which §5.3 also drops below zoom 0.6 in light and must therefore never drop in dark.
The document does say this. What it does not do is update §5.2's budget table, which still lists G1
as carrying freshness unconditionally.

**Fix.** Add a theme column to `56` §5.2's channel table. G1: light only. It is a two-cell change
and it makes the budget honest.

---

## 8. The IA — usable, or six views bolted to a nav bar?

*margin tab: this is where the geometry stops closing*

**Answer: the model is good and the geometry does not close.** `52` §5's selection type, `Facet`,
`OffscreenReason` and the narrow-never-widen decision are genuinely strong — `OffscreenReason` in
particular is the difference between a linked product and six pages. `52` §1.1's separation of six
projections from six views is correct and is the kind of thing most products never work out.

Then three arithmetic problems break it.

### 8.1 D-29 — CRITICAL: the card's two-column grid cannot render at the sheet width derived for it

**File / section:** `51` §7.8, §8 (`--sheet: 1180px`, `--bp-cols: 860px`); `54` §18
(`.workbench { grid-template-columns: 1fr 420px }`); `52` §2.3, §2.4.

**The claim.** `51` §7.8: *"`--sheet: 1180px` exists because a two-column grid at that width holds
exactly 73 columns of `--t-mono`, and the emitter wraps at 72. It is not a round number chosen for
taste."* `51` §8: *"`--bp-cols: 860px` — two columns collapse to one below this."*

**The arithmetic.** `54` §18 gives the inspector a fixed 420px column at `--s6` (32px) gutter,
inside the same sheet, with `--s5 × 2` (48px) of sheet padding:

```
1180 − 48 (sheet padding) − 420 (inspector) − 32 (gutter)  =  680px for the main region
680px  <  860px (--bp-cols)
```

Therefore, **at the canonical sheet width with the inspector open, the main region is below the
two-column breakpoint and the card's two-column grid never renders.** The 1180px number was derived
from a two-column mono requirement that the layout it sits in cannot satisfy. `54` §18's own cost
section computes 700px and 93 mono columns and concludes config blocks "survive" — which is true
for a *single* column and is not the property `51` §7.8 derived the width for.

It gets worse in combination. `52` §2.3 adds a *pinned second pane* (50/50 or 62/38) as a separate
mechanism, and argues against three panes because *"three panes at 1280px gives each 400px, which
is below the card's own column width (~360pt ≈ 480px) and the type stops working."* With `54`'s
inspector present, a pinned split gives 680/2 = **340px per pane** — below the number `52` itself
says breaks the type — and `52` never mentions the inspector at any point in 1,639 lines.

**Consequence.** Two documents specify two different second surfaces (a 420px inspector column and
a pinned 38–50% pane), neither knows about the other, and the union of them destroys the geometry
both are built on. The card's most recognisable structural feature — *"two columns, ~360pt each,
744pt content width"* — is unreachable in the default configuration.

**Fix.** Settle it once, and the answer follows from the card:

1. **The inspector and the pinned pane are the same surface.** There is one second column. `52`
   §2.3's ratios (62/38) applied to 1132px of content give 702/430 — which is `54` §18's 420px
   inspector to within a rounding step. They already agree; nobody noticed.
2. **The card's two-column grid is a property of a single view's body, not of the sheet.** At
   1180px with a second column open, the body is 680px and renders one mono column of 72ch (541.9px)
   with room to spare. Two columns of card content require the second surface closed, and that is
   fine — the card is a *reading* artifact and the inspector is an *editing* one.
3. **Re-derive `--sheet` honestly.** Either state it as `550 + 32 + 420 + 48 = 1050px` for the
   working layout and `1180px` for the reading layout, or keep 1180 and say plainly that two
   columns require the inspector closed. `51` §7.8's current derivation is a coincidence presented
   as a consequence.

### 8.2 D-30 — The furniture above the body is roughly twice the size both documents claim

**File / section:** `52` §2.2; `54` §3 cost.

**The claim.** `52` §2.2: *"Everything above the body is 8 lines of text and 4 rules. Measured at
`51`'s type scale that is about 150 px on a desktop."* `54` §3 cost: the masthead alone is
*"~110px … On a 900px-tall laptop viewport that is 12% of the screen."*

**The arithmetic, from `54`'s own CSS:**

| Element | Declarations | px |
|---|---|---|
| `.masthead` border-top + padding-top | `--rule-mast` 3 + `--s3` 12 | 15 |
| `.eyebrow` | `--t-tab` 11px at inherited `--lh-step` 20 | 20 |
| `h1` | margin `--s3` 12 + `--lh-title` 24 + margin `--s1` 4 | 40 |
| `.subtitle` | `--t-small` at `--lh-step` | 20 |
| `.imperative` | margin `--s3` 12 + padding `--s3` 12 + border 1 + line 20 | 45 |
| **masthead subtotal** | | **140** (`54` claims ~110) |
| `.legend` | margin `--s3` 12 + border 1 + padding `--s2` 8 + line 20 + padding 8 + border 1 | 50 |
| `.rail` | margin `--s5` 24 + padding 8 + line 16 + padding 8 + border-bottom 3 + rail border 1 | 60 |
| ribbon (`52` §9.4) | line 20 + hairline 1 + `--s2` 8 | 29 |
| **total** | | **≈ 279px** |

Below 1100px `52` §2.4 wraps the view band to two lines: **+32px → ≈ 311px.** With the egress strip
armed (`52` §8.5 / `54` §20's 32px band): **≈ 343px.**

**Consequence.** On the 1280×800 laptop `52` §2.1 uses to argue against a left rail, 279px is
**35% of the viewport height**, permanently, before any content. `52` §2.1's rejection of a left
nav rests on the comparison *"a left rail costs 200px horizontally **and** a header costs 60px
vertically, in every application that has both"* — a comparison the sheet loses once the real
number is used. `52` §11 failure 4 predicts *"header creeps to 300px"* as a future risk; it is the
shipping specification.

**Fix.** Three of the four elements can go without touching the card.

- **The ribbon is the masthead subtitle.** `52` §9.4's ribbon (`selected: IkeGateway GW-B · 6 lines
  in config …`) and `54` §3's `.subtitle` (`SRX-A · WORKSPACE dc-east · junos-srx 21.4R3`) are the
  same fact at two heights. Merge them: −29px.
- **The eyebrow and the view band are the same control.** `VIEW 3 OF 6 · FINDINGS` and a band whose
  current tab is `▸findings · 3 high` are redundant. The card's `SIDE n ·` line *is* its navigation,
  because you turn the card over. Keep the band, delete the eyebrow: −20px.
- **The legend does not need `--s3` above it and `--s2` inside it.** The card's legend sits between
  two 1px rules with the tightest leading on the sheet: −20px.

That is 210px, which is 26% of an 800px viewport — still large, honest, and defensible, and it
should be stated as 210 rather than as 150.

### 8.3 D-31 — The view band is specified two incompatible ways and the reconciliation misses it

**File / section:** `52` §9.3; `54` §11; `54` § *Reconciliation with `52`*.

**The claim.** `52` §9.3: *"One row of margin tabs under the legend. **Lowercase, unpunctuated,
muted, italic** — exactly the card's `read this first` / `most-missed` treatment. Current view in
ink, **not boxed and not underlined**; the `▸` marker is a character, not a shape."*

`54` §11 CSS: `text-transform: uppercase; letter-spacing: var(--track-label); font-weight: 700;` and
`.rail button[aria-selected="true"] { border-bottom-color: var(--ink) }` with
`border-bottom: var(--rule-mast)` — a **3px underline**, described in `54` §11's Provenance as
*"the masthead rule, reused at the one place a second 3px rule is justified."*

Lowercase italic versus bold tracked uppercase. Not underlined versus a 3px underline. Margin-tab
register versus tab-bar register.

`54`'s closing *Reconciliation with `52`* section enumerates three divergences (severity treatment,
severity levels, suppression reason) and asserts agreement on the egress indicator. It does not
mention the navigation.

**Consequence.** The single most-looked-at control in the product has two specifications, and the
document whose job is reconciliation says the two documents diverge on three points. It is four,
and this is the visible one. `52`'s version is the card's; `54`'s is a tab bar. Whichever ships,
the reconciliation section is now known to be incomplete, which means the other three entries are
also unaudited.

**Fix.** Take `52`'s. `54` §11's own Provenance section admits it is inventing (*"New. The card has
four sides and you turn it over"*), and its justification — a second 3px rule — spends `51` §9's
scarcest weight (*"Three uses, product-wide"*) on navigation chrome. `52`'s treatment costs nothing,
is the card's own device, and keeps the 3px rule meaning "a new sheet starts here". Then re-run
`54`'s reconciliation properly against all of `52`.

### 8.4 D-32 — The egress indicator: two specifications, and `54` claims they agree

**File / section:** `52` §8.5; `54` §20, § *Reconciliation*.

**The claim.** `54`'s reconciliation: *"One point where the two agree and it is worth recording
that they arrived there separately: the egress indicator sits above the 3px masthead rule."*

**Why it is wrong.** They agree on *position* and nothing else.

| Property | `52` §8.5 | `54` §20 |
|---|---|---|
| Form | *"a 1px strip"* opening with `▲` | Full-bleed inverted band, `--ink` ground, `--page` text, 3px `--ink` bottom rule |
| Sticky | not stated; it is sheet furniture in the §2.2 diagram | `position: sticky; top: 0; z-index: var(--z-egress)` — *"the only sticky element in the product"* |
| Height | one line | 32px, per `54` §20 cost |
| Glyph | `▲` | none |
| Focus order | not stated | `Disarm` is *"the first focusable element in the document, before the skip link"* |

`54` §20's version is the right one and its reasoning (inversion is the only device with no second
meaning, and it survives forced colours exactly) is sound. `52`'s `▲` also violates the no-icons
rule (D-11). But *"they agree"* is false, and the disagreement includes whether the product's only
sticky element exists.

**Fix.** `54` §20 wins; `52` §2.2 and §8.5 are amended to match, including deleting `▲`; the
reconciliation table gains a fourth and fifth row.

### 8.5 Is the IA usable? Yes — with one structural caveat

Setting the geometry aside, the model works. Six surfaces over one `Selection` with one `epoch`,
`resolve` as a pure function, `select_at` returning `ElementId`s only, and `OffscreenReason` as a
first-class return value is a real architecture and it answers the question the brief poses ("one
graph, six views") rather than restating it. `52` §5.5's worked `st0.0`-in-three-views example is
the proof, and it is convincing.

The caveat is `52` §2.5's own first cost: *"Switching is a keystroke you have to know."* With
`54` §11's tab bar that is false (they look like tabs); with `52` §9.3's margin tabs it is true
(they look like annotations, because the entire point of the margin tab is that it looks like an
annotation). The design cannot have both the card's register and a discoverable navigation, and
§8.3's fix chooses the register. That is the right choice for this owner, and the honest statement
of what it costs is: **a first-time user will not find five of the six views without pressing `?`.**
`52` §2.5 says this and then mitigates it away by pointing out the tabs are `role="tab"` with 24px
targets. Being a `role="tab"` does not make something look like a tab. Say the cost and keep it.

---

## 9. Cross-document contradictions

*margin tab: four maps, one keyboard*

### 9.1 D-33 — CRITICAL: four incompatible keyboard maps, one of which removes the safety modifier from accepting an AI change to a firewall

**File / section:** `53` §3 (*"The keymap, in full"*); `54` §23 (*"Product-wide keyboard map … Every
global binding, in one place, so conflicts are visible"*); `52` §3.8, §4.3, §6.5; `55` §4.5.6.

Four documents each publish a complete or product-wide keymap. They conflict as follows.

| Binding | `53` §3 (owns the keymap) | `54` §23 / §15 / §19 | `52` | `55` §4.5.6 | Verdict |
|---|---|---|---|---|---|
| Switch view | `⌥1`…`⌥6` | **`Ctrl+1`…`Ctrl+6`** | `⌥1`…`⌥6` | — | 3-way, `54` is the outlier |
| Set explainer depth | `⌥\` or `v` | **`Ctrl+1/2/3`** (§15) **and** `Ctrl+Shift+1/2/3` (§23) | `V` | — | `54` contradicts *itself*, and its §15 binding collides with its own §23 view-switch |
| **Accept AI proposal** | **`⇧A`** — §3.8: *"Every action that … commits a security decision requires Shift plus its letter"* | **`A`** (§19, §23) | — | — | See below |
| Reject AI proposal | `⇧R` | `R` | — | — | Same |
| Decline one proposal op | `d` | — | — | — | `54` §23 has no `d` |
| `n` | next filter match (§3.2) | next changed diff line (§23) | — | — | Collision |
| `p` | cycle platform filter (§3.4) | previous changed diff line (§23) | — | — | Collision |
| `u` | **unsuppress** a finding (§3.4) | toggle unchanged diff context (§23) | — | — | Collision |
| `g` | **sequence prefix** — `g g` = first (§3.2) | — | — | **go to connection** (§4.5.6) | Collision, and `55` §4.5.6 also specifies **type-ahead** in the same list, so `g` is a command *and* a search character in one widget |
| `i` | inspect provenance (§3.4) | `Ctrl+I` focuses the inspector (§23) | — | — | Different actions, similar mnemonic |
| `/` | not bound | focus in-view filter (§23) | — | — | `53` uses `⌘F` for the same thing |
| `Esc` in a roving list | unwind one level of the §3.7 ladder | *"collapse all disclosures; second press moves focus to the container"* (`54` §2.5) | — | *"moves focus to the container's own heading"* (`55` §5.6) | 3-way |

**The one that matters.** `53` §3.8 states a safety principle and applies it: *"Every action that
removes data or commits a security decision requires `Shift` plus its letter, and none of them is
on a single key."* `⇧A` accepts checked proposal ops, and `53` §3.5 adds *"`Enter` never accepts a
whole proposal … `21` §15's failure mode 4 — proposal fatigue, accepting without reading — is a
real risk and the friction is the mitigation."*

`54` §19 and §23 bind bare **`a`** to Accept. The mitigation `53` designed is removed by the
component catalogue, and `54` §19's keyboard table reasons about it (*"only when focus is inside
the region, and only after the region has been focused once"*) without knowing `53` exists.

**Consequence.** In a product whose output is pasted into production firewalls, one document makes
"apply an unvalidated model-generated change" a single unmodified letter and another makes it a
shifted letter with a checked-op precondition and a note requirement. Implementation will pick one
at random. `54` §23's own header — *"so conflicts are visible"* — is the exact claim being falsified.

**Fix.**

1. **`53` owns the keymap. Say so in `52`, `54`, `55` and `56`'s companion-document lines, and
   delete the maps in `54` §23, `54` §15, `54` §19 and `55` §4.5.6, replacing them with pointers.**
   A single-source keymap is the only structure in which conflicts are actually visible.
2. Resolve the four genuine collisions in `53`: `n`/`p`/`u` need scoping (`53`'s focus rule
   already provides the mechanism — diff-scoped `n`/`p`/`u` only when focus is inside a diff
   block); `g` cannot be both a sequence prefix and an Outline command with type-ahead in the same
   widget — the Outline's graph traversal moves to `⌥→` / `⌥←`, which are free inside a list.
3. Keep `⇧A` / `⇧R`. `53` §3.8's principle is right and it is the only place in the design set
   where a keyboard binding is treated as a security control.
4. Add the check: a CI test that parses every `<kbd>` table in `docs/50-design/` and fails on any
   key bound to two actions in overlapping scopes. This is fifty lines and it is the reason to
   have a single map.

### 9.2 D-34 — `53` §12.3 forbids `aria-live="assertive"` "ever"; `54` and `55` require exactly one

**File / section:** `53` §12.3; `54` §20; `55` §4.6, §10 failure 4.

**The claim.** `53` §12.3, final row of its announcement table: *"Nothing, ever | `aria-live="assertive"`.
**There is no event in this product that justifies interrupting somebody.**"*

`55` §4.6: *"Egress armed / disarmed | **`alert`** | none | `Egress armed. 3 requests to
sync.example.com.` **The only `alert` in the product**"* — and `55` §10 failure 4's fix reads *"One
`alert` in the product and it is egress."* `54` §20 implements it: `<div class="vh" role="alert"
id="egress-arm-alert">`, with a paragraph explaining why two live regions are *"the only correct way
to do this."*

`role="alert"` has an implicit `aria-live="assertive"`.

**Consequence.** Flat contradiction on an accessibility mechanism, between documents that cite each
other. One of the two behaviours ships. If `53` wins, the product has no interruption when egress
arms — which `55` argues is *"the one thing worth interrupting for, because it is the one thing that
changes what leaves the machine"*, and I agree with `55`. If `54`/`55` win, `53` §12.3's absolute
statement is false and a reviewer reading `53` will believe something untrue about the product.

**Fix.** `55` is right. `53` §12.3's last row becomes *"exactly one: the egress-armed transition
(`55` §4.6). Nothing else, ever."*

### 9.3 D-35 — Three documents each name a different "only motion in the product"

**File / section:** `51` §12; `55` §7.1; `53` §12.5; `52` §5.6.4.

| Document | Claim |
|---|---|
| `51` §12 | *"**There is one animation in this product.** Inline disclosure panels … fade in over 90ms, opacity only."* `--motion-state: 0ms`, everything else `Never` |
| `55` §7.1 | *"One animation product-wide: a 90 ms opacity fade on inline disclosure"* |
| `53` §12.5 | *"`prefers-reduced-motion: reduce` disables **the only motion in the product** (smooth scrolling, §10.3)"* |
| `52` §5.6.4 | *"Scrolling uses `behavior: 'instant'` when the distance exceeds two viewport heights and `'smooth'` otherwise"* |

There are **two** motions: a 90ms opacity fade and smooth scrolling. Each of three documents
asserts that its one is the only one.

**Consequence.** Minor in itself; diagnostic of the real problem, which is that these six documents
were written in parallel and each treats itself as the whole design. Where they overlap they do not
check.

**Fix.** `51` §12's property table gains a row for scroll behaviour, citing `52` §5.6.4's rules, and
the "one animation" sentence becomes "one animation and one scroll behaviour". `53` §12.5 and `55`
§7.1 point at it.

### 9.4 D-36 — CSS that cannot run: `opacity` transitions from `display: none`

**File / section:** `54` §13 (`.f-body`), §17 (`.prov`); `51` §12.

**The claim.** `51` §12: the product's single animation is a 90ms opacity fade on inline
disclosure. `54` implements it twice:

```css
.f-body { opacity: 1; transition: opacity var(--motion-disclosure) var(--motion-ease); }
.f-body[hidden] { display: none; }
```

```css
.prov { opacity: 1; transition: opacity ...; }
.prov[hidden] { display: none; }
```

**Why it does not work.** An element going from `display: none` to `display: block` is not
transitioned by the CSS engine unless `transition-behavior: allow-discrete` is set on `display`
*and* a `@starting-style` rule supplies the initial `opacity: 0`. Neither is present. The elements
start at `opacity: 1` in both states, so there is nothing to interpolate even if the display change
were animatable.

**Consequence.** The product's only animation does not run. Which is, in fairness, fine — `51` §12
says disabling it *"loses nothing"* — but it means `51` §12, `55` §7.1, `55` §1.1's AAA claim for
SC 2.3.3, and `54` §13/§17's States tables all describe behaviour that is not implemented, and the
first person to notice will "fix" it by adding a height transition, which `51` §12 forbids by name.

**Fix.** Either implement it properly —

```css
.f-body { transition: opacity var(--motion-disclosure) var(--motion-ease),
                      display var(--motion-disclosure) allow-discrete; }
@starting-style { .f-body { opacity: 0; } }
```

— or delete the transition declarations and `--motion-disclosure`, and state in `51` §12 that the
product has **no** animation at all. The second is more in the card's spirit and removes a token,
a media query and two failure modes. I would take the second.

### 9.5 D-37 — `55` §1.1 claims WCAG 2.2 AA "in full" and AAA 2.4.13, against a documented focus exception

**File / section:** `55` §1.1, §5.3; `54` §12, §22, §26.

**The claim.** `55` §1.1: *"the product targets WCAG 2.2 Level AA **in full**, plus five named AAA
criteria"*, including **2.4.13 Focus Appearance (AAA)**, with `55` §5.3 stating *"We meet it in
every mode, with a factor of five of margin."*

**Why it is false as specified.** `54` §12 removes the focus indicator from the finder input:

```css
#q:focus-visible { outline: none; }   /* the shell IS the focus indicator here */
```

`54` §22 records it as an audited exception: *"the only component in the product where C4 is not
the focus channel."* `54` §26 lists it as open and marks it VERIFY.

The stated substitute does not substitute. The shell's 1px `--ink` border is present whenever the
dialog is **open**, regardless of where focus is. `54` §12's keyboard table says `Tab` cycles
*"input → footer links → input"* — so focus leaves the input while the border stays identical.
Nothing on screen changes when the input gains or loses focus except the caret, and a caret is not
a focus indicator for a component (it indicates a text insertion point, and it blinks). That is a
failure of **SC 2.4.7 Focus Visible (Level AA)**, not merely of 2.4.13 (AAA).

Second problem in the same component: `54` §12's footer contains two `<span class="tab">` elements
and `54` §4 states categorically that *"a tab is never focusable and never a link."* So the "footer
links" the Tab cycle depends on do not exist, and the focus trap has exactly one stop.

**Consequence.** The AA-in-full claim is the sentence a procurement questionnaire or a VPAT will
quote. It is false, in the product's most-used surface, by the design set's own record.

**Fix.**

- Give the finder input a real indicator. The double-draw `54` §26 worries about is avoided by
  inverting the input row instead: `#q:focus-visible { background: var(--surface); }` plus a 2px
  `--ink` bottom rule on `.finder-input-row`. That is the card's own vocabulary and it is 1px away
  from nothing, not 1px away from the shell border.
- Fix the trap: the footer's two spans become a real `<button>` (`open the guidebook entry`) or the
  keyboard table stops claiming a cycle.
- `55` §1.1 changes to *"targets AA in full; one known exception is tracked at `54` §26 and blocks
  the claim until closed."* An accessibility document whose value is honesty cannot have one
  optimistic sentence at the top.

### 9.6 D-38 — `52` §3.5.1 and `54` §13 specify finding severity two different ways; the reconciliation covers it, one document does not change

**File / section:** `52` §3.5.1; `54` §13; `54` § *Reconciliation*.

Recorded here for completeness because `54`'s reconciliation table **does** catch this one and
proposes the right answer (take `54`'s four-tone left bar; `52`'s three-level top rule conflates
`suppressed` with a severity). The finding is that `52` was never amended — it still specifies a
2px top rule and three levels plus `suppressed`, and `52` §14 says *"None with the conventions"*
and does not mention the proposal.

**Fix.** Amend `52` §3.5.1 to point at `54` §13, or record the proposal in `52` §14 as received.
A reconciliation offered and never accepted is two specifications with a note.

---

## 10. Would it feel, in use, like the object the owner loves?

*margin tab: the honest answer*

**No. Close, and no.**

Sit in front of it as specified. Here is the first screen, assembled from the documents:

- 279px of furniture before any content — a masthead, a subtitle, an imperative, a three-item
  legend, a band of six tabs and a selection ribbon — on an 800px laptop, so 35% of the viewport is
  identification.
- One column, not two, because the inspector took 420px and dropped the body below `--bp-cols`.
- Config lines at 24px in a 20px grid, so the block is a fifth looser than the card's.
- No continuation backslashes, because `Display` is the default.
- Between eight and thirty margin tabs, in 11px muted italic, carrying dates and provenance.
- Four different 4px bars meaning four different things.
- A pill on every finder result.
- A tab bar with a 3px underline, if `54` wins; annotations, if `52` does.

Everything on that list is individually defensible and the list is not the card. The card's feeling
comes from three properties, and the design set preserved the first, weakened the second and lost
the third:

| Property | Status |
|---|---|
| **Restraint of palette** — three colours, no fourth, ever | **Kept, rigorously.** This is real and it is the hardest one |
| **Restraint of device** — six devices, each meaning one thing | **Weakened.** Six devices, each meaning four things |
| **Density** — small, tight, two columns, no air | **Lost.** One column at 83% density with 279px of furniture |

### What would have to change

Six things. All are specified above; none requires a new idea; four are CSS.

1. **`--row-min` moves onto the interactive element, not the row** (D-6 fix 2). Recovers the card's
   20px grid at no conformance cost. `51` §8 already says this is the rule; `54` §8.4 does not do it.
2. **`Terminal` wrap becomes the default** (D-5). Recovers the backslash.
3. **Settle the second column once** (D-29): one second surface, 62/38, and state plainly that the
   card's two-column body requires it closed. Recovers the two-column grid for reading.
4. **Cut the furniture to ~210px** (D-30 fix): merge ribbon into subtitle, delete the eyebrow, tighten
   the legend. Recovers 12% of the viewport.
5. **Budget the margin tab at three per region** (D-1) and move row metadata into the hairline table
   the catalogue already specifies. Recovers the card's voice in its most characteristic device.
6. **One meaning per 4px bar** (D-2), one meaning per `▸` (D-2a). Recovers R3, which is the rule the
   whole channel budget exists to enforce.

Do those six and the answer changes to yes. Do none of them and the product is a competent,
unusually restrained, well-reasoned web application in the card's colours — which is the outcome
this review exists to name before it ships.

---

## 11. Findings index, ranked

Severity is this reviewer's, on the design lens only. `high` means it changes the product the owner
receives or makes a false claim a third party will rely on.

| # | Severity | Finding | File / § |
|---|---|---|---|
| **D-15** | **high** | `prefers-contrast: more` cascade drops light-theme users to 2.13–2.41:1; the specified CI check cannot catch it | `55` §2.6, §2.7 |
| **D-33** | **high** | Four incompatible keymaps; `54` binds bare `a` to Accept-AI-proposal where `53` requires `⇧A` as a safety control | `53` §3, `54` §23/§15/§19, `55` §4.5.6 |
| **D-29** | **high** | The card's two-column grid cannot render at `--sheet` with the inspector open; 1180px derivation is void; `52` and `54` specify two unaware second surfaces | `51` §7.8, `54` §18, `52` §2.3 |
| **D-6** | **high** | Default density is 20% looser than the card, and `51` §8's own rule for avoiding it is not implemented | `51` §8, `54` §8.4 |
| **D-37** | **high** | WCAG 2.2 "AA in full" and AAA 2.4.13 claimed against a documented SC 2.4.7 failure in the finder | `55` §1.1, `54` §12/§22 |
| **D-5** | **high** | Continuation backslashes — a named card device — off by default; `53` and `54` contradict | `54` §8.2, `53` §6.3.1 |
| **D-30** | **high** | Furniture is ≈279px, not the claimed ~150px; the left-rail rejection rests on the wrong number | `52` §2.2, `54` §3 |
| **D-2** | med | 4px bar carries six meanings; R3 audit records two exceptions and misses four | `51` §4.2, `52` §5.2, `54` §22 |
| **D-1** | med | Margin tab industrialised into a badge system; authoring rules violated by the catalogue's own examples | `54` §4/§13/§14/§17/§18 |
| **D-25** | med | The diagram emits literal light-theme hex; it does not theme, and export needs two resolutions | `56` §5.7, §9.3 |
| **D-13** | med | `dashed` claimed exclusive to AI; `51` §4.8 uses it for unanswered fields; `54` §2.4 implements dotted | `51` §4.8/§9, `54` §2.4 |
| **D-31** | med | View band specified two incompatible ways; `54`'s reconciliation misses it | `52` §9.3, `54` §11 |
| **D-14** | med | `55` §2.3's dark own-wash figures wrong for caution/danger, contradicting `51` and its own independence claim | `55` §2.3 |
| **D-34** | med | `53` forbids `aria-live="assertive"` "ever"; `54`/`55` require exactly one | `53` §12.3, `54` §20, `55` §4.6 |
| **D-8** | med | `.pill` is the badge `51` §4.5 rejected by name, at 4.73:1 — the size/ground pair `54` §6 declares impermissible | `54` §12, `51` §4.5 |
| **D-2a** | med | Inside a config block, `▸` means hover, expanded and selected; the ground channel is already spent | `54` §8.4–8.6, `51` §4.6 |
| **D-36** | med | The product's only animation cannot run as written (`opacity` transition from `display:none`) | `54` §13/§17, `51` §12 |
| **D-12** | med | A fourth stacking layer via native `popover`, and a hover-only tooltip on every diagram node inside an `aria-hidden` subtree | `54` §17, `56` §5.7, `55` §1.4/§4.8 |
| **D-26** | med | `51` §5.1 cites owner brief §6.7 for a claim it does not make; and its "no server to remember a preference" is void by §5.6 | `51` §5.1 |
| **D-18** | med | Prototype `--danger` stated at 7.4:1; actual 5.98:1; the argument that supersedes the prototype depends on the wrong number | `51` §5.4, §18, `54` §28 |
| **D-11** | med | A `✓` checkbox (12px, fails 2.5.8, unlisted in `55` §6.5), `▲`, `▴`/`▾`, `↳` — in a product that claims four times to have no icons | `54` §10, `52` §8.5, `55` §1.4 |
| **D-4** | low | The one-line imperative repurposed as unsaved-state indicator | `52` §7.2 |
| **D-16** | low | `55` §3.2's tritanopia row does not reproduce; the dark table drops the row silently | `55` §3.2 |
| **D-9** | low | Legend rendered as coloured text + 14×10 swatch, not the card's ink-on-wash + accent bar | `54` §6 |
| **D-27** | low | Ten geometric band/box/bracket forms with no word attached | `56` §5.2 G7 |
| **D-32** | low | `54` claims the two egress specifications agree; they agree on position only | `54` §*Recon*, `52` §8.5 |
| **D-35** | low | Three documents each name a different "only motion in the product" | `51` §12, `53` §12.5, `55` §7.1 |
| **D-24** | low | `52` §9.6's own header-fact enumeration is 18 against a stated ceiling of 14 | `52` §9.6 |
| **D-10** | low | The 6px risk dot is the one component chosen for familiarity rather than derived from the card | `54` §8.4 |
| **D-28** | low | `56` §5.2's channel budget lists G1 unconditionally; it is light-theme only | `56` §5.2, §8.1 |
| **D-19** | low | `51` §7.4's "3.4% taller" is 1.7% | `51` §7.4 |
| **D-20** | low | `--measure: 68ch` is 491.6px, not "≈460px" | `51` §7.8 |
| **D-21** | low | "Boost chroma 20–45%" contradicts its own "1.20–1.34×" | `51` §5.3 |
| **D-22/23** | low | Four OKL values in the dark derivation record do not re-derive; dark `--ink` misses `51` §3.1's own 5° hue tolerance | `51` §5.3, §5.4 |
| **D-17** | low | `55` §2.6's "worst CR" column implies three significant figures it does not have | `55` §2.6 |
| **D-3** | low | The imperative/voice has no Copy section in the component template | `54` §1 |
| **D-38** | low | `52` §3.5.1 never amended after `54`'s reconciliation proposal | `52` §3.5.1, §14 |

---

## 12. Method and sources

**Recomputed independently for this review:**

- Every WCAG 2.x contrast ratio in `51` §3.4, §5.5, `55` §2.2, §2.3, §2.6 and `56` §8.1 —
  linearised sRGB, `0.2126R + 0.7152G + 0.0722B`, `(L₁+0.05)/(L₂+0.05)`.
- Every OKLCh coordinate in `51` §3.1, §5.2, §5.3, §5.4 — standard M1/M2 matrices.
- Every dichromat simulation in `55` §3.2 — Viénot, Brettel & Mollon (1999) single-plane
  projection in linear sRGB, and achromatopsia as WCAG relative luminance rendered neutral.
- Every font metric in `51` §7.3, §7.4, §7.8 and `56` §2.4 — `fontTools` against
  `/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf` and
  `/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf`, `unitsPerEm` 2048 in both. DejaVu's OS/2
  is version 1 and carries no `sxHeight`/`sCapHeight`, so `x` and `H` glyph `yMax` were read
  directly: 1120 and 1493, matching `51` §7.3.
- The card's own wrap statistics in `51` §2, against `.context/field-card-srx-ipsec.txt`.
- Every geometric derivation in `51` §2, §7.8, §8 and every layout sum in `52` §2.2, `54` §3, §18.
- The prototype's dark palette, from `design/prototype/index.html` lines 48–79.

**Not verified — no web access was available in this session.** The following are cited as fact by
the documents and could not be checked here. All three are already marked `VERIFY` in place, which
is the correct handling, and none of them is load-bearing for a finding above:

| Claim | File |
|---|---|
| Firefox has not shipped `@page` margin boxes as of early 2026 (Bugzilla 1854974) | `51` §13.5 |
| `print-color-adjust` is Baseline 2025 with a `-webkit-` prefix for older engines | `51` §13.3 |
| CSS Anchor Positioning shipped in Chromium ahead of other engines | `54` §17 |
| Liberation 2.x ships under SIL OFL 1.1 rather than GPL+font-exception | `51` §7.2 |

`51` §7.2's licence VERIFY should be closed before v1 regardless of this review: bundling five font
faces into a distributed single-file artifact is a redistribution, and the build's licence file is
a shipping obligation, not a documentation one.

**Documents read in full for this lens:** `.context/owner-brief.md`, `.context/conventions.md`,
`.context/design-language.md`, `.context/field-card-srx-ipsec.txt`,
`docs/50-design/51-design-tokens.md`, `52-information-architecture.md`,
`53-interaction-and-keyboard.md`, `54-component-catalog.md`, `55-accessibility.md`,
`56-diagram-view.md`, `design/prototype/index.html`.

## 13. Disagreements

None with `.context/conventions.md`. Two notes on adjacent material.

**1. `55` §2.5 F3's WCAG framing is over-claimed, though its recommendation is right.** F3 asserts
that two severity bars in different rows must clear SC 1.4.11's 3:1 *against each other*. 1.4.11
measures a graphical object against its **adjacent** colours — the colours physically touching it —
and two 4px bars separated by a row hairline and the page ground are not adjacent to one another.
The dark theme does not fail 1.4.11 for this reason. It fails to be *usable*, which is a better
argument and does not need a criterion number attached to it. The recommendation — width in both
themes, delete the tone ramp — is correct and should be adopted, on the usability argument alone.
Attaching a conformance failure that will not survive an auditor's reading weakens a good call.

**2. `54` §28 note 1 is right and should be generalised.** The assignment named a "provenance
popover"; `54` specified an inline disclosure because `51` §11 forbids elevation, kept the name and
changed the behaviour. That is the correct way to handle an inherited term. It should be applied to
the two other inherited terms in the set that were kept without being re-derived: **"tab"** in
`54` §11 (which the card does not have, and which `52` §9.3 correctly renders as a margin tab), and
**"badge"** in `54` §12's `.pill` (which `51` §4.5 rejected and which came back under a different
name). Keeping a word and changing the thing is good discipline. Keeping a word and importing the
thing is how a design language ends.
