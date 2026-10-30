import type { CableRunSide, CableRunView } from '../../document/cableRuns';
import type { Selection } from './contract';

/** What a right-click landed on (ADR-0060 decision 4). */
export type MenuTarget =
  /** `on` is set for a device on a shelf or a surface rather than in a rack unit: its menu offers what
   * works there, and Details selects it the way a click does. */
  | { kind: 'chassis'; id: string; on?: 'occupant' | 'fixture' }
  /** `freeU` is the free unit the click landed on, with the click's pane and flow position. */
  | { kind: 'rack'; id: string; freeU?: { u: number; screen: Point; flow: Point } }
  | { kind: 'cable'; id: string }
  /** A wall, desk or ceiling panel. */
  | { kind: 'surface'; id: string }
  | { kind: 'free'; id: string }
  | { kind: 'label'; id: string }
  | { kind: 'line'; id: string }
  /** `at` is where the click landed, in pane pixels and flow units. */
  | { kind: 'pane'; at?: { screen: Point; flow: Point } };

type Point = { x: number; y: number };

export interface MenuItem {
  label: string;
  onSelect: () => void;
  /** Removes something; drawn apart from the rest. */
  danger?: boolean;
  /** The heading this item sits under; a menu draws one each time it changes. */
  group?: string;
  /** Why it cannot be used yet. The item stays in the menu, greyed, with this line under it, so a
   * person learns it exists (sign-off r58). */
  disabled?: string;
  /** Its key, as the shortcuts sheet shows it ("Ctrl D"). */
  keys?: string;
}

/**
 * Sign-off r58 and r60: the words for what can be done to a device, one list for every way in: the
 * panel's foot and its ⋯ menu, right-click, Ctrl K and Inventory. They used to be written in each
 * place and had drifted ("Trace a path from here" beside "Trace from here", "Inside" beside "Open
 * inside").
 */
export const DEVICE_WORDS = {
  open: 'Open',
  openInside: 'Open inside',
  trace: 'Trace from here',
  showInInventory: 'Show in Inventory',
  details: 'Details',
  itsDown: "It's down",
  planChange: 'Plan a change',
  planFirmware: 'Plan a firmware upgrade',
  swapModel: 'Swap model…',
  giveModel: 'Give it a catalogue model…',
  fitCard: 'Fit a card',
  suggestCables: 'Suggest cables (LLDP)',
  addPort: 'Add a port',
  termix: 'Open in Termix',
  duplicate: 'Duplicate',
  copyLink: 'Copy link',
  printLabel: 'Print its label',
  remove: 'Remove device',
} as const;

/** The headings a device's menu is grouped under; removal sits apart, after a rule. */
export const DEVICE_GROUPS = { look: 'Look', work: 'Work on it', copy: 'Copy' } as const;

/** Why "Plan a firmware upgrade" cannot be used yet. */
export const FIRMWARE_NEEDS_VERSION = 'Choose a version on its model first';
/** Why a port cannot be added by hand. */
export const PORTS_FROM_MODEL = 'Its ports come from its model';
/** Why Termix cannot open it. */
export const TERMIX_NEEDS_ADDRESS = 'Give it a management address first';
/** Why an unplaced device cannot be duplicated: the copy goes in the rack beside it. */
export const DUPLICATE_NEEDS_RACK = 'Place it in a rack first';

/** The actions a menu may offer. An absent one (a reader, or a place that
 * cannot do it) leaves its item out. */
