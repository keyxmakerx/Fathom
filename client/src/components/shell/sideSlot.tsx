// r30-panels: Checks, a plan, "It's down" and a path trace open as tabs of the one right-hand panel, not as cards
// over the canvas. The place that owns each one still renders it where it always did; `InSideSlot` moves what it
// draws into its tab's slot in the dock.

import { createContext, useContext, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/** One extra tab on the right-hand strip. Its owner keeps whether it is open. */
export interface SideTab {
  id: string;
  label: string;
  /** Shown after the label ("Checks 3"); nothing when 0 or absent. */
  count?: number;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
  /** What the tab shows, when its owner is not inside the shell (Docs); otherwise the owner uses `InSideSlot`. */
  content?: ReactNode;
}

/** True inside a side tab's slot: a card that is dragged about the canvas stays put there. */
export const InSlot = createContext(false);

/** The slot element for each side tab, by id. `null` outside a shell that has side tabs. */
export const SideSlots = createContext<Readonly<Record<string, HTMLElement | null>> | null>(null);

/** Draws its children in the side tab's slot. Outside a shell with side tabs (tests, other places) they draw where
 * they are; inside one, nothing draws while the slot is not in the page. */
export function InSideSlot({ id, children }: { id: string; children: ReactNode }) {
  const slots = useContext(SideSlots);
  if (slots == null || !(id in slots)) return <>{children}</>;
  const target = slots[id];
  return target != null ? createPortal(<InSlot.Provider value>{children}</InSlot.Provider>, target) : null;
}

/** Which side tab holds the panel after the tabs changed: a tab that just opened takes it; one that closed gives
 * it up. */
export function nextActive(active: string | null, before: Readonly<Record<string, boolean>>, tabs: readonly Pick<SideTab, 'id' | 'open'>[]): string | null {
  let next = active;
  for (const t of tabs) if (t.open && before[t.id] !== true) next = t.id;
  if (next != null && !tabs.some((t) => t.id === next && t.open)) return null;
  return next;
}
