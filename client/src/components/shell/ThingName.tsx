// Sign-off r60: a device, port, rack or cable name in Plans, Checks, History, It's down or Trace is a link
// that selects it on the canvas. The place that can select provides `SelectThing`; elsewhere a name is text.
// ADR-0091 as built: in Inventory and Sheet the same name opens the item's page.

import { createContext, useContext, type ReactNode } from 'react';

/** Selects the thing with this design id where the person can see it; false when it cannot be selected. */
export const SelectThing = createContext<((id: string) => boolean) | null>(null);

/** What a click on a name does, as its tooltip says: the canvas selects; Inventory and Sheet open the item's page. */
export const SelectThingHint = createContext('Select it on the canvas');

export function ThingName({ ids, children, className }: { ids: readonly string[]; children: ReactNode; className?: string }) {
  const select = useContext(SelectThing);
  const hint = useContext(SelectThingHint);
  if (select == null || ids.length === 0) return <>{children}</>;
  return (
    <button
      type="button"
      className={className == null ? 'thing-name' : `thing-name ${className}`}
      title={hint}
      onClick={(e) => {
        e.stopPropagation();
        ids.some((id) => select(id));
      }}
    >
      {children}
    </button>
  );
}
