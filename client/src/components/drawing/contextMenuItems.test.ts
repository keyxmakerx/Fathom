import { describe, expect, it, vi } from 'vitest';

import { DEVICE_WORDS, FIRMWARE_NEEDS_VERSION, PASTE_NEIGHBOURS, cableRunItems, deviceMenuItems, menuItemsFor, type MenuActions, type MenuItem } from './contextMenuItems';
import { shortcutText } from '../shell/shortcuts';

const fn = () => vi.fn();

/** What a writer's canvas can do to a device, a rack, a cable and the empty canvas. */
function actions(): MenuActions {
  return {
    onSelect: fn(),
    onOpen: fn(),
    onOpenInside: fn(),
    onOpenShelf: fn(),
    onTraceFrom: fn(),
    onDuplicateDevice: fn(),
    onRemoveDevice: fn(),
    onDisconnect: fn(),
    onAddDevice: fn(),
    onCloseRackGaps: fn(),
    onCopyRack: fn(),
    onAddRack: fn(),
    onAddWall: fn(),
    onPasteConfig: fn(),
    onAddInRack: fn(),
    onAddBoxHere: fn(),
    onAddLabelHere: fn(),
    onDuplicateFree: fn(),
    onRemoveFree: fn(),
  };
}

/** Everything a device can do, so the whole list shows. */
function deviceActions(): MenuActions {
  return {
    ...actions(),
    onItsDown: fn(),
    onPlanChange: fn(),
    onPlanFirmware: fn(),
    onSwapModel: fn(),
    onFitCard: fn(),
    onSuggestCables: fn(),
    onAddPort: fn(),
    onTakeOut: fn(),
    onShowInInventory: fn(),
    onOpenInTermix: fn(),
    onCopyLink: fn(),
    onPrintLabel: fn(),
  };
}

const labels = (items: readonly MenuItem[]) => items.map((i) => i.label);
/** The rows in their groups, "|" between: how the menu draws them. */
function shape(items: readonly MenuItem[]): string {
  const out: string[] = [];
  items.forEach((item, i) => {
    const before = items[i - 1];
    if (i > 0 && (item.danger || item.group !== before?.group)) out.push('|');
    out.push(item.label);
  });
  return out.join(' / ');
}

