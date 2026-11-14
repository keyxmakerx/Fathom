// Where the opening fit stops on an empty design (r115 thread 4, finished for alpha): the stand-in rack is fitted
// into the room above the "An empty design" note, so the note never sits on the rack's lower units.

/** Space kept between the bottom of the rack and the top of the note, in screen pixels. */
export const NOTE_GAP_PX = 16;

/** The fit's own padding on every other side, as React Flow reads it (a share of the pane). */
const SIDE_PADDING = 0.1;

type Box = { top: number; bottom: number; height: number };
type Side = `${number}%` | `${number}px`;

/** The fit's padding with the note's room taken off the bottom: `0.1` as before when there is no note, or the
 * note does not reach into the pane. The bottom is in pixels, the rest stays a share of the pane. */
export function paddingClearOf(pane: Box | null, note: Box | null): number | { top: Side; right: Side; left: Side; bottom: Side } {
  if (pane == null || note == null || pane.height <= 0) return SIDE_PADDING;
  const covered = pane.bottom - note.top;
  if (covered <= 0 || note.top < pane.top) return SIDE_PADDING;
  const side: Side = `${SIDE_PADDING * 100}%`;
  return { top: side, right: side, left: side, bottom: `${Math.round(covered + NOTE_GAP_PX)}px` };
}
