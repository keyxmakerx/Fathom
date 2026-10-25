// Guided lessons (ADR-0066 item 1.3, round 10 lessons B). A lesson is data in `corpus/lessons/`, run in its own copy
// of a sample network. Every step is checked here from the design, the selection, a trace or Checks; nobody marks one
// by hand. Steps name things the way a person does (hostnames, `hostname:label`); this module finds them in the design.
import { asString, edgesIn, edgesOut, fieldValue, findNode, parseNodeId, readPhysicalPortFields, type Document } from '../../document/model';
import type { ChecksResult, TraceResult } from '../../engine/engine';
import { parseFlow } from '../trace/traceModel';

export interface LessonSource {
  claim: string;
  cite: string;
  url: string;
  read_on: string;
}

export type TraceExpect = { reaches: true; crosses: string[] } | { reaches: false; stopsAt: string } | { firstMatch: string };

export type LessonStep =
  | { kind: 'read'; title: string; body: string; explainer?: string }
  | { kind: 'click'; title: string; prompt: string; answer: { device: string } | { cable: string }; hint: string; after: string }
  | {
      kind: 'trace';
      title: string;
      prompt: string;
      from: { device: string } | { port: string };
      to: { device: string };
      flow?: string;
      expect: TraceExpect;
      after: string;
    }
  | { kind: 'change'; title: string; prompt: string; expect: { rule: string; now: 'fires' | 'clears' }; after: string };

export interface Lesson {
  id: string;
  title: string;
  summary: string;
  sample: string;
  sources: LessonSource[];
  steps: LessonStep[];
}

const lessonFiles = import.meta.glob('../../../../corpus/lessons/*.json', { eager: true, query: '?raw', import: 'default' }) as Record<string, string>;

/** The order the list shows them in: the basics first. */
const ORDER = ['vlans', 'single-points-of-failure', 'firewall-policy-order'];

export function lessons(): Lesson[] {
  const all = Object.values(lessonFiles).map((text) => JSON.parse(text) as Lesson);
  const rank = (l: Lesson) => (ORDER.includes(l.id) ? ORDER.indexOf(l.id) : ORDER.length);
  return all.sort((a, b) => rank(a) - rank(b) || a.title.localeCompare(b.title));
}

export function lesson(id: string): Lesson | null {
  return lessons().find((l) => l.id === id) ?? null;
}

export const KIND_WORDS: Readonly<Record<LessonStep['kind'], string>> = {
  read: 'Read',
  click: 'Click the answer',
  trace: 'Trace',
  change: 'Change it and watch',
};

// ---------------------------------------------------------------------------
// Finding things by the names a lesson uses

const live = (doc: Document, id: string) => {
  const n = findNode(doc, id);
  return n != null && n.absentSince === undefined ? n : undefined;
};

/** The live Device with this hostname; null when there is none, or several. */
export function deviceByHostname(doc: Document, hostname: string): string | null {
  const found = doc.nodes.filter(
    (n) => n.absentSince === undefined && parseNodeId(n.id).kind === 'Device' && asString(fieldValue(n.fields, 'Device.hostname')) === hostname,
  );
  return found.length === 1 ? found[0]!.id : null;
}

function chassisOf(doc: Document, deviceId: string): string[] {
  return edgesOut(doc, deviceId, 'HasChassis')
    .filter((e) => e.absentSince === undefined && live(doc, e.to) !== undefined)
    .map((e) => e.to);
}

/** `hostname:label` to the PhysicalPort; null when it is not in the design. */
export function portByRef(doc: Document, ref: string): string | null {
  const i = ref.lastIndexOf(':');
  const deviceId = i > 0 ? deviceByHostname(doc, ref.slice(0, i)) : null;
  if (deviceId == null) return null;
  const label = ref.slice(i + 1);
  for (const chassisId of chassisOf(doc, deviceId)) {
    for (const e of edgesOut(doc, chassisId, 'HasPort')) {
      const p = e.absentSince === undefined ? live(doc, e.to) : undefined;
      if (p != null && readPhysicalPortFields(p).label === label && readPhysicalPortFields(p).service !== 'power') return p.id;
    }
  }
  return null;
}

/** The live cable on a port, or null. */
export function cableOnPort(doc: Document, portId: string): string | null {
  for (const e of edgesIn(doc, portId, 'Terminates')) {
    if (e.absentSince === undefined && live(doc, e.from) !== undefined) return e.from;
  }
  return null;
}

