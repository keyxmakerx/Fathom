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
import type { Placement, Sheath } from '../../document/view';
// ADR-0053 §5/§6, this session's brief item 4 — the Notes section shared by
// a device, a port and a rack's own editor panel (`document/notes.ts`'s
// `NOTABLE_KINDS`): `NoteView` is the one read-side shape a caller hands
// back from `EditorActions.notesOf` below, the same "re-export the one
// document/ shape" precedent `Placement`/`Sheath` above already set for this
// file.
import type { NoteHow, NoteView } from '../../document/notes';

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
export type { NoteHow, NoteView } from '../../document/notes';

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
  /** ADR-0053 §1/§3, this session's brief item 2 — Ctrl Z, at the same
   * `keydown` listener `onDisconnect` above already uses, ignored while
   * focus sits in an input/textarea/select (the drawing's own cable delete
   * key already carries no such guard, since nothing else on this canvas
   * reads a keystroke while typing; Ctrl Z would collide with an ordinary
   * text undo in a field otherwise). Optional, same reason as `onConnect` —
   * a caller with nothing undoable simply never wires it, and the listener
   * calls nothing. */
  onUndo?(): void;
  /** Ctrl Shift Z, the same site. */
  onRedo?(): void;
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
  /** ADR-0051 §1, this session's brief item 1 — a shelf's own editor
   * commits its name through `document/edit.ts`'s `setPassiveNodeField`
   * (`'shelf'` names the caller's own intent; the write-side function takes
   * any `PassiveNode`, a shelf being this session's own one caller of it). */
  | { kind: 'shelf'; id: string; field: 'label'; value: string | null }
  | { kind: 'supply'; id: string; field: 'serial' | 'model'; value: string | null }
  | { kind: 'supply-remove'; id: string }
  | { kind: 'supply-fit'; chassisId: string; slot: string }
  /** ADR-0051 §1 — the "PLACED ON" control (Rack | Shelf | Surface): moves a
   * Chassis or PassiveNode to a new `Placement` (`document/view.ts`'s own
   * union — the read side; `document/commands.ts`'s `movePlacement` is its
   * write-side mirror, taking the same shape, so this change is passed
   * straight through unchanged). */
  | { kind: 'move-placement'; itemId: string; placement: Placement }
  /** ADR-0051 §1 — a sketch's own typed-by-hand port (`commands.ts`'s
   * `addSketchPort`). `service` is the schema's own optional field on
   * `PhysicalPort`, `null` when left blank — never an empty string standing
   * in for unset (UI-SPEC "Absent is drawn as absent"). */
  | { kind: 'add-sketch-port'; chassisId: string; label: string; connector: string; service: string | null; face: 'front' | 'rear' }
  /** ADR-0051 §1 — the reverse: `commands.ts`'s `removeSketchPort`. */
  | { kind: 'remove-sketch-port'; chassisId: string; portId: string }
  /** ADR-0051 §1 — a rack's "+ add a shelf" (`commands.ts`'s `createShelf`);
   * `label` is required (`PassiveNode.label`, schema card "1" — this
   * session's brief item 1); `model` names a catalogue entry from the
   * palette's own list, `null` for an unmodelled shelf (1U, per that
   * function's own default). */
  | { kind: 'create-shelf'; rackId: string; positionU: number; label: string; model: { vendor: string; model: string } | null }
  /** ADR-0051 §1 — "+ add a surface" (`commands.ts`'s `createSurface`).
   * `form` is the raw text the control holds — the caller
   * (`racks/RacksPlace.tsx`'s `handleEdit`) validates it against
   * `SURFACE_FORMS` before calling, the same way `'rack'`'s `bay` is parsed
   * before `setRackField` gets a chance to refuse it. */
  | { kind: 'create-surface'; premisesId: string; label: string; form: string };

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
  /** Optional — ADR-0052 §5's view-only rendering: a caller that holds only
   * `read` capability (`RacksPlace.tsx`'s `canDraw`) omits this entirely
   * rather than supply a function that refuses every call, so `Editor.tsx`
   * can tell "nothing to write to" apart from "wrote it, refused." Every
   * field then renders as plain text with no input and no action —
   * `Editor.tsx`'s own `EditableValue`/`SupplyAction`/`PlacedOnControl` and
   * the "+ add a port"/"+ add a shelf" controls all read this the same way. */
  onEdit?(change: EditorChange): { refused: string } | void;
  /** ADR-0051 §1, this session's brief item 4 — a shelf's own editor lists
   * its occupants by slot, each a link that selects the occupant (moves the
   * whole editor to that occupant's own panel) rather than editing
   * anything — a plain selection change, so it is its own callback, not an
   * `EditorChange` (which always ends in a write or a refusal). Optional
   * for the same reason `DrawingActions.onConnect`/`.onDisconnect` are
   * (`contract.ts`'s own file header note on that pattern): a caller that
   * does not supply one simply has no selecting links, not a crash. */
  onSelect?(selection: Selection): void;
  /** ADR-0053 §5, this session's brief item 4 — every live note on
   * `ownerId` (a Device, a PhysicalPort or a Rack — `document/notes.ts`'s
   * own `Notable`), re-read fresh off the caller's held `Document` on every
   * call rather than cached here: the same "no `Document` in this file"
   * contract every other `EditorActions` member already keeps. Optional —
   * absent renders no Notes section at all, not an empty one (ADR-0052 §5's
   * "no action, not a disabled one"). */
  notesOf?(ownerId: string): NoteView[];
  /** Typed text is stored exactly as given; pasted text is the caller's own
   * job to run through the redaction gate FIRST (`engine.ts`'s
   * `redactText`, ADR-0053 §6) before this is ever called — this function
   * only ever sees the text that should be written, typed or already gated.
   * Async because a paste's own gate call needs the module booted, which
   * `onEdit`'s synchronous contract (this file's own doc above) has no room
   * for; Notes are the one thing in this editor with a real await in the
   * middle. Optional, same reading as `onEdit`. */
  onAddNote?(ownerId: string, opts: { text: string; how: NoteHow }): Promise<{ refused: string } | void>;
  /** The reverse — `document/notes.ts`'s `removeNote`, synchronous like
   * `onEdit` (nothing to await: a tombstone needs no gate). Optional, same
   * reading. */
  onRemoveNote?(noteId: string): { refused: string } | void;
}

/** `EditorActions`'s three Notes members, grouped for a caller that only
 * wants to thread notes support (never `onEdit`/`onSelect`) into a place
 * component — `DesignPlace.tsx` builds exactly one of these and hands it to
 * both `RacksPlace`/`InventoryPlace`, each of which spreads it into its own
 * `EditorFor` call's `actions`. */
export type NotesActions = Required<Pick<EditorActions, 'notesOf' | 'onAddNote' | 'onRemoveNote'>>;

export type Selection =
  | { kind: 'rack'; id: string }
  | { kind: 'chassis'; id: string }
  | { kind: 'port'; id: string }
  | { kind: 'cable'; id: string }
  /** ADR-0051 §1, this session's brief items 1/4 — a shelf itself (as
   * opposed to one of its occupants, `'occupant'` below), selected by
   * clicking its own plate rather than a box on it. */
  | { kind: 'shelf'; id: string }
  /** ADR-0051 §1/§2 — a shelf occupant (`OccupantView`), selected by
   * clicking its own box on the plate. */
  | { kind: 'occupant'; id: string }
  /** ADR-0051 §1/§2 — a surface fixture (`FixtureView`, a board included —
   * a board is itself a fixture), selected by clicking it on its surface. */
  | { kind: 'fixture'; id: string };

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
