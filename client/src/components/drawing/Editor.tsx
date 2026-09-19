import { useEffect, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';

import '../../styles/drawing.css';
// ADR-0053 §6, this session's brief item 4 — "the black block reused from
// the drawer where a value was destroyed": `.config-drawer__block`
// (`config/config.css`) is imported here, read-only, rather than copied —
// the same visual, `NotesSection`'s own marker parsing below only ever
// applies the class the gate's own `<REDACTED:label>` convention already
// gets in `ConfigDrawer.tsx`.
import '../config/config.css';
import { DEVICE_ROLES } from '../../document/edit';
import { PORT_CONNECTOR_VALUES, PORT_SERVICE_VALUES } from '../../document/compat';
// `FixtureView`/`Placement` are not in `contract.ts`'s own re-export list
// (frozen this session — that file's header: "the view re-exports stay"),
// but they are `document/view.ts`'s own read-side shapes, the same ones
// `ChassisView.placement` and `SurfaceView.fixtures` already carry
// structurally; named here so the "PLACED ON" control (ADR-0051 §1, this
// session's brief item 1) can walk a board's nested fixtures and build the
// right `Placement` literal. Type-only, the same as `DEVICE_ROLES` above —
// this file still never reads or writes a `Document`.
import type { FixtureView, Placement } from '../../document/view';
import {
  ABSENT,
  UNNAMED_HOSTNAME,
  type ClosetView,
  type EditorActions,
  type EditorChange,
  type NoteHow,
  type NoteView,
  type PaletteItem,
  type PortView,
  type Selection,
} from './contract';
import { findChassis, findFixture, findOccupant, findRack, findShelf, locatePort } from './lookup';

// `DEVICE_ROLES` is `Device.role`'s own enum vocabulary (`schema/schema.yaml`,
// mirrored once in `document/edit.ts` rather than guessed here — CLAUDE.md
// rule 3, "role's values are the enum, never a free string"); `PORT_CONNECTOR_VALUES`/
// `PORT_SERVICE_VALUES` (`document/compat.ts`) and `FixtureView`/`Placement`
// (`document/view.ts`, type-only) are the same kind of import, added for
// ADR-0051 §1's sketch-port and "PLACED ON" controls. Every one of these is
// a vocabulary or a read-side shape, never a live `Document`: this file
// still never reads or writes one, it only raises `EditorActions.onEdit`
// and waits for a new `view` prop, the same contract `DrawingActions`
// already keeps.

function Field({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="drawing-editor__field">
      <div className="drawing-editor__field-label">{label}</div>
      <div className="drawing-editor__field-value">{value}</div>
    </div>
  );
}

// UI-SPEC "Screens": first press on a value selects it, second press turns
// it into an input. Selected reads as `--surface` background with a
// `--rule-accent` (4px) ink rule on the left — `drawing.css`'s own tokens,
// applied inline because this file does not touch `drawing.css` (owned by
// the canvas builder this session).
const SELECTED_STYLE: CSSProperties = {
  display: 'inline-block',
  background: 'var(--surface)',
  borderLeft: 'var(--rule-accent) solid var(--ink)',
  paddingLeft: 'calc(var(--s2) - var(--rule-accent))',
  marginLeft: 'calc(-1 * var(--s2))',
  cursor: 'pointer',
};

const IDLE_STYLE: CSSProperties = {
  display: 'inline-block',
  borderLeft: 'var(--rule-accent) solid transparent',
  paddingLeft: 'calc(var(--s2) - var(--rule-accent))',
  marginLeft: 'calc(-1 * var(--s2))',
  cursor: 'pointer',
};

const TYPED_NOTE_STYLE: CSSProperties = {
  fontSize: 'var(--t-micro)',
  color: 'var(--muted)',
  lineHeight: 1.4,
};

// UI-SPEC "Cables": "A risk colour is only ever a bordered wash with words
// in it — never bare coloured text." A refused edit is exactly that risk —
// same `--danger`/`--danger-wash` tokens `racks.css`'s
// `.racks-place__refusal` already uses for the server's own refusal path,
// applied inline because this file does not touch `drawing.css` (see the
// file header).
const CAUTION_STYLE: CSSProperties = {
  display: 'block',
  marginTop: 'var(--s1)',
  border: 'var(--rule-hair) solid var(--danger)',
  background: 'var(--danger-wash)',
  color: 'var(--danger)',
  padding: 'var(--s1) var(--s2)',
  fontSize: 'var(--t-micro)',
};

type FieldState = 'idle' | 'selected' | 'editing';

interface EditableValueProps {
  value: string;
  placeholder: string;
  placeholderClassName?: string;
  editorKind: 'text' | 'select';
  options?: readonly string[];
  /** Returns the refusal beside a value the schema refused
   * (`EditorActions.onEdit`, `contract.ts`) — see its doc for why this is a
   * return value and not a callback. `undefined` when the caller holds no
   * `EditorActions.onEdit` at all (ADR-0052 §5's view-only rendering) — the
   * field then never becomes selectable or editable, only ever the plain
   * text `hasValue ? value : placeholder` already read for the idle state. */
  onCommit: ((raw: string | null) => { refused: string } | void) | undefined;
}

/**
 * One field of the one editor (ADR-0046 §2): idle -> click selects it ->
 * click again edits it. Enter or blur commits; Escape reverts without
 * committing. A `select` (for `Device.role`) commits on choice — there is no
 * free-text value to refuse there, the schema's own enum is the option list.
 *
 * ADR-0052 §5: `onCommit == null` (a reader, no `EditorActions.onEdit`) is
 * read-only — the click handler that would move it out of `idle` is simply
 * not attached, so `state` can never reach `'selected'`/`'editing'` and no
 * `<input>`/`<select>` is ever rendered, only the same text a writer sees at
 * rest.
 */
function EditableValue({ value, placeholder, placeholderClassName, editorKind, options, onCommit }: EditableValueProps) {
  const [state, setState] = useState<FieldState>('idle');
  const [draft, setDraft] = useState(value);
  const [refusal, setRefusal] = useState<string | null>(null);
  const readOnly = onCommit == null;

  // The document changed under us (a save applied, or a refusal left it as
  // it was) — pick up the authoritative value whenever this field is not
  // mid-edit.
  useEffect(() => {
    if (state !== 'editing') setDraft(value);
  }, [value, state]);

  // The field's own authoritative value moved under us — a save applied, a
  // different edit landed, or this is a fresh selection entirely. Whatever
  // refusal was showing no longer describes the current value, so it
  // clears with it rather than lingering as a stale caution.
  useEffect(() => {
    setRefusal(null);
  }, [value]);

  function commit(raw: string) {
    if (!onCommit) return; // unreachable in practice — see `readOnly`, below
    const trimmed = raw.trim();
    const result = onCommit(trimmed.length > 0 ? trimmed : null);
    if (result?.refused) {
      setRefusal(result.refused);
      setState('selected');
      return;
    }
    setRefusal(null);
    setState('idle');
  }

  function revert() {
    setDraft(value);
    setRefusal(null);
    setState('selected');
  }

  if (state === 'editing' && !readOnly) {
    if (editorKind === 'select') {
      return (
        <select
          autoFocus
          className="drawing-editor__field-value"
          value={draft}
          onChange={(e) => commit(e.target.value)}
          onBlur={() => setState('selected')}
          onKeyDown={(e: KeyboardEvent<HTMLSelectElement>) => {
            if (e.key === 'Escape') revert();
          }}
        >
          <option value="" />
          {(options ?? []).map((opt) => (
            <option key={opt} value={opt}>
              {opt}
            </option>
          ))}
        </select>
      );
    }
    return (
      <input
        autoFocus
        className="drawing-editor__field-value"
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setRefusal(null);
        }}
        onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
          if (e.key === 'Enter') commit(draft);
          else if (e.key === 'Escape') revert();
        }}
        onBlur={() => commit(draft)}
      />
    );
  }

  const hasValue = value.length > 0;
  return (
    <>
      <span
        style={readOnly ? undefined : state === 'selected' ? SELECTED_STYLE : IDLE_STYLE}
        className={hasValue ? undefined : placeholderClassName}
        onClick={readOnly ? undefined : () => setState(state === 'selected' ? 'editing' : 'selected')}
      >
        {hasValue ? value : placeholder}
      </span>
      {refusal != null ? <div style={CAUTION_STYLE}>{refusal}</div> : null}
    </>
  );
}

