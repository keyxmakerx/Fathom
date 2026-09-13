# ADR-0039 — The perimeter is where the ports are

> **Status:** Accepted — decided by the orchestrating session on 2026-09-02 under the owner's
> standing delegation (*"I'm good with your decisions, you are the orchestrator"*), executing
> `49` §15 item 1, which the owner commissioned and which ranks this gesture first of nine.
> Binding once built (CLAUDE.md rule 3); reopenable on merit (`75` §2).
> **Date:** 2026-09-02.
> **Reversal cost:** R1 — the lowest in this series. No schema change, no new opcode, no new
> journal shape. The gesture terminates in `OP_CABLE`, which shipped 2026-08-29. Reversal
> deletes a pointer branch and a preview line; every cable drawn meanwhile is indistinguishable
> from one drawn with the keyboard, because it *is* one.
> **Amends:** `56` §6.3 (Escape mid-drag — documented since authoring, never built, built here
> for both drags); `56` §6.4 (specifies `L`/`T` keys that were never bound and a write path
> ADR-0038 superseded). **Supersedes nothing.**

## Contents

| § | |
|---|---|
| 1 | The request |
| 2 | **The decision** |
| 3 | Why the perimeter answers the question nobody could answer |
| 4 | Eleven decisions, each with what it rejected |
| 5 | The band, and why it is a screen-space number |
| 6 | What must stay true |
| 7 | What will be built |
| 8 | Cost, measured |
| 9 | Failure modes |
| 10 | Open decisions |
| 11 | Sources consulted |
| 12 | Disagreements |

## 1. The request

`49` §15 — the Lucidchart study the owner commissioned — ranks nine gestures and puts this one
first: *"Hover the perimeter to connect … **In Fathom the anchors are ports, not compass points,
which is strictly more useful.** This one gesture is most of what 'feels like Lucidchart'."*

The owner asked for it twice in his own words. 2026-08-18 (`57` §12): *"something as simple as
drag and dropping cables."* 2026-08-19 (`57` §13.5): *"it's WAY faster to drag and drop, and
then fill out later."*

**And it is now small, which it was not when it was written.** `OP_CABLE` shipped 2026-08-29
(ADR-0038) with a hold-then-select keyboard path, a port picker that mints ports as the gesture
needs them, and a proven journal and replay. This record adds a **pointer affordance over a
proven gesture**. It writes nothing new.

## 2. The decision

> **A drag that begins on a box's perimeter draws a cable, because the perimeter is where the
> ports are. A drag that begins in its body moves the box, as it does today. The drag opens the
> same port picker the keyboard opens, journals the same record, and can be abandoned with
> Escape — which will now also abandon a move, as `56` §6.3 said it should since the day it was
> written.**

## 3. Why the perimeter answers the question nobody could answer

The scouts were asked to establish, and not to resolve, the question this feature turns on:
**a drag from box A to box B could mean a cable or a logical link, and nothing arbitrates.**
They established it precisely, and it is worse than it looks:

- `hand_link_candidates(Device, Device)` returns exactly `[PeersWith]`
  (`crates/fathom-weld/src/lib.rs:162`), so `OP_LINK` writes it **with no question at all** —
  its own one-candidate rule.
- `OP_CABLE` is a structurally disjoint path: different frame, different write, different sheet.
- Nothing in the schema, the module, or the page picks between them. Today a person chooses by
  pressing one of two strip buttons.

So a drag that "just connects" would have to guess, and guessing is the defect this corpus keeps
finding in itself (`70` §16's doctrine, ADR-0038 D2's `PassThrough` trap).

**The perimeter dissolves it.** `49` §15 item 1 says what a Fathom anchor *is*: not a compass
point but a **port**. A drag from a port is a physical run — a cable — by definition. A logical
adjacency is not a thing you pull out of a socket.

And the escape hatch is **already built and already shipping**: the cable sheet's third choice
reads *"no cable — these just talk"* (`fathom-dev.src.html:5497`) and redirects to the connect
controls in one sentence (`:5737`). So the ambiguity is answered **by a sheet that exists**, at
the moment the operator can see both boxes and knows which they meant — and the drag itself
never guesses.

## 4. Eleven decisions, each with what it rejected

