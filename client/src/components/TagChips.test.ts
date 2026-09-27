import { describe, expect, it } from 'vitest';

import { matchSuggestions } from './TagChips';

const SUGGESTIONS = [
  { name: 'core', count: 3 },
  { name: 'core-network', count: 1 },
  { name: 'lobby', count: 2 },
];

describe('matchSuggestions', () => {
  it('a prefix that is not an exact match defaults the highlight to the new-tag row, not the suggestion', () => {
    const { filtered, showNewRow, defaultHighlight } = matchSuggestions('co', SUGGESTIONS, new Set());
    expect(filtered.map((s) => s.name)).toEqual(['core', 'core-network']);
    expect(showNewRow).toBe(true);
    expect(defaultHighlight).toBe(filtered.length); // the new-tag row, not "core"
  });

  it('an exact match (ignoring case) defaults the highlight to that row, and offers no new-tag row', () => {
    const { filtered, showNewRow, defaultHighlight } = matchSuggestions('Core', SUGGESTIONS, new Set());
    expect(showNewRow).toBe(false);
    expect(defaultHighlight).toBe(filtered.findIndex((s) => s.name === 'core'));
  });

  it('a suggestion already on the object is not offered', () => {
    const { filtered } = matchSuggestions('core', SUGGESTIONS, new Set(['core']));
    expect(filtered.map((s) => s.name)).toEqual(['core-network']);
  });

  it('compares by the tag fold, so full-width letters and ß find the existing tag', () => {
    const tags = [...SUGGESTIONS, { name: 'Straße', count: 1 }];
    const wide = matchSuggestions('\uff23\uff2f\uff32\uff25', tags, new Set()); // full-width CORE
    expect(wide.showNewRow).toBe(false);
    expect(wide.filtered[wide.defaultHighlight]?.name).toBe('core');
    const sharp = matchSuggestions('STRASSE', tags, new Set());
    expect(sharp.showNewRow).toBe(false);
    expect(sharp.filtered[sharp.defaultHighlight]?.name).toBe('Straße');
  });

  it('a suggestion already on the object under another spelling is not offered', () => {
    const { filtered } = matchSuggestions('stra', [{ name: 'Straße', count: 1 }], new Set(['strasse']));
    expect(filtered).toEqual([]);
  });

  it('inner spaces in the draft collapse before comparing', () => {
    const { showNewRow, filtered, defaultHighlight } = matchSuggestions('core   network', [{ name: 'core network', count: 1 }], new Set());
    expect(showNewRow).toBe(false);
    expect(filtered[defaultHighlight]?.name).toBe('core network');
  });

  it('a blank draft offers nothing and no new-tag row', () => {
    const { filtered, showNewRow } = matchSuggestions('   ', SUGGESTIONS, new Set());
    expect(filtered).toEqual([]);
    expect(showNewRow).toBe(false);
  });
});
