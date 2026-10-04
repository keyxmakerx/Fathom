import { describe, expect, it } from 'vitest';

import { buildCableScheduleRows, CABLE_SCHEDULE_COLUMNS } from './cableSchedule';
import type { ClosetView } from '../document/view';
import { emptyDocument } from '../document/model';

describe('buildCableScheduleRows', () => {
  it('writes type and colour as words, absent as a dash, both ends named', () => {
    const view = {
      racks: [],
      surfaces: [],
      unplaced: [],
      rows: [],
      cables: [
        { id: 'c1', kind: 'fibre', media: 'om4', sheath: 'aqua', label: 'F-1', lengthM: 3, ends: [{ outside: true, label: 'ISP' }, { outside: true, label: '' }] },
        { id: 'c2', kind: 'copper', media: '', sheath: null, label: null, ends: [] },
      ],
    } as unknown as ClosetView;
    const rows = buildCableScheduleRows(emptyDocument(), view).map((r) => r.row.cells);
    expect(rows[0]).toEqual(['F-1', 'Fibre · om4', 'aqua', '3 m', 'outside · ISP', 'outside', '']);
    expect(rows[1]).toEqual(['—', 'Copper', '—', '—', '—', '—', '']);
    expect(rows[0]).toHaveLength(CABLE_SCHEDULE_COLUMNS.length);
  });
});
