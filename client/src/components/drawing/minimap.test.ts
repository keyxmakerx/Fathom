import { describe, expect, it } from 'vitest';

import { BIG_NODE_COUNT, isBigDrawing } from './minimap';

const pane = { width: 1000, height: 600 };

describe('isBigDrawing', () => {
  it('is small when it fits the window with few boxes', () => {
    expect(isBigDrawing({ nodeCount: 6, content: { width: 800, height: 500 }, pane })).toBe(false);
  });

  it('is big past forty boxes, however small they are', () => {
    expect(isBigDrawing({ nodeCount: BIG_NODE_COUNT, content: { width: 100, height: 100 }, pane })).toBe(false);
    expect(isBigDrawing({ nodeCount: BIG_NODE_COUNT + 1, content: { width: 100, height: 100 }, pane })).toBe(true);
  });

  it('is big when the content is more than twice the window, across or down', () => {
    expect(isBigDrawing({ nodeCount: 5, content: { width: 2000, height: 100 }, pane })).toBe(false);
    expect(isBigDrawing({ nodeCount: 5, content: { width: 2001, height: 100 }, pane })).toBe(true);
    expect(isBigDrawing({ nodeCount: 5, content: { width: 100, height: 1300 }, pane })).toBe(true);
  });

  it('does not guess when the sizes are not known yet', () => {
    expect(isBigDrawing({ nodeCount: 5, content: null, pane })).toBe(false);
    expect(isBigDrawing({ nodeCount: 5, content: { width: 9000, height: 9000 }, pane: null })).toBe(false);
    expect(isBigDrawing({ nodeCount: 5, content: { width: 9000, height: 9000 }, pane: { width: 0, height: 0 } })).toBe(false);
  });
});
