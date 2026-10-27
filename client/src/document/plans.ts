// Maintenance plans (ADR-0061 round 7, schema 0.15). A plan is a MaintenancePlan node with ordered
// PlanStep children (HasStep). It never changes the live design: a step holds its change as an
// `edit` the canvas already makes, and marking the step done applies it through the same commands
// (cables.ts, edit.ts, commands.ts), so the design's history sees it like any edit. All pure.
//
// Plan text meets the redaction gate the way notes do (ADR-0053 section 6): text a person PASTES goes through
// `gate` (the redaction gate, `Engine.redactText`) inside the command; text they TYPE is stored as typed. Each
// command still takes `gate`, so no caller can forget the choice: the UI passes the real gate for a pasted form and
// `TYPED_AS_WRITTEN` otherwise. Order and stage are checked here by the client's own commands; the UI only calls these.

import { connectPorts, disconnect, setCableField, type CableFieldKey } from './cables';
import { opticOf, setCardField, setOptic } from './cards';
import { setSupplyField } from './supplies';
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
  parseEdgeId,
  parseNodeId,
  readMountedInFields,
  text,
  token,
  uint,
  fieldValue,
  interfaceName,
  type Document,
  type GraphNode,
} from './model';
import { memberInterfaces } from './portTies';
import { reservedFor, swapFromStock, type OldPartTo } from './stock';
import { truncateUtf8 } from './undo';

interface Actor {
  actor?: string;
  now?: number;
}

/** The redaction gate: what a person gave in, what may be stored out. */
export type TextGate = (text: string) => string;

/** The explicit "stored as typed" choice for text nobody pasted. Never the answer for a pasted field. */
export const TYPED_AS_WRITTEN: TextGate = (text) => text;

export type PlanStage = 'planned' | 'doing' | 'recorded';
export type StepKind = 'address' | 'route' | 'cable' | 'move' | 'other' | 'lag' | 'swap';
export type StepState = 'planned' | 'done' | 'went_differently';
export type PlanOutcome = 'succeeded' | 'partial' | 'failed';

export const STEP_KINDS: readonly StepKind[] = ['address', 'route', 'cable', 'move', 'lag', 'swap', 'other'];
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
  | { t: 'move'; chassis: string; rack: string; positionU: number; face: 'front' | 'rear' }
  | { t: 'lag'; device: string; name: string; lacp: LacpMode; members: string[] }
  | { t: 'unlag'; lag: string }
  /** r35: a part swapped for another. `id` is a Card, a PowerSupply, or the PhysicalPort an optic sits in; the
   * new part's model (an optic's part number) and serial. An empty model keeps the one it has. */
  | { t: 'part'; id: string; model: string; serial: string };

/** The node kinds a part swap may name. */
export const PART_KINDS: readonly string[] = ['Card', 'PowerSupply', 'PhysicalPort'];

/** `lacp_mode` (schema/enums/lacp_mode.yaml); '' leaves it unset. `off` is a static bundle. */
export type LacpMode = 'active' | 'passive' | 'off' | '';
export const LACP_MODES: readonly LacpMode[] = ['active', 'passive', 'off', ''];

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
    case 'lag':
      return ['lag', clean(e.device, 'an id'), clean(e.name, 'a name'), e.lacp, ...e.members.map((m) => clean(m, 'an id'))].join('\t');
    case 'unlag':
      return ['unlag', clean(e.lag, 'an id')].join('\t');
    case 'part':
      return ['part', clean(e.id, 'an id'), clean(e.model, 'a model'), clean(e.serial, 'a serial')].join('\t');
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
    case 'lag':
      return p.length >= 5 && (LACP_MODES as readonly string[]).includes(p[3])
        ? { t: 'lag', device: p[1], name: p[2], lacp: p[3] as LacpMode, members: p.slice(4) }
        : null;
    case 'unlag':
      return p.length === 2 ? { t: 'unlag', lag: p[1] } : null;
    case 'part':
      return p.length === 4 ? { t: 'part', id: p[1], model: p[2], serial: p[3] } : null;
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
    case 'lag':
      return [e.device, ...e.members];
    case 'unlag':
      return [e.lag];
    case 'part':
      return [e.id];
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

