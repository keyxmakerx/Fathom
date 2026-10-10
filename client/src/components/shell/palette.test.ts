import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { cycleGroup, firstEnabled, highlightParts, matchActions, matchRanges, moveActive, noteOf, type PaletteAction } from './palette';
import { ShortcutsSheet } from './ShortcutsSheet';
import { SHORTCUTS } from './shortcuts';
import { fuzzyHits, mergeHits } from './thingsSearch';
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

describe('which letters were typed', () => {
  it('picks the letters in order: "sw1" underlines the s, w and 1 of switch-1', () => {
    expect(matchRanges('switch-1', 'sw1')).toEqual([0, 1, 7]);
    expect(highlightParts('switch-1', 'sw1')).toEqual([
      { text: 'sw', hit: true },
      { text: 'itch-', hit: false },
      { text: '1', hit: true },
    ]);
  });
  it('prefers the whole query as one run, ignoring case; spaces in the query are skipped', () => {
    expect(matchRanges('Core switch-1', 'SWITCH')).toEqual([5, 6, 7, 8, 9, 10]);
    expect(matchRanges('Add a port to sw-1', 'add port')).toEqual([0, 1, 2, 6, 7, 8, 9]);
  });
  it('says no match, and marks nothing for an empty query', () => {
    expect(matchRanges('switch-1', 'zz')).toBeNull();
    expect(matchRanges('switch-1', '  ')).toBeNull();
    expect(highlightParts('switch-1', 'zz')).toEqual([{ text: 'switch-1', hit: false }]);
  });
  it('lets actions be found by their letters in order, after plain matches', () => {
    const list = [act('trace', 'Trace a path from switch-1'), act('dup', 'Duplicate switch-1'), act('undo', 'Undo')];
    expect(matchActions(list, 'dsw1').map((a) => a.id)).toEqual(['dup']);
    expect(matchActions(list, 'switch').map((a) => a.id)).toEqual(['trace', 'dup']);
    expect(matchActions(list, 'q')).toEqual([]);
  });
});

describe('Tab narrowing', () => {
  const groups = ['Devices', 'Do', 'Go to'];
  it('steps through the groups and back to all', () => {
    expect(cycleGroup(groups, null, 1)).toBe('Devices');
    expect(cycleGroup(groups, 'Devices', 1)).toBe('Do');
    expect(cycleGroup(groups, 'Go to', 1)).toBeNull();
  });
  it('goes the other way with Shift+Tab', () => {
    expect(cycleGroup(groups, null, -1)).toBe('Go to');
    expect(cycleGroup(groups, 'Do', -1)).toBe('Devices');
    expect(cycleGroup(groups, 'Devices', -1)).toBeNull();
    expect(cycleGroup([], null, 1)).toBeNull();
  });
});

describe('a found thing\'s muted words', () => {
  const hit = (over: Partial<SearchHit>): SearchHit => ({ group: 'Devices', name: 'switch-1', why: 'EX4300 · R1 U40', selection: { kind: 'chassis', id: 'c' }, ...over });
  it('shows where it is, rack then unit, and keeps a tag it was found by', () => {
    expect(noteOf(hit({ where: 'R1 · U40' }))).toBe('R1 · U40');
    expect(noteOf(hit({ where: 'R1 · U40', why: 'tag: core' }))).toBe('R1 · U40 · tag: core');
    expect(noteOf(hit({}))).toBe('EX4300 · R1 U40');
  });
  it('finds devices by their letters in order, with their place', () => {
    const view = { racks: [{ id: 'r', label: 'R1', heightU: 42, chassis: [{ id: 'c1', hostname: 'switch-1', model: 'EX', positionU: 40 }, { id: 'c2', hostname: 'router', model: 'MX', positionU: 3 }] }] };
    const hits = fuzzyHits(view as never, 'sw1');
    expect(hits.map((h) => h.name)).toEqual(['switch-1']);
    expect(hits[0]!.where).toBe('R1 · U40');
    expect(fuzzyHits(view as never, 's')).toEqual([]);
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
