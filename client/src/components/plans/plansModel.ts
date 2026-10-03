// Pure helpers for the plan surface (ADR-0061 round 7): words, marks, the add-step form, names. No React.
import type { Canon } from '../checks/checksModel';
import { UNNAMED_HOSTNAME } from '../drawing/contract';
import { compatible } from '../../document/compat';
import {
  asString,
  edgesOut,
  fieldValue,
  findNode,
  parseNodeId,
  readMountedInFields,
  readPhysicalPortFields,
  type Document,
  type GraphNode,
} from '../../document/model';
import {
  currentStep,
  touchedBy,
  type Plan,
  type PlanStage,
  type PlanStep,
  type StepCheck,
  type StepEdit,
  type StepKind,
} from '../../document/plans';
import type { CheckFinding } from '../../engine/engine';
import type { PlanMark } from './plansStore';

/** The band's List view button: where focus lands when the list page closes. */
export const LIST_TOGGLE_ID = 'plans-list-toggle';

/** Makes everything beside `page` inert (nothing under a covering page can be focused or clicked); returns the undo. */
export function holdSiblings(page: { parentElement: { children: ArrayLike<Element> } | null }): () => void {
  const held = Array.from(page.parentElement?.children ?? []).filter((el) => (el as unknown) !== page && !el.hasAttribute('inert'));
  held.forEach((el) => el.setAttribute('inert', ''));
  return () => held.forEach((el) => el.removeAttribute('inert'));
}

export const STAGE_WORD: Record<PlanStage, string> = { planned: 'PLANNING', doing: 'DOING', recorded: 'RECORDED' };

export const KIND_WORD: Record<StepKind, string> = { address: 'Address', route: 'Route', cable: 'Cable', move: 'Move', other: 'Other' };

export const OUTCOME_WORD = { succeeded: 'Succeeded', partial: 'Partial', failed: 'Failed' } as const;

/** The tag on a mark: PLANNED, STEP n, ✓ DONE, ≠ WENT DIFFERENTLY. */
export function stepWord(plan: Pick<Plan, 'stage'>, step: PlanStep, current: PlanStep | null): string {
  if (step.state === 'done') return '✓ DONE';
  if (step.state === 'went_differently') return '≠ WENT DIFFERENTLY';
  return plan.stage === 'doing' && current?.id === step.id ? `STEP ${step.ordinal + 1}` : 'PLANNED';
}

/** The state column and checklist glyph for a step. */
export function stateText(step: PlanStep, current: PlanStep | null): string {
  if (step.state === 'done') return '✓ Done';
  if (step.state === 'went_differently') return '≠ Went differently';
  return current?.id === step.id ? '● Under way' : 'Planned';
}

/** A step's heading: the kind as a badge, unless the change text already opens with it ("Move X", "Cable Y"). */
export function stepHead(step: Pick<PlanStep, 'kind' | 'change'>): { badge: string | null; text: string } {
  const word = KIND_WORD[step.kind];
  const opens = step.change.toLowerCase().startsWith(word.toLowerCase()) && !/^[\p{L}\p{N}]/u.test(step.change.charAt(word.length));
  return { badge: opens ? null : word, text: step.change };
}

/** The live cable that joins two ports, if the design has one. */
function cableBetween(doc: Document, a: string, b: string): string | null {
  for (const n of doc.nodes) {
    if (n.absentSince !== undefined || parseNodeId(n.id).kind !== 'Cable') continue;
    const ends = edgesOut(doc, n.id, 'Terminates').map((e) => e.to);
    if (ends.includes(a) && ends.includes(b)) return n.id;
  }
  return null;
}

function markFor(step: PlanStep, canon: Canon, word: string, doc?: Document | null): PlanMark | null {
  const e = step.edit;
  const base = { stepId: step.id, ordinal: step.ordinal, word };
  if (e?.t === 'cable') {
    const devices = [...new Set([canon(e.a), canon(e.b)])];
    // Went differently: no cable was made, so only a tag on the devices. Done: the real cable carries the mark.
    if (step.state === 'went_differently') return { ...base, kind: 'touch', keys: devices };
    if (step.state === 'done') {
      const cable = doc ? cableBetween(doc, e.a, e.b) : null;
      return { ...base, kind: 'touch', keys: cable ? [cable, ...devices] : devices };
    }
    return { ...base, kind: 'add-cable', keys: [canon(e.a), canon(e.b)], ends: [e.a, e.b] };
  }
  if (e?.t === 'cut') return { ...base, kind: 'cut-cable', keys: [e.cable] };
  const keys = [...new Set(step.targets.map(canon))];
  return keys.length === 0 ? null : { ...base, kind: 'touch', keys };
}

