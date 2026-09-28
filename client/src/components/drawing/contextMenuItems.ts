import type { Selection } from './contract';

/** What a right-click landed on (ADR-0060 decision 4). */
export type MenuTarget =
  | { kind: 'chassis'; id: string }
  | { kind: 'rack'; id: string }
  | { kind: 'cable'; id: string }
  | { kind: 'pane' };

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
  onDuplicateDevice?(chassisId: string): void;
  onRemoveDevice?(chassisId: string): void;
  onDisconnect?(cableId: string): void;
  onAddDevice?(rackId: string): void;
  onAddRack?(heightU: number): void;
  onAddWall?(): void;
}

/** The rack sizes the empty canvas's menu offers (ADR-0060 decision 5). */
const RACK_SIZES = [42, 24, 12] as const;

/** Pure: the items a right-click on `target` offers, in order. */
export function menuItemsFor(target: MenuTarget, actions: MenuActions): MenuItem[] {
  const items: MenuItem[] = [];
  switch (target.kind) {
    case 'chassis': {
      const { id } = target;
      items.push({ label: 'Details', onSelect: () => actions.onSelect({ kind: 'chassis', id }) });
      if (actions.onDuplicateDevice) items.push({ label: 'Duplicate', onSelect: () => actions.onDuplicateDevice?.(id) });
      if (actions.onRemoveDevice) items.push({ label: 'Remove', onSelect: () => actions.onRemoveDevice?.(id), danger: true });
      break;
    }
    case 'rack': {
      const { id } = target;
      items.push({ label: 'Details', onSelect: () => actions.onSelect({ kind: 'rack', id }) });
      if (actions.onAddDevice) items.push({ label: 'Add a device', onSelect: () => actions.onAddDevice?.(id) });
      break;
    }
    case 'cable': {
      const { id } = target;
      items.push({ label: 'Details', onSelect: () => actions.onSelect({ kind: 'cable', id }) });
      if (actions.onDisconnect) items.push({ label: 'Disconnect', onSelect: () => actions.onDisconnect?.(id), danger: true });
      break;
    }
    case 'pane': {
      if (actions.onAddRack) {
        for (const u of RACK_SIZES) items.push({ label: `Add a ${u}U rack`, onSelect: () => actions.onAddRack?.(u) });
      }
      if (actions.onAddWall) items.push({ label: 'Add a wall', onSelect: () => actions.onAddWall?.() });
      break;
    }
  }
  return items;
}
