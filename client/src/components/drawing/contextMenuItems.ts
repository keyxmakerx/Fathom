import type { CableRunSide, CableRunView } from '../../document/cableRuns';
import { shortcutText } from '../shell/shortcuts';
import type { Selection } from './contract';

/** What a right-click landed on (ADR-0060 decision 4). */
export type MenuTarget =
  /** `on` is set for a device on a shelf or a surface rather than in a rack unit: its menu is a racked
   * device's, and Details selects it the way a click does. */
  | { kind: 'chassis'; id: string; on?: 'occupant' | 'fixture' }
  /** `freeU` is the free unit the click landed on, with the click's pane and flow position. */
  | { kind: 'rack'; id: string; freeU?: { u: number; screen: Point; flow: Point } }
  | { kind: 'cable'; id: string }
  /** A port on a plate: its own menu (r116), not its device's. */
  | { kind: 'port'; id: string }
  /** A portal tray at the edge of the view; `far` is set when it is a link to another site. */
  | { kind: 'tray'; far?: SiteFar }
  /** A wall, desk or ceiling panel. */
  | { kind: 'surface'; id: string }
  /** A shelf's own tray, not one of the things on it. */
  | { kind: 'shelf'; id: string }
  | { kind: 'free'; id: string }
  | { kind: 'label'; id: string }
  | { kind: 'line'; id: string }
  /** `at` is where the click landed, in pane pixels and flow units. */
  | { kind: 'pane'; at?: { screen: Point; flow: Point } };

type Point = { x: number; y: number };

/** A port in another design that a link between sites names (ADR-0079). */
export type SiteFar = { design: string; element: string };

/** What a port holds, read off the drawing for its menu (`menuFacts.ts`). */
export interface PortFacts {
  cableId: string | null;
  farPortId: string | null;
  far: SiteFar | null;
  /** The device the port is on, wherever it sits; what a trace starts from. */
  deviceId: string | null;
}

/** One end of a cable, for "Go to end A". `portId` is null for an end outside this design. */
export interface CableEndFacts {
  portId: string | null;
  chassisId: string | null;
  far: SiteFar | null;
}

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
  /** Its key, as the shortcuts sheet shows it on this platform ("Ctrl+D", "Cmd+D" on a Mac). */
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
  planChange: 'Plan a change…',
  planFirmware: 'Plan a firmware upgrade',
  swapModel: 'Swap model…',
  giveModel: 'Give it a catalogue model…',
  fitCard: 'Fit a card',
  suggestCables: 'Suggest cables (LLDP)',
  addPort: 'Add a port',
  termix: 'Open in Termix',
  takeOut: 'Take it out, spot not known',
  duplicate: 'Duplicate',
  copyLink: 'Copy link',
  printLabel: 'Print label',
  remove: 'Remove device',
} as const;

/** The groups a device's menu is divided into (r116: a rule between them, no heading); removal sits apart. */
export const DEVICE_GROUPS = { look: 'go', work: 'work', copy: 'copy' } as const;

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
  /** Steps into a shelf's own view. */
  onOpenShelf?(shelfId: string): void;
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
  /** Takes a device out of its rack, shelf or wall when its spot is not known: it stays whole, drawn on the canvas. */
  onTakeOut?(chassisId: string): void;
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
  /** Removes an empty rack, shelf or wall (sign-off rua-ui-audit). */
  onRemoveHolder?(id: string): void;
  /** What Remove calls it ("rack", "wall") and what is still on it, '' when empty. */
  holderOf?(id: string): { noun: string; onIt: string } | null;
  /** r116: a rack's "Add a shelf", at the free unit clicked or, with `u` null, the highest free one. */
  onAddShelf?(rackId: string, u: number | null): void;
  /** r116: "Add a rack…" asks its one question (42U, 24U, 12U or Custom) after the click. */
  onAskRackSize?(): void;
  /** r116: "Add a cable run…" asks its one question (which kind, which side) after the click. */
  onAskCableRun?(hostId: string): void;
  /** r116: prints a rack's own label. */
  onPrintRackLabel?(rackId: string): void;
  /** r116: a port's menu reads what its port holds. */
  portFacts?(portId: string): PortFacts | null;
  /** r116: a cable's two ends, A then B, for "Go to end A". */
  cableEndFacts?(cableId: string): readonly [CableEndFacts | null, CableEndFacts | null];
  /** r116: opens the far design at the far port of a link between sites. */
  onOpenFarSite?(far: SiteFar): void;
  /** r116: a port's "Link to another site…" opens its picker in the panel. */
  onLinkSite?(portId: string): void;
  /** r116: traces from one end of a cable to the other. */
  onTracePath?(cableId: string): void;
  /** r116: takes one cable out of the drawing, kept in the Layers list to bring back. */
  onHideCable?(cableId: string): void;
}

