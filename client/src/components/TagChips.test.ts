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

  it('a blank draft offers nothing and no new-tag row', () => {
    const { filtered, showNewRow } = matchSuggestions('   ', SUGGESTIONS, new Set());
    expect(filtered).toEqual([]);
    expect(showNewRow).toBe(false);
  });
});