/** A supply's remove/fit action (ADR-0050 §4) — the same idle/refused shape
 * `EditableValue` uses (`CAUTION_STYLE`), but for a one-shot command rather
 * than a typed value: `onCommit` calls straight through to
 * `EditorActions.onEdit` and shows whatever refusal comes back
 * (`document/supplies.ts`'s `UnknownSlotError`/`SlotAlreadyFittedError`/
 * `FixedSlotError`, via `racks/RacksPlace.tsx`'s own `refusalFor`) beside
 * the button, the same way a refused field edit shows beside its field. */
function SupplyAction({
  label,
  onCommit,
}: {
  label: string;
  /** `undefined` when the caller holds no `EditorActions.onEdit`
   * (ADR-0052 §5) — nothing renders at all, "no actions" rather than a
   * disabled button, since there is no refusal to show for a click that
   * would never happen. */
  onCommit: (() => { refused: string } | void) | undefined;
}) {
  const [refusal, setRefusal] = useState<string | null>(null);
  if (!onCommit) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => {
          const result = onCommit();
          setRefusal(result?.refused ?? null);
        }}
      >
        {label}
      </button>
      {refusal != null ? <div style={CAUTION_STYLE}>{refusal}</div> : null}
    </>
  );
}

/** ADR-0051 §1, this session's brief item 4 — a shelf's own editor lists
 * its occupants by slot, each a link that selects the occupant
 * (`EditorActions.onSelect`, optional — nothing renders here if a caller
 * has not supplied one, the same graceful-absence `DrawingActions.onConnect`
 * already gives elsewhere). Plain underlined ink text, never a bordered
 * wash (`CAUTION_STYLE` is reserved for a refusal) — this is navigation,
 * not risk. */
const LINK_STYLE: CSSProperties = {
  background: 'none',
  border: 'none',
  padding: 0,
  margin: 0,
  color: 'var(--ink)',
  textDecoration: 'underline',
  cursor: 'pointer',
  font: 'inherit',
};

function SelectLink({ label, onSelect }: { label: string; onSelect?: () => void }) {
  if (!onSelect) return <span>{label}</span>;
  return (
    <button type="button" style={LINK_STYLE} onClick={onSelect}>
      {label}
    </button>
  );
}

/** The Inventory board's own mark (`design/proposals/screens/Inventory.dc.html`
 * — "Stored as typed."), shown once a field carries a value: every field
 * this editor writes is `Origin::Hand` (`document/edit.ts`'s `assertHand`),
 * so a present value here is always one a person typed. `extra`, used only
 * for `management_address`, is the board's own ADR-0041 sentence stated
 * once, muted. */
function TypedNote({ shown, extra }: { shown: boolean; extra?: string }) {
  if (!shown) return null;
  return (
    <div style={TYPED_NOTE_STYLE}>
      <strong style={{ color: 'var(--ink)', fontWeight: 700 }}>Stored as typed.</strong>
      {extra ? ` ${extra}` : ''}
    </div>
  );
}

const MANAGEMENT_ADDRESS_NOTE =
  'Fathom does not redact what you type, only what you paste, so it is saved and exported exactly as written.';

// ===========================================================================
// ADR-0051 §1 — the "PLACED ON" control, a sketch's typed ports, and a
// rack's "+ add a shelf" (this session's brief items 1–3). Each raises one
// `EditorChange` (`contract.ts`) through `EditorActions.onEdit`, the same
// `{ refused: string } | void` contract every existing action already uses
// — a refusal shows beside the control with `CAUTION_STYLE`, the same wash
// `EditableValue`/`SupplyAction` show theirs with. The literal-building part
// of each is pulled out as its own pure function (`moveToRackChange` and
// its siblings below) so the SHAPE of what gets raised is testable without
// rendering or simulating a click — this project's tests have no DOM
// environment to drive one (`Editor.render.test.ts`'s own header).

/** ADR-0051 §1 — the "PLACED ON" control's own segmented-button look: a flat
 * hairline box, the current choice filled ink, per UI-SPEC "zero radius, no
 * shadows" — applied inline for the same reason `SELECTED_STYLE` above is
 * (this file does not touch `drawing.css`). */
const SEGMENT_ACTIVE_STYLE: CSSProperties = {
  background: 'var(--ink)',
  color: 'var(--paper)',
  border: 'var(--rule-hair) solid var(--ink)',
  padding: 'var(--s1) var(--s2)',
  fontSize: 'var(--t-micro)',
  cursor: 'default',
};

const SEGMENT_STYLE: CSSProperties = {
  ...SEGMENT_ACTIVE_STYLE,
  background: 'var(--surface)',
  color: 'var(--ink)',
  cursor: 'pointer',
};

/** The compact "TYPED" mark the Shelf board's editor prints beside every
 * hand-typed port (`design/places/renders/Shelf.png`) — muted, bordered,
 * never a risk colour (it names provenance, not a caution). */
const TYPED_BADGE_STYLE: CSSProperties = {
  display: 'inline-block',
  fontSize: 'var(--t-micro)',
  letterSpacing: 'var(--track-label)',
  textTransform: 'uppercase',
  color: 'var(--muted)',
  border: 'var(--rule-hair) solid var(--muted)',
  padding: '0 3px',
  lineHeight: 1.4,
};

export function moveToRackChange(itemId: string, rackId: string, positionU: number, face: 'front' | 'rear' = 'front'): EditorChange {
  return { kind: 'move-placement', itemId, placement: { kind: 'rack', rackId, positionU, face } };
}

export function moveToShelfChange(itemId: string, shelfId: string, slot: number): EditorChange {
  return { kind: 'move-placement', itemId, placement: { kind: 'shelf', shelfId, slot } };
}

/** `target.kind` tells a board (`FixedTo` another `PassiveNode`) from a
 * surface (`FixedTo` a `Surface`) — `view.ts`'s own `placementOf` reads the
 * same distinction back off which kind of node `FixedTo.to` names. */
export function moveToSurfaceChange(
  itemId: string,
  target: { id: string; kind: 'surface' | 'board' },
  xMm: number | null,
  yMm: number | null,
): EditorChange {
  return {
    kind: 'move-placement',
    itemId,
    placement:
      target.kind === 'board' ? { kind: 'board', boardId: target.id, xMm, yMm } : { kind: 'surface', surfaceId: target.id, xMm, yMm },
  };
}

export function addSketchPortChange(
  chassisId: string,
  label: string,
  connector: string,
  service: string | null,
  face: 'front' | 'rear',
): EditorChange {
  return { kind: 'add-sketch-port', chassisId, label, connector, service, face };
}

