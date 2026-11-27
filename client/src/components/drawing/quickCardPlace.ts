// Where the quick card hangs: the point on the thing its dotted line starts from, and the edges of the thing the
// card keeps clear of. Pure; the card is `QuickCard.tsx`.

export interface Box {
  left: number;
  right: number;
  top: number;
  width: number;
  height: number;
}

/** The row a thing is drawn in, where that is wider than the thing: a shelf for a thing on it, a device for a port
 * on it. */
export interface Row {
  left: number;
  right: number;
}

export interface Anchor {
  /** The height the dotted line runs at. */
  y: number;
  /** The edges the card keeps clear of: the thing's own, or those of the row it is drawn in. */
  left: number;
  right: number;
  /** Where the dotted line starts, when that is not the edge the card keeps clear of: a port's own edges. */
  from?: Row;
}

/** A device, shelf or rack hangs the card off its right edge (a rack at the height it was clicked, being tall); a
 * cable, which has no edge to speak of, from where it was clicked. A thing on a shelf hangs it off the end of the
 * shelf's row, as a device in a rack hangs it off the end of its unit: hung off the thing itself, the card would
 * lie on the shelf's other things. A port hangs it off the end of its device for the same reason, the ports beside
 * it being the next ones to be pressed; its line still starts at the port, which nothing else marks. */
export function cardAnchor(kind: 'device' | 'rack' | 'shelf' | 'cable' | 'port', at: { fx: number; fy: number }, box: Box, row: Row | null = null): Anchor {
  if (kind === 'cable') {
    const x = box.left + at.fx * box.width;
    return { y: box.top + at.fy * box.height, left: x, right: x };
  }
  const y = kind === 'rack' ? box.top + at.fy * box.height : box.top + box.height / 2;
  if (row != null && kind === 'device') return { y, left: row.left, right: row.right };
  if (row != null && kind === 'port') return { y, left: row.left, right: row.right, from: { left: box.left, right: box.right } };
  return { y, left: box.left, right: box.right };
}

/** Where the card and its dotted line are put, in window pixels. */
export interface Placed {
  /** The line's end on the thing, and its end on the card. */
  ax: number;
  ay: number;
  bx: number;
  /** The card's corner. */
  left: number;
  top: number;
  hidden: boolean;
}

export interface Bounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** The dotted line between the thing and the card. */
export const LEADER_PX = 28;
const EDGE = 8;

/** Right of the thing, or left of it when the canvas has no room on the right; kept inside the canvas from top to
 * bottom. Hidden while the thing is being dragged (`busy`) or while the end the line starts from is out of view.
 * That end was once always the right one, so a thing whose right end lay past the edge of the canvas had no card,
 * though its left end was in view and there was room beside it. A port whose device has room on neither side (the
 * device is wider than the canvas) keeps its card beside the port itself. */
export function placeCard(a: Anchor, card: { w: number; h: number }, canvas: Bounds, busy = false): Placed {
  const roomRight = (edge: number) => edge + LEADER_PX + card.w <= canvas.right - EDGE;
  const roomLeft = (edge: number) => edge - LEADER_PX - card.w >= canvas.left + EDGE;
  const from = a.from ?? a;
  const clear = a.from != null && !roomRight(a.right) && !roomLeft(a.left) ? a.from : a;
  const right = roomRight(clear.right);
  const left = right ? clear.right + LEADER_PX : Math.max(canvas.left + EDGE, clear.left - LEADER_PX - card.w);
  const top = Math.max(canvas.top + EDGE, Math.min(a.y - card.h / 2, canvas.bottom - card.h - EDGE));
  const ax = right ? from.right : from.left;
  const hidden = busy || a.y < canvas.top || a.y > canvas.bottom || ax < canvas.left || ax > canvas.right;
  return { ax, ay: a.y, bx: right ? left : left + card.w, left, top, hidden };
}
