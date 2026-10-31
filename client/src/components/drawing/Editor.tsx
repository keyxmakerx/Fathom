import { cloneElement, createContext, isValidElement, useContext, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';

import '../../styles/drawing.css';
// ADR-0053 §6 — "the black block reused from the drawer where a value was
// destroyed": `.config-drawer__block` (`config/config.css`) is imported
// here, read-only, rather than copied.
import '../config/config.css';
import { DEVICE_ROLES } from '../../document/edit';
import { PORT_CONNECTOR_VALUES, PORT_FACE_VALUES, PORT_SERVICE_VALUES, faceWords, type PortFace } from '../../document/compat';
import { expandPortPattern, previewLabels } from '../../document/portPattern';
// `OWNERSHIP_VALUES` (`Cable.ownership`'s own enum) — the same "mirrored
// once, never guessed" reasoning `DEVICE_ROLES` above already gives, for
// the cable panel.
import { OWNERSHIP_VALUES } from '../../document/cables';
import { SHEATH_VAR, needsHairlineOutline, sheathsFor } from './sheath';
// `FixtureView`/`Placement` are not in `contract.ts`'s own re-export list
// (frozen this session — that file's header: "the view re-exports stay"),
// but they are `document/view.ts`'s own read-side shapes, the same ones
// `ChassisView.placement` and `SurfaceView.fixtures` already carry
// structurally; named here so the "PLACED ON" control (ADR-0051 §1)
// can walk a board's nested fixtures and build the
// right `Placement` literal. Type-only, the same as `DEVICE_ROLES` above —
// this file still never reads or writes a `Document`.
import type { FixtureView, Placement, RackView } from '../../document/view';
import { FIELD_TYPES, FIELD_TYPE_LABEL, type FieldType } from '../../document/fields';
import { TagChips } from '../TagChips';
import { DocsSection } from '../docs/DocsSection';
import { DevicePhoto } from '../docs/DevicePhoto';
import { FirmwareChip, FirmwareSection } from '../firmware/FirmwareSection';
import { AboutSection } from '../learn/AboutSection';
import { TermixActions } from '../termix/TermixActions';
import { MenuItems } from './ContextMenu';
import { DEVICE_WORDS, type MenuItem } from './contextMenuItems';
import {
  ABSENT,
  UNNAMED_HOSTNAME,
  type CableView,
  type ChassisView,
  type ClosetView,
  type EditorActions,
  type EditorChange,
  type NoteHow,
  type NoteView,
  type PaletteItem,
  type PortView,
  type Selection,
} from './contract';
import { findChassis, findFixture, findOccupant, findRack, findShelf, findUnplacedChassis, locatePort } from './lookup';
import { connectorName, describePorts, faceplateLayoutFor } from './faceplate';
import { EmptyState } from '../ui/EmptyState';
import { DeviceSections } from './DeviceSections';
import { Fold } from './Fold';
import { CardsSection, OpticSection } from './Parts';
import { OpenFarSite, SiteLinkPicker, siteLinkOf } from './SiteLink';
import { LoginsTab, LoginsTabLabel } from '../vault/Screens';
import { cableEndText, farEndOf, moveToRackChange, moveToShelfChange, moveToSurfaceChange, addSketchPortChange, removeSketchPortChange, addSketchPortRangeChange, duplicateDeviceChange, createShelfChange, createSurfaceChange, setCableFieldChange, disconnectCableChange, oneEndCableChange, needsFinishingChange, removeDeviceChange, rackHeightBlocker, swapModelChange, swapSummary } from './editorChanges';
import { loadJsonPref, saveJsonPref } from '../../prefs';
export { cableEndText, farEndOf, moveToRackChange, moveToShelfChange, moveToSurfaceChange, addSketchPortChange, removeSketchPortChange, addSketchPortRangeChange, duplicateDeviceChange, createShelfChange, createSurfaceChange, setCableFieldChange, disconnectCableChange, oneEndCableChange, needsFinishingChange, removeDeviceChange, rackHeightBlocker, swapModelChange, swapSummary };

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

/** A whole number, edited in place; a refusal from the engine shows beside it. */
function NumberField({ label, value, onCommit }: { label: string; value: number; onCommit: ((n: number) => { refused: string } | void) | undefined }) {
  return (
    <div className="drawing-editor__field">
      <div className="drawing-editor__field-label">{label}</div>
      <EditableValue
        value={String(value)}
        placeholder={ABSENT}
        editorKind="text"
        onCommit={
          onCommit
            ? (v) => {
                const n = Number(v);
                if (v === null || !Number.isInteger(n) || n < 1) return { refused: 'Type a whole number, 1 or more.' };
                return onCommit(n);
              }
            : undefined
        }
      />
    </div>
  );
}

export function Field({ label, value }: { label: string; value: ReactNode }) {
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

export const TYPED_NOTE_STYLE: CSSProperties = {
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
export const CAUTION_STYLE: CSSProperties = {
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
export function EditableValue({ value, placeholder, placeholderClassName, editorKind, options, onCommit }: EditableValueProps) {
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
export function SupplyAction({
  label,
  onCommit,
  className,
}: {
  label: string;
  className?: string;
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
        className={className ?? (label.startsWith('Remove') ? 'btn-danger' : undefined)}
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

/** Round 15 (r15-qol), find by MAC: the hardware address seen on a port, in any spelling. */
function PortMacField({ port, actions }: { port: PortView; actions: EditorActions }) {
  return (
    <>
      <div className="drawing-editor__field">
        <div className="drawing-editor__field-label">MAC</div>
        <EditableValue
          value={port.mac ?? ''}
          placeholder={ABSENT}
          editorKind="text"
          onCommit={actions.onEdit ? (v) => actions.onEdit!({ kind: 'port', id: port.id, field: 'mac', value: v }) : undefined}
        />
      </div>
      <TypedNote shown={(port.mac ?? '').length > 0} />
    </>
  );
}

/** Round 15 (r15-qol): "Close gaps" slides everything up against the thing above it; "Copy
 * rack" makes R2 with the same devices, shelves and the cables between them. Each answers with
 * what it did. Close gaps shows only while there is a gap. */
function RackTidyControl({ rack, actions }: { rack: RackView; actions: EditorActions }) {
  const [said, setSaid] = useState<{ text: string; bad: boolean } | null>(null);
  const onEdit = actions.onEdit;
  if (!onEdit) return null;
  const items = [...rack.chassis, ...rack.shelves].sort((a, b) => b.positionU - a.positionU);
  const gaps = items.some((it, i) => i > 0 && items[i - 1]!.positionU > it.positionU + it.heightU);
  const run = (change: EditorChange) => {
    const r = onEdit(change);
    const text = r?.refused ?? null;
    setSaid(text === null ? null : { text, bad: !/^(Closed the gaps|No gaps|Copied to)/.test(text) });
  };
  return (
    <div className="drawing-editor__field">
      <div className="btn-group">
        {gaps ? (
          <button type="button" onClick={() => run({ kind: 'rack-close-gaps', rackId: rack.id })}>
            Close gaps
          </button>
        ) : null}
        <button type="button" onClick={() => run({ kind: 'rack-copy', rackId: rack.id })}>
          Copy rack
        </button>
      </div>
      {said ? (
        <div role={said.bad ? 'alert' : 'status'} style={said.bad ? CAUTION_STYLE : TYPED_NOTE_STYLE}>
          {said.text}
        </div>
      ) : null}
    </div>
  );
}

/** "Hide this cable" / "Show this cable" in the cable's own panel: a view
 * choice, never an edit — never gated on `actions.onEdit` the way
 * `SupplyAction` above is, so a read-only viewer can hide a cable too.
 * Absent only when the caller supplies neither half of the pair at all. */
function HideCableAction({ cable, actions }: { cable: CableView; actions: EditorActions }) {
  if (!actions.isCableHidden || !actions.onToggleCableHidden) return null;
  const hidden = actions.isCableHidden(cable.id);
  return (
    <div className="drawing-editor__hide-cable">
      <button type="button" onClick={() => actions.onToggleCableHidden!(cable.id)}>
        {hidden ? 'Show this cable' : 'Hide this cable'}
      </button>
      {!hidden && <span className="drawing-editor__hide-cable-note">in this browser only; nothing is deleted</span>}
    </div>
  );
}

/** ADR-0051 §1 — a shelf's own editor lists
 * its occupants by slot, each a link that selects the occupant
 * (`EditorActions.onSelect`, optional — nothing renders here if a caller
 * has not supplied one, the same graceful-absence `DrawingActions.onConnect`
 * already gives elsewhere). Plain underlined ink text, never a bordered
 * wash (`CAUTION_STYLE` is reserved for a refusal) — this is navigation,
 * not risk. */
const LINK_STYLE: CSSProperties = {
  background: 'none',
  border: 'none',
  boxShadow: 'none',
  padding: 0,
  margin: 0,
  color: 'var(--ink)',
  textDecoration: 'underline',
  cursor: 'pointer',
  font: 'inherit',
  // A name as typed: base.css capitalises a bare <button>.
  textTransform: 'none',
  letterSpacing: 'normal',
};

function SelectLink({ label, onSelect }: { label: string; onSelect?: () => void }) {
  if (!onSelect) return <span>{label}</span>;
  return (
    <button type="button" style={LINK_STYLE} onClick={onSelect}>
      {label}
    </button>
  );
}

// ===========================================================================
// A selected port's own panel: the device and
// port label (each of the three placement branches below already carries
// this), connector, service, face, its cable if any (this section) with the
// far end in words and the cable's sheath swatch, and two actions — Select
// cable and Go to far end. A port with no cable says so and, for a writer,
// offers Connect… instead.

/** "a port with no cable... offers Connect… which starts the same drag the
 * person could start by hand is not required — say 'drag from this port to
 * connect' instead." A click opens the hint; nothing here ever calls
 * React Flow — this file never touches the canvas (`contract.ts`'s own file
 * header: the drawing and the editor share a view, not a DOM). Absent
 * entirely for a reader (`canDraw` false — `EditorActions.onEdit == null`,
 * the same reading every other action on this panel already gives). */
function ConnectHint({ canDraw }: { canDraw: boolean }) {
  const [open, setOpen] = useState(false);
  if (!canDraw) return null;
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}>
        Connect…
      </button>
    );
  }
  return <div style={TYPED_NOTE_STYLE}>drag from this port to connect</div>;
}

/** A free port can start a cable whose far end is not there yet; it begins as Unknown. */
function OneEndCableButton({ portId, actions }: { portId: string; actions: EditorActions }) {
  return (
    <SupplyAction
      label="Add a cable, far end open"
      className="btn-quiet"
      onCommit={actions.onEdit ? () => actions.onEdit!(oneEndCableChange(portId)) : undefined}
    />
  );
}

/** The cable panel's Missing links controls: only on a cable with one end connected. Unknown is
 * the default; "Needs finishing" is a person's word that the open end is planned or unfinished
 * work, and puts it in the top bar's Missing links count. */
export function LooseEndField({ cable, actions }: { cable: CableView; actions: EditorActions }) {
  const [refusal, setRefusal] = useState<string | null>(null);
  if (cable.looseEnd !== true) return null;
  const needs = cable.needsFinishing === true;
  return (
    <div className="drawing-editor__field" data-testid="loose-end-field">
      <div className="drawing-editor__field-label">Far end</div>
      <div className="drawing-editor__field-value">{needs ? 'Needs finishing' : 'Unknown'}</div>
      {actions.onEdit ? (
        <button
          type="button"
          aria-pressed={needs}
          onClick={() => setRefusal(actions.onEdit!(needsFinishingChange(cable.id, !needs))?.refused ?? null)}
        >
          Needs finishing
        </button>
      ) : null}
      {refusal != null ? <div style={CAUTION_STYLE}>{refusal}</div> : null}
      <div style={TYPED_NOTE_STYLE}>One end is connected. Drag from a free port onto this cable's port to finish it.</div>
    </div>
  );
}

/** A selected port's own "Cable" field — shared by all three placements
 * below (a rack chassis's port, a shelf occupant's, a surface fixture's),
 * since `PortView.cable` and `farEndOf` read the same way regardless of
 * where the port itself sits. `actions.onSelect` (`EditorActions`, optional)
 * is what "Select cable"/"Go to far end" raise — a plain selection change,
 * the same shape the shelf's own occupant links already use; `Drawing.tsx`
 * is what turns a `'port'` selection into a camera pan to the faceplate
 * stop, "one camera," never a second one this file has to know about. */
function PortCableSection({ view, port, actions }: { view: ClosetView; port: PortView; actions: EditorActions }) {
  if (port.cable == null) {
    return (
      <div className="drawing-editor__field">
        <div className="drawing-editor__field-label">Cable</div>
        <div className="drawing-editor__field-value">Not cabled.</div>
        <ConnectHint canDraw={actions.onEdit != null} />
        <OneEndCableButton portId={port.id} actions={actions} />
        <SiteLinkPicker portId={port.id} actions={actions} />
      </div>
    );
  }
  const cable = port.cable;
  const cableObj = view.cables.find((c) => c.id === cable.cableId);
  const farEnd = farEndOf(view, cable.cableId, port.id);
  const farSite = siteLinkOf(farEnd);
  const onSelect = actions.onSelect;
  return (
    <div className="drawing-editor__field">
      <div className="drawing-editor__field-label">Cable</div>
      <div className="drawing-editor__field-value" style={{ display: 'flex', alignItems: 'center', gap: 'var(--s2)' }}>
        {cableObj?.sheath != null ? (
          <span
            className="drawing-picker__swatch"
            aria-hidden="true"
            style={{ display: 'inline-block', background: SHEATH_VAR[cableObj.sheath] }}
          />
        ) : null}
        <span>
          {farEnd
            ? cableEndText(view, farEnd)
            : cableObj?.looseEnd === true
              ? cableObj.needsFinishing === true
                ? 'No far end · needs finishing'
                : 'No far end · unknown'
              : ABSENT}
        </span>
      </div>
      {onSelect ? (
        <div style={{ display: 'flex', gap: 'var(--s2)', marginTop: 'var(--s1)' }}>
          <button type="button" onClick={() => onSelect({ kind: 'cable', id: cable.cableId })}>
            Select cable
          </button>
          {cable.farPortId != null ? (
            <button type="button" onClick={() => onSelect({ kind: 'port', id: cable.farPortId! })}>
              Go to far end
            </button>
          ) : null}
          {farSite != null && farEnd != null ? <OpenFarSite far={farSite} label={cableEndText(view, farEnd)} /> : null}
        </div>
      ) : farSite != null && farEnd != null ? (
        <OpenFarSite far={farSite} label={cableEndText(view, farEnd)} />
      ) : null}
    </div>
  );
}

/** The Inventory board's own mark (`design/proposals/screens/Inventory.dc.html`
 * — "Stored as typed."), shown once a field carries a value: every field
 * this editor writes is `Origin::Hand` (`document/edit.ts`'s `assertHand`),
 * so a present value here is always one a person typed. `extra`, used only
 * for `management_address`, is the board's own ADR-0041 sentence stated
 * once, muted. */
/** 'each' marks every field (the canvas panel); 'once' leaves it to the page, which says it once (Inventory). */
export const TypedNoteMode = createContext<'each' | 'once'>('each');

function TypedNote({ shown, extra }: { shown: boolean; extra?: string }) {
  const mode = useContext(TypedNoteMode);
  if (!shown || mode === 'once') return null;
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
// rack's "+ add a shelf". Each raises one
// `EditorChange` (`contract.ts`) through `EditorActions.onEdit`, the same
// `{ refused: string } | void` contract every existing action already uses
// — a refusal shows beside the control with `CAUTION_STYLE`, the same wash
// `EditableValue`/`SupplyAction` show theirs with. The literal-building part
// of each is pulled out as its own pure function (`moveToRackChange` and
// its siblings below) so the SHAPE of what gets raised is testable without
// rendering or simulating a click — this project's tests have no DOM
// environment to drive one (`Editor.render.test.ts`'s own header).

/** The sheath colour selector — UI-SPEC "Cables": "Colour is the real
 * sheath," and "a colour selector using the same
 * lists as the connect-time picker for that kind (power fixed to grey)
 * showing the current one marked and each swatch as the token's colour
 * with its name." `sheathsFor`/`SHEATH_VAR` (`./sheath.ts`) are the exact
 * pair `ColourPicker.tsx`'s own drop-time popover already reads — the same
 * lists, so a copper cable offers the same nine here it offered at connect
 * time, fibre the same four, power the one fixed grey. Reuses
 * `drawing.css`'s own `.drawing-picker__swatch(--selected)` rules
 * (`ColourPicker.tsx`'s own precedent) rather than a third copy of the same
 * 14px hairline-bordered box. ADR-0052 §5: no `onEdit` at all renders the
 * current sheath as plain text, the same "text, no action" reading every
 * other control on this panel gives a reader. */
function CableSheathField({ cable, onEdit }: { cable: CableView; onEdit: EditorActions['onEdit'] }) {
  const [refusal, setRefusal] = useState<string | null>(null);

  // The authoritative sheath moved under us (the write landed, or this is a
  // fresh cable selection entirely) — the same reset `EditableValue`'s own
  // effect gives a stale refusal.
  useEffect(() => {
    setRefusal(null);
  }, [cable.id, cable.sheath]);

  if (!onEdit) {
    return <Field label="Sheath" value={cable.sheath ?? ABSENT} />;
  }

  return (
    <div className="drawing-editor__field">
      <div className="drawing-editor__field-label">Sheath — the lead you actually used</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s2)' }}>
        {sheathsFor(cable.kind).map((sheath) => {
          const selected = sheath === cable.sheath;
          return (
            <button
              key={sheath}
              type="button"
              role="radio"
              aria-checked={selected}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--s2)',
                background: 'transparent',
                border: 'none',
                padding: 0,
                font: 'inherit',
                color: 'var(--ink)',
                cursor: 'pointer',
              }}
              onClick={() => {
                const result = onEdit(setCableFieldChange(cable.id, 'sheath', sheath));
                setRefusal(result?.refused ?? null);
              }}
            >
              <span
                className={selected ? 'drawing-picker__swatch drawing-picker__swatch--selected' : 'drawing-picker__swatch'}
                style={{ display: 'inline-block', background: SHEATH_VAR[sheath] }}
              />
              <span>{sheath}</span>
            </button>
          );
        })}
      </div>
      {refusal != null ? <div style={CAUTION_STYLE}>{refusal}</div> : null}
    </div>
  );
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

/** The first sizes offered for a rack (ADR-0060 decision 5); any other height is typed. */
const RACK_SIZES: readonly number[] = [42, 24, 12];

/** A rack's height (ADR-0060 decision 5): three common sizes, or a typed one. A reader sees the height only. */
function RackHeightControl({ rack, actions }: { rack: RackView; actions: EditorActions }) {
  const [custom, setCustom] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);

  useEffect(() => {
    setCustom('');
    setRefusal(null);
  }, [rack.id]);

  const onEdit = actions.onEdit;
  if (!onEdit) return <Field label="Height" value={`${rack.heightU}U`} />;
  const doEdit: (change: EditorChange) => { refused: string } | void = onEdit;

  function choose(heightU: number) {
    if (heightU === rack.heightU) return;
    const blocker = rackHeightBlocker(rack, heightU);
    if (blocker !== null) {
      setRefusal(blocker);
      return;
    }
    const result = doEdit({ kind: 'rack-height', id: rack.id, heightU });
    if (result?.refused) {
      setRefusal(result.refused);
      return;
    }
    setRefusal(null);
    setCustom('');
  }

  function chooseCustom() {
    const n = Number(custom);
    if (custom.trim() === '' || !Number.isInteger(n) || n < 1 || n > 255) {
      setRefusal('Type a whole number of units, 1 to 255.');
      return;
    }
    choose(n);
  }

  return (
    <div className="drawing-editor__field">
      <div className="drawing-editor__field-label">Height</div>
      <div className="btn-group">
        {RACK_SIZES.map((u) => (
          <button
            key={u}
            type="button"
            aria-pressed={u === rack.heightU}
            onClick={() => u !== rack.heightU && choose(u)}
          >
            {u}U
          </button>
        ))}
      </div>
      {RACK_SIZES.includes(rack.heightU) ? null : <Field label="Now" value={`${rack.heightU}U`} />}
      <div>
        <input
          aria-label="Custom height in units"
          placeholder="custom U"
          size={8}
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') chooseCustom();
          }}
        />
        <button type="button" onClick={chooseCustom}>
          set
        </button>
      </div>
      {refusal != null ? <div style={CAUTION_STYLE}>{refusal}</div> : null}
    </div>
  );
}

