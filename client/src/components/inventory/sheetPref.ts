import { readPref, writePref } from '../../prefs';
// r31-bar A: whether Inventory opens as the Sheet (one spreadsheet, its tabs along the bottom) or as the item pages.
// Kept in this browser so the bar's Sheet tab can choose it before Inventory opens.

const KEY = 'fathom.inventory.sheet';

export function loadSheet(): boolean {
  return readPref(KEY) === '1';
}

export function saveSheet(on: boolean): void {
  writePref(KEY, on ? '1' : null);
}
