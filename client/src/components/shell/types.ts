import type { ReactNode } from 'react';

import type { DesignSummary } from '../../api/designs';
import type { Scope } from '../../api/scopes';

import type { Lens } from './lens';
import type { PathPart } from './path';
import type { PaletteAction } from './palette';
import type { SearchHit } from './search';
import type { SideTab } from './sideSlot';

export type { Lens } from './lens';
export { LENSES, LENS_LABEL, isLensLit } from './lens';
export type { PathItem, PathPart } from './path';
export { pathToItems } from './path';

/** the shell brief "The vocabulary": two places, nothing else gets the name. `null`
 * is Home — neither tab is marked current there. */
export type Place = 'racks' | 'inventory';

/** r31-bar A: the four views the bar names. Diagram and Canvas are the Racks place in its two looks; Inventory is
 * the item pages; Sheet is the same lists as one spreadsheet with its tabs along the bottom. */
export type MainView = 'diagram' | 'canvas' | 'inventory' | 'sheet';

/** A row of the Doing ▾ menu. Without `onSelect` it shows, dimmed, with its hint saying what it needs. */
export interface DoingItem {
  id: string;
  label: string;
  onSelect?: () => void;
  hint?: string;
}

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
  /** ADR-0079: the organisation and open design, so the palette also finds things in the other
   * designs this person may read. */
  estate?: { organisationId: string; designId: string };
}

/** One person in "who else is here", drawn as an initials dot. */
export interface PresenceUser {
  id: string;
  initials: string;
  /** Their display name, for the dot's label and title. */
  name: string;
  /** Selects what they have selected, when the canvas can show it; the +N list's names link to it. */
  go?: () => void;
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
 * it holds no sample data of its own (the shell brief "How to build it").
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

  /** The one lit lens, of the five the shell brief fixes in this order: Cables,
   * Links, Routing, Power, Owner. */
  lens: Lens;
  onLensChange: (lens: Lens) => void;

  /** The Show ▾ menu of canvas layers (Racks place only). */
  layers?: { value: import('../drawing/layers').LayerSet; onToggle: (id: import('../drawing/layers').LayerId) => void; style?: { value: import('../drawing/diagramStyle').DiagramStyle; onChange: (style: import('../drawing/diagramStyle').DiagramStyle) => void }; cables?: { value: import('../drawing/cableStyle').CableStyle; onChange: (style: import('../drawing/cableStyle').CableStyle) => void; colour?: { value: import('../drawing/cableStyle').CableColour; onChange: (colour: import('../drawing/cableStyle').CableColour) => void } }; aids?: ShowAids };
  /** The Views menu, drawn beside Show: named camera positions with their layers (Racks place only). */
  views?: ReactNode;
  /** The same views as rows, for the View ▾ menu the bar folds into when it is narrow. */
  viewsFolded?: ReactNode;
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

  /** The Equipment tab's content in the right dock — the palette, for the
   * Racks place. Omitted or `null` draws no Equipment tab. */
  rail?: ReactNode;
  /** The design is open and empty (and can be drawn in): the Equipment tab opens by itself, once, when it
   * is opened. Undefined until the design has loaded (ADR-0068 §3). */
  autoEquipment?: boolean;
  /** Each bump opens the Equipment tab (the "Add equipment" button on the canvas). */
  equipmentRequest?: number;

  /** r31-bar A: the four views as the bar's tabs. With no design open (Home, Admin) `value` is `null`
   * and the tabs go back to the design last open, `backTo`; without `mainView` there they are only named. */
  mainView?: { value: MainView | null; onChange: (view: MainView) => void; backTo?: string };
  /** Sign-off r74: the Work tab, every site's work in one list. A view of the organisation, not
   * of a design, so it sits after the four; `on` while it is in view. */
  work?: { on: boolean; onOpen: () => void };
  /** Right after the design's name in the bar: the Sample chip. */
  designExtra?: ReactNode;
  /** The Doing ▾ menu's rows. */
  doing?: readonly DoingItem[];
  /** r31-motion: a job under way takes the bar. The other views fold, the job sits where Doing was, and the rule
   * under the bar takes the job's colour. */
  task?: { label: string; stage?: string; tone: 'plan' | 'do' | 'down' | 'trace'; onExit: () => void } | null;
  /** Below the Layers menu's rows: the cable colour key. */
  layersExtra?: ReactNode;
  /** The zoom stops the bottom pill opens upward with (r31-bar A). */
  zoomStops?: { stops: readonly { id: string; label: string }[]; current: string | null; onGo: (id: string) => void };
  /** ADR-0074: the folders the building, site and estate stops draw, above the closet. Absent, the
   * camera stops at the closet. */
  places?: {
    scopes: readonly Scope[];
    /** The folder of the open design. */
    currentScopeId: string;
    /** The folder of every design the person may open. */
    designScopeIds: readonly string[];
    /** Open the latest design in a folder. */
    onOpenScope: (scopeId: string) => void;
    /** ADR-0051: the building stop's floor plan, a design in the building folder. */
    floorPlan?: {
      organisationId: string;
      designs: readonly DesignSummary[];
      onDesignMade: (design: DesignSummary) => void;
    };
  };

  /** r30-panels: more tabs for the right-hand panel (Checks, a plan, "It's down", a trace). What each draws goes
   * through `InSideSlot`. */
  sideTabs?: readonly SideTab[];

  /** The design's trail (ADR-0053 §4), folded to a strip on the right edge.
   * Absent where no design is open. */
  trail?: ReactNode;
  trailOpen?: boolean;
  onTrailOpenChange?: (open: boolean) => void;

  /** The drawing itself (or Inventory's lists, or Home): the shell draws
   * none of it. */
  children: ReactNode;
}
