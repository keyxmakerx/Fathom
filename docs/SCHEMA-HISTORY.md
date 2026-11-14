# Schema version history

Each minor version of `schema/schema.yaml`: what it added, and how it was priced against the schema spec's change table (62 §16.2). Moved here from the comment on the schema's `version` key on 3 November 2026 (sign-off r107). The text is as it was written at each bump. A new version adds one line under the schema's `version` key and its entry at the end here.

Versions 0.15 and 0.16 (maintenance plans, custom-field values) were never written up separately; 0.17's entry names them. 0.34 (Termix in the work, ADR-0080) has no entry; docs/STATE.md describes it.

## 0.1 and 0.2

0.1 was one minor bump from an empty baseline (19 §7.5, 62 §16.1 — 62's "3.2" is explicitly illustrative). 0.2 added physical placement (ADR-0035), priced against 62 §16.2's table item by item: one new node kind (Rack, minor), two new edge kinds (HasRack, MountedIn, minor), seven new fields all optional-or-on-a-new-declarer (minor), zero removals, zero retypes, zero reordered tuples, no containment restructured — MountedIn is a reference, so no existing kind's owner changes. Whole change = MINOR.

## 0.3

0.3 adds two `Device.role` variants, `server` and `access_point` (ADR-0037). Priced the same way: 62 §16.2's table reads "New enum variant | minor | Variant::Unknown(token) — the generated arm", twice, and there is nothing else in the change — no kind, no edge, no field, no key. An old build reading a 0.3 export gets `DeviceRole::Unknown("server")` and renders the token, which is the forward-compatibility the unknown arm exists for.

The two are declared BEFORE `other` rather than appended after it, and that is deliberate. `other` is not a peer of the six: it is the taxonomy's escape hatch and it reads last everywhere the variants are listed — the generated `DECLARED` array, `schema.json`, the form's dropdown, the refusal message. Nothing in the tree depends on a variant's ordinal: the canonical form of every schema enum is its token (`Json::Str(self.token())`, 62 §7), the wire key registry is untouched because no FIELD moved, and no code sorts a `DeviceRole`. `crates/fathom-ir/tests/generated_contract.rs` pins that the canonical form is the token, so if a later change ever does make the ordinal load-bearing, it fails a test rather than silently rewriting old exports.

## 0.4

0.4 relaxes ONE cardinality: PhysicalPort.label goes "1" → "0..1" (owner, 2026-08-28, 70 §18 — closing 57 §13.5's open decision 8, which was the hard blocker on all of cabling mode). Priced against 62 §16.2: "Relaxed constraint / widened cardinality upper bound" reads minor; a LOWERED lower bound is the same relaxation read from the other end — every 0.3 export is a valid 0.4 export, and an old build reading a new export meets a missing optional where it expected a required, which is the tolerated direction. Nothing else moved: no kind, no edge, no retype, no tuple reordered. Whole change = MINOR.

## 0.5

0.5 is WO-10 (2026-08-29): the DhcpRelay kind, three edge kinds (HasDhcpRelay, RelaysFor, RelayServerIn), four fields all on the new declarer, four field keys 308-311. Priced against 62 §16.2: "New node kind | minor", "New edge kind | minor" three times, and "New optional field" / fields on a new declarer are minor by the same table. An old build reading a 0.5 export meets a kind it does not declare and keeps it in `unknown`, which is the forward-compatibility the table promises. Nothing existing moved: no retype, no tuple, no containment restructured -- DhcpRelay hangs off Device by a NEW containment edge, so no existing kind's owner changes. Whole change = MINOR. RelayServerIn is the third edge because the owner chose it (70 §18.5) over a string field that would have been invariant 7's natural-key reference.

## 0.6

0.6 is the cables session's schema half (docs/UI-SPEC.md "Cables", "Power"): one new optional field, `Cable.sheath` (field key 312, the next in `schema/field-keys.yaml`), and two enum variants each on two already-keyed fields — `PhysicalPort.connector` gains `c13`/`c14`, `PhysicalPort.service` gains `power` — so a PDU's outlets and a device's PSU inlets are ports the way UI-SPEC "Power" draws them. Priced against 62 §16.2 exactly as 0.2 and 0.3 were: "New optional field" is minor (the field is new, its declarer — Cable — is not), and "New enum variant | minor | Variant::Unknown(token)" three times. No kind, no edge, no retype, no removal, no field key reused or renumbered. Whole change = MINOR.

## 0.7

0.7 is ADR-0050 (the rear elevation, 2026-09-16), all additive: two optional fields on the existing declarer Rack — row and bay, the row a rack stands in and its place within it (62 §16.2: "New optional field" is minor); one new node kind, PowerSupply, a field-replaceable supply that occupies a chassis slot, joining the PortHost class because a hot-swappable supply carries its own inlet port (62 §16.2: "New node kind" is minor, and the Placeable/PortHost class widenings are "New enum variant"-shaped in 62's table — a class member added, nothing removed); one new edge kind, FittedIn, seating a PowerSupply in its Chassis (62 §16.2: "New edge kind" is minor). FittedIn is CONTAINMENT, not reference like MountedIn: MountedIn is forced to be a reference because Chassis already has a containment parent (Device, via HasChassis) and containment is a forest, so a rack cannot also contain the chassis (MountedIn's own doc, ADR-0036). PowerSupply has no such competing claim — nothing else contains it — so the same forest rule that forces MountedIn to be a reference does not apply, and containment is free to be the answer FittedIn gives. It is also the answer PowerSupply's declared identity, `[owner(Chassis), slot]`, needs: every `owner(X)` identity term elsewhere in this tree (Rack's `owner(Premises)`, PhysicalPort's `owner(PortHost)`, PassiveNode's `owner(Premises)`) is backed by a containment edge with `in: "1"` — HasRack's own doc says so in as many words ("in: 1 keeps containment a forest and makes owner(Premises) usable as Rack's identity term") — and no `owner()` term in this schema is backed by a reference edge. FittedIn follows that same, only, convention: HasPort's and HasRack's, not MountedIn's. Five new field keys, 313-317 (Rack.row, Rack.bay, PowerSupply.slot, PowerSupply.serial, PowerSupply.model), one new kind (51 -> 52), one new edge (95 -> 96). No kind removed, no retype, no tuple reordered, no containment moved for anything that already had one. Whole change = MINOR.

## 0.8

0.8 is ADR-0051 §1 (the shapes, before v0.1, 2026-09-18), all additive. Three new enum variants on the existing declarer PassiveNode.form — shelf, outlet, board (62 §16.2: "New enum variant" is minor, three times). One new edge kind, SitsOn, seating a Chassis or PassiveNode on a shelf's slot (62 §16.2: "New edge kind" is minor); one field on its new declarer, slot (62 §16.2: a field on a new declarer is minor). A REFERENCE edge, and for MountedIn's own reason: a Chassis already has a containment parent (Device, via HasChassis) and a PassiveNode already has one (Premises, via HasPassiveNode), and containment is a forest, so a shelf cannot also contain either — the schema cannot say the target's form is shelf, and the doc says the client refuses anything else. One new node kind, Surface — a wall, floor, desk or ceiling a device or passive can be fixed to — joining the Placeable class exactly as Rack did (ADR-0036), because a surface draws as a flat panel beside the rack rows the same way a rack elevation is a separate renderer from the topology diagram (62 §16.2: "New node kind" is minor, and the Placeable class widening is "New enum variant"-shaped in 62's table). One new edge kind, HasSurface, containing a Surface in its Premises, in the manner of HasRack — CONTAINMENT, because Surface's declared identity, `[owner(Premises), label]`, needs the same convention every other `owner(X)` identity term in this tree already uses (HasRack's own doc: "in: 1 keeps containment a forest and makes owner(Premises) usable as Rack's identity term") (62 §16.2: "New edge kind" is minor). One new edge kind, FixedTo, fixing a Chassis or PassiveNode to a Surface or a PassiveNode of form board (62 §16.2: "New edge kind" is minor); two fields on its new declarer, x_mm and y_mm (62 §16.2: fields on a new declarer are minor). A REFERENCE edge, for the same forest reason SitsOn is one: the schema cannot say a Chassis or PassiveNode carries at most one of MountedIn, SitsOn and FixedTo, and the doc says the client enforces it. One new optional field on the existing declarer PhysicalPort, face (62 §16.2: "New optional field" is minor) — the faceplate the port sits on, absent meaning front or the catalogue's. Two new enum variants on PhysicalPort.connector, nema515r and nema515p, beside c13 and c14 (62 §16.2: "New enum variant" is minor, twice). Eight new field keys, 318-325 (SitsOn.slot, Surface.label, Surface.form, Surface.width_mm, Surface.height_mm, FixedTo.x_mm, FixedTo.y_mm, PhysicalPort.face), one new kind (52 -> 53), three new edges (96 -> 99). No kind removed, no retype, no tuple reordered, no containment moved for anything that already had one. Whole change = MINOR.

