import { describe, expect, it } from 'vitest';

import { viewOf } from '../../document/view';
import { cableRows, portRows, rackRows } from './kinds';
import { buildPlaceIndex } from './placeIndex';
import { smallEstate } from './testFixture';
import { totalsOf } from './totals';

describe('totals under a list', () => {
  const e = smallEstate();
  const view = viewOf(e.doc, []);
  const idx = buildPlaceIndex(e.doc, view);

  it('cable length adds up and counts the cables with none', () => {
    const t = totalsOf('cables', cableRows(e.doc, view, idx, []));
    expect(t).toEqual([{ label: 'Cable length', value: '42 m' }]);
  });

  it('free U adds up across racks', () => {
    const rows = rackRows(e.doc, view, [], idx);
    const t = totalsOf('racks', rows);
    const free = rows.reduce((n, r) => n + (r.nums?.free ?? 0), 0);
    expect(t[0]).toEqual({ label: 'Free', value: `${free}U of ${3 * 42}U` });
  });

  it('ports split into cabled and free', () => {
    const rows = portRows(e.doc, view, idx, []);
    const [cabled, free] = totalsOf('ports', rows);
    expect(Number(cabled!.value) + Number(free!.value)).toBe(rows.length);
    expect(cabled!.value).toBe('6');
  });

  it('kinds with no sums say nothing', () => {
    expect(totalsOf('devices', [])).toEqual([]);
  });
});
