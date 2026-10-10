import { useEffect, useRef, type RefObject } from 'react';

/**
 * Focus for a box typed into on the canvas (a label, a note). React Flow hides a node until it has
 * measured it, and measures again when the canvas changes size (a side panel sliding open), and a
 * hidden box drops its focus. So: keep trying for a few frames on mount, and when focus falls to
 * nowhere without the person clicking or tabbing away, take it back instead of ending the edit.
 * Returns the blur handler the field uses: it calls `finish` only for a real blur.
 */
export function useEditFocus<T extends HTMLInputElement | HTMLTextAreaElement>(ref: RefObject<T | null>, finish: (value: string) => void): (e: React.FocusEvent<T>) => void {
  const leaving = useRef(false);
  const retake = useRef<() => void>(() => {});
  useEffect(() => {
    let frame = 0;
    let tries = 0;
    const take = (select: boolean) => {
      const el = ref.current;
      if (el == null) return;
      el.focus({ preventScroll: true });
      if (document.activeElement === el) {
        if (select) el.select();
        return;
      }
      if ((tries += 1) < 20) frame = requestAnimationFrame(() => take(select));
    };
    take(true);
    retake.current = () => {
      tries = 0;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => take(false));
    };
    const onPointer = () => {
      leaving.current = true;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Tab') leaving.current = true;
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [ref]);
  return (e) => {
    const el = e.currentTarget;
    if (!leaving.current && e.relatedTarget == null && el.isConnected) {
      // Nothing took focus and nobody clicked or tabbed: the box was hidden for a moment.
      retake.current();
      return;
    }
    leaving.current = false;
    finish(el.value);
  };
}