| # | decided | rejected, and why |
|---|---|---|
| D1 | **Perimeter = cable.** The drag opens the existing port picker for the near end, then the far end, exactly as the strip path does. *"These just talk"* remains its third choice and is how a person reaches a logical link from a drag. | Asking *"cable or link?"* on every drag — twenty cables in a sitting is twenty questions, and `57` §12.4 already says this gesture wants to be sticky like a pen tool. Also rejected: inferring from kinds, which is guessing |
| D2 | **Body = move, unchanged.** The existing ADR-0035 drag keeps the whole box minus the band, and every property it has: 3px slop, capture on first real move, preview by transform, one write on release, refusal snaps back. | Any change to the move-drag's feel. It works and the owner uses it |
| D3 | **The band is 10 CSS pixels of SCREEN space**, by arithmetic against the box's client rect — no second SVG element. §5 reasons it. | A band in scene units: the canvas zooms 0.2×–4.0×, so a fixed scene band renders 1.6px to 32px — a 20× swing. A second hit-target rect: more DOM per box on an estate meant to hold thousands |
| D4 | **A box too small to aim at is all body.** Under 40 screen pixels on its shorter side, the band is suppressed and the whole box moves. | Letting the band eat a small box until it cannot be moved by mouse at all. The keyboard path connects it |
| D5 | **Drop on a port is NOT in this cut, because no port is drawn.** `dgFoldPorts` folds `PhysicalPort` and `Cable` out of every scene (`fathom-dev.src.html:7512`), added by ADR-0038's own build so a cable would not draw itself as a scaffold of three boxes. | Pretending the target exists, or standing up the rung-3 faceplate first — explicitly deferred by ADR-0038 §9 item 2 |
| D6 | **Drop on empty canvas reverts and says why**, naming the shape autoprompt as unbuilt. | Silence — the operator would think the product was broken. Building the autoprompt (`49` §15 item 3), which is its own feature |
| D7 | **Escape mid-drag reverts and releases, for the connect-drag AND the move-drag.** | Shipping a second drag with a gap the first one has. `56` §6.3 has specified this since it was written and it was never built; adding a third un-abortable gesture would make the doctrine decorative |
| D8 | **Drop back on the origin box is a cancel**, with a sentence. | Treating it as a self-connection, which no schema edge admits anyway |
| D9 | **The release handler calls the low-level functions with the ids the drag captured**, and never synthesises `S.sel`. | Reusing the keyboard wrappers: `dgSelect` on a `Rack` **descends into its elevation** (`:4840`), so a synthesised selection would hijack the gesture into navigation mid-drag |
| D10 | **No new accelerator.** The strip buttons plus hold-then-select already satisfy `55` §5.5 and `49` §15 item 4. | Filing a chord in this record. ADR-0035 §9's `Alt`+arrow is the cautionary tale: filed in an ADR, wired, and only then checked against `53`'s keymap. `53` owns the keymap and a chord is its decision, not this one's |
| D11 | **The preview line is decorative.** The SVG is `aria-hidden`; what is happening is announced in the live region, as the move-drag announces its own outcome. | A live-region update per pointermove, which would flood a screen reader |

## 5. The band, and why it is a screen-space number

**10 CSS pixels, measured from the box's rendered edge inward, in client coordinates.**

Three constraints fix it and they leave little room:

1. **It must exceed the 3px slop** (`fathom-dev.src.html:8156`). A press inside the band that
   then moves must be unambiguously a drag from the band, not a jittered press near it.
2. **It must not vary with zoom.** The canvas runs `DG_MIN = 0.2` to `DG_MAX = 4.0`
   (`:4581`). A scene-unit band would render 20× thicker at one end of that range than the
   other. The page already has the right precedent: the box hairline uses
   `non-scaling-stroke` (`:1259`) precisely so its apparent weight is constant.
3. **It must leave a body to grab.** At 10px each side, a box needs 20px of width before the
   body vanishes — hence D4's 40px floor, which leaves half the box as body at the worst case.

10 is picked as the smallest value satisfying all three with margin, and it is written here
rather than in the code so that changing it is a decision and not a tweak — the same reason
ADR-0035 fixed its 4px snap grid in a record.

## 6. What must stay true

- **The drag adds no reachable state.** Anything the pointer can do, the keyboard can already
  do — `49` §15 item 9: *"a state only a mouse can reach is not a state."*
- **A cable drawn by drag and the same cable drawn by keyboard produce byte-identical journal
  records apart from ids.** This is a test, not a hope.
- **Nothing is written before release**, and a refusal reverts the preview completely — the
  move-drag's discipline, inherited.
- **No DOM event reaches a mode, confirm, or id argument** (the 2026-08-21 paste defect).
- **The sheet records the verb that opened it** (the 2026-08-16 chooser defect), and the drag
  is a fourth way in, so it carries its own verb.
- **The move-drag is not regressed.** Its driver
  (`2026-08-15-hand-placement-drive.mjs`, 23/23 — corrected here from a stale "25/25" that had
  circulated since the driver was first filed; re-run three times against this record's own build
  and the pre-ADR-0039 build alike, both count 23) must stay green untouched.

## 7. What will be built

