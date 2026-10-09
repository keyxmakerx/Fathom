import type { Selection } from './contract';

/** What a right-click landed on (ADR-0060 decision 4). */
export type MenuTarget =
  | { kind: 'chassis'; id: string }
  /** `freeU` is the free unit the click landed on, with the click's pane and flow position. */
  | { kind: 'rack'; id: string; freeU?: { u: number; screen: Point; flow: Point } }
  | { kind: 'cable'; id: string }
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
}

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
  /** Opens a maintenance plan on a device (ADR-0061 round 7). */
  onPlanChange?(elementId: string): void;
  /** Opens the "It's down" checklist on a device (ADR-0061 troubleshooting). */
  onItsDown?(elementId: string): void;
  onRemoveDevice?(chassisId: string): void;
  onDisconnect?(cableId: string): void;
  onAddDevice?(rackId: string): void;
  onAddRack?(heightU: number): void;
  onAddWall?(): void;
  onPasteConfig?(): void;
  onAddInRack?(rackId: string, u: number, at: { screen: Point; flow: Point }): void;
  onAddBoxHere?(at: { screen: Point; flow: Point }): void;
  onAddLabelHere?(form: 'text' | 'area', flow: Point): void;
  onDuplicateFree?(ids: string[]): void;
  onRemoveFree?(ids: string[]): void;
}

/** The rack sizes the empty canvas's menu offers (ADR-0060 decision 5). */
const RACK_SIZES = [42, 24, 12] as const;

/** Pure: the items a right-click on `target` offers, in order. */
export function menuItemsFor(target: MenuTarget, actions: MenuActions): MenuItem[] {
  const items: MenuItem[] = [];
  switch (target.kind) {
    case 'chassis': {
      const { id } = target;
      if (actions.onOpen) items.push({ label: 'Open', onSelect: () => actions.onOpen?.(id) });
      if (actions.onOpenInside) items.push({ label: 'Inside', onSelect: () => actions.onOpenInside?.(id) });
      if (actions.onTraceFrom) items.push({ label: 'Trace a path from here', onSelect: () => actions.onTraceFrom?.(id) });
      items.push({ label: 'Details', onSelect: () => actions.onSelect({ kind: 'chassis', id }) });
      if (actions.onItsDown) items.push({ label: "It's down", onSelect: () => actions.onItsDown?.(id) });
      if (actions.onPlanChange) items.push({ label: 'Plan a change', onSelect: () => actions.onPlanChange?.(id) });
      if (actions.onDuplicateDevice) items.push({ label: 'Duplicate', onSelect: () => actions.onDuplicateDevice?.(id) });
      if (actions.onRemoveDevice) items.push({ label: 'Remove', onSelect: () => actions.onRemoveDevice?.(id), danger: true });
      break;
    }
    case 'rack': {
      const { id } = target;
      items.push({ label: 'Details', onSelect: () => actions.onSelect({ kind: 'rack', id }) });
      const free = target.freeU;
      if (free && actions.onAddInRack) items.push({ label: `Add here (U${free.u})`, onSelect: () => actions.onAddInRack?.(id, free.u, free) });
      if (actions.onAddDevice) items.push({ label: 'Add a device', onSelect: () => actions.onAddDevice?.(id) });
      break;
    }
    case 'cable': {
      const { id } = target;
      items.push({ label: 'Details', onSelect: () => actions.onSelect({ kind: 'cable', id }) });
      if (actions.onDisconnect) items.push({ label: 'Disconnect', onSelect: () => actions.onDisconnect?.(id), danger: true });
      break;
    }
    case 'free':
    case 'label': {
      const { id } = target;
      const sel: Selection = target.kind === 'free' ? { kind: 'chassis', id } : { kind: 'label', id };
      if (target.kind === 'free' && actions.onOpen) items.push({ label: 'Open', onSelect: () => actions.onOpen?.(id) });
      if (target.kind === 'free' && actions.onTraceFrom) items.push({ label: 'Trace a path from here', onSelect: () => actions.onTraceFrom?.(id) });
      items.push({ label: 'Details', onSelect: () => actions.onSelect(sel) });
      if (target.kind === 'free' && actions.onItsDown) items.push({ label: "It's down", onSelect: () => actions.onItsDown?.(id) });
      if (target.kind === 'free' && actions.onPlanChange) items.push({ label: 'Plan a change', onSelect: () => actions.onPlanChange?.(id) });
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
      }
      if (actions.onAddRack) {
        for (const u of RACK_SIZES) items.push({ label: `Add a ${u}U rack`, onSelect: () => actions.onAddRack?.(u) });
      }
      if (actions.onAddWall) items.push({ label: 'Add a wall', onSelect: () => actions.onAddWall?.() });
      if (actions.onPasteConfig) items.push({ label: 'Paste config', onSelect: () => actions.onPasteConfig?.() });
      break;
    }
  }
  return items;
}
