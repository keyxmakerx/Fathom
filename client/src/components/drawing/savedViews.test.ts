import { describe, expect, it } from 'vitest';

import { defaultLayers } from './layers';
import { addView, layersSummary, MAX_NAME, MAX_VIEWS, parseViews, removeView, renameView, tidyName, viewsKey, type SavedView } from './savedViews';

const view = (id: string, name: string): SavedView => ({ id, name, look: 'rack', camera: { x: 1, y: 2, zoom: 1 }, layers: { ...defaultLayers(), vlans: true } });

describe('saved views', () => {
  it('are per person and design, like the layers', () => {
    expect(viewsKey('a1', 'd1')).toBe('fathom.views.a1.d1');
    expect(viewsKey(null, undefined)).toBe('fathom.views.anon.unsaved');
  });

  it('tidy a name to one short line', () => {
    expect(tidyName('  Core   rack,\n VLANs on ')).toBe('Core rack, VLANs on');
    expect(tidyName('x'.repeat(100))).toHaveLength(MAX_NAME);
    expect(tidyName('   ')).toBe('');
  });

  it('add a view, refusing an empty name, a repeated name and a full list', () => {
    const first = addView([], view('1', 'Core rack'));
    expect('views' in first && first.views).toHaveLength(1);
    expect(addView([view('1', 'Core rack')], view('2', ' core RACK '))).toEqual({ refused: 'A view with that name already exists.' });
    expect(addView([], view('2', '  '))).toEqual({ refused: 'Give the view a name.' });
    const full = Array.from({ length: MAX_VIEWS }, (_, i) => view(String(i), `v${i}`));
    expect('refused' in addView(full, view('x', 'one more'))).toBe(true);
  });

  it('rename and delete', () => {
    const list = [view('1', 'A'), view('2', 'B')];
    const renamed = renameView(list, '1', 'C');
    expect('views' in renamed && renamed.views.map((v) => v.name)).toEqual(['C', 'B']);
    expect(renameView(list, '1', 'b')).toEqual({ refused: 'A view with that name already exists.' });
    expect(renameView(list, '1', 'A')).toHaveProperty('views');
    expect(removeView(list, '1').map((v) => v.id)).toEqual(['2']);
  });

  it('parse keeps whole views and drops damaged ones, with unknown layers dropped', () => {
    const good = { id: 'a', name: 'Core', look: 'diagram', camera: { x: 0, y: 0, zoom: 2 }, layers: { vlans: true, nonsense: true } };
    const parsed = parseViews([good, { id: 'b' }, null, { ...good, id: 'c', look: 'plan' }, { ...good, id: 'a' }, { ...good, id: 'd', camera: { x: 0, y: 0, zoom: 0 } }]);
    expect(parsed.map((v) => v.id)).toEqual(['a']);
    expect(parsed[0]!.layers.vlans).toBe(true);
    expect(parsed[0]!.layers).not.toHaveProperty('nonsense');
    expect(parseViews('x')).toEqual([]);
  });

  it('say which layers a view turns on', () => {
    expect(layersSummary({ ...defaultLayers(), checks: false, vlans: true, tags: true }, { vlans: 'VLANs', tags: 'Tags' })).toBe('VLANs, Tags');
    expect(layersSummary({ ...defaultLayers(), checks: false }, {})).toBe('no layers');
  });
});
