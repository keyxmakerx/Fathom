import { describe, expect, it } from 'vitest';

import { distinctOf } from './facets';
import type { InvRow } from './kinds';
import type { FieldSpec } from './query';
import { applySuggestion, suggestAt, wordAt } from './suggest';
import { schemaFor } from './rowQuery';
import type { Column } from './kinds';

const col = (key: string, label: string, extra: Partial<Column> = {}): Column => ({ key, label, width: 100, editable: false, type: 'text', ...extra });
const schema = schemaFor('devices', [col('name', 'Name'), col('role', 'Role'), col('site', 'Site'), col('length', 'Length (m)')]);
const row = (name: string, role: string, site: string, length = ''): InvRow => ({ key: name, selection: null, ownerId: null, cells: { name, role, site, length }, tags: [], ids: {}, title: name });
const ROWS = [row('a', 'switch', 'LON1'), row('b', 'switch', 'LON1'), row('c', 'server', 'MAN1'), row('d', 'Access point', 'MAN1', '5'), row('e', '', 'MAN1')];
const values = (f: string) => distinctOf(ROWS, schema, f);
const fields: FieldSpec[] = schema.fields;

describe('suggestions while typing', () => {
  it('finds the word under the cursor, between spaces, brackets and bars', () => {
    expect(wordAt('role:switch (site:LON1 | na', 27)).toEqual({ start: 25, end: 27 });
    expect(wordAt('role:sw', 7)).toEqual({ start: 0, end: 7 });
  });

  it('suggests fields first, by start and then by label', () => {
    const s = suggestAt('ro', 2, fields, values)!;
    expect(s.items.map((i) => i.main)).toEqual(['role']);
    expect(s.items[0]!.isField).toBe(true);
    const byLabel = suggestAt('length', 6, fields, values)!;
    expect(byLabel.items[0]!.main).toBe('length');
    expect(suggestAt('', 0, fields, values)!.head).toContain('press ?');
  });

  it('after field: suggests values with counts, most common first', () => {
    const s = suggestAt('role:', 5, fields, values)!;
    expect(s.items.map((i) => [i.main, i.count])).toEqual([['switch', 2], ['Access point', 1], ['server', 1], ['empty', 1]]);
    expect(s.head).toContain('4 values');
    expect(s.items.find((i) => i.main === 'Access point')!.insert).toBe('role:"Access point" ');
  });

  it('narrows by what is typed, starts first then contains', () => {
    const s = suggestAt('role:s', 6, fields, values)!;
    expect(s.items.map((i) => i.main)).toEqual(['switch', 'server', 'Access point']);
    expect(suggestAt('role:point', 10, fields, values)!.items.map((i) => i.main)).toEqual(['Access point']);
  });

  it('works after a minus and in a group', () => {
    const s = suggestAt('(role:switch | -site:M', 22, fields, values)!;
    expect(s.items[0]!.insert).toBe('-site:MAN1 ');
  });

  it('a number field offers no values after > but says it takes a number', () => {
    expect(suggestAt('length>', 7, fields, values)).toBeNull();
  });

  it('puts the choice in place of the word and moves the cursor past it', () => {
    const line = 'site:LON1 role:s name~x';
    const s = suggestAt(line, 15, fields, values)!;
    const done = applySuggestion(line, s, s.items[0]!);
    expect(done.line).toBe('site:LON1 role:switch name~x');
    expect(done.line.slice(0, done.cursor)).toBe('site:LON1 role:switch ');
  });

  it('stops suggesting once the value is typed out in full', () => {
    expect(suggestAt('site:LON1', 9, fields, values)).toBeNull();
    expect(suggestAt('site:lon', 8, fields, values)!.items.map((i) => i.main)).toEqual(['LON1']);
  });

  it('says nothing for a word that is not a field or a field being valued', () => {
    expect(suggestAt('"quoted', 7, fields, values)).toBeNull();
    expect(suggestAt('nosuch:x', 8, fields, values)).toBeNull();
  });
});
