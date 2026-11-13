import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { DataTable, type DataTableProps } from './DataTable';
import type { Column, InvRow } from './kinds';

const noop = () => {};
const columns: Column[] = [
  { key: 'name', label: 'Name', width: 150, editable: true, type: 'text' } as Column,
  { key: 'model', label: 'Model', width: 120, editable: false, type: 'text' } as Column,
];
const row = (name: string): InvRow => ({ key: name, selection: null, ownerId: null, cells: { name, model: 'C9300' }, tags: [], ids: {}, title: name });

const render = (over: Partial<DataTableProps> = {}) =>
  renderToStaticMarkup(
    createElement(DataTable, {
      columns,
      rows: [row('core-1'), row('edge-2')],
      openKey: null,
      checked: new Set<string>(),
      sorts: [],
      canEdit: true,
      onCommit: noop,
      onOpen: noop,
      onToggleChecked: noop,
      onToggleAll: noop,
      onSort: noop,
      emptyText: 'None',
      ...over,
    }),
  );

describe('The Sheet stays a spreadsheet (r127)', () => {
  it('gives each row a small open button in its first cell, so a click in the grid can just select', () => {
    const html = render({ sheet: true });
    expect(html).toContain('aria-label="Open core-1"');
    expect(html).toContain('aria-label="Open edge-2"');
    expect(html).toContain('title="Open its page (Ctrl Enter)"');
    // Only the first column carries it.
    expect(html.match(/inv-table__open/g)?.length).toBe(2);
  });

  it('Inventory keeps its list, where a click on the name opens the page, without the button', () => {
    const html = render();
    expect(html).not.toContain('inv-table__open');
    expect(html).toContain('core-1');
  });
});