/** Remove, always listed for a rack or wall; greyed with what is on it until it is empty, so
 * nothing a person placed goes with it by accident. */
function pushRemoveHolder(items: MenuItem[], id: string, actions: MenuActions): void {
  const holder = actions.holderOf?.(id);
  if (!actions.onRemoveHolder || holder == null) return;
  items.push({
    label: `Remove ${holder.noun}`,
    onSelect: () => actions.onRemoveHolder?.(id),
    danger: true,
    keys: holder.onIt === '' ? shortcutText('delete') : undefined,
    disabled: holder.onIt === '' ? undefined : `Empty it first: ${holder.onIt}`,
  });
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

const NOTHING_IN_PORT = 'Nothing is plugged into it';

/** A rack's two groups and removal (r116). */
const RACK_GROUPS = { add: 'add', tidy: 'tidy' } as const;
const PANE_GROUPS = { add: 'add', note: 'note', paste: 'paste' } as const;

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
      const free = target.freeU;
      const a = RACK_GROUPS.add;
      if (free && actions.onAddInRack) items.push({ group: a, label: `Add a device here (U${free.u})`, onSelect: () => actions.onAddInRack?.(id, free.u, free) });
      else if (actions.onAddDevice) items.push({ group: a, label: 'Add a device', onSelect: () => actions.onAddDevice?.(id) });
      if (actions.onAddShelf) items.push({ group: a, label: 'Add a shelf', onSelect: () => actions.onAddShelf?.(id, free?.u ?? null) });
      if (actions.onAddCableRun) {
        items.push({ group: a, label: 'Add a cable run…', onSelect: () => actions.onAskCableRun?.(id) });
      }
      const t = RACK_GROUPS.tidy;
      if (actions.onCloseRackGaps) items.push({ group: t, label: 'Close gaps', onSelect: () => actions.onCloseRackGaps?.(id) });
      if (actions.onCopyRack) items.push({ group: t, label: 'Copy rack, with its cables', onSelect: () => actions.onCopyRack?.(id) });
      if (actions.onPrintRackLabel) items.push({ group: t, label: DEVICE_WORDS.printLabel, onSelect: () => actions.onPrintRackLabel?.(id) });
      pushRemoveHolder(items, id, actions);
      break;
    }
    case 'surface': {
      items.push({ label: 'Details', onSelect: () => actions.onSelect({ kind: 'surface', id: target.id }) });
      pushRunItems(items, target.id, actions);
      pushRemoveHolder(items, target.id, actions);
      break;
    }
    case 'shelf': {
      const { id } = target;
      if (actions.onOpenShelf) items.push({ label: 'Open shelf', onSelect: () => actions.onOpenShelf?.(id) });
      items.push({ label: 'Details', onSelect: () => actions.onSelect({ kind: 'shelf', id }) });
      pushRemoveHolder(items, id, actions);
      break;
    }
    case 'port': {
      const { id } = target;
      const facts = actions.portFacts?.(id) ?? null;
      const cable = facts?.cableId ?? null;
      const go = 'go';
      items.push({
        group: go,
        label: 'Select its cable',
        onSelect: () => cable != null && actions.onSelect({ kind: 'cable', id: cable }),
        disabled: cable == null ? NOTHING_IN_PORT : undefined,
      });
      const far = facts?.far ?? null;
      const farPort = facts?.farPortId ?? null;
      items.push({
        group: go,
        label: 'Go to far end',
        onSelect: () => (far != null ? actions.onOpenFarSite?.(far) : farPort != null && actions.onSelect({ kind: 'port', id: farPort })),
        disabled: cable == null ? NOTHING_IN_PORT : farPort == null && far == null ? 'Its cable has no far end' : undefined,
      });
      const device = facts?.deviceId ?? null;
      if (actions.onTraceFrom && device != null) items.push({ group: go, label: DEVICE_WORDS.trace, onSelect: () => actions.onTraceFrom?.(device) });
      if (actions.onLinkSite) {
        items.push({
          group: 'link',
          label: 'Link to another site…',
          onSelect: () => actions.onLinkSite?.(id),
          disabled: cable != null ? 'It has a cable already' : undefined,
        });
      }
      if (actions.onDisconnect) {
        items.push({ label: 'Disconnect', onSelect: () => cable != null && actions.onDisconnect?.(cable), danger: true, disabled: cable == null ? NOTHING_IN_PORT : undefined });
      }
      break;
    }
    case 'cable': {
      const { id } = target;
      const ends = actions.cableEndFacts?.(id) ?? [null, null];
      const go = 'go';
      (['A', 'B'] as const).forEach((letter, i) => {
        const end = ends[i] ?? null;
        items.push({
          group: go,
          label: `Go to end ${letter}`,
          onSelect: () => (end?.portId != null ? actions.onSelect({ kind: 'port', id: end.portId }) : end?.far != null && actions.onOpenFarSite?.(end.far)),
          disabled: end == null ? 'This end is not connected yet' : end.portId == null && end.far == null ? 'This end is outside this design' : undefined,
        });
      });
      if (actions.onTracePath) items.push({ group: go, label: 'Trace this path', onSelect: () => actions.onTracePath?.(id) });
      const tidy = 'tidy';
      if (actions.onHideCable) items.push({ group: tidy, label: 'Hide this cable', onSelect: () => actions.onHideCable?.(id) });
      const loose = actions.looseState?.(id) ?? null;
      if (loose != null && actions.onSetNeedsFinishing) {
        const on = loose === 'needs-finishing';
        items.push({ group: tidy, label: on ? 'Clear "Needs finishing"' : 'Needs finishing', onSelect: () => actions.onSetNeedsFinishing?.(id, !on) });
      }
      if (actions.onDisconnect) items.push({ label: 'Disconnect', onSelect: () => actions.onDisconnect?.(id), danger: true });
      break;
    }
    case 'tray': {
      const far = target.far ?? null;
      const why = 'Only a link to another site goes anywhere else';
      items.push({ label: 'Open there', onSelect: () => far != null && actions.onOpenFarSite?.(far), disabled: far == null ? why : undefined });
      items.push({ label: 'Go to far end', onSelect: () => far != null && actions.onOpenFarSite?.(far), disabled: far == null ? why : undefined });
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
      const g = PANE_GROUPS;
      if (at && actions.onAddBoxHere) items.push({ group: g.add, label: 'Add a device here', onSelect: () => actions.onAddBoxHere?.(at) });
      if (actions.onAddRack) items.push({ group: g.add, label: 'Add a rack…', onSelect: () => (actions.onAskRackSize ? actions.onAskRackSize() : actions.onAddRack?.(RACK_SIZES[0])) });
      if (actions.onAddWall) items.push({ group: g.add, label: 'Add a wall', onSelect: () => actions.onAddWall?.() });
      if (at && actions.onAddLabelHere) {
        items.push({ group: g.note, label: 'Add a label', onSelect: () => actions.onAddLabelHere?.('text', at.flow) });
        items.push({ group: g.note, label: 'Add an area', onSelect: () => actions.onAddLabelHere?.('area', at.flow) });
        items.push({ group: g.note, label: 'Add a note', onSelect: () => actions.onAddLabelHere?.('note', at.flow) });
      }
      if (actions.onPasteConfig) items.push({ group: g.paste, label: 'Paste config', onSelect: () => actions.onPasteConfig?.() });
      if (actions.onSuggestCables) items.push({ group: g.paste, label: PASTE_NEIGHBOURS, onSelect: () => actions.onSuggestCables?.(null) });
      break;
    }
  }
  return items;
}

