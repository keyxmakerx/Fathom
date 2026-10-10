import { describe, expect, it } from 'vitest';

import type { DesignSummary } from '../../api/designs';
import { EMPTY_RECENT, KEEP, parseRecent, pruned, recentKey, visibleRecent, withDesign, withDevice } from './recent';

const design = (id: string): DesignSummary => ({ designId: id, scopeId: 's', createdAtUnix: 0, createdBy: 'x', capability: 'draw', latestVersion: 1, name: id });

describe('recent', () => {
  it('is per account', () => {
    expect(recentKey('a1')).toBe('fathom.recent.a1');
    expect(recentKey(null)).toBe('fathom.recent.anon');
  });

  it('puts the newest first and does not repeat a design', () => {
    let r = withDesign(EMPTY_RECENT, { organisationId: 'o', designId: 'd1', at: 1 });
    r = withDesign(r, { organisationId: 'o', designId: 'd2', at: 2 });
    r = withDesign(r, { organisationId: 'o', designId: 'd1', at: 3 });
    expect(r.designs.map((d) => d.designId)).toEqual(['d1', 'd2']);
    expect(r.designs[0]!.at).toBe(3);
  });

  it('keeps a bounded list', () => {
    let r = EMPTY_RECENT;
    for (let i = 0; i < KEEP + 5; i++) r = withDesign(r, { organisationId: 'o', designId: `d${i}`, at: i });
    expect(r.designs).toHaveLength(KEEP);
    expect(r.designs[0]!.designId).toBe(`d${KEEP + 4}`);
  });

  it('remembers a device once per design', () => {
    let r = withDevice(EMPTY_RECENT, { organisationId: 'o', designId: 'd', chassisId: 'c', name: 'sw1', at: 1 });
    r = withDevice(r, { organisationId: 'o', designId: 'd', chassisId: 'c', name: 'sw1-renamed', at: 2 });
    expect(r.devices).toHaveLength(1);
    expect(r.devices[0]!.name).toBe('sw1-renamed');
  });

  it('shows only what this account can still see, newest first, at most six', () => {
    let r = EMPTY_RECENT;
    for (let i = 0; i < 9; i++) r = withDesign(r, { organisationId: 'o', designId: `d${i}`, at: i });
    r = withDesign(r, { organisationId: 'o', designId: 'gone', at: 100 });
    r = withDesign(r, { organisationId: 'other', designId: 'd3', at: 101 });
    const listed = Array.from({ length: 9 }, (_, i) => design(`d${i}`));
    const view = visibleRecent(r, 'o', listed);
    expect(view.designs.map((d) => d.design.designId)).toEqual(['d8', 'd7', 'd6', 'd5', 'd4', 'd3']);
  });

  it('hides a device whose design is no longer listed', () => {
    const r = withDevice(EMPTY_RECENT, { organisationId: 'o', designId: 'gone', chassisId: 'c', name: 'x', at: 1 });
    expect(visibleRecent(r, 'o', [design('d1')]).devices).toEqual([]);
  });

  it('forgets what the server no longer lists, for that organisation only', () => {
    let r = withDesign(EMPTY_RECENT, { organisationId: 'o', designId: 'gone', at: 1 });
    r = withDesign(r, { organisationId: 'p', designId: 'elsewhere', at: 2 });
    expect(pruned(r, 'o', [design('d1')]).designs.map((d) => d.designId)).toEqual(['elsewhere']);
  });

  it('survives damaged storage', () => {
    expect(parseRecent('x')).toEqual(EMPTY_RECENT);
    expect(parseRecent({ designs: [{ organisationId: 'o' }, null, { organisationId: 'o', designId: 'd', at: 1 }], devices: 7 })).toEqual({
      designs: [{ organisationId: 'o', designId: 'd', at: 1 }],
      devices: [],
    });
  });
});
