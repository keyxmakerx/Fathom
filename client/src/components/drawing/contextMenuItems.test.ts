import { describe, expect, it, vi } from 'vitest';

import { menuItemsFor, type MenuActions } from './contextMenuItems';

function actions(): Required<MenuActions> {
  return {
    onSelect: vi.fn(),
    onOpen: vi.fn(),
    onOpenInside: vi.fn(),
    onDuplicateDevice: vi.fn(),
    onRemoveDevice: vi.fn(),
    onDisconnect: vi.fn(),
    onAddDevice: vi.fn(),
    onAddRack: vi.fn(),
    onAddWall: vi.fn(),
    onPasteConfig: vi.fn(),
    onAddBoxHere: vi.fn(),
    onAddLabelHere: vi.fn(),
    onDuplicateFree: vi.fn(),
    onRemoveFree: vi.fn(),
  };
}

describe('menuItemsFor', () => {
  it('offers a device Open, Inside, details, a duplicate and removal, removal marked', () => {
    const a = actions();
    const items = menuItemsFor({ kind: 'chassis', id: 'c1' }, a);
    expect(items.map((i) => i.label)).toEqual(['Open', 'Inside', 'Details', 'Duplicate', 'Remove']);
    expect(items[4].danger).toBe(true);
    items[3].onSelect();
    expect(a.onDuplicateDevice).toHaveBeenCalledWith('c1');
    items[0].onSelect();
    expect(a.onOpen).toHaveBeenCalledWith('c1');
    items[2].onSelect();
    expect(a.onSelect).toHaveBeenCalledWith({ kind: 'chassis', id: 'c1' });
  });

  it('offers a rack its details and a new device', () => {
    const a = actions();
    const items = menuItemsFor({ kind: 'rack', id: 'r1' }, a);
    expect(items.map((i) => i.label)).toEqual(['Details', 'Add a device']);
    items[1].onSelect();
    expect(a.onAddDevice).toHaveBeenCalledWith('r1');
  });

  it('offers a cable its details and a disconnect', () => {
    const a = actions();
    const items = menuItemsFor({ kind: 'cable', id: 'k1' }, a);
    expect(items.map((i) => i.label)).toEqual(['Details', 'Disconnect']);
    items[1].onSelect();
    expect(a.onDisconnect).toHaveBeenCalledWith('k1');
  });

  it('offers the empty canvas three rack sizes and a wall', () => {
    const a = actions();
    const items = menuItemsFor({ kind: 'pane' }, a);
    expect(items.map((i) => i.label)).toEqual(['Add a 42U rack', 'Add a 24U rack', 'Add a 12U rack', 'Add a wall', 'Paste config']);
    items[1].onSelect();
    expect(a.onAddRack).toHaveBeenCalledWith(24);
    items[4].onSelect();
    expect(a.onPasteConfig).toHaveBeenCalled();
  });

  it('lets a free box be opened like a racked device', () => {
    const a = actions();
    const items = menuItemsFor({ kind: 'free', id: 'f1' }, a);
    expect(items[0].label).toBe('Open');
    items[0].onSelect();
    expect(a.onOpen).toHaveBeenCalledWith('f1');
  });

  it('gives a reader only Details, and nothing on the empty canvas', () => {
    const reader: MenuActions = { onSelect: vi.fn() };
    expect(menuItemsFor({ kind: 'chassis', id: 'c1' }, reader).map((i) => i.label)).toEqual(['Details']);
    expect(menuItemsFor({ kind: 'cable', id: 'k1' }, reader).map((i) => i.label)).toEqual(['Details']);
    expect(menuItemsFor({ kind: 'pane' }, reader)).toEqual([]);
  });
});
