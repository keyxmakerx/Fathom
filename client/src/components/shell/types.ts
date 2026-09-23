import type { ReactNode } from 'react';

import type { Lens } from './lens';
import type { PathPart } from './path';

export type { Lens } from './lens';
export { LENSES, LENS_LABEL, isLensLit } from './lens';
export type { PathItem, PathPart } from './path';
export { pathToItems } from './path';

/** BRIEF.md "The vocabulary": two places, nothing else gets the name. `null`
 * is Home — neither tab is marked current there. */
export type Place = 'racks' | 'inventory';

/** One name chip in "who else is here". */
export interface PresenceUser {
  id: string;
  name: string;
}

export interface AccountInfo {
  /** The 24×24 ink square's two-letter mark. */
  initials: string;
  /** Shown nowhere in the bar itself today, but the account menu and its
   * caller (sign-in, People and permissions) need it. */
  address: string;
}

/**
 * The shell's full contract. `Shell` renders only from these props and the
 * `children` it is given as the drawing (or Inventory's lists, or Home) —
 * it holds no sample data of its own (BRIEF.md "How to build it").
 */
export interface ShellProps {
  /** Which of the two places is current. `null` on Home, where neither
   * `Racks` nor `Inventory` is marked. */
  place: Place | null;
  onPlaceChange: (place: Place) => void;

  /** The breadcrumb, root first, current (ink, 700) last. Empty on Home. */
  path: PathPart[];
  /** Rows for the tree popover that opens beneath the path on click. `null`
   * or omitted content is fine — the popover simply has nothing to show. */
  tree: ReactNode;

  /** The one lit lens, of the five BRIEF.md fixes in this order: Cables,
   * Links, Routing, Power, Owner. */
  lens: Lens;
  onLensChange: (lens: Lens) => void;

  /** Who else is here, as name chips. Empty renders no chips — never a
   * placeholder name. */
  presence: PresenceUser[];

  /** The zoom percentage shown between the sign buttons, e.g. `100`. */
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  /** Fits the drawing into view; the percentage is the button. */
  onZoomFit?: () => void;

  canUndo: boolean;
  canRedo: boolean;
  onUndo: () => void;
  onRedo: () => void;

  /** The 24×24 account square and its menu (ADR-0047 §3): the caller's
   * `menu` rows, then the theme switch and Sign out. */
  account: AccountInfo;
  /** The caller's account-menu rows — Site, credentials, Home — each present
   * only when it acts. People and permissions joins when it is built. */
  menu?: ReactNode;
  /** Where the brand goes: Home. Omitted on Home itself. */
  onHome?: () => void;

  /** ADR-0052 §5: the open design's `capability` is `'read'`
   * (`RacksPlace.tsx`'s own `canDraw`) — shows the "view only" chip in the
   * bar. Omitted or `false` on Home and everywhere a reader could not have
   * landed anyway. */
  viewOnly?: boolean;

  /** The selection's editor surface. `null` when nothing is selected — the
   * editor is then absent from the DOM, not an empty panel. */
  editor: ReactNode | null;

  /** Content for the folded rail's open state (`Strip`'s `nav`) — the
   * palette, for the Racks place. Omitted or `null` falls back to `Strip`'s
   * own honest empty state rather than inventing rail content. */
  rail?: ReactNode;

  /** ADR-0053 §4 — the Trail panel, beside the drawing (`racks/Trail.tsx`).
   * Omitted or `null` on every place that has no batches of its own to
   * show (Home; Inventory has no drawing to sit "beside," so it renders no
   * trail either, today) — absent from the DOM entirely, the same "no
   * action, not a disabled one" reading `editor`/`rail` already give. */
  trail?: ReactNode;

  /** The drawing itself (or Inventory's lists, or Home): the shell draws
   * none of it. */
  children: ReactNode;
}
