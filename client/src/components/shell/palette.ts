// The command palette's pure side: which actions match the words typed, and how arrow keys move over
// rows that may be unavailable. The sheet itself is `CommandPalette.tsx`.

/** Something the palette can do. `disabled` is the reason it cannot be done right now; an action that
 * does not apply at all (a reader asked to edit) is simply left out by whoever builds the list. */
export interface PaletteAction {
  id: string;
  label: string;
  /** The shortcut, as written ("Ctrl+Z"). */
  hint?: string;
  /** Other words that find it ("remove" for Delete). */
  keywords?: readonly string[];
  disabled?: string;
  run: () => void;
}

const words = (text: string): string[] => text.toLowerCase().split(/\s+/).filter((w) => w !== '');

/** The actions every typed word appears in (label or keywords), best first: label starts with the
 * first word, then label contains it, then only a keyword does. No words lists them all as given. */
export function matchActions(actions: readonly PaletteAction[], query: string): PaletteAction[] {
  const typed = words(query);
  if (typed.length === 0) return [...actions];
  const scored: Array<{ action: PaletteAction; score: number; order: number }> = [];
  actions.forEach((action, order) => {
    const label = action.label.toLowerCase();
    const extra = (action.keywords ?? []).join(' ').toLowerCase();
    const all = `${label} ${extra}`;
    if (!typed.every((w) => all.includes(w))) return;
    const score = label.startsWith(typed[0]!) ? 0 : label.includes(typed[0]!) ? 1 : 2;
    scored.push({ action, score, order });
  });
  scored.sort((a, b) => a.score - b.score || a.order - b.order);
  return scored.map((s) => s.action);
}

/** One row in the palette's single list: an action, or a thing found in the design. */
export type Row<T> = { kind: 'action'; action: PaletteAction } | { kind: 'thing'; thing: T };

/** The next row to land on moving `step` (1 or -1) from `from`, skipping rows that cannot be chosen.
 * Stays put when there is none. */
export function moveActive(enabled: readonly boolean[], from: number, step: 1 | -1): number {
  for (let i = from + step; i >= 0 && i < enabled.length; i += step) {
    if (enabled[i]) return i;
  }
  return from;
}

/** The first row that can be chosen, or -1. */
export function firstEnabled(enabled: readonly boolean[]): number {
  return enabled.findIndex((e) => e);
}
