import { useCallback, useState } from 'react';

import type { DesignCapability } from '../../api/designs';
import type { Selection } from '../drawing';
import { InventoryPlace } from '../inventory/InventoryPlace';
import { RacksPlace } from '../racks/RacksPlace';
import type { Place, ShellProps } from '../shell/types';
import { useDesignSession } from './useDesignSession';

export interface DesignPlaceProps extends Omit<ShellProps, 'editor' | 'rail' | 'children' | 'place'> {
  place: Place;
  organisationId: string;
  designId: string;
  capability: DesignCapability;
  onZoomChange: (zoom: number) => void;
}

/**
 * This session's brief item 1 — the parent Racks and Inventory share.
 * `useDesignSession` is called exactly ONCE here, above the `if` that picks
 * which of the two place components actually renders: switching `place`
 * only ever swaps which of `RacksPlace`/`InventoryPlace` is mounted, never
 * remounts `DesignPlace` itself, so the `Document`, the catalogue and the
 * in-flight `SaveQueue` all survive the switch untouched — nothing reloads,
 * and a change queued the moment before someone clicked "Inventory" still
 * goes out.
 *
 * Also holds the one thing "Show on rack"/"Open in inventory" (this
 * session's brief item 5) needs to cross the switch: `focus`, the
 * `Selection` Racks should open already showing. Each call gets a fresh
 * object (a new `{ kind, id }` literal) so `RacksPlace`'s own edge-triggered
 * effect can tell "asked again" from "the same selection, unchanged" by
 * identity, the same shape `Drawing.tsx`'s own camera moves already use.
 */
export function DesignPlace(props: DesignPlaceProps) {
  const { organisationId, designId, capability, onZoomChange, onPlaceChange, ...shellProps } = props;
  const session = useDesignSession(organisationId, designId, capability);
  const [focus, setFocus] = useState<Selection | null>(null);

  const showOnRack = useCallback(
    (selection: Selection) => {
      setFocus({ ...selection });
      onPlaceChange('racks');
    },
    [onPlaceChange],
  );

  const openInInventory = useCallback(
    (chassisId: string) => {
      // The reverse trip carries no focus today — `InventoryPlace` has no
      // per-row scroll target of its own yet (its brief item 4 opens the
      // editor by selection, not by a remembered row); the chassis id is
      // still named in case a later session adds one.
      void chassisId;
      onPlaceChange('inventory');
    },
    [onPlaceChange],
  );

  if (props.place === 'racks') {
    return (
      <RacksPlace
        {...shellProps}
        onPlaceChange={onPlaceChange}
        session={session}
        onZoomChange={onZoomChange}
        initialFocus={focus}
        onOpenInventory={openInInventory}
      />
    );
  }

  return <InventoryPlace {...shellProps} onPlaceChange={onPlaceChange} session={session} onShowOnRack={showOnRack} />;
}