export function removeSketchPortChange(chassisId: string, portId: string): EditorChange {
  return { kind: 'remove-sketch-port', chassisId, portId };
}

export function createShelfChange(
  rackId: string,
  positionU: number,
  label: string,
  model: { vendor: string; model: string } | null,
): EditorChange {
  return { kind: 'create-shelf', rackId, positionU, label, model };
}

export function createSurfaceChange(premisesId: string, label: string, form: string): EditorChange {
  return { kind: 'create-surface', premisesId, label, form };
}

/** Every shelf across every rack this view carries, each labelled with its
 * own rack too — a shelf's id alone does not say where it is. */
function shelfOptions(view: ClosetView): Array<{ id: string; label: string }> {
  const out: Array<{ id: string; label: string }> = [];
  for (const rack of view.racks) {
    for (const shelf of rack.shelves) {
      out.push({ id: shelf.id, label: `${shelf.label || shelf.id} · ${rack.label}` });
    }
  }
  return out;
}

/** Every board nested under `fixtures`, at any depth — a board is itself a
 * `FixtureView` (`PassiveNode.form === 'board'`) that carries its own nested
 * `fixtures` (`view.ts`'s own doc on `FixtureView.fixtures`). */
function collectBoards(fixtures: readonly FixtureView[], out: Array<{ id: string; label: string }>): void {
  for (const f of fixtures) {
    if (f.form === 'board') out.push({ id: f.id, label: f.label || f.id });
    collectBoards(f.fixtures, out);
  }
}

/** Every surface, and every board fixed to one, this view carries — the two
 * kinds `movePlacement`'s own `'surface'`/`'board'` `Placement` distinguish
 * (`moveToSurfaceChange` above), offered together because item 1's own
 * contract asks for "a surface or board" as one choice. */
function surfaceOptions(view: ClosetView): Array<{ id: string; label: string; kind: 'surface' | 'board' }> {
  const out: Array<{ id: string; label: string; kind: 'surface' | 'board' }> = [];
  for (const surface of view.surfaces) {
    out.push({ id: surface.id, label: surface.label || surface.id, kind: 'surface' });
    const boards: Array<{ id: string; label: string }> = [];
    collectBoards(surface.fixtures, boards);
    for (const b of boards) out.push({ id: b.id, label: `${b.label} (board)`, kind: 'board' });
  }
  return out;
}

interface PlacedOnControlProps {
  itemId: string;
  placement: Placement;
  view: ClosetView;
  actions: EditorActions;
}

/** ADR-0051 §1, this session's brief item 1 — "PLACED ON" as three choices,
 * the current one marked; choosing another asks for what that place needs
 * (a rack and a unit; a shelf and a slot; a surface or board and optional
 * millimetres, per `design/places/renders/Shelf.png`'s own editor) and
 * raises `moveToRackChange`/`moveToShelfChange`/`moveToSurfaceChange`
 * through `actions.onEdit`. A refusal (an occupied slot, an unknown target,
 * a range that does not fit) shows beside the control exactly as
 * `EditableValue`'s does. */
