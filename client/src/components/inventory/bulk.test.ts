import { describe, expect, it } from 'vitest';

import { newUlid } from '../../document/ulid';
import { undo } from '../../document/undo';
import { viewOf } from '../../document/view';
import { applyPlan, dryRun, planSet, planTag } from './bulk';
import { allColumns, deviceRows } from './kinds';
import { buildPlaceIndex } from './placeIndex';
import { smallEstate } from './testFixture';

const actor = newUlid();
const setup = () => {
  const e = smallEstate();
  const view = viewOf(e.doc, []);
  const rows = deviceRows(e.doc, view, [], buildPlaceIndex(e.doc, view));
  const cols = allColumns('devices', []);
  return { e, rows, role: cols.find((c) => c.key === 'role')!, tags: cols.find((c) => c.type === 'tags')! };
};

describe('planning a bulk change', () => {
  it('lists only the rows that change, with before and after, and counts the rest', () => {
    const { rows, role } = setup();
    const plan = planSet(rows, role, ' firewall ');
    expect(plan.title).toBe('Set Role to firewall');
    expect(plan.same).toBe(1);
    expect(plan.lines).toHaveLength(rows.length - 1);
    expect(plan.lines.find((l) => l.row.cells.name === 'lon1-a03-tor1')).toMatchObject({ before: 'switch', after: 'firewall' });
  });

  it('adding a tag skips rows that have it; removing skips rows that lack it', () => {
    const { rows, tags } = setup();
    const add = planTag(rows, tags, 'Lab', 'add');
    expect(add.lines).toHaveLength(rows.length);
    expect(add.lines[0]!.after).toBe('Lab');
    expect(planTag(rows, tags, 'Lab', 'remove').lines).toHaveLength(0);
    expect(planTag(rows, tags, 'Lab', 'remove').same).toBe(rows.length);
  });
});

describe('applying it', () => {
  it('is one undo step, and Undo puts every row back', () => {
    const { e, rows, role } = setup();
    const ctx = { catalogue: [], actor, defs: [] };
    const plan = planSet(rows, role, 'router');
    const out = applyPlan(e.doc, 'devices', plan, ctx);
    expect(out.refused).toEqual([]);
    expect(out.changed).toBe(plan.lines.length);
    expect(out.doc.batches.length).toBe(e.doc.batches.length + 1);
    expect(out.batchId).not.toBeNull();
    const view = viewOf(out.doc, []);
    const after = deviceRows(out.doc, view, [], buildPlaceIndex(out.doc, view));
    expect(after.every((r) => r.cells.role === 'router')).toBe(true);
    const back = undo(out.doc, out.batchId!, { actor, now: Date.now() });
    const v2 = viewOf(back, []);
    const restored = deviceRows(back, v2, [], buildPlaceIndex(back, v2));
    expect(restored.map((r) => r.cells.role)).toEqual(rows.map((r) => r.cells.role));
  });

  it('a dry run names what would be refused without writing', () => {
    const { e, rows, role } = setup();
    const ctx = { catalogue: [], actor, defs: [] };
    const bad = planSet(rows, role, 'not-a-role');
    const refused = dryRun(e.doc, 'devices', bad, ctx);
    expect(refused?.length).toBeGreaterThan(0);
    expect(refused![0]).toContain('Role');
    const out = applyPlan(e.doc, 'devices', bad, ctx);
    expect(out.changed).toBeLessThanOrEqual(0);
    expect(out.doc).toBe(e.doc);
  });
});
