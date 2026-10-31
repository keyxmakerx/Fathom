import { describe, expect, it } from 'vitest';

import type { Plan } from '../../document/plans';
import type { CheckFinding } from '../../engine/engine';
import { alsoInOf } from './alsoIn';

const plan = (id: string, stage: Plan['stage'], targets: string[]): Plan =>
  ({ id, title: id, windowStart: '', windowEnd: '', author: '', stage, outcome: null, record: '', steps: [{ targets }] }) as unknown as Plan;
const finding = (title: string, ids: string[]): CheckFinding => ({ title, elements: ids.map((id) => ({ id, name: id })) }) as unknown as CheckFinding;

describe('alsoInOf', () => {
  const ids = new Set(['dev', 'ch', 'p1']);

  it('lists the open plans and the findings that name any of the device own ids', () => {
    const out = alsoInOf(ids, [plan('a', 'planned', ['p1']), plan('b', 'doing', ['other']), plan('c', 'recorded', ['ch'])], [finding('dup ip', ['x', 'dev']), finding('far', ['y'])], new Set());
    expect(out.plans.map((p) => p.id)).toEqual(['a']);
    expect(out.findings.map((f) => f.title)).toEqual(['dup ip']);
    expect(out.ideas).toBe(false);
  });

  it('says when an open AI idea names it', () => {
    expect(alsoInOf(ids, [], [], new Set(['dev'])).ideas).toBe(true);
  });
});