/** The marks the canvas draws: every step while planning or doing; none once recorded (Show these changes asks). */
export function buildMarks(plan: Plan, canon: Canon, doc?: Document | null): PlanMark[] {
  if (plan.stage === 'recorded') return [];
  const current = currentStep(plan);
  return plan.steps.flatMap((s) => markFor(s, canon, stepWord(plan, s, current), doc) ?? []);
}

/** What a recorded plan changed: the steps that happened, as marks. */
export function changedMarks(plan: Plan, canon: Canon, doc?: Document | null): PlanMark[] {
  return plan.steps.filter((s) => s.state !== 'planned').flatMap((s) => markFor(s, canon, stepWord(plan, s, null), doc) ?? []);
}

/** Keys kept at full strength: Do's current step, Record's changes when asked; null fades nothing. */
export function focusKeys(plan: Plan, canon: Canon, showChanges: boolean, doc?: Document | null): ReadonlySet<string> | null {
  let marks: PlanMark[] = [];
  if (plan.stage === 'doing') {
    const cur = currentStep(plan);
    const mark = cur ? markFor(cur, canon, '') : null;
    marks = mark ? [mark] : [];
  } else if (plan.stage === 'recorded' && showChanges) {
    marks = changedMarks(plan, canon, doc);
  }
  const keys = new Set(marks.flatMap((m) => m.keys));
  return keys.size === 0 ? null : keys;
}

export function progress(plan: Plan): { total: number; done: number; differently: number; at: number } {
  const done = plan.steps.filter((s) => s.state === 'done').length;
  const differently = plan.steps.filter((s) => s.state === 'went_differently').length;
  const cur = currentStep(plan);
  return { total: plan.steps.length, done, differently, at: cur ? cur.ordinal + 1 : plan.steps.length };
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number): string => String(n).padStart(2, '0');

