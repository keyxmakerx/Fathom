import { Fragment, useMemo, useState } from 'react';

import { parseNodeId } from '../../document/model';
import { viewOf, type ClosetView } from '../../document/view';
import type { DesignSession } from '../design/useDesignSession';
import { EditorFor, type NotesActions, type Selection } from '../drawing';
import { paletteFromCatalogue } from '../racks/palette';
import { Shell } from '../Shell';
import type { ShellProps } from '../shell/types';
import { MiddleClip } from './MiddleClip';
import {
  COLUMN_LABEL,
  columnsForLens,
  formatLastChange,
  gapRows,
  groupDeviceRows,
  type ColumnKey,
  type DeviceRow,
} from './rows';
import './inventory.css';

const EMPTY_VIEW: ClosetView = { premisesId: '', racks: [], cables: [], rows: [], surfaces: [] };

type Kind = 'devices' | 'racks' | 'cables' | 'ports';
const KINDS: ReadonlyArray<{ key: Kind; label: string }> = [
  { key: 'devices', label: 'Devices' },
  { key: 'racks', label: 'Racks' },
  { key: 'cables', label: 'Cables' },
  { key: 'ports', label: 'Ports' },
];

/** Selection identity for a React key and an "is this row selected" check —
 * `Selection`'s own kinds each carry an `id`, so `${kind}:${id}` is already
 * unique across all of them without inventing a new id scheme. */
function selectionKey(s: Selection): string {
  return `${s.kind}:${s.id}`;
}

function cellText(row: DeviceRow, column: ColumnKey): string {
  switch (column) {
    case 'name':
      return row.name;
    case 'model':
      return row.model;
    case 'where':
      return row.where;
    case 'ports':
      return row.ports;
    case 'firmware':
      return row.firmware;
    case 'power':
      return row.power;
    case 'lastChange':
      return row.lastChangeMs != null ? formatLastChange(row.lastChangeMs) : '—';
    case 'cablesByKind':
      return row.cablesByKind;
    case 'inletStates':
      return row.inletStates;
    case 'owner':
      return row.owner;
    default:
      return '—';
  }
}

export interface InventoryPlaceProps extends Omit<ShellProps, 'editor' | 'rail' | 'children'> {
  /** This session's brief item 1 — the same `Document`/`SaveQueue`/
   * `handleEdit` `RacksPlace` reads, held one level up in `DesignPlace.tsx`
   * so switching place never reloads the design or drops a queued save. */
  session: DesignSession;
  /** This session's brief item 5 — "Show on rack": switches the place to
   * Racks with `selection` already chosen and the camera asked to the
   * faceplate stop (`RacksPlace`'s own `initialFocus`). */
  onShowOnRack: (selection: Selection) => void;
  /** ADR-0053 §5/§6, this session's brief item 4 — Notes, the same three
   * doors `RacksPlace.tsx` receives, built once by `DesignPlace.tsx` and
   * threaded straight into this place's own `EditorFor` call: "the one
   * editor" holds for Notes exactly as it does for every other field. */
  notesActions: NotesActions;
  /** ADR-0053 §3 — "a refusal wash naming that change." `RacksPlace.tsx`
   * shows this in its own `Trail`; Inventory has no Trail mounted, but an
   * undo requested from here can refuse exactly the same way, so it goes in
   * the Shell's own `trail` slot rather than landing nowhere. */
  undoRefusal: string | null;
}

/**
 * The basic Inventory place (ADR-0046 §8): a rail of kinds and their
 * counts, a grid of devices grouped per rack, then shelves, then surfaces,
 * then unplaced, a Gaps section listing every rack's free runs, and the
 * one editor (ADR-0046 §2) on the right — the exact same `EditorFor`/
 * `handleEdit` the drawing uses, so an edit here is the same edit there.
 * Racks, Cables and Ports are named on the rail with real counts; only
 * Devices has a built grid this session — the other three are honestly
 * unbuilt rather than a grid with nothing behind it.
 */