describe('the device menu (r116)', () => {
  it('is the ten rows, in three groups and removal apart', () => {
    const items = menuItemsFor({ kind: 'chassis', id: 'c1' }, deviceActions());
    expect(labels(items)).toHaveLength(10);
    expect(shape(items)).toBe(
      "Open / Trace from here / Show in Inventory / | / It's down / Plan a change… / Open in Termix / | / Duplicate / Copy link / Print label / | / Remove device",
    );
    expect(items.at(-1)!.danger).toBe(true);
    // The keys come from the shortcuts table, so the menu says what the sheet and the buttons say.
    expect(items.at(-1)!.keys).toBe(shortcutText('delete'));
    expect(items.find((i) => i.label === 'Duplicate')!.keys).toBe(shortcutText('duplicate'));
    expect(shortcutText('duplicate', true)).toBe('Cmd+D');
  });

  it('leaves Open in Termix out where Termix is not set up', () => {
    const { onOpenInTermix: _termix, ...noTermix } = deviceActions();
    expect(labels(menuItemsFor({ kind: 'chassis', id: 'c1' }, noTermix))).not.toContain('Open in Termix');
    expect(labels(menuItemsFor({ kind: 'chassis', id: 'c1' }, noTermix))).toHaveLength(9);
  });

  it('no longer lists what moved to the panel or elsewhere', () => {
    const gone = [DEVICE_WORDS.openInside, DEVICE_WORDS.details, DEVICE_WORDS.planFirmware, DEVICE_WORDS.swapModel, DEVICE_WORDS.giveModel, DEVICE_WORDS.fitCard, DEVICE_WORDS.addPort, DEVICE_WORDS.takeOut, DEVICE_WORDS.suggestCables];
    const got = labels(menuItemsFor({ kind: 'chassis', id: 'c1' }, deviceActions()));
    for (const word of gone) expect(got).not.toContain(word);
  });

  it('runs each row on its device', () => {
    const a = deviceActions();
    const items = menuItemsFor({ kind: 'chassis', id: 'c1' }, a);
    const run = (label: string) => items.find((i) => i.label === label)!.onSelect();
    run('Open');
    expect(a.onOpen).toHaveBeenCalledWith('c1');
    run('Trace from here');
    expect(a.onTraceFrom).toHaveBeenCalledWith('c1');
    run('Duplicate');
    expect(a.onDuplicateDevice).toHaveBeenCalledWith('c1');
    run("It's down");
    expect(a.onItsDown).toHaveBeenCalledWith('c1');
    run('Plan a change…');
    expect(a.onPlanChange).toHaveBeenCalledWith('c1');
    run('Copy link');
    expect(a.onCopyLink).toHaveBeenCalledWith('c1');
    run('Remove device');
    expect(a.onRemoveDevice).toHaveBeenCalledWith('c1');
  });

  it('is the same for a device on a shelf or a wall', () => {
    const a = deviceActions();
    const racked = labels(menuItemsFor({ kind: 'chassis', id: 'cam' }, a));
    for (const on of ['fixture', 'occupant'] as const) expect(labels(menuItemsFor({ kind: 'chassis', id: 'cam', on }, a))).toEqual(racked);
  });

  it('greys Duplicate on a device in no rack, and Termix on one with no address, each with why', () => {
    const a = { ...deviceActions(), termixRefusal: () => 'Give it a management address first', duplicateRefusal: () => 'Place it in a rack first' };
    const items = menuItemsFor({ kind: 'chassis', id: 'c1' }, a);
    expect(items.find((i) => i.label === 'Duplicate')!.disabled).toBe('Place it in a rack first');
    expect(items.find((i) => i.label === 'Open in Termix')!.disabled).toBe('Give it a management address first');
    // A free box duplicates as a box, wherever it is.
    expect(menuItemsFor({ kind: 'free', id: 'f1' }, a).find((i) => i.label === 'Duplicate')!.disabled).toBeUndefined();
  });

  it('gives a reader what a reader can do, and never a row that edits', () => {
    const reader: MenuActions = { onSelect: fn(), onOpen: fn(), onTraceFrom: fn() };
    expect(labels(menuItemsFor({ kind: 'chassis', id: 'c1' }, reader))).toEqual(['Open', 'Trace from here']);
    expect(menuItemsFor({ kind: 'pane' }, reader)).toEqual([]);
  });

  it('does not offer a label or a cable a plan or an "It\'s down"', () => {
    const a = deviceActions();
    expect(labels(menuItemsFor({ kind: 'label', id: 'l1' }, a))).not.toContain("It's down");
    expect(labels(menuItemsFor({ kind: 'cable', id: 'k1' }, a))).not.toContain(DEVICE_WORDS.planChange);
  });
});

describe('Ctrl K still finds every device action by name', () => {
  it('lists the ten and the ones that left the menu', () => {
    const items = deviceMenuItems('c1', deviceActions(), { inPanel: true, all: true });
    expect(labels(items)).toEqual(
      expect.arrayContaining([
        'Open',
        DEVICE_WORDS.openInside,
        DEVICE_WORDS.trace,
        DEVICE_WORDS.itsDown,
        DEVICE_WORDS.planChange,
        DEVICE_WORDS.planFirmware,
        DEVICE_WORDS.swapModel,
        DEVICE_WORDS.fitCard,
        DEVICE_WORDS.suggestCables,
        DEVICE_WORDS.addPort,
        DEVICE_WORDS.takeOut,
        DEVICE_WORDS.remove,
      ]),
    );
    expect(labels(items).length).toBeGreaterThan(labels(deviceMenuItems('c1', deviceActions(), { inPanel: true })).length);
  });

  it('adds Details outside the panel, and runs each as before', () => {
    const a = deviceActions();
    const items = deviceMenuItems('c1', a, { all: true, on: 'occupant' });
    items.find((i) => i.label === DEVICE_WORDS.details)!.onSelect();
    expect(a.onSelect).toHaveBeenLastCalledWith({ kind: 'occupant', id: 'c1' });
    items.find((i) => i.label === DEVICE_WORDS.takeOut)!.onSelect();
    expect(a.onTakeOut).toHaveBeenCalledWith('c1');
    items.find((i) => i.label === DEVICE_WORDS.suggestCables)!.onSelect();
    expect(a.onSuggestCables).toHaveBeenLastCalledWith('c1');
  });

  it('keeps the greyed reasons: firmware needs a version, Add a port waits on the model', () => {
    const a = { ...deviceActions(), firmwareNeedsVersion: () => true, hasModel: () => true, addPortRefusal: () => 'Its ports come from its model' };
    const items = deviceMenuItems('c1', a, { all: true, inPanel: true });
    expect(items.find((i) => i.label === DEVICE_WORDS.planFirmware)!.disabled).toBe(FIRMWARE_NEEDS_VERSION);
    expect(items.find((i) => i.label === DEVICE_WORDS.addPort)!.disabled).toBe('Its ports come from its model');
    expect(labels(items)).toContain('Swap model…');
    const bare = deviceMenuItems('c1', { ...a, hasModel: () => false }, { all: true, inPanel: true });
    expect(labels(bare)).toContain('Give it a catalogue model…');
  });

  it("is what a free box's menu has always been (r116 leaves that one as it was)", () => {
    const free = labels(menuItemsFor({ kind: 'free', id: 'f1' }, deviceActions()));
    expect(free).toEqual(expect.arrayContaining([DEVICE_WORDS.planFirmware, DEVICE_WORDS.swapModel, DEVICE_WORDS.fitCard, DEVICE_WORDS.addPort, DEVICE_WORDS.details]));
    expect(free).not.toContain(DEVICE_WORDS.takeOut);
    expect(free).not.toContain(DEVICE_WORDS.openInside);
    const a = deviceActions();
    menuItemsFor({ kind: 'free', id: 'f1' }, a)[0]!.onSelect();
    expect(a.onOpen).toHaveBeenCalledWith('f1');
  });
});

