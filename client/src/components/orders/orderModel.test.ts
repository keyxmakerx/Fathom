import { describe, expect, it } from 'vitest';

import { parseOrder, type Definition, type Order } from '../../api/orders';
import {
  answerFrom,
  answersToSend,
  conditionHolds,
  durationWords,
  fieldsAtOpen,
  finishBlocker,
  historyWords,
  isOverdue,
  matchTeams,
  mayCancelOrder,
  mayPickUp,
  mayWork,
  missingAtOpen,
  overdueRuleWords,
  readyForYou,
  setsUsed,
  signOff,
  whereItIs,
} from './orderModel';
import { setsFor } from './OrderTypesPage';
import { STARTERS, STARTER_SETS } from './starters';

const field = (key: string, extra: Record<string, unknown> = {}) => ({ key, label: key[0].toUpperCase() + key.slice(1), kind: 'text', required: false, choices: [], ...extra });
const job = (id: string, team: string, extra: Record<string, unknown> = {}) => ({ id, name: `Job ${id}`, team, steps: [], asks: [], needs: [], holds: [], overdue: [], ...extra });

const DEF = {
  id: 'dia',
  name: 'Dedicated Internet Access',
  code: 'DIA',
  fields: [
    field('customer', { required: true }),
    field('bandwidth', { kind: 'choice', choices: ['100M', '1G', '10G'], required: true }),
    field('optic', { when: { field: 'bandwidth', op: 'in', value: ['1G', '10G'] }, required: true }),
    field('circuit'),
  ],
  lanes: [
    {
      id: 'main',
      name: 'main',
      implicit: true,
      stages: [
        { id: 'order', name: 'Order Management', jobs: [job('check', 'T-desk', { steps: ['a', 'b'], due_minutes: 1440 })] },
        { id: 'design', name: 'Design', approval: 'approve_plans', jobs: [job('port', 'T-net', { asks: ['circuit'] })] },
        { id: 'provision', name: 'Provisioning', jobs: [job('configure', 'T-prov', { makes_plan: true })] },
      ],
    },
  ],
};

function order(over: Record<string, unknown> = {}, you: Record<string, unknown> = {}): Order {
  return parseOrder({
    id: 'O1',
    number: 1042,
    type: 'dia',
    type_version: 2,
    name: 'Dedicated Internet Access',
    code: 'DIA',
    status: 'open',
    opened_by: 'A-opener',
    opened_at: 1_700_000_000,
    answers: { customer: 'Riverside', bandwidth: '10G', optic: 'LR' },
    lanes: [
      {
        id: 'main',
        name: 'main',
        stages: [
          { id: 'order', name: 'Order Management', status: 'done', jobs: [{ id: 'check', name: 'Check the order', team: 'T-desk', status: 'done', steps: ['a', 'b'], ticks: [0, 1], asks: [] }] },
          {
            id: 'design',
            name: 'Design',
            approval: 'approve_plans',
            status: 'running',
            jobs: [{ id: 'port', name: 'Pick the port', team: 'T-net', status: 'ready', picked_by: null, steps: [], ticks: [], asks: ['circuit'], ready_at: 1_700_000_100 }],
          },
          { id: 'provision', name: 'Provisioning', status: 'not_started', jobs: [{ id: 'configure', name: 'Configure', team: 'T-prov', status: 'not_started', steps: [], ticks: [], asks: [] }] },
        ],
      },
    ],
    holds: [],
    history: [],
    definition: DEF,
    you: { account: 'A-me', steward: false, teams: { 'T-net': { on: true, roles: [], powers: [] }, 'T-desk': { on: false, roles: [], powers: [] } }, ...you },
    people: { 'A-opener': 'Ann' },
    teams: { 'T-net': { slug: 'network-design', name: 'Network design' } },
    ...over,
  });
}