function PlacedOnControl({ itemId, placement, view, actions }: PlacedOnControlProps) {
  const [asking, setAsking] = useState<'rack' | 'shelf' | 'surface' | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [rackId, setRackId] = useState('');
  const [positionU, setPositionU] = useState('1');
  const [shelfId, setShelfId] = useState('');
  const [slot, setSlot] = useState('0');
  const [surfaceKey, setSurfaceKey] = useState('');
  const [xMm, setXMm] = useState('');
  const [yMm, setYMm] = useState('');

  // The authoritative placement moved under us (a move applied elsewhere,
  // or this is a fresh selection) — the same reset `EditableValue`'s own
  // `useEffect` gives a stale refusal.
  useEffect(() => {
    setAsking(null);
    setRefusal(null);
  }, [itemId, placement.kind]);

  const onEdit = actions.onEdit;

  // ADR-0052 §5: no `EditorActions.onEdit` at all — the segmented choice and
  // every form behind it are the actions this control has, so a reader gets
  // only the plain summary Fields below, never a control that could commit
  // nothing.
  if (!onEdit) {
    return (
      <div className="drawing-editor__field">
        <div className="drawing-editor__field-label">Placed on</div>
        {placement.kind === 'none' ? <Field label="Placed" value={ABSENT} /> : null}
        {placement.kind === 'rack' ? <Field label="Unit" value={`U${placement.positionU}`} /> : null}
        {placement.kind === 'shelf' ? <Field label="Slot" value={String(placement.slot)} /> : null}
        {placement.kind === 'surface' || placement.kind === 'board' ? (
          <Field
            label="Position"
            value={placement.xMm != null && placement.yMm != null ? `${placement.xMm}mm, ${placement.yMm}mm` : ABSENT}
          />
        ) : null}
      </div>
    );
  }

  // Re-typed without the `| undefined` the field carries — the `if (!onEdit)
  // return` above already proved it out, but that narrowing does not reach
  // into `commit`, a nested `function` declaration TypeScript does not
  // narrow a closed-over `const` through (unlike an inline arrow function).
  const doEdit: (change: EditorChange) => { refused: string } | void = onEdit;

  const racks = view.racks;
  const shelves = shelfOptions(view);
  const surfaces = surfaceOptions(view);

  function open(kind: 'rack' | 'shelf' | 'surface') {
    setRefusal(null);
    setAsking(kind);
    if (kind === 'rack') {
      setRackId(placement.kind === 'rack' ? placement.rackId : (racks[0]?.id ?? ''));
      setPositionU(placement.kind === 'rack' ? String(placement.positionU) : '1');
    } else if (kind === 'shelf') {
      setShelfId(placement.kind === 'shelf' ? placement.shelfId : (shelves[0]?.id ?? ''));
      setSlot(placement.kind === 'shelf' ? String(placement.slot) : '0');
    } else {
      const currentId = placement.kind === 'surface' ? placement.surfaceId : placement.kind === 'board' ? placement.boardId : undefined;
      const current = surfaces.find((s) => s.id === currentId);
      setSurfaceKey(current ? `${current.kind}:${current.id}` : (surfaces[0] ? `${surfaces[0].kind}:${surfaces[0].id}` : ''));
      setXMm(placement.kind === 'surface' || placement.kind === 'board' ? (placement.xMm != null ? String(placement.xMm) : '') : '');
      setYMm(placement.kind === 'surface' || placement.kind === 'board' ? (placement.yMm != null ? String(placement.yMm) : '') : '');
    }
  }

  function commit(change: EditorChange) {
    const result = doEdit(change);
    if (result?.refused) {
      setRefusal(result.refused);
      return;
    }
    setRefusal(null);
    setAsking(null);
  }

  function commitRack() {
    const u = Number(positionU);
    if (!Number.isInteger(u) || u < 1) {
      setRefusal('unit must be a whole number, 1 or more');
      return;
    }
    if (rackId === '') {
      setRefusal('choose a rack');
      return;
    }
    commit(moveToRackChange(itemId, rackId, u));
  }

  function commitShelf() {
    const s = Number(slot);
    if (!Number.isInteger(s) || s < 0) {
      setRefusal('slot must be a whole number, 0 or more');
      return;
    }
    if (shelfId === '') {
      setRefusal('choose a shelf');
      return;
    }
    commit(moveToShelfChange(itemId, shelfId, s));
  }

  function commitSurface() {
    if (surfaceKey === '') {
      setRefusal('choose a surface or board');
      return;
    }
    // `surfaceKey` is `${kind}:${id}` and `id` itself is `<kebab-kind>:<ulid>`
    // (`document/model.ts`'s own `formatNodeId`) — split on the FIRST colon
    // only, never `String.split(':')`, which would cut the id apart too.
    const sep = surfaceKey.indexOf(':');
    const kind = surfaceKey.slice(0, sep) as 'surface' | 'board';
    const id = surfaceKey.slice(sep + 1);
    const x = xMm.trim().length > 0 ? Number(xMm) : null;
    const y = yMm.trim().length > 0 ? Number(yMm) : null;
    // `FixedTo.x_mm`/`.y_mm` are schema `u32` (`document/commands.ts`'s
    // `movePlacement`: `uint(placement.xMm, 32)`) — a non-integer or a
    // negative value reaches `uint` and throws a bare `RangeError` there,
    // which used to close this form as if the move had succeeded
    // (`refusalFor` did not name it). Caught here instead, the same "whole
    // number, 0 or more" shape `commitRack`'s unit and `commitShelf`'s slot
    // already check.
    const UINT32_MAX = 2 ** 32 - 1;
    const inRange = (n: number) => Number.isInteger(n) && n >= 0 && n <= UINT32_MAX;
    if ((x != null && !inRange(x)) || (y != null && !inRange(y))) {
      setRefusal(`position must be a whole number, 0 to ${UINT32_MAX}, or left blank`);
      return;
    }
    commit(moveToSurfaceChange(itemId, { id, kind }, x, y));
  }

  const CHOICES: ReadonlyArray<'rack' | 'shelf' | 'surface'> = ['rack', 'shelf', 'surface'];
  const currentKind: 'rack' | 'shelf' | 'surface' | null =
    placement.kind === 'rack' || placement.kind === 'shelf' ? placement.kind : placement.kind === 'surface' || placement.kind === 'board' ? 'surface' : null;

  return (
    <div className="drawing-editor__field">
      <div className="drawing-editor__field-label">Placed on</div>
      <div style={{ display: 'flex', gap: 0 }}>
        {CHOICES.map((choice) => (
          <button
            key={choice}
            type="button"
            style={choice === currentKind ? SEGMENT_ACTIVE_STYLE : SEGMENT_STYLE}
            disabled={choice === currentKind}
            onClick={() => open(choice)}
          >
            {choice === 'rack' ? 'Rack' : choice === 'shelf' ? 'Shelf' : 'Surface'}
          </button>
        ))}
      </div>

      {placement.kind === 'none' ? <Field label="Placed" value={ABSENT} /> : null}
      {placement.kind === 'rack' ? <Field label="Unit" value={`U${placement.positionU}`} /> : null}
      {placement.kind === 'shelf' ? <Field label="Slot" value={String(placement.slot)} /> : null}
      {placement.kind === 'surface' || placement.kind === 'board' ? (
        <Field
          label="Position"
          value={placement.xMm != null && placement.yMm != null ? `${placement.xMm}mm, ${placement.yMm}mm` : ABSENT}
        />
      ) : null}

      {asking === 'rack' ? (
        <div className="drawing-editor__field">
          <select value={rackId} onChange={(e) => setRackId(e.target.value)}>
            {racks.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
          <input placeholder="unit" value={positionU} onChange={(e) => setPositionU(e.target.value)} />
          <button type="button" onClick={commitRack}>
            move
          </button>
          <button type="button" onClick={() => setAsking(null)}>
            cancel
          </button>
        </div>
      ) : null}

      {asking === 'shelf' ? (
        <div className="drawing-editor__field">
          <select value={shelfId} onChange={(e) => setShelfId(e.target.value)}>
            {shelves.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
              </option>
            ))}
          </select>
          <input placeholder="slot" value={slot} onChange={(e) => setSlot(e.target.value)} />
          <button type="button" onClick={commitShelf}>
            move
          </button>
          <button type="button" onClick={() => setAsking(null)}>
            cancel
          </button>
        </div>
      ) : null}

      {asking === 'surface' ? (
        <div className="drawing-editor__field">
          <select value={surfaceKey} onChange={(e) => setSurfaceKey(e.target.value)}>
            {surfaces.map((s) => (
              <option key={`${s.kind}:${s.id}`} value={`${s.kind}:${s.id}`}>
                {s.label}
              </option>
            ))}
          </select>
          <input placeholder="x mm (optional)" value={xMm} onChange={(e) => setXMm(e.target.value)} />
          <input placeholder="y mm (optional)" value={yMm} onChange={(e) => setYMm(e.target.value)} />
          <button type="button" onClick={commitSurface}>
            move
          </button>
          <button type="button" onClick={() => setAsking(null)}>
            cancel
          </button>
        </div>
      ) : null}

      {refusal != null ? <div style={CAUTION_STYLE}>{refusal}</div> : null}
    </div>
  );
}

/** ADR-0051 §1, brief item 2 — "+ add a port" on a sketch: label, connector
 * (the schema's own `PhysicalPort.connector` enum, `document/compat.ts`'s
 * `PORT_CONNECTOR_VALUES` — the same vocabulary `commands.ts`'s
 * `addSketchPort` itself refuses outside of), service (its optional
 * `PhysicalPort.service`, `PORT_SERVICE_VALUES`, blank means unset) and face. */
