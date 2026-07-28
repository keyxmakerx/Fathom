# 55 — Accessibility

> **Status:** Proposed

Companion documents: `.context/design-language.md` (ground truth — every value audited below was
machine-extracted from the owner's field card, not chosen by me), `51-design-tokens.md` (the token
set, its contrast tables and its forced-colours path — this document verifies those numbers
independently and adds the ones they do not carry), `52-information-architecture.md` §5 (selection,
which is what a screen reader has to be able to follow), `53-interaction-and-keyboard.md` (the
keyboard model; this document specifies what focus *looks like*, not where it goes),
`54-component-catalog.md` §24 (the summarised contract — this document is the long form of it),
`56-diagram-view.md` (the diagram; §4.5 here specifies its non-visual representation and that
document implements it), `10-core/13-emitters-and-provenance.md` (`Risk`, which is the only
colour-carried semantic in the product), `30-security/34-browser-hardening.md` §5.6 (why the
diagram is SVG built from a closed tag set, which is also why it can have an accessibility tree at
all).

**The governing rule of this document, stated once, in caps, at the top:**

> **THIS DESIGN IS SMALL, GREY, AND COLOUR-CODED ON THREE HUES. THAT IS THREE ACCESSIBILITY
> DEFECTS IN ONE SENTENCE. EVERY ONE OF THEM IS FIXED BY ADDING A WORD, NOT BY ADDING CHROME.**

The owner's constraint is *"it's very bare bones, there's something I love about it,"* and
`51` treats the bare-bones quality as a requirement rather than a starting point. So does this
document. **Nothing below adds a rounded corner, a shadow, an icon, a badge or a colour.** Where
the aesthetic and an accessibility requirement genuinely cannot both be satisfied, §8 says so and
picks, and it picks accessibility in every case where the choice is between a user being able to
do the work and the screen looking right.

---

## 0. Contents

| § | |
|---|---|
| 1 | The conformance target, and what is deliberately not claimed |
| 2 | Contrast audit — every token pair, computed |
| 3 | Colour independence and colour-vision deficiency |
| 4 | Screen readers over a table, a config block, a findings list and a diagram |
| 5 | Keyboard-only operation and the focus indicator |
| 6 | Density, zoom and reflow |
| 7 | Motion, reduced motion, forced colours |
| 8 | Where the aesthetic and accessibility genuinely conflict |
| 9 | Testing |
| 10 | Failure modes |
| 11 | Open decisions |
| 12 | Sources consulted |
| 13 | Disagreements |

---

## 1. The conformance target

*margin tab: read this first*

### 1.1 The claim

**DECISION — the product targets WCAG 2.2 Level AA in full, plus five named AAA criteria, and it
ships an opt-in contrast mode that reaches AAA for text.**

The five AAA criteria taken deliberately, because they are cheap in this design and expensive in
most:

