# ADR-0073: Cards and optics — parts in slots and cages, tracked like devices

**Status:** accepted 2026-10-26. The owner approved sign-off card r35-cards that day: a card is "a
part in a slot", an optic is "a detail of the port", and the extras "read from paste", "catalogue
slots" and "swap in maintenance" (spares were not ticked). The owner's notes: "sfp's should be
draggable as well, and are monitored in inventory and such", and "make sure it integrates with
teaching, troubleshooting, and maintenances".

## Decisions

1. **A card is a node, `Card` (schema 0.28).** It sits in a slot by `HasCard` (containment), from a
   `Chassis` or from another `Card` (a sub-slot: a PIC in an FPC, a MIC in an MPC). Its identity is
   its owner and its `slot` name. It carries `name`, `model` and `serial`.
2. **A card's ports stay on the chassis.** Each keeps its `HasPort` from the chassis and gains an
   `OnCard` reference to its card. Every reader that walks a port up to its device (the canvas,
   lessons, changes, trouble, hosts, networks) keeps working unchanged; a card is a fact about the
   port, not a new owner of it. Taking a card out removes its ports and their ends; the cables stay
   as loose ends.
3. **An optic is the port's `transceiver` field, now with a shape**: `{ type, vendor, part, serial,
   wavelength_nm }`, every member optional. Unknown means nobody looked, Absent means an empty cage,
   `{}` means fitted and nothing more known. Moving an optic between cages is one undo step, by a
   drag from the port panel onto a port on the plate, or from a list.
4. **One Parts list in Inventory** holds every card, swappable power supply and optic, where it sits,
   its model and its serial; serial and model edit in place.
5. **Paste reads parts.** `show inventory` (Cisco) and `show chassis hardware` (Junos) offer each card,
   optic and supply they report. An optic for an empty cage is offered ticked; a card that is not
   drawn, or a serial that differs, is offered unticked (the drawing wins, ADR-0046); a part with
   nothing to land on is only said.
6. **The catalogue may list `card_slots`** by the vendor's own names. The device's Cards panel shows the
   empty ones and offers them when a card is fitted. No catalogue model lists any yet: each will be
   added with its own cited source, as the PSU slots were.
7. **Maintenance gets a Swap a part step** (`PlanStep.kind` `swap`, edit line `part`): the part, the new
   model and serial, applied in place on Done so its slot, ports and cables stay. The preview says how
   many ports on a card, and how many cabled, go down while it is out, or which link an optic carries.
   Back out puts the old serial back.
8. **Teaching:** a Cards and optics lesson on a new parts-lab sample. **Troubleshooting:** It's down's link
   step names the optic in each cage and the card a port is on as suspects; a path trace's cable hop
   says which card each end is on and what optic it holds.
9. **Serials never leave in an AI reading or a trace.** The AI reading lists a card's slot, name and
   model and strips an optic's serial, as it already did for the chassis.

## Kept open

Spares (an "available inventory" thread asked that parts be able to exist unfitted, with history that
follows the serial): `CardHost` can gain a store member later, and the swap step's choice of a new part
can then be filtered to spares. Spare optics would need a kind of their own. Neither is built.

## Sources

- Junos `show chassis hardware` rows (FPC, PIC, Xcvr, PEM): Juniper Networks, CLI reference "show chassis
  hardware", MX960 sample, read 2026-10-26.
- Cisco `show inventory` entries for optics, supplies and modules, and an empty PID for a third-party
  optic: layer23-switch.com "How to check SFP type"; community.cisco.com "SFP transceiver module not
  detected stacked switch 3850" (a C9200-48P output), both read 2026-10-26.
- Optics are hot-removable and hot-insertable: Juniper Networks, "Maintain Transceivers", EX4400
  hardware guide, read 2026-10-26.