export interface MenuActions {
  onSelect(selection: Selection | null): void;
  /** Opens a device's config drawer; zoom never does. */
  onOpen?(chassisId: string): void;
  /** Opens a device's inside view, where the device has one. */
  onOpenInside?(chassisId: string): void;
  /** Starts a path trace from a device (ADR-0061 item 9). */
  onTraceFrom?(chassisId: string): void;
  onDuplicateDevice?(chassisId: string): void;
  /** Why this device cannot be duplicated (it is in no rack), or null when it can. */
  duplicateRefusal?(chassisId: string): string | null;
  /** Opens a maintenance plan on a device (ADR-0061 round 7). */
  onPlanChange?(elementId: string): void;
  /** Plans a firmware upgrade for a device (firmware). Absent for a reader or where firmware is not open. */
  onPlanFirmware?(chassisId: string): void;
  /** True when the device's model has no chosen version yet, so the item says so and goes to the model's page. */
  firmwareNeedsVersion?(chassisId: string): boolean;
  /** Opens the "It's down" checklist on a device (ADR-0061 troubleshooting). */
  onItsDown?(elementId: string): void;
  /** Opens cable suggestions from a neighbour list (LLDP), for a device or, from the empty canvas, any. */
  onSuggestCables?(chassisId: string | null): void;
  /** Right-click "Fit a card" on a device (ADR-0073). Absent for a reader. */
  onFitCard?(chassisId: string): void;
  onRemoveDevice?(chassisId: string): void;
  /** Sign-off r58: opens the device's own page in Inventory. */
  onShowInInventory?(chassisId: string): void;
  /** Opens Swap model (or Give it a catalogue model, for a device with none) in its panel. */
  onSwapModel?(chassisId: string): void;
  /** Whether the device has a catalogue model, which decides the Swap model item's words. */
  hasModel?(chassisId: string): boolean;
  /** Opens the panel's Add a port form. */
  onAddPort?(chassisId: string): void;
  /** Why a port cannot be added by hand (its ports come from its model), or null when it can. */
  addPortRefusal?(chassisId: string): string | null;
  /** Opens the device's terminal in Termix; absent where the server names no Termix, or it is off. */
  onOpenInTermix?(chassisId: string): void;
  /** Why Termix cannot open this device (it has no management address), or null when it can. */
  termixRefusal?(chassisId: string): string | null;
  /** Copies the device's link: the one its printed label holds, which opens its page after sign-in. */
  onCopyLink?(chassisId: string): void;
  /** Prints the device's own label. */
  onPrintLabel?(chassisId: string): void;
  onDisconnect?(cableId: string): void;
  /** Missing links: which kind of loose end this cable has (one end connected), or null for a cable
   * with both ends, which has nothing to mark. */
  looseState?(cableId: string): 'needs-finishing' | 'unknown' | null;
  onSetNeedsFinishing?(cableId: string, on: boolean): void;
  onAddDevice?(rackId: string): void;
  /** Slides everything in a rack up to close the gaps (round 15). */
  onCloseRackGaps?(rackId: string): void;
  /** A copy of the whole rack with its cables (round 15). */
  onCopyRack?(rackId: string): void;
  onAddRack?(heightU: number): void;
  onAddWall?(): void;
  onPasteConfig?(): void;
  onAddInRack?(rackId: string, u: number, at: { screen: Point; flow: Point }): void;
  onAddBoxHere?(at: { screen: Point; flow: Point }): void;
  onAddLabelHere?(form: 'text' | 'area' | 'note', flow: Point): void;
  onDuplicateFree?(ids: string[]): void;
  onRemoveFree?(ids: string[]): void;
  /** Cable runs (schema 0.23): a lacing bar on a rack's side, or a tray along its top. */
  onAddCableRun?(hostId: string, form: 'tray' | 'lacing_bar', side: CableRunSide): void;
  onRemoveCableRun?(runId: string): void;
  /** The runs already on a rack, so the menu offers only free sides and names what it removes. */
  cableRunsOn?(rackId: string): readonly CableRunView[];
}

const RUN_OFFERS: readonly { form: 'tray' | 'lacing_bar'; side: CableRunSide; add: string; remove: string }[] = [
  { form: 'lacing_bar', side: 'left', add: 'Add a lacing bar on the left', remove: 'Remove the left lacing bar' },
  { form: 'lacing_bar', side: 'right', add: 'Add a lacing bar on the right', remove: 'Remove the right lacing bar' },
  { form: 'tray', side: 'top', add: 'Add a cable tray on top', remove: 'Remove the cable tray on top' },
];

/** The rack sizes the empty canvas's menu offers (ADR-0060 decision 5). */
const RACK_SIZES = [42, 24, 12] as const;

/** A rack's or wall's cable runs: one on each free side, and removal of each run there. */
function pushRunItems(items: MenuItem[], hostId: string, actions: MenuActions): void {
  const runs = actions.cableRunsOn?.(hostId) ?? [];
  if (actions.onAddCableRun) {
    for (const o of RUN_OFFERS) {
      if (!runs.some((r) => r.side === o.side)) items.push({ label: o.add, onSelect: () => actions.onAddCableRun?.(hostId, o.form, o.side) });
    }
  }
  if (actions.onRemoveCableRun) {
    for (const r of runs) {
      const offer = RUN_OFFERS.find((o) => o.side === r.side);
      const label = offer?.remove ?? `Remove the ${r.side} cable run`;
      items.push({ label, onSelect: () => actions.onRemoveCableRun?.(r.id), danger: true });
    }
  }
}