/** "Sat 4 Oct 02:00–04:00"; what was typed when it does not read as a date. */
export function windowText(start: string, end: string): string {
  const s = start === '' ? null : new Date(start);
  const e = end === '' ? null : new Date(end);
  const ok = (d: Date | null): d is Date => d != null && !Number.isNaN(d.getTime());
  if (!ok(s)) return ok(e) ? `until ${fmt(e)}` : [start, end].filter((x) => x !== '').join(' – ');
  const day = `${DAYS[s.getDay()]} ${s.getDate()} ${MONTHS[s.getMonth()]}`;
  const clock = (d: Date): string => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (!ok(e)) return `${day} ${clock(s)}`;
  return s.toDateString() === e.toDateString() ? `${day} ${clock(s)}–${clock(e)}` : `${day} ${clock(s)} – ${fmt(e)}`;
}
function fmt(d: Date): string {
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The band's sentence after the title. */
export function bandSentence(plan: Plan, doc?: Document | null, canon?: Canon): string {
  const p = progress(plan);
  if (plan.stage === 'planned') {
    const win = windowText(plan.windowStart, plan.windowEnd);
    return [win, plural(p.total, 'change', 'changes')].filter((x) => x !== '').join(' · ');
  }
  if (plan.stage === 'doing') {
    const bits = [p.done > 0 ? `${p.done} done` : '', p.differently > 0 ? `${p.differently} went differently` : ''].filter((x) => x !== '');
    const head = p.total > 0 && p.at <= p.total && currentStep(plan) ? `Step ${p.at} of ${p.total}` : `${p.total} of ${p.total} marked`;
    return [head, ...bits].join(' · ');
  }
  const outcome = plan.outcome ? OUTCOME_WORD[plan.outcome] : 'Recorded';
  const n = doc && canon ? touchedDevices(doc, canon, plan).length : touchedBy(plan).length;
  return n === 0 ? outcome : `${outcome} · on ${n} ${n === 1 ? "device's" : "devices'"} history`;
}

/** "3 of 4 as planned, 1 went differently." */
export function outcomeSentence(plan: Plan): string {
  const p = progress(plan);
  const asPlanned = `${p.done} of ${p.total} as planned`;
  return p.differently > 0 ? `${asPlanned}, ${p.differently} went differently.` : `${asPlanned}.`;
}

// ---------------------------------------------------------------------------
// Names

const field = (n: GraphNode | undefined, key: string): string => (n ? (asString(fieldValue(n.fields, key)) ?? '') : '');

/** What a person calls a thing: a device's hostname, a port as "device · label", a rack's label. */
export function nameOf(doc: Document, canon: Canon, id: string): string {
  const node = findNode(doc, id);
  if (!node || node.absentSince !== undefined) return id.includes(':') ? id.split(':')[0] : id;
  switch (parseNodeId(id).kind) {
    case 'Device':
      return field(node, 'Device.hostname') || UNNAMED_HOSTNAME;
    case 'Chassis': {
      const dev = canon(id);
      return dev !== id ? nameOf(doc, canon, dev) : field(node, 'Chassis.model') || 'chassis';
    }
    case 'PhysicalPort': {
      const dev = canon(id);
      const label = field(node, 'PhysicalPort.label') || 'port';
      return dev !== id ? `${nameOf(doc, canon, dev)} · ${label}` : label;
    }
    case 'Cable': {
      const label = field(node, 'Cable.label');
      if (label !== '') return label;
      const ends = edgesOut(doc, id, 'Terminates').map((e) => nameOf(doc, canon, e.to));
      return ends.length > 0 ? ends.join(' ↔ ') : 'cable';
    }
    case 'Rack':
      return field(node, 'Rack.label') || 'rack';
    case 'PassiveNode':
      return field(node, 'PassiveNode.label') || 'passive';
    default:
      return id;
  }
}

const kindOf = (id: string): string => {
  try {
    return parseNodeId(id).kind;
  } catch {
    return '';
  }
};

/** The devices a plan touched, once each: ports and chassis resolve to their device, a cable to the devices it
 * joined; racks and anything else are dropped. */
export function touchedDevices(doc: Document, canon: Canon, plan: Plan): Choice[] {
  const out = new Map<string, Choice>();
  const add = (id: string): void => {
    const dev = canon(id);
    if (out.has(dev) || findNode(doc, dev) === undefined || kindOf(dev) !== 'Device') return;
    out.set(dev, { id: dev, name: nameOf(doc, canon, dev) });
  };
  for (const id of touchedBy(plan)) {
    if (kindOf(id) === 'Cable') edgesOut(doc, id, 'Terminates').forEach((e) => add(e.to));
    else add(id);
  }
  return [...out.values()];
}

export interface Choice {
  id: string;
  name: string;
}

function liveOfKind(doc: Document, kind: string): GraphNode[] {
  return doc.nodes.filter((n) => n.absentSince === undefined && parseNodeId(n.id).kind === kind);
}

const byName = (a: Choice, b: Choice): number => a.name.localeCompare(b.name, undefined, { numeric: true });

export function devicesOf(doc: Document, canon: Canon): Choice[] {
  return liveOfKind(doc, 'Device').map((n) => ({ id: n.id, name: nameOf(doc, canon, n.id) })).sort(byName);
}

export function racksOf(doc: Document, canon: Canon): Choice[] {
  return liveOfKind(doc, 'Rack').map((n) => ({ id: n.id, name: nameOf(doc, canon, n.id) })).sort(byName);
}

export function cablesOf(doc: Document, canon: Canon): Choice[] {
  return liveOfKind(doc, 'Cable').map((n) => ({ id: n.id, name: nameOf(doc, canon, n.id) })).sort(byName);
}

/** The chassis of one device, for a Move step. */
export function chassisOfDevice(doc: Document, canon: Canon, deviceId: string): Choice[] {
  return liveOfKind(doc, 'Chassis')
    .filter((n) => canon(n.id) === deviceId)
    .map((n) => ({ id: n.id, name: nameOf(doc, canon, n.id) }));
}

/** The ports on one device (the device is already chosen). Labels that repeat get their face, then a count, so
 * two "1"s are never the same words. */
export function portsOfDevice(doc: Document, canon: Canon, deviceId: string): Choice[] {
  const ports = liveOfKind(doc, 'PhysicalPort')
    .filter((n) => canon(n.id) === deviceId)
    .map((n) => ({ id: n.id, label: field(n, 'PhysicalPort.label') || 'port', face: readPhysicalPortFields(n).face ?? '' }));
  const count = (names: string[]): Map<string, number> => names.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>());
  const labels = count(ports.map((p) => p.label));
  const withFace = ports.map((p) => ({ ...p, name: (labels.get(p.label) ?? 0) > 1 && p.face !== '' ? `${p.label} (${p.face})` : p.label }));
  const names = count(withFace.map((p) => p.name));
  const seen = new Map<string, number>();
  return withFace
    .map((p) => {
      if ((names.get(p.name) ?? 0) < 2) return { id: p.id, name: p.name };
      const n = (seen.get(p.name) ?? 0) + 1;
      seen.set(p.name, n);
      return { id: p.id, name: `${p.name} #${n}` };
    })
    .sort(byName);
}