/** The empty canvas's word for cable suggestions; a device's menu calls the same thing "Suggest cables (LLDP)". */
export const PASTE_NEIGHBOURS = 'Paste a neighbour list (LLDP)';

/** The sizes "Add a rack…" asks for (r116), tallest first; Custom comes after them. */
export const RACK_SIZE_CHOICES: readonly number[] = RACK_SIZES;

/** What "Add a cable run…" asks: one row per free side, and removal of each run already there. */
export function cableRunItems(hostId: string, actions: MenuActions): MenuItem[] {
  const items: MenuItem[] = [];
  pushRunItems(items, hostId, actions);
  return items;
}

export interface DeviceMenuWhere {
  /** A device on a shelf or a surface rather than in a rack unit: Details selects it the way a click does. */
  on?: 'occupant' | 'fixture';
  /** A box on the free canvas: it duplicates and removes as a box, and has no inside or slots. Its menu is
   * the long one (r116 leaves it as it was). */
  free?: boolean;
  /** The device panel's own ⋯ menu, which leaves out Details: the panel is the details. */
  inPanel?: boolean;
  /** Every action by name, the ones that left the menu too: Ctrl K and the hand-off from Inventory use it. */
  all?: boolean;
}

/**
 * Sign-off r58 and r116 (ADR-0091 decision 4): what can be done to one device. Ten rows in four groups
 * (open and look, work on it, copy, removal apart). An action that edits one fact lives in the panel beside
 * that fact and left the menu, but `all` still lists it, so Ctrl K finds every action by name. Pure, and the
 * one list behind right-click, the panel's ⋯ menu, Ctrl K and Inventory, so they cannot drift apart. An
 * action the place cannot do (a reader, or a place without it) is left out; one it can do later is greyed
 * with the reason.
 */
