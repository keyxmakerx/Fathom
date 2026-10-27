import { describe, expect, it } from 'vitest';

import type { Scope } from '../api/scopes';
import { viewOf } from '../document/view';
import { buildRacksDocument, estatePlan, hasSites, planCounts } from './estate';
import { gateTable } from './gate';
import { readImport } from './read';
import { ACTOR, NOW, fixture, stubRedact } from './testkit';

const gated = async (text: string) => gateTable(readImport(text), stubRedact);
const folder = (id: string, kind: string, name: string, parent: string | null = null): Scope => ({
  scopeId: id,
  parentScopeId: parent,
  kind,
  displayName: name,
  depth: kind === 'network' ? 1 : 2,
  path: parent ? `${parent}.${id}` : id,
  capability: 'steward',
});

describe('a NetBox export fills sites, locations and racks (ADR-0074 §8)', () => {
  it('reads a device export into its site, its locations and the racks devices name', async () => {
    const table = await gated(fixture('netbox-devices.csv'));
    expect(hasSites(table)).toBe(true);
    const plan = estatePlan(table, [], []);
    expect(plan.from).toBe('devices');
    expect(plan.sites.map((s) => s.name)).toEqual(['HQ']);
    const floors = plan.sites[0].locations;
    expect(floors.map((l) => l.name)).toEqual(['Floor 1', 'Floor 2']);
    expect(floors[0].racks.map((r) => [r.name, r.heightU])).toEqual([['R1', 42]]);
    expect(floors[0].racks[0].devices).toBeGreaterThan(1);
    expect(floors[1].racks).toEqual([]);
    expect(planCounts(plan)).toEqual({ sites: 1, buildings: 2, designs: 1, racks: 1 });
  });

  it('reads a rack export by name, with its height, and matches folders already there', async () => {
    const csv = ['name,site,location,status,u_height', 'A01,LON1,Hall 1,active,48', 'A02,LON1,Hall 1,active,', 'B01,MAN1,,active,42', 'X,,,active,42'].join('\n');
    const table = await gated(csv);
    const lon = folder('S-LON', 'network', 'lon1');
    const hall = folder('B-HALL', 'building', 'HALL 1', 'S-LON');
    const plan = estatePlan(table, [lon, hall], ['B-HALL']);
    expect(plan.from).toBe('racks');
    expect(plan.skipped).toBe(1);
    const [london, manchester] = plan.sites;
    expect(london.existing?.scopeId).toBe('S-LON');
    expect(london.locations[0].existing?.scopeId).toBe('B-HALL');
    expect(london.locations[0].hasDesign).toBe(true);
    expect(london.locations[0].racks.map((r) => [r.name, r.heightU])).toEqual([
      ['A01', 48],
      ['A02', 42],
    ]);
    expect(manchester.existing).toBeNull();
    expect(manchester.locations[0].name).toBe('');
    // London's hall already has a design, so only Manchester's racks make one.
    expect(planCounts(plan)).toEqual({ sites: 1, buildings: 0, designs: 1, racks: 1 });
  });

  it('builds one row of racks per location, bays in order', () => {
    const doc = buildRacksDocument('Hall 1', [{ name: 'A01', heightU: 48, devices: 0 }, { name: 'A02', heightU: 42, devices: 0 }], { actor: ACTOR, now: NOW });
    const racks = [...viewOf(doc, []).racks].sort((a, b) => (a.bay ?? 0) - (b.bay ?? 0));
    expect(racks.map((r) => [r.label, r.heightU, r.row, r.bay])).toEqual([
      ['A01', 48, 'Hall 1', 1],
      ['A02', 42, 'Hall 1', 2],
    ]);
  });

  it('never sees a value the gate did not pass', async () => {
    const table = await gated('name,site,location\nR1,HQ password hunter2,Floor 1');
    const plan = estatePlan(table, [], []);
    expect(plan.sites[0].name).not.toContain('hunter2');
  });
});
