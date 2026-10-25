// Lessons written on a design (ADR-0066 §2, schema 0.27). A Lesson node hangs off the root (HasLesson) with ordered
// LessonStep children (HasLessonStep). Steps name what they point at by design id, so they stay true in a copy of the
// design: publishing copies the whole design and marks the lesson in the copy published. Pure, like issues.ts.
//
// Text meets the redaction gate the way issues do: every command takes `gate`, so no caller can forget the choice,
// and the server's credential check reads every text field of both kinds on save.

import { addEdge, addNode, begin, finish, setNodeField, tombstone, type Build } from './freeform';
import {
  archiveField,
  asNumber,
  asString,
  assertHand,
  edgesIn,
  edgesOut,
  fieldValue,
  findNode,
  identifier,
  parseNodeId,
  requireFieldName,
  text,
  token,
  uint,
  type Document,
  type GraphNode,
} from './model';
import { TYPED_AS_WRITTEN, type TextGate } from './plans';
import { truncateUtf8 } from './undo';

export { TYPED_AS_WRITTEN, type TextGate };

interface Actor {
  actor?: string;
  now?: number;
}

export type LessonStepKind = 'read' | 'click' | 'trace' | 'change';
export type ExpectTrace = 'reaches' | 'stops' | 'first_match';
export type ExpectNow = 'fires' | 'clears';

export const STEP_KINDS: readonly LessonStepKind[] = ['read', 'click', 'trace', 'change'];

export type LessonRefusalCode = 'not-a-lesson' | 'not-a-step' | 'bad-text' | 'bad-step' | 'published';

export class LessonRefusal extends Error {
  readonly code: LessonRefusalCode;
  constructor(code: LessonRefusalCode, message: string) {
    super(message);
    this.name = 'LessonRefusal';
    this.code = code;
  }
}

/** What a step says and checks. Empty strings are fields not set. */
export interface LessonStepInput {
  kind: LessonStepKind;
  title: string;
  body?: string;
  hint?: string;
  after?: string;
  explainer?: string;
  /** Design id of the Device or Cable a click step wants picked. */
  answer?: string;
  /** Design id of the Device or PhysicalPort a trace starts at. */
  traceFrom?: string;
  /** Design id of the Device a trace goes to. */
  traceTo?: string;
  flow?: string;
  expectTrace?: ExpectTrace;
  /** Design ids of Devices a reaching trace crosses. */
  expectCrosses?: readonly string[];
  /** Design id of the Device a stopping trace stops at. */
  expectStop?: string;
  expectFirstMatch?: string;
  expectRule?: string;
  expectNow?: ExpectNow;
}

export interface DesignLessonStep extends Required<Omit<LessonStepInput, 'expectTrace' | 'expectNow' | 'expectCrosses'>> {
  id: string;
  ordinal: number;
  expectTrace: ExpectTrace | '';
  expectCrosses: string[];
  expectNow: ExpectNow | '';
}

export interface DesignLesson {
  id: string;
  title: string;
  summary: string;
  author: string;
  /** Set on a published copy; empty on the author's draft. */
  publishedAt: string;
  sourceDesign: string;
  steps: DesignLessonStep[];
}

// One stored field per input property, in the order a step is written.
const STEP_TEXT: ReadonlyArray<readonly [keyof LessonStepInput, string]> = [
  ['title', 'LessonStep.title'],
  ['body', 'LessonStep.body'],
  ['hint', 'LessonStep.hint'],
  ['after', 'LessonStep.after'],
  ['explainer', 'LessonStep.explainer'],
  ['answer', 'LessonStep.answer'],
  ['traceFrom', 'LessonStep.trace_from'],
  ['traceTo', 'LessonStep.trace_to'],
  ['flow', 'LessonStep.flow'],
  ['expectStop', 'LessonStep.expect_stop'],
  ['expectFirstMatch', 'LessonStep.expect_first_match'],
  ['expectRule', 'LessonStep.expect_rule'],
];

const str = (n: GraphNode, key: string): string => asString(fieldValue(n.fields, key)) ?? '';

function live(doc: Document, id: string, kind: 'Lesson' | 'LessonStep'): GraphNode {
  const n = findNode(doc, id);
  if (!n || n.absentSince !== undefined || parseNodeId(id).kind !== kind) {
    throw new LessonRefusal(kind === 'Lesson' ? 'not-a-lesson' : 'not-a-step', `"${id}" is not a live ${kind}`);
  }
  return n;
}

