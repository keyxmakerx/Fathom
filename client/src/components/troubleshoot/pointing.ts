// Where the answers point (ADR-0061 troubleshooting). Pure: from the answers so far, one sentence and the tests
// that would tell the suspects apart. Nearest first: the first Not OK names its suspects. Fathom never names a
// cause and never says "the problem is" (ADR-0020); it says what the answers point at, and that it does not decide.
import type { Answer } from '../../document/issues';
import type { Suspect } from './chain';
import { orList } from './chain';

export interface PointStep {
  ordinal: number;
  answer: Answer;
  suspects: readonly Suspect[];
  tests: readonly string[];
}

export interface Pointing {
  sentence: string;
  /** Said after the sentence when there are suspects to tell apart. */
  note: string;
  tests: string[];
  suspects: Suspect[];
}

export const POINT_OK = 'Everything Fathom can check looks fine so far.';
export const POINT_DONE = 'Everything Fathom can check looks fine. What is left is outside what Fathom records.';
export const POINT_NOTE = "Fathom doesn't decide which; these would tell them apart:";
export const POINT_NOTE_ONE = 'These would tell you more:';

/** Null while nothing is answered. */
export function pointing(steps: readonly PointStep[]): Pointing | null {
  const answered = steps.filter((s) => s.answer !== 'unanswered');
  if (answered.length === 0) return null;
  const firstBad = steps.filter((s) => s.answer === 'not_ok').sort((a, b) => a.ordinal - b.ordinal)[0];
  if (firstBad !== undefined) {
    const suspects = [...firstBad.suspects];
    const sentence = suspects.length > 0 ? `Your answers point at ${orList(suspects.map((s) => s.label))}.` : 'Your answers point at this step, which Fathom has nothing recorded about.';
    const tests = [...firstBad.tests];
    const note = suspects.length > 1 ? POINT_NOTE : tests.length > 0 ? POINT_NOTE_ONE : '';
    return { sentence, note, tests, suspects };
  }
  const unsure = answered.filter((s) => s.answer === 'cant_tell');
  const fine = answered.filter((s) => s.answer === 'ok');
  if (fine.length === 0) {
    return { sentence: `Nothing points anywhere yet: ${unsure.length === 1 ? 'the one answer was' : 'the answers were'} Can't tell.`, note: '', tests: [], suspects: [] };
  }
  const left = steps.some((s) => s.answer === 'unanswered');
  const base = left || unsure.length > 0 ? POINT_OK : POINT_DONE;
  const sentence = unsure.length > 0 ? `${base} (Can't tell on step ${unsure.map((s) => s.ordinal + 1).join(', ')}.)` : base;
  return { sentence, note: '', tests: [], suspects: [] };
}

/** The sentence frozen into an issue when it is saved, or nothing. */
export function outcomeText(steps: readonly PointStep[]): string {
  return pointing(steps)?.sentence ?? '';
}
