import { describe, expect, it } from 'vitest';

import type { Explainer } from '../../api/learn';
import { emptyDocument } from '../../document/model';
import type { ChassisView, ClosetView } from '../drawing/contract';
import { learnNotes } from './learnNotes';

const note = (subject: string, terse: string): Explainer => ({
  id: `explain:concept:${subject}`,
  kind: 'concept',
  title: subject,
  subject,
  platforms: ['*'],
  tab: 'learn note',
  terse,
  explained: null,
  teaching: null,
  breaksIfWrong: null,
  reviewedOn: null,
  reviewed: false,
  sources: [],
});

const explainers = [note('basics.switch', 'Joins devices.\n'), note('basics.router', 'Moves traffic.'), note('basics.firewall-zones', 'Checks traffic.')];

const chassis = (id: string, role: string | null) => ({ id, deviceId: `Device:${id}`, hostname: id, role }) as unknown as ChassisView;

function view(...cs: ChassisView[]): ClosetView {
  return { racks: [{ chassis: cs }], cables: [], unplaced: [] } as unknown as ClosetView;
}

describe('learnNotes', () => {
  it('writes one note per role, on the first device of it, firewall first', () => {
    const out = learnNotes(emptyDocument(), view(chassis('sw-1', 'switch'), chassis('sw-2', 'switch'), chassis('fw-1', 'firewall')), explainers);
    expect(out.map((n) => [n.key, n.anchor.id, n.line])).toEqual([
      ['role:firewall', 'fw-1', 'Checks traffic.'],
      ['role:switch', 'sw-1', 'Joins devices.'],
    ]);
  });

  it('writes nothing for a role with no note, or no design', () => {
    expect(learnNotes(emptyDocument(), view(chassis('srv-1', 'server')), explainers)).toEqual([]);
    expect(learnNotes(null, view(chassis('sw-1', 'switch')), explainers)).toEqual([]);
  });

  it('ignores explainers that are not learn notes', () => {
    const other = { ...note('basics.switch', 'x'), tab: 'read this first' };
    expect(learnNotes(emptyDocument(), view(chassis('sw-1', 'switch')), [other])).toEqual([]);
  });
});
