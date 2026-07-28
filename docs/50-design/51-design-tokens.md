# 51 — Design tokens

> **Status:** Proposed

Companion documents: `docs/50-design/54-component-catalog.md` (what these tokens build),
`docs/10-core/13-emitters-and-provenance.md` §13 (wrapping, which sets the mono measure),
`docs/10-core/12-rule-engine.md` §10–11 (`Severity`, `Confidence`, `FindingState`,
`Suppression` — the states this document must render without colour),
`docs/10-core/18-diff-verify-rollback.md` §2.6 (diff rendering, already decided there),
`docs/30-security/34-browser-hardening.md` (CSP — why there is no font CDN).

Source of truth for every value: `.context/design-language.md`, machine-extracted from the
owner's four-side SRX IPsec field card, plus direct measurement of the two font binaries and
direct arithmetic on the card's page geometry. Where a number here was derived rather than
extracted, the derivation is shown. Where it was chosen, it says so.

The owner's constraint, in full:

> *"I'm going to provide the style I want, though it's very bare bones there's something I
> love about it."*

**The bare-bones quality is the requirement, not the starting point.** This document exists
to make it systematic. Every token below either appears in the card or is forced by
something that does. There is no token here whose justification is "design systems usually
have one."

---

## 0. Contents

| § | |
|---|---|
| 1 | Three rules that govern the whole set |
| 2 | Where the numbers come from — the card's geometry, solved |
| 3 | Colour — light |
| 4 | The channel budget — expressing eleven states in three neutrals |
| 5 | Dark theme — should it exist, and how it was derived |
| 6 | Forced colours and the Windows high-contrast path |
| 7 | Type |
| 8 | Space |
| 9 | Borders and rules |
| 10 | Radius — the token whose value is zero |
| 11 | Elevation — none |
| 12 | Motion — one animation in the whole product |
| 13 | Print — closing the loop with the artifact |
| 14 | The complete token file |
| 15 | Failure modes of this token system |
| 16 | Open decisions |
| 17 | Sources consulted |
| 18 | Disagreements |

---

## 1. Three rules that govern the whole set

**R1 — The three risk colours are reserved.** `#1F6F4A`, `#A8571B`, `#8C2F2F` and their three
washes mean exactly one thing each, forever: what a *command* does to a live box
(`ReadOnly | ChangesConfig | Disruptive`). They may not be reused for finding severity, for
status, for diff, for selection, for validation, for AI provenance, or for the egress state.
This is conventions §"The risk enum", restated because it is the single constraint that
shapes everything in §4.

**R2 — No component may encode meaning in colour alone.** Every risk-coloured element carries
the word as well, either visible or in a visually-hidden span. This is WCAG 1.4.1, and it is
also the only thing that keeps the risk semantics alive in Windows high-contrast mode, where
`background-color` and `color` are both overridden by the user agent (§6).

**R3 — One channel, one owner, per component.** There are a small number of visual channels
available: left-edge bar (weight × tone × style), ground, outline, gutter glyph, type weight,
type case, underline. Each channel has exactly one meaning inside a given component. A design
that lets two meanings share a channel produces a screen nobody can read under pressure, and
this product is read under pressure. §4 is the assignment table.

---

## 2. Where the numbers come from — the card's geometry, solved

The extraction gives four geometric facts: a 744pt content width, ~360pt columns, 3px and 1px
rules, and 4px accent bars (described in the source as `36 562 3 234 re f`, a 3-unit-wide
filled rectangle).

Those numbers are not arbitrary. Solve them:

```
360pt + 24pt + 360pt = 744pt          two columns, one gutter
744pt + 24pt + 24pt  = 792pt          content plus symmetric margins
792pt × 612pt        = US Letter, landscape
```

**The card is US Letter landscape with 24pt margins.** 792 × 612pt is Letter rotated; 744 is
what is left after 24pt each side; two 360pt columns leave exactly 24pt of gutter. Every
geometric token in this document falls out of that page:

| Card measurement | pt | px @96dpi | Token |
|---|---|---|---|
| Page margin / column gutter | 24 | 32 | `--s6` |
| Column width | 360 | 480 | `--col` |
| Content width | 744 | 992 | `--sheet-card` |
| Accent bar | 3 | 4 | `--rule-accent`, and the base space unit |
| Masthead rule | 2.25 | 3 | `--rule-mast` |
| Hairline | 0.75 | 1 | `--rule-hair` |

The 3-unit accent bar is why the base space unit is **4px** and not 8px. A design system that
starts at 8px cannot draw this card's most characteristic device.

