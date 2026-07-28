# 53 — Interaction and the keyboard

> **Status:** Proposed

Companion documents: `52-information-architecture.md` (the shell, the six views and the selection
model this keymap drives), `51-design-tokens.md` (the visual system — focus rings, weights and rules
are specified there and referenced here), `54-component-catalog.md` (the components these
gestures act on; §8.3's wrap policy and §14's finder are load-bearing for §6 and §5),
`10-core/16-command-finder.md` §19 (the finder's own keymap, which
this document extends and, in one place, proposes to correct),
`40-stack/44-performance-budgets.md` (every millisecond in §10),
`30-security/33-sync-protocol.md` §5–§7 (the op model and merge semantics that §7's undo has to
survive), `20-ai/21-ai-layer-architecture.md` §2.5 (the accept contract §7.6 has to preserve).

The audience is people who spend their working day in a terminal, in `vi`, on a console cable, at
a `>` prompt. That is not a stylistic observation, it is a design constraint with a specific
consequence: **for this audience, reaching for the mouse is a small failure, and they will
notice every one.**

It is also a constraint that is easy to over-read. A network engineer lives in a terminal because
that is where the devices are, not because they have taken a position on modal editing. The same
person uses a browser all day. Designing a vim-modal interface for them because they type `:wq`
is a category error, and §2 argues it out rather than assuming it.

**The governing rule of this document, stated once, in caps, at the top:**

> **EVERY ACTION IS REACHABLE WITHOUT A MOUSE, AND EVERY ACTION IS ALSO REACHABLE WITHOUT THE
> KEYMAP. A BINDING WITH NO VISIBLE AFFORDANCE IS A FEATURE ONLY THE AUTHOR HAS.**

---

## 0. Contents

| § | |
|---|---|
| 1 | What this product actually asks of the keyboard |
| 2 | The scheme — three candidates, one decision |
| 3 | The keymap, in full |
| 4 | Conflict analysis |
| 5 | `Ctrl+K` in full |
| 6 | Copy — the primary output mechanism |
| 7 | Undo and redo |
| 8 | Focus |
| 9 | Errors and validation — timing, not styling |
| 10 | Latency — what is synchronous with a keystroke |
| 11 | Touch and small screens |
| 12 | Accessibility obligations, stated as requirements |
| 13 | Failure modes |
| 14 | Open decisions |
| 15 | Sources consulted |
| 16 | Disagreements |

---

## 1. What this product actually asks of the keyboard

*margin tab: read this first*

Before picking a scheme, count the work. A keymap is sized by the interactions it has to cover,
and this product's interactions fall into five groups with very different shapes.

| Group | Examples | Frequency | Shape |
|---|---|---|---|
| **A — Navigation** | switch view, move within a list, expand/collapse, scroll to selection | constant, tens per minute | Directional. Wants arrows and a small alphabet |
| **B — Selection** | select, extend, toggle, clear | constant | Directional plus modifiers |
| **C — Text entry** | field values: `203.0.113.10`, `reth0.0`, `group14`, a suppression reason, a passphrase, a finder query | **constant, and interleaved with A and B** | Every printable key is text |
| **D — Verbs** | copy, undo, save, start a walkthrough, open the explainer, cycle depth, accept a proposal | occasional, deliberate | Named actions. Wants mnemonics |
| **E — Escape** | dismiss, cancel, unfocus | constant | One key |

Group C is the one that decides the scheme. **This is not a reading application.** It is not a
mail client and it is not a source browser. Roughly half of what a user does in the walkthrough,
the inventory and the finder is typing values into typed fields, and those fields are
interleaved with navigation at a granularity of a second or two: type `203.0.113.10`, tab, type
`reth0.0`, arrow down, expand, read, arrow up, type.

Any scheme that makes single letters mean commands has to answer group C, and the answers are
either "a mode" or "focus-dependence". §2 is that argument.

---

## 2. The scheme — three candidates, one decision

### 2.1 The candidates, priced honestly

| | **Modal / vim-like** | **Chorded / Emacs-like** | **Conventional core + sequences** |
|---|---|---|---|
| Shape | Normal mode where letters are commands; insert mode where they are text; `Esc` between | Every command is a modifier chord: `Ctrl+X Ctrl+F`, `Ctrl+C Ctrl+K` | A small set of `Ctrl`/`Cmd` chords for universals, plus single-letter and two-key sequences that fire only when focus is not in a text field |
| Fit with group C | **Bad.** Every field entry is a mode transition. Every mistyped mode is a destructive command — `d` in normal mode where the user meant to type `dh-group` | Good. Chords never collide with text | Good, if the focus rule is exactly right (§2.3) |
| Fit with group D | Excellent. Mnemonic verbs, one key | Poor. `Ctrl+Alt+Shift+F` is not a mnemonic, it is a knuckle exercise | Good. `g f` is a mnemonic and two taps |
| Browser/OS collision | Low — single letters are not reserved | **Severe.** §4.1: the browser owns most of the `Ctrl`+letter space and reserves some of it non-preventably | Low for sequences, bounded for the handful of chords |
| Discoverability | Poor. Modes are invisible unless you draw an indicator, and `design-language.md` has no place to draw one | Poor | Moderate. Sequences are listed in the footer and in `?` |
| Screen reader interaction | Hostile — single letters collide with browse-mode quick navigation | Fine | Needs WCAG 2.1.4 compliance (§12.2) |
| Precedent in this space | `vi`, `less`, `htop`, `k9s` | Emacs, and effectively nothing on the web | GitHub, Gmail, Linear, Superhuman, Jira |
| Cost to a junior | High. The teaching pillar (brief §5.4) exists to serve people ramping in, and a modal editor is a second thing to ramp into | Very high | Low. `Ctrl+C` copies |

### 2.2 DECISION — a small conventional core, plus sequences, and no modes

**The scheme is:**

1. **A small chorded core** — about eight `Ctrl`/`Cmd` bindings, all of them things a browser user
   already expects: `Ctrl+K`, `Ctrl+C`, `Ctrl+Z`, `Ctrl+Shift+Z`, `Ctrl+S`, `Ctrl+F`, `Ctrl+A`,
   `Ctrl+L`.
2. **Arrow-key navigation everywhere**, with `j`/`k`/`h`/`l` as aliases under the focus rule.
3. **Single-letter verbs and two-key `g`-prefixed sequences**, which fire **only when focus is not
   in a text-entry element** (§2.3).
4. **`Alt`/`Option` for view and pane management** — `⌥1`–`⌥6`, `⌥←`/`⌥→`, `⌥P`, `⌥E`, `⌥D`,
   `⌥L`. These work everywhere, including inside text fields, because they never collide with
   text.
5. **No modes. No mode indicator. No mode errors.**

**The defence against modal.** The single strongest argument for a modal scheme is that this
audience already knows one. The argument against is arithmetic: in the SRX walkthrough (`52`
§6.3) a user answers about fifteen questions, of which roughly nine take free text or a scalar.
A modal scheme charges two mode transitions per field — thirty transitions — and prices every
missed transition as a command executed against a graph. In `vi` a missed transition costs a
character; here it can cost a deletion. There is no version of that trade that is worth
`hjkl`.

**The defence against chorded.** §4.1's table. The browser has already taken the chord space, and
two of the collisions cannot be intercepted at all. A scheme built on chords in a browser
document spends its whole design budget on collision avoidance and ends up at `Ctrl+Alt+Shift`,
which is not an interface, it is an apology.

**The concession to the terminal audience, and it is not a token one.** Every navigation key has
a vi alias, and they are real bindings, not an option buried in settings:

| vi alias | Bound to | Context |
|---|---|---|
| `j` / `k` | `↓` / `↑` | any list, any view body |
| `h` / `l` | collapse / expand | trees, ladder groups, config blocks, inventory groups |
| `g g` / `G` | first / last | any list |
| `/` | open the finder scoped to the current view | `16` §19.1 already binds this |
| `n` / `N` | next / previous match of the current in-view filter | any view |
| `{` / `}` | previous / next block | config, findings, walkthrough steps |
| `.` | repeat the last verb | §3.6, and it is bounded — see there |

`w`, `b`, `d`, `y`, `p`, `c` and `:` are **deliberately unbound**. Half-implementing vim is worse
than not implementing it: a user who finds `j`, `k` and `gg` working will try `dd`, and `dd`
doing nothing is a much better outcome than `dd` doing something.

### 2.3 The focus rule — the one thing that makes this work

> **A single-letter or sequence binding fires if and only if the event target is not a text-entry
> context.**

```ts
// The only predicate that gates single-key dispatch. Deliberately conservative:
// when in doubt, the keystroke is text.
function isTextContext(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  if (t.isContentEditable) return true;
  const tag = t.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    // Not every input is text. A checkbox is not, and a proposal's per-op
    // checkbox is a place where 'a' should still mean "accept".
    return !NON_TEXT_INPUT_TYPES.has((t as HTMLInputElement).type);
  }
  // Escape hatch for anything that opts in, e.g. the diagram's inline label editor.
  return t.closest('[data-text-context]') !== null;
}
```

Three properties of the rule:

