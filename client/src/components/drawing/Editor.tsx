import { useEffect, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from 'react';

import '../../styles/drawing.css';
import { DEVICE_ROLES } from '../../document/edit';
import { ABSENT, UNNAMED_HOSTNAME, type ClosetView, type EditorActions, type Selection } from './contract';
import { findChassis, findPort, findRack } from './lookup';

// `DEVICE_ROLES` is `Device.role`'s own enum vocabulary (`schema/schema.yaml`,
// mirrored once in `document/edit.ts` rather than guessed here — CLAUDE.md
// rule 3, "role's values are the enum, never a free string"). Nothing else
// is imported from `document/`: this file never reads or writes a
// `Document`, it only raises `EditorActions.onEdit` and waits for a new
// `view` prop, the same contract `DrawingActions` already keeps.

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

type FieldState = 'idle' | 'selected' | 'editing';

interface EditableValueProps {
  value: string;
  placeholder: string;
  placeholderClassName?: string;
  editorKind: 'text' | 'select';
  options?: readonly string[];
  onCommit: (raw: string | null) => void;
}

/**
 * One field of the one editor (ADR-0046 §2): idle -> click selects it ->
 * click again edits it. Enter or blur commits; Escape reverts without
 * committing. A `select` (for `Device.role`) commits on choice — there is no
 * free-text value to refuse there, the schema's own enum is the option list.
 */
function EditableValue({ value, placeholder, placeholderClassName, editorKind, options, onCommit }: EditableValueProps) {
  const [state, setState] = useState<FieldState>('idle');
  const [draft, setDraft] = useState(value);

  // The document changed under us (a save applied, or a refusal left it as
  // it was) — pick up the authoritative value whenever this field is not
  // mid-edit.
  useEffect(() => {
    if (state !== 'editing') setDraft(value);
  }, [value, state]);

  function commit(raw: string) {
    const trimmed = raw.trim();
    onCommit(trimmed.length > 0 ? trimmed : null);
    setState('idle');
  }

  function revert() {
    setDraft(value);
    setState('selected');
  }

  if (state === 'editing') {
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
        onChange={(e) => setDraft(e.target.value)}
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
    <span
      style={state === 'selected' ? SELECTED_STYLE : IDLE_STYLE}
      className={hasValue ? undefined : placeholderClassName}
      onClick={() => setState(state === 'selected' ? 'editing' : 'selected')}
    >
      {hasValue ? value : placeholder}
    </span>
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

/**
 * The selected thing's fields, exactly as the shell's `editor` prop wants
 * them (`Shell.tsx`'s `editor: ReactNode | null`). The same function serves
 * the drawing's side panel and (per UI-SPEC "One editor") the inventory
 * page — this file draws the fields and raises `actions.onEdit`; it never
 * reads or writes a `Document` itself.
 */
export function EditorFor(selection: Selection | null, view: ClosetView, actions: EditorActions): ReactNode {
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
      </div>
    );
  }

  if (selection.kind === 'chassis') {
    const found = findChassis(view, selection.id);
    if (found == null) return null;
    const { rack, chassis } = found;
    const topU = chassis.positionU + chassis.heightU - 1;
    const uRange = chassis.heightU === 1 ? `U${chassis.positionU}` : `U${chassis.positionU}–U${topU}`;
    return (
      <div className="drawing-editor__panel">
        <div className="drawing-editor__title">
          <EditableValue
            value={chassis.hostname}
            placeholder={UNNAMED_HOSTNAME}
            placeholderClassName="drawing-editor__title--placeholder"
            editorKind="text"
            onCommit={(v) => actions.onEdit({ kind: 'device', id: chassis.deviceId, field: 'hostname', value: v })}
          />
        </div>
        <TypedNote shown={chassis.hostname.length > 0} />

        <Field label="Model" value={chassis.model || ABSENT} />
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
            onCommit={(v) => actions.onEdit({ kind: 'device', id: chassis.deviceId, field: 'role', value: v })}
          />
        </div>
        <TypedNote shown={(chassis.role ?? '').length > 0} />

        <div className="drawing-editor__field">
          <div className="drawing-editor__field-label">Mgmt address</div>
          <EditableValue
            value={chassis.managementAddress ?? ''}
            placeholder={ABSENT}
            editorKind="text"
            onCommit={(v) =>
              actions.onEdit({ kind: 'device', id: chassis.deviceId, field: 'management_address', value: v })
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
            onCommit={(v) => actions.onEdit({ kind: 'chassis', id: chassis.id, field: 'serial', value: v })}
          />
        </div>
        <TypedNote shown={(chassis.serial ?? '').length > 0} />
      </div>
    );
  }

  const found = findPort(view, selection.id);
  if (found == null) return null;
  const { rack, chassis, port } = found;
  return (
    <div className="drawing-editor__panel">
      <div className="drawing-editor__title">{port.label || ABSENT}</div>
      <Field label="Connector" value={port.connector} />
      <Field label="Uplink" value={port.uplink ? 'yes' : 'no'} />
      <Field label="Device" value={chassis.hostname || UNNAMED_HOSTNAME} />
      <Field label="Rack" value={rack.label} />
      <Field label="Cabled" value={ABSENT} />
    </div>
  );
}
