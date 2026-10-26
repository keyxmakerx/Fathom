// Cards and optics in the one editor (ADR-0073, schema 0.28): the device panel's Cards section
// and the port panel's Optic section. Every write is an `EditorChange` through `actions.onEdit`,
// refused beside the control the same way a field edit is.

import { useEffect, useId, useState, type DragEvent } from 'react';

import { PORT_CONNECTOR_VALUES } from '../../document/compat';
import { expandPortPattern } from '../../document/portPattern';
import { ABSENT, type CardView, type ChassisView, type EditorActions, type EditorChange, type Optic, type PortView } from './contract';
import { CAUTION_STYLE, EditableValue, Field, SHOW_PANEL_TAB, SupplyAction, TYPED_NOTE_STYLE } from './Editor';
import { connectorName } from './faceplate';

/** The drag payload type an optic chip carries: the port id it came from. */
export const OPTIC_DRAG_TYPE = 'application/x-fathom-optic';
/** Raised by a cage an optic chip is dropped on (`ChassisNode.tsx`); the open Optic section moves it. */
export const OPTIC_DROP_EVENT = 'fathom:optic-drop';

export interface OpticDrop {
  fromPortId: string;
  toPortId: string;
}

/** A cage that can take a dropped optic: it has a cage, and nothing in it. */
export function takesOptic(port: PortView): boolean {
  return /sfp|qsfp/.test(port.connector) && !port.optic;
}

