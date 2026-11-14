// Orders (ADR-0084): an organisation's order types, written by a Steward as one YAML file each,
// and the orders opened from them. The server reads and checks every file and the engine decides
// every act (`crates/fathom-server/src/design_api/orders_routes.rs`); this module only carries
// the words both ways.

import { ApiRefusal } from './errors';
import { body } from './fieldDefinitions';
import { signedFetch } from './signedFetch';

const base = (organisation: string) => `/organisations/${encodeURIComponent(organisation)}`;

// ---------------------------------------------------------------------------
// The definition, as the board draws it and the order page asks it
// ---------------------------------------------------------------------------

export type FieldKind =
  | 'text'
  | 'long_text'
  | 'number'
  | 'yes_no'
  | 'date'
  | 'choice'
  | 'choices'
  | 'site'
  | 'device'
  | 'port'
  | 'team'
  | 'person'
  | 'prefix';

export type Scalar = string | number | boolean;

/** ADR-0084 decision 2: one fixed comparison on one field, or all / any of those. */
export type Condition =
  | { field: string; op: 'is' | 'is_not'; value: Scalar }
  | { field: string; op: 'in'; value: Scalar[] }
  | { field: string; op: 'at_least' | 'at_most'; value: number }
  | { field: string; op: 'set' | 'not_set'; value: null }
  | { all: Condition[] }
  | { any: Condition[] };

export interface OrderField {
  key: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  choices: string[];
  family: 'ipv4' | 'ipv6' | null;
  size: number | null;
  min: number | null;
  max: number | null;
  help: string | null;
  when: Condition | null;
  fromSet: string | null;
  line: number;
}

export interface OverdueRule {
  afterMinutes: number;
  action: 'escalate' | 'reassign' | 'move_on';
  to: string | null;
}

export interface JobDef {
  id: string;
  name: string;
  /** A slug in a file being written; a team id once installed. */
  team: string;
  steps: string[];
  asks: string[];
  when: Condition | null;
  dueMinutes: number | null;
  overdue: OverdueRule[];
  optional: boolean;
  makesPlan: boolean;
  needs: string[];
  sendBack: { to: string; label: string } | null;
  reserves: string | null;
  holds: string[];
  line: number;
}

export interface StageDef {
  id: string;
  name: string;
  approval: string | null;
  jobs: JobDef[];
  line: number;
}

export interface LaneDef {
  id: string;
  name: string;
  startsAfter: string | null;
  /** The file said `stages:` at the top: one lane with no name of its own. */
  implicit: boolean;
  stages: StageDef[];
}

export interface Definition {
  id: string;
  name: string;
  code: string | null;
  fields: OrderField[];
  lanes: LaneDef[];
}

export interface Problem {
  line: number;
  message: string;
}

/** Teams that stand now, by id. */
export type TeamNames = Record<string, { slug: string; name: string }>;

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const s = (v: unknown): string => (typeof v === 'string' ? v : '');
const os = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const on = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const strs = (v: unknown): string[] => arr(v).filter((x): x is string => typeof x === 'string');

function parseCondition(v: unknown): Condition | null {
  const r = rec(v);
  if (Array.isArray(r.all)) return { all: r.all.map(parseCondition).filter((c): c is Condition => c !== null) };
  if (Array.isArray(r.any)) return { any: r.any.map(parseCondition).filter((c): c is Condition => c !== null) };
  if (typeof r.field !== 'string' || typeof r.op !== 'string') return null;
  return { field: r.field, op: r.op, value: r.value ?? null } as Condition;
}

function parseField(v: unknown): OrderField {
  const r = rec(v);
  return {
    key: s(r.key),
    label: s(r.label),
    kind: (s(r.kind) || 'text') as FieldKind,
    required: r.required === true,
    choices: strs(r.choices),
    family: r.family === 'ipv4' || r.family === 'ipv6' ? r.family : null,
    size: on(r.size),
    min: on(r.min),
    max: on(r.max),
    help: os(r.help),
    when: r.when ? parseCondition(r.when) : null,
    fromSet: os(r.from_set),
    line: n(r.line),
  };
}

