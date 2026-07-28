# Fathom design language — extracted from the SRX IPsec field card

This is **ground truth**, machine-extracted from the reference PDF the project owner
supplied (`srxipsecvpnreference1.pdf`, 4 sides). It is not an interpretation. Colour
values come from the PDF's own `rg`/`RG` operators; fonts from `/BaseFont` entries;
structure from the content-stream geometry.

The owner's words: *"it's very bare bones, there's something I love about it."*
Treat that as a hard constraint, not a starting point. The aesthetic is **printed
technical reference**, not "dashboard".

---

## Palette (exact, by usage frequency in the source)

| Hex | Occurrences | Role in the card |
|---|---|---|
| `#14171A` | 162 | Ink. Body text, headings, hairlines, the 3px masthead rule. Not black. |
| `#5C6772` | 152 | Muted. Secondary prose, table labels, margin tabs, footers. |
| `#F2F4F6` | 54 | Surface. Code-block and table-zebra background. |
| `#D2D7DD` | 34 | Hairline. 1px rules, cell borders, block edges. |
| `#FFFFFF` | 16 | Page. |
| `#1F6F4A` | 20 | **Safe / read-only.** Accent bar + label text. |
| `#EEF5F1` | 12 | Safe background wash. |
| `#A8571B` | 30 | **Caution / changes config.** Accent bar + label text. |
| `#FBF3EA` | 22 | Caution background wash. |
| `#8C2F2F` | 10 | **Danger / disruptive.** Accent bar + label text. |
| `#F8EFEF` | 2 | Danger background wash. |

Three semantic colours, each a `{ink, wash}` pair. **There is no fourth accent and no
brand colour.** The card has no blue, no purple, no gradient, no shadow. Every
non-neutral pixel on those four pages means one of exactly three things:

```
READ-ONLY   — SAFE ON PRODUCTION      #1F6F4A on #EEF5F1
CHANGES CONFIG — NEEDS A COMMIT       #A8571B on #FBF3EA
DISRUPTIVE  — DROPS LIVE TRAFFIC      #8C2F2F on #F8EFEF
```

That legend appears on **every one of the four sides**, unchanged. It is the card's
single most disciplined move and it maps 1:1 onto the `Risk` enum in the emitter spec
(`ReadOnly | ChangesConfig | Disruptive`). The tool must not invent a fourth level.

## Type

Two families only:

- **Liberation Sans** (regular / bold / italic) — headings, prose, table text.
  Metric-compatible with Helvetica/Arial. Substitute stack:
  `"Liberation Sans", Inter, "Helvetica Neue", Arial, system-ui, sans-serif`.
- **DejaVu Sans Mono** (regular / bold) — every command, every config line, every
  identifier, every field name in prose (`external-interface`, `st0.0`).
  Substitute stack: `"DejaVu Sans Mono", "JetBrains Mono", "SF Mono", Menlo, monospace`.

Observed treatments:

- Section heads are **letterspaced small-caps-ish uppercase** — rendered in the source
  as spaced capitals (`T H E   O B J E C T   C H A I N`, `P H A S E  1 —  P R O P O S A L,
  P O L I C Y,  G A T E W A Y`). Reproduce with `text-transform: uppercase` +
  `letter-spacing: 0.14em`, not by inserting spaces.
- Inline identifiers in prose are set in mono at the same optical size as the
  surrounding sans, and the sans body wraps around them (`external-interface is the
  WAN unit the IKE packets leave by, not st0.`). Mono-in-prose is the card's texture.
- Body copy is small and tight. This is a *reference*, and density is the point.
  Do not let a design system inflate the leading.

## Structure — the grammar of a card side

Each of the four sides is the same skeleton:

```
┌─ 3px ink rule ──────────────────────────────────────────────┐   masthead top
   SIDE n · <THREE WORDS, DOT-SEPARATED>          <margin tabs>
   <TITLE IN LETTERSPACED CAPS>
   <subtitle / companion line, muted>
   <one all-caps imperative warning, full width>
─ 1px rule ────────────────────────────────────────────────────
   READ-ONLY …   CHANGES CONFIG …   DISRUPTIVE …      ← legend, always
─ 1px hairline ────────────────────────────────────────────────

   ▌ SECTION HEAD                    ▌ SECTION HEAD
     prose                             prose
     ┌ mono block on #F2F4F6 ┐         ┌ table, hairline rules ┐
     └───────────────────────┘         └───────────────────────┘
     ▌ 4px accent bar + wash: the "note" — the thing people miss

   … two columns, ~360pt each, 744pt content width …

─ 1px rule ────────────────────────────────────────────────────
   SIDE n OF 4 — <THREE WORDS>
└──────────────────────────────────────────────────────────────┘
```