1. **It is checked on `keydown`, in the capture phase, on `window`.** One listener, no delegation
   walk, registered at boot (`44` §4.2's rule for `Ctrl+K` generalised).
2. **It is conservative in the safe direction.** A binding that fails to fire is an annoyance. A
   binding that fires into a field is a graph mutation the user did not intend.
3. **It is what makes this scheme WCAG 2.1.4-conformant by the third route** — *active only on
   focus* — for most bindings, with an explicit turn-off for the rest (§12.2).

### 2.4 What the scheme costs

| Cost | Statement |
|---|---|
| **Single letters are invisible** | Nothing on screen says `s` suppresses a finding. Mitigations: `?` shows the whole map; every action also has a pointer affordance (the governing rule); the footer names the two or three bindings relevant to the current selection. It is still a real cost and it is the cost every non-modal keyboard product pays |
| **Sequences have a timeout, and timeouts are guesses** | `g` then `f` within 900 ms. Too short and slow typists lose the sequence; too long and a stray `g` swallows the next key. 900 ms with a visible pending indicator in the footer (`g …`) is the compromise, and the indicator is what makes it survivable |
| **The vi aliases are a promise we partly keep** | §2.2. Some users will be annoyed by `dd` doing nothing. That is the correct annoyance |
| **`Alt` on Linux** | Some window managers and terminal emulators grab `Alt`+digit. Nothing can be done from a web page. §4.3 |

---

## 3. The keymap, in full

*margin tab: the whole thing*

Notation: `⌘` is `Cmd` on macOS and `Ctrl` elsewhere, and both are bound in parallel on macOS
because macOS users with external keyboards use `Ctrl` too (`16` §19.1). `⌥` is `Alt`/`Option`.
`g f` is a sequence: `g`, release, `f`.

### 3.1 Global — everywhere, including inside text fields

| Keys | Action | Notes |
|---|---|---|
| `⌘K` | Open the finder overlay | §5. Also `Ctrl+K` on macOS |
| `⌘S` | Save the workspace | First use opens the passphrase sheet (`52` §7.2 screen 4) |
| `⌘Z` | Undo | §7 |
| `⌘⇧Z` / `⌘Y` | Redo | Both; `⌘Y` for Windows habit |
| `⌘C` | Copy | §6. Context-dependent payload |
| `⌘L` | Copy a `fathom:node:<ulid>` reference to the anchor | `52` §10.3 |
| `⌘F` | Filter within the current view | Not the finder. In-view filtering. §5.7 explains the split |
| `⌥1` … `⌥6` | Go to view 1–6 in the fixed order | finder · walkthrough · config · findings · diagram · inventory |
| `⌥←` / `⌥→` | Previous / next view | Does not wrap. Wrapping loses your place, same reasoning as `16` §19.2's list |
| `⌥P` | Pin / unpin the second pane | ≥ 1100 px only (`52` §2.3) |
| `⌥[` / `⌥]` | Split ratio 62/38 / 50/50 | |
| `⌥E` | Toggle the explainer drawer | `52` §4.2 |
| `⌥D` | Config `ChangeSet` mode | See OD-2 in `52` §12 |
| `⌥L` | Diagram layer picker | Opens inline, not a menu |
| `⌥\` | Cycle explainer depth: terse · explained · teaching | Also `V` under the focus rule |
| `Esc` | Dismiss the innermost thing | §3.7 |
| `F6` | Move focus between shell landmarks: masthead → band → body → footer | The standard landmark rotor key; costs nothing and helps a lot |
| `?` | Show the keymap | Under the focus rule. Rendered as a sheet, not a modal |

### 3.2 Under the focus rule — navigation

| Keys | Action |
|---|---|
| `↓` `↑` / `j` `k` | Move within the current list |
| `→` `←` / `l` `h` | Expand / collapse. On a leaf, `→` moves into its expansion |
| `g g` / `G` | First / last |
| `PgDn` `PgUp` | One viewport |
| `{` `}` | Previous / next block (config block, finding group, walkthrough step) |
| `n` `N` | Next / previous match of the in-view filter |
| `Tab` `⇧Tab` | Standard DOM focus order between *components*, not within lists (§8.3, roving tabindex) |
| `Enter` | The primary action for what is focused (§3.5) |
| `Space` | Expand/collapse without acting. On a checkbox, toggle |

### 3.3 Under the focus rule — selection

| Keys | Action |
|---|---|
| `x` | Toggle the focused element in the selection set |
| `⇧↓` `⇧↑` / `⇧j` `⇧k` | Extend the range in the current view's order (`52` §5.4) |
| `⌘A` | Select all in the current view's order — not "the whole graph" |
| `Esc` | Clear to the anchor; second `Esc` clears entirely |
| `⌘click` | Toggle (pointer equivalent of `x`) |
| `⇧click` | Range |

### 3.4 Under the focus rule — verbs

Single letters. Mnemonic where possible, and where the mnemonic collides, frequency wins.

| Key | Action | Where it applies |
|---|---|---|
| `e` | **Explain** — open the explainer inline on the focused thing | everywhere |
| `v` | Cycle explainer depth | everywhere |
| `c` | **Copy** the focused thing (same as `⌘C`, for one-handed use) | everywhere |
| `y` | Copy in the **paste-into-a-ticket** form (`⌥Enter` in the finder; §6.4) | everywhere |
| `w` | Start the **walkthrough** that builds this | finder result, config block, finding |
| `f` | **Fix** — generate a `ChangeSet` from this finding's remediation | findings |
| `s` | **Suppress** this finding — opens the reason field inline, focused | findings |
| `u` | **Unsuppress** | findings, on a suppressed row |
| `p` | Cycle **platform** filter | finder, findings, inventory |
| `r` | **Rosetta** — expand cross-vendor equivalents | finder, config line |
| `a` | **Accept** the focused proposal op | proposal card only |
| `d` | **Decline** the focused proposal op | proposal card only |
| `i` | **Inspect** — open provenance for the focused line or field | config, inventory |
| `z` | Zoom to fit | diagram |
| `.` | Repeat the last verb | §3.6 |

### 3.5 What `Enter` does, by context

`Enter` is the most-pressed key in the product and it must never be ambiguous.

| Focused thing | `Enter` | `⇧Enter` | `⌥Enter` |
|---|---|---|---|
| Finder result | Copy the rendered command, close | Copy un-interpolated (`<vpn-name>`) | Copy the whole answer block |
| Config line | Expand its provenance and explainer | — | Copy the line with its risk label |
| Config block header | Expand/collapse the block | — | Copy the whole block |
| Finding row | Expand | — | Copy the finding as a ticket block |
| Inventory row | Expand child rows | — | Copy the row as TSV |
| Inventory cell | Enter edit | — | — |
| Diagram node | Open the field surface | — | — |
| Walkthrough question | Commit the answer, advance to the next unanswered step | Commit and **stay** | — |
| Proposal op | Toggle its checkbox | — | — |
| A text field, generally | Commit the field, keep focus | Commit and move to the next field | — |

**`Enter` never accepts a whole proposal.** Accepting is `⇧A` (§3.7's shifted verbs) or the
button, and per-op checkboxes must be set first. `21` §15's failure mode 4 — proposal fatigue,
accepting without reading — is a real risk and the friction is the mitigation.

### 3.6 `.` — repeat, and its bounds

`.` repeats the last verb against the current focus. It is bounded to a whitelist:

| Repeatable | Not repeatable |
|---|---|
| `e`, `v`, `c`, `y`, `i`, `r`, `p`, `z` | `s` (suppress — needs a reason each time), `f` (produces a change set), `a`/`d` (proposal review), `w` (starts a run), anything that writes the graph |

A repeat that mutates the graph is a repeat that mutates the *wrong* node the first time somebody
mis-focuses. The whitelist is the control and it is short on purpose.

### 3.7 `Esc`, precisely

`Esc` unwinds exactly one level, in this order:

1. A pending sequence (`g …`) → cancel it
2. An open finder overlay → close (with `16` §19.2's rule: a second `Esc` within 400 ms clears the
   query instead of closing, so a mistyped query is one key from empty)
3. An inline editor with uncommitted text → **revert the field to its committed value and keep
   focus**
4. An expanded explainer → collapse
5. An expanded proposal card → collapse (the proposal is not rejected; `21` §2.5 says the card
   does not disappear when you click elsewhere and `Esc` is clicking elsewhere)
6. A multi-selection → clear to anchor
7. A selection → clear
8. Nothing → nothing. **`Esc` on an empty state does not navigate anywhere**

Step 3 is the one that gets implemented wrong. Reverting *and* blurring means the user loses
their place; reverting and keeping focus lets them retype.

### 3.8 Shifted verbs — the destructive ones

Every action that removes data or commits a security decision requires `Shift` plus its letter,
and none of them is on a single key.

| Keys | Action | Additional gate |
|---|---|---|
| `⇧A` | Accept the checked proposal ops | Requires ≥1 checked op; requires a note if any op's `Basis` is `Judgement` (`21` §2.5.1) |
| `⇧R` | Reject the proposal | Optional "tell me why it was wrong" field |
| `⇧D` | Tombstone the selected node | Undoable (§7.2) |
| `⇧P` | **Purge** a tombstoned node | Type-to-confirm the node's name; requires a reason; **not undoable** (`33` §5.1's `Purge`) |
| `⇧X` | Clear the workspace from memory | Type-to-confirm `discard` |

---

## 4. Conflict analysis

*margin tab: the browser was here first*

### 4.1 Browser reservations

Some browser shortcuts can be intercepted with `preventDefault()`; some cannot, because the
browser never dispatches the event to the page at all.

| Combination | Chrome/Edge | Firefox | Safari | Fathom's position |
|---|---|---|---|---|
| `Ctrl/⌘+T`, `+N`, `+W`, `+Tab`, `+⇧Tab`, `+PgUp/PgDn` | **Not dispatched** — cannot be prevented | mostly reserved | reserved | **Never bound.** Nothing in §3 uses them |
| `Ctrl/⌘+1`…`+9` | Tab switching; reserved in Chrome | tab switching | tab switching | **Never bound.** This is why view switching is `⌥1`–`⌥6` and not `⌘1`–`⌘6` |
| `Ctrl+K` | Omnibox search from the address bar; page can preventDefault when focused | **Focuses the browser search bar**; preventable from a focused page | — | Bound, with `preventDefault` in capture. `16` §19.1's statement stands: if the page does not have focus there is nothing we can or should do |
| `Ctrl/⌘+F` | Find in page; preventable | preventable | preventable | **Bound, and this is a real cost.** §4.2 |
| `Ctrl/⌘+S` | Save page; preventable | preventable | preventable | Bound. Universal expectation; the browser's own action is useless for a `file://` single-page document |
| `Ctrl/⌘+A`, `+C`, `+Z`, `+Y` | Selection/clipboard/undo; preventable, and mostly we do not want to prevent them | same | same | Bound *by refinement*, not replacement — §6.2 and §7 |
| `Ctrl+Shift+I`, `+J`, `+C`, `+K` | DevTools | DevTools/console | Inspector | **Never bound** |
| `Ctrl/⌘+P` | Print; preventable | preventable | preventable | **Not bound.** Printing a config block is a legitimate thing to want and the browser's print is the right tool |
| `F1`–`F12` | mixed (`F5`, `F11`, `F12` reserved-ish) | mixed | mixed | Only `F6` is bound (landmark rotation), which no browser reserves |

<!-- VERIFY: the exact set of non-dispatched combinations per browser and per platform in 2026.
     The list above is the well-known core and it has been stable for years, but it is
     enforcement behaviour, not a spec, and it changes. Test it in the e2e matrix with a page
     that logs every keydown, on Chromium, Firefox and WebKit, on Windows, macOS and Linux, and
     check the result into perf/keymap-conflicts.toml alongside the keymap. -->

### 4.2 `Ctrl+F` — the one contested binding

Taking `Ctrl+F` from the browser is the most aggressive thing in this keymap and it needs a
reason and an escape hatch.

**The reason:** browser find-in-page searches rendered text. In the config view a device emits
~4,000 lines and the view is virtualised, so **the browser's find searches only what is currently
in the DOM** and reports "not found" for text that is unambiguously in the config. That is worse
than useless — it is confidently wrong. The same applies to the inventory table and the findings
list. A virtualised list and browser find are incompatible, and the honest choice is to take the
key and do the search properly.

**The escape hatch:** `⇧⌘F` passes through to the browser, uninterrupted, and the in-view filter's
own header says so: `⇧⌘F for the browser's find`. Users who want the browser's behaviour get one
extra modifier, not a lecture.

### 4.3 Operating system reservations

| Combination | OS behaviour | Position |
|---|---|---|
| `⌘Space` | Spotlight (macOS) | Never bound |
| `⌘Tab`, `⌘Q`, `⌘W`, `⌘H`, `⌘M` | macOS system/window | Never bound |
| **`Ctrl+↑` / `Ctrl+↓`** | **Mission Control / App Exposé on macOS by default** | **A live conflict — §4.4** |
| `Ctrl+←` / `Ctrl+→` | Desktop switching on macOS; workspace switching on many Linux WMs | Never bound |
| `Alt+digit` | Grabbed by some Linux window managers and by tmux/terminal emulators when the browser is not focused | Bound anyway (`⌥1`–`⌥6`), with the pointer affordance in the view band as the fallback. Nothing can be done from a page |
| `Alt+F4`, `Super`, `Win` | System | Never bound |
| `AltGr` | Composes characters on many European layouts, and the browser reports it as `Ctrl+Alt` | **Never bind `Ctrl+Alt`+letter.** §4.5 |

### 4.4 PROPOSED CHANGE to `16` §19.2 — `Ctrl+↑`/`Ctrl+↓` on slot chips

`16` §19.2 binds `Ctrl+↑` / `Ctrl+↓` to cycle slot candidates on a finder chip. **On macOS,
`Ctrl+↑` and `Ctrl+↓` are Mission Control and Application Windows by default**, and while the
browser does dispatch them to the page, the OS acts on them as well: the user gets a full-screen
window-management animation *and* a cycled slot value. That is not a collision the page can win.

**Proposal:** bind slot cycling to `⌥↑` / `⌥↓`, keeping `Ctrl+↑`/`Ctrl+↓` as a non-macOS alias.
`Alt`+arrow is unclaimed by macOS and by the major Linux desktops, and `⌥` is already this
keymap's namespace for "shell and structure" (§3.1).

<!-- VERIFY: whether macOS still ships Mission Control on Ctrl+↑ by default in the current
     release, and whether Chrome/Safari on macOS dispatch the keydown to the page before the OS
     consumes it. Both have been true for many years; confirm rather than assume. -->

### 4.5 Combinations this keymap will never use, as a standing rule

| Never | Reason |
|---|---|
| `Ctrl+Alt`+letter | Indistinguishable from `AltGr`+letter on European layouts. A German user typing `@` (`AltGr+Q`) would fire a command |
| Three-modifier chords | If a binding needs three modifiers it is not a binding, it is a menu item |
| `Ctrl`+punctuation | Layout-dependent. `Ctrl+/` is a different physical key on AZERTY, QWERTZ and Dvorak |
| Bindings that differ between views for the same key | `s` means suppress in findings and nothing anywhere else; it never means "save" somewhere |
| Anything bound to `keypress` | Deprecated, and it does not fire for non-printable keys |

### 4.6 Layout independence

Dispatch uses `KeyboardEvent.code` (physical position) for **navigation** and
`KeyboardEvent.key` (produced character) for **verbs**.

| Group | Property | Why |
|---|---|---|
| `j`/`k`/`h`/`l`, `g g`, `{`/`}` | `code` — `KeyJ`, `KeyK` … | These are positional habits. A Dvorak user who learned `hjkl` learned the *positions* in a terminal, and terminals are positional |
| `e`, `v`, `s`, `f`, `w`, `y`, `p`, `a`, `d` | `key` | These are mnemonics. `s` must mean suppress because it is the first letter of suppress, on every layout |
| Modified chords (`⌘K`, `⌘S`) | `key`, with `code` fallback | `⌘K` on a Dvorak layout is the K the user typed |

This split will look inconsistent in the code and it is the correct inconsistency. It is
documented here so the second implementer does not "fix" it.

---

## 5. `Ctrl+K` in full

*margin tab: the wedge*

`16` §19 owns the finder's internal keymap. This section owns the parts §19 does not: scoping,
preview, acting, chaining, and the lifecycle of the overlay against the rest of the shell.

### 5.1 Opening

| Property | Value |
|---|---|
| Binding | `⌘K` from anywhere, including inside a text field, including inside the finder itself (which selects the query text rather than reopening) |
| Also | `/` under the focus rule; clicking the always-present input in the shell |
| Latency | `44` B4: overlay painted with recents at **50 ms P95**, with zero WASM crossings on the open path |
| What it does to the page underneath | Nothing. The sheet stays visible and legible: no dim, no blur, no fade, no scroll lock beyond preventing background scroll while the overlay has focus |
| What it does to focus | Stores `document.activeElement`, focuses the input, selects any pre-seeded text. §8.2 |
| Pre-seed | If there is a text selection in the page when `⌘K` is pressed, it becomes the query. Selecting `NO_PROPOSAL_CHOSEN` in a log paste and pressing `⌘K` should search for it |

### 5.2 Scoping

A scope narrows the index before ranking. It is a **chip**, rendered before the query text, and it
is entered three ways: by sigil, by typing a scope word and pressing `Tab`, or automatically from
context.

| Sigil | Scope | Index searched |
|---|---|---|
| *(none)* | Everything, ranked by `16` §8's fusion | commands + explainers + rules + tasks |
| `>` | Actions | The verb list of §3.4, plus view switches. This is the command palette, and it exists so that every keyboard action has a *searchable* name, which is the discoverability answer to §2.4 |
| `#` | Graph | Nodes and edges in the open workspace, by name, kind and address |
| `!` | Findings | Open findings, by rule id and title |
| `?` | Explainers | The guidebook only |
| `@` | Supervisor | The AI path (`52` §8.4). Never the default, never auto-selected |

**Context scoping is automatic and visible.** With `IkeGateway GW-B` selected, the overlay opens
with a muted chip reading `in: GW-B` and results interpolate real values (`16` §16). Backspace on
an empty query removes the chip and widens to everything — the standard chip behaviour, and the
only way out that people try.

### 5.3 Preview

The overlay is two columns above 900 px: results left, **preview right**. The preview renders the
highlighted result's full answer block **live as you arrow through**, with no click and no delay:

```
  ┌ results ─────────────────────────┬ preview ────────────────────────────────┐
  │ ▸ READ-ONLY  show security ipsec │  show security ipsec security-associa…  │
  │              security-associat…  │                                          │
  │              Is Phase 2 installe…│  READ-ONLY — SAFE ON PRODUCTION          │
  │   READ-ONLY  show security ike   │                                          │
  │              security-associat…  │  ANSWERS  Is Phase 2 installed and       │
  │   READ-ONLY  show security ipsec │           passing traffic?               │
  │              inactive-tunnels    │  READ     State — want Installed         │
  │                                  │  IF BAD → show security ipsec            │
  │                                  │           inactive-tunnels               │
  │                                  │  ROSETTA  panos  show vpn ipsec-sa       │
  │                                  │           ios    show crypto ipsec sa    │
  └──────────────────────────────────┴──────────────────────────────────────────┘
```

The preview is not a hover state and it is not delayed. Arrowing is instant because the data is
already in the index row; there is nothing to fetch. Below 900 px the preview collapses into the
expanded row (`→` expands, per `16` §19.2).

### 5.4 Acting

`Enter` performs the result kind's default action. This is the table that decides whether the
finder is a search box or a tool.

| Result kind | `Enter` | `⇧Enter` | `⌥Enter` |
|---|---|---|---|
| Command | **Copy** the rendered (interpolated) command, close, footer confirms | Copy un-interpolated | Copy the answer block: command + risk label + what to read + next-if-bad |
| Node (`#`) | Select it and go to the view that best shows its kind | Select without leaving the current view | Copy its `fathom:node:` reference |
| Finding (`!`) | Go to findings, expand it | Select its node without switching | Copy the ticket block |
| Explainer (`?`) | Open the guidebook sheet | Open inline against the current selection | Copy the entry at the current depth |
| Task | Start the walkthrough, prefilled (`52` §6.8) | — | — |
| Action (`>`) | Perform it | — | — |
| Supervisor (`@`) | Send the question. **The overlay closes and the result arrives as a proposal in place** (`52` §8.3) — it never renders an answer inside the finder | — | — |

The last row is a deliberate refusal. If model answers rendered inside the finder, the finder
would become a chat box, and every argument in `52` §8.1 would apply to it.

### 5.5 Chaining

`Tab` on a highlighted result **converts it into a scope and keeps the overlay open**:

```
  ⌘K   → [                                    ]
  VPN-B → [ VPN-B                             ]        3 results
  Tab   → [ in: VPN-B ][                      ]        scoped
  verify→ [ in: VPN-B ][ verify               ]        the ladder for VPN-B
  Enter → copied: 9 commands, 9 READ-ONLY
```

Five keystrokes plus two words from "I need to check that tunnel" to a verification ladder on the
clipboard with real values interpolated. That sequence is the product's best single demonstration
and it should be the one in the README.

`⇧Tab` pops the last chip.

### 5.6 Dismissing

| Gesture | Result |
|---|---|
| `Esc` | Close. Focus returns to the stored element (§8.2) |
| `Esc` twice within 400 ms | First clears the query, second closes (`16` §19.2) |
| Click outside | Close. The overlay is not modal and clicking the sheet behind it both closes the overlay and lands the click |
| Acting on a result | Closes, except for `>` actions that are toggles and for `Tab` chaining |
| Switching view with `⌥n` | Closes, and the view switch happens |

**The overlay never closes by itself.** Not on a timeout, not on a graph change, not when an AI
result arrives, not when a sync merge lands. §8.1.

### 5.7 `⌘K` versus `⌘F`

They are different tools and users will conflate them, so the distinction has to be visible in
both.

| | `⌘K` finder | `⌘F` in-view filter |
|---|---|---|
| Searches | The **corpus** (plus the graph, under `#`) | The **current view's rows** |
| Result | A ranked list in an overlay | The view itself, filtered in place, with non-matching rows removed and a count in the header |
| Persists | No | Yes, until cleared. The view header shows `filtered · 14 of 214 · ⌘F to change · Esc to clear` |
| Ranking | `16` §8's fusion | Substring, then subsequence. No fuzzy ranking — a filter that reorders is a search, and the user asked for a filter |

---

## 6. Copy — the primary output mechanism

*margin tab: this is the output*

### 6.1 Why this section is long

Invariant 2: *the application never touches a network device. All output is copy-paste.* The
clipboard is not a convenience feature here. **It is the product's only output channel**, and
every failure in it is a failure to deliver the product.

The card's own governing sentence for side 1 applies to every copy in this product:
`VERIFY AGAINST YOUR OWN BOX BEFORE ACTING`.

### 6.2 The mechanism, in three layers

| Layer | When | API |
|---|---|---|
| **1 — Interception** | The user pressed `⌘C` with a native text selection | Listen for the `copy` event and **rewrite** `event.clipboardData`. No permission, no user-activation problem, works on `file://`. This is the primary path and it is the one that must never break |
| **2 — Explicit** | The user pressed `c`/`y`, or hit `Enter` on a finder result, or clicked a copy affordance | `navigator.clipboard.write()` with `ClipboardItem`s, called **synchronously inside the gesture handler**, passing promises for the payload |
| **3 — Fallback** | Layer 2 threw (`NotAllowedError`, missing API, insecure context) | A hidden `<textarea>`, `select()`, `document.execCommand('copy')`. Deprecated, still universally implemented |
| **4 — Last resort** | All of the above failed | Render the payload in a focused, pre-selected read-only block with `press ⌘C` in the footer. **Never a silent failure** |

Two facts that shape layer 2:

- `file://` origins are *potentially trustworthy* per the Secure Contexts algorithm, so the async
  clipboard API is in principle available in mode A. <!-- VERIFY: that Chromium, Firefox and
  WebKit all actually expose `navigator.clipboard.write` on a `file://` document in their current
  releases. The spec says potentially-trustworthy; implementations have historically differed,
  and mode A is the deployment this product exists for. Test it in the e2e matrix on a real
  `file://` load, not on a localhost server. -->
- WebKit requires the `write()` call to happen inside a trusted user-gesture handler, but permits
  the `ClipboardItem`'s data to be a **promise** that resolves later. So the correct shape is
  always: construct `ClipboardItem` with a promise synchronously, do the work asynchronously.
  Writing `await buildPayload(); navigator.clipboard.write(...)` fails on Safari, and it is the
  shape everybody writes first.

### 6.3 What a copy gesture copies, by context

| Context | `⌘C` / `c` copies | `y` copies (ticket form) |
|---|---|---|
| **Finder result** | The rendered command, interpolated, one line, no risk label, no trailing newline | Command + `RISK LABEL` + `ANSWERS` + `READ` + `IF BAD →`, as plain text |
| **One config line** | The **unwrapped logical line** — one `set` statement on one line, no gutter number, no risk dot, no display wrapping. §6.3.1 | The line + its risk label + the one-line explainer at the current depth |
| **Selected config lines** (multi) | The lines **in emit order**, not click order, deduplicated, blank line between blocks | The same, preceded by a `# <n> lines · <k> CHANGES CONFIG · <j> DISRUPTIVE` header comment |
| **A config block header** | The whole block, including every continuation | The block plus its section explainer |
| **Partial text selection inside a block** | §6.4 |
| **`ChangeSet` mode, nothing selected** | The whole change set: `commit confirmed 5`, the diff lines, then the ladder as comments | The full change ticket (`18` §6) with its hash |
| **A finding** | `<rule-id> · <severity> · <node name>` on one line | The full ticket block: id, severity, node, `why`, `symptom_if_mismatched`, remediation for this platform, `acceptable_when`, `sources` |
| **Several findings** | One line each | Ticket blocks, separated by a hairline of hyphens, severity-ordered |
| **An inventory row** | The row as TSV of visible columns, with a header row | The row as a `key: value` block |
| **Several inventory rows** | TSV, header row once. This is the paste-into-a-spreadsheet form and it should be exactly that | — |
| **A diagram node** | `<Kind> <name> · fathom:node:<ulid>` | The node's emit closure as config |
| **A diagram selection of several nodes** | One line each | The union of their emit closures, in emit order |
| **An explainer, open** | The body at the current depth, as plain text, with `— <corpus-id> @ <corpus-version>` as the last line | The same plus the `sources` list |
| **A walkthrough step** | The lines this step produced | The run so far as a change set |
| **A verification ladder** | The commands, numbered, one per line, `#` comments for what to read | The ladder plus `STOP AT THE FIRST FAILURE` |
| **A proposal** | **Nothing.** §6.6 |
| **Nothing selected, anywhere** | Falls through to the browser's native copy of whatever text is selected | — |

#### 6.3.1 Continuation backslashes — display versus clipboard

The card prints `set security ike proposal IKE-P1 \` with a continuation because that is how a
command wraps in a terminal, and `design-language.md` device 5 requires the *display* to do the
same. The clipboard is a different question, and `54` §8.3 answers it: **`WrapPolicy::Display`
means the display wraps and the clipboard does not.** This document adopts that position.

| Path | Payload |
|---|---|
| `⌘C` / `c` on a line or block | Unwrapped logical lines. One `set` statement per line, however long. This is what a terminal wants and it is what round-trips through `parse(copy(emit(g)))` |
| `y` (ticket form) and copy-for-print | Wrapped at the emitter's own column with `\` continuations, exactly as the card prints them, because a change ticket is read by a human in a fixed-width field |

The distinction is invisible until somebody pastes a wrapped line into a device that does not
accept continuations, at which point it is the whole story. It is also why §6.3's rule 1 exists:
the clipboard is built from `EmittedLine.text`, and `EmittedLine.text` holds one statement.

**Two rules that hold across every row of that table:**

1. **Never copy a gutter number, a risk dot, a diff marker, a line-wrap that the emitter did not
   produce, or a zero-width character.** Everything in the left column is display. A paste into a
   terminal that includes `12  ▪` is a paste that fails, and it fails in a way the user blames on
   the tool, correctly.
2. **Copy is always plain text (`text/plain`), and optionally *also* `text/html`.** The plain
   text is the artefact. HTML is added only for the ticket forms, where a paste into a rich text
   field (Jira, ServiceNow, an email) benefits from the hairline table — and the HTML is generated
   from the same builder, never separately.

### 6.4 Partial selection inside a config block

The hard case, because a `set` statement can wrap:

```
set security ike proposal IKE-P1 \
  authentication-method pre-shared-keys
```

A user drag-selects from the middle of line 1 to the middle of line 2.

**DECISION — a partial selection copies exactly the selected characters, verbatim, and nothing
is completed, expanded or repaired.**

The alternative — silently completing the statement — is the kind of helpfulness that produces a
command the user did not read. And the failure mode of not completing it is benign: a truncated
`set` line is rejected by the Junos CLI with a syntax error at the point of truncation. A
*completed* line the user did not intend is accepted.

**But it is announced.** The footer confirmation reads:

```
copied · 47 chars · starts mid-statement · ends mid-statement
```

And when a selection covers whole lines plus a fragment, the confirmation counts both:
`copied · 3 whole lines + 1 fragment`.

**The one adjustment made silently, because it is display-only:** leading indentation that the
*view* added for wrapping is removed; indentation the *emitter* produced (the two spaces after a
continuation backslash, which is how the card prints it) is preserved. The rule is that the
clipboard gets what `EmittedLine.text` holds, sliced by the selection, never what the DOM holds.

### 6.5 Feedback — the footer line

**No toast, no popup, no checkmark animation, no "Copied!" bubble.** The footer's right-hand
segment — normally `unsaved · 4 edits` — is replaced for **1.6 seconds** by the copy
confirmation, in muted text:

```
   VIEW 3 OF 6 — CONFIG    ⌥← WALKTHROUGH    FINDINGS ⌥→     copied · 31 lines · 6 CHANGES CONFIG · 2 DISRUPTIVE
```

**The risk composition is the confirmation.** It is the single most useful thing this product can
tell you at the moment you have 31 lines of configuration on your clipboard and are about to
paste them into a box that is carrying traffic. It costs nothing to compute — every
`EmittedLine` carries `risk` already (invariant 6) — and it uses the three reserved colours for
exactly what they mean.

| Copy contains | Confirmation |
|---|---|
| Only `ReadOnly` lines | `copied · 9 lines · all READ-ONLY` |
| Any `ChangesConfig` | `copied · 31 lines · 6 CHANGES CONFIG` |
| Any `Disruptive` | `copied · 31 lines · 6 CHANGES CONFIG · 2 DISRUPTIVE` — and the `DISRUPTIVE` word is in `#8C2F2F`, the only place the palette appears in the footer |
| A failure at layer 4 | `copy blocked by the browser · press ⌘C on the selected block` — and it does **not** clear after 1.6 s |

For screen readers the confirmation is also written to a polite live region (§12.3), so it is
announced and does not interrupt.

### 6.6 What is deliberately not copyable

| Not copyable | Why |
|---|---|
| **A proposal's lines, before acceptance** | `52` §8.3. A proposed line that can be copied into a terminal has completely defeated the proposal mechanism: the model has produced config that reached a device, which is exactly what `21`'s governing rule forbids. Attempting it puts `accept it first — proposed lines are not emitted` in the footer |
| **A redacted value** | There is nothing to copy; the parser discarded it (invariant 3). The placeholder `"<PSK>"` copies as the placeholder, which is the point |
| **The passphrase field** | `autocomplete="off"`, and the copy handler on that field is suppressed. `32` §—'s zeroisation requirements are about memory; this is about the clipboard, which is a system-wide plaintext store that other applications read |
| **A `Disruptive` command in an unscoped form, from an auto-interpolated finder result** | `16` §16.5 already forbids auto-interpolating an unscoped `Disruptive` entry. The card's reason: *"Clearing P1 tears down every child SA under it — on a hub that is every spoke at once. Always scope by peer or index."* The finder renders `clear security ike security-associations <peer-ip>` with the slot unfilled and refuses `Enter` until it is filled |

That last row is the clearest case in the product of the risk enum doing real work: a copy that
is refused because of what the command would do.

### 6.7 Paste, as the inverse

| Where | Behaviour |
|---|---|
| Anywhere, with no field focused, content lexes as config | The ingest screen (`52` §7.2 screen 1) |
| Anywhere, with no field focused, content does not lex | Goes to the finder as a reverse query — *"paste a command, what does it do"* (brief §6.1) |
| In a typed field | Normal paste, then the field's scalar parser runs on blur. Pasting `203.0.113.10/32` into a host-address field keeps the text and raises a shape error; it does not silently strip the prefix |
| In a field, multi-line content | The first line is pasted; the footer says `pasted line 1 of 4 · ⌘V outside a field to ingest` |

---

## 7. Undo and redo

*margin tab: this is harder than it looks*

### 7.1 The three things that make this hard

1. **The graph is typed and referential.** Undoing "delete `IkeGateway GW-B`" has to restore the
   node *and* every edge that referenced it, or the graph is L0-invalid (`11` §9.1), which the
   store refuses.
2. **The log is append-only and sealed.** `17` §5: a record file is an append-only sequence of
   independently sealed frames. **You cannot un-append.** So undo cannot be implemented as
   truncation.
3. **There is an AI layer proposing changes and a CRDT merging remote ones.** Undo has to have a
   defined answer for "what happens when I undo a change that a colleague has since built on".

### 7.2 The unit — transactions, not keystrokes

```rust
/// The undo unit. Groups the ops one user intention produced.
pub struct Transaction {
    pub id: TransactionId,           // ULID
    pub actor: ActorPseudonym,       // 33 §5.1
    pub at: Hlc,
    pub ops: Vec<OpEnvelope>,        // 33 §5.1's Op
    /// What the footer and the ⌘Z affordance say. Never generated from the
    /// op list — authored per source, so it reads like a sentence.
    pub label: BoundedText<60>,      // "dh-group on IKE-P1", "paste 1 842 lines"
    pub source: TxSource,
}

pub enum TxSource {
    /// One field, committed on blur or after the 400 ms settle (44 §4.4).
    Field { field: FieldRef },
    /// One walkthrough step's whole answer, however many nodes it created.
    WalkthroughStep { run: RunId, step: StepId },
    /// One ingest, however many thousand lines.
    Ingest { capture: CaptureId },
    /// One proposal acceptance — the accepted subset, as one unit.
    ProposalAccept { proposal: ProposalId },
    /// One suppression.
    Suppression { id: SuppressionId },
    /// Structural: add/remove a node or edge from the diagram or inventory.
    Structure,
    /// Remote ops applied by a merge. NEVER undoable — §7.5.
    Merge { frames: SmallVec<[FrameId; 4]> },
}
```

**Granularity table.** The single most common complaint about undo in any editor is that the
granularity is wrong, so it is stated as a table rather than left to emerge.

| Action | Transactions | Reasoning |
|---|---|---|
| Typing `203.0.113.10` into a peer field | **1** | The field commits once, on blur or after the 400 ms settle. Eleven keystrokes are not eleven undos |
| Typing, blurring, returning, retyping | **2** | Two commits, two intentions |
| Answering walkthrough step 5 (Phase 1 crypto: 4 fields, 2 nodes, 3 edges) | **1** | One question, one answer, one undo. This is the case that makes per-field granularity wrong |
| Pasting 1,842 lines | **1** | Nobody wants to undo an ingest node by node |
| Accepting 3 of 5 proposal ops | **1** | The accepted subset is the unit, per `21` §2.5.1's `HumanReview` |
| Dragging 6 diagram nodes | **1** | One drag |
| Bulk-editing 11 inventory rows | **1**, and the label says `dpd on 11 gateways` | |
| A merge applying 27,412 remote ops | **0 undoable transactions** | §7.5 |

### 7.3 What is and is not undoable

| Undoable | Not undoable | Why not |
|---|---|---|
| Field commit | Selection change | `52` §5.7. An undo stack full of selections is unusable |
| Walkthrough step answer | View switch, split, scroll, filter, sort | Not graph state |
| Node/edge add, tombstone | **Purge** | `33` §5.1: the only destructive op, human-only, reason-carrying. A purge you can undo is not a purge, and §3.8 gates it behind type-to-confirm precisely because it is final |
| Ingest | Copy to clipboard | The clipboard is not ours to restore |
| Suppression / unsuppression | Unlock, lock, save, sync push | Not graph state; and an "undo save" is a request to write plaintext somewhere |
| Proposal acceptance (§7.6) | Proposal *rejection* | Rejecting changed nothing. The card is still there, in `Rejected` state, and can be re-opened |
| Layout drag | Explainer depth, platform filter | Preferences |
| Bulk edit | Anything a remote actor did | §7.5 |

### 7.4 The mechanism — compensating ops, never truncation

Because the log is append-only (§7.1 point 2), **undo appends the inverse.**

```rust
fn invert(op: &Op, before: &GraphSnapshotRef) -> Result<Op, NotInvertible> {
    match op {
        Op::SetField { field, .. } => Ok(Op::SetField {
            field: *field,
            // Ops are state-carrying (33 §5.1), so the previous whole value is
            // recoverable from the resolved state at `before` without a delta.
            value: before.resolved(*field),
            prov: ProvenanceId::new(Actor::User(uid), Confidence::Asserted,
                                    Reason::Undo(tx)),
            class: /* unchanged */,
        }),
        Op::AddNode { node, .. }  => Ok(Op::Tombstone { element: (*node).into(),
                                                        at: now() }),
        Op::AddEdge { edge, .. }  => Ok(Op::Tombstone { element: (*edge).into(),
                                                        at: now() }),
        Op::Tombstone { element, .. } => Ok(Op::Untombstone { element: *element }),
        Op::SetAdd { set, member, .. } => Ok(Op::SetRemove {
            set: *set, member: member.clone(),
            observed: before.adds_observed(*set, member),   // OR-Set, 33 §6.4
        }),
        Op::SetRemove { set, member, .. } => Ok(Op::SetAdd { set: *set,
                                                             member: member.clone(), .. }),
        Op::Suppress { suppression } => Ok(Op::Unsuppress {
            id: suppression.id, observed: before.suppress_ops(suppression.id) }),
        Op::Unsuppress { .. } => Ok(Op::Suppress { /* from the snapshot */ }),
        // Grow-only, immutable, never conflicting — and never removed.
        Op::ProvRecord { .. } | Op::Capture { .. }
            | Op::AiValue { .. } | Op::Export { .. } => Err(NotInvertible::GrowOnly),
        Op::Purge { .. } => Err(NotInvertible::Destructive),
    }
}
```

`Op::Untombstone` does not currently exist in `33` §5.1. **This is a required addition** and it is
raised in §16.

Two consequences of compensating ops, both of which must be visible in the interface:

| Consequence | Treatment |
|---|---|
| **Undo is an edit.** It appears in the history, in provenance, in the diff, and in what a colleague receives on sync | Correct and desirable. `11` §8 records who asserted what, when, and undo is an assertion |
| **Undo is not time travel.** The inverse is applied to the *current* state, not to a snapshot | §7.5's staleness rule |

### 7.5 Undo across a merge, and the staleness rule

**DECISION — the undo stack is per-session, per-actor, in memory, and never synced.**

You can undo your own transactions from this session. You cannot undo a colleague's, and you
cannot undo your own from last week. The reasons:

| Reason | Detail |
|---|---|
| Distributed undo of a CRDT is a research problem | `33` §4.4 already says the hand-rolled CRDT's cost is not softened; adding selective undo semantics on top of it multiplies the correctness surface for a feature nobody asked for |
| An undo stack that survives a save is an undo stack that survives a lock | Which means holding pre-images of graph values outside the sealed record, which is a plaintext-at-rest problem (`32`) |
| Undoing somebody else's edit is a social action, not an editing action | The right tool is the conflict presentation (`33` §7.2), which shows both values and both actors |

**The staleness rule, which is the whole of the merge interaction:**

> **An undo whose target has changed since the transaction is not applied. It is reported and
> skipped.**

```
on undo(tx):
    stale = []
    apply = []
    for op in tx.ops.rev():
        current = graph.resolved(op.target())
        expected = tx.after_value(op)              # what this tx set it to
        if current != expected:  stale.push(op)    # somebody else moved it
        else:                    apply.push(invert(op, tx.before))
    if apply.is_empty():
        footer("nothing to undo — every value has changed since")
        return
    commit(apply)
    if !stale.is_empty():
        footer("undid {n} of {m} · {k} changed by someone else since")
        ribbon_link_to_conflicts(stale)
```

Partial undo is allowed. **Silent wrong undo is not.** The alternative — force the old value back
over a colleague's newer one — is a last-writer-wins resolution disguised as an undo, and `33`
§6.3 is explicit that recency does not resolve a concurrent write to a security-material field.

**Redo** is the mirror, with one asymmetry that matters: **the redo stack is cleared by a new
local transaction, and is *not* cleared by remote ops arriving.** A colleague's edit landing
should not eat your redo. The staleness rule catches the case where their edit made your redo
wrong.

### 7.6 Undo and accepted AI proposals

Accepting a proposal is one transaction (§7.2). Undoing it:

| What happens | What does not |
|---|---|
| The accepted ops are inverted; field values return | **The provenance records are not removed.** `21` §2.5.1 writes two per accepted op — the supervisor's assertion and the human's acceptance — and both are grow-only (`33` §5.1). Undo adds a third: the reversal |
| The proposal's `ReviewState` becomes `AcceptedThenReverted { by, at }` | It does **not** return to `Pending`. A proposal that silently becomes pending again after an undo can be re-accepted by muscle memory |
| The card reappears, expanded, with a muted line: `accepted 14:02 · reverted 14:04 by you` | The objections and caveats are not re-collapsed |
| The AI audit log (`17` §11) records the reversal | Nothing is deleted from it, ever |

**This is a security property, not a UX detail.** A workspace under review must be able to answer
"did anybody accept a model proposal and then quietly back it out", and the answer has to be in
the record. `21`'s whole reproducibility story rests on the provenance chain surviving; undo must
not be a hole in it.

`52` §8's rendering follows: the reverted proposal's card renders in place, against the node, in
whatever view owns it.

### 7.7 What the user sees

| Element | Content |
|---|---|
| The footer, after `⌘Z` | `undid · dh-group on IKE-P1 · ⌘⇧Z to redo` for 1.6 s |
| The footer, after a partial undo | `undid 4 of 6 · 2 changed by someone else since · see conflicts` — and this one does **not** auto-clear |
| The `?` sheet | Lists the last 10 transactions with labels, so "what did I just do" has an answer |
| Nothing, ever | An undo history panel. `52` §9.5's forbidden list. The stack is 10 items and it is reachable from `?` |

### 7.8 Depth, and the honest limit

**The undo stack holds 100 transactions, or 50 MB of pre-image state, whichever is smaller.** An
ingest transaction's pre-image can be large (a re-parse over an existing graph produces a big
`before` snapshot), so the byte cap binds before the count cap in practice.

