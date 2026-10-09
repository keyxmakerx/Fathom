import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { afterEscape, FindResults, panelVisible } from './FindBox';
import { NO_WHERE } from './placeIndex';
import type { InvRow } from './kinds';
import { buildSearchIndex, search } from './search';
import { buildPlaceIndex } from './placeIndex';
import { smallEstate } from './testFixture';
import { cableRows, deviceRows, portRows, rackRows } from './kinds';
import { viewOf } from '../../document/view';

const vlan = (id: number, name: string): InvRow => ({
  key: `vlan:${id}`,
  selection: null,
  ownerId: null,
  cells: { vlan: String(id), label: name, site: 'LON1' },
  tags: [],
  ids: {},
  places: [{ site: 'LON1', row: '', rack: '', rackId: '', u: null }],
  title: `VLAN ${id} · ${name}`,
});

function outcome(clue: string) {
  const e = smallEstate();
  const view = viewOf(e.doc, []);
  const idx = buildPlaceIndex(e.doc, view);
  const ix = buildSearchIndex({
    devices: deviceRows(e.doc, view, [], idx),
    ports: portRows(e.doc, view, idx, []),
    racks: rackRows(e.doc, view, [], idx),
    cables: cableRows(e.doc, view, idx, []),
    idx,
    vlans: [vlan(30, 'Cameras'), vlan(300, 'Cameras-old')],
  });
  return search(ix, clue, NO_WHERE);
}

describe('Find results under the Where bar', () => {
  it('keep the Reading as line and the groups by kind with counts', () => {
    const o = outcome('camer');
    const html = renderToStaticMarkup(createElement(FindResults, { outcome: o, where: NO_WHERE, at: -1, more: new Set<string>(), onMore: () => {}, onChoose: () => {}, onClearWhere: () => {} }));
    expect(html).toContain('Reading as:');
    expect(html).toContain('inv-find__group');
    expect(html).toContain('<span class="inv-find__n">2</span>');
    expect(html).toContain('VLAN 30');
    expect(html).toContain('VLAN 300');
  });

  it('give the list back when the box is cleared or Esc is pressed', () => {
    const o = outcome('camer');
    expect(panelVisible(true, 'camer', o)).toBe(true);
    // Cleared (or only spaces left): no panel.
    expect(panelVisible(true, '', o)).toBe(false);
    expect(panelVisible(true, '   ', o)).toBe(false);
    // Esc: the clue goes and the panel closes, so the panel is hidden whatever comes next.
    const esc = afterEscape();
    expect(esc).toEqual({ value: '', open: false });
    expect(panelVisible(esc.open, esc.value, o)).toBe(false);
    expect(panelVisible(esc.open, 'camer', o)).toBe(false);
  });
});