describe('what an order asks', () => {
  const def = order().definition as Definition;

  it('asks a field only while its `when` holds, and leaves a job’s questions to the job', () => {
    expect(fieldsAtOpen(def, { bandwidth: '100M' }).map((f) => f.key)).toEqual(['customer', 'bandwidth']);
    expect(fieldsAtOpen(def, { bandwidth: '10G' }).map((f) => f.key)).toEqual(['customer', 'bandwidth', 'optic']);
  });

  it('says the first needed answer that is missing, and sends only what is still asked', () => {
    expect(missingAtOpen(def, { customer: 'x', bandwidth: '10G' })?.key).toBe('optic');
    expect(missingAtOpen(def, { customer: 'x', bandwidth: '100M' })).toBeNull();
    expect(answersToSend(def, { customer: 'x', bandwidth: '100M', optic: 'LR' })).toEqual({ customer: 'x', bandwidth: '100M' });
  });

  it('reads the fixed comparisons the way the engine does', () => {
    expect(conditionHolds({ field: 'n', op: 'at_least', value: 3 }, { n: 3 })).toBe(true);
    expect(conditionHolds({ field: 'n', op: 'at_most', value: 3 }, { n: 4 })).toBe(false);
    expect(conditionHolds({ field: 'x', op: 'not_set', value: null }, {})).toBe(true);
    expect(conditionHolds({ any: [{ field: 'a', op: 'is', value: 'y' }, { field: 'b', op: 'set', value: null }] }, { b: 'z' })).toBe(true);
    expect(conditionHolds({ all: [{ field: 'a', op: 'is', value: 'y' }, { field: 'b', op: 'set', value: null }] }, { b: 'z' })).toBe(false);
  });

  it('turns what was typed into the answer its kind takes, and says when a number isn’t one', () => {
    const n = { ...def.fields[0], kind: 'number' as const, min: 1, max: 10 };
    expect(answerFrom(n, ' 4 ')).toBe(4);
    expect(answerFrom(n, '4.5')).toEqual({ problem: 'Customer is a whole number.' });
    expect(answerFrom(n, '11')).toEqual({ problem: 'Customer is at most 10.' });
    expect(answerFrom({ ...n, kind: 'yes_no' }, 'yes')).toBe(true);
    expect(answerFrom(n, '')).toBeNull();
  });
});