When the cap evicts, the oldest transactions are dropped silently and `⌘Z` at the bottom of the
stack says `nothing further to undo in this session`. It does not say "buy more undo" and it does
not degrade into a partial state.

---

## 8. Focus

*margin tab: never stolen*

### 8.1 The rule

> **Focus moves only as the direct result of a user action in the same interaction. Nothing
> asynchronous ever moves focus.**

The enumerated list of things that must never move focus, because each one is a bug somebody will
write:

| Event | Must not move focus |
|---|---|
| A finding appears, clears, or changes severity | ✓ |
| A finding the user is *reading* is cleared by a background re-lint | ✓ — §8.5 handles removal |
| An AI proposal arrives, 4 seconds after the question | ✓. It lands as a count in the view band (`52` §8.6) |
| A sync merge applies 27,412 remote ops | ✓. `33` §7.3: one line, no interruption |
| A tier-C lint sweep completes | ✓ |
| A walkthrough step's inline finding appears | ✓ — the finding renders under the answer; the answer field keeps focus |
| An emit completes and the config re-renders | ✓ |
| A workspace unlocks | ✗ — this one *does* move focus, from the passphrase field to the body, and it is a direct result of the user's submit |
| A timer of any kind | ✓, unconditionally. There are no focus timers |

### 8.2 Save and restore