function parseJob(v: unknown): JobDef {
  const r = rec(v);
  const sb = r.send_back ? rec(r.send_back) : null;
  return {
    id: s(r.id),
    name: s(r.name),
    team: s(r.team),
    steps: strs(r.steps),
    asks: strs(r.asks),
    when: r.when ? parseCondition(r.when) : null,
    dueMinutes: on(r.due_minutes),
    overdue: arr(r.overdue).map((o) => {
      const x = rec(o);
      return { afterMinutes: n(x.after_minutes), action: s(x.action) as OverdueRule['action'], to: os(x.to) };
    }),
    optional: r.optional === true,
    makesPlan: r.makes_plan === true,
    needs: strs(r.needs),
    sendBack: sb ? { to: s(sb.to), label: s(sb.label) } : null,
    reserves: os(r.reserves),
    holds: strs(r.holds),
    line: n(r.line),
  };
}

export function parseDefinition(v: unknown): Definition {
  const r = rec(v);
  return {
    id: s(r.id),
    name: s(r.name),
    code: os(r.code),
    fields: arr(r.fields).map(parseField),
    lanes: arr(r.lanes).map((l) => {
      const x = rec(l);
      return {
        id: s(x.id),
        name: s(x.name),
        startsAfter: os(x.starts_after),
        implicit: x.implicit === true,
        stages: arr(x.stages).map((st) => {
          const y = rec(st);
          return { id: s(y.id), name: s(y.name), approval: os(y.approval), jobs: arr(y.jobs).map(parseJob), line: n(y.line) };
        }),
      };
    }),
  };
}

function parseTeams(v: unknown): TeamNames {
  const out: TeamNames = {};
  for (const [id, t] of Object.entries(rec(v))) {
    const x = rec(t);
    out[id] = { slug: s(x.slug), name: s(x.name) || s(x.slug) };
  }
  return out;
}

function json(bytes: Uint8Array): Rec {
  try {
    return rec(JSON.parse(new TextDecoder().decode(bytes)));
  } catch {
    throw new Error('malformed orders response: body is not JSON');
  }
}

// ---------------------------------------------------------------------------
// Order types
// ---------------------------------------------------------------------------

export interface OrderTypeLine {
  id: string;
  version: number;
  name: string;
  code: string | null;
  fileId: string;
  savedBy: string;
  savedAt: number;
}

export interface OrderType extends OrderTypeLine {
  source: string;
  fieldSets: string[];
  /** Slug to team id, as matched when this version was saved. */
  teams: Record<string, string>;
  definition: Definition;
  liveTeams: TeamNames;
}

function parseTypeLine(v: unknown): OrderTypeLine {
  const r = rec(v);
  return { id: s(r.id), version: n(r.version), name: s(r.name), code: os(r.code), fileId: s(r.file_id), savedBy: s(r.saved_by), savedAt: n(r.saved_at) };
}

function parseType(v: unknown): OrderType {
  const r = rec(v);
  const teams: Record<string, string> = {};
  for (const [k, t] of Object.entries(rec(r.teams))) if (typeof t === 'string') teams[k] = t;
  return {
    ...parseTypeLine(r),
    source: s(r.source),
    fieldSets: strs(r.field_sets),
    teams,
    definition: parseDefinition(r.definition),
    liveTeams: parseTeams(r.live_teams),
  };
}

export async function fetchOrderTypes(organisation: string): Promise<{ steward: boolean; types: OrderTypeLine[] }> {
  const r = json(await signedFetch('GET', `${base(organisation)}/order-types`));
  return { steward: r.steward === true, types: arr(r.types).map(parseTypeLine) };
}

export async function fetchOrderType(organisation: string, id: string): Promise<OrderType> {
  return parseType(json(await signedFetch('GET', `${base(organisation)}/order-types/${encodeURIComponent(id)}`)));
}

export interface CheckAnswer {
  problems: Problem[];
  definition: Definition | null;
  slugs: string[];
  teams: TeamNames;
}

/** Reads and checks a file without saving it. */
export async function checkOrderType(organisation: string, source: string, fieldSets: readonly string[]): Promise<CheckAnswer> {
  const r = json(await signedFetch('POST', `${base(organisation)}/order-types/check`, body({ source, field_sets: fieldSets })));
  return {
    problems: arr(r.problems).map((p) => ({ line: n(rec(p).line), message: s(rec(p).message) })),
    definition: r.definition ? parseDefinition(r.definition) : null,
    slugs: strs(r.slugs),
    teams: parseTeams(r.teams),
  };
}

/** Why a save was refused, in words a Steward can act on, when the server said. */
export type SaveRefusal = { kind: 'problems'; problems: Problem[] } | { kind: 'unmatched'; slugs: string[] } | { kind: 'secret' } | { kind: 'other'; message: string };

