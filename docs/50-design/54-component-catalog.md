# 54 — Component catalogue

> **Status:** Proposed

Companion documents: `docs/50-design/51-design-tokens.md` (every value used here),
`docs/10-core/13-emitters-and-provenance.md` (`EmittedLine`, `Risk`, `WrapPolicy`),
`docs/10-core/12-rule-engine.md` (`Finding`, `Severity`, `Confidence`, `FindingState`,
`Suppression`), `docs/10-core/16-command-finder.md` (what the palette searches),
`docs/10-core/18-diff-verify-rollback.md` (diff semantics — §16 here renders what that
document decides), `docs/20-ai/21-ai-layer-architecture.md` (what §19 has to make visible).

**Every component in this catalogue is derived from a device on the owner's field card, not
from a component library.** There is no `Card`, no `Badge`, no `Chip`, no `Modal` with a
rounded corner and a drop shadow, no `Toast`, no `Skeleton`, no `Avatar`, no `Breadcrumb`. The
card has none of those and neither does this. Where a conventional interface would reach for
one, the entry below says what the card does instead and why it is better for this product.

The worked content in every example is real material from `.context/field-card-srx-ipsec.txt`.
Nothing is lorem.

---

## 0. Contents

| § | Component | Card device it comes from |
|---|---|---|
| 1 | How to read this catalogue | — |
| 2 | Shared primitives | — |
| 3 | Masthead | the 3px rule and the `SIDE n ·` block |
| 4 | Margin tab | `read this first`, `most-missed`, `approx` |
| 5 | The one-line imperative | `BOTH ENDS MUST AGREE — EVERY VALUE, EXACTLY` |
| 6 | Risk legend | the legend on all four sides |
| 7 | Accent-bar note | the 4px bar + wash |
| 8 | Mono config block | `set security ike proposal IKE-P1 \` |
| 9 | Two-column hairline table | `ERROR DECODER`, `FLAP PATTERN → CAUSE` |
| 10 | Numbered plumbing list | `#1 the tunnel interface` … `#5` |
| 11 | View rail | — (new; the screen has six views, the card has four sides) |
| 12 | Finder palette | — (new; §6.1 of the brief) |
| 13 | Finding row | the two-column table, plus severity |
| 14 | Suppression record | — (new; the audit artifact) |
| 15 | Depth toggle | the margin tab |
| 16 | Diff view | the two-column table |
| 17 | Provenance disclosure | — (new; inline, because §11 of the tokens doc says no overlays) |
| 18 | Inspector | the two-column table, as a column |
| 19 | AI proposal surface | — (new; must be unmistakably not the card) |
| 20 | Egress-armed indicator | — (new; inversion, used nowhere else) |
| 21 | Folio / footer | `SIDE 1 OF 4 — BUILD, PROVISION, PLUMB` |
| 22 | Channel audit — proving R3 holds | — |
| 23 | Product-wide keyboard map | — |
| 24 | Accessibility contract, summarised | — |
| 25 | Failure modes | — |
| 26 | Open decisions | — |
| 27 | Sources consulted | — |
| 28 | Disagreements | — |

---

## 1. How to read this catalogue

Every entry has the same eight parts. If an entry omits one, it says why.

| Part | What it contains |
|---|---|
| **Provenance** | The device on the card this comes from, quoted. New components say so. |
| **Anatomy** | The parts, named. Names match the class names. |
| **HTML** | Complete and copy-pasteable. No framework. No `div` where an element exists. |
| **CSS** | Complete. Every value is a token from `51-design-tokens.md`. No hex, no raw px font sizes. |
| **States** | Every state, and the channel that carries it (tokens §4.2). |
| **Keyboard** | Every key. "None" means the component is not interactive, and that is a claim. |
| **Accessibility contract** | Roles, names, relationships, live regions, and the non-visual equivalent of every visual signal. |
| **Cost** | What this component is worse at than the conventional alternative. Named, not buried. |

**The three global rules from `51-design-tokens.md` §1 are in force in every entry:**

- **R1** — the three risk colours are reserved for `Risk` and nothing else.
- **R2** — no component encodes meaning in colour alone; the word is always present.
- **R3** — one channel, one owner, per component. §22 audits this.

---

## 2. Shared primitives

These are not components. They are the four things every component uses.

### 2.1 `.vh` — visually hidden, and revealed under forced colours

```css
.vh { position: absolute; width: 1px; height: 1px; overflow: hidden;
      clip-path: inset(50%); white-space: nowrap; }
@media (forced-colors: active) {
  .risk-dot .vh, .risk-bar .vh, .pill .vh {
    position: static; width: auto; height: auto; clip-path: none; }
}
```

R2 lives here. Every 6px risk dot, every 4px risk bar, every severity bar carries its word in a
`.vh` span. Under forced colours the colour is gone and the word appears in its place. This is
the entire high-contrast strategy and it costs three words of markup per element.

### 2.2 `.tab` — the margin tab primitive

Specified as a component in §4 because it is one, but every other component embeds it.

### 2.3 `.btn` — the button

The card has no buttons. This is the smallest possible addition consistent with it: a 1px
`--ink` rule, uppercase tracked label, no radius, no fill until hover, and hover is an
inversion of the same two tokens.

```css
.btn {
  background: var(--page); color: var(--ink);
  border: var(--rule-hair) solid var(--ink); border-radius: var(--radius);
  font-family: var(--sans); font-size: var(--t-tab); font-weight: 700;
  letter-spacing: var(--track-label); text-transform: uppercase;
  padding: var(--s2) var(--s3); min-height: var(--row-min);
  cursor: pointer; transition: none;
}
.btn:hover  { background: var(--ink); color: var(--page); }
.btn:active { background: var(--muted); border-color: var(--muted); }
.btn[disabled] { border-color: var(--hairline); color: var(--muted); cursor: default; }
.btn[disabled]:hover { background: var(--page); color: var(--muted); }
.btn.ghost  { border-color: var(--muted); font-weight: 400; }
.btn.ghost:hover { background: var(--surface); color: var(--ink); border-color: var(--ink); }
.btn:focus-visible { outline: var(--focus-width) solid var(--focus-colour);
                     outline-offset: var(--focus-offset-outset); }
```

Border is `--muted` at minimum, never `--hairline` — a 1.45:1 border on an interactive control
fails WCAG 1.4.11 (tokens §3.4). `min-height: var(--row-min)` satisfies SC 2.5.8.

There are exactly two variants: default and `.ghost`. There is no primary/secondary/tertiary
ladder, because a screen with three button weights is a screen that has stopped saying what
matters.

### 2.4 `.field` — the labelled input

```html
<div class="field" data-state="invalid">
  <label for="f-dpd">Dead peer detection interval</label>
  <span class="tab">seconds; interval × threshold is the blackhole window</span>
  <div class="field-row">
    <span class="field-gutter" aria-hidden="true">!</span>
    <input id="f-dpd" type="text" inputmode="numeric" value="0"
           aria-invalid="true" aria-describedby="f-dpd-msg f-dpd-hint">
  </div>
  <p class="field-msg" id="f-dpd-msg">Must be 1 or greater. Junos rejects 0 at commit.</p>
  <p class="field-hint" id="f-dpd-hint">Default is 10 × 5 = 50 s of blackhole before failover
    even starts. 10 × 3 is a reasonable middle.</p>
</div>
```

```css
.field { margin: 0 0 var(--s4); max-width: var(--measure); }
.field label { display: block; font-size: var(--t-micro); font-weight: 700;
               letter-spacing: var(--track-label); text-transform: uppercase;
               color: var(--muted); }
.field-row { display: flex; align-items: stretch; }
.field-gutter { font-family: var(--mono); font-size: var(--t-mono); color: var(--ink);
                width: var(--s3); flex: none; display: none;
                align-items: center; font-weight: 700; }
.field input, .field textarea, .field select {
  flex: 1; min-width: 0; background: var(--page); color: var(--ink);
  font-family: var(--mono); font-size: var(--t-mono);
  padding: var(--s2) 0; min-height: var(--row-min);
  border: 0; border-bottom: var(--rule-hair) solid var(--hairline);
  border-radius: var(--radius);
}
.field input:focus-visible { outline: var(--focus-width) solid var(--focus-colour);
                             outline-offset: var(--focus-offset-outset); }

/* Validation. Tokens §4.8 — C8 underline + C5 gutter glyph. No colour. */
.field[data-state="unanswered"] input { border-bottom-style: var(--rule-style-pending); }
.field[data-state="invalid"]    input { border-bottom-width: 2px;
                                        border-bottom-color: var(--ink); }
.field[data-state="invalid"]    .field-gutter { display: flex; }
.field-msg  { display: none; font-size: var(--t-small); font-weight: 700;
              color: var(--ink); margin: var(--s1) 0 0; }
.field[data-state="invalid"] .field-msg { display: block; }
.field-hint { font-size: var(--t-small); color: var(--muted); margin: var(--s1) 0 0; }
```

The input's value is set in `--mono`, always. Every value an engineer types into this product
is an identifier, an address, an algorithm name or a number, and all four are mono on the card.

**Cost.** A 2px ink underline is not findable in peripheral vision the way a red border is.
Tokens §4.8 requires three compensations and all three are mandatory: a live count in the form
header, `aria-invalid` + `aria-describedby`, and focus moving to the first invalid field on
submit. The focus move is the real fix; the underline is a reminder.

### 2.5 The roving-tabindex list contract

Used by the config block (§8), the finding list (§13), the diff view (§16) and the finder's
result list (§12). Specified once here.

A list of *n* interactive rows is **one tab stop**, not *n*. Inside it:

| Key | Behaviour |
|---|---|
| <kbd>↓</kbd> / <kbd>↑</kbd> | Move the roving `tabindex="0"` to the next/previous row and focus it. Does not wrap. |
| <kbd>Home</kbd> / <kbd>End</kbd> | First / last row. |
| <kbd>PgDn</kbd> / <kbd>PgUp</kbd> | ±10 rows. |
| <kbd>Enter</kbd> / <kbd>Space</kbd> | Activate — expand the row's disclosure, or select. |
| <kbd>Esc</kbd> | Collapse all disclosures in the list; focus stays. Second press moves focus to the list container. |
| <kbd>Tab</kbd> | Leaves the list entirely. |