/** Where a chassis is mounted now, as words; empty when it is not in a rack. */
export function placementText(doc: Document, canon: Canon, chassisId: string): string {
  const m = edgesOut(doc, chassisId, 'MountedIn')[0];
  if (!m) return '';
  const f = readMountedInFields(m);
  return `${nameOf(doc, canon, m.to)}${f.positionU != null ? ` · U${f.positionU}` : ''}`;
}

// ---------------------------------------------------------------------------
// The add-step form

export interface StepForm {
  kind: StepKind;
  change: string;
  before: string;
  after: string;
  /** address, route, other: the device; move: the device whose chassis moves. */
  device: string;
  /** cable: connect two ports, or cut one cable. */
  cableMode: 'connect' | 'cut';
  deviceB: string;
  portA: string;
  portB: string;
  cable: string;
  rack: string;
  positionU: string;
  face: 'front' | 'rear';
  value: string;
}

export const EMPTY_FORM: StepForm = {
  kind: 'address',
  change: '',
  before: '',
  after: '',
  device: '',
  cableMode: 'connect',
  deviceB: '',
  portA: '',
  portB: '',
  cable: '',
  rack: '',
  positionU: '1',
  face: 'front',
  value: '',
};

export interface BuiltStep {
  kind: StepKind;
  change: string;
  before: string;
  after: string;
  edit?: StepEdit;
  targets?: string[];
}

/** The step a form describes, or the sentence saying what is missing. */
export function buildStep(doc: Document, canon: Canon, f: StepForm): BuiltStep | { error: string } {
  const text = (s: string): string => s.trim();
  const name = (id: string): string => nameOf(doc, canon, id);
  switch (f.kind) {
    case 'address': {
      if (f.device === '') return { error: 'Choose the device.' };
      if (text(f.value) === '') return { error: 'Type the new address.' };
      const node = findNode(doc, f.device);
      const now = field(node, 'Device.management_address');
      return {
        kind: 'address',
        change: text(f.change) || `Management address on ${name(f.device)}`,
        before: text(f.before) || now,
        after: text(f.value),
        edit: { t: 'field', id: f.device, key: 'Device.management_address', value: text(f.value) },
      };
    }
    case 'cable': {
      if (f.cableMode === 'cut') {
        if (f.cable === '') return { error: 'Choose the cable to remove.' };
        return { kind: 'cable', change: text(f.change) || `Remove ${name(f.cable)}`, before: text(f.before) || name(f.cable), after: text(f.after), edit: { t: 'cut', cable: f.cable } };
      }
      if (f.portA === '' || f.portB === '') return { error: 'Choose both ports.' };
      if (f.portA === f.portB) return { error: 'A cable needs two different ports.' };
      return {
        kind: 'cable',
        change: text(f.change) || `${name(f.portA)} → ${name(f.portB)}`,
        before: text(f.before),
        after: text(f.after) || `${name(f.portA)} ↔ ${name(f.portB)}`,
        edit: { t: 'cable', a: f.portA, b: f.portB },
      };
    }
    case 'move': {
      const chassis = f.device === '' ? '' : (chassisOfDevice(doc, canon, f.device)[0]?.id ?? '');
      if (chassis === '') return { error: 'Choose a device that has a chassis.' };
      if (f.rack === '') return { error: 'Choose the rack.' };
      const u = Number(f.positionU);
      if (!Number.isInteger(u) || u < 1) return { error: 'Give the rack unit as a whole number from 1.' };
      return {
        kind: 'move',
        change: text(f.change) || `${name(f.device)} to ${name(f.rack)}`,
        before: text(f.before) || placementText(doc, canon, chassis),
        after: text(f.after) || `${name(f.rack)} · U${u}`,
        edit: { t: 'move', chassis, rack: f.rack, positionU: u, face: f.face },
      };
    }
    case 'route':
    case 'other': {
      if (text(f.change) === '') return { error: 'Say what changes.' };
      return {
        kind: f.kind,
        change: text(f.change),
        before: text(f.before),
        after: text(f.after),
        ...(f.device !== '' ? { targets: [f.device] } : {}),
      };
    }
  }
}

