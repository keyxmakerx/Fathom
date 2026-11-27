import { describe, expect, it, vi } from 'vitest';

import { matchActions } from './palette';
import { viewActions } from './viewActions';

describe('the four views in the command palette', () => {
  it('names them as the bar does, in its order, under Go to', () => {
    const rows = viewActions({ value: 'canvas', onChange: () => {} });
    expect(rows.map((r) => r.label)).toEqual(['Diagram view', 'Canvas view', 'Inventory view', 'Sheet view']);
    expect(rows.every((r) => r.group === 'go')).toBe(true);
  });

  it('says the one in view is already showing, and goes to any other', () => {
    const onChange = vi.fn();
    const rows = viewActions({ value: 'canvas', onChange });
    expect(rows.find((r) => r.id === 'view-canvas')?.disabled).toBe('Already showing');
    const sheet = rows.find((r) => r.id === 'view-sheet');
    expect(sheet?.disabled).toBeUndefined();
    sheet?.run();
    expect(onChange).toHaveBeenCalledWith('sheet');
  });

  it('is found by the words people type, the older names among them', () => {
    const rows = viewActions({ value: null, onChange: () => {} });
    const first = (typed: string) => matchActions(rows, typed)[0]?.id;
    expect(first('show canvas')).toBe('view-canvas');
    expect(first('racks')).toBe('view-canvas');
    expect(first('spreadsheet')).toBe('view-sheet');
    expect(first('diagram')).toBe('view-diagram');
    expect(first('show inventory')).toBe('view-inventory');
  });
});