Every surface that takes focus stores the previous `document.activeElement` **at open time** and
restores it at close. Never inferred, never "the first focusable thing", never `document.body`.

```ts
class FocusScope {
  private prev: HTMLElement | null = null;
  enter(target: HTMLElement) {
    this.prev = document.activeElement as HTMLElement | null;
    target.focus({ preventScroll: true });   // §8.4
  }
  exit() {
    // If the stored element is gone from the DOM, fall back to its nearest
    // surviving ancestor, then to the view body — never to <body>.
    const t = this.prev && this.prev.isConnected ? this.prev : this.fallback();
    t.focus({ preventScroll: true });
    this.prev = null;
  }
}
```

Applies to: the finder overlay, the explainer drawer, an inline editor, a proposal card, the
passphrase sheet, the `?` sheet.

### 8.3 Roving tabindex

Every list — finder results, config lines, findings, inventory rows, walkthrough steps, ladder
steps — is **one tab stop**. Inside it, arrow keys move a roving `tabindex="0"`, and everything
else is `tabindex="-1"`.

The reason is arithmetic: the config view for one device holds ~4,000 lines. Without a roving
tabindex, `Tab` from the view band to the footer is 4,000 presses. With it, it is one.

The finder is the exception and it follows `16` §19.3: focus stays in the **input** at all times
and `aria-activedescendant` moves. That is the ARIA combobox pattern and deviating from it breaks
screen-reader announcement of results.

