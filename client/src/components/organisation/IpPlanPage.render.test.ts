import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { PlanList, PlanRecord } from '../../api/ipPlan';
import { IpPlanView, type IpPlanViewProps } from './IpPlanPage';

const id = (n: number) => `01K${String(n).padStart(23, '0')}`;
const r = (n: number, kind: PlanRecord['kind'], fields: PlanRecord['fields'], extra: Partial<PlanRecord> = {}): PlanRecord => ({
  id: id(n),
  kind,
  version: 1,
  fields,
  lapsed: false,
  addresses: null,
  usable: null,
  ...extra,
});

const plan: PlanList = {
  today: '2026-11-14',
  records: [
    r(1, 'aggregate', { prefix: '10.0.0.0/8', rir: 'RFC 1918' }, { addresses: '16777216', usable: '16777214' }),
    r(2, 'prefix', { prefix: '10.20.1.0/24', status: 'active', is_pool: false, mark_utilised: false, folder: 'scope-1' }, { addresses: '256', usable: '254' }),
    r(3, 'reservation', { prefix: '10.20.1.8/29', reason: 'WAN', holder: 'acct-2', ends: '2026-11-01' }, { lapsed: true }),
  ],
};

const noop = async () => {
  throw new Error('not in a render test');
};
const view = (over: Partial<IpPlanViewProps> = {}) =>
  renderToStaticMarkup(
    createElement(IpPlanView, {
      plan,
      folders: [{ id: 'scope-1', label: 'London / DC1' }],
      names: new Map([['acct-2', 'Ana']]),
      you: 'acct-1',
      onSave: noop,
      onDelete: noop,
      onLook: noop,
      onTake: noop,
      onDownload: () => undefined,
      ...over,
    }),
  );

describe('Steward › IP plan (ADR-0083 decision 7)', () => {
  it('opens on the address tree with use, free stretches and folders, and no Not finished mark', () => {
    const out = view();
    expect(out).toContain('data-testid="ip-plan-tree"');
    expect(out).toContain('10.20.1.0/24');
    expect(out).toContain('8 of 256 used');
    expect(out).toContain('London / DC1');
    expect(out).toContain('Reserved for Ana until 2026-11-01 · lapsed');
    expect(out).not.toContain('Not finished');
  });

  it('shows a block’s panel with how its usable count is worked out, and next free', () => {
    const out = view({ initialSelected: id(2) });
    expect(out).toContain('data-testid="ip-plan-panel"');
    expect(out).toContain('256 addresses, 254 usable without the network and broadcast addresses');
    expect(out).toContain('data-testid="ip-plan-next"');
    expect(out).toContain('Find a /25');
  });

  it('calls releasing a reservation Release, not Delete', () => {
    expect(view({ initialSelected: id(3) })).toMatch(/data-testid="ip-plan-delete"[^>]*>Release</);
  });

  it('says where to start when nothing is planned', () => {
    expect(view({ plan: { today: '2026-11-14', records: [] } })).toContain('Start with an aggregate');
  });

  it('asks for what a kind needs, and holds Add until it has it', () => {
    const out = view({ initialForm: { kind: 'prefix', id: null } });
    expect(out).toContain('data-testid="ip-plan-form"');
    expect(out).toContain('placeholder="10.20.1.0/24"');
    expect(out.match(/<button[^>]*data-testid="ip-plan-save"[^>]*>/)?.[0]).toContain('disabled');
  });
});