| SC | Level | Why it is cheap here |
|---|---|---|
| 2.4.12 Focus Not Obscured (Enhanced) | AAA | There is one sticky element in the product (`51` §11's `--z-egress`) and one modal layer. Nothing else can obscure focus because nothing else floats |
| 2.4.13 Focus Appearance | AAA | The indicator is already a 2px solid `--ink` outline. §5.3 shows the arithmetic |
| 2.2.4 Interruptions | AAA | There is no interruption. No toast, no nag, no auto-save banner, no re-engagement prompt |
| 2.3.3 Animation from Interactions | AAA | `--motion-state: 0ms`. The only animation in the product is a 90 ms opacity fade on content that is already in the DOM |
| 3.3.9 Accessible Authentication (Enhanced) | AAA | The only credential in the product is the workspace passphrase, and paste into that field is never blocked (invariant 3's one exception). Blocking paste into a passphrase field is the single most common way products fail 3.3.8 |

### 1.2 What is not claimed, and why

| Not claimed | Reason |
|---|---|
| **1.4.6 Contrast (Enhanced), AAA, by default** | The default palette is the card's own extracted ink. Four of its six foreground tokens sit between 4.6:1 and 6.2:1 (§2.2). Forcing AAA by default means recolouring the artifact the project exists to reproduce. **It is available on request** — §2.6 ships an AAA-conformant set behind `prefers-contrast: more` |
| **1.4.8 Visual Presentation, AAA** | Requires user-selectable foreground and background colours and a 1.5 line spacing minimum. We ship two themes and a fixed 20px baseline grid, and `51` §7.6 argues the grid at length. A user stylesheet can still override both, and §6.4 requires that it survive |
| **2.4.9 Link Purpose (Link Only), AAA** | Config lines and finding rows are activatable and their accessible names are constructed (§4.3, §4.4), but a lone `st0.0` is not self-describing out of context and pretending otherwise would mean padding every row with prose |
| **1.2.x, media** | There is no audio and no video in this product, in any deployment mode. Not applicable, stated so nobody looks for it |

### 1.3 Three constraints accessibility inherits from the rest of the product

1. **No egress (invariant 1).** There is no accessibility overlay widget, no remote conformance
   service, no font CDN, no "accessibility statement" that phones home, and no runtime
   third-party ARIA polyfill. Everything below is first-party code in the bundle. This is a
   genuine benefit: overlay widgets are a well-documented source of *new* barriers, and the
   architecture forbids them by construction rather than by policy.
2. **Offline single file (§8 of the brief).** Whatever the accessible representation of the
   diagram is, it ships in the same 3.4 MB HTML file. It cannot be a server-rendered
   description and it cannot be generated by a language model at runtime — invariant 9
   (determinism where it is observable) applies to it, because two users reading the same
   workspace must hear the same topology.
3. **The corpus is human-authored (invariant 10).** Every text alternative that is *content* —
   the explainer for a rule, the description of a topology idiom, the `answers` string on a
   command — is corpus with a `reviewed_by`. Text alternatives that are *structure* — the
   accessible name of a config line, the outline row for a node — are **generated
   deterministically from the graph**, not authored, because a generated name is always current
   and an authored one rots (§2.2 of the brief, applied to ourselves).

### 1.4 What this design gets for free

Worth stating before the audit, because the audit is a list of problems and the balance matters.

| Common defect | Why it cannot occur here |
|---|---|
| Focus indicator removed by a design system | There is exactly one outline in the product and `51` §4.7 makes it a token |
| Meaning conveyed by an icon with no label | There are no icons. `design-language.md`: *"No logos. No icons. No illustrations."* |
| Content hidden behind hover | There are no tooltips and no popovers. `51` §11: disclosure is inline and pushes content down |
| Motion-triggered vestibular symptoms | One 90 ms opacity fade, product-wide |
| A modal that traps a screen reader | Two modal surfaces exist (finder palette, dialog) and both are enumerated |
| Contrast destroyed by a gradient or an image behind text | There are no gradients and no images |
| Text baked into an image | There are no images. Even the diagram is text and vector geometry |

The card's discipline is, accidentally, most of an accessibility strategy. The parts it does not
solve are density, hairlines and the three colours, and those are the rest of this document.

---

## 2. Contrast audit — every token pair, computed

*margin tab: the real numbers*

### 2.1 Method, stated so the numbers can be reproduced

WCAG 2.x relative luminance: linearise each sRGB channel (`c/12.92` below 0.04045, else
`((c+0.055)/1.055)^2.4`), weight `0.2126 R + 0.7152 G + 0.0722 B`, then
`(L_lighter + 0.05) / (L_darker + 0.05)`. Every figure below was computed from the hex values in
`.context/design-language.md`, independently of `51` §3.4. Where the two documents agree, they
agree to the second decimal; where this document adds a pair `51` does not carry, it says so.

**APCA is not used.** It is the candidate contrast method for a future WCAG version and it is not
normative in WCAG 2.2. A product that claims AA has to be measured by the method AA is defined by.
<!-- VERIFY: if WCAG 3.0 or a WCAG 2.x errata makes APCA normative before v1 ships, re-run this
     section under both methods. The expected divergence is on the light-on-light pairs — the
     washes — where APCA is stricter, and on --muted at small sizes, where APCA's size and weight
     terms would likely fail 11px --t-tab that WCAG 2.x passes. -->

**The size question, settled first.** WCAG's "large text" allowance (3:1 instead of 4.5:1) applies
at 18.66px bold or 24px regular. **The largest type in this product is `--t-title` at 21px, used
once per screen.** Nothing in the product is large text. **The 4.5:1 threshold therefore applies to
every single glyph in the product**, and the 3:1 allowance is never available. That is the first
consequence of the density decision and it is a good one — it removes an entire class of "well, it
is a heading" argument.

### 2.2 Light theme — the full matrix

Every foreground against every ground it is permitted to land on (`51` §3.2: the `{ink, wash}`
pair is atomic — `--safe` never sits on `--caution-wash`).

| Foreground | `--page` `#FFFFFF` | `--surface-2` `#FAFBFC` | `--surface` `#F2F4F6` | own wash |
|---|---|---|---|---|
| `--ink` `#14171A` | **17.99** | 17.37 | 16.32 | 16.25 / 16.37 / 15.92 |
| `--muted` `#5C6772` | **5.77** | 5.57 | 5.24 | 5.21 / 5.25 / 5.11 |
| `--safe` `#1F6F4A` | **6.12** | 5.91 | 5.55 | **5.53** |
| `--caution` `#A8571B` | **5.19** | 5.01 | **4.71** | **4.73** |
| `--danger` `#8C2F2F` | **8.19** | 7.91 | 7.43 | **7.25** |
| `--hairline` `#D2D7DD` | 1.45 | 1.40 | 1.31 | 1.28–1.32 |

Non-text pairs that matter:

| Pair | Ratio | Requirement | Verdict |
|---|---|---|---|
| `--safe-wash` on `--page` | 1.107 | none — decorative ground | fine |
| `--caution-wash` on `--page` | 1.099 | none | fine |
| `--danger-wash` on `--page` | 1.130 | none | fine |
| `--surface` on `--page` | 1.103 | none | fine |
| `--surface-2` on `--page` | 1.036 | none | fine, and it is barely a colour |
| `--hairline` on `--page` | **1.448** | **3:1 if it bounds a control (1.4.11)** | **fails** |
| `--ink` vs `--muted` **adjacent** | **3.117** | **3:1 (1.4.11) when two bars must be told apart** | passes by 0.117 |
| `--muted` vs `--hairline` adjacent | 3.98 | 3:1 | passes |

### 2.3 Dark theme — the full matrix

| Foreground | `--page` `#0F1215` | `--surface-2` `#141719` | `--surface` `#191C20` | own wash |
|---|---|---|---|---|
| `--ink` `#DFE4E8` | **14.67** | 14.06 | 13.35 | 13.14 / 13.32 / 13.34 |
| `--muted` `#8A95A0` | **6.16** | 5.91 | 5.61 | 5.52 / 5.59 / 5.60 |
| `--safe` `#35A06E` | **5.73** | 5.49 | 5.21 | **5.13** |
| `--caution` `#D97328` | **5.76** | 5.52 | 5.24 | **5.15** |
| `--danger` `#EA6260` | **5.74** | 5.50 | 5.22 | **5.14** |
| `--hairline` `#2B3138` | 1.43 | 1.37 | 1.30 | 1.28–1.30 |

| Pair | Ratio | Verdict |
|---|---|---|
| `--hairline` on `--page` | 1.431 | **fails 1.4.11 as a control boundary**, same as light |
| `--ink` vs `--muted` **adjacent** | **2.381** | **fails 1.4.11 (3:1)** — new finding, §2.5 F3 |
| `--muted` vs `--hairline` adjacent | 4.31 | passes |

`51` §5.5 concludes *"the dark theme is the more legible of the two."* On text, it is: worst text
pair 5.13 dark against 4.71 light. On **non-text ranking**, it is worse, and §2.5 F3 is why.

### 2.4 Verdict by criterion

| SC | Threshold | Light | Dark |
|---|---|---|---|
| **1.4.3 Contrast (Minimum), AA** | 4.5:1, all text | **pass** — worst is `--caution` on `--surface` at 4.71 | **pass** — worst is `--safe` on `--safe-wash` at 5.13 |
| **1.4.6 Contrast (Enhanced), AAA** | 7:1, all text | **fail** — only `--ink` (16+) and `--danger` (7.25+) clear it | **fail** — nothing but `--ink` clears it |
| **1.4.11 Non-text Contrast, AA** | 3:1, control boundaries and meaningful graphics | **fail** for `--hairline` as a control boundary (1.45); **pass** for the severity ramp (3.12) | **fail** for `--hairline` (1.43) **and** for the severity ramp's top two steps (2.38) |

### 2.5 The four findings, named

**F1 — `--hairline` is 1.45:1 and cannot bound anything interactive.** Already found in `51` §3.4
and resolved there structurally: a hairline may separate table rows and edge a static block; it may
never be an input border, a focus indicator, or the sole marker of a selected row. **This document
adds one usage to the forbidden list that `51` does not carry: a hairline may not be the boundary
of a node, an edge, or a band in the diagram**, because those are meaningful graphics under 1.4.11
and 1.45:1 does not meet it. `56` §5 draws every node boundary, edge and band in `--ink` (17.99) or
`--muted` (5.77) — both of which clear 3:1 — and `--hairline` appears in the diagram only in the
static ghost after a re-layout (§7.2), which carries no meaning alone.

**F2 — nothing clears AAA for text by default, in either theme.** Four of six foregrounds sit
between 4.6 and 6.2 in light and all four semantics sit at 5.1–5.8 in dark. That is a conscious
consequence of reproducing an extracted palette. §2.6 is the answer.

**F3 — in the dark theme, the severity ramp's top two steps are 2.38:1 apart and fail 1.4.11.**
`51` §4.4 justifies the ramp by its contrast *against the page* — 17.99 → 5.77 → 1.45 → nothing —
and concludes *"those steps are large and unambiguous."* Against the page they are. But a user
comparing a `high` bar with a `medium` bar is comparing **the two bars with each other**, and
1.4.11's 3:1 is measured against adjacent colours. Light passes at 3.117 with 0.117 to spare. Dark
fails at 2.381.

**Fix, and it is the fix `51` §6 already invented for a different reason:** the severity ramp
switches from tone to **width** in the dark theme as well as under forced colours.

```css
/* 51 §6 already does this for forced-colors. Extend the same rule to dark. */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    .finding.high   { border-left-width: 4px; border-left-color: var(--ink); }
    .finding.medium { border-left-width: 2px; border-left-color: var(--ink); }
    .finding.low    { border-left-width: 1px; border-left-color: var(--muted); }
    .finding.info   { border-left-width: 0; }
  }
}
```

Width is not a colour and is not subject to 1.4.11's ratio at all. It costs the dark theme one
visual difference from the light theme — the ramp is a width ramp on dark and a tone ramp on light
— and that is a smaller cost than a severity ranking two of whose four steps are indistinguishable.
**RECOMMENDATION — use the width ramp in both themes and delete the tone ramp entirely.** It is one
encoding instead of two, it survives forced colours without a special case, it survives monochrome
print, and 4/2/1/0 px is a cleaner ordinal than three greys. `51` §4.4's ramp is not wrong; it is
one more thing to keep in sync than it needs to be. This is a **proposed change to `51` §4.4**, not
a disagreement with a binding convention.

**F4 — the three risk colours are 1.00:1 to 1.58:1 apart in luminance.** Not a WCAG failure —
nothing in WCAG requires two semantic colours to be distinguishable from each other. It is the most
important number in this document anyway, and §3 is built on it.

| Pair | Light | Dark |
|---|---|---|
| `--safe` vs `--caution` | 1.179 | **1.004** |
| `--safe` vs `--danger` | 1.339 | **1.001** |
| `--caution` vs `--danger` | 1.578 | **1.003** |

In the dark theme they are, to two decimal places, **the same brightness**. That is not an
accident: `51` §5.3's rule M3 deliberately flattened the luminance band to 5.73–5.76 and ranked the
three by chroma instead. It is the right call for a dark screen and it means that on a monochrome
printer, under achromatopsia, or through a badly-calibrated projector, **the dark theme's three
risk colours are one colour.** §3 is not a nicety. It is what keeps the risk semantics alive.

### 2.6 The adjusted set — `prefers-contrast: more`

Solved, not eyeballed. For each token: hold the OKLCh hue, hold the chroma where it stays in the
sRGB gamut, and move lightness until the token clears **7:1 against every ground it is permitted to
land on** — which means the worst case is its own wash, not the page.

**Light:**

| Token | Default | Adjusted | OKL | Chroma | Worst CR | What changed |
|---|---|---|---|---|---|---|
| `--muted` | `#5C6772` | `#48525D` | 0.508 → 0.435 | 0.0221 held | 7.01 | Two steps darker. Same hue, same chroma. Margin tabs get heavier; the card's "almost apologetic" register survives because it is still the *lightest* thing on the page |
| `--safe` | `#1F6F4A` | `#015E3A` | 0.484 → 0.424 | 0.0973 held | 7.01 | A darker green. Still unmistakably the card's green |
| `--caution` | `#A8571B` | `#843E00` | 0.545 → 0.446 | 0.1268 → 0.1146 | 7.00 | **The biggest change in the set.** Burnt orange becomes a dark rust; 10% of chroma had to go because the sRGB gamut narrows as it darkens at that hue |
| `--danger` | `#8C2F2F` | `#8C2F2F` | unchanged | unchanged | 7.25 | **Nothing.** Oxblood already clears AAA on every permitted ground |
| `--hairline` | `#D2D7DD` | `#878C91` | 0.877 → 0.638 | — | 3.00 | Only in this mode does a hairline meet 1.4.11, which means only in this mode may it bound a control — and it still does not, because §2.5 F1's structural rule is simpler than a mode-dependent one |

**Dark:**

| Token | Default | Adjusted | Worst CR | Note |
|---|---|---|---|---|
| `--muted` | `#8A95A0` | `#9DA9B4` | 7.00 | |
| `--safe` | `#35A06E` | `#53BA86` | 7.00 | |
| `--caution` | `#D97328` | `#F58C46` | 7.00 | |
| `--danger` | `#EA6260` | **`#FF827D`** | 7.00 | **This is the pink.** Chroma had to drop from 0.1695 to 0.1530 to stay in gamut |
| `--hairline` | `#2B3138` | `#626870` | 3.00 | |

**Two honest costs, both of which a reasonable person could use to argue against shipping this
mode.**

1. **`#FF827D` is exactly the failure `51` §5.2 identified.** That section solves the dark
   `--danger` at paper contrast parity and gets `#FF8984`, calls it pink, and says *"pink does not
   mean drops live traffic."* AAA in dark requires almost the same value. There is no third
   option: on a dark ground, more contrast means lighter, and lighter red is pink.
   **Resolution: ship the pink.** A user who has set `prefers-contrast: more` at the operating
   system level has told us, explicitly, that contrast beats connotation. Honouring a stated
   accessibility preference and then second-guessing it on aesthetic grounds is the failure mode
   this whole document exists to avoid. The word `DISRUPTIVE — DROPS LIVE TRAFFIC` is present in
   every case (§3.1), so the semantics are carried by the word regardless of what the hue
   suggests.
2. **At AAA the three semantics become mutually indistinguishable.** Solving all three to the same
   7:1 target collapses their mutual contrast to 1.00–1.04 in both themes — worse than the default
   light set's 1.18–1.58. **Discrimination and contrast pull in opposite directions**, and no
   palette can maximise both against a fixed ground. This is, again, only survivable because of
   §3.

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

**What was deliberately not changed:** `--ink`, `--page`, `--surface`, `--surface-2` and all three
washes. The washes are 1.10–1.13:1 tints that carry no information alone; darkening them would
make the notes look like boxes, which is what `design-language.md` says the card never does.

`prefers-contrast: less` is **not** implemented. There is no lower-contrast variant of a reference
card, and a design whose lowest text ratio is already 4.71:1 has nothing safe to give back.

### 2.7 The CI check

The permitted-ground table is data, and the test iterates it. This is the check `51` §3.4 asks for,
specified:

```rust
// tests/tokens/contrast.rs — runs on every PR, no browser needed.
const PERMITTED: &[(&str, &[&str])] = &[
    ("ink",     &["page", "surface_2", "surface", "safe_wash", "caution_wash", "danger_wash"]),
    ("muted",   &["page", "surface_2", "surface", "safe_wash", "caution_wash", "danger_wash"]),
    ("safe",    &["page", "surface_2", "surface", "safe_wash"]),
    ("caution", &["page", "surface_2", "surface", "caution_wash"]),
    ("danger",  &["page", "surface_2", "surface", "danger_wash"]),
];

#[test] fn every_permitted_pair_clears_aa() { /* 4.5 for all four token sets */ }
#[test] fn contrast_more_clears_aaa()       { /* 7.0 for the two `more` sets    */ }
#[test] fn adjacent_severity_steps_clear_1_4_11() { /* 3.0, or the ramp is width-encoded */ }
#[test] fn hairline_is_never_a_control_boundary()  { /* grep the built CSS, §2.5 F1 */ }
```

Four token sets: light, dark, light-more, dark-more. Twenty-two permitted pairs each. The test
runs in under a millisecond and it is the only reason the numbers in §2.2 and §2.3 will still be
true in a year.

---

## 3. Colour independence

*margin tab: most-missed*

### 3.1 The rule

> **R2 (`51` §1) — no component may encode meaning in colour alone. Every risk-coloured element
> carries the word as well, either visible or in a visually-hidden span.**

This document does not restate R2; it specifies the mechanism, proves it is necessary with numbers,
and specifies the test that keeps it true.

**The rule in operational form, and it is absolute:**

| | |
|---|---|
| A `Risk` value may be rendered as | colour **and** word |
| A `Risk` value may never be rendered as | colour alone; a swatch alone; a letter (`R`/`C`/`D`); an abbreviation; a shape; a position in a fixed order |
| The word is | the conventions string, verbatim, uppercase: `READ-ONLY — SAFE ON PRODUCTION`, `CHANGES CONFIG — NEEDS A COMMIT`, `DISRUPTIVE — DROPS LIVE TRAFFIC` |
| The word may be shortened to | `READ-ONLY`, `CHANGES CONFIG`, `DISRUPTIVE` — the first clause only — **and only where the full legend is present on the same screen**, which `54` §6 requires it to be |
| The word may be visually hidden when | the full legend is on screen **and** the coloured element sits inside a labelled group whose group label carries the word. Nowhere else |

The legend is what makes the short form legal. The card carries the full three-line legend on all
four sides, unchanged; `51` §13.5 makes it print on every page; `54` §6 puts it on every screen.
That legend is not decoration and it is not branding — **it is the text alternative for the entire
colour system**, and every abbreviation elsewhere depends on it being there.

### 3.2 The simulation, and what it shows

Method: linearise sRGB, transform to LMS with the Viénot, Brettel & Mollon (1999) matrices as
commonly implemented, project onto the dichromatic plane, transform back. Achromatopsia is
computed as the WCAG relative luminance rendered as a neutral.
<!-- VERIFY: the protan/deutan projections below are the single-plane Viénot 1999 method, which
     that paper states is valid for protanopia and deuteranopia. The tritan row uses the same
     single-plane form and Viénot explicitly notes it is not valid for tritanopia — Brettel's
     two-plane method is required. Re-run the tritan row against a reference implementation
     (or against Machado, Oliveira & Fernandes 2009's severity-parameterised matrices, which also
     give the useful anomalous-trichromat cases this table does not cover) before quoting it
     anywhere outside this document. -->

**Light theme:**

| Vision | `--safe` | `--caution` | `--danger` | safe/caution | safe/danger | caution/danger |
|---|---|---|---|---|---|---|
| Typical | `#1F6F4A` | `#A8571B` | `#8C2F2F` | 1.18 | 1.34 | 1.58 |
| Protanopia | `#69694A` | `#64641D` | `#424230` | 1.10 | 1.82 | 1.65 |
| Deuteranopia | `#60604C` | `#76760E` | `#58582A` | 1.34 | 1.15 | 1.55 |
| Tritanopia | `#5353BC` | `#878700` | `#6A6A00` | 1.64 | 1.09 | 1.49 |
| Achromatopsia | `#626262` | `#6D6D6D` | `#4F4F4F` | 1.18 | 1.34 | 1.58 |

**Dark theme:**

| Vision | `--safe` | `--caution` | `--danger` | safe/caution | safe/danger | caution/danger |
|---|---|---|---|---|---|---|
| Typical | `#35A06E` | `#D97328` | `#EA6260` | 1.00 | 1.00 | 1.00 |
| Protanopia | `#98986E` | `#84842A` | `#7C7C61` | 1.34 | 1.45 | 1.08 |
| Deuteranopia | `#8B8B70` | `#9A9A19` | `#9B9B5A` | 1.16 | 1.19 | 1.03 |
| Achromatopsia | `#8E8E8E` | `#8E8E8E` | `#8E8E8E` | **1.00** | **1.00** | **1.00** |

**Read three things out of that.**

1. **The best mutual separation under any simulated deficiency is 1.82:1** (light, protanopia,
   safe vs danger). 1.4.11's threshold for a meaningful graphic is 3:1. **Every pair, in every
   theme, under every deficiency, is below it — most are below 1.6.**
2. **Under deuteranopia the light theme's safe and danger are 1.15:1 apart.** `READ-ONLY — SAFE ON
   PRODUCTION` and `DISRUPTIVE — DROPS LIVE TRAFFIC` become two olive-grey smudges of the same
   weight. That is the worst possible confusion in this product: it is the pair whose confusion
   costs an outage.
3. **In the dark theme under achromatopsia the three colours are numerically identical.** Not
   close — identical, `#8E8E8E` three times, because `51` §5.3 M3 equalised their luminance on
   purpose.

**The conclusion is not "pick better colours."** No three-colour palette on a fixed ground can be
3:1-separated pairwise *and* 4.5:1 against the ground *and* be the card's palette. The conclusion
is that **the colour is a redundant cue and the word is the primary one**, which is what the card
already believed — it prints the legend on every side.

<!-- VERIFY: the commonly quoted prevalence figures for red-green colour vision deficiency
     (~8% of men and ~0.5% of women of northern European ancestry) come from a small number of
     mid-20th-century population studies and are reproduced widely without re-checking. Find a
     current, citable epidemiological source before putting a number in any user-facing or
     marketing text. The argument above does not need one. -->

### 3.3 The component contract

```ts
// The only way a Risk value reaches the DOM. There is no other constructor.
export type Risk = 'ReadOnly' | 'ChangesConfig' | 'Disruptive';

const RISK_TEXT: Record<Risk, { short: string; full: string; cls: string }> = {
  ReadOnly:      { short: 'READ-ONLY',      full: 'READ-ONLY — SAFE ON PRODUCTION',      cls: 'r-safe'    },
  ChangesConfig: { short: 'CHANGES CONFIG', full: 'CHANGES CONFIG — NEEDS A COMMIT',     cls: 'r-caution' },
  Disruptive:    { short: 'DISRUPTIVE',     full: 'DISRUPTIVE — DROPS LIVE TRAFFIC',     cls: 'r-danger'  },
};

/** `visible: false` is legal only where the legend is on screen (§3.1). */
export function riskMark(risk: Risk, visible: boolean): Element {
  const el = document.createElement('span');
  el.className = `risk-dot ${RISK_TEXT[risk].cls}`;
  const word = document.createElement('span');
  word.className = visible ? 'risk-word' : 'vh';   // `.vh` = 51 §14's visually-hidden
  word.textContent = visible ? RISK_TEXT[risk].short : RISK_TEXT[risk].full;
  el.appendChild(word);
  return el;
}
```

Three properties of that function, each load-bearing:

- **The word is a text node, always.** Not an `aria-label`, not a `title`, not a `data-` attribute.
  A text node is read by every assistive technology, survives `forced-colors`, survives
  copy-and-paste into a change ticket, and appears in the browser's own find-in-page. An
  `aria-label` does none of those.
- **When hidden, the word is the *full* string; when visible, the short one.** The visible case is
  constrained by width and has the legend beside it. The hidden case has neither constraint nor a
  legend in the reading order at that point, so it gets the complete sentence.
- **`riskMark` is the only path.** `51` §3.3's `tokens/reserved-colour` lint already restricts
  where the semantic tokens may appear in CSS. The matching source lint restricts `r-safe`,
  `r-caution` and `r-danger` to this one function.

### 3.4 The monochrome test — the check that actually proves it

Automated accessibility tooling cannot find a colour-only encoding, because it cannot know that
green means something. This can:

```
tests/e2e/monochrome.spec.ts

  1. Load the fixture workspace (the field card's side-1 tunnel: SRX-A ↔ SRX-B).
  2. Inject a stylesheet that maps all six semantic tokens to one value:
        --safe: #000; --caution: #000; --danger: #000;
        --safe-wash: #FFF; --caution-wash: #FFF; --danger-wash: #FFF;
  3. Walk every element carrying a `risk-*` or `r-*` class.
  4. ASSERT: its accessible name, or the accessible name of its labelling ancestor,
     contains exactly one of the three conventions strings.
  5. ASSERT: no two elements with different Risk values now have identical
     accessible names AND identical computed styles.
  6. Repeat under `forced-colors: active` and at `prefers-contrast: more`.
```

Step 5 is the one that catches the real regression: somebody adds a "compact" risk rendering that
drops the word because the legend is right there, and then the legend gets moved. The test fails
the moment the two are no longer on the same screen.

The equivalent check for the diagram is in `56` §7 and it is the same test with the outline (§4.5)
standing in for the accessible name.

### 3.5 Where the palette is *not* the only signal, and where it is

| Signal | Colour? | Redundant encoding |
|---|---|---|
| `Risk` | yes, the only one | the word (§3.3) |
| `Severity` | no — `51` §4.2 assigns it the left-edge bar | width ramp (§2.5 F3) + `aria-describedby` naming the level |
| `Confidence` | no | margin tab: `probable`, `heuristic, may be wrong` |
| `FindingState` | no | rule style + strikethrough + the word in the row's accessible name |
| Diff sign | no | gutter glyph `+ − ~ ·`, which is a text node |
| Selection | no | `▸` glyph + ground, and `aria-selected` |
| Focus | no | 2px outline (§5) |
| Validation | no | underline weight + `!` glyph + `aria-invalid` + a message |
| Provenance class (AI vs deterministic) | no | dashed border + hatch + `role` and label (`54` §19) |
| Egress armed | no | inversion + `CanvasText`/`Canvas` under forced colours + a live region |
| **Staleness of a parsed node** | **no** | margin tab with the age in words (`11` §8.7); in the diagram, a stroke-tone step and a second label line (`56` §8) |

Eleven axes, one of which uses colour. `51` §4 did that work; this document's contribution is to
confirm it holds up under the simulation in §3.2, and it does — because ten of the eleven never
depended on hue in the first place.

---

## 4. Screen readers over a table, a config block, a findings list and a diagram

*margin tab: the hard part*

### 4.1 Three reading modes, not one

A screen-reader user in this product is doing one of three things, and the right structure is
different for each:

| Mode | Example | Right structure | Wrong structure |
|---|---|---|---|
| **Look up** | "what does `NO_PROPOSAL_CHOSEN (P1)` mean" | A real table with row headers — jump by column, read one cell | A list of paragraphs |
| **Read in sequence** | "read me the Phase 1 block I am about to paste" | A list of lines with constructed names, one tab stop, arrow navigation | A table (announces "row 14 column 1" 40 times) |
| **Explore a structure** | "what is this device connected to" | A tree plus a per-node relations table | A picture with a description |

The diagram is mode 3 and it is the one everybody gets wrong, because the instinct is to describe
the picture. §4.5 does not describe the picture.

### 4.2 The dense table

The card's `ERROR DECODER` is the model for every diagnostic table in the product (`54` §9). It is
two columns, horizontal hairlines only, no vertical rules. That renders as a real table with no
compromise at all:

```html
<table class="t2">
  <caption class="vh">Error decoder — what to look at for each IKE log string</caption>
  <thead>
    <tr><th scope="col">In the log</th><th scope="col">Go look at</th></tr>
  </thead>
  <tbody>
    <tr>
      <th scope="row"><span class="m-caps">NO_PROPOSAL_CHOSEN</span> (P1)</th>
      <td><code>dh-group</code>, <code>encryption</code>, <code>hash</code>,
          <code>authentication-method</code></td>
    </tr>
    <tr>
      <th scope="row"><span class="m-caps">INVALID_KE_PAYLOAD</span></th>
      <td>DH group mismatch — P1 <code>dh-group</code> or PFS <code>keys</code></td>
    </tr>
  </tbody>
</table>
```

Four requirements, each of which is broken by a common "improvement":

| Requirement | The improvement that breaks it |
|---|---|
| `<th scope="row">` on the lookup key, not `<td>` | "the left column looked too bold, so we made it a `td`" — and now the row has no name |
| A `<caption class="vh">` on every table | "the heading above it says the same thing" — it does, but the caption is what a table-list command reads |
| No `role="presentation"` anywhere | "we used a table for layout" — this product never does |
| Identifiers in `<code>`, error strings in `.m-caps` | `.m-caps` is 0.94em mono with 0.01em tracking (`51` §7.4) and is **presentation only** — it must never be the thing that distinguishes two values |

**The one real problem: `NO_PROPOSAL_CHOSEN` read aloud.** Screen readers vary in how they
pronounce a long underscored all-caps token — some spell it, some read it as words, some read the
underscores. There is no markup that reliably fixes this and inserting spaces or `<abbr>` would
corrupt the string a user needs to search for in `show log kmd`.

**Resolution: leave the string exactly as it appears on the box, and put the meaning in the cell
next to it.** The left column is a *lookup key*, and a user who is reading it aloud already has the
string in front of them in the log. The right column — `dh-group, encryption, hash,
authentication-method` — is the answer and it reads perfectly. This is the card's own design and it
happens to be the accessible one.

### 4.3 The config block — 400 lines of mono

A block of emitted config is the most-read surface in the product and the one where naive markup
fails hardest. `54` §8 specifies the component; this is its accessibility contract.

**Structure:**

```html
<div class="block" role="list" aria-label="Phase 1 — proposal, policy, gateway. 8 lines.
             All lines change config and need a commit.">
  <div class="line" role="listitem" tabindex="0" id="l1"
       aria-describedby="l1-risk l1-prov">
    <span class="ln" aria-hidden="true">1</span>
    <code>set security ike proposal IKE-P1 authentication-method pre-shared-keys</code>
    <span id="l1-risk" class="vh">CHANGES CONFIG — NEEDS A COMMIT</span>
    <span id="l1-prov" class="vh">from IkeProposal IKE-P1, field authentication-method.
          Enter to expand provenance.</span>
  </div>
  …
</div>
```

**Six rules:**

1. **One tab stop for the whole block.** Roving `tabindex`: the focused line is `tabindex="0"`,
   every other line is `tabindex="-1"`. A 400-line block that is 400 tab stops is a keyboard trap
   in everything but name. `54` §2.5 owns the roving-list primitive; this is one of its users.
2. **The line number is `aria-hidden`.** It is a gutter ornament, it is not part of the command,
   and hearing "one" before every line is 400 wasted syllables.
3. **The `Risk` word is in a `.vh` span per line, and the block's `aria-label` summarises it.**
   The summary sentence is generated: if every line in the block has the same `Risk`, it says so
   once; if they differ, it says `contains 6 lines that change config and 2 that are disruptive`
   and each line still carries its own.
4. **Continuation backslashes are preserved in the DOM and hidden from the accessible name.**
   The card wraps commands the way a terminal wraps them —
   `set security ike gateway GW-B dead-peer-detection \` then two spaces and
   `always-send interval 10 threshold 3`. That is correct for copy-paste and wrong for reading
   aloud: a screen reader announces "backslash" and the two-space indent as a separate line.
   **The wrap is presentation.** One `role="listitem"` holds the whole logical command; the
   backslash and the line break live inside it in a `<span aria-hidden="true">`, and the
   accessible name is the unwrapped command. The clipboard payload is the wrapped form, per `13`
   §13 — so the three representations are: **wrapped on screen, wrapped on the clipboard,
   unwrapped in the accessibility tree.** All three come from one `EmittedLine` and CI asserts
   that unwrapping the DOM text reproduces `EmittedLine.text` exactly (`51` §13.7 already
   specifies this test for print; it is the same assertion).
5. **`<code>` around every command, `role="list"` on the block.** Some screen readers suppress
   `<code>` announcement, some announce it once per block; either is acceptable. What is not
   acceptable is a `<pre>` with a single text node, because then there are no lines to navigate.
6. **Above 400 lines the block degrades to a `<pre>` with opt-in expansion** (`54` §25 failure 1).
   The degraded form is *more* accessible, not less — one text node read continuously — and it
   announces the degradation: `400 of 1,240 lines. Expand to navigate line by line.`

### 4.4 The findings list

The four state axes (`Severity`, `Confidence`, `FindingState`, and whether a `suppression` exists)
are all non-colour already. Their accessibility contract is that **each one appears in the row's
accessible name in words, in a fixed order, and the order never varies**:

```
"high. ipsec.pfs.absent. Perfect Forward Secrecy is not configured.
 IpsecPolicy IPSEC-POL on SRX-A. definite. active. Expanded shows why,
 remediation and sources."
```

Fixed order: severity, rule id, title, subject, confidence, state, affordance. A screen-reader user
scanning 200 findings is listening for the first word of each row, and if severity is sometimes
third the scan is dead. This is the non-visual equivalent of `51` §4.1's R3 — one channel, one
owner — applied to the utterance.

`Confidence: definite` is spoken, not omitted. `51` §4.2 renders `definite` as *nothing* visually,
which is right for a screen where absence is legible; in an utterance, absence is
indistinguishable from a bug.

### 4.5 The diagram — the hard case

*margin tab: why it exists*

#### 4.5.1 What does not work, stated first

| Approach | Why it fails |
|---|---|
| `<svg role="img" aria-label="Network diagram of site B">` | It is a label for a *manipulation surface*. A user can drag nodes, draw links and thereby generate configuration in this view (`56` §6). Labelling it as an image and stopping is telling a class of users that a whole feature is a picture |
| `<title>` on every shape | `<title>` produces a tooltip on hover and an accessible name on the shape. It does nothing for navigation: there is no order, no containment, no way to ask "what is this connected to" |
| `<desc>` with a long prose description | It rots. The moment somebody drags a node the description is wrong, and a description that is generated from the graph anyway may as well be generated *as structure* |
| `tabindex` on SVG shapes | Support for focusing arbitrary SVG elements is uneven across engines and assistive technologies, and a focusable SVG element with no accessible name is a documented source of confused announcements. The prevailing guidance is to keep focus and the keyboard model in native HTML and let the SVG be the picture |
| A generated text summary from a language model | Invariant 9, and `21`'s boundary. Two users on the same workspace must hear the same topology |

#### 4.5.2 The design: the Outline is not an alternative, it is the interface

> **DECISION — keyboard focus in the diagram view never enters the `<svg>`. It moves through a
> real DOM tree — the Outline — built from the same layout output that draws the picture. The SVG
> mirrors the Outline's focus; it does not hold it.**

This is one decision doing five jobs:

1. It gives assistive technology a genuine structure to navigate.
2. It gives keyboard users a focus model that does not depend on SVG focus support.
3. It makes the focus ring drawable at exactly 2 CSS px regardless of zoom (§5.2), because the
   ring is painted by us from the focused node's coordinates rather than by the user agent around
   an arbitrary shape.
4. It makes the diagram testable without a rendering engine — the Outline is assertable in a unit
   test.
5. It is the same tree the CLI prints for `fathom topology`, so it has a second consumer and
   therefore stays current.

The Outline is **not** hidden. It is a resizable column beside the canvas (`52` §2's shell already
has the shape), collapsible to a 1-line summary, and it is where selection lives for everybody —
mouse users included. A parallel structure that only screen-reader users see is a structure nobody
maintains.

#### 4.5.3 The data shape

```ts
/** Produced by the same X15/X16 layout call that produces the coordinates
 *  (41 §3.2). One entry per drawn element. Deterministic order. */
export interface OutlineRow {
  id: ElementId;                 // NodeId or EdgeId — invariant 7
  depth: number;                 // tree depth, 0 = drawing root
  kind: Kind;                    // 'Device' | 'Interface' | 'Tunnel' | 'Zone' | …
  /** The primary label, identical to the one drawn in the picture. */
  label: string;                 // "SRX-A", "reth0.0", "VPN-B"
  /** Generated, never authored. Complete sentence, no abbreviation. */
  spoken: string;
  /** Relations from this element, for the connections table (§4.5.5). */
  links: OutlineLink[];
  /** Which layers this row is present in. A row not in the active layer set
   *  is not rendered at all — the Outline is filtered exactly as the SVG is. */
  layers: LayerMask;
  /** 11 §8.7 band. Spoken; never a colour. */
  age: AgeBand;                  // Fresh | Ageing | Stale | Unverified
  /** Set only for nodes the layout could not place inside the viewport. */
  offscreen?: OffscreenReason;   // 52 §5 already defines this
}

export interface OutlineLink {
  via: ElementId;                // the edge
  to: ElementId;                 // the far element
  /** "trunk", "aggregate member", "tunnel", "routed next hop", "zone member" */
  relation: string;
  /** The label drawn on the edge in the picture, if any. */
  detail?: string;               // "vlan 10, 20, 30"  |  "st0.0 · 10.255.0.1/30"
}
```

`spoken` is generated by a total function over `(kind, fields, provenance)` — one match arm per
kind, no free text, no template language. It is in the core, not the UI, because the CLI needs it
and because invariant 9 requires it to be byte-identical across builds.

#### 4.5.4 The tree, with the field card's own topology

The fixture: side 1's tunnel, both ends modelled. `SRX-A` at site A, `SRX-B` at site B, a
route-based IPsec VPN between them, `reth0.0` as the WAN unit and `st0.0` as the tunnel unit.

```html
<div class="outline" role="tree" aria-label="Topology outline. Layers: physical, L3, overlay.
                                             14 elements. 1 unverified.">
  <div role="treeitem" aria-level="1" aria-expanded="true" aria-setsize="2" aria-posinset="1"
       tabindex="0" id="o-srxa">
    SRX-A
    <span class="vh">Device SRX-A, platform junos-srx, chassis cluster, 2 chassis.
          6 interfaces. 4 connections. Parsed 11 months ago.</span>
    <div role="group">
      <div role="treeitem" aria-level="2" aria-expanded="false" aria-setsize="6" aria-posinset="1">
        reth0.0
        <span class="vh">Logical unit reth0.0 on redundant Ethernet interface reth0,
              redundancy group 1, address 198.51.100.5/30, zone WAN.
              This is the external interface of IKE gateway GW-B. 2 connections.</span>
      </div>
      <div role="treeitem" aria-level="2" aria-expanded="false" aria-setsize="6" aria-posinset="2">
        st0.0
        <span class="vh">Logical unit st0.0 on tunnel interface st0, address 10.255.0.1/30,
              zone VPN, bound by IPsec VPN VPN-B. 1 connection.</span>
      </div>
      …
    </div>
  </div>
  <div role="treeitem" aria-level="1" aria-expanded="false" aria-setsize="2" aria-posinset="2">
    Tunnel SITE-A ↔ SITE-B
    <span class="vh">Tunnel, route based, intended state up. Endpoint A: IPsec VPN VPN-B on
          SRX-A. Endpoint B: IPsec VPN VPN-A on SRX-B. 1 traffic selector,
          10.1.0.0/16 to 10.2.0.0/16. Both ends modelled.</span>
  </div>
</div>
```

**Why `role="tree"` and not a nested list.** The containment relation in the graph is a forest
(`11` §7.2 — exactly one containment in-edge per node), which is what a tree is. `aria-expanded`
gives collapse without a disclosure widget. `aria-level`, `aria-setsize` and `aria-posinset` give
"3 of 6, level 2", which is the non-visual equivalent of seeing a node's position in a column.

**Why the tree is containment and not connectivity.** A network is not a tree; it is a graph with
cycles, and forcing connectivity into a tree means either duplicating nodes or picking an arbitrary
spanning tree, both of which lie. Containment *is* a tree in this schema, so it is what the tree
role carries. **Connectivity is a table**, per element, and that is §4.5.5.

#### 4.5.5 Connections — the part that makes it usable

Pressing `Enter` on a tree item, or `Ctrl+I`, opens that element's connections in the inspector
column as a real table. This is the answer to "what is this connected to", which is the question a
diagram exists to answer:

```html
<table>
  <caption class="vh">Connections of logical unit reth0.0 on SRX-A. 2 connections.</caption>
  <thead><tr>
    <th scope="col">Relation</th><th scope="col">To</th><th scope="col">Detail</th>
  </tr></thead>
  <tbody>
    <tr><th scope="row">zone member</th>
        <td>Zone WAN on SRX-A</td>
        <td>host-inbound system-services: ike</td></tr>
    <tr><th scope="row">IKE external interface</th>
        <td>IKE gateway GW-B</td>
        <td>peer 203.0.113.10, v2-only, DPD always-send 10 × 3</td></tr>
  </tbody>
</table>
```

That table is the field card's own two-column form — lookup key on the left, answer on the right —
and it is generated from `OutlineRow.links`. A sighted user reading the picture and a screen-reader
user reading this table are getting the same facts in the same words.

#### 4.5.6 Navigation keys

| Key | In the Outline |
|---|---|
| <kbd>↑</kbd> <kbd>↓</kbd> | Previous / next visible row |
| <kbd>→</kbd> | Expand; if expanded, move to first child |
| <kbd>←</kbd> | Collapse; if collapsed, move to parent |
| <kbd>Home</kbd> <kbd>End</kbd> | First / last row |
| <kbd>Enter</kbd> | Open connections in the inspector |
| <kbd>g</kbd> | **Go to a connection** — moves focus to the far element of the focused row's *n*th link, entered as a number. The graph traversal key |
| <kbd>b</kbd> | Back — the traversal stack, so `g` is reversible |
| Type-ahead | Jumps to the next row whose `label` starts with the typed characters |

`g` and `b` are what turn a tree into a graph browser. Without them a user can see that `reth0.0`
connects to `GW-B` and has no way to *get* to `GW-B` except by walking the tree back up to the
device and down another branch. With them, following a tunnel from one site to the other is two
keystrokes.

#### 4.5.7 The topology digest — a text artifact you can paste

`Ctrl+Shift+C` in the diagram view copies the visible scene as text. Same generator, no markup:

```
SITE-A
  SRX-A                      junos-srx  cluster  parsed 11 months ago
    reth0.0    198.51.100.5/30   zone WAN   ike gateway GW-B (external-interface)
      └─ link ─ ge-0/0/0 (node0) + ge-5/0/0 (node1)      reth0, RG1
    st0.0      10.255.0.1/30     zone VPN   bound by VPN-B
      └─ tunnel ─ st0.0 on SRX-B   10.255.0.2/30
    route      10.2.0.0/16 → st0.0
TUNNEL  SITE-A ↔ SITE-B          route-based, intended up
  A  VPN-B  on SRX-A     GW-B → 203.0.113.10   v2-only
  B  VPN-A  on SRX-B     GW-A → 198.51.100.5   v2-only
  ts TS1    10.1.0.0/16 ↔ 10.2.0.0/16
```

Three reasons this exists and is not a novelty:

- It is what goes in a change ticket. A screenshot of a diagram is useless in a ticket a
  screen-reader user will read next week.
- It is diffable. Two digests of the same workspace at different times is a topology diff for free.
- It is the CLI's `fathom topology` output, which means it has a test suite with golden files and
  cannot silently drift from the picture.

#### 4.5.8 The bijection test

> **CI asserts a bijection between drawn SVG elements and Outline rows, in both directions, for
> every layer combination in the fixture set.**

```
for each layer mask in the 31 non-empty subsets of {physical, l2, l3, security, overlay}:
    scene   = layout(fixture, mask)
    drawn   = { element ids in the serialised SVG }
    outline = { row ids in the Outline }
    ASSERT drawn == outline
    ASSERT every outline row's `spoken` is non-empty and ends with '.'
    ASSERT every outline row's `label` equals the <text> content of its drawn element
```

This is the check that stops the Outline from rotting. A developer who adds a new decoration to the
picture — a VRRP marker, a bandwidth annotation — fails the build until it has a row. **The
alternative, an accessibility review once a quarter, has never worked anywhere.**

#### 4.5.9 What is genuinely lost

Honest, because §8 requires it: **a diagram's value is partly gestalt.** "The DMZ is over on the
right and everything crossing into it goes through those two boxes" is a fact you get in one
saccade from a picture and cannot get from a tree, a table or a digest in any amount of time. The
Outline gives complete and current *facts*; it does not give shape.

Two partial mitigations, offered as what they are:

- The layer toggles reduce what has to be read. A user who wants "what crosses into the DMZ" reads
  the security layer's zone bands (`56` §4.4), which is a much smaller structure than the whole
  scene.
- The digest's indentation carries hierarchy, which is a weak proxy for spatial grouping.

Neither is the picture. This is one of the places where a design cannot be made equivalent, only
usable, and saying otherwise would be dishonest.

### 4.6 Live regions and the 400 ms problem

`44` §4.4: findings recompute on field commit, which is blur or 400 ms of settled text. A naive
`aria-live="polite"` findings panel therefore interrupts a screen-reader user **every 400 ms while
they type an IP address**, which makes the field unusable and is worse than no announcement.

**The contract:**

| Region | Politeness | Coalescing | What is announced |
|---|---|---|---|
| Findings panel | `polite` | **2 s quiet window**, and only the *net change* since the last announcement | `2 new findings, 1 resolved. Highest is high.` Never the finding text |
| Field shape feedback (B6) | **none** | — | It is `aria-describedby` on the field, not a live region. The user hears it when they arrive at the field or when they ask |
| Field validation on commit | `polite` via `aria-invalid` + `aria-describedby` | — | The message. One utterance per commit |
| Tier C sweep progress | `polite` | 5 s | `checking, 340 of 4,100`. Matches the visible margin tab (`44` §4.8.3 move 3) exactly |
| Egress armed / disarmed | **`alert`** | none | `Egress armed. 3 requests to sync.example.com.` The only `alert` in the product |
| Export gate refusal | `alert` | none | `17` §15.3's refusal, verbatim |

**One `alert` role, product-wide.** `alert` interrupts. The egress state is the one thing worth
interrupting for, because it is the one thing that changes what leaves the machine. Everything else
is `polite` and coalesced.

**The 2-second quiet window is the specification, not an implementation detail.** It means a user
typing continuously hears nothing from the findings panel, and hears one summary two seconds after
they stop. That matches what a sighted user sees, which is a panel that settles.

### 4.7 Shell: landmarks, headings, titles

| Element | Requirement |
|---|---|
| Skip link | First focusable element, visible on focus, target is `<main>` |
| Landmarks | `banner` (masthead + view rail), `main` (the view), `complementary` (inspector / Outline), `contentinfo` (folio). Exactly one of each |
| Headings | One `<h1>` per view, no skipped levels. The `<h1>` is the view's title in the masthead, not a hidden duplicate |
| `document.title` | `<selection> — <view> — <workspace> — Fathom`, updated on every view or selection change, because it is how a screen-reader user knows a route changed in an application that does not reload |
| Tracked uppercase | `text-transform`, never typed spaces (`51` §7.7 rule 1). Lint the DOM for `/\b(\w\s){3,}\w\b/` in heading text |
| Language | `<html lang="en">`. The corpus is English-only at v1 and says so |

### 4.8 The assistive-technology matrix, and what has to be measured

**No behaviour of any specific screen reader is asserted in this document.** Support for SVG,
`role="tree"`, `aria-expanded` on non-widget containers, and long `.vh` strings varies between
products and between versions of the same product, and a design document that states such
behaviours from memory is how a product ships something that does not work.

The support matrix is a **test plan**, not a claim:

| Combination | Priority | Why |
|---|---|---|
| NVDA + Firefox, Windows | P0 | The most common free combination in the audience |
| NVDA + Chromium, Windows | P0 | Corporate default browser |
| JAWS + Chromium, Windows | P1 | Enterprise procurement |
| VoiceOver + Safari, macOS | P1 | |
| Orca + Firefox, Linux | P2 | Air-gapped RHEL workstations are a named deployment target |
| Narrator + Edge | P3 | |

<!-- VERIFY: for each P0/P1 combination, measure and record in tests/a11y/at-matrix.md:
     (1) whether the Outline's role="tree" with aria-level/setsize/posinset is announced with
         position information, or flattened;
     (2) whether a `.vh` span inside a treeitem is included in the accessible name or read as
         separate content;
     (3) whether `<code>` inside a role="listitem" suppresses or duplicates announcement;
     (4) whether the roving-tabindex config block is navigable in browse mode as well as focus
         mode, and whether the block's aria-label is announced on entry;
     (5) whether an aria-live="polite" region inside a landmark that is also aria-hidden during
         a modal is correctly silenced;
     (6) whether the SVG with role="img" and aria-hidden="true" (our intent — the picture is
         decorative because the Outline carries it) is genuinely skipped.
     Item 6 is the one most likely to come back badly, and if it does the fallback is
     role="presentation" on the <svg> plus focus management entirely in the Outline, which is
     what we do anyway. -->

**Note the intent hidden in item 6:** because the Outline carries every fact the picture carries
(§4.5.8's bijection), **the `<svg>` itself is `aria-hidden="true"`.** It is a rendering of
something already in the accessibility tree, and exposing both means every element is announced
twice. That is a defensible and slightly unusual position, and it is only defensible *because* of
the bijection test.

---

## 5. Keyboard-only operation and the focus indicator

*margin tab: fields that matter*

`53-interaction-and-keyboard.md` owns the keymap and the focus *order*. This document owns what
focus looks like and where the single indicator fails.

### 5.1 One indicator, no exceptions

```css
--focus-width:  2px;
--focus-colour: var(--ink);
--focus-offset-inset:  -2px;   /* controls that already have a border */
--focus-offset-outset:  2px;   /* borderless controls */
```

`:focus-visible`, never `:focus` (`51` §4.7). Nothing else in the product draws an outline, so an
outline means exactly one thing — which is the same discipline the three colours get.

### 5.2 The five surfaces where a 2px ink outline is not visible, and the rule for each

This is the part `51` does not carry, and it is where the aesthetic actually bites: in a design
with no shadow, no radius and one accent, the focus ring has nothing to fall back on.

| Surface | Ratio, ink outline | Verdict | Rule |
|---|---|---|---|
| `--page` `#FFFFFF` | 17.99 | fine | default |
| `--surface` `#F2F4F6` | 16.32 | fine | default |
| Any wash | 15.92–16.37 | fine | default |
| **The egress band** — inverted, `--ink` ground | **1.00** | **invisible** | `.egress :focus-visible { --focus-colour: var(--page); }` → 17.99 against the band |
| **On top of a 4px accent bar** (a note, a finding row, a config block gutter) | 1.00 where they overlap | **the ring disappears into the bar** | `outline-offset` moves *outward* on any element whose left edge is an accent bar: `--focus-offset-outset` and `padding-inline-start` ≥ `--s2`, so the ring's left segment lands on the ground, not on the bar |
| **Inside the diagram, over a node's own 1px ink stroke** | 1.00 | **the ring merges with the node** | The ring is drawn by us, 2 CSS px, at `--s1` (4px) offset outside the node's bounding box, in `--ink`, with `vector-effect="non-scaling-stroke"` so it stays 2 CSS px at every zoom. `56` §6.2 |
| **Dark theme, `--ink` `#DFE4E8` on `--page` `#0F1215`** | 14.67 | fine | default |
| **`forced-colors: active`** | overridden | — | `--focus-colour: Highlight` (`51` §6) |

The egress rule deserves a sentence, because it is the one that looks like a special case and is
not. **Inversion is used exactly once in this product** (`51` §4.2), and the focus colour flips
with it, mechanically. There is no second inverted surface to remember.

### 5.3 2.4.13 Focus Appearance (AAA) — the arithmetic

> *"an area of the focus indicator … is at least as large as the area of a 2 CSS pixel thick
> perimeter of the unfocused component or sub-component, and has a contrast ratio of at least 3:1
> between the same pixels in the focused and unfocused states."*

| Term | Our value |
|---|---|
| Indicator area | A 2 CSS px solid outline around the whole component — **exactly** a 2px perimeter, by construction |
| Contrast between focused and unfocused pixels | Those pixels are `--page` (or `--surface`) unfocused and `--ink` focused: **17.99:1** light, **14.67:1** dark, against a 3:1 requirement |
| At `prefers-contrast: more` | unchanged — `--ink` is not adjusted |
| Under `forced-colors` | `Highlight` vs `Canvas`, which the user agent guarantees |

We meet it in every mode, with a factor of five of margin, and it cost nothing because the design
already had one high-contrast neutral and no competing outlines. **This is the clearest example in
the product of the bare-bones aesthetic being an accessibility asset rather than a liability.**

### 5.4 2.4.11 Focus Not Obscured

There is one sticky element (`--z-egress`) and one modal layer (`--z-modal`). Therefore:

```css
:root { --egress-height: 28px; }
[tabindex], a, button, input, select, textarea, [role="treeitem"], [role="listitem"] {
  scroll-margin-block-start: calc(var(--egress-height) + var(--s2));
  scroll-margin-block-end:   var(--s4);
}
```

Nothing else can obscure focus, because nothing else floats — `51` §11 removed the entire category.
That is also why 2.4.12 (Enhanced, AAA) is claimed in §1.1: not *partially* obscured is a much
harder bar in a normal interface and a trivial one here.

### 5.5 2.5.7 Dragging Movements — the diagram's obligation

> *"All functionality that uses dragging movements can be achieved by a single pointer without
> dragging, unless dragging is essential."*

The diagram has three drag gestures and none of them is essential:

| Gesture | Single-pointer alternative | Keyboard alternative |
|---|---|---|
| **Drag a node to reposition** | Select node, then `Move` in the inline disclosure, then click the target cell | Arrow keys nudge by `--s1` (4px); <kbd>Shift</kbd>+arrow by `--s6` (32px); `Enter` commits, `Esc` reverts |
| **Marquee select** | `Select all in layer`, then deselect individually; or filter then `Select filtered` | `Ctrl+A` within the focused subtree; `Space` toggles a row's selection in the Outline |
| **Drag from port to port to draw a link** | Select source, `L`, select target, confirm in the disclosure | identical — the gesture is *already* select-then-select, and the drag is the shortcut, not the mechanism |

The third row is the design pattern worth generalising: **specify the two-step form first and make
the drag a shortcut for it.** Drag-first designs need a bolted-on alternative that nobody tests;
this one has the alternative as the reference implementation and the drag as sugar. `56` §6.4
builds it that way.

**One drag remains and it is exempt: pan.** Panning is `Space`-drag or a scroll gesture, and its
non-drag equivalents are arrow keys on the canvas, `Home` (fit to content) and the Outline (which
scrolls the canvas to the focused element). Pan is not "functionality" in 2.5.7's sense — nothing
is achieved by it that is not achieved by focusing the thing you wanted to see.

### 5.6 Roving tabindex — the contract for long lists

Any list over 20 rows is one tab stop. The rule, stated once so every component obeys it:

| Property | Value |
|---|---|
| Container | `role="list" \| "tree" \| "grid"`, `aria-label` carrying the count and any summary |
| Focused child | `tabindex="0"` |
| Every other child | `tabindex="-1"` |
| Entering with <kbd>Tab</kbd> | Focus lands on the previously-focused child, or the first if none |
| Leaving with <kbd>Tab</kbd> | Focus leaves the container entirely — the list is one stop out as well as one stop in |
| <kbd>Esc</kbd> | Moves focus to the container's own heading, so a user is never stranded |
| Virtualisation | The focused row is **never** unmounted. If a scroll would remove it, the scroll is clamped or the focus moves first. A focused element removed from the DOM sends focus to `<body>`, which is the single most common way a virtualised list becomes unusable |

### 5.7 What may trap focus

| Surface | Trap? | Exit |
|---|---|---|
| Finder palette | yes, deliberately | <kbd>Esc</kbd>, always, unconditionally |
| Modal dialog (export gate, suppression reason) | yes | <kbd>Esc</kbd> cancels; the primary action is reachable by <kbd>Tab</kbd> in ≤ 6 stops |
| Inline disclosure | **no** | It is in the flow. Tab moves out of it into the next line |
| The diagram canvas | **no** | It is `aria-hidden` and holds no focus (§4.5.2) |
| The egress band | **no** | It has one control, `Disarm` |

Everything else: no. A trap that is not on this list is a bug, and the e2e harness asserts the list
by tabbing 200 times from `<body>` on every view and checking it returns to `<body>`.

---

## 6. Density, zoom and reflow

*margin tab: it is small on purpose*

### 6.1 The density control

`51` §8 already decides there is exactly one. This specifies it.

```rust
/// Workspace setting (17 §—). Not a session preference: two engineers opening
/// the same workspace should see the same screen, and a density that follows the
/// person rather than the document makes screenshots in a ticket unreproducible.
pub enum Density { Comfortable, Compact }
```

| | `Comfortable` (default) | `Compact` |
|---|---|---|
| `--row-min` | 24px | 20px |
| SC 2.5.8 | **conformant** | **not conformant**, and the setting's own description says so |
| Where it applies | The interactive target box of a row. **Never the type size and never the line-height** | same |
| What it does not change | `--lh-step`, every `--t-*` token, `--s*`, the hairline weights | |

**The setting's user-facing text, which is the specification of it, in the card's register:**

```
DENSITY
  comfortable   24px rows. Every clickable row meets WCAG 2.2 SC 2.5.8 (24 × 24 CSS px).
  compact       20px rows. Buys back about a fifth of the height of a 200-line block.
                Rows no longer meet SC 2.5.8's minimum target size. Choose this only if
                you are working with a mouse or trackpad you trust.
```

No shame, no nag, no "not recommended" in italics. The number is stated, the criterion is named,
the user decides. `54` §26 and `51` §16 both flag this as a decision needing a position; **this is
the position.**

**Why there is no `spacious`.** `design-language.md`: *"No decorative whitespace — the margins are
for tabs, not for air."* A user who needs bigger targets needs *browser zoom*, which scales
everything coherently, not a third density that scales padding and leaves 10px type alone.

**Why density is not the accessibility answer.** It is important to say this plainly, because a
density control looks like an accessibility feature and mostly is not: **the accessibility answer
to "this is too small" is zoom, and zoom is the user agent's job.** Our job is to not break it,
which is §6.3.

### 6.2 Text zoom versus page zoom

| Mechanism | What moves | What we must do |
|---|---|---|
| **Page zoom** (`Ctrl` `+`) | Everything, including the layout viewport, which shrinks in CSS px | Reflow (§6.3) |
| **Text-only zoom** (Firefox; browser setting) | Only lengths in `em`/`rem`/`%` | Every font size is `rem` (`51` §7.5), every line-height is `rem`, so this works. **The failure mode is a `px` font size**, which CI greps for |
| **Root font size** (browser setting: minimum font size / default size) | The `rem` base | Same. Also: `--t-micro` at 0.625rem becomes 12.5px at a 20px root, which is fine, and `--lh-step` at 1.25rem becomes 25px, which keeps the grid |

**The one thing that is not `rem` and must not be:** the three rule weights (1px, 3px, 4px) and
`--focus-width` (2px). A hairline that scales with text zoom becomes a 4px slab at 400% and the
card's most characteristic device turns into a border. Hairlines are device features, not typographic
ones. The cost: at 400% zoom the hairlines look thin relative to the type — which is exactly how
they look on the printed card at arm's length, so it is not a regression.

### 6.3 Reflow — 1.4.10 at 320 CSS px

> *"Content can be presented without loss of information or functionality, and without requiring
> scrolling in two dimensions for … vertical scrolling content at a width equivalent to 320 CSS
> pixels … Except for parts of the content which require two-dimensional layout for usage or
> meaning."*

400% zoom on a 1280 px-wide window gives a 320 CSS px layout viewport. Walk the widths:

| Width | What happens |
|---|---|
| ≥ 1180 px | `--sheet`: two columns of 72ch mono, inspector beside |
| 1100–1180 | Sheet fluid; inspector still beside |
| < 1100 | **Inspector stacks below** (`54` §18 — it stacks, it does not float) |
| < 860 (`--bp-cols`) | **Two columns collapse to one** |
| < 550 | A config block no longer holds 72 mono columns and **scrolls horizontally inside its own `overflow-x: auto` container.** The page body never scrolls sideways |
| 320 | Everything is one column; the view rail becomes a horizontal scroller; the masthead's tracked title wraps |

**The honest part: is a config block "content which requires two-dimensional layout"?**

The argument that it is: a `set` command's line structure is meaningful. The card preserves
continuation backslashes precisely because *"commands wrap the way they wrap in a terminal, not the
way they wrap in a webpage"* (`design-language.md`), and `13` §13's `WrapPolicy` makes the wrap a
first-class property of the emitted text. Re-wrapping a command at 320px produces text that is not
what you would paste.

The argument that it is not: a user at 400% zoom is not pasting; they are reading, and reading a
horizontally-scrolling block is miserable.

**Resolution — do both, and make the choice explicit.** A config block at any width below its
natural measure shows a control in its header:

```
PHASE 1 — PROPOSAL, POLICY, GATEWAY          ⟨ wrap to fit ⟩   ⟨ copy ⟩
```

- Default below `--bp-cols`: **wrap to fit**, with the continuation shown as a hanging indent and
  a `↳` glyph that is `aria-hidden`, and a margin tab reading `wrapped to fit — copy still pastes
  the real wrap`.
- The clipboard payload is **never** affected by the display wrap. It is always
  `render(EmittedLine, WrapPolicy::Display { cols: 72 })`.
- Opting back into the real wrap re-enables horizontal scroll inside the block only.

So the 1.4.10 exception is not relied upon as the primary path — it is available for the user who
wants the real geometry, and the conformant path is the default. That is the right way round.

**The one place the exception is genuinely used: the diagram.** A network topology is
two-dimensional for meaning; that is what it is. At 320 px the diagram view **shows the Outline
full-width and collapses the canvas to a summary line** with a control to expand it into a
pan-and-zoom surface. The Outline is not a fallback here — it is the same interface everyone uses
(§4.5.2), so the narrow layout is a rearrangement, not a degradation. **A view whose accessible
representation is also its narrow-viewport representation is a view that will still work in three
years**, because both cases are exercised by the same code path.

Verification at 200% and 400% is three e2e assertions per view, on every PR:

```
for zoom in [200, 400]:
  for view in [finder, walkthrough, config, findings, diagram, inventory]:
    ASSERT document.scrollingElement.scrollWidth <= clientWidth + 1   # no body h-scroll
    ASSERT every interactive element is reachable by Tab
    ASSERT no element's text is clipped (scrollHeight <= clientHeight per text box)
```

### 6.4 1.4.12 Text Spacing — where we break, and the fix

The criterion requires that applying **all four** of the following, and changing nothing else,
causes no loss of content or functionality: line height ≥ 1.5 × font size; paragraph spacing ≥ 2 ×
font size; letter spacing ≥ 0.12 × font size; word spacing ≥ 0.16 × font size.

**Two real breakages in this design:**

| Breakage | Detail | Fix |
|---|---|---|
| **Fixed row heights in the virtualised lists** | `41` §4.5a fixes row height so the virtualiser can compute offsets in `O(1)`. A user stylesheet setting `line-height: 1.5 !important` makes `--t-mast` (15px) need 22.5px inside a 20px row, and the text clips | **The row height is measured, not hardcoded.** On mount, and on every `fonts.ready` and every `matchMedia` change, render one off-screen probe row with the longest realistic content and read its `offsetHeight`; that becomes the virtualiser's row height. Cost: one forced layout per condition change, and the virtualiser must be able to re-measure without losing scroll position (anchor on the focused row's `ElementId`, not on a pixel offset) |
| **Tracked uppercase heads** | `--track-head` is 0.14em; a user adding 0.12em brings it to 0.26em. A centred or right-aligned tracked run also has the trailing-space problem (`51` §7.7 rule 2) | Heads are `overflow-wrap: anywhere` and have no fixed width or height. The trailing-space compensation uses `margin-inline-end: calc(-1 * var(--track-head))` — which under-compensates when the user adds tracking, leaving the head ~1.5px off axis. **Accepted.** A slightly off-axis head is not "loss of content" |

**Not a breakage, contrary to instinct: `--lh-step` as a length.** `51` §7.6 sets `line-height` to
`1.25rem` rather than a ratio, and 20px on 13px is 1.538 — already above the 1.5 threshold. On
12.5px mono it is 1.6. On `--t-mast` (15px) it is 1.333 and on `--t-title` (21px) it is 1.143,
which is *below* 1.5 — but 1.4.12 is a requirement that the page **survive the user setting it**,
not that the page ship at it. Since the user's `!important` wins over our length, and the fix above
makes rows re-measure, it survives.

### 6.5 Target size, walked through

| Target | Size | Conformance |
|---|---|---|
| Config line, `Comfortable` | full width × 24px | 2.5.8 met outright |
| Config line, `Compact` | full width × 20px | Fails the 24px minimum; **the Spacing exception applies**: a 24px-diameter circle centred on each row's bounding box does not intersect another target, because rows are full-width and stacked with no horizontal neighbours. <!-- VERIFY: confirm with the Understanding document's own worked examples that a full-width 20px row stack satisfies the Spacing exception; the circle-intersection test is about *centres*, and vertically stacked 20px rows put centres 20px apart, which is < 24. If it does not satisfy it, `Compact` is non-conformant outright and the setting text in §6.1 must say so without the exception. --> |
| Provenance chip inside a line | ~11px tall, inline | **Inline exception** — "constrained by the line-height of non-target text" |
| View rail tab | ≥ 24px both axes | met |
| The `▸` selection glyph | not a target — the whole row is | n/a |
| Diagram node | ≥ 24 × 24 CSS px at zoom ≥ 1; **below zoom 1 it shrinks** | The Outline row is the **Equivalent** target (≥ 24px tall, always) — which is one more reason the Outline is not optional |

---

## 7. Motion, reduced motion, forced colours

### 7.1 Motion — already settled, restated in one line

One animation product-wide: a 90 ms opacity fade on inline disclosure, on content that is already
in the DOM and already announced (`51` §12). `prefers-reduced-motion: reduce` zeroes it and **loses
nothing**, which is the whole reason it is the only animation.

### 7.2 What this document adds: the diagram's motion candidates, and their refusal

| Candidate | Refused because |
|---|---|
| Animating node positions after a re-layout | It is the single most common vestibular trigger in a diagram editor, and at 500 nodes it is 500 concurrent transforms. Under `prefers-reduced-motion` it would have to be disabled, which means the users most likely to be disoriented by an instantaneous re-layout are the ones who get the instantaneous re-layout |
| Pan inertia / momentum | Motion the user did not ask for, continuing after input stops |
| Zoom easing | Same |
| A "pulse" on a newly created node | `51` §12's argument about the egress indicator applies verbatim |
| Edge-drawing animation while connecting | The line follows the pointer; that is direct manipulation, not animation. **Allowed**, and exempt from `prefers-reduced-motion` because it is a direct response to continuous input |

**The re-layout disorientation problem is real and is solved structurally, not with animation.**
`56` §3.5 seeds each re-layout's crossing-reduction ordering from the previous one, so a small graph
change produces a small position change. Where a re-layout does move things substantially, the view shows a **static
ghost**: the previous bounding boxes drawn once in 1px `--hairline`, dismissed on the next
interaction, plus a margin tab `re-laid out · 6 nodes moved`. Static, skippable, announced, and it
survives reduced motion because it is not motion.

### 7.3 Forced colours and SVG — the case `51` §6 does not cover

Under `forced-colors: active` the user agent overrides SVG `fill` and `stroke` along with `color`
and `background-color`. For the diagram that means:

| Device | What happens | Rule |
|---|---|---|
| Node rect: 1px `--ink` stroke, `--page` fill | Both become system colours; the boundary survives as `CanvasText` | fine |
| **Zone band drawn as a fill or a wash** | The fill collapses to `Canvas` and **the band disappears entirely** | **A zone band must always have a stroke, never only a fill.** `56` §4.4's zone bracket is stroke-only for exactly this reason, and it was the right call before forced colours was considered |
| Tunnel drawn as two parallel hairlines | Stroke geometry survives; both rails become `CanvasText` | fine, and this is why the tunnel is geometry rather than a colour |
| Stale node drawn in `--muted` stroke (`56` §8) | `--muted` and `--ink` both become `CanvasText`; **the staleness step disappears** | It cannot switch to a dash — dash is globally reserved for AI-proposed and dotted for pending (`51` §9), and `56` §5.2's channel budget depends on that reservation holding inside the diagram too. **It switches to a word:** the node's second label line (`parsed 11 months ago`) is forced on regardless of zoom under `forced-colors: active`. When a visual channel dies, fall back to text — which is this document's thesis, applied to itself |
| Selection: 2px stroke + `▸` glyph | The glyph is a text node and survives | fine (`51` §4.6 already made this argument) |
| Risk swatch in a legend | All three collapse to one | R2's word is revealed (`51` §6) |

```css
@media (forced-colors: active) {
  .dg-node          { forced-color-adjust: auto; }            /* let the UA win */
  .dg-node .dg-age  { display: block; }        /* the age line, forced on at every zoom */
  .dg-band          { fill: none; stroke: CanvasText; }        /* never fill-only */
  .dg-focus-ring    { stroke: Highlight; }
}
```

### 7.4 `prefers-contrast` wiring

```css
@media (prefers-contrast: more)   { /* §2.6's adjusted sets */ }
@media (prefers-contrast: custom) { /* matches forced-colors: active; §7.3 + 51 §6 */ }
/* prefers-contrast: less is deliberately not implemented — §2.6 */
```

`prefers-contrast: custom` is the value that matches when a user has a forced-colours palette
active, so the two rules must not fight. Ordering: the `forced-colors` block comes last in the
stylesheet and wins.

---

## 8. Where the aesthetic and accessibility genuinely conflict

*margin tab: read this before arguing with any of it*

Every row below is a real conflict, not a solved one. The resolution column is a choice with a
cost, and the cost column is what it actually costs.

| # | The aesthetic wants | Accessibility wants | Resolution | What it costs |
|---|---|---|---|---|
| **C1** | Hairlines at `#D2D7DD`, 1.45:1 — *"the card's most beautiful device"* | 3:1 for anything bounding a control (1.4.11) | Hairlines stay, and are **structurally forbidden** from bounding a control, a focus ring, a selected row, or anything in the diagram that carries meaning (§2.5 F1) | Input borders are `--muted` (5.77) instead of hairline, which makes forms visibly heavier than the card's tables. It is the single most visible compromise in the product |
| **C2** | 10px and 11px annotation type — the margin tab register | Larger text, or at least AAA contrast at those sizes | Sizes stay; **`--muted` clears 4.5:1 at every size**, and margin tabs **never carry information that appears nowhere else** (`54` §25 failure 3). `prefers-contrast: more` takes `--muted` to 7:1 | A user who needs 200% zoom to read 11px is zooming the whole interface, which is the correct mechanism but does mean the dense layout collapses to one column earlier than a larger base size would |
| **C3** | 20px rows — density is the point | 24 × 24 px targets (2.5.8) | **24px is the default**; 20px is an opt-in per-workspace setting whose own description names the criterion it fails (§6.1) | 20% of vertical space on the densest and most valuable screen, for every user who never opens the setting. That is the honest price of a conformant default |
| **C4** | Three colours, no fourth, no icons | Colour must never be the only cue; the three are 1.00–1.82:1 apart under CVD (§3.2) | **The word ships with the colour, always** (§3.1), enforced by a monochrome CI test (§3.4) | Every risk element is wider than a coloured dot. In a dense table that is real width, and it is why the short form and the always-present legend exist |
| **C5** | Neutral severity — no colour ramp for findings | A colour ramp is faster to scan | Obeyed; `51` §18 already prices it at *"roughly half a second slower to scan"* | Half a second per findings list, every time. Paid so that green means one thing |
| **C6** | A diagram — the impressive view | A picture is not usable non-visually | **The Outline is the interface, for everyone** (§4.5.2), the SVG is `aria-hidden`, and CI asserts a bijection | Gestalt is lost and cannot be recovered (§4.5.9). Also: two representations to keep in sync forever, which the bijection test makes survivable but does not make free |
| **C7** | No shadows, no radius, no icons — nothing looks like a control | Users must be able to tell what is interactive | Hover changes ground by one step; the cursor changes; `?` renders the complete keyboard map; **every keyboard-only affordance has a visible twin** (`54` §23) | Discoverability. A new user genuinely cannot tell that a config line is clickable until they hover it. The mitigation is that the product is used daily by the same people, not browsed by strangers — a real argument, and one that does not help the stranger |
| **C8** | Letterspaced uppercase heads | Uppercase is harder to read and typed spaces destroy screen-reader output | `text-transform` + `letter-spacing` only, never typed spaces; uppercase restricted to heads, labels, buttons, the legend and the one-line imperative (`51` §7.7) | Uppercase running text would be a defect; the restriction means the register can never be extended to body copy, which nobody wanted anyway |
| **C9** | Mono-in-prose at 0.96em — the card's texture | Two families at two sizes in one line is harder for some dyslexic readers | Kept. The mono **is** the semantic — it marks "this is a literal identifier you will type" — and replacing it with quotation would be worse for the same readers | No mitigation offered beyond the user's own font-override stylesheet, which our `rem`-based sizing survives |
| **C10** | A findings panel that updates as you type | A live region that fires every 400 ms is unusable | 2-second quiet window, coalesced net-change announcements, count not content (§4.6) | A screen-reader user learns about a finding up to 2.4 s after a sighted user sees it. Accepted |
| **C11** | The dark theme's three semantics at equal luminance (`51` §5.3 M3) | They become one colour under achromatopsia and on a monochrome printer (§3.2) | Kept, because the alternative is a pink `--danger`; **the word carries it** | The dark theme's colour layer conveys nothing to a monochrome viewer. It conveys nothing *harmful* either, because it was never load-bearing |
| **C12** | AAA contrast on request | The AAA dark set makes `--danger` `#FF827D` — pink | Ship the pink (§2.6) | The one place where an explicit user preference overrides a considered design decision, and it should |

**The pattern across all twelve:** in this design, almost every conflict is resolved by *adding a
word*, not by adding a visual device. That is not a coincidence — it is what the card already does,
four times, on every side. The legend, the margin tab, the one-line imperative and the numbered
plumbing list are all text standing in for chrome, and text is the one medium that works for
everybody.

---

## 9. Testing

### 9.1 What automated tooling finds and does not

`axe-core` runs in the e2e harness as a **development dependency** — it is not in the shipped
bundle, so invariant 1 is untouched (`34` §8.2's zero-runtime-dependency rule is about runtime).
It reliably finds missing names, bad roles, duplicate ids, contrast on solid backgrounds, and
missing form labels.

It cannot find any of the following, which are the defects this design is actually exposed to:

| Defect | Found by |
|---|---|
| A `Risk` rendered as colour with no word | §3.4's monochrome test |
| The Outline missing a row that the SVG draws | §4.5.8's bijection test |
| A tracked head typed as literal spaces | A DOM lint for `/\b(\w\s){3,}\w\b/` in heading text |
| A hairline used as an input border | A CSS grep, `51` §3.3 |
| A live region that fires every 400 ms | A harness that counts `aria-live` mutations per second during a scripted typing run and fails above 1 |
| A virtualised row unmounted while focused | An e2e run that focuses row 200, scrolls to row 4,000, and asserts `document.activeElement !== document.body` |
| Focus invisible on the egress band | A pixel-diff of the focused and unfocused states, asserting ≥ 3:1 on the changed pixels — which is 2.4.13's own test, automated |
| Clipping under the 1.4.12 text-spacing stylesheet | An e2e run that injects the four declarations and asserts `scrollHeight <= clientHeight` on every text box |

Eight first-party checks, each of which exists because a real defect in this specific design would
otherwise ship. **A conformance suite that only runs `axe` on this product would report a clean bill
of health on a screen where the diagram is an unlabelled rectangle.**

### 9.2 The fixture

One workspace, used by every accessibility test, and it is the same fixture `44` §4.3 uses for the
finder and `45` uses for parsing: **side 1 of the field card, both ends modelled.** Two SRXs, a
route-based tunnel, `reth0.0` and `st0.0`, the five plumbing pieces, one deliberately missing
`host-inbound-traffic system-services ike` so that `zone.host-inbound.ike-missing` fires, and one
device whose newest `Parsed` provenance is 14 months old so the `Unverified` band is exercised.

Using one fixture across performance, parsing and accessibility is the only reason it will stay
current.

### 9.3 The manual script

Automated checks do not tell you whether the Outline is *usable*. Once per release, one person who
uses a screen reader daily performs these four tasks, timed, on the P0 combinations:

| # | Task | Pass condition |
|---|---|---|
| 1 | "This tunnel is not coming up. Find out whether the WAN zone allows IKE." | Reaches the finding and reads its `why` without sighted assistance |
| 2 | "Tell me what `SRX-A`'s `st0.0` is connected to." | Uses the Outline + connections table; does not need the digest |
| 3 | "Copy the Phase 1 block into a change ticket." | Clipboard content is byte-identical to the visible block |
| 4 | "Which devices in this workspace have not been re-parsed in over a year?" | Finds them from the inventory or the Outline; the age is spoken, not inferred |

Task 4 exists because staleness is the one signal that is carried differently in every view, and it
is the one most likely to be silently dropped.

---

## 10. Failure modes

| # | Failure | What it looks like | What you will wrongly blame | The fix |
|---|---|---|---|---|
| 1 | A "compact" risk rendering drops the word because the legend is nearby | Then the legend moves | "the legend was redundant" | §3.1's short-form rule and §3.4's step 5 |
| 2 | The Outline is treated as an accessibility feature and stops being the default interface | It rots within two releases | "nobody used it" | §4.5.2 — it is where selection lives for everybody |
| 3 | Somebody adds `tabindex` to SVG shapes to "make the diagram keyboard accessible" | Duplicate announcements; focus that the ring does not follow | "screen readers are inconsistent" | §4.5.2. Focus never enters the SVG |
| 4 | The findings live region is made `assertive` "so people notice" | Typing an IP address becomes impossible | "the screen reader is too chatty" | §4.6. One `alert` in the product and it is egress |
| 5 | Row heights hardcoded for the virtualiser | Text clips under a user text-spacing stylesheet | "that stylesheet is unusual" | §6.4. Measure a probe row |
| 6 | Focus ring left as `--ink` on the egress band | Keyboard users cannot see where they are on the one element that matters most | "the band is fine, it is inverted" | §5.2 |
| 7 | `prefers-contrast: more` implemented by multiplying every colour by a factor | Hues shift, the washes go grey, `--danger` and `--caution` converge | "high contrast looks broken" | §2.6 — solve at fixed hue, per token, against the worst permitted ground |
| 8 | The dark severity ramp left as three tones | `high` and `medium` are 2.38:1 apart and indistinguishable | "severity is unclear in dark mode" | §2.5 F3 — width, not tone |
| 9 | The diagram exported to PNG and put in a ticket as the topology record | The record is now an image with no text alternative, outside our control | "we gave them an export" | §4.5.7's digest is what goes in a ticket. `56` §9 makes the digest part of the export |
| 10 | A new decoration added to the diagram with no Outline row | Silent, until a user reports a missing device | "the Outline is out of date" | §4.5.8's bijection test fails the build |
| 11 | `.vh` implemented with `display: none` or `visibility: hidden` | The word is removed from the accessibility tree, and R2 is silently void | "we hid it, same thing" | `51` §14's `.vh` — absolute positioning with `clip-path`, never `display` |
| 12 | An accessibility overlay widget proposed to "fix conformance quickly" | A script from a third-party host | "it is just one script" | Invariant 1 makes it impossible, and §1.3 says why that is a benefit |

---

## 11. Open decisions

**DECISION — the severity ramp: tone or width (§2.5 F3).** The dark theme forces width. Using width
in both themes is one encoding instead of two and survives forced colours and monochrome print
unchanged. **RECOMMENDATION — width in both, and delete the tone ramp.** This is a proposed change
to `51` §4.4 and needs that document's author to agree or refuse.

**DECISION — `Compact` density and SC 2.5.8 (§6.1).** Position taken: ship it, default to the
conformant mode, state the criterion in the setting's own text. Depends on the VERIFY in §6.5 about
whether the Spacing exception actually covers a full-width 20px row stack. **If it does not, the
setting text loses the exception clause and simply says it is non-conformant** — which is still a
defensible thing to ship as an opt-in, and is more honest than a wrong exception citation.

**DECISION — is the `<svg>` `aria-hidden`?** (§4.8 VERIFY item 6.) Hiding it is correct if and only
if the bijection holds. If a future decoration cannot be represented in the Outline, the whole
position collapses and the SVG has to be exposed with per-element naming — which is a materially
worse design. **RECOMMENDATION — treat "can this be represented in the Outline" as an acceptance
criterion for every new diagram decoration**, enforced by §4.5.8.

**Open, not decided — a text-only mode.** A view that renders the entire product as the digest
format (§4.5.7) — no SVG, no virtualisation, no roving lists — would be trivially accessible, would
work at 320px, and would be about 300 lines of code. It is tempting and it is also the classic
trap: a second interface that receives a fifth of the maintenance. **RECOMMENDATION — no, and
revisit only if the P0 manual script (§9.3) fails twice in a row.**

**Open, not decided — internationalisation.** The corpus is English-only at v1. Every accessible
name in §4 is generated from English templates in the core. Adding a second language means the
`spoken` generator becomes localisable, which is a core change, not a UI one. Naming it now so it
is not a surprise.

---

## 12. Sources consulted

- `.context/design-language.md` — the extracted palette, type, structure and voice. Every hex
  audited in §2 comes from it.
- `.context/field-card-srx-ipsec.txt` — the `ERROR DECODER` table (§4.2), the Phase 1 block
  (§4.3), the five plumbing pieces and the tunnel topology (§4.5.4, §9.2).
- W3C, *Web Content Accessibility Guidelines (WCAG) 2.2* — SC levels and normative text for
  1.4.3, 1.4.4, 1.4.6, 1.4.10, 1.4.11, 1.4.12, 2.4.7, 2.4.11, 2.4.12, 2.4.13, 2.5.7, 2.5.8, 4.1.3.
  1.4.10's exception and 2.5.8's Spacing and Inline exceptions are quoted from the specification
  and its Understanding document.
- WCAG 2.x relative-luminance formula for every ratio in §2; OKLab/OKLCh with the standard M1/M2
  matrices for the §2.6 solve.
- Viénot, Brettel & Mollon (1999) LMS dichromat projection for §3.2, with the tritanopia caveat
  marked VERIFY in that section.
- MDN, `prefers-contrast` (values `no-preference | more | less | custom`; `custom` is what matches
  under `forced-colors: active`) and `vector-effect` (`non-scaling-stroke`, Baseline since 2020).
- Prevailing SVG accessibility guidance that interactive controls should use native HTML for the
  focus and keyboard model rather than adding handlers and `tabindex` to SVG elements — which is
  the basis of §4.5.2.
- `docs/50-design/51-design-tokens.md` §3.4, §4, §5.5, §6, §7.5–7.7, §8, §12, §14 — the token set
  this document audits.
- `docs/50-design/54-component-catalog.md` §23, §24, §25 — the keyboard map and the summarised
  contract this document is the long form of.
- `docs/40-stack/44-performance-budgets.md` §4.4, §4.7 — the 400 ms debounce and the diagram's
  element budget, both of which constrain §4.6 and §4.5.
- `docs/10-core/11-ir-schema.md` §8.7 — the staleness bands §3.5 and §7.3 render.
- `docs/30-security/34-browser-hardening.md` §5.6, §8.2 — the closed SVG tag set and the
  zero-runtime-dependency rule that shapes §9.1.

## 13. Disagreements

None with the binding conventions. Three notes on things adjacent to them:

**1. The three-value risk enum is right and this document proves it the hard way.** §3.2 shows the
three colours are 1.00–1.82:1 apart under every simulated deficiency, which looks like an argument
against a colour-coded enum. It is the opposite. A *four*-value enum would need four mutually
distinguishable colours on one ground, which is strictly harder, and the fourth value would arrive
without the legend discipline that makes the first three survivable. The convention's real content
is not "three colours" — it is "one legend, everywhere, unchanged," and that is what carries the
semantics for everybody.

**2. Proposed change to `51` §4.4** — the severity ramp should be width, not tone, in both themes.
Reasoning in §2.5 F3. Recorded here rather than as a disagreement because `51` §4.4 is a design
decision, not a convention.

**3. A note on `51` §4.9's cost accounting.** That section lists four costs of the neutral encoding
scheme and prices peripheral detection and learnability honestly. It does not list the fifth, which
this document found: **the neutral ramp's own steps have to satisfy 1.4.11 against each other, and
in one theme they do not.** That is not a criticism of the scheme — it is the kind of thing you
only find by computing every pair, which is why §2.7 makes it a test rather than a table.