describe('the rack menu (r116)', () => {
  const at = { screen: { x: 1, y: 2 }, flow: { x: 3, y: 4 } };
  const rackActions = (): MenuActions => ({
    ...actions(),
    onAddShelf: fn(),
    onAddCableRun: fn(),
    onAskCableRun: fn(),
    onPrintRackLabel: fn(),
    onRemoveHolder: fn(),
    holderOf: () => ({ noun: 'rack', onIt: '2 devices, 1 shelf' }),
  });

  it('is the seven rows, with the free unit named when the click landed on one', () => {
    const items = menuItemsFor({ kind: 'rack', id: 'r1', freeU: { u: 3, ...at } }, rackActions());
    expect(labels(items)).toHaveLength(7);
    expect(shape(items)).toBe('Add a device here (U3) / Add a shelf / Add a cable run… / | / Close gaps / Copy rack, with its cables / Print label / | / Remove rack');
  });

  it('adds a device to the highest free unit when the click was not on a free one', () => {
    const a = rackActions();
    const items = menuItemsFor({ kind: 'rack', id: 'r1' }, a);
    expect(labels(items)[0]).toBe('Add a device');
    items[0]!.onSelect();
    expect(a.onAddDevice).toHaveBeenCalledWith('r1');
  });

  it('runs each row on its rack, and asks the cable run its one question after the click', () => {
    const a = rackActions();
    const items = menuItemsFor({ kind: 'rack', id: 'r1', freeU: { u: 12, ...at } }, a);
    const run = (label: string) => items.find((i) => i.label === label)!.onSelect();
    run('Add a device here (U12)');
    expect(a.onAddInRack).toHaveBeenCalledWith('r1', 12, expect.objectContaining({ screen: at.screen }));
    run('Add a shelf');
    expect(a.onAddShelf).toHaveBeenCalledWith('r1', 12);
    run('Add a cable run…');
    expect(a.onAskCableRun).toHaveBeenCalledWith('r1');
    expect(a.onAddCableRun).not.toHaveBeenCalled();
    run('Close gaps');
    expect(a.onCloseRackGaps).toHaveBeenCalledWith('r1');
    run('Copy rack, with its cables');
    expect(a.onCopyRack).toHaveBeenCalledWith('r1');
    run('Print label');
    expect(a.onPrintRackLabel).toHaveBeenCalledWith('r1');
  });

  it('always lists Remove, greyed with what is on it until the rack is empty', () => {
    const remove = menuItemsFor({ kind: 'rack', id: 'r1' }, rackActions()).find((i) => i.label === 'Remove rack');
    expect(remove?.disabled).toBe('Empty it first: 2 devices, 1 shelf');
    expect(remove?.danger).toBe(true);
  });

  it('puts the cable runs in the question: one row on each free side, and removal of each run there', () => {
    const add = vi.fn();
    const remove = vi.fn();
    const run = { id: 'run1', hostId: 'r1', form: 'lacing_bar' as const, side: 'left' as const, label: null, ties: [] };
    const items = cableRunItems('r1', { ...actions(), onAddCableRun: add, onRemoveCableRun: remove, cableRunsOn: () => [run] });
    expect(labels(items)).toEqual(['Add a lacing bar on the right', 'Add a cable tray on top', 'Remove the left lacing bar']);
    items[1]!.onSelect();
    expect(add).toHaveBeenCalledWith('r1', 'tray', 'top');
    expect(items[2]!.danger).toBe(true);
    items[2]!.onSelect();
    expect(remove).toHaveBeenCalledWith('run1');
  });
});

