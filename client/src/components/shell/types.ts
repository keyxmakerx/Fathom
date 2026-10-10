import type { ReactNode } from 'react';

import type { Lens } from './lens';
import type { PathPart } from './path';
import type { PaletteAction } from './palette';
import type { SearchHit } from './search';

export type { Lens } from './lens';
export { LENSES, LENS_LABEL, isLensLit } from './lens';
export type { PathItem, PathPart } from './path';
export { pathToItems } from './path';

/** BRIEF.md "The vocabulary": two places, nothing else gets the name. `null`
 * is Home — neither tab is marked current there. */
export type Place = 'racks' | 'inventory';

/** The Show ▾ menu's rows for the small aids on the canvas (mini-map, cable colour key), kept in this browser. */
export interface ShowAids {
  items: ReadonlyArray<{ id: 'minimap' | 'colourKey'; label: string; on: boolean; note?: string }>;
  onToggle: (id: 'minimap' | 'colourKey') => void;
}

/** Quick search: what a query finds, and what choosing a hit does. */
export interface ShellSearch {
  run: (query: string) => SearchHit[];
  choose: (selection: SearchHit['selection']) => void;
  /** The command palette's actions, asked for each time it opens so they follow what is selected now. */
  actions?: () => PaletteAction[];
}

/** One person in "who else is here", drawn as an initials dot. */
export interface PresenceUser {
  id: string;
  initials: string;
  /** Their display name, for the dot's label and title. */
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

  /** The Show ▾ menu of canvas layers (Racks place only). */
  layers?: { value: import('../drawing/layers').LayerSet; onToggle: (id: import('../drawing/layers').LayerId) => void; style?: { value: import('../drawing/diagramStyle').DiagramStyle; onChange: (style: import('../drawing/diagramStyle').DiagramStyle) => void }; aids?: ShowAids };
  /** The Views menu, drawn beside Show: named camera positions with their layers (Racks place only). */
  views?: ReactNode;
  /** The Rack | Diagram switch (Racks place only); absent where the look does not apply. */
  look?: { value: import('../drawing/look').Look; onChange: (look: import('../drawing/look').Look) => void };

  /** Who else is in this view, as initials dots. Empty renders nothing —
   * never a placeholder name. */
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

  /** The Print button, next to Undo/Redo; absent with no design open. */
  onPrint?: () => void;

  /** The Share button; present only for someone who may share (a steward). */
  onShare?: () => void;
  /** The design's docs list; absent with no design open. */
  onDocs?: () => void;
  /** The History button; absent with no design open. */
  onHistory?: () => void;
  /** History is open: the button reads as on. */
  historyOpen?: boolean;

  /** The 24×24 account square and its menu (ADR-0047 §3): the caller's
   * `menu` rows, then the theme switch and Sign out. */
  account: AccountInfo;
  /** The caller's account-menu rows — Site, credentials, Home — each present
   * only when it acts. People and permissions joins when it is built. */
  menu?: ReactNode;
  /** The amber "Admin" pill beside the account square. Cosmetic: the server
   * still decides who may open the console. Absent unless the caller says so. */
  adminPill?: { current?: boolean; onSelect?: () => void };
  /** Where the brand goes: Home. Omitted on Home itself. */
  onHome?: () => void;
  /** Quick search. Absent where there is nothing to search yet (Home, Site). */
  search?: ShellSearch;

  /** The Cables list, hanging from the Cables lens. `Bar.tsx`'s own doc:
   * absent everywhere but the Racks place. */
  cablesGroupsPopover?: ReactNode;
  cablesGroupsSummary?: string | null;
  /** The hidden-one-at-a-time chip. */
  hiddenCablesCount?: number;
  onShowAllHiddenCables?: () => void;

  /** ADR-0052 §5: the open design's `capability` is `'read'`
   * (`RacksPlace.tsx`'s own `canDraw`) — shows the "view only" chip in the
   * bar. Omitted or `false` on Home and everywhere a reader could not have
   * landed anyway. */
  viewOnly?: boolean;

  /** The live design's notices. Shown under the editor's fields, or at the
   * canvas's top right while no editor is open. */
  notices?: ReactNode;
  /** The panel label of the field the notice sits under ("serial"). */
  noticeField?: string | null;
  /** The element the notice is about; it sits in the editor only if the panel shows this element. */
  noticeElement?: string | null;
  /** What the one always-present, visually hidden status region says. */
  announce?: string;
  /** A chip for the bar's trailing group, before Undo (the Checks count). */
  barExtra?: ReactNode;

  /** A full-width band between the bar and the body (the open maintenance plan's). */
  band?: ReactNode;

  /** The selection's editor surface. `null` when nothing is selected — the
   * editor is then absent from the DOM, not an empty panel. */
  editor: ReactNode | null;
  /** The History panel's content while History is open (the right-hand History tab). */
  history?: ReactNode;
  /** A key for what is selected; selecting something new shows its Details tab. */
  selectionKey?: string | null;
  /** Which design this is, for remembering the open panels per person in this browser. */
  resume?: { accountId: string | null; designId: string };

  /** Content for the folded rail's open state (`Strip`'s `nav`) — the
   * palette, for the Racks place. Omitted or `null` falls back to `Strip`'s
   * own honest empty state rather than inventing rail content. */
  rail?: ReactNode;

  /** The design's trail (ADR-0053 §4), folded to a strip on the right edge.
   * Absent where no design is open. */
  trail?: ReactNode;
  trailOpen?: boolean;
  onTrailOpenChange?: (open: boolean) => void;

  /** The drawing itself (or Inventory's lists, or Home): the shell draws
   * none of it. */
  children: ReactNode;
}
