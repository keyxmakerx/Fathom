# 57 — The zoom ladder and the trace

> **Status:** Proposed · **Opened 2026-08-17, parked 2026-08-18 at the owner's direction**
> (usage limits — *"we are gonna have to stop here for the week"*).
> **Nothing in this document is built.** No `.rs` file, no `schema/` change and no page
> change came out of it. It exists so that a week's design conversation is not lost, and so
> the next session starts from the findings rather than from the questions.

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
8. **How is "cable to that device, port unknown" recorded?** §13.2. Three routes priced,
   none chosen; the likeliest is relaxing `PhysicalPort.label` to `0..1`. Cheap now.

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

**This is a better data-entry design than §12's drag-and-drop, and it should lead.** Three
reasons, none of them aesthetic:

1. **It is faster where the work actually happens.** Documenting an estate is a list-shaped
   job — you go down the ports of a switch one at a time. Typing never leaves the keyboard;
   dragging means finding two things on a canvas for every one cable.
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
better. The two designs are complementary rather than competing: type-to-link for the
one-at-a-time case, a range gesture for the panel case, and §12's drag for the case where a
person is looking at a picture rather than a list.

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
- **With the five designs, on §8.** They were evaluated before the owner's last constraints
  arrived. "Dozens of racks" is not a detail — it refutes The Open Spine's central premise,
  and no reviewer had the chance to say so.