describe('the empty canvas menu (r116)', () => {
  const at = { screen: { x: 1, y: 2 }, flow: { x: 30, y: 40 } };
  const paneActions = (): MenuActions => ({ ...actions(), onAskRackSize: fn(), onSuggestCables: fn() });

  it('is the eight rows in three groups', () => {
    const items = menuItemsFor({ kind: 'pane', at }, paneActions());
    expect(labels(items)).toHaveLength(8);
    expect(shape(items)).toBe(`Add a device here / Add a rack… / Add a wall / | / Add a label / Add an area / Add a note / | / Paste config / ${PASTE_NEIGHBOURS}`);
    expect(PASTE_NEIGHBOURS).toBe('Paste a neighbour list (LLDP)');
  });

  it('asks the rack size after the click instead of listing three rows', () => {
    const a = paneActions();
    menuItemsFor({ kind: 'pane', at }, a).find((i) => i.label === 'Add a rack…')!.onSelect();
    expect(a.onAskRackSize).toHaveBeenCalled();
    expect(a.onAddRack).not.toHaveBeenCalled();
  });

  it('runs the rest at the spot clicked', () => {
    const a = paneActions();
    const items = menuItemsFor({ kind: 'pane', at }, a);
    const run = (label: string) => items.find((i) => i.label === label)!.onSelect();
    run('Add a device here');
    expect(a.onAddBoxHere).toHaveBeenCalledWith(at);
    run('Add a note');
    expect(a.onAddLabelHere).toHaveBeenLastCalledWith('note', at.flow);
    run('Add an area');
    expect(a.onAddLabelHere).toHaveBeenLastCalledWith('area', at.flow);
    run('Add a label');
    expect(a.onAddLabelHere).toHaveBeenLastCalledWith('text', at.flow);
    run('Add a wall');
    expect(a.onAddWall).toHaveBeenCalled();
    run('Paste config');
    expect(a.onPasteConfig).toHaveBeenCalled();
    run(PASTE_NEIGHBOURS);
    expect(a.onSuggestCables).toHaveBeenLastCalledWith(null);
  });

  it('offers a note on its own where that is all the canvas can do', () => {
    const onAddLabelHere = vi.fn();
    const items = menuItemsFor({ kind: 'pane', at }, { onSelect: fn(), onAddLabelHere });
    expect(labels(items)).toEqual(['Add a label', 'Add an area', 'Add a note']);
  });
});

