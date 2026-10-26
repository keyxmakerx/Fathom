import { describe, expect, it } from 'vitest';

import type { Scope } from '../../api/scopes';
import { FOLD_AT, ancestorOfKind, focusFor, mapView, upperStopsFor } from './placesMap';

const scope = (id: string, kind: string, parent: Scope | null, over: Partial<Scope> = {}): Scope => ({
  scopeId: id,
  parentScopeId: parent?.scopeId ?? null,
  kind,
  displayName: id,
  depth: parent ? parent.depth + 1 : 1,
  path: parent ? `${parent.path}.${id}` : id,
  capability: 'read',
  ...over,
});

const hub = scope('Northgate', 'network', null, { placeRole: 'hub' });
const blockA = scope('BlockA', 'building', hub);
const blockB = scope('BlockB', 'building', hub);
const idf1 = scope('IDF1', 'rack', blockA);
const idf2 = scope('IDF2', 'rack', blockA);
const branch = scope('Riverside', 'network', null, { placeRole: 'branch' });
const all = [hub, blockA, blockB, idf1, idf2, branch];

describe('the stops above the closet (ADR-0074)', () => {
  it('opens the building, site and estate from a closet, and only the stops that exist', () => {
    expect(upperStopsFor(all, 'IDF1')).toEqual(['building', 'site', 'estate']);
    expect(upperStopsFor(all, 'Riverside')).toEqual(['site', 'estate']);
    expect(upperStopsFor([idf1], 'IDF1')).toEqual([]);
    expect(focusFor(all, 'building', 'IDF1')).toBe('BlockA');
    expect(focusFor(all, 'site', 'IDF1')).toBe('Northgate');
    expect(ancestorOfKind(all, 'BlockA', 'building')?.scopeId).toBe('BlockA');
  });

  it('draws a building\'s closets, with designs counted and where you are marked', () => {
    const view = mapView(all, 'building', 'BlockA', 'IDF1', ['IDF1', 'IDF1', 'BlockB']);
    expect(view.boxes.map((b) => [b.scope.scopeId, b.designs, b.here])).toEqual([
      ['IDF1', 2, true],
      ['IDF2', 0, false],
    ]);
  });

  it('draws a site\'s buildings, counting designs in their closets', () => {
    const view = mapView(all, 'site', 'Northgate', 'IDF1', ['IDF1', 'IDF2', 'BlockB']);
    expect(view.place?.scopeId).toBe('Northgate');
    expect(view.boxes.map((b) => [b.scope.scopeId, b.inside, b.designs, b.here])).toEqual([
      ['BlockA', 2, 2, true],
      ['BlockB', 0, 1, false],
    ]);
  });

  it('folds many small sites into a counted stack, never the hub or the one you are in', () => {
    const branches = Array.from({ length: FOLD_AT + 2 }, (_, i) => scope(`B${String(i).padStart(2, '0')}`, 'network', null, { placeRole: 'branch' }));
    const scopes = [hub, blockA, idf1, ...branches];
    const view = mapView(scopes, 'estate', null, 'B03', []);
    expect(view.boxes.map((b) => b.scope.scopeId)).toEqual(['B03', 'Northgate']);
    expect(view.stacks).toHaveLength(1);
    expect(view.stacks[0].boxes).toHaveLength(FOLD_AT + 1);
    // A few branches do not fold.
    expect(mapView(all, 'estate', null, 'IDF1', []).stacks).toEqual([]);
  });

  it('shows nothing it was not sent', () => {
    expect(mapView(all, 'site', 'NoSuchSite', 'IDF1', []).boxes).toEqual([]);
  });
});
