// Whose a plain key is (`keyOwner.ts`): with a device selected, Up and Down moved it, and Delete removed it, while
// the keyboard was on a button outside the drawing that Tab had gone to, or on one with its menu open.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { beforeEach, describe, expect, it } from 'vitest';

import { OPEN_LAYER, OPEN_MODAL, keysToSelection, noteInput, plainKeyIsElsewhere } from './keyOwner';

const el = (tagName: string) => ({ tagName }) as unknown as Element;
const body = el('BODY');
/** A button in a panel, outside the drawing. */
const button = el('BUTTON');
/** A device on the canvas. */
const node = el('DIV');
const drawing = { contains: (other: Node | null) => (other as unknown) === node };

const key = (name: string, on: Element, more: Partial<Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'defaultPrevented'>> = {}) => ({
  key: name,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  defaultPrevented: false,
  target: on,
  ...more,
});

type Holder = { contains: (other: Node | null) => boolean };
/** A menu or a dialog on the page, and what it holds. */
const layer = (...holds: unknown[]): Holder => ({ contains: (other) => holds.includes(other) });
/** The page, with the menus and dialogs open on it, and the dialogs that cover it. */
const page = (open: { layers?: Holder[]; modals?: Holder[] }) => ({
  querySelectorAll: (selectors: string) => (selectors === OPEN_MODAL ? (open.modals ?? []) : selectors === OPEN_LAYER ? (open.layers ?? []) : []),
});

/** Tab is pressed and the focus moves with it. */
function tabTo(): void {
  noteInput({ type: 'keydown', key: 'Tab' });
  noteInput({ type: 'focusin' });
  noteInput({ type: 'keyup', key: 'Tab' });
}

const PLAIN = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Delete', 'Backspace'];

