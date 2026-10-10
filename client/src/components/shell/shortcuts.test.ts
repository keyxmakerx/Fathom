import { describe, expect, it } from 'vitest';

import { SHORTCUTS, SHORTCUT_GROUPS, capsFor, isTypingTarget, matches, shortcutText } from './shortcuts';

function key(k: string, extra: Partial<KeyboardEvent> = {}) {
  return { key: k, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...extra };
}

describe('the shortcuts table', () => {
  it('has unique ids and every group is used', () => {
    expect(new Set(SHORTCUTS.map((s) => s.id)).size).toBe(SHORTCUTS.length);
    for (const g of SHORTCUT_GROUPS) expect(SHORTCUTS.some((s) => s.group === g)).toBe(true);
  });

  it('matches the keys its entries name', () => {
    expect(matches(key('d', { ctrlKey: true }), 'duplicate')).toBe(true);
    expect(matches(key('D', { metaKey: true }), 'duplicate')).toBe(true);
    expect(matches(key('d'), 'duplicate')).toBe(false);
    expect(matches(key('z', { ctrlKey: true }), 'undo')).toBe(true);
    expect(matches(key('Z', { ctrlKey: true, shiftKey: true }), 'undo')).toBe(false);
    expect(matches(key('Z', { ctrlKey: true, shiftKey: true }), 'redo')).toBe(true);
    expect(matches(key('?', { shiftKey: true }), 'shortcuts')).toBe(true);
    expect(matches(key('?', { ctrlKey: true }), 'shortcuts')).toBe(false);
    expect(matches(key('ArrowUp'), 'nudge-up')).toBe(true);
    expect(matches(key('d', { ctrlKey: true, altKey: true }), 'duplicate')).toBe(false);
  });

  it('Alt+Left goes back and Alt+Right goes forward, and only with Alt held', () => {
    expect(matches(key('ArrowLeft', { altKey: true }), 'go-back')).toBe(true);
    expect(matches(key('ArrowRight', { altKey: true }), 'go-forward')).toBe(true);
    expect(matches(key('ArrowLeft'), 'go-back')).toBe(false);
    expect(matches(key('ArrowLeft', { altKey: true }), 'go-forward')).toBe(false);
    // The arrow keys' other jobs ignore Alt.
    expect(matches(key('ArrowLeft', { altKey: true }), 'nudge-left')).toBe(false);
    expect(shortcutText('go-back', false)).toBe('Alt+Left');
  });

  it('a gesture has no key to match', () => {
    expect(matches(key('Enter'), 'rename')).toBe(false);
  });

  it('writes Cmd for Ctrl on a Mac', () => {
    expect(capsFor(['Ctrl', 'K'], true)).toEqual(['Cmd', 'K']);
    expect(shortcutText('find', false)).toBe('Ctrl+K');
  });

  it('knows when someone is typing', () => {
    expect(isTypingTarget({ tagName: 'INPUT' } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV' } as unknown as EventTarget)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});