export function saveRefusal(e: unknown): SaveRefusal {
  if (e instanceof ApiRefusal) {
    try {
      const r = rec(JSON.parse(e.message));
      if (r.error === 'problems') return { kind: 'problems', problems: arr(r.problems).map((p) => ({ line: n(rec(p).line), message: s(rec(p).message) })) };
      if (r.error === 'unmatched_teams') return { kind: 'unmatched', slugs: strs(r.slugs) };
      if (r.error === 'looks_secret') return { kind: 'secret' };
      if (r.error === 'refused') return { kind: 'other', message: s(r.message) };
    } catch {
      /* a plain sentence */
    }
    return { kind: 'other', message: e.message };
  }
  return { kind: 'other', message: e instanceof Error ? e.message : String(e) };
}

export async function saveOrderType(
  organisation: string,
  request: { id: string | null; source: string; fieldSets: readonly string[]; teams: Record<string, string> },
): Promise<OrderType> {
  const sent: Rec = { source: request.source, field_sets: request.fieldSets, teams: request.teams };
  if (request.id) sent.id = request.id;
  return parseType(json(await signedFetch('POST', `${base(organisation)}/order-types`, body(sent))));
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

export type OrderStatus = 'open' | 'done' | 'cancelled';
export type JobStatus = 'not_started' | 'left_out' | 'waiting' | 'ready' | 'done' | 'cancelled' | 'skipped';
export type StageStatus = 'not_started' | 'running' | 'awaiting_sign_off' | 'done';

export interface OrderLine {
  id: string;
  number: number;
  type: string;
  typeVersion: number;
  openedBy: string;
  openedAt: number;
  status: OrderStatus;
  updatedAt: number;
}

export async function fetchOrders(organisation: string, finished = false): Promise<{ orders: OrderLine[]; people: Record<string, string> }> {
  const r = json(await signedFetch('GET', `${base(organisation)}/orders${finished ? '/finished' : ''}`));
  const people: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec(r.people))) if (typeof v === 'string') people[k] = v;
  return {
    people,
    orders: arr(r.orders).map((o) => {
      const x = rec(o);
      return {
        id: s(x.id),
        number: n(x.number),
        type: s(x.type),
        typeVersion: n(x.type_version),
        openedBy: s(x.opened_by),
        openedAt: n(x.opened_at),
        status: (s(x.status) || 'open') as OrderStatus,
        updatedAt: n(x.updated_at),
      };
    }),
  };
}

export type AnswerValue = string | number | boolean | string[] | { design: string; device: string; port?: string | null };

export interface JobState {
  id: string;
  name: string;
  /** The team it is with now: its own, or the one an overdue rule handed it to. */
  team: string;
  ownTeam: string;
  status: JobStatus;
  pickedBy: string | null;
  /** When its `due` passes, from the server; null when it has none or isn't ready. */
  dueAt: number | null;
  /** The overdue rules the engine has carried out, by their place in the list. */
  fired: number[];
  /** The role an `escalate` rule put it in front of. */
  escalated: string | null;
  steps: string[];
  ticks: number[];
  asks: string[];
  readyAt: number | null;
  finishedAt: number | null;
  finishedBy: string | null;
  note: string | null;
  plan: { design: string; plan: string } | null;
}

export interface StageState {
  id: string;
  name: string;
  approval: string | null;
  status: StageStatus;
  approvedBy: string | null;
  jobs: JobState[];
}

export interface LaneState {
  id: string;
  name: string;
  stages: StageState[];
}

export interface HistoryEntry {
  seq: number;
  at: number;
  by: string;
  action: string;
  detail: Rec;
}

export interface Standing {
  on: boolean;
  roles: string[];
  powers: string[];
}

export interface Order {
  id: string;
  number: number;
  type: string;
  typeVersion: number;
  name: string;
  code: string | null;
  status: OrderStatus;
  openedBy: string;
  openedAt: number;
  answers: Record<string, AnswerValue>;
  lanes: LaneState[];
  holds: { job: string; field: string; design: string; device: string; port: string | null }[];
  history: HistoryEntry[];
  definition: Definition;
  you: { account: string; steward: boolean; teams: Record<string, Standing> };
  people: Record<string, string>;
  teams: TeamNames;
}