| layer | what |
|---|---|
| the page | the perimeter hit test; the third pointerdown branch; the preview line; the drop resolution and its four outcomes (box / origin / empty canvas / off-canvas); the Escape rung for both drags; the live-region sentences |
| the module | **nothing.** `OP_CABLE` (27) is unchanged |
| evidence | `docs/80-review/evidence/2026-09-02-drag-to-connect-drive.mjs` through a real reload: a cable drawn entirely by drag; the same cable by keyboard producing the same journal shape; body-drag still moves; the band suppressed on a small box; Escape mid-connect and mid-move; drop on origin; drop on empty canvas; *"these just talk"* reached from a drag; export → reload → import |
| docs | this record; the stale `fathom-weld` comment corrected; `56` §6.3 and §6.4 annotated; CLAUDE.md's state bullet |

### As built, 2026-09-02 (the proving session)

Three adversarial skeptics attacked the no-regression claim, the never-guesses claim, and §5's
band arithmetic independently, against the build this record's own execution session left
behind. Two held with no defect (no-regression; the-guess, modulo one evidence gap it flagged
as non-blocking and this pass closed anyway). The third — the band — found the shipped page
code correct in every respect it checked (screen-space arithmetic, the named constants, the
floor suppression, the 3px slop, D9's no-synthesised-selection) but found the **evidence** for
D3's zoom-invariance claim materially weaker than §9's own failure-mode row and the execution
session's own report implied. Nothing here changes the page, the module, or the schema — the
gesture built by the execution session is unchanged. What follows is where the **evidence**
changed and why.

1. **§9's failure-mode row says "the driver drags at two zoom levels" stops the band feeling
   different at different zooms. The first cut of the evidence only ever moved the zoom by a
   single ~20% step off the fitted view** (one click of the `0.8×` strip button, `k=1.488 →
   k=1.190`), because its own search capped its target factor at `Math.min(0.7, maxF * 0.9)` —
   nowhere near either `DG_MIN` (0.2) or `DG_MAX` (4.0), and its own comments admitted why: a
   fitted view packs the outermost boxes close to the canvas edge (`DG_PAD` is only 24px), so a
   naive zoom toward either true extreme pushes a box off screen or under the 40px floor. Where
   no safe alternate zoom existed for a run's layout the section silently degraded to
   `check(..., true, 'not exercised')` — a vacuously passing assertion, which is exactly the
   anti-pattern CLAUDE.md rule 0 names: a gate tested against what the assertion needs rather
   than what the real range requires. **Rewritten**, not reworded: the section now computes the
   true safe factor range from the two test boxes' own on-screen rects and the canvas's, anchors
   the zoom on the **pair's own shared midpoint** (not the canvas centre, which buys materially
   more headroom when the pair sits off-centre in a five-box layout) rather than the strip's
   canvas-centred buttons, and drives the zoom with a **real wheel event** — the same `wheel`
   listener and the same `Math.pow(0.9988, dy)` arithmetic `dgZoomAt` runs for a physical
   scroll (`fathom-dev.src.html:8150`), a different real input path than the strip buttons the
   first cut used, not a synthesised call into the page's own functions. It now drives the drag
   at two genuinely far-apart points — one as close to where D4's floor takes over as the pair's
   geometry allows (this run: `k=1.000`, against a `k=1.488` fit — the box's shorter side lands
   at 44 CSS px, four above the literal 40), and one as close to the true `DG_MAX` ceiling as the
   pair's own on-canvas geometry allows (this run: `k≈1.689`, 42% of `DG_MAX` — this five-box
   vertical layout already fills most of the canvas height at "fit", which is what bounds how
   far a two-box subset of it can zoom in before its neighbours would leave the canvas, not a
   limit in the arithmetic) — and **fails outright**, rather than passing vacuously, if no safe
   alternate zoom exists for a run's layout. A structural point worth recording precisely rather
   than leaving implicit: for a normal 44-scene-unit device box, the 40px floor is crossed around
   `k≈0.91`, well above `DG_MIN` (0.2) — so "the same relative press produces the same outcome at
   `k=0.2` and `k=4.0`" is not a claim D3 makes for a box this size at all; below `≈0.91` D4's
   floor has already taken the box out of band-eligibility, which is the case §4 already drives
   at the true `DG_MIN`, separately and correctly. What D3 promises, and what §9 now actually
   drives, is the band's own operating range, not the whole `DG_MIN`–`DG_MAX` span.
2. **The evidence claimed all four release outcomes (box / origin / empty canvas / off-canvas)
   were driven, and Escape "for both drags."** True of three outcomes and of both Escapes; the
   fourth — a real pointerup released with its coordinates outside `.dcanvas` — was not actually
   driven by the shipped suite. Escape mid-drag (§7) exercises a structurally different code path
   (the keydown rung) from `dgConnectRelease`'s own off-canvas branch
   (`fathom-dev.src.html:8456-8461`), so passing the former proved nothing about the latter. A
   skeptic drove it by hand and confirmed the page said the right, distinct sentence
   (`cable drag cancelled — released off the canvas`, not the Escape wording); **§7b now drives
   it automatically** — a real release over the toolbar chrome above the canvas — so the claim in
   this section's own second row is no longer a promise the automated suite doesn't keep.
