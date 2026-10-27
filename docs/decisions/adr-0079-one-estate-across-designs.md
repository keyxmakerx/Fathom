# ADR-0079: One estate across designs — the estate index, links between sites, and slimmer saves

**Status:** accepted 2026-10-27. The owner approved sign-off card r51-scale with option A ("index
and slim saves"), with a note: "A is fine, but keep in mind we need to be able to search and pull
up all the inventory. I'm not saying we need 900k on the canvas, there shouldn't be more than a
single datacenter for that." Then, in the thread: "the goal is for everything to be connected, but
you don't have to render it all at once."

**Builds on:** ADR-0049 (the server reads every design back), ADR-0063 (live changes, the
`design_change` table and checkpoints), ADR-0074 (sites, buildings and closets are the folders).
**Keeps:** the per-design keys of `PHASE-2-STORAGE-DESIGN.md` §3, and folder permissions as the
only answer to "who may see this".

## Context

`docs/SCALE.md` has the numbers. The estate is about 900,000 devices of 187 kinds. A design is one
encrypted document, loaded whole into the browser, and capped at 64 MiB: about 2,700 devices at the
benchmark's six ports a device, and a few hundred devices of real gear. Search, Find and Inventory
work only inside the open design.

So the estate has to be many designs, one per site, building or datacenter. Without more work that
is thousands of islands: nothing finds a serial number across them, and a cable from one site to
another ends in a label someone typed.

## Decided

1. **One design per site, building or datacenter, drawn one at a time.** A design sits in a closet,
   building or site folder (ADR-0074). The canvas draws the open design only. The building, site and
   estate stops draw the folders above it, as ADR-0074 already says.

2. **An estate index on the server, per organisation.** After every accepted whole save and every
   accepted live change, the server rebuilds that design's index rows from the head it already
   holds (ADR-0049, ADR-0063). The rebuild runs after the commit, on the head's own worker, and
   never delays the save. At startup, any design whose index is behind its version is queued.
   - **What is indexed:** devices, chassis, cards, optics, power supplies and spares. For each one:
     its kind, name, model and vendor, the design and folder it is in, its rack and U, its
     management address, the addresses on its interfaces, and its serial number. Ports are not rows
     of their own. A device's row carries its ports (id, name, and where the port's link to
     another site lands), sealed with the rest, so a link can pick one. Port names are not search
     terms: they repeat on every device and would crowd out the words that find one.
   - **What it answers:** search across every design a person may read (Ctrl+K's "Other sites"
     group), and Inventory › Every site: one table across the estate, paged by the server 100
     rows at a time, filtered by kind, and grouped by design. It is not sorted by name across the
     estate, because the database holds no names to sort by (decision 3). A row opens its design
     at that thing, the way a scanned label does (ADR-0075).
   - **Catching up.** A design changed some other way, or saved before the index existed, is
     rebuilt when a search finds its rows older than the design, a few designs per search, and
     the page says how many are still catching up.

3. **The index is sealed like everything else.** A row's contents are encrypted under a key
   derived from the master key for that organisation and the index (HKDF, its own label). The
   database never holds a device name, address or serial number in the clear. Search goes through
   keyed hashes of normalised terms: whole words, and every prefix of three characters or more, so
   typing "core-sw" finds "core-sw-01". What the database can learn is which rows share a term, and
   how often a term occurs. That is recorded here as the cost of searching without decrypting
   900,000 rows per keystroke. A search for part of a word from the middle, such as "sw-01" inside
   "core-sw-01", is not offered.

4. **Who sees what: the folder, checked at the time of the question.** The server filters results
   by the person's Read on each design's folder when they search, never when the row was written.
   A person with Read on one site finds only that site's things, and the index is never a way
   round a folder. In this first cut AI connections do not get estate search. Their `list_designs`
   and `read_design` are unchanged.

5. **Links between sites: a cable can end on a thing in another design.** The schema's
   `ExternalPeer`, "the far end you do not model", gains two optional fields: the far design's id
   and the far element's id. A cable from a port to such a peer is a link to another site.
   - It is made by picking the far port from estate search, the same Everywhere search as point 2.
     The near design stores only ids and the label the person sees. It never copies anything else
     out of the far design.
   - On the canvas, the far end is drawn as the portal tray already drawn for a cable leaving the
     closet, named for the far site and device. A click opens the far design at that port, if the
     person may read it. If not, the tray says the far end is in a site they can't open.
   - Trace stops at the tray and offers "Continue in <site>". A Check reports a link whose far end
     doesn't point back (an idea), or whose far element has gone (a warning), from the index: the
     server answers, for each far end, whether the caller may open that design, whether the port
     is there, and where that port's own link points. A far end in a design the person can't open,
     or one still being indexed, gives no finding, because Fathom cannot see it.
   - Carrier names and circuit IDs on such a link come with Circuits (ADR-0068 point 7). A circuit
     then holds these links, and doesn't replace them.

6. **Slimmer saves: the head carries the present and the change table carries the past.** Whole
   saves, the server's head and checkpoints carry the current graph with the provenance it still
   uses. The batch log and field history live in the `design_change` rows, where ADR-0063 already
   writes every change, and History pages them from the server. It is built last of the three,
   measured before and after on the benchmark. If it would change what History or Undo can do, it
   comes back to the sign-offs page first. It does: today Undo can step back through every change
   ever saved, because every save carries them. So it is on the sign-offs page as card r53-slim-saves
   (2026-10-27), with keeping the newest 500 changes in the save as the recommended pick.

7. **The limit, said plainly.** A design still loads whole. A single datacenter of real gear larger
   than what point 6 brings in reach needs the canvas to load by view (r51 option B). That is after
   Alpha. `docs/SCALE.md` keeps the measured numbers.

## Order

The admin logging work from card r52 goes first, in its own pull request. Then this record, in one
pull request, in the order 2–4, then 5, then 6, each with its measurements in `docs/SCALE.md` and
its docs in STATE.md, UI-SPEC and EXAMPLES.

## Consequences

- One new table pair (index rows and terms), one key label, and two `ExternalPeer` fields in
  `schema/`. No change to how a design is encrypted.
- A design moved to another folder (ADR-0074) moves in the index on its next rebuild. Deleting a
  design deletes its rows.
- Key rotation re-encrypts the index the way it re-encrypts changes: in bounded batches, or simply
  rebuilds it from the designs.
