// A control's hint: its name, what it does in one plain sentence, and its shortcut. A control opts in by
// spreading `hint(...)`; `Hints.tsx` is the one card that shows them. Pure, so the words and the placing are
// tested without a browser.

export interface Hint {
  name: string;
  more?: string;
  /** Key caps as one line, pressed together: "Ctrl+Z". */
  keys?: string;
}

/** Where the card goes by the control: under it (over it when there is no room), or to its left. */
export type HintSide = 'below' | 'left';

export interface HintProps {
  'data-hint': string;
  'data-hint-more'?: string;
  'data-hint-keys'?: string;
  'data-hint-side'?: 'left';
  title: string;
}

/** The attributes a control spreads to explain itself. `title` says the same in one line, for a screen reader
 * and for a page the card is not on; a `title` the control sets after the spread wins. */
export function hint(name: string, more?: string, keys?: string, side?: 'left'): HintProps {
  const said = more ?? name;
  return {
    'data-hint': name,
    'data-hint-more': more,
    'data-hint-keys': keys === '' ? undefined : keys,
    'data-hint-side': side,
    title: keys != null && keys !== '' ? `${said} (${keys})` : said,
  };
}

/** A control's hint, read off its attributes; null when it has none. */
export function readHint(attr: (name: string) => string | null): Hint | null {
  const name = attr('data-hint')?.trim() ?? '';
  if (name === '') return null;
  const more = attr('data-hint-more')?.trim() ?? '';
  const keys = attr('data-hint-keys')?.trim() ?? '';
  return { name, ...(more !== '' ? { more } : {}), ...(keys !== '' ? { keys } : {}) };
}

/** "Ctrl+Shift+Z" as its caps. A lone "+" (zoom in) is a key, not a join. */
export function keyCaps(keys: string): string[] {
  if (keys === '+') return ['+'];
  return keys
    .split('+')
    .map((k) => k.trim())
    .filter((k) => k !== '');
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Room kept between the card and its control, and between the card and the window's edge. */
export const HINT_GAP = 8;
export const HINT_EDGE = 8;

export interface HintPlace {
  left: number;
  top: number;
  /** Which way the card arrives from: it drops in under a control, and rises in over one. */
  from: 'above' | 'below' | 'right';
}

/** Where the card sits: centred under the control; over it when there is no room under; beside it, to the
 * left, for a control on the window's right edge. Always inside the window. */
export function placeHint(target: Box, card: { width: number; height: number }, win: { width: number; height: number }, side: HintSide = 'below'): HintPlace {
  const clampX = (x: number) => Math.max(HINT_EDGE, Math.min(x, win.width - card.width - HINT_EDGE));
  const clampY = (y: number) => Math.max(HINT_EDGE, Math.min(y, win.height - card.height - HINT_EDGE));
  if (side === 'left' && target.left - HINT_GAP - card.width >= HINT_EDGE) {
    return { left: target.left - HINT_GAP - card.width, top: clampY(target.top + target.height / 2 - card.height / 2), from: 'right' };
  }
  const left = clampX(target.left + target.width / 2 - card.width / 2);
  const under = target.top + target.height + HINT_GAP;
  if (under + card.height <= win.height - HINT_EDGE) return { left, top: under, from: 'above' };
  return { left, top: clampY(target.top - HINT_GAP - card.height), from: 'below' };
}

/** How long the pointer rests on a control before its hint shows. */
export const HINT_DELAY_MS = 450;
/** Moving on to the next control while a hint is up (or just was): the next one comes at once. */
export const HINT_WARM_DELAY_MS = 60;
/** How long after a hint goes the next still counts as "moving along". */
export const HINT_WARM_FOR_MS = 400;
/** A tab to a control is deliberate, so its hint comes sooner. */
export const HINT_FOCUS_DELAY_MS = 150;
/** Off a control, its card waits this long for the pointer to reach the next one, so it can glide there. */
export const HINT_LINGER_MS = 120;

/** How far the pointer travels from where a press, a key or the wheel put the hints away before one may show. */
export const HINT_STIR_PX = 4;

/** Whether the pointer is still where the hints were put away. A control that slides under a pointer at rest
 * (Back leaving the tool row, a menu closing) was not pointed at, so it does not explain itself. */
export function pointerAtRest(rest: { x: number; y: number } | null, x: number, y: number): boolean {
  return rest != null && Math.hypot(x - rest.x, y - rest.y) < HINT_STIR_PX;
}

/** The wait before a hint shows: short while one was up a moment ago, so a row of tools reads in one sweep. */
export function hintDelay(now: number, lastShownUntil: number | null, focus: boolean): number {
  if (focus) return HINT_FOCUS_DELAY_MS;
  return lastShownUntil != null && now - lastShownUntil <= HINT_WARM_FOR_MS ? HINT_WARM_DELAY_MS : HINT_DELAY_MS;
}
