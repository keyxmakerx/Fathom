# How big Fathom goes

**Measured 2026-10-27** on main at 99aebc3, by `scripts/bench-checks-sync.mjs` (the engine and the
client's own document code in Node, no CPU throttle). Re-measure before quoting; read numbers off a
run, not off this page.

## What was asked

An estate of about 900,000 devices across 187 kinds of equipment (routers, switches, cards, SFPs and
so on). The number of kinds is not the problem: a kind is a schema type or a catalogue entry. The
number of devices is.

## How a design is held today

A design is one document. The server stores it whole, encrypted (ADR-0049), and the browser loads it
whole into the engine. Live changes are small (ADR-0063), but opening a design, a full reload and
the server's own copy of the head all hold the entire document. One design is capped at 64 MiB
(`designs::MAX_PAYLOAD_BYTES`). Inventory, Find and Ctrl+K search the open design only; nothing
searches across designs.

## Numbers

The benchmark's design is deliberately small per device: a box with six ports, a cable to its
neighbour, a VLAN on every fourth and a subnet on every fourth.

| Devices | Nodes | Edges | Document | Without history | First open | Full reload after an edit |
|---|---|---|---|---|---|---|
| 200 | 2,300 | 2,450 | 4.8 MB | 1.3 MB | | |
| 1,000 | 11,500 | 12,250 | 24.2 MB | 6.5 MB | 17.9 s | 12.7 s |

"Without history" is the same document with its batches and provenance taken out: about three
quarters of the bytes are the record of how it was built, carried in every save.

So, at the benchmark's six ports a device:

- **The 64 MiB cap stops a design at about 2,700 devices.**
- **A design of 1,000 devices already takes 18 s to open** on a fast machine; a laptop is slower.
- A real switch with 48 ports, two cards and four optics is roughly eight times the nodes, so a
  design of real gear reaches those limits at a few hundred devices.

**900,000 devices is not reachable in one design, or by splitting into designs without more
work**: even at a few hundred devices a design, that is thousands of designs with no inventory or
search across them.

## What it would take

Three pieces of work, cheapest first. The choice of how far to go is on the Sign-offs page.

1. **Stop carrying the whole history in every save.** Keep history in the chain and the change
   table, and save the current state plus a checkpoint. About a fourfold cut in document size,
   no change to how anything looks.
2. **An estate index across designs.** The server already reads every design back (ADR-0049); it
   can keep a searchable index of devices, ports, addresses and serials per organisation, so
   Inventory and search answer across every design a person can read. This is what makes "one
   design per site or building" workable at 900,000.
3. **Designs held as rows, loaded by what is on screen.** The canvas asks for what is in view and
   the next zoom level out; Inventory pages through the server. This is the only route to a single
   design of tens of thousands of devices, and it reopens ADR-0049 and ADR-0063's whole-document
   head.

## What was not measured

Live co-editing under load (many people on one design), import of a large file, and the canvas's
own drawing time in a browser. The server's live path applies each change to its cached head, so
its cost follows the head's size above.
