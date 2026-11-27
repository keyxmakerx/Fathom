// r159: one key takes the keyboard to the drawing (`to-drawing` in `shell/shortcuts.ts`, G).
//
// From the top of the page, Tab took 25 presses to reach the first rack of the sample, and 25 to 39 to reach a device from the
// canvas tools (cards r154, r155). G goes straight there: to the selected thing when it is drawn and takes the
// keyboard, or else to the first thing on the drawing that does, which is the first rack. The cables come before
// the racks in the page, so Shift and Tab from there walks back through them. Escape and the arrows then work as
// after a walk with Tab (`shell/keyOwner.ts`).

import { useEffect, useRef, type RefObject } from 'react';
import type { ReactFlowInstance } from '@xyflow/react';
import { isTypingTarget, matches } from '../shell/shortcuts';
import { OPEN_MODAL, walkedTo } from '../shell/keyOwner';

type Picked = { kind: string; id: string } | null;

/** Where the selected thing may be in the page, best first: a drawn port, a cable, a thing on a wall or a shelf,
 * a node of its own (named `<kind>:<id>` on the Canvas, by the bare id in the Diagram look). */
export function stopSelectors(selected: Picked): string[] {
  if (selected == null || selected.id === '') return [];
  const id = JSON.stringify(selected.id);
  if (selected.kind === 'port') return [`button[data-port-id=${id}]`];
  if (selected.kind === 'cable') return [`.react-flow__edge[data-id=${id}]`];
  return [`[data-device-chassis=${id}]`, `.react-flow__node[data-id$=${JSON.stringify(`:${selected.id}`)}]`, `.react-flow__node[data-id=${id}]`];
}

/** The first thing on the drawing that takes the keyboard. */
export const FIRST_STOP = '.react-flow__node[tabindex="0"]';

/** Whether the keyboard can land on `el`: it takes a Tab stop and is drawn. */
function takesKeyboard(el: HTMLElement): boolean {
  return el.tabIndex >= 0 && el.getAttribute('tabindex') !== '-1' && el.getClientRects().length > 0 && el.closest('[class*="--undrawn"]') == null;
}

/** The element G lands on in `root`: the selected thing, or the first stop, or nothing on an empty drawing. */
export function drawingStop(root: ParentNode, selected: Picked): HTMLElement | null {
  for (const sel of stopSelectors(selected)) {
    for (const el of Array.from(root.querySelectorAll<HTMLElement>(sel))) if (takesKeyboard(el)) return el;
  }
  return Array.from(root.querySelectorAll<HTMLElement>(FIRST_STOP)).find(takesKeyboard) ?? null;
}

/** A key pressed in a menu, a list or a dialog: a letter there moves within it (type-ahead), so G is not ours. */
const KEEPS_LETTERS = '[role="menu"], [role="menubar"], [role="listbox"], [role="dialog"], [role="alertdialog"]';

/** Listens for G on the whole page while this drawing is shown. Not while someone types, not on a menu, a list or a
 * dialog, and not while a dialog covers the page: the key is theirs then. The list in Details that stands open beside
 * a device is a menu too, so an open menu elsewhere on the page does not stop it. */
export function useToDrawingKey(root: RefObject<HTMLElement | null>, selected: Picked): void {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.repeat || !matches(event, 'to-drawing') || isTypingTarget(event.target)) return;
      if (document.querySelector(OPEN_MODAL) != null || (event.target as Element | null)?.closest?.(KEEPS_LETTERS) != null) return;
      const at = root.current == null ? null : drawingStop(root.current, selected);
      if (at == null) return;
      event.preventDefault();
      walkedTo();
      // The drawing moves its own camera; a scroll here would shift the canvas inside its frame.
      at.focus({ preventScroll: true });
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [root, selected]);
}

/** How long React Flow's own move to a focused node is given before the thing inside it is looked at. */
const SETTLE_MS = 320;

type Box = { left: number; top: number; right: number; bottom: number };

/** How far to move the drawing so `thing` shows inside `pane` with `margin` to spare, or null when it already
 * does. A thing larger than the pane is shown from its top left. */
export function shiftToShow(thing: Box, pane: Box, margin = 24): { dx: number; dy: number } | null {
  const along = (lo: number, hi: number, paneLo: number, paneHi: number): number => {
    if (lo >= paneLo + margin && hi <= paneHi - margin) return 0;
    if (hi - lo > paneHi - paneLo - 2 * margin || lo < paneLo + margin) return paneLo + margin - lo;
    return paneHi - margin - hi;
  };
  const dx = along(thing.left, thing.right, pane.left, pane.right);
  const dy = along(thing.top, thing.bottom, pane.top, pane.bottom);
  return dx === 0 && dy === 0 ? null : { dx, dy };
}

/** React Flow brings a node the keyboard lands on into view, but not a thing inside one: a device on a wall, a
 * thing on a shelf, a drawn port. Without this, Tab could walk onto something off the screen, or under the zoom
 * buttons (`covers`, the reach a fit keeps clear of). Only for the
 * keyboard (a ring is showing): a press with the pointer is on something already in view. */
export function useKeepWalkInView(
  root: RefObject<HTMLElement | null>,
  rf: Pick<ReactFlowInstance, 'getViewport' | 'setViewport'>,
  covers: () => { top: number; bottom: number } | null,
): void {
  // How far the tool row and the zoom buttons reach over the pane, asked at the moment of the walk.
  const coversRef = useRef(covers);
  coversRef.current = covers;
  useEffect(() => {
    const el = root.current;
    if (el == null) return undefined;
    function onFocusIn(event: FocusEvent) {
      const on = event.target as HTMLElement | null;
      if (on == null || on.classList.contains('react-flow__node') || on.closest('.react-flow__node') == null) return;
      if (!on.matches(':focus-visible')) return;
      // After React Flow has moved to the node the thing is in, which it does on the same focus.
      window.setTimeout(() => {
        if (document.activeElement !== on || !on.isConnected) return;
        const box = el!.getBoundingClientRect();
        const reach = coversRef.current();
        const pane = { left: box.left, right: box.right, top: box.top + (reach?.top ?? 0), bottom: box.bottom - (reach?.bottom ?? 0) };
        const shift = shiftToShow(on.getBoundingClientRect(), pane);
        if (shift == null) return;
        const v = rf.getViewport();
        const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
        void rf.setViewport({ x: v.x + shift.dx, y: v.y + shift.dy, zoom: v.zoom }, { duration: still ? 0 : 200 });
      }, SETTLE_MS);
    }
    el.addEventListener('focusin', onFocusIn);
    return () => el.removeEventListener('focusin', onFocusIn);
  }, [root, rf]);
}