**The mono measure, measured from the card itself.** Of 91 command lines in the source text,
23 carry a continuation backslash. The longest wrapped line including its backslash is 51
characters (`set security ike gateway GW-B dead-peer-detection \`); the longest surviving
unwrapped line is 62 (`set security ipsec vpn-monitor-options interval 10 threshold 5`).
The card therefore does **not** wrap at a fixed column — it breaks at a syntactic boundary and
the threshold sits somewhere in the 51–62 range. Continuation indent is exactly two spaces,
every time.

`13-emitters-and-provenance.md` §13.3 sets `WrapPolicy::default() = Display { cols: 72 }` with
a two-space continuation indent. The indent agrees with the card. The column does not: 72 is a
terminal convention, the card's is a column-width consequence. **The emitter wins**, because
the wrap is a rendering property and the user may be pasting into an 80-column session. The
token `--cfg-cols: 72` exists so the two documents cannot drift apart silently, and §7.8 shows
how the sheet width was chosen to hold 72 columns of mono in a two-column grid.

---

## 3. Colour — light

### 3.1 Neutrals

Five extracted values plus one derived. Named by role, never by hue — there is no `--grey-400`
in this system, because the day someone needs a seventh grey is the day the discipline breaks.

```css
--ink:       #14171A;   /* 162 uses in the source. Body, headings, rules, the 3px masthead. */
--muted:     #5C6772;   /* 152 uses. Secondary prose, table labels, margin tabs, footers.   */
--surface:   #F2F4F6;   /*  54 uses. Code-block and table-zebra ground.                     */
--hairline:  #D2D7DD;   /*  34 uses. 1px rules, cell borders, block edges.                  */
--page:      #FFFFFF;   /*  16 uses. Ground.                                                */
--surface-2: #FAFBFC;   /* derived. One step above --surface: hover, zebra, inert ground.   */
```

`--ink` is not black. That matters more than it sounds: `#14171A` at OKLCh L=0.203 with a
faint blue cast (h≈248) is what makes the hairlines and the washes sit in the same family
instead of looking like three unrelated systems. `--surface`, `--hairline` and `--muted` all
share that hue within 5°. `--surface-2` was picked on the same hue axis, at OKL 0.988.

`--surface-2` is the only invented neutral in the set. It exists because the card, being
paper, gets hover states for free (a finger) and a screen does not.

### 3.2 The three semantic pairs

```css
--safe:    #1F6F4A;   --safe-wash:    #EEF5F1;   /* ReadOnly      */
--caution: #A8571B;   --caution-wash: #FBF3EA;   /* ChangesConfig */
--danger:  #8C2F2F;   --danger-wash:  #F8EFEF;   /* Disruptive    */
```

Named by role, not by hue, for a reason that will matter in §5: on a dark ground `--danger`
is not dark and `--safe` is not the same green. If the tokens were `--green` / `--amber` /
`--red` the dark theme would either lie or fork.

The pairing is `{ink, wash}` and the pair is atomic — `--safe` is only ever used on `--page`,
`--surface` or `--safe-wash`, never on `--caution-wash`. There is no `--safe-border`,
`--safe-hover`, `--safe-subtle`. The card has two values per semantic and so does this.

### 3.3 The reservation rule, stated as a lint

R1 is enforceable, not aspirational. Two checks belong in CI:

| Check | Rule |
|---|---|
| `tokens/reserved-colour` | The identifiers `--safe`, `--caution`, `--danger` and their washes may appear only inside selectors matching `.r-safe`, `.r-caution`, `.r-danger`, `.risk-*`, `.hit-risk.*` (M29 — `.pill` is deleted), `.note.safe\|caution\|danger`, `.legend-*`. Anywhere else is a build failure. |
| `tokens/no-raw-hex` | No hex literal may appear in any stylesheet outside `51-design-tokens.css`. |

The second check is what stops the first from being routed around.

### 3.4 Measured contrast — light

Computed, not estimated. WCAG 2.x relative-luminance formula.

| Foreground | on `--page` | on `--surface` | on own wash |
|---|---|---|---|
| `--ink` `#14171A` | **17.99** | 16.32 | — |
| `--muted` `#5C6772` | **5.77** | 5.24 | — |
| `--safe` `#1F6F4A` | **6.12** | 5.55 | 5.53 |
| `--caution` `#A8571B` | **5.19** | 4.71 | 4.73 |
| `--danger` `#8C2F2F` | **8.19** | 7.43 | 7.25 |
| `--hairline` `#D2D7DD` | 1.45 | 1.31 | — |

Everything that carries text clears WCAG AA (4.5:1) on every ground it is permitted to land
on. Nothing clears AAA (7:1) except `--ink` and `--danger`. **`--caution` on `--surface` at
4.71:1 is the tightest pair in the product** and it is 0.21 above the floor. Consequence: no
component may put `--caution` text on `--surface` at a size below `--t-small` (12px) without
bolding it, and the `tokens/contrast` CI check should assert the pair rather than trust it.

**`--hairline` at 1.45:1 against the page fails WCAG 1.4.11 (non-text contrast, 3:1) if it is
ever the sole visual indicator of a control.** This is the card's most beautiful device and
its biggest accessibility liability, and it is not fixable by darkening the hairline without
destroying the look. The resolution is structural, not chromatic:

| Hairline used as | Allowed? | Because |
|---|---|---|
| Separator between table rows | Yes | Decorative; the table's structure is carried by `<table>` semantics |
| Edge of a static block | Yes | Decorative |
| Border of an input, button, or any interactive control | **No** | 1.4.11 applies. Use `--muted` (5.77:1) or `--ink` (17.99:1) |
| Focus indicator | **No** | Focus is `--ink`, always (§4.7) |
| The only thing distinguishing a selected row | **No** | Selection carries a gutter glyph as well (§4.6) |

That table is the honest answer. It costs the design a slightly heavier input border than the
card's own hairlines would suggest. It is the right trade.

---

## 4. The channel budget — expressing eleven states in three neutrals

R1 forbids colour for everything except risk. The product still has to render, simultaneously
and legibly:

- `Severity` — `info | low | medium | high` (`63-rulepack-spec.md`)
- `Confidence` — `definite | probable | heuristic` (same)
- `FindingState` — `Active | Pending | Suppressed | Superseded` (`12-rule-engine.md` §10.2)
- diff sign — added / removed / changed / unchanged (`18-diff-verify-rollback.md` §2)
- `DeltaClass` — `Tighten | Loosen | Neutral | Unknown` (same, §2.4)
- selection
- keyboard focus
- hover
- field validity — valid / unanswered / invalid
- provenance class — deterministic / AI-proposed
- the egress state

Eleven axes, no colour. This is the design problem the reservation rule creates and it is the
most substantive section of this document.

### 4.1 The available channels

| # | Channel | Values it can carry | Cost of using it |
|---|---|---|---|
| C1 | Left edge bar, 4px, **tone** | `--ink` / `--muted` / `--hairline` / none | 4 levels, ordinal, reads at a glance |
| C2 | Left edge bar, **style** | solid / dashed / hatched | 3 levels, categorical; hatch is expensive to read at small sizes |
| C3 | **Ground** | `--page` / `--surface-2` / `--surface` | 3 levels; collides with hover if hover also uses ground |
| C4 | **Outline**, 2px offset −2px | present / absent | 1 bit only |
| C5 | **Gutter glyph**, mono | `+ − ~ · ▸ !` and ordinals | n levels, but consumes 3ch of width |
| C6 | Type **weight** | 400 / 700 | 1 bit |
| C7 | Type **case + tracking** | sentence / uppercase-tracked / lowercase-italic | 3 registers |
| C8 | **Underline** of a label | none / 1px dotted `--hairline` / 2px solid `--ink` | 3 levels |
| C9 | **Strikethrough** | present / absent | 1 bit |
| C10 | **Margin tab** — a lowercase muted word | free text | unlimited, but only 1–3 words |

C10 is the card's own device and it is the release valve. The card uses `approx`, `DF ping`,
`not VPN-specific` to tell you *how to weight* something without spending a heading on it.
That is exactly the job that a colour-coded badge does in a conventional interface, and it is
better at it, because a word is unambiguous and a hue is a convention you have to learn.

### 4.2 The assignment

Read this as the contract. §54 implements it component by component.

| Axis | Channel | Encoding |
|---|---|---|
| **Risk** (`ReadOnly/ChangesConfig/Disruptive`) | colour (reserved) + C10 | 6px swatch or 4px bar in the semantic ink, **plus the word**, visible or visually-hidden |
| **Severity** | C1 | `high` = 4px `--ink`; `medium` = 4px `--muted`; `low` = 4px `--hairline`; `info` = no bar, row hairline only |
| **Confidence** | C10 | `definite` = nothing; `probable` = margin tab `probable`; `heuristic` = margin tab `heuristic, may be wrong` |
| **FindingState** | C2 | `Active` = solid bar; `Pending` = dotted bar; `Suppressed` = hatched bar + C9 on the title; `Superseded` = row collapses to one muted line, no bar |
| **Diff sign** (line level) | C5 + C3 | `+` added on `--surface-2`; `−` removed on `--page` with C9; `~` changed on `--surface-2`; `·` unchanged on `--page` |
| **Diff** (field level) | — | Already decided in `18-diff-verify-rollback.md` §2.6: `--muted` before → `--ink` after, `→` in muted, `tighten`/`loosen` as a margin tab. Not re-specified here. |
| **Selection** | C5 + C3 | `▸` in the gutter + `--surface` ground. Never a coloured bar — that channel belongs to severity/risk |
| **Focus** | C4 | 2px solid `--ink`, offset −2px inside bordered controls, +2px outside borderless ones. **The only outline in the product.** |
| **Hover** | C3 | one step of ground: `--page` → `--surface-2`, `--surface` → `--page` (inverted inside code blocks, which is what the prototype already does) |
| **Validation** | C8 + C5 | valid = 1px `--hairline` underline; unanswered = 1px dashed `--hairline`; invalid = 2px `--ink` underline + `!` gutter glyph + message in `--ink` bold |
| **Provenance class** | C2 | deterministic = solid rules everywhere; AI-proposed = **dashed** border + hatched 4px gutter. Nothing deterministic in this product is ever drawn with a dashed rule. |
| **Egress armed** | inversion | `--ink` ground, `--page` text, full bleed, sticky. **Inversion is used nowhere else.** |

### 4.3 Why severity gets the bar and risk gets the colour

They are never in the same component. Risk annotates *emitted config lines* (a property of a
command). Severity annotates *finding rows* (a property of a rule firing). A config line has
no severity; a finding row has no risk — except inside its `remediation`, which is emitted
config and therefore carries risk legitimately, in a nested config block that has its own
gutter.

If they ever did collide, the rule is: **the config block's gutter is the risk channel; the
containing row's left edge is the severity channel.** Two edges, two meanings, 12px apart.
That is exactly how the card lays out a note (4px bar) containing a command (mono block).

### 4.4 Severity as an ordinal ramp, and why four levels is the maximum

`--ink` → `--muted` → `--hairline` → nothing is a four-step ramp of *contrast against the
page*: 17.99 → 5.77 → 1.45 → 1.00. Those steps are large and unambiguous. A fifth level would
have to sit between `--muted` and `--hairline` — around 3:1 — and it would be indistinguishable
from `--hairline` at 4px width in peripheral vision.

`63-rulepack-spec.md` caps `high` at 15% of active rules pack-wide. That budget is what makes
this ramp work: if a third of the list is `--ink` bars, the ramp conveys nothing.

### 4.5 Confidence as a margin tab, not a badge

```html
<span class="tab">heuristic, may be wrong</span>
```

Lowercase, muted, unpunctuated, at `--t-tab` (11px), floated to the row's right. This is the
card's `approx` and `not VPN-specific` doing the same job it does on paper.

The alternative — a `HEURISTIC` pill — was rejected because a pill is a shape, shapes need a
fill, a fill needs a colour, and the only colours available are reserved. Every time this
system is tempted toward a badge, the answer is a margin tab.

### 4.6 Selection without a coloured bar

Selection is `▸` (U+25B8) in the mono gutter plus `--surface` ground. Both, never one:

- ground alone collides with hover;
- glyph alone is invisible at a glance in a 200-line block;
- together they are unambiguous and they survive forced-colours mode, where the ground is
  overridden but `content` is not.

Multi-selection uses the same glyph. There is no checkbox — the card has no form controls and
this product's lists are navigated, not filled in.

### 4.7 Focus is the only outline

```css
--focus-width: 2px;
--focus-colour: var(--ink);
--focus-offset-inset: -2px;   /* controls that already have a border */
--focus-offset-outset: 2px;   /* borderless text controls */
```

`--ink` on `--page` is 17.99:1, on `--surface` 16.32:1, on every wash above 16:1. It clears
WCAG 1.4.11's 3:1 by a factor of five on every ground in the product, which is why focus never
needs a second colour or a double ring.

`:focus-visible`, never `:focus`. A mouse click on a config line must not paint a ring; a Tab
onto it must.

Nothing else in the product draws an outline. If a component looks like it wants one, it wants
a border, and borders are §9.

### 4.8 Validation without red

This is the hardest assignment in the table and the one that costs the most.

| State | Underline | Gutter | Message |
|---|---|---|---|
| valid / untouched | 1px solid `--hairline` | — | — |
| unanswered, required | 1px **dotted** `--hairline` (changed from dashed per M30, ADR-0025 — `dashed` is exclusive to AI-proposed content; this matches §9's `--rule-style-pending` and `54` §2.4. CI: `dashed` may appear only in selectors matching `.prop*`, `.dg-proposed`) | — | field's own margin tab: `needs an answer` |
| invalid | **2px solid `--ink`** | `!` | one line, `--ink`, 700, directly beneath |

The 2px `--ink` underline is the heaviest thing on a form. Since nothing else on a form is
heavier than 1px, an invalid field is the only 2px rule on the screen and it reads instantly.

**What this costs.** A red field is identifiable in peripheral vision at any distance. A 2px
ink underline is not — you have to be looking at the form. Mitigations, all of which are
required, not optional:

1. The form's header carries a live count: `2 fields need an answer` in `--ink` 700.
2. `aria-invalid="true"` plus `aria-describedby` pointing at the message, so assistive tech
   gets the state losslessly regardless of what the pixels do.
3. Submit is blocked and focus moves to the first invalid field, so the user is never left to
   find it visually.

Point 3 is the real fix. The visual treatment is a reminder; the focus move is the
affordance.

### 4.9 What the whole scheme costs, stated plainly

- **Learnability.** A new user does not know that a hatched bar means suppressed. Colour
  systems are learned in a day; this one takes a week. The mitigation is that every device has
  a word attached (C10), so nothing is *only* a texture. The card gets away with it because it
  has a legend on every side; this product carries the same legend on every screen.
- **Peripheral detection.** Neutral encodings do not catch the eye from across a desk. For
  findings that is acceptable — you are reading them. For the egress state it is not, which is
  why egress gets inversion, the loudest device available (§4.2).
- **Density limits.** A 4px bar at three tones needs ≥16px of row height to read. At 20px rows
  it is fine; below that the ramp collapses. §8 caps row density accordingly.
- **Printing.** Hatch and dash survive monochrome printing; colour does not. This scheme is
  *better* on paper than a colour scheme would be, which is the point of §13.

---

## 5. Dark theme

### 5.1 Should this product have one at all?

**Yes, and the argument is not "users expect it."**

The case against is real and worth stating first. The card is a printed artifact. Ink on paper
is a subtractive system with a fixed white point and no dark counterpart, and every design
decision in the extraction — hairlines at 1.45:1, washes at 1.10:1, an accent bar 3 units wide
— assumes a bright ground and a viewer whose pupils are constricted. Move that to a dark
ground and the fine structure either disappears or halates. A dark theme is not a free
inversion; it is a second design that has to be verified independently, and it doubles the
contrast-check surface forever.

The case for, in order of weight:

1. **Where this product is used.** A network engineer at 02:00 during a change window, in a
   NOC with the lights down, next to a terminal that is already dark. The tool sits beside a
   terminal emitting `show security ike security-associations`, and a white 992px sheet next
   to a dark terminal is a flashbulb. That is true and needs no reference. (The brief citation
   that stood here is deleted per ADR-0026 (6): brief §6.7 is *Verification and rollback
   generation* — it names no environment, no NOC and no time of day, and `conventions.md`
   says never fabricate a reference.)
2. **Respecting the OS signal.** Ignoring `prefers-color-scheme` means the OS-level setting a
   user has already made is silently discarded. (The "no server to remember a preference"
   half of this argument is deleted per ADR-0026: §5.6 stores the theme in `Settings`, so the
   premise was void by this document's own wiring.)
3. **It is cheap to get wrong and cheap to verify.** The verification is a contrast matrix,
   §5.5, and it is a CI check, not a judgement call.

**DECISION — dark theme ships, derived not inverted, and light is the default.** `light dark`
in `color-scheme`, `prefers-color-scheme` respected, and an explicit `data-theme` override that
wins in both directions. There is no third theme, no "auto-dim", no sepia.

> **Superseded as unconditional — ADR-0026.** Light is the product. The dark theme ships
> **only if three things land**, because as specified it is two visual languages, not two
> palettes: (1) one severity encoding in both themes — width in both, the tone ramp deleted
> (`55` §2.5 F3's recommendation, on the usability argument); (2) the diagram themes — `56`
> §5.7 currently emits literal light-theme hex as SVG presentation attributes, so in dark
> mode 20% of the surface fights the theme; (3) the `prefers-contrast` cascade is tested as a
> rendered cascade (`55` §2.7 as amended per R10). Until all three land: light only, and say
> why. The 02:00 case above is real and, if the conditions are not funded, is answered more
> cheaply — and worse — by a single dimmed light palette.

### 5.2 Why inversion fails — with the numbers

Two independent failures, both measured.

**Failure 1: the washes.** The three washes sit 1.10–1.13:1 above the page — a tint so faint it
is barely a colour at all. Scale each wash's linear RGB down until its luminance matches what a
dark wash needs (≈0.0088 relative luminance):

| Paper wash | naive darkened | resulting OKLCh chroma | paper chroma |
|---|---|---|---|
| `--safe-wash` `#EEF5F1` | `#171817` | 0.0025 | 0.0091 |
| `--caution-wash` `#FBF3EA` | `#181716` | 0.0025 | 0.0147 |
| `--danger-wash` `#F8EFEF` | `#181717` | 0.0016 | 0.0097 |

All three land within three hex steps of each other and of a plain neutral `--surface`. The
hue survives arithmetically and dies perceptually. A darkened wash is not a wash, it is grey.

**Failure 2: `--danger`.** On paper `--danger` `#8C2F2F` has the *highest* contrast of the three
semantics (8.19:1) because oxblood is dark and the ground is white. On a dark ground,
preserving that contrast ratio means picking the *lightest* red available. Solve for it at the
paper hue (OKLCh h=23.9°) against a dark page:

| Target contrast | Solved colour | What it looks like |
|---|---|---|
| 4.6:1 | `#E53F44` | red |
| 5.5:1 | `#F64F52` | bright red |
| 6.0:1 | `#FE5758` | at the sRGB gamut edge |
| 7.0:1 | `#FF716D` | salmon |
| **8.19:1 (paper parity)** | **`#FF8984`** | **pink** |

The lightest red is pink and pink does not mean *drops live traffic*. **Luminance and semantic
weight run in opposite directions across the light/dark boundary**, and that is the whole
problem. Any "just invert it" dark theme produces a pink danger colour and a grey wash set.

### 5.3 The method

Four rules, applied in order.

**M1 — The ground takes the card's own ink hue.** The dark page is not `#000` and not neutral
grey. `--ink` `#14171A` is OKLCh h=248.2°; the dark page is the same hue at OKL 0.180:
`#0F1215`. Neutral greys next to the card's slightly-blue hairlines look like two systems.

**M2 — `--ink` inverts to 14.67:1, not 17.99:1.** Full-strength white on a dark ground halates
on an LCD, and this design is dense — 20px rows of 12.5px mono. Backing off ~20% of contrast
removes the bloom without touching legibility. `#DFE4E8`, the ink hue at OKL 0.913.

**M3 — Flatten the luminance band; let chroma carry the ranking.** On paper the three
semantics span 5.19–8.19:1, and that spread is an accident of pigment, not an intent. On dark,
put all three in a narrow band (5.7–5.8:1) and rank them by *saturation* instead — `--danger`
most saturated, `--safe` least, which is how they read on paper anyway (oxblood is the darkest
and therefore the densest).

**M4 — Boost chroma 20–45% over paper.** Colourfulness falls with luminance (the Hunt effect),
so a paper-chroma green at OKL 0.63 on a dark ground reads grey-green. Each semantic ink was
solved at the paper hue, at 1.20–1.34× the paper chroma, at the target contrast — which lands
each at 77–90% of the available sRGB gamut at that lightness. Not at the gamut edge: the edge
(`#FF3341`, `#009A62`) is neon and the card is not neon.

**M5 — Washes are rebuilt, not darkened.** Match the *perceptual lightness step*, not the
hex arithmetic. Paper washes sit ΔL(OKLab) ≈ 0.032–0.041 below the page; the dark washes sit
ΔL ≈ 0.048 *above* the dark page, at 2.2–2.6× the paper chroma (M4 again, more severely,
because a near-black tint has almost no colourfulness left).

### 5.4 The dark set

```css
--page:       #0F1215;   /* ink hue at OKL 0.180 */
--surface-2:  #141719;
--surface:    #191C20;
--hairline:   #2B3138;
--muted:      #8A95A0;
--ink:        #DFE4E8;

--safe:    #35A06E;   --safe-wash:    #132019;
--caution: #D97328;   --caution-wash: #29180E;
--danger:  #EA6260;   --danger-wash:  #271817;
```

Derivation record, so a future editor can re-solve rather than eyeball:

| Token | OKLCh L | C | h | % of gamut at that L,h | CR vs page |
|---|---|---|---|---|---|
| `--safe` | 0.633 | 0.1245 | 158.9 | 85% | 5.73 |
| `--caution` | 0.660 | 0.1521 | 52.0 | 90% | 5.76 |
| `--danger` | 0.668 | 0.1699 | 23.9 | 77% | 5.74 |
| `--safe-wash` | 0.228 | 0.0227 | 158.9 | — | 1.12 (paper: 1.11) |
| `--caution-wash` | 0.228 | 0.0324 | 52.0 | — | 1.10 (paper: 1.10) |
| `--danger-wash` | 0.228 | 0.0253 | 23.9 | — | 1.10 (paper: 1.13) |
| `--hairline` | 0.295 | ~0.012 | 248 | — | 1.43 (paper: 1.45) |
| `--surface` | 0.220 | ~0.008 | 248 | — | 1.10 (paper: 1.10) |

The hairline and surface ratios land within 0.02 of paper. That is the goal: the *relationships*
are preserved, the values are not.

**This supersedes the dark values in `design/prototype/index.html`**, which were hand-picked by
eye. They are not wrong-looking, but `--danger: #D07A78` there computes at **5.98:1** — not the
7.4:1 previously printed here, a 24% error in the direction that made the argument work
(corrected per ADR-0026 (4)). The conclusion survives for a different reason: the prototype's
value is the same lightness at lower chroma, so the correct criticism is §5.3 M4 (chroma
equalisation), not §5.2's pink failure mode. The washes there were also chosen without a
lightness-step target. The prototype should be updated to these values.

### 5.5 Verification — dark contrast matrix

Every ink against every ground it is permitted to land on:

| Foreground | on `--page` | on `--surface` | on own wash |
|---|---|---|---|
| `--ink` `#DFE4E8` | **14.67** | 13.35 | 13.14 / 13.32 / 13.34 |
| `--muted` `#8A95A0` | **6.16** | 5.61 | 5.52 / 5.59 / 5.60 |
| `--safe` `#35A06E` | **5.73** | 5.21 | 5.13 |
| `--caution` `#D97328` | **5.76** | 5.24 | 5.22 |
| `--danger` `#EA6260` | **5.74** | 5.22 | 5.22 |
| `--hairline` `#2B3138` | 1.43 | 1.30 | — |

Worst text pair in dark: 5.13:1. Worst in light: 4.71:1. **The dark theme is the more legible
of the two**, which is a fair outcome given it was solved and the light one was extracted.

`--hairline` fails 1.4.11 on dark for the same reason it does on light, and the §3.4 usage table
applies unchanged.

### 5.6 Wiring

```css
:root { color-scheme: light dark; }

/* Light is the default and lives in :root, unconditionally. */
:root { /* light tokens */ }

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { /* dark tokens */ }
}

/* The explicit override must win in both directions. */
:root[data-theme="dark"]  { /* dark tokens */ }
:root[data-theme="light"] { /* light tokens */ }
```

The `:not([data-theme="light"])` in the media query is what stops "OS is dark, user chose
light" from producing a half-dark screen. The theme choice is workspace-local and lives in
`Settings` (`17-workspace-format.md`); it is not a cookie, not `localStorage` keyed to an
origin, and it is never transmitted.

**Duplication is deliberate.** The obvious cleaner alternative — one set of tokens and a
`light-dark()` function per token — was rejected: it puts two unrelated hex values on one line
and makes the derivation record in §5.4 unreadable. Three explicit blocks, one source of truth
per theme, checked by CI that all three declare the same token names.

---

## 6. Forced colours and the Windows high-contrast path

In `forced-colors: active` the user agent overrides `color`, `background-color`,
`border-color`, `outline-color`, `text-decoration-color`, SVG `fill` and `stroke`; forces
`box-shadow` and `text-shadow` to `none`; and forces non-`url()` `background-image` to `none`.

Read that list against §4 and three things break:

| Device | Breaks how | Fix |
|---|---|---|
| Risk colour | All three collapse to `CanvasText` | R2 already guarantees a word is present. In forced colours, reveal the visually-hidden word: `@media (forced-colors: active) { .risk-bar .vh { position: static; clip-path: none; width:auto; height:auto; } }` (M41: the risk mark is the 4px `.risk-bar`) |
| Severity ramp (`--ink`/`--muted`/`--hairline` bars) | All three border colours collapse to one | Switch the ramp from tone to **width**: 4px / 2px / 1px / 0 under forced colours. Width is not overridden. |
| AI hatch (`repeating-linear-gradient`) | `background-image` forced to `none` | The dashed *border* survives (`border-style` is not overridden). Keep the dash as the primary signal and the hatch as reinforcement, never the reverse. |
| Egress inversion | `--ink`/`--page` collapse | Explicitly restate as system colours: `background: CanvasText; color: Canvas;` — inversion survives because both keywords are defined. |

```css
@media (forced-colors: active) {
  :root { --focus-colour: Highlight; }
  .finding.high   { border-left-width: 4px; }
  .finding.medium { border-left-width: 2px; }
  .finding.low    { border-left-width: 1px; }
  .finding.info   { border-left-width: 0; }
  .egress { background: CanvasText; color: Canvas; forced-color-adjust: none; }
  .risk-bar .vh { position: static; width: auto; height: auto; clip-path: none; }
}
```

`forced-color-adjust: none` appears exactly once in the product, on the egress band, because
that is the one element whose meaning *is* its inversion. Everywhere else the user's palette
wins.

---

## 7. Type

### 7.1 The two families, and nothing else

```css
--sans: "Liberation Sans", Inter, "Helvetica Neue", Arial, system-ui, sans-serif;
--mono: "DejaVu Sans Mono", "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;
```

Two families, five faces: sans regular / bold / italic, mono regular / bold. There is no mono
italic (the card has none, and italic mono is unreadable at 12.5px), no sans light, no
condensed, no display face.

### 7.2 DECISION — the fonts ship inside the bundle

Invariant 1 forbids a font CDN. That leaves three options and the measurements decide it.

Latin-1 + arrows + the handful of box glyphs, subset with `fontTools`, WOFF2:

| Face | Subset WOFF2 | Source TTF |
|---|---|---|
| Liberation Sans Regular | 20.5 KB | 401 KB |
| Liberation Sans Bold | 19.9 KB | 405 KB |
| Liberation Sans Italic | 20.8 KB | 406 KB |
| DejaVu Sans Mono Regular | 17.1 KB | 335 KB |
| DejaVu Sans Mono Bold | 16.2 KB | 326 KB |
| **Total** | **94.6 KB** | 1.87 MB |

Base64-inlined into the single-file offline build: **126.1 KB**. That is the cost of the
design rendering identically on a locked-down Windows box, an air-gapped RHEL workstation and
a Mac, with zero network requests, forever.

**Decision: bundle all five faces as `@font-face` with `src: url(data:font/woff2;base64,…)`.**
`font-display: block` — a flash of Arial in a 992px dense reference sheet reflows every table
and every config block, and 126 KB from a data URI has no fetch latency to hide.

**What this costs:** 126 KB on every offline build, and two font licences to carry
(Liberation is SIL OFL 1.1; DejaVu is a Bitstream Vera derivative under a permissive licence —
both must be reproduced in the build's licence file).
<!-- VERIFY: confirm the exact licence text and attribution requirement for the DejaVu package version bundled, and that Liberation Sans 2.x ships under OFL 1.1 rather than the older GPL+font-exception. -->

The fallback stack still exists and still matters, because the CLI's man pages, the printed
output and any copy-paste destination will use whatever is installed.

### 7.3 Measured metrics — both families

Read directly from the shipped binaries (`unitsPerEm` 2048 in both):

| | Liberation Sans | DejaVu Sans Mono |
|---|---|---|
| x-height | 1082 (**0.5283 em**) | 1120 (**0.5469 em**) |
| Cap height | 1409 (0.6880 em) | 1493 (0.7290 em) |
| Advance, `0` | 1139 (0.5562 em) | 1233 (**0.6021 em**) |
| Advance, space | 569 | 1233 |
| hhea asc/desc/gap | 1854 / −434 / 67 | 1901 / −483 / 0 |
| Default line box | 1.1499 em | 1.1641 em |
| Digits all equal advance | **yes** | yes |
| GSUB features present | `ccmp dlig subs sups` | `case ccmp dlig fina init liga locl medi rlig` |

### 7.4 The mono-in-prose rule, solved

The card's characteristic texture is mono set inline in sans prose at the same optical size:

> `external-interface` is the WAN unit the IKE packets leave by, not `st0`.

"Same optical size" is not "same font-size". Matching **x-heights**:

```
mono_size / sans_size = 0.5283 / 0.5469 = 0.9660
```

```css
--mono-optical: 0.966;
code, .m { font-family: var(--mono); font-size: 0.96em; }
```

Verify at the body size: Liberation Sans at 13px has an x-height of 6.868px; DejaVu Sans Mono
at 12.5px (= 13 × 0.9615) has an x-height of 6.836px. **A difference of 0.03px.** The two
faces sit on the same optical line.

**The tension nobody mentions.** Matching *cap* heights instead gives 0.6880 / 0.7290 = 0.9438.
Identifiers in this corpus are overwhelmingly lowercase-hyphenated — `external-interface`,
`dead-peer-detection`, `st0.0`, `lifetime-kilobytes` — so x-height governs and 0.96 is right.
But error codes are all-caps — `NO_PROPOSAL_CHOSEN`, `INVALID_KE_PAYLOAD`,
`TS_UNACCEPTABLE` — and at 0.96 those run **3.4% taller** than the surrounding capitals.

Rather than average the two into a compromise that is wrong for both, declare the exception:

```css
--mono-optical:      0.96;   /* lowercase identifiers — the default */
--mono-optical-caps: 0.94;   /* all-caps runs: error codes, log strings */
.m-caps { font-size: 0.94em; letter-spacing: 0.01em; }
```

`.m-caps` is used in the ERROR DECODER table's left column and nowhere else that is not also
an all-caps machine string.

### 7.5 The scale

Two registers, not one geometric ramp.

| Token | px | rem | Line height | Used for |
|---|---|---|---|---|
| `--t-micro` | 10 | 0.625 | `1rem` (16px) | legend, note labels, gutter numbers, footers, table heads |
| `--t-tab` | 11 | 0.6875 | `1rem` (16px) | margin tabs, view rail, buttons, `kbd` |
| `--t-small` | 12 | 0.75 | `1.25rem` (20px) | table cells, notes, secondary prose |
| `--t-mono` | 12.5 | 0.78125 | `1.25rem` (20px) | config blocks, mono table cells |
| `--t-body` | 13 | 0.8125 | `1.25rem` (20px) | body prose |
| `--t-head` | 13 | 0.8125 | `1.25rem` (20px) | section heads (uppercase, tracked) |
| `--t-mast` | 15 | 0.9375 | `1.25rem` (20px) | finder input, masthead eyebrow |
| `--t-title` | 21 | 1.3125 | `1.5rem` (24px) | the side title, once per screen |

The ratio between adjacent steps in the 10–13 band is ≈1.09. A conventional 1.25 modular scale
would put the title at 10 × 1.25⁴ ≈ 24px and the next step at 30px, and it would leave gaping
holes where this design needs four distinguishable annotation sizes inside 3px of range. A
reference card has many simultaneous levels of subordination inside a narrow range — that is
what makes it a reference card rather than an article. **This scale is tuned, not generated,
and it is stated as tuned so nobody "fixes" it later.**

Sizes are declared in `rem` so browser text-zoom scales them; the px column is the rendering at
a 16px root and is what the derivations above assume.

### 7.6 Vertical rhythm

`--lh-step: 1.25rem` (20px at a 16px root) is the baseline unit — five times the 4px space
base. Every text size from `--t-small` through `--t-mast` sets `line-height: var(--lh-step)`,
which means:

- a 13px prose line and a 12.5px config line occupy exactly the same vertical space;
- a config block and the paragraph next to it stay in step in the two-column grid;
- `--t-micro` and `--t-tab` at 16px are 0.8 steps — deliberately off-grid, because tabs and
  labels are annotations that float beside the grid rather than sit on it, exactly as they do
  on the card.

Line-height is set as a length, not a ratio. A ratio (`1.5`) makes 12.5px and 13px text produce
19.5px lines that never quite align; a length locks the grid. The length is in `rem`, so text
zoom still works.

Body copy is small and tight and must stay that way. A design system's instinct is
`line-height: 1.6`; at 13px that is 20.8px and it looks like a blog. 20px is 1.538 and it looks
like a card.

### 7.7 Letterspaced uppercase heads

```css
--track-head: 0.14em;   /* section heads: T H E   O B J E C T   C H A I N */
--track-mast: 0.16em;   /* the masthead eyebrow */
--track-label: 0.10em;  /* note labels, table heads, buttons */
--track-legend: 0.09em; /* the risk legend */
```

Three things this must never do:

1. **Never type the spaces.** `text-transform: uppercase` + `letter-spacing`, so the DOM text
   stays `The object chain`. A screen reader reads the DOM, and `T H E  O B J E C T` is read as
   individual letters. This is the single most common way a design like this becomes
   inaccessible.
2. **Compensate the trailing space.** `letter-spacing` adds tracking after the final glyph too.
   Any centred or right-aligned tracked run needs `margin-right: calc(var(--track-head) * -1)`
   or it sits visibly off-axis.
3. **Never track lowercase body text.** Tracking is a register marker here — it says "this is a
   head or a label". Tracked body copy is unreadable at 13px and it destroys the distinction.

Uppercase is reserved for: section heads, the masthead, the one-line imperative, note labels,
table column heads, buttons, the risk legend. Everything else is sentence case. Margin tabs are
*lowercase*, always, and that contrast is the point.

### 7.8 Measure, and the 72-column problem

DejaVu Sans Mono advance is 0.6021 em, so at `--t-mono` (12.5px) one character is 7.526px and
72 columns is **541.9px**.

Solve the sheet width backwards from that:

```
column   = 72ch mono                     = 541.9px  →  550px
gutter   = --s6                          =  32px
padding  = --s5 × 2                      =  48px
sheet    = 550 × 2 + 32 + 48             = 1180px
```

**`--sheet: 1180px` exists because a two-column grid at that width holds exactly 73 columns of
`--t-mono`, and the emitter wraps at 72.** It is not a round number chosen for taste.

> **Restated honestly — R35, ADR-0025 (3).** The derivation above holds only with the second
> surface closed: with `54` §18's 420px inspector open at its 32px gutter, the content is
> `1180 − 48 − 420 − 32 = 680px`, below `--bp-cols: 860px`, and the two-column grid never
> renders. The card's two-column body is a property of a **view's body with the second surface
> closed** — a reading state — not of the sheet. `--sheet` stays 1180px with that constraint
> stated, rather than being re-derived; the previous text presented a coincidence as a
> consequence.

For comparison, the card's own content width is 744pt = 992px, so the screen sheet is 1.19× a
card side. Deliberately not wider: the card's density depends on the measure, and a 1400px
sheet turns a reference card into a dashboard.

Prose measure is capped independently at `--measure: 68ch` (Liberation Sans, ≈ 460px at 13px),
because 550px of 13px prose is a 78-character line and too long to track.

**When the viewport cannot hold two columns**, the grid collapses to one at `--bp-cols: 860px`.
A config block in a single 550px column still holds 72 characters; below 550px it scrolls
horizontally inside its own `overflow-x: auto` and the page body never scrolls sideways.

### 7.9 Numerals

```css
--num-tabular: tabular-nums;
```

Applied to: table cells containing numbers, the finder's timing readout, gutter line numbers,
SA indices, byte counters, lifetimes, MTU values, and every countdown.

**Honest note: this is a no-op in the primary fonts.** Both Liberation Sans and DejaVu Sans
Mono already give every digit an identical advance (measured, §7.3), and neither exposes a
`tnum` GSUB feature — Liberation Sans has only `ccmp dlig subs sups`. The declaration exists
entirely for the fallback stack: Inter, SF Mono and most `system-ui` faces default to
proportional figures, and a column of proportional MTU values in a table is exactly the sort of
thing that makes an engineer distrust the tool.

Do not declare `font-variant-numeric: lining-nums` — neither face has oldstyle figures to
suppress, and it is noise.

---

## 8. Space

Base unit **4px**, because the card's accent bar is 3pt = 4px (§2). Eight steps, and no step
between them is available.

```css
--s1:  4px;   /* the accent bar width; the smallest gap that exists      */
--s2:  8px;   /* label-to-value, swatch-to-text                          */
--s3: 12px;   /* intra-block padding, paragraph spacing                  */
--s4: 16px;   /* block padding, tab spacing                              */
--s5: 24px;   /* sheet padding, section-internal spacing                 */
--s6: 32px;   /* column gutter — the card's 24pt, in px                  */
--s7: 48px;   /* between major sections                                  */
--s8: 64px;   /* sheet bottom, before the footer                         */
```

The scale is 4-8-12-16-24-32-48-64: linear to 16, then doubling. That break is where the scale
stops describing *gaps inside things* and starts describing *gaps between things*.

Geometry constants, all from §2:

```css
--sheet:      1180px;   /* §7.8 — two columns of 72ch mono              */
--sheet-card:  992px;   /* the card's own 744pt content width           */
--col:         480px;   /* the card's own 360pt column                  */
--measure:      68ch;   /* prose line length cap                        */
--bp-cols:     860px;   /* two columns collapse to one below this       */
--gutter-num:   34px;   /* config-block line-number gutter: 6 digits of --t-micro + --s2 */
```

**Density and WCAG 2.5.8.** A config line at `--lh-step` is 20px tall. SC 2.5.8 (Target Size
Minimum, AA) requires 24×24 CSS px for pointer targets, with an exception for targets whose
size is constrained by the line-height of surrounding non-target text. A clickable config line
arguably sits inside that exception and arguably does not, and "arguably" is not a conformance
position.

```css
--row-min: 24px;   /* comfortable — default */
```

**DECISION — there is exactly one density control in this product, its default is the
accessible one, and it exists for an accessibility reason and not a taste one.**
`--row-min: 24px` (comfortable, default) or `20px` (compact, documented as not meeting SC 2.5.8,
opt-in per workspace). Compact costs nothing on a 12-line config block and buys back 20% of
vertical space on a 200-line one. Padding goes on the interactive element, never on the row, so
the visual density and the target size can differ.

There is no `--density-spacious`. The card does not have decorative whitespace — its margins
hold tabs, not air — and neither does this.

---

## 9. Borders and rules

Three weights, and there is not a fourth.

```css
--rule-hair:   1px;   /* 34 uses in the card. Cell borders, block edges, separators */
--rule-mast:   3px;   /* the masthead rule, and the active view-rail underline      */
--rule-accent: 4px;   /* the left bar on notes, findings, config blocks             */
```

| Weight | Where it is allowed | Where it is forbidden |
|---|---|---|
| 1px | Table row rules, block edges, section-head underline, separators, input borders | Never as a focus indicator; never as the sole identifier of a control (§3.4) |
| 3px | The masthead top rule. The active tab in the view rail. The egress band's bottom edge. | Nowhere else. Three uses, product-wide. |
| 4px | Left edge only. Notes, finding severity, config blocks, the AI hatch gutter, selection. | Never on the right, top or bottom. A 4px bar means "this block is annotated"; a 4px anything-else means nothing. |

Styles:

```css
--rule-style-deterministic: solid;
--rule-style-proposed:      dashed;   /* AI output. See §4.2 */
--rule-style-pending:       dotted;   /* an unanswered question, not a defect */
```

`solid` is the default and everything deterministic uses it. **Nothing produced by the
deterministic pipeline is ever drawn with a dashed rule**, so a dashed rule anywhere on the
screen means exactly one thing.

The hatch, used for suppressed records and the AI gutter:

```css
--hatch: repeating-linear-gradient(135deg,
          var(--muted) 0 2px, transparent 2px 5px);
```

2px stripe, 3px gap, 135°. At 4px wide it reads as texture rather than as pattern, which is
what is wanted — it should say "this is not a normal rule" without becoming decoration. It
disappears under forced colours (§6), which is why the dashed border, not the hatch, is the
primary AI signal.

---

## 10. Radius — the token whose value is zero

```css
--radius: 0;
```

It is a token, with a value, declared once, and it is not `border-radius: 0` sprinkled through
the sheet. Two reasons:

1. **It makes the decision auditable.** A grep for `border-radius` should return exactly one
   hit outside the token file, and CI can assert that.
2. **It makes the decision arguable.** A future editor who wants rounded corners has one value
   to change and one paragraph to argue with, rather than 60 declarations to hunt.

The paragraph: the card has no rounded corners anywhere, and the reason is not fashion. A
rounded corner is a manufacturing artifact — it exists because physical objects have radii and
because early UI toolkits used it to signal "this is a button". This product's surfaces are
*rules and washes*, not objects. A 4px accent bar with a rounded end is not a rule, it is a
lozenge, and a lozenge is decoration. The moment corners round, the notes become cards, the
cards need shadows, and the whole thing becomes a dashboard.

`border-radius: 0` also applies to `<input>`, `<button>`, `<select>` and `<textarea>`, which
several user agents round by default. `appearance: none` plus `--radius` on every form control,
without exception.

---

## 11. Elevation — none

```css
--shadow: none;
```

There is no elevation scale. There is no `--shadow-sm`. There are no z-layers except the two
listed below.

The card is ink on paper and has exactly one plane. On screen this has three consequences that
are load-bearing, and they are stated here rather than in §54 because they constrain every
component:

1. **There are no floating panels.** The provenance "popover" is an inline disclosure that
   pushes content down. The inspector is a column, not an overlay. A tooltip does not exist.
2. **The two exceptions are bounded by rules, not shadows.** The finder palette and any modal
   dialog are full-bleed sheets on `--page` with a 1px `--ink` border and a `--page` scrim at
   `--scrim-opacity: 0.72` over the content behind. A scrim is a ground, not a shadow.
3. **`z-index` is a three-value enum**, declared here so nobody invents a fourth:

```css
--z-content: auto;
--z-egress:  10;    /* the only sticky element in the product */
--z-modal:   20;    /* finder palette, dialogs */
```

Under forced colours `box-shadow` is forced to `none` anyway, so a design that depended on
shadow to separate layers would already be broken for a real class of users. This one cannot
break, because it never had shadows to lose.

---

## 12. Motion

```css
--motion-state:      0ms;    /* hover, selection, press, focus — instantaneous */
--motion-ease:       linear;
/* --motion-disclosure deleted per M34 (ADR-0025 group) — see below */
```

**The product has no animation** (amended per M34). The 90ms disclosure fade that stood here
could not run as written — `opacity` does not transition out of `display: none` without
`transition-behavior: allow-discrete` plus a `@starting-style` rule, neither of which was
specified, and the elements start at `opacity: 1` in both states — and three documents each
named a different "only motion in the product". Deleting the fade and `--motion-disclosure` is
more in the card's spirit, removes a token, a media query and two failure modes, and stops the
first person who notices from "fixing" it with a height transition the table below forbids by
name. The one scroll behaviour is smooth scrolling, owned by `52` §5.6.4.

`--motion-state: 0ms` remains a *token* rather than an absence so that adding a transition is
a visible change to a shared value rather than a line in a component.

Rules:

| Property | Animatable? | Why |
|---|---|---|
| `opacity` | **Never** (was "on disclosure only"; deleted per M34) | The disclosure fade could not run as written and is removed; content appears instantly |
| `height` / `max-height` | **Never** | It makes disclosure feel slow, it breaks scroll anchoring, and in a 200-line config block it reflows everything below |
| `transform` | **Never** | Nothing in this product slides. Sliding implies spatial layers and §11 says there are none |
| `background-color` | **Never** | A 150ms hover fade on a 200-row list is 200 concurrent transitions and it makes cursor movement feel laggy |
| `border-color` | **Never** | Same, and focus must be instant or it reads as unresponsive |

```css
@media (prefers-reduced-motion: reduce) {
  * { transition-duration: 0ms !important; animation-duration: 0ms !important;
      animation-iteration-count: 1 !important; scroll-behavior: auto !important; }
}
```

Because the product has no animation (M34), the reduced-motion block is a guard against
regressions rather than a mitigation of anything that ships. Scroll behaviour: smooth
scrolling per `52` §5.6.4, reduced to `auto` under `prefers-reduced-motion` as above.

**The egress indicator does not pulse, flash or animate.** This was considered and rejected. A
pulsing alarm is what you add when the static design is not loud enough; the inverted band
*is* loud enough (§4.2), and a pulse would have to be disabled under `prefers-reduced-motion`,
which would mean the loudest signal in the product is the one that vanishes for the users most
likely to need it.

---

## 13. Print

This is not a nice-to-have. The project began with a printed field card; a product that
generates configuration, findings and a verify ladder and then cannot put them on paper has
lost the thread. **The print stylesheet is a feature, and the feature is "export a field card
of your own."**

### 13.1 Page geometry — reproduce the card exactly

```css
@page {
  size: letter landscape;   /* 792pt × 612pt — the card's own page, §2 */
  margin: 24pt;             /* → 744pt content, exactly the card's measure */
}
```

A4 landscape (842 × 595pt) at the same 24pt margins gives 794pt of content — 50pt wider, which
the two-column grid absorbs because the columns are `1fr 1fr`. Both papers work; Letter
reproduces the source geometry to the point.

```css
@page :first { margin-top: 24pt; }
```

There is no separate first-page treatment beyond that. The card's masthead *is* the first-page
treatment.

### 13.2 What prints, what does not

| Element | Print behaviour |
|---|---|
| Masthead, 3px rule, title, subtitle, imperative | Prints. This is the card's identity. |
| Risk legend | **Prints on every page** (§13.5). It is the card's most disciplined move and a printed page without it is unreadable. |
| Margin tabs | Print. They are content. |
| Section heads, notes, tables, config blocks, plumbing lists | Print. |
| Provenance panels | Print **only if expanded**. Collapsed disclosure does not silently become invisible content — see §13.6. |
| View rail, finder palette, buttons, the copy affordance, the depth toggle | `display: none`. |
| Egress band | `display: none`, and a one-line footer note instead: `egress was armed during this session — 3 requests`. A printed page has no live egress state, but it must not silently drop the fact that there was one. |
| AI proposal surfaces | Print, **with the dashed border and a printed banner**: `AI PROPOSAL — NOT DETERMINISTIC — NOT VALIDATED`. Never omitted from print, because the paper artifact is the one that gets circulated. |
| Scrollable containers | `overflow: visible` — a printed page cannot scroll, and a clipped config block is a lie. |

### 13.3 Colour on paper

```css
@media print {
  .legend-item, .hit-risk, .note.safe, .note.caution, .note.danger,
  .risk-bar {
    -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
  }
}
```

`print-color-adjust: exact` opts these elements out of the browser's ink-saving optimisation.
The default is `economy`, under which a browser is free to drop background colours entirely —
which would silently delete the risk washes and turn `DISRUPTIVE` into plain text. The property
is Baseline as of 2025 with a `-webkit-` prefix for older engines; user and UA preferences
still override it, so R2's requirement that every risk element carry the word is what actually
guarantees the semantics survive a monochrome printer.

The rest of the sheet prints in whatever the browser decides, because the rest of the sheet is
already ink-on-white by construction. **Dark theme never prints.** `@media print` forces the
light token set regardless of `data-theme`, because printing a dark theme wastes toner and
produces an unreadable page.

```css
@media print { :root, :root[data-theme="dark"] { /* the light token block, restated */ } }
```

### 13.4 Type on paper

```css
@media print {
  html { font-size: 12px; }        /* rem base: 13px prose → 9.75pt */
  body { font-size: 9.75pt; }
  h1   { font-size: 15pt; }
  .block, code, .m { font-size: 8pt; }
}
```

9.75pt body on a landscape sheet at 744pt measure is a genuine reference-card size — the source
card's own body copy is in the same range. Mono at 8pt in a 360pt column holds
360 / (8 × 0.6021) ≈ 74 characters, which comfortably contains the emitter's 72-column wrap.

### 13.5 Repeating the legend

The legend must appear on every printed side. `@page` margin boxes (`@top-center` and friends)
are supported in Chromium and **not shipped in Firefox as of early 2026**, so they cannot carry
it.
<!-- VERIFY: re-check Firefox's status on page-margin boxes (Bugzilla 1854974) before implementation; if it has shipped, move the legend and the folio into @top-center / @bottom-center and delete the per-section duplication below. -->

Until then the legend is a normal element repeated once per top-level section, hidden on screen
after the first, and revealed in print:

```css
.legend.repeat { display: none; }
@media print { .legend.repeat { display: flex; break-before: avoid; } }
```

Ugly, and honest about being ugly. The alternative — a legend on side 1 only — makes sides 2–4
of a printed export unreadable, which is precisely the failure the source card was designed to
avoid.

### 13.6 Breaks

```css
@media print {
  h2, h3            { break-after: avoid; }
  .note, .plumb-item, .finding, .prop, tr { break-inside: avoid; }
  .block            { break-inside: avoid; }       /* a split config block is unusable */
  section           { break-before: auto; }
  p                 { orphans: 3; widows: 3; }
  .foot             { break-before: avoid; }
}
```

`break-inside: avoid` on `.block` is the important one and it has a limit: a config block
longer than one printed column cannot avoid breaking. When it must break, the continuation
carries a repeated header line — this is a rendering requirement on the component, not
something CSS can do, and §54 specifies it.

### 13.7 Print is a first-class output, so it is a first-class test

Three CI checks, all runnable headless:

| Check | Method |
|---|---|
| The printed sheet has no horizontal overflow at Letter landscape | Render to PDF, assert page count and that no element's bounding box exceeds 744pt |
| The legend appears on every page | Extract text per page, assert all three risk strings present |
| A config block's printed text is byte-identical to the clipboard payload, modulo wrapping | Extract text, unwrap, compare against `EmittedLine.text` |

The third one is the one that matters: it is the printed-artifact equivalent of invariant 9.

---

## 14. The complete token file

`design/tokens.css`. This is the whole of it — everything else in the product references these
names and declares no hex, no px font sizes and no durations of its own.

```css
/* =========================================================================
   Fathom design tokens.
   Values marked [E] are machine-extracted from the owner's SRX IPsec field
   card. Values marked [D] are derived — the derivation is in
   docs/50-design/51-design-tokens.md at the section noted. Values marked [C]
   were chosen; the reasoning is in the same place.
   ========================================================================= */

:root {
  color-scheme: light dark;

  /* --- neutrals ------------------------------------------------- §3.1 --- */
  --ink:        #14171A;   /* [E] 162 uses */
  --muted:      #5C6772;   /* [E] 152 uses */
  --surface:    #F2F4F6;   /* [E]  54 uses */
  --hairline:   #D2D7DD;   /* [E]  34 uses */
  --page:       #FFFFFF;   /* [E]  16 uses */
  --surface-2:  #FAFBFC;   /* [D] ink hue at OKL 0.988 */

  /* --- the risk enum. Reserved. See §1 R1 ----------------------- §3.2 --- */
  --safe:       #1F6F4A;   --safe-wash:    #EEF5F1;   /* [E] ReadOnly      */
  --caution:    #A8571B;   --caution-wash: #FBF3EA;   /* [E] ChangesConfig */
  --danger:     #8C2F2F;   --danger-wash:  #F8EFEF;   /* [E] Disruptive    */

  /* --- rules ---------------------------------------------------- §9 ----- */
  --rule-hair:   1px;      /* [E] */
  --rule-mast:   3px;      /* [E] */
  --rule-accent: 4px;      /* [E] 3pt in the source PDF */
  --rule-style-deterministic: solid;
  --rule-style-proposed:      dashed;
  --rule-style-pending:       dotted;
  --hatch: repeating-linear-gradient(135deg,
            var(--muted) 0 2px, transparent 2px 5px);

  /* --- radius and elevation ------------------------------ §10, §11 ----- */
  --radius: 0;             /* [C] deliberate. Read §10 before changing.     */
  --shadow: none;          /* [C] there is no elevation scale.              */
  --scrim-opacity: 0.72;
  --z-content: auto;  --z-egress: 10;  --z-modal: 20;

  /* --- space ---------------------------------------------------- §8 ----- */
  --s1:  4px;  --s2:  8px;  --s3: 12px;  --s4: 16px;
  --s5: 24px;  --s6: 32px;  --s7: 48px;  --s8: 64px;

  /* --- geometry ------------------------------------------- §2, §7.8 ---- */
  --sheet:      1180px;    /* [D] 2 × 72ch mono + gutter + padding */
  --sheet-card:  992px;    /* [E] the card's 744pt content width   */
  --col:         480px;    /* [E] the card's 360pt column          */
  --measure:      68ch;    /* [C] prose line cap                   */
  --bp-cols:     860px;    /* [C] two columns → one                */
  --gutter-num:   34px;    /* [D] 6 digits of --t-micro + --s2     */
  --cfg-cols:       72;    /* [D] must equal WrapPolicy::Display cols */
  --row-min:      24px;    /* [C] WCAG 2.5.8. 20px in compact mode.   */

  /* --- type ----------------------------------------------------- §7 ----- */
  --sans: "Liberation Sans", Inter, "Helvetica Neue", Arial, system-ui, sans-serif;
  --mono: "DejaVu Sans Mono", "JetBrains Mono", "SF Mono", Menlo, Consolas, monospace;

  --t-micro: 0.625rem;     /* 10px   */
  --t-tab:   0.6875rem;    /* 11px   */
  --t-small: 0.75rem;      /* 12px   */
  --t-mono:  0.78125rem;   /* 12.5px */
  --t-body:  0.8125rem;    /* 13px   */
  --t-head:  0.8125rem;    /* 13px   */
  --t-mast:  0.9375rem;    /* 15px   */
  --t-title: 1.3125rem;    /* 21px   */

  --lh-step:  1.25rem;     /* 20px — the baseline unit, 5 × --s1 */
  --lh-micro: 1rem;        /* 16px — off-grid on purpose, §7.6   */
  --lh-title: 1.5rem;      /* 24px */

  --mono-optical:      0.96;   /* [D] x-height match, §7.4 */
  --mono-optical-caps: 0.94;   /* [D] cap-height match     */

  --track-head:   0.14em;  /* [E] */
  --track-mast:   0.16em;  /* [E] */
  --track-label:  0.10em;
  --track-legend: 0.09em;

  --num-tabular: tabular-nums;

  /* --- focus ---------------------------------------------------- §4.7 --- */
  --focus-width:  2px;
  --focus-colour: var(--ink);
  --focus-offset-inset: -2px;
  --focus-offset-outset: 2px;

  /* --- motion --------------------------------------------------- §12 ---- */
  --motion-state:      0ms;
  /* --motion-disclosure deleted per M34 — the product has no animation */
  --motion-ease:       linear;
}

/* --- dark. Derived, not inverted. §5 ------------------------------------ */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --ink:       #DFE4E8;  --muted:      #8A95A0;
    --surface:   #191C20;  --surface-2:  #141719;
    --hairline:  #2B3138;  --page:       #0F1215;
    --safe:      #35A06E;  --safe-wash:    #132019;
    --caution:   #D97328;  --caution-wash: #29180E;
    --danger:    #EA6260;  --danger-wash:  #271817;
  }
}
:root[data-theme="dark"] {
  --ink:       #DFE4E8;  --muted:      #8A95A0;
  --surface:   #191C20;  --surface-2:  #141719;
  --hairline:  #2B3138;  --page:       #0F1215;
  --safe:      #35A06E;  --safe-wash:    #132019;
  --caution:   #D97328;  --caution-wash: #29180E;
  --danger:    #EA6260;  --danger-wash:  #271817;
}
:root[data-theme="light"] {
  --ink:       #14171A;  --muted:      #5C6772;
  --surface:   #F2F4F6;  --surface-2:  #FAFBFC;
  --hairline:  #D2D7DD;  --page:       #FFFFFF;
  --safe:      #1F6F4A;  --safe-wash:    #EEF5F1;
  --caution:   #A8571B;  --caution-wash: #FBF3EA;
  --danger:    #8C2F2F;  --danger-wash:  #F8EFEF;
}

/* --- forced colours. §6 ------------------------------------------------- */
@media (forced-colors: active) {
  :root { --focus-colour: Highlight; }
}

/* --- reduced motion. §12 ------------------------------------------------ */
@media (prefers-reduced-motion: reduce) {
  * { transition-duration: 0ms !important;
      animation-duration: 0ms !important;
      animation-iteration-count: 1 !important;
      scroll-behavior: auto !important; }
}

/* --- fonts. §7.2. Five faces, base64 WOFF2, 126 KB inlined. ------------- */
@font-face { font-family:"Liberation Sans"; font-style:normal; font-weight:400;
             font-display:block; src:url(data:font/woff2;base64,…) format("woff2"); }
@font-face { font-family:"Liberation Sans"; font-style:normal; font-weight:700;
             font-display:block; src:url(data:font/woff2;base64,…) format("woff2"); }
@font-face { font-family:"Liberation Sans"; font-style:italic; font-weight:400;
             font-display:block; src:url(data:font/woff2;base64,…) format("woff2"); }
@font-face { font-family:"DejaVu Sans Mono"; font-style:normal; font-weight:400;
             font-display:block; src:url(data:font/woff2;base64,…) format("woff2"); }
@font-face { font-family:"DejaVu Sans Mono"; font-style:normal; font-weight:700;
             font-display:block; src:url(data:font/woff2;base64,…) format("woff2"); }

/* --- the base layer ----------------------------------------------------- */
*, *::before, *::after { box-sizing: border-box; }

html { -webkit-text-size-adjust: 100%; }

body {
  margin: 0;
  background: var(--page);
  color: var(--ink);
  font-family: var(--sans);
  font-size: var(--t-body);
  line-height: var(--lh-step);
  font-variant-numeric: var(--num-tabular);
  -webkit-font-smoothing: antialiased;
}

input, button, select, textarea {
  font: inherit; color: inherit;
  border-radius: var(--radius);
  appearance: none;
}

:focus-visible {
  outline: var(--focus-width) solid var(--focus-colour);
  outline-offset: var(--focus-offset-outset);
}

/* Visually hidden, but present for AT and revealed under forced colours. */
.vh {
  position: absolute; width: 1px; height: 1px; overflow: hidden;
  clip-path: inset(50%); white-space: nowrap;
}
@media (forced-colors: active) {
  .risk-bar .vh, .hit-risk .vh {
    position: static; width: auto; height: auto; clip-path: none;
  }
}

/* Mono in prose. §7.4 */
code, .m { font-family: var(--mono); font-size: 0.96em; }
.m-caps  { font-family: var(--mono); font-size: 0.94em; letter-spacing: 0.01em; }
```

---

## 15. Failure modes of this token system

Named honestly, in the card's register: what breaks, and what you will wrongly blame.

| # | Failure | What it looks like | What you will blame | The actual fix |
|---|---|---|---|---|
| 1 | A component reuses a risk colour for status | Two things on one screen are green and mean different things | "the green is too similar" | §1 R1 and the `tokens/reserved-colour` CI check. The colour is not the problem; the reuse is |
| 2 | Someone adds `--grey-300` | Six neutrals become eleven and the hairlines stop matching | "the design looks muddy" | The neutral set is closed. New greys come from `--surface-2` or nowhere |
| 3 | `letter-spacing` is applied by typing spaces | Screen readers spell out headings letter by letter | "screen readers are broken" | §7.7 rule 1. Lint the DOM for runs of `\w \w \w` |
| 4 | Dark tokens drift from light | A component looks right in one theme and wrong in the other | "dark mode is hard" | CI asserts the three theme blocks declare identical token *names*. Contrast matrix is a test, not a review |
| 5 | Line-height set as a ratio somewhere | Config blocks and prose stop aligning across columns | "the grid is off" | §7.6. `--lh-step` is a length. Lint for unitless `line-height` |
| 6 | Mono set at `1em` in prose | Identifiers look 4% too big and the texture goes coarse | "the mono font is wrong" | §7.4. `0.96em`, measured |
| 7 | A hairline used as an input border | Low-vision users cannot find the field | "the form is confusing" | §3.4. 1px `--hairline` is 1.45:1 and fails 1.4.11 |
| 8 | A transition added to `background-color` on list rows | Cursor movement over a 200-row list feels laggy | "the app is slow" | §12. `--motion-state: 0ms` and the property table |
| 9 | Print stylesheet not tested | The exported card silently drops the risk washes | "the printer" | §13.3 `print-color-adjust: exact`, and §13.7's CI checks |
| 10 | Severity ramp used at 16px rows | Three of four levels are indistinguishable | "severity is unclear" | §4.4 and `--row-min` |
| 11 | The AI surface loses its dashed border in forced colours | Proposed output becomes indistinguishable from deterministic output | "high contrast mode is broken" | §6. The dash survives; the hatch does not. Never make the hatch primary |
| 12 | Bundled fonts omitted from the offline build | Layout shifts on a machine without Liberation Sans; tables reflow | "the CSS is fragile" | §7.2. 126 KB, `font-display: block` |

---

## 16. Open decisions

**DECISION — compact density and SC 2.5.8 (§8).** Shipping a mode that is documented as not
meeting an AA success criterion is defensible only if the default is conformant and the mode is
opt-in per workspace. The alternative is 24px rows everywhere, which costs 20% of vertical space
on the config view — the densest and most valuable screen in the product. **RECOMMENDATION:**
ship both, default comfortable, and put the SC reference in the setting's own description text
rather than burying it in a design doc.

**DECISION — bundled fonts (§7.2).** 126 KB in every offline build against a guaranteed
identical rendering. **RECOMMENDATION:** bundle. The single-file build already carries the
corpus; 126 KB is not the line item that decides whether it fits on a USB stick.

**DECISION — dark theme (§5.1).** Argued and settled above. Recorded here because it is
expensive to reverse once components reference theme-conditional tokens.

**Open, not decided — `--t-mono` at 12.5px.** A half-pixel font size renders differently across
engines and at fractional device pixel ratios. 12px would be integral and would make the
x-height match 0.5283 × 13 vs 0.5469 × 12 = 6.868 vs 6.563, a 4.4% mismatch — visible. 13px mono
in 13px sans is a 3.5% overshoot the other way. 12.5px is optically correct and mechanically
slightly awkward.
<!-- VERIFY: render 12.5px DejaVu Sans Mono at devicePixelRatio 1, 1.25, 1.5, 2 in Chromium, Firefox and WebKit and compare the rasterised x-height against 13px Liberation Sans. If 12.5px rounds inconsistently, fall back to 13px mono with `--mono-optical: 1.0` and accept the 3.5% overshoot, which errs toward legibility. -->

**Open, not decided — the legend repeat in print (§13.5).** Depends on Firefox shipping
page-margin boxes. Marked VERIFY there.

---

## 17. Sources consulted

- `.context/design-language.md` — the machine extraction. Every `[E]` value.
- `.context/field-card-srx-ipsec.txt` — measured directly for §2's wrap analysis (91 command
  lines, 23 wrapped, longest wrapped 51 chars, longest unwrapped 62 chars, 2-space
  continuation indent).
- Font binaries measured with `fontTools`: `LiberationSans-{Regular,Bold,Italic}.ttf`,
  `DejaVuSansMono{,-Bold}.ttf`. Subset sizes produced with `fontTools.subset --flavor=woff2`
  over Latin-1 plus arrows and box glyphs.
- WCAG 2.2 Understanding documents: SC 1.4.11 Non-text Contrast (3:1 for UI components and
  graphical objects, AA); SC 2.5.8 Target Size Minimum (24 × 24 CSS px, AA, with the
  spacing / equivalent / inline / user-agent / essential exceptions).
- MDN: `@media (forced-colors)` — the list of forcibly overridden properties in §6 is taken
  from it; `print-color-adjust` — `economy` default, `exact` opt-out, Baseline 2025, `-webkit-`
  prefix for older engines.
- Page-margin box support: shipped in Chromium, not shipped in Firefox as of early 2026
  (tracked as Bugzilla 1854974). Marked VERIFY in §13.5.
- Contrast figures computed with the WCAG 2.x relative-luminance formula; OKLab/OKLCh
  conversions with the standard M1/M2 matrices.
- `docs/10-core/13-emitters-and-provenance.md` §13 for `WrapPolicy` and the 72-column default.
- `docs/10-core/12-rule-engine.md` §10–11 and `docs/60-content/63-rulepack-spec.md` for the
  `Severity`, `Confidence`, `FindingState` and `Suppression` shapes §4 has to render.
- `docs/10-core/18-diff-verify-rollback.md` §2.6 for the already-decided field-level diff
  rendering, which this document defers to rather than restating.

## 18. Disagreements

**0. The dark theme redefines the three pinned risk colours (registered per M28).**
`conventions.md` pins `--safe`/`--caution`/`--danger` by hex, and `design-language.md` calls
them *"ground truth, machine-extracted"*. §5.4 substitutes `#35A06E`/`#D97328`/`#EA6260` in
dark — hue-matched, contrast-solved, and previously a silent redefinition of a pinned
constant. Proposed amendment to the convention: *"the three pairs are pinned for the light
theme; a dark theme substitutes hue-matched pairs at equal or better contrast, listed here."*

Otherwise none with the binding conventions. Two notes on things adjacent to them:

**1. `design/prototype/index.html` is superseded on three points**, and this is a proposed change
to that file rather than a disagreement with a convention:

| Prototype | This document | Why |
|---|---|---|
| Dark values hand-picked; `--danger: #D07A78` at **5.98:1** (corrected per ADR-0026 — 7.4:1 was a 24% arithmetic error) | `#EA6260` at 5.74:1 | The prototype's value is the same lightness at lower chroma — §5.3 M4's criticism, not §5.2's pink failure mode |
| `.egress` uses `--caution` and `--caution-wash` | Inversion: `--ink` ground, `--page` text | It reuses a reserved colour, which conventions forbid. Inversion is louder and costs nothing |
| `line-height: 1.5` (unitless) on body | `var(--lh-step)`, a length | Unitless ratios put 12.5px mono and 13px prose on different rhythms, §7.6 |

**2. The convention that finding severity is rendered "in neutrals with a weight/rule
treatment" is correct and I have obeyed it.** It is worth recording what it costs, because a
future reader may mistake §4.9 for an objection: neutral severity is roughly half a second
slower to scan than a colour ramp, and that cost is paid every time a findings list is opened.
It is still the right call, because a product where green means both "safe to run" and "low
severity" has destroyed the meaning of the only colour vocabulary it has. The half-second is
the price of the legend on every side of the card meaning exactly one thing.
