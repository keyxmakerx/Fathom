import { describe, expect, it } from 'vitest';

import type { Column, InvRow } from './kinds';
import { parseTable, planPaste } from './paste';

const col = (key: string, label: string, editable = true): Column => ({ key, label, width: 100, editable, type: 'text' });
const columns = [col('name', 'Name'), col('role', 'Role'), col('serial', 'Serial'), col('model', 'Model', false)];
const row = (name: string, cells: Record<string, string> = {}): InvRow => ({
  key: name,
  selection: null,
  ownerId: name,
  cells: { name, ...cells },
  tags: [],
  ids: {},
  title: name,
});

describe('parseTable', () => {
  it('reads tab-separated rows', () => {
    expect(parseTable('a\tb\nc\td\n')).toEqual([['a', 'b'], ['c', 'd']]);
  });
  it('reads CSV with quotes, doubled quotes and a newline inside a cell', () => {
    expect(parseTable('name,note\n"sw, 01","say ""hi""\nthere"\n')).toEqual([['name', 'note'], ['sw, 01', 'say "hi"\nthere']]);
  });
  it('drops blank lines and handles CRLF', () => {
    expect(parseTable('a,b\r\n\r\nc,d\r\n')).toEqual([['a', 'b'], ['c', 'd']]);
  });
});

describe('planPaste', () => {
  it('uses a header row, matches by name and ignores unknown columns', () => {
    const table = parseTable('Name\tRole\tColour\nsw-01\tswitch\tred\nfw-02\tfirewall\tblue');
    const plan = planPaste(table, columns, [row('sw-01', { role: 'router' })], { canAdd: true });
    expect(plan.ignoredHeaders).toEqual(['Colour']);
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0]!.edits).toEqual([{ col: columns[1], value: 'switch' }]);
    expect(plan.adds).toEqual([{ name: 'fw-02', edits: [{ col: columns[1], value: 'firewall' }] }]);
  });
  it('maps headerless cells to the columns left to right', () => {
    const plan = planPaste([['sw-09', 'switch', 'SN1']], columns, [], { canAdd: true });
    expect(plan.adds[0]!.edits.map((e) => e.value)).toEqual(['switch', 'SN1']);
  });
  it('leaves a value alone when the pasted cell is empty or unchanged', () => {
    const plan = planPaste(parseTable('Name\tRole\nsw-01\t'), columns, [row('sw-01', { role: 'switch' })], { canAdd: true });
    expect(plan.updates).toHaveLength(0);
  });
  it('skips new names where nothing can be added', () => {
    const plan = planPaste(parseTable('Name\tRole\nnew\tswitch'), columns, [], { canAdd: false });
    expect(plan.adds).toHaveLength(0);
    expect(plan.skipped).toBe(1);
  });
});