3. **Cosmetic**: the file's `// ----` section-header comments and its `console.log` section
   numbers had drifted apart (a comment read "10." over a console line that printed "9.",
   and similarly for the next section) from an earlier edit that inserted a subsection without
   renumbering both. Realigned; §9 is now one section with 9a/9b subsections (matching the
   existing 3/3b pattern already in the file), and the export/reload section is 10 in both places.

Re-run twice after the rewrite for stability: **58/58**, both runs, byte-identical journal counts
(`4` cable draws: §1, §2, §9a, §9b). The five drivers this record must not regress were re-run
unchanged and green: `2026-08-15-hand-placement-drive.mjs` 23/23,
`2026-08-29-cabling-drive.mjs` 56/56, `2026-08-16-hand-link-drive.mjs` 31/31,
`2026-08-16-the-cut-that-drew.mjs` 18/18.

## 8. Cost, measured

Page bytes before and after, read off the `fathom-artifact` build by the proving session.
Before: **2,803,728 bytes** (2026-08-29, after ADR-0038). After: **2,818,598 bytes** (2026-09-02,
this record's own build — read directly off `cargo run -p fathom-artifact`'s own output) —
**+14,870 bytes**. Module bytes are **unchanged at 988,540** (`cargo build --locked --release
--target wasm32-unknown-unknown -p fathom-wasm`, the same figure ADR-0038 §7 measured): this
record adds no Rust, and the wasm build confirms it rather than merely asserting it.

## 9. Failure modes

| failure | what stops it |
|---|---|
| dragging a box to move it starts a connection instead | D3's band plus D4's floor; the move driver re-run unchanged |
| the drag writes `PeersWith` where a cable was meant | D1: the drag never calls `OP_LINK`; a test asserts a dragged connection produces a `Cable` |
| a drag mid-flight cannot be abandoned | D7, driven in both directions |
| dragging onto a rack navigates away | D9: no synthesised selection |
| the band feels different at different zooms | D3's screen-space arithmetic; the driver drags at two zoom levels |
| the preview line survives a refusal | the revert path, driven |
| a screen-reader user is flooded mid-drag | D11 |

## 10. Open decisions

1. **The shape autoprompt** — `49` §15 item 3, drop on empty canvas creating a node *and* its
   edge in one gesture. The single largest remaining item of the nine. *For planning.*
2. **Drop on a port**, once the rung-3 faceplate exists (ADR-0038 §9 item 2). *For planning.*
3. **A keyboard chord for connect**, if wanted — `53`'s, not this record's (D10).
4. **`?` — the shortcut help — is specified in `53` §3.1 and does not exist in the page.**
   `49` §15 item 9 leans on it as the discoverability test. A pre-existing gap, surfaced here
   because this feature is the first that would want a line in it. *For planning.*
5. **Alignment guides and measured distances** (`49` §15 item 5) belong to the move-drag and are
   constrained there to gestures that write a `LayoutPin`. *For planning.*

## 11. Sources consulted

| source | for |
|---|---|
| `docs/40-stack/49-the-server-product.md` §15 | the ranked gestures; the anchors-are-ports sentence this record turns on |
| `docs/50-design/57-the-zoom-ladder-and-the-trace.md` §12, §13.5 | the owner's words |
| `docs/90-decisions/adr-0038-…md` | the gesture this one adds a pointer to |
| `docs/90-decisions/adr-0035-…md` | the move-drag, and the accelerator cautionary tale |
| three scout briefs, 2026-09-02 (session scratchpad `drag-{pointer,gesture,access}.*.txt`) | every line number above; the `dgFoldPorts` finding; the `dgSelect` Rack trap; the Escape gap |
| `docs/50-design/53-*.md` | the keymap's ownership (D10) |

## 12. Disagreements

1. **With `56` §6.4.** It specifies `L`/`T` keys and a single `Op::AddEdge{kind:Link}`. Neither
   exists: `53` binds no such keys, and ADR-0038 established that a cable is not an edge but a
   node with two. `56` is Proposed and predates both opcodes; it is annotated, not rewritten.
2. **With `fathom-weld/src/lib.rs`'s own doc comment**, which still reads *"no opcode creates a
   `Cable`"* — true when written, false since 2026-08-29. Corrected in this pass, because it is
   the first thing an implementer reads when asking what a device-to-device connection means.
3. **With this session's own opening proposal.** On 2026-08-29 the next canvas item was named as
   marquee select and multi-drag. `49` §15's ranking — researched, and the owner's own
   commission — does not list marquee select among its nine at all, and puts this gesture first.
   The ranking wins over the recollection.