function AddSketchPortForm({ chassisId, actions }: { chassisId: string; actions: EditorActions }) {
  const [open, setIsOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [connector, setConnector] = useState<string>(PORT_CONNECTOR_VALUES[0]);
  const [service, setService] = useState('');
  const [face, setFace] = useState<'front' | 'rear'>('front');
  const [refusal, setRefusal] = useState<string | null>(null);

  const onEdit = actions.onEdit;
  // ADR-0052 §5: no `EditorActions.onEdit` — no add control at all, not
  // even the closed "+ add a port" button, the same "no actions" reading
  // `SupplyAction` gives a reader.
  if (!onEdit) return null;
  // As `PlacedOnControl`'s own `doEdit` above — `commit`, a nested
  // `function` declaration, does not inherit the narrowing the `if
  // (!onEdit)` check just proved.
  const doEdit: (change: EditorChange) => { refused: string } | void = onEdit;

  if (!open) {
    return (
      <button type="button" onClick={() => setIsOpen(true)}>
        + add a port
      </button>
    );
  }

  function commit() {
    const result = doEdit(addSketchPortChange(chassisId, label, connector, service.length > 0 ? service : null, face));
    if (result?.refused) {
      setRefusal(result.refused);
      return;
    }
    setRefusal(null);
    setIsOpen(false);
    setLabel('');
    setService('');
  }

  return (
    <div className="drawing-editor__field">
      <input placeholder="label" value={label} onChange={(e) => setLabel(e.target.value)} />
      <select value={connector} onChange={(e) => setConnector(e.target.value)}>
        {PORT_CONNECTOR_VALUES.map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
      <select value={service} onChange={(e) => setService(e.target.value)}>
        <option value="">{ABSENT}</option>
        {PORT_SERVICE_VALUES.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </select>
      <select value={face} onChange={(e) => setFace(e.target.value as 'front' | 'rear')}>
        <option value="front">front</option>
        <option value="rear">rear</option>
      </select>
      <button type="button" onClick={commit}>
        add
      </button>
      <button type="button" onClick={() => setIsOpen(false)}>
        cancel
      </button>
      {refusal != null ? <div style={CAUTION_STYLE}>{refusal}</div> : null}
    </div>
  );
}

/** ADR-0051 §1, brief item 2 — a sketch's own ports, each marked TYPED
 * (`TYPED_BADGE_STYLE`) with a remove action, plus "+ add a port". A
 * chassis WITH a catalogue model shows its ports read-only "as today" (the
 * brief's own words) — this section is never rendered for one. */
function SketchPortsSection({ chassisId, ports, actions }: { chassisId: string; ports: PortView[]; actions: EditorActions }) {
  return (
    <div className="drawing-editor__field">
      <div className="drawing-editor__field-label">Ports · typed by hand</div>
      {ports.map((port) => (
        <div key={port.id} className="drawing-editor__field" style={{ display: 'flex', alignItems: 'center', gap: 'var(--s2)' }}>
          <span>{port.label || ABSENT}</span>
          <span style={{ color: 'var(--muted)' }}>{port.connector}</span>
          <span style={TYPED_BADGE_STYLE}>typed</span>
          <SupplyAction
            label="remove"
            onCommit={actions.onEdit ? () => actions.onEdit!(removeSketchPortChange(chassisId, port.id)) : undefined}
          />
        </div>
      ))}
      <AddSketchPortForm chassisId={chassisId} actions={actions} />
    </div>
  );
}

/** ADR-0051 §1, brief item 3 — a rack's own "+ add a shelf": a unit and an
 * optional catalogue model drawn from the same list the palette itself
 * offers (`racks/palette.ts`'s `paletteFromCatalogue`) — never a hard-coded
 * list (BRIEF's own "no sample data in component source"). */
function AddShelfControl({ rackId, catalogue, actions }: { rackId: string; catalogue: readonly PaletteItem[]; actions: EditorActions }) {
  const [open, setIsOpen] = useState(false);
  const [positionU, setPositionU] = useState('1');
  const [label, setLabel] = useState('');
  const [modelKey, setModelKey] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);

  const onEdit = actions.onEdit;
  // ADR-0052 §5: as `AddSketchPortForm` above — no `EditorActions.onEdit`,
  // no "+ add a shelf" control at all.
  if (!onEdit) return null;
  // As `PlacedOnControl`'s own `doEdit` above.
  const doEdit: (change: EditorChange) => { refused: string } | void = onEdit;

  if (!open) {
    return (
      <button type="button" onClick={() => setIsOpen(true)}>
        + add a shelf
      </button>
    );
  }

  function commit() {
    const u = Number(positionU);
    if (!Number.isInteger(u) || u < 1) {
      setRefusal('unit must be a whole number, 1 or more');
      return;
    }
    // `PassiveNode.label` is schema card "1" — required (this session's
    // brief item 1, `commands.ts`'s `CreateShelfOptions.label`'s own doc):
    // refused here, before `createShelf` ever gets a chance to write an
    // empty string, the same "parse before the write side sees it" shape
    // `commitRack`'s own unit check already follows.
    if (label.trim().length === 0) {
      setRefusal('name the shelf');
      return;
    }
    let model: { vendor: string; model: string } | null = null;
    if (modelKey !== '') {
      const [vendor, ...rest] = modelKey.split('|');
      model = { vendor, model: rest.join('|') };
    }
    const result = doEdit(createShelfChange(rackId, u, label.trim(), model));
    if (result?.refused) {
      setRefusal(result.refused);
      return;
    }
    setRefusal(null);
    setIsOpen(false);
    setPositionU('1');
    setLabel('');
    setModelKey('');
  }

  return (
    <div className="drawing-editor__field">
      <input placeholder="unit" value={positionU} onChange={(e) => setPositionU(e.target.value)} />
      <input placeholder="name" value={label} onChange={(e) => setLabel(e.target.value)} />
      <select value={modelKey} onChange={(e) => setModelKey(e.target.value)}>
        <option value="">no catalogue model</option>
        {catalogue.map((item) => (
          <option key={`${item.vendor}/${item.model}`} value={`${item.vendor}|${item.model}`}>
            {item.vendor} {item.model} ({item.rackUnits}U)
          </option>
        ))}
      </select>
      <button type="button" onClick={commit}>
        add
      </button>
      <button type="button" onClick={() => setIsOpen(false)}>
        cancel
      </button>
      {refusal != null ? <div style={CAUTION_STYLE}>{refusal}</div> : null}
    </div>
  );
}

// ===========================================================================
// ADR-0053 §5/§6, this session's brief item 4 — Notes, on a device, a port
// and a rack (exactly `document/notes.ts`'s `Notable` set): the notes with
// who, when, typed or pasted; an add box for each of the two; remove.

/** `<REDACTED:label>` — the same marker `ConfigDrawer.tsx`'s own
 * `lineSegments` reads (that file's own doc on the convention;
 * `document/capture.ts`'s `dropsIn` is the third, unexported reader). A
 * pasted note's stored text carries this literally (`engine.ts`'s
 * `redactText`'s own doc: "the client writes the note with the returned
 * text"), so parsing it back out at render time — rather than storing a
 * separate drops list nothing in `document/notes.ts`'s schema carries — is
 * enough to draw the same black block here that a destroyed config value
 * gets in the drawer, with no second copy of the gate's own decision.
 */
const NOTE_REDACTED_MARKER = /<REDACTED:([^>]+)>/g;

function noteTextSegments(text: string): ReactNode {
  NOTE_REDACTED_MARKER.lastIndex = 0;
  const parts: ReactNode[] = [];
  let cursor = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = NOTE_REDACTED_MARKER.exec(text)) !== null) {
    if (m.index > cursor) parts.push(text.slice(cursor, m.index));
    parts.push(
      <span key={`note-block-${key}`} className="config-drawer__block">
        {m[1]} · destroyed at the gate
      </span>,
    );
    key += 1;
    cursor = m.index + m[0].length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts.length > 0 ? parts : text;
}

const NOTE_META_STYLE: CSSProperties = {
  fontSize: 'var(--t-micro)',
  color: 'var(--muted)',
};

const NOTE_TEXT_STYLE: CSSProperties = {
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
};

/** ADR-0053 §6: "Fathom does not redact what you type, only what you
 * paste" — printed beside a typed note exactly as `EditorChange`'s own
 * `management_address` note already prints the parallel sentence for a
 * typed field, `MANAGEMENT_ADDRESS_NOTE` above. */
const NOTE_TYPED_SENTENCE = 'stored as typed — Fathom does not redact what you type, only what you paste';

function NoteRow({ note, onRemove }: { note: NoteView; onRemove?: () => { refused: string } | void }) {
  return (
    <div className="drawing-editor__field">
      <div style={NOTE_META_STYLE}>
        {note.who} · {new Date(note.when).toLocaleString()} · {note.how}
      </div>
      <div style={NOTE_TEXT_STYLE}>{noteTextSegments(note.text)}</div>
      {note.how === 'typed' ? <div style={TYPED_NOTE_STYLE}>{NOTE_TYPED_SENTENCE}</div> : null}
      {onRemove ? <SupplyAction label="remove" onCommit={onRemove} /> : null}
    </div>
  );
}

/**
 * The Notes section shared by a device, a port and a rack's own panel
 * (three call sites below). Reads `actions.notesOf` fresh on every render —
 * the same "no cache, ask the caller" contract every other `EditorActions`
 * member keeps — and writes through `actions.onAddNote`/`.onRemoveNote`.
 * Absent entirely when the caller supplies neither add nor read
 * (ADR-0052 §5's "no action, not a disabled one"); a reader still SEES the
 * notes list (`notesOf` is never gated the way `onAddNote`/`onRemoveNote`
 * are, `RacksPlace.tsx`/`InventoryPlace.tsx`'s own doc on why) but gets no
 * add box and no remove link.
 */
function NotesSection({ ownerId, actions }: { ownerId: string; actions: EditorActions }) {
  if (!actions.notesOf && !actions.onAddNote) return null;
  const notes = actions.notesOf ? actions.notesOf(ownerId) : [];

  return (
    <div className="drawing-editor__field">
      <div className="drawing-editor__field-label">Notes</div>
      {notes.length === 0 ? <div className="drawing-editor__field-value">{ABSENT}</div> : null}
      {notes.map((note) => (
        <NoteRow
          key={note.id}
          note={note}
          onRemove={actions.onRemoveNote ? () => actions.onRemoveNote!(note.id) : undefined}
        />
      ))}
      {actions.onAddNote ? <AddNoteForm ownerId={ownerId} onAddNote={actions.onAddNote} /> : null}
    </div>
  );
}

function AddNoteForm({
  ownerId,
  onAddNote,
}: {
  ownerId: string;
  onAddNote: (ownerId: string, opts: { text: string; how: NoteHow }) => Promise<{ refused: string } | void>;
}) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  // ADR-0053 §6 — "pasted note text goes through the gate": a real `onPaste`
  // on the textarea, not the button pressed, is what marks a draft as a
  // paste — CLAUDE.md rule 4, a credential is protected by never arriving,
  // and a wrong button must not be the one thing standing between a pasted
  // secret and the gate. Sticky once set: a paste anywhere in this draft's
  // life means the whole draft goes through the door, even if "add typed" is
  // the button someone then presses.
  const [hadPaste, setHadPaste] = useState(false);

  async function commit(button: NoteHow) {
    if (draft.trim().length === 0 || busy) return;
    const how: NoteHow = hadPaste ? 'pasted' : button;
    setBusy(true);
    const result = await onAddNote(ownerId, { text: draft, how });
    setBusy(false);
    if (result?.refused) {
      setRefusal(result.refused);
      return;
    }
    setRefusal(null);
    setDraft('');
    setHadPaste(false);
  }

  return (
    <div className="drawing-editor__field">
      <textarea
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onPaste={() => setHadPaste(true)}
        placeholder="add a note"
        rows={2}
        disabled={busy}
      />
      <div style={{ display: 'flex', gap: 'var(--s2)' }}>
        <button type="button" disabled={busy} onClick={() => void commit('typed')}>
          add typed
        </button>
        {/* ADR-0053 §6 — "pasted note text goes through the gate": this
            button confirms a paste that a real `onPaste` on the textarea
            above has already marked (`hadPaste`) — the button alone no
            longer decides which door the text goes through. */}
        <button type="button" disabled={busy} onClick={() => void commit('pasted')}>
          add pasted
        </button>
      </div>
      {refusal != null ? <div style={CAUTION_STYLE}>{refusal}</div> : null}
    </div>
  );
}

