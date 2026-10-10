// The small line under a pinned note: who added it and when, "KM · 9 OCT". The initials come from
// the people this client knows (you, and whoever is in the design live); an author it cannot name
// shows the date alone, never invented letters.
import { createContext } from 'react';

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** Account id to initials, for every person this client can name. */
export const NoteAuthorsContext = createContext<ReadonlyMap<string, string>>(new Map());

/** "KM · 9 OCT"; the year too when it is not this year. `null` when there is nothing on record. */
export function noteByline(author: { actor: string; at: number } | undefined, initialsOf: ReadonlyMap<string, string>, now: number = Date.now()): string | null {
  if (!author) return null;
  const d = new Date(author.at);
  if (Number.isNaN(d.getTime())) return null;
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  const date = `${d.getDate()} ${MONTHS[d.getMonth()]}${sameYear ? '' : ` ${d.getFullYear()}`}`;
  const who = initialsOf.get(author.actor);
  return who ? `${who} · ${date}` : date;
}
