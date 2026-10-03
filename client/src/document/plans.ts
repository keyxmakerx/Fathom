// Maintenance plans (ADR-0061 round 7, schema 0.14). A plan is a MaintenancePlan node with ordered
// PlanStep children (HasStep). It never changes the live design: a step holds its change as an
// `edit` the canvas already makes, and marking the step done applies it through the same commands
// (cables.ts, edit.ts, commands.ts), so the design's history sees it like any edit. All pure.
//
// Every text a person types goes through `gate` (the redaction gate, `Engine.redactText`) inside the
// command, so no caller can skip it. Order and stage are enforced here; the UI only calls these.

import { connectPorts, disconnect, setCableField, type CableFieldKey } from './cables';
import { movePlacement } from './commands';
import {
  setChassisField,
  setDeviceField,
  setPassiveNodeField,
  setRackField,
  setRackHeight,
  type ChassisFieldKey,
  type DeviceFieldKey,
  type RackFieldKey,
} from './edit';
import { addEdge, addNode, begin, finish, foldFrom, setNodeField, tombstone } from './freeform';
import {
  UnknownReferenceError,
  asNumber,
  asString,
  edgesIn,
  edgesOut,
  findNode,
  parseNodeId,
  text,
  token,
  uint,
  fieldValue,
  type Document,
  type GraphNode,
} from './model';

interface Actor {
  actor?: string;
  now?: number;
}

/** The redaction gate: what a person typed in, what may be stored out. */
export type TextGate = (text: string) => string;

export type PlanStage = 'planned' | 'doing' | 'recorded';
export type StepKind = 'address' | 'route' | 'cable' | 'move' | 'other';
export type StepState = 'planned' | 'done' | 'went_differently';
export type PlanOutcome = 'succeeded' | 'partial' | 'failed';

export const STEP_KINDS: readonly StepKind[] = ['address', 'route', 'cable', 'move', 'other'];
export const OUTCOMES: readonly PlanOutcome[] = ['succeeded', 'partial', 'failed'];

export type PlanRefusalCode =
  | 'not-a-plan'
  | 'not-a-step'
  | 'not-planning'
  | 'not-doing'
  | 'recorded'
  | 'no-steps'
  | 'out-of-order'
  | 'step-done'
  | 'note-required'
  | 'steps-left'
  | 'refused-by-check'
  | 'bad-edit'
  | 'bad-text';

