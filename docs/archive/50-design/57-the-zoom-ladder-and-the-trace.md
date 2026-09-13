# 57 — The zoom ladder and the trace

> **Status:** Proposed · **Opened 2026-08-17, parked 2026-08-18 at the owner's direction**
> (usage limits — *"we are gonna have to stop here for the week"*).
> **Nothing in this document is built.** No `.rs` file, no `schema/` change and no page
> change came out of it. It exists so that a week's design conversation is not lost, and so
> the next session starts from the findings rather than from the questions.
>
> **ADDENDUM 2026-08-28: that sentence is now historical.** Pile A (§14.1) was built out on
> 2026-08-21/22 — the rack rung, rung 4 (§7's gap), editable cells, the gaps view, Direction
> A on the inventory — and the byte pile (§14.1 C) emptied when the 900,000-byte ceiling was
> removed with the pivot (`49` §1). The owner-blocked pile is untouched: every decision in it
> is still open. §14's sorting logic is dated; its findings (§2, §3, §6) still bind.

Two renders were published and approved in outline. This file is the durable record of
what they showed, what five independent designs and four adversarial checks established,
and — most importantly — **the one view nobody designed**.

## Contents

| § | |
|---|---|
| 1 | Where this came from: the owner's words |
| 2 | The zoom ladder — five rungs in one canvas |
| 3 | The fork: physical and logical are two chains, not two views |
| 4 | **The schema gap this exposed** — a rack cannot be at a site |
| 5 | The trace: five directions, four checks |
| 6 | **What every direction agreed on** — three findings |
| 7 | **THE GAP: nobody designed the inside of a box** |
| 8 | The constraints the owner added last, verbatim |
| 9 | What I would build, in order |
| 10 | Open decisions |
| 11 | Sources consulted |

---

## 1. Where this came from

It started as a complaint about a button. `rack view` sat in the band's `START HERE / OR /
THEN` row, beside `paste a config` and `add equipment` — and the owner noticed that the
first two are how data gets **in** while the third is a way of **looking**. That is a
category error and it was introduced on 2026-08-17 when those three were promoted to doors.

The complaint opened into something much larger. His words, in order, across the
conversation:

> *"i want to be able to zoom that way into the boxes, and zoom out all the way until we are
> at site data vs just a single network path logically."*

> *"the rack has no way of interconnecting what where and that includes other racks. like
> maybe some kind of icon that when you click on it takes you to a different rack and
> highlights which connection you were looking at?"*

> *"you should be able to zoom into a box and follow logic as well, this tcp routes here
> because of this on this port. but these can be hundreds of things so we'll need some way
> to parse it."*

> *"the goal is I should be able to track a tcp all the way to a different location via the
> canvas viewer."*

**The rack was never the subject.** The subject is that a network exists at several scales
at once and the product only draws one of them.

## 2. The zoom ladder

Agreed in outline by the owner on 2026-08-17 against a published render.

**One canvas. Zoom is a depth axis, not a set of modes.** The chart area swaps what it
draws; the band, the masthead and the side panel stay put. It is not a new view, not a new
screen, and not a modal — the picture changes and nothing else does.

| depth | rung | kinds | state |
|---|---|---|---|
| 0 | Premises | `Premises` | no renderer |
| 1 | Site | `Site → Device` | **live today** |
| 2 | Rack | `Rack ←MountedIn— Chassis` | **built, reached by the wrong door** |
| 3 | Chassis | `Chassis → PhysicalPort` | no renderer |

Two things fall out of this that are worth stating because they are cheap and easy to miss:

- **Pan, zoom and fit already work on the canvas** and would work on any of these renderers
  unchanged. The depth axis costs no new viewport code.
- **`rack view` stops being a door.** It is not deleted; it is relocated to where selecting
  a rack takes you. The band goes back to being two doors, which is what it is for.

The published render is `docs/80-review/evidence/2026-08-17-zoom-ladder-render.html`. It draws
all four rungs in the product's own tokens; open it in a browser from disk.

## 3. The fork

The owner asked whether this should be a physical view versus a logical view, and said
*"whatever you think is best"*. **The schema had already decided, and neither of us knew it.**

There are two containment chains and they hang off different roots:

```
PHYSICAL   root → Premises → Rack ──MountedIn──→ Chassis → PhysicalPort
LOGICAL    root → Site → Device → Interface → LogicalUnit → Address
                                └──────────→ Chassis   ← they meet here
```

`HasRack` runs from `Premises`. `HasDevice` runs from `Site`. **They meet at the chassis**,
which is bolted into a rack (physical) and belongs to a device in a site (logical).

So the answer to *"physical or logical?"* is **neither — it is one ladder that forks once,
at the box.** That is a better answer than either party had, and it came out of the schema
rather than out of an opinion. `Occupies` (`Interface → PhysicalPort`) is the same joint
one level down: it is the exact edge where a logical interface meets the metal it runs on.

## 4. The schema gap this exposed

> **A RACK CANNOT BE AT A SITE, AND A SITE CANNOT CONTAIN A RACK.**

`HasRack` is `Premises → Rack`. `HasDevice` is `Site → Device`. There is no edge between
`Site` and `Rack`, and no edge between `Site` and `Premises`.

So *"this rack is at the Denver site"* is **not expressible today**. For a single home lab
this never comes up — one building, one site, and the distinction is invisible. For the
owner's stated goal of using this at work it comes up immediately.

This is a schema question, not a rendering one, and it is **cheap now and expensive later**:
every hour of parsing, welding and drawing built on the current shape is an hour that has to
be revisited if `Site` and `Premises` are ever related. It is named here rather than
decided, because it is the owner's and `62`'s.

## 5. The trace: five directions

Five designs, each developed independently against the real schema; four were then attacked
by a reviewer who did not write them. The fifth reviewer died on an API error and its design
is recorded unchecked. All four completed checks returned **viable** — which is itself worth
noting, because it means the shape of the problem is agreed and only the treatment is open.

| direction | the idea in one line | crossing a rack | scale to hundreds |
|---|---|---|---|
| **Rail and Seat** | the thread is fixed on a rail and the *picture* is what travels | free — the rail never moves | folds the rail middle-out around where you stand |
| **Thread and Gutter** | the path is drawn on the picture and terminates in edge markers where it leaves | click the marker, the canvas travels | **weakest** — see below |
| **The Open Spine** | the path stays expanded, everything else folds shut | no crossing at all — both racks stay open | detail drops one rung per hop of distance |
| **The Run Sheet** | the trace is a written account and the canvas illustrates it | a line in the sheet | **strongest** — text filters in ways a picture cannot |
| **Facing Pages** | both ends on screen at once, path across the seam | both ends already visible | *(check did not complete)* |

**The sharpest single catch in the whole exercise**, found by the checker on Thread and
Gutter: the diagram's default picture is **aggregated**, folding any group above six items,
and *a thread lives at exactly the granularity aggregation removes*. A design that draws a
path over the default view is drawing it over the view that has hidden the path's hops. That
finding applies to more than the one direction it was filed against.

## 6. What every direction agreed on

Three findings, which matter more than the five treatments and which no single agent was
asked to produce — they converged.

### 6.1 The trace is already specified, and nobody has written it

`19` §6.5 defines `trace_step` in full: the `Terminates` cable walk, the sort orders, the
`PassThrough` patch-panel step, a 16-hop cap, and seven named outcomes including
`Unterminated`, `Ambiguous`, `FanOut`, `Horizon` and `Exceeded`. **It has never been
implemented.** So the design work is mostly about how to *draw* a decision taken long ago,
and the traversal itself is a specification-following exercise rather than an invention.

### 6.2 Nothing can create a cable

`Cable` is declared. `Terminates` (`Cable → PhysicalPort | ExternalPeer`) is declared.
`PassThrough` (`PhysicalPort → PhysicalPort`) is declared, which is a patch panel.

**No opcode builds any of them.** `OP_LINK` (24) writes *reference* edges between two
elements that already exist, and `Terminates` runs from a `Cable` node nothing can bring
into existence. `HAND_LINK_EXCLUDED` also removes `MountedIn` from hand-drawing on purpose.

So the physical trace is **fully expressible and completely unbuildable on a hand-made
estate**. An `OP_CABLE` is the prerequisite for the owner's first two asks and every one of
the five directions needs it. This is the single most actionable item in this document.

### 6.3 "Why does it go here?" can be answered honestly with no rules engine

Four of the five landed on the same move independently, and it is the best idea to come out
of the exercise.

**Never say *permitted* or *denied*.** There is no rules engine — zero lines — and building
one is a subsystem, not a feature. Instead: from the interface traffic entered by and the
one it leaves by, the graph already names the two `Zone`s, the `PolicySet` between them, and
that set's `SecurityPolicy` children **in the order the device reads them**.

> Four hundred policies on the box become the twenty-seven pointing this direction —
> **exactly, and not heuristically.**

It is a *narrowing*, not a verdict, and it must carry a standing sentence that says so:
*Fathom does not evaluate policy. This is what the graph puts in play, in the order the
device reads it.* That sentence is the design. It lets requirement 3 be answered this
quarter instead of dishonestly or never.

## 7. THE GAP: nobody designed the inside of a box

The owner asked, at the end:

> *"did you also design a view for the internals of how something is routed inside
> equipment?"*

**No. And the honest answer is that rung 3 is a faceplate, not an internal view.**

Rung 3 draws `Chassis → PhysicalPort` — the *outside* of the box, ports on a front panel.
The path *through* the box — in on `ge-0/0/1`, which `Occupies` a port, into `Zone trust`,
matched against a `PolicySet`, routed by a `RoutingInstance`'s `StaticRoute` or
`RoutingProtocol`, out via `st0.0` into an `IpsecVpn` — appeared in every design only as
**the Seat**, a *list in the side panel*. Nobody drew it.

That is a real omission and it is the most interesting thing left, because:

- **It is where the "why" lives.** §6.3's narrowing is exactly this content, and it is
  currently specified as text beside a picture rather than as a picture.
- **The schema supports it richly.** `Zone`, `PolicySet → SecurityPolicy`, `NatRuleSet →
  NatRule`, `RoutingInstance → StaticRoute | RoutingProtocol → ProtocolAdjacency`,
  `AddressObject`, `Application`, `IpsecVpn`, `Occupies`, `HasUnit`, `HasAddress` — all
  declared, all per-Device containment, none of it drawn anywhere.
- **It is the rung where the two chains of §3 actually meet**, so it is the natural home for
  the physical/logical switch rather than an abstract toggle.
- **It needs no new kind and no rules engine** — only a renderer and a layout, both of which
  are page-side and therefore free against the 900,000-byte module ceiling.

**A sixth rung, between chassis and nothing:**

| depth | rung | what it draws |
|---|---|---|
| 3 | Chassis | the faceplate — ports on the outside |
| **4** | **Inside the box** | **ingress interface → zone → policy set → routing instance → egress interface, as a picture** |

Unbuilt, undesigned, and the first thing I would render next.

## 8. The constraints the owner added last

Recorded verbatim, 2026-08-18, because they arrived after every design above and none of the
five was evaluated against them:

> *"there could be 10+ going from one device to another, there could be dozens of different
> racks, so i think seeing one rack at a time that can then move over to the other rack, with
> a decent animation would be for the best."*

> *"the fact there could be dozens of random weird connections, and they all need to
> dynamically be both seeable, orderly, and easy to read/change and etc."*

> *"I should be able to add equipment and such, and we still need a top down view as well,
> not just a rack view."*

> *"i do love the trace idea where it shows all of them, and then you can click on it and it
> shows where in the chain you are, brilliant idea. I think that should just be a dedicated
> feature."*

What these change:

1. **One rack at a time, with travel between them.** This settles the §5 comparison in
   favour of **Rail and Seat** and against **The Open Spine**, whose whole premise is holding
   several racks open at once. Dozens of racks makes "keep them all open" untenable.
2. **The travel is animated, and the animation carries meaning.** ADR-0033 and the motion
   rule rewritten on 2026-08-17 already permit this: a duration must be a named token and
   anything animated needs a `prefers-reduced-motion` answer. A rack-to-rack traversal that
   moves in the direction of the cable is exactly the "motion carries meaning" case.
3. **10+ links between two devices is the common case, not the edge case.** Every render in
   §5 drew one line between two boxes. A bundle of ten needs its own treatment — fan, bundle
   with a count, or a spread-on-focus — and none of the five addressed it.
4. **The trace becomes a dedicated feature**, not a mode of the diagram. That is the owner's
   call and it simplifies §5: the rail does not have to share the canvas's chrome.
5. **A top-down view is still wanted** — the rack elevation is a *side* view, and a
   floor/room plan is a different drawing that nothing above designed.
6. **Adding equipment must work at every rung**, not just from the band's door.

## 9. What I would build, in order

Not a plan of record — the owner's queue in `79-work-orders/` is that. This is the ordering
the design work implies.

| # | | why first |
|---|---|---|
| 1 | **`OP_CABLE`** | §6.2. Nothing physical is traceable until a cable can exist. It blocks two of the three asks and every one of the five directions. |
| 2 | **Move `rack view` out of the band** | The original complaint, and it is nearly free — the renderer exists and only the entry point changes. |
| 3 | **The byte work** | 203 bytes free. `OP_CABLE`, unmount and move are all module code and none of them fits. `47` §11 names the levers. |
| 4 | **Rung 4 — inside the box** | §7. The biggest gap, page-side, no new kinds, and it is where "why does it go here" actually lives. |
| 5 | **The rail** | §8 settles the shape. Needs 1 and 3 first. |
| 6 | **Unmount and move** | Drag-and-drop in a rack is a *move*, which `rack_place` refuses on purpose. Reopening that refusal is a decision, not a patch. |

## 10. Open decisions

All owner's, none taken here.

1. **Is a `Site` related to a `Premises`?** §4. Cheap now, expensive later.
2. **Does drag-and-drop in a rack justify reopening the no-move refusal?** The refusal is
   deliberate and documented; drag-and-drop cannot be built around it.
3. **Is the trace a dedicated view or a mode of the diagram?** The owner said dedicated
   (§8.4). That takes one of the six view slots, of which three are unbuilt placeholders.
4. **What does a bundle of ten links look like?** Undesigned (§8.3).
5. **What is the top-down view?** A floor plan is a different drawing from an elevation and
   nothing above designed it (§8.5).
6. **Where do `PhysicalPort`s come from?** §12.3. Cabling mode does not work until this is
   answered, and it is upstream of `OP_CABLE`.
7. **Should `schema/platforms.yaml` carry a port complement?** It would make §12.3 route 3
   possible and it is a schema change.
8b. **Where does a thing that is not in a rack live?** §15. A `Surface` kind plus widening
   `MountedIn`, and a `Device`-to-`Premises` relationship. Second independent surfacing of the
   §4 gap.
8c. **Does `height_u` move from `MountedIn` to `Chassis`?** §15.6. A 2U server is 2U whether
   or not it is racked. Cheap now, a migration later.
8. ~~**How is "cable to that device, port unknown" recorded?**~~ **ANSWERED 2026-08-28**
   (`70` §18.3): `PhysicalPort.label` is `0..1` as of schema 0.4 — *"absolutely"*, in the
   owner's word, because the empty-chart-then-fill-in gesture is *"one of the main
   features"*. §13.5's promotion of this row to a blocker read the answer correctly a week
   early. §12 and §13 are unblocked; B3 (where ports come from) is the next open question
   they meet.

## 12. Cabling mode, and the correction that protects the trace

Added 2026-08-18, after §8 was written. The owner's words:

> *"we need to also have the ability to easily edit stuff, either by like very granular, or
> something as simple as drag and dropping cables. We should be able to go into cabling mode
> or something, where i can draw a cable between one device and another, you'd prompt me when
> i click on the first box to indicate where it is coming out of, but give an option for
> unknown or virtual (seperate options and more if needed) and then drag and drop, doing the
> same thing with the ports on the other side."*

### 12.1 His two options are already declared — on the other edge

`Link` (`Interface → Interface`, symmetric, `0..1` at each end) declares:

```
media: enum { copper, fibre, dac, virtual, unknown }
```

**`virtual` and `unknown` are the two he named, verbatim, and they already exist.** Along with
`length_m`, `label` (documented as *"Patch panel reference"*) and `provider_circuit`.

But they are on `Link`, not on `Cable`. And that is the correction:

> **`virtual` IS NOT A KIND OF CABLE. IT IS THE ABSENCE OF ONE.**

`Cable` + `Terminates` is the physical plant: a run of copper or fibre between two
`PhysicalPort`s. `Link` is a logical adjacency between two `Interface`s, which may or may not
have any metal under it. Two VMs on one hypervisor, a VLAN, a tunnel — all `Link`, none of
them `Cable`.

**If "virtual" were offered as a port choice in a cable dialog, the product would write
fiction into the physical plant** — and `19` §6.5's `trace_step` walks `Terminates` and
`PassThrough` to answer *"where does this physically go"*. A virtual cable in that walk
returns a physical path that does not exist, confidently, in the one feature whose entire
value is being trustworthy about the plant.

So the dialog's shape is not *"pick a port, or unknown, or virtual"*. It is:

| the person means | what gets written |
|---|---|
| out of this specific port | `Cable` + `Terminates{end: A, lane?}` |
| out of *a* port, I don't know which | a **one-ended cable** — see §12.2 |
| there is no cable, these just talk | `Link{media: virtual}` — a different gesture |
| I don't know if there's a cable | `Link{media: unknown}` |
| off the estate entirely | `Terminates → ExternalPeer`, which is declared |

The last row is one he did not ask for and will want: `Terminates` goes to
`PhysicalPort | ExternalPeer`, so "this uplink goes to the ISP" is already expressible.

**Annotation, 2026-08-29 (ADR-0038 §11.2).** The shipped schema declares `Cable.media.virtual`
(`19` §3.4's list, verbatim), which this section did not notice. The argument above stands
about the *gesture*: `OP_CABLE` never offers or writes it, and the sheet's "no cable — these
just talk" redirects to the link gesture. The variant stays declared for plants that may
legitimately state one; removing it would be a MAJOR bump for no safety gained.

### 12.2 A one-ended cable is legal, and the schema says so out loud

`Terminates` is `out: "0..2"` at the cable end. A cable with **one** termination is a valid
graph. `Cable`'s own doc anticipates exactly the owner's "unknown" case:

> *"A one-ended cable with no label has no recovery key — if you record a planned cable,
> label it."*

So "unknown far end" needs no new option and no new field. It is a cable with one
`Terminates`, and the schema's advice — **label it, or you will never find it again** — is
the prompt the form should give. That is a designed behaviour available for free.

### 12.3 The blocker nobody has hit yet: there are no ports

`HasPort` is `Chassis → PhysicalPort`, and **nothing creates a `PhysicalPort`.** A device
added by hand gets a `Device` and a `Chassis` and zero ports.

So "click the box and pick which port it comes out of" shows an **empty list on every
hand-built device in the estate**. This is the same shape of blocker as `OP_CABLE` (§6.2) and
it is upstream of it: cabling mode cannot work at all until ports exist. Two routes, neither
chosen here:

1. **Ports arrive with the equipment.** The add-equipment sheet asks how many ports and of
   what kind, and writes them. Cheap, but wrong for a chassis with mixed line cards.
2. **Ports are created inline by the cabling gesture.** Clicking a box with no ports offers
   *"add a port"* as the first item. Better for the hand-built case and more code.

A platform-driven default (an SRX345 has a known port complement) is the obvious third route
and it needs `schema/platforms.yaml` to carry port data, which it does not.

### 12.4 Cabling mode is not a mode — it is `OP_LINK`'s gesture one rung down

The product removed a mode this week (`rack view` as a door) and should not add one back.
But cabling genuinely is repetitive — you draw twenty of them in a sitting — so it wants to
be **sticky**, like a pen tool, rather than a screen.

There is already an idiom for exactly this: `OP_LINK`'s *hold one end, select the other,
draw or cut*. Cabling is the same gesture one rung down — **ports instead of boxes**. That
unification is worth taking deliberately:

| rung | hold | select | writes |
|---|---|---|---|
| 1 — site | a device | another device | a reference edge the schema admits |
| 3 — chassis | a **port** | another **port** | `Cable` + two `Terminates` |

Same muscle memory, same refusal-to-guess when several kinds are legal, same `by hand` mark,
same keyboard path. It should also be drawable **from the rack elevation**, because that is
where a person can see both boxes at once — which is the answer to §8's "one rack at a time
with travel between them" meeting cabling.

**Annotation, 2026-08-29 (ADR-0038 D2, §11.1).** "Same gesture" is true; "same mechanism" would
be wrong. The only reference edge the schema admits between two `PhysicalPort`s is
`PassThrough` — *these two holes are the same hole* — and `OP_LINK`'s one-candidate rule would
write it without asking. A cable is a third, minted node with two `Terminates` edges, so
`OP_CABLE` is its own compound write and never consults `hand_link_candidates`.

### 12.5 Breakout is modelled, and it will bite

`Terminates.lane` is a `u8` and `Cable.assembly` is documented as *"breakout assembly,
multi-fibre bundle"*. So one 40G port fanning to four 10G ports is expressible — and it means
the port picker cannot assume one cable per port. Any design that draws "one line per port"
is wrong the first time the owner documents a breakout, which in a home lab with a 40G
uplink is week one.

### 12.6 On "granular editing", which is the larger half of his ask

`OP_FIELD_SET` already exists: a stored field can be corrected. So granular editing is not
missing — it is **unreachable**. You can only edit what a form happens to expose, and the
forms expose what somebody remembered to put in them.

The general answer, which is a bigger idea than cabling: **every fact on screen should be
editable where it is shown.** The inventory already renders every field of every kind from
the generated tables; making those cells editable in place reaches far more of the estate
than any number of purpose-built sheets, and it is page-side. That is probably the highest
value-per-byte item in this entire document.

### 12.7 Scale, again

Dozens of cables between two racks is the normal case, and drawing each by hand is the kind
of tedium that makes people stop using a tool. Two things worth designing before anyone
builds the single-cable gesture:

- **Range cabling.** *"ports 1–24 on this panel go to ports 1–24 on that one"* is one gesture,
  not twenty-four. `PassThrough` is symmetric and `0..n`, so a patch panel's whole front-to-back
  mapping is expressible in one sweep.
- **The bundle.** `Cable.assembly` groups them. Ten cables between two racks should draw as
  one bundle with a count, expanding on focus — which is also §8.3's unanswered question
  about ten links between two devices, and probably the same treatment.

## 13. Type-to-link: the inventory as the universal editor

Added 2026-08-18. The owner corrected §12.6's reading of "granular editing":

> *"by granular editing i meant like if i'm filling out an inventory, i should be able to
> edit port ge0/1/0 and in the field basically @ another device, though without the @, and it
> will lookup and i can click on it. Then we have a link. Maybe even offer for me to provide
> the otherside, like it dropsdown or expands under the field i'm typing in to provide it or
> leave blank if i don't know and it puts it in unknown."*

**Both are built. This is not an alternative to §12's drag-and-drop and an earlier draft of
this section was wrong to rank them** — see §13.5, which is the owner's correction and the
most important paragraph in this file. The two halves do different jobs: **the drag captures,
the field completes.** What follows is why the field half is worth building well, not an
argument for building it first.

1. **It is fast for the list-shaped half of the work.** Some documenting is done down a
   switch's ports one at a time, and there typing never leaves the keyboard.
2. **It is keyboard-native for free.** §12's drag gesture needs a keyboard twin built
   alongside it or the browser drivers fail it. A text field with a completion list *is* the
   keyboard path, and the mouse affordance is the one that comes free instead.
3. **The completion engine already exists.** The finder searches 98 corpus entries with
   fuzzy matching from `Ctrl`+`K`. Pointing that same widget at the estate rather than the
   corpus is reuse, not new machinery.

### 13.1 What it really is: an edge wearing a field's clothes

A field holds a scalar. A connection to another node is an **edge**. So "type a device name
into a field and get a link" is a *form affordance over an edge*, not a new field type — and
therefore **needs no schema change at all**. That is the whole reason this is cheap.

It also generalises past cabling, which is the part worth taking seriously:

| editing this | typing here | writes |
|---|---|---|
| a `PhysicalPort` | *connects to* | `Cable` + two `Terminates` |
| a `Chassis` | *mounted in* | `MountedIn{position_u, face}` |
| a `Device` | *site* | `HasDevice` |
| an `Interface` | *linked to* | `Link{media}` |

**Every edge becomes a typeable field, and the inventory becomes the universal editor.** That
is a far larger answer to "granular editing" than any number of purpose-built sheets, and it
is page-side.

### 13.2 The gap his flow hits immediately, and it is a real one

> **"CABLE FROM `ge-0/1/0` TO `sw-core-01`, PORT UNKNOWN" IS NOT EXPRESSIBLE.**

His design says: name the far device, then leave the far port blank if you do not know it.
That is exactly right as a workflow and the schema cannot record it.

- `Terminates` goes to `PhysicalPort | ExternalPeer`. There is no third option.
- A **placeholder port** on the far device does not work: `PhysicalPort.label` is `card: "1"`
  — required, documented as *"The silkscreen"*. Inventing a silkscreen value is fiction, and
  it is exactly the kind of fiction invariant 3's neighbours exist to prevent.
- A **one-ended cable** is legal (§12.2) but **loses the far device entirely**, which is the
  one thing he did know. That is a strictly worse record than what he typed.
- `Link{media: unknown}` is `Interface → Interface`, so it needs two interfaces, and at this
  point in the flow he may know neither.

So the honest options, none chosen here:

1. **Relax `PhysicalPort.label` to `0..1`** — a port whose silkscreen has not been read. Small
   schema change, minor bump, and it makes "there is a port here and I do not know which"
   directly sayable. This is probably right and it is the owner's call.
2. **A field on `Terminates` or `Cable` for an unresolved far end** — records the device
   without pretending to a port. More faithful, more machinery, and a second way to say
   where a cable goes, which is how graphs rot.
3. **Accept the loss** and record `Link{media: unknown}` at the interface level when the port
   is not known. Cheapest, and it silently moves the fact from the physical plant to the
   logical layer, which will confuse the trace.

**This is the same shape of decision as §4's site-and-premises gap: cheap now, expensive after
things are built on the current shape.**

### 13.3 Three behaviours to get right

- **Ambiguity is refused, never guessed.** Typing a name where several edge kinds are legal
  between the two ends is `OP_LINK`'s existing situation, and it already has the right answer:
  offer the names, never pick. The completion list must not silently choose the first legal
  kind.
- **A name that does not exist must not become one by accident.** *"connects to: pve-02"*
  where `pve-02` is not in the estate is powerful — it is how you document a lab at speed —
  and a typo that silently creates a ghost device is how an estate of record stops being one.
  Creation must be an explicit, separate choice in the list (*"create device pve-02"*), never
  the fallback when nothing matched.
- **The link the field creates is hand-asserted and must be marked.** Same rule as `OP_LINK`:
  a fact a person typed carries `by hand` on the Outline row and in the picture, so a
  colleague can always tell it from something a config said.

### 13.4 What it does not solve

It is a *data-entry* design, not a *reading* one. §12.7's range cabling — *"ports 1–24 to
ports 1–24"* — is twenty-four trips through this field, and the field does not make that
better.

### 13.5 The owner's correction, and it changes the shape of both halves

> *"nunununo no. We are doing both, because it's WAY faster to drag and drop, and then fill
> out later, or even in line than it is to be editing the dedicated piece of equipment page.
> trust me, we aren't reinventing the wheel here, other people have done similar things
> before."*

**He is right and §13's opening was wrong.** Ranking them was the error, and the reason it
was an error is worth stating because it changes what gets built:

> **THE DRAG IS FOR CAPTURE. THE FIELD IS FOR COMPLETION. A CABLE IS BORN INCOMPLETE AND
> THAT IS THE FEATURE, NOT A DEFECT TO DESIGN AROUND.**

You drag ten cables in fifteen seconds because you can see both boxes and your hands know
where they go. Not one of those ten has a label, a media type, a lane or a far-end port yet,
and **none of that stops the ten cables from being true**. You fill them in afterwards,
inline, from a list — or you never do, and the estate still says ten real things it did not
say before.

The failure mode this avoids is the one he named: a form that demands every field before it
will record anything turns a fifteen-second job into a twenty-minute one and gets abandoned.
Drag-then-annotate is a long-established pattern in inventory and diagramming tools, and the
project has no reason to relitigate it.

**Three consequences, and the first one promotes an open decision to a precondition.**

1. **`PhysicalPort.label` must become `0..1`.** §13.2 offered relaxing it as one of three
   routes, likeliest but optional. Under drag-first it is not optional: *"there is a port and
   I do not know which"* is the **normal state of every freshly-dragged cable**, not an edge
   case in a form. A schema that cannot say it cannot record the primary gesture. Open
   decision 8 is now a blocker rather than a preference.
2. **Incompleteness is drawn, never hidden.** `70` §16 already settled the doctrine — an
   incomplete path is drawn and *marked*, never refused — and `51` §9 reserves `dotted` for
   *unanswered*. A dragged cable with one end unresolved is exactly an unanswered fact, so it
   draws dotted and says so on its Outline row. The mark is what makes capture-first honest
   rather than sloppy: the estate never pretends the gap is not there.
3. **The unfinished need a home, and one exists with nothing in it.** *"17 cables have no far
   port · 4 have no label"* is a standing list of what the estate does not yet know, which is
   precisely the **findings** view — one of the three placeholders. This gives an unbuilt view
   its first real job, and it is the natural place the annotate half is driven from: work the
   list down rather than hunting the canvas for what is dotted.

**What this does NOT change.** The two guardrails in §13.3 hold for the drag as well: a
gesture must never invent a device that was not named, and where several edge kinds are legal
between two ends the product offers them and refuses to pick. Fast capture is not permission
to guess.

## 14. Where this stands — the handoff

Written 2026-08-18 at the close of the week, because the honest summary of five days of
design is uncomfortable and worth saying in one place:

> **THE DESIGN HAS OUTRUN THE BUILD CAPACITY BY ROUGHLY A YEAR OF BYTES.** There are eight
> unbuilt designs in this file and **203 free bytes** in the module. The constraint is not
> ideas and has not been ideas for some time. **Every road out of here runs through `47`'s
> byte levers**, and not one of them has been proved.

### 14.1 The three categories, and only one of them is stuck

Everything raised this week sorts into three piles, and conflating them is what makes the
situation look worse than it is.

**A — Buildable now. No decision, no bytes, page-side.** This pile is not empty and it is
where a session with no owner available should go.

| | what | why it is free |
|---|---|---|
| A1 ✅ 2026-08-21 | **Move `rack view` out of the band** — selecting a rack is how you get an elevation | the renderer exists; only the entry point changes |
| A2 ✅ 2026-08-22 | **Rung 4 — inside the box** (§7) | needs no new kind, no opcode, no rules engine; a renderer and a layout, both page-side |
| A3 ✅ 2026-08-22 | **Editable inventory cells** for fields that already exist | `OP_FIELD_SET` already exists (§12.6); this is reach, not machinery |
| A4 ✅ 2026-08-21 | **The findings view as "what the estate does not know yet"** (§13.5.3) | reads the graph it already has; gives an empty placeholder its first job |
| A5 ✅ 2026-08-22 | **Give the inventory Direction A's treatment too** (§16) | the same fix already written for the diagram; page-side, no module bytes |

**B — Blocked on the owner.** Five decisions, all cheap now and expensive later, none of
which an execution session may take (`78` §5).

| | decision | why it cannot wait |
|---|---|---|
| B1 ✅ 2026-08-28 | **Does `PhysicalPort.label` become `0..1`?** — **ANSWERED YES** (*"absolutely, one of the main features is to be able to create essentially a lucid chart with no information"*, `70` §18.3) and executed the same day: schema 0.4 relaxes the card, `62` §16.2 prices it minor. | ~~hard blocker~~ **cleared.** Everything in §12 and §13 is now buildable; B3 is the next question those sections meet |
| B2 | **Is a `Site` related to a `Premises`?** (§4) | a rack cannot be at a site. Invisible in one building, immediate at work |
| B3 ✅ 2026-08-29 | **Where do `PhysicalPort`s come from?** (§12.3) — **ANSWERED: route 2, minted inline by the cabling gesture** (ADR-0038 D1, under the owner's same-day delegation and his empty-chart principle, `70` §18.3). *Unknown* mints a port with no label. Route 3 stays open as ADR-0038 §9 item 5 | ~~cabling shows an empty port list~~ **cleared**; a pasted device also gets its missing `Chassis` minted (ADR-0038 D5) |
| B4 | **Reopen the no-move refusal?** | drag-and-drop in a rack *is* a move, and `rack_place` refuses one on purpose |
| B5 | **Is the trace a dedicated view?** | he said yes (§8.4); it takes one of six view slots, three of which are placeholders |

**C — Blocked on bytes.** Everything else. `OP_CABLE`, unmount, move, DHCP's `DhcpRelay`,
and any new kind at all. **203 bytes free; DHCP alone needs 602.**

### 14.2 The unlock, and it is unproven

`47` names three levers that would free an estimated **~81,000 bytes** — 135× what DHCP
needs — with no server, no egress and no visible change to the product:

| lever | claimed | state |
|---|---|---|
| one generated dispatch emitted as a table instead of a branch tree | ~11,089 | **mechanism corroborated, headline unreproduced** |
| the store's eight `BTreeMap`s as sorted vectors | ~45,549 | **unreproduced** |
| six sort sites as one shared insertion sort | ~25,125 | **unreproduced** |

A run to prove all three was started on 2026-08-17 and stopped by the owner at the first
minute for cost. **It is the single highest-leverage unproven claim in the project**, because
category C empties the moment it lands and stays empty — the first lever in particular makes
*every future schema kind* cheaper, which changes the economics of everything left to build.

The fourth lever, moving the finder out of the module (**220,289 bytes, measured twice**), is
**held rather than recommended**: a reviewer established that while today's finder code only
reads the public corpus, the finder as *specified* walks the user's graph. Moving it would
put estate-touching code outside the module boundary, which is a different and worse trade
than the byte figure suggests.

### 14.3 What I would actually do first, in order

1. **Prove the three byte levers.** Nothing else changes shape until this is known, and it is
   the only item that unblocks a whole category. If they land, category C empties.
2. **Answer B1.** One schema decision, one line, and it unblocks the entire cabling design.
3. **A1 and A4** — cheap, visible, and A4 gives the annotate half somewhere to live.
4. **A2 — rung 4.** The biggest design gap, no dependencies, and it is where "why does this
   go here" lives.
5. **`OP_CABLE`**, once bytes exist and B1/B3 are answered.

### 14.4 What I am least confident about

Stated plainly, because a handoff that only lists conclusions is not one.

- **Scale is hand-waved in all five trace directions** (§5). Each has a mechanism; none was
  tested against an estate forty times the fixture. The aggregation catch — the default view
  folds groups above six, which is exactly the granularity a thread needs — suggests the
  problem is worse than any of the five modelled.
- **The three byte figures are claims, not measurements.** Only `slot_type`'s 16,348 is
  corroborated. Do not plan on ~81,000 until it is built and read off a real artifact.
- **Six of the owner's constraints (§8) arrived after every design was judged.** Only two of
  the five were re-examined against them, by reasoning rather than by rendering.
- **Nothing in this file has been driven in a browser**, which is the standard this project
  holds every other claim to.

## 15. Where a thing is: racks, shelves, buildings and the floor

Added 2026-08-18, from the owner's own estate:

> *"oh we'll need to be able to put it into a building, but it doesn't have to be in one.
> However i'm not gonna lie 99.9% of equipment will be... I also want to account for something
> like i have where i have a shelf, and little mini pcs and other stuff on a per shelf, just
> kinda sitting there. Heck my own NAS is a PC case sitting on a shelf on my rack (which is
> just a short rack)"*

**This is the most useful thing he has said about the physical model**, because it is a real
estate rather than a hypothetical one, and the schema answers only one third of it.

### 15.1 What already works

- **Custom rack sizes.** `Rack.height_u` is `card: "1"`, `u8`, range 1–100. His *"short rack"*
  is a rack with a small `height_u` and needs nothing. Nothing is hardcoded to 42U.
- **`face`** is `enum { front, rear }` on `MountedIn`, so front and rear mounting is there.
- **Unstated height is handled honestly.** The elevation draws an item of unknown height as
  one unit and *marks* it, rather than silently assuming 1U — `70` §16's doctrine, applied.
- **Not being in a rack is already legal.** `MountedIn` is `out: "0..1"`, so zero racks is a
  valid `Chassis`.

### 15.2 Three ways a thing is somewhere, and only one is modelled

| how | example from his estate | modelled? |
|---|---|---|
| **bolted into a rack at a U** | the switch, the firewall | **yes** — `MountedIn{position_u, height_u, face}` |
| **resting on a surface** | mini PCs on a shelf; the NAS, a PC case on a shelf in the rack | **no** |
| **just in a building** | an AP on a wall, a switch on a desk | **no** — and see §15.5 |

### 15.3 Why "just use `MountedIn` with the height blank" is wrong

It is the obvious cheap answer and it fails twice.

1. **It poisons clash detection.** The elevation already reports two items claiming one U as a
   clash. Three mini PCs on one shelf would all sit at the shelf's U and produce **three
   permanent false clashes**, in a feature whose whole value is catching the real ones.
2. **It asserts a fact nobody stated.** *"Bolted at U14"* is not true of a PC case resting on
   a shelf. This product exists to not do that.

A real shelf fixes both cleanly: **the shelf** takes one legitimate mount at U14–U15, and the
things on it are not in the rack at all — so nothing collides and nothing is claimed.

### 15.4 `PassiveNode` is not the answer, checked rather than assumed

It looks close — its `form` enum has `enclosure` and `other`. But it is *"hardware with ports
and no configuration… owns `PhysicalPort`s exactly as a `Chassis` does"*, it is contained by
`Premises` so it cannot be mounted in a rack, and nothing can rest on it. It models things in
the **signal path**. A shelf carries weight, not signal.

### 15.5 The recommendation

Two changes, and the second is larger than the first.

**(a) A surface is a kind, and it can be racked or free-standing.**

```
Surface        label, form: enum { shelf, desk, floor, bracket, cabinet_base, other }
MountedIn      from: [Chassis, Surface]     <- widen the existing edge
HasSurface     Premises -> Surface          <- for a shelf not in a rack
RestsOn        Chassis -> Surface           <- reference edge, no position
```

Widening `MountedIn` rather than inventing a second mounting edge is the point: a shelf **is**
a rack-mounted item, so it should get `position_u`, `height_u` and `face` from the edge that
already means that. His NAS then reads exactly as he described it — a `Chassis` that
`RestsOn` a `Surface` that is `MountedIn` his short rack at some U.

**(b) A `Device` must be able to be in a `Premises`.** This is §4's gap, and §15 is the second
independent place it has surfaced, which is usually the signal that it is the real structural
problem rather than an edge case. Today `HasDevice` is `Site → Device` and `HasRack` is
`Premises → Rack`, and the two roots are unrelated — so **the only way for anything to be in
a building is to be bolted into a rack.** An access point on a wall, a switch on a desk, a
mini PC on a shelf: none of them can say which building they are in.

His own words settle the requirement — *"we'll need to be able to put it into a building, but
it doesn't have to be in one… 99.9% of equipment will be"* — so the relationship is
**optional and near-universal**, which is precisely the shape `HasDevice`/`MountedIn` already
use (`0..1` in, `0..n` out).

### 15.6 What it costs

New kinds are module bytes, and module bytes are the thing there are none of.

| | measured or estimated |
|---|---|
| one new kind, all its generated dispatch | **+602 measured** (`DhcpRelay`, WO-10 §2) |
| a reference edge | small, unmeasured |
| free bytes today | **203** |

So §15.5 is **pile C — blocked on the byte work**, like everything else. But the *decision* is
free and it is the usual asymmetry: settle it now and it is a schema edit; settle it after the
rack renderer, the cabling gesture and the trace are built on the current shape and it is a
migration plus three rewrites.

**The height field is in the wrong place and this is the moment to move it.** `height_u` is on
`MountedIn` — the mounting *relationship* — so a 2U server has no height until it is racked,
and unracking it loses the fact. Height is a property of the box: it belongs on `Chassis`,
with `MountedIn` keeping only `position_u` and `face`. Cheap now; a migration later.

## 16. The inventory never got Direction A, and it is the same defect

Found 2026-08-18 when the owner said, of a build he had just rebuilt:

> *"which PR/build was the one where when you are looking at equipment and click on it, you
> have like 3 pages opened, it was too much and you couldn't see anything"*

**He was describing the inventory, and he was right: the fix had landed on the diagram only.** *(Fixed 2026-08-22 — this section is the record of the defect, not a live report; `2026-08-21-inventory-direction-a.mjs` asserts the shared idiom.)*

### 16.1 What is actually on screen

`.ledger` is the shared two-column frame — `grid-template-columns: 62fr 38fr`, the *fact*
column and the *meaning* column. Direction A collapsed it **for one view**:

```css
.sheet[data-viewing="diagram"] .ledger { grid-template-columns: 1fr; }
```

and moved what had been the third region into the Outline's panel as a second tab. The
diagram went from three competing regions to two, and the picture grew 762 → 928 px.

**The inventory was never touched.** It still renders as:

| region | what it is |
|---|---|
| 1 | the kind strip |
| 2 | the table, inside the ledger's **62%** column |
| 3 | the meaning column, the remaining **38%** |

So picking a kind and clicking a row still puts three things on screen at once, and the table
— the thing a person came to read — gets 62% of what is left after the strip. On a laptop
that is a table with a horizontal scrollbar beside two columns of chrome.

**This is the same defect Direction A was written to fix.** It was fixed in one of the two
places it occurs, which is worse than not having noticed, because the two views now disagree
about their own idiom — and making them agree was the stated point of Direction A.

### 16.2 The fix

Not a new design. Apply the one that already exists:

1. Collapse the ledger for the inventory as it is collapsed for the diagram — the selector
   already exists and needs one more view in it.
2. Move the meaning column into a tabbed panel beside the table, using the same
   `OBJECTS` / `DETAILS` pattern the diagram now uses (`dgPaneSet` / `dgPaneApply` and the
   `#doutHead` tab are the working reference).
3. Selecting a row turns the panel to `DETAILS`, exactly as selecting a box does. Escape
   returns to the list. The keyboard path is the diagram's, already driven and passing.

**Page-side. No module bytes, no schema change, no owner decision.** It belongs in §14.1's
pile A as **A5** and it is probably the cheapest visible improvement left in the product.

### 16.3 One thing to check while doing it

The three browser drivers that broke when the diagram gained its panel broke for one reason —
they clicked a row, the panel turned to `DETAILS`, and the row they wanted next was no longer
on screen. **The inventory's drivers will break the same way**, and the fix is the same:
return to the list tab between selections. `2026-08-16-hand-link-drive.mjs` and
`2026-08-16-the-cut-that-drew.mjs` carry the pattern, and the helper is three lines.

Deferred to next week at the owner's direction, 2026-08-18: *"Nope we'll have to save it for
next week just make sure its all documented please."*

## Failure modes

- **This document is a record of design, not of code.** Nothing here has been driven in a
  browser and no number in it was measured except those cited to `47` and to the schema.
- **The five directions were judged against three requirements and then the owner added six
  more constraints** (§8). Only two of the five were re-examined against them, and only by
  reasoning rather than by rendering.
- **§12 was written from the schema and from reasoning, not from a render.** No drawing of
  cabling mode exists and the owner asked for no more renders this week.
- **One of five checks did not complete** (Facing Pages, API error), so that direction is
  recorded unchecked and should not be relied on.

## Sources consulted

| what | where | when |
|---|---|---|
| The containment chains, every kind and edge named here | `schema/schema.yaml` | 2026-08-17 |
| `trace_step`, its seven outcomes and the 16-hop cap | `19` §6.5, §6.6 | 2026-08-17 |
| `HAND_LINK_EXCLUDED`, `hand_link_candidates` | `crates/fathom-weld/src/lib.rs` | 2026-08-17 |
| The no-move refusal, in its own words | `crates/fathom-wasm/src/shell.rs` `rack_place` | 2026-08-17 |
| Aggregation threshold of 6 | `crates/fathom-layout/src/agg.rs` | 2026-08-17 |
| Module ceiling and headroom, 899,797 of 900,000 | measured build | 2026-08-17 |
| Where the module's bytes are | `47` | 2026-08-15 |
| The zoom-ladder render, four rungs | `docs/80-review/evidence/2026-08-17-zoom-ladder-render.html` | 2026-08-17 |
| The five trace directions, with checks | `docs/80-review/evidence/2026-08-18-trace-directions-render.html` | 2026-08-18 |

## Disagreements

- **With myself, twice, and the owner was right both times.** I proposed the rack elevation
  in the side panel; a 42U elevation does not fit in a 380px column and I was letting the
  plumbing pick the design. I then proposed a full-screen takeover; the owner corrected that
  to the canvas swapping what it draws while the chrome stays, which is cheaper and better.
- **With myself, on §13, and the owner corrected it.** The section opened by ranking
  type-to-link above drag-and-drop. That was wrong: they do different jobs — the drag
  captures, the field completes — and ranking them would have produced a slower product and
  a form nobody finishes. Retracted in §13.5, which also promotes open decision 8 from a
  preference to a blocker.
- **With the five designs, on §8.** They were evaluated before the owner's last constraints
  arrived. "Dozens of racks" is not a detail — it refutes The Open Spine's central premise,
  and no reviewer had the chance to say so.