### 8.4 Focus and scrolling

`focus({ preventScroll: true })` everywhere, followed by an explicit scroll decision under
`52` §5.6.4's four conditions. The browser's default focus scroll is centred, immediate and
ignores whether the element was already visible — which produces exactly the jumping that makes
linked views feel hostile.

### 8.5 When the focused thing disappears

A real bug class, and the reason is that findings clear asynchronously.

| Situation | Behaviour |
|---|---|
| The focused finding clears because the graph was fixed | Focus moves to the **next sibling in the list**, or the previous if there is none, or the list container if the list is now empty. **Never** to `document.body` — losing focus to body drops a keyboard user back to the top of the document |
| The focused config line disappears because of a re-emit | Focus moves to the line with the nearest `order_hint`. `13`'s E4 (order stable under unrelated edits) makes this stable |
| The focused row is filtered out | Focus moves to the first visible row, and the footer says `focused row is filtered out` |
| The focused element is tombstoned | It is still rendered (muted, `11` §10.5), so focus stays |
| The focused element is purged | Same as the finding case |

### 8.6 The focus ring

| Property | Value |
|---|---|
| Style | 2px solid ink (`#14171A` light / `#E4E8EC` dark), offset 2px, **square corners** |
| Where | `:focus-visible` on everything interactive, including list rows, config lines and diagram nodes |
| Never | `outline: none` without a replacement in the same rule. A CI lint over the stylesheet fails the build on a bare `outline: none` |
| In the diagram | A 2px ink stroke around the shape's bounding box, drawn as a `<rect>` in the same closed tag set (`44` §4.7) |
| Contrast | Against `#F2F4F6` surface and `#FFFFFF` page, ink at 2px clears WCAG 1.4.11 non-text contrast comfortably |