export class PlanRefusal extends Error {
  readonly code: PlanRefusalCode;
  constructor(code: PlanRefusalCode, message: string) {
    super(message);
    this.name = 'PlanRefusal';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// The edit a step holds: one tab-separated line, read by `crates/fathom-wasm/src/plan.rs` too.

export type StepEdit =
  | { t: 'field'; id: string; key: string; value: string }
  | { t: 'cable'; a: string; b: string }
  | { t: 'cut'; cable: string }
  | { t: 'move'; chassis: string; rack: string; positionU: number; face: 'front' | 'rear' };

function clean(part: string, what: string): string {
  if (/[\t\r\n]/.test(part)) throw new PlanRefusal('bad-edit', `${what} may not hold a tab or a line break`);
  return part;
}

export function encodeEdit(e: StepEdit): string {
  switch (e.t) {
    case 'field':
      return ['field', clean(e.id, 'an id'), clean(e.key, 'a field'), clean(e.value, 'a value')].join('\t');
    case 'cable':
      return ['cable', clean(e.a, 'an id'), clean(e.b, 'an id')].join('\t');
    case 'cut':
      return ['cut', clean(e.cable, 'an id')].join('\t');
    case 'move':
      return ['move', clean(e.chassis, 'an id'), clean(e.rack, 'an id'), String(e.positionU), e.face].join('\t');
  }
}

export function decodeEdit(line: string | undefined): StepEdit | null {
  if (line === undefined || line === '') return null;
  const p = line.split('\t');
  switch (p[0]) {
    case 'field':
      return p.length === 4 ? { t: 'field', id: p[1], key: p[2], value: p[3] } : null;
    case 'cable':
      return p.length >= 3 ? { t: 'cable', a: p[1], b: p[2] } : null;
    case 'cut':
      return p.length === 2 ? { t: 'cut', cable: p[1] } : null;
    case 'move': {
      const u = Number(p[3]);
      return p.length === 5 && Number.isInteger(u) && (p[4] === 'front' || p[4] === 'rear')
        ? { t: 'move', chassis: p[1], rack: p[2], positionU: u, face: p[4] }
        : null;
    }
    default:
      return null;
  }
}

/** The design ids an edit touches, in order. */
export function targetsOf(e: StepEdit | null): string[] {
  if (e === null) return [];
  switch (e.t) {
    case 'field':
      return [e.id];
    case 'cable':
      return [e.a, e.b];
    case 'cut':
      return [e.cable];
    case 'move':
      return [e.chassis, e.rack];
  }
}

/** The field edits a step may hold: each is a field a person can already set by hand. */
export const EDITABLE_FIELDS: readonly string[] = [
  'Device.hostname',
  'Device.role',
  'Device.management_address',
  'Chassis.serial',
  'Rack.row',
  'Rack.bay',
  'Rack.height_u',
  'PassiveNode.label',
  'Cable.label',
  'Cable.sheath',
  'Cable.media',
  'Cable.length_m',
  'Cable.ownership',
];

/** Applies an edit through the command a hand edit uses. Throws what that command throws. */
export function applyEdit(doc: Document, e: StepEdit, opts?: Actor): Document {
  switch (e.t) {
    case 'cable':
      return connectPorts(doc, e.a, e.b, {}, opts);
    case 'cut':
      return disconnect(doc, e.cable, opts);
    case 'move':
      return movePlacement(doc, e.chassis, { kind: 'rack', rackId: e.rack, positionU: e.positionU, face: e.face }, opts);
    case 'field': {
      const value = e.value === '' ? null : e.value;
      const [kind, key] = e.key.split('.');
      switch (kind) {
        case 'Device':
          return setDeviceField(doc, e.id, key as DeviceFieldKey, value, opts);
        case 'Chassis':
          return setChassisField(doc, e.id, key as ChassisFieldKey, value, opts);
        case 'Rack':
          return key === 'height_u'
            ? setRackHeight(doc, e.id, Number(value), opts)
            : setRackField(doc, e.id, key as RackFieldKey, value, opts);
        case 'PassiveNode':
          return setPassiveNodeField(doc, e.id, 'label', value, opts);
        case 'Cable':
          return setCableField(doc, e.id, key as CableFieldKey, key === 'length_m' && value !== null ? Number(value) : value, opts);
        default:
          throw new PlanRefusal('bad-edit', `${e.key} is not a field a plan step can set`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Reading

export interface PlanStep {
  id: string;
  ordinal: number;
  kind: StepKind;
  change: string;
  before: string;
  after: string;
  /** Design ids, from the edit or as typed. */
  targets: string[];
  edit: StepEdit | null;
  state: StepState;
  note: string;
  doneAt: string;
}

export interface Plan {
  id: string;
  title: string;
  windowStart: string;
  windowEnd: string;
  author: string;
  stage: PlanStage;
  outcome: PlanOutcome | null;
  record: string;
  steps: PlanStep[];
}

const str = (n: GraphNode, key: string): string => asString(fieldValue(n.fields, key)) ?? '';

function live(doc: Document, id: string, kind: 'MaintenancePlan' | 'PlanStep'): GraphNode {
  const n = findNode(doc, id);
  if (!n || n.absentSince !== undefined || parseNodeId(id).kind !== kind) {
    throw new PlanRefusal(kind === 'MaintenancePlan' ? 'not-a-plan' : 'not-a-step', `"${id}" is not a live ${kind}`);
  }
  return n;
}

function readStep(n: GraphNode): PlanStep {
  const edit = decodeEdit(str(n, 'PlanStep.edit'));
  const typed = str(n, 'PlanStep.targets');
  return {
    id: n.id,
    ordinal: asNumber(fieldValue(n.fields, 'PlanStep.ordinal')) ?? 0,
    kind: (str(n, 'PlanStep.kind') || 'other') as StepKind,
    change: str(n, 'PlanStep.change'),
    before: str(n, 'PlanStep.before'),
    after: str(n, 'PlanStep.after'),
    targets: typed !== '' ? typed.split('\n') : targetsOf(edit),
    edit,
    state: (str(n, 'PlanStep.state') || 'planned') as StepState,
    note: str(n, 'PlanStep.note'),
    doneAt: str(n, 'PlanStep.done_at'),
  };
}

export function planSteps(doc: Document, planId: string): PlanStep[] {
  return edgesOut(doc, planId, 'HasStep')
    .map((e) => findNode(doc, e.to))
    .filter((n): n is GraphNode => n !== undefined && n.absentSince === undefined)
    .map(readStep)
    .sort((a, b) => a.ordinal - b.ordinal);
}

export function readPlan(doc: Document, id: string): Plan {
  const n = live(doc, id, 'MaintenancePlan');
  const outcome = str(n, 'MaintenancePlan.outcome');
  return {
    id,
    title: str(n, 'MaintenancePlan.title'),
    windowStart: str(n, 'MaintenancePlan.window_start'),
    windowEnd: str(n, 'MaintenancePlan.window_end'),
    author: str(n, 'MaintenancePlan.author'),
    stage: (str(n, 'MaintenancePlan.stage') || 'planned') as PlanStage,
    outcome: outcome === '' ? null : (outcome as PlanOutcome),
    record: str(n, 'MaintenancePlan.record'),
    steps: planSteps(doc, id),
  };
}

/** Every live plan, newest first. */
export function listPlans(doc: Document): Plan[] {
  return doc.nodes
    .filter((n) => n.absentSince === undefined && parseNodeId(n.id).kind === 'MaintenancePlan')
    .map((n) => readPlan(doc, n.id))
    .reverse();
}

/** The step to do next: the first still planned, or null. */
export function currentStep(plan: Plan): PlanStep | null {
  return plan.steps.find((s) => s.state === 'planned') ?? null;
}

/** Everything a plan touches, once each, in step order. */
export function touchedBy(plan: Plan): string[] {
  return [...new Set(plan.steps.flatMap((s) => s.targets))];
}

/** Recorded plans that touched `elementId`, newest first: what a thing's History shows. */
export function recordedPlansTouching(doc: Document, elementId: string): Plan[] {
  return listPlans(doc).filter((p) => p.stage === 'recorded' && touchedBy(p).includes(elementId));
}

/** Out-of-order states a document might hold (a hand-edited file, a bad merge). Empty is sound. */
export function planProblems(plan: Plan): string[] {
  const out: string[] = [];
  let sawPlanned = false;
  const ordinals = new Set<number>();
  for (const s of plan.steps) {
    if (ordinals.has(s.ordinal)) out.push(`two steps are numbered ${s.ordinal + 1}`);
    ordinals.add(s.ordinal);
    if (s.state === 'planned') sawPlanned = true;
    else if (sawPlanned) out.push(`step ${s.ordinal + 1} is marked ${s.state.replace('_', ' ')} before an earlier step`);
  }
  if (plan.stage === 'planned' && plan.steps.some((s) => s.state !== 'planned')) out.push('a step is marked before the plan started');
  if (plan.stage === 'recorded' && plan.steps.some((s) => s.state === 'planned')) out.push('the plan is recorded with steps left');
  return out;
}

// ---------------------------------------------------------------------------
// Writing

function gated(gate: TextGate, value: string | undefined, what: string): string {
  const out = gate(value ?? '');
  if (/\u0000/.test(out)) throw new PlanRefusal('bad-text', `${what} holds a character that cannot be stored`);
  return out;
}

function requirePlanning(doc: Document, planId: string): void {
  live(doc, planId, 'MaintenancePlan');
  const stage = str(findNode(doc, planId)!, 'MaintenancePlan.stage');
  if (stage === 'recorded') throw new PlanRefusal('recorded', 'this plan is recorded and cannot change');
  if (stage !== 'planned' && stage !== '') throw new PlanRefusal('not-planning', 'steps can only change before work starts');
}

export interface CreatePlanOptions extends Actor {
  title: string;
  windowStart?: string;
  windowEnd?: string;
  author?: string;
  gate: TextGate;
}

export function createPlan(doc: Document, opts: CreatePlanOptions): { doc: Document; id: string } {
  const title = gated(opts.gate, opts.title, 'the title').trim();
  if (title === '') throw new PlanRefusal('bad-text', 'a plan needs a title');
  const b = begin(doc, opts);
  const fields: Record<string, ReturnType<typeof text>> = {
    'MaintenancePlan.title': text(title),
    'MaintenancePlan.stage': token('planned'),
  };
  if (opts.windowStart) fields['MaintenancePlan.window_start'] = text(opts.windowStart);
  if (opts.windowEnd) fields['MaintenancePlan.window_end'] = text(opts.windowEnd);
  if (opts.author) fields['MaintenancePlan.author'] = text(gated(opts.gate, opts.author, 'the author'));
  const id = addNode(b, 'MaintenancePlan', fields);
  return { doc: finish(b, 'plan a change'), id };
}

export function setPlanHead(
  doc: Document,
  planId: string,
  patch: { title?: string; windowStart?: string; windowEnd?: string },
  opts: Actor & { gate: TextGate },
): Document {
  requirePlanning(doc, planId);
  const b = begin(doc, opts);
  if (patch.title !== undefined) {
    const t = gated(opts.gate, patch.title, 'the title').trim();
    if (t === '') throw new PlanRefusal('bad-text', 'a plan needs a title');
    setNodeField(b, planId, 'MaintenancePlan.title', text(t));
  }
  if (patch.windowStart !== undefined) setNodeField(b, planId, 'MaintenancePlan.window_start', text(patch.windowStart));
  if (patch.windowEnd !== undefined) setNodeField(b, planId, 'MaintenancePlan.window_end', text(patch.windowEnd));
  return finish(b, 'edit plan');
}

export interface AddStepOptions extends Actor {
  kind: StepKind;
  change: string;
  before?: string;
  after?: string;
  edit?: StepEdit;
  /** Design ids when there is no edit to read them from. */
  targets?: readonly string[];
  gate: TextGate;
}

export function addStep(doc: Document, planId: string, opts: AddStepOptions): { doc: Document; id: string } {
  requirePlanning(doc, planId);
  if (!STEP_KINDS.includes(opts.kind)) throw new PlanRefusal('bad-edit', `"${opts.kind}" is not a kind of step`);
  const change = gated(opts.gate, opts.change, 'the step').trim();
  if (change === '') throw new PlanRefusal('bad-text', 'a step needs words saying what changes');
  const steps = planSteps(doc, planId);
  const fields: Record<string, ReturnType<typeof text>> = {
    'PlanStep.ordinal': uint(steps.length === 0 ? 0 : steps[steps.length - 1].ordinal + 1, 32),
    'PlanStep.kind': token(opts.kind),
    'PlanStep.change': text(change),
    'PlanStep.state': token('planned'),
  };
  if (opts.before) fields['PlanStep.before'] = text(gated(opts.gate, opts.before, 'the before'));
  if (opts.after) fields['PlanStep.after'] = text(gated(opts.gate, opts.after, 'the after'));
  if (opts.edit) {
    // The value is the one place a typed value reaches an edit; it is gated like any text.
    const e = opts.edit.t === 'field' ? { ...opts.edit, value: gated(opts.gate, opts.edit.value, 'the value') } : opts.edit;
    fields['PlanStep.edit'] = text(encodeEdit(e));
    if (e.t === 'field' && !EDITABLE_FIELDS.includes(e.key)) throw new PlanRefusal('bad-edit', `${e.key} is not a field a plan step can set`);
  }
  const targets = opts.targets ?? [];
  if (!opts.edit && targets.length > 0) fields['PlanStep.targets'] = text(targets.join('\n'));
  const b = begin(doc, opts);
  const id = addNode(b, 'PlanStep', fields);
  addEdge(b, 'HasStep', planId, id);
  return { doc: finish(b, 'add step'), id };
}

function renumber(b: ReturnType<typeof begin>, ordered: readonly PlanStep[]): void {
  ordered.forEach((s, i) => {
    if (s.ordinal !== i) setNodeField(b, s.id, 'PlanStep.ordinal', uint(i, 32));
  });
}

function planOf(doc: Document, stepId: string): string {
  live(doc, stepId, 'PlanStep');
  const edge = edgesIn(doc, stepId, 'HasStep')[0];
  if (!edge) throw new PlanRefusal('not-a-step', `"${stepId}" has no plan`);
  return edge.from;
}

export function removeStep(doc: Document, stepId: string, opts?: Actor): Document {
  const planId = planOf(doc, stepId);
  requirePlanning(doc, planId);
  const b = begin(doc, opts);
  const edge = edgesIn(doc, stepId, 'HasStep')[0]!;
  tombstone(b, new Set([stepId]), new Set([edge.id]));
  renumber(b, planSteps(doc, planId).filter((s) => s.id !== stepId));
  return finish(b, 'remove step');
}

/** Reorders while planning: `stepId` goes to `index` (0-based) among the plan's steps. */
export function moveStep(doc: Document, stepId: string, index: number, opts?: Actor): Document {
  const planId = planOf(doc, stepId);
  requirePlanning(doc, planId);
  const steps = planSteps(doc, planId);
  const from = steps.findIndex((s) => s.id === stepId);
  const to = Math.max(0, Math.min(steps.length - 1, index));
  if (from === to) return doc;
  const ordered = steps.slice();
  const [moved] = ordered.splice(from, 1);
  ordered.splice(to, 0, moved);
  const b = begin(doc, opts);
  renumber(b, ordered);
  return finish(b, 'move step');
}

/** Planning to doing. A plan with no steps cannot start. */
export function startPlan(doc: Document, planId: string, opts?: Actor): Document {
  requirePlanning(doc, planId);
  if (planSteps(doc, planId).length === 0) throw new PlanRefusal('no-steps', 'add a step before starting the work');
  const b = begin(doc, opts);
  setNodeField(b, planId, 'MaintenancePlan.stage', token('doing'));
  return finish(b, 'start plan');
}

function requireTurn(doc: Document, stepId: string): { plan: Plan; step: PlanStep } {
  const planId = planOf(doc, stepId);
  const plan = readPlan(doc, planId);
  if (plan.stage === 'recorded') throw new PlanRefusal('recorded', 'this plan is recorded and cannot change');
  if (plan.stage !== 'doing') throw new PlanRefusal('not-doing', 'start the work before marking a step');
  const step = plan.steps.find((s) => s.id === stepId)!;
  // A second person marking the same step meets this: it is no longer planned.
  if (step.state !== 'planned') throw new PlanRefusal('step-done', 'this step was already marked');
  if (plan.steps.some((s) => s.ordinal < step.ordinal && s.state === 'planned')) {
    throw new PlanRefusal('out-of-order', 'an earlier step is still to do');
  }
  return { plan, step };
}

/** The checks' verdict on an edit: the first refusal (a finding), or null to go ahead. */
export type StepCheck = (edit: StepEdit) => { title: string } | null;

function relabelLast(doc: Document, from: number, label: string): Document {
  const folded = foldFrom(doc, from);
  const batches = folded.batches.slice();
  const last = batches[batches.length - 1];
  if (last && batches.length > from) batches[batches.length - 1] = { ...last, label };
  return { ...folded, batches };
}

export interface MarkDoneOptions extends Actor {
  /** Dry-runs the step's edit against the checks (`OP_CHECK_GESTURE`). Required, so no caller skips it. */
  check: StepCheck;
}

/** Applies the step's edit through the normal command, then marks it done: one undo step. */
export function markDone(doc: Document, stepId: string, opts: MarkDoneOptions): Document {
  const { plan, step } = requireTurn(doc, stepId);
  if (step.edit) {
    const refused = opts.check(step.edit);
    if (refused) throw new PlanRefusal('refused-by-check', refused.title);
  }
  const from = doc.batches.length;
  const now = opts.now ?? Date.now();
  const applied = step.edit ? applyEdit(doc, step.edit, { actor: opts.actor, now }) : doc;
  const b = begin(applied, { actor: opts.actor, now });
  setNodeField(b, stepId, 'PlanStep.state', token('done'));
  setNodeField(b, stepId, 'PlanStep.done_at', text(new Date(now).toISOString()));
  return relabelLast(finish(b, 'mark step'), from, `${plan.title}: step ${step.ordinal + 1} done`);
}

export interface WentDifferentlyOptions extends Actor {
  note: string;
  gate: TextGate;
}

/** The step happened another way: nothing is applied, the note says how. */
export function markWentDifferently(doc: Document, stepId: string, opts: WentDifferentlyOptions): Document {
  const { plan, step } = requireTurn(doc, stepId);
  const note = gated(opts.gate, opts.note, 'the note').trim();
  if (note === '') throw new PlanRefusal('note-required', 'say what happened instead');
  const now = opts.now ?? Date.now();
  const b = begin(doc, { actor: opts.actor, now });
  setNodeField(b, stepId, 'PlanStep.state', token('went_differently'));
  setNodeField(b, stepId, 'PlanStep.note', text(note));
  setNodeField(b, stepId, 'PlanStep.done_at', text(new Date(now).toISOString()));
  return finish(b, `${plan.title}: step ${step.ordinal + 1} went differently`);
}

export interface RecordOptions extends Actor {
  outcome: PlanOutcome;
  /** What went wrong, or anything worth keeping. */
  text?: string;
  gate: TextGate;
}

/** Closes the plan. Once recorded it never changes: History reads it as written. */
export function recordPlan(doc: Document, planId: string, opts: RecordOptions): Document {
  const plan = readPlan(doc, planId);
  if (plan.stage === 'recorded') throw new PlanRefusal('recorded', 'this plan is recorded and cannot change');
  if (plan.stage !== 'doing') throw new PlanRefusal('not-doing', 'start the work before recording it');
  if (plan.steps.some((s) => s.state === 'planned')) throw new PlanRefusal('steps-left', 'mark every step before recording');
  if (!OUTCOMES.includes(opts.outcome)) throw new PlanRefusal('bad-edit', `"${opts.outcome}" is not an outcome`);
  const b = begin(doc, opts);
  setNodeField(b, planId, 'MaintenancePlan.stage', token('recorded'));
  setNodeField(b, planId, 'MaintenancePlan.outcome', token(opts.outcome));
  const record = gated(opts.gate, opts.text, 'the record').trim();
  if (record !== '') setNodeField(b, planId, 'MaintenancePlan.record', text(record));
  return finish(b, `${plan.title}: recorded as ${opts.outcome}`);
}

/** Unknown ids in a plan's steps, for the list view to flag: a thing deleted since planning. */
export function missingTargets(doc: Document, plan: Plan): string[] {
  return touchedBy(plan).filter((id) => {
    const n = findNode(doc, id);
    return !n || n.absentSince !== undefined;
  });
}

export { UnknownReferenceError };
