// Whose an arrow key, Delete or Backspace is: the drawing's selection, or the control the keyboard is on.
//
// The drawing listens for these keys on the whole page, so a thing picked with the pointer is moved or removed
// with no press on the drawing first, whatever button the last press left the focus on. Someone going through
// the page with Tab is elsewhere: on a button or in a list, where the key is that control's or nobody's. So a
// plain key is not the drawing's when the control it is pressed on has used it, when the keyboard walked there,
// or when a menu or a dialog is open: the key is then for what opened.

import { useEffect } from 'react';

/** A Tab has moved the focus, and no pointer has been pressed since. */
let walking = false;
/** A Tab is down: a focus that moves now was moved by it. */
let tabDown = false;

type Input = Pick<KeyboardEvent, 'type'> & Partial<Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>>;

/** Told of every key, every move of the focus and every press with a pointer (`useKeyOwner`). */
export function noteInput(event: Input): void {
  if (event.type === 'keydown') {
    // Ctrl+Tab and Alt+Tab leave the page. They do not go through it.
    tabDown = event.key === 'Tab' && event.ctrlKey !== true && event.metaKey !== true && event.altKey !== true;
  } else if (event.type === 'keyup') {
    tabDown = false;
  } else if (event.type === 'focusin') {
    // Search keeps Tab for itself and moves no focus with it: that is not a walk.
    if (tabDown) walking = true;
  } else if (event.type === 'pointerdown') {
    tabDown = false;
    walking = false;
  }
}

/** A thing was picked for the selection from the keyboard (Search): the keys are the selection's again. */
export function keysToSelection(): void {
  walking = false;
}

/** The keyboard was sent to the drawing with its own key (`drawing/toDrawing.ts`): from there it goes on as after
 * a walk with Tab. */
export function walkedTo(): void {
  walking = true;
}

/** Someone is going through the page with Tab: the ring they see is where they are. */
export function keyboardIsWalking(): boolean {
  return walking;
}

const PLAIN_KEYS: ReadonlySet<string> = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Delete', 'Backspace']);

type PlainKey = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'defaultPrevented' | 'target'>;

/** A menu or a dialog open on the page. The card beside a selected thing is the selection's own, and is marked
 * so (`drawing/QuickCard.tsx`). The copy a closed one leaves to fade has no role (`ghost.ts`). */
export const OPEN_LAYER = '[role="menu"], [role="dialog"]:not([data-selection-card]), [role="alertdialog"]';
/** A dialog that covers the page: nothing under it is to change, wherever the keyboard was left. */
export const OPEN_MODAL = '[aria-modal="true"]';

type Held = Pick<Node, 'contains'>;
/** Where the open menus and dialogs are looked for: the document. */
type Page = { querySelectorAll(selectors: string): ArrayLike<Held> };

/** One of `layers` is open apart from `surface`. A menu inside the surface is the surface's own, and a dialog
 * the surface is shown in is not over it. */
function openApart(page: Page | null, layers: string, surface: Held | null): boolean {
  if (page == null) return false;
  return Array.from(page.querySelectorAll(layers)).some((layer) => surface == null || !(surface.contains(layer as Node) || layer.contains(surface as Node)));
}

/** True when this key press is not for `surface` (the drawing, or an opened device) to act on: an arrow key,
 * Delete or Backspace, with or without Shift, pressed on a control outside the surface that has used the key
 * itself, that the keyboard walked to, or while a menu or a dialog is open; or pressed anywhere while a dialog
 * covers the page. Every other key, and every key pressed inside the surface or on nothing with no such dialog,
 * is the surface's as before. Inside it `defaultPrevented` says nothing: the canvas's own nodes prevent an
 * arrow's scroll and leave the move to the drawing. */
export function plainKeyIsElsewhere(event: PlainKey, surface: Held | null, page: Page | null = typeof document === 'undefined' ? null : document): boolean {
  if (!PLAIN_KEYS.has(event.key) || event.ctrlKey || event.metaKey || event.altKey) return false;
  if (openApart(page, OPEN_MODAL, surface)) return true;
  const on = event.target as Element | null;
  const tag = on?.tagName;
  if (on == null || tag == null || tag === 'BODY' || tag === 'HTML') return false;
  if (surface?.contains(on) === true) return false;
  return event.defaultPrevented || walking || openApart(page, OPEN_LAYER, surface);
}

/** Follows the keyboard and the pointer for `plainKeyIsElsewhere`. Mounted once, by the shell. */
export function useKeyOwner(): void {
  useEffect(() => {
    const types = ['keydown', 'keyup', 'focusin', 'pointerdown'] as const;
    // Before any control hears the event, so a key a control keeps to itself is still seen.
    for (const type of types) document.addEventListener(type, noteInput, true);
    return () => {
      for (const type of types) document.removeEventListener(type, noteInput, true);
    };
  }, []);
}