### 8.7 Autofocus

Used exactly twice, and both times because the element is the only thing on the sheet:

1. The passphrase field on the unlock sheet.
2. The finder input on first run (`52` §7.2 screen 0).

Not used for: an inline editor opened by a click (the click already put focus there), the
walkthrough's first question (the user should be able to read it before typing), a proposal card,
or any field after a view switch.

---

## 9. Errors and validation — timing, not styling

*margin tab: never a modal*

### 9.1 The prohibition

| Forbidden | Why |
|---|---|
| `alert()`, `confirm()`, `prompt()` | Synchronous, unstyleable, and they block the event loop, which means they block a re-lint in flight |
| A modal dialogue of our own | A modal is a claim that nothing else on the screen matters. Nothing in this product is ever that important — not a validation error, not a merge conflict (`33` §7.2), not a proposal (`21` §2.5) |
| A blocking overlay while something computes | Every long operation is chunked and cancellable (`12` §7.1, `44` §4.8.3 move 3) |
| A toast | `52` §9.5 |
| The browser's `beforeunload` | **Permitted exactly once**: an unsaved in-memory workspace (`52` §7.2 screen 2). It is the only correct tool for that and it is not ours to style |

### 9.2 The three timings

| Timing | What fires | Budget | Rendering |
|---|---|---|---|
| **Per keystroke** | Shape feedback: is this an IPv4 address, does this interface name parse for this platform, is this within the enum | `44` B6: **8 ms P95**, from TypeScript, no WASM crossing | A muted margin tab under the field: `not an address yet`. **Never red, never an icon, never a border colour** |
| **On field commit** (blur, or 400 ms settle) | Findings on the edited node | `44` B7: **16.7 ms P95** | The findings surface: inline in the walkthrough, in the panel elsewhere. `12` §7.2: no flash, no reorder animation, no "new" badge |
| **On emit** | L2 blockers (`11` §9.1) | per emit | A list above the config block. Never a partial config with a hole in it |

**The 400 ms silence is the design, not a compromise** (`44` §4.4). Typing `203.0.113.10`
produces eleven intermediate strings of which ten are not addresses. A findings panel that fires
on each of them is a strobe light people stop reading.

And the corollary that makes it survivable: **the field is never silent.** Shape feedback fills
the gap at 8 ms.

### 9.3 What a validation failure never does

| Never | Instead |
|---|---|
| Reverts the user's text | The bad text stays. It is what they typed and they may be mid-way through it |
| Moves focus | §8.1 |
| Prevents leaving the field | You can always blur. The field stays in an uncommitted state and the row carries the margin tab `not committed · <reason>` |
| Prevents leaving the view | You can always switch. The uncommitted field is listed in the view band's count |
| Blocks save | A workspace with invalid fields saves. `11` §9.1: L1–L3 are measurements, not errors. Only L0 (well-formedness) is enforced, and the store refuses an L0-breaking write at the API level, before a UI ever sees it |
| Colours the field red | Red means `Disruptive`. A malformed address is not disruptive; it is not even config yet. `51` §4.8's 2px ink underline is the treatment |

**Reconciliation with `51` §4.8 point 3.** That document requires that a *form submit* be blocked
and that focus move to the first invalid field. There is no conflict with §8.1: a submit is a
direct user action in the same interaction, which is precisely the case where focus is allowed to
move. What is prohibited here is different and narrower — an invalid field may not block a
**save**, a **view switch**, a **blur** or a **workspace close**, because none of those is a
submit and none of them is worth trapping a user for. A walkthrough step's `Enter` is a submit
and follows `51`.

### 9.4 Destructive confirmations, without a dialogue

Type-to-confirm, inline, in the row:

```
  ▌ PURGE  Device SRX-B
    This removes the node, its 830 children and their history from the
    workspace. It cannot be undone and it will replicate to everyone
    on this workspace.
    type the device name to confirm   [ SRX-B                    ]
    reason (recorded)                 [                          ]
                                                      [ purge ]  Esc to cancel
```

Type-to-confirm is used for `⇧P` purge, `⇧X` clear-workspace, and removing a member from a
workspace (`33` §2.8). Nothing else. Over-using it trains people to type names without reading.

### 9.5 Where errors that are not the user's fault go

| Error | Surface |
|---|---|
| Parser cannot bind 17 lines | The ingest screen's `NOT RECOGNISED` column (`52` §7.2 screen 1), verbatim, with counts |
| A rule pack fails signature verification | The workspace opens **without that pack**, and a persistent line in the masthead says which pack and why. Not a dialogue; not silently ignored either |
| WASM instantiation fails | The one case where the product cannot render its own error in its own idiom. A static HTML block in the shell, present in the document before any script runs, saying what failed and what to try |
| Clipboard blocked | §6.5's non-clearing footer line |
| Sync unreachable | `33` §8.2: keep working offline, one line in the footer, no interruption, no retry spinner |
| A subagent times out | The proposal count does not increment. A muted line where the count would be: `supervisor timed out · 30 s`. `21` §10 owns the budgets |

---

## 10. Latency — what is synchronous with a keystroke

*margin tab: one frame or not at all*

### 10.1 The classification

Everything the interface does falls into one of four bands. The bands come from `44` §4.1's
citation of the classic response-time thresholds — 0.1 s for "instantaneous", 1 s for "flow of
thought preserved", 10 s for "attention gone".

| Band | Budget | Rule |
|---|---|---|
| **Frame** | ≤ 16.7 ms | Must complete before the next paint. Anything here is on the keystroke path |
| **Instant** | ≤ 100 ms | Feels like a direct response. May cross the WASM boundary, may not do I/O |
| **Deliberate** | ≤ 1 s | The user asked for something and expects a beat. Must be cancellable if it can exceed 300 ms |
| **Background** | unbounded | Must never block input, must never move focus, must report its own progress as a count, never as a bar |

### 10.2 The assignment

