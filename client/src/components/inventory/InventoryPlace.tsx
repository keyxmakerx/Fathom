import { Fragment, useEffect, useMemo, useState } from 'react';

import { parseNodeId } from '../../document/model';
import { viewOf, type ClosetView } from '../../document/view';
import type { DesignSession } from '../design/useDesignSession';
import { EditorFor, type NotesActions, type Selection } from '../drawing';
import { paletteFromCatalogue } from '../racks/palette';
import { Shell } from '../Shell';
import type { ShellProps } from '../shell/types';
import { MiddleClip } from './MiddleClip';
import { NetworksPanel } from './NetworksPanel';
import { deriveNetworks, type NetworksDerived } from '../../document/networks-derive';
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
const EMPTY_NETWORKS_DERIVED: NetworksDerived = { vlanRows: [], subnetRows: [], dockerNetworkRows: [], dockerUnattachedContainers: [] };

type Kind = 'devices' | 'racks' | 'cables' | 'ports' | 'networks';
const KINDS: ReadonlyArray<{ key: Kind; label: string }> = [
  { key: 'devices', label: 'Devices' },
  { key: 'racks', label: 'Racks' },
  { key: 'cables', label: 'Cables' },
  { key: 'ports', label: 'Ports' },
  { key: 'networks', label: 'Networks' },
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
  const { session, onShowOnRack, notesActions, lens, ...shellProps } = props;
  const { doc, catalogue, loadError, saveRefusal, canDraw, handleEdit, applyDocChange, reloadDesign } = session;

  const [kind, setKind] = useState<Kind>('devices');
  const [selection, setSelection] = useState<Selection | null>(null);

  const view = useMemo<ClosetView>(() => (doc ? viewOf(doc, catalogue) : EMPTY_VIEW), [doc, catalogue]);
  const groups = useMemo(() => (doc ? groupDeviceRows(view, doc) : []), [view, doc]);
  const gaps = useMemo(() => gapRows(view), [view]);
  const columns = columnsForLens(lens);
  // ADR-0058 — the Networks kind's live count and its grid read the SAME
  // derivation (computed once here, handed to `NetworksPanel` as a prop,
  // never recomputed inside it) — one derivation per doc change, not two.
  // `deriveNetworks` itself never throws, but the empty fallback is kept as
  // a second line of defence: a page with devices to inventory must never
  // go blank over a Networks-only reading.
  //
  // `deriveNetworks` runs synchronously only while the Networks kind is
  // actually shown (it is a real graph walk, memoised on the `Document`
  // object itself, but a re-render still pays for a first call after every
  // edit).
  const networksDerived = useMemo(() => {
    if (!doc || kind !== 'networks') return EMPTY_NETWORKS_DERIVED;
    try {
      return deriveNetworks(doc);
    } catch {
      return EMPTY_NETWORKS_DERIVED;
    }
  }, [doc, kind]);

  // The rail count, off the critical path, while ANY kind is shown: ADR-0046
  // §2 says every count is read off the live document, and a ref that
  // started at 0 and only updated while the reader was actually on Networks
  // showed "0" on first arrival and a stale number after an undo made
  // elsewhere. `null` (shown as "…") until the document has sat still for
  // 250ms, then the real, memoised count — never a leftover one. While
  // Networks itself is open, `networksDerived` above is already exactly
  // current, so the rail reads that directly instead of waiting out its
  // debounce.
  const [backgroundNetworksCount, setBackgroundNetworksCount] = useState<number | null>(null);
  useEffect(() => {
    if (!doc) {
      setBackgroundNetworksCount(null);
      return undefined;
    }
    setBackgroundNetworksCount(null);
    const timer = window.setTimeout(() => {
      try {
        const d = deriveNetworks(doc);
        setBackgroundNetworksCount(d.vlanRows.length + d.subnetRows.length + d.dockerNetworkRows.length);
      } catch {
        setBackgroundNetworksCount(0);
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [doc]);
  const networksCount =
    kind === 'networks'
      ? networksDerived.vlanRows.length + networksDerived.subnetRows.length + networksDerived.dockerNetworkRows.length
      : backgroundNetworksCount;

  // ADR-0046 §2: "Nothing in a list is typed" — every count below is read
  // off the live document, never a literal — a live `Chassis`/`Cable`/`PhysicalPort`
  // node, counted regardless of where (or whether) it is placed, so the
  // rail's own number and the grid's own row count can never disagree about
  // what a "device" is.
  const counts: Record<Kind, number | null> = useMemo(() => {
    if (!doc) return { devices: 0, racks: 0, cables: 0, ports: 0, networks: 0 };
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
    return {
      devices,
      racks: view.racks.length,
      cables,
      ports,
      networks: networksCount,
    };
  }, [doc, view.racks.length, networksCount]);

  // ADR-0047: absent, not empty, when nothing is selected (see RacksPlace).
  // The Networks kind owns its right-hand panel (the Add network editor,
  // `NetworksPanel`'s layout) rather than this shared one — a network
  // row is not a `Selection` (ADR-0058, `NetworksPanel.tsx`'s header
  // note), so `EditorFor` is not asked for it.
  const selectedPanel =
    doc != null && kind !== 'networks'
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

  return (
    <Shell {...shellProps} lens={lens} editor={editorPane} viewOnly={!canDraw}>
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
                    <span className="inventory-place__count">{counts[k.key] ?? '…'}</span>
                  </button>
                </li>
              ))}
            </ul>
            <div className="inventory-place__rail-title">Saved filters</div>
            <p className="inventory-place__muted">Saved filters are not built yet.</p>
          </nav>

          <div className={kind === 'networks' ? 'inventory-place__main inventory-place__main--flush' : 'inventory-place__main'}>
            {kind === 'networks' ? (
              doc != null ? <NetworksPanel doc={doc} derived={networksDerived} view={view} applyDocChange={applyDocChange} canDraw={canDraw} /> : null
            ) : kind !== 'devices' ? (
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