/**
 * The selected thing's fields, exactly as the shell's `editor` prop wants
 * them (`Shell.tsx`'s `editor: ReactNode | null`). The same function serves
 * the drawing's side panel and (per UI-SPEC "One editor") the inventory
 * page — this file draws the fields and raises `actions.onEdit`; it never
 * reads or writes a `Document` itself.
 */
export function EditorFor(
  selection: Selection | null,
  view: ClosetView,
  actions: EditorActions,
  catalogue: readonly PaletteItem[] = [],
): ReactNode {
  if (selection == null) return null;

  if (selection.kind === 'rack') {
    const rack = findRack(view, selection.id);
    if (rack == null) return null;
    const usedU = rack.chassis.reduce((sum, c) => sum + c.heightU, 0);
    return (
      <div className="drawing-editor__panel">
        <div className="drawing-editor__title">{rack.label}</div>
        <Field label="Height" value={`${rack.heightU}U`} />
        <Field label="Numbering" value={rack.unitNumbering} />
        <Field label="Used" value={`${usedU} of ${rack.heightU}U`} />
        <Field label="Devices" value={String(rack.chassis.length)} />
        <Field label="Shelves" value={String(rack.shelves.length)} />

        <div className="drawing-editor__field">
          <div className="drawing-editor__field-label">Row</div>
          <EditableValue
            value={rack.row ?? ''}
            placeholder={ABSENT}
            editorKind="text"
            onCommit={actions.onEdit ? (v) => actions.onEdit!({ kind: 'rack', id: rack.id, field: 'row', value: v }) : undefined}
          />
        </div>
        <TypedNote shown={(rack.row ?? '').length > 0} />

        <div className="drawing-editor__field">
          <div className="drawing-editor__field-label">Bay</div>
          <EditableValue
            value={rack.bay != null ? String(rack.bay) : ''}
            placeholder={ABSENT}
            editorKind="text"
            onCommit={actions.onEdit ? (v) => actions.onEdit!({ kind: 'rack', id: rack.id, field: 'bay', value: v }) : undefined}
          />
        </div>
        <TypedNote shown={rack.bay != null} />

        {/* ADR-0051 §1, brief item 3 — "a rack's editor gains '+ add a
            shelf'". */}
        <AddShelfControl rackId={rack.id} catalogue={catalogue} actions={actions} />

        {/* ADR-0053 §5 — a Rack is one of the three `Notable` kinds; the
            rack's own "no notes FIELD" (schema's own doc) stays true — this
            is a note reached through `HasNote`, a node, never a field
            `Rack` itself declares. */}
        <NotesSection ownerId={rack.id} actions={actions} />
      </div>
    );
  }

  // ADR-0051 §1, this session's brief items 1/4 — a shelf itself (as
  // opposed to one of its occupants, `'occupant'` below): its own name,
  // editable (item 1 — `PassiveNode.label` is schema card "1", so the plate
  // has something to show instead of the node id), and its occupants
  // listed by slot, each a link that selects the occupant (item 4).
  if (selection.kind === 'shelf') {
    const found = findShelf(view, selection.id);
    if (found == null) return null;
    const { rack, shelf } = found;
    return (
      <div className="drawing-editor__panel">
        <div className="drawing-editor__title">
          <EditableValue
            value={shelf.label}
            placeholder={ABSENT}
            editorKind="text"
            onCommit={actions.onEdit ? (v) => actions.onEdit!({ kind: 'shelf', id: shelf.id, field: 'label', value: v }) : undefined}
          />
        </div>
        <TypedNote shown={shelf.label.length > 0} />

        <Field label="Rack" value={`${rack.label} · U${shelf.positionU}`} />
        <Field label="Height" value={`${shelf.heightU}U`} />

        <div className="drawing-editor__field">
          <div className="drawing-editor__field-label">Occupants · by slot</div>
          {shelf.occupants.length === 0 ? (
            <div className="drawing-editor__field-value">{ABSENT}</div>
          ) : (
            shelf.occupants.map((occupant) => {
              const onSelectOccupant = actions.onSelect;
              return (
                <div key={occupant.id} className="drawing-editor__field" style={{ display: 'flex', gap: 'var(--s2)' }}>
                  <span style={{ color: 'var(--muted)' }}>{occupant.slot}</span>
                  <SelectLink
                    label={occupant.label || ABSENT}
                    onSelect={onSelectOccupant && (() => onSelectOccupant({ kind: 'occupant', id: occupant.id }))}
                  />
                </div>
              );
            })
          )}
        </div>
      </div>
    );
  }

  if (selection.kind === 'chassis') {
    const found = findChassis(view, selection.id);
    if (found == null) return null;
    const { rack, chassis } = found;
    const topU = chassis.positionU + chassis.heightU - 1;
    const uRange = chassis.heightU === 1 ? `U${chassis.positionU}` : `U${chassis.positionU}–U${topU}`;
    // `chassis.sketch` (`document/view.ts`) only reads `true` once at least
    // one port exists — right for the box on the plate (nothing to mark
    // "typed" with zero ports), wrong for the editor: a device
    // `createSketchDevice` (this session's brief item 2) just minted has NO
    // catalogue model and NO ports yet, and gating "+ add a port" on
    // `chassis.sketch` would hide the one control that could ever add its
    // first one. Computed locally instead, off `chassis.model` alone — the
    // same "no catalogue model" reading the fixture panel below already
    // derives locally for its own `sketch` for the identical reason.
    const chassisSketch = chassis.model === '';
    return (
      <div className="drawing-editor__panel">
        <div className="drawing-editor__title">
          <EditableValue
            value={chassis.hostname}
            placeholder={UNNAMED_HOSTNAME}
            placeholderClassName="drawing-editor__title--placeholder"
            editorKind="text"
            onCommit={
              actions.onEdit ? (v) => actions.onEdit!({ kind: 'device', id: chassis.deviceId, field: 'hostname', value: v }) : undefined
            }
          />
        </div>
        <TypedNote shown={chassis.hostname.length > 0} />

        <Field label="Model" value={chassis.model || ABSENT} />
        {/* ADR-0051 §1, brief item 2 — "a box with no catalogue entry draws
            from ports typed by hand and says so." */}
        {chassisSketch ? (
          <div style={TYPED_NOTE_STYLE}>
            <strong style={{ color: 'var(--ink)', fontWeight: 700 }}>No catalogue entry.</strong> Ports typed by
            hand.
          </div>
        ) : null}
        <Field label="Vendor" value={chassis.vendor || ABSENT} />
        <Field label="Rack" value={`${rack.label} · ${uRange}`} />
        <Field label="Face" value={chassis.face} />
        {/* PortView carries no cabled state yet — the count shown is honest
            about that rather than inventing a "0 of n". */}
        <Field label="Ports" value={`${ABSENT} of ${chassis.ports.length} cabled`} />

        <div className="drawing-editor__field">
          <div className="drawing-editor__field-label">Role</div>
          <EditableValue
            value={chassis.role ?? ''}
            placeholder={ABSENT}
            editorKind="select"
            options={DEVICE_ROLES}
            onCommit={
              actions.onEdit ? (v) => actions.onEdit!({ kind: 'device', id: chassis.deviceId, field: 'role', value: v }) : undefined
            }
          />
        </div>
        <TypedNote shown={(chassis.role ?? '').length > 0} />

        <div className="drawing-editor__field">
          <div className="drawing-editor__field-label">Mgmt address</div>
          <EditableValue
            value={chassis.managementAddress ?? ''}
            placeholder={ABSENT}
            editorKind="text"
            onCommit={
              actions.onEdit
                ? (v) => actions.onEdit!({ kind: 'device', id: chassis.deviceId, field: 'management_address', value: v })
                : undefined
            }
          />
        </div>
        <TypedNote shown={(chassis.managementAddress ?? '').length > 0} extra={MANAGEMENT_ADDRESS_NOTE} />

        <div className="drawing-editor__field">
          <div className="drawing-editor__field-label">Serial</div>
          <EditableValue
            value={chassis.serial ?? ''}
            placeholder={ABSENT}
            editorKind="text"
            onCommit={
              actions.onEdit ? (v) => actions.onEdit!({ kind: 'chassis', id: chassis.id, field: 'serial', value: v }) : undefined
            }
          />
        </div>
        <TypedNote shown={(chassis.serial ?? '').length > 0} />

        {chassis.psuInlets.length > 0 ? (
          <div className="drawing-editor__field">
            <div className="drawing-editor__field-label">Power</div>
            {chassis.psuInlets.map((inlet) => (
              <div key={inlet.id} className="drawing-editor__field">
                <div className="drawing-editor__field-label">{inlet.slot}</div>
                <div className="drawing-editor__field-value">
                  {!inlet.fitted ? (
                    <SupplyAction
                      label="fit"
                      onCommit={
                        actions.onEdit ? () => actions.onEdit!({ kind: 'supply-fit', chassisId: chassis.id, slot: inlet.slot }) : undefined
                      }
                    />
                  ) : inlet.hotSwap && inlet.supplyId != null ? (
                    <>
                      <EditableValue
                        value={inlet.serial ?? ''}
                        placeholder={ABSENT}
                        editorKind="text"
                        onCommit={
                          actions.onEdit
                            ? (v) => actions.onEdit!({ kind: 'supply', id: inlet.supplyId!, field: 'serial', value: v })
                            : undefined
                        }
                      />
                      <TypedNote shown={(inlet.serial ?? '').length > 0} />
                      <SupplyAction
                        label="remove"
                        onCommit={actions.onEdit ? () => actions.onEdit!({ kind: 'supply-remove', id: inlet.supplyId! }) : undefined}
                      />
                    </>
                  ) : (
                    'fitted'
                  )}
                </div>
              </div>
            ))}
            {chassis.singleFed ? <div style={CAUTION_STYLE}>Single-fed: only one supply is cabled.</div> : null}
            {chassis.oneFitted ? <div style={CAUTION_STYLE}>One fitted: a slot is empty.</div> : null}
          </div>
        ) : null}

        {/* ADR-0051 §1, brief item 2 — a sketch's own ports, typed by hand,
            each marked TYPED, with add/remove. A catalogued chassis keeps
            its read-only "Ports" count above, unchanged. */}
        {chassisSketch ? <SketchPortsSection chassisId={chassis.id} ports={chassis.ports} actions={actions} /> : null}

        {/* ADR-0051 §1, brief item 1 — "PLACED ON" as three choices, the
            current one marked. */}
        <PlacedOnControl itemId={chassis.id} placement={chassis.placement} view={view} actions={actions} />

        {/* ADR-0053 §5 — Device, not Chassis: the device has the page, the
            hostname and the capture, so its notes are `HasNote`'d off
            `chassis.deviceId`, not `chassis.id`. */}
        <NotesSection ownerId={chassis.deviceId} actions={actions} />
      </div>
    );
  }

  // ADR-0051 §1/§2, this session's brief item 3 — a shelf occupant, shown
  // with what `OccupantView` carries: its label, model or sketch mark, the
  // shelf/slot it sits on, and its ports (typed by hand or read off the
  // catalogue) — the same "typed by hand" add/remove `SketchPortsSection`
  // already gives a rack chassis, since an occupant's own id is the SAME
  // `Chassis` node id `addSketchPort`/`removeSketchPort` already take
  // (`commands.ts`'s own doc). `OccupantView` carries no separate
  // `psuInlets` of its own (`elevation.ts`'s file header on why) — a C14
  // inlet, typed or catalogued, is simply one more row of `occupant.ports`.
  if (selection.kind === 'occupant') {
    const found = findOccupant(view, selection.id);
    if (found == null) return null;
    const { rack, shelf, occupant } = found;
    const placement: Placement = { kind: 'shelf', shelfId: shelf.id, slot: occupant.slot };
    // `occupant.sketch` (`document/view.ts`), like `chassis.sketch` above,
    // only reads `true` once a port already exists — the SAME chicken-and-
    // egg fix (this session's brief item 2's own doc, on the chassis
    // branch above): a device dropped straight onto a shelf slot has no
    // ports yet, and would otherwise never see "+ add a port" at all.
    const occupantSketch = occupant.model == null;
    return (
      <div className="drawing-editor__panel">
        <div className="drawing-editor__title">{occupant.label || ABSENT}</div>
        <Field label="Kind" value={occupant.kind} />
        <Field label="Model" value={occupant.model ?? ABSENT} />
        {occupantSketch ? (
          <div style={TYPED_NOTE_STYLE}>
            <strong style={{ color: 'var(--ink)', fontWeight: 700 }}>No catalogue entry.</strong> Ports typed by
            hand.
          </div>
        ) : null}
        <Field label="Shelf" value={`${shelf.label || shelf.id} · ${rack.label}`} />
        <Field label="Slot" value={String(occupant.slot)} />
        <Field label="Ports" value={`${ABSENT} of ${occupant.ports.length} cabled`} />

        {occupant.kind === 'chassis' && occupantSketch ? (
          <SketchPortsSection chassisId={occupant.id} ports={occupant.ports} actions={actions} />
        ) : occupant.ports.length > 0 ? (
          <div className="drawing-editor__field">
            <div className="drawing-editor__field-label">Ports</div>
            {occupant.ports.map((port) => (
              <div key={port.id} className="drawing-editor__field" style={{ display: 'flex', gap: 'var(--s2)' }}>
                <span>{port.label || ABSENT}</span>
                <span style={{ color: 'var(--muted)' }}>{port.connector}</span>
              </div>
            ))}
          </div>
        ) : null}

        <PlacedOnControl itemId={occupant.id} placement={placement} view={view} actions={actions} />
      </div>
    );
  }

  // ADR-0051 §1/§2, this session's brief item 3 — a surface fixture (a
  // board included, since a board is itself a `FixtureView`), shown the same
  // way: label, model or sketch, its position on the surface, its ports and
  // its own `psuInlets` (a `FixtureView`, unlike `OccupantView`, carries
  // these separately — `document/view.ts`'s own contract, mirroring
  // `ChassisView`).
  if (selection.kind === 'fixture') {
    const found = findFixture(view, selection.id);
    if (found == null) return null;
    const { surface, parent, fixture } = found;
    const placement: Placement =
      parent == null
        ? { kind: 'surface', surfaceId: surface.id, xMm: fixture.xMm, yMm: fixture.yMm }
        : { kind: 'board', boardId: parent.id, xMm: fixture.xMm, yMm: fixture.yMm };
    const sketch = fixture.kind === 'chassis' && fixture.model == null;
    return (
      <div className="drawing-editor__panel">
        <div className="drawing-editor__title">{fixture.label || ABSENT}</div>
        <Field label="Kind" value={fixture.kind} />
        <Field label="Model" value={fixture.model ?? ABSENT} />
        {fixture.form ? <Field label="Form" value={fixture.form} /> : null}
        {sketch ? (
          <div style={TYPED_NOTE_STYLE}>
            <strong style={{ color: 'var(--ink)', fontWeight: 700 }}>No catalogue entry.</strong> Ports typed by
            hand.
          </div>
        ) : null}
        <Field label="Surface" value={surface.label || surface.id} />
        <Field
          label="Position"
          value={fixture.xMm != null && fixture.yMm != null ? `${fixture.xMm}mm, ${fixture.yMm}mm` : ABSENT}
        />
        <Field label="Ports" value={`${ABSENT} of ${fixture.ports.length} cabled`} />

        {fixture.kind === 'chassis' && sketch ? (
          <SketchPortsSection chassisId={fixture.id} ports={fixture.ports} actions={actions} />
        ) : fixture.ports.length > 0 ? (
          <div className="drawing-editor__field">
            <div className="drawing-editor__field-label">Ports</div>
            {fixture.ports.map((port) => (
              <div key={port.id} className="drawing-editor__field" style={{ display: 'flex', gap: 'var(--s2)' }}>
                <span>{port.label || ABSENT}</span>
                <span style={{ color: 'var(--muted)' }}>{port.connector}</span>
              </div>
            ))}
          </div>
        ) : null}

        {fixture.psuInlets.length > 0 ? (
          <div className="drawing-editor__field">
            <div className="drawing-editor__field-label">Power</div>
            {fixture.psuInlets.map((inlet) => (
              <div key={inlet.id} className="drawing-editor__field">
                <div className="drawing-editor__field-label">{inlet.slot}</div>
                <div className="drawing-editor__field-value">
                  {inlet.fitted ? (inlet.cable != null ? 'fed' : 'fitted') : 'not fitted'}
                </div>
              </div>
            ))}
          </div>
        ) : null}

        <PlacedOnControl itemId={fixture.id} placement={placement} view={view} actions={actions} />
      </div>
    );
  }

  // `selection.kind === 'port'` — `locatePort`, not a chassis-only lookup:
  // ADR-0051 §1/§2 widen where a port can be to a shelf occupant's own and a
  // surface fixture's, alongside a rack chassis's (`lookup.ts`'s own file
  // header on the one entry point this mirrors).
  const located = locatePort(view, selection.id);
  if (located == null) return null;
  const { port } = located;
  if (located.place === 'chassis') {
    const { rack, chassis } = located;
    return (
      <div className="drawing-editor__panel">
        <div className="drawing-editor__title">{port.label || ABSENT}</div>
        <Field label="Connector" value={port.connector} />
        <Field label="Uplink" value={port.uplink ? 'yes' : 'no'} />
        <Field label="Device" value={chassis.hostname || UNNAMED_HOSTNAME} />
        <Field label="Rack" value={rack.label} />
        <Field label="Cabled" value={ABSENT} />
        {/* ADR-0053 §5 — PhysicalPort is one of the three `Notable` kinds,
            wherever the port sits (a rack chassis, a shelf occupant or a
            surface fixture — `port.id` is the same `PhysicalPort` node id
            either way, `locatePort`'s own contract). */}
        <NotesSection ownerId={port.id} actions={actions} />
      </div>
    );
  }
  if (located.place === 'shelf') {
    const { rack, shelf, occupant } = located;
    return (
      <div className="drawing-editor__panel">
        <div className="drawing-editor__title">{port.label || ABSENT}</div>
        <Field label="Connector" value={port.connector} />
        <Field label="Uplink" value={port.uplink ? 'yes' : 'no'} />
        <Field label="Occupant" value={occupant.label || ABSENT} />
        <Field label="Shelf" value={`${shelf.label || shelf.id} · ${rack.label}`} />
        <Field label="Cabled" value={ABSENT} />
        <NotesSection ownerId={port.id} actions={actions} />
      </div>
    );
  }
  const { surface, fixture } = located;
  return (
    <div className="drawing-editor__panel">
      <div className="drawing-editor__title">{port.label || ABSENT}</div>
      <Field label="Connector" value={port.connector} />
      <Field label="Uplink" value={port.uplink ? 'yes' : 'no'} />
      <Field label="Fixture" value={fixture.label || ABSENT} />
      <Field label="Surface" value={surface.label || surface.id} />
      <Field label="Cabled" value={ABSENT} />
      <NotesSection ownerId={port.id} actions={actions} />
    </div>
  );
}
