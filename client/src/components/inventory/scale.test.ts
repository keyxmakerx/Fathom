// The scale proof: 1,900 devices, 13,000 ports, 5,000 cables. Skipped unless FATHOM_SCALE=1 (it
// builds the estate, which takes seconds). Prints how long each step takes and holds each to a
// generous budget. Run: FATHOM_SCALE=1 npx vitest run src/components/inventory/scale.test.ts

import { describe, expect, it } from 'vitest';

import { viewOf } from '../../document/view';
import { bulkEstate } from './bulkEstate';
import { cableRows, deviceRows, FACETS, allColumns, portRows, rackRows, type Kind } from './kinds';
import { buildPlaceIndex, inWhere } from './placeIndex';
import { filterRows, schemaFor } from './rowQuery';
import { buildSearchIndex, search } from './search';
import { PINNED_VIEWS } from './views';
import { distinctOf } from './facets';
import { sortRows } from './sorting';

const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const on = env.FATHOM_SCALE === '1';

function ms<T>(label: string, out: Record<string, number>, fn: () => T): T {
  const t = performance.now();
  const r = fn();
  out[label] = Math.round((performance.now() - t) * 10) / 10;
  return r;
}

describe.skipIf(!on)('the full estate', () => {
  it('counts, filters and search stay quick', () => {
    const t: Record<string, number> = {};
    const built = ms('build the estate (test support only)', t, () => bulkEstate({ scale: 1 }));
    const { doc, stats } = built;
    const view = ms('viewOf', t, () => viewOf(doc, []));
    const idx = ms('place index', t, () => buildPlaceIndex(doc, view));
    const devices = ms('device rows', t, () => deviceRows(doc, view, [], idx));
    const ports = ms('port rows', t, () => portRows(doc, view, idx, []));
    const cables = ms('cable rows', t, () => cableRows(doc, view, idx, []));
    const racks = ms('rack rows', t, () => rackRows(doc, view, [], idx));
    expect(devices.length).toBe(stats.devices);
    const rows: Record<string, typeof devices> = { devices, ports, cables, racks };

    const schemas = Object.fromEntries((['devices', 'ports', 'racks', 'cables'] as Kind[]).map((k) => [k, schemaFor(k, allColumns(k, []), FACETS[k] ?? [])]));
    // The side list's counts: every saved view, run over its kind.
    ms('side-list counts (all saved views)', t, () => PINNED_VIEWS.map((v) => filterRows(rows[v.kind] ?? [], schemas[v.kind]!, v.q).rows.length));
    ms('Where: one row', t, () => Object.values(rows).map((rs) => rs.filter((r) => inWhere(r.places, { site: 'Northwind', row: 'LON2 Row A', rack: '' })).length));
    ms('filter ports: connector:lc device~tor', t, () => filterRows(ports, schemas.ports!, 'connector:lc device~tor').rows.length);
    ms('filter cables: length>=30 sheath:aqua', t, () => filterRows(cables, schemas.cables!, 'length>=30 sheath:aqua').rows.length);
    ms('filter devices: bare word', t, () => filterRows(devices, schemas.devices!, 'srv00').rows.length);
    ms('filter devices: group and negation', t, () => filterRows(devices, schemas.devices!, '(role:server | role:switch) -rack:LON1-A02 serial^8T').rows.length);
    ms('column menu values (port name)', t, () => distinctOf(ports, schemas.ports!, 'name'));
    ms('sort ports by two columns', t, () => sortRows(ports, [{ key: 'device', dir: 'asc' }, { key: 'name', dir: 'asc' }]).length);

    const ix = ms('build the search index', t, () => buildSearchIndex({ devices, ports, racks, cables, idx }));
    const k = built.known;
    const where = { site: '', row: '', rack: '' };
    ms('find: cable label', t, () => search(ix, k.trunkLabel, where));
    ms('find: serial', t, () => search(ix, k.serial, where));
    ms('find: device and port', t, () => search(ix, `${k.torDevice} 24`, where));
    ms('find: a port name on every device', t, () => search(ix, 'ge-0/0/4', where));
    ms('find: a name fragment', t, () => search(ix, 'srv00', where));
    ms('find: nearest names (no match)', t, () => search(ix, 'lon1-a02-trr1x', where));
    ms('find: MAC', t, () => search(ix, '00:1a:2b:3c:4d:5e', where));

    console.log(`counts: ${stats.devices} devices, ${stats.ports} ports, ${stats.cables} cables, ${stats.racks} racks`);
    console.log(Object.entries(t).map(([a, b]) => `${a}: ${b} ms`).join('\n'));
    for (const [label, took] of Object.entries(t)) {
      if (label.startsWith('build the estate')) continue;
      const budget = /^(viewOf|place index|device rows|port rows|cable rows|rack rows|build the search index)/.test(label) ? 2000 : 250;
      expect(took, label).toBeLessThan(budget);
    }
  }, 120_000);
});