/** The node kind a design id names, or null when it is not a well-formed node id. */
function nodeKindOf(id: string): string | null {
  try {
    return parseNodeId(id).kind;
  } catch {
    return null;
  }
}

/** A field edit's key must be one a hand can set, and the target must be of the kind that owns it. */
function assertEditable(e: StepEdit): void {
  if (e.t !== 'field') return;
  if (!EDITABLE_FIELDS.includes(e.key)) throw new PlanRefusal('bad-edit', `${e.key} is not a field a plan step can set`);
  if (nodeKindOf(e.id) !== e.key.split('.')[0]) {
    throw new PlanRefusal('bad-edit', `${e.key} does not belong to the thing this step changes`);
  }
}

/** The id slots of an edit and the node kind each must be. */
function slotsOf(e: StepEdit): [string, string][] {
  switch (e.t) {
    case 'field':
      return [[e.id, e.key.split('.')[0]]];
    case 'cable':
      return [
        [e.a, 'PhysicalPort'],
        [e.b, 'PhysicalPort'],
      ];
    case 'cut':
      return [[e.cable, 'Cable']];
    case 'move':
      return [
        [e.chassis, 'Chassis'],
        [e.rack, 'Rack'],
      ];
    case 'lag':
      return [[e.device, 'Device'], ...e.members.map((m): [string, string] => [m, 'Interface'])];
    case 'unlag':
      return [[e.lag, 'AggregateInterface']];
    case 'part':
      return [[e.id, nodeKindOf(e.id) ?? 'Card']];
  }
}

/** Refuses an edit whose key, ids or kinds are not well formed, or name something not in the design. */
function assertWellFormed(doc: Document, e: StepEdit): void {
  assertEditable(e);
  for (const [id, kind] of slotsOf(e)) {
    if (nodeKindOf(id) !== kind) throw new PlanRefusal('bad-edit', `"${id}" is not a ${kind}`);
    const n = findNode(doc, id);
    if (!n || n.absentSince !== undefined) throw new PlanRefusal('bad-edit', `"${id}" is not in the design`);
  }
  if (e.t === 'move' && !Number.isInteger(e.positionU)) throw new PlanRefusal('bad-edit', 'a rack position is a whole number');
  if (e.t === 'move' && e.face !== 'front' && e.face !== 'rear') throw new PlanRefusal('bad-edit', 'a face is front or rear');
  if (e.t === 'lag') assertLag(doc, e);
  if (e.t === 'unlag') lagEdges(doc, e.lag);
  if (e.t === 'part') assertPart(e);
}

function assertPart(e: Extract<StepEdit, { t: 'part' }>): void {
  if (!PART_KINDS.includes(nodeKindOf(e.id) ?? '')) throw new PlanRefusal('bad-edit', 'a swap names a card, a power supply, or the port an optic is in');
  if (e.serial.trim() === '' && e.model.trim() === '') throw new PlanRefusal('bad-edit', "give the new part's serial or model");
  for (const v of [e.model, e.serial]) {
    if (v !== '' && !/^[\x21-\x7e]+$/.test(v)) throw new PlanRefusal('bad-edit', 'a model or serial is one word with no spaces');
  }
}

