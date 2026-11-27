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

const FLOATING = '[role="dialog"]:not(.quick-card), [role="menu"]:not(details:not([open]) *)';

/** Whether something floats over the page besides the canvas's own card: Search, a sheet, a panel, a dialog, or a
 * menu hung from the bar. It was opened after anything on the canvas and answers Esc itself. A menu counts as
 * a dialog does: it once did not, so Esc put away the card behind an open menu and left the menu open. Only an
 * open one: the More list in Details is in the page while its `<details>` is shut, and is no menu until it opens. */
export function openAbove(page: Pick<Document, 'querySelector'> = document): boolean {
  return page.querySelector(FLOATING) != null;
}

/** The same, asked by an open menu of the page's own (`own` holds it): whether a dialog or another menu floats
 * over the page besides itself. One opened since is above it, and the Esc is that one's. */
export function openAboveMenu(own: Pick<Element, 'contains'>, page: Pick<Document, 'querySelectorAll'> = document): boolean {
  for (const el of page.querySelectorAll(FLOATING)) if (!own.contains(el)) return true;
  return false;
}

/** What one Esc puts away on the canvas, topmost first: a hover peek, then the quick card, then an opened
 * device is left, then the selection is cleared (r116: Esc steps out one level). While something floats over
 * the page (`above`) the Esc is that thing's, and nothing on the canvas answers. */
export function nextEscape(up: { above?: boolean; peek: boolean; card: boolean; opened?: boolean; selected?: boolean }): 'peek' | 'card' | 'leave' | 'clear' | null {
  if (up.above === true) return null;
  if (up.peek) return 'peek';
  if (up.card) return 'card';
  if (up.opened === true) return 'leave';
  if (up.selected === true) return 'clear';
  return null;
}
