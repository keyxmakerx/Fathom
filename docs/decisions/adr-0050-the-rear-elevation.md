# ADR-0050 — The rear elevation

**Status:** accepted 2026-09-16, by the owner in session.
**Amends:** `docs/UI-SPEC.md` "Power" (the one-sentence rear view) and ADR-0046's drawing.

## Context

The interface page gave the rear of a rack one sentence: *stacked under the front when zoomed, a
flip at rack scale.* Session 5 built that sentence literally: a chassis mounted on the rear rails
drew stacked beneath its front neighbour. That is not a rear view; it is the front view with the
rear-mounted devices shown.

The owner's requirement, stated on 2026-09-16: a rack must have a rear view, one rack alone and a
whole row of racks together, because the things an engineer needs to find from behind are on the
back — PSU inlets, and on many devices the management and console ports — and the record must say
which PSU is plugged in where, especially on devices with two supplies, and on devices whose supply
is not swappable.

## Decision

1. **Two elevations of every rack, front and rear.** The rear elevation draws, unit by unit, the
   face that faces the back: the rear faceplate of a front-mounted chassis, the front faceplate of
   a rear-mounted one. A device whose catalogue entry has no rear faceplate draws as a plain plate
   carrying its name, never as nothing. The rack frame mirrors — the rail that is on the left from
   the front is on the right from behind, unit numbers with it. A rear faceplate's own layout does
   **not** mirror: vendors draw rear panels as seen from behind, and the catalogue records them as
   the vendor draws them.
2. **A row.** A rack belongs to a row and a bay within it, recorded on the rack. The closet stop
   arranges racks by row, bays left to right as seen from the front. The row's rear elevation
   reverses the bay order, because you have walked round. The flip is one camera, never a page
   change: per row at the closet stop, per rack at the rack stop. A rack with no row is its own row.
3. **Inlets are ports on the rear face, at their positions.** The catalogue stops recording an
   inlet as a count. Each inlet is an entry on the rear faceplate like any port: its slot name in
   the vendor's own words (PSU 0, PSU 1, PEM A), its position, whether the slot is hot-swappable,
   all cited with a date under CLAUDE.md rule 1. The rail hexagons stay as the rack stop's summary
   and light the inlet they stand for.
4. **A power supply is a part.** A node that occupies a slot, populated or empty, with its own
   serial, because supplies are field-replaceable units with serials of their own. Two distinct
   marks follow: **single-fed** (two supplies fitted, one cabled) and **one fitted** (a slot
   empty). A device whose supply is not swappable has an inlet and no slot: no part, nothing to
   fit or remove.
5. **Management and console ports go into the catalogue** on whichever face carries them. The
   EX4300 entry left them out on purpose while the front was the only view; that reason is gone,
   they are the reason the rear view exists.

## Consequences

- Schema: a minor bump. `Rack` gains row and bay; a `Psu` kind with its slot and the edge that
  seats it in a chassis; a port's slot name where the catalogue gives one. Nothing removed.
- Catalogue format (ADR-0044): inlets move from a count to positioned rear-face entries with a
  slot name and a hot-swap flag; port groups gain management and console roles. Every existing
  entry is re-read against its source and the date updated.
- Drawing: a rear elevation of one rack and of a row, mirrored as above, with the front | rear
  flip already built driving it; power leads end on the inlet, on the face, not on the rail.
- Session 6 starts with this, ahead of the config surface, because the rear view exists now and
  this is what it is for.
