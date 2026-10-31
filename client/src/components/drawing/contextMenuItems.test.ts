import { describe, expect, it, vi } from 'vitest';

import { DEVICE_WORDS, FIRMWARE_NEEDS_VERSION, deviceMenuItems, menuItemsFor, type MenuActions } from './contextMenuItems';
import { shortcutText } from '../shell/shortcuts';

function actions(): Required<Omit<MenuActions, 'onPlanChange' | 'onItsDown' | 'onPlanFirmware' | 'firmwareNeedsVersion' | 'onSuggestCables' | 'onFitCard' | 'onAddCableRun' | 'onRemoveCableRun' | 'cableRunsOn' | 'looseState' | 'onSetNeedsFinishing' | 'onShowInInventory' | 'onSwapModel' | 'hasModel' | 'onAddPort' | 'addPortRefusal' | 'onOpenInTermix' | 'onCopyLink' | 'onPrintLabel' | 'termixRefusal' | 'duplicateRefusal'>> {
  return {
    onSelect: vi.fn(),
    onOpen: vi.fn(),
    onOpenInside: vi.fn(),
    onTraceFrom: vi.fn(),
    onDuplicateDevice: vi.fn(),
    onRemoveDevice: vi.fn(),
    onDisconnect: vi.fn(),
    onAddDevice: vi.fn(),
    onCloseRackGaps: vi.fn(),
    onCopyRack: vi.fn(),
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
  it('offers the Needs finishing toggle only on a cable with one end connected', () => {
    const set = vi.fn();
    const unknown = menuItemsFor({ kind: 'cable', id: 'c1' }, { ...actions(), looseState: () => 'unknown', onSetNeedsFinishing: set });
    expect(unknown.map((i) => i.label)).toEqual(['Details', 'Needs finishing', 'Disconnect']);
    unknown.find((i) => i.label === 'Needs finishing')!.onSelect();
    expect(set).toHaveBeenLastCalledWith('c1', true);

    const marked = menuItemsFor({ kind: 'cable', id: 'c1' }, { ...actions(), looseState: () => 'needs-finishing', onSetNeedsFinishing: set });
    marked.find((i) => i.label === 'Clear "Needs finishing"')!.onSelect();
    expect(set).toHaveBeenLastCalledWith('c1', false);

    const whole = menuItemsFor({ kind: 'cable', id: 'c1' }, { ...actions(), looseState: () => null, onSetNeedsFinishing: set });
    expect(whole.map((i) => i.label)).toEqual(['Details', 'Disconnect']);
  });

  it('offers cable runs on a wall too', () => {
    const add = vi.fn();
    const items = menuItemsFor({ kind: 'surface', id: 'w1' }, { ...actions(), onAddCableRun: add, onRemoveCableRun: vi.fn(), cableRunsOn: () => [] });
    expect(items.map((i) => i.label)).toEqual(['Add a lacing bar on the left', 'Add a lacing bar on the right', 'Add a cable tray on top']);
    expect(menuItemsFor({ kind: 'surface', id: 'w1' }, actions())).toEqual([]);
  });

  it('offers a lacing bar or tray on each free side of a rack, and removal of each run there', () => {
    const add = vi.fn();
    const remove = vi.fn();
    const run = { id: 'run1', hostId: 'r1', form: 'lacing_bar' as const, side: 'left' as const, label: null, ties: [] };
    const items = menuItemsFor({ kind: 'rack', id: 'r1' }, { ...actions(), onAddCableRun: add, onRemoveCableRun: remove, cableRunsOn: () => [run] });
    const labels = items.map((i) => i.label);
    expect(labels).not.toContain('Add a lacing bar on the left');
    expect(labels).toContain('Add a lacing bar on the right');
    expect(labels).toContain('Add a cable tray on top');
    items.find((i) => i.label === 'Add a cable tray on top')!.onSelect();
    expect(add).toHaveBeenCalledWith('r1', 'tray', 'top');
    const off = items.find((i) => i.label === 'Remove the left lacing bar')!;
    expect(off.danger).toBe(true);
    off.onSelect();
    expect(remove).toHaveBeenCalledWith('run1');
  });


  it('offers Plan a firmware upgrade beside Plan a change, greyed with the reason until a version is chosen', () => {
    const go = vi.fn();
    const base = { ...actions(), onPlanChange: vi.fn(), onPlanFirmware: go };
    const items = (needs: boolean) => menuItemsFor({ kind: 'chassis', id: 'c1' }, { ...base, firmwareNeedsVersion: () => needs });
    const labels = items(false).map((i) => i.label);
    expect(labels.indexOf('Plan a firmware upgrade')).toBe(labels.indexOf('Plan a change') + 1);
    expect(items(false).find((i) => i.label === 'Plan a firmware upgrade')!.disabled).toBeUndefined();
    // Sign-off r58: shown greyed, so a person learns it is there and what it waits on.
    expect(items(true).find((i) => i.label === 'Plan a firmware upgrade')!.disabled).toBe(FIRMWARE_NEEDS_VERSION);
    menuItemsFor({ kind: 'chassis', id: 'c1' }, base).find((i) => i.label === 'Plan a firmware upgrade')!.onSelect();
    expect(go).toHaveBeenCalledWith('c1');
    expect(menuItemsFor({ kind: 'chassis', id: 'c1' }, actions()).map((i) => i.label)).not.toContain('Plan a firmware upgrade');
  });

  it('offers a device Open, Open inside, a trace, details, a duplicate and removal, removal marked', () => {
    const a = actions();
    const items = menuItemsFor({ kind: 'chassis', id: 'c1' }, a);
    expect(items.map((i) => i.label)).toEqual(['Open', 'Open inside', 'Trace from here', 'Details', 'Duplicate', 'Remove device']);
    expect(items[5].danger).toBe(true);
    // The keys come from the shortcuts table, so the menu says what the sheet and the buttons say.
    expect(items[5].keys).toBe(shortcutText('delete'));
    expect(items[4].keys).toBe(shortcutText('duplicate'));
    expect(shortcutText('duplicate', true)).toBe('Cmd+D');
    items[4].onSelect();
    expect(a.onDuplicateDevice).toHaveBeenCalledWith('c1');
    items[0].onSelect();
    expect(a.onOpen).toHaveBeenCalledWith('c1');
    items[2].onSelect();
    expect(a.onTraceFrom).toHaveBeenCalledWith('c1');
    items[3].onSelect();
    expect(a.onSelect).toHaveBeenCalledWith({ kind: 'chassis', id: 'c1' });
  });

  it('offers a device on a shelf or a wall Open, a trace and details, and selects it the way a click does', () => {
    const a = actions();
    const items = menuItemsFor({ kind: 'chassis', id: 'cam', on: 'fixture' }, a);
    expect(items.map((i) => i.label)).toEqual(['Open', 'Trace from here', 'Details']);
    items[1].onSelect();
    expect(a.onTraceFrom).toHaveBeenCalledWith('cam');
    items[2].onSelect();
    expect(a.onSelect).toHaveBeenCalledWith({ kind: 'fixture', id: 'cam' });
  });

  it("offers It's down on a device and a free box when it can be used, and not otherwise", () => {
    const a = { ...actions(), onItsDown: vi.fn() };
    const chassis = menuItemsFor({ kind: 'chassis', id: 'c1' }, a);
    expect(chassis.map((i) => i.label)).toEqual(['Open', 'Open inside', 'Trace from here', 'Details', "It's down", 'Duplicate', 'Remove device']);
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

  it('offers Fit a card on a device only to someone who can draw', () => {
    const go = vi.fn();
    menuItemsFor({ kind: 'chassis', id: 'c1' }, { ...actions(), onFitCard: go }).find((i) => i.label === 'Fit a card')!.onSelect();
    expect(go).toHaveBeenLastCalledWith('c1');
    expect(menuItemsFor({ kind: 'chassis', id: 'c1' }, actions()).map((i) => i.label)).not.toContain('Fit a card');
  });

  it('offers cable suggestions on a device, a free box and the empty canvas when they can be used', () => {
    const go = vi.fn();
    const a = { ...actions(), onSuggestCables: go };
    const label = DEVICE_WORDS.suggestCables;
    menuItemsFor({ kind: 'chassis', id: 'c1' }, a).find((i) => i.label === label)!.onSelect();
    expect(go).toHaveBeenLastCalledWith('c1');
    menuItemsFor({ kind: 'free', id: 'f1' }, a).find((i) => i.label === label)!.onSelect();
    expect(go).toHaveBeenLastCalledWith('f1');
    menuItemsFor({ kind: 'pane' }, a).find((i) => i.label === 'Suggest cables from a neighbour list (LLDP)')!.onSelect();
    expect(go).toHaveBeenLastCalledWith(null);
    expect(menuItemsFor({ kind: 'chassis', id: 'c1' }, actions()).map((i) => i.label)).not.toContain(label);
  });

  it('offers a rack its details and a new device', () => {
    const a = actions();
    const items = menuItemsFor({ kind: 'rack', id: 'r1' }, a);
    expect(items.map((i) => i.label)).toEqual(['Details', 'Add a device', 'Close gaps', 'Copy rack, with its cables']);
    items[1].onSelect();
    expect(a.onAddDevice).toHaveBeenCalledWith('r1');
    items[2].onSelect();
    expect(a.onCloseRackGaps).toHaveBeenCalledWith('r1');
    items[3].onSelect();
    expect(a.onCopyRack).toHaveBeenCalledWith('r1');
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

  it('groups a device menu under Look, Work on it and Copy, with removal apart', () => {
    const a = { ...actions(), onItsDown: vi.fn(), onShowInInventory: vi.fn(), onCopyLink: vi.fn(), onPrintLabel: vi.fn() };
    const items = menuItemsFor({ kind: 'chassis', id: 'c1' }, a);
    expect(items.map((i) => [i.group ?? null, i.label])).toEqual([
      ['Look', 'Open'],
      ['Look', 'Open inside'],
      ['Look', 'Trace from here'],
      ['Look', 'Show in Inventory'],
      ['Look', 'Details'],
      ['Work on it', "It's down"],
      ['Copy', 'Duplicate'],
      ['Copy', 'Copy link'],
      ['Copy', 'Print its label'],
      [null, 'Remove device'],
    ]);
    items.find((i) => i.label === 'Copy link')!.onSelect();
    expect(a.onCopyLink).toHaveBeenCalledWith('c1');
  });

  it('names Swap model by whether the device has a model, and greys Add a port with its reason', () => {
    const base = { ...actions(), onSwapModel: vi.fn(), onAddPort: vi.fn() };
    const modelled = menuItemsFor({ kind: 'chassis', id: 'c1' }, { ...base, hasModel: () => true, addPortRefusal: () => 'Its ports come from its model' });
    expect(modelled.map((i) => i.label)).toContain('Swap model…');
    expect(modelled.find((i) => i.label === 'Add a port')!.disabled).toBe('Its ports come from its model');
    const bare = menuItemsFor({ kind: 'chassis', id: 'c1' }, { ...base, hasModel: () => false, addPortRefusal: () => null });
    expect(bare.map((i) => i.label)).toContain('Give it a catalogue model…');
    expect(bare.find((i) => i.label === 'Add a port')!.disabled).toBeUndefined();
  });

  it('greys Duplicate on a device in no rack, and Termix on one with no address, each with why', () => {
    const a = { ...actions(), onOpenInTermix: vi.fn(), termixRefusal: () => 'Give it a management address first', duplicateRefusal: () => 'Place it in a rack first' };
    const items = menuItemsFor({ kind: 'chassis', id: 'c1' }, a);
    expect(items.find((i) => i.label === 'Duplicate')!.disabled).toBe('Place it in a rack first');
    expect(items.find((i) => i.label === 'Open in Termix')!.disabled).toBe('Give it a management address first');
    // A free box duplicates as a box, wherever it is.
    expect(menuItemsFor({ kind: 'free', id: 'f1' }, a).find((i) => i.label === 'Duplicate')!.disabled).toBeUndefined();
  });

  it("leaves Details out of the panel's own menu, which is the details", () => {
    const labels = deviceMenuItems('c1', actions(), { inPanel: true }).map((i) => i.label);
    expect(labels).not.toContain('Details');
    expect(labels).toContain('Remove device');
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
    expect(menuItemsFor({ kind: 'rack', id: 'r1' }, a).map((i) => i.label)).toEqual(['Details', 'Add a device', 'Close gaps', 'Copy rack, with its cables']);
    const items = menuItemsFor({ kind: 'rack', id: 'r1', freeU: { u: 12, ...at } }, a);
    expect(items.map((i) => i.label)).toEqual(['Details', 'Add here (U12)', 'Add a device', 'Add a note here', 'Close gaps', 'Copy rack, with its cables']);
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
