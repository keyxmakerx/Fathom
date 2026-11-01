// A check step's paste box (ADR-0080 decision 5): the person pastes what the device answered, the
// redaction gate runs on it in the browser, and Fathom compares what it can. It says Matches, Differs
// or Can't tell, and why. It never marks the step: the person still presses Done or Went differently.
//
// What Fathom compares, and nothing more:
// - a hash step ("Check the SHA-256 on the device"): a value of that hash's length in the paste, with
//   the image's own value when Fathom holds the image, otherwise with the first and last four
//   characters the plan's words keep (which can show a difference but never prove a match);
// - the record step ("Record 23.4R2 as running"): the version, as a whole word in the paste.
// Everything else is Can't tell, said plainly.
//
// The comparison reads the paste in the browser BEFORE the redaction gate, in memory only. The gate
// removes any line holding a long hex value (its `long-hex` detector), so a file's hash never survives
// it, and a hash check could never say Matches after it. What is kept is the gated paste and this
// comparison's verdict and why (`PlanStep.compared`), the why gated too.

import type { Plan, PlanStep } from '../../document/plans';
import { stepTitle, upgradeGroups } from '../firmware/upgradePlan';

export type Verdict = NonNullable<PlanStep['compared']>['verdict'];

export const VERDICT_WORD: Readonly<Record<Verdict, string>> = {
  matches: 'Matches',
  differs: 'Differs',
  'cant_tell': 'Can’t tell',
};

export type Expectation =
  | { kind: 'hash'; /** `SHA-256`, as the step names it. */ label: string; length: number; full: string | null; head: string | null; tail: string | null }
  | { kind: 'version'; version: string }
  | { kind: 'none' };

/** Hex lengths by the name a step gives the hash. */
const HASH_LENGTH: Readonly<Record<string, number>> = { 'SHA-256': 64, 'SHA-512': 128, 'SHA-384': 96, 'SHA-1': 40, MD5: 32 };

const HASH_TITLE = /^Check the (\S+) on the device$/;
const RECORD_TITLE = /^Record (\S+) as running$/;
/** `abcd…1234` in a step's words: `shortHash` (api/firmware.ts). */
const SHORT = /\b([0-9a-f]{4})…([0-9a-f]{4})\b/i;

/**
 * Whether a step gets the paste box: a firmware plan's "Check ... on the device" steps and its record
 * step, and in any other plan a step a person wrote starting Check, Verify or Confirm.
 */
export function isCheckStep(plan: Plan, step: PlanStep): boolean {
  const title = stepTitle(step.change);
  if (upgradeGroups(plan).length > 0) return /^Check .+ on the device$/.test(title) || RECORD_TITLE.test(title);
  return /^(check|verify|confirm)\b/i.test(title);
}

/** What a step can be compared with. `fullHash` is the image's own value, when Fathom holds it. */
export function expectationOf(step: PlanStep, fullHash: string | null = null): Expectation {
  const title = stepTitle(step.change);
  const record = RECORD_TITLE.exec(title);
  if (record) return { kind: 'version', version: record[1]! };
  const hash = HASH_TITLE.exec(title);
  const length = hash ? HASH_LENGTH[hash[1]!.toUpperCase()] : undefined;
  if (hash && length !== undefined) {
    const full = fullHash !== null && fullHash.length === length && /^[0-9a-f]+$/i.test(fullHash) ? fullHash.toLowerCase() : null;
    const short = SHORT.exec(step.change);
    return { kind: 'hash', label: hash[1]!, length, full, head: short ? short[1]!.toLowerCase() : null, tail: short ? short[2]!.toLowerCase() : null };
  }
  return { kind: 'none' };
}

export interface Comparison {
  verdict: Verdict;
  why: string;
}

const brief = (h: string): string => `${h.slice(0, 8)}…${h.slice(-8)}`;

/** Every run of hex digits exactly `length` long, as its own word, lowercased. */
export function hexValues(seen: string, length: number): string[] {
  const out = seen.match(new RegExp(`(?<![0-9a-fA-F])[0-9a-fA-F]{${length}}(?![0-9a-fA-F])`, 'g')) ?? [];
  return [...new Set(out.map((h) => h.toLowerCase()))];
}

/** The paste's words, where a word is letters, digits and `. - _ ( )` (a version keeps its dots and brackets). */
const words = (seen: string): string[] => seen.split(/[^A-Za-z0-9.\-_()]+/).filter((w) => w !== '');

/** Words on a line that names a version (`Version 17.09.04a`, `Junos: 23.4R2`), which look like one. */
function versionsNamed(seen: string): string[] {
  const out: string[] = [];
  for (const line of seen.split('\n')) {
    if (!/\bversion\b|^\s*junos\s*:|^\s*nxos\s*:/i.test(line)) continue;
    for (const w of words(line)) {
      const t = w.replace(/[.,]+$/, '');
      if (/^v?\d+\.\d/i.test(t)) out.push(t);
    }
  }
  return [...new Set(out)];
}

export function compareSeen(expect: Expectation, seen: string): Comparison {
  if (seen.trim() === '') return { verdict: 'cant_tell', why: 'Nothing was pasted.' };
  switch (expect.kind) {
    case 'none':
      return { verdict: 'cant_tell', why: 'Fathom has nothing to compare this step with. Read it yourself.' };
    case 'version': {
      const want = expect.version.toLowerCase();
      if (words(seen).some((w) => w.replace(/[.,]+$/, '').toLowerCase() === want)) {
        return { verdict: 'matches', why: `${expect.version} is in what the device said.` };
      }
      const named = versionsNamed(seen);
      if (named.length > 0) return { verdict: 'differs', why: `The device names ${named.slice(0, 3).join(', ')}, not ${expect.version}.` };
      return { verdict: 'cant_tell', why: `No version is named in what was pasted. Paste the output of the command that shows the running version.` };
    }
    case 'hash': {
      const found = hexValues(seen, expect.length);
      if (found.length === 0) return { verdict: 'cant_tell', why: `No ${expect.label} value is in what was pasted.` };
      if (expect.full !== null) {
        if (found.includes(expect.full)) return { verdict: 'matches', why: `The device’s ${expect.label} is the image’s, ${brief(expect.full)}, every character.` };
        return { verdict: 'differs', why: `The device’s ${expect.label} is ${brief(found[0]!)}; the image’s is ${brief(expect.full)}.` };
      }
      if (expect.head === null || expect.tail === null) {
        return { verdict: 'cant_tell', why: `Fathom does not hold the ${expect.label} to compare with. Compare it with the vendor’s published value.` };
      }
      const agrees = found.some((h) => h.startsWith(expect.head!) && h.endsWith(expect.tail!));
      if (agrees) {
        return { verdict: 'cant_tell', why: `The first and last four characters agree with the plan’s ${expect.head}…${expect.tail}, which cannot prove the rest. Compare the whole value.` };
      }
      return { verdict: 'differs', why: `The device’s ${expect.label} is ${brief(found[0]!)}, which does not begin ${expect.head} and end ${expect.tail}.` };
    }
  }
}
