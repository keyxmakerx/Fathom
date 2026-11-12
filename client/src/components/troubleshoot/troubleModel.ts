// Pure helpers for the "It's down" panel (ADR-0061 troubleshooting): the in-memory draft, its words, what lights on
// the canvas, and the plan "Plan a fix" makes. No React. The draft is not in the document until it is saved.
import type { Answer, DraftStep, Issue } from '../../document/issues';
import { buildChain, alsoAffected, affectedLines, type ChainStep } from './chain';
import { outcomeText, pointing, type PointStep, type Pointing } from './pointing';
import type { Document } from '../../document/model';
import type { Canon } from '../checks/checksModel';

export interface DraftStepState extends ChainStep {
  answer: Answer;
  note: string;
  /** A real paste reached the note: it meets the gate when saved. */
  pasted: boolean;
  answeredAt: string;
  /** The saved IssueStep this row writes to; '' until the draft is saved. */
  stepId: string;
  /** The note as the issue last held it, so a note being typed is not overwritten by a sync. */
  savedNote: string;
}

export interface Draft {
  deviceId: string;
  deviceName: string;
  openedAt: number;
  steps: DraftStepState[];
  /** The "Also affected" lines, read once when the session opens. */
  affected: string[];
  /** Set once "Save as an issue" (or Plan a fix) has saved it, or when a saved issue is continued: each answer
   * then writes to the issue as it is given. */
  savedId: string | null;
  /** Opened from a plan (sign-off r73): the step, or null for a check after the work, and the words that sent it. */
  from: { stepId: string | null; said: string } | null;
}

export const GLYPH: Record<Answer, string> = { ok: '✓', not_ok: '✗', cant_tell: '?', unanswered: '○' };
export const ANSWER_WORD: Record<Answer, string> = { ok: 'OK', not_ok: 'Not OK', cant_tell: "Can't tell", unanswered: 'Not asked yet' };

/** The checklist for a device, nothing answered. Null when the id is not a live device. */
export function startDraft(doc: Document, deviceId: string, now: number): Draft | null {
  if (!deviceId.startsWith('device:')) return null;
  const chain = buildChain(doc, deviceId);
  return {
    deviceId,
    deviceName: chain.deviceName,
    openedAt: now,
    steps: chain.steps.map((s) => ({ ...s, answer: 'unanswered', note: '', pasted: false, answeredAt: '', stepId: '', savedNote: '' })),
    affected: affectedLines(chain.deviceName, alsoAffected(doc, deviceId)),
    savedId: null,
    from: null,
  };
}

/** The index of the first unanswered step, or -1. */
export function firstOpen(steps: readonly { answer: Answer }[]): number {
  return steps.findIndex((s) => s.answer === 'unanswered');
}

/** The next step to ask after `from`: the next unanswered, wrapping once; `from` when none is left. */
export function nextOpen(steps: readonly { answer: Answer }[], from: number): number {
  for (let i = from + 1; i < steps.length; i += 1) if (steps[i].answer === 'unanswered') return i;
  const first = firstOpen(steps);
  return first === -1 ? from : first;
}

export function answered(steps: readonly { answer: Answer }[]): number {
  return steps.filter((s) => s.answer !== 'unanswered').length;
}

export function withAnswer(draft: Draft, index: number, answer: Answer, now: number): Draft {
  if (index < 0 || index >= draft.steps.length) return draft;
  const steps = draft.steps.map((s, i) => (i === index ? { ...s, answer, answeredAt: answer === 'unanswered' ? '' : new Date(now).toISOString() } : s));
  return { ...draft, steps };
}

export function withNote(draft: Draft, index: number, note: string, pasted: boolean): Draft {
  if (index < 0 || index >= draft.steps.length) return draft;
  return { ...draft, steps: draft.steps.map((s, i) => (i === index ? { ...s, note, pasted: s.pasted || pasted } : s)) };
}

const pointSteps = (draft: Pick<Draft, 'steps'>): PointStep[] =>
  draft.steps.map((s, i) => ({ ordinal: i, answer: s.answer, suspects: s.suspects, tests: s.tests }));

/** Where the answers so far point; null while nothing is answered. */
export function pointOf(draft: Pick<Draft, 'steps'>): Pointing | null {
  return pointing(pointSteps(draft));
}

const FROM = 'From ';

/** The sentence an issue keeps: where the answers point, after the plan's words that sent it here. */
export function outcomeOf(draft: Pick<Draft, 'steps' | 'from'>): string {
  const point = outcomeText(pointSteps(draft));
  return draft.from ? `${FROM}${draft.from.said}\n${point}` : point;
}

/** A saved, open issue as a checklist again, to pick up where it stopped. Each saved step takes its Why?, How to
 * check and suspects from the device's chain as the design is now, when a step there asks the same question; a step
 * the design no longer asks keeps its own words and points at itself. */
