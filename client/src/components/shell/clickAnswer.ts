// r116 (ADR-0091 decision 3): a click gives one answer. With the Details panel folded the quick card comes out
// beside the thing; with it open the panel fills in and no card shows. "Details" on the card opens the panel,
// which then stays open until the person folds it. Pure, so the rule is tested without a browser.

import { createContext, useContext } from 'react';

export type ClickAnswer = 'card' | 'panel';

export function clickAnswer(detailsOpen: boolean): ClickAnswer {
  return detailsOpen ? 'panel' : 'card';
}

/** Whether the Details panel is the one showing on the right edge; the shell provides it, the card reads it. */
export const DetailsOpenContext = createContext(false);

export function useDetailsOpen(): boolean {
  return useContext(DetailsOpenContext);
}

/** How long after a press on the canvas a new selection still counts as that click's (see `useRightTab`). */
export const CANVAS_PRESS_MS = 600;

/** What one Esc puts away on the canvas, topmost first: a hover peek, then the quick card, then an opened
 * device is left, then the selection is cleared (r116: Esc steps out one level). */
export function nextEscape(up: { peek: boolean; card: boolean; opened?: boolean; selected?: boolean }): 'peek' | 'card' | 'leave' | 'clear' | null {
  if (up.peek) return 'peek';
  if (up.card) return 'card';
  if (up.opened === true) return 'leave';
  if (up.selected === true) return 'clear';
  return null;
}