| Interaction | Band | Budget | Source |
|---|---|---|---|
| Keystroke → finder results re-ranked and painted | Frame | 16.7 ms P95 | `44` B5 |
| Keystroke → field shape feedback | Frame | 8 ms P95 | `44` B6 |
| Selection change → all visible views repainted | Frame | 8 ms P95 (`52` S1) | `52` §5.6.3 |
| Arrow key → finder preview updated | Frame | within B5 | §5.3 |
| Expand/collapse an explainer, index hit | Frame | 12 ms P95 (`52` S4) | |
| `⌘K` → overlay painted with recents | Instant | 50 ms P95 | `44` B4 |
| View switch | Instant | 20 ms P95 (`52` S3) | |
| Field commit → findings on the edited node | Instant | 16.7 ms after a **400 ms deliberate silence** | `44` B7, §9.2 |
| Copy → clipboard written + footer confirmation | Instant | 50 ms | §6 |
| Re-emit after one field change | Instant | 4 ms P95 | `44` B11 |
| Explainer body, lazy zstd frame | Instant | 60 ms P95 (`52` S5) | |
| Paste 5,000 lines → populated graph | Deliberate | 90 ms P95 | `44` B9 |
| Emit a full device | Deliberate | 30 ms P95 | `44` B10 |
| Diagram first render, 500 nodes | Deliberate | 160 ms P95 | `44` B12 |
| Field commit → all propagated findings settled | Deliberate | 200 ms P95 | `44` B8 |
| Workspace unlock | Deliberate, **plus the KDF** | KDF + 150 ms P95 | `44` B14 |
| Full lint sweep on pack toggle | Background | chunked, cancellable | `12` §7.1, `44` §4.8.3 |
| Sync push / pull | Background | no budget — somebody else's network | `33` |
| Any AI call | Background | never on any interaction path | `21` §10 |

### 10.3 The rules that follow

| Rule | Consequence |
|---|---|
| **Nothing in the Frame band crosses the WASM boundary more than once** | Selection propagation uses cached view indices (`52` §5.6.1). Shape feedback is TypeScript-only |
| **Nothing in the Frame or Instant band decompresses, decrypts or parses** | Explainer bodies are the boundary case and they are given their own band (S5) |
| **Anything in the Deliberate band that can exceed 300 ms is cancellable and says what it is doing, as a count** | `checking · 340 of 4,100` in a margin tab, never a bar, never a spinner, never a percentage |
| **Nothing in the Background band may take focus, move the scroll, reorder a list the user is reading, or open anything** | §8.1 |
| **No animation is on any interaction path** | `44` §4.2: *"a 150 ms fade is 150 ms of latency, and it is latency somebody chose."* The only motion in the product is scrolling, and it is instant beyond two viewport heights and disabled entirely under `prefers-reduced-motion` |

### 10.4 The one deliberate delay

The 400 ms debounce before findings (`44` §4.4, §9.2). It is the only intentional wait in the
product and it is documented in three places because somebody will "optimise" it to zero and
produce the strobe.

---

## 11. Touch and small screens

*margin tab: standing in front of a rack*

### 11.1 The honest position

**Fathom on a phone is a reader and a lookup tool. It is not an editor.**

That is not a hedge and it is not a phase-1 limitation. Editing a typed graph means typing values
into typed fields while reading findings, and a 390 px viewport with half of it covered by a
keyboard cannot hold a field, its shape feedback, its explainer and a finding at once. Shipping a
cramped editor produces exactly one outcome: somebody sets a DPD threshold wrong on a train.

**But there is a real, important, frequent use case and it is the wedge itself:** you are standing
in front of a rack, or on a call, or in a change window, and you need to know what to type. Brief
§6.1's *"the feature people open ten times a day"* is not a desk feature. It is a phone feature as
often as not.

So the mobile product is: **the finder, the guidebook, and read-only views of your own workspace.**
That is a complete product for the situation the user is actually in.

### 11.2 What ships on a phone

| Surface | Phone | Reason |
|---|---|---|
| **Finder** | **Full function**, including scoping, preview, Rosetta, copy, chaining | This is the reason the phone build exists |
| **Explainer** | Full, all three depths | Reading is what a phone is for |
| **Config, read** | Full: blocks, lines, provenance expansion, risk labels, copy | You are reading a config you are about to type |
| **Config, `ChangeSet`** | Full, read + copy | The change-window use case |
| **Findings, read** | Full: expand, read `acceptable_when`, copy the ticket block | |
| **Findings, suppress** | **No** | A suppression carries a reason and is a reviewable waiver. It is a desk decision |
| **Inventory, read** | Yes, as a single-column list, not a table. Two columns of a 12-column table on a phone is a table nobody can read | |
| **Inventory, edit** | **No** | |
| **Diagram** | Read-only. Pinch-zoom, pan, tap to select, LOD floor raised so labels stay legible | A read-only diagram on a phone is useful; a draggable one produces accidental layout changes that sync |
| **Walkthrough** | **Read-only review of an existing run.** Cannot start one, cannot answer a step | Fifteen typed answers on a phone is the thing §11.1 refuses |
| **AI proposals** | **Review yes, accept no** | `21` §15's proposal-fatigue failure mode is worst on a device where the whole card does not fit on screen. A fat-fingered accept is exactly the failure the proposal mechanism exists to prevent |
| **Unlock a workspace** | Yes, with the caveat in §11.6 | |
| **Paste and ingest** | Yes — pasting a config from a terminal app on the same phone is a real flow | |
| **Save / sync** | Yes | |

### 11.3 Layout

| Property | Value |
|---|---|
| Breakpoint | `< 700 px` is the phone layout; `700–1099 px` is the one-column desktop layout (`52` §2.4) |
| Sheet | One column. The masthead keeps the 3px rule, the title, and the imperative; the subtitle collapses to the device name only |
| **The legend** | **Stays.** All three risk labels, on two lines if necessary. It is on every side of the card, unchanged, and it is the thing you most need when reading a command on a phone in a data centre |
| The view band | Horizontally scrollable, momentum off, with the current view first. Not a `<select>` |
| The footer | `VIEW n OF 6` only; the neighbour keys are dropped since there is no keyboard |
| Units | `dvh` for full-height surfaces (`svh`/`lvh` where the distinction matters), so the URL bar collapsing does not resize the world |
| The on-screen keyboard | `visualViewport.addEventListener('resize', …)` to keep the focused field and its shape feedback above the keyboard. Never `scrollIntoView` on focus — that fights the browser's own handling |
| Type | The body size does **not** shrink below the desktop size. The card is dense on paper because paper has high resolution; a phone does not. Density is achieved by showing less, not by shrinking type |

### 11.4 Targets and gestures

| Property | Value |
|---|---|
| Minimum target | **44 × 44 CSS px** on touch. WCAG 2.2 SC 2.5.8 requires 24 × 24 at Level AA and SC 2.5.5 requires 44 × 44 at AAA; **we take the AAA number** because the environment is a rack aisle, one-handed, possibly with gloves |
| Spacing | 8 px minimum between targets, which also satisfies 2.5.8's spacing exception on desktop |
| Tap | Select |
| **Long-press (400 ms)** | **Open the explainer.** This is the mobile equivalent of clicking a config line, and it is the single most important touch gesture in the product |
| Pinch | Zoom, diagram only |
| Two-finger pan | Pan, diagram only. One-finger pan scrolls the page, because fighting the page scroll on a phone is always the wrong choice |
| Swipe left/right on the sheet | **Not bound.** It collides with browser back/forward gestures on both iOS and Android, and losing your place because you swiped is unrecoverable |
| Pull-to-refresh | Disabled (`overscroll-behavior-y: contain`). There is nothing to refresh; the graph is local |
| Hover | **Nothing is hover-only.** Every hover affordance on desktop has a tap or long-press equivalent |

### 11.5 Copy on a phone

The one interaction that must not fail, because it is the whole point.

| Property | Value |
|---|---|
| Every command, every config line and every block has a visible copy target | 44 px, right-aligned, labelled `copy` in text, not an icon |
| Mechanism | §6.2 layer 2, with the `ClipboardItem`-holding-a-promise shape that WebKit requires |
| Confirmation | The footer line, as on desktop, and it holds for 2.5 s rather than 1.6 s because a phone user is not looking at the same place |
| Selection copy | The native selection handles work; the `copy` event interception (layer 1) rewrites the payload identically to desktop |
| Failure | The last-resort path (layer 4) is more likely here, and it must render a selectable block, not an error |

### 11.6 The unlock problem on a phone

`44` §4.8 and `32` §4.2: the KDF is calibrated on the creating device. **A workspace created on a
2026 workstation, opened on a phone, can take many seconds.** `44` §4.8.4's proposed
`DeviceFloor::AnyDevice` default exists for exactly this case, and this document supports it: the
phone build is the strongest argument for calibrating to the floor device, because the phone is
where the mis-calibration is felt and where the tab is most likely to be killed for memory
while the Argon2 arena is live.

If the workspace was created with `DeviceFloor::WorkstationOnly`, the unlock sheet says so before
the user commits: `this workspace was tuned for a workstation · unlocking here may take 8–20
seconds`. Estimated from the stored `m`, `t`, `p` and a quick local benchmark — and marked as an
estimate, because it is one.

### 11.7 What is honestly lost