describe('the port menu (r116)', () => {
  const portActions = (over: Partial<MenuActions> = {}): MenuActions => ({
    ...actions(),
    portFacts: () => ({ cableId: 'k1', farPortId: 'p9', far: null, deviceId: 'c1' }),
    onLinkSite: fn(),
    onOpenFarSite: fn(),
    ...over,
  });

  it('is its own menu, not its device\'s: five rows in three groups', () => {
    const items = menuItemsFor({ kind: 'port', id: 'p1' }, portActions());
    expect(shape(items)).toBe('Select its cable / Go to far end / Trace from here / | / Link to another site… / | / Disconnect');
    expect(labels(items)).toHaveLength(5);
    expect(items.at(-1)!.danger).toBe(true);
  });

  it('selects its cable, goes to the far port, traces from its device and disconnects its cable', () => {
    const a = portActions();
    const items = menuItemsFor({ kind: 'port', id: 'p1' }, a);
    const run = (label: string) => items.find((i) => i.label === label)!.onSelect();
    run('Select its cable');
    expect(a.onSelect).toHaveBeenLastCalledWith({ kind: 'cable', id: 'k1' });
    run('Go to far end');
    expect(a.onSelect).toHaveBeenLastCalledWith({ kind: 'port', id: 'p9' });
    run('Trace from here');
    expect(a.onTraceFrom).toHaveBeenCalledWith('c1');
    run('Disconnect');
    expect(a.onDisconnect).toHaveBeenCalledWith('k1');
  });

  it('greys what needs a cable, with why, on a port with none; Link to another site is still there', () => {
    const items = menuItemsFor({ kind: 'port', id: 'p1' }, portActions({ portFacts: () => ({ cableId: null, farPortId: null, far: null, deviceId: 'c1' }) }));
    for (const label of ['Select its cable', 'Go to far end', 'Disconnect']) expect(items.find((i) => i.label === label)!.disabled).toBe('Nothing is plugged into it');
    expect(items.find((i) => i.label === 'Link to another site…')!.disabled).toBeUndefined();
    expect(items.find((i) => i.label === 'Trace from here')!.disabled).toBeUndefined();
  });

  it('greys Link to another site on a port that has a cable already', () => {
    const items = menuItemsFor({ kind: 'port', id: 'p1' }, portActions());
    expect(items.find((i) => i.label === 'Link to another site…')!.disabled).toBe('It has a cable already');
  });

  it('opens the far site when the far end is a link between sites', () => {
    const far = { design: 'd2', element: 'port:9' };
    const a = portActions({ portFacts: () => ({ cableId: 'k1', farPortId: null, far, deviceId: 'c1' }) });
    menuItemsFor({ kind: 'port', id: 'p1' }, a).find((i) => i.label === 'Go to far end')!.onSelect();
    expect(a.onOpenFarSite).toHaveBeenCalledWith(far);
  });

  it('says so when the cable has no far end', () => {
    const items = menuItemsFor({ kind: 'port', id: 'p1' }, portActions({ portFacts: () => ({ cableId: 'k1', farPortId: null, far: null, deviceId: 'c1' }) }));
    expect(items.find((i) => i.label === 'Go to far end')!.disabled).toBe('Its cable has no far end');
  });

  it('gives a reader the three that look, and no Link or Disconnect', () => {
    const items = menuItemsFor({ kind: 'port', id: 'p1' }, { onSelect: fn(), onTraceFrom: fn(), portFacts: () => ({ cableId: 'k1', farPortId: 'p9', far: null, deviceId: 'c1' }) });
    expect(labels(items)).toEqual(['Select its cable', 'Go to far end', 'Trace from here']);
  });
});

describe('the cable menu (r116)', () => {
  const cableActions = (over: Partial<MenuActions> = {}): MenuActions => ({
    ...actions(),
    cableEndFacts: () => [
      { portId: 'pa', chassisId: 'ca', far: null },
      { portId: 'pb', chassisId: 'cb', far: null },
    ],
    onTracePath: fn(),
    onHideCable: fn(),
    looseState: () => 'unknown',
    onSetNeedsFinishing: fn(),
    ...over,
  });

  it('is six rows in three groups on a cable with one end connected', () => {
    const items = menuItemsFor({ kind: 'cable', id: 'k1' }, cableActions());
    expect(shape(items)).toBe('Go to end A / Go to end B / Trace this path / | / Hide this cable / Needs finishing / | / Disconnect');
    expect(labels(items)).toHaveLength(6);
  });

  it('leaves Needs finishing out of a cable with both ends, and reads Clear when it is marked', () => {
    expect(labels(menuItemsFor({ kind: 'cable', id: 'k1' }, cableActions({ looseState: () => null })))).toEqual(['Go to end A', 'Go to end B', 'Trace this path', 'Hide this cable', 'Disconnect']);
    const set = vi.fn();
    const marked = menuItemsFor({ kind: 'cable', id: 'k1' }, cableActions({ looseState: () => 'needs-finishing', onSetNeedsFinishing: set }));
    marked.find((i) => i.label === 'Clear "Needs finishing"')!.onSelect();
    expect(set).toHaveBeenLastCalledWith('k1', false);
    menuItemsFor({ kind: 'cable', id: 'k1' }, cableActions({ onSetNeedsFinishing: set })).find((i) => i.label === 'Needs finishing')!.onSelect();
    expect(set).toHaveBeenLastCalledWith('k1', true);
  });

  it('goes to either end, traces the path, hides the cable and disconnects it', () => {
    const a = cableActions();
    const items = menuItemsFor({ kind: 'cable', id: 'k1' }, a);
    const run = (label: string) => items.find((i) => i.label === label)!.onSelect();
    run('Go to end A');
    expect(a.onSelect).toHaveBeenLastCalledWith({ kind: 'port', id: 'pa' });
    run('Go to end B');
    expect(a.onSelect).toHaveBeenLastCalledWith({ kind: 'port', id: 'pb' });
    run('Trace this path');
    expect(a.onTracePath).toHaveBeenCalledWith('k1');
    run('Hide this cable');
    expect(a.onHideCable).toHaveBeenCalledWith('k1');
    run('Disconnect');
    expect(a.onDisconnect).toHaveBeenCalledWith('k1');
    expect(items.find((i) => i.label === 'Disconnect')!.danger).toBe(true);
  });

  it('greys an end that is not there yet or lies outside, with why', () => {
    const a = cableActions({ cableEndFacts: () => [{ portId: 'pa', chassisId: 'ca', far: null }, null] });
    expect(menuItemsFor({ kind: 'cable', id: 'k1' }, a).find((i) => i.label === 'Go to end B')!.disabled).toBe('This end is not connected yet');
    const outside = cableActions({ cableEndFacts: () => [{ portId: 'pa', chassisId: 'ca', far: null }, { portId: null, chassisId: null, far: null }] });
    expect(menuItemsFor({ kind: 'cable', id: 'k1' }, outside).find((i) => i.label === 'Go to end B')!.disabled).toBe('This end is outside this design');
  });
});

