// Issues (ADR-0061 troubleshooting, schema 0.17). An Issue node records one "It's down" session: the device,
// ordered IssueStep children (HasIssueStep) with the answer to each, and the sentence saying where the answers
// pointed. Pure, like plans.ts. Fathom never names a cause; `outcome` is the pointing sentence frozen at save.
//
// Text meets the redaction gate the way plans do (ADR-0053 section 6): pasted text goes through `gate` inside the
// command, typed text is stored as typed. Every command takes `gate`, so no caller can forget the choice.

import { addEdge, addNode, begin, finish, setNodeField } from './freeform';
import {
  asNumber,
  asString,
  edgesIn,
  edgesOut,
  fieldValue,
  findNode,
  parseNodeId,
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

export type IssueStage = 'open' | 'closed';
export type StepTopic = 'power' | 'neighbours' | 'link' | 'port' | 'address' | 'gateway' | 'other';
export type Answer = 'unanswered' | 'ok' | 'not_ok' | 'cant_tell';

export const TOPICS: readonly StepTopic[] = ['power', 'neighbours', 'link', 'port', 'address', 'gateway', 'other'];
export const ANSWERS: readonly Answer[] = ['unanswered', 'ok', 'not_ok', 'cant_tell'];

export type IssueRefusalCode = 'not-an-issue' | 'not-a-step' | 'closed' | 'no-steps' | 'bad-text' | 'bad-answer' | 'not-a-plan' | 'not-a-device';

export class IssueRefusal extends Error {
  readonly code: IssueRefusalCode;
  constructor(code: IssueRefusalCode, message: string) {
    super(message);
    this.name = 'IssueRefusal';
    this.code = code;
  }
}

export interface IssueStep {
  id: string;
  ordinal: number;
  topic: StepTopic;
  question: string;
  detail: string;
  /** Design ids, one per line when stored. */
  targets: string[];
  answer: Answer;
  note: string;
  answeredAt: string;
}

export interface Issue {
  id: string;
  title: string;
  deviceId: string;
  author: string;
  openedAt: string;
  stage: IssueStage;
  outcome: string;
  planId: string;
  steps: IssueStep[];
}

const str = (n: GraphNode, key: string): string => asString(fieldValue(n.fields, key)) ?? '';

function live(doc: Document, id: string, kind: 'Issue' | 'IssueStep'): GraphNode {
  const n = findNode(doc, id);
  if (!n || n.absentSince !== undefined || parseNodeId(id).kind !== kind) {
    throw new IssueRefusal(kind === 'Issue' ? 'not-an-issue' : 'not-a-step', `"${id}" is not a live ${kind}`);
  }
  return n;
}

function readStep(n: GraphNode): IssueStep {
  const targets = str(n, 'IssueStep.targets');
  return {
    id: n.id,
    ordinal: asNumber(fieldValue(n.fields, 'IssueStep.ordinal')) ?? 0,
    topic: (str(n, 'IssueStep.topic') || 'other') as StepTopic,
    question: str(n, 'IssueStep.question'),
    detail: str(n, 'IssueStep.detail'),
    targets: targets === '' ? [] : targets.split('\n'),
    answer: (str(n, 'IssueStep.answer') || 'unanswered') as Answer,
    note: str(n, 'IssueStep.note'),
    answeredAt: str(n, 'IssueStep.answered_at'),
  };
}

export function issueSteps(doc: Document, issueId: string): IssueStep[] {
  return edgesOut(doc, issueId, 'HasIssueStep')
    .map((e) => findNode(doc, e.to))
    .filter((n): n is GraphNode => n !== undefined && n.absentSince === undefined)
    .map(readStep)
    .sort((a, b) => a.ordinal - b.ordinal);
}

export function readIssue(doc: Document, id: string): Issue {
  const n = live(doc, id, 'Issue');
  return {
    id,
    title: str(n, 'Issue.title'),
    deviceId: str(n, 'Issue.device'),
    author: str(n, 'Issue.author'),
    openedAt: str(n, 'Issue.opened_at'),
    stage: (str(n, 'Issue.stage') || 'open') as IssueStage,
    outcome: str(n, 'Issue.outcome'),
    planId: str(n, 'Issue.plan'),
    steps: issueSteps(doc, id),
  };
}

/** Every live issue, newest first. */
export function listIssues(doc: Document): Issue[] {
  return doc.nodes
    .filter((n) => n.absentSince === undefined && parseNodeId(n.id).kind === 'Issue')
    .map((n) => readIssue(doc, n.id))
    .reverse();
}

/** Issues that name `elementId`: opened on it, or with a step that lights it. `canon` maps a port or cable
 * target to its device, so a switch's history holds the issue of a device cabled to it. Newest first. */
export function issuesTouching(doc: Document, elementId: string, canon: (id: string) => string = (id) => id): Issue[] {
  return listIssues(doc).filter(
    (i) => canon(i.deviceId) === elementId || i.steps.some((s) => s.targets.some((t) => t === elementId || canon(t) === elementId)),
  );
}

/** The first step still unanswered, or null. */
export function currentIssueStep(issue: Pick<Issue, 'steps'>): IssueStep | null {
  return issue.steps.find((s) => s.answer === 'unanswered') ?? null;
}

// ---------------------------------------------------------------------------
// Writing

function gated(gate: TextGate, value: string | undefined, what: string): string {
  const out = gate(value ?? '');
  if (/\u0000/.test(out)) throw new IssueRefusal('bad-text', `${what} holds a character that cannot be stored`);
  return out;
}

/** One step of a draft, as the chain makes it and the person answers it. */
export interface DraftStep {
  topic: StepTopic;
  question: string;
  detail?: string;
  targets?: readonly string[];
  answer?: Answer;
  note?: string;
  /** A real paste reached the note: it goes through the gate. Typed text is stored as typed. */
  pasted?: boolean;
  answeredAt?: string;
}

export interface CreateIssueOptions extends Actor {
  deviceId: string;
  title: string;
  steps: readonly DraftStep[];
  author?: string;
  /** The "where the answers point" sentence, frozen now. */
  outcome?: string;
  gate: TextGate;
}

/** Saves a draft as an Issue (stage open) with its steps and answers: one undo step. */
export function createIssue(doc: Document, opts: CreateIssueOptions): { doc: Document; id: string } {
  const device = findNode(doc, opts.deviceId);
  if (!device || device.absentSince !== undefined || parseNodeId(opts.deviceId).kind !== 'Device') {
    throw new IssueRefusal('not-a-device', `"${opts.deviceId}" is not a device in the design`);
  }
  const title = gated(opts.gate, opts.title, 'the title').trim();
  if (title === '') throw new IssueRefusal('bad-text', 'an issue needs a title');
  if (opts.steps.length === 0) throw new IssueRefusal('no-steps', 'an issue needs at least one step');
  const now = opts.now ?? Date.now();
  const b = begin(doc, { actor: opts.actor, now });
  const fields: Record<string, ReturnType<typeof text>> = {
    'Issue.title': text(title),
    'Issue.device': text(opts.deviceId),
    'Issue.opened_at': text(new Date(now).toISOString()),
    'Issue.stage': token('open'),
  };
  if (opts.author) fields['Issue.author'] = text(gated(opts.gate, opts.author, 'the author'));
  const outcome = gated(opts.gate, opts.outcome, 'the outcome').trim();
  if (outcome !== '') fields['Issue.outcome'] = text(outcome);
  const id = addNode(b, 'Issue', fields);
  opts.steps.forEach((s, i) => {
    if (!TOPICS.includes(s.topic)) throw new IssueRefusal('bad-answer', `"${s.topic}" is not a topic`);
    const answer = s.answer ?? 'unanswered';
    if (!ANSWERS.includes(answer)) throw new IssueRefusal('bad-answer', `"${answer}" is not an answer`);
    const question = gated(opts.gate, s.question, 'the question').trim();
    if (question === '') throw new IssueRefusal('bad-text', 'a step needs a question');
    const f: Record<string, ReturnType<typeof text>> = {
      'IssueStep.ordinal': uint(i, 32),
      'IssueStep.topic': token(s.topic),
      'IssueStep.question': text(question),
      'IssueStep.answer': token(answer),
    };
    const detail = gated(opts.gate, s.detail, 'the detail').trim();
    if (detail !== '') f['IssueStep.detail'] = text(detail);
    const targets = (s.targets ?? []).filter((t) => t !== '');
    if (targets.length > 0) f['IssueStep.targets'] = text(targets.join('\n'));
    const note = gated(s.pasted === true ? opts.gate : TYPED_AS_WRITTEN, s.note, 'the note').trim();
    if (note !== '') f['IssueStep.note'] = text(note);
    if (s.answeredAt) f['IssueStep.answered_at'] = text(s.answeredAt);
    else if (answer !== 'unanswered') f['IssueStep.answered_at'] = text(new Date(now).toISOString());
    const step = addNode(b, 'IssueStep', f);
    addEdge(b, 'HasIssueStep', id, step);
  });
  return { doc: finish(b, truncateUtf8(`Issue: ${title}`)), id };
}

function issueOf(doc: Document, stepId: string): string {
  live(doc, stepId, 'IssueStep');
  const edge = edgesIn(doc, stepId, 'HasIssueStep')[0];
  if (!edge) throw new IssueRefusal('not-a-step', `"${stepId}" has no issue`);
  return edge.from;
}

function requireOpen(doc: Document, issueId: string): GraphNode {
  const n = live(doc, issueId, 'Issue');
  if (str(n, 'Issue.stage') === 'closed') throw new IssueRefusal('closed', 'this issue is closed and cannot change');
  return n;
}

export interface AnswerOptions extends Actor {
  answer: Answer;
  note?: string;
  gate: TextGate;
}

/** Records the answer to a step of a saved, open issue. A new answer replaces the earlier one; a note is kept
 * until a new one is given. */
export function answerStep(doc: Document, stepId: string, opts: AnswerOptions): Document {
  requireOpen(doc, issueOf(doc, stepId));
  if (!ANSWERS.includes(opts.answer)) throw new IssueRefusal('bad-answer', `"${opts.answer}" is not an answer`);
  const note = gated(opts.gate, opts.note, 'the note').trim();
  const now = opts.now ?? Date.now();
  const b = begin(doc, { actor: opts.actor, now });
  setNodeField(b, stepId, 'IssueStep.answer', token(opts.answer));
  if (note !== '') setNodeField(b, stepId, 'IssueStep.note', text(note));
  if (opts.answer !== 'unanswered') setNodeField(b, stepId, 'IssueStep.answered_at', text(new Date(now).toISOString()));
  return finish(b, 'answer step');
}

export interface CloseOptions extends Actor {
  /** Anything typed to keep with the issue, added after the frozen sentence. */
  text?: string;
  gate: TextGate;
}

/** Closes an issue. The outcome sentence stays as saved; typed text is added on a new line. */
export function closeIssue(doc: Document, issueId: string, opts: CloseOptions): Document {
  const n = requireOpen(doc, issueId);
  const extra = gated(opts.gate, opts.text, 'the text').trim();
  const b = begin(doc, opts);
  setNodeField(b, issueId, 'Issue.stage', token('closed'));
  if (extra !== '') {
    const before = str(n, 'Issue.outcome');
    setNodeField(b, issueId, 'Issue.outcome', text(before === '' ? extra : `${before}\n${extra}`));
  }
  return finish(b, truncateUtf8(`Issue closed: ${str(n, 'Issue.title')}`));
}

/** Links the maintenance plan made from an issue. The plan must be a live plan. */
export function linkPlan(doc: Document, issueId: string, planId: string, opts?: Actor): Document {
  live(doc, issueId, 'Issue');
  const plan = findNode(doc, planId);
  if (!plan || plan.absentSince !== undefined || parseNodeId(planId).kind !== 'MaintenancePlan') {
    throw new IssueRefusal('not-a-plan', `"${planId}" is not a live maintenance plan`);
  }
  const b = begin(doc, opts);
  setNodeField(b, issueId, 'Issue.plan', text(planId));
  return finish(b, 'link plan to issue');
}