export function InventoryPlace(props: InventoryPlaceProps) {
  const { session, onShowOnRack, notesActions, undoRefusal, lens, ...shellProps } = props;
  const { doc, catalogue, loadError, saveRefusal, canDraw, handleEdit, reloadDesign } = session;

  const [kind, setKind] = useState<Kind>('devices');
  const [selection, setSelection] = useState<Selection | null>(null);

  const view = useMemo<ClosetView>(() => (doc ? viewOf(doc, catalogue) : EMPTY_VIEW), [doc, catalogue]);
  const groups = useMemo(() => (doc ? groupDeviceRows(view, doc) : []), [view, doc]);
  const gaps = useMemo(() => gapRows(view), [view]);
  const columns = columnsForLens(lens);

  // ADR-0046 §2: "Nothing in a list is typed" — every count below is read
  // off the live document, never a literal — a live `Chassis`/`Cable`/`PhysicalPort`
  // node, counted regardless of where (or whether) it is placed, so the
  // rail's own number and the grid's own row count can never disagree about
  // what a "device" is.
  const counts: Record<Kind, number> = useMemo(() => {
    if (!doc) return { devices: 0, racks: 0, cables: 0, ports: 0 };
    let devices = 0;
    let cables = 0;
    let ports = 0;
    for (const node of doc.nodes) {
      if (node.absentSince !== undefined) continue;
      const nodeKind = parseNodeId(node.id).kind;
      if (nodeKind === 'Chassis') devices += 1;
      else if (nodeKind === 'Cable') cables += 1;
      else if (nodeKind === 'PhysicalPort') ports += 1;
    }
    return { devices, racks: view.racks.length, cables, ports };
  }, [doc, view.racks.length]);

  // ADR-0047: absent, not empty, when nothing is selected (see RacksPlace).
  const selectedPanel =
    doc != null
      ? EditorFor(
          selection,
          view,
          {
            onEdit: canDraw ? handleEdit : undefined,
            onSelect: setSelection,
            // ADR-0053 §5/§6 — a reader may read Notes; only a writer may
            // add or remove one.
            notesOf: notesActions.notesOf,
            onAddNote: canDraw ? notesActions.onAddNote : undefined,
            onRemoveNote: canDraw ? notesActions.onRemoveNote : undefined,
          },
          paletteFromCatalogue(catalogue),
        )
      : null;
  const editorPane =
    saveRefusal != null ? (
      <div className="inventory-place__refusal">
        {saveRefusal}
        {/* ADR-0054 §1's refusal wash "offers reload". */}
        <button type="button" className="inventory-place__refusal-reload" onClick={reloadDesign}>
          Reload
        </button>
      </div>
    ) : selectedPanel != null && selection != null ? (
      <>
        {selectedPanel}
        <button type="button" className="inventory-place__show-on-rack" onClick={() => onShowOnRack(selection)}>
          Show on rack
        </button>
      </>
    ) : null;

  const trail = undoRefusal != null ? <div className="inventory-place__refusal">{undoRefusal}</div> : null;

  return (
    <Shell {...shellProps} lens={lens} editor={editorPane} trail={trail} viewOnly={!canDraw}>
      {doc == null ? (
        <div className="inventory-place__loading">{loadError ?? 'Opening the design…'}</div>
      ) : (
        <div className="inventory-place">
          <nav className="inventory-place__rail" aria-label="Inventory kinds">
            <div className="inventory-place__rail-title">Kinds</div>
            <ul className="inventory-place__kinds">
              {KINDS.map((k) => (
                <li key={k.key}>
                  <button
                    type="button"
                    className={k.key === kind ? 'inventory-place__kind inventory-place__kind--active' : 'inventory-place__kind'}
                    onClick={() => setKind(k.key)}
                  >
                    <span>{k.label}</span>
                    <span className="inventory-place__count">{counts[k.key]}</span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="inventory-place__rail-title">Saved filters</div>
            <p className="inventory-place__muted">Saved filters are not built yet.</p>
          </nav>

          <div className="inventory-place__main">
            {kind !== 'devices' ? (
              <div className="inventory-place__unbuilt">This list is not built yet.</div>
            ) : (
              <>
                <table className="inventory-place__grid">
                  <thead>
                    <tr>
                      <th aria-hidden="true" />
                      {columns.map((c) => (
                        <th key={c}>{COLUMN_LABEL[c]}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {groups.length === 0 ? (
                      <tr>
                        <td colSpan={columns.length + 1} className="inventory-place__muted">
                          No devices yet.
                        </td>
                      </tr>
                    ) : (
                      groups.map((group) => (
                        <Fragment key={group.label}>
                          <tr className="inventory-place__group-row">
                            <td colSpan={columns.length + 1}>{group.label}</td>
                          </tr>
                          {group.rows.map((row) => {
                            const key = selectionKey(row.selection);
                            const isSelected = selection != null && selectionKey(selection) === key;
                            return (
                              <tr
                                key={key}
                                className={isSelected ? 'inventory-place__row inventory-place__row--selected' : 'inventory-place__row'}
                                onClick={() => setSelection(row.selection)}
                              >
                                <td aria-hidden="true" />
                                {columns.map((c) => (
                                  <td key={c}>{c === 'name' ? <MiddleClip text={row.name} /> : cellText(row, c)}</td>
                                ))}
                              </tr>
                            );
                          })}
                        </Fragment>
                      ))
                    )}
                  </tbody>
                </table>

                <div className="inventory-place__gaps">
                  <div className="inventory-place__rail-title">Gaps</div>
                  {gaps.length === 0 ? (
                    <p className="inventory-place__muted">No free runs.</p>
                  ) : (
                    <ul>
                      {gaps.map((g, i) => (
                        <li key={`${g.rackId}:${g.fromU}:${i}`}>
                          {`${g.rackLabel} · U${g.fromU}–U${g.toU} · ${g.sizeU}U free`}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </Shell>
  );
}
