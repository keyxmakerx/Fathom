import { describe, expect, it } from 'vitest';

import { parseDesignWork, parseWork, type WorkRow } from '../../api/work';
import { initialsOfName, isLate, numberOf, sections, sitesOf, stateLine, whereOf, whoOf } from './workModel';

const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

function row(over: Partial<WorkRow>): WorkRow {
  return {
    design: 'd1',
    designName: 'Lab',
    element: 'maintenance-plan:1',
    open: 'maintenance-plan:1',
    kind: 'plan',
    number: 1,
    title: 'Junos upgrade',
    device: '',
    place: '',
    isOpen: true,
    state: 'planned',
    when: '',
    assigned: '',
    ticket: '',
    steps: 0,
    stepsDone: 0,
    stepsDifferently: 0,
    comments: 0,
    ...over,
  };
}

describe('the Work tab (sign-off r74)', () => {
  it('reads the server answer: rows with their work, names and who is in each design', () => {
    const answer = parseWork(
      enc({
        hits: [
          {
            design: 'd1',
            designName: 'Lab',
            element: 'maintenance-plan:1',
            open: 'maintenance-plan:1',
            kind: 'plan',
            name: 'Junos upgrade',
            number: 7,
            work: { open: true, state: 'doing', when: '2026-11-11T22:00', assigned: 'A1', ticket: 'NET-42', steps: 6, stepsDone: 3, stepsDifferently: 0, comments: 2 },
          },
          { design: 'd1', element: 'device:1', kind: 'device', name: 'not work' },
        ],
        designs: 3,
        behind: 1,
        people: { A1: 'Key Maker' },
        here: { d1: [{ account: 'A1', name: 'Key Maker', initials: 'KM' }] },
        you: 'A1',
      }),
    );
    expect(answer.rows).toHaveLength(1);
    expect(answer.rows[0]).toMatchObject({ number: 7, state: 'doing', steps: 6, stepsDone: 3, ticket: 'NET-42', comments: 2 });
    expect(answer.people.A1).toBe('Key Maker');
    expect(answer.here.d1[0].initials).toBe('KM');
    expect(answer.you).toBe('A1');
    expect(parseDesignWork(enc({ numbers: { 'issue:1': 3 }, people: { A1: 'Key Maker' } }))).toEqual({ numbers: { 'issue:1': 3 }, people: { A1: 'Key Maker' } });
  });

  it('puts what is under way in Now and the rest in Coming up, soonest first, and counts each kind', () => {
    const rows = [
      row({ element: 'p1', state: 'doing', number: 1 }),
      row({ element: 'p2', state: 'planned', when: '2026-11-20', number: 2 }),
      row({ element: 'p3', state: 'planned', when: '2026-11-11', number: 3 }),
      row({ element: 'i1', kind: 'issue', state: 'open', number: 4, assigned: 'me' }),
      row({ element: 's1', kind: 'spare', state: 'on_order', when: '2026-11-07', number: 5, design: 'd2', designName: 'Office' }),
    ];
    const all = sections(rows, { kind: 'all', mine: false, design: '' }, 'me');
    // No date on either: the newest number first.
    expect(all.now.map((r) => r.element)).toEqual(['i1', 'p1']);
    expect(all.coming.map((r) => r.element)).toEqual(['s1', 'p3', 'p2']);
    expect(all.counts).toEqual({ all: 5, plan: 3, issue: 1, spare: 1 });
    expect(sections(rows, { kind: 'all', mine: true, design: '' }, 'me').now.map((r) => r.element)).toEqual(['i1']);
    expect(sections(rows, { kind: 'spare', mine: false, design: '' }, 'me').coming.map((r) => r.element)).toEqual(['s1']);
    expect(sections(rows, { kind: 'all', mine: false, design: 'd2' }, 'me').counts.all).toBe(1);
    expect(sitesOf(rows)).toEqual([
      { id: 'd1', name: 'Lab' },
      { id: 'd2', name: 'Office' },
    ]);
  });

  it('says each kind’s own state, and when something is late', () => {
    expect(stateLine(row({ state: 'doing', steps: 6, stepsDone: 3 }))).toBe('Doing · step 4 of 6');
    expect(stateLine(row({ state: 'doing', steps: 6, stepsDone: 3, stepsDifferently: 1 }))).toBe('Doing · step 4 of 6 · 1 went differently');
    expect(stateLine(row({ kind: 'spare', state: 'on_order', when: '2026-11-07' }))).toMatch(/^On order · due \w{3} 7 Nov$/);
    expect(stateLine(row({ kind: 'issue', state: 'closed', isOpen: false }))).toBe('Closed');
    expect(isLate(row({ kind: 'issue', state: 'open', when: '2026-11-01' }), '2026-11-02')).toBe(true);
    expect(isLate(row({ state: 'doing', when: '2026-11-01' }), '2026-11-02')).toBe(false);
    expect(isLate(row({ kind: 'issue', state: 'closed', isOpen: false, when: '2026-11-01' }), '2026-11-02')).toBe(false);
  });

  it('names who it is assigned to and who is in the design now, the assignee first', () => {
    const r = row({ assigned: 'A2' });
    const who = whoOf(r, {
      people: { A2: 'Jo Doe' },
      here: { d1: [{ account: 'A1', name: 'Key Maker', initials: 'KM' }, { account: 'A2', name: 'Jo Doe', initials: 'JD' }] },
    });
    expect(who.assigned).toEqual({ name: 'Jo Doe', initials: 'JD' });
    expect(who.inIt.map((p) => p.initials)).toEqual(['JD', 'KM']);
    expect(whoOf(row({ assigned: 'A9' }), { people: {}, here: {} }).gone).toBe(true);
    expect(initialsOfName('Key Maker')).toBe('KM');
    expect(initialsOfName('jd')).toBe('JD');
    expect(numberOf(row({ number: 12 }))).toBe('W-12');
    expect(numberOf(row({ number: null }))).toBe('…');
    expect(whereOf(row({ kind: 'issue', device: 'srx1500-lab', place: 'Core U12' }))).toBe('Lab › srx1500-lab · Core U12');
    expect(whereOf(row({}), 'd1')).toBe('This design');
  });
});
