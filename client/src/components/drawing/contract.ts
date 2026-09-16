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

/** The one editor's own field set (ADR-0046 §2) — exactly the four fields
 * `schema/schema.yaml` gives `Device` and `Chassis` that this session's
 * editor exposes. `value: null` is a cleared field (UI-SPEC "Absent is drawn
 * as absent" — a clear is never an empty string). */
export type EditorChange =
  | { kind: 'device'; id: string; field: 'hostname' | 'role' | 'management_address'; value: string | null }
  | { kind: 'chassis'; id: string; field: 'serial'; value: string | null };

/** What the editor raises. Like `DrawingActions`, it never acts on the graph
 * itself — the caller turns a change into a real edit through
 * `document/edit.ts` and finds out what happened only when a new `view` prop
 * arrives. */
export interface EditorActions {
  onEdit(change: EditorChange): void;
}

export type Selection =
  | { kind: 'rack'; id: string }
  | { kind: 'chassis'; id: string }
  | { kind: 'port'; id: string };

/** UI-SPEC "Absent is drawn as absent" — a dash, never an invented zero or
 * an omitted row. Shared by `ChassisNode` (the box) and `Editor` (the
 * panel) so a missing field reads the same mark in both places. */
export const ABSENT = '—';

/** A device's hostname is left unset by the command that places it, until
 * someone types one — never blank, never invented as a fact. Shared by
 * `ChassisNode` and `Editor` so the placeholder word is the same wherever a
 * hostname is drawn. */
export const UNNAMED_HOSTNAME = 'unnamed';

/** One row of the palette — the catalogue entries a rack may take, never a
 * hard-coded list (BRIEF's "no sample data in component source"). */
export interface PaletteItem {
  vendor: string;
  model: string;
  rackUnits: number;
  summary: string;
}
