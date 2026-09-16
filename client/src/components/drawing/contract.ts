/**
 * The view contract this drawing builds against. The document model is
 * being built in parallel by another session at `client/src/document/view.ts`
 * — when that file exists, the lead switches the import there in one line.
 * Until then these are declared here, with exactly the names and shapes the
 * brief specifies, so the switch is mechanical. The drawing never imports
 * `document/` directly.
 */

export interface PortView {
  id: string;
  label: string;
  connector: string;
  row: number;
  column: number;
  uplink: boolean;
}

export interface ChassisView {
  id: string;
  deviceId: string;
  hostname: string;
  model: string;
  vendor: string;
  positionU: number;
  heightU: number;
  face: 'front' | 'rear';
  ports: PortView[];
}

export interface RackView {
  id: string;
  label: string;
  heightU: number;
  unitNumbering: string;
  chassis: ChassisView[];
  freeRuns: Array<{ fromU: number; toU: number }>;
}

export interface ClosetView {
  premisesId: string;
  racks: RackView[];
}

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