/** What the "Plan a change" right-click on a thing starts: the right kind of step, the thing filled in. */
export function prefillFor(doc: Document, canon: Canon, elementId: string): Partial<StepForm> | null {
  const node = findNode(doc, elementId);
  if (!node || node.absentSince !== undefined) return null;
  const dev = canon(elementId);
  switch (parseNodeId(elementId).kind) {
    case 'Device':
      return { kind: 'address', device: elementId };
    case 'Chassis':
      return { kind: 'move', device: dev !== elementId ? dev : '' };
    case 'PhysicalPort':
      return { kind: 'cable', cableMode: 'connect', device: dev !== elementId ? dev : '', portA: elementId };
    case 'Cable':
      return { kind: 'cable', cableMode: 'cut', cable: elementId };
    default:
      return { kind: 'other' };
  }
}

/** A plan's first title when it is made from a right-click. */
export function titleFor(doc: Document, canon: Canon, elementId: string): string {
  return `Change to ${nameOf(doc, canon, elementId)}`;
}

// ---------------------------------------------------------------------------
// Checks before Done

/** The media each end's connector could take, as the canvas guesses it for a cable it may refuse
 * (`mediaCandidates`): the pair's own when they fit, else each end's natural lead. */
export function mediaCandidatesFor(doc: Document, a: string, b: string): string[] {
  const connector = (id: string): string | null => {
    const n = findNode(doc, id);
    return n ? (readPhysicalPortFields(n).connector ?? '') : null;
  };
  const from = connector(a);
  const to = connector(b);
  if (from == null || to == null) return [''];
  const pair = compatible(from, to);
  if (pair.ok) return [pair.media];
  const natural = (c: string): string | null => {
    const probe = compatible(c, c);
    return probe.ok && probe.media !== 'power' ? probe.media : null;
  };
  const found = [natural(from), natural(to)].filter((m): m is string => m != null);
  return found.length > 0 ? [...new Set(found)] : [''];
}

interface Gestures {
  checkCable(near: { port: string }, far: { port: string }, media?: string): CheckFinding[];
  checkFieldEdit(key: number, displayId: string, value: string): CheckFinding[];
}

/** The first refusal the step's edit would meet, or null. Fails open: the checks never block on an error. */
export function refusalFor(
  mirror: Gestures | null,
  edit: StepEdit,
  fieldKey: (name: string) => number | undefined,
  doc?: Document | null,
): CheckFinding | null {
  if (mirror == null) return null;
  try {
    let found: CheckFinding[] = [];
    if (edit.t === 'cable') {
      // The media comes from the ports' connectors, as the canvas's own cable gesture does.
      for (const media of doc ? mediaCandidatesFor(doc, edit.a, edit.b) : ['']) {
        found = mirror.checkCable({ port: edit.a }, { port: edit.b }, media);
        if (found.some((f) => f.severity === 'refuse')) break;
      }
    } else if (edit.t === 'field') {
      const key = fieldKey(edit.key);
      if (key !== undefined) found = mirror.checkFieldEdit(key, edit.id, edit.value);
    }
    return found.find((f) => f.severity === 'refuse') ?? null;
  } catch {
    return null;
  }
}

/** A `StepCheck` that also keeps the whole finding for the Why card. */
export function stepCheck(
  mirror: Gestures | null,
  fieldKey: (name: string) => number | undefined,
  keep: (f: CheckFinding) => void,
  doc?: Document | null,
): StepCheck {
  return (edit) => {
    const hit = refusalFor(mirror, edit, fieldKey, doc);
    if (hit == null) return null;
    keep(hit);
    return { title: hit.title };
  };
}

/** Whether a step's buttons are live: only the current step of a plan being done, by someone who can edit. */
export function stepIsLive(plan: Plan, step: PlanStep, canEdit: boolean): boolean {
  return canEdit && plan.stage === 'doing' && currentStep(plan)?.id === step.id;
}

/** Esc closes the topmost of: the Why card, the changes shown. */
export function planEscTarget(open: { why: boolean; changes: boolean; notice: boolean }): 'why' | 'changes' | 'notice' | null {
  if (open.why) return 'why';
  if (open.notice) return 'notice';
  if (open.changes) return 'changes';
  return null;
}
