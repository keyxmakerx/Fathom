// The arrow keys in an open menu: which row the keyboard goes to next.

type Key = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>;

/** The row a key goes to, by its place among `count` rows, or null when the key is not one that moves. `at` is the
 * row the keyboard is on, or -1 when it is on the button that opened the menu: from there Down goes to the first
 * row and Up to the last, and no other key moves. In the rows, Down and Right step on, Up and Left step back, and
 * both go round at the ends; Home and End go to the first row and the last. A key held with Ctrl, Cmd, Alt or
 * Shift is not the menu's. */
export function rowAfter(event: Key, at: number, count: number): number | null {
  if (count <= 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return null;
  if (at < 0) return event.key === 'ArrowDown' ? 0 : event.key === 'ArrowUp' ? count - 1 : null;
  switch (event.key) {
    case 'ArrowDown':
    case 'ArrowRight':
      return (at + 1) % count;
    case 'ArrowUp':
    case 'ArrowLeft':
      return (at - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}

type Field = { tagName?: string; type?: string; isContentEditable?: boolean };

/** Inputs the arrow keys do nothing in: the menu may take the key there. */
const PLAIN_INPUTS = ['checkbox', 'button', 'submit', 'reset', 'image'];

/** Whether the thing the keyboard is on uses the arrow keys itself: a field to type in, a list to choose from, a
 * slider, a set of radio buttons. The menu leaves the key to it. A tick box does not use them. */
export function usesArrows(el: Field | null): boolean {
  if (el == null) return false;
  const tag = (el.tagName ?? '').toLowerCase();
  if (tag === 'textarea' || tag === 'select' || el.isContentEditable === true) return true;
  return tag === 'input' && !PLAIN_INPUTS.includes((el.type ?? 'text').toLowerCase());
}

/** What the arrow keys stop on in a menu: what Tab stops on there. */
export const MENU_ROWS = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled)';