function readStep(n: GraphNode): DesignLessonStep {
  const crosses = str(n, 'LessonStep.expect_crosses');
  const out = {
    id: n.id,
    ordinal: asNumber(fieldValue(n.fields, 'LessonStep.ordinal')) ?? 0,
    kind: (str(n, 'LessonStep.kind') || 'read') as LessonStepKind,
    expectTrace: str(n, 'LessonStep.expect_trace') as ExpectTrace | '',
    expectCrosses: crosses === '' ? [] : crosses.split('\n'),
    expectNow: str(n, 'LessonStep.expect_now') as ExpectNow | '',
  } as DesignLessonStep;
  for (const [prop, key] of STEP_TEXT) (out as unknown as Record<string, string>)[prop] = str(n, key);
  return out;
}

export function lessonSteps(doc: Document, lessonId: string): DesignLessonStep[] {
  return edgesOut(doc, lessonId, 'HasLessonStep')
    .filter((e) => e.absentSince === undefined)
    .map((e) => findNode(doc, e.to))
    .filter((n): n is GraphNode => n !== undefined && n.absentSince === undefined)
    .map(readStep)
    .sort((a, b) => a.ordinal - b.ordinal);
}

export function readLesson(doc: Document, id: string): DesignLesson {
  const n = live(doc, id, 'Lesson');
  return {
    id,
    title: str(n, 'Lesson.title'),
    summary: str(n, 'Lesson.summary'),
    author: str(n, 'Lesson.author'),
    publishedAt: str(n, 'Lesson.published_at'),
    sourceDesign: str(n, 'Lesson.source_design'),
    steps: lessonSteps(doc, id),
  };
}

/** Every live lesson in the design, oldest first. */
export function listLessons(doc: Document): DesignLesson[] {
  return doc.nodes.filter((n) => n.absentSince === undefined && parseNodeId(n.id).kind === 'Lesson').map((n) => readLesson(doc, n.id));
}

/** The published lesson a copy carries, or null. A published copy holds one. */
export function publishedLesson(doc: Document): DesignLesson | null {
  return listLessons(doc).find((l) => l.publishedAt !== '') ?? null;
}

// ---------------------------------------------------------------------------
// Whether a step is complete enough to run

/** What a step still needs before it can be checked, in a few words; null when it is complete. */
export function stepProblem(step: LessonStepInput | DesignLessonStep): string | null {
  if (step.title.trim() === '') return 'It needs a title.';
  switch (step.kind) {
    case 'read':
      return (step.body ?? '').trim() === '' ? 'It needs something to read.' : null;
    case 'click':
      return (step.answer ?? '') === '' ? 'Pick the answer on the canvas.' : null;
    case 'trace':
      if ((step.traceFrom ?? '') === '' || (step.traceTo ?? '') === '') return 'It needs both ends of the trace.';
      if (!step.expectTrace) return 'Record what the trace shows.';
      if (step.expectTrace === 'stops' && (step.expectStop ?? '') === '') return 'Say where the trace stops.';
      if (step.expectTrace === 'first_match' && (step.expectFirstMatch ?? '').trim() === '') return 'Name the policy that matches first.';
      return null;
    case 'change':
      if ((step.expectRule ?? '') === '') return 'Pick the check to watch.';
      return !step.expectNow ? 'Say whether it should fire or clear.' : null;
  }
}

// ---------------------------------------------------------------------------
// Writing

function gated(gate: TextGate, value: string | undefined, what: string): string {
  const out = gate(value ?? '');
  if (/\u0000/.test(out)) throw new LessonRefusal('bad-text', `${what} holds a character that cannot be stored`);
  return out.trim();
}

function requireDraft(doc: Document, lessonId: string): GraphNode {
  const n = live(doc, lessonId, 'Lesson');
  if (str(n, 'Lesson.published_at') !== '') throw new LessonRefusal('published', 'a published lesson cannot change; edit the draft and publish again');
  return n;
}

function lessonOf(doc: Document, stepId: string): string {
  live(doc, stepId, 'LessonStep');
  const edge = edgesIn(doc, stepId, 'HasLessonStep').find((e) => e.absentSince === undefined);
  if (!edge) throw new LessonRefusal('not-a-step', `"${stepId}" has no lesson`);
  return edge.from;
}