/** What a canvas selection points at, as a lesson names things: a Device, or a cable. */
export function selected(doc: Document, id: string): { device: string } | { cable: string } | null {
  const node = live(doc, id);
  if (node == null) return null;
  const kind = parseNodeId(id).kind;
  if (kind === 'Device') return { device: id };
  if (kind === 'Cable') return { cable: id };
  if (kind === 'Chassis') {
    const owner = edgesIn(doc, id, 'HasChassis').find((e) => e.absentSince === undefined);
    return owner != null ? { device: owner.from } : null;
  }
  if (kind === 'PhysicalPort') {
    const chassis = edgesIn(doc, id, 'HasPort').find((e) => e.absentSince === undefined);
    return chassis != null ? selected(doc, chassis.from) : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Checking a step

export type StepCheck = { state: 'waiting' } | { state: 'passed' } | { state: 'wrong'; detail: string } | { state: 'broken'; detail: string };

/** A click step against what is selected now. `selectedId` is the canvas's selection key. */
export function checkClick(doc: Document, step: Extract<LessonStep, { kind: 'click' }>, selectedId: string | null): StepCheck {
  if (selectedId == null) return { state: 'waiting' };
  const want =
    'device' in step.answer
      ? deviceByHostname(doc, step.answer.device)
      : (() => {
          const port = portByRef(doc, step.answer.cable);
          return port == null ? null : cableOnPort(doc, port);
        })();
  if (want == null) return { state: 'broken', detail: 'The answer is no longer in this copy of the design.' };
  const got = selected(doc, selectedId);
  if (got == null) return { state: 'wrong', detail: step.hint };
  const gotId = 'device' in got ? got.device : got.cable;
  return gotId === want ? { state: 'passed' } : { state: 'wrong', detail: step.hint };
}

/** The display ids and flow a trace step asks for; null when its ends are no longer in the design. */
export function traceArgs(
  doc: Document,
  step: Extract<LessonStep, { kind: 'trace' }>,
): { from: string; fromLabel: string; to: string; toLabel: string; flowText: string; flow?: { protocol: number; port: number } } | null {
  const from = 'device' in step.from ? deviceByHostname(doc, step.from.device) : portByRef(doc, step.from.port);
  const to = deviceByHostname(doc, step.to.device);
  if (from == null || to == null) return null;
  const flow = parseFlow(step.flow ?? '');
  const fromLabel = 'device' in step.from ? step.from.device : `${step.from.port.replace(':', ' port ')}`;
  return { from, fromLabel, to, toLabel: step.to.device, flowText: step.flow ?? '', flow: flow != null && flow !== 'none' ? flow : undefined };
}

/** A trace's answer against what the step expects. */
export function checkTrace(expect: TraceExpect, result: TraceResult): StepCheck {
  const titles = result.hops.filter((h) => h.kind === 'device' || h.kind === 'switch' || h.kind === 'end').map((h) => h.title);
  if ('firstMatch' in expect) {
    for (const hop of result.hops) {
      const first = hop.policies.find((p) => p.state === 'matches');
      if (first != null) {
        return first.name === expect.firstMatch ? { state: 'passed' } : { state: 'wrong', detail: `The first policy that matches is now ${first.name}.` };
      }
    }
    return { state: 'wrong', detail: 'No policy on the path matches this flow now.' };
  }
  if (expect.reaches) {
    if (result.stopped !== '') return { state: 'wrong', detail: `The trace stopped: ${result.stopped}` };
    const missing = expect.crosses.filter((h) => !titles.includes(h));
    return missing.length === 0 ? { state: 'passed' } : { state: 'wrong', detail: `The path no longer crosses ${missing.join(' and ')}.` };
  }
  if (result.stopped === '') return { state: 'wrong', detail: 'The trace reached the far end.' };
  const last = titles.at(-1);
  return last === expect.stopsAt ? { state: 'passed' } : { state: 'wrong', detail: `The trace now stops at ${last ?? 'the start'}.` };
}

/** A change step against what Checks finds now. */
export function checkChange(step: Extract<LessonStep, { kind: 'change' }>, checks: ChecksResult | null): StepCheck {
  if (checks == null || checks.loadFailed) return { state: 'waiting' };
  const fires = checks.findings.some((f) => f.rule === step.expect.rule);
  return fires === (step.expect.now === 'fires') ? { state: 'passed' } : { state: 'waiting' };
}

// ---------------------------------------------------------------------------
// Where a learner got to, per account, in this browser

export interface LessonRun {
  lessonId: string;
  designId: string;
  /** Steps passed so far; equal to the step count once done. */
  step: number;
}

const KEY = (accountId: string | null) => `fathom.lessons.${accountId ?? 'anon'}`;

export function loadRuns(accountId: string | null, storage: Pick<Storage, 'getItem'> | undefined = globalThis.localStorage): LessonRun[] {
  try {
    const raw = storage?.getItem(KEY(accountId));
    const v: unknown = raw == null ? [] : JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.filter(
      (r): r is LessonRun =>
        typeof r === 'object' && r != null && typeof r.lessonId === 'string' && typeof r.designId === 'string' && Number.isInteger(r.step) && r.step >= 0,
    );
  } catch {
    return [];
  }
}

export function saveRun(
  accountId: string | null,
  run: LessonRun,
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = globalThis.localStorage,
): LessonRun[] {
  const next = [...loadRuns(accountId, storage).filter((r) => r.lessonId !== run.lessonId), run];
  try {
    storage?.setItem(KEY(accountId), JSON.stringify(next));
  } catch {
    // Private mode or a full disk: progress lasts for this page only.
  }
  return next;
}

export function runForDesign(runs: readonly LessonRun[], designId: string): LessonRun | null {
  return runs.find((r) => r.designId === designId) ?? null;
}
