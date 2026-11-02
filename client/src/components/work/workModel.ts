// The Work tab's sorting and words (sign-off r74), pure so they can be tested without a browser.

import type { Present, WorkAnswer, WorkRow, WorkRowKind } from '../../api/work';
import { numberWord } from '../../document/work';

export type KindFilter = 'all' | WorkRowKind;

export const KIND_FILTERS: ReadonlyArray<[KindFilter, string]> = [
  ['all', 'All'],
  ['plan', 'Maintenance'],
  ['issue', 'Troubleshooting'],
  ['spare', 'Orders'],
];

export const KIND_WORD: Record<WorkRowKind, string> = { plan: 'Maintenance', issue: 'Troubleshooting', spare: 'Order' };

export interface Filters {
  kind: KindFilter;
  mine: boolean;
  /** A design id, or '' for every site. */
  design: string;
}

export interface Sections {
  /** Doing now: a plan under way, an open issue. */
  now: WorkRow[];
  /** Planned plans and spares on order, away or lent. */
  coming: WorkRow[];
  /** How many rows each kind filter would show, with Mine and the site applied. */
  counts: Record<KindFilter, number>;
}

function isNow(r: WorkRow): boolean {
  return (r.kind === 'plan' && r.state === 'doing') || (r.kind === 'issue' && r.isOpen);
}

/** Soonest first; nothing given goes last; then the newest number. */
function byWhen(a: WorkRow, b: WorkRow): number {
  if (a.when !== b.when) {
    if (a.when === '') return 1;
    if (b.when === '') return -1;
    return a.when < b.when ? -1 : 1;
  }
  return (b.number ?? 0) - (a.number ?? 0);
}

export function sections(rows: readonly WorkRow[], filters: Filters, you: string): Sections {
  const scoped = rows.filter((r) => (!filters.mine || (you !== '' && r.assigned === you)) && (filters.design === '' || r.design === filters.design));
  const counts: Record<KindFilter, number> = { all: scoped.length, plan: 0, issue: 0, spare: 0 };
  for (const r of scoped) counts[r.kind] += 1;
  const shown = scoped.filter((r) => filters.kind === 'all' || r.kind === filters.kind);
  return { now: shown.filter(isNow).sort(byWhen), coming: shown.filter((r) => !isNow(r)).sort(byWhen), counts };
}

/** The designs the rows come from, by name, for the site menu. */
export function sitesOf(rows: readonly WorkRow[]): Array<{ id: string; name: string }> {
  const seen = new Map<string, string>();
  for (const r of rows) if (!seen.has(r.design)) seen.set(r.design, r.designName ?? 'Unnamed design');
  return [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

const STATE_WORD: Record<string, string> = {
  planned: 'Planned',
  doing: 'Doing',
  recorded: 'Recorded',
  open: 'Open',
  closed: 'Closed',
  on_order: 'On order',
  in_repair: 'Away for repair',
  lent: 'Lent',
};

/** "Tue 11 Nov 22:00" for a date and time, "Fri 7 Nov" for a date; as typed when it is neither. */
export function whenWord(when: string): string {
  const t = when.trim();
  if (t === '') return '';
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(t);
  const d = new Date(dateOnly ? `${t}T00:00:00` : t);
  if (Number.isNaN(d.getTime())) return t;
  const day = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
  if (dateOnly) return day;
  const time = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  return `${day} ${time}`;
}

/** The row's status in the kind's own words: "Doing · step 4 of 6", "On order · due Fri 7 Nov". */
export function stateLine(r: WorkRow): string {
  const word = STATE_WORD[r.state] ?? r.state;
  const when = whenWord(r.when);
  if (r.kind === 'plan') {
    if (r.state === 'doing' && r.steps > 0) {
      const at = Math.min(r.stepsDone + 1, r.steps);
      const off = r.stepsDifferently > 0 ? ` · ${r.stepsDifferently} went differently` : '';
      return `${word} · step ${at} of ${r.steps}${off}`;
    }
    return when && r.state === 'planned' ? `${word} · ${when}` : word;
  }
  return when && r.isOpen ? `${word} · due ${when}` : word;
}

/** Past its date and still open. A plan's window is "late" only once it is past and not begun. */
export function isLate(r: WorkRow, today: string): boolean {
  if (!r.isOpen || r.when === '') return false;
  const day = r.when.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  if (r.kind === 'plan' && r.state !== 'planned') return false;
  return day < today;
}

/** "Key Maker" is KM, "jd" is JD: the server's own rule (`live::initials_of`). */
export function initialsOfName(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words.length === 0) return '-';
  const letters = words.length === 1 ? [...words[0]].slice(0, 2).join('') : [...words[0]][0] + [...words[1]][0];
  return letters.toUpperCase();
}

export interface Who {
  /** The person it is assigned to, or null. */
  assigned: { name: string; initials: string } | null;
  /** Assigned to someone who is no longer in the organisation. */
  gone: boolean;
  /** People in the design right now, the assignee first. */
  inIt: Present[];
}

export function whoOf(r: WorkRow, answer: Pick<WorkAnswer, 'people' | 'here'>): Who {
  const name = r.assigned ? answer.people[r.assigned] : undefined;
  const inIt = [...(answer.here[r.design] ?? [])].sort((a, b) => (a.account === r.assigned ? -1 : b.account === r.assigned ? 1 : 0));
  return {
    assigned: name != null ? { name, initials: initialsOfName(name) } : null,
    gone: r.assigned !== '' && name == null,
    inIt,
  };
}

export function numberOf(r: WorkRow): string {
  return r.number != null ? numberWord(r.number) : '…';
}

/** Where it is: the design, then the device's rack or the spare's store. */
export function whereOf(r: WorkRow, currentDesign: string | null = null): string {
  const design = r.design === currentDesign ? 'This design' : (r.designName ?? 'Unnamed design');
  const more = [r.device, r.place].filter(Boolean).join(' · ');
  return more ? `${design} › ${more}` : design;
}

/** Today as an ISO date in this browser's own time. */
export function todayIso(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}