export function draftFromIssue(doc: Document, issue: Issue, now: number): Draft {
  const chain = buildChain(doc, issue.deviceId);
  const used = new Set<number>();
  const steps: DraftStepState[] = issue.steps.map((s) => {
    const at = chain.steps.findIndex((c, i) => !used.has(i) && c.topic === s.topic && c.question === s.question);
    if (at !== -1) used.add(at);
    const base: ChainStep =
      at !== -1 ? chain.steps[at] : { topic: s.topic, question: s.question, detail: s.detail, targets: s.targets, why: [], how: [], known: false, suspects: [], tests: [] };
    return { ...base, detail: s.detail, targets: s.targets, answer: s.answer, note: s.note, pasted: false, answeredAt: s.answeredAt, stepId: s.id, savedNote: s.note };
  });
  // The plan's words that sent it here lead the saved outcome; keep them.
  const first = issue.outcome.split('\n')[0];
  const from = issue.stepId !== '' || first.startsWith(FROM) ? { stepId: issue.stepId === '' ? null : issue.stepId, said: first.startsWith(FROM) ? first.slice(FROM.length) : '' } : null;
  return {
    deviceId: issue.deviceId,
    deviceName: chain.deviceName,
    openedAt: now,
    steps,
    affected: affectedLines(chain.deviceName, alsoAffected(doc, issue.deviceId)),
    savedId: issue.id,
    from: from && from.said !== '' ? from : null,
  };
}

/** Brings a saved draft's answers in line with the issue (another editor, an undo). A note being typed is kept.
 * The same draft comes back when nothing changed. */
export function syncFromIssue(draft: Draft, issue: Issue): Draft {
  let changed = false;
  const steps = draft.steps.map((s, i) => {
    const saved = issue.steps.find((x) => x.ordinal === i);
    if (saved === undefined) return s;
    const note = s.note === s.savedNote ? saved.note : s.note;
    if (s.stepId === saved.id && s.answer === saved.answer && s.answeredAt === saved.answeredAt && s.note === note && s.savedNote === saved.note) return s;
    changed = true;
    return { ...s, stepId: saved.id, answer: saved.answer, answeredAt: saved.answeredAt, note, savedNote: saved.note };
  });
  return changed ? { ...draft, steps } : draft;
}

/** "nas-01 is down · 3 of 6" counting the open step; with none open, "· narrowed" or "· all answered". */
export function headerText(draft: Draft, open: number): string {
  const bad = draft.steps.some((s) => s.answer === 'not_ok') && pointOf(draft) !== null;
  const where = open >= 0 && open < draft.steps.length ? `${open + 1} of ${draft.steps.length}` : bad ? 'narrowed' : 'all answered';
  return `${draft.deviceName} is down · ${where}`;
}

export function issueTitle(deviceName: string): string {
  return `${deviceName} is down`;
}

export function planTitle(deviceName: string): string {
  return `Fix: ${deviceName} is down`;
}

/** What the draft saves: every step with its answer, in order. */
export function toDraftSteps(draft: Draft): DraftStep[] {
  return draft.steps.map((s) => ({
    topic: s.topic,
    question: s.question,
    detail: s.detail,
    targets: s.targets,
    answer: s.answer,
    note: s.note,
    pasted: s.pasted,
    answeredAt: s.answeredAt === '' ? undefined : s.answeredAt,
  }));
}

/** The plan steps "Plan a fix" makes: one 'other' step per suspect part the answers point at. */
export function fixSteps(p: Pointing | null): { change: string; target: string }[] {
  if (p === null) return [];
  const seen = new Set<string>();
  const out: { change: string; target: string }[] = [];
  for (const s of p.suspects) {
    if (seen.has(s.id)) continue;
    seen.add(s.id);
    out.push({ change: `Check ${s.label}`, target: s.id });
  }
  return out;
}

/** Plan a fix is live once an answer points at something; until then it says why not, in one line. */
export function planFixState(draft: Draft, canEdit: boolean): { ok: true } | { ok: false; reason: string } {
  if (!canEdit) return { ok: false, reason: 'You can look at this but not change it.' };
  if (fixSteps(pointOf(draft)).length === 0) return { ok: false, reason: 'Nothing is suspect yet: answer Not OK to a step first.' };
  return { ok: true };
}

/** What the canvas keeps lit: every step's targets, the current step's, and what the answers point at. */
export function canvasKeys(draft: Draft, current: number, canon: Canon): { chain: Set<string>; current: Set<string>; suspects: Set<string> } {
  const keys = (ids: readonly string[]): string[] => ids.map(canon);
  const chain = new Set(draft.steps.flatMap((s) => keys(s.targets)));
  const now = new Set(current >= 0 && current < draft.steps.length ? keys(draft.steps[current].targets) : []);
  const p = pointOf(draft);
  const suspects = new Set(p === null ? [] : keys(p.suspects.map((s) => s.id)));
  return { chain, current: now, suspects };
}

/** Esc closes the Why? card first, then the panel, and only while focus is inside the panel. */
export function troubleEscTarget(open: { why: boolean; panel: boolean; inside: boolean }): 'why' | 'panel' | null {
  if (!open.inside) return null;
  if (open.why) return 'why';
  if (open.panel) return 'panel';
  return null;
}

/** The key that answers: 1, 2, 3. */
export function answerForKey(key: string): Answer | null {
  if (key === '1') return 'ok';
  if (key === '2') return 'not_ok';
  if (key === '3') return 'cant_tell';
  return null;
}

/** A saved issue's date and time as it reads in the history: "3 Oct 21:40". */
export function whenText(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getDate()} ${months[d.getMonth()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The one line a history shows for an issue. */
export function historyLine(issue: Pick<Issue, 'title' | 'openedAt' | 'outcome' | 'stage'>): string {
  const first = issue.outcome.split('\n')[0];
  return [issue.title, whenText(issue.openedAt), issue.stage === 'closed' ? 'closed' : 'open', first].filter((x) => x !== '').join(' · ');
}
