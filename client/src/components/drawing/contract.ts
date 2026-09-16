/**
 * The view contract this drawing builds against. The document model
 * (`client/src/document/view.ts`) is the one definition of the four view
 * shapes below; this file re-exports them rather than declaring a second
 * copy, now that that file exists. The drawing itself still never imports
 * `document/` directly — it goes through this module.
 */

export type { ChassisView, ClosetView, PortView, RackView } from '../../document/view';

/**
 * What the drawing raises. It never acts on the graph itself — every one of
 * these is a request the caller (holding the real document) may accept,
 * reject, or turn into something else; the drawing finds out what happened
 * only when a new `view` prop arrives.
 */
export interface DrawingActions {
  onPlace(rackId: string, catalogueRef: { vendor: string; model: string }, positionU: number): void;
  onMove(chassisId: string, rackId: string, positionU: number): void;
  onSelect(selection: Selection | null): void;
}

export type Selection =
  | { kind: 'rack'; id: string }
  | { kind: 'chassis'; id: string }
  | { kind: 'port'; id: string };

/** One row of the palette — the catalogue entries a rack may take, never a
 * hard-coded list (BRIEF's "no sample data in component source"). */
export interface PaletteItem {
  vendor: string;
  model: string;
  rackUnits: number;
  summary: string;
}
