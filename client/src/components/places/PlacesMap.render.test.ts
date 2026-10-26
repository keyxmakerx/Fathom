import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { Scope } from '../../api/scopes';
import { PlacesMap } from './PlacesMap';

const noop = () => undefined;
const s = (id: string, kind: string, parent: string | null, path: string, over: Partial<Scope> = {}): Scope => ({
  scopeId: id,
  parentScopeId: parent,
  kind,
  displayName: id,
  depth: path.split('.').length,
  path,
  capability: 'read',
  ...over,
});
const scopes = [
  s('Northgate', 'network', null, 'N', { placeRole: 'hub', placeForm: 'central_office' }),
  s('Block A', 'building', 'Northgate', 'N.A', { placeForm: 'data_centre' }),
  s('IDF-1', 'rack', 'Block A', 'N.A.1', { placeForm: 'closet' }),
  s('IDF-2', 'rack', 'Block A', 'N.A.2'),
];
const render = (stop: 'building' | 'site' | 'estate', focusId: string | null) =>
  renderToStaticMarkup(
    createElement(PlacesMap, { scopes, currentScopeId: 'IDF-1', stop, focusId, designScopeIds: ['IDF-1'], onGo: noop, onOpenScope: noop, onBack: noop }),
  );

describe('the stops above the closet (ADR-0074)', () => {
  it('the building stop: its closets, where you are, and a closet with no design cannot open', () => {
    const out = render('building', 'Block A');
    expect(out).toContain('Every site');
    expect(out).toContain('Northgate');
    expect(out).toContain('You are here');
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>.*IDF-2/);
    expect(out).toContain('room builder');
  });

  it('the site stop: its buildings and their kind, the site marked a hub', () => {
    const out = render('site', 'Northgate');
    expect(out).toContain('Block A');
    expect(out).toContain('Datacenter');
    expect(out).toContain('2 closets · 1 design');
    expect(out).toContain('places-map__role places-map__role--hub');
  });

  it('the estate: the hub has a double border', () => {
    expect(render('estate', null)).toContain('places-box places-box--hub');
  });
});