/** Pure: the items a right-click on `target` offers, in order. */
export function menuItemsFor(target: MenuTarget, actions: MenuActions): MenuItem[] {
  const items: MenuItem[] = [];
  switch (target.kind) {
    case 'chassis': {
      items.push(...deviceMenuItems(target.id, actions, { on: target.on }));
      break;
    }
    case 'rack': {
      const { id } = target;
      items.push({ label: 'Details', onSelect: () => actions.onSelect({ kind: 'rack', id }) });
      const free = target.freeU;
      if (free && actions.onAddInRack) items.push({ label: `Add here (U${free.u})`, onSelect: () => actions.onAddInRack?.(id, free.u, free) });
      if (actions.onAddDevice) items.push({ label: 'Add a device', onSelect: () => actions.onAddDevice?.(id) });
      // A note sits on the canvas at the spot, over the rack; it does not follow the rack if it moves.
      if (free && actions.onAddLabelHere) items.push({ label: 'Add a note here', onSelect: () => actions.onAddLabelHere?.('note', free.flow) });
      if (actions.onCloseRackGaps) items.push({ label: 'Close gaps', onSelect: () => actions.onCloseRackGaps?.(id) });
      if (actions.onCopyRack) items.push({ label: 'Copy rack, with its cables', onSelect: () => actions.onCopyRack?.(id) });
      pushRunItems(items, id, actions);
      break;
    }
    case 'surface': {
      pushRunItems(items, target.id, actions);
      break;
    }
    case 'cable': {
      const { id } = target;
      items.push({ label: 'Details', onSelect: () => actions.onSelect({ kind: 'cable', id }) });
      const loose = actions.looseState?.(id) ?? null;
      if (loose != null && actions.onSetNeedsFinishing) {
        const on = loose === 'needs-finishing';
        items.push({ label: on ? 'Clear "Needs finishing"' : 'Needs finishing', onSelect: () => actions.onSetNeedsFinishing?.(id, !on) });
      }
      if (actions.onDisconnect) items.push({ label: 'Disconnect', onSelect: () => actions.onDisconnect?.(id), danger: true });
      break;
    }
    case 'free': {
      items.push(...deviceMenuItems(target.id, actions, { free: true }));
      break;
    }
    case 'label': {
      const { id } = target;
      items.push({ label: 'Details', onSelect: () => actions.onSelect({ kind: 'label', id }) });
      if (actions.onDuplicateFree) items.push({ label: 'Duplicate', onSelect: () => actions.onDuplicateFree?.([id]) });
      if (actions.onRemoveFree) items.push({ label: 'Remove', onSelect: () => actions.onRemoveFree?.([id]), danger: true });
      break;
    }
    case 'line': {
      const { id } = target;
      items.push({ label: 'Details', onSelect: () => actions.onSelect({ kind: 'line', id }) });
      if (actions.onRemoveFree) items.push({ label: 'Remove', onSelect: () => actions.onRemoveFree?.([id]), danger: true });
      break;
    }
    case 'pane': {
      const at = target.at;
      if (at && actions.onAddBoxHere) items.push({ label: 'Add a box here', onSelect: () => actions.onAddBoxHere?.(at) });
      if (at && actions.onAddLabelHere) {
        items.push({ label: 'Add a label here', onSelect: () => actions.onAddLabelHere?.('text', at.flow) });
        items.push({ label: 'Add an area here', onSelect: () => actions.onAddLabelHere?.('area', at.flow) });
        items.push({ label: 'Add a note here', onSelect: () => actions.onAddLabelHere?.('note', at.flow) });
      }
      if (actions.onAddRack) {
        for (const u of RACK_SIZES) items.push({ label: `Add a ${u}U rack`, onSelect: () => actions.onAddRack?.(u) });
      }
      if (actions.onAddWall) items.push({ label: 'Add a wall', onSelect: () => actions.onAddWall?.() });
      if (actions.onPasteConfig) items.push({ label: 'Paste config', onSelect: () => actions.onPasteConfig?.() });
      if (actions.onSuggestCables) items.push({ label: 'Suggest cables from a neighbour list (LLDP)', onSelect: () => actions.onSuggestCables?.(null) });
      break;
    }
  }
  return items;
}