describe('where an order stands, and who may do what', () => {
  it('says where it is in words', () => {
    expect(whereItIs(order())).toBe('Design');
    expect(whereItIs(order({ status: 'cancelled' }))).toBe('Cancelled');
  });

  it('offers a ready job to its own team only', () => {
    const o = order();
    const port = o.lanes[0].stages[1].jobs[0];
    expect(mayPickUp(o, port)).toBe(true);
    expect(mayWork(o, port)).toBe(true);
    expect(readyForYou(o).map((j) => j.id)).toEqual(['port']);
    const other = order({}, { teams: { 'T-net': { on: false, roles: [], powers: [] } } });
    expect(mayWork(other, other.lanes[0].stages[1].jobs[0])).toBe(false);
  });

  it('says why Done would be refused before it is pressed', () => {
    const o = order();
    expect(finishBlocker(o, o.lanes[0].stages[1].jobs[0])).toBeNull();
    const plan = o.lanes[0].stages[2].jobs[0];
    expect(finishBlocker(o, plan)).toContain('Link the plan');
  });

  it('never offers a sign-off to whoever opened the order or worked the stage, and offers it to a Steward', () => {
    const waiting = (you: Record<string, unknown>, jobs?: unknown[]) => {
      const o = order({}, you);
      const stage = { ...o.lanes[0].stages[1], status: 'awaiting_sign_off' as const };
      if (jobs) stage.jobs = jobs as typeof stage.jobs;
      return signOff(o, stage);
    };
    expect(waiting({ account: 'A-opener', steward: true })).toMatchObject({ may: false });
    expect(waiting({ steward: true }, [{ ...order().lanes[0].stages[1].jobs[0], finishedBy: 'A-me' }])).toMatchObject({ may: false });
    expect(waiting({ steward: true })).toEqual({ may: true });
    expect(waiting({})).toMatchObject({ may: false });
    expect(waiting({ teams: { 'T-net': { on: true, roles: [], powers: ['approve_plans'] } } })).toEqual({ may: true });
  });

  it('lets a lead or a Steward cancel the order, nobody else', () => {
    expect(mayCancelOrder(order())).toBe(false);
    expect(mayCancelOrder(order({}, { steward: true }))).toBe(true);
    expect(mayCancelOrder(order({}, { teams: { 'T-net': { on: true, roles: ['lead'], powers: [] } } }))).toBe(true);
  });

  it('marks a ready job past its due time as overdue', () => {
    const o = order();
    const def = o.definition.lanes[0].stages[1].jobs[0];
    const st = { ...o.lanes[0].stages[1].jobs[0] };
    expect(isOverdue({ ...def, dueMinutes: 60 }, st, 1_700_000_100 + 3599)).toBe(false);
    expect(isOverdue({ ...def, dueMinutes: 60 }, st, 1_700_000_100 + 3601)).toBe(true);
    expect(isOverdue(def, st, 2_000_000_000)).toBe(false);
  });

  it('puts an escalated overdue job in front of whoever holds that role on its team', () => {
    const escalated = (over: Record<string, unknown>) => {
      const o = order({}, { teams: { 'T-net': { on: false, roles: ['lead'], powers: [] } } });
      const port = o.lanes[0].stages[1].jobs[0];
      Object.assign(port, over);
      return o;
    };
    expect(readyForYou(escalated({ escalated: null })).map((j) => j.id)).toEqual([]);
    expect(readyForYou(escalated({ escalated: 'lead' })).map((j) => j.id)).toEqual(['port']);
    expect(readyForYou(escalated({ escalated: 'overseer' })).map((j) => j.id)).toEqual([]);
  });

  it('says an overdue rule, and what the engine did, in words', () => {
    const o = order();
    expect(overdueRuleWords(o, { afterMinutes: 0, action: 'escalate', to: 'lead' })).toBe('as soon as it is overdue, show it to the team’s lead');
    expect(overdueRuleWords(o, { afterMinutes: 2880, action: 'reassign', to: 'team' })).toBe('2 days after it is due, hand it back to the team');
    expect(overdueRuleWords(o, { afterMinutes: 60, action: 'reassign', to: 'T-net' })).toBe('1 hour after it is due, hand it to Network design');
    expect(overdueRuleWords(o, { afterMinutes: 7200, action: 'move_on', to: null })).toBe('5 days after it is due, move on without it');
    const withRules = order({
      definition: { ...DEF, lanes: [{ ...DEF.lanes[0], stages: [{ ...DEF.lanes[0].stages[0], jobs: [job('check', 'T-desk', { due_minutes: 1440, overdue: [{ after_minutes: 0, action: 'escalate', to: 'lead' }] })] }] }] },
    });
    expect(historyWords(withRules, 'overdue', { job: 'check', rule: 0 })).toBe('showed Check the order to the team’s lead, as it was overdue');
  });

  it('says a length of time as a person would', () => {
    expect(durationWords(1440)).toBe('1 day');
    expect(durationWords(2 * 1440)).toBe('2 days');
    expect(durationWords(7 * 1440)).toBe('1 week');
    expect(durationWords(240)).toBe('4 hours');
    expect(durationWords(30)).toBe('30 minutes');
  });
});

describe('a Steward’s file', () => {
  it('matches each slug to the Steward’s pick, else the team with that slug, else nothing', () => {
    const teams = { T1: { slug: 'field', name: 'Field' }, T2: { slug: 'net', name: 'Network' } };
    expect(matchTeams(['field', 'net', 'desk'], teams, { net: 'T1' })).toEqual({ field: 'T1', net: 'T1', desk: null });
    expect(matchTeams(['net'], teams, { net: 'gone' })).toEqual({ net: 'T2' });
  });

  it('ships the three starters, DIA first, with the shared set they use', () => {
    expect(STARTERS.map((s) => s.id)).toEqual(['dia', 'site-build', 'service-removal']);
    expect(STARTERS.find((s) => s.id === 'site-build')?.draft).toBe(true);
    expect(STARTERS[0].draft).toBe(false);
    for (const s of STARTERS) for (const id of setsUsed(s.source)) expect(STARTER_SETS[id]).toBeDefined();
  });

  it('sends the shared sets a file uses, preferring the one it was saved with', () => {
    const mine = 'fathom: field-set/1\nid: customer-details\nname: Mine\nfields: []\n';
    expect(setsFor(STARTERS[0].source, [mine])).toEqual([mine]);
    expect(setsFor(STARTERS[0].source, [])).toEqual([STARTER_SETS['customer-details']]);
    expect(setsFor('fields:\n  - { key: a, label: A, kind: text }\n', [mine])).toEqual([]);
  });
});
