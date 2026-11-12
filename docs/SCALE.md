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
(`designs::MAX_PAYLOAD_BYTES`). Find searches the open design. Since ADR-0079, Ctrl+K and
Inventory › Every site also search every other design a person can read, through the server's
estate index, and a cable can link to a port in another design.

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

Three pieces of work, cheapest first. The owner chose 1 and 2 (sign-off r51, option A; ADR-0079).
Both are built; for 1 the owner picked keeping the newest 500 changes in each save (r53, option A).

1. **Stop carrying the whole history in every save.** Built (ADR-0079 decision 6): each checkpoint
   keeps the newest 500 changes and the provenance still in use; every change stays on the chain,
   and History pages through it from the server. Undo reaches the newest 500. Measured on the
   benchmark's document, 2026-10-28, with the same rule:

   | Devices | Changes in the design | Document | Kept to 500 changes | Without history |
   |---|---|---|---|---|
   | 200 | 700 | 4.8 MB | 4.2 MB | 1.3 MB |
   | 1,000 | 3,500 | 24.2 MB | 16.6 MB | 6.5 MB |

   So about a third smaller at 1,000 devices, not the fourfold cut "without history" suggested:
   500 kept changes keep their provenance, and provenance (one record a field) is most of what
   remains. What it changes is growth: a save no longer gets bigger with every edit, so a design
   edited millions of times stays the present plus 500 changes. The 64 MiB cap now stops the
   benchmark's design at about 4,000 devices instead of 2,700.
2. **An estate index across designs.** The server already reads every design back (ADR-0049); it
   can keep a searchable index of devices, ports, addresses and serials per organisation, so
   Inventory and search answer across every design a person can read. This is what makes "one
   design per site or building" workable at 900,000.
3. **Designs held as rows, loaded by what is on screen.** The canvas asks for what is in view and
   the next zoom level out; Inventory pages through the server. This is the only route to a single
   design of tens of thousands of devices, and it reopens ADR-0049 and ADR-0063's whole-document
   head.

## The estate index at a million devices

**Measured 2026-11-02** with `scripts/bench-estate-index.sh` on PostgreSQL 16.15, 4 cores, 1,000
designs of 1,000 devices and 20 search terms each (20,000,000 terms; 6.8 GB with indexes, 241 MB
more for 0068's), second run of each query. The terms are synthetic and real rows carry more
(every prefix of name, model and serial, and one per port), so the sizes are a floor: about 100
terms a device would be roughly 35 GB at a million devices, an estimate.

| What a person does | Before migration 0068 and the rewritten search | After |
|---|---|---|
| A save of a 1,000-device design rebuilds its rows | 3.1 s per row deleted (17.9 s for 10): about 30 to 50 minutes for the design | 20 ms for all 1,000 |
| One common word (62,000 matches) | 350 to 560 ms | 0.13 to 0.4 ms |
| A serial number with the device filter | 15.1 to 15.3 s | 0.1 to 1.2 ms |
| Two common words | 130 to 320 ms | 17 ms |

Why: the rows' foreign key cascades to `estate_terms`, and no index on it led with the element, so
each deleted row read the organisation's whole term list; and search grouped every entry of every
word, including `kind:device`, which every device carries. ADR-0089 §8.4 has the detail. A rebuild
of a 1,000-device design also wrote 57 MB of WAL, all of which a synchronous standby receives
(ADR-0090); rebuilding only the elements that changed is the next step.

## What was not measured

The time to open a design after slimming (it follows the document's size, so expect it to fall
about as much), and History's page time on a chain of millions (each page is a range read off the
chain's primary key, and verify still walks the whole chain). Live co-editing under load (many people on one design), the Work tab, Search and Everywhere at
thousands of designs (their shared permission check was batched in PR #294 and timed only at 40 and
200 designs; ADR-0089 §6 item 5 plans the run, and §7 step 4 replaces the Work tab's five-second
polling with a push), import of a large file, the canvas's
own drawing time in a browser, and the estate index under real rows rather than the synthetic ones above (its rebuild
runs after the save, never in front of it, and search says how many designs are still catching up). The server's live path applies each change to its cached head, so
its cost follows the head's size above.