export function onOpticDragOver(port: PortView, event: DragEvent): void {
  if (!event.dataTransfer.types.includes(OPTIC_DRAG_TYPE) || !takesOptic(port)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
}

export function onOpticDrop(port: PortView, event: DragEvent): void {
  const from = event.dataTransfer.getData(OPTIC_DRAG_TYPE);
  if (!from || !takesOptic(port)) return;
  event.preventDefault();
  event.stopPropagation();
  window.dispatchEvent(new CustomEvent<OpticDrop>(OPTIC_DROP_EVENT, { detail: { fromPortId: from, toPortId: port.id } }));
}

function opticWords(o: Optic): string {
  const bits = [o.type, o.part, o.wavelengthNm != null ? `${o.wavelengthNm} nm` : undefined].filter(Boolean);
  return bits.length > 0 ? bits.join(' · ') : 'Fitted, details not known';
}

// ---------------------------------------------------------------------------
// The port panel's Optic section

const OPTIC_FIELDS: ReadonlyArray<{ key: keyof Optic; label: string; hint: string }> = [
  { key: 'type', label: 'Type', hint: '10GBASE-SR' },
  { key: 'part', label: 'Part number', hint: 'SFP-10G-SR' },
  { key: 'vendor', label: 'Vendor', hint: '' },
  { key: 'serial', label: 'Serial', hint: '' },
  { key: 'wavelengthNm', label: 'Wavelength (nm)', hint: '850' },
];

export function OpticSection({ port, siblings, actions }: { port: PortView; siblings: readonly PortView[]; actions: EditorActions }) {
  const onEdit = actions.onEdit;
  const [refusal, setRefusal] = useState<string | null>(null);
  const optic = port.optic;

  // A drop on a cage moves this port's optic there (the chip below is what was dragged).
  useEffect(() => {
    if (!onEdit) return;
    function onDrop(event: Event) {
      const { fromPortId, toPortId } = (event as CustomEvent<OpticDrop>).detail;
      if (fromPortId !== port.id) return;
      const result = onEdit!({ kind: 'optic-move', fromPortId, toPortId });
      setRefusal(result?.refused ?? null);
    }
    window.addEventListener(OPTIC_DROP_EVENT, onDrop);
    return () => window.removeEventListener(OPTIC_DROP_EVENT, onDrop);
  }, [onEdit, port.id]);

  if (!/sfp|qsfp/.test(port.connector) && optic == null) return null;

  const set = (change: EditorChange): void => {
    const result = onEdit?.(change);
    setRefusal(result?.refused ?? null);
  };
  const fieldText = (k: keyof Optic): string => {
    const v = optic?.[k];
    return v == null ? '' : String(v);
  };
  const commitField = (k: keyof Optic) => (raw: string | null) => {
    const next: Optic = { ...(optic ?? {}) };
    if (raw == null) delete next[k];
    else if (k === 'wavelengthNm') {
      const n = Number(raw);
      if (!Number.isInteger(n)) return { refused: 'Wavelength is a whole number of nanometres, such as 850 or 1310.' };
      next.wavelengthNm = n;
    } else next[k] = raw as never;
    return onEdit?.({ kind: 'optic', portId: port.id, optic: next });
  };
  const freeCages = siblings.filter((p) => p.id !== port.id && takesOptic(p));

  return (
    <div className="drawing-editor__field" data-testid="optic-section">
      <div className="drawing-editor__group">Optic</div>
      {optic === undefined ? (
        <div style={TYPED_NOTE_STYLE}>Nobody has looked in this cage yet.</div>
      ) : optic === null ? (
        <div style={TYPED_NOTE_STYLE}>Empty cage.</div>
      ) : (
        <>
          <div
            className="drawing-parts__optic-chip"
            draggable={onEdit != null}
            title={onEdit ? 'Drag onto an empty cage to move this optic' : undefined}
            onDragStart={(e) => {
              e.dataTransfer.setData(OPTIC_DRAG_TYPE, port.id);
              e.dataTransfer.effectAllowed = 'move';
            }}
          >
            {opticWords(optic)}
          </div>
          {OPTIC_FIELDS.map((f) => (
            <div key={f.key} className="drawing-editor__field">
              <div className="drawing-editor__field-label">{f.label}</div>
              <EditableValue value={fieldText(f.key)} placeholder={ABSENT} editorKind="text" onCommit={onEdit ? commitField(f.key) : undefined} />
            </div>
          ))}
        </>
      )}
      {onEdit ? (
        <div className="drawing-parts__actions">
          {optic == null ? <button type="button" onClick={() => set({ kind: 'optic', portId: port.id, optic: {} })}>Fit an optic</button> : null}
          {optic !== null ? <button type="button" onClick={() => set({ kind: 'optic', portId: port.id, optic: null })}>{optic ? 'Take it out' : 'Mark empty'}</button> : null}
          {optic && freeCages.length > 0 ? (
            <label className="drawing-parts__move">
              <span>Move to</span>
              <select value="" onChange={(e) => e.target.value && set({ kind: 'optic-move', fromPortId: port.id, toPortId: e.target.value })}>
                <option value="" />
                {freeCages.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label || p.id}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
      ) : null}
      {refusal != null ? <div style={CAUTION_STYLE}>{refusal}</div> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The device panel's Cards section

function FitCardForm({
  hostId,
  sub,
  actions,
  onDone,
  slots,
  initialSlot = '',
}: {
  hostId: string;
  sub: boolean;
  actions: EditorActions;
  onDone: () => void;
  /** The catalogue's empty slots, offered as the slot's choices; anything may still be typed. */
  slots?: readonly string[];
  initialSlot?: string;
}) {
  const [slot, setSlot] = useState(initialSlot);
  const listId = useId();
  const [name, setName] = useState('');
  const [model, setModel] = useState('');
  const [serial, setSerial] = useState('');
  const [pattern, setPattern] = useState('');
  const [connector, setConnector] = useState('sfp_plus');
  const [refusal, setRefusal] = useState<string | null>(null);
  // The same name-or-pattern field "+ Add a port" uses: `1/{1-24}` is 24 ports typed once.
  const expanded = pattern.trim() === '' ? null : expandPortPattern(pattern);

  function commit() {
    if (expanded && !expanded.ok) {
      setRefusal(expanded.reason);
      return;
    }
    const result = actions.onEdit?.({
      kind: 'card-fit',
      hostId,
      slot,
      name: name || undefined,
      model: model || undefined,
      serial: serial || undefined,
      ports: expanded?.ok ? { labels: expanded.labels, connector } : undefined,
    });
    if (result?.refused) {
      setRefusal(result.refused);
      return;
    }
    onDone();
  }

  const cell = (label: string, value: string, set: (v: string) => void, placeholder = '', wide = false, list?: string) => (
    <label className={wide ? 'drawing-ports__cell drawing-ports__cell--wide' : 'drawing-ports__cell'}>
      <span>{label}</span>
      <input
        value={value}
        placeholder={placeholder}
        list={list}
        onChange={(e) => {
          set(e.target.value);
          setRefusal(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
        }}
      />
    </label>
  );

  return (
    <div className="drawing-ports__form" data-testid="fit-card-form">
      {cell(sub ? 'Sub-slot' : 'Slot', slot, setSlot, slots?.[0] ?? (sub ? '0' : '1, or FPC 2'), false, slots?.length ? listId : undefined)}
      {slots?.length ? (
        <datalist id={listId}>
          {slots.map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      ) : null}
      {cell('What it is', name, setName, '24 x SFP+')}
      {cell('Model', model, setModel)}
      {cell('Serial', serial, setSerial)}
      {cell('Ports, a name or a pattern', pattern, setPattern, slot ? `${slot}/{1-24}` : '1/{1-24}', true)}
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
      <div className="drawing-ports__pattern" style={TYPED_NOTE_STYLE}>
        {expanded === null
          ? 'No ports yet: fit it again with ports, or add them later.'
          : expanded.ok
            ? expanded.labels.length === 1
              ? `Port ${expanded.labels[0]}`
              : `${expanded.labels.length} ports, ${expanded.labels[0]} to ${expanded.labels.at(-1)}`
            : expanded.reason}
      </div>
      <div className="drawing-ports__actions">
        <button type="button" className="drawing-ports__primary" onClick={commit}>
          Fit card
        </button>
        <button type="button" onClick={onDone}>
          Cancel
        </button>
      </div>
      {refusal != null ? <div style={CAUTION_STYLE}>{refusal}</div> : null}
    </div>
  );
}

function CardRow({ card, depth, actions }: { card: CardView; depth: number; actions: EditorActions }) {
  const onEdit = actions.onEdit;
  const [adding, setAdding] = useState(false);
  const commit = (field: 'name' | 'model' | 'serial') => (onEdit ? (v: string | null) => onEdit({ kind: 'card', id: card.id, field, value: v }) : undefined);
  return (
    <div className="drawing-parts__card" style={{ marginLeft: depth * 12 }} data-testid="card-row">
      <div className="drawing-parts__card-head">
        <span className="drawing-parts__slot">{depth === 0 ? 'Slot' : 'Sub-slot'} {card.slot}</span>
        <EditableValue value={card.name ?? ''} placeholder="Card" editorKind="text" onCommit={commit('name')} />
      </div>
      <div className="drawing-editor__field">
        <div className="drawing-editor__field-label">Model</div>
        <EditableValue value={card.model ?? ''} placeholder={ABSENT} editorKind="text" onCommit={commit('model')} />
      </div>
      <div className="drawing-editor__field">
        <div className="drawing-editor__field-label">Serial</div>
        <EditableValue value={card.serial ?? ''} placeholder={ABSENT} editorKind="text" onCommit={commit('serial')} />
      </div>
      <Field label="Ports" value={String(card.portIds.length)} />
      <div className="drawing-parts__actions">
        <SupplyAction label="Take out" onCommit={onEdit ? () => onEdit({ kind: 'card-remove', id: card.id }) : undefined} />
        {onEdit && !adding ? (
          <button type="button" onClick={() => setAdding(true)}>
            + Card in a sub-slot
          </button>
        ) : null}
      </div>
      {adding ? <FitCardForm hostId={card.id} sub actions={actions} onDone={() => setAdding(false)} /> : null}
      {card.cards.map((c) => (
        <CardRow key={c.id} card={c} depth={depth + 1} actions={actions} />
      ))}
    </div>
  );
}

/** Asks the open device's Cards section to start fitting a card (the palette's and right-click's "Fit a card"). */
export const FIT_CARD_EVENT = 'fathom:fit-card';

export function CardsSection({ chassis, actions }: { chassis: ChassisView; actions: EditorActions }) {
  const [adding, setAdding] = useState<string | null>(null);
  const cards = chassis.cards ?? [];
  const empty = (chassis.cardSlots ?? []).filter((name) => !cards.some((c) => c.slot === name));
  const firstEmpty = empty[0] ?? '';
  useEffect(() => {
    const onRequest = (event: Event) => {
      if ((event as CustomEvent<{ chassisId: string }>).detail.chassisId !== chassis.id) return;
      window.dispatchEvent(new CustomEvent(SHOW_PANEL_TAB, { detail: { tab: 'ports' } }));
      setAdding(firstEmpty);
    };
    window.addEventListener(FIT_CARD_EVENT, onRequest);
    return () => window.removeEventListener(FIT_CARD_EVENT, onRequest);
  }, [chassis.id, firstEmpty]);
  if (cards.length === 0 && empty.length === 0 && !actions.onEdit) return null;
  return (
    <div className="drawing-editor__field" data-testid="cards-section">
      <div className="drawing-editor__group">Cards</div>
      {cards.length === 0 && empty.length === 0 ? <div style={TYPED_NOTE_STYLE}>No cards. A modular device's line cards and modules go here, each in its slot.</div> : null}
      {cards.map((c) => (
        <CardRow key={c.id} card={c} depth={0} actions={actions} />
      ))}
      {actions.onEdit ? (
        adding !== null ? (
          <FitCardForm hostId={chassis.id} sub={false} actions={actions} onDone={() => setAdding(null)} slots={empty} initialSlot={adding} />
        ) : (
          <button type="button" className="drawing-ports__add" onClick={() => setAdding(empty[0] ?? '')}>
            + Fit a card
          </button>
        )
      ) : null}
      {empty.length > 0 ? (
        <div className="drawing-parts__empty" data-testid="empty-card-slots">
          <span style={TYPED_NOTE_STYLE}>Empty {empty.length === 1 ? 'slot' : 'slots'}:</span>
          {empty.map((name) =>
            actions.onEdit ? (
              <button key={name} type="button" className="drawing-parts__slot-button" onClick={() => setAdding(name)} title={`Fit a card in ${name}`}>
                {name}
              </button>
            ) : (
              <span key={name} className="drawing-parts__slot">
                {name}
              </span>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}