/** Swaps the part in place: its serial, and its model when one is given. The part's ports and cables stay. One undo step. */
function swapPart(doc: Document, e: Extract<StepEdit, { t: 'part' }>, opts?: Actor): Document {
  assertPart(e);
  const from = doc.batches.length;
  const model = e.model.trim();
  const serial = e.serial.trim();
  let working = doc;
  switch (nodeKindOf(e.id)) {
    case 'Card':
      if (serial !== '') working = setCardField(working, e.id, 'serial', serial, opts);
      if (model !== '') working = setCardField(working, e.id, 'model', model, opts);
      break;
    case 'PowerSupply':
      if (serial !== '') working = setSupplyField(working, e.id, 'serial', serial, opts);
      if (model !== '') working = setSupplyField(working, e.id, 'model', model, opts);
      break;
    default: {
      const had = opticOf(findNode(doc, e.id)!) ?? {};
      working = setOptic(working, e.id, { ...had, ...(model !== '' ? { part: model } : {}), ...(serial !== '' ? { serial } : {}) }, opts);
    }
  }
  const folded = foldFrom(working, from);
  const last = folded.batches.length - 1;
  return { ...folded, batches: [...folded.batches.slice(0, last), { ...folded.batches[last]!, label: 'swap part' }] };
}

// ---------------------------------------------------------------------------
// LAG steps (schema 0.25): member Interfaces of one device bundled into a new AggregateInterface
// (ae on Junos, port-channel on IOS, bond on Linux). The far end is its own step on its own device.

/** The LAG a member already belongs to, or null. */
function lagOf(doc: Document, interfaceId: string): string | null {
  for (const m of edgesOut(doc, interfaceId, 'MemberOfAggregate')) {
    const ae = findNode(doc, m.to);
    if (m.absentSince === undefined && ae && ae.absentSince === undefined) return asString(fieldValue(ae.fields, 'AggregateInterface.name')) ?? m.to;
  }
  return null;
}

/** Every interface-like name the device already holds. */
function interfaceNames(doc: Document, deviceId: string): Set<string> {
  const out = new Set<string>();
  for (const e of edgesOut(doc, deviceId, 'HasInterface')) {
    const n = findNode(doc, e.to);
    if (e.absentSince !== undefined || !n || n.absentSince !== undefined) continue;
    const name = asString(fieldValue(n.fields, `${parseNodeId(n.id).kind}.name`));
    if (name !== undefined) out.add(name);
  }
  return out;
}

export interface LagMember {
  id: string;
  name: string;
  /** The LAG it is in now, or null when it is free to bundle. */
  inLag: string | null;
}