/** ADR-0051 §1 — "PLACED ON" as three choices,
 * the current one marked; choosing another asks for what that place needs
 * (a rack and a unit; a shelf and a slot; a surface or board, with no
 * position typed in: ADR-0060 decision 11) and
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
        {(placement.kind === 'surface' || placement.kind === 'board') && placement.xMm != null && placement.yMm != null ? (
          <Field label="Position" value={`${placement.xMm}mm, ${placement.yMm}mm`} />
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
    // No position is asked for (ADR-0060 decision 11): an unpositioned fixture
    // is laid out by the surface. Staying on the same surface keeps any position it had.
    const same =
      (placement.kind === 'surface' && placement.surfaceId === id) || (placement.kind === 'board' && placement.boardId === id);
    const x = same && (placement.kind === 'surface' || placement.kind === 'board') ? placement.xMm : null;
    const y = same && (placement.kind === 'surface' || placement.kind === 'board') ? placement.yMm : null;
    commit(moveToSurfaceChange(itemId, { id, kind }, x, y));
  }

  const CHOICES: ReadonlyArray<'rack' | 'shelf' | 'surface'> = ['rack', 'shelf', 'surface'];
  const currentKind: 'rack' | 'shelf' | 'surface' | null =
    placement.kind === 'rack' || placement.kind === 'shelf' ? placement.kind : placement.kind === 'surface' || placement.kind === 'board' ? 'surface' : null;

  return (
    <div className="drawing-editor__field">
      <div className="drawing-editor__field-label">Placed on</div>
      <div className="btn-group">
        {CHOICES.map((choice) => (
          <button
            key={choice}
            type="button"
            aria-pressed={choice === currentKind}
            onClick={() => choice !== currentKind && open(choice)}
          >
            {choice === 'rack' ? 'Rack' : choice === 'shelf' ? 'Shelf' : 'Surface'}
          </button>
        ))}
      </div>

      {placement.kind === 'none' ? <Field label="Placed" value={ABSENT} /> : null}
      {placement.kind === 'rack' ? <Field label="Unit" value={`U${placement.positionU}`} /> : null}
      {placement.kind === 'shelf' ? <Field label="Slot" value={String(placement.slot)} /> : null}
      {(placement.kind === 'surface' || placement.kind === 'board') && placement.xMm != null && placement.yMm != null ? (
        <Field label="Position" value={`${placement.xMm}mm, ${placement.yMm}mm`} />
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

/** ADR-0051 §1 — "+ add a port" on a sketch: label, connector
 * (the schema's own `PhysicalPort.connector` enum, `document/compat.ts`'s
 * `PORT_CONNECTOR_VALUES`), service (optional, blank means unset) and face.
 * Round 15, ports by pattern: the one name field also takes a pattern, so
 * `ge-0/0/{0-23}` is 24 ports typed once (`document/portPattern.ts`), with
 * the count and a preview shown as it is typed. One batch either way. */
