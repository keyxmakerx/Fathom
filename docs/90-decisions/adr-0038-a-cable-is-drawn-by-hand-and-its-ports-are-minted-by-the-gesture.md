# ADR-0038 — A cable is drawn by hand, and its ports are minted by the gesture

> **Status:** Accepted — decided by the orchestrating session on 2026-08-29 under the owner's
> same-day delegation (*"I'm good with your decisions, you are the orchestrator for the day"*),
> executing the design the owner specified in `57` §12 and the answer he gave on 2026-08-28
> (*"absolutely, one of the main features is to be able to create essentially a lucid chart with
> no information, then a user can go in and fill in info as needed"*, `70` §18.3). Binding once
> built (CLAUDE.md rule 3); reopenable on merit (`75` §2).
> **Date:** 2026-08-29.
> **Register entry:** none — `57` §12 is full design, not an intent stub.
> **Reversal cost:** R2. Nothing in `schema/` changes: `Cable`, `Terminates`, `PhysicalPort`,
> `HasPort`, `HasCable` and `HasChassis` are all declared already. Reversal retires one opcode,
> one layout derivation, two inventory rows and a sheet; every cable and port written meanwhile
> stays a valid graph any build can read.
> **Supersedes:** `57` §14.1 row B3 (open → answered); amends `57` §12.4's mechanism claim and
> reconciles `57` §12.1 with the shipped schema (§11 below).

## Contents

| § | |
|---|---|
| 1 | The request, and what was blocking it |
| 2 | **The decision** |
| 3 | Fourteen decisions, each with what it rejected |
| 4 | The shape: `OP_CABLE`'s contract |
| 5 | What must stay true |
| 6 | What will be built |
| 7 | Cost, measured |
| 8 | Failure modes |
| 9 | Open decisions |
| 10 | Sources consulted |
| 11 | Disagreements |

## 1. The request, and what was blocking it

The owner, 2026-08-18 (`57` §12): *"drag and dropping cables … go into cabling mode … draw a
cable between one device and another, you'd prompt me when i click on the first box to indicate
where it is coming out of, but give an option for unknown or virtual … and then drag and drop,
doing the same thing with the ports on the other side."* And on 2026-08-28 the principle that
decides the hard part: an empty chart first, filled in later.

Two things blocked it. **`PhysicalPort.label` was required**, so a port whose silkscreen nobody
had read could not exist — closed 2026-08-28 (schema 0.4). And **nothing creates a
`PhysicalPort` or a `Cable`** (`57` §14.1 B3, `57` §12.3): a hand-added device has a `Chassis`
and zero ports, a pasted device has no `Chassis` at all, so the port prompt would show an
empty list on every box in the estate.

Three read-only scouts (2026-08-29) verified `57` §12 against the tree before this was written.
Their briefs are the sources in §10; two of their findings changed the design and are §3's D2
and D3.

## 2. The decision

> **A cable is a hand-drawn fact: `OP_CABLE` mints a `Cable` and its `Terminates` edges in one
> batch, and mints the `PhysicalPort` — and the `Chassis` — the gesture needs when the box has
> none. "Unknown" is a port with no label. "Virtual" is not a cable and is never written as one.
> An unknown far end is a one-ended cable, and the prompt says to label it.**

## 3. Fourteen decisions, each with what it rejected

| # | decided | rejected, and why |
|---|---|---|
| D1 | **Ports are minted inline by the gesture** (`57` §12.3 route 2). A box with no ports offers *add a port*; *unknown* mints a port with no label and no position. **B3 is closed by this row.** | Route 1 (ports arrive with the equipment form) — wrong for mixed line cards and demands answers at add time, the opposite of empty-chart-first. Route 3 (platform port complements from `platforms.yaml`) — the registry carries no port data; deferred, §9 |
| D2 | **`OP_CABLE` is a new opcode with a compound single-batch write**, modelled on `OP_EQUIP_ADD`'s batch, never on `hand_link_candidates`. | Reusing `OP_LINK` on two port ids. The only reference edge between two `PhysicalPort`s is `PassThrough` — *"these two holes are the same hole"* — and `OP_LINK`'s one-candidate rule would write it **without asking**: a patch-panel transparency recorded as a cable, silently, in an estate of record. `57` §12.4's *"same gesture"* is true of the hand and false of the write |
| D3 | **`Cable.media.virtual` stays declared; the gesture never offers or writes it.** The sheet's *"no cable — these just talk"* choice redirects to the link gesture and closes. | Removing the variant to match `57` §12.1's argument — a removed enum variant is a MAJOR bump (`62` §16.2) that makes any export carrying it unreadable, for a variant a pasted or imported plant may legitimately declare. The fiction `57` §12.1 fears enters through the *hand*, and it is closed there |
| D4 | **An unknown far end is a one-ended cable** (`Terminates` out `0..2`), and the sheet says *label it or you will never find it again* — the schema's own sentence. | A placeholder far port, or a refusal. Both invent or lose a fact the operator has |
| D5 | **A device with no `Chassis` gets one minted, silently, in the same batch** (`member_index` 0), because every pasted device has none. | Refusing to cable a pasted device, which is most of the estate |
| D6 | **`Terminates.end` is normalised by the module: A is the smaller far-end `NodeId`** (`19` §3.4), never draw order. | Draw order — the same cable drawn from either end would be two different cables |
| D7 | **The frame carries a count byte and this cut refuses any count but 1** (`ERR_CABLE_COUNT`). | A single-cable frame with no count — range cabling (`57` §12.7) would then be a wire change; a count that is refused today is a value change tomorrow, and a future N-record journal fails loudly on this build instead of truncating |
| D8 | **Removal is `OP_CABLE` mode 0: tombstone the cable AND both `Terminates` edges**; and `cabled_peer` is hardened to skip an absent cable. Both. | Generic `OP_ELEMENT_REMOVE` alone — `Graph::tombstone` cascades through containment only, so a removed cable's reference edges stay live and a device keeps showing *cabled to* a cable that is gone |
| D9 | **No reconciliation.** Pressing *add a port* twice mints two unlabelled ports; nothing merges them. Stated, as `OP_EQUIP_ADD` states it. | Guessing that two unlabelled ports are one — `identity_clash` is Device-only and a labelless, positionless port has no identity tuple to clash on |
| D10 | **The picker is a sheet, opened from a selected box at rung 1 or a selected chassis in the elevation**; the cable draws box-to-box like a link, marked. **`fathom-layout` derives the device-to-device line** from `Cable → Terminates → port → chassis → device`. A one-ended cable draws no line and lives in the Outline under its device. | Building rung 3 (the faceplate) first — nothing renders it and `data-dinto` skips it; per-port drawing is §9 |
| D11 | **Unlabelled ports render as `(unlabelled)` with a page-side ordinal in the picker**, never a bare `—`; `display_name` gains the fallback `Cable` already has. | Leaving the first unlabelled port ever minted to render as an em-dash everywhere |
| D12 | **The Escape ladder gains a rung that releases a held end** — for links and cables alike. | Shipping the existing stuck-hold gap a second time |
| D13 | **Vocabulary is derived, not translated**: the Outline row reads `cable to <port or device> · by hand`, the midpoint word is `cable · by hand`; kind names lowercased by the existing `dgWords` rule. | Inventing a display word the schema does not have |
| D14 | **`Cable` and `PhysicalPort` become inventory rows**, so the annotate-later half (`57` §13.5: *"the drag captures, the field completes"*) is the existing cell editor and not a new form. Type-to-link (`57` §13) is out of this cut. | A bespoke annotate sheet — the inventory already renders every field of every kind |

## 4. The shape: `OP_CABLE`'s contract

Numbers below are the next free at filing and **must be re-read from `lib.rs`/`protocol.rs` at
build time** — opcode numbers have collided across concurrent branches before (`OP_DIAGRAM`
19 → 20; ADR-0035 → 0036).

**Request.** The shared 24-byte header (clock `u64` LE, entropy `u128` LE), then:

```
mode   u8    0 = cut · 1 = draw
count  u8    must be 1 in this cut (D7)
record
  draw:  near_end · far_end · label(len u8, UTF-8; empty = unlabelled)
  cut:   cable(len u8, display id)
end spec
  tag u8  0 = existing port      + len u8 + port display id
          1 = mint a port on box + len u8 + box display id + len u8 + port label (empty = unlabelled)
          2 = unknown far end    (no bytes; legal for far_end only → one-ended cable)
          3 = RESERVED for ExternalPeer ("off the estate", 57 §12.1 row 5); refused in this cut
```

**Reply.** Three words, as `OP_LINK`: `1` drew, `0` cut, `2` already there (a live cable already
terminates both named ports — a correct no-op that must never share the word for a real write).
With `1`, the reply carries the display ids the batch minted — cable, then each port, then the
chassis if one was minted — so the page journals by id and can select the new cable.

**Errors.** `ERR_CABLE_COUNT` (count ≠ 1), `ERR_CABLE_END` (a spec names something that is not
a live port or box, both ends name the same port, tag 3, or tag 2 on the near end),
`ERR_NO_CABLE` (cut names no live cable). Every refusal closes the batch: *no refusal leaves the
store wedged* is the test to copy.

**Write sequence, one batch** (`OP_EQUIP_ADD`'s shape): mint a `Chassis` + `HasChassis` if the
box has none (D5) → mint each tag-1 port + `HasPort` under its chassis → mint the `Cable` +
`HasCable` (root containment — reuse whatever the weld uses to attach a fresh root-owned node;
do not hand-roll it) → `Terminates` to A then B with `end` set by D6 → label if given → close.
Every id from **one** `Mint` seeded by the header's clock and entropy, one `next()` per new id,
so a replay with the same header mints the same ids.

**Journal record** (page-side, through `jpush`, the one constructor): `{ op: 'cable', mode,
near: {tag, id, label}, far: {tag, id, label}, label, wrote: { cable, ports: [...], chassis } }`
plus the header's clock and entropy. Kinds are implicit in the op name; **no ordinal anywhere.**
A replay confirms, as every replayed op does, and re-mints deterministically. **The
unlabelled, unpositioned port replayed through export → reload → import is the new case nothing
before this had, and it gets its own test.**

## 5. What must stay true

- **The picker records the verb that opened it** (draw, cut, add-a-port), not only the ends —
  the chooser's 2026-08-16 defect, in advance.
- **A no-op never shares a reply word with a write** (word `2`).
- **No DOM event reaches a mode or confirm argument** — the paste's 2026-08-21 defect, in advance.
- **`virtual` is never written on a `Cable` by any hand gesture** (D3).
- **A cable's line on the canvas is derived, never stored**; a hand-placed pin on the cable's
  boxes moves the line, and nothing about the line survives except the graph that implies it.
- **Every sentence the sheet speaks is re-read against what the code does at ship time** — the
  `REPLACES` lesson.

## 6. What will be built

| layer | what |
|---|---|
| `fathom-wasm` | `OP_CABLE` (+ `ERR_CABLE_COUNT`, `ERR_CABLE_END`, `ERR_NO_CABLE`), the `cable` handler and its three words, `tests/cable.rs` modelled on `tests/link.rs` and `tests/equip.rs`, a test that `OP_CABLE` is not `ERR_UNKNOWN_OP` (nothing else would catch a missing dispatch arm) |
| `fathom-weld` / `fathom-graph` | nothing new declared; the root-containment attach reused |
| `fathom-layout` | the device-to-device line derived from a two-ended cable, flagged `cable` |
| `fathom-inventory` | `cabled_peer` skips absent cables (D8); `display_name` fallback for ports (D11); `InvKind::Cable` and `InvKind::PhysicalPort` rows, appended (D14) |
| the page | the picker sheet; the hold-a-port gesture on the strip; the Escape rung (D12); journal op + import arm; the Outline row and midpoint word (D13); the wire constants declared so the cross-check test binds them |
| evidence | `docs/80-review/evidence/2026-08-29-cabling-drive.mjs` through a real reload: mint-on-empty-box, existing-port, unknown-far-end, cut, already-there, the pasted-device chassis mint, the unlabelled-port replay |
| docs | this record; `57` §14.1 B3 closed; `57` §12.1 and §12.4 annotated; CLAUDE.md's state bullet |

## 7. Cost, measured

Module size before and after, read off the `artifact_gates` run and recorded here by the
proving session: **before 969,090 bytes** (2026-08-29, after WO-10). After: <!-- VERIFY: fill from
the run -->. Reported, not gated (`49` §1).

## 8. Failure modes

| failure | what stops it |
|---|---|
| a cable drawn between two ports is recorded as a `PassThrough` | D2: `OP_CABLE` never consults `hand_link_candidates`; a test draws between two ports and asserts a `Cable` node and two `Terminates`, no `PassThrough` |
| the same cable drawn from either end is two cables | D6 + a test drawing A→B and B→A asserting one identity |
| a removed cable still shows as *cabled to* | D8 + a test that removes and re-reads through `cabled_peer` |
| the first unlabelled port renders as `—` | D11 + the picker driver |
| a held end cannot be escaped | D12 + the driver presses Escape mid-hold |
| replay of an unlabelled port produces a different port | the deterministic-mint test through a real export and import |
| the count byte is ignored and a future N-record journal is truncated | D7's refusal, tested |

## 9. Open decisions

1. **Range cabling and bundles** (`57` §12.7) — the frame admits them (D7); designing the
   gesture and the bundle drawing is a follow-up. *For planning.*
2. **The faceplate (rung 3)** — per-port drawing, and cabling from a drawn port. *For planning,
   after the elevation gains a renderer for it.*
3. **`ExternalPeer` ends** (tag 3) — *"this uplink goes to the ISP"*. Nothing constructs an
   `ExternalPeer` yet. *For planning.*
4. **Type-to-link** (`57` §13) and the findings view's *unfinished cables* list (`57` §13.5
   item 3). *For planning; the inventory rows are the interim annotate path.*
5. **Platform port complements** (`57` §12.3 route 3) — `platforms.yaml` carrying port data.
   *For the owner, with the engine question (`70` §18.4).*
6. **A standalone *add a port* from the inventory**, outside the gesture. *For planning.*

## 10. Sources consulted

| source | for |
|---|---|
| `docs/50-design/57-the-zoom-ladder-and-the-trace.md` §12, §13.5, §14.1 | the design and the owner's words |
| `docs/70-ops/70-owner-answers-and-standing-priorities.md` §18.3 | the empty-chart principle |
| three scout briefs, 2026-08-29 (session scratchpad, `cable-{schema,page,precedent}.brief.txt`) | every line number in §4; the `PassThrough` finding; the `Cable.media.virtual` finding; the tombstone-cascade gap |
| `schema/schema.yaml` — `Cable`, `Terminates`, `PhysicalPort`, `HasPort`, `HasCable`, `HasChassis`, `PassThrough`, `Link` | the declared shapes |
| `crates/fathom-wasm/src/shell.rs` — `equip_add`, the `link` arm | the batch and the three-word precedent |
| `docs/90-decisions/adr-0035-a-hand-placed-position-is-graph-data.md` | this record's shape |

## 11. Disagreements

1. **With `57` §12.4's prose.** *"Cabling is `OP_LINK`'s gesture one rung down"* reads as a
   mechanism claim and is only a gesture claim. Taken literally it writes `PassThrough` (D2).
   `57` §12.4 is annotated to say so rather than rewritten.
2. **With `57` §12.1's premise.** It argues `virtual` is not a kind of cable against a schema
   that declares `Cable.media.virtual` (`19` §3.4's list, verbatim). Both are right about
   different doors: the schema admits what a plant may declare; the hand gesture is where fiction
   would enter, and it is closed there (D3). Removing the variant would be a MAJOR bump for no
   gain in safety.
3. **With the precedent of shipping `OP_LINK` without a record.** This one gets a record because
   it decides where ports come from, which is the same category of question ADR-0035 answered
   for positions.