**Why this deviates from the APG's usual "every button is a tab stop".** A 200-line config
block would be 200 tab stops. That is worse for a keyboard user than for anyone else — it makes
the block impossible to skip. The container carries
`aria-describedby` pointing at a one-line instruction (`.vh`: *"Use arrow keys to move between
lines. Enter shows where a line came from."*) so the pattern is announced rather than
discovered.

```js
// The whole contract, once, shared.
function rovingList(container, rowSelector) {
  const rows = () => [...container.querySelectorAll(rowSelector)];
  let i = 0;
  const focusRow = n => {
    const r = rows(); if (!r.length) return;
    i = Math.max(0, Math.min(n, r.length - 1));
    r.forEach((el, k) => el.tabIndex = k === i ? 0 : -1);
    r[i].focus();
  };
  rows().forEach((el, k) => el.tabIndex = k === 0 ? 0 : -1);
  container.addEventListener('keydown', e => {
    const k = e.key;
    if (k === 'ArrowDown') { focusRow(i + 1); e.preventDefault(); }
    else if (k === 'ArrowUp') { focusRow(i - 1); e.preventDefault(); }
    else if (k === 'Home') { focusRow(0); e.preventDefault(); }
    else if (k === 'End') { focusRow(rows().length - 1); e.preventDefault(); }
    else if (k === 'PageDown') { focusRow(i + 10); e.preventDefault(); }
    else if (k === 'PageUp') { focusRow(i - 10); e.preventDefault(); }
  });
}
```

---

## 3. Masthead

### Provenance

> ```
> ┌─ 3px ink rule ───────────────────────────────────────────────┐
>    SIDE n · <THREE WORDS, DOT-SEPARATED>        <margin tabs>
>    <TITLE IN LETTERSPACED CAPS>
>    <subtitle / companion line, muted>
>    <one all-caps imperative warning, full width>
> ```

Every one of the four sides opens with this, unchanged. It is the strongest structural signal
on the card and it is what makes a side identifiable at arm's length.

### Anatomy

```
 ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔  .masthead   (3px --ink, border-top)
 CONFIG · SRX-A · IPSEC              read this first   nothing is committed
 └── .eyebrow ──┘                    └──────── .tabs ────────────┘
 S R X   I P S E C   —   B U I L D I N G   A   T U N N E L        h1
 The object chain · companion to the SRX field card               .subtitle
 ─────────────────────────────────────────────────────────────    1px --ink
 VERIFY AGAINST YOUR OWN BOX BEFORE ACTING                        .imperative
```

### HTML

```html
<header class="masthead">
  <div class="mast-row">
    <p class="eyebrow">Config · srx-a · ipsec</p>
    <div class="tabs">
      <span class="tab">read this first</span>
      <span class="tab">nothing is committed</span>
    </div>
  </div>
  <h1>SRX IPsec — building a tunnel</h1>
  <p class="subtitle">The object chain · companion to the SRX field card</p>
  <p class="imperative">Verify against your own box before acting</p>
</header>
```

Note: the DOM text is **sentence case**. The capitals are `text-transform`. Tokens §7.7 rule 1
— a screen reader must not spell out `S R X  I P S E C`.

### CSS

```css
.masthead {
  border-top: var(--rule-mast) solid var(--ink);
  padding-top: var(--s3);
  margin-top: var(--s5);
}
.mast-row { display: flex; align-items: baseline; justify-content: space-between;
            gap: var(--s5); flex-wrap: wrap; }
.eyebrow {
  margin: 0;
  font-size: var(--t-tab); font-weight: 700;
  letter-spacing: var(--track-mast); text-transform: uppercase;
  color: var(--muted);
}
.masthead h1 {
  margin: var(--s3) 0 var(--s1);
  font-size: var(--t-title); font-weight: 700;
  letter-spacing: var(--track-head); text-transform: uppercase;
  line-height: var(--lh-title);
  margin-right: calc(var(--track-head) * -1);   /* trailing-track compensation, tokens §7.7 */
}
.subtitle {
  margin: 0;
  font-size: var(--t-small); color: var(--muted);
  letter-spacing: 0.04em; text-transform: uppercase;
}
.imperative {
  margin: var(--s3) 0 0;
  padding-top: var(--s3);
  border-top: var(--rule-hair) solid var(--ink);
  font-size: var(--t-small); font-weight: 700;
  letter-spacing: var(--track-label); text-transform: uppercase;
}
@media print { .masthead { break-after: avoid; } }
```

### States

None. The masthead is not interactive and does not change with application state, except that
the eyebrow interpolates the current workspace and node (`Config · srx-a · ipsec`). That
interpolation is the *only* dynamic content in it.

### Keyboard

None. It contains no focusable elements. `<h1>` is a landmark for heading navigation and that is
the whole keyboard story.

### Accessibility contract

- `<header>` maps to `banner` when it is a direct child of `<body>`; when it is inside a
  `<section>` it does not, and that is correct — a per-view masthead is not the page banner.
- Exactly one `<h1>` per view.
- The imperative is a `<p>`, not a `role="alert"`. It is a standing rule, not an event. Making
  it an alert would fire it on every view change and train users to ignore live regions.

### Tokens

`--rule-mast`, `--rule-hair`, `--ink`, `--muted`, `--t-title`, `--t-tab`, `--t-small`,
`--track-head`, `--track-mast`, `--track-label`, `--s1`, `--s3`, `--s5`, `--lh-title`.

### Cost

A 3px rule plus a title plus a subtitle plus an imperative is ~110px of vertical space before
any content. On a 900px-tall laptop viewport that is 12% of the screen spent on identification.
The card can afford it because a card side is a whole sheet; a scrolling view cannot, quite.
**Mitigation:** the masthead does not stick. It scrolls away. The only sticky element in the
product is the egress band (§20).

---

## 4. Margin tab

### Provenance

> **The margin tab.** Tiny muted labels floating at the top-right of a side — `read this
> first`, `most-missed`, `verify as you go`, `why it exists`, `fields that matter`, `what the
> log means`, `up-ness`, `approx`, `DF ping`, `not VPN-specific`. Lowercase, unpunctuated,
> almost apologetic. They tell you *how to weight* the section without taking up a heading.

This is the most reusable device on the card and the catalogue leans on it harder than anything
else. Tokens §4.5 makes it the answer to every temptation toward a coloured badge.

### Anatomy

One `<span>`. That is the whole component. It has no box, no border, no background, no icon.

### HTML

```html
<span class="tab">most-missed</span>
<span class="tab">approx</span>
<span class="tab">heuristic, may be wrong</span>
<span class="tab">parsed 2026-03-04, 4 months old</span>
```

### CSS

```css
.tab {
  font-size: var(--t-tab);
  line-height: var(--lh-micro);
  color: var(--muted);
  font-style: italic;
  white-space: nowrap;
}
.tabs { display: flex; gap: var(--s4); flex-wrap: wrap; }

/* In a section head, the tab drops the head's tracking and uppercase. */
h2 .tab, h3 .tab { letter-spacing: 0; text-transform: none; font-weight: 400; }
```

### Rules for authoring one

These are content rules, and they are as load-bearing as the CSS:

| Rule | Why |
|---|---|
| Lowercase, always | The contrast against the tracked uppercase heads is what makes it read as an aside |
| No terminal punctuation | It is a label, not a sentence |
| One to four words | `verify as you go` is four. `this section explains the concept of dead peer detection` is a paragraph |
| Says *how to weight*, not *what it is* | `most-missed` and `approx` weight. `Configuration` describes, and the heading already did that |
| Never a verb phrase addressed to the user | `read this first` is the one exception on the card, and it earns it by being first |

### States

None on the tab itself. Tabs are used to *carry* other components' states — confidence
(§13), provenance age (§18), AI uncertainty (§19) — but the tab has none of its own.

### Keyboard

None. A tab is never focusable and never a link. The moment a tab becomes clickable it stops
being a margin note and becomes a filter chip, which is a different component from a different
design language.

### Accessibility contract

- Plain text in a `<span>`. No `role`, no `aria-label`.
- When a tab annotates a specific control, associate it with `aria-describedby` rather than
  leaving the relationship visual. §2.4's `.field` does exactly that.
- Italic at 11px is at the low end of legibility. The tab is never the sole carrier of required
  information — it always duplicates something available elsewhere (a `Confidence` value, a
  `provenance` timestamp). Verified in §22.

### Cost

11px muted italic is genuinely hard to read for low-vision users and it is *below* the 12px the
rest of the product uses. It survives because it is never load-bearing alone. If a future
component makes a tab the only place a fact appears, that component is wrong, not the tab.

---

## 5. The one-line imperative

### Provenance

> **The one-line imperative.** `VERIFY AGAINST YOUR OWN BOX BEFORE ACTING`, `BOTH ENDS MUST
> AGREE — EVERY VALUE, EXACTLY`, `THE JOIN KEY ACROSS ALL OUTPUT IS VPN NAME + PEER IP, NEVER
> ST0`, `OVERHEAD FIGURES APPROXIMATE — CIPHER-DEPENDENT`. Each side states its own governing
> rule once, in caps, at the top. It is a *disclaimer that is also the most useful sentence on
> the page.*

### Where each view's imperative comes from

This is a content requirement, not just a CSS one. Every view must have one, and it must be
the most useful sentence on that view, not a legal notice.

| View | Imperative | Source |
|---|---|---|
| Config | `Verify against your own box before acting` | Side 1 |
| Crypto / walkthrough | `Both ends must agree — every value, exactly` | Side 2 |
| Verify | `The join key across all output is VPN name + peer IP, never st0` | Side 3 |
| MTU / overhead | `Overhead figures approximate — cipher-dependent` | Side 4 |
| Findings | `Every finding says when it is acceptable to ignore it` | Brief §5.2 |
| Diff | `Unchanged produces nothing — this is a change set, not a config` | 18-diff §2 |
| Finder | `Read-only unless the risk says otherwise` | The legend |
| AI proposal | `Nothing here has been validated — accept re-runs the deterministic pipeline` | 21-ai |

### Implementation

It is `.imperative` in §3, and it is part of the masthead. It is listed as its own component
because the *content rule* — one per view, authored, specific — is the component. A masthead
with a generic imperative has failed even if the CSS is identical.

---

## 6. Risk legend

### Provenance

> That legend appears on **every one of the four sides**, unchanged. It is the card's single
> most disciplined move.

```
READ-ONLY   — SAFE ON PRODUCTION      #1F6F4A on #EEF5F1
CHANGES CONFIG — NEEDS A COMMIT       #A8571B on #FBF3EA
DISRUPTIVE  — DROPS LIVE TRAFFIC      #8C2F2F on #F8EFEF
```

### Anatomy

```
 ───────────────────────────────────────────────────  1px --hairline
 ▪ READ-ONLY — SAFE ON PRODUCTION    ▪ CHANGES CONFIG — NEEDS A COMMIT   ▪ DISRUPTIVE — …
 └ .swatch                           └ .legend-item.r-caution
 ───────────────────────────────────────────────────  1px --hairline
```

### HTML

```html
<ul class="legend" aria-label="Risk legend">
  <li class="legend-item r-safe">
    <span class="swatch" aria-hidden="true"></span>Read-only — safe on production</li>
  <li class="legend-item r-caution">
    <span class="swatch" aria-hidden="true"></span>Changes config — needs a commit</li>
  <li class="legend-item r-danger">
    <span class="swatch" aria-hidden="true"></span>Disruptive — drops live traffic</li>
</ul>
```

### CSS

```css
.legend {
  display: flex; flex-wrap: wrap; gap: var(--s5);
  margin: var(--s3) 0 0; padding: var(--s2) 0;
  list-style: none;
  border-top: var(--rule-hair) solid var(--hairline);
  border-bottom: var(--rule-hair) solid var(--hairline);
}
.legend-item {
  display: flex; align-items: center; gap: var(--s2);
  font-size: var(--t-micro); font-weight: 700;
  letter-spacing: var(--track-legend); text-transform: uppercase;
}
.swatch { width: 14px; height: 10px; flex: none; }
.r-safe    { color: var(--safe); }    .r-safe    .swatch { background: var(--safe); }
.r-caution { color: var(--caution); } .r-caution .swatch { background: var(--caution); }
.r-danger  { color: var(--danger); }  .r-danger  .swatch { background: var(--danger); }

.legend.repeat { display: none; }
@media print {
  .legend, .swatch { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .legend.repeat { display: flex; break-before: avoid; }
  .legend { break-inside: avoid; }
}
```

### Placement rule

**The legend appears on every view that renders a `Risk` value, immediately below the
masthead, always in the same place, never collapsed, never behind a disclosure.** It is not a
"first-run" element and it does not get dismissed. The card puts it on all four sides for the
same reason: a reference is consulted, not read, and a consulted page has no memory of the one
before it.

In print it repeats per top-level section (tokens §13.5).

### States

None. It never highlights the "current" risk. A legend that reacts becomes a filter, and a
filter is a control, and a control needs a keyboard contract, and now the most stable element
on the page moves. It does not move.

### Keyboard

None. `<ul>` with three `<li>`, no focusable children.

### Accessibility contract

- `<ul aria-label="Risk legend">` so a screen reader can find it in the landmark/list rotor.
- The swatch is `aria-hidden` — the text beside it already says the same thing, and announcing
  "image" three times is noise.
- Contrast: `--caution` on `--page` is 5.19:1 at 10px bold (tokens §3.4). 10px is below the
  "large text" threshold, so 4.5:1 is the requirement and it clears. `--caution` at `--t-micro`
  is never permitted on `--surface` (4.71:1 is too close to the floor for 10px type) — the
  legend always sits on `--page`.

### Cost

Three lines of 10px uppercase, repeated on every view, forever, that a returning user reads
zero times. That is ~28px of permanent overhead. The card decided this trade four times out of
four and it was right: the one time you need it, you need it immediately and you will not go
looking.

---

## 7. Accent-bar note

### Provenance

> **The 4px left accent bar.** Notes and warnings are a wash + a 4px coloured left edge —
> never a box, never an icon, never a rounded corner. In the source these are literally
> `36 562 3 234 re f` — a 3-unit-wide filled rectangle.

### Anatomy

```
 ▌ WHAT BREAKS, AND WHAT YOU WILL WRONGLY BLAME     ← .note-label
 ▌ PFS on one side and absent on the other fails    ← body
 ▌ Phase 2 while Phase 1 stays up. …
 │
 └ 4px --rule-accent, left only. Ground is the matching wash.
```

### HTML

```html
<!-- neutral note: the default -->
<aside class="note">
  <b class="note-label">The thing that looks like a bug and is not</b>
  <p>Under IKEv2 the first child SA is always keyed from the IKE SA regardless; PFS applies to
     later child rekeys. A capture of the initial bring-up showing no DH exchange is not a
     misconfiguration.</p>
</aside>

<!-- risk-coloured note: only when the note is about what a command DOES -->
<aside class="note danger">
  <b class="note-label"><span class="vh">Disruptive. </span>Clearing P1 tears down every child SA</b>
  <p>On a hub that is every spoke at once. Always scope by peer or index.
     <code>clear security ike security-associations &lt;peer-ip&gt;</code></p>
</aside>
```

### CSS

```css
.note {
  border-left: var(--rule-accent) solid var(--muted);
  background: var(--surface);
  padding: var(--s3) var(--s4);
  margin: var(--s3) 0;
  font-size: var(--t-small);
}
.note > :last-child { margin-bottom: 0; }
.note p { margin: 0 0 var(--s2); max-width: var(--measure); }
.note-label {
  display: block;
  font-size: var(--t-micro); font-weight: 700;
  letter-spacing: var(--track-label); text-transform: uppercase;
  margin-bottom: var(--s1);
}

.note.safe    { border-left-color: var(--safe);    background: var(--safe-wash); }
.note.caution { border-left-color: var(--caution); background: var(--caution-wash); }
.note.danger  { border-left-color: var(--danger);  background: var(--danger-wash); }
.note.safe    .note-label { color: var(--safe); }
.note.caution .note-label { color: var(--caution); }
.note.danger  .note-label { color: var(--danger); }

@media print { .note { break-inside: avoid;
                       -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
```

### The rule that keeps R1 intact

**A `.note` may take a risk colour only when the note is about what a command does to a live
box.** `clear security ike security-associations` tears down every child SA — that is
`Disruptive` and the note is `.note.danger`. "PFS on one side fails Phase 2" is a *finding*,
not a command, and its note is neutral.

If you cannot name the command the colour refers to, the note is neutral. That test is
mechanical and it is the whole enforcement mechanism.

### States

None. A note does not collapse, expand, dismiss or animate. It is printed matter.

### Keyboard

None, except that any `<code>` inside a note that is copy-paste material is wrapped by the
copy affordance from §8.7, which is focusable.

### Accessibility contract

- `<aside>` maps to `complementary` only as a direct child of `<body>`; nested it is a generic
  container, which is correct — a note inside an article is not a page-level landmark.
- `.note-label` is `<b>`, not `<strong>` and not a heading. It is not more *important* than the
  body (which is what `<strong>` means) and it is not a document section (which is what a
  heading means). `<b>` is the correct element for "stylistically offset without conveying
  extra importance", and the label's job here is offsetting.
- Risk-coloured notes carry `<span class="vh">Disruptive. </span>` inside the label — R2.

### Cost

The 4px bar plus `--s4` padding costs 20px of horizontal space per note. In a 480px column with
nested notes inside a plumbing list, that is visible. **Notes do not nest.** A note inside a
note becomes a 40px indent and reads as a quote inside a quote. One level, enforced by lint.

---

## 8. Mono config block

The most important component in the product. It is where `13-emitters-and-provenance.md`'s
`(line, provenance)` decision becomes visible.

### Provenance

> **Continuation backslashes preserved.** `set security ike proposal IKE-P1 \` — commands wrap
> the way they wrap in a terminal, not the way they wrap in a webpage.

Plus the card's own mono blocks on `#F2F4F6`, and the numbered plumbing (§10) that sits
alongside them.

### 8.1 Anatomy

```
 ┌ .block ────────────────────────────────────────────────────── copy · 14 lines ┐
 │ ▌ 1  ▪ set security ike proposal IKE-P1 \                                     │
 │ ▌      authentication-method pre-shared-keys                                  │  ← continuation
 │ ▌ 2  ▪ set security ike proposal IKE-P1 dh-group group14                      │
 │ ▌ 3  ▪ set security ike gateway GW-B external-interface reth0.0               │
 │ ├──────────────────────────────────────────────────────────────────────────── │
 │ │  WHY THIS LINE     IkeGateway GW-B · field external_interface               │  ← .prov, disclosed
 │ │  PROVENANCE        entered by hand, 2026-07-02                              │
 │ │  RULES APPLIED     ike.gateway.external-interface.wrong-unit                │
 │ │  external-interface is the WAN unit the IKE packets leave by, not st0.      │
 │ ├──────────────────────────────────────────────────────────────────────────── │
 │ ▌ 4  ▪ set security ipsec vpn VPN-B bind-interface st0.0                      │
 └───────────────────────────────────────────────────────────────────────────────┘
   │  │  └ .risk-dot, 6px, the reserved colour + a .vh word
   │  └ .gut — line number, --t-micro, tabular, right-aligned in --gutter-num
   └ 4px --hairline block edge; becomes --ink on the expanded line
```

### 8.2 Wrapping — the rule that makes this a config block and not a `<pre>`

`EmittedLine.text` is **one logical line** with no newlines and no backslashes
(`13-emitters-and-provenance.md` §13.3). The renderer wraps it for display at `--cfg-cols`
(72), inserting ` \` at the break and a two-space indent on the continuation — the card's exact
convention, measured in tokens §2.

Five consequences, all of which the component must honour:

| # | Rule |
|---|---|
| 1 | **One logical line = one focus stop, one line number, one risk dot, one provenance panel.** A continuation row is not separately focusable and carries no gutter content. |
| 2 | **The clipboard payload is the unwrapped logical line.** `WrapPolicy::Display` means display wraps, clipboard does not. The copy button's accessible name says so. |
| 3 | Continuation rows are `aria-hidden="false"` but are part of the same accessible name as the parent line — a screen reader reads the logical line once, whole. Implemented by putting the whole logical text in the button and the visual wrap in a `::` presentational span set, not by splitting the text node. |
| 4 | Wrap points never contribute to `LineId`, to diffing or to the content hash. |
| 5 | A block that breaks across printed columns repeats a header row: `… IKE-P1 (continued)`. CSS cannot do this; the renderer emits it when `break-inside: avoid` cannot be satisfied. |

Rule 3 is the fiddly one and it is worth the fiddle. The naive implementation — emit two `<div>`s
with the backslash in the text — makes a screen reader announce a stray backslash and read
`authentication-method pre-shared-keys` as an orphan line. The correct implementation keeps one
text node and wraps visually:

```html
<button class="cfg-line" tabindex="0" aria-expanded="false" aria-controls="prov-3">
  <span class="gut" aria-hidden="true">1</span>
  <span class="risk-dot caution" aria-hidden="true"></span>
  <span class="vh">Changes config. </span>
  <span class="cfg-text">set security ike proposal IKE-P1 authentication-method pre-shared-keys</span>
</button>
```

…with `.cfg-text` styled `white-space: pre-wrap; text-indent: 0; hanging-indent` and the
backslash drawn by the renderer only in the copy-for-print and copy-with-continuations paths.

**DECISION — the visible backslash is a rendering flavour, not markup.** Two flavours:
`Display` (soft wrap, hanging indent, no backslash — the default, and what a screen reader
sees) and `Terminal` (hard wrap with ` \` and two-space indent, what the card does and what
prints). The view rail's config screen offers `wrap: soft | terminal` as a per-block margin tab.
This preserves the card's texture where it matters — on paper, and for anyone who wants it —
without lying to assistive tech.
<!-- VERIFY: 13-emitters §13.3 flags that it is unconfirmed whether the Junos CLI accepts backslash continuation on a pasted `set` line or via `load set terminal`. Until that is recorded per Junos train, `Terminal` flavour must never be the clipboard payload — only the printed one. -->

### 8.3 HTML

```html
<section class="block-wrap">
  <div class="block-head">
    <h3>Phase 1 — proposal, policy, gateway</h3>
    <span class="tab">click any line</span>
    <button class="btn ghost copy" data-copy="#cfg-p1">
      Copy<span class="vh"> 14 lines, unwrapped, as one block</span></button>
  </div>

  <div class="block" id="cfg-p1" role="list"
       aria-describedby="cfg-p1-help" aria-label="Emitted configuration, Phase 1">
    <p class="vh" id="cfg-p1-help">Arrow keys move between lines.
       Enter shows the graph node and rules that produced a line.</p>

    <div role="listitem" class="cfg-row">
      <button class="cfg-line" tabindex="0" aria-expanded="false" aria-controls="prov-1">
        <span class="gut" aria-hidden="true">1</span>
        <span class="risk-dot caution" aria-hidden="true"></span>
        <span class="vh">Changes config. </span>
        <span class="cfg-text">set security ike proposal IKE-P1 authentication-method pre-shared-keys</span>
      </button>
      <div class="prov" id="prov-1" hidden>…</div>
    </div>

    <div role="listitem" class="cfg-row">
      <button class="cfg-line" tabindex="-1" aria-expanded="false" aria-controls="prov-2">
        <span class="gut" aria-hidden="true">2</span>
        <span class="risk-dot caution" aria-hidden="true"></span>
        <span class="vh">Changes config. </span>
        <span class="cfg-text">set security ike gateway GW-B external-interface reth0.0</span>
      </button>
      <div class="prov" id="prov-2" hidden>…</div>
    </div>
  </div>
</section>
```

### 8.4 CSS

```css
.block-wrap { margin: var(--s3) 0; }
.block-head { display: flex; align-items: baseline; gap: var(--s3); flex-wrap: wrap;
              margin-bottom: var(--s2); }
.block-head h3 { margin: 0; }
.block-head .copy { margin-left: auto; }

.block {
  background: var(--surface);
  border-left: var(--rule-accent) solid var(--hairline);
  font-family: var(--mono); font-size: var(--t-mono); line-height: var(--lh-step);
  overflow-x: auto;
}

.cfg-line {
  display: flex; align-items: flex-start; gap: var(--s2);
  width: 100%; min-height: var(--row-min);
  background: none; border: 0;
  border-left: var(--rule-accent) solid transparent;
  margin-left: calc(var(--rule-accent) * -1);
  padding: 0 var(--s3) 0 0;
  font: inherit; color: var(--ink); text-align: left; cursor: pointer;
  border-radius: var(--radius); transition: none;
}
.cfg-line:hover { background: var(--page); }
.cfg-line[aria-expanded="true"] { background: var(--page);
                                  border-left-color: var(--ink); }
.cfg-line:focus-visible { outline: var(--focus-width) solid var(--focus-colour);
                          outline-offset: var(--focus-offset-inset); }

.gut {
  flex: none; width: var(--gutter-num); text-align: right;
  color: var(--muted); font-size: var(--t-micro);
  font-variant-numeric: var(--num-tabular);
  padding-top: 4px; user-select: none;
}
.cfg-line:hover .gut::after,
.cfg-line[aria-expanded="true"] .gut::after { content: " \25B8"; }  /* ▸ affordance */

.cfg-text { white-space: pre-wrap; overflow-wrap: normal;
            padding-left: 2ch; text-indent: -2ch; }   /* hanging indent = the card's 2 spaces */

/* The risk channel. R1: this is the ONLY colour inside a config block. */
.risk-dot { display: inline-block; width: 6px; height: 6px; flex: none; margin-top: 7px; }
.risk-dot.safe    { background: var(--safe); }
.risk-dot.caution { background: var(--caution); }
.risk-dot.danger  { background: var(--danger); }

/* Terminal wrap flavour — what prints, and what the card does. */
.block[data-wrap="terminal"] .cfg-text { white-space: pre; }
.block[data-wrap="terminal"] { overflow-x: auto; }

@media print {
  .block { break-inside: avoid; overflow: visible; }
  .block[data-wrap] .cfg-text { white-space: pre-wrap; }
  .copy, .block-head .tab { display: none; }
  .risk-dot { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
```

### 8.5 States

| State | Channel | Rendering |
|---|---|---|
| Default | — | `--surface` ground, `--hairline` 4px block edge |
| Hover | C3 ground | line ground → `--page`; gutter gains `▸` |
| Focus | C4 outline | 2px `--ink`, inset −2px |
| Expanded | C1 + C3 | line ground `--page`, its 4px left edge becomes `--ink`, `.prov` disclosed |
| Risk | reserved colour + `.vh` word | 6px dot |
| Selected (multi-line copy) | C5 + C3 | `▸` persists in gutter, ground `--surface` (inverse of hover, which is the block's inversion, §8.6) |
| Line changed since last emit | C5 | `~` prefixed in the gutter before the number |

### 8.6 The inverted hover

Inside a config block the ground is `--surface`, so hover goes *up* to `--page`, not down. This
is the opposite direction from everywhere else in the product. It is right: hover means "this
one", and inside a grey block the way to say "this one" is to make it lighter, the way a
highlighter does on paper. It is also the only place in the product where hover moves toward
`--page`, so it does not create an ambiguity.

### 8.7 The copy affordance

```html
<button class="btn ghost copy" data-copy="#cfg-p1">
  Copy<span class="vh"> 14 lines, unwrapped, as one block</span></button>
```

Rules:

1. The accessible name states the line count and that the payload is **unwrapped**. A user who
   sees backslashes on screen and gets none in the paste buffer must not be surprised.
2. On success the label becomes `Copied` for 1200ms and an `aria-live="polite"` region
   announces `14 lines copied`. This is not motion (tokens §12) — it is a text swap.
3. There is no icon. A clipboard glyph is decoration; the word `Copy` is not.
4. A per-line copy exists inside the provenance panel (§17), not on the line itself. A copy
   button on every line would put a control in the gutter and the gutter belongs to the line
   number.

### 8.8 Keyboard

The roving-tabindex contract (§2.5), plus:

| Key | Behaviour |
|---|---|
| <kbd>Enter</kbd> / <kbd>Space</kbd> | Toggle the line's provenance panel |
| <kbd>Esc</kbd> | Collapse all panels in the block |
| <kbd>Shift</kbd>+<kbd>↑/↓</kbd> | Extend a line selection |
| <kbd>Ctrl/⌘</kbd>+<kbd>C</kbd> | Copy the selection, or the whole block if nothing is selected |
| <kbd>Ctrl/⌘</kbd>+<kbd>A</kbd> | Select all lines in the focused block (not the document) |

### 8.9 Accessibility contract

- `role="list"` / `role="listitem"` with a `<button>` inside each item. A `<pre>` would be more
  semantically honest about the whitespace but cannot contain per-line controls without
  breaking the whitespace model.
- `aria-expanded` + `aria-controls` on each line; the panel is `hidden` when collapsed, so it is
  out of the accessibility tree rather than merely invisible.
- The logical line is one text node. §8.2 rule 3.
- `--surface` ground with `--ink` text is 16.32:1. The `--muted` gutter on `--surface` is
  5.24:1 at 10px — clears AA.
- The 6px risk dot is `aria-hidden`; its `.vh` sibling carries the word, and forced colours
  reveals the word (§2.1).
- The block is not `role="region"` and has no `tabindex` of its own; `aria-label` on a `list` is
  permitted and gives it a name in the rotor.

### 8.10 Cost

Three real costs, stated:

1. **200 `<button>` elements is 200 layout objects and 200 event targets.** Above ~500 lines
   this needs virtualisation, and virtualisation breaks <kbd>Ctrl</kbd>+<kbd>F</kbd> and
   printing. **Threshold: 400 logical lines.** Above that the block renders as a plain `<pre>`
   with a banner offering "expand for per-line provenance". A 900-line SRX config is a real
   input and pretending otherwise is how this component becomes unusable on the first real
   workspace.
2. **`min-height: var(--row-min)` (24px) inflates a 40-line block by 160px** versus the 20px
   line box the type wants. That is the SC 2.5.8 trade from tokens §8, and compact mode buys it
   back for users who opt in.
3. **The hanging indent (`text-indent: -2ch`) is fragile** across `overflow-x: auto` in some
   engines: the negative indent can be clipped at the scroll origin.
   <!-- VERIFY: test `.cfg-text { padding-left: 2ch; text-indent: -2ch }` inside an overflow-x:auto parent in Chromium, Firefox and WebKit at 12.5px; if the first character clips, switch to a grid with an explicit 2ch continuation column. -->

---

## 9. Two-column hairline table — the ERROR DECODER pattern

### Provenance

> **Two-column tables with no vertical rules.** Horizontal hairlines only. Left column is the
> lookup key (`NO_PROPOSAL_CHOSEN (P1)`), right column is the answer (`dh-group, encryption,
> hash, authentication-method`). The `ERROR DECODER` and `FLAP PATTERN → CAUSE` tables are the
> model for every findings/diagnostic view.

### Anatomy

```
 IN THE LOG                      GO LOOK AT                     ← thead, --t-micro tracked
 ═══════════════════════════════════════════════════════════    1px --ink
 NO_PROPOSAL_CHOSEN (P1)         dh-group, encryption, hash…
 ───────────────────────────────────────────────────────────    1px --hairline
 INVALID_KE_PAYLOAD              DH group mismatch — P1 dh-group or PFS keys
 ───────────────────────────────────────────────────────────
```

No vertical rules. Ever. The left column's mono setting is what separates the columns; a rule
would be redundant and the card knew it.

### HTML

```html
<div class="tbl-wrap">
  <table class="decoder">
    <caption class="vh">Error decoder: IKE and IPsec log strings and where to look</caption>
    <thead>
      <tr><th scope="col">In the log</th><th scope="col">Go look at</th></tr>
    </thead>
    <tbody>
      <tr><td class="m-caps">NO_PROPOSAL_CHOSEN (P1)</td>
          <td>dh-group, encryption, hash, authentication-method</td></tr>
      <tr><td class="m-caps">NO_PROPOSAL_CHOSEN (P2)</td>
          <td>PFS group, ESP algorithms, esp vs ah</td></tr>
      <tr><td class="m-caps">INVALID_KE_PAYLOAD</td>
          <td>DH group mismatch — P1 <code>dh-group</code> or PFS <code>keys</code></td></tr>
      <tr><td class="m-caps">TS_UNACCEPTABLE</td>
          <td>Traffic selectors do not mirror (v2)</td></tr>
      <tr><td class="m-caps">AUTHENTICATION_FAILED</td>
          <td>PSK, cert chain, clock skew — or identity</td></tr>
      <tr><td class="m">IKE-ID validation failed</td>
          <td><code>local-identity</code> / <code>remote-identity</code></td></tr>
      <tr><td>Phase-1 timeout, no response</td>
          <td>host-inbound <code>ike</code>, upstream ACL, peer address, NAT</td></tr>
      <tr><td class="m-caps">Bad SPI / INVALID_SPI</td>
          <td>ESP for an SA we no longer hold. Brief after a flap is normal;
              persistent = rekey out of step</td></tr>
    </tbody>
  </table>
</div>
```

### CSS

```css
.tbl-wrap { overflow-x: auto; }
table {
  width: 100%; border-collapse: collapse;
  font-size: var(--t-small); margin: var(--s3) 0;
}
thead th {
  text-align: left; vertical-align: bottom;
  font-size: var(--t-micro); font-weight: 700;
  letter-spacing: var(--track-label); text-transform: uppercase;
  color: var(--muted);
  padding: var(--s1) var(--s3) var(--s2) 0;
  border-bottom: var(--rule-hair) solid var(--ink);
}
tbody td {
  padding: var(--s2) var(--s3) var(--s2) 0;
  border-bottom: var(--rule-hair) solid var(--hairline);
  vertical-align: top;
}
tbody td:first-child {
  font-family: var(--mono); font-size: var(--t-mono);
  white-space: nowrap;                  /* the lookup key never wraps */
}
tbody td:first-child.m-caps { font-size: var(--mono-optical-caps, 0.94em); }
tbody tr:hover td { background: var(--surface-2); }
table th, table td { border-left: 0; border-right: 0; }   /* no vertical rules. ever. */

/* Zebra is available but off by default — hairlines already separate rows. */
table.zebra tbody tr:nth-child(even) td { background: var(--surface); }

@media print {
  tr { break-inside: avoid; }
  thead { display: table-header-group; }   /* repeat the head across printed pages */
  tbody tr:hover td { background: none; }
}
```

### The lookup-key rule

**The left column never wraps.** `white-space: nowrap` on `td:first-child` plus
`overflow-x: auto` on the wrapper. A key that wraps stops being scannable, and scanning the
left column is the entire purpose of this table. When the viewport cannot hold it, the table
scrolls horizontally inside its own box — the page body never scrolls sideways.

### States

| State | Channel | Rendering |
|---|---|---|
| Default | — | 1px `--hairline` row rules |
| Hover | C3 ground | row → `--surface-2` |
| Sorted (only in the inventory table) | C5 | `▴`/`▾` appended to the `th`, plus `aria-sort` |

The table is not selectable, not expandable and not filterable. When a table needs those it is
not this component — it is the finding list (§13) or the inspector (§18).

### Keyboard

None for the static variant. Native table semantics give screen-reader users row/column
navigation for free, which is the whole reason this is a `<table>` and not a grid of `<div>`s.

The sortable variant puts a `<button>` inside the `<th>` and manages `aria-sort` on the `<th>`.

### Accessibility contract

- Real `<table>`, real `<thead>`, `scope="col"` on every header.
- `<caption class="vh">` on every table. The visible section head is not a caption and a screen
  reader arriving via the table rotor will not have heard it.
- `thead { display: table-header-group }` so the header repeats on every printed page.
- No `role="presentation"` tables anywhere in the product. If a layout needs columns, it uses
  the grid.

### Cost

`nowrap` on the key column plus horizontal scroll means that on a 360px phone the answer column
is 40% off-screen. This product is not designed for phones — it is a 992px reference sheet — and
pretending it is would cost the density that makes it worth using. Below `--bp-cols` the grid
collapses to one column and the tables scroll. That is the honest behaviour.

---

## 10. Numbered plumbing list

### Provenance

> **Numbered plumbing.** `#1 the tunnel interface` … `#5 policy for the zone pair`. Ordinals
> as content, not as `<ol>` chrome.

And the payoff line that makes the numbering load-bearing:

> Miss #3 and Phase 1 times out with nothing useful in the log — the box drops the peer's IKE
> before processing it. Miss #1, #2, #4 or #5 and the tunnel reads UP while passing zero packets.

### Anatomy

```
 #1   the tunnel interface
      set interfaces st0 unit 0 family inet address 10.255.0.1/30
 #2   st0 into a zone
      set security zones security-zone VPN interfaces st0.0
 #3   let IKE reach the box on the WAN zone
      set security zones security-zone WAN interfaces reth0.0 …
```

The ordinal is `#1`, in mono, in a fixed 28px column. It is **content**, because the prose
refers to it by number. A CSS-generated `<ol>` marker cannot be referenced from a paragraph
three blocks later, and it cannot be copied.

### HTML

```html
<ol class="plumb">
  <li class="plumb-item">
    <span class="plumb-n" aria-hidden="true">#1</span>
    <div class="plumb-t">
      <b>the tunnel interface</b>
      <code>set interfaces st0 unit 0 family inet address 10.255.0.1/30</code>
    </div>
  </li>
  <li class="plumb-item">
    <span class="plumb-n" aria-hidden="true">#3</span>
    <div class="plumb-t">
      <b>let IKE reach the box on the WAN zone</b>
      <code>set security zones security-zone WAN interfaces reth0.0 host-inbound-traffic
        system-services ike</code>
    </div>
  </li>
</ol>

<aside class="note">
  <p>Miss <b>#3</b> and Phase 1 times out with nothing useful in the log — the box drops the
     peer's IKE before processing it. Miss <b>#1</b>, <b>#2</b>, <b>#4</b> or <b>#5</b> and the
     tunnel reads UP while passing zero packets.</p>
</aside>
```

### CSS

```css
.plumb { display: grid; gap: var(--s3); margin: var(--s3) 0;
         padding: 0; list-style: none; counter-reset: none; }
.plumb-item { display: grid; grid-template-columns: 28px 1fr;
              gap: var(--s3); align-items: start; }
.plumb-n { font-family: var(--mono); font-size: var(--t-small);
           color: var(--muted); padding-top: 1px;
           font-variant-numeric: var(--num-tabular); }
.plumb-t { font-size: var(--t-small); }
.plumb-t b { display: block; font-weight: 700; margin-bottom: 2px; }
.plumb-t code { display: block; color: var(--ink); }
@media print { .plumb-item { break-inside: avoid; } }
```

`list-style: none` on an `<ol>` — the marker is suppressed and the visible ordinal is the
`.plumb-n` span. The element stays `<ol>` because the sequence is meaningful and assistive tech
should say "list of 5 items".

`aria-hidden` on `.plumb-n` prevents a screen reader announcing "hash one, item one" — the list
semantics already number it.

### Two variants

| Variant | Ordinal | Used for |
|---|---|---|
| `#n` | `#1`…`#5` | Structural pieces that the prose refers to by number: the five plumbing pieces |
| `n` | `1`…`9` | Sequences that are read in order and not referenced individually: the bring-up order, the three PFS rules |

The bring-up ladder from side 1 uses the second variant and adds a risk dot per step, because
each step is a command:

```html
<li class="plumb-item">
  <span class="plumb-n" aria-hidden="true">1</span>
  <div class="plumb-t">
    <span class="risk-dot caution" aria-hidden="true"></span><span class="vh">Changes config. </span>
    <code>commit confirmed 5</code> <span class="tab">always, remotely</span>
  </div>
</li>
```

### States

None. The list is static content.

**Except** in the Verify view, where the ladder is generated per change (`verify(diff(graph))`)
and each step can be marked done by the user. That variant adds a checkbox — the only checkbox
in the product — because a verify ladder that you work down is exactly the case a checkbox
exists for, and there is no card device for it. It is a native `<input type="checkbox">` with
`appearance: none`, a 12px square with a 1px `--muted` border, and a `✓` in `--ink` when
checked. State is session-only and never persisted (it is not a fact about the network).

### Keyboard

None for the static variant. The checkbox variant is a normal tab stop with
<kbd>Space</kbd> to toggle.

### Accessibility contract

- `<ol>` with `list-style: none`. Note that Safari drops list semantics when `list-style: none`
  is applied; add `role="list"` explicitly to restore it.
- The ordinal span is `aria-hidden`.
- The "Miss #3" note is a plain `<p>`, and it references the numbers in text, which is why the
  numbers must be text.

### Cost

A 28px ordinal column on a 480px card column is 6% of the measure spent on `#1`. On the card
that is free because the card is 992px wide. On a collapsed single-column layout it is the
difference between a config line fitting and wrapping. Accepted: the numbers are the point.

---

## 11. View rail

### Provenance

**New.** The card has four sides and you turn it over. A screen has six views and needs a
control. This is the smallest thing that does the job in the card's language: uppercase tracked
labels on a hairline baseline, with the active one carrying a 3px `--ink` underline — the
masthead rule, reused at the one place a second 3px rule is justified.

### HTML

```html
<nav class="rail" aria-label="Views">
  <div role="tablist" aria-label="Views">
    <button role="tab" id="t-finder"   aria-selected="true"  aria-controls="v-finder"  tabindex="0">Finder</button>
    <button role="tab" id="t-config"   aria-selected="false" aria-controls="v-config"  tabindex="-1">Config</button>
    <button role="tab" id="t-findings" aria-selected="false" aria-controls="v-findings" tabindex="-1">Findings</button>
    <button role="tab" id="t-diagram"  aria-selected="false" aria-controls="v-diagram" tabindex="-1">Diagram</button>
    <button role="tab" id="t-verify"   aria-selected="false" aria-controls="v-verify"  tabindex="-1">Verify</button>
    <button role="tab" id="t-teach"    aria-selected="false" aria-controls="v-teach"   tabindex="-1">Teach</button>
  </div>
</nav>
<section role="tabpanel" id="v-finder" aria-labelledby="t-finder" tabindex="0">…</section>
```

### CSS

```css
.rail { border-bottom: var(--rule-hair) solid var(--hairline); margin-top: var(--s5); }
.rail [role="tablist"] { display: flex; gap: 0; overflow-x: auto; }
.rail button {
  background: none; border: 0;
  border-bottom: var(--rule-mast) solid transparent;
  margin-bottom: calc(var(--rule-hair) * -1);
  font-family: var(--sans); font-size: var(--t-tab); font-weight: 700;
  letter-spacing: var(--track-label); text-transform: uppercase;
  color: var(--muted); padding: var(--s2) var(--s4);
  min-height: var(--row-min); white-space: nowrap; cursor: pointer;
  border-radius: var(--radius);
}
.rail button:hover { color: var(--ink); }
.rail button[aria-selected="true"] { color: var(--ink); border-bottom-color: var(--ink); }
.rail button:focus-visible { outline: var(--focus-width) solid var(--focus-colour);
                             outline-offset: var(--focus-offset-inset); }
@media print { .rail { display: none; }
               [role="tabpanel"] { display: block !important; } }
```

### Keyboard

The APG tabs pattern, automatic activation:

| Key | Behaviour |
|---|---|
| <kbd>←</kbd> / <kbd>→</kbd> | Previous / next tab, wrapping, and activate it |
| <kbd>Home</kbd> / <kbd>End</kbd> | First / last tab |
| <kbd>Tab</kbd> | Leaves the tablist and lands on the active panel |
| <kbd>Ctrl</kbd>+<kbd>1</kbd>…<kbd>6</kbd> | Jump directly to a view from anywhere |

Automatic activation (arrow = switch) rather than manual (arrow = move, Enter = switch), because
switching is cheap here — every view is already rendered client-side and there is no fetch.

### Accessibility contract

- One tab stop for the whole rail (roving `tabindex`).
- Each panel is `tabindex="0"` so <kbd>Tab</kbd> from the rail lands somewhere useful.
- In print every panel is revealed: a printed export is the whole workspace, not the view that
  happened to be open.

### Cost

Six views behind a rail means five of them are invisible. A user who does not know the Findings
view exists will not find it from the Config view. Mitigation: findings appear *inline* in the
config view as well (brief §6.2 — "findings raised inline as you go, not at the end"), so the
rail is a way to focus, not the only path.

---

## 12. Finder palette

The wedge (brief §6.1). It must open in one keystroke from anywhere and be faster than a
browser tab, or nobody uses it.

### Anatomy

```
 ┌ .finder-shell — 1px --ink, on --page, over a --page scrim at 0.72 ────────┐
 │ CTRL K │ is the tunnel up                                    │ 3 · 0.8 ms │
 ├────────┴───────────────────────────────────────────────────┴─────────────┤
 │ ▌ show security ipsec security-associations        [READ-ONLY]           │  ← .hit.sel
 │ ▌ Is Phase 2 installed and passing traffic?                              │
 │ ▌ │ Read: State — want Installed                                         │
 │   show security ipsec inactive-tunnels             [READ-ONLY]           │
 │   Names what is down, and prints a Tunnel Down Reason                    │
 │   clear security ipsec security-associations       [CHANGES CONFIG]      │
 └──────────────────────────────────────────────────────────────────────────┘
   junos-srx · corpus 1.4.0 · Enter copies · → opens the guidebook entry
```

### HTML

```html
<div class="scrim" data-open="false"></div>

<div class="finder-shell" role="dialog" aria-modal="true" aria-label="Command finder"
     data-open="false">
  <div class="finder-input-row">
    <span class="finder-key" aria-hidden="true">Ctrl K</span>
    <input id="q" type="text" role="combobox"
           aria-expanded="true" aria-controls="hits" aria-activedescendant="hit-0"
           aria-autocomplete="list" aria-describedby="finder-help"
           autocomplete="off" spellcheck="false" autocapitalize="off"
           placeholder="is the tunnel up" aria-label="Find a command">
    <span class="finder-meta" id="meta" aria-hidden="true">3 · 0.8 ms</span>
    <span class="vh" id="finder-live" role="status" aria-live="polite">3 results</span>
    <span class="vh" id="finder-help">Type a question. Arrow keys move between results.
      Enter copies the command. Right arrow opens the explainer.</span>
  </div>

  <ul id="hits" role="listbox" aria-label="Results">
    <li id="hit-0" role="option" aria-selected="true" class="hit sel">
      <span class="hit-cmd">
        <code>show security ipsec security-associations</code>
        <span class="pill safe">Read-only<span class="vh"> — safe on production</span></span>
      </span>
      <span class="hit-ans">Is Phase 2 installed and passing traffic?</span>
      <span class="hit-read"><b>Read:</b> State — want <code>Installed</code>.
        Anything else is not passing traffic.</span>
    </li>
    <li id="hit-1" role="option" aria-selected="false" class="hit">
      <span class="hit-cmd">
        <code>show security ipsec inactive-tunnels</code>
        <span class="pill safe">Read-only<span class="vh"> — safe on production</span></span>
      </span>
      <span class="hit-ans">Which tunnels are down, and why?</span>
      <span class="hit-read"><b>Read:</b> the Tunnel Down Reason — often the whole answer.</span>
    </li>
  </ul>

  <div class="finder-foot">
    <span class="tab">junos-srx · corpus 1.4.0</span>
    <span class="tab">Enter copies · → opens the guidebook entry</span>
  </div>
</div>
```

### CSS

```css
.scrim { position: fixed; inset: 0; z-index: calc(var(--z-modal) - 1);
         background: var(--page); opacity: var(--scrim-opacity); display: none; }
.scrim[data-open="true"] { display: block; }

.finder-shell {
  position: fixed; z-index: var(--z-modal);
  top: 12vh; left: 50%; transform: translateX(-50%);
  width: min(var(--sheet-card), calc(100vw - var(--s6)));
  max-height: 70vh; display: none; flex-direction: column;
  background: var(--page);
  border: var(--rule-hair) solid var(--ink);   /* a rule, not a shadow. tokens §11 */
  border-radius: var(--radius);
  box-shadow: var(--shadow);                   /* none */
}
.finder-shell[data-open="true"] { display: flex; }

.finder-input-row { display: flex; align-items: stretch; flex: none;
                    border-bottom: var(--rule-hair) solid var(--hairline); }
.finder-key {
  display: flex; align-items: center; flex: none;
  font-family: var(--mono); font-size: var(--t-micro);
  letter-spacing: 0.06em; color: var(--muted);
  padding: 0 var(--s3); border-right: var(--rule-hair) solid var(--hairline);
}
#q {
  flex: 1; min-width: 0; border: 0; background: none; color: var(--ink);
  font-family: var(--mono); font-size: var(--t-mast);
  padding: var(--s3); outline: none;
}
#q::placeholder { color: var(--muted); }
#q:focus-visible { outline: none; }   /* the shell IS the focus indicator here, §12 note */
.finder-meta { display: flex; align-items: center; flex: none;
               padding: 0 var(--s3); font-size: var(--t-micro); color: var(--muted);
               letter-spacing: var(--track-label); text-transform: uppercase;
               font-variant-numeric: var(--num-tabular); }

#hits { flex: 1; overflow-y: auto; margin: 0; padding: 0; list-style: none; }
.hit {
  display: block; padding: var(--s3);
  border-bottom: var(--rule-hair) solid var(--hairline);
  border-left: var(--rule-accent) solid transparent;
  cursor: pointer;
}
.hit:last-child { border-bottom: 0; }
.hit:hover { background: var(--surface-2); }
.hit.sel   { background: var(--surface); border-left-color: var(--ink); }
.hit-cmd { display: flex; align-items: baseline; gap: var(--s2);
           font-family: var(--mono); font-size: var(--t-mono); }
.hit-ans { display: block; color: var(--muted); font-size: var(--t-small); margin-top: 2px; }
.hit-read { display: block; font-size: var(--t-small); margin-top: var(--s2);
            padding-left: var(--s3);
            border-left: var(--rule-hair) solid var(--hairline); }

.pill { font-size: var(--t-micro); font-weight: 700;
        letter-spacing: var(--track-legend); text-transform: uppercase;
        padding: 1px 5px; flex: none; white-space: nowrap; }
.pill.safe    { color: var(--safe);    background: var(--safe-wash); }
.pill.caution { color: var(--caution); background: var(--caution-wash); }
.pill.danger  { color: var(--danger);  background: var(--danger-wash); }

.finder-foot { flex: none; display: flex; justify-content: space-between; gap: var(--s4);
               padding: var(--s2) var(--s3);
               border-top: var(--rule-hair) solid var(--hairline); }
.empty { padding: var(--s5) var(--s3); color: var(--muted); font-size: var(--t-small); }

@media print { .finder-shell, .scrim { display: none !important; } }
```

### Why the selection bar is `--ink` and not a risk colour

Selection is C5+C3 per tokens §4.2, and here the selected hit already sits on `--surface`, so
the `▸` glyph is replaced by a 4px `--ink` left bar. This is the one place the 4px bar carries
selection rather than severity or risk — and it is unambiguous because a finder result has no
severity, and its risk lives in the pill, which is a different element on a different edge. §22
records this as an audited exception.

### States

| State | Channel | Rendering |
|---|---|---|
| Closed | — | `display: none` on shell and scrim |
| Open, empty query | — | Recent queries, then `.empty` with three seed questions from the card |
| Open, no results | — | `.empty`: *"Nothing matched. The corpus indexes the question a command answers — try `is the tunnel up` rather than `ipsec sa`."* |
| Result active | C3 + C1 | `--surface` ground + 4px `--ink` bar |
| Result hovered but not active | C3 | `--surface-2` |
| Risk of the result | reserved colour | `.pill`, with the word visible |

### Keyboard

| Key | Behaviour |
|---|---|
| <kbd>Ctrl/⌘</kbd>+<kbd>K</kbd> | Open from anywhere, including from inside a text field. Selects any existing query text. |
| <kbd>↓</kbd> / <kbd>↑</kbd> | Move `aria-activedescendant`. Focus never leaves the input. Does not wrap. |
| <kbd>Enter</kbd> | Copy the command to the clipboard, close, restore focus to the invoker. Announce `copied` politely. |
| <kbd>Shift</kbd>+<kbd>Enter</kbd> | Copy with the workspace's real values interpolated (`… vpn-name VPN-B detail`) |
| <kbd>→</kbd> | Open the guidebook entry for the active result, in the Teach view |
| <kbd>Esc</kbd> | Close, restore focus to the invoker. Never clears the query first — a two-press Escape is a small betrayal. |
| <kbd>Tab</kbd> | Trapped inside the dialog: input → footer links → input |

### Accessibility contract

- `role="dialog" aria-modal="true"` with a focus trap, and `inert` on the rest of the document
  while open.
- The combobox pattern: focus stays on the `<input>`; `aria-activedescendant` points at the
  active `<li role="option">`. The options are **not** focusable.
- `role="status" aria-live="polite"` announces the result count on each keystroke — debounced to
  200ms so a fast typist does not get a stream of interruptions.
- The `Ctrl K` chip is `aria-hidden`; the same information is in `#finder-help`, which the
  input references with `aria-describedby`.
- **The input has no visible focus ring** because the shell's 1px `--ink` border is the focus
  indicator for the whole dialog and the caret marks the insertion point. This is a deliberate
  exception to "focus is always an outline" and it is the only one. Recorded in §22.
- `pill` carries the risk word visibly (`Read-only`) plus the rest in `.vh`, so R2 holds even
  before forced-colours.

### Cost

- A modal dialog is the one thing in this product that covers content, and it exists because
  the alternative — a persistent search field in the masthead — costs 40px of every screen
  forever to serve an interaction that lasts four seconds.
- 12vh from the top rather than centred, so the palette does not cover the masthead of the view
  you are searching from. This wastes 12vh of the palette's own height and is worth it.
- The scrim is `--page` at 0.72 rather than a dark overlay. A dark scrim would be the only dark
  surface in the light theme and it would read as a shadow, which §11 forbids.

---

## 13. Finding row

### Provenance

The two-column hairline table (§9), plus the 4px accent bar (§7) carrying severity, plus the
margin tab (§4) carrying confidence. Every part is a card device; the composition is new.

The content model is `Finding` from `12-rule-engine.md` §10.3 — in particular the **witness**,
which is what makes a finding arguable rather than merely asserted.

### Anatomy

```
 ▌ HIGH   Perfect Forward Secrecy is not configured        heuristic, may be wrong
 ▌        IPSEC-POL on srx-a                              ipsec.pfs.absent
 ▌  ▸ expanded:
 ▌        WHY          Without PFS, Phase 2 keys derive from Phase 1 key material.
 ▌                     One compromised IKE SA secret unlocks every data key derived
 ▌                     under it, including previously recorded traffic.
 ▌        BECAUSE      IPSEC-POL.perfect_forward_secrecy is absent
 ▌                     (parsed from srx-a.set, line 47)
 ▌        SYMPTOM      PFS on one side and absent on the other fails Phase 2 while
 ▌                     Phase 1 stays up — "IKE looks fine but the tunnel keeps dropping."
 ▌        FIX          ┌ set security ipsec policy IPSEC-POL \                  ▪
 ▌                     │   perfect-forward-secrecy keys group14
 ▌        ACCEPTABLE   Interoperating with a peer that cannot support it. Document
 ▌        WHEN         the exception and compensate with shorter Phase 2 lifetimes.
 ▌        SOURCE       RFC 7296 §1.3.2
 ▌        [ Suppress with a reason ]  [ Copy fix ]
 └ 4px --ink (high) / --muted (medium) / --hairline (low) / none (info)
```

### HTML

```html
<article class="finding high" data-state="active" data-confidence="definite">
  <h3 class="f-head">
    <button class="f-toggle" aria-expanded="false" aria-controls="f-body-1">
      <span class="f-sev">High<span class="vh"> severity</span></span>
      <span class="f-title">Perfect Forward Secrecy is not configured</span>
      <span class="f-anchor">IPSEC-POL on srx-a</span>
    </button>
  </h3>
  <span class="f-id"><code>ipsec.pfs.absent</code></span>

  <div class="f-body" id="f-body-1" hidden>
    <dl>
      <dt>Why</dt>
      <dd>Without PFS, Phase 2 keys derive from Phase 1 key material. One compromised IKE SA
          secret unlocks every data key derived under it, including previously recorded
          traffic.</dd>

      <dt>Because</dt>
      <dd class="witness"><code>IPSEC-POL.perfect_forward_secrecy</code> is absent
          <span class="tab">parsed from srx-a.set, line 47</span></dd>

      <dt>Symptom if mismatched</dt>
      <dd>PFS on one side and absent on the other fails Phase 2 while Phase 1 stays up —
          <em>"IKE looks fine but the tunnel keeps dropping."</em></dd>

      <dt>Fix</dt>
      <dd><!-- a nested config block, §8, with its own risk dots --></dd>

      <dt>Acceptable when</dt>
      <dd>Interoperating with a peer that cannot support it. Document the exception and
          compensate with shorter Phase 2 lifetimes.</dd>

      <dt>Source</dt>
      <dd>RFC 7296 §1.3<span class="tab">the optional KE payload for Child SA forward
          secrecy</span></dd>
    </dl>
    <div class="f-actions">
      <button class="btn">Suppress with a reason</button>
      <button class="btn ghost copy" data-copy="#fix-1">Copy fix</button>
    </div>
  </div>
</article>
```

### CSS

```css
.finding {
  position: relative;
  border-bottom: var(--rule-hair) solid var(--hairline);
  border-left: var(--rule-accent) solid transparent;
  padding: var(--s3) 0 var(--s3) var(--s3);
}
.finding:first-child { border-top: var(--rule-hair) solid var(--hairline); }

/* Severity — C1, tone. Tokens §4.2. Never colour. */
.finding.high   { border-left-color: var(--ink); }
.finding.medium { border-left-color: var(--muted); }
.finding.low    { border-left-color: var(--hairline); }
.finding.info   { border-left-color: transparent; }

/* State — C2, style. */
.finding[data-state="active"]     { border-left-style: var(--rule-style-deterministic); }
.finding[data-state="pending"]    { border-left-style: var(--rule-style-pending); }
.finding[data-state="suppressed"] { border-left-color: transparent; }
.finding[data-state="suppressed"]::before {
  content: ""; position: absolute; left: calc(var(--rule-accent) * -1);
  top: 0; bottom: 0; width: var(--rule-accent); background: var(--hatch);
}
.finding[data-state="suppressed"] .f-title { text-decoration: line-through; color: var(--muted); }
.finding[data-state="superseded"] { border-left-color: transparent; padding: var(--s2) 0; }
.finding[data-state="superseded"] .f-body,
.finding[data-state="superseded"] .f-id { display: none; }

.f-head { margin: 0; font-size: var(--t-body); font-weight: 400; }
.f-toggle {
  display: flex; align-items: baseline; gap: var(--s3); flex-wrap: wrap;
  width: 100%; min-height: var(--row-min);
  background: none; border: 0; padding: 0;
  font: inherit; color: inherit; text-align: left; cursor: pointer;
  border-radius: var(--radius);
}
.f-toggle:hover { background: var(--surface-2); }
.f-toggle:focus-visible { outline: var(--focus-width) solid var(--focus-colour);
                          outline-offset: var(--focus-offset-outset); }
.f-sev {
  flex: none; width: 52px;
  font-family: var(--mono); font-size: var(--t-micro);
  letter-spacing: var(--track-legend); text-transform: uppercase; color: var(--muted);
}
.finding.high .f-sev { color: var(--ink); font-weight: 700; }
.f-title  { font-weight: 700; }
.f-anchor { color: var(--muted); font-size: var(--t-small); }
.f-id { position: absolute; top: var(--s3); right: 0;
        font-size: var(--t-micro); color: var(--muted); }

/* Confidence — C10, a margin tab. Emitted by the renderer, not by CSS. */
.finding[data-confidence="probable"]  .f-head::after { content: "probable"; }
.finding[data-confidence="heuristic"] .f-head::after { content: "heuristic, may be wrong"; }
.finding[data-confidence] .f-head::after {
  margin-left: auto; font-size: var(--t-tab); font-style: italic; color: var(--muted);
}
.finding[data-confidence="definite"] .f-head::after { content: none; }

.f-body { padding-left: 52px; margin-top: var(--s2); font-size: var(--t-small);
          opacity: 1; transition: opacity var(--motion-disclosure) var(--motion-ease); }
.f-body[hidden] { display: none; }
.f-body dl { display: grid; grid-template-columns: max-content 1fr;
             gap: var(--s1) var(--s4); margin: 0 0 var(--s3); }
.f-body dt { font-size: var(--t-micro); font-weight: 700;
             letter-spacing: var(--track-label); text-transform: uppercase;
             color: var(--muted); padding-top: 2px; }
.f-body dd { margin: 0; max-width: var(--measure); }
.f-actions { display: flex; gap: var(--s2); flex-wrap: wrap; }

@media (max-width: 640px) { .f-body { padding-left: 0; } .f-id { position: static; } }
@media print {
  .finding { break-inside: avoid; }
  .f-body[hidden] { display: block; }     /* print the whole finding, always */
  .f-actions { display: none; }
}
```

### The two mandatory fields

Two `<dt>`s may never be omitted, and their absence is a corpus lint error, not a rendering
concern:

- **`Because` — the witness.** `12-rule-engine.md` §10.3: *"the witness is the difference
  between a finding you believe and one you argue with."* It renders the exact `(node, field,
  value)` the condition read, plus provenance as a margin tab.
- **`Acceptable when`.** Invariant 8. A rule that can never be acceptable says so explicitly.
  Rendering it collapsed or behind a "more" link would defeat the point — it is the field that
  decides whether the tool gets muted in week two.

### States

| State | Channel | Rendering |
|---|---|---|
| `Active` | C2 solid | Normal |
| `Pending` | C2 dotted | Dotted bar, and the title is prefixed `Unanswered:` — it is a question, not a defect |
| `Suppressed` | C2 hatch + C9 | Hatched bar, struck title, body collapsed by default, suppression reason shown inline |
| `Superseded` | none | Collapses to one muted line: `superseded by ipsec.pfs.weak-group` |
| Severity high/medium/low/info | C1 tone | 4px bar, four tones |
| Confidence | C10 | Margin tab, right-aligned |
| Expanded | — | `hidden` removed, 90ms opacity fade (tokens §12) |

Under forced colours the severity ramp switches from tone to width (tokens §6).

### Keyboard

The list is a roving-tabindex list (§2.5). Within a row:

| Key | Behaviour |
|---|---|
| <kbd>Enter</kbd> / <kbd>Space</kbd> | Toggle the body |
| <kbd>→</kbd> | Expand if collapsed; if expanded, move focus into the body's first control |
| <kbd>←</kbd> | Collapse; if already collapsed, move to the parent group heading |
| <kbd>S</kbd> | Open the suppression dialog for this finding |
| <kbd>C</kbd> | Copy the fix |

<kbd>→</kbd>/<kbd>←</kbd> as expand/collapse is the tree convention and it is what a keyboard
user will try. It does not conflict with the roving list, which uses <kbd>↑</kbd>/<kbd>↓</kbd>.

### Accessibility contract

- The row is an `<article>` with an `<h3>` — findings are document sections and heading
  navigation is how a screen-reader user skims a list of forty of them.
- The disclosure button is inside the heading, which is the APG's own recommendation for
  accordion patterns.
- `aria-expanded` + `aria-controls`; the body is `hidden`, not `display:none` via a class, so it
  leaves the accessibility tree.
- Severity is in text (`High`) plus a `.vh` suffix (` severity`) so the announcement is
  "High severity, Perfect Forward Secrecy is not configured" and not "High, Perfect…".
- Confidence via `::after` `content` is **read by most screen readers but not all**. Because
  confidence is advisory and never the sole carrier of required information, this is acceptable
  — but the same string is also present in the expanded body's `<dl>` as a `Confidence` row for
  `probable`/`heuristic`, so it is never lost.
  <!-- VERIFY: confirm current NVDA/JAWS/VoiceOver behaviour for CSS ::after content in 2026 before relying on it even advisorily; if any of the three drops it, move the tab into markup. -->

### Cost

- The severity ramp costs about half a second of scan time versus a colour ramp (tokens §4.9).
- A collapsed finding shows the title and anchor only, which means the `acceptable_when` — the
  field that stops the tool being muted — is one interaction away. Considered making the body
  expanded by default; rejected because forty expanded findings is a wall. **Compromise: `high`
  severity findings render expanded by default; everything else collapsed.** That puts the
  mandatory fields in front of the user exactly where they matter and keeps the list scannable.

---

## 14. Suppression record

### Provenance

**New.** There is no card device for this because paper does not have waivers. But
`12-rule-engine.md` §11 and `17-workspace-format.md` §9 make it the artifact a reviewer reads,
and brief §6.6 says suppressions "carry a reason, and are stored in the workspace so a reviewer
can see what was waived and why."

Design consequence: **this component is written for the reviewer, not the author.** Every
choice below follows from that.

### Anatomy

```
 ╱▌ ipsec.pfs.absent                                    finding scope   fresh
 ╱▌ IPSEC-POL on srx-a
 ╱▌ "Peer is a 2015-vintage ASA that negotiates group2 only. Ticket NET-4471.
 ╱▌  Compensated with lifetime-seconds 900 on P2."
 ╱▌ by  a.mcgregor   unverified          created 2026-05-02   expires 2026-11-02  in 97 days
 ╱▌ matched 14 times · last 2026-07-26
 └ 4px hatch — the suppressed channel, C2
```

### HTML

```html
<article class="supp" data-review="fresh">
  <header class="supp-head">
    <code class="supp-rule">ipsec.pfs.absent</code>
    <span class="supp-anchor">IPSEC-POL on srx-a</span>
    <span class="tab">finding scope</span>
    <span class="tab">fresh</span>
  </header>

  <blockquote class="supp-reason">Peer is a 2015-vintage ASA that negotiates group2 only.
    Ticket NET-4471. Compensated with <code>lifetime-seconds 900</code> on P2.</blockquote>

  <dl class="supp-meta">
    <dt>By</dt>
    <dd>a.mcgregor <span class="tab">unverified — workspace-local text, not an identity</span></dd>
    <dt>Created</dt><dd><time datetime="2026-05-02">2026-05-02</time></dd>
    <dt>Expires</dt><dd><time datetime="2026-11-02">2026-11-02</time>
        <span class="tab">in 97 days</span></dd>
    <dt>Matched</dt><dd>14 times · last <time datetime="2026-07-26">2026-07-26</time></dd>
  </dl>

  <div class="supp-actions">
    <button class="btn ghost">Acknowledge</button>
    <button class="btn ghost">Revoke</button>
  </div>
</article>
```

### CSS

```css
.supp {
  position: relative;
  padding: var(--s3) 0 var(--s3) var(--s4);
  border-bottom: var(--rule-hair) solid var(--hairline);
}
.supp::before {
  content: ""; position: absolute; left: 0; top: 0; bottom: 0;
  width: var(--rule-accent); background: var(--hatch);
}
.supp-head { display: flex; align-items: baseline; gap: var(--s3); flex-wrap: wrap; }
.supp-rule { font-family: var(--mono); font-size: var(--t-mono); font-weight: 700; }
.supp-anchor { font-size: var(--t-small); color: var(--muted); }
.supp-reason {
  margin: var(--s2) 0; padding-left: var(--s3);
  border-left: var(--rule-hair) solid var(--hairline);
  font-size: var(--t-small); max-width: var(--measure);
}
.supp-meta { display: grid; grid-template-columns: max-content 1fr;
             gap: 2px var(--s4); margin: var(--s2) 0 0; font-size: var(--t-small); }
.supp-meta dt { font-size: var(--t-micro); font-weight: 700;
                letter-spacing: var(--track-label); text-transform: uppercase;
                color: var(--muted); }
.supp-meta dd { margin: 0; font-variant-numeric: var(--num-tabular); }
.supp-actions { display: flex; gap: var(--s2); margin-top: var(--s3); }

/* Review state — C10, margin tabs, plus one structural change for orphans. */
.supp[data-review="orphaned"] { background: var(--surface-2); }
.supp[data-review="orphaned"] .supp-anchor { text-decoration: line-through; }
.supp[data-review="expired"] .supp-rule { text-decoration: line-through; }

@media print { .supp { break-inside: avoid; } .supp-actions { display: none; } }
```

### The three things this component must not soften

1. **The author is not an identity.** `12-rule-engine.md` §11.1 says `author` is *"free text,
   workspace-local, NOT authenticated"*. Rendering it as `by a.mcgregor` with an avatar and no
   qualifier would manufacture accountability that does not exist. The margin tab
   `unverified — workspace-local text, not an identity` is mandatory and may not be truncated,
   collapsed or moved behind a tooltip. A reviewer who reads this list must not come away
   believing a name was verified.
2. **The reason is quoted, in full, never truncated.** Minimum 20 characters is enforced at
   input; there is no maximum and no `line-clamp`. A suppression list whose reasons are
   ellipsised is a suppression list nobody reads.
3. **Expiry is a countdown, not a date.** `expires 2026-11-02` is a fact; `in 97 days` is the
   thing that changes behaviour. Both are shown; the countdown is the margin tab, so it reads as
   the weighting it is.

### States

| `ReviewState` | Channel | Rendering |
|---|---|---|
| `Fresh` | C10 | tab `fresh` |
| `Acknowledged { by, on }` | C10 | tab `acknowledged by r.oyelaran, 2026-06-01` |
| `Orphaned { since }` | C3 + C9 + C10 | `--surface-2` ground, anchor struck, tab `orphaned since 2026-03-04 — the node it pointed at is gone` |
| Expired | C9 + C10 | rule id struck, tab `expired 12 days ago — this finding is active again` |

Expired is not a `ReviewState` in the type; it is derived from `expires` vs `workspace.as_of`.
It renders differently because an expired suppression has stopped suppressing, and a list that
looks identical before and after that moment is a trap.

### Keyboard

Normal tab order — a suppression list is tens of items, not hundreds, and every item has two
actions, so the roving pattern would hide them. <kbd>Tab</kbd> reaches Acknowledge and Revoke
directly.

### Accessibility contract

- `<article>` per record; `<blockquote>` for the reason, because it is quoted human text.
- `<time datetime>` on every date so assistive tech and any export can parse them.
- Revoke is destructive-ish and opens a confirm dialog naming the rule and the count of findings
  that will become active again: `Revoking this will make 3 findings active.`
- The hatch is decorative; the state is carried by the tabs. Under forced colours the hatch
  disappears (tokens §6) and the tabs remain, which is why the tabs are mandatory.

### Cost

This component is deliberately verbose — four metadata rows and a full-length quote per record.
On a workspace with sixty suppressions that is a long page. That is the correct outcome: a
long, uncomfortable suppression list is the honest representation of sixty waivers, and
compressing it into a tidy table is how waivers become invisible.

---

## 15. Depth toggle

### Provenance

> **Fathom's explainer depth toggle should feel like these**, not like a settings panel.

Where "these" is the margin tab. This is an explicit instruction in the design language and the
component obeys it literally.

### Anatomy

```
 P E R F E C T   F O R W A R D   S E C R E C Y      terse  explained  teaching
                                                          ─────────
```

Three lowercase italic words at the right end of the section head. The active one loses its
italic, gains weight, and gains a 1px `--ink` underline. There is no track, no thumb, no
segmented-control border, no pill, no chevron and no label saying "Depth".

### HTML

```html
<h2>
  Perfect forward secrecy
  <span class="depth" role="radiogroup" aria-label="Explanation depth">
    <button role="radio" aria-checked="false" tabindex="-1" data-d="terse">terse</button>
    <button role="radio" aria-checked="true"  tabindex="0"  data-d="explained">explained</button>
    <button role="radio" aria-checked="false" tabindex="-1" data-d="teaching">teaching</button>
  </span>
</h2>

<div class="depth-body">
  <div data-depth="terse" hidden>…</div>
  <div data-depth="explained">…</div>
  <div data-depth="teaching" hidden>…</div>
</div>
```

### CSS

```css
h2 {
  display: flex; align-items: baseline; justify-content: space-between; gap: var(--s4);
  margin: var(--s6) 0 var(--s3); padding-bottom: var(--s2);
  font-size: var(--t-head); font-weight: 700;
  letter-spacing: var(--track-head); text-transform: uppercase;
  border-bottom: var(--rule-hair) solid var(--ink);
}

.depth { display: flex; align-items: baseline; gap: var(--s3); flex: none; }
.depth button {
  background: none; border: 0;
  border-bottom: var(--rule-hair) solid transparent;
  padding: 0 0 1px;
  font-family: var(--sans); font-size: var(--t-tab); font-style: italic;
  letter-spacing: 0; text-transform: none; font-weight: 400;
  color: var(--muted); cursor: pointer; border-radius: var(--radius);
}
.depth button:hover { color: var(--ink); }
.depth button[aria-checked="true"] {
  color: var(--ink); font-style: normal; font-weight: 700;
  border-bottom-color: var(--ink);
}
.depth button:focus-visible { outline: var(--focus-width) solid var(--focus-colour);
                              outline-offset: var(--focus-offset-outset); }
.depth-body > [hidden] { display: none; }
@media print { .depth { display: none; } }
```

Note `min-height` is **not** applied here. Three 11px words are a 16px target and fail SC 2.5.8
on size. They pass on the **spacing exception**: `--s3` (12px) between them means a 24px-diameter
circle centred on each does not intersect its neighbours' circles, provided the toggle sits at
least 12px clear of anything else focusable — which the `justify-content: space-between` in the
head guarantees. This is the one place in the product that relies on the spacing exception
rather than meeting the size outright, and it is recorded here so it can be re-checked.

### Global versus per-block

Brief §5.4: depth is *"user-toggled globally and per-block."*

| Scope | Where | Behaviour |
|---|---|---|
| Global | Settings, and <kbd>Ctrl</kbd>+<kbd>1/2/3</kbd> | Sets the default for every block that has no override |
| Per-block | This component | Overrides the global for one block, for this session only |

A per-block override renders an extra margin tab on the head: `overridden`. Without it, a user
who set one block to `teaching` three screens ago has no way to know why this section is longer
than the others.

Per-block overrides are **session-only and never persisted**. Persisting them would make the
workspace non-deterministic in its rendering, and it would mean two engineers open the same
workspace and see different explanations of the same node.

### States

| State | Channel | Rendering |
|---|---|---|
| Inactive | C7 register | lowercase italic `--muted` |
| Active | C6 + C7 + C8 | roman, 700, `--ink`, 1px `--ink` underline |
| Hover | C7 | `--muted` → `--ink`, still italic |
| Focus | C4 | outline, offset +2px |
| Overridden from global | C10 | extra margin tab `overridden` on the head |

### Keyboard

The APG radiogroup pattern:

| Key | Behaviour |
|---|---|
| <kbd>Tab</kbd> | Enters the group at the checked radio; one tab stop for all three |
| <kbd>←</kbd> / <kbd>→</kbd> / <kbd>↑</kbd> / <kbd>↓</kbd> | Move and check, wrapping |
| <kbd>Space</kbd> | Check the focused radio |
| <kbd>Ctrl</kbd>+<kbd>1/2/3</kbd> | Set the **global** depth from anywhere |

### Accessibility contract

- `role="radiogroup"` with three `role="radio"` buttons. It is a single-select of mutually
  exclusive options, which is exactly what a radiogroup is, and modelling it as three toggle
  buttons with `aria-pressed` would announce three independent states.
- `aria-label="Explanation depth"` on the group — the visible label is absent by design, and an
  unlabelled radiogroup is a failure.
- The three bodies are `hidden`, not visually swapped, so only the active depth is in the
  accessibility tree. A screen reader must not read the same explanation three times.
- Switching depth moves nothing and announces nothing beyond the radio state change. The content
  region is **not** a live region: re-reading a whole section on every arrow press is hostile.

### Cost

Three 11px italic words at the right edge of a section head is a control that a first-time user
may not recognise as a control. That is the instruction, and it is a real cost — measured by
whether a new user ever reaches `teaching` depth without being told. **Mitigation:** the first
time a workspace is opened, one section head carries a margin tab reading
`three depths — try teaching`. It appears once, is dismissed by using the toggle, and is never
shown again. That is the only onboarding affordance in the product.

---

## 16. Diff view

### Provenance

The two-column hairline table (§9), and `18-diff-verify-rollback.md` §2.6, which has already
decided the field-level rendering:

> `#14171A` ink for the after value, `#5C6772` muted for the before, a `→` in muted, and the
> `tighten` / `loosen` label as a muted lowercase margin word — the card's margin-tab treatment.
> No red, no green, no `+`/`-` gutter in colour.

**This section implements that decision and does not re-argue it.** It adds only what that
document does not specify: the line-level diff of emitted config, where before/after does not
apply.

### 16.1 Field-level — exactly as §18 specifies

```html
<section class="diffset">
  <h3 class="diff-node">
    <span class="diff-op">Changed</span>
    <span class="diff-kind">IpsecPolicy</span>
    <code class="diff-name">IPSEC-POL</code>
    <span class="tab">on srx-a</span>
  </h3>
  <table class="diff">
    <caption class="vh">Field changes on IpsecPolicy IPSEC-POL</caption>
    <thead><tr><th scope="col">Field</th><th scope="col">Before</th>
               <th scope="col"></th><th scope="col">After</th>
               <th scope="col">Class</th></tr></thead>
    <tbody>
      <tr>
        <td class="m">perfect-forward-secrecy</td>
        <td class="before">—</td>
        <td class="arrow" aria-hidden="true">→</td>
        <td class="after m">keys group14</td>
        <td><span class="tab">tighten</span></td>
      </tr>
      <tr>
        <td class="m">proposals</td>
        <td class="before m">IPSEC-P2</td>
        <td class="arrow" aria-hidden="true">→</td>
        <td class="after m">IPSEC-P2</td>
        <td><span class="tab">·</span></td>
      </tr>
    </tbody>
  </table>
</section>
```

```css
.diff-node { display: flex; align-items: baseline; gap: var(--s3);
             margin: var(--s5) 0 var(--s2);
             font-size: var(--t-small); font-weight: 400; }
.diff-op   { font-size: var(--t-micro); font-weight: 700;
             letter-spacing: var(--track-label); text-transform: uppercase; }
.diff-kind { color: var(--muted); }
.diff-name { font-family: var(--mono); font-weight: 700; }

table.diff td.before { color: var(--muted); }
table.diff td.after  { color: var(--ink); font-weight: 700; }
table.diff td.arrow  { color: var(--muted); width: 2ch; text-align: center; }
table.diff thead th:nth-child(3) { width: 2ch; }
```

The `→` is `aria-hidden` and the column headers carry the meaning — a screen reader reads
"Field, perfect-forward-secrecy. Before, em dash. After, keys group14. Class, tighten." That is
better than "arrow" and it is why the arrow is a separate cell rather than inline text.

### 16.2 Line-level — what §18 leaves open

An emitted-config diff has no before/after pair per row; it has added, removed and changed
lines. The encoding is tokens §4.2: **C5 gutter glyph + C3 ground, no colour, no strikethrough
on additions.**

```html
<div class="block diffblock" role="list" aria-label="Configuration change set">
  <div role="listitem" class="dl add">
    <span class="dg" aria-hidden="true">+</span><span class="vh">Added. </span>
    <span class="risk-dot caution" aria-hidden="true"></span><span class="vh">Changes config. </span>
    <code>set security ipsec policy IPSEC-POL perfect-forward-secrecy keys group14</code>
  </div>
  <div role="listitem" class="dl del">
    <span class="dg" aria-hidden="true">−</span><span class="vh">Removed. </span>
    <span class="risk-dot danger" aria-hidden="true"></span><span class="vh">Disruptive. </span>
    <code>delete security ipsec vpn VPN-B traffic-selector TS1</code>
  </div>
  <div role="listitem" class="dl same">
    <span class="dg" aria-hidden="true">·</span>
    <span class="risk-dot caution" aria-hidden="true"></span><span class="vh">Changes config. </span>
    <code>set security ipsec policy IPSEC-POL proposals IPSEC-P2</code>
  </div>
</div>
```

```css
.diffblock .dl {
  display: flex; align-items: flex-start; gap: var(--s2);
  min-height: var(--row-min); padding-right: var(--s3);
  font-family: var(--mono); font-size: var(--t-mono); line-height: var(--lh-step);
}
.dg { flex: none; width: 2ch; text-align: center; color: var(--muted);
      font-weight: 700; user-select: none; }
.dl.add  { background: var(--surface-2); }
.dl.add  .dg { color: var(--ink); }
.dl.del  { background: var(--page); }
.dl.del  .dg { color: var(--ink); }
.dl.del  code { text-decoration: line-through; text-decoration-thickness: 1px;
                color: var(--muted); }
.dl.chg  { background: var(--surface-2); }
.dl.same .dg { color: var(--hairline); }
@media print { .dl { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
```

The gutter glyphs are `+ − ~ ·` — `diff -u` with a `·` for context, which is a vocabulary every
engineer in this audience already has. Adding a colour on top would be redundant *and* would
break R1.

**Risk dots survive into the diff**, because a removed line still does something to a live box
when you paste it. `delete security ipsec vpn VPN-B traffic-selector TS1` is `Disruptive`
whether it is an addition or a removal — the risk is a property of the command, not of the
change. That is exactly why the two channels can coexist here.

### States

| State | Channel | Rendering |
|---|---|---|
| Added | C5 `+` + C3 `--surface-2` | — |
| Removed | C5 `−` + C9 strike | on `--page`, struck, `--muted` |
| Changed | C5 `~` + C3 | — |
| Unchanged context | C5 `·` in `--hairline` | on `--page` |
| `DeltaClass` tighten/loosen/neutral/unknown | C10 | margin tab, field-level only |

### Keyboard

Roving list (§2.5). <kbd>Enter</kbd> on a line opens its provenance (§17) exactly as in a
normal config block. Additionally:

| Key | Behaviour |
|---|---|
| <kbd>n</kbd> / <kbd>p</kbd> | Next / previous **changed** line, skipping context |
| <kbd>u</kbd> | Toggle unchanged-context lines |

### Accessibility contract

- Every glyph has a `.vh` word: `Added. `, `Removed. `. A screen reader reads
  "Added. Changes config. set security ipsec policy…" which is the complete meaning.
- Strikethrough alone is not announced by most screen readers, which is why the `.vh` word
  carries it rather than `<del>`. `<del>`/`<ins>` were considered and rejected: the change set
  is not a text edit and the semantics would nest badly inside the `role="list"`.
- `18-diff-verify-rollback.md` §2.5 requires deterministic ordering; the DOM order is that
  order and the component must never re-sort.

### Cost

A neutral diff is slower to skim than a red/green one for a sighted user with normal colour
vision — that is a real regression and it is worth naming. It is better for readers with a
red-green deficiency (the largest single group of colour-vision-deficient users), better in
print, better in forced colours, and it is required by R1
regardless. The `n`/`p` keys exist specifically to buy back the skim speed.

---

## 17. Provenance disclosure

### Provenance

**New.** The card has no interactions. But `13-emitters-and-provenance.md` decides that every
line carries its origin, and brief §4.1 makes "click any line of config to learn what it does"
a structural consequence rather than a feature. This is where that lands.

**It is called a popover in the assignment and it is not one.** Tokens §11 forbids elevation, so
there is nothing to float. It is an inline disclosure that pushes content down, bounded by two
hairlines, on `--page` inside the block's `--surface`. Same information, no z-layer.

### Anatomy

```
 ▌ 3  ▪ set security ike gateway GW-B external-interface reth0.0
 ├──────────────────────────────────────────────────────────────── 1px hairline
 │  NODE          IkeGateway GW-B
 │  FIELD         external_interface
 │  PROVENANCE    entered by hand · 2026-07-02 · you
 │  RULES         ike.gateway.external-interface.wrong-unit  (passed)
 │  RISK          CHANGES CONFIG — NEEDS A COMMIT
 │
 │  external-interface is the WAN unit the IKE packets leave by, not st0.
 │  Wrong on a multi-homed box means Phase 1 sources from an address the peer
 │  has never heard of.
 │
 │  [ Copy this line ]  [ Open the node ]  [ Why this value? ]
 ├──────────────────────────────────────────────────────────────── 1px hairline
 ▌ 4  ▪ set security ipsec vpn VPN-B bind-interface st0.0
```

### HTML

```html
<div class="prov" id="prov-3" role="region" aria-label="Provenance for line 3">
  <dl>
    <dt>Node</dt>       <dd>IkeGateway <code>GW-B</code></dd>
    <dt>Field</dt>      <dd><code>external_interface</code></dd>
    <dt>Provenance</dt> <dd>entered by hand · <time datetime="2026-07-02">2026-07-02</time></dd>
    <dt>Rules</dt>      <dd><code>ike.gateway.external-interface.wrong-unit</code>
                            <span class="tab">passed</span></dd>
    <dt>Risk</dt>       <dd><span class="pill caution">Changes config<span class="vh">
                            — needs a commit</span></span></dd>
  </dl>
  <p class="why"><code>external-interface</code> is the WAN unit the IKE packets leave by, not
     <code>st0</code>. Wrong on a multi-homed box means Phase 1 sources from an address the peer
     has never heard of.</p>
  <div class="prov-actions">
    <button class="btn ghost">Copy this line</button>
    <button class="btn ghost">Open the node</button>
    <button class="btn ghost">Why this value?</button>
  </div>
</div>
```

### CSS

```css
.prov {
  padding: var(--s3) var(--s4) var(--s3) calc(var(--gutter-num) + var(--s3));
  background: var(--page);
  border-top: var(--rule-hair) solid var(--hairline);
  border-bottom: var(--rule-hair) solid var(--hairline);
  font-family: var(--sans); font-size: var(--t-small);
  white-space: normal;
  opacity: 1; transition: opacity var(--motion-disclosure) var(--motion-ease);
}
.prov[hidden] { display: none; }
.prov dl { display: grid; grid-template-columns: max-content 1fr;
           gap: var(--s1) var(--s4); margin: 0 0 var(--s2); }
.prov dt { font-size: var(--t-micro); font-weight: 700;
           letter-spacing: var(--track-label); text-transform: uppercase;
           color: var(--muted); padding-top: 2px; }
.prov dd { margin: 0; }
.prov .why { margin: 0 0 var(--s3); max-width: var(--measure); color: var(--ink); }
.prov-actions { display: flex; gap: var(--s2); flex-wrap: wrap; }
@media print { .prov[hidden] { display: none; } }   /* collapsed stays collapsed on paper */
```

The left padding aligns the panel's content with the config text, not with the block edge — so
the panel reads as belonging to the line above it rather than to the block.

### The one exception: the diagram surface

On the diagram (`6.5`), a node has no line to expand under, so provenance must be positioned.
That variant uses the native `popover` attribute with `position-anchor`, and it is still bounded
by a 1px `--ink` rule with `box-shadow: var(--shadow)` — which is `none`. It floats; it does not
appear to float.

```css
.prov[popover] { border: var(--rule-hair) solid var(--ink);
                 max-width: 40ch; box-shadow: var(--shadow); }
```

<!-- VERIFY: CSS Anchor Positioning (`position-anchor` / `anchor()`) shipped in Chromium ahead of other engines; check current Firefox and WebKit status before depending on it. Fallback: position with a small JS measure on open, which is what the diagram already needs for edge routing. -->

### States

| State | Rendering |
|---|---|
| Collapsed | `hidden`; out of the accessibility tree |
| Expanded | Visible, 90ms opacity fade — the only animation in the product |
| Provenance = `parsed` | Extra margin tab with the capture age: `parsed 2026-03-04, 4 months old` |
| Provenance = `inferred` | Extra margin tab: `inferred — not confirmed against the device` |
| Line has an active finding | The `Rules` row shows the rule id and links to the finding row |

The parsed-age tab is required by brief §6.5: *"Where the graph was populated by parsing real
configs, mark those nodes as such and show their age."* Showing the age is the part that stops
§2.2's rot from being invisible.

### Keyboard

| Key | Behaviour |
|---|---|
| <kbd>Enter</kbd> / <kbd>Space</kbd> on the line | Toggle |
| <kbd>Tab</kbd> from the line | Into the panel's actions |
| <kbd>Esc</kbd> | Collapse; focus returns to the line |
| <kbd>Shift</kbd>+<kbd>Tab</kbd> from the first action | Back to the line |

Focus is **not** moved into the panel on open. The user asked what a line does, not to operate a
control; moving focus would make <kbd>↓</kbd> stop navigating the block.

### Accessibility contract

- `role="region"` with an `aria-label` naming the line, so it is reachable from the landmark
  rotor and is not an anonymous blob of `dl`.
- Controlled by the line's `aria-expanded` / `aria-controls`.
- `hidden` when collapsed — not `visibility` and not opacity-zero.
- The `Why` prose is the corpus explainer at the current depth (§15), so a `teaching`-depth
  reader gets the analogy and a `terse` reader gets one sentence.

### Cost

Inline disclosure pushes every line below it down. Expand line 3 of a 40-line block and lines
4–40 move ~140px. That is disorienting and it is the price of having no overlays. **Mitigation:**
only one panel is open at a time within a block, opening a second closes the first, and the
focused line is scrolled to stay put (`scroll-margin-block: var(--s5)` plus an explicit
`scrollIntoView({block:'nearest'})` after expansion). The alternative — a floating card with a
shadow — is a different design language and it would be the first crack.

---

## 18. Inspector

### Provenance

The two-column hairline table (§9), turned on its side and given a column. It is the graph node
viewed as a field list, which is exactly what the card's `THE OBJECT CHAIN` block is on paper:

> ```
> ike proposal  →  ike policy  →  ike gateway
> algorithms       mode            address
> dh-group         pre-shared-key  external-interface
> lifetime                         version (v1/v2)
> ```

### Anatomy

```
 ┌ .inspector — a column, not an overlay ────────────────┐
 │ IKE GATEWAY                          fields that matter│
 │ GW-B                                                   │
 │ ───────────────────────────────────────────────────────│
 │ address              203.0.113.10        hand · 07-02  │
 │ external-interface   reth0.0             hand · 07-02  │
 │ version              v2-only             hand · 07-02  │
 │ dead-peer-detection  always-send 10 × 3  inferred      │
 │ local-identity       —                   unset         │
 │ ───────────────────────────────────────────────────────│
 │ FINDINGS ANCHORED HERE                          2      │
 │ ▌ HIGH  Dead peer detection window is 50 s             │
 │ ───────────────────────────────────────────────────────│
 │ EMITS                                          6 lines │
 │ ▌ ▪ set security ike gateway GW-B address 203.0.113.10 │
 └────────────────────────────────────────────────────────┘
```

### HTML

```html
<aside class="inspector" aria-label="Inspector">
  <header class="insp-head">
    <p class="eyebrow">Ike gateway</p>
    <span class="tab">fields that matter</span>
    <h2 class="insp-name"><code>GW-B</code></h2>
    <p class="insp-id"><code>fathom:ikegateway:01J9K2QW3M8Z5T7VYB4N6XR0PD</code></p>
  </header>

  <table class="insp-fields">
    <caption class="vh">Fields of IkeGateway GW-B</caption>
    <thead><tr><th scope="col">Field</th><th scope="col">Value</th>
               <th scope="col">Provenance</th></tr></thead>
    <tbody>
      <tr><th scope="row" class="m">address</th>
          <td class="m">203.0.113.10</td>
          <td><span class="tab">hand · 2026-07-02</span></td></tr>
      <tr><th scope="row" class="m">external-interface</th>
          <td class="m">reth0.0</td>
          <td><span class="tab">hand · 2026-07-02</span></td></tr>
      <tr><th scope="row" class="m">dead-peer-detection</th>
          <td class="m">always-send interval 10 threshold 3</td>
          <td><span class="tab">inferred — not confirmed against the device</span></td></tr>
      <tr class="unset"><th scope="row" class="m">local-identity</th>
          <td class="m">—</td>
          <td><span class="tab">unset</span></td></tr>
    </tbody>
  </table>

  <section class="insp-block">
    <h3>Findings anchored here <span class="tab">2</span></h3>
    <!-- finding rows, §13, compact variant -->
  </section>

  <section class="insp-block">
    <h3>Emits <span class="tab">6 lines</span></h3>
    <!-- config block, §8 -->
  </section>
</aside>
```

### CSS

```css
.inspector {
  border-left: var(--rule-hair) solid var(--hairline);
  padding: 0 0 var(--s7) var(--s5);
  min-width: 0;                 /* so mono content can scroll rather than blow the grid */
  overflow-y: auto;
}
.insp-head { padding-top: var(--s5); }
.insp-name { margin: var(--s1) 0 0; font-size: var(--t-mast);
             font-family: var(--mono); font-weight: 700;
             letter-spacing: 0; text-transform: none; border: 0; }
.insp-id { margin: 2px 0 0; font-size: var(--t-micro); color: var(--muted);
           word-break: break-all; }

.insp-fields { margin-top: var(--s3); }
.insp-fields th[scope="row"] { text-align: left; font-weight: 400; color: var(--muted);
                               padding: var(--s2) var(--s3) var(--s2) 0;
                               border-bottom: var(--rule-hair) solid var(--hairline);
                               white-space: nowrap; }
.insp-fields tr.unset td, .insp-fields tr.unset th { color: var(--muted); }
.insp-block { margin-top: var(--s5); }
.insp-block h3 { display: flex; justify-content: space-between; gap: var(--s3);
                 border-bottom: var(--rule-hair) solid var(--ink);
                 padding-bottom: var(--s2); }

/* Layout: the inspector is a grid column, never a floating panel. Tokens §11. */
.workbench { display: grid; grid-template-columns: 1fr 420px; gap: var(--s6);
             align-items: start; }
@media (max-width: 1100px) {
  .workbench { grid-template-columns: 1fr; }
  .inspector { border-left: 0; border-top: var(--rule-mast) solid var(--ink);
               padding-left: 0; }
}
```

Below 1100px the inspector stops being a column and becomes a section, and it takes the 3px
masthead rule to mark the transition — the same rule, doing the same job it does at the top of a
card side: *a new sheet starts here.*

### The node ID is shown, in full, and never truncated

`fathom:ikegateway:01J9K2QW3M8Z5T7VYB4N6XR0PD` is 43 characters of noise to a user and it is the
thing every rule, explainer, emitter and diagram element references (invariant 7). It is set at
`--t-micro` in `--muted` with `word-break: break-all`, and it is selectable. When a user files a
bug or a reviewer correlates an export, this is the only string that identifies the node
unambiguously — a name can be renamed, an ID cannot.

### States

| State | Channel | Rendering |
|---|---|---|
| Field set, hand-entered | C10 | tab `hand · 2026-07-02` |
| Field set, parsed | C10 | tab `parsed 2026-03-04, 4 months old` |
| Field inferred | C10 | tab `inferred — not confirmed against the device` |
| Field unset | C3 + C10 | `—` in `--muted`, tab `unset` |
| Field being edited | §2.4 | inline `.field` replaces the value cell |
| Field invalid | C8 + C5 | 2px `--ink` underline + `!` |
| Node has findings | — | count in the section head's margin tab |
| Nothing selected | — | The empty state is a **field list of the last-selected node, dimmed**, not a blank panel. The card has no empty states and neither does this |

### Keyboard

| Key | Behaviour |
|---|---|
| <kbd>Tab</kbd> | Into the inspector after the main region |
| <kbd>↑</kbd>/<kbd>↓</kbd> | Between field rows (roving, §2.5) |
| <kbd>Enter</kbd> | Edit the focused field |
| <kbd>Esc</kbd> | Cancel the edit and restore the previous value |
| <kbd>Ctrl/⌘</kbd>+<kbd>Enter</kbd> | Commit the edit and move to the next field |
| <kbd>Ctrl</kbd>+<kbd>I</kbd> | Move focus to the inspector from anywhere |

<kbd>Esc</kbd> restoring the previous value is not optional: the inspector edits the graph
directly, and an accidental keystroke in a field that auto-commits is a silent corruption.

### Accessibility contract

- `<aside aria-label="Inspector">` — a `complementary` landmark, so <kbd>D</kbd>-key landmark
  navigation reaches it.
- The field list is a real `<table>` with `<th scope="row">` on the field name. Screen readers
  then announce "external-interface, reth0.0, hand 2026-07-02" per row without the user having
  to remember the column order.
- The inspector's content changes when the selection changes. It is **not** a live region —
  announcing a 30-row table on every selection change would be unusable. Instead, selection
  moves focus to the inspector's `<h2>` only when the selection was made from the keyboard, and
  leaves focus alone when it was made with a pointer.

### Cost

420px of permanent screen width. At the 1180px sheet that leaves 700px for the main region,
which holds 93 columns of `--t-mono` — still above the 72 the emitter wraps at, so config blocks
survive. Below 1100px it stacks and the user scrolls. There is no collapse-to-icon-rail variant,
because a 40px icon rail is four icons and this product has no icons.

---

## 19. AI proposal review surface

### Provenance

**New, and required to look unlike everything else in this catalogue.** Invariant 9 quarantines
non-determinism behind the AI layer's boundary "and labelled as such in the UI". This component
is that label.

**The constraint: make it unmistakable without inventing a fourth colour.** R1 leaves colour
unavailable, so the difference has to be structural. It is, and the rule is simple enough to
state in one line:

> **Everything deterministic in this product is drawn with solid rules. The AI surface is the
> only thing drawn with dashed ones.**

### The five devices, and what each survives

| # | Device | Survives print? | Survives forced colours? | Survives a screen reader? |
|---|---|---|---|---|
| 1 | **Dashed 1px border**, all four sides | Yes | Yes — `border-style` is not overridden | No |
| 2 | **Hatched 4px left gutter** | Yes | **No** — `background-image` is forced to `none` | No |
| 3 | **`--surface-2` ground** | Yes (with `print-color-adjust`) | No | No |
| 4 | **Banner: `PROPOSAL — NOT DETERMINISTIC`** | Yes | Yes | Yes |
| 5 | **`role="region" aria-label="AI proposal, not deterministic"`** | n/a | Yes | Yes |

Devices 4 and 5 are the ones that always work, which is why they are mandatory and the visual
ones are reinforcement. Device 1 is the primary *visual* signal because it is the only visual
one that survives forced colours.

### Two rules that make it categorical rather than decorative

**Rule 1 — an AI proposal never renders a risk dot or a risk pill.** `Risk` is a property of
emitted lines produced by a deterministic emitter with a corpus entry behind them. A proposed
line has not been through that pipeline. Showing a green dot next to an unvalidated line would
be the single most dangerous thing this interface could do. Proposed config renders in mono, on
`--surface-2`, with **no gutter dot at all** — and the absence is itself a signal, because every
other config block in the product has one.

**Rule 2 — the clipboard payload is prefixed.** Copying from a proposal yields:

```
# fathom: AI proposal — not validated, not emitted by the deterministic pipeline
# model: <id>  corpus: <ver>  pack: <ver>  generated: <iso8601>
set security ipsec policy IPSEC-POL perfect-forward-secrecy keys group14
```

`#` is a comment in Junos, PAN-OS set syntax and IOS, so the prefix is inert if pasted and
legible if reviewed. This is the one place in the product where the clipboard payload is not
byte-identical to the visible text, and it is disclosed on the button:
`Copy — with a provenance header`.

### HTML

```html
<section class="prop" role="region" aria-label="AI proposal, not deterministic">
  <header class="prop-head">
    <b class="prop-label">Proposal — not deterministic</b>
    <span class="prop-meta">
      <code>subagent:ipsec-review</code> ·
      <code>corpus 1.4.0</code> ·
      <time datetime="2026-07-28T09:14:00Z">09:14</time>
    </span>
  </header>

  <div class="prop-body">
    <p>The peer at <code>203.0.113.10</code> is configured <code>v2-only</code> but no
       <code>local-identity</code> is set, and the outer source is behind NAT. Under IKEv2 the
       peer will validate the IKE-ID against the address it sees.</p>

    <div class="prop-cfg">
      <div class="pl"><code>set security ike gateway GW-B local-identity inet 198.51.100.5</code></div>
    </div>

    <dl class="prop-basis">
      <dt>Because</dt>
      <dd><code>IkeGateway.local_identity</code> is unset and <code>nat_detected</code> is true
          <span class="tab">read from the graph, not inferred</span></dd>
      <dt>Corpus support</dt>
      <dd><code>explain:field:IkeGateway.local_identity</code>
          <span class="tab">human-reviewed 2026-04-11</span></dd>
      <dt>Egress</dt>
      <dd>none — this ran on the local subagent<span class="tab">no graph left the device</span></dd>
    </dl>

    <aside class="note">
      <b class="note-label">What accepting does</b>
      <p>Accepting sets the field on the graph and re-runs the deterministic pipeline. The
         resulting config lines are emitted, carry risk, carry provenance, and are indistinguishable
         from anything you typed. This block collapses to a provenance entry on that field.</p>
    </aside>
  </div>

  <div class="prop-actions">
    <button class="btn">Accept and re-emit</button>
    <button class="btn ghost">Reject</button>
    <button class="btn ghost">Copy — with a provenance header</button>
    <button class="btn ghost">What was sent</button>
  </div>
</section>
```

### CSS

```css
.prop {
  position: relative;
  border: var(--rule-hair) var(--rule-style-proposed) var(--muted);
  border-radius: var(--radius);
  background: var(--surface-2);
  margin: var(--s4) 0;
}
.prop::before {
  content: ""; position: absolute; left: 0; top: 0; bottom: 0;
  width: var(--rule-accent); background: var(--hatch);
}
.prop-head {
  display: flex; align-items: baseline; gap: var(--s3); flex-wrap: wrap;
  padding: var(--s2) var(--s3) var(--s2) var(--s4);
  border-bottom: var(--rule-hair) var(--rule-style-proposed) var(--hairline);
}
.prop-label { font-size: var(--t-micro); font-weight: 700;
              letter-spacing: var(--track-label); text-transform: uppercase;
              color: var(--muted); }
.prop-meta  { margin-left: auto; font-size: var(--t-micro); color: var(--muted); }
.prop-body  { padding: var(--s3) var(--s3) var(--s3) var(--s4); font-size: var(--t-small); }
.prop-body p { max-width: var(--measure); }

/* Proposed config: mono, on surface-2, dashed edge, and NO risk dot. Rule 1. */
.prop-cfg { background: var(--page);
            border-left: var(--rule-accent) var(--rule-style-proposed) var(--hairline);
            font-family: var(--mono); font-size: var(--t-mono);
            line-height: var(--lh-step); margin: var(--s3) 0; overflow-x: auto; }
.prop-cfg .pl { padding: 0 var(--s3); white-space: pre-wrap; }

.prop-basis { display: grid; grid-template-columns: max-content 1fr;
              gap: var(--s1) var(--s4); margin: var(--s3) 0; }
.prop-basis dt { font-size: var(--t-micro); font-weight: 700;
                 letter-spacing: var(--track-label); text-transform: uppercase;
                 color: var(--muted); }
.prop-basis dd { margin: 0; }
.prop-actions { display: flex; gap: var(--s2); flex-wrap: wrap;
                padding: 0 var(--s3) var(--s3) var(--s4); }

@media print {
  .prop { break-inside: avoid;
          -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .prop-actions { display: none; }
  .prop-head::after { content: " — NOT VALIDATED"; }
}
@media (forced-colors: active) {
  .prop::before { display: none; }         /* the hatch is gone; the dash carries it */
  .prop { border-width: 2px; }             /* compensate by weight, not by colour */
}
```

### The mandatory rows

Three `<dt>`s may never be omitted:

| Row | Why |
|---|---|
| **Because** | The same discipline as a finding's witness (§13). A proposal that cannot name the graph values it read is a guess, and it should be rendered as one — or not rendered. |
| **Corpus support** | Ties the claim to a human-reviewed corpus entry (invariant 10). If there is none, the row reads `none — this is not backed by the corpus` and the proposal renders with an extra margin tab `unsupported`. |
| **Egress** | Either `none — this ran on the local subagent` or the exact origin and payload summary, with a `What was sent` button that shows the literal bytes. Never absent, never vague. |

### States

| State | Rendering |
|---|---|
| Proposed | As above |
| Accepted | The block collapses to a single muted line — `accepted 09:16 · set on IkeGateway.local_identity` — and the field's provenance in the inspector reads `ai-proposed, accepted by you, 2026-07-28`. **The provenance never loses the fact.** |
| Rejected | Collapses to `rejected 09:16` with the reason if one was given. Retained for the session log |
| Unsupported by corpus | Extra margin tab `unsupported`, and Accept is disabled until the user acknowledges a confirm dialog |
| Egress was required | The egress band (§20) is armed while the request is in flight and the proposal shows the origin in its `Egress` row permanently |

### Keyboard

| Key | Behaviour |
|---|---|
| <kbd>Tab</kbd> | Normal order; Accept is first, so the destructive-by-default path is never the fastest |
| <kbd>A</kbd> | Accept — only when focus is inside the region, and only after the region has been focused once (no blind accept from a global shortcut) |
| <kbd>R</kbd> | Reject |
| <kbd>Esc</kbd> | Collapse the proposal without deciding |

There is no "accept all". A surface that lets a user accept twelve unvalidated proposals with
one keystroke has defeated the purpose of having a review surface.

### Accessibility contract

- `role="region"` with `aria-label="AI proposal, not deterministic"`. This is the non-visual
  equivalent of the dashed border and it is not optional — a blind user must know this content
  is different, and no amount of dashing tells them.
- The banner text is real text, not `::before` content, so it is announced and it prints.
- Accept opens a confirm dialog when the proposal is unsupported by the corpus. The dialog names
  what will change and what will re-run.
- The proposal is never inserted into a live region and never announces itself. Proposals arrive
  because the user asked; interrupting a screen-reader user mid-sentence to announce one is
  hostile.

### Cost

Dashed borders at 1px look like a broken image placeholder to a certain kind of eye, and there
is no getting around that — dashes read as "unfinished" and that is exactly the connotation
wanted here, but it does mean the AI surface is the ugliest thing in the product. That is a
deliberate outcome and it should not be softened. If a future revision makes this surface
pleasant, it has broken it.

---

## 20. Egress-armed indicator

### Provenance

**New.** Invariant 1: *"No egress by default. The application never opens a connection the user
did not configure."* When that default is deliberately relaxed — a sync build, or an AI
subagent that calls out — the user must know, continuously, without looking for it.

### The device: inversion, used nowhere else

Tokens §4.2 allocates inversion to this component alone. `--ink` ground, `--page` text, full
bleed, sticky, with a 3px `--ink` bottom rule.

Why not `--caution`? Because that is one of the three reserved colours (R1) and the prototype's
use of it is a violation this document corrects. Why inversion? Because nothing else in the
product is inverted, so an inverted band cannot be read as decoration — there is no other
inverted thing for the eye to file it alongside. And inversion survives forced colours exactly
(`background: CanvasText; color: Canvas`), which colour does not.

### Anatomy

```
 ████████████████████████████████████████████████████████████████████████████
 █ EGRESS ARMED   this workspace may send graph excerpts to                 █
 █                api.example-inference.internal · 3 requests this session  █
 █                                              [ WHAT WAS SENT ] [ DISARM ]█
 ████████████████████████████████████████████████████████████████████████████
 ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔  3px --ink
```

### HTML

```html
<div class="egress" id="egress" role="status" aria-live="polite" hidden>
  <b class="egress-label">Egress armed</b>
  <span class="egress-detail">
    This workspace may send graph excerpts to
    <code>api.example-inference.internal</code> ·
    <span class="egress-count">3</span> requests this session
  </span>
  <span class="egress-actions">
    <button class="btn egress-btn">What was sent</button>
    <button class="btn egress-btn">Disarm</button>
  </span>
</div>
```

### CSS

```css
.egress {
  position: sticky; top: 0; z-index: var(--z-egress);
  display: flex; align-items: center; gap: var(--s3); flex-wrap: wrap;
  padding: var(--s2) var(--s5);
  background: var(--ink); color: var(--page);
  border-bottom: var(--rule-mast) solid var(--ink);
  font-size: var(--t-micro); letter-spacing: var(--track-label);
  text-transform: uppercase; font-weight: 700;
}
.egress[hidden] { display: none; }
.egress-label { flex: none; }
.egress-detail { letter-spacing: 0; text-transform: none; font-weight: 400;
                 font-size: var(--t-small); }
.egress-detail code { color: var(--page); }
.egress-count { font-variant-numeric: var(--num-tabular); }
.egress-actions { margin-left: auto; display: flex; gap: var(--s2); }
.egress .btn { background: var(--ink); color: var(--page); border-color: var(--page); }
.egress .btn:hover { background: var(--page); color: var(--ink); }
.egress .btn:focus-visible { outline: var(--focus-width) solid var(--page);
                             outline-offset: var(--focus-offset-outset); }

@media (forced-colors: active) {
  .egress { background: CanvasText; color: Canvas; forced-color-adjust: none; }
  .egress .btn { border-color: Canvas; color: Canvas; }
}
@media print {
  .egress { display: none; }
  .foot::after { content: attr(data-egress-note); }   /* "egress was armed — 3 requests" */
}
```

### Six rules, all of which are requirements

1. **It is rendered by the shell, not by any view.** No view can suppress it, no route can
   unmount it, and it is above the view rail in the DOM.
2. **It is the only sticky element in the product** (tokens §11). The masthead scrolls away;
   this does not.
3. **It does not animate.** Considered and rejected in tokens §12: a pulse would have to be
   disabled under `prefers-reduced-motion`, which would remove the loudest signal in the product
   for the users most likely to need it. The band is unmissable statically.
4. **The count is live and monotonic within a session.** `3 requests this session` increments and
   never resets except on workspace close. A number that goes back to zero teaches the user the
   band is decorative.
5. **`Disarm` is always present and always one click.** An armed state the user cannot leave
   from the band is a state they will stop reading.
6. **It survives to paper as a footer note.** A printed export whose session had egress armed
   says so. `display: none` on the band, and the folio gains
   `egress was armed during this session — 3 requests`.

### The arming announcement

The band is `role="status" aria-live="polite"` because it is persistent state. The *transition*
into armed is an event, and it is announced once, assertively, by a separate one-shot live
region:

```html
<div class="vh" role="alert" id="egress-arm-alert"></div>
```

```js
egressAlert.textContent =
  'Egress armed. This workspace may now send graph excerpts to ' + origin + '.';
```

Two live regions rather than one, because `aria-live="assertive"` on a persistent element would
interrupt on every count increment. The polite band reports state; the assertive one-shot
reports the transition. That split is the only correct way to do this.

### Focus order

**When armed, the `Disarm` button is the first focusable element in the document**, before the
skip link. Rationale: the first <kbd>Tab</kbd> after arming should land on the way out. This is
implemented by DOM order, not `tabindex`, because positive `tabindex` values are a maintenance
trap.

### States

| State | Rendering |
|---|---|
| Disarmed (default, and the only state in an offline build) | `hidden` — the element is not in the accessibility tree at all |
| Armed, idle | Band visible, count shown |
| Armed, request in flight | The detail gains ` · request in flight` as **text**, not a spinner. There are no spinners |
| Armed, request failed | Detail gains ` · last request failed` and the `What was sent` panel shows the error |

### Keyboard

| Key | Behaviour |
|---|---|
| <kbd>Tab</kbd> | Reaches `What was sent`, then `Disarm`, before anything else |
| <kbd>Enter</kbd> on `What was sent` | Opens a dialog showing the literal payloads, per request, byte-exact |
| <kbd>Enter</kbd> on `Disarm` | Disarms with no confirm. Disarming is always safe; confirming it would add friction to the safe direction |

There is no keyboard shortcut to *arm*. Arming happens in settings, deliberately, with a
confirm.

### Accessibility contract

- `role="status"` + `aria-live="polite"` on the band; a separate `role="alert"` for the
  transition.
- `hidden` when disarmed, so it is absent from the accessibility tree rather than silently
  present.
- Inversion is restated in system colours under forced colours; `forced-color-adjust: none`
  appears here and nowhere else in the product.
- Contrast: `--page` on `--ink` is 17.99:1 in light and 14.67:1 in dark. The button's `--page`
  border on `--ink` is the same, well past 1.4.11's 3:1.

### Cost

A permanent 32px band across the top of every screen whenever the feature is on. That is the
point: egress should feel like something is switched on, not like a preference that was set once
and forgotten. In the offline single-file build the element never renders and costs nothing.

---

## 21. Folio / footer

### Provenance

> ```
> ─ 1px rule ────────────────────────────────────────────────────
>    SIDE n OF 4 — <THREE WORDS>
> ```

### HTML

```html
<footer class="foot" data-egress-note="">
  <span>Config · 2 of 6 — build, provision, plumb</span>
  <span>corpus 1.4.0 · pack ipsec-baseline 2.1.0 · engine 0.9.3</span>
  <span>workspace 8f21c4… · as of 2026-07-28</span>
</footer>
```

### CSS

```css
.foot {
  margin-top: var(--s7); padding-top: var(--s3);
  border-top: var(--rule-hair) solid var(--ink);
  display: flex; justify-content: space-between; gap: var(--s4); flex-wrap: wrap;
  font-size: var(--t-micro); letter-spacing: var(--track-label);
  text-transform: uppercase; color: var(--muted);
  font-variant-numeric: var(--num-tabular);
}
@media print { .foot { break-before: avoid; } }
```

### Why the versions are in the footer and not in an About dialog

Invariant 9: same workspace + same corpus version + same build ⇒ byte-identical output. The
three version strings and the workspace content hash are what make a screenshot or a printout
*reproducible*. Putting them behind a menu means every bug report arrives without them. They
cost 16px at the bottom of a page nobody scrolls to and they are the difference between "it said
something different yesterday" being answerable and not.

---

## 22. Channel audit — proving R3 holds

R3 says one channel, one owner, per component. This table is the proof, and it is the thing to
re-run whenever a component is added.

| Component | C1 bar tone | C2 bar style | C3 ground | C4 outline | C5 gutter | C6 weight | C8 underline | C9 strike | C10 tab | colour |
|---|---|---|---|---|---|---|---|---|---|---|
| Masthead | — | — | — | — | — | emphasis | — | — | annotation | — |
| Risk legend | — | — | — | — | — | — | — | — | — | **Risk** |
| Note | Risk *or* neutral | — | wash | — | — | — | — | — | — | **Risk** |
| Config block | expanded | — | hover/select | focus | line no. + select `▸` | — | — | — | annotation | **Risk** (dot) |
| Table | — | — | hover/zebra | focus | sort mark | — | — | — | annotation | — |
| Plumbing list | — | — | — | focus | ordinal | title | — | — | annotation | **Risk** (ladder only) |
| View rail | — | — | — | focus | — | — | active (3px) | — | — | — |
| Finder | **selection** | — | active/hover | *(shell border)* | — | — | — | — | corpus meta | **Risk** (pill) |
| Finding row | **severity** | **state** | hover | focus | — | severity high | — | suppressed | **confidence** | **Risk** (fix block only) |
| Suppression | — | hatch = suppressed | orphaned | focus | — | rule id | — | expired/orphaned | **review state** | — |
| Depth toggle | — | — | — | focus | — | active | active | — | overridden | — |
| Diff, field | — | — | — | focus | — | after value | — | — | **DeltaClass** | — |
| Diff, line | — | — | **add/chg** | focus | **+ − ~ ·** | — | — | **removed** | — | **Risk** (dot) |
| Provenance | — | — | — | focus | — | — | — | — | prov class + age | **Risk** (pill) |
| Inspector | — | — | unset rows | focus | — | — | **validation** | — | **provenance** | — |
| AI proposal | — | **dashed = proposed** | surface-2 | focus | — | — | — | — | unsupported | **none — Rule 1** |
| Egress | — | — | **inversion** | focus | — | — | — | — | — | — |

**Two audited exceptions**, both recorded rather than hidden:

1. **Finder — C1 carries selection**, not severity or risk. Safe because a finder result has no
   severity and its risk lives in a pill on the opposite edge.
2. **Finder input — no focus outline.** The dialog's 1px `--ink` border plus the caret is the
   indicator. The only component in the product where C4 is not the focus channel.

**One column that is deliberately almost empty:** the AI proposal's colour cell reads `none`.
That is Rule 1 in §19 and it is the strongest single signal in the whole scheme — the absence of
the risk dot that every other config block has.

---

## 23. Product-wide keyboard map

Every global binding, in one place, so conflicts are visible.

| Key | Scope | Action |
|---|---|---|
| <kbd>Ctrl/⌘</kbd>+<kbd>K</kbd> | Global, including inside text fields | Open the finder palette |
| <kbd>Ctrl</kbd>+<kbd>1</kbd>…<kbd>6</kbd> | Global | Jump to view 1–6 |
| <kbd>Ctrl</kbd>+<kbd>I</kbd> | Global | Focus the inspector |
| <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>1/2/3</kbd> | Global | Set global explainer depth |
| <kbd>Ctrl/⌘</kbd>+<kbd>P</kbd> | Global | Print / export the field card |
| <kbd>Esc</kbd> | Global | Close the topmost open thing: dialog → disclosure → nothing |
| <kbd>/</kbd> | Global, outside text fields | Focus the in-view filter |
| <kbd>?</kbd> | Global, outside text fields | Open the keyboard map — which is this table, rendered |
| <kbd>↑</kbd> <kbd>↓</kbd> <kbd>Home</kbd> <kbd>End</kbd> <kbd>PgUp</kbd> <kbd>PgDn</kbd> | Any roving list | Navigate (§2.5) |
| <kbd>←</kbd> <kbd>→</kbd> | Tabs, radiogroups, finding rows | Move / expand / collapse |
| <kbd>Enter</kbd> <kbd>Space</kbd> | Any row | Activate |
| <kbd>n</kbd> <kbd>p</kbd> | Diff view | Next / previous changed line |
| <kbd>u</kbd> | Diff view | Toggle unchanged context |
| <kbd>s</kbd> | Findings | Suppress the focused finding |
| <kbd>c</kbd> | Findings, config | Copy the fix / the block |
| <kbd>a</kbd> <kbd>r</kbd> | AI proposal, focus inside only | Accept / reject |

**No single-letter binding fires while focus is in a text input.** That includes the finder's
own input, which is why <kbd>Ctrl/⌘</kbd>+<kbd>K</kbd> is the only global that works from inside
a field.

**Every single-letter binding has a visible equivalent.** `?` renders this table; each row's
action also exists as a button in the component. A keyboard-only affordance that has no visible
twin is a secret.

---

## 24. Accessibility contract, summarised

Everything a reviewer needs to check, in one list.

| # | Contract | Where |
|---|---|---|
| 1 | No meaning is carried by colour alone; every risk element has its word | R2, §2.1, audited in §22 |
| 2 | Focus is a 2px `--ink` outline, `:focus-visible`, on every interactive element | tokens §4.7; one audited exception (§22) |
| 3 | Contrast: all text ≥ 4.5:1 on every permitted ground, both themes | tokens §3.4, §5.5 |
| 4 | `--hairline` never bounds an interactive control (1.4.11) | tokens §3.4 |
| 5 | Pointer targets ≥ 24×24 CSS px, or documented under an exception | `--row-min`; §15 uses the spacing exception, recorded |
| 6 | Long lists are one tab stop with arrow navigation, announced via `aria-describedby` | §2.5 |
| 7 | Every disclosure uses `aria-expanded` + `aria-controls` + `hidden` | §8, §13, §17 |
| 8 | Every table is a real table with `scope` and a `<caption class="vh">` | §9, §16, §18 |
| 9 | Uppercase is `text-transform`; the DOM text is sentence case | tokens §7.7 |
| 10 | Live regions: `polite` for state, one-shot `alert` for transitions, never both on one element | §12, §20 |
| 11 | Forced-colours mode has an explicit path for every colour-carried signal | tokens §6 |
| 12 | The AI surface's difference is available non-visually via `role`+`aria-label` | §19 |
| 13 | `prefers-reduced-motion` loses nothing, because the only animation is redundant | tokens §12 |
| 14 | Skip link to the main region; landmarks on banner, main, complementary, contentinfo | shell |
| 15 | The document has one `<h1>` per view and no skipped heading levels | §3 |

---

## 25. Failure modes

| # | Failure | What it looks like | What you will wrongly blame | Fix |
|---|---|---|---|---|
| 1 | A config block renders 900 lines | The tab key takes 900 presses to escape; the page janks | "the browser" | §8.10 — 400-line threshold, then `<pre>` with opt-in expansion |
| 2 | Both the finding bar and a nested risk dot appear at the same indent | Two 4px marks 4px apart; neither reads | "too much going on" | §4.3 of tokens — the block's gutter is risk, the row's edge is severity, 12px apart |
| 3 | A margin tab becomes the only place a fact appears | Low-vision users miss it entirely at 11px italic | "the tab is too small" | §4 — tabs never carry sole information; §22 audits it |
| 4 | The AI surface is restyled to look "polished" | Proposed config becomes indistinguishable from emitted config | "users trust it more now" | §19. If the surface stops being ugly it has stopped working |
| 5 | The egress band is made dismissible | Users dismiss it in week one and never see it again | "it was annoying" | §20 rule 5 — `Disarm` is the exit, dismissal is not |
| 6 | Provenance is moved into a floating tooltip | Content stops jumping; a shadow appears; then a second one | "the inline panel was disorienting" | §17 cost — the jump is the price of no elevation. Mitigate with scroll anchoring, do not float |
| 7 | Suppression reasons get `line-clamp: 2` | The list looks tidy; nobody reads a reason again | "the list was too long" | §14 rule 2 — a long list is the honest representation |
| 8 | `text-transform: uppercase` typed as literal capitals | Screen readers spell out headings | "screen readers are broken" | tokens §7.7, and lint the DOM |
| 9 | The legend is shown once, on the first view | Sides 2–6 of a printed export are unreadable | "print is hard" | §6 placement rule, tokens §13.5 |
| 10 | A fourth risk level is added ("informational") | The legend grows; the three-colour discipline dies | "we needed a level for X" | Invariant: exactly three. What you needed was `Severity`, which is a different axis |
| 11 | Depth per-block overrides get persisted | Two engineers open the same workspace and see different text | "it remembered my preference" | §15 — session-only, by design |
| 12 | The inspector is turned into an overlay to save width | The first shadow appears; §11 collapses | "the sheet was too narrow" | §18 — it stacks below 1100px; it does not float |

---

## 26. Open decisions

**DECISION — the `Terminal` wrap flavour and the clipboard (§8.2).** Until
`13-emitters-and-provenance.md`'s open VERIFY on Junos backslash continuation is closed,
`Terminal` may be a *display and print* flavour only. **RECOMMENDATION:** ship `Display` as the
default, `Terminal` as an opt-in per block, and never as the clipboard payload.

**DECISION — high-severity findings expanded by default (§13).** Costs vertical space, buys the
`acceptable_when` field being read. **RECOMMENDATION:** ship it expanded, and revisit if the
median workspace has more than five `high` findings — at which point the problem is the rule
pack's 15% budget, not the component.

**DECISION — the AI surface deliberately looks worse than everything else (§19).** This will be
argued with by anyone who reviews the interface visually. **RECOMMENDATION:** record it in the
design review as intentional, with the sentence from §19's cost section, so the argument is had
once.

**Open — the finder input's missing focus ring (§12).** It is an audited exception and it may be
the wrong call. The alternative is an inset ring on a control that already has a caret and a
1px `--ink` dialog border 1px away from it, which double-draws.
<!-- VERIFY: test with a screen-magnifier user at 400% zoom whether the dialog border alone is a sufficient focus indicator for the finder input, or whether an inset ring is needed despite the double-draw. -->

**Open — `::after` content for the confidence tab (§13).** Marked VERIFY there. If any of
NVDA/JAWS/VoiceOver drops generated content in 2026, the tab moves into markup and the CSS gets
simpler.

---

## 27. Sources consulted

- `.context/field-card-srx-ipsec.txt` — every worked example: the object chain, the five
  plumbing pieces, the bring-up order, the ERROR DECODER table, the FLAP PATTERN → CAUSE table,
  the PFS explanation and its three rules, the DPD `10 × 3` recommendation, the MTU overhead
  budget, `show system commit`, and `external-interface is the WAN unit the IKE packets leave
  by, not st0`.
- `.context/design-language.md` — the six devices in "Devices worth stealing verbatim", the
  "What the card never does" list, and the Voice section.
- `docs/50-design/51-design-tokens.md` — every value; the channel budget in §4 that §22 audits.
- `docs/10-core/13-emitters-and-provenance.md` §13 — `WrapPolicy`, the 72-column default, the
  two-space continuation indent, and the open VERIFY on backslash continuation.
- `docs/10-core/12-rule-engine.md` §10–11 — `Finding`, the witness, `FindingState`,
  `Suppression`, `Scope`, `ReviewState`, and the "author is NOT authenticated" note that §14 is
  built around.
- `docs/60-content/63-rulepack-spec.md` — the `severity` and `confidence` enumerations and the
  15% `high` budget.
- `docs/10-core/18-diff-verify-rollback.md` §2.4–2.6 — `DeltaClass` and the already-decided
  field-level diff rendering that §16.1 implements verbatim.
- `docs/10-core/17-workspace-format.md` §9 — where suppressions live and why they are the
  reviewer's artifact.
- WAI-ARIA Authoring Practices for the combobox, tabs, radiogroup, disclosure and accordion
  patterns; WCAG 2.2 SC 1.4.1, 1.4.11, 2.4.7, 2.5.8; MDN on `forced-colors`, `hidden`,
  `popover` and `print-color-adjust`.

## 28. Disagreements

None with the binding conventions. Three recorded departures from adjacent material, each
argued rather than asserted:

**1. The assignment names a "provenance popover"; §17 specifies an inline disclosure.** This is
not a refusal — it is what `51-design-tokens.md` §11 (`--shadow: none`, no elevation scale)
forces. A popover implies a floating layer, a floating layer implies separation from the page,
and the only tool for that separation in a shadowless design is a 1px rule, which is what the
one genuinely-positioned variant (the diagram) uses. The name is kept; the behaviour is inline.

**2. `design/prototype/index.html` is superseded on the egress indicator.** The prototype paints
it in `--caution` / `--caution-wash`, which reuses a reserved colour. §20 replaces this with
inversion. This is the same correction recorded in `51-design-tokens.md` §18 and it is listed
again here because the component is the place it will be noticed.

**3. Convention: "Finding severity is a separate scale rendered in neutrals with a weight/rule
treatment."** Obeyed exactly, in §13, via the four-tone 4px bar. Recording the cost so it is not
mistaken for an objection: neutral severity is measurably slower to skim than a colour ramp, and
the mitigation — expanding `high` findings by default — spends vertical space to buy the
scanning back. Both costs are real and the convention is still right, for the reason the card
demonstrates on all four of its sides: a colour vocabulary that means one thing is worth more
than two vocabularies that each mean half a thing.

---

### Reconciliation with `52-information-architecture.md`

These two documents were authored independently and diverge on three points. **`52` owns
layout, `54` owns components**, so the proposals below are offered to `52` rather than imposed;
all three are cheap to change in either direction and should be settled once.

| Point | `52` §3.5.1 | `54` §13 | Proposed resolution |
|---|---|---|---|
| Severity treatment | A **top** rule above the row: 2px ink (high), 1px hairline (medium/low), with the severity word carrying weight | A **4px left bar** in four tones: `--ink` / `--muted` / `--hairline` / none | Take `54`'s left bar. Reasons: it is the card's own accent-bar device (`design-language.md` device 2) rather than a new one; a top rule collides with the row separator that already exists between findings; and it gives four steps, which the type needs |
| Severity levels | Three, plus `suppressed` | Four — `high`/`medium`/`low`/`info` — with `suppressed` handled as a *state* on a separate channel (C2) | Take `54`'s. `63-rulepack-spec.md` defines `info \| low \| medium \| high`, and `12-rule-engine.md` §10.2 makes `Suppressed` a `FindingState`, not a severity. Conflating them means a suppressed high and a suppressed info render identically |
| Suppression reason | Margin tab shows the first 40 characters | The record quotes the reason in full, never clamped (§14 rule 2) | Both, and they are not in conflict: the 40-character tab belongs to the *finding row* in a list; the full quote belongs to the *suppression record* in the review list. `54` §14 governs the second and should say so — it now does |

One point where the two agree and it is worth recording that they arrived there separately:
the egress indicator sits **above the 3px masthead rule**, outside the sheet's own furniture.
`52` §2.2 puts it there for layout reasons; `54` §20 puts it there because it is shell-rendered
and no view may suppress it. `54` additionally specifies the treatment — inversion, not a
1px strip in `--caution` — for the reason in §28 note 2.
