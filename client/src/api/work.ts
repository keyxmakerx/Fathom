// The Work tab (sign-off r74): every plan, "It's down" issue and spare that is out, across every
// design this person may read, from the server's estate index
// (`crates/fathom-server/src/design_api/estate_routes.rs`). Each piece of work has a Fathom number
// the server gave it. A design's own route names its numbers and who may be assigned work there.

import { body } from './fieldDefinitions';
import { parseEstate, type EstateHit } from './estate';
import { signedFetch } from './signedFetch';

export type WorkRowKind = 'plan' | 'issue' | 'spare';

export interface WorkRow {
  design: string;
  designName: string | null;
  element: string;
  /** What opening it shows: the plan, the issue, or a spare's store. */
  open: string;
  kind: WorkRowKind;
  number: number | null;
  title: string;
  /** An issue's device, by name. */
  device: string;
  /** An issue's device's rack, or a spare's store and bin. */
  place: string;
  isOpen: boolean;
  /** The kind's own status: planned, doing, recorded; open, closed; on_order, in_repair, lent. */
  state: string;
  /** A plan's window start, an issue's or a spare's due date, as typed. */
  when: string;
  assigned: string;
  ticket: string;
  steps: number;
  stepsDone: number;
  stepsDifferently: number;
  comments: number;
}

export interface Present {
  account: string;
  name: string;
  initials: string;
}

export interface WorkAnswer {
  rows: WorkRow[];
  designs: number;
  behind: number;
  /** Names of the accounts work is assigned to, by id. */
  people: Record<string, string>;
  /** Who is in each design now, by design id. */
  here: Record<string, Present[]>;
  /** This person's account, for Mine. */
  you: string;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function rowOf(hit: EstateHit, raw: Record<string, unknown>): WorkRow | null {
  const w = (raw.work ?? null) as Record<string, unknown> | null;
  if (w == null) return null;
  const kind = hit.kind === 'plan' || hit.kind === 'issue' || hit.kind === 'spare' ? hit.kind : null;
  if (kind == null) return null;
  return {
    design: hit.design,
    designName: hit.designName,
    element: hit.element,
    open: hit.open,
    kind,
    number: typeof raw.number === 'number' ? raw.number : null,
    title: hit.name || hit.model || '(untitled)',
    device: hit.device,
    place: hit.place,
    isOpen: w.open === true,
    state: str(w.state),
    when: str(w.when),
    assigned: str(w.assigned),
    ticket: str(w.ticket),
    steps: num(w.steps),
    stepsDone: num(w.stepsDone),
    stepsDifferently: num(w.stepsDifferently),
    comments: num(w.comments),
  };
}

export function parseWork(bytes: Uint8Array): WorkAnswer {
  const estate = parseEstate(bytes);
  const raw = JSON.parse(new TextDecoder().decode(bytes)) as {
    hits?: unknown[];
    people?: Record<string, unknown>;
    here?: Record<string, unknown>;
    you?: unknown;
  };
  const rawHits = (raw.hits ?? []) as Record<string, unknown>[];
  const rows: WorkRow[] = [];
  estate.hits.forEach((hit, i) => {
    const row = rowOf(hit, rawHits[i] ?? {});
    if (row) rows.push(row);
  });
  const people: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw.people ?? {})) if (typeof v === 'string') people[k] = v;
  const here: Record<string, Present[]> = {};
  for (const [design, list] of Object.entries(raw.here ?? {})) {
    if (!Array.isArray(list)) continue;
    here[design] = list.map((p) => {
      const o = (p ?? {}) as Record<string, unknown>;
      return { account: str(o.account), name: str(o.name), initials: str(o.initials) };
    });
  }
  return { rows, designs: estate.designs, behind: estate.behind, people, here, you: str(raw.you) };
}

export async function fetchWork(organisationId: string, done = false): Promise<WorkAnswer> {
  const path = `/organisations/${encodeURIComponent(organisationId)}/work/page`;
  return parseWork(await signedFetch('POST', path, body(done ? { done: true } : {})));
}

export interface DesignWork {
  /** Fathom numbers by element id; a piece of work saved in the last few seconds has none yet. */
  numbers: Record<string, number>;
  /** Who may be assigned work in this design (Draw on its folder): account id to name. */
  people: Record<string, string>;
}

export function parseDesignWork(bytes: Uint8Array): DesignWork {
  const raw = JSON.parse(new TextDecoder().decode(bytes)) as { numbers?: Record<string, unknown>; people?: Record<string, unknown> };
  const numbers: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw.numbers ?? {})) if (typeof v === 'number') numbers[k] = v;
  const people: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw.people ?? {})) if (typeof v === 'string') people[k] = v;
  return { numbers, people };
}

export async function fetchDesignWork(organisationId: string, designId: string): Promise<DesignWork> {
  const path = `/organisations/${encodeURIComponent(organisationId)}/designs/${encodeURIComponent(designId)}/work`;
  return parseDesignWork(await signedFetch('POST', path, body({})));
}
