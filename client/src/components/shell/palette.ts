// The command palette's pure side: which actions match the words typed, and how arrow keys move over
// rows that may be unavailable. The sheet itself is `CommandPalette.tsx`.

import type { SearchHit } from './search';

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
  /** Where the palette lists it: "do" (an action, the default) or "go" (a place or saved view to go to). */
  group?: 'do' | 'go';
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
    const plain = typed.every((w) => all.includes(w));
    // Letters in order ("tr1" for "Trace a path from switch-1") find it last.
    if (!plain && !(query.trim().length >= 2 && matchRanges(action.label, query) !== null)) return;
    const score = !plain ? 3 : label.startsWith(typed[0]!) ? 0 : label.includes(typed[0]!) ? 1 : 2;
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

/** Which letters of `text` the typed `query` picks out, as indexes, or null if it does not match.
 * The whole query as one run wins; otherwise its letters in order (spaces ignored), so "sw1" picks
 * the s, w and 1 of "switch-1". */
export function matchRanges(text: string, query: string): number[] | null {
  const letters = query.toLowerCase().replace(/\s+/g, '');
  if (letters === '') return null;
  const lower = text.toLowerCase();
  const run = lower.indexOf(query.trim().toLowerCase());
  if (run >= 0 && query.trim() !== '') return Array.from({ length: query.trim().length }, (_, i) => run + i);
  const found: number[] = [];
  let from = 0;
  for (const ch of letters) {
    const at = lower.indexOf(ch, from);
    if (at < 0) return null;
    found.push(at);
    from = at + 1;
  }
  return found;
}

/** `text` cut into runs, each marked as typed-for or not, for underlining the letters that matched. */
export function highlightParts(text: string, query: string): Array<{ text: string; hit: boolean }> {
  const at = matchRanges(text, query);
  if (at === null) return [{ text, hit: false }];
  const hits = new Set(at);
  const parts: Array<{ text: string; hit: boolean }> = [];
  for (let i = 0; i < text.length; i += 1) {
    const hit = hits.has(i);
    const last = parts[parts.length - 1];
    if (last !== undefined && last.hit === hit) last.text += text[i];
    else parts.push({ text: text[i]!, hit });
  }
  return parts;
}

/** The group a row sits under, or the next one along when Tab narrows the list: `step` 1 or -1 over
 * `groups`, with "all" (null) between the last and the first. */
export function cycleGroup(groups: readonly string[], current: string | null, step: 1 | -1): string | null {
  if (groups.length === 0) return null;
  const at = current === null ? -1 : groups.indexOf(current);
  const from = current !== null && at < 0 ? -1 : at; // a group that has gone counts as "all"
  const next = from + step;
  if (current === null && step === -1) return groups[groups.length - 1]!;
  if (next < 0 || next >= groups.length) return null;
  return groups[next]!;
}

/** The muted words after a found thing's name: where it is, plus a tag it was found by. */
export function noteOf(hit: SearchHit): string {
  if (hit.where === undefined) return hit.why;
  return hit.why.startsWith('tag:') ? `${hit.where} · ${hit.why}` : hit.where;
}