## 0.9

0.9 is ADR-0052 §3 (the config drawer, 2026-09-18), all additive. One new node kind, Capture — what the redaction gate let through, owned by Device — joining the Placeable class exactly as Surface did (0.8), for the same reason every declared kind but LayoutPin does: the class means "every kind the diagram can draw as a box", stated as a full list, and `shipped_tree.rs::every_kind_but_the_pin_itself_is_placeable` is the noticer if a new kind is left out (62 §16.2: "New node kind" is minor). Four fields on the new declarer — text, platform, line_count, shape (62 §16.2: fields on a new declarer are minor). One new edge kind, HasCapture, containing a Capture in its Device, in the manner of HasChassis (62 §16.2: "New edge kind" is minor). Four new field keys, 326-329 (Capture.text, Capture.platform, Capture.line_count, Capture.shape), one new kind (53 -> 54), two new edges — HasCapture and, through Placeable, the extra HasLayoutPin pair — (99 -> 100 declared edge count; HasLayoutPin itself is not a new edge KIND, only a wider pair set). No kind removed, no retype, no tuple reordered, no containment moved for anything that already had one. Whole change = MINOR.

## 0.10

0.10 is ADR-0053 §5 (undo that records, notes and the private layer, 2026-09-19), all additive. One new node kind, Note — the text of a note on a device, port or rack, how it arrived and, for a paste, its line count — joining the Placeable class exactly as Capture did (0.9), for the same reason every declared kind but LayoutPin does (62 §16.2: "New node kind" is minor). Three fields on the new declarer — text, how, line_count (62 §16.2: fields on a new declarer are minor). One new class, Notable — Device, PhysicalPort and Rack, the owners of a note (62 §16.2 has no row for a class widening or addition because a class is not itself wire data; ADR-0036 and ADR-0051 §1 already added members to Placeable without moving the version by more than the kind or edge that motivated it, and a new class is the same shape of change again — nothing it names did not already exist). One new edge kind, HasNote, containing a Note in whichever of Device, PhysicalPort or Rack owns it, HasLayoutPin's own shape of a class on the `from:` side rather than HasChassis's single kind (62 §16.2: "New edge kind" is minor). Three new field keys, 330-332 (Note.text, Note.how, Note.line_count), one new kind (54 -> 55), one new class (4 -> 5), one new edge — HasNote — plus, through Placeable, the extra HasLayoutPin pair for Note (HasCapture's own precedent: HasLayoutPin is not a new edge KIND, only a wider pair set). No kind removed, no retype, no tuple reordered, no containment moved for anything that already had one — Rack's own "no notes field" stays literally true, because Rack still declares no `notes`-shaped field of its own; a note is a node reached through HasNote, never a field. Whole change = MINOR.

## 0.11

0.11 is ADR-0058 (networks in Inventory; Docker on its host, 2026-09-25), all additive. Three new node kinds, ContainerNetwork, Container and PublishedPort, all emits: false, config layer, owned by Device (Container's PublishedPort owned by Container) -- a Docker guest is a node in the same graph as a switch, not a Device field (62 §16.2: "New node kind" is minor, three times). Nine fields, all on their new declarers (62 §16.2: fields on a new declarer are minor). Five new edge kinds -- HasContainerNetwork, HasContainer, HasPublishedPort (containment, HasVlan's and HasCapture's own shape), AttachedTo and ParentUnit (reference, MountedIn's own shape: both targets already have a containment parent) (62 §16.2: "New edge kind" is minor, five times). One field on AttachedTo, address (fields on a new declarer are minor). The Placeable class widens by three members (ADR-0036's and ADR-0051 §1's own precedent: a class widening is "New enum variant"-shaped in 62's table). Ten new field keys, 333-342 (ContainerNetwork.name/.driver/ .subnet/.gateway, Container.name, PublishedPort.protocol/ .container_port/.host_port/.host_address, AttachedTo.address). Three new L0 constraint declarations (vlanmember.same-device, parentunit.same-host, attachedto.same-host) -- declarations only, the same shape as occupies.same-device; they add no field, edge or kind and move no count in this function. No kind removed, no retype, no tuple reordered, no containment moved for anything that already had one. Whole change = MINOR. Decision 6 holds regardless: the client and server read 0.10 payloads and write 0.11, so a design saved before this lands keeps opening after it.

## 0.12

0.12 is ADR-0059 (tags, 2026-09-26), all additive. One new node kind, Tag (one field, name, key 343), joining Placeable as every kind but LayoutPin does. One new class, Taggable. Two new edge kinds, HasTag (containment, HasTenant's own shape, root to Tag) and TaggedWith (reference, AttachedTo's own shape, Taggable to Tag, both ends 0..n) (62 §16.2: each of these is minor). No kind removed, no retype, no tuple reordered, no containment moved for anything that already had one. Whole change = MINOR. Decision 9 holds regardless: the client and server read 0.11 payloads and write 0.12.

## 0.13

0.13 is ADR-0060 step 7 (free boxes and lines, 2026-10-02), all additive: two node kinds, Label and Line (joining Placeable), three edge kinds, HasLabel and HasLine (root containment, HasTag's shape) and LineEnd (reference, Line to Chassis), seven field keys (344-350, PassiveNode.slots last). Whole change = MINOR; the reader still opens 0.10 to 0.12 payloads.

## 0.14

0.14 is ADR-0061 round 7 (docs, 2026-10-03), all additive: three node kinds, Doc, DocLink and DocFile (all join Placeable as Tag does), one class, Docable, four edge kinds, HasDoc (root containment, HasTag's shape), DocOn (reference, Doc to Docable), HasDocLink and HasDocFile (containment, Doc to DocLink or DocFile); thirteen field keys (351-363). Whole change = MINOR. 0.15 is ADR-0061 round 7, maintenance plans (2026-10-03), all additive: two node kinds, MaintenancePlan and PlanStep (joining Placeable), two edge kinds, HasPlan (root containment, HasTag's shape) and HasStep (containment, plan to step), seventeen field keys (364-380). Whole change = MINOR; the reader still opens 0.10 to 0.14 payloads. 0.16 is custom-field values (2026-10-02), all additive. One new node kind, FieldValue (value, definition; keys 381-382), joining Placeable as Tag does. One new class, Fieldable. Notable widens to Cable, Vlan and ContainerNetwork. One new edge kind, HasFieldValue (containment, HasNote's shape) (62 §16.2: each is minor). The DEFINITIONS are not in the graph: they are an organisation-wide server store (ADR-0062), and a value names its definition by id in `definition`. Nothing removed, retyped or reordered. Whole change = MINOR: the client and server read 0.10 to 0.15 payloads and write 0.16.

## 0.17

0.17 is ADR-0061 path trace, part 1 (2026-10-03; 0.15 and 0.16 are maintenance plans and custom-field values). No kind or edge moves. Five structured value types that were unit structs get shapes: PolicyScope (ZonePair, InterfaceDirection, Global), AddressValue (Prefix, Range, Host, Fqdn, Any), L4Spec (Any, or a protocol with port ranges), NatScope and NatAction. A unit struct serialised as {}, and ingest never wrote one, so no stored payload holds the old form. One optional field, SecurityPolicy.match_any_application (key 383), joins its two siblings so a policy can say "any application" (62 §16.2: minor). Whole change = MINOR; the reader opens the same older versions as before.

## 0.18

0.18 is ADR-0061 troubleshooting (2026-10-03), all additive: two node kinds, Issue and IssueStep (joining Placeable), two edge kinds, HasIssue (root containment, HasPlan's shape) and HasIssueStep, fifteen field keys (390-404). Whole change = MINOR. The reader still opens 0.10 to 0.17.

## 0.19

0.19 is firmware targets (2026-10-10), all additive: one node kind, FirmwareTarget (joining Placeable as Tag does), one edge kind, HasFirmwareTarget (root containment, HasTag's shape), one Device field, firmware_hold; seven field keys (405-411). Whole change = MINOR. The reader still opens 0.10 to 0.18.

## 0.20

0.20 is the owner's ticked ideas (2026-10-10), all additive. Two optional fields on the existing declarer PhysicalPort, plate_x and plate_y (keys 412-413; 384-389 stay held elsewhere): where a hand-typed port was dragged to on its faceplate, in thousandths of the plate's width and height to the port's centre. Not `position`, which is tier-1 identity. One enum variant, `note`, on Label.form: a sticky note pinned to the canvas. 62 §16.2: "New optional field" is minor, twice; "New enum variant" is minor. No kind, edge or key moved. Whole change = MINOR. The reader still opens 0.10 to 0.19.

## 0.21

0.21 is the round 15 quality-of-life items (2026-10-10), additive. One optional field on the existing declarer PhysicalPort, mac (key 462, MacAddress): the hardware address seen on that port, so Find answers a MAC with the port and where it is plugged. 62 §16.2: "New optional field" is minor. No kind, edge or key moved. Whole change = MINOR. The reader still opens 0.10 to 0.20.

## 0.22

0.22 is the describe-a-model builder (2026-10-10), all additive. Three enum variants on the existing PhysicalPort.face — left, right, top — so a box with ports on its sides or top (the owner's NUC, sign-off r15-catalogue) can say so. 62 §16.2: "New enum variant" is minor, three times. No kind, edge or key added or moved. Whole change = MINOR. The reader still opens 0.10 to 0.21.

## 0.23

0.23 is cable runs and ties (round 15 cable styles, 2026-10-10), all additive: two node kinds, CableRun (a tray or lacing bar along one side of a rack or wall) and CableTie (a tie clipped somewhere along a run); three edge kinds, HasCableRun (containment from Rack or Surface), HasCableTie (containment from CableRun) and Ties (reference, CableTie to the Cables it holds); four field keys (414-417). 62 §16.2: new kinds and edges are minor. Whole change = MINOR. The reader still opens 0.10 to 0.22.

## 0.24

0.24 is missing links for cables (round 26 point 6, round 27 points 1-2, 2026-10-16), additive: one optional field on the existing declarer Cable, needs_finishing (key 478, bool): a person marked this cable's loose end as planned or unfinished work. Absent means a cable with one end connected is Unknown (a legacy drawing where nobody knows the far end). Whether a cable is loose at all is never stored: it is read off the drawing, from fewer than two Terminates. 62 §16.2: "New optional field" is minor. No kind, edge or existing key moved. Whole change = MINOR. The reader still opens 0.10 to 0.23.

## 0.25

0.25 is the LAG plan step (sign-off plan-ideas, 2026-10-25): one new enum variant, `lag`, on PlanStep.kind. Its edit line (`lag` first) bundles member Interfaces of one device into a new AggregateInterface when the step is done. 62 §16.2: "New enum variant" is minor. No kind, edge or key added or moved. Whole change = MINOR. The reader still opens 0.10 to 0.24.

## 0.26

0.26 is mesh VPNs on the diagram (sign-off r16-overlay, 2026-10-25), all additive: one node kind, OverlayNetwork (a Tailscale tailnet, a NetBird network, a WireGuard tunnel and the like), hung off the root through HasOverlay (containment), and OverlayMember (reference, network to Device) carrying that member's overlay address, whether it is an exit node, and the subnet routes it offers. Seven field keys (479-485). 62 §16.2: new kinds and edges are minor. Whole change = MINOR. The reader still opens 0.10 to 0.25.

## 0.27

0.27 is the lesson builder (ADR-0066 §2, 2026-10-25), all additive: two node kinds, Lesson and LessonStep (joining Placeable, as Issue and IssueStep do), two edge kinds, HasLesson (root containment, HasIssue's shape) and HasLessonStep, twenty-two field keys (486-507). A lesson is written in the design it teaches; publishing copies the whole design, so its steps keep naming design ids. Whole change = MINOR. The reader still opens 0.10 to 0.26.

## 0.28

0.28 is cards and optics (ADR-0073, sign-off r35-cards, 2026-10-26), all additive: one node kind, Card (a line card, module or NIM in a slot), seated by HasCard (containment) in a Chassis or in another Card's sub-slot, and OnCard (reference, port to card) saying which ports are on it; one class, CardHost. Transceiver, unit until now, gains its shape (type, vendor, part, serial, wavelength_nm, all optional); it was never writable except as {}, which still reads. Four field keys (508-511). PlanStep.kind gains `swap`, a part replaced in a maintenance window. 62 §16.2: new kinds, edges and a class member are minor. Whole change = MINOR. The reader still opens 0.10 to 0.27.

## 0.29

0.29 is the room builder (ADR-0051, ADR-0074 decision 4, sign-off r37-estate v2), all additive: three node kinds, FloorPlan (a plan image behind a building's rooms, scaled by two points), Room (a named room on a floor) and RoomCorner (one corner of a room's outline, in millimetres), contained by HasFloorPlan and HasRoom from Premises and HasRoomCorner from Room. Twelve field keys (512-523). 62 §16.2: new kinds and edges are minor. Whole change = MINOR. The reader still opens 0.10 to 0.28.

## 0.30

0.30 is available inventory (ADR-0076, sign-offs r36-stock and r38-stock-how, 2026-10-26), all additive: three node kinds hung off the root, Store (a cupboard, shelf or room spares sit in), StockItem (a part on hand but not fitted: spare, reserved, on order, in repair, lent or retired) and StockLevel (the fewest spares of one model to keep); their root containment edges HasStore, HasStock and HasStockLevel; and three reference edges, InStore (item to store), ReservedFor (item to the plan step that will fit it) and ForIssue (item to the issue it went for repair under). StockItem joins Fieldable so custom fields (price, supplier) fill on it. Eighteen field keys (524-541). 62 §16.2: new kinds, edges and class members are minor. Whole change = MINOR. The reader still opens 0.10 to 0.29.

## 0.31

0.31 is upgrades Fathom has no steps for (sign-off r55-fw-by-hand, 2026-10-28), all additive: one optional Device field, firmware_target, the version chosen for that one device when none of its chassis has a catalogue model (a custom-built NAS). One field key (542). 62 §16.2: an optional field is minor. Whole change = MINOR. The reader still opens 0.10 to 0.30.

## 0.32

0.32 is links between sites (ADR-0079 decision 5), all additive: two optional fields on ExternalPeer, far_design (the id of the design the far end is in) and far_element (the id of the port there), so a cable to the peer is a link to another site. Two field keys (543-544). 62 §16.2: new optional fields are minor. Whole change = MINOR. The reader still opens 0.10 to 0.31.

## 0.33

0.33 is the plan-to-maintenance flow (sign-off r73-plan-flow, 2026-11-01), all additive: two optional MaintenancePlan fields, checks (typed checks after the work, each with its answer) and release_notes (pasted, gated in the browser); four optional PlanStep fields, if_when, branch_of and if_taken (one If path under a step) and issue (the It's down issue Troubleshoot opened from it); one optional Issue field, step, its other end. Seven field keys (545-551). 62 §16.2: optional fields are minor. Whole change = MINOR. The reader still opens 0.10 to 0.32. 0.34 is Termix in the work (ADR-0080 decisions 5 and 10, 2026-11-01), all additive: two optional PlanStep fields, seen (what the person pasted for a check step, after the redaction gate) and compared (Fathom's verdict on it), and one optional PhysicalPort field, console_baud (a console port's speed in bits per second). Three field keys (552-554). 62 §16.2: new optional fields are minor. Whole change = MINOR. The reader still opens 0.10 to 0.33.

## 0.35

0.35 is the Work tab's ticket parts (sign-off r74, 2026-11-02), all additive: assigned_to and ticket on MaintenancePlan, Issue and StockItem, and due on Issue (a plan has its window, an item its own due). Notable widens to MaintenancePlan, Issue and StockItem, so a comment on a piece of work is a Note, who and when from its provenance. Seven field keys (555-561). The Fathom number is not a field: the server gives it (estate index, ADR-0087). 62 §16.2: optional fields and a widened class are minor. Whole change = MINOR. The reader still opens 0.10 to 0.34.

## 0.36

0.36 is the IP plan store (ADR-0083, 2026-11-02), all additive: a fourth layer, `plan`, for records the organisation's IP plan store keeps on the server and a design never holds (a design naming one is refused on read). Eleven new kinds -- IpamVrf, IpamRouteTarget, IpamAggregate, IpamPrefix, IpamRange, IpamAddress, IpamReservation, IpamVlanGroup, IpamVlan, IpamAsnRange, IpamAsn -- all emits: false, no edges and no classes: a record names another by store id, and meets the drawing by value. No new scalar: the ADR's IpNetwork is the existing IpPrefix, which already reads both families. Seventy-five field keys (562-636). 62 §16.2: new node kinds are minor; a new layer value is a new closed-vocabulary arm no stored design can carry. Whole change = MINOR. The reader still opens 0.10 to 0.35.

## 0.37

0.37 is a plan's other ending (sign-off r94-plan-next, 2026-11-02): one enum variant, `called_off`, on MaintenancePlan.stage, for a plan stopped before any work, its reason in the existing `record`. Nothing removed, retyped or reordered. 62 §16.2: a new variant on a closed enum is minor. Whole change = MINOR. The reader still opens 0.10 to 0.36.

## 0.38

0.38 is a plan's team (sign-off r102-plan-approval version 2, 2026-11-02): one optional field, MaintenancePlan.team, the team that owns the plan, by its server id (field key 637). Its lead or supervisor approves the plan where a folder asks for approval. Nothing removed, retyped or reordered. Whole change = MINOR. The reader still opens 0.10 to 0.37.

## 0.39

0.39 is NAT on firewalls (sign-off r104, round 3 of the routing build order, 2026-11-02): one new kind, NatPool (a source or destination NAT pool, which NatAction::Pool names), its containment edge HasNatPool, and one optional field on NatRule, match_destination_port. Six field keys (638-643). 62 §16.2: a new node kind, a new edge kind and an optional field are each minor. Whole change = MINOR. The reader still opens 0.10 to 0.38.

## 0.40

0.40 is where a thing sits on a shelf (sign-off shelf-view, 2026-11-12 and 2026-11-13): two optional fields, SitsOn.x_mm, millimetres from the shelf's inside left edge, and SitsOn.y_mm, millimetres back from its front lip, set by dragging a device in the shelf view's front view and its strip seen from above (field keys 644 and 645). The slot stays the left-to-right order. Nothing removed, retyped or reordered. 62 §16.2: a new optional field is minor, twice. Whole change = MINOR. The reader still opens 0.10 to 0.39.

## 0.41

0.41 is plaintext management services (sign-off r137, 2026-11-14): two optional fields on SystemSettings, telnet_enabled and http_enabled, set when a device's own config turns on a telnet server or unencrypted HTTP for managing it (field keys 646 and 647). They feed the check `sec.mgmt.plaintext`. Absent means the reader found nothing, never that the service is off. Nothing removed, retyped or reordered. 62 §16.2: a new optional field is minor, twice. Whole change = MINOR. The reader still opens 0.10 to 0.40.