| Lost | Statement |
|---|---|
| Building anything | You cannot construct a tunnel on a phone. That is correct |
| The split | One column, always |
| The keyboard model | Every binding in §3 is unreachable. This is why the governing rule of this document requires a pointer affordance for everything: the phone build is the proof that the rule was followed |
| Density | The card's density does not survive 390 px. What survives is the *structure* — masthead, imperative, legend, hairlines, margin tabs — and that turns out to be most of the value |
| Diagram usefulness | A 500-node diagram on a phone is a texture (`44` §4.7.4's own words). The LOD floor is raised so that it degrades to device rectangles with labels, and below that it says `too many nodes for this screen · 214 devices · use the list` |

---

## 12. Accessibility obligations, stated as requirements

*margin tab: not optional*

### 12.1 Keyboard operability

Every action is reachable without a pointer (the governing rule). This is WCAG 2.1.1 Keyboard, and
it is satisfied by construction because the keymap came first. The inverse — every action
reachable without the keymap — is the harder half and is satisfied by the pointer affordances
enumerated per action in §3 and `52`.

### 12.2 Character key shortcuts — WCAG 2.1.4

The single-letter verbs of §3.4 are character key shortcuts and SC 2.1.4 (Level A) requires one
of: a mechanism to turn them off, a mechanism to remap them, or that they are active only on
focus.

**Fathom satisfies two of the three:**

1. **Active only on focus** — for every binding gated by the focus rule (§2.3), which is all of
   §3.2, §3.3 and §3.4. A character key never fires while a text-entry element has focus.
2. **Turn off** — a setting, `single-key shortcuts: on / off`, in the workspace settings and in
   the `?` sheet. With it off, `⌥`+letter is the alias for every single-letter verb.

Remapping is **not** offered in v1 (OD-3).

### 12.3 Announcement

| Thing | Mechanism |
|---|---|
| Finder results | The ARIA combobox pattern from `16` §19.3, unchanged |
| The risk label | **Text, always, not colour alone.** `READ-ONLY — SAFE ON PRODUCTION` is announced, which is also why the card prints the words next to the bars |
| Finding severity | Text (`high`, `medium`, `low`), never weight alone |
| The copy confirmation | `aria-live="polite"` region in the footer. Polite, so it never interrupts a line being read |
| Findings appearing | `aria-live="polite"` on the findings count only, not on the list. Announcing eleven findings as they stream is announcing nothing |
| A merge landing | Polite, once, with the count (`33` §7.3's one line) |
| Nothing, ever | `aria-live="assertive"`. There is no event in this product that justifies interrupting somebody |

### 12.4 Colour

The three risk colours are the only colour in the product and each is always accompanied by its
text label. Finding severity, selection, conflict, diff and proposal state are all rendered in
neutrals with weight and rule treatments (`52` §3.5.1, §5.2; `33` §7.2). **A user who cannot
distinguish the three risk colours loses nothing**, because the words are always present — which
is a property of the card, not a concession we made.

### 12.5 Motion

`prefers-reduced-motion: reduce` disables the only motion in the product (smooth scrolling,
§10.3). There is nothing else to disable, which is the benefit of a design language with no
animation in it.

### 12.6 Zoom and reflow

The sheet reflows to 320 px at 400 % zoom without horizontal scrolling (WCAG 1.4.10), with one
stated exception: **config blocks and the diagram scroll horizontally**, and they are covered by
1.4.10's exception for content requiring two-dimensional layout. A `set` line is not reflowable —
wrapping it changes what it means to a reader, and the card's continuation backslashes exist
precisely because commands wrap the way a terminal wraps them.

---

## 13. Failure modes

| # | Failure | Symptom | Control | Residual |
|---|---|---|---|---|
| 1 | **A single-letter binding fires into a field** | A user typing a suppression reason types `s` and suppresses something else | §2.3's conservative `isTextContext`, plus an e2e test that types the full Latin alphabet into every field kind and asserts zero transactions | Low, and it is the highest-severity failure in this document |
| 2 | **Copy emits display characters** | A paste into a terminal fails on `12 ▪` | Copy builds from `EmittedLine.text`, never from the DOM. Property test: for every fixture config, `parse(copy(emit(g))) ≡ emit(g)` | Low, with the test |
| 3 | **Copy silently fails on `file://`** | The product's only output channel is dead in its flagship deployment | Four-layer fallback (§6.2), the non-clearing footer line, and an e2e case that runs on a real `file://` load | Moderate until the VERIFY in §6.2 is answered |
| 4 | **Undo applies over a colleague's newer value** | Two engineers overwrite each other and blame the tool | §7.5's staleness rule refuses rather than forcing | Low |
| 5 | **Undo granularity is per-keystroke** | `⌘Z` eleven times to remove one address | Field commit is the unit (§7.2), which follows from the 400 ms settle already in `44` §4.4 | Low |
| 6 | **Focus stolen by an async finding** | The user is typing and the caret jumps | §8.1's enumerated list, and a test harness that asserts `document.activeElement` is unchanged across every async completion | Moderate — this is written by accident |
| 7 | **Focus lost to `<body>` when the focused row disappears** | Keyboard user is dumped at the top of a 4,000-line document | §8.5's fallback chain | Moderate |
| 8 | **The sequence timeout eats a keystroke** | `g` then a pause then `k` moves up instead of going to the top | 900 ms window, visible `g …` pending indicator in the footer | Low |
| 9 | **`⌘F` taken and the in-view filter is worse than the browser's** | Users lose find-in-page and gain nothing | §4.2's escape hatch (`⇧⌘F` passes through), and the filter must match substring case-insensitively on first release, not something clever | Low |
| 10 | **`⌥` bindings dead on a Linux WM that grabs them** | View switching does not work and there is no error | Nothing can be done from a page. The view band is the pointer affordance and the `>` finder scope is the keyboard fallback (`>config` `Enter`) | Real, unmitigable |
| 11 | **A proposal is accepted by a stray keypress** | A model-proposed value reaches the graph unreviewed | Accept is `⇧A`, requires checked ops, requires a note for `Judgement` ops, and is unavailable on touch (§11.2) | Low |
| 12 | **A phone user tries to build a tunnel** | Frustration, or worse, a half-built tunnel | The walkthrough is read-only below 700 px and says so in one line | Low |

---

## 14. Open decisions

| # | Decision | Options | Leaning |
|---|---|---|---|
| **OD-1** | **Whether `.` (repeat) is in v1 at all.** It is a vi affordance with a small whitelist (§3.6) and a real mis-fire risk | (a) v1 (b) defer | Leaning (b). The whitelist makes it safe and it also makes it nearly useless; ship it when there is a verb worth repeating |
| **OD-2** | **Whether the undo stack should survive a save.** §7.5 says no, for reasons that are about plaintext at rest. A weaker version — survive a save but not a lock — is arguable | (a) session-only (b) until lock | Leaning (a). "Until lock" means holding pre-images in memory across an autosave, which is where a pre-image outlives the value it shadows |
| **OD-3** | **Remapping.** WCAG 2.1.4 is satisfied without it (§12.2), and every remapping system is a config file, a conflict checker and a migration | (a) v1 (b) later (c) never | Leaning (b). The `>` finder scope is the discoverable path in the meantime |
| **OD-4** | **Whether `j`/`k` should be `code`-based or `key`-based** (§4.6). Positional serves the terminal habit; character serves the mnemonic | (a) `code` (b) `key` (c) both, with `code` winning | Leaning (c). A Dvorak user gets `hjkl` where their fingers expect it and also where the letters are — the two only collide for layouts that move `j` onto another navigation key, and none of the common ones do |
| **OD-5** | **Whether the phone build is a separate artifact.** A read-only subset could ship without the emitters' write paths, the walkthrough driver and the CRDT merge, which is a meaningful size saving against `44` B17 | (a) one artifact, feature-gated by viewport (b) two artifacts | Leaning (a) for v1 — two artifacts means two release trains and a "why can't I edit on my tablet" question with no good answer. Revisit if B17 binds |

---

## 15. Sources consulted

| Source | Used for |
|---|---|
| `.context/owner-brief.md` §6.1, §6.2, §6.6, §6.7 | The `Ctrl+K` bar, the walkthrough's inline findings, suppressions with reasons, the verification ladder |
| `.context/design-language.md` | No animation, no icons, no progress bars, no toasts; the margin tab as the annotation primitive; the risk legend as text plus colour |
| `.context/field-card-srx-ipsec.txt` | §6.3's continuation backslashes; §6.6's `clear security ike` scoping rule; §11.3's legend-always argument |
| `.context/conventions.md` | Invariants 2, 3, 6, 7, 9; the three-value risk enum and its non-reuse |
| `10-core/16-command-finder.md` §16, §19 | The finder keymap this document extends; the `Esc`-twice rule; the ARIA combobox pattern; §4.4's proposed correction |
| `10-core/11-ir-schema.md` §9.1, §10.5 | L0–L3 and why a malformed field does not block a save; tombstones |
| `10-core/13-emitters-and-provenance.md` | `EmittedLine.text` as the copy source; E4's stable ordering under §8.5 |
| `20-ai/21-ai-layer-architecture.md` §2.5, §10, §15 | The accept contract, `HumanReview`, proposal fatigue, AI latency being off the interaction path |
| `30-security/33-sync-protocol.md` §5.1, §6.3, §6.4, §7 | The `Op` enum §7.4 inverts; OR-Set removal semantics; why recency does not resolve a security-material conflict; no modal for conflicts |
| `40-stack/44-performance-budgets.md` §3, §4.2, §4.4, §4.7, §4.8 | Every budget in §10; the 400 ms debounce; the no-animation argument; the KDF-on-a-phone problem |
| W3C, *Secure Contexts*, §3.1 | `file://` origins are Potentially Trustworthy — the basis for expecting the async clipboard API in mode A |
| MDN, *User activation* | Which events are activation-triggering, and that `keydown` counts with exclusions — the basis for §6.2 layer 2 |
| WebKit, *Async Clipboard API* | The `ClipboardItem`-holding-a-promise shape required by Safari |
| W3C WCAG 2.1, SC 2.1.1, SC 2.1.4 | Keyboard operability; character key shortcuts and the three ways to satisfy it |
| W3C WCAG 2.2, SC 2.5.5, SC 2.5.8 | Target size — 24 × 24 at AA, 44 × 44 at AAA; §11.4 takes the AAA number |
| W3C WCAG 2.1, SC 1.4.10, SC 1.4.11 | Reflow and its two-dimensional exception; non-text contrast for the focus ring |

---

## 16. Disagreements

No disagreement with the conventions.

Two **proposed changes** to sibling documents, both raised because this document cannot be
implemented without them:

**1. `16` §19.2 — rebind slot cycling off `Ctrl+↑`/`Ctrl+↓`.** On macOS those are Mission Control
and Application Windows by default, and the OS acts on them regardless of what the page does.
Proposed replacement: `⌥↑`/`⌥↓`, with `Ctrl+↑`/`Ctrl+↓` retained as a non-macOS alias. §4.4.

**2. `54` §14 — the double-`Esc` in the finder.** `54`'s finder specification says `Esc` closes
and *"never clears the query first — a two-press Escape is a small betrayal."* `16` §19.2 says
the opposite: a second `Esc` within 400 ms clears the query rather than closing, *"so a mistyped
query is one key away from empty without losing the panel."* §3.7 and §5.6 of this document
follow `16`, because `16` owns the finder and was written first. The disagreement is real and
should be settled once rather than diverging: **my position is that `16` is right**, because the
gesture is ordered the safe way round — the first press always closes if the query is empty, and
only clears when there is something to clear, so a user who wants "close" gets it on the first
press in the state they are usually in. `54`'s objection stands only for the case where the user
has typed and wants to leave, which is one press of `Esc` followed by one more, and both presses
do a useful thing. **This needs an owner's ruling, not a compromise.**

**3. `33` §5.1 — add `Op::Untombstone { element: ElementId }`.** §7.4 needs an inverse for
`Op::Tombstone` and there is none in the op model. Without it, undoing a deletion is not
expressible as a compensating op, and undo would have to become log truncation — which `17` §5's
append-only sealed frames make impossible. The op is trivially convergent (it is a
last-writer-wins boolean over an element's `absent_since`, field class B under `33` §6.4) and it
does not weaken the "absence is not deletion" position in `11` §10.5, because it can only apply
to an element that still exists.