/** Sets or clears one field on a node, archiving what it replaces so undo finds it. */
function putField(b: Build, id: string, key: string, value: ReturnType<typeof text> | undefined): void {
  const node = b.doc.nodes.find((n) => n.id === id)!;
  const existing = node.fields[key];
  if (value !== undefined) {
    setNodeField(b, id, key, value);
    return;
  }
  if (existing === undefined || existing.presence !== 'set') return;
  requireFieldName(key);
  const prov = assertHand(b.doc, { assertedAt: b.now, assertedBy: b.actor, supersedes: existing.prov });
  b.doc = archiveField(prov.doc, id, key, existing);
  b.ops.push({ type: 'set_field', element: id, key, presence: 'absent', prov: prov.id });
  b.doc = {
    ...b.doc,
    nodes: b.doc.nodes.map((n) => (n.id === id ? { ...n, fields: { ...n.fields, [key]: { presence: 'absent', prov: prov.id } } } : n)),
  };
}

function stepFields(step: LessonStepInput, gate: TextGate): Record<string, ReturnType<typeof text> | undefined> {
  if (!STEP_KINDS.includes(step.kind)) throw new LessonRefusal('bad-step', `"${step.kind}" is not a kind of step`);
  const f: Record<string, ReturnType<typeof text> | undefined> = { 'LessonStep.kind': token(step.kind) };
  for (const [prop, key] of STEP_TEXT) {
    const v = gated(gate, step[prop] as string | undefined, `the step's ${prop}`);
    f[key] = v === '' ? undefined : text(v);
  }
  if (f['LessonStep.title'] === undefined) throw new LessonRefusal('bad-text', 'a step needs a title');
  const crosses = (step.expectCrosses ?? []).filter((c) => c !== '');
  f['LessonStep.expect_crosses'] = crosses.length > 0 ? text(crosses.join('\n')) : undefined;
  f['LessonStep.expect_trace'] = step.expectTrace != null ? token(step.expectTrace) : undefined;
  f['LessonStep.expect_now'] = step.expectNow != null ? token(step.expectNow) : undefined;
  return f;
}

export interface CreateLessonOptions extends Actor {
  title: string;
  summary?: string;
  author?: string;
  gate: TextGate;
}

/** A new, empty draft lesson on the design: one undo step. */
export function createLesson(doc: Document, opts: CreateLessonOptions): { doc: Document; id: string } {
  const title = gated(opts.gate, opts.title, 'the title');
  if (title === '') throw new LessonRefusal('bad-text', 'a lesson needs a title');
  const b = begin(doc, opts);
  const fields: Record<string, ReturnType<typeof text>> = { 'Lesson.title': text(title) };
  const summary = gated(opts.gate, opts.summary, 'the summary');
  if (summary !== '') fields['Lesson.summary'] = text(summary);
  const author = gated(opts.gate, opts.author, 'the author');
  if (author !== '') fields['Lesson.author'] = text(author);
  // Root containment (HasLesson) is implicit, as for an issue: a node no edge contains hangs off the root.
  const id = addNode(b, 'Lesson', fields);
  return { doc: finish(b, truncateUtf8(`Lesson: ${title}`)), id };
}

/** Renames a draft, or changes its summary. */
export function setLessonText(doc: Document, lessonId: string, patch: { title?: string; summary?: string }, opts: Actor & { gate: TextGate }): Document {
  requireDraft(doc, lessonId);
  const b = begin(doc, opts);
  if (patch.title !== undefined) {
    const title = gated(opts.gate, patch.title, 'the title');
    if (title === '') throw new LessonRefusal('bad-text', 'a lesson needs a title');
    putField(b, lessonId, 'Lesson.title', text(title));
  }
  if (patch.summary !== undefined) {
    const summary = gated(opts.gate, patch.summary, 'the summary');
    putField(b, lessonId, 'Lesson.summary', summary === '' ? undefined : text(summary));
  }
  return finish(b, 'edit lesson');
}

/** Adds a step at the end of a draft. */
export function addLessonStep(doc: Document, lessonId: string, step: LessonStepInput, opts: Actor & { gate: TextGate }): { doc: Document; id: string } {
  requireDraft(doc, lessonId);
  const steps = lessonSteps(doc, lessonId);
  const fields = stepFields(step, opts.gate);
  const set: Record<string, ReturnType<typeof text>> = { 'LessonStep.ordinal': uint((steps.at(-1)?.ordinal ?? -1) + 1, 32) };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined) set[k] = v;
  const b = begin(doc, opts);
  const id = addNode(b, 'LessonStep', set);
  addEdge(b, 'HasLessonStep', lessonId, id);
  return { doc: finish(b, 'add lesson step'), id };
}

