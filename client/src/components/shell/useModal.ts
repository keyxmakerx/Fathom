import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Open modals, newest last. Only the newest answers Escape and keeps Tab, so closing a dialog
// opened from another dialog leaves the first one open.
const open: symbol[] = [];

export interface ModalOptions {
  /** Where focus starts: the first control inside (default; an `autoFocus` field that already has
   *  focus is left alone), the container itself (give it `tabIndex={-1}`), or nowhere, for a
   *  dialog that places focus itself. */
  focus?: 'first' | 'container' | 'none';
}

/**
 * The one behaviour every modal dialog shares: focus moves in when it opens and goes back to
 * whatever had it when it closes, Tab stays inside, and Escape calls `onEscape`. Escape is read on
 * the document, not the dialog, so it still works after a disabled field drops focus to the page.
 * `onEscape` is read fresh each time, so a caller can refuse to close (busy, unsaved) by
 * returning early.
 */
export function useModal(ref: RefObject<HTMLElement | null>, onEscape: () => void, options: ModalOptions = {}): void {
  const escape = useRef(onEscape);
  escape.current = onEscape;
  const focus = options.focus ?? 'first';

  useEffect(() => {
    const me = Symbol('modal');
    open.push(me);
    const back = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const box = ref.current;
    if (focus === 'container') box?.focus();
    else if (focus === 'first' && box && !box.contains(document.activeElement)) (box.querySelector<HTMLElement>(FOCUSABLE) ?? box).focus();

    const onKey = (e: KeyboardEvent) => {
      if (open[open.length - 1] !== me || e.isComposing) return;
      if (e.key === 'Escape') {
        e.stopPropagation();
        escape.current();
        return;
      }
      if (e.key !== 'Tab' || !ref.current) return;
      const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const at = document.activeElement;
      const inside = at instanceof Node && ref.current.contains(at);
      if (e.shiftKey && (at === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (at === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      open.splice(open.indexOf(me), 1);
      if (back?.isConnected) back.focus();
    };
    // Mount only: the dialog's element and focus choice do not change while it is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
