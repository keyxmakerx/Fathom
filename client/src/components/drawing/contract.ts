/**
 * The view contract this drawing builds against. `client/src/document/view.ts`
 * is the one definition of these four shapes in spirit, but this session
 * grows `PortView` a cable field that document/view.ts does not carry yet
 * (session 5 builds cabling against the drawing side of the seam only —
 * see the session brief), and `document/view.ts` is off limits to edit
 * here. So all four — `PortView`, `ChassisView`, `RackView`, `ClosetView`
 * — are declared locally below rather than re-exported: `PortView` grows
 * `cable`; `ChassisView` and `RackView` are otherwise byte-for-byte
 * `document/view.ts`'s own shapes (the brief's "`ChassisView` is
 * unchanged" — true of every field it already had), redeclared only so
 * their nested `ports: PortView[]` reaches the new `PortView` rather than
 * document/view.ts's own older one. Once the document side grows the same
 * field, the lead switches this file back to a plain re-export. The
 * drawing itself still never imports `document/` directly for anything but
 * these types — it goes through this module.
 *
 * `cable` and `cables` are typed optional (not the bare `CableEndView |
 * null` / `CableView[]` the brief's snippet shows) for two reasons that
 * both come down to the same seam: a `ClosetView`/`PortView` literal
 * written before this session — `Editor.render.test.ts`, owned by another
 * builder and off limits here — still type-checks without naming them; and
 * `racks/RacksPlace.tsx` (also off limits) hands this drawing a `ClosetView`
 * built by `document/view.ts`'s own `viewOf`, which does not set `cable`/
 * `cables` at all — TypeScript accepts a value missing an optional property,
 * so that still satisfies this file's `ClosetView`/`PortView` structurally.
 * Every reader in this drawing treats a missing one exactly as an explicit
 * empty one (`port.cable ?? null`, `view.cables ?? []`), so the two
 * spellings carry the same meaning throughout.
 */

/** One end of a cable, as seen from the port it plugs into. `farPortId`
 * and `farChassisId` are both `null` exactly when `outsideCloset` is true —
 * UI-SPEC "Portals": a cable leaving the closet names where it goes, not a
 * port on this side's estate. */
// The view the drawing renders has ONE definition, `document/view.ts`
// (ADR-0046 §2: one editor, one graph — and one shape of it). These are
// re-exported here so the drawing's callers import from one place; the
// seam that once redeclared them locally was collapsed on 2026-09-16 once
// the document carried cables.
import type { Sheath } from '../../document/view';

export type {
  CableEndView,
  InletView,
  RowView,
  CableKind,
  CableView,
  ChassisView,
  ClosetView,
  PortView,
  RackView,
  Sheath,
} from '../../document/view';

export interface DrawingActions {
  onPlace(rackId: string, catalogueRef: { vendor: string; model: string }, positionU: number): void;
  onMove(chassisId: string, rackId: string, positionU: number): void;
  onSelect(selection: Selection | null): void;
  /** UI-SPEC "Drag-to-connect": raised only on a drop the picker actually
   * confirmed — nothing is recorded for a cancelled drag. Optional for the
   * same reason `PortView.cable` is (file header): `racks/RacksPlace.tsx`,
   * off limits this session, builds a `Drawing` without it yet. Drag-to-
   * connect is simply inert (the lead never droops into a live drop) until
   * a caller supplies it. */
  onConnect?(fromPortId: string, toPortId: string, sheath: Sheath): void;
  /** UI-SPEC "Delete/Backspace on a selected cable" — raised after nothing
   * else; undo is the caller's concern, not this drawing's. Optional, same
   * reason as `onConnect`. */
  onDisconnect?(cableId: string): void;
}

/** The one editor's own field set (ADR-0046 §2). `value: null` is a cleared
 * field (UI-SPEC "Absent is drawn as absent" — a clear is never an empty
 * string). ADR-0050 §2/§4 add `Rack.row`/`.bay` and a chassis's power
 * supplies: `'rack'`'s `value` is always the raw text an input holds (the
 * editor deals only in strings — `EditableValue`, `Editor.tsx`); the caller
 * (`racks/RacksPlace.tsx`'s `handleEdit`) parses `bay` to a number before
 * calling `document/edit.ts`'s `setRackField`. `'supply-remove'`/
 * `'supply-fit'` are actions, not field edits — `document/supplies.ts`'s
 * `removeSupply`/`fitSupply` — and may still be refused (an unknown slot, a
 * slot already fitted, a fixed slot) the same way a field edit can. */
export type EditorChange =
  | { kind: 'device'; id: string; field: 'hostname' | 'role' | 'management_address'; value: string | null }
  | { kind: 'chassis'; id: string; field: 'serial'; value: string | null }
  | { kind: 'rack'; id: string; field: 'row' | 'bay'; value: string | null }
  | { kind: 'supply'; id: string; field: 'serial' | 'model'; value: string | null }
  | { kind: 'supply-remove'; id: string }
  | { kind: 'supply-fit'; chassisId: string; slot: string };

/** What the editor raises. Like `DrawingActions`, it never acts on the graph
 * itself — the caller turns a change into a real edit through
 * `document/edit.ts` and finds out what happened, for an ACCEPTED edit,
 * only when a new `view` prop arrives.
 *
 * A REFUSED edit (`document/edit.ts`'s `FieldValueError` — a malformed
 * management address, a role outside the enum) is different: nothing else
 * ever tells the editor which field it was, because there is no new view to
 * derive that from — the document did not change. So `onEdit` returns the
 * refusal directly, synchronously, rather than through a callback: the
 * caller (`racks/RacksPlace.tsx`'s `handleEdit`) already resolves an edit
 * in one synchronous call (`document/edit.ts` either returns a new
 * `Document` or throws, both in the same tick), so a return value is the
 * whole answer and needs no extra plumbing — a callback would add a second
 * way to report the same fact for no round trip this contract actually has
 * to survive. `void` means the edit was accepted, or the failure is not one
 * this editor names beside a field (e.g. the document moved under us,
 * `UnknownReferenceError`) — either way the caller leaves the document as
 * it was. */
export interface EditorActions {
  onEdit(change: EditorChange): { refused: string } | void;
}

export type Selection =
  | { kind: 'rack'; id: string }
  | { kind: 'chassis'; id: string }
  | { kind: 'port'; id: string }
  | { kind: 'cable'; id: string };

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