Devices worth stealing verbatim:

1. **The margin tab.** Tiny muted labels floating at the top-right of a side —
   `read this first`, `most-missed`, `verify as you go`, `why it exists`,
   `fields that matter`, `what the log means`, `up-ness`, `approx`, `DF ping`,
   `not VPN-specific`. Lowercase, unpunctuated, almost apologetic. They tell you
   *how to weight* the section without taking up a heading. This is the card's
   personality in four words. **Fathom's explainer depth toggle should feel like
   these**, not like a settings panel.
2. **The 4px left accent bar.** Notes and warnings are a wash + a 4px coloured left
   edge — never a box, never an icon, never a rounded corner. In the source these are
   literally `36 562 3 234 re f` — a 3-unit-wide filled rectangle.
3. **The one-line imperative.** `VERIFY AGAINST YOUR OWN BOX BEFORE ACTING`,
   `BOTH ENDS MUST AGREE — EVERY VALUE, EXACTLY`, `THE JOIN KEY ACROSS ALL OUTPUT IS
   VPN NAME + PEER IP, NEVER ST0`, `OVERHEAD FIGURES APPROXIMATE — CIPHER-DEPENDENT`.
   Each side states its own governing rule once, in caps, at the top. It is a
   *disclaimer that is also the most useful sentence on the page.*
4. **Two-column tables with no vertical rules.** Horizontal hairlines only. Left
   column is the lookup key (`NO_PROPOSAL_CHOSEN (P1)`), right column is the answer
   (`dh-group, encryption, hash, authentication-method`). The `ERROR DECODER` and
   `FLAP PATTERN → CAUSE` tables are the model for every findings/diagnostic view.
5. **Continuation backslashes preserved.** `set security ike proposal IKE-P1 \` —
   commands wrap the way they wrap in a terminal, not the way they wrap in a webpage.
   Emitted config must do the same.
6. **Numbered plumbing.** `#1 the tunnel interface` … `#5 policy for the zone pair`.
   Ordinals as content, not as `<ol>` chrome.

## What the card never does

No logos. No icons. No illustrations. No rounded corners. No drop shadows. No
gradients. No screenshots. No avatars. No progress bars. No "cards" in the UI sense.
No empty states. No decorative whitespace — the margins are for tabs, not for air.

## Voice — sampled from the source

> *"Phase 2 rides inside Phase 1. P1 can be perfectly healthy while P2 fails forever —
> that split is the most useful diagnostic fact on this card."*

> *"Miss #3 and Phase 1 times out with nothing useful in the log — the box drops the
> peer's IKE before processing it. Miss #1, #2, #4 or #5 and the tunnel reads UP while
> passing zero packets."*

> *"A tunnel that goes down at the lifetime boundary is a rekey collision or a peer
> refusing the new SA — not a timer that needs raising."*

> *"Too tight and a two-second underlay hiccup tears down a healthy tunnel — you then
> spend a week debugging self-inflicted flaps."*

> *"Correlate before you theorise."*

Characteristics to hold every explainer to:

- **States the failure mode, not the feature.** Never "PFS provides forward secrecy."
  Always "PFS on one side and absent on the other fails Phase 2 while Phase 1 stays up."
- **Names the misdiagnosis it prevents.** "easily misread as a wrong pre-shared key.
  Check identity before you re-type the PSK."
- **Uses em-dashes to deliver the twist.** The sentence sets up, the dash pays off.
- **Never hedges and never hypes.** No "simply", no "just", no "powerful", no
  "seamless" (except literally: *"Healthy rekey is seamless"*).
- **Ends sections with a rule of thumb, not a summary.** "10 × 3 is a reasonable
  middle." "Turn it on." "Write proposals out."

This voice is the `Teaching` depth in §5.4. It is achievable by a human writing YAML.
It is *not* reliably achievable by a language model improvising at runtime — which is
the single strongest argument for the corpus-first, model-second position in the AI
architecture.
