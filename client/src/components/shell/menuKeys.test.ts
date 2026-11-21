import { describe, expect, it } from 'vitest';

import { MENU_ROWS, rowAfter, usesArrows } from './menuKeys';

const key = (name: string, held: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey', boolean>> = {}) => ({
  key: name,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...held,
});

describe('the arrow keys in an open menu', () => {
  it('step through the rows: Down and Right on, Up and Left back', () => {
    expect(rowAfter(key('ArrowDown'), 0, 4)).toBe(1);
    expect(rowAfter(key('ArrowRight'), 1, 4)).toBe(2);
    expect(rowAfter(key('ArrowUp'), 2, 4)).toBe(1);
    expect(rowAfter(key('ArrowLeft'), 1, 4)).toBe(0);
  });

  it('go round at the ends', () => {
    expect(rowAfter(key('ArrowDown'), 3, 4)).toBe(0);
    expect(rowAfter(key('ArrowRight'), 3, 4)).toBe(0);
    expect(rowAfter(key('ArrowUp'), 0, 4)).toBe(3);
    expect(rowAfter(key('ArrowLeft'), 0, 4)).toBe(3);
  });

  it('Home and End go to the first row and the last', () => {
    expect(rowAfter(key('Home'), 2, 4)).toBe(0);
    expect(rowAfter(key('End'), 1, 4)).toBe(3);
  });

  it('from the button that opened the menu, Down goes to the first row and Up to the last', () => {
    expect(rowAfter(key('ArrowDown'), -1, 4)).toBe(0);
    expect(rowAfter(key('ArrowUp'), -1, 4)).toBe(3);
  });

  it('and no other key moves from that button: it is a button in a row of buttons', () => {
    for (const name of ['ArrowLeft', 'ArrowRight', 'Home', 'End']) expect(rowAfter(key(name), -1, 4)).toBeNull();
  });

  it('a menu of one row stays on it', () => {
    expect(rowAfter(key('ArrowDown'), 0, 1)).toBe(0);
    expect(rowAfter(key('ArrowUp'), 0, 1)).toBe(0);
  });

  it('do nothing in a menu with no rows', () => {
    expect(rowAfter(key('ArrowDown'), -1, 0)).toBeNull();
    expect(rowAfter(key('End'), 0, 0)).toBeNull();
  });

  it('leave every other key alone: Tab, Enter, Space, Escape, a letter', () => {
    for (const name of ['Tab', 'Enter', ' ', 'Escape', 'a', 'PageDown', 'Delete', 'Backspace']) expect(rowAfter(key(name), 1, 4)).toBeNull();
  });

  it('are not the menu\'s with Ctrl, Cmd, Alt or Shift held', () => {
    for (const held of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey'] as const) {
      expect(rowAfter(key('ArrowDown', { [held]: true }), 1, 4)).toBeNull();
      expect(rowAfter(key('Home', { [held]: true }), 1, 4)).toBeNull();
    }
  });
});

describe('what uses the arrow keys itself', () => {
  it('a field to type in, a list, a slider and radio buttons do', () => {
    expect(usesArrows({ tagName: 'INPUT', type: 'text' })).toBe(true);
    expect(usesArrows({ tagName: 'INPUT' })).toBe(true);
    expect(usesArrows({ tagName: 'INPUT', type: 'search' })).toBe(true);
    expect(usesArrows({ tagName: 'INPUT', type: 'number' })).toBe(true);
    expect(usesArrows({ tagName: 'INPUT', type: 'range' })).toBe(true);
    expect(usesArrows({ tagName: 'INPUT', type: 'radio' })).toBe(true);
    expect(usesArrows({ tagName: 'TEXTAREA' })).toBe(true);
    expect(usesArrows({ tagName: 'SELECT' })).toBe(true);
    expect(usesArrows({ tagName: 'DIV', isContentEditable: true })).toBe(true);
  });

  it('a button, a link and a tick box do not', () => {
    expect(usesArrows({ tagName: 'BUTTON' })).toBe(false);
    expect(usesArrows({ tagName: 'A' })).toBe(false);
    expect(usesArrows({ tagName: 'INPUT', type: 'checkbox' })).toBe(false);
    expect(usesArrows({ tagName: 'INPUT', type: 'CHECKBOX' })).toBe(false);
    expect(usesArrows({ tagName: 'DIV', isContentEditable: false })).toBe(false);
    expect(usesArrows(null)).toBe(false);
  });

  it('the rows are what Tab stops on: buttons, links and fields that are not off', () => {
    expect(MENU_ROWS).toContain('button:not(:disabled)');
    expect(MENU_ROWS).toContain('a[href]');
    expect(MENU_ROWS).toContain('input:not(:disabled)');
  });
});
