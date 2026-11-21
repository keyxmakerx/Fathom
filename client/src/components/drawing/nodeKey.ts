// Enter on a thing in the drawing that the keyboard is on selects it, as a press on it does.
//
// React Flow puts every device, rack, shelf, wall and cable in the Tab order. Its own Enter marks the thing
// selected in its store; the selection this app draws, moves and shows a panel for is the app's own, so the
// canvas hears the key here and makes the selection a press would.

import { keyboardIsWalking } from '../shell/keyOwner';
import { matches } from '../shell/shortcuts';

type EnterKey = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'repeat' | 'defaultPrevented' | 'target'>;
type Held = { classList?: { contains(name: string): boolean }; getAttribute?(name: string): string | null };

/** What the keyboard is on: one of React Flow's nodes or one of its edges, by the id the canvas gave it. */
export interface Landed {
  kind: 'node' | 'edge';
  id: string;
}

/** What an Enter was pressed on, or null when the press is not one that selects: another key, a key held down
 * and repeating, one with Ctrl, Cmd or Alt, one something has already used, or one pressed on a button, a port
 * or a field inside a node, which is that control's. Shift is left to the caller: it adds to what is picked,
 * as Shift and a press do. Space is not taken: on the drawing it is held to pan. */
export function enterOn(event: EnterKey): Landed | null {
  if (!matches(event, 'select-focused') || event.repeat || event.defaultPrevented) return null;
  const on = event.target as Held | null;
  const kind = on?.classList?.contains('react-flow__node') === true ? 'node' : on?.classList?.contains('react-flow__edge') === true ? 'edge' : null;
  if (on == null || kind == null) return null;
  const id = on.getAttribute?.('data-id');
  return id == null || id === '' ? null : { kind, id };
}

type EscapeKey = Pick<KeyboardEvent, 'key' | 'target'>;

/** The node an Escape was pressed on, for someone going through the page with Tab (`walking`), or null. React
 * Flow takes the keyboard off a selected node a frame after Escape. For them the caller puts it back: Escape
 * clears the selection and the ring stays where it was, as it does on a shelf, a wall and a cable. After a
 * press with a pointer there is no ring to keep, and the node is left as React Flow leaves it. */
export function escapeOnWalkedNode<T extends Held>(event: EscapeKey, walking: boolean): T | null {
  if (event.key !== 'Escape' || !walking) return null;
  const on = event.target as T | null;
  return on?.classList?.contains('react-flow__node') === true ? on : null;
}

/** Puts the keyboard back on the node an Escape took it off (`escapeOnWalkedNode`). React Flow's own frame is
 * asked for first, by the node's own handler, so this one runs after it. */
export function keepRing(event: KeyboardEvent): void {
  const node = escapeOnWalkedNode<HTMLElement>(event, keyboardIsWalking());
  if (node == null) return;
  requestAnimationFrame(() => {
    const on = document.activeElement;
    if (node.isConnected && (on == null || on === document.body)) node.focus({ preventScroll: true });
  });
}

/** What is read out for a node or a cable the keyboard is on, in place of React Flow's own words. Those offer
 * Space, which is held to pan here, say every node can be moved and deleted, and say Escape lets go, which the
 * Diagram look does not do. */
const SAID = 'Press Enter to select it.';
export const KEYS_SAID = {
  'node.a11yDescription.default': SAID,
  'node.a11yDescription.keyboardDisabled': SAID,
  'edge.a11yDescription.default': SAID,
} as const;