function AddSketchPortForm({ chassisId, actions }: { chassisId: string; actions: EditorActions }) {
  const [open, setIsOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [connector, setConnector] = useState<string>(PORT_CONNECTOR_VALUES[0]);
  const [service, setService] = useState('');
  const [face, setFace] = useState<PortFace>('front');
  const [refusal, setRefusal] = useState<string | null>(null);
  const labelRef = useRef<HTMLInputElement>(null);
  const hintId = useId();

  // The command palette's "Add port" opens this form for the selected device.
  useEffect(() => {
    function onRequest(event: Event) {
      if ((event as CustomEvent<{ chassisId: string }>).detail.chassisId !== chassisId) return;
      window.dispatchEvent(new CustomEvent(SHOW_PANEL_TAB, { detail: { tab: 'ports' } }));
      setIsOpen(true);
      window.requestAnimationFrame(() => labelRef.current?.focus());
    }
    window.addEventListener(ADD_PORT_EVENT, onRequest);
    return () => window.removeEventListener(ADD_PORT_EVENT, onRequest);
  }, [chassisId]);

  const onEdit = actions.onEdit;
  // ADR-0052 §5: no `EditorActions.onEdit` — no add control at all, not
  // even the closed "+ add a port" button, the same "no actions" reading
  // `SupplyAction` gives a reader.
  if (!onEdit) return null;
  const doEdit: (change: EditorChange) => { refused: string } | void = onEdit;

  if (!open) {
    return (
      <button type="button" className="drawing-ports__add" onClick={() => setIsOpen(true)}>
        + Add a port
      </button>
    );
  }

  const pattern = label.includes('{') || label.includes('}') ? expandPortPattern(label) : null;
  const count = pattern?.ok ? pattern.labels.length : 1;

  function commit() {
    const expanded = expandPortPattern(label);
    if (!expanded.ok) {
      setRefusal(expanded.reason);
      return;
    }
    const svc = service.length > 0 ? service : null;
    const result = doEdit(
      expanded.labels.length === 1
        ? addSketchPortChange(chassisId, expanded.labels[0]!, connector, svc, face)
        : { kind: 'add-sketch-ports', chassisId, labels: expanded.labels, connector, service: svc, face },
    );
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
    <div className="drawing-ports__form">
      <label className="drawing-ports__cell drawing-ports__cell--wide">
        <span>Name, or a pattern</span>
        <input
          ref={labelRef}
          placeholder="eth0, or ge-0/0/{0-23}"
          value={label}
          aria-describedby={hintId}
          onChange={(e) => {
            setLabel(e.target.value);
            setRefusal(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
          }}
        />
      </label>
      <div id={hintId} className="drawing-ports__pattern" style={TYPED_NOTE_STYLE}>
        {pattern === null ? (
          'Braces make many at once: {0-23}, {01-24} or {wan,lan}.'
        ) : pattern.ok ? (
          <>
            <strong style={{ color: 'var(--ink)' }}>{pattern.labels.length} ports</strong> · {previewLabels(pattern.labels)}
          </>
        ) : (
          pattern.reason
        )}
      </div>
      <label className="drawing-ports__cell">
        <span>Connector</span>
        <select value={connector} onChange={(e) => setConnector(e.target.value)}>
          {PORT_CONNECTOR_VALUES.map((c) => (
            <option key={c} value={c}>
              {connectorName(c)}
            </option>
          ))}
        </select>
      </label>
      <label className="drawing-ports__cell">
        <span>Face</span>
        <select value={face} onChange={(e) => setFace(e.target.value as PortFace)}>
          {PORT_FACE_VALUES.map((f) => (
            <option key={f} value={f}>
              {faceWords(f).charAt(0).toUpperCase() + faceWords(f).slice(1)}
            </option>
          ))}
        </select>
      </label>
      <label className="drawing-ports__cell drawing-ports__cell--wide">
        <span>Service (optional)</span>
        <select value={service} onChange={(e) => setService(e.target.value)}>
          <option value="">{ABSENT}</option>
          {PORT_SERVICE_VALUES.map((sv) => (
            <option key={sv} value={sv}>
              {sv}
            </option>
          ))}
        </select>
      </label>
      <div className="drawing-ports__actions">
        <button type="button" className="drawing-ports__primary" onClick={commit}>
          {count === 1 ? 'Add port' : `Add ${count} ports`}
        </button>
        <button type="button" onClick={() => setIsOpen(false)}>
          Cancel
        </button>
      </div>
      {refusal != null ? <div style={CAUTION_STYLE}>{refusal}</div> : null}
    </div>
  );
}

/** The unit's ports in words, so the plate can stay clean: connector, count,
 * numbers, rows and where they sit. */
function PortsInWords({ chassis }: { chassis: ChassisView }) {
  const lines = useMemo(() => {
    const out: string[] = [];
    for (const face of PORT_FACE_VALUES) {
      const ports = chassis.ports.filter((p) => p.face === face);
      if (ports.length === 0) continue;
      out.push(...describePorts(ports, faceplateLayoutFor(ports, chassis.heightU, chassis.hostname)));
    }
    return out;
  }, [chassis.ports, chassis.heightU, chassis.hostname]);
  if (lines.length === 0) return null;
  return (
    <div className="drawing-editor__field">
      <div className="drawing-editor__field-label">Ports on this unit</div>
      <ul className="drawing-editor__ports-words">
        {lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
    </div>
  );
}

/** ADR-0051 §1 — a sketch's own ports, each marked TYPED
 * under a "typed by hand" heading with a remove action, plus "+ Add a port". A
 * chassis WITH a catalogue model shows its ports read-only "as today" (the
 * brief's own words) — this section is never rendered for one. */
function SketchPortsSection({ chassisId, ports, actions }: { chassisId: string; ports: PortView[]; actions: EditorActions }) {
  const [refusal, setRefusal] = useState<string | null>(null);
  return (
    <div className="drawing-editor__field">
      <div className="drawing-editor__field-label">
        Ports · typed by hand
      </div>
      {ports.length > 0 ? (
        <ul className="drawing-ports__list">
          {ports.map((port) => (
            <li key={port.id} className="drawing-ports__row">
              <span className="drawing-ports__label">{port.label || ABSENT}</span>
              <span className="drawing-ports__kind">
                {connectorName(port.connector)}
                {port.face !== 'front' ? ` · ${faceWords(port.face)}` : ''}
              </span>
              {actions.onEdit ? (
                <button
                  type="button"
                  className="drawing-ports__remove"
                  aria-label={`Remove port ${port.label}`}
                  title="Remove this port"
                  onClick={() => setRefusal(actions.onEdit!(removeSketchPortChange(chassisId, port.id))?.refused ?? null)}
                >
                  ×
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {refusal != null ? <div style={CAUTION_STYLE}>{refusal}</div> : null}
      <AddSketchPortForm chassisId={chassisId} actions={actions} />
    </div>
  );
}

/** A panel's tabs (UI-SPEC "Look"): every tab's body stays in the page,
 * the others hidden, so a tab never loses what was typed in it. */
type PanelTab = { id: string; label: ReactNode; body: ReactNode };

/** 'flat' where the page around the panel already has tabs of its own (Inventory's item page). */
export const PanelTabsMode = createContext<'tabs' | 'flat'>('tabs');

/** Brings a details-panel tab forward: `detail.tab` is its id ("ports", "details"). */
export const SHOW_PANEL_TAB = 'fathom:panel-tab';

/** Sign-off r58: a device menu's "Swap model…" opens the panel's own form; `detail.chassisId` names the device. */
export const SWAP_MODEL_EVENT = 'fathom:swap-model';
/** A device menu's "Add a port" opens the Ports tab's form. */
export const ADD_PORT_EVENT = 'fathom:add-port';
/** A device menu's "Open in Termix" unfolds Management and puts the person on its Termix button. The
 * button itself opens Termix: a window opened later than the click would be blocked as a pop-up. */
export const SHOW_TERMIX_EVENT = 'fathom:show-termix';

/** Asks the panel for `chassisId` to do `event` once it is open (a click selects it first). */
export function askPanel(event: string, chassisId: string): void {
  window.setTimeout(() => window.dispatchEvent(new CustomEvent(event, { detail: { chassisId } })), 80);
}

/** Inside the Management fold: on "Open in Termix" from a menu, unfolds it and focuses the Termix button. */
function TermixReveal({ chassisId }: { chassisId: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const onShow = (event: Event) => {
      if ((event as CustomEvent<{ chassisId: string }>).detail.chassisId !== chassisId) return;
      window.dispatchEvent(new CustomEvent(SHOW_PANEL_TAB, { detail: { tab: 'details' } }));
      window.requestAnimationFrame(() => {
        const fold = ref.current?.closest('details');
        if (fold) fold.open = true;
        const button = fold?.querySelector<HTMLButtonElement>('[data-testid="termix-actions"] button');
        button?.scrollIntoView({ block: 'nearest' });
        button?.focus();
      });
    };
    window.addEventListener(SHOW_TERMIX_EVENT, onShow);
    return () => window.removeEventListener(SHOW_TERMIX_EVENT, onShow);
  }, [chassisId]);
  return <span ref={ref} hidden />;
}

/** The tab last opened, so the next device opens on the same one; kept in this browser, so the panel
 * reopens on it too (sign-off r60). */
const PANEL_TAB_KEY = 'fathom.panel-tab';
let lastTab: string | null = loadJsonPref(PANEL_TAB_KEY, (raw) => (typeof raw === 'string' ? raw : null), null);

function PanelTabs({ tabs, initial }: { tabs: readonly PanelTab[]; initial?: string }) {
  const mode = useContext(PanelTabsMode);
  const [picked, setPickedState] = useState(initial ?? lastTab ?? tabs[0].id);
  const setPicked = (id: string) => {
    lastTab = id;
    saveJsonPref(PANEL_TAB_KEY, id);
    setPickedState(id);
  };
  const base = useId();
  // A command that opens a form on one tab ("Fit a card", "Add a port") brings that tab forward first.
  useEffect(() => {
    const onShow = (event: Event) => {
      const id = (event as CustomEvent<{ tab: string }>).detail.tab;
      if (tabs.some((t) => t.id === id)) setPicked(id);
    };
    window.addEventListener(SHOW_PANEL_TAB, onShow);
    return () => window.removeEventListener(SHOW_PANEL_TAB, onShow);
  });
  if (mode === 'flat') return <>{tabs.map((tab) => <div key={tab.id} className="drawing-tabs__panel">{tab.body}</div>)}</>;
  const current = tabs.some((t) => t.id === picked) ? picked : tabs[0].id;

  function onKey(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = tabs[(index + step + tabs.length) % tabs.length];
    setPicked(next.id);
    document.getElementById(`${base}-${next.id}`)?.focus();
  }

  return (
    <>
      <div className="drawing-tabs" role="tablist">
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`${base}-${tab.id}`}
            className="drawing-tabs__tab"
            aria-selected={tab.id === current}
            aria-controls={`${base}-${tab.id}-panel`}
            tabIndex={tab.id === current ? 0 : -1}
            onClick={() => setPicked(tab.id)}
            onKeyDown={(e) => onKey(e, index)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tabpanel"
          id={`${base}-${tab.id}-panel`}
          aria-labelledby={`${base}-${tab.id}`}
          className="drawing-tabs__panel"
          hidden={tab.id !== current}
        >
          {tab.body}
        </div>
      ))}
    </>
  );
}

/** r31 pictures: the panel's faceplate, bigger than the one on the rack. Front ports in their rows, each filled with
 * the sheath of the cable in it; an empty port is drawn open. */
function PanelFaceplate({ chassis, view }: { chassis: ChassisView; view: ClosetView }) {
  const ports = chassis.ports.filter((p) => p.face === 'front');
  if (ports.length === 0) return null;
  const rows = [...new Set(ports.map((p) => p.row))].sort((a, b) => a - b);
  const boxes: { port: PortView; x: number; y: number; w: number }[] = [];
  let width = 0;
  rows.forEach((row, r) => {
    let x = 0;
    for (const port of ports.filter((p) => p.row === row).sort((a, b) => a.column - b.column)) {
      if (port.gapBefore && x > 0) x += 6;
      const w = /^(sfp|qsfp)/i.test(port.connector) ? 22 : 17;
      boxes.push({ port, x, y: r * 20 + 1, w });
      x += w + 4;
    }
    width = Math.max(width, x - 4);
  });
  const height = rows.length * 20 - 4;
  const sheathOf = (port: PortView) => {
    const cable = port.cable != null ? view.cables.find((c) => c.id === port.cable!.cableId) : undefined;
    return cable?.sheath != null ? SHEATH_VAR[cable.sheath] : port.cable != null ? 'var(--muted)' : null;
  };
  const cabled = ports.filter((p) => p.cable != null).length;
  return (
    <div className="dev-panel__face" data-testid="device-face">
      <svg width="100%" viewBox={`-1 -1 ${width + 2} ${height + 3}`} style={{ maxWidth: width + 2, maxHeight: 64 }} role="img" aria-label={`${cabled} of ${ports.length} front ports cabled`}>
        {boxes.map(({ port, x, y, w }) => {
          const fill = sheathOf(port);
          return (
            <rect key={port.id} x={x} y={y} width={w} height={14} rx={1} fill={fill ?? 'var(--page)'} stroke="var(--control-line-hover)" strokeWidth={1}>
              <title>{`${port.label || ABSENT} · ${connectorName(port.connector)}${port.cable != null ? ' · cabled' : ''}`}</title>
            </rect>
          );
        })}
      </svg>
      <div className="dev-panel__facecap">
        <span>
          <b>{cabled}</b> of {ports.length} ports cabled
        </span>
      </div>
    </div>
  );
}

/** "24 × RJ45, 2 × SFP": what the device carries, in counts per connector. */
function connectorCounts(ports: readonly PortView[]): string {
  const counts = new Map<string, number>();
  for (const p of ports) counts.set(connectorName(p.connector), (counts.get(connectorName(p.connector)) ?? 0) + 1);
  return [...counts].map(([name, n]) => `${n} × ${name}`).join(', ');
}

/** r31 pictures: each cabled port, a short line in its cable's colour, and where the other end goes. The far device
 * selects. */
function ConnectionsSection({ chassis, view, actions }: { chassis: ChassisView; view: ClosetView; actions: EditorActions }) {
  const cabled = chassis.ports.filter((p) => p.cable != null).sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
  if (cabled.length === 0) return null;
  return (
    <div className="dev-panel__sec" data-testid="device-connections">
      <div className="dev-panel__h">Connections · {cabled.length}</div>
      <ul className="dev-conn">
        {cabled.map((port) => {
          const end = port.cable!;
          const cable = view.cables.find((c) => c.id === end.cableId);
          const located = end.farPortId != null ? locatePort(view, end.farPortId) : undefined;
          const far =
            located == null ? null : located.place === 'chassis' ? located.chassis.hostname || UNNAMED_HOSTNAME : located.place === 'shelf' ? located.occupant.label || ABSENT : located.fixture.label || ABSENT;
          // Not on this drawing: the outside label, or nothing yet on a cable left open.
          const otherEnd = far == null && cable != null ? farEndOf(view, cable.id, port.id) : undefined;
          const farText = far ?? (otherEnd != null ? cableEndText(view, otherEnd) : 'not connected yet');
          const farChassis = end.farChassisId;
          const onSelect = actions.onSelect;
          return (
            <li key={port.id}>
              <span className="dev-conn__p">{port.label || ABSENT}</span>
              <span
                className="dev-conn__ln"
                style={{
                  background: cable?.sheath != null ? SHEATH_VAR[cable.sheath] : 'var(--control-line-hover)',
                  boxShadow: cable?.sheath != null && needsHairlineOutline(cable.sheath) ? 'inset 0 0 0 1px var(--control-line-hover)' : undefined,
                }}
              />
              <span className="dev-conn__far">
                {farChassis != null && far != null && onSelect ? (
                  <button type="button" className="dev-conn__go" onClick={() => onSelect({ kind: 'chassis', id: farChassis })}>
                    {far}
                  </button>
                ) : (
                  <b>{farText}</b>
                )}
                {located != null ? ` · ${located.port.label || ABSENT}` : null}
              </span>
              <span className="dev-conn__vl">{port.uplink ? 'uplink' : cable?.label ?? ''}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** ADR-0051 §1 — "Duplicate": `commands.ts`'s `duplicateDevice`, shown only
 * on a rack-mounted chassis's panel. May carry a NOTICE, not a refusal
 * (`contract.ts`'s `EditorActions.onEdit`). */
function DuplicateDeviceControl({ chassisId, actions }: { chassisId: string; actions: EditorActions }) {
  const [notice, setNotice] = useState<string | null>(null);
  const onEdit = actions.onEdit;
  if (!onEdit) return null;

  function commit() {
    const result = onEdit!(duplicateDeviceChange(chassisId));
    setNotice(result?.refused ?? null);
  }

  return (
    <div className="drawing-editor__field">
      <button type="button" className="btn-main" onClick={commit}>
        {DEVICE_WORDS.duplicate}
      </button>
      {notice != null ? <div style={CAUTION_STYLE}>{notice}</div> : null}
    </div>
  );
}

/** Sign-off r28-swap — "Swap model…": pick a catalogue model, see what carries over, confirm. */
function SwapModelControl({ chassisId, current, catalogue, actions }: { chassisId: string; current: string; catalogue: readonly PaletteItem[]; actions: EditorActions }) {
  const [open, setIsOpen] = useState(false);
  const [modelKey, setModelKey] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  const formRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onAsk = (event: Event) => {
      if ((event as CustomEvent<{ chassisId: string }>).detail.chassisId !== chassisId) return;
      window.dispatchEvent(new CustomEvent(SHOW_PANEL_TAB, { detail: { tab: 'details' } }));
      setIsOpen(true);
      window.requestAnimationFrame(() => {
        formRef.current?.scrollIntoView({ block: 'nearest' });
        formRef.current?.querySelector('select')?.focus();
      });
    };
    window.addEventListener(SWAP_MODEL_EVENT, onAsk);
    return () => window.removeEventListener(SWAP_MODEL_EVENT, onAsk);
  }, [chassisId]);
  const onEdit = actions.onEdit;
  if (!onEdit) return null;
  const choices = catalogue.filter((item) => item.model !== current);
  if (choices.length === 0) return null;

  if (!open) {
    return (
      <button type="button" className="btn-quiet" onClick={() => setIsOpen(true)}>
        {current ? DEVICE_WORDS.swapModel : DEVICE_WORDS.giveModel}
      </button>
    );
  }

  const [vendor, ...rest] = modelKey.split('|');
  const picked = modelKey !== '' ? { vendor: vendor!, model: rest.join('|') } : null;
  const plan = picked ? actions.previewSwap?.(chassisId, picked) ?? null : null;

  function close() {
    setIsOpen(false);
    setModelKey('');
    setRefusal(null);
  }

  function commit() {
    if (!picked) return;
    const result = onEdit!(swapModelChange(chassisId, picked));
    if (result?.refused) {
      setRefusal(result.refused);
      return;
    }
    close();
  }

  return (
    <div className="drawing-editor__field" ref={formRef}>
      <select aria-label="New model" value={modelKey} onChange={(e) => { setModelKey(e.target.value); setRefusal(null); }}>
        <option value="">pick the new model</option>
        {choices.map((item) => (
          <option key={`${item.vendor}/${item.model}`} value={`${item.vendor}|${item.model}`}>
            {item.vendor} {item.model} ({item.rackUnits}U)
          </option>
        ))}
      </select>
      {plan ? (
        <ul className="drawing-editor__swap-plan">
          {swapSummary(plan).map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      <button type="button" className="btn-main" disabled={!picked} onClick={commit}>
        Swap
      </button>
      <button type="button" onClick={close}>
        cancel
      </button>
      {refusal != null ? <div style={CAUTION_STYLE}>{refusal}</div> : null}
    </div>
  );
}

/** ADR-0051 §1 — a rack's own "+ add a shelf": a unit and an
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
    // `PassiveNode.label` is schema card "1" — required
    // (`commands.ts`'s `CreateShelfOptions.label`'s own doc):
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
// ADR-0053 §5/§6 — Notes, on a device, a port
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
export function NotesSection({ ownerId, actions }: { ownerId: string; actions: EditorActions }) {
  if (!actions.notesOf && !actions.onAddNote) return null;
  const notes = actions.notesOf ? actions.notesOf(ownerId) : [];

  return (
    <div className="drawing-editor__field drawing-editor__field--notes">
      <div className="drawing-editor__field-label">Notes</div>
      {notes.length === 0 ? (
        <div className="drawing-editor__field-value drawing-editor__empty-next">
          {actions.onAddNote ? 'No notes yet. Type one, or paste one in.' : 'No notes yet.'}
        </div>
      ) : null}
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

/**
 * ADR-0059 — the Tags section shared by the
 * device, port, cable and rack panels (four call sites below), `NotesSection`'s
 * own shape: absent entirely when the caller supplies neither `tagsOf` nor
 * `onAddTag` (ADR-0052 §5's "no action, not a disabled one"); a reader still
 * sees the chips (`tagsOf` is never gated the way `onAddTag`/`onRemoveTag`
 * are) but gets no input and no remove control (`TagChips`'s own reading).
 */
export function TagsSection({ ownerId, actions }: { ownerId: string; actions: EditorActions }) {
  if (!actions.tagsOf && !actions.onAddTag) return null;
  const tags = actions.tagsOf ? actions.tagsOf(ownerId) : [];
  const suggestions = actions.allTags ? actions.allTags() : [];

  return (
    <div className="drawing-editor__field">
      <div className="drawing-editor__field-label">Tags</div>
      <TagChips
        key={ownerId}
        tags={tags.map((t) => ({ id: t.tagId, name: t.name }))}
        suggestions={suggestions}
        onAdd={actions.onAddTag ? (name) => actions.onAddTag!(ownerId, name) : undefined}
        onRemove={actions.onRemoveTag ? (tagId) => actions.onRemoveTag!(ownerId, tagId) : undefined}
        onRename={actions.onRenameTag}
      />
    </div>
  );
}

/**
 * ADR-0062 — "Your fields": the custom fields defined for this kind of thing, shared with
 * everyone who opens the design. Absent when the caller supplies no `fieldsOf`.
 */
export function FieldsSection({ ownerId, actions }: { ownerId: string; actions: EditorActions }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState<FieldType>('text');
  const [choicesText, setChoicesText] = useState('');
  const [refusal, setRefusal] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  if (!actions.fieldsOf) return null;
  const rows = actions.fieldsOf(ownerId);
  if (rows == null) return null;
  const writable = actions.onSetField != null;

  const submit = async () => {
    const result = await actions.onAddFieldDef?.(ownerId, name, type, type === 'choice' ? choicesText.split(',').map((c) => c.trim()).filter(Boolean) : undefined);
    if (result && 'refused' in result) {
      setRefusal(result.refused);
      return;
    }
    setName('');
    setChoicesText('');
    setRefusal(null);
    setAdding(false);
  };

  return (
    <>
      <div className="drawing-editor__group">Your fields</div>
      {rows.length === 0 ? (
        <EmptyState
          title="No fields yet."
          compact
          action={actions.onAddFieldDef && !adding ? { label: 'Add a field', onClick: () => setAdding(true) } : undefined}
        >
          Fields are your own details for this thing, like a warranty date.
        </EmptyState>
      ) : null}
      {rows.map(({ def, value, removed }) => (
        <div key={def.id} className="drawing-editor__field" style={removed ? { color: 'var(--muted)' } : undefined}>
          <div className="drawing-editor__field-label">
            {def.name}
            {removed ? ' (removed field)' : null}
            {actions.onRemoveFieldDef && !removed ? (
              removing === def.id ? (
                <span style={{ marginLeft: 'var(--s2)' }}>
                  Remove for the organisation?{' '}
                  <button
                    type="button"
                    onClick={async () => {
                      const r = await actions.onRemoveFieldDef!(def.id);
                      setRemoving(null);
                      if (r && 'refused' in r) setRefusal(r.refused);
                    }}
                  >
                    Remove
                  </button>{' '}
                  <button type="button" onClick={() => setRemoving(null)}>
                    Keep
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  aria-label={`Remove the field ${def.name}`}
                  style={{ marginLeft: 'var(--s2)', border: 'none', background: 'none', color: 'var(--muted)', padding: 0 }}
                  onClick={() => setRemoving(def.id)}
                >
                  ×
                </button>
              )
            ) : null}
          </div>
          <EditableValue
            value={value ?? ''}
            placeholder={def.type === 'date' ? 'YYYY-MM-DD' : ABSENT}
            editorKind={def.type === 'choice' ? 'select' : 'text'}
            options={def.type === 'choice' ? def.choices : undefined}
            onCommit={writable && !removed ? (raw) => actions.onSetField!(ownerId, def.id, raw ?? '') : undefined}
          />
        </div>
      ))}
      {actions.onAddFieldDef ? (
        adding ? (
          <div className="drawing-editor__field">
            <div className="drawing-editor__field-label">New field</div>
            <div style={{ display: 'flex', gap: 'var(--s1)', flexWrap: 'wrap' }}>
              <input
                aria-label="Field name"
                value={name}
                placeholder="Warranty ends"
                onChange={(e) => setName(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void submit();
                  if (e.key === 'Escape') setAdding(false);
                }}
              />
              <select aria-label="Field type" value={type} onChange={(e) => setType(e.currentTarget.value as FieldType)}>
                {FIELD_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {FIELD_TYPE_LABEL[t]}
                  </option>
                ))}
              </select>
              {type === 'choice' ? (
                <input aria-label="Choices" value={choicesText} placeholder="Choices, comma separated" onChange={(e) => setChoicesText(e.currentTarget.value)} />
              ) : null}
              <button type="button" onClick={() => void submit()}>
                Add field
              </button>
            </div>
            <div style={TYPED_NOTE_STYLE}>Every one of this kind gets the field, in every design of the organisation.</div>
            {refusal ? <div style={CAUTION_STYLE}>{refusal}</div> : null}
          </div>
        ) : rows.length > 0 ? (
          // With no fields yet, the empty state above carries the button.
          <button type="button" onClick={() => setAdding(true)}>
            + Add a field
          </button>
        ) : null
      ) : null}
    </>
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
        onDrop={() => setHadPaste(true)}
        data-gate="self"
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
/** The ids a panel holds fields of: its own, its device's and its power supplies'. Live notices match on these. */
function elementsOf(selection: Selection, view: ClosetView): string {
  const ids = [selection.id];
  if (selection.kind === 'chassis') {
    const chassis = findChassis(view, selection.id)?.chassis ?? findUnplacedChassis(view, selection.id);
    if (chassis != null) {
      ids.push(chassis.deviceId);
      for (const inlet of chassis.psuInlets) if (inlet.supplyId != null) ids.push(inlet.supplyId);
    }
  }
  return ids.join(' ');
}

/** A pick from the ⋯ list shuts it; a greyed item leaves it open, its reason showing. */
function closeMoreOnPick(event: { target: EventTarget; currentTarget: HTMLElement }) {
  const item = (event.target as Element).closest?.('button');
  if (item != null && item.getAttribute('aria-disabled') !== 'true') event.currentTarget.closest('details')?.removeAttribute('open');
}

export function EditorFor(
  selection: Selection | null,
  view: ClosetView,
  actions: EditorActions,
  catalogue: readonly PaletteItem[] = [],
  /** The device panel's foot: the caller's main ways on (Open inside, Trace from here). */
  links?: ReactNode,
  /** Rows the caller adds to the device panel's ⋯ menu, above Duplicate and Remove; or, as a list, the whole
   * menu (sign-off r58: the same list as right-click), which then carries its own Duplicate and Remove. */
  more?: ReactNode | readonly MenuItem[],
  /** Sign-off r60: what the caller shows at the end of the device panel, above its foot ("Also in", issues). */
  tail?: ReactNode,
): ReactNode {
  const panel = panelFor(selection, view, actions, catalogue, links, more, tail);
  if (selection == null || !isValidElement<{ 'data-elements'?: string }>(panel)) return panel;
  return cloneElement(panel, { 'data-elements': elementsOf(selection, view) });
}

function panelFor(
  selection: Selection | null,
  view: ClosetView,
  actions: EditorActions,
  catalogue: readonly PaletteItem[] = [],
  links?: ReactNode,
  more?: ReactNode | readonly MenuItem[],
  tail?: ReactNode,
): ReactNode {
  if (selection == null) return null;

  if (selection.kind === 'rack') {
    const rack = findRack(view, selection.id);
    if (rack == null) return null;
    const usedU = rack.chassis.reduce((sum, c) => sum + c.heightU, 0);
    return (
      <div className="drawing-editor__panel">
        <div className="drawing-editor__title">{rack.label}</div>
        <RackHeightControl rack={rack} actions={actions} />
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

        {/* ADR-0051 §1 — "a rack's editor gains '+ add a
            shelf'". */}
        <AddShelfControl rackId={rack.id} catalogue={catalogue} actions={actions} />
        <RackTidyControl rack={rack} actions={actions} />

        {/* ADR-0053 §5 — a Rack is one of the three `Notable` kinds; the
            rack's own "no notes FIELD" (schema's own doc) stays true — this
            is a note reached through `HasNote`, a node, never a field
            `Rack` itself declares. */}
        <FieldsSection ownerId={rack.id} actions={actions} />
        <NotesSection ownerId={rack.id} actions={actions} />
        <TagsSection ownerId={rack.id} actions={actions} />
        <DocsSection ownerId={rack.id} />
      </div>
    );
  }

  // ADR-0060 step 7: a text label or area, and a line between two boxes.
  if (selection.kind === 'label') {
    const label = view.labels.find((l) => l.id === selection.id);
    if (label == null) return null;
    const area = label.form === 'area';
    return (
      <div className="drawing-editor__panel">
        <div className="drawing-editor__title">{area ? 'Area' : label.form === 'note' ? 'Note' : 'Label'}</div>
        <div className="drawing-editor__field">
          <div className="drawing-editor__field-label">Text</div>
          <EditableValue
            value={label.text}
            placeholder={ABSENT}
            editorKind="text"
            onCommit={actions.onEdit ? (v) => actions.onEdit!({ kind: 'label', id: label.id, field: 'text', value: v ?? '' }) : undefined}
          />
        </div>
        {area && (
          <>
            <NumberField label="Width" value={Math.round(label.w)} onCommit={actions.onEdit ? (n) => actions.onEdit!({ kind: 'area-size', id: label.id, w: n, h: label.h }) : undefined} />
            <NumberField label="Height" value={Math.round(label.h)} onCommit={actions.onEdit ? (n) => actions.onEdit!({ kind: 'area-size', id: label.id, w: label.w, h: n }) : undefined} />
          </>
        )}
        <SupplyAction label={area ? 'Remove area' : label.form === 'note' ? 'Remove note' : 'Remove label'}onCommit={actions.onEdit ? () => actions.onEdit!({ kind: 'free-remove', id: label.id }) : undefined} />
      </div>
    );
  }

  if (selection.kind === 'line') {
    const line = view.lines.find((l) => l.id === selection.id);
    if (line == null) return null;
    const name = (id: string): string => view.free.find((f) => f.id === id)?.hostname || UNNAMED_HOSTNAME;
    return (
      <div className="drawing-editor__panel">
        <div className="drawing-editor__title">Line</div>
        <Field label="Joins" value={`${name(line.aId)} and ${name(line.bId)}`} />
        <div className="drawing-editor__field">
          <div className="drawing-editor__field-label">Label</div>
          <EditableValue
            value={line.label ?? ''}
            placeholder={ABSENT}
            editorKind="text"
            onCommit={actions.onEdit ? (v) => actions.onEdit!({ kind: 'line', id: line.id, field: 'label', value: v }) : undefined}
          />
        </div>
        <SupplyAction label="Remove line" onCommit={actions.onEdit ? () => actions.onEdit!({ kind: 'free-remove', id: line.id }) : undefined} />
      </div>
    );
  }

  // ADR-0051 §1 — a shelf itself (as opposed to one of its occupants,
  // `'occupant'` below): its own name, editable (`PassiveNode.label` is
  // schema card "1", so the plate has something to show instead of the
  // node id), and its occupants listed by slot, each a link that selects
  // the occupant.
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
        <NumberField label="Height (U)" value={shelf.heightU} onCommit={actions.onEdit ? (n) => actions.onEdit!({ kind: 'shelf-size', id: shelf.id, heightU: n }) : undefined} />
        <NumberField
          label="Slots"
          value={shelf.slots ?? Math.max(0, ...shelf.occupants.map((o) => o.slot))}
          onCommit={actions.onEdit ? (n) => actions.onEdit!({ kind: 'shelf-size', id: shelf.id, slots: n }) : undefined}
        />

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
        {actions.onOpenShelf ? (
          <div className="drawing-editor__footer dev-panel__foot">
            <button type="button" className="btn-main" onClick={() => actions.onOpenShelf!(shelf.id)} data-testid="shelf-open">
              Open shelf
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  if (selection.kind === 'chassis') {
    // A `Chassis` with no live `MountedIn`/`SitsOn`/`FixedTo` at all
    // (`ClosetView.unplaced`, `document/view.ts`) — Inventory's "Unplaced"
    // group opens the SAME chassis panel, `rack` simply `undefined` and
    // every rack-only field below gated on it, rather than nothing at all.
    const found = findChassis(view, selection.id);
    const chassis = found?.chassis ?? findUnplacedChassis(view, selection.id);
    if (chassis == null) return null;
    const rack = found?.rack;
    const topU = chassis.positionU + chassis.heightU - 1;
    const uRange = chassis.heightU === 1 ? `U${chassis.positionU}` : `U${chassis.positionU}–U${topU}`;
    // `chassis.sketch` (`document/view.ts`) only reads `true` once at least
    // one port exists — right for the box on the plate (nothing to mark
    // "typed" with zero ports), wrong for the editor: a device
    // `createSketchDevice` just minted has NO
    // catalogue model and NO ports yet, and gating "+ add a port" on
    // `chassis.sketch` would hide the one control that could ever add its
    // first one. Computed locally instead, off `chassis.model` alone — the
    // same "no catalogue model" reading the fixture panel below already
    // derives locally for its own `sketch` for the identical reason.
    const chassisSketch = chassis.model === '';
    const kindLine = [chassis.role, rack ? `${rack.label}, ${uRange}` : 'not placed'].filter(Boolean).join(' · ');
    const sub = [[chassis.vendor, chassis.model].filter(Boolean).join(' '), connectorCounts(chassis.ports)].filter(Boolean).join(' · ');
    return (
      <div className="drawing-editor__panel drawing-editor__panel--tabbed drawing-editor__panel--device">
        {/* r31 pictures: what and where in one small line, the name, what it is, then its state as chips. */}
        <div className="dev-panel__head">
          <div className="dev-panel__kind">
            <span>{kindLine}</span>
            {actions.onEdit != null || more != null ? (
              <details className="dev-more" data-testid="device-more">
                <summary className="dev-more__button" aria-label="More for this device" title="More for this device">
                  ⋯
                </summary>
                {Array.isArray(more) ? (
                  <div className="dev-more__menu dev-more__menu--list" role="menu" onClick={closeMoreOnPick}>
                    <MenuItems items={more as readonly MenuItem[]} />
                  </div>
                ) : (
                  <div className="dev-more__menu">
                    {more as ReactNode}
                    {/* `duplicateDevice` (`commands.ts`) refuses a source that is not rack-mounted, so it is left off an
                        unplaced device rather than offered only to refuse. */}
                    {rack ? <DuplicateDeviceControl chassisId={chassis.id} actions={actions} /> : null}
                    {/* No confirmation dialog; undo is the record's job. */}
                    <SupplyAction label={DEVICE_WORDS.remove} onCommit={actions.onEdit ? () => actions.onEdit!(removeDeviceChange(chassis.id)) : undefined} />
                  </div>
                )}
              </details>
            ) : null}
          </div>
          <div className="drawing-editor__title dev-panel__name">
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
          {sub ? <div className="dev-panel__sub">{sub}</div> : null}
          <div className="dev-panel__chips">
            <FirmwareChip deviceId={chassis.deviceId} />
            {chassisSketch ? <span className="dev-tag">Typed by hand</span> : null}
          </div>
          {/* r30-device: said once for the whole panel, not under every field. */}
          <TypedNote shown={[chassis.hostname, chassis.role, chassis.serial, chassis.managementAddress].some((v) => (v ?? '').length > 0)} />
        </div>
        <PanelFaceplate chassis={chassis} view={view} />

        {/* A new sketch has nothing to show but its ports, so it opens there. */}
        <TypedNoteMode.Provider value="once">
        <PanelTabs
          key={chassis.id}
          initial={chassisSketch && chassis.ports.length === 0 ? 'ports' : undefined}
          tabs={[
            {
              id: 'details',
              label: 'Details',
              body: (
                <>
                  <div className="drawing-editor__group">Device</div>
                  {/* ADR-0051 §1 — "a box with no catalogue entry draws
                      from ports typed by hand and says so." */}
                  {chassisSketch ? (
                    <div style={TYPED_NOTE_STYLE}>
                      <strong style={{ color: 'var(--ink)', fontWeight: 700 }}>No catalogue entry.</strong> Ports typed by
                      hand.
                    </div>
                  ) : null}
                  <SwapModelControl chassisId={chassis.id} current={chassis.model} catalogue={catalogue} actions={actions} />
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

                  <div className="drawing-editor__group">Location</div>
                  {/* Rack/face are placement-only — nothing to show for a chassis
                      `PlacedOnControl` below already draws "Placed on: none" for. */}
                  {rack ? <Field label="Rack" value={`${rack.label} · ${uRange}`} /> : null}
                  {rack ? <Field label="Face" value={chassis.face} /> : null}
                  {/* ADR-0051 §1 — "PLACED ON" as three choices, the
                      current one marked. */}
                  <PlacedOnControl itemId={chassis.id} placement={chassis.placement} view={view} actions={actions} />

                  {/* r30-device: Device and Location stay open; the rest fold to one line each. Sign-off r60:
                      which of the rest show, and in what order, is the person's choice. */}
                  <DeviceSections
                    sections={{
                      connections: <ConnectionsSection chassis={chassis} view={view} actions={actions} />,
                      management: (
                        <Fold title="Management" summary={chassis.managementAddress || 'no address'} testId="management-fold">
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
                          {(chassis.managementAddress ?? '').length > 0 ? <div style={TYPED_NOTE_STYLE}>{MANAGEMENT_ADDRESS_NOTE}</div> : null}
                          <TermixActions name={chassis.hostname} address={chassis.managementAddress ?? ''} />
                          <TermixReveal chassisId={chassis.id} />
                        </Fold>
                      ),
                      firmware: <FirmwareSection deviceId={chassis.deviceId} folded />,
                      about: <AboutSection deviceId={chassis.deviceId} folded />,
                      photo: <DevicePhoto ownerId={chassis.deviceId} name={chassis.hostname || UNNAMED_HOSTNAME} folded />,
                    }}
                  />

                </>
              ),
            },
            {
              id: 'ports',
              label: 'Ports',
              body: (
                <>
                  <Field label="Ports" value={chassis.ports.length > 0 ? `${chassis.ports.filter((p) => p.cable != null).length} of ${chassis.ports.length} cabled` : 'None yet'} />
                  {/* Sign-off r60: an empty tab says what to do next. */}
                  {chassis.ports.length === 0 ? (
                    <p className="drawing-editor__empty-next" data-testid="ports-empty">
                      {chassisSketch
                        ? actions.onEdit
                          ? 'Add its ports below, or give it a catalogue model on the Details tab and its ports come with it.'
                          : 'No ports have been added to it yet.'
                        : 'Its catalogue model lists no ports.'}
                    </p>
                  ) : null}
                  <PortsInWords chassis={chassis} />

                  {/* ADR-0051 §1 — a sketch's own ports, typed by hand,
                      each marked TYPED, with add/remove. A catalogued chassis keeps
                      its read-only "Ports" count above, unchanged. */}
                  {chassisSketch ? <SketchPortsSection chassisId={chassis.id} ports={chassis.ports} actions={actions} /> : null}

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

                  <CardsSection chassis={chassis} actions={actions} />

                </>
              ),
            },
            {
              id: 'logins',
              label: <LoginsTabLabel deviceId={chassis.deviceId} />,
              body: <LoginsTab deviceId={chassis.deviceId} />,
            },
            {
              id: 'notes',
              label: 'Notes',
              body: (
                <>
                  <FieldsSection ownerId={chassis.deviceId} actions={actions} />

                  {/* ADR-0053 §5 — Device, not Chassis: the device has the page, the
                      hostname and the capture, so its notes are `HasNote`'d off
                      `chassis.deviceId`, not `chassis.id`. */}
                  <NotesSection ownerId={chassis.deviceId} actions={actions} />
                  <TagsSection ownerId={chassis.deviceId} actions={actions} />
                  <DocsSection ownerId={chassis.deviceId} model={chassis.model} />

                </>
              ),
            },
          ]}
        />
        </TypedNoteMode.Provider>

        {tail}
        {links ? <div className="drawing-editor__footer dev-panel__foot">{links}</div> : null}
      </div>
    );
  }

  // ADR-0051 §1/§2 — a shelf occupant, shown
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
    // egg fix as the chassis branch above: a device dropped straight onto a
    // shelf slot has no ports yet, and would otherwise never see "+ add a
    // port" at all.
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
        <Field label="Ports" value={`${occupant.ports.filter((p) => p.cable != null).length} of ${occupant.ports.length} cabled`} />

        {occupant.kind === 'chassis' && occupantSketch ? (
          <SketchPortsSection chassisId={occupant.id} ports={occupant.ports} actions={actions} />
        ) : occupant.ports.length > 0 ? (
          <div className="drawing-editor__field">
            <div className="drawing-editor__field-label">Ports</div>
            {byPortLabel(occupant.ports).map((port) => (
              <div key={port.id} className="drawing-editor__field" style={{ display: 'flex', gap: 'var(--s2)' }}>
                <span>{port.label || ABSENT}</span>
                <span style={{ color: 'var(--muted)' }}>{port.connector}</span>
              </div>
            ))}
          </div>
        ) : null}

        <PlacedOnControl itemId={occupant.id} placement={placement} view={view} actions={actions} />

        {/* UI-SPEC's cable-delete rule — a device on a shelf removes exactly
            like a rack-mounted one; a passive occupant (a splitter, an
            outlet) has no such action — racks/surfaces and everything on
            them that is not a device stay out of scope. */}
        {occupant.kind === 'chassis' ? (
          <div className="drawing-editor__footer">
            <SupplyAction
              label={DEVICE_WORDS.remove}
              onCommit={actions.onEdit ? () => actions.onEdit!(removeDeviceChange(occupant.id)) : undefined}
            />
          </div>
        ) : null}
      </div>
    );
  }

  // ADR-0051 §1/§2 — a surface fixture (a
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
        <Field label="Ports" value={`${fixture.ports.filter((p) => p.cable != null).length} of ${fixture.ports.length} cabled`} />

        {fixture.kind === 'chassis' && sketch ? (
          <SketchPortsSection chassisId={fixture.id} ports={fixture.ports} actions={actions} />
        ) : fixture.ports.length > 0 ? (
          <div className="drawing-editor__field">
            <div className="drawing-editor__field-label">Ports</div>
            {byPortLabel(fixture.ports).map((port) => (
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

        {/* UI-SPEC's cable-delete rule — a device fixed to a surface removes
            exactly like a rack-mounted one; a board or any other passive
            fixture has no such action. */}
        {fixture.kind === 'chassis' ? (
          <div className="drawing-editor__footer">
            <SupplyAction
              label={DEVICE_WORDS.remove}
              onCommit={actions.onEdit ? () => actions.onEdit!(removeDeviceChange(fixture.id)) : undefined}
            />
          </div>
        ) : null}
      </div>
    );
  }

  // UI-SPEC "Cables" — a selected cable's own panel.
  // `view.cables` (`ClosetView`, `contract.ts`'s re-export) is the one place
  // a `Cable` lives in this view, the same "scan by kind" `document/view.ts`'s
  // own file header gives `viewOf` for a root-level node — `null` when this
  // view carries no such cable, never invented, the same rule every lookup
  // in `lookup.ts` already keeps.
  if (selection.kind === 'cable') {
    const cable = view.cables.find((c) => c.id === selection.id);
    if (cable == null) return null;
    return (
      <div className="drawing-editor__panel">
        <div className="drawing-editor__title">
          <EditableValue
            value={cable.label ?? ''}
            placeholder={ABSENT}
            editorKind="text"
            onCommit={actions.onEdit ? (v) => actions.onEdit!(setCableFieldChange(cable.id, 'label', v)) : undefined}
          />
        </div>
        <TypedNote shown={(cable.label ?? '').length > 0} />

        {/* "its two ends in words (device and port each side, or the
            outside label)". "Go to end A and
            Go to end B, each selecting that port and panning to it" —
            offered only for a real port end; an outside end has no port to
            go to. */}
        {cable.ends.length === 0 ? (
          <Field label="Ends" value={ABSENT} />
        ) : (
          cable.ends.map((end, i) => (
            <div key={i} className="drawing-editor__field">
              <div className="drawing-editor__field-label">{i === 0 ? 'End A' : 'End B'}</div>
              <div className="drawing-editor__field-value" style={{ display: 'flex', alignItems: 'center', gap: 'var(--s2)' }}>
                <span>{cableEndText(view, end)}</span>
                {'portId' in end && actions.onSelect ? (
                  <button type="button" onClick={() => actions.onSelect!({ kind: 'port', id: end.portId })}>
                    {i === 0 ? 'Go to end A' : 'Go to end B'}
                  </button>
                ) : null}
                {'outside' in end && end.far ? <OpenFarSite far={end.far} label={cableEndText(view, end)} /> : null}
              </div>
            </div>
          ))
        )}

        <LooseEndField cable={cable} actions={actions} />

        <Field label="Kind" value={cable.kind} />
        <Field label="Media" value={cable.media || ABSENT} />

        {/* "the sheath as a colour selector using the same lists as the
            connect-time picker for that kind (power fixed to grey)". */}
        <CableSheathField cable={cable} onEdit={actions.onEdit} />

        <div className="drawing-editor__field">
          <div className="drawing-editor__field-label">Length (m)</div>
          <EditableValue
            value={cable.lengthM != null ? String(cable.lengthM) : ''}
            placeholder={ABSENT}
            editorKind="text"
            onCommit={actions.onEdit ? (v) => actions.onEdit!(setCableFieldChange(cable.id, 'length_m', v)) : undefined}
          />
        </div>
        <TypedNote shown={cable.lengthM != null} />

        <div className="drawing-editor__field">
          <div className="drawing-editor__field-label">Ownership</div>
          <EditableValue
            value={cable.ownership ?? ''}
            placeholder={ABSENT}
            editorKind="select"
            options={OWNERSHIP_VALUES}
            onCommit={actions.onEdit ? (v) => actions.onEdit!(setCableFieldChange(cable.id, 'ownership', v)) : undefined}
          />
        </div>
        <TypedNote shown={(cable.ownership ?? '').length > 0} />

        {/* UI-SPEC "Delete/Backspace on a selected cable calls onDisconnect
            — no confirmation dialog" — the panel's own version of the same
            action, through `EditorActions.onEdit` rather than `Drawing`'s
            own keyboard listener, the same "the same edit through either
            door" reading `handleEdit` already gives every other change. */}
        <SupplyAction
          label="Disconnect"
          onCommit={actions.onEdit ? () => actions.onEdit!(disconnectCableChange(cable.id)) : undefined}
        />

        <HideCableAction cable={cable} actions={actions} />

        {/* ADR-0059 decision 2 — Cable is one of the `Taggable` kinds. */}
        <FieldsSection ownerId={cable.id} actions={actions} />
        <NotesSection ownerId={cable.id} actions={actions} />
        <TagsSection ownerId={cable.id} actions={actions} />
        <DocsSection ownerId={cable.id} />
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
        <Field label="Device" value={chassis.hostname || UNNAMED_HOSTNAME} />
        <Field label="Connector" value={port.connector} />
        {/* "connector, service, face". */}
        <Field label="Service" value={port.service ?? ABSENT} />
        <Field label="Face" value={port.face} />
        <Field label="Uplink" value={port.uplink ? 'yes' : 'no'} />
        <Field label="Rack" value={rack.label} />
        <PortCableSection view={view} port={port} actions={actions} />
        <OpticSection port={port} siblings={chassis.ports} actions={actions} />
        {/* ADR-0053 §5 — PhysicalPort is one of the three `Notable` kinds,
            wherever the port sits (a rack chassis, a shelf occupant or a
            surface fixture — `port.id` is the same `PhysicalPort` node id
            either way, `locatePort`'s own contract). */}
        <PortMacField port={port} actions={actions} />
        <FieldsSection ownerId={port.id} actions={actions} />
        <NotesSection ownerId={port.id} actions={actions} />
        <TagsSection ownerId={port.id} actions={actions} />
        <DocsSection ownerId={port.id} />
      </div>
    );
  }
  if (located.place === 'shelf') {
    const { rack, shelf, occupant } = located;
    return (
      <div className="drawing-editor__panel">
        <div className="drawing-editor__title">{port.label || ABSENT}</div>
        <Field label="Device" value={occupant.label || ABSENT} />
        <Field label="Connector" value={port.connector} />
        <Field label="Service" value={port.service ?? ABSENT} />
        <Field label="Face" value={port.face} />
        <Field label="Uplink" value={port.uplink ? 'yes' : 'no'} />
        <Field label="Shelf" value={`${shelf.label || shelf.id} · ${rack.label}`} />
        <PortCableSection view={view} port={port} actions={actions} />
        <OpticSection port={port} siblings={occupant.ports} actions={actions} />
        <PortMacField port={port} actions={actions} />
        <FieldsSection ownerId={port.id} actions={actions} />
        <NotesSection ownerId={port.id} actions={actions} />
        <TagsSection ownerId={port.id} actions={actions} />
        <DocsSection ownerId={port.id} />
      </div>
    );
  }
  const { surface, fixture } = located;
  return (
    <div className="drawing-editor__panel">
      <div className="drawing-editor__title">{port.label || ABSENT}</div>
      <Field label="Device" value={fixture.label || ABSENT} />
      <Field label="Connector" value={port.connector} />
      <Field label="Service" value={port.service ?? ABSENT} />
      <Field label="Face" value={port.face} />
      <Field label="Uplink" value={port.uplink ? 'yes' : 'no'} />
      <Field label="Surface" value={surface.label || surface.id} />
      <PortCableSection view={view} port={port} actions={actions} />
      <OpticSection port={port} siblings={fixture.ports} actions={actions} />
      <PortMacField port={port} actions={actions} />
      <FieldsSection ownerId={port.id} actions={actions} />
      <NotesSection ownerId={port.id} actions={actions} />
      <TagsSection ownerId={port.id} actions={actions} />
      <DocsSection ownerId={port.id} />
    </div>
  );
}

/** Ports in the order printed on the device (1, 2 … 10), not the order they were stored in. */
function byPortLabel<P extends { label: string }>(ports: readonly P[]): P[] {
  return [...ports].sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
}
