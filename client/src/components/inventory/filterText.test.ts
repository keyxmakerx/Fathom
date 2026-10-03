import { describe, expect, it } from 'vitest';

import { parseFilterText } from './filterText';
import type { Column } from './kinds';

const col = (key: string, label: string): Column => ({ key, label, width: 100, editable: false, type: 'text' });
const columns = [col('name', 'Name'), col('model', 'Model'), col('tags', 'Tags'), col('field:01ABC', 'Rack owner')];

describe('parseFilterText', () => {
  it('reads tag: as the Tags column, in any case and plural', () => {
    expect(parseFilterText('tag:edge', columns, '*')).toEqual({ col: 'tags', value: 'edge' });
    expect(parseFilterText('TAGS: edge ', columns, '*')).toEqual({ col: 'tags', value: 'edge' });
  });

  it('reads a column label, including a custom field with a space', () => {
    expect(parseFilterText('model:ex4300', columns, '*')).toEqual({ col: 'model', value: 'ex4300' });
    expect(parseFilterText('Rack owner:ops', columns, '*')).toEqual({ col: 'field:01ABC', value: 'ops' });
  });

  it('keeps the whole text for the menu column when the word is no column', () => {
    expect(parseFilterText('10.0.0.1:443', columns, '*')).toEqual({ col: '*', value: '10.0.0.1:443' });
    expect(parseFilterText('edge', columns, 'name')).toEqual({ col: 'name', value: 'edge' });
  });

  it('keeps the text when nothing follows the colon, and ignores empty input', () => {
    expect(parseFilterText('tag:', columns, '*')).toEqual({ col: '*', value: 'tag:' });
    expect(parseFilterText('   ', columns, '*')).toBeNull();
  });
});
