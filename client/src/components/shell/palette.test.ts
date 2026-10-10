import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { firstEnabled, matchActions, moveActive, type PaletteAction } from './palette';
import { ShortcutsSheet } from './ShortcutsSheet';
import { SHORTCUTS } from './shortcuts';
import { mergeHits } from './thingsSearch';
import type { SearchHit } from './search';
import { EditableName, renamedValue } from '../drawing/NameEdit';

const act = (id: string, label: string, keywords: string[] = [], disabled?: string): PaletteAction => ({ id, label, keywords, disabled, run: () => {} });
const ACTIONS = [act('add-port', 'Add port', ['interface']), act('undo', 'Undo'), act('delete', 'Delete', ['remove']), act('trace', 'Trace from here', ['path'])];

describe('matchActions', () => {
  it('lists everything for no words, in the order given', () => {
    expect(matchActions(ACTIONS, '  ').map((a) => a.id)).toEqual(['add-port', 'undo', 'delete', 'trace']);
  });
  it('needs every word, in the label or the keywords', () => {
    expect(matchActions(ACTIONS, 'add port').map((a) => a.id)).toEqual(['add-port']);
    expect(matchActions(ACTIONS, 'remove').map((a) => a.id)).toEqual(['delete']);
    expect(matchActions(ACTIONS, 'port undo')).toEqual([]);
  });
  it('puts a label that starts with the word before one that only contains it', () => {
    expect(matchActions(ACTIONS, 'ra').map((a) => a.id)).toEqual(['trace']);
    expect(matchActions(ACTIONS, 'd').map((a) => a.id)).toEqual(['delete', 'add-port', 'undo']);
  });
});

describe('moving over rows', () => {
  const enabled = [false, true, false, true];
  it('skips rows that cannot be chosen and stays at the ends', () => {
    expect(firstEnabled(enabled)).toBe(1);
    expect(moveActive(enabled, 1, 1)).toBe(3);
    expect(moveActive(enabled, 3, 1)).toBe(3);
    expect(moveActive(enabled, 3, -1)).toBe(1);
    expect(moveActive(enabled, 1, -1)).toBe(1);
    expect(firstEnabled([false])).toBe(-1);
  });
});

describe('mergeHits', () => {
  const hit = (group: SearchHit['group'], id: string): SearchHit => ({ group, name: id, why: '', selection: { kind: 'chassis', id } });
  it('drops repeats of the same thing and keeps the usual group order', () => {
    const out = mergeHits([hit('Ports', 'p1'), hit('Devices', 'a')], [hit('Devices', 'a'), hit('Devices', 'b'), hit('Racks', 'r')]);
    expect(out.map((h) => h.name)).toEqual(['a', 'b', 'r', 'p1']);
  });
});

describe('the shortcuts sheet', () => {
  it('lists every shortcut in the table, grouped', () => {
    const markup = renderToStaticMarkup(createElement(ShortcutsSheet, { onClose: () => {} }));
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-label="Keyboard shortcuts"');
    for (const group of ['Canvas', 'Selection', 'Editing', 'Find']) expect(markup).toContain(`<h3 class="shortcuts-sheet__heading">${group}</h3>`);
    for (const s of SHORTCUTS) expect(markup).toContain(s.what.replace(/&/g, '&amp;'));
  });
});

describe('renaming on the canvas', () => {
  it('saves only a name that changed, trimmed', () => {
    expect(renamedValue('sw-01', ' sw-02 ')).toBe('sw-02');
    expect(renamedValue('sw-01', 'sw-01')).toBeNull();
    expect(renamedValue('sw-01', '')).toBe('');
    expect(renamedValue('', '')).toBeNull();
  });

  it('without edit rights a name is plain text: no hint, no handler', () => {
    const markup = renderToStaticMarkup(createElement(EditableName, { target: { kind: 'rack', id: 'rack:1' }, text: 'R1', className: 'n', children: 'R1' }));
    expect(markup).toBe('<span class="n">R1</span>');
  });
});
