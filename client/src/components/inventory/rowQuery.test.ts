import { describe, expect, it } from 'vitest';

import type { Column, InvRow } from './kinds';
import { filterRows, schemaFor, slug } from './rowQuery';

const col = (key: string, label: string, extra: Partial<Column> = {}): Column => ({ key, label, width: 100, editable: false, type: 'text', ...extra });
const COLS = [col('name', 'Name'), col('role', 'Role'), col('height', 'Height (U)'), col('tags', 'Tags', { type: 'tags' }), col('field:01H', 'Warranty ends', { type: 'date' }), col('field:02H', 'Rack units', { type: 'number' })];
const row = (name: string, role: string, height: string, tags: string[], extra: Record<string, string> = {}): InvRow => ({
  key: name,
  selection: null,
  ownerId: null,
  cells: { name, role, height, tags: tags.join(', '), ...extra },
  tags,
  ids: {},
  title: name,
});
const ROWS = [row('r1', 'Switch', '42', ['prod'], { 'field:01H': '2027-03-01', 'field:02H': '2' }), row('r2', 'Router', '24', [], { 'field:02H': '10' }), row('r3', 'Switch', '', ['prod', 'lab'])];

describe('queries over Inventory rows', () => {
  const schema = schemaFor('racks', COLS);

  it('a custom field is asked about by its name', () => {
    expect(slug('Warranty ends')).toBe('warranty_ends');
    expect(schema.fields.map((f) => f.key)).toContain('warranty_ends');
    expect(filterRows(ROWS, schema, 'warranty_ends:any').rows.map((r) => r.key)).toEqual(['r1']);
  });

  it('numeric columns compare as numbers, and blanks never match', () => {
    expect(filterRows(ROWS, schema, 'height>30').rows.map((r) => r.key)).toEqual(['r1']);
    expect(filterRows(ROWS, schema, 'rack_units>=10').rows.map((r) => r.key)).toEqual(['r2']);
    expect(filterRows(ROWS, schema, 'height<=24').rows.map((r) => r.key)).toEqual(['r2']);
  });

  it('tags are many values', () => {
    expect(filterRows(ROWS, schema, 'tags:lab').rows.map((r) => r.key)).toEqual(['r3']);
    expect(filterRows(ROWS, schema, 'tags:empty').rows.map((r) => r.key)).toEqual(['r2']);
  });

  it('a bare word searches every cell', () => {
    expect(filterRows(ROWS, schema, 'router').rows.map((r) => r.key)).toEqual(['r2']);
  });

  it('a bad term is named and the rest still filters', () => {
    const f = filterRows(ROWS, schema, 'role:switch colour:red');
    expect(f.rows.map((r) => r.key)).toEqual(['r1', 'r3']);
    expect(f.parsed.errors[0]!.raw).toBe('colour:red');
  });
});