export function parseOrder(v: unknown): Order {
  const r = rec(v);
  const you = rec(r.you);
  const standing: Record<string, Standing> = {};
  for (const [k, t] of Object.entries(rec(you.teams))) {
    const x = rec(t);
    standing[k] = { on: x.on === true, roles: strs(x.roles), powers: strs(x.powers) };
  }
  const people: Record<string, string> = {};
  for (const [k, p] of Object.entries(rec(r.people))) if (typeof p === 'string') people[k] = p;
  return {
    id: s(r.id),
    number: n(r.number),
    type: s(r.type),
    typeVersion: n(r.type_version),
    name: s(r.name),
    code: os(r.code),
    status: (s(r.status) || 'open') as OrderStatus,
    openedBy: s(r.opened_by),
    openedAt: n(r.opened_at),
    answers: rec(r.answers) as Record<string, AnswerValue>,
    lanes: arr(r.lanes).map((l) => {
      const x = rec(l);
      return {
        id: s(x.id),
        name: s(x.name),
        stages: arr(x.stages).map((st) => {
          const y = rec(st);
          return {
            id: s(y.id),
            name: s(y.name),
            approval: os(y.approval),
            status: (s(y.status) || 'not_started') as StageStatus,
            approvedBy: os(y.approved_by),
            jobs: arr(y.jobs)
              .filter((j) => j !== null)
              .map((j) => {
                const z = rec(j);
                const plan = z.plan ? rec(z.plan) : null;
                return {
                  id: s(z.id),
                  name: s(z.name),
                  team: s(z.team),
                  ownTeam: s(z.own_team) || s(z.team),
                  status: (s(z.status) || 'not_started') as JobStatus,
                  pickedBy: os(z.picked_by),
                  dueAt: on(z.due_at),
                  fired: arr(z.fired).filter((t): t is number => typeof t === 'number'),
                  escalated: os(z.escalated),
                  steps: strs(z.steps),
                  ticks: arr(z.ticks).filter((t): t is number => typeof t === 'number'),
                  asks: strs(z.asks),
                  readyAt: on(z.ready_at),
                  finishedAt: on(z.finished_at),
                  finishedBy: os(z.finished_by),
                  note: os(z.note),
                  plan: plan ? { design: s(plan.design), plan: s(plan.plan) } : null,
                };
              }),
          };
        }),
      };
    }),
    holds: arr(r.holds).map((h) => {
      const x = rec(h);
      return { job: s(x.job), field: s(x.field), design: s(x.design), device: s(x.device), port: os(x.port) };
    }),
    history: arr(r.history).map((h) => {
      const x = rec(h);
      return { seq: n(x.seq), at: n(x.at), by: s(x.by), action: s(x.action), detail: rec(x.detail) };
    }),
    definition: parseDefinition(r.definition),
    you: { account: s(you.account), steward: you.steward === true, teams: standing },
    people,
    teams: parseTeams(r.teams),
  };
}

export async function fetchOrder(organisation: string, id: string): Promise<Order> {
  return parseOrder(json(await signedFetch('GET', `${base(organisation)}/orders/${encodeURIComponent(id)}`)));
}

export async function openOrder(organisation: string, type: string, answers: Record<string, AnswerValue>): Promise<Order> {
  return parseOrder(json(await signedFetch('POST', `${base(organisation)}/orders`, body({ type, answers }))));
}

export type OrderAct =
  | { action: 'pick_up' | 'finish'; job: string }
  | { action: 'tick'; job: string; step: number; done: boolean }
  | { action: 'send_back' | 'cancel'; job: string; reason: string }
  | { action: 'link_plan'; job: string; design: string; plan: string }
  | { action: 'approve'; stage: string }
  | { action: 'answer'; field: string; value: AnswerValue | null; reason?: string }
  | { action: 'cancel_order'; reason: string };

export async function actOnOrder(organisation: string, id: string, act: OrderAct): Promise<Order> {
  return parseOrder(json(await signedFetch('POST', `${base(organisation)}/orders/${encodeURIComponent(id)}/act`, body(act))));
}

/** The engine's refusal sentence, or the server's, for showing beside what was tried. */
export function refusalWords(e: unknown): string {
  const r = saveRefusal(e);
  if (r.kind === 'other') return r.message;
  if (r.kind === 'secret') return 'That reads like a password or key, so Fathom did not keep it.';
  if (r.kind === 'unmatched') return `No team matches ${r.slugs.join(', ')}.`;
  return r.problems.map((p) => `Line ${p.line}: ${p.message}`).join(' ');
}
