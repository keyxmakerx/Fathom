import { describe, expect, it } from 'vitest';

import type { Answer } from '../../document/issues';
import { POINT_DONE, POINT_NOTE, POINT_OK, outcomeText, pointing, type PointStep } from './pointing';

const step = (ordinal: number, answer: Answer, suspects: string[] = [], tests: string[] = []): PointStep => ({
  ordinal,
  answer,
  suspects: suspects.map((label) => ({ label, id: `id:${label}` })),
  tests,
});

// The four sentences ADR-0040 forbids, split so this file does not itself say them.
const FORBIDDEN = [['zero', 'knowledge'].join('-'), ['end', 'to', 'end'].join('-'), 'we cannot read your ' + 'data', 'only you hold the ' + 'key'];

describe('pointing', () => {
  it('says nothing while nothing is answered', () => {
    expect(pointing([step(0, 'unanswered'), step(1, 'unanswered')])).toBeNull();
    expect(pointing([])).toBeNull();
    expect(outcomeText([step(0, 'unanswered')])).toBe('');
  });

  it('names the suspects of the first Not OK, with the tests that tell them apart', () => {
    const p = pointing([
      step(0, 'ok', ['PDU-A outlet 4']),
      step(1, 'ok', ['sw-02']),
      step(2, 'not_ok', ['the cable', 'port 23 on sw-02'], ['Try nas-01 on a free port (sw-02 has 4)']),
      step(3, 'unanswered', ['port 23 on sw-02']),
    ])!;
    expect(p.sentence).toBe('Your answers point at the cable or port 23 on sw-02.');
    expect(p.note).toBe(POINT_NOTE);
    expect(p.tests).toEqual(['Try nas-01 on a free port (sw-02 has 4)']);
    expect(p.suspects.map((s) => s.label)).toEqual(['the cable', 'port 23 on sw-02']);
  });

  it('is nearest first: an earlier Not OK wins over a later one', () => {
    const p = pointing([step(0, 'not_ok', ['power']), step(1, 'ok'), step(2, 'not_ok', ['the cable'])])!;
    expect(p.sentence).toBe('Your answers point at power.');
  });

  it('says everything looks fine so far when every answer is OK and steps remain', () => {
    expect(pointing([step(0, 'ok'), step(1, 'unanswered')])!.sentence).toBe(POINT_OK);
    expect(pointing([step(0, 'ok'), step(1, 'ok')])!.sentence).toBe(POINT_DONE);
  });

  it("notes Can't tell without pointing anywhere", () => {
    expect(pointing([step(0, "cant_tell"), step(1, 'unanswered')])!.sentence).toBe("Nothing points anywhere yet: the one answer was Can't tell.");
    expect(pointing([step(0, 'ok'), step(1, 'cant_tell'), step(2, 'unanswered')])!.sentence).toBe(`${POINT_OK} (Can't tell on step 2.)`);
  });

  it('points at the step itself when a Not OK has no suspect recorded', () => {
    expect(pointing([step(0, 'not_ok')])!.sentence).toContain('Fathom has nothing recorded');
  });

  it('never names a cause and never says the problem is (ADR-0020), nor the four forbidden sentences', () => {
    const cases: PointStep[][] = [
      [step(0, 'not_ok', ['the cable', 'port 23 on sw-02'], ['Try another cable between them'])],
      [step(0, 'ok'), step(1, 'ok')],
      [step(0, 'ok'), step(1, 'cant_tell'), step(2, 'unanswered')],
      [step(0, 'cant_tell')],
      [step(0, 'not_ok')],
    ];
    for (const steps of cases) {
      const p = pointing(steps)!;
      const all = [p.sentence, p.note, ...p.tests].join(' ').toLowerCase();
      expect(all).not.toMatch(/the problem is|the cause is|is broken|has failed|caused by/);
      for (const f of FORBIDDEN) expect(all).not.toContain(f);
    }
  });

  it('freezes the sentence for an issue', () => {
    expect(outcomeText([step(0, 'not_ok', ['the cable'])])).toBe('Your answers point at the cable.');
  });
});
