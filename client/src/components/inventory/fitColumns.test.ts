import { describe, expect, it } from 'vitest';
import { fitColumns } from './fitColumns';
import type { Column } from './kinds';

const col = (key: string, width: number): Column => ({ key, label: key, width, editable: false, type: 'text' } as Column);

describe('fitColumns', () => {
  it('keeps every column when they fit', () => {
    expect(fitColumns([col('a', 100), col('b', 100)], 390).map((c) => c.key)).toEqual(['a', 'b']);
  });
  it('drops what does not fit, and the total never passes the width', () => {
    const out = fitColumns([col('name', 200), col('el', 160), col('where', 220), col('x', 140)], 390);
    expect(out.reduce((n, c) => n + c.width, 0)).toBeLessThanOrEqual(390);
    expect(out[0]!.key).toBe('name');
    expect(out.length).toBeLessThan(4);
  });
  it('clamps a first column wider than the window', () => {
    const out = fitColumns([col('name', 600), col('b', 100)], 390);
    expect(out).toHaveLength(1);
    expect(out[0]!.width).toBe(390);
  });
  it('gives the next column the room that is left when it is usable', () => {
    const out = fitColumns([col('name', 200), col('where', 300)], 390);
    expect(out.map((c) => [c.key, c.width])).toEqual([['name', 200], ['where', 190]]);
  });
});
