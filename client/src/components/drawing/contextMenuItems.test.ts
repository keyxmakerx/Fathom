import { describe, expect, it, vi } from 'vitest';

import { menuItemsFor, type MenuActions } from './contextMenuItems';

function actions(): Required<Omit<MenuActions, 'onPlanChange' | 'onItsDown'>> {
  return {
    onSelect: vi.fn(),
    onOpen: vi.fn(),
    onOpenInside: vi.fn(),
    onTraceFrom: vi.fn(),
    onDuplicateDevice: vi.fn(),
    onRemoveDevice: vi.fn(),
    onDisconnect: vi.fn(),
    onAddDevice: vi.fn(),
    onAddRack: vi.fn(),
    onAddWall: vi.fn(),
    onPasteConfig: vi.fn(),
    onAddInRack: vi.fn(),
    onAddBoxHere: vi.fn(),
    onAddLabelHere: vi.fn(),
    onDuplicateFree: vi.fn(),
    onRemoveFree: vi.fn(),
  };
}

describe('menuItemsFor', () => {
  it('offers a device Open, Inside, a trace, details, a duplicate and removal, removal marked', () => {
    const a = actions();
    const items = menuItemsFor({ kind: 'chassis', id: 'c1' }, a);
    expect(items.map((i) => i.label)).toEqual(['Open', 'Inside', 'Trace a path from here', 'Details', 'Duplicate', 'Remove']);
    expect(items[5].danger).toBe(true);
    items[4].onSelect();
    expect(a.onDuplicateDevice).toHaveBeenCalledWith('c1');
    items[0].onSelect();
    expect(a.onOpen).toHaveBeenCalledWith('c1');
    items[2].onSelect();
    expect(a.onTraceFrom).toHaveBeenCalledWith('c1');
    items[3].onSelect();
    expect(a.onSelect).toHaveBeenCalledWith({ kind: 'chassis', id: 'c1' });
  });

  it("offers It's down on a device and a free box when it can be used, and not otherwise", () => {
    const a = { ...actions(), onItsDown: vi.fn() };
    const chassis = menuItemsFor({ kind: 'chassis', id: 'c1' }, a);
    expect(chassis.map((i) => i.label)).toEqual(['Open', 'Inside', 'Trace a path from here', 'Details', "It's down", 'Duplicate', 'Remove']);
    chassis.find((i) => i.label === "It's down")!.onSelect();
    expect(a.onItsDown).toHaveBeenCalledWith('c1');
    const free = menuItemsFor({ kind: 'free', id: 'f1' }, a);
    expect(free.map((i) => i.label)).toContain("It's down");
    free.find((i) => i.label === "It's down")!.onSelect();
    expect(a.onItsDown).toHaveBeenCalledWith('f1');
    // A reader's menu carries no action for it, so no item.
    expect(menuItemsFor({ kind: 'chassis', id: 'c1' }, { onSelect: vi.fn(), onOpen: vi.fn() }).map((i) => i.label)).not.toContain("It's down");
    expect(menuItemsFor({ kind: 'label', id: 'l1' }, a).map((i) => i.label)).not.toContain("It's down");
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

  it('offers Add here only when the click landed on a free unit of a rack', () => {
    const a = actions();
    const at = { screen: { x: 1, y: 2 }, flow: { x: 3, y: 4 } };
    expect(menuItemsFor({ kind: 'rack', id: 'r1' }, a).map((i) => i.label)).toEqual(['Details', 'Add a device']);
    const items = menuItemsFor({ kind: 'rack', id: 'r1', freeU: { u: 12, ...at } }, a);
    expect(items.map((i) => i.label)).toEqual(['Details', 'Add here (U12)', 'Add a device', 'Add a note here']);
    items[1].onSelect();
    expect(a.onAddInRack).toHaveBeenCalledWith('r1', 12, expect.objectContaining({ screen: at.screen }));
  });

  it('offers a note on the empty canvas and on a free unit of a rack, at the spot clicked', () => {
    const onAddLabelHere = vi.fn();
    const a: MenuActions = { onSelect: vi.fn(), onAddLabelHere };
    const at = { screen: { x: 1, y: 2 }, flow: { x: 30, y: 40 } };
    const pane = menuItemsFor({ kind: 'pane', at }, a);
    expect(pane.map((i) => i.label)).toEqual(['Add a label here', 'Add an area here', 'Add a note here']);
    pane[2]!.onSelect();
    expect(onAddLabelHere).toHaveBeenLastCalledWith('note', at.flow);
    const rack = menuItemsFor({ kind: 'rack', id: 'r1', freeU: { u: 3, ...at } }, a);
    expect(rack.map((i) => i.label)).toEqual(['Details', 'Add a note here']);
    rack[1]!.onSelect();
    expect(onAddLabelHere).toHaveBeenLastCalledWith('note', at.flow);
  });
});