/** Rewrites a step of a draft: fields the input leaves empty are cleared. */
export function updateLessonStep(doc: Document, stepId: string, step: LessonStepInput, opts: Actor & { gate: TextGate }): Document {
  requireDraft(doc, lessonOf(doc, stepId));
  const fields = stepFields(step, opts.gate);
  const b = begin(doc, opts);
  for (const [k, v] of Object.entries(fields)) {
    const now = findNode(b.doc, stepId)!.fields[k];
    if (v !== undefined && now?.presence === 'set' && JSON.stringify(now.value) === JSON.stringify(v)) continue;
    putField(b, stepId, k, v);
  }
  return finish(b, 'edit lesson step');
}

/** Removes a step of a draft; the steps after it move up. */
export function removeLessonStep(doc: Document, stepId: string, opts?: Actor): Document {
  const lessonId = lessonOf(doc, stepId);
  requireDraft(doc, lessonId);
  const b = begin(doc, opts);
  const edges = edgesIn(doc, stepId, 'HasLessonStep').map((e) => e.id);
  tombstone(b, new Set([stepId]), new Set(edges));
  renumber(b, lessonSteps(doc, lessonId).filter((s) => s.id !== stepId));
  return finish(b, 'remove lesson step');
}

/** Moves a step of a draft one place earlier (-1) or later (+1). */
export function moveLessonStep(doc: Document, stepId: string, by: -1 | 1, opts?: Actor): Document {
  const lessonId = lessonOf(doc, stepId);
  requireDraft(doc, lessonId);
  const steps = lessonSteps(doc, lessonId);
  const at = steps.findIndex((s) => s.id === stepId);
  const to = at + by;
  if (to < 0 || to >= steps.length) return doc;
  const order = [...steps];
  [order[at], order[to]] = [order[to]!, order[at]!];
  const b = begin(doc, opts);
  renumber(b, order);
  return finish(b, 'move lesson step');
}

function renumber(b: Build, order: readonly DesignLessonStep[]): void {
  order.forEach((s, i) => {
    if (s.ordinal !== i) setNodeField(b, s.id, 'LessonStep.ordinal', uint(i, 32));
  });
}

/** Removes a lesson and its steps. */
export function removeLesson(doc: Document, lessonId: string, opts?: Actor): Document {
  live(doc, lessonId, 'Lesson');
  const stepEdges = edgesOut(doc, lessonId, 'HasLessonStep').filter((e) => e.absentSince === undefined);
  const nodes = new Set([lessonId, ...stepEdges.map((e) => e.to)]);
  const edges = new Set(stepEdges.map((e) => e.id));
  const b = begin(doc, opts);
  tombstone(b, nodes, edges);
  return finish(b, 'remove lesson');
}

/**
 * The document a published copy is made from: the author's design with only this lesson kept, marked published
 * with the time and the design it came from. Every other lesson in the design is left out of the copy, published
 * or not, so a learner's copy carries one lesson.
 */
export function publishedCopy(doc: Document, lessonId: string, opts: Actor & { sourceDesign: string }): Document {
  const lesson = readLesson(doc, lessonId);
  if (lesson.steps.length === 0) throw new LessonRefusal('bad-step', 'a lesson needs at least one step before it is published');
  const unfinished = lesson.steps.findIndex((s) => stepProblem(s) !== null);
  if (unfinished >= 0) throw new LessonRefusal('bad-step', `step ${unfinished + 1} is not finished: ${stepProblem(lesson.steps[unfinished]!)}`);
  let out = doc;
  for (const other of listLessons(doc)) if (other.id !== lessonId) out = removeLesson(out, other.id, opts);
  const b = begin(out, opts);
  setNodeField(b, lessonId, 'Lesson.published_at', text(new Date(b.now).toISOString()));
  if (opts.sourceDesign !== '') setNodeField(b, lessonId, 'Lesson.source_design', identifier(opts.sourceDesign));
  return finish(b, truncateUtf8(`Published: ${lesson.title}`));
}