/** A device's member Interfaces, in name order, saying which are already in a LAG. */
export function lagMembers(doc: Document, deviceId: string): LagMember[] {
  return memberInterfaces(doc, deviceId)
    .map((i) => ({ ...i, inLag: lagOf(doc, i.id) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/** The first free LAG name in the device's own naming: ae0 on Junos, bond0 on Linux, Port-channel1 on IOS. */
export function nextLagName(doc: Document, deviceId: string): string {
  const platform = asString(fieldValue(findNode(doc, deviceId)?.fields ?? {}, 'Device.platform')) ?? '';
  const [stem, from] = platform.startsWith('junos') ? ['ae', 0] : platform.startsWith('linux') ? ['bond', 0] : platform.startsWith('ios') ? ['Port-channel', 1] : ['lag', 0];
  const taken = interfaceNames(doc, deviceId);
  let i = from;
  while (taken.has(`${stem}${i}`)) i++;
  return `${stem}${i}`;
}

function assertLag(doc: Document, e: Extract<StepEdit, { t: 'lag' }>): void {
  if (!/^[\x21-\x7e]+$/.test(e.name)) throw new PlanRefusal('bad-edit', 'a LAG name is one word with no spaces');
  if (!LACP_MODES.includes(e.lacp)) throw new PlanRefusal('bad-edit', `"${e.lacp}" is not an LACP mode`);
  if (e.members.length < 2) throw new PlanRefusal('bad-edit', 'a LAG needs two or more members');
  if (new Set(e.members).size !== e.members.length) throw new PlanRefusal('bad-edit', 'a member is listed twice');
  if (interfaceNames(doc, e.device).has(e.name)) throw new PlanRefusal('bad-edit', `${e.name} already exists on this device`);
  const own = new Set(memberInterfaces(doc, e.device).map((i) => i.id));
  for (const m of e.members) {
    if (!own.has(m)) throw new PlanRefusal('bad-edit', 'every member must be an interface of this device');
    const held = lagOf(doc, m);
    if (held !== null) throw new PlanRefusal('bad-edit', `a member is already in ${held}`);
  }
}

/** The edges a LAG removal takes with it: its HasInterface and its members' MemberOfAggregate. Anything else on it
 * (a unit, an address) is refused, so removing a LAG never leaves a config orphaned. */
function lagEdges(doc: Document, lagId: string): string[] {
  const ae = findNode(doc, lagId);
  if (!ae || ae.absentSince !== undefined) throw new PlanRefusal('bad-edit', 'that LAG is not in the design');
  const own = doc.edges.filter((x) => x.absentSince === undefined && (x.from === lagId || x.to === lagId));
  const taken = own.filter((x) => parseEdgeId(x.id).kind === 'HasInterface' || parseEdgeId(x.id).kind === 'MemberOfAggregate');
  if (taken.length !== own.length) {
    const name = asString(fieldValue(ae.fields, 'AggregateInterface.name')) ?? 'the LAG';
    throw new PlanRefusal('bad-edit', `${name} carries more than its members; take those off first`);
  }
  return taken.map((x) => x.id);
}

/** Removes a LAG: the AggregateInterface and its member edges, members kept. One undo step. */
function removeLag(doc: Document, lagId: string, opts?: Actor): Document {
  const edges = lagEdges(doc, lagId);
  const name = asString(fieldValue(findNode(doc, lagId)!.fields, 'AggregateInterface.name')) ?? 'LAG';
  const b = begin(doc, opts);
  tombstone(b, new Set([lagId]), new Set(edges));
  return finish(b, truncateUtf8(`remove LAG ${name}`));
}

/** Builds the LAG: the AggregateInterface on the device, and each member joined to it. One undo step. */
function makeLag(doc: Document, e: Extract<StepEdit, { t: 'lag' }>, opts?: Actor): Document {
  assertLag(doc, e);
  const b = begin(doc, opts);
  const fields: Record<string, ReturnType<typeof text>> = { 'AggregateInterface.name': interfaceName(e.name) };
  if (e.lacp !== '') fields['AggregateInterface.lacp_mode'] = token(e.lacp);
  const ae = addNode(b, 'AggregateInterface', fields);
  addEdge(b, 'HasInterface', e.device, ae);
  for (const m of e.members) addEdge(b, 'MemberOfAggregate', m, ae);
  return finish(b, truncateUtf8(`make LAG ${e.name}`));
}

/** Applies an edit through the command a hand edit uses. Throws what that command throws. */
export function applyEdit(doc: Document, e: StepEdit, opts?: Actor): Document {
  assertEditable(e);
  switch (e.t) {
    case 'cable':
      return connectPorts(doc, e.a, e.b, {}, opts);
    case 'cut':
      return disconnect(doc, e.cable, opts);
    case 'move':
      return movePlacement(doc, e.chassis, { kind: 'rack', rackId: e.rack, positionU: e.positionU, face: e.face }, opts);
    case 'lag':
      return makeLag(doc, e, opts);
    case 'unlag':
      return removeLag(doc, e.lag, opts);
    case 'part':
      return swapPart(doc, e, opts);
    case 'field': {
      const value = e.value === '' ? null : e.value;
      const [kind, key] = e.key.split('.');
      const number = (): number => {
        const n = Number(value);
        if (value === null || !Number.isFinite(n)) throw new PlanRefusal('bad-edit', `${e.key} needs a number`);
        return n;
      };
      switch (kind) {
        case 'Device':
          return setDeviceField(doc, e.id, key as DeviceFieldKey, value, opts);
        case 'Chassis':
          return setChassisField(doc, e.id, key as ChassisFieldKey, value, opts);
        case 'Rack':
          return key === 'height_u'
            ? setRackHeight(doc, e.id, number(), opts)
            : setRackField(doc, e.id, key as RackFieldKey, value, opts);
        case 'PassiveNode':
          return setPassiveNodeField(doc, e.id, 'label', value, opts);
        case 'Cable':
          return setCableField(doc, e.id, key as CableFieldKey, key === 'length_m' && value !== null ? number() : value, opts);
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
  if (out.includes('\u0000')) throw new PlanRefusal('bad-text', `${what} holds a character that cannot be stored`);
  return out;
}

/** A window end is empty, or an ISO date-time as a date-time field gives it. */
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})?$/;

function windowValue(value: string, what: string): string {
  if (value === '') return value;
  if (!ISO_DATE_TIME.test(value) || Number.isNaN(new Date(value).getTime())) {
    throw new PlanRefusal('bad-text', `${what} is not a date and time`);
  }
  return value;
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
  const windowStart = windowValue(opts.windowStart ?? '', 'the start of the window');
  const windowEnd = windowValue(opts.windowEnd ?? '', 'the end of the window');
  const b = begin(doc, opts);
  const fields: Record<string, ReturnType<typeof text>> = {
    'MaintenancePlan.title': text(title),
    'MaintenancePlan.stage': token('planned'),
  };
  if (windowStart) fields['MaintenancePlan.window_start'] = text(windowStart);
  if (windowEnd) fields['MaintenancePlan.window_end'] = text(windowEnd);
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
  const start = patch.windowStart === undefined ? undefined : windowValue(patch.windowStart, 'the start of the window');
  const end = patch.windowEnd === undefined ? undefined : windowValue(patch.windowEnd, 'the end of the window');
  const b = begin(doc, opts);
  if (patch.title !== undefined) {
    const t = gated(opts.gate, patch.title, 'the title').trim();
    if (t === '') throw new PlanRefusal('bad-text', 'a plan needs a title');
    setNodeField(b, planId, 'MaintenancePlan.title', text(t));
  }
  if (start !== undefined) setNodeField(b, planId, 'MaintenancePlan.window_start', text(start));
  if (end !== undefined) setNodeField(b, planId, 'MaintenancePlan.window_end', text(end));
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
    // The value is the one place a typed value reaches an edit; it takes the same gate as the other fields.
    const e = opts.edit.t === 'field' ? { ...opts.edit, value: gated(opts.gate, opts.edit.value, 'the value') } : opts.edit;
    assertWellFormed(doc, e);
    fields['PlanStep.edit'] = text(encodeEdit(e));
  }
  const targets = opts.targets ?? [];
  if (!opts.edit) {
    for (const t of targets) {
      const n = nodeKindOf(t) === null ? undefined : findNode(doc, t);
      if (!n || n.absentSince !== undefined) throw new PlanRefusal('bad-edit', `"${t}" is not in the design`);
    }
    if (targets.length > 0) fields['PlanStep.targets'] = text(targets.join('\n'));
  }
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
  /** A swap step with a spare reserved for it (ADR-0076): where the part that comes out goes. Left out, it is
   * retired, so it is never counted as a spare nobody checked; the Inventory moves it on. */
  oldPartTo?: OldPartTo;
}

/** Applies the step's edit through the normal command, then marks it done: one undo step. A swap step with a
 * spare reserved for it fits that spare from stock, so the spare leaves stock and the old part goes in. */
export function markDone(doc: Document, stepId: string, opts: MarkDoneOptions): Document {
  const { plan, step } = requireTurn(doc, stepId);
  if (step.edit) {
    assertEditable(step.edit);
    const refused = opts.check(step.edit);
    if (refused) throw new PlanRefusal('refused-by-check', refused.title);
  }
  const from = doc.batches.length;
  const now = opts.now ?? Date.now();
  const spare = step.edit?.t === 'part' ? reservedFor(doc, stepId) : null;
  const applied =
    spare && step.edit?.t === 'part'
      ? swapFromStock(doc, step.edit.id, spare.id, { actor: opts.actor, now, oldTo: opts.oldPartTo ?? 'retired' })
      : step.edit
        ? applyEdit(doc, step.edit, { actor: opts.actor, now })
        : doc;
  const b = begin(applied, { actor: opts.actor, now });
  setNodeField(b, stepId, 'PlanStep.state', token('done'));
  setNodeField(b, stepId, 'PlanStep.done_at', text(new Date(now).toISOString()));
  return relabelLast(finish(b, 'mark step'), from, truncateUtf8(`${plan.title}: step ${step.ordinal + 1} done`));
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
  return finish(b, truncateUtf8(`${plan.title}: step ${step.ordinal + 1} went differently`));
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
  return finish(b, truncateUtf8(`${plan.title}: recorded as ${opts.outcome}`));
}

// ---------------------------------------------------------------------------
// Backing out (sign-off r16-backout). A plan that went wrong is not rewound in place: Back out writes a new,
// separate plan from where the design is now back to where it started, so the way back can hold steps of its own.
// It starts as the reverse of every step done, newest first; a step that went differently becomes a step to check.

/** What a backed-out plan's own remaining steps are marked, and the words its record starts with. */
export const BACKED_OUT_NOTE = 'Not done: the plan was backed out';

const BACK_OUT_TITLE = 'Back out: ';

export interface ReverseStep {
  kind: StepKind;
  change: string;
  before: string;
  after: string;
  edit?: StepEdit;
  targets?: string[];
}

/** The live cable between two ports, or null. */
function liveCableBetween(doc: Document, a: string, b: string): string | null {
  for (const t of edgesIn(doc, a, 'Terminates')) {
    const c = findNode(doc, t.from);
    if (c && c.absentSince === undefined && edgesOut(doc, t.from, 'Terminates').some((u) => u.to === b)) return t.from;
  }
  return null;
}

/** Every end a cable ever had, removed or not: a cut cable's ends are tombstoned with it. */
function everEnds(doc: Document, cableId: string): string[] {
  return doc.edges.filter((x) => x.from === cableId && parseEdgeId(x.id).kind === 'Terminates').map((x) => x.to);
}

const liveNode = (doc: Document, id: string): boolean => {
  const n = findNode(doc, id);
  return n !== undefined && n.absentSince === undefined;
};

/** The value a field held before its latest change, as an edit value ('' = it had none). */
function priorValue(doc: Document, id: string, key: string): string {
  const h = doc.history.find((r) => r.element === id && r.field === key);
  const last = h?.entries[h.entries.length - 1];
  if (!last || last.presence !== 'set') return '';
  const v = last.value;
  return typeof v === 'number' ? String(v) : (asString(v) ?? '');
}

/** The model and serial a part had before its latest swap, or null when nothing is known of it. */
function priorPart(doc: Document, id: string): { model: string; serial: string } | null {
  const kind = nodeKindOf(id);
  if (!liveNode(doc, id)) return null;
  if (kind === 'Card' || kind === 'PowerSupply') {
    const serial = priorValue(doc, id, `${kind}.serial`);
    const model = priorValue(doc, id, `${kind}.model`);
    return serial === '' && model === '' ? null : { model, serial };
  }
  const h = doc.history.find((r) => r.element === id && r.field === 'PhysicalPort.transceiver');
  const last = h?.entries[h.entries.length - 1];
  const v = last?.presence === 'set' ? last.value : undefined;
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const s = (x: unknown): string => (typeof x === 'string' ? x : '');
  return s(o.serial) === '' && s(o.part) === '' ? null : { model: s(o.part), serial: s(o.serial) };
}

/** The reverse of one marked step, read against the design as it is now. */
export function reverseOf(doc: Document, step: PlanStep): ReverseStep {
  const n = step.ordinal + 1;
  const words = firstLineOf(step.change);
  if (step.state === 'went_differently') {
    return { kind: 'other', change: `Check step ${n}, it went differently: ${words}`, before: step.note, after: step.before, targets: step.targets.filter((t) => liveNode(doc, t)) };
  }
  const by = (edit: StepEdit): ReverseStep => ({ kind: step.kind, change: `Undo step ${n}: ${words}`, before: step.after, after: step.before, edit });
  const byHand = (what: string): ReverseStep => ({
    kind: 'other',
    change: `Undo step ${n}: ${what}`,
    before: step.after,
    after: step.before,
    targets: step.targets.filter((t) => liveNode(doc, t)),
  });
  const e = step.edit;
  if (e === null) return byHand(words);
  switch (e.t) {
    case 'cable': {
      const cable = liveCableBetween(doc, e.a, e.b);
      return cable ? by({ t: 'cut', cable }) : byHand(`${words} (the cable is no longer in the design)`);
    }
    case 'cut': {
      const ends = everEnds(doc, e.cable);
      return ends.length === 2 && ends.every((p) => liveNode(doc, p)) ? by({ t: 'cable', a: ends[0], b: ends[1] }) : byHand(words);
    }
    case 'move': {
      // Where it stood before: its newest removed rack placement, if the move took it out of a rack.
      const prior = doc.edges
        .filter((x) => x.from === e.chassis && x.absentSince !== undefined && parseEdgeId(x.id).kind === 'MountedIn')
        .sort((x, y) => (y.absentSince ?? 0) - (x.absentSince ?? 0))[0];
      const f = prior ? readMountedInFields(prior) : null;
      return prior && f?.positionU != null && liveNode(doc, prior.to)
        ? by({ t: 'move', chassis: e.chassis, rack: prior.to, positionU: f.positionU, face: f.face === 'rear' ? 'rear' : 'front' })
        : byHand(words);
    }
    case 'field':
      return by({ ...e, value: priorValue(doc, e.id, e.key) });
    case 'lag': {
      const ae = edgesOut(doc, e.device, 'HasInterface').find(
        (h) => parseNodeId(h.to).kind === 'AggregateInterface' && liveNode(doc, h.to) && asString(fieldValue(findNode(doc, h.to)!.fields, 'AggregateInterface.name')) === e.name,
      );
      return ae ? by({ t: 'unlag', lag: ae.to }) : byHand(words);
    }
    case 'part': {
      const was = priorPart(doc, e.id);
      return was !== null ? by({ t: 'part', id: e.id, ...was }) : byHand(words);
    }
    case 'unlag': {
      const ae = findNode(doc, e.lag);
      const was = (kind: string) => doc.edges.filter((x) => x.to === e.lag && parseEdgeId(x.id).kind === kind);
      const device = was('HasInterface')[0]?.from;
      const members = was('MemberOfAggregate').map((x) => x.from).filter((m) => liveNode(doc, m));
      const name = ae ? asString(fieldValue(ae.fields, 'AggregateInterface.name')) : undefined;
      const lacp = ae ? (asString(fieldValue(ae.fields, 'AggregateInterface.lacp_mode')) ?? '') : '';
      return device && name && members.length >= 2 && (LACP_MODES as readonly string[]).includes(lacp)
        ? by({ t: 'lag', device, name, lacp: lacp as LacpMode, members })
        : byHand(words);
    }
  }
}

function firstLineOf(s: string): string {
  return s.split('\n')[0];
}

/** The way back, newest step first: what Back out pre-fills. */
export function backOutSteps(doc: Document, plan: Plan): ReverseStep[] {
  return plan.steps
    .filter((s) => s.state !== 'planned' && !(s.state === 'went_differently' && s.note === BACKED_OUT_NOTE))
    .sort((a, b) => b.ordinal - a.ordinal)
    .map((s) => reverseOf(doc, s));
}

/**
 * Backs a plan out. While the work is going, the plan stops: its remaining steps are marked as not done and it is
 * recorded as failed, saying where the way back is. A plan already recorded is left as written. Either way a new
 * plan is made, still being planned, holding the reverse steps: it can be changed, added to and reordered before
 * anyone starts it. One batch; the recording in it cannot be undone, as no recording can.
 */
export function backOut(doc: Document, planId: string, opts: Actor & { author?: string }): { doc: Document; id: string } {
  const plan = readPlan(doc, planId);
  if (plan.stage === 'planned') throw new PlanRefusal('not-doing', 'nothing has been done yet; change the plan instead');
  const steps = backOutSteps(doc, plan);
  if (steps.length === 0) throw new PlanRefusal('no-steps', 'no step has been marked, so there is nothing to back out');
  const from = doc.batches.length;
  const now = opts.now ?? Date.now();
  const at = { actor: opts.actor, now };
  const title = truncateUtf8(`${BACK_OUT_TITLE}${plan.title}`, 200);
  let next = doc;
  if (plan.stage === 'doing') {
    const b = begin(next, at);
    for (const s of plan.steps.filter((x) => x.state === 'planned')) {
      setNodeField(b, s.id, 'PlanStep.state', token('went_differently'));
      setNodeField(b, s.id, 'PlanStep.note', text(BACKED_OUT_NOTE));
      setNodeField(b, s.id, 'PlanStep.done_at', text(new Date(now).toISOString()));
    }
    setNodeField(b, planId, 'MaintenancePlan.stage', token('recorded'));
    setNodeField(b, planId, 'MaintenancePlan.outcome', token('failed'));
    const record = plan.record.trim() === '' ? '' : `${plan.record.trim()}\n`;
    setNodeField(b, planId, 'MaintenancePlan.record', text(`${record}Backed out. The way back is the plan "${title}".`));
    next = finish(b, 'back out');
  }
  const made = createPlan(next, { title, gate: TYPED_AS_WRITTEN, ...(opts.author ? { author: opts.author } : {}), ...at });
  next = made.doc;
  for (const s of steps) next = addStep(next, made.id, { ...s, gate: TYPED_AS_WRITTEN, ...at }).doc;
  return { doc: relabelLast(next, from, truncateUtf8(`${plan.title}: backed out`)), id: made.id };
}

/** An AI idea as the plan needs it (ADR-0072 decision 7): what the AI app sent, already screened by the server. */
export interface IdeaForPlan {
  title: string;
  steps: readonly { action: string; text: string; target: string | null }[];
}

/** What sort of plan step an idea's step becomes. The AI never chooses an edit; a person adds one. */
const IDEA_STEP_KIND: Readonly<Record<string, StepKind>> = { connect: 'cable', move: 'move' };

/**
 * A draft plan made from an AI idea, one undo step. The AI's words are text nobody typed here, so every one goes
 * through `gate` (the caller passes the real redaction gate). No step carries an edit: the plan changes nothing until
 * a person adds the edits and marks steps done, as with any plan. A target no longer in the design is left off.
 */
export function planFromIdea(doc: Document, idea: IdeaForPlan, opts: Actor & { gate: TextGate; author?: string }): { doc: Document; id: string } {
  const from = doc.batches.length;
  const title = truncateUtf8(idea.title, 200);
  const made = createPlan(doc, { title, gate: opts.gate, ...(opts.author ? { author: opts.author } : {}), actor: opts.actor, now: opts.now });
  let next = made.doc;
  for (const step of idea.steps) {
    if (step.text.trim() === '') continue;
    const node = step.target !== null && nodeKindOf(step.target) !== null ? findNode(next, step.target) : undefined;
    const live = node !== undefined && node.absentSince === undefined;
    next = addStep(next, made.id, {
      kind: IDEA_STEP_KIND[step.action] ?? 'other',
      change: step.text,
      ...(live ? { targets: [step.target as string] } : {}),
      gate: opts.gate,
      actor: opts.actor,
      now: opts.now,
    }).doc;
  }
  return { doc: relabelLast(next, from, truncateUtf8(`AI idea planned: ${title}`)), id: made.id };
}

/** Unknown ids in a plan's steps, for the list view to flag: a thing deleted since planning. */
export function missingTargets(doc: Document, plan: Plan): string[] {
  return touchedBy(plan).filter((id) => {
    const n = findNode(doc, id);
    return !n || n.absentSince !== undefined;
  });
}

export { UnknownReferenceError };