describe('the portal tray menu (r116)', () => {
  it('is its own menu, not the empty canvas\'s: Open there and Go to far end', () => {
    const far = { design: 'd2', element: 'port:9' };
    const a: MenuActions = { onSelect: fn(), onOpenFarSite: fn(), onAddRack: fn(), onAddWall: fn() };
    const items = menuItemsFor({ kind: 'tray', far }, a);
    expect(labels(items)).toEqual(['Open there', 'Go to far end']);
    for (const item of items) {
      expect(item.disabled).toBeUndefined();
      item.onSelect();
    }
    expect(a.onOpenFarSite).toHaveBeenCalledTimes(2);
    expect(a.onOpenFarSite).toHaveBeenCalledWith(far);
  });

  it('greys both on a tray that is not a link to another site, with why', () => {
    const items = menuItemsFor({ kind: 'tray' }, { onSelect: fn(), onOpenFarSite: fn() });
    expect(labels(items)).toEqual(['Open there', 'Go to far end']);
    for (const item of items) expect(item.disabled).toBe('Only a link to another site goes anywhere else');
  });
});

describe('menus r116 leaves as they were', () => {
  it('always lists Remove on a wall, greyed with what is on it until it is empty', () => {
    const onRemoveHolder = vi.fn();
    const empty = menuItemsFor({ kind: 'surface', id: 'w1' }, { ...actions(), onRemoveHolder, holderOf: () => ({ noun: 'wall', onIt: '' }) });
    expect(labels(empty)).toEqual(['Details', 'Remove wall']);
    empty[1]!.onSelect();
    expect(onRemoveHolder).toHaveBeenCalledWith('w1');
    const full = menuItemsFor({ kind: 'surface', id: 'w1' }, { ...actions(), onRemoveHolder, holderOf: () => ({ noun: 'wall', onIt: '1 device' }) });
    expect(full[1]!.disabled).toBe('Empty it first: 1 device');
  });

  it('gives a reader a wall menu with Details, not the browser menu', () => {
    expect(labels(menuItemsFor({ kind: 'surface', id: 'w1' }, { onSelect: fn() }))).toEqual(['Details']);
  });

  it('offers cable runs on a wall too', () => {
    const items = menuItemsFor({ kind: 'surface', id: 'w1' }, { ...actions(), onAddCableRun: fn(), onRemoveCableRun: fn(), cableRunsOn: () => [] });
    expect(labels(items)).toEqual(['Details', 'Add a lacing bar on the left', 'Add a lacing bar on the right', 'Add a cable tray on top']);
  });

  it('offers Open shelf first on a shelf, then Details', () => {
    const a = actions();
    const items = menuItemsFor({ kind: 'shelf', id: 's1' }, a);
    expect(labels(items)).toEqual(['Open shelf', 'Details']);
    items[0]!.onSelect();
    expect(a.onOpenShelf).toHaveBeenCalledWith('s1');
    items[1]!.onSelect();
    expect(a.onSelect).toHaveBeenCalledWith({ kind: 'shelf', id: 's1' });
    expect(labels(menuItemsFor({ kind: 'shelf', id: 's1' }, { onSelect: fn() }))).toEqual(['Details']);
  });

  it('keeps the label and line menus', () => {
    const a = actions();
    expect(labels(menuItemsFor({ kind: 'label', id: 'l1' }, a))).toEqual(['Details', 'Duplicate', 'Remove']);
    expect(labels(menuItemsFor({ kind: 'line', id: 'n1' }, a))).toEqual(['Details', 'Remove']);
  });
});
