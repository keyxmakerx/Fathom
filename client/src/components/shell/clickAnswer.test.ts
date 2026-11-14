import { describe, expect, it } from 'vitest';

import { CANVAS_PRESS_MS, clickAnswer, nextEscape } from './clickAnswer';
import { cameFromCanvasPress } from './useRightTab';

describe('a click gives one answer (r116)', () => {
  it('is the card while the Details panel is folded, and the panel alone while it is open', () => {
    expect(clickAnswer(false)).toBe('card');
    expect(clickAnswer(true)).toBe('panel');
  });
});

describe('a selection that answers a click on the canvas', () => {
  it('does not open the panel by itself: the card answers', () => {
    expect(cameFromCanvasPress(1000, 900)).toBe(true);
    expect(cameFromCanvasPress(1000, 1000)).toBe(true);
  });
  it('is not a click once the press is old, or when there was none (Ctrl K, a link)', () => {
    expect(cameFromCanvasPress(1000 + CANVAS_PRESS_MS, 1000)).toBe(false);
    expect(cameFromCanvasPress(5000, -Infinity)).toBe(false);
  });
});

describe('Esc steps out one level (r116)', () => {
  it('puts away a peek, then the card, then leaves an opened device, then clears the selection', () => {
    expect(nextEscape({ peek: true, card: true, opened: true, selected: true })).toBe('peek');
    expect(nextEscape({ peek: false, card: true, opened: true, selected: true })).toBe('card');
    expect(nextEscape({ peek: false, card: false, opened: true, selected: true })).toBe('leave');
    expect(nextEscape({ peek: false, card: false, opened: false, selected: true })).toBe('clear');
    expect(nextEscape({ peek: false, card: false })).toBeNull();
  });
});