export function deviceMenuItems(id: string, actions: MenuActions, where: DeviceMenuWhere = {}): MenuItem[] {
  const w = DEVICE_WORDS;
  const look = DEVICE_GROUPS.look;
  const work = DEVICE_GROUPS.work;
  const copy = DEVICE_GROUPS.copy;
  // A free box keeps the long list it had; so does Ctrl K.
  const long = where.all === true || where.free === true;
  // A device on a shelf or a wall is the same box as a racked one: everything works on it. So does a free
  // box, which is a device whose spot is not known: its model, ports, cards and firmware are all its own.
  // Only "Open inside" waits for a place.
  const racked = where.free !== true;
  const items: MenuItem[] = [];
  if (actions.onOpen) items.push({ group: look, label: w.open, onSelect: () => actions.onOpen?.(id) });
  if (long && actions.onOpenInside && racked) items.push({ group: look, label: w.openInside, onSelect: () => actions.onOpenInside?.(id) });
  if (actions.onTraceFrom) items.push({ group: look, label: w.trace, onSelect: () => actions.onTraceFrom?.(id) });
  if (actions.onShowInInventory) items.push({ group: look, label: w.showInInventory, onSelect: () => actions.onShowInInventory?.(id) });
  if (long && where.inPanel !== true) {
    const sel: Selection = where.free === true ? { kind: 'chassis', id } : { kind: where.on ?? 'chassis', id };
    items.push({ group: look, label: w.details, onSelect: () => actions.onSelect(sel) });
  }
  if (actions.onItsDown) items.push({ group: work, label: w.itsDown, onSelect: () => actions.onItsDown?.(id) });
  if (actions.onPlanChange) items.push({ group: work, label: w.planChange, onSelect: () => actions.onPlanChange?.(id) });
  if (long && actions.onPlanFirmware) {
    const needs = actions.firmwareNeedsVersion?.(id) === true;
    items.push({ group: work, label: w.planFirmware, onSelect: () => actions.onPlanFirmware?.(id), disabled: needs ? FIRMWARE_NEEDS_VERSION : undefined });
  }
  if (long && actions.onSwapModel) {
    items.push({ group: work, label: actions.hasModel?.(id) === false ? w.giveModel : w.swapModel, onSelect: () => actions.onSwapModel?.(id) });
  }
  if (long && actions.onFitCard) items.push({ group: work, label: w.fitCard, onSelect: () => actions.onFitCard?.(id) });
  if (long && actions.onSuggestCables) items.push({ group: work, label: w.suggestCables, onSelect: () => actions.onSuggestCables?.(id) });
  if (long && actions.onAddPort) {
    items.push({ group: work, label: w.addPort, onSelect: () => actions.onAddPort?.(id), disabled: actions.addPortRefusal?.(id) ?? undefined });
  }
  if (long && actions.onTakeOut && racked) items.push({ group: work, label: w.takeOut, onSelect: () => actions.onTakeOut?.(id) });
  if (actions.onOpenInTermix) items.push({ group: work, label: w.termix, onSelect: () => actions.onOpenInTermix?.(id), disabled: actions.termixRefusal?.(id) ?? undefined });
  const duplicate = where.free === true ? (actions.onDuplicateFree ? () => actions.onDuplicateFree?.([id]) : null) : actions.onDuplicateDevice ? () => actions.onDuplicateDevice?.(id) : null;
  if (duplicate) items.push({ group: copy, label: w.duplicate, onSelect: duplicate, keys: shortcutText('duplicate'), disabled: where.free === true ? undefined : actions.duplicateRefusal?.(id) ?? undefined });
  if (actions.onCopyLink) items.push({ group: copy, label: w.copyLink, onSelect: () => actions.onCopyLink?.(id) });
  if (actions.onPrintLabel) items.push({ group: copy, label: w.printLabel, onSelect: () => actions.onPrintLabel?.(id) });
  const remove = where.free === true ? (actions.onRemoveFree ? () => actions.onRemoveFree?.([id]) : null) : actions.onRemoveDevice ? () => actions.onRemoveDevice?.(id) : null;
  if (remove) items.push({ label: w.remove, onSelect: remove, danger: true, keys: shortcutText('delete') });
  return items;
}
