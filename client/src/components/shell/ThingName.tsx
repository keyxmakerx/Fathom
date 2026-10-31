// Sign-off r60: a device, port, rack or cable name in Plans, Checks, History, It's down or Trace is a link
// that selects it on the canvas. The place that can select provides `SelectThing`; elsewhere a name is text.

import { createContext, useContext, type ReactNode } from 'react';

/** Selects the thing with this design id where the person can see it; false when it cannot be selected. */
export const SelectThing = createContext<((id: string) => boolean) | null>(null);

export function ThingName({ ids, children, className }: { ids: readonly string[]; children: ReactNode; className?: string }) {
  const select = useContext(SelectThing);
  if (select == null || ids.length === 0) return <>{children}</>;
  return (
    <button
      type="button"
      className={className == null ? 'thing-name' : `thing-name ${className}`}
      title="Select it on the canvas"
      onClick={(e) => {
        e.stopPropagation();
        ids.some((id) => select(id));
      }}
    >
      {children}
    </button>
  );
}