describe('whose an arrow key, Delete or Backspace is', () => {
  // The walk is kept between presses: every test starts from a press with the pointer.
  beforeEach(() => noteInput({ type: 'pointerdown' }));

  it('is the selection after a press with the pointer, whatever button the press left the focus on', () => {
    for (const name of PLAIN) expect(plainKeyIsElsewhere(key(name, button), drawing)).toBe(false);
  });

  it('is the button the keyboard walked to with Tab, and not the selection', () => {
    tabTo();
    for (const name of PLAIN) expect(plainKeyIsElsewhere(key(name, button), drawing)).toBe(true);
    // Shift is the larger step of the same key.
    expect(plainKeyIsElsewhere(key('ArrowUp', button, { shiftKey: true }), drawing)).toBe(true);
  });

  it('is the selection again once the pointer is pressed anywhere', () => {
    tabTo();
    noteInput({ type: 'pointerdown' });
    for (const name of PLAIN) expect(plainKeyIsElsewhere(key(name, button), drawing)).toBe(false);
  });

  it('is the selection while the keyboard is on the drawing or on nothing, walked there or not', () => {
    tabTo();
    for (const name of PLAIN) {
      expect(plainKeyIsElsewhere(key(name, node), drawing)).toBe(false);
      expect(plainKeyIsElsewhere(key(name, body), drawing)).toBe(false);
      expect(plainKeyIsElsewhere(key(name, el('HTML')), drawing)).toBe(false);
      expect(plainKeyIsElsewhere({ ...key(name, button), target: null }, drawing)).toBe(false);
    }
  });

  it('is the control that used it, walked to or not: the Back list moves its own focus with the arrows', () => {
    expect(plainKeyIsElsewhere(key('ArrowDown', button, { defaultPrevented: true }), drawing)).toBe(true);
    // On the canvas a node stops an arrow's scroll and leaves the move to the drawing.
    expect(plainKeyIsElsewhere(key('ArrowDown', node, { defaultPrevented: true }), drawing)).toBe(false);
  });

  it('leaves every other key, and every key with Ctrl, Cmd or Alt, as it was', () => {
    tabTo();
    for (const name of ['Escape', 'Enter', ' ', 'z', 'Tab', 'Home']) expect(plainKeyIsElsewhere(key(name, button), drawing)).toBe(false);
    for (const held of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      expect(plainKeyIsElsewhere(key('ArrowUp', button, held), drawing)).toBe(false);
      expect(plainKeyIsElsewhere(key('Backspace', button, held), drawing)).toBe(false);
    }
  });

  it('does not take a Tab that moves no focus for a walk: Search keeps Tab to narrow its list', () => {
    noteInput({ type: 'keydown', key: 'Tab' });
    noteInput({ type: 'keyup', key: 'Tab' });
    // The focus moves later, by itself: Search closes and gives it back.
    noteInput({ type: 'focusin' });
    expect(plainKeyIsElsewhere(key('ArrowUp', button), drawing)).toBe(false);
  });

  it('does not take a focus moved by anything but Tab for a walk', () => {
    noteInput({ type: 'focusin' });
    noteInput({ type: 'keydown', key: 'Enter' });
    noteInput({ type: 'focusin' });
    noteInput({ type: 'keyup', key: 'Enter' });
    expect(plainKeyIsElsewhere(key('ArrowUp', button), drawing)).toBe(false);
    // Ctrl+Tab and Alt+Tab go to another tab or window, and the focus comes back when the person does.
    for (const held of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }]) {
      noteInput({ type: 'keydown', key: 'Tab', ...held });
      noteInput({ type: 'focusin' });
      noteInput({ type: 'keyup', key: 'Tab', ...held });
    }
    expect(plainKeyIsElsewhere(key('ArrowUp', button), drawing)).toBe(false);
  });

  it('counts Shift+Tab as Tab: the walk goes both ways', () => {
    noteInput({ type: 'keydown', key: 'Shift' });
    noteInput({ type: 'keydown', key: 'Tab' });
    noteInput({ type: 'focusin' });
    expect(plainKeyIsElsewhere(key('Delete', button), drawing)).toBe(true);
  });

  it('gives the keys back to the selection when a thing is picked in Search', () => {
    tabTo();
    keysToSelection();
    expect(plainKeyIsElsewhere(key('ArrowUp', button), drawing)).toBe(false);
    // The next Tab is a walk again.
    tabTo();
    expect(plainKeyIsElsewhere(key('ArrowUp', button), drawing)).toBe(true);
  });

  it('treats a surface that is not on the page as holding nothing', () => {
    tabTo();
    expect(plainKeyIsElsewhere(key('Delete', button), null)).toBe(true);
    expect(plainKeyIsElsewhere(key('Delete', body), null)).toBe(false);
  });

  it('is not the selection while a menu or a dialog is open, on the button a press with the pointer opened it from', () => {
    const open = page({ layers: [layer()] });
    for (const name of PLAIN) expect(plainKeyIsElsewhere(key(name, button), drawing, open)).toBe(true);
    // The same button with nothing open: the press left the keys with the selection.
    for (const name of PLAIN) expect(plainKeyIsElsewhere(key(name, button), drawing, page({}))).toBe(false);
  });

  it('is the selection with the keyboard on the drawing or on nothing, whatever is open beside it', () => {
    // A panel that does not cover the page stays open while a device is pressed and deleted.
    const open = page({ layers: [layer()] });
    for (const name of PLAIN) {
      expect(plainKeyIsElsewhere(key(name, node), drawing, open)).toBe(false);
      expect(plainKeyIsElsewhere(key(name, body), drawing, open)).toBe(false);
    }
  });

  it('is not the selection under a dialog that covers the page, wherever the keyboard was left', () => {
    const open = page({ modals: [layer()] });
    for (const name of PLAIN) {
      expect(plainKeyIsElsewhere(key(name, node), drawing, open)).toBe(true);
      expect(plainKeyIsElsewhere(key(name, body), drawing, open)).toBe(true);
      expect(plainKeyIsElsewhere(key(name, button), drawing, open)).toBe(true);
    }
    expect(plainKeyIsElsewhere(key('Delete', body), null, open)).toBe(true);
  });

  it('does not count a menu inside the drawing, or a dialog the drawing is shown in', () => {
    const ownMenu = layer();
    const withMenu: Holder = { contains: (other) => (other as unknown) === node || (other as unknown) === ownMenu };
    expect(plainKeyIsElsewhere(key('ArrowUp', button), withMenu, page({ layers: [ownMenu] }))).toBe(false);
    const around = layer(drawing, node);
    expect(plainKeyIsElsewhere(key('ArrowUp', node), drawing, page({ modals: [around] }))).toBe(false);
    expect(plainKeyIsElsewhere(key('ArrowUp', button), drawing, page({ layers: [around] }))).toBe(false);
  });

  it('leaves every other key as it was with a menu or a dialog open', () => {
    const open = page({ layers: [layer()], modals: [layer()] });
    for (const name of ['Escape', 'Enter', ' ', 'z', 'Tab', 'Home']) expect(plainKeyIsElsewhere(key(name, button), drawing, open)).toBe(false);
    expect(plainKeyIsElsewhere(key('ArrowUp', button, { ctrlKey: true }), drawing, open)).toBe(false);
    expect(plainKeyIsElsewhere(key('Backspace', body, { metaKey: true }), drawing, open)).toBe(false);
  });

  it('does not count the card beside a selected thing: it is the selection\'s own, and is marked so', () => {
    expect(OPEN_LAYER).toContain('[role="dialog"]:not([data-selection-card])');
    const card = readFileSync(fileURLToPath(new URL('../drawing/QuickCard.tsx', import.meta.url)), 'utf8');
    const root = card.slice(card.indexOf('className="quick-card"'), card.indexOf('className="quick-card__head"'));
    expect(root).toContain('role="dialog"');
    expect(root).toContain('data-selection-card=""');
  });
});
