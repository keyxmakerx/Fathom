// r31-bar A: whether Inventory opens as the Sheet (one spreadsheet, its tabs along the bottom) or as the item pages.
// Kept in this browser so the bar's Sheet tab can choose it before Inventory opens.

const KEY = 'fathom.inventory.sheet';

export function loadSheet(): boolean {
  try {
    return globalThis.localStorage?.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

export function saveSheet(on: boolean): void {
  try {
    if (on) globalThis.localStorage?.setItem(KEY, '1');
    else globalThis.localStorage?.removeItem(KEY);
  } catch {
    // Storage refused: the choice lasts only until the page is left.
  }
}