export interface DeviceMenuWhere {
  /** A device on a shelf or a surface rather than in a rack unit: what works there. */
  on?: 'occupant' | 'fixture';
  /** A box on the free canvas: it duplicates and removes as a box, and has no inside or slots. */
  free?: boolean;
  /** The device panel's own ⋯ menu, which leaves out Details: the panel is the details. */
  inPanel?: boolean;
}

/**
 * Sign-off r58: everything that can be done to one device, in four groups (Look, Work on it, Copy,
 * then removal apart). Pure, and the one list behind right-click, the panel's ⋯ menu, Ctrl K and
 * Inventory, so the four cannot drift apart again. An action the place cannot do (a reader, or a
 * place without it) is left out; one it can do later is greyed with the reason.
 */
export function deviceMenuItems(id: string, actions: MenuActions, where: DeviceMenuWhere = {}): MenuItem[] {
  const w = DEVICE_WORDS;
  const look = DEVICE_GROUPS.look;
  const work = DEVICE_GROUPS.work;
  const copy = DEVICE_GROUPS.copy;
  const racked = where.on == null && where.free !== true;
  const items: MenuItem[] = [];
  if (actions.onOpen) items.push({ group: look, label: w.open, onSelect: () => actions.onOpen?.(id) });
  if (actions.onOpenInside && racked) items.push({ group: look, label: w.openInside, onSelect: () => actions.onOpenInside?.(id) });
  if (actions.onTraceFrom) items.push({ group: look, label: w.trace, onSelect: () => actions.onTraceFrom?.(id) });
  if (actions.onShowInInventory) items.push({ group: look, label: w.showInInventory, onSelect: () => actions.onShowInInventory?.(id) });
  if (where.inPanel !== true) {
    const sel: Selection = where.free === true ? { kind: 'chassis', id } : { kind: where.on ?? 'chassis', id };
    items.push({ group: look, label: w.details, onSelect: () => actions.onSelect(sel) });
  }
  if (actions.onItsDown) items.push({ group: work, label: w.itsDown, onSelect: () => actions.onItsDown?.(id) });
  if (actions.onPlanChange) items.push({ group: work, label: w.planChange, onSelect: () => actions.onPlanChange?.(id) });
  if (where.on != null) return items;
  if (actions.onPlanFirmware && racked) {
    const needs = actions.firmwareNeedsVersion?.(id) === true;
    items.push({ group: work, label: w.planFirmware, onSelect: () => actions.onPlanFirmware?.(id), disabled: needs ? FIRMWARE_NEEDS_VERSION : undefined });
  }
  if (actions.onSwapModel && racked) {
    items.push({ group: work, label: actions.hasModel?.(id) === false ? w.giveModel : w.swapModel, onSelect: () => actions.onSwapModel?.(id) });
  }
  if (actions.onFitCard && racked) items.push({ group: work, label: w.fitCard, onSelect: () => actions.onFitCard?.(id) });
  if (actions.onSuggestCables) items.push({ group: work, label: w.suggestCables, onSelect: () => actions.onSuggestCables?.(id) });
  if (actions.onAddPort && racked) {
    items.push({ group: work, label: w.addPort, onSelect: () => actions.onAddPort?.(id), disabled: actions.addPortRefusal?.(id) ?? undefined });
  }
  if (actions.onOpenInTermix) items.push({ group: work, label: w.termix, onSelect: () => actions.onOpenInTermix?.(id), disabled: actions.termixRefusal?.(id) ?? undefined });
  const duplicate = where.free === true ? (actions.onDuplicateFree ? () => actions.onDuplicateFree?.([id]) : null) : actions.onDuplicateDevice ? () => actions.onDuplicateDevice?.(id) : null;
  if (duplicate) items.push({ group: copy, label: w.duplicate, onSelect: duplicate, keys: 'Ctrl D', disabled: where.free === true ? undefined : actions.duplicateRefusal?.(id) ?? undefined });
  if (actions.onCopyLink) items.push({ group: copy, label: w.copyLink, onSelect: () => actions.onCopyLink?.(id) });
  if (actions.onPrintLabel) items.push({ group: copy, label: w.printLabel, onSelect: () => actions.onPrintLabel?.(id) });
  const remove = where.free === true ? (actions.onRemoveFree ? () => actions.onRemoveFree?.([id]) : null) : actions.onRemoveDevice ? () => actions.onRemoveDevice?.(id) : null;
  if (remove) items.push({ label: w.remove, onSelect: remove, danger: true, keys: 'Del' });
  return items;
}
