# 52 — Information architecture

> **Status:** Proposed

Companion documents: `.context/design-language.md` (the grammar every layout in here is written
in — it is ground truth, not interpretation), `51-design-tokens.md` (the visual system: tokens, type scale,
rule weights — this document assumes it and does not restate it), `54-component-catalog.md`
(the components each view is assembled from), `53-interaction-and-keyboard.md`
(the keyboard model that drives everything specified here), `10-core/16-command-finder.md` §19
(the finder's own keymap and shell, which this document extends but does not override),
`20-ai/21-ai-layer-architecture.md` §2.5 (the proposal card, whose placement this document
decides), `40-stack/44-performance-budgets.md` (every millisecond quoted below).

Owner brief §1 states the whole product in four words:

> **One graph, six views.**

This document is the shell that holds six views over one structure without becoming six
applications. That is the entire problem. Six views over one graph is a good architecture and a
hard interface: every view wants to own the screen, every view has its own idea of what "the
current thing" is, and the moment two of them disagree the user is holding two products.

**The governing rule of this document, stated once, in caps, at the top:**

> **THE VIEWS ARE RENDERINGS OF ONE SELECTION OVER ONE GRAPH. A VIEW THAT HOLDS STATE THE OTHERS
> CANNOT SEE HAS BECOME A SECOND APPLICATION.**

---

## 0. Contents

| § | |
|---|---|
| 1 | The list of six is not the list of six |
| 2 | The shape of the shell |
| 3 | The six views, specified |
| 4 | The explainer surface |
| 5 | Selection — the through-line |
| 6 | The walkthrough, in detail |
| 7 | First run — paste first |
| 8 | Where the AI layer lives |
| 9 | Information scent |
| 10 | State, routing and deep links |
| 11 | Failure modes of this architecture |
| 12 | Open decisions |
| 13 | Sources consulted |
| 14 | Disagreements |

---

## 1. The list of six is not the list of six

*margin tab: read this first*

### 1.1 Two different sixes, and the difference matters

Brief §1 gives six **projections**:

```
diagram   = render(graph)
config    = emit(graph, vendor)
findings  = lint(graph)
lesson    = explain(node, depth)
runbook   = verify(diff(graph))
inventory = table(graph)
```

The shell holds six **views**: finder, walkthrough, config, findings, diagram, inventory.

These are not the same list and pretending they are produces a muddled interface. Two
projections are not views, and two views are not projections.

| Projection | Is it a view? | Where it lives |
|---|---|---|
| `render(graph)` | yes | **diagram** |
| `emit(graph, vendor)` | yes | **config**, mode `Full` |
| `lint(graph)` | yes | **findings** |
| `table(graph)` | yes | **inventory** |
| `explain(node, depth)` | **no** | the **explainer surface** — §4. It is a layer that opens inside all six views and owns no screen of its own |
| `verify(diff(graph))` | **no** | **config**, mode `ChangeSet` — §3.4.3. A runbook is a rendering of a *diff*, and a diff is a config artefact |

| View | Is it a projection? | What it actually is |
|---|---|---|
| finder | **no** | `find(corpus, query, graph?)`. A projection of the **corpus**, with the graph as optional context. The only surface that works with no workspace at all (brief §6.1: *"zero setup, zero data entry, zero trust required"*) |
| walkthrough | **no** | `drive(graph, task)`. The only **controller** in the product — an authored program that asks questions and writes to the graph. Everything else reads |

So the honest count is:

> **Four renderers, one controller, one corpus surface, and one layer that opens inside all of
> them.**

**DECISION — `verify(diff(graph))` is a mode of the config view, not a seventh view.** A change
set, its verification ladder and its rollback are three renderings of one `GraphDiff`
(`18` §2.3), and they are read in one sitting, in one order, and copied into one change ticket
(`18` §6). Splitting them across a view boundary means the user assembles a change ticket by
walking two views. The cost of the decision: the config view now has a mode selector, which is
one more piece of state, and a user who thinks "where is the runbook" has to learn that it is
under config. §9.3's view band mitigates this by naming the mode in the tab — `config · change
set · 14 lines` — rather than hiding it.

### 1.2 Why this matters for the shell

Because it settles the navigation model before it is designed. Four renderers over one selection
can share one canvas: they are answering four questions about the same thing, and switching
between them is switching question, not switching context. A controller and a corpus search
cannot share that canvas honestly — the walkthrough has a cursor that is not a selection, and the
finder has a query that is not a graph state.

That gives the structure in §2 directly:

| Kind of surface | Shell treatment |
|---|---|
| The four renderers | **one canvas, one at a time**, switched by keystroke, sharing selection |
| The controller (walkthrough) | **the same canvas**, but it owns the canvas while it is running and its cursor is a second, distinct pointer |
| The corpus surface (finder) | **an overlay** over whatever is on the canvas, plus a full-canvas form for the case where it is the only thing you are doing (§3.2.2) |
| The explainer | **a layer** — inline expansion, never a canvas |
| The AI | **an action on nodes** whose output renders in place in whichever view owns the node — §8 |

---

## 2. The shape of the shell

*margin tab: not a dashboard*

### 2.1 What is rejected, and why

The default answer for an application with six views is a left navigation rail plus a content
area. It is rejected. The reasons are not aesthetic preferences; each one is a cost that would be
paid on every screen for the life of the product.

| Rejected | Why |
|---|---|
| **Left nav + content** | A persistent vertical rail costs 180–240 px of a 1280 px laptop screen — 15–19 % — permanently, to render six words that change state maybe forty times a day. The field card's margins carry *margin tabs*, not navigation: `design-language.md`, *"the margins are for tabs, not for air"*. A rail is also a claim that the six views are siblings of equal weight, and they are not: §1.1 shows four renderers, one controller and one search |
| **Dashboard of panels** | Six panels at once means six panels at one sixth the density. The card is a *reference*: *"body copy is small and tight… density is the point"*. A dashboard optimises for glanceability, and nothing in this product is glanceable — a finding you glance at is a finding you did not read |
| **IDE three-pane (tree / editor / inspector)** | The tree is the inventory, the editor is the config, the inspector is the explainer. Freezing all three on screen forever means the diagram never gets more than a third of the canvas, and the diagram is the view that breaks first at scale (`44` §7.1). It also imports the IDE's worst habit: state that lives in a pane rather than in the document |
| **Tabs with close buttons (browser model)** | Implies documents. There is one document — the workspace. Six views of one workspace are not six tabs, and a user who closes the findings tab has hidden the product's opinions, which is the one thing brief §6.4 says the inventory must not let you do |
| **A chat sidebar** | §8. It is the wrong model for this product for reasons that are architectural, not decorative |

### 2.2 DECISION — the shell is a sheet

**The application is one sheet of paper with a masthead, a legend, a body and a footer rule.**
The body changes. The furniture does not. It is the card's own skeleton
(`design-language.md`, *Structure — the grammar of a card side*), applied literally:

```
┌ 1px strip ─────────────────────────────────────────────────────────────────────┐  egress strip
   ▲ this workspace may send graph excerpts to api.example.internal · 3 this session   (§8.5)
   ── only present when tier 1 egress is armed. Above the 3px rule on purpose. ──
├ 3px ink rule ──────────────────────────────────────────────────────────────────┤  masthead
   VIEW 3 OF 6 · FINDINGS                         3 high · 7 med · 2 suppressed
   F I N D I N G S                                    ← letterspaced caps, 21px
   SRX-A · WORKSPACE dc-east · junos-srx 21.4R3        ← subtitle, muted, caps
   CONTINUOUS LINT OVER THE GRAPH — NOT A REPORT YOU RUN   ← one-line imperative
├ 1px rule ──────────────────────────────────────────────────────────────────────┤
   READ-ONLY — SAFE ON PRODUCTION   CHANGES CONFIG — NEEDS A COMMIT   DISRUPTIVE …    legend
├ 1px hairline ──────────────────────────────────────────────────────────────────┤
   finder   walkthrough · 4 of 11   config · 214 lines   ▸findings · 3 high        view band
   diagram · 12 nodes   inventory · 2 devices                                        (§9.3)
├ 1px hairline ──────────────────────────────────────────────────────────────────┤
   selected: IkeGateway GW-B · 6 lines in config · 2 findings · 1 node in diagram   ribbon (§9.4)
├────────────────────────────────────────────────────────────────────────────────┤

   ▌ VIEW BODY
     … the only thing that changes when you switch views …

├ 1px rule ──────────────────────────────────────────────────────────────────────┤
   VIEW 3 OF 6 — FINDINGS   ⌥←  CONFIG        DIAGRAM  ⌥→        unsaved · 4 edits   footer
└────────────────────────────────────────────────────────────────────────────────┘
```

Everything above the body is 8 lines of text and 4 rules. Measured at `51`'s type scale that is
about 150 px on a desktop and it does not scale with the size of the workspace, the number of
findings or the number of views. Compare: a left rail costs 200 px horizontally *and* a header
costs 60 px vertically, in every application that has both.

**The masthead is not chrome; it is the answer to "where am I".** `VIEW 3 OF 6 · FINDINGS` is the
card's `SIDE 1 OF 4 — BUILD, PROVISION, PLUMB`, and it appears twice — top and bottom — for the
same reason the card repeats it: you look at the top when you arrive and the bottom when you
finish. §9 is the full treatment.

### 2.3 The split — pinning a second view

One view at a time is right for reading and wrong for two specific tasks: *drawing while
watching the config change*, and *walking a walkthrough while watching findings appear*. Both
are core (brief §4.1 consequence 3; §6.2's "findings raised inline as you go").

**DECISION — exactly two panes, never three, and the second pane is pinned rather than opened.**

```
├ 1px hairline ─────────────────────────┬────────────────────────────────────────┤
   ▌ DIAGRAM                             ▌ CONFIG · pinned            ⌥P unpin
     …                                     …
```

| Property | Value | Reason |
|---|---|---|
| Maximum panes | 2 | Three panes at 1280 px gives each 400 px, which is below the card's own column width (~360 pt ≈ 480 px) and the type stops working |
| Split ratio | 50/50, or 62/38 with `⌥[` / `⌥]` | Two positions, not a draggable continuum. A draggable splitter is state nobody remembers setting |
| Orientation | vertical (side by side) above 1100 px; **the split is unavailable below it** | The card's geometry is two ~360 pt columns in 744 pt. Below 1100 CSS px there is one column and that is the whole design |
| Which view may be pinned | any renderer, plus findings | The walkthrough may not be pinned — it is a controller, and a controller in a 400 px pane is a form in a gutter |
| Masthead when split | names the **primary** pane only; the pinned pane carries a one-line header of its own | Two mastheads is two products |
| Selection | **shared, unconditionally** | §5. This is the entire reason the split is worth having |

**The cost, stated:** a split doubles the work of every selection change (§5.6 budget S1 is
specified for the split case, not the single case) and it doubles the number of places a
regression in highlight rendering can hide. It also gives a user a way to make the diagram
too small to be useful and then report that the diagram is unreadable. Accepted, because the
alternative — a fixed second pane — is the IDE model rejected in §2.1.

### 2.4 Responsive collapse

| Width | Shell |
|---|---|
| ≥ 1440 px | Sheet centred at 1180 px max (matching the prototype), split available |
| 1100–1439 px | Sheet full width minus 24 px gutters, split available |
| 700–1099 px | One column. Split unavailable — `⌥P` reports `split needs 1100px` in the footer and does nothing |
| < 700 px | The reader subset. `53` §11 owns this and it is a real product, not a graceful degradation |

The view band wraps to two lines below 1100 px and never becomes a `<select>`. A dropdown of
views hides exactly the information the band exists to show (the counts), which is the whole of
§9.

### 2.5 What the sheet costs

Name it, because it is real.

| Cost | Detail |
|---|---|
| **Switching is a keystroke you have to know** | With a left rail, six targets are always visible and clickable. With a band of margin tabs they are visible but they read as annotations, not buttons. Mitigation: they *are* buttons (`role="tab"`, 24 px minimum target per `53` §11.4), the current one is ink-weight against muted, and the footer names the neighbours with their keys. A user who never learns `⌥←`/`⌥→` clicks the band, which is the same six targets a rail would have given them, minus the 200 px |
| **No persistent "you are here" beyond text** | Deliberate. §9.5 |
| **One view at a time means context switching is real** | The split (§2.3) is the answer for the two cases where it matters, and it is bounded at two on purpose |
| **A very wide screen wastes horizontal space** | The sheet caps at 1180 px. A 3440 px ultrawide gets a lot of white. This is what a printed reference does, and letting body text run to 3000 px is worse |

---

## 3. The six views, specified

*margin tab: what each one is for*

### 3.1 The view contract

Every view implements the same three functions. This is the mechanism that stops a view becoming
a second application: a view that needs a fourth function is a view that is holding private
state, and the review question is "why".

```rust
/// Implemented in the UI layer (TypeScript), against data the core provides.
/// The core never knows a view exists.
pub trait View {
    const ID: ViewId;

    /// What this view's primary object is, for the masthead subtitle and for
    /// the ribbon. May be None (the finder with no workspace).
    fn primary(&self, sel: &Selection, g: &GraphRef) -> Option<ElementId>;

    /// How this view renders the shared selection. Never mutates it.
    /// Must be pure and must complete inside budget S1 (§5.6).
    fn resolve(&self, sel: &Selection) -> ViewHighlight;

    /// What pointing at something in this view means, in graph terms.
    /// Returns None for hits on furniture (a column header, a rule).
    fn select_at(&self, hit: Hit) -> Option<Selection>;
}

/// The total order this view lists things in. Range multi-select (§5.4) is
/// defined only within one view's own order.
pub trait Ordered: View {
    fn order(&self) -> &[ElementId];
}
```

`resolve` and `select_at` are inverses in the loose sense and **exactly** inverses in no sense at
all. That asymmetry is §5.2 and it is the hardest part of the selection model.

### 3.2 Finder

| | |
|---|---|
| **Purpose** | Close the vocabulary gap (brief §2.1). Answer "what is this called" and "what do I type" in under one frame, with no workspace, no account and no trust |
| **Primary object** | A `CorpusId` — a command entry, an explainer, a rule, a task. **Not a graph element.** The finder is the one surface whose primary object is corpus, not graph |
| **Shows** | Ranked results as answer blocks: command, `Risk` label as text and colour, `answers`, `read_field`, `next_if_bad`, `rosetta` — `16` §17 owns the shape |
| **Lets you change** | Nothing in the graph. The finder is read-only over the corpus by construction. It *acts* — copy, navigate, start a walkthrough, open an explainer — and every one of those actions is either a clipboard write or a view switch |
| **Connects to** | Everything. Every result carries at least one link out: `G` to the guidebook entry, `W` to the walkthrough that builds it, `Enter` to the clipboard. With a workspace open, results interpolate real values (`16` §16) and the interpolated slots are selections into the graph |

#### 3.2.1 The overlay form

The default. `Ctrl+K` from anywhere, including from inside a text field, including inside the
config editor. It renders over the sheet with the sheet still legible behind it — **no backdrop
fade, no dimming layer, no transition** (`44` §4.2: *"a 150 ms fade is 150 ms of latency"*). The
overlay is a 1px-ruled block that occupies the top 60 % of the body area and leaves the masthead
and legend visible, because the risk legend is exactly the thing you want visible while looking
at a command you are about to run.

#### 3.2.2 The full-canvas form

The same component at full body height, with the results list two columns wide. It is reached
three ways: `⌥1`, clicking `finder` in the view band, and **first run** (§7.2 screen 0). It
exists because of one honest observation: for a large fraction of sessions the finder is not a
thing you invoke on the way to something else — it *is* the session. Brief §6.1 calls it the
feature people open ten times a day. Ten times a day is not a modal.

Both forms are the same code, the same index, the same ranking, the same keymap. The only
difference is the container and the column count.

### 3.3 Walkthrough

| | |
|---|---|
| **Purpose** | Brief §6.2, the flagship. Build one thing correctly, with findings raised inline as you go, ending with validated config, a verification ladder and a rollback |
| **Primary object** | A `WalkthroughRun` — the task, its cursor, and the graph elements it has created so far. The run has a **root node** (for the SRX task, the `IpsecVpn`), and that root is what the ribbon and masthead name |
| **Shows** | The whole task as a numbered list on one sheet, current step expanded, everything else collapsed to one line. §6 |
| **Lets you change** | The graph, directly, one field per answer, as you go. It is the only view that writes structure the user did not draw |
| **Connects to** | config (live emit of the run's root closure), findings (the step's armed rules), explainer (every question has a `why` at three depths), and on completion, config·`ChangeSet` for the ladder and rollback |

Full specification in §6.

### 3.4 Config

| | |
|---|---|
| **Purpose** | The product's primary output. `emit(graph, platform)` with provenance on every line (invariant 6) |
| **Primary object** | An **emit unit** (`11` §9.2): `Device`, `IpsecVpn`, `SecurityPolicy`, `Interface` or `Tunnel`. Not "the graph" — an emit never runs over the graph |
| **Shows** | Emitted lines, in block order, on `#F2F4F6`, in mono, with continuation backslashes preserved exactly as the card prints them (`design-language.md`, device 5). A left gutter carrying the risk dot. Blockers (L2 failures, `11` §9.1) listed above the block, never a partial config with a hole in it |
| **Lets you change** | Nothing by typing. **The config view is not an editor.** Clicking a line selects its source node and fields; editing happens in the field surface that opens against that node (§4.2's inline expansion). This is the direct consequence of brief §4.1 consequence 1 applied to text instead of to pictures: if you can type into the config, the config is the data structure |
| **Connects to** | Every line back-references `source_node` and `source_fields` (`13`), so every line is a selection. Findings that touched a line are listed in its provenance expansion via `rules_applied` |

#### 3.4.1 The two modes

| Mode | Content | Reached by |
|---|---|---|
| `Full` | The whole emit unit | default |
| `ChangeSet` | `config_diff(A, B)` (`18` §3) plus the pruned verification ladder (`18` §4.5) plus the rollback (`18` §5), in that order, with `commit confirmed 5` as line 1 (`18` §5.5) | `⌥D`, or automatically on completing a walkthrough, or from any finding's remediation |

`ChangeSet` is `verify(diff(graph))` from brief §1. §1.1 explains why it is a mode.

#### 3.4.2 The line, in full

```
─────────────────────────────────────────────────────────────────────────────────
  12  ▪  set security ike gateway GW-B external-interface reth0.0
        └ IkeGateway GW-B · external_interface · hand-entered 2026-07-24
          rules: zone.host-inbound.ike-missing (armed)
          ▌ external-interface is the WAN unit the IKE packets leave by, not st0.
            Wrong on a multi-homed box means Phase 1 sources from an address the
            peer has never heard of.
─────────────────────────────────────────────────────────────────────────────────
```

The gutter number is the emit ordinal (used by `53` §6 for copy scoping). `▪` is the risk dot in
one of the three colours. The expansion under it is the explainer surface (§4) at the current
depth; the prose shown is the card's own text on `external-interface`, side 1.

#### 3.4.3 Multi-platform

One workspace can hold devices on several platforms. The config view emits for the platform of
the emit unit's device, named in the subtitle. There is no "all platforms" mode: a screen of
concatenated configs for four vendors is a file, not a view. Exporting several units at once is
an export action, not a view state.

### 3.5 Findings

| | |
|---|---|
| **Purpose** | Brief §6.6. Continuous lint over the graph, not a batch report |
| **Primary object** | A `Finding` — one rule firing against one node (conventions, *Terminology*) |
| **Shows** | The card's `ERROR DECODER` layout, literally: a two-column table, horizontal hairlines only, no vertical rules. Left column is the lookup key (the rule id and the node), right column is the answer (title, `why`, `symptom_if_mismatched`, remediation, `acceptable_when`, `sources`) |
| **Lets you change** | Suppressions — create one, with a mandatory reason, stored in the workspace (brief §6.6). Nothing else. A finding is not editable; the *graph* is, and the finding follows |
| **Connects to** | Each finding selects its node, which highlights lines in config and a node in the diagram. Each remediation is a one-click action that produces a `ChangeSet` (§3.4.1), not a silent write |

#### 3.5.1 Severity is rendered in neutrals

Non-negotiable, from the conventions: the three colours mean `ReadOnly`, `ChangesConfig`,
`Disruptive` and nothing else. Finding severity is a **weight and rule** treatment:

| Severity | Treatment |
|---|---|
| high | Rule above the row is 2px ink; the severity word is bold ink, letterspaced |
| medium | 1px hairline; severity word is regular ink |
| low | 1px hairline; severity word is muted |
| suppressed | Row is muted throughout; margin tab `suppressed · <reason first 40 chars>`; collapsed by default, counted in the view band |

A user asking "why is my high-severity finding not red" is asking a fair question and the answer
is on screen: red already means *drops live traffic*, and a finding does not drop traffic — the
command you paste might.

#### 3.5.2 Grouping and the default sort

Default sort is `(severity desc, node emit order, rule id)`. Node emit order — not alphabetical
— so that walking the findings list walks the object chain in the order the card teaches
(`11` §9.2's depth-first pre-order). A user reading top to bottom is reading Phase 1 before
Phase 2, proposal before policy before gateway, exactly as side 1 lays it out.

Grouping toggles: by node, by rule, by severity, by platform. Group state is a view preference,
persisted per workspace, and it is **not** part of the selection.

### 3.6 Diagram

| | |
|---|---|
| **Purpose** | Brief §6.5. A view over the graph and a manipulation surface for it — a design tool, not a source of truth |
| **Primary object** | A `Site` or a `Device` (the drawing root), with the layer set as a view preference |
| **Shows** | SVG from a closed tag set (`44` §4.7), layered physical / L2 / L3 / security / overlay, toggled independently. Nodes parsed from real configs are marked as such with their age (brief §6.5; `11` §8.7) |
| **Lets you change** | Structure: add a device, draw a link, draw a tunnel, drag for layout. **Layout position is workspace state keyed by `NodeId`** (`11` §10.6) and survives renames. Field values are not edited here — clicking a node selects it and the field surface opens |
| **Connects to** | Selection, in both directions, and this is the direction users will test first: click a node, switch to config, the lines are highlighted |

#### 3.6.1 What the diagram deliberately cannot show

At more than 2,000 live SVG elements the view aggregates to `Site`/`Device` level and requires a
drill-down (`44` §4.7.4). The honest consequence, already stated there and repeated here because
it is an IA consequence and not only a rendering one: **an engineer who wants their whole
200-device estate on one screen cannot get it, and the answer is the inventory view.** Saying
"use the table" is the true answer and it is worse than the answer they wanted.

### 3.7 Inventory

| | |
|---|---|
| **Purpose** | Brief §6.4. The estate as a table — and the thing NetBox structurally cannot do: **the inventory has opinions** |
| **Primary object** | The row set — a kind plus a filter. Default kind is `Device` |
| **Shows** | A virtualised table, sortable, with hairline row rules and no vertical rules. Columns are kind-dependent and chosen from the schema (`11` §11.6 makes the schema data, so the column picker is generated, not hand-written) |
| **Lets you change** | Field values, in place, in the cell. This is the one view where bulk editing is appropriate: setting `dpd` on eleven gateways is a table operation |
| **Connects to** | Every row is a node. Selecting rows selects nodes. The opinions column is findings, aggregated per row |

#### 3.7.1 The opinions column

The rightmost column of every inventory table is not a field. It is the per-row finding
aggregate, rendered as text: `3 high · 1 med`, or `—`. Sorting by it sorts by worst severity then
count. This is brief §6.4's *"facts that argue back"* made structural: you cannot look at the
inventory without seeing what the rule engine thinks of each row.

Below the table, in the note idiom (4px accent bar, wash), the **structural observations** — the
inventory's own opinions that are not findings against a single node:

```
▌ TWO SRX DEVICES, NO CLUSTER
  SRX-A and SRX-B are the same model and family and sit in the same Site.
  If these are a chassis cluster, RG0 needs a node priority pair and RG1
  needs the reth members. Nothing here says they are — Fathom is guessing
  from two facts.                                   [ model it ]  [ not a cluster ]
```

**These are findings like any other** (invariant 5: findings are data, not code) — rules whose
`applies_to` is a population rather than a node. `44` §7.1 already names population rules as the
second thing that breaks at scale, and this is the surface that makes them worth the cost.

### 3.8 The connection matrix

Every cell is "what happens when you are in the row view, acting on the current selection, and go
to the column view". Empty means the selection simply carries and the view renders it normally.

| from ↓ / to → | finder | walkthrough | config | findings | diagram | inventory |
|---|---|---|---|---|---|---|
| **finder** | — | `W` on a result starts that task, pre-seeded with the finder's context | `Enter` copies; going to config selects the interpolated node if any | a result's `next_if_bad` names findings; going to findings filters to them | — | a graph-scoped query (`#`) resolves to rows |
| **walkthrough** | `Ctrl+K` scoped to the current step's field | — | live emit of the run root's closure; the step's lines are highlighted | filtered to the run root's closure, in step order | the run root is drawn and the current step's node pulses once (§5.6) | the run's created nodes are the row set |
| **config** | `Ctrl+K` scoped to the selected line's platform and phase | `W` on a line offers the task that builds that block | — | filtered to `rules_applied` on the selected lines | selects the `source_node` | selects the `source_node`'s row |
| **findings** | `Ctrl+K` scoped to the finding's rule domain | remediation → the task that fixes it, if the corpus names one | scrolls to and highlights the lines the finding's node produced | — | selects the finding's node, and dims layers that do not contain it | selects the finding's node's row |
| **diagram** | `Ctrl+K` scoped to the selected node's kind | `W` offers tasks whose root kind matches the selection | highlights the selection's emit closure | filters to the selection | — | selects rows |
| **inventory** | `Ctrl+K` scoped to the row's kind | `W` offers tasks rooted at the row | emit unit becomes the row, if the row is an emit unit | filters to the selected rows | selects and centres, expanding a collapsed group if needed | — |

Two rules govern the whole matrix and they are worth more than the matrix:

1. **A view switch never changes the selection.** It changes how the selection is drawn. The one
   exception is the finder, whose primary object is a corpus entry rather than a node, and which
   therefore may *set* a selection when a result names one.
2. **A view switch never scrolls the previous view.** Coming back finds it where you left it.
   Scroll position is per-view session state (§10.2).

---

## 4. The explainer surface

*margin tab: not a view*

### 4.1 What it is

`explain(node, depth)` is a projection (brief §1) and it is not a view, because it has no
independent subject. It always explains *the thing you are looking at*. Giving it a view would
mean giving it a navigation problem — "explain what?" — which is exactly the problem the click
already solved.

**DECISION — the explainer is a layer with three placements and no home.**

### 4.2 The three placements

| Placement | Where | Trigger | Content budget |
|---|---|---|---|
| **Inline expansion** | Directly under the thing, pushing content down, never overlaying it | `Enter`/click on a config line, a field, a finding, a diagram node, a walkthrough question | Terse: 1–3 lines. Explained: a paragraph plus one note block. Teaching: the full triple (`15` §4) |
| **The margin drawer** | Right 38 % of the body, as a pinned pane (§2.3's split, with the explainer as the pinned side) | `⌥E` | Full teaching triple plus the misdiagnosis index (`15` §5.6) |
| **The sheet** | Full body, masthead reads `GUIDEBOOK`, still `VIEW n OF 6` for whichever view you came from | `G` from the finder, or following a `sources` link | The complete entry with its counterfactual, its sources, and its `reviewed_by` |

Inline expansion is the default and carries 90 % of the traffic. It is chosen over a tooltip, a
popover and a side panel for one reason: **an explainer that overlays the thing it explains makes
you choose between the explanation and the evidence.** The card never does this — its notes sit
*next to* the block, in the flow, with a 4px accent bar.

### 4.3 The depth control is a margin tab, not a setting

`design-language.md` is explicit: *"Fathom's explainer depth toggle should feel like these"* —
the card's `read this first`, `most-missed`, `verify as you go`. So:

```
                                                      terse · explained · teaching
```

Muted, lowercase, top-right of the block, current one in ink. Three words. `V` cycles it
(`16` §19.2 already binds `V` in the finder; `53` §3 makes it global). It sets a **global**
default and a **per-block** override, and the per-block override is forgotten when the block
closes. Brief §5.4 asks for exactly this: *"user-toggled globally and per-block"*.

There is no settings screen for it, no dropdown, no radio group, no icon.

### 4.4 What opening an explainer never does

| Never | Why |
|---|---|
| Steals focus | `53` §8. The expansion is announced via `aria-expanded` and the content is in the tab order after the trigger, but focus stays where it was |
| Changes the selection | The explainer is *about* the selection. Explaining a thing is not selecting a different thing |
| Blocks anything | It is not a modal. `Esc` closes it; so does opening another one |
| Fetches | Corpus bodies are lazily-decompressed zstd frames from inside the artifact (`15`, `44` §5.3). Lazy means "from local memory", never "from a network". Invariant 1 |

---

## 5. Selection — the through-line

*margin tab: this is the architecture*

### 5.1 The type

```rust
/// The single piece of shared state that makes six views one product.
/// Lives in the UI layer. The core is told about it only when it needs to
/// compute something (an emit closure, a filter); the core holds no selection.
pub struct Selection {
    /// The last element the user explicitly pointed at. Drives the masthead
    /// subtitle, the ribbon, and every single-target action. `None` only when
    /// nothing is selected.
    pub anchor: Option<ElementId>,

    /// The full set, including the anchor. Ordered by `ElementId` so that
    /// equality and hashing are cheap and the ordering never depends on the
    /// order things were clicked in.
    pub set: BTreeSet<ElementId>,

    /// WHY it is selected — what the user actually pointed at. Two selections
    /// with the same `set` and different `facet` render differently.
    pub facet: Facet,

    /// Which view made this selection. Used for one thing only: deciding
    /// whether a view should scroll (§5.6.3). Never used for filtering.
    pub origin: ViewId,

    /// Monotonic. Increments on every change. Views compare it to decide
    /// whether their cached highlight is stale.
    pub epoch: u64,
}

pub enum Facet {
    /// The node or edge itself. The common case.
    Element,
    /// One field of the anchor. Set by clicking a field, a cell, or a
    /// config line whose provenance names exactly one field.
    Field(FieldKey),
    /// One emitted line. Narrows to (node, fields) but keeps the line
    /// identity so the config view can scroll to it and the copy gesture
    /// knows what "this line" means.
    Line(EmitLineIdx),
    /// One finding. Narrows to its node but keeps the rule identity so the
    /// findings view can expand the right row.
    Finding(FindingKey),
    /// A byte range in a capture — a pasted config (14 §—). Narrows to
    /// whatever the parser bound that range to, which may be nothing.
    Span { capture: CaptureId, bytes: Range<u32> },
}
```

Three properties are load-bearing:

1. **The selection is over the graph, never over a rendering.** There is no `SelectedLine`,
   no `SelectedRow`, no `SelectedSvgNode`. Every view derives its own highlight from
   `ElementId`s. This is invariant 7 (*rules, explainers, emitters and diagram elements
   reference IDs, never paths or names*) applied to the interface.
2. **`facet` exists because narrowing is lossy.** Clicking `set security ike gateway GW-B
   external-interface reth0.0` and clicking the `external_interface` cell in inventory produce
   the same `set` — and should not produce the same screen. The facet is what remembers the
   difference.
3. **`anchor` is not `set.first()`.** Multi-select has a primary and it is the last thing you
   pointed at, not the lowest ULID.

### 5.2 What "selected" means — narrowing and widening

This is the hard part, and it is hard because the mapping between graph elements and view
elements is many-to-many in both directions.

| Direction | Operation | Exact? | Example |
|---|---|---|---|
| view element → graph | **narrowing** | yes, always | Config line 12 → `IkeGateway GW-B`, field `external_interface`. `EmittedLine` carries `source_node` and `source_fields` by construction (invariant 6) |
| graph → view elements | **widening** | no — it is a *closure*, and the closure is view-specific | `IpsecVpn VPN-B` → 31 config lines across 6 blocks; 1 diagram node plus 2 decorated edges; 1 inventory row plus 4 child rows; 3 findings |

**DECISION — selection narrows implicitly and never widens implicitly.** Pointing at a line
selects one node. Pointing at a node selects one node. The *closure* is rendered, but it is
rendered as **related**, not as selected, and the distinction is visible.

```
  PRIMARY   the selection itself        4px ink left bar, ink text
  RELATED   the closure of the selection 1px ink left bar, #F2F4F6 wash, ink text
  DIMMED    everything else              muted text, no bar
```

**Selection highlighting is neutrals only.** The three colours mean `ReadOnly`, `ChangesConfig`
and `Disruptive` and nothing else (conventions, *The risk enum*). A selected `Disruptive` line is
a `Disruptive` line with an ink bar on it, and both facts are legible.

Why the two-tier treatment matters: without it, selecting `VPN-B` in the diagram lights up 31
config lines identically, and the user reasonably concludes they selected 31 things. Then they
press the copy key. `53` §6 defines copy against the *primary* set with an explicit `Alt` variant
for the closure, and that only works if the two tiers were visibly different first.

### 5.3 Per-view `resolve` and `select_at`

| View | `select_at` produces | `resolve` renders primary as | `resolve` renders related as |
|---|---|---|---|
| **config** | `Facet::Line`, narrowed to the line's `source_node` + `source_fields` | 4px ink bar on the line, the line's block header in ink | wash on every line whose `source_node ∈ set` or whose `source_fields` intersect the selected fields |
| **findings** | `Facet::Finding`, narrowed to `finding.node` | the finding row expanded, 4px ink bar | rows for the same node, and rows for nodes in the emit closure, un-dimmed while everything else dims |
| **diagram** | `Facet::Element` for a node; `Facet::Element` for an edge; **`Facet::Field` for a decoration** (a tunnel's `st0.N` label is a decoration on an edge and selects `LogicalUnit.name`) | 2px ink stroke on the shape, label in ink | 1px ink stroke on closure members, everything else at 40 % opacity in the same ink |
| **inventory** | `Facet::Element` for a row, `Facet::Field` for a cell | row background `#F2F4F6`, 4px ink bar in the row gutter | child rows and referenced rows get the 1px bar |
| **walkthrough** | `Facet::Field` for a question | the step expanded | steps that write to the same node get the 1px bar |
| **finder** | sets the selection only when the result names a graph element (an interpolated slot) | — | — |

### 5.4 Multi-select

| Gesture | Semantics | Scope |
|---|---|---|
| `Ctrl`/`Cmd` + click | Toggle one element in `set`; `anchor` becomes the toggled element if added, or the previous anchor if removed | any view |
| `Shift` + click | Range from `anchor` to the hit, **in the current view's `Ordered::order()`** | views implementing `Ordered`: config, findings, inventory, walkthrough |
| `Shift` + `↑`/`↓` | Extend the range by one in view order | same |
| `Ctrl`/`Cmd` + `A` | Select everything in the current view's order — **which is not "the whole graph"** | same |
| Marquee drag | Union of nodes whose bounding box intersects the marquee | diagram only |
| `Esc` | Clear to `anchor` only; second `Esc` clears entirely | any view |

**Range select is undefined across views and is refused, not approximated.** The diagram has no
total order that means anything (a layout is not an ordering), and a range from a config line to
an inventory row is a question with no answer. If `anchor` was set in a different view than the
`Shift`+click target, the gesture degrades to a toggle and the footer says `range needs one
view`.

Semantics of a multi-selection, per view:

| View | With `|set| > 1` |
|---|---|
| config | Union of highlights. Copy copies the union **in emit order**, not in click order (`53` §6.3) |
| findings | Filter is `OR` over the set. The count in the view band updates |
| diagram | Union. Dragging moves all selected nodes together |
| inventory | Row selection. Editing a cell offers `apply to 11 selected rows` **as an explicit second action**, never as the default (see `33` §7.4 on bulk actions) |
| walkthrough | Ignores it. A step drives one node. The ribbon says `walkthrough uses the anchor` |
| explainer | Explains the **anchor** only. There is no explainer for a set |

### 5.5 Worked — the same node in three views

`LogicalUnit st0.0`, from the field card's side 1, plumbing piece #1.

| View | How it appears | What `resolve` does |
|---|---|---|
| **diagram** | **Not a node.** It is a decoration on the tunnel edge between SRX-A and SRX-B — the label `st0.0` sitting on the edge, plus the `10.255.0.1/30` address on the near end. In the L3 layer it is the edge's identity; in the physical layer it does not exist at all | Strokes the edge at 2px ink and puts the label in ink. **In a layer where it does not exist, `resolve` returns `Offscreen(reason: "not in this layer")`** and the view band's diagram tab reads `diagram · selection not in L2` |
| **inventory** | A row, indented under `Interface st0` under `Device SRX-A`, with columns `name`, `family`, `address`, `mtu`, `zone`, and the opinions column | Row gutter bar, and if the row is inside a collapsed group, the group **expands** — this is the one case where `resolve` mutates view-local state, and it is allowed because a highlight you cannot see is not a highlight |
| **config** | **Four lines in three different blocks**: `set interfaces st0 unit 0 family inet address 10.255.0.1/30` (interfaces block), `set security zones security-zone VPN interfaces st0.0` (zones block), `set security ipsec vpn VPN-B bind-interface st0.0` (vpn block), `set routing-options static route 10.2.0.0/16 next-hop st0.0` (routing block) | All four get the 4px primary bar, because all four have `st0.0` in `source_node` or `source_fields`. The blocks between them stay dimmed. **The view does not scroll to all four** — it scrolls to the first, and the footer reads `4 lines · 3 blocks · ⌥N next` |

This example is the reason `resolve` returns a `ViewHighlight` rather than a boolean per element:

```rust
pub struct ViewHighlight {
    pub primary: Vec<ViewElementRef>,
    pub related: Vec<ViewElementRef>,
    /// Non-empty when the selection exists in the graph but this view cannot
    /// show it. The view band renders the reason; the view does not go blank.
    pub offscreen: Option<OffscreenReason>,
    /// Where this view would scroll, if it decides to scroll (§5.6.3).
    pub scroll_target: Option<ViewElementRef>,
}

pub enum OffscreenReason {
    /// A layer filter, a kind filter, a search filter
    FilteredOut { control: &'static str },
    /// The diagram has aggregated above 2,000 elements (44 §4.7.4)
    Aggregated { drill_into: NodeId },
    /// This kind has no rendering in this view at all
    NotRepresented { kind: NodeKind },
}
```

**`OffscreenReason` is the single most important field in the selection model** and it is the one
a first implementation will leave out. Without it, selecting a node in inventory and switching to
the diagram shows an unchanged picture and the user concludes the link is broken. With it, the
diagram says `not in this layer · ⌥L to show L3` and the link is legible even when it cannot be
drawn.

### 5.6 Propagation — algorithm, complexity, budget

#### 5.6.1 The indices

Each view maintains one index from `ElementId` to its own elements, built once and patched
incrementally.

| View | Index | Built | Patched on |
|---|---|---|---|
| config | `BTreeMap<NodeId, SmallVec<[EmitLineIdx; 4]>>` plus `HashMap<FieldRef, EmitLineIdx>` | at emit (`44` B10) | re-emit (B11, 4 ms) |
| findings | `HashMap<NodeId, SmallVec<[FindingKey; 2]>>` | at lint | finding patch ops (`44` §4.4) |
| diagram | `HashMap<ElementId, SvgRef>` | at layout | structural change only |
| inventory | `HashMap<NodeId, RowIdx>` | at table build | row insert/remove |
| walkthrough | `HashMap<NodeId, StepId>` | at run start | step completion |

#### 5.6.2 The algorithm

```
on selection_change(new: Selection):
    if new.epoch == last_rendered_epoch: return          # idempotent
    for view in visible_views():                          # 1 or 2 (§2.3)
        h = view.resolve(new)                             # pure
        view.apply_classes(h)                             # class toggles only
    update_ribbon(new)                                    # §9.4
    update_view_band_counts(new)                          # §9.3, from cached indices
```

`apply_classes` is a set difference against the previously applied highlight — remove classes
from `prev.primary \ h.primary`, add to `h.primary \ prev.primary`. It never rebuilds DOM and
never re-reads layout.

**Complexity.** `O(|set| · f + |h| )` where `f` is the mean fan-out of the view index (config:
~3.8 lines per node for a mid-size SRX; diagram: 1; inventory: 1) and `|h|` is the symmetric
difference from the previous highlight. For the worst realistic case — selecting a whole `Device`
in inventory with config pinned, ~830 nodes (`11` §14.2), ~4,000 lines — `|h|` is 4,000 class
toggles, which is the case the budget below is set against.

#### 5.6.3 Budget S1 — a proposed addition to `44` §3

| # | Budget | P50 | **P95** | Hard fail | Gate |
|---|---|---|---|---|---|
| **S1** | selection change → all visible views repainted, `|set| = 1` | 3 ms | **8 ms** | 16.7 ms | counters + e2e, every PR |
| **S2** | selection change → all visible views repainted, `|set| = 1` device (≈ 830 nodes, ≈ 4,000 lines, split view) | 14 ms | **33 ms** | 66 ms | e2e, every PR |
| **S3** | view switch (no selection change) | 8 ms | **20 ms** | 50 ms | e2e, every PR |
| **S4** | explainer inline expansion, index hit | 4 ms | **12 ms** | 33 ms | e2e |
| **S5** | explainer inline expansion, lazy zstd body | 20 ms | **60 ms** | 150 ms | e2e |

Counter gates: `highlight_class_ops` ≤ 4,096 per selection change; `dom_nodes_created` **= 0** on
a selection change (a selection that creates DOM has re-rendered, which is the regression this
counter exists to catch); `boundary_crossings` ≤ 1 (only when a closure must be computed, and
closures are cached per anchor).

S1 is one frame because selection is the interaction that carries the product. S2 is deliberately
two frames: selecting an entire device is a deliberate act and 33 ms is imperceptible as a
*response*, only as an *animation* — and there is no animation.

#### 5.6.4 Scrolling — the rule that stops nausea

A view scrolls to `scroll_target` if and only if **all** of:

1. the selection changed (not merely the view),
2. `new.origin != this.id` — the view that made the selection never scrolls itself, because the
   thing is already under the user's cursor,
3. the target is not already within the viewport inset by 15 %,
4. the user has not scrolled this view manually within the last 1,200 ms.

Condition 4 is the one everybody omits and it is the one that makes the difference between a
linked view and a fighting view. Scrolling uses `behavior: 'instant'` when the distance exceeds
two viewport heights and `'smooth'` otherwise, because a smooth scroll across 40 screens is a
long animation nobody asked for. If `prefers-reduced-motion` is set, always `'instant'`.

### 5.7 What selection is not

| Not | Why |
|---|---|
| **Undoable** | `53` §7.3. Undo is over graph transactions. An undo stack polluted with 200 selections is an undo stack nobody uses |
| **Synced** | Selection is per-client session state and is never written to the workspace or a frame. Two engineers on one workspace do not share a cursor. Shared cursors are a collaboration feature this product has not earned and they leak what a colleague is looking at |
| **Persisted across a lock** | Locking the workspace clears it, along with everything else in memory (`32` §—) |
| **Part of the URL by default** | §10.3 |

### 5.8 Failure modes of the selection model

| # | Failure | Symptom | Control |
|---|---|---|---|
| 1 | A view caches a highlight and misses an `epoch` bump | Stale highlight; two views disagree; the user loses trust in the link | `epoch` compared on every render; a debug assertion in dev builds that re-derives and compares |
| 2 | A selected node is deleted (or tombstoned, `11` §10.5) | Dangling `ElementId`; `resolve` returns nothing everywhere; the ribbon names a thing that is gone | On any graph transaction, `set` is filtered against existence. Tombstoned nodes stay selected (they still render, muted); purged nodes are dropped, and the ribbon says `1 selected element was purged` |
| 3 | A view implements `select_at` to return a rendering identity | The link works in that view and nowhere else | The type forbids it: `select_at` returns `Selection`, which holds only `ElementId`s |
| 4 | Widening leaks into `set` | Selecting a device selects 830 things; copy copies the estate | §5.2's decision, enforced by the fact that closures are computed in `resolve`, which cannot write |
| 5 | Multi-select across a filter change | Rows selected, filter applied, selection now contains invisible rows; a bulk edit hits things off screen | `OffscreenReason::FilteredOut` is rendered in the ribbon as `3 of 11 selected are filtered out`, and bulk edits name the full count in their confirm text |
| 6 | The diagram's aggregation hides the selection | Select in inventory, switch to diagram, nothing visible | `OffscreenReason::Aggregated { drill_into }` with a one-key drill |

---

## 6. The walkthrough, in detail

*margin tab: the flagship*

### 6.1 Why it is different from every other view

Brief §6.2: *"Pick a task, answer questions, get validated config with findings raised inline as
you go — not at the end."*

Every other view renders the graph. The walkthrough **writes** it, and it writes it from a
program somebody authored. That makes three things different:

1. It has a **cursor** that is not a selection. The cursor is "which question am I on"; the
   selection is "which node am I looking at". They are usually related and are not the same, and
   conflating them breaks the moment you click into config to check something.
2. It is **resumable state stored in the workspace**, not session state.
3. It is **corpus**, so it versions and it can drift out from under a run in progress (§6.9).

### 6.2 The types

```rust
/// Corpus. Authored YAML, reviewed, versioned with the corpus (60-content).
pub struct Task {
    pub id: TaskId,                   // junos-srx/site-to-site-ipsec.route-based
    pub version: SemVer,
    pub platforms: Vec<PlatformId>,
    pub versions: VersionPredicate,   // Junos 15 vs 21 vs 23 differ; 5.2 of the brief
    /// The kind the run is rooted at. Drives the ribbon and the emit unit.
    pub root_kind: NodeKind,          // IpsecVpn
    pub steps: Vec<Step>,
    /// Rules that this task promises to keep clean. Findings from these rules
    /// against the run's closure render inline (§6.4); everything else goes to
    /// the findings view without interrupting.
    pub armed_rules: Vec<RuleId>,
}

pub struct Step {
    pub id: StepId,                   // stable forever; §6.9 matches runs across versions
    pub ordinal: u16,                 // "#3" — the card's numbered plumbing, as content
    /// The question in the user's words, not the field's words. This is the
    /// vocabulary gap (brief §2.1) inside the walkthrough.
    pub question: BoundedText<120>,
    pub explain: ExplainerId,         // three depths, §4
    pub writes: Vec<FieldTarget>,
    pub creates: Vec<NodeTemplate>,   // may create nodes and edges
    pub input: InputSpec,
    pub default: Option<DefaultSpec>, // with a source, per 11 §5.3
    pub skip_when: Option<Predicate>, // evaluated against the graph
    pub blocked_until: Vec<StepId>,   // hard ordering, minimal
    /// Rules that become checkable once this step is answered. Named per step
    /// so the inline finding appears at the earliest honest moment (§6.4).
    pub arms: Vec<RuleId>,
}

pub enum InputSpec {
    Choice { options: Vec<ChoiceOption>, multi: bool },
    Scalar { ty: ScalarType },        // 11 §4 — Ipv4Addr, InterfaceName, Seconds, Mtu…
    NodePick { kind: NodeKind, create_inline: bool },
    Confirm,                          // "#3 — let IKE reach the box on the WAN zone"
}

/// Workspace state. Written as ordinary ops (33 §5.1), so it syncs and merges.
pub struct WalkthroughRun {
    pub id: RunId,
    pub task: TaskId,
    pub task_version: SemVer,
    pub root: Option<NodeId>,         // None until the root step completes
    pub cursor: StepId,
    pub answered: BTreeMap<StepId, AnswerRecord>,
    pub skipped: BTreeMap<StepId, SkipReason>,
    pub started_at: Timestamp,
    pub state: RunState,
}

pub enum RunState { Active, Parked, Completed { at: Timestamp }, Abandoned }

pub struct AnswerRecord {
    pub at: Timestamp,
    /// Which ops this answer produced. This is what makes a step undoable
    /// as a unit (53 §7.2).
    pub tx: TransactionId,
    /// Was this answered by the user, or satisfied by the graph on entry?
    pub how: AnswerOrigin,
}

pub enum AnswerOrigin {
    Typed,
    /// The graph already had it. Carries the provenance so the collapsed step
    /// can say "parsed · 2026-07-14" (§6.8).
    Prefilled { prov: ProvenanceId },
    /// A default was accepted without being changed.
    DefaultAccepted { source: DefaultSource },
}
```

### 6.3 The SRX site-to-site sequence

`junos-srx/site-to-site-ipsec.route-based`, `root_kind: IpsecVpn`. Every question, every default
and every explainer below is drawn from the field card. Sides are cited so an author can find the
source text.

| # | Question | Writes | Default | Arms | Skip when | Card source |
|---|---|---|---|---|---|---|
| **1** | *Which box is this going on?* | `Device` (pick or create) | the only device, if one | — | one device in workspace and it is `junos-srx` | — |
| **2** | *What is the far end's public address?* | `IkeGateway.peer` | — | `ike.gateway.peer-unset` | peer already `Set` | side 1, `address 203.0.113.10` |
| **3** | *Which interface do the IKE packets leave by?* | `IkeGateway.external_interface` → `LogicalUnit` | the unit with a default route | **`zone.host-inbound.ike-missing`** | — | side 1: *"`external-interface` is the WAN unit the IKE packets leave by, not `st0`. Wrong on a multi-homed box means Phase 1 sources from an address the peer has never heard of."* |
| **4** | *IKEv1 or IKEv2?* | `IkeGateway.version` | `v2-only` | `ike.version.v1-only`, `ike.mode.aggressive` | — | side 2, IKEv1 vs IKEv2 table |
| **5** | *Phase 1 crypto* — DH group, encryption, hash, lifetime | `IkeProposal.{dh_group, encryption_algorithm, authentication_algorithm, lifetime_seconds}` + `IkePolicy` + edges | `group14`, `aes-256-cbc`, `sha-256`, `28800` | `ike.proposal.legacy-dh`, `ike.proposal.gcm-with-hash`, `ike.proposal.3des` | — | side 1 config block; side 2 *"Proposal parameters"* |
| **6** | *Does the peer identify you by your outer IP?* | `IkeGateway.{local_identity, remote_identity}` | skip (the common case) | `ike.identity.nat-mismatch` | peer is not behind NAT and address is static | side 2, *Peer identity* |
| **7** | *How fast should a dead peer be declared dead?* | `IkeGateway.dpd` | `always-send interval 10 threshold 3` | `ike.dpd.absent`, `ike.dpd.too-tight` | — | side 2: *"10 × 5 = 50 s of blackhole before failover even starts… 10 × 3 is a reasonable middle."* |
| **8** | *Phase 2 crypto* — protocol, encryption, lifetime | `IpsecProposal.{protocol, encryption_algorithm, lifetime_seconds}` | `esp`, `aes-256-gcm`, `3600` | `ipsec.proposal.ah`, `ipsec.proposal.gcm-with-hash` | — | side 1: *"GCM is AEAD, so there is no separate `authentication-algorithm`. With CBC you must set both — a missing hash is a silent proposal mismatch."* |
| **9** | *Perfect forward secrecy?* | `IpsecPolicy.perfect_forward_secrecy` | `group14` | **`ipsec.pfs.absent`**, `ipsec.pfs.group-mismatch` | — | side 2, the whole PFS block |
| **10** | *Which prefixes go through the tunnel?* | `TrafficSelector.{local_ip, remote_ip}` (repeatable) | — | `ipsec.selector.default-any`, `ipsec.selector.v1-multi` | — | side 4: *"Default selector is 0.0.0.0/0… Peers that build one SA per subnet pair reject it outright."* |
| **11** | **#1** *the tunnel interface* | `LogicalUnit st0.N` + `Address` | next free `st0.N`, `/30` from a reserved block | `st0.address-absent` | already bound | side 1, plumbing #1 |
| **12** | **#2** *st0 into a zone* | `ZoneMember` edge | existing `VPN` zone if one | `st0.no-zone` | — | plumbing #2 |
| **13** | **#3** *let IKE reach the box on the WAN zone* | `ZoneMember.host_inbound += ike` on the external interface's zone | — | (already armed at step 3) | already present | plumbing #3, and side 4 *"Things that bite"* |
| **14** | **#4** *route the remote prefix at st0* | `StaticRoute{ prefix: TS.remote_ip, next_hop: st0.N }` | derived from step 10 | `route.remote-prefix-absent` | — | plumbing #4 |
| **15** | **#5** *policy for the zone pair, each direction* | `SecurityPolicy` ×2 | `match any/any/any then permit`, both directions | `policy.any-any`, `policy.reverse-absent` | — | plumbing #5 |
| **16** | *Should the tunnel be up before there is traffic?* | `IpsecVpn.establish_tunnels` | `immediately` | `ipsec.establish.both-on-traffic`, `ipsec.establish.both-responder-only` | — | side 3: *"`on-traffic`… an idle backup cycles in the log by design"*; *"Both ends `on-traffic`, or both `responder-only`. Nobody initiates, nothing is misconfigured, tunnel never comes up."* |
| **17** | *Do you want the tunnel to fail over when it stops passing traffic?* | `IpsecVpn.vpn_monitor` | on, with `source-interface` = LAN unit | `vpn-monitor.no-source`, `vpn-monitor.target-outside-selector` | no dynamic routing over `st0` and no monitored service | side 3, *Fake flaps* |
| **18** | *MTU and MSS* | `LogicalUnit st0.N.mtu`, `Device.tcp_mss_ipsec_vpn` | `1400`, `1360` | `mtu.mss-clamp.absent`, `mtu.all-tcp-blast-radius` | — | side 4: *"Rule of thumb: MSS = tunnel MTU − 40… 1400 MTU → clamp 1360"* |
| **19** | *Review* | nothing | — | all | never | side 1, Bring-Up Order |

Nineteen steps, of which 6, 17 and often 13 are skipped, so the modal run is about **fifteen
questions**. Steps 11–15 render as the card's numbered plumbing block, ordinals as content, and
the section head reads `T H E   F I V E   P L U M B I N G   P I E C E S`.

#### 6.3.1 What step 19 produces

Not a "success" screen. The run's final step switches the canvas to `config · ChangeSet` with:

1. `commit confirmed 5` as line 1 (`18` §5.5),
2. the change set for the whole run, in emit order, risk-labelled,
3. the verification ladder pruned to what this change actually touched (`18` §4.5) — for this
   task that is the card's Bring-Up Order, steps 2 through 9, with `show security ipsec
   inactive-tunnels` present because it is `next_if_bad` for step 3,
4. the rollback (`18` §5),
5. the change ticket (`18` §6), as one copyable block.

The imperative line on that screen is the card's own: `STOP AT THE FIRST FAILURE`.

### 6.4 Findings inline, not at the end

This is the flagship behaviour inside the flagship view and it is worth being precise about,
because "findings inline" is easy to say and easy to implement as "findings at the end, but
drawn earlier".

**The mechanism is `Step.arms`.** A rule becomes checkable at the earliest step after which its
condition is decidable. Not at the end, and not before — a rule that fires against a field
nobody has been asked about yet is a rule firing against `Presence::Unknown`, which `11` §9.3's
four-valued evaluation returns `Unknown` for, not `Fires`.

**The worked case, and it is the best one on the card.**

Step 3 asks *"which interface do the IKE packets leave by?"*. The user answers `reth0.0`. At that
instant the graph knows:

- `IkeGateway.external_interface → LogicalUnit reth0.0`
- `reth0.0` is a member of `Zone WAN` (from an earlier paste, or from step 3's own node pick)
- `Zone WAN`'s `host_inbound_traffic.system_services` does **not** contain `ike`

`zone.host-inbound.ike-missing` fires. The step, still open, grows a note block underneath the
answer:

```
  ▌ WHAT WILL HAPPEN IF YOU STOP HERE                    zone.host-inbound.ike-missing
    Zone WAN does not allow inbound IKE on reth0.0. The box will drop the
    peer's IKE before it is processed. Phase 1 times out with nothing useful
    in the log — you will spend the afternoon on proposals that are correct.

    fix now:  set security zones security-zone WAN interfaces reth0.0 \
                host-inbound-traffic system-services ike            CHANGES CONFIG
    or:       step #3 of the plumbing, later in this walkthrough
    acceptable when: the peer's IKE arrives on a different interface than the
                     one you are sourcing from — rare, and you would know.
                                                          [ fix now ]  [ later ]
```

Three properties of that block are the design:

| Property | Why |
|---|---|
| It appears **sixteen steps before** the plumbing step that fixes it | Because that is when it became true. The card puts this exact failure in *Things that bite* and says *"Check this before touching crypto"* — the walkthrough enforces the card's own advice by ordering the *finding*, not the *step* |
| `[ later ]` is a first-class answer that **links the finding to step 13** | The finding does not disappear; it moves to a `deferred` list rendered in the step-13 row, so the walkthrough's own list shows the debt |
| The `acceptable_when` is on screen, not behind a disclosure | Invariant 8, and brief §5.2: *"tools that flag everything as critical are muted within a week"* |

**Which findings interrupt and which do not:**

| Finding | Where it renders |
|---|---|
| Fires against a node in the run's closure, and its rule is in `Task.armed_rules` | Inline, in the step, as above |
| Fires against the closure, rule not armed by this task | The view band's findings count increments. No interruption. The walkthrough is not a general lint session |
| Fires elsewhere in the graph (a paste ten minutes ago made another device worse) | Findings view only. **Never** inside the walkthrough |
| Fires and then clears because the next answer fixed it | Removed with no animation, no "resolved" state, no strike-through. `12` §7.2's rule: *"no flash, no reorder animation, no 'new' badge"* |

**Timing.** The finding evaluation runs on step answer commit, which is a field commit, so
`44` B7 applies: 16.7 ms end to end for findings on the edited node. The inline block is
therefore in the same frame as the answer being accepted. There is no spinner and there is no
"checking…" state, because there is nothing to wait for.

### 6.5 Going back

The walkthrough is **a list, not a wizard**. Every step is on the sheet; the current one is
expanded and the rest are one-line rows:

```
   ✓  #1   which box                         SRX-A                    hand · just now
   ✓  #2   far end address                   203.0.113.10             hand · just now
   ✓  #3   IKE leaves by                     reth0.0                  hand · just now
          ▌ zone.host-inbound.ike-missing · deferred to #13
   ✓  #4   IKE version                       v2-only                  default accepted
 ▸    #5   Phase 1 crypto                                             ← you are here
      #6   peer identity                     — skipped, peer is static
      #7   dead peer detection                                        blocked · needs #5
      …
```

| Gesture | Behaviour |
|---|---|
| Click a completed row, or `[` | Expands it in place. **Later answers are not discarded.** The cursor moves; the run's `answered` map is untouched |
| Change an answer on a revisited step | Produces a new transaction. Downstream steps whose answers *depended* on the changed value are marked `stale · was derived from #5` and the row shows both values. They are **not** auto-recomputed |
| `]` or click ahead | §6.6 |
| `Esc` | Collapses the expanded step; cursor unchanged |

**Why later answers are not discarded, and what it costs.** A wizard that resets everything after
the step you edited is the single most-hated interaction in configuration software, and the
reason it exists is that the alternative — a partially inconsistent state — is harder. Fathom can
afford the harder thing because it has a rule engine: an inconsistency after a back-edit is a
finding, and findings are the product. The cost is that a user can leave a run in a state where
step 14's route points at an `st0.N` that step 11 no longer creates, and the only thing telling
them is a finding. That is a real cost and it is the right one.

### 6.6 Skipping ahead

Two kinds of forward motion, and they must not be confused.

| Kind | Behaviour |
|---|---|
| **Skip a step** (`S`) | Records `SkipReason::UserSkipped`. The step's fields stay `Unknown`. Any rule that needed them stays `Unknown` (not `Passes`) — `11` §9.3. The row reads `— skipped`, and step 19's review lists every skip |
| **Jump to a step** (click, or `]` repeatedly) | Moves the cursor. Steps in between are neither answered nor skipped; they read `not yet` |

A step whose `blocked_until` is unmet **can still be opened** — you can read its question, its
explainer at any depth, and its default — but its input is disabled and it carries the margin tab
`blocked · needs #5`. This matters: the most common reason to jump ahead is to find out what the
walkthrough is going to ask, and a wizard that refuses to show you is a wizard you leave.

`blocked_until` is kept minimal on purpose. In the SRX task only three steps have it: #11 (needs
the traffic selectors from #10 to size the `/30`... it does not, actually — it needs nothing;
corrected: #14 needs #10 and #11, #15 needs #12, #17 needs #11). Everything else can be answered
in any order. **A task author who blocks everything has written a wizard.**

### 6.7 Leaving and returning

**The walkthrough writes to the graph as you go.** There is no staging buffer, no draft, no
"apply at the end".

| Consequence | Detail |
|---|---|
| Leaving loses nothing | Switch to config, to findings, to the finder, close the tab after a save — the answers are graph values with provenance |
| Returning is free | `⌥2` returns to the run at its cursor. If several runs are `Active`, the view band reads `walkthrough · 2 runs` and the view opens on a two-row picker, not a modal |
| **A half-finished run leaves a half-valid graph** | It fires findings. `L1` (referentially closed) fails; `L2` (emittable) fails with a blocker list. This is correct and it is visible |
| Parking | `⌥P` on a run sets `RunState::Parked`. Parked runs stop contributing armed findings inline; their findings go to the findings view like anything else. This is the release valve for "I started this and I am not finishing it today" |

**The alternative, and why it was rejected.** Staging every answer and committing at the end
gives a clean graph until the user is done. It also makes brief §6.2's central promise —
*"findings raised inline as you go"* — impossible, because findings are `lint(graph)` and a
staged answer is not in the graph. You could lint the staging buffer, which means a second graph,
a second rule evaluation path and two places for a finding to be computed. That is a second
application inside the walkthrough, which is the thing this document's governing rule forbids.

### 6.8 When the graph already has half the answer

The commonest real entry into the walkthrough is not an empty workspace. It is: *paste a config,
see findings, start the task that fixes them*. So prefill is the normal case, not an
optimisation.

**The algorithm, on run start:**

```
fn prefill(task: &Task, g: &Graph, root_hint: Option<NodeId>) -> RunPrefill {
    let root = root_hint.or_else(|| pick_or_none(g, task.root_kind));
    let mut out = RunPrefill::default();
    for step in &task.steps {
        if let Some(p) = &step.skip_when && p.eval(g, root) == True {
            out.skipped.insert(step.id, SkipReason::NotApplicable);
            continue;
        }
        match satisfaction(step, g, root) {
            // Every written field is Set or Default, from provenance that is
            // not this run.
            Satisfied { prov, fires: none } =>
                out.prefilled.insert(step.id, AnswerOrigin::Prefilled { prov }),
            // Satisfied, but an armed rule fires against the value that is there.
            Satisfied { prov, fires: some(f) } =>
                out.contested.insert(step.id, (prov, f)),
            Partial { missing } => out.partial.insert(step.id, missing),
            Unsatisfied => {}
        }
    }
    out.cursor = first_unsatisfied_or_contested(&out, task);
    out
}
```

**Complexity** `O(|steps| · |writes| )` plus one rule evaluation over the closure, which is
already computed. For 19 steps and ~40 written fields this is microseconds; the cost is entirely
in the closure lint, which is bounded by `44` B7/B8.

**The three outcomes, rendered:**

| Outcome | Row treatment |
|---|---|
| `Prefilled` | Collapsed, answer shown, margin tab naming the provenance: `parsed · 2026-07-14 · SRX-A running config`. A checkmark, not a "you did this" |
| `Contested` | **Expanded, and this is the point.** The graph has an answer *and* an armed rule fires against it. Shown as a normal step with the existing value pre-entered and the finding inline. The cursor lands on the first of these, not on the first blank |
| `Partial` | Expanded, with the known fields filled and the missing ones focused |

**The worked case.** A user pastes the field card's own Phase 1 block, which sets `IKE-P1` with
`group14`, `sha-256`, `aes-256-cbc`, `28800`, `IKE-POL`, and `GW-B` with an address and
`external-interface reth0.0` — but no `version` statement and no Phase 2 at all. Starting the
task:

- steps 1, 2, 3, 5 → `Prefilled`, collapsed, `parsed`
- step 4 (IKE version) → `Contested`: `version` is `Absent`, which on Junos means IKEv1 is
  available, and `ike.version.v1-only` fires. **The cursor starts here**, at step 4, with the
  card's IKEv1-vs-IKEv2 table as the explainer
- steps 8–10, 16–18 → `Unsatisfied`
- step 13 → fires `zone.host-inbound.ike-missing` immediately, because step 3 is already
  satisfied and the zone is already known

So a paste plus a task start puts the user at the first *decision*, not at question one. That
sequence — paste, findings, task, first real decision — is the product in four moves and it
should be the demo.

**The rule that makes prefill safe: a prefilled step is never silently accepted if an armed rule
fires against it.** Otherwise the walkthrough validates whatever was already wrong.

### 6.9 Task version drift

A run stores `task_version`. When the corpus version changes:

| Change | Behaviour |
|---|---|
| Patch (prose, explainers) | Run continues silently |
| Minor (a step added, a default changed) | Steps matched by `StepId`. New steps insert at their `ordinal` and read `new in this task version`. Changed defaults do **not** overwrite answered steps |
| Major (a step removed, a step's `writes` changed) | The run is marked `RunState::Parked` with a one-line reason and a `replay` action. Replay re-runs `prefill` against the new task with the existing graph, which recovers almost everything, because the graph — not the run — is where the answers live |

That last sentence is why the run record is small and why writing as you go (§6.7) was the right
call: the run is a bookmark, not a document.

### 6.10 What the walkthrough costs

| Cost | Honest statement |
|---|---|
| **Authoring** | 19 steps × (question + explainer triple + defaults with sources + skip predicate + armed rules) is a substantial content artefact per task. `15` §1.2 already prices the explainer corpus; tasks are on top of that. A product with four tasks is a product with four tasks — the walkthrough does not generalise |
| **Version predicates** | Brief §5.2: *"Junos syntax differs meaningfully between 15.x, 21.x and 23.x."* A task that is right on 21.4 and wrong on 15.1 is worse than no task. Every default with a version-dependent value needs `11` §5.3's sourced `Default` |
| **The half-finished graph** | §6.7 |
| **Prefill can be wrong** | Satisfaction is computed over fields, not intent. A step can be "satisfied" by values that were meant for a different tunnel. Mitigation is that the closure is rooted at the run's root node, so a second `IpsecVpn` does not prefill from the first — but two selectors on one VPN can confuse step 10 |
| **It is the slowest path to config in the product** | Fifteen questions versus a paste. It is for the case where you do not know the answers, which is the case where you should be slowed down |

---

## 7. First run — paste first

*margin tab: no empty forms*

### 7.1 The failure mode being designed against

Brief §2.2 is unusually specific: source-of-truth systems fail on data entry discipline, and
*"any design that begins with 'now model your entire estate in these forms' inherits that failure
mode."* Brief §6.3 gives the answer in one line: *"Paste is the primary on-ramp for inventory.
Never an empty form."*

And `design-language.md` closes the door on the usual escape hatch: **no empty states.** No
illustration, no "get started" card, no three-step onboarding carousel, no sample data button.

So the first-run design has one job: **get from zero to an opinion about the user's own network
without asking for anything.**

### 7.2 Screen by screen

#### Screen 0 — the finder, working, with nothing loaded

There is no welcome screen. The application opens on the finder at full canvas (§3.2.2) with the
input focused and the index already mounted (`44` B2: `Ctrl+K` armed at 350 ms P95).

```
├ 3px ink rule ──────────────────────────────────────────────────────────────────┤
   VIEW 1 OF 6 · FINDER                                       no workspace open
   F A T H O M
   COMMAND FINDER · SRX IPSEC · JUNOS · PANOS · IOS-XE
   VERIFY AGAINST YOUR OWN BOX BEFORE ACTING
├ 1px rule ──────────────────────────────────────────────────────────────────────┤
   READ-ONLY — SAFE ON PRODUCTION   CHANGES CONFIG — NEEDS A COMMIT   DISRUPTIVE …
├ 1px hairline ──────────────────────────────────────────────────────────────────┤

   ┌──────────────────────────────────────────────────────────────────┐  Ctrl K
   │ is the tunnel up                                                 │
   └──────────────────────────────────────────────────────────────────┘

   READ-ONLY   show security ipsec security-associations
               Is Phase 2 installed and passing traffic?
               read: State — want Installed
               if that is bad → show security ipsec inactive-tunnels
   …

├ 1px hairline ──────────────────────────────────────────────────────────────────┤
   #1  paste a config anywhere on this page          nothing leaves this machine
   #2  build one instead                             guided walkthroughs · 4 tasks
   #3  open a workspace file                         .fathom
├ 1px rule ──────────────────────────────────────────────────────────────────────┤
   VIEW 1 OF 6 — FINDER                                     offline · no egress
```

Three doors, as the card's numbered plumbing — ordinals as content, not as `<ol>` chrome. No
buttons with icons, no cards, no hero.

**The whole of screen 0 is a working product.** Brief §6.1: *"zero setup, zero data entry, zero
trust required, because it is read-only reference content."* A user who never does anything else
has still got value, and that is the wedge.

#### Screen 1 — paste anywhere

A `paste` handler on `document`. Not a drop zone, not a "click to upload", not a textarea you
have to find. If the clipboard contains something that lexes as a config (`14`'s shape stage), the
sheet becomes the ingest preview. If it does not, the paste goes to the finder input, because the
other thing people paste is a command they do not recognise (brief §6.1, the reverse query
shape).

```
├ 3px ink rule ──────────────────────────────────────────────────────────────────┤
   INGEST                                                      1 842 lines · 61 ms
   W H A T   W A S   I N   T H A T
   DETECTED junos-srx · SET FORMAT · CONFIDENT
   NOTHING HAS LEFT THIS MACHINE AND NOTHING HAS BEEN SAVED
├ 1px rule ──────────────────────────────────────────────────────────────────────┤
   READ-ONLY …  CHANGES CONFIG …  DISRUPTIVE …
├ 1px hairline ──────────────────────────────────────────────────────────────────┤

  ▌ RECOGNISED                          ▌ NOT RECOGNISED                    17 lines
    1 Device        SRX-A                 set system scripts op file …           ×3
    14 Interface    ge-0/0/0 … reth1       set services application-ident …      ×9
    38 LogicalUnit                         set groups NODE0 …                    ×5
    4 Zone          TRUST VPN WAN DMZ
    2 IkeGateway    GW-B GW-C              these are kept verbatim in the
    2 IpsecVpn      VPN-B VPN-C            workspace and re-emitted unchanged.
    9 SecurityPolicy                       they are not modelled, so no rule
    22 StaticRoute                         and no explainer applies to them.

  ▌ REDACTED BEFORE PARSING                                              4 lines
    line 412   set security ike policy IKE-POL pre-shared-key ascii-text "•••"
    line 418   set security ike policy IKE-POL2 pre-shared-key ascii-text "•••"
    line 903   set snmp community "•••"
    line 1204  set system root-authentication encrypted-password "•••"
    The application never accepts a credential. These values were discarded in
    the parser, before the graph existed. They are not in memory and they will
    not be in the file.

├────────────────────────────────────────────────────────────────────────────────┤
   [ keep this ]        [ discard ]            keeping creates a workspace in memory
```

The redaction block is not a nicety. Invariant 3 says the application never accepts a credential;
a security-first tool that silently drops four lines of the user's paste and says nothing has
asked to be trusted without showing its work. **Showing exactly which lines were dropped, with
their line numbers and their statement paths, is the cheapest trust-building move in the
product.**

#### Screen 2 — keep

`[ keep this ]` creates a workspace **in memory**. No passphrase, no filename, no account, no
dialogue.

The masthead's imperative line becomes, and stays:

```
   UNSAVED · IN MEMORY ONLY · NOT YET ENCRYPTED
```

**DECISION — the passphrase is asked for at first save, not at first value.** The alternative —
unlock before you can do anything — puts a key derivation (one second, `32` §4.2) and a security
decision between a user and the first thing they wanted to see. `44` §4.8.4 makes the same
argument from the other end: *"the latency is a security parameter; it is just one nobody
measures."*

**The cost is real and must be surfaced, not mitigated away:** an in-memory workspace dies with
the tab. Controls:

| Control | Detail |
|---|---|
| The imperative line, always, in caps | It is the most prominent text on the sheet after the view name |
| `beforeunload` | The **only** browser-native dialogue this product uses. It is not ours, it is not styleable, and it is the correct tool for exactly this |
| The footer state | `unsaved · 4 edits` from the first edit onward |
| A margin tab at 10 minutes | `unsaved for 10 minutes` — muted, in the masthead tab row. Not a toast, not a nag, not growing more urgent |
| Never | An autosave to `localStorage`. `34`'s hardening and `32`'s posture both forbid plaintext at rest, and an "encrypted with a key we made up" autosave is worse than none |

#### Screen 3 — findings, not the diagram

**DECISION — the sheet lands on findings after an ingest.**

The obvious choice is the diagram: it is the impressive one. It is also the one that tells the
user something they already know — they know their own topology. Findings on their own config, in
under a second, is the moment the product does something they could not do themselves.

```
   VIEW 4 OF 6 · FINDINGS                     3 high · 11 med · 6 low · 0 suppressed
   F I N D I N G S
   SRX-A · PARSED 2026-07-28 · junos-srx 21.4R3-S2
   CONTINUOUS LINT OVER THE GRAPH — NOT A REPORT YOU RUN
```

with the first finding expanded, and — if the corpus has a task for it — a `[ walk me through
fixing this ]` action that starts a walkthrough pre-seeded and prefilled (§6.8). That is the
whole funnel: paste → opinion → guided fix, in three interactions and no forms.

#### Screen 4 — first save

Triggered by `Ctrl+S`, by `[ save ]` in the footer, or by `beforeunload`'s escape hatch. One
sheet, not a modal:

```
   S A V E   T H I S   W O R K S P A C E
   THE PASSPHRASE NEVER LEAVES THIS MACHINE AND CANNOT BE RECOVERED
   ┌──────────────────────────────────────────────────────────────────┐
   │                                                                  │
   └──────────────────────────────────────────────────────────────────┘
   six words from a generated list beats a sentence you invented
                                          [ suggest six words ]

   ▌ WHAT HAPPENS WHEN YOU PRESS SAVE
     A key is derived from this passphrase. On this machine that takes about
     one second and that is deliberate. The file is written encrypted; the
     passphrase is not stored anywhere, and there is no recovery, no reset,
     and no support path. If you lose it the workspace is gone.
```

`32` §4.7's conclusion — passphrase strength dominates everything else — is stated here, once,
in the one place a user is making that decision.

### 7.3 The three other entry shapes

| Entry | First screen |
|---|---|
| **Opening an existing workspace** | The unlock sheet. Key-independent boot runs while the field has focus (`44` §4.8.3 move 1), so the passphrase is the only wait |
| **Starting from a walkthrough with nothing** | Task picker → step 1 creates the `Device`. This is the "empty form" path and it is *offered third*, not first, on purpose |
| **A shared link to a corpus entry** | §10.3. Opens the guidebook sheet with no workspace, which is screen 0 with a different body |

### 7.4 What first-run deliberately does not do

| Not | Why |
|---|---|
| A tour, a coach mark, a tooltip sequence | The card has no chrome and neither does this. A product that needs a tour has an IA problem the tour is hiding |
| Sample data | A user who explores sample data learns a fictional network. The finder is the sample data and it is real |
| An account | There is no account until there is sync, and sync is opt-in (`33` §3) |
| Ask for a device name, a site name, or a "project name" | Every one of those is a form before a value |
| Progress indication of any kind | `design-language.md`: no progress bars. Ingest is 69 ms at 5,000 lines (`44` B9) |

---

## 8. Where the AI layer lives

*margin tab: not a sidebar*

### 8.1 The rejected model

A chat panel down the right-hand side is the default answer in 2026 and it is wrong here for four
reasons, none of them stylistic.

| Reason | Detail |
|---|---|
| **It makes prose the product** | `21` §2.2 removes *narrate* from the AI layer's verb set on purpose: *"Prose is the thing models are best at and the thing this product least needs from them."* A chat panel is a prose-shaped hole and it will get filled |
| **It separates the proposal from the thing it changes** | A diff in a chat bubble is a diff you review out of context. `21` §2.5 already specifies the review card in the field card's idiom — the remaining question is *where it sits*, and the answer must be "against the node it changes" |
| **It creates a second navigation model** | Conversation scrollback is a history you navigate by scrolling. The product's history is the provenance chain and the audit log. Two histories is two products |
| **It costs 30 % of the canvas permanently for something used occasionally** | Same arithmetic as the left rail (§2.1), for a feature that `21` scopes to three query shapes |

### 8.2 DECISION — the AI is an action on nodes, and its output renders in place

Three sentences define the whole surface:

1. **You invoke it from something.** There is no blank prompt. Every invocation carries a subject:
   a node, a finding, a selection, a failed parse, a step.
2. **Its output is a `Proposal` attached to that subject**, rendered by the view that owns the
   subject, in that view's idiom.
3. **There is no AI view, no AI panel and no AI history pane.** There is a count in the view band
   and a filter.

### 8.3 The four in-place renderings

One `ProposalId`, four renderings — which is §5's selection model applied to proposals, and it
works for exactly the same reason: the proposal references `ElementId`s, never renderings.

| View | Rendering |
|---|---|
| **inventory** | The proposal card (`21` §2.5's layout, verbatim) as an expansion **directly under the affected row**, pushing rows down. Multi-node proposals expand under the anchor row and put a 1px bar on the others |
| **config** | Proposed lines interleaved with real ones in the affected block, in the diff gutter idiom (`~`, `+`, `−`), muted, with the block header carrying `proposed · not emitted`. **The lines are not copyable** until accepted — `53` §6.6 makes this explicit, because a proposed line that can be copied into a terminal has defeated the entire proposal mechanism |
| **diagram** | Proposed nodes and edges drawn with a 1px dashed stroke in muted ink; existing elements the proposal changes get a 1px muted ring. No colour — the risk palette is reserved |
| **walkthrough** | A pending step inserted at the cursor, reading `proposed · constraint.negotiator`, answerable like any step but with the accept semantics of a proposal (per-op checkboxes, `21` §2.5.1) |

In all four, the **objections block is never collapsed** (`21` §2.5: *"rendered with the proposal,
never suppressed, never summarised"*), and the risk badge is the risk of the *emitted lines the
change would produce*, computed by the real emitter against a shadow graph.

### 8.4 The invocation surface

**There is one, and it is the finder.** `Ctrl+K` already carries the property the AI needs: it is
one keystroke from anywhere and it already knows the current selection (`16` §16, context
awareness).

| Path | Behaviour |
|---|---|
| Query returns results above cutoff | Deterministic finder results. **The AI is not offered.** `21` §3 (*prefer the deterministic path*) is enforced at the interface, not only in the supervisor |
| Query returns nothing above cutoff | The miss state (`16` §19.5) gains one line: `ask the supervisor · 2 subagents · no egress (tier 3)`, or at tier 1, `ask the supervisor · sends an excerpt to api.example.internal`. Named endpoint, always, in the affordance itself |
| Explicit scope `@ai` | Available always, for the user who knows what they want |
| From a finding | `[ why is this hard to fix here ]` on a finding whose `acceptable_when` might apply — `21` §1.1's *constrained construction* shape |
| From a failed parse | The ingest screen's `NOT RECOGNISED` column gets `[ what are these ]` — `21` §1.1's *unrecognised text* shape |
| From a selection of several nodes | `[ why does this not work ]` — the *multi-node synthesis* shape |

Notice what is absent: a floating button, a sparkle icon, a corner affordance, an "Ask AI"
placeholder in every input. `design-language.md`: no icons, no logos, no illustrations.

### 8.5 The egress strip

At tier 1 (egress to a named endpoint), a 1px strip sits **above the 3px masthead rule** — the
only element in the product above that rule. It reads:

```
▲ this workspace may send graph excerpts to api.example.internal · 3 requests this session · what was sent
```

It is not dismissible. `what was sent` opens the AI audit log (`17` §11) as a sheet. In tiers 2
and 3 (local model, no egress) the strip is absent entirely — not present-and-green, absent. A
persistent "you are safe" banner trains people to ignore the strip that matters.

### 8.6 Counting

The view band gains a conditional tab: `proposals · 2 pending`, present only when there are any.
Selecting it applies a **filter** to the current view — showing only the elements a proposal
touches — rather than switching to a proposal view. That is the difference between "the AI is a
lens on your work" and "the AI is a place you go".

`21` §15's failure mode 5 (*proposal storms*) is bounded here too: **at most one proposal card is
expanded at a time**, and the band's count is the only thing that grows.

---

## 9. Information scent

*margin tab: where am I, what is hidden*

### 9.1 The problem

Six views, one canvas, one at a time. Two questions must be answerable without moving:

1. **Where am I?**
2. **What is out of sight, and does it matter?**

The conventional answers are breadcrumbs and badges. Both are forbidden here — breadcrumbs
because there is no hierarchy to trace (there is one graph and six views over it), badges because
a badge is a coloured dot and the only colours in this product mean `ReadOnly`, `ChangesConfig`
and `Disruptive`.

The card answers both questions already, and it does it with three devices: **`SIDE n OF 4`**,
**margin tabs**, and **dense headers**.

### 9.2 `VIEW n OF 6` — top and bottom

The masthead eyebrow reads `VIEW 3 OF 6 · FINDINGS`. The footer rule reads `VIEW 3 OF 6 —
FINDINGS`, with the neighbours and their keys. This is the card's `SIDE 1 OF 4 — BUILD, PROVISION,
PLUMB`, unchanged, and it is a better "you are here" than a highlighted nav item because it also
tells you **how many there are** and **that they are ordered**.

The order is fixed and never reorders: `finder · walkthrough · config · findings · diagram ·
inventory`. It is the order of the workflow — look it up, build it, read it, check it, see it,
file it — and a fixed order means muscle memory for `⌥1`–`⌥6`.

### 9.3 The view band

One row of margin tabs under the legend. Lowercase, unpunctuated, muted, italic — exactly the
card's `read this first` / `most-missed` treatment. Current view in ink, not boxed and not
underlined; the `▸` marker is a character, not a shape.

```
   finder   walkthrough · 4 of 19   config · 214 lines · 2 blocked   ▸findings · 3 high
   diagram · 12 nodes · L3   inventory · 2 devices · 1 observation   proposals · 2
```

**Every tab carries its own state, and the state is the scent.**

| View | What its tab says | Why that number |
|---|---|---|
| finder | nothing, or `finder · 3 recent` | It has no state worth counting |
| walkthrough | `4 of 19`, or `2 runs`, or nothing | Progress is the only thing you want to know from outside |
| config | `214 lines`, `+ 2 blocked` if L2 fails, `change set · 14 lines` in `ChangeSet` mode | Blockers are the reason you would go there |
| findings | `3 high` — the worst severity and its count only | A tab that reads `3 high · 11 med · 6 low · 4 suppressed` is a table, not a tab |
| diagram | `12 nodes · L3`, or `aggregated` above 2,000 elements | The layer is state you will forget you set |
| inventory | `2 devices`, `· 1 observation` when a population rule has an opinion | §3.7.1 |
| proposals | `2` | Conditional; absent when zero |

**Three rules on the counts:**

1. **No count is ever a colour.** Not red for high findings, not green for zero. The risk palette
   is reserved and a fourth palette is forbidden.
2. **A count that has changed since you last looked at that view is set in bold ink; everything
   else is muted.** Weight, not colour — the same treatment finding severity uses (§3.5.1). This
   is the "something happened over there" signal and it costs one CSS class.
3. **No tab shows more than two facts.** The band is a scent, not a report. If a view needs three
   numbers to describe its state, the third belongs in that view's header.

### 9.4 The selection ribbon

One muted line between the band and the body, present only when something is selected:

```
   selected: IkeGateway GW-B · 6 lines in config · 2 findings · 1 node in diagram · not in L2
```

This is the through-line made visible and it does four things at once: names the anchor, states
its kind, tells you the selection exists in views you cannot see, and — the important part —
names where it *does not* exist (`OffscreenReason`, §5.5). Each fragment is a link.

With a multi-selection it reads `selected: 11 nodes · anchor IkeGateway GW-B · 3 of 11 filtered
out`.

### 9.5 What is forbidden, and what replaces it

| Forbidden | Replacement |
|---|---|
| Breadcrumbs | `VIEW n OF 6` plus the ribbon. There is no hierarchy to breadcrumb |
| Badges (coloured pills with counts) | Counts as plain text in the band, weighted not coloured |
| Notification dots | Bold weight on a changed count |
| Toasts | The footer line, for 1.6 s (`53` §6.5) |
| A "recently viewed" list | The finder's recents, which already exist (`44` §4.2) |
| Tab close buttons | There is nothing to close |
| An overflow menu | Six views fit. If a seventh is ever added, this design has a real problem and an overflow menu would be hiding it |
| Icons of any kind | Words. `design-language.md`: *no icons* |

### 9.6 The scent budget

A rule for reviewers, stated as a number so it can be enforced: **the furniture above the body
carries at most 14 discrete facts.** Currently: view ordinal, view name, one masthead statistic,
title, subtitle (3 facts: device, workspace, platform version), imperative, 3 legend entries, 6
band tabs, 1 ribbon. That is at the ceiling. **Adding a fact to the header means removing one**,
and the review question for any addition is "which fact does this replace".

Without a budget, headers grow. The card's header does not grow, because it is printed.

---

## 10. State, routing and deep links

### 10.1 The three tiers of state

| Tier | Examples | Lives | Survives |
|---|---|---|---|
| **Workspace** | graph, suppressions, walkthrough runs, diagram layout, settings | the encrypted document (`17`) | everything; syncs |
| **Session** | selection, current view, split state, scroll positions, explainer depth override, finder recents | memory | view switches; **not** a lock, **not** a reload |
| **Ephemeral** | the finder query, an open explainer, a hovered row | memory, discarded on close | nothing |

The line between workspace and session is drawn at one question: **would a colleague opening this
workspace want it?** Diagram layout: yes (a picture nobody laid out is unreadable). Selection: no
(§5.7). Explainer depth default: yes, it is a settings value. The current view: no.

### 10.2 Scroll position

Per view, per session, keyed by `(ViewId, primary_object)`. Returning to a view returns to where
you were, unless the selection changed while you were away and §5.6.4's conditions fire.

### 10.3 Deep links, and the disclosure problem

**DECISION — the URL never contains graph data, and by default it contains nothing at all.**

A URL is the most-copied, most-logged, most-pasted string a browser produces. `17`'s governing
rule applies with full force: *"a filename is plaintext… everything you name, count or touch, you
disclose."* `fathom.example/#/device/SRX-A/ike-gateway/GW-B` in a support ticket is a topology
leak, and in mode A there is no URL at all because the document is `file://`.

| Link kind | Form | Contains |
|---|---|---|
| **Corpus link** (default, always available) | `#/c/junos-srx/ipsec.sa.show` | A corpus ID. Public content, ships in every artifact, discloses nothing about the user |
| **View link** | `#/v/findings` | A view name |
| **Workspace-local link** | not a URL | `Ctrl+L` copies a `fathom:node:<ulid>` reference — an opaque ULID, meaningless without the workspace. Pasting one into the finder navigates to it |
| **Sharable node link** | **does not exist** | Deliberately. There is no server-side workspace to resolve it against (`33` §1.2) and no way to make one that does not disclose |

The cost: you cannot send a colleague a link to a finding. You send them the finding — `53` §6.4
makes a finding copy into a paste-ready block with its rule ID, which is the artefact a ticket
actually wants.

---

## 11. Failure modes of this architecture

| # | Failure | How it shows up | Control | Residual |
|---|---|---|---|---|
| 1 | **A view accretes private state** | A filter in the diagram that findings cannot see; a sort in inventory the config ignores | The `View` trait's three functions, and a review rule: new state is either workspace, session (§10.1) or a bug | Real. This is the failure this document exists to prevent and it will be attempted every quarter |
| 2 | **Selection link silently breaks** | Click a node, switch view, nothing highlights; users stop trusting the link and stop switching | `OffscreenReason` (§5.5) forces every view to *say* why it cannot show something. Dev-build assertion: `resolve` returning an empty highlight with `offscreen: None` for a live element panics | Moderate |
| 3 | **The walkthrough becomes the product** | Everything routes through tasks; the graph is only reachable through a wizard | The walkthrough writes ordinary ops and creates ordinary nodes. Anything it can do, inventory and diagram can do | Low |
| 4 | **The sheet's furniture grows** | Header creeps to 300 px; density dies | §9.6's budget of 14 facts | Moderate — this always happens |
| 5 | **The split becomes mandatory** | Users work permanently in 50/50 and every view is designed for half a screen | The split is off by default, off below 1100 px, and capped at two | Low |
| 6 | **Six views become five plus a graveyard** | Nobody opens the diagram because it aggregates above 2,000 elements | Honest: `44` §4.7.4 already accepts this. The band's count makes disuse visible | Real, and it is a scope question, not an IA one |
| 7 | **AI proposals colonise the canvas** | Every view is full of dashed ghosts | One expanded proposal at a time (§8.6); the band count is the only growth | Moderate |
| 8 | **First-run paste fails on a config we cannot parse** | The best on-ramp dead-ends | The ingest screen's `NOT RECOGNISED` column is a first-class part of screen 1, with the AI's *unrecognised text* path (§8.4) and an export-the-miss action (`16` §3.6) | Real. `14` owns the parser coverage question |
| 9 | **Two views disagree about the anchor** | Masthead says one thing, ribbon says another | One `Selection`, one `epoch`, one owner (the shell). Views never write it except through `select_at` | Low |
| 10 | **A user never finds a view** | Never opens findings; concludes the product does not lint | `VIEW n OF 6` states there are six; the band names all six with counts; first run lands on findings (§7.2 screen 3) | Moderate |

---

## 12. Open decisions

| # | Decision | Options | Leaning |
|---|---|---|---|
| **D1** | **Does the walkthrough belong in the view band at all**, given it is a controller and is empty most of the time? | (a) always a tab (b) a tab only when a run exists, and otherwise reachable only from the finder and from findings | Leaning (a). An empty walkthrough tab is how a user discovers tasks exist, and §7.2's door #2 is not enough on its own |
| **D2** | **Whether `ChangeSet` should be reachable as `⌥7`** — a seventh key for a mode, without being a seventh view | (a) mode only (b) mode plus its own key | Leaning (b). It costs one binding and it is the artefact people are trying to reach when they open the product on a change night |
| **D3** | **Whether inventory bulk-edit is in v1 at all.** `33` §7.4 is emphatic about bulk actions and merge semantics | (a) v1 with a per-row confirm list (b) defer | Leaning (b) for the first release. The failure mode of a bad bulk edit across a sync merge is unpleasant and `53` §7's undo cannot fully repair it |
| **D4** | **Whether the split may hold two instances of the same view** (config `Full` next to config `ChangeSet`) | (a) yes (b) no | Leaning (a) — it is the change-night layout and it costs nothing structurally, since panes hold `(ViewId, mode)` not `ViewId` |
| **D5** | **Where diagram layout lives when two people edit concurrently.** It is workspace state, so it merges; two people dragging the same node is a class B LWW field (`33` §6.4) and that is probably fine | (a) LWW (b) per-user layout overlays | Leaning (a), with a VERIFY on whether "my colleague moved my boxes" is a complaint that arrives |

---

## 13. Sources consulted

| Source | Used for |
|---|---|
| `.context/owner-brief.md` §1, §2.2, §4.1, §5.4, §6.1–6.7 | The six projections, paste-first, the walkthrough's promise, depth toggling |
| `.context/design-language.md` | Every layout in this document: masthead grammar, margin tabs, the 4px bar, the one-line imperative, numbered plumbing, what the card never does |
| `.context/field-card-srx-ipsec.txt`, sides 1–4 | §6.3's entire question sequence, §6.4's worked finding, §3.4.2's explainer text, §3.5.2's ordering |
| `.context/conventions.md` | Terminology, the three-value risk enum and its non-reuse, invariants 1, 3, 5, 6, 7, 8 |
| `10-core/11-ir-schema.md` §5, §8.7, §9.1–9.2, §10.5, §10.6, §13 | `Presence`, `ElementId`, `FieldRef`, emit units and closures, L0–L3, tombstones, rename survival |
| `10-core/13-emitters-and-provenance.md` | `EmittedLine`'s `source_node` / `source_fields` — the entire narrowing story |
| `10-core/15-explainer-corpus.md` §3, §4, §5.6 | The explainer resolution ladder, the three depths, the misdiagnosis index |
| `10-core/16-command-finder.md` §16, §17, §19 | Context awareness, answer-shaped results, the finder's keymap and miss state |
| `10-core/18-diff-verify-rollback.md` §3, §4.5, §5, §6 | `ChangeSet` mode's content and ordering |
| `20-ai/21-ai-layer-architecture.md` §1.1, §2.2, §2.5, §3, §15 | The three query shapes, the verb set, the proposal card, proposal fatigue |
| `30-security/33-sync-protocol.md` §5.1, §7 | Ops, and the presentation rules for conflicts that §9's neutrals follow |
| `40-stack/44-performance-budgets.md` §3, §4.2, §4.4, §4.7 | Every latency figure; the diagram's element ceiling and aggregation behaviour |
| `design/prototype/index.html` | The token set and the view-band idea this document formalises |

---

## 14. Disagreements

None with the conventions.

One **proposed change** to a sibling document, raised here because it is an IA consequence:

**`44` §3 should adopt budgets S1–S5 (§5.6.3).** Selection propagation is currently unbudgeted,
and it is the single most frequent non-typing interaction in the product. An unbudgeted
interaction that runs forty times a minute is the one that will be slow.

One **noted tension** with the owner's brief, resolved rather than disagreed with: brief §1 names
six projections and this document's shell has six views, and they are not the same six (§1.1).
Nothing in the brief says they must be. The mapping is stated in full so that a reader holding the
brief can follow it.
