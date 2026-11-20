import { describe, expect, it } from 'vitest';

import { CANVAS_PRESS_MS, clickAnswer, nextEscape, openAbove } from './clickAnswer';
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

  // Search, a sheet or a panel opened over the canvas is the top level: its Esc must not put the card away first.
  it('answers nothing on the canvas while something floats over the page', () => {
    expect(nextEscape({ above: true, peek: true, card: true, opened: true, selected: true })).toBeNull();
    expect(nextEscape({ above: false, peek: false, card: true })).toBe('card');
  });

  it('counts any dialog or open menu as floating over the page, except the canvas\'s own card', () => {
    const asked: string[] = [];
    const page = (found: boolean) => ({ querySelector: (selector: string) => (asked.push(selector), found ? ({} as Element) : null) });
    expect(openAbove(page(true))).toBe(true);
    expect(openAbove(page(false))).toBe(false);
    // On the page itself this is checked by the sample's drive: a selector that matches nothing reads as
    // "nothing is open", and no test here has a page to ask. A menu inside a shut `<details>` is left out: the
    // More list in Details is one, and counted, it sent the Esc for a hover card on to close Details as well.
    expect(asked[0]).toBe('[role="dialog"]:not(.quick-card), [role="menu"]:not(details:not([open]) *)');
  });
});
