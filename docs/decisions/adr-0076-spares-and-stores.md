# ADR-0076: Spares and stores — what is on hand but not fitted

**Status:** accepted 2026-10-26. The owner approved sign-off card r36-stock (state plus store; a named
store listed, not drawn; every hook, including paste and CSV, prices, suppliers and orders), then card
r38-stock-how after asking that the work reuse what is built rather than redo it, and that it keep in
mind how and why a person would reach it and add to it. Their r38 answers: prices are custom fields;
who sees prices is whoever sees the design; who edits is whoever may Draw; stock is per design; the ways
in are type, paste, import, from a device, an AI and a camera scan; and the AI reads stock, sees prices
at the notes tier, may recommend stock, and the Connect page says so. Their note on r38 asked for a
phone view without a native app; that is its own piece of work (ADR-0068 point 8).

Builds on ADR-0073 (cards and optics), whose "Kept open" this closes.

## Who uses it, and why

- **Whoever keeps the spares cupboard**: what is on the shelf, what is away for repair, what is lent, and
  whether there are enough of a model.
- **Whoever plans or does a swap**: is there a spare for this part, and where is it; keep it for the job.
- **Whoever is fixing an outage** (It's down): is a spare on hand, so a test swap is possible now.
- **A teacher**: the parts lab now has a cupboard, so a lesson can show why spares and RMAs matter.

## Decisions

1. **Three kinds, hung off the root with no edge, as a Tag is (schema 0.29).** `Store` (a cupboard,
   shelf or room, by name; a place and a note in words), `StockItem` (one thing on hand, or a count of
   identical things without a serial) and `StockLevel` (the fewest spares of one model to keep, one per
   model). A store is listed, not drawn, until Sites and rooms are; its bins are words on the item.
2. **An item has a state**: spare, reserved, on order, away for repair, lent or retired. A reserved item
   names its plan step (`ReservedFor`); one away for repair may name the issue it is for (`ForIssue`)
   and carries the vendor's RMA number and when it is due back; a lent one says who has it. Retired
   stays listed, so a serial's history is never lost.
3. **Fitting is the existing swap.** A spare going in is ADR-0073's Swap a part: the fitted Card,
   PowerSupply or optic takes the spare's model and serial (an optic its whole description), the spare's
   item ends, and the part that came out becomes an item with where it was fitted frozen in `came_from`.
   One undo step. The serial's history reads from the design's own change history; nothing new learns
   how to fit a card. Taking a part out into stock (Add to stock › From a device) removes it from the
   drawing and makes its item in one step.
4. **A swap step picks from stock.** The step form offers the spares of the part's sort, its model first;
   picking one fills the serial and model and keeps it for the step. Marking the step done fits that
   spare from stock. The part that came out goes in as retired unless the person says otherwise, so a
   part nobody looked at is never counted as a spare.
5. **One place in Inventory: Parts › On hand.** Parts gets a Fitted / On hand switch rather than a new
   kind. On hand lists items by state (On hand, On order, Away for repair, Lent out, Retired, All), says
   which models are below the level kept, and holds the stores and the levels. An item opens in place to
   edit and to move it on (it arrived, back from repair, given back, used it, lend, send for repair, on
   order, retire). A store opens its own page, bin by bin: the page a printed bin label opens on a phone.
6. **Four ways in**, all on one Add to stock panel: type one (a serial makes it one item; without one,
   give a count); paste a list, a spreadsheet's rows or a device's own `show inventory` / `show chassis
   hardware`; import a CSV or tab-separated file with a header row; or pick parts out of a drawn device.
   A paste goes through the browser's redaction gate first (CLAUDE.md rule 4) and only the rows added are
   kept. A serial already in stock is refused, so a second paste of the same list adds nothing twice.
   Columns the reader does not know (a price, a supplier) are named so they can become custom fields.
   The serial box is a plain field marked for the phone's scan button.
7. **Prices, suppliers and orders are custom fields** on a spare (field kind `part`, migration 0049).
   On hand offers a starter set, Price, Supplier, Order number and Warranty end, made once as the
   organisation's own fields. Whoever reads the design reads them.
8. **Checks:** `stock.level.below-minimum` fires on a level with fewer spares of its model on the shelf.
   A check cannot add counts up, so it judges models tracked one by one and leaves a model with a counted
   spare to the Inventory, which adds them up. Anything away, lent, on order or kept for a plan does not
   count.
9. **Troubleshooting:** It's down's link step, which already suggests swapping an optic or looking at a
   card, now says whether a spare is on hand and where ("one on hand in Comms cupboard, bin 1").
10. **The AI** (ADR-0072): the design reading lists stores, each spare's sort, model, name, state, count,
    bin and where it came from, and the levels kept, at the layout tier. Never a serial (an optic's is
    stripped as on a port), an RMA number or who has a loan. At the notes tier it adds a store's place
    and note, a spare's note and a spare's custom-field values with the field names; no other owner's
    custom-field values leave. `recommend` may target a store or a spare. The Connect page's tier words
    say all of this.
11. **Teaching:** the parts-lab sample gains a Comms cupboard with a spare optic, a spare card and fibre
    leads, and keeps at least two of its optic, so Checks has something to say; the Cards and optics
    lesson ends on the spare on the shelf and the RMA; Learn has a sourced explainer,
    `explain:concept:basics.spares`.

## Not built

- The firmware check does not cover spares: a spare has no version recorded. A `StockItem.version`
  field would let it; not added without a reason from the owner.
- Labels to print and the phone's scan button are the phone-view work (ADR-0068 point 8), which calls
  `StoreBinPage` and fills the serial field marked `data-scan-target="serial"`.
- Stock shared across designs (r38 chose per design).

## Sources

- An RMA number is how a vendor tracks a returned part, and asking for one needs its serial; the number
  goes on the outside of the box: Juniper Networks, "Contact Customer Support and Return Components",
  QFX5140 hardware guide, no date on the page, read 2026-10-26.
- Advance replacement wants the failed part back within ten calendar days of receiving the new one:
  Cisco, "Cisco RMA Policy for Warranty and Hardware Support Contract Returns" (EDCS-23258637), updated
  21 June 2023, read 2026-10-26.
- Optics are hot-removable and hot-insertable: Juniper Networks, "Maintain Transceivers", EX4400
  hardware guide, read 2026-10-26 (ADR-0073's source).
