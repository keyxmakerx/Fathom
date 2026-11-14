// Ctrl K lists every action on the selected device by its name, the ones that left the short menu too
// (r116, ADR-0091 decision 4). Pure: the place says which list and what the device is called.

import type { PaletteAction } from '../shell/palette';
import type { MenuItem } from './contextMenuItems';

export function devicePaletteActions(items: readonly MenuItem[], deviceName: string, keywords: Readonly<Record<string, readonly string[]>> = {}): PaletteAction[] {
  return items.map((item) => ({
    id: `device:${item.label}`,
    label: deviceName === '' ? item.label : `${item.label} · ${deviceName}`,
    hint: item.keys,
    keywords: keywords[item.label],
    disabled: item.disabled,
    run: item.onSelect,
  }));
}
