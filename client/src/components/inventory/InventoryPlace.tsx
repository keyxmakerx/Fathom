import { useCallback, useEffect, useMemo, useState } from 'react';

import { getSession } from '../../state/sessionState';
import { viewOf, type ClosetView } from '../../document/view';
import { deriveNetworks, type NetworksDerived } from '../../document/networks-derive';
import type { DesignSession } from '../design/useDesignSession';
import { cableEndText } from '../drawing/Editor';
import { EditorFor, type FieldsActions, type NotesActions, type Selection, type TagsActions } from '../drawing';
import { paletteFromCatalogue } from '../racks/palette';
import { Shell } from '../Shell';
import type { ShellProps } from '../shell/types';
import { DataTable, type Sort } from './DataTable';
import { ItemPage } from './ItemPage';
import type { FieldDefView } from '../../document/fields';
import { ListToolbar, type Filter } from './ListToolbar';
import { NetworksPanel } from './NetworksPanel';
import { PasteDialog } from './PasteDialog';
import {
  CAN_ADD,
  KINDS,
  addThing,
  addressRows,
  allColumns,
  applyCellEdits,
  cableRows,
  defaultColumnKeys,
  deviceRows,
  interfaceRows,
  rackRows,
  type CellEdit,
  type Column,
  type InvRow,
  type Kind,
} from './kinds';
import './inventory.css';

const EMPTY_VIEW: ClosetView = { premisesId: '', racks: [], cables: [], rows: [], surfaces: [], unplaced: [], free: [], lines: [], labels: [] };
const EMPTY_NETWORKS_DERIVED: NetworksDerived = { vlanRows: [], subnetRows: [], dockerNetworkRows: [], dockerUnattachedContainers: [] };

export interface InventoryPlaceProps extends Omit<ShellProps, 'editor' | 'rail' | 'children'> {
  session: DesignSession;
  /** "Show on canvas": switches the place to the canvas with `selection` chosen. */
  onShowOnRack: (selection: Selection) => void;
  /** What is selected, by element id, for presence (ADR-0063 §12). */
  onSelectedChange?: (id: string | null) => void;
  notesActions: NotesActions;
  tagsActions: TagsActions;
  fieldsActions: FieldsActions;
  /** The organisation's field definitions (ADR-0062). */
  fieldDefs: readonly FieldDefView[];
  /** Runs pasted text through the redaction gate (CLAUDE.md rule 4). */
  redact: (text: string) => Promise<string>;
  accountId: string | null;
}

function columnPrefsKey(kind: Kind): string {
  return `fathom.inventory.columns.${kind}`;
}

function loadColumnPrefs(kind: Kind): string[] | null {
  try {
    const raw = window.localStorage.getItem(columnPrefsKey(kind));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return Array.isArray(parsed) && parsed.every((x) => typeof x === 'string') ? (parsed as string[]) : null;
  } catch {
    return null;
  }
}

function saveColumnPrefs(kind: Kind, keys: string[]): void {
  try {
    window.localStorage.setItem(columnPrefsKey(kind), JSON.stringify(keys));
  } catch {
    // Storage can be blocked; the choice then lasts only this visit.
  }
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function matches(row: InvRow, filter: Filter): boolean {
  const needle = filter.value.trim().toLowerCase();
  if (needle === '') return true;
  if (filter.col === '*') return Object.values(row.cells).some((v) => v.toLowerCase().includes(needle));
  return (row.cells[filter.col] ?? '').toLowerCase().includes(needle);
}

/**
 * Inventory (ADR-0062): kinds down the left, a table in the middle, the selected thing's page
 * beside it. Every edit goes through the same document commands the canvas editor uses.
 */
export function InventoryPlace(props: InventoryPlaceProps) {
  const { session, onShowOnRack, onSelectedChange, notesActions, tagsActions, fieldsActions, fieldDefs, redact, accountId, lens, ...shellProps } = props;
  const { doc, catalogue, loadError, saveRefusal, canDraw, handleEdit, applyDocChange, reloadDesign } = session;

  const [kind, setKind] = useState<Kind>('devices');
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [override, setOverride] = useState<Selection | null>(null);
  const [filters, setFilters] = useState<Filter[]>([]);
  const [sort, setSort] = useState<Sort | null>(null);
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [lastChecked, setLastChecked] = useState<string | null>(null);
  const [prefs, setPrefs] = useState<string[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pasteText, setPasteText] = useState<string | null>(null);

  const view = useMemo<ClosetView>(() => (doc ? viewOf(doc, catalogue) : EMPTY_VIEW), [doc, catalogue]);
  const endText = useCallback((end: Parameters<typeof cableEndText>[1]) => cableEndText(view, end), [view]);

  // Networks and addresses share one derivation, computed only when one of them is shown, and a
  // debounced one for the rail counts.
  const networksDerived = useMemo(() => {
    if (!doc || (kind !== 'networks' && kind !== 'addresses')) return EMPTY_NETWORKS_DERIVED;
    try {
      return deriveNetworks(doc);
    } catch {
      return EMPTY_NETWORKS_DERIVED;
    }
  }, [doc, kind]);
  const [background, setBackground] = useState<{ networks: number; addresses: number } | null>(null);
  useEffect(() => {
    if (!doc) return undefined;
    const timer = window.setTimeout(() => {
      try {
        const d = deriveNetworks(doc);
        setBackground({
          networks: d.vlanRows.length + d.subnetRows.length + d.dockerNetworkRows.length,
          addresses: d.subnetRows.reduce((n, s) => n + s.members.length, 0),
        });
      } catch {
        setBackground({ networks: 0, addresses: 0 });
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [doc]);

  const rowsByKind = useMemo(() => {
    if (!doc) return { devices: [], racks: [], cables: [], interfaces: [] } as Record<string, InvRow[]>;
    return {
      devices: deviceRows(doc, view, fieldDefs),
      racks: rackRows(doc, view, fieldDefs),
      cables: cableRows(doc, view, endText, fieldDefs),
      interfaces: interfaceRows(doc, view, endText, fieldDefs),
    } as Record<string, InvRow[]>;
  }, [doc, view, endText, fieldDefs]);

  const baseRows = useMemo<InvRow[]>(() => {
    if (!doc) return [];
    if (kind === 'addresses') {
      const labelOf = (id: string) => rowsByKind.devices?.find((r) => r.deviceNodeId === id)?.title ?? id;
      return addressRows(doc, networksDerived.subnetRows, labelOf);
    }
    return rowsByKind[kind] ?? [];
  }, [doc, kind, rowsByKind, networksDerived]);

  const counts: Record<Kind, number | null> = {
    devices: rowsByKind.devices?.length ?? 0,
    racks: rowsByKind.racks?.length ?? 0,
    cables: rowsByKind.cables?.length ?? 0,
    interfaces: rowsByKind.interfaces?.length ?? 0,
    networks: kind === 'networks' ? networksDerived.vlanRows.length + networksDerived.subnetRows.length + networksDerived.dockerNetworkRows.length : (background?.networks ?? null),
    addresses: kind === 'addresses' ? baseRows.length : (background?.addresses ?? null),
  };

  const columnsAll = useMemo(() => allColumns(kind, fieldDefs), [kind, fieldDefs]);
  const columns = useMemo<Column[]>(() => {
    const keys = prefs ?? loadColumnPrefs(kind) ?? defaultColumnKeys(kind, lens);
    const byKey = new Map(columnsAll.map((c) => [c.key, c]));
    const picked = keys.map((k) => byKey.get(k)).filter((c): c is Column => c !== undefined);
    return picked.length > 0 ? picked : columnsAll.slice(0, 4);
  }, [columnsAll, prefs, kind, lens]);

  const rows = useMemo(() => {
    let out = baseRows.filter((r) => filters.every((f) => matches(r, f)));
    if (sort) {
      const dir = sort.dir === 'asc' ? 1 : -1;
      out = [...out].sort((a, b) => dir * collator.compare(a.cells[sort.key] ?? '', b.cells[sort.key] ?? ''));
    }
    return out;
  }, [baseRows, filters, sort]);

  const switchKind = (next: Kind) => {
    setKind(next);
    setOpenKey(null);
    setOverride(null);
    setFilters([]);
    setSort(null);
    setChecked(new Set());
    setPrefs(null);
    setNotice(null);
  };

  const openRow = openKey ? (rows.find((r) => r.key === openKey) ?? null) : null;
  const pageSelection = override ?? openRow?.selection ?? null;
  const selectedId = pageSelection?.id ?? null;
  useEffect(() => {
    onSelectedChange?.(selectedId);
  }, [onSelectedChange, selectedId]);

  const ctx = useMemo(() => ({ catalogue, actor: getSession()?.accountId, defs: fieldDefs }), [catalogue, fieldDefs]);

  const commitEdits = (edits: CellEdit[]): string | void => {
    if (!doc) return;
    const result = applyCellEdits(doc, kind, edits, ctx);
    if (result.refused.length > 0 && result.changed <= 0) return result.refused[0];
    if (result.doc !== doc) applyDocChange(result.doc);
    if (result.refused.length > 0) setNotice(`${result.refused.length} not changed: ${result.refused.slice(0, 3).join('; ')}`);
    else setNotice(null);
  };

  const onCommit = (row: InvRow, col: Column, value: string) => commitEdits([{ row, col, value }]);

  const onAdd = (name: string): string | void => {
    if (!doc) return;
    try {
      const made = addThing(doc, kind, name, view.premisesId === '' ? null : view.premisesId, ctx);
      applyDocChange(made.doc);
      setOpenKey(made.row.key);
      setOverride(null);
      setNotice(null);
    } catch (e) {
      return e instanceof Error ? e.message : 'That was refused.';
    }
  };

  const toggleChecked = (row: InvRow, shift: boolean) => {
    const next = new Set(checked);
    if (shift && lastChecked) {
      const a = rows.findIndex((r) => r.key === lastChecked);
      const b = rows.findIndex((r) => r.key === row.key);
      if (a >= 0 && b >= 0) {
        for (let i = Math.min(a, b); i <= Math.max(a, b); i += 1) next.add(rows[i]!.key);
        setChecked(next);
        return;
      }
    }
    if (next.has(row.key)) next.delete(row.key);
    else next.add(row.key);
    setLastChecked(row.key);
    setChecked(next);
  };

  const checkedRows = rows.filter((r) => checked.has(r.key));

  const editorActions = {
    onEdit: canDraw ? handleEdit : undefined,
    onSelect: (s: Selection) => setOverride(s),
    notesOf: notesActions.notesOf,
    onAddNote: canDraw ? notesActions.onAddNote : undefined,
    onRemoveNote: canDraw ? notesActions.onRemoveNote : undefined,
    tagsOf: tagsActions.tagsOf,
    allTags: tagsActions.allTags,
    onAddTag: canDraw ? tagsActions.onAddTag : undefined,
    onRemoveTag: canDraw ? tagsActions.onRemoveTag : undefined,
    onRenameTag: canDraw ? tagsActions.onRenameTag : undefined,
    fieldsOf: fieldsActions.fieldsOf,
    onSetField: canDraw ? fieldsActions.onSetField : undefined,
    onAddFieldDef: canDraw ? fieldsActions.onAddFieldDef : undefined,
    onRemoveFieldDef: canDraw ? fieldsActions.onRemoveFieldDef : undefined,
  };

  const palette = useMemo(() => paletteFromCatalogue(catalogue), [catalogue]);
  const showPage = doc != null && kind !== 'networks' && pageSelection != null && EditorFor(pageSelection, view, {}, palette) != null;

  const page =
    showPage && pageSelection ? (
      <ItemPage
        key={override ? `${override.kind}:${override.id}` : openKey ?? ''}
        doc={doc}
        view={view}
        selection={pageSelection}
        ownerId={override ? ownerOfSelection(override) : (openRow?.ownerId ?? null)}
        title={override ? `${override.kind} ${override.id.slice(-6)}` : (openRow?.title ?? '')}
        actions={editorActions}
        palette={palette}
        accountId={accountId}
        onShowOnCanvas={() => onShowOnRack(pageSelection)}
        backLabel={override ? (openRow?.title ?? 'Back') : null}
        onBack={() => setOverride(null)}
      />
    ) : null;

  const refusal =
    saveRefusal != null ? (
      <div className="inventory-place__refusal">
        {saveRefusal}
        <button type="button" className="inventory-place__refusal-reload" onClick={reloadDesign}>
          Reload
        </button>
      </div>
    ) : null;

  return (
    <Shell {...shellProps} lens={lens} editor={null} viewOnly={!canDraw}>
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
                    onClick={() => switchKind(k.key)}
                  >
                    <span>{k.label}</span>
                    <span className="inventory-place__count">{counts[k.key] ?? '…'}</span>
                  </button>
                </li>
              ))}
            </ul>
          </nav>

          {kind === 'networks' ? (
            <div className="inventory-place__main inventory-place__main--flush">
              <NetworksPanel doc={doc} derived={networksDerived} view={view} applyDocChange={applyDocChange} canDraw={canDraw} />
            </div>
          ) : (
            <>
              <div className="inv-list">
                {refusal}
                <ListToolbar
                  kindLabel={KINDS.find((k) => k.key === kind)!.label}
                  columnsAll={columnsAll}
                  columns={columns}
                  onColumns={(keys) => {
                    setPrefs(keys);
                    saveColumnPrefs(kind, keys);
                  }}
                  filters={filters}
                  onFilters={setFilters}
                  canAdd={canDraw && CAN_ADD.has(kind)}
                  addHint={kind === 'cables' ? 'Draw cables on the canvas.' : kind === 'interfaces' ? 'Interfaces come with a device.' : kind === 'addresses' ? 'Addresses are read from your devices.' : ''}
                  onAdd={onAdd}
                  onPaste={canDraw && (kind === 'devices' || kind === 'racks' || kind === 'cables' || kind === 'interfaces') ? () => setPasteText('') : undefined}
                  checkedRows={checkedRows}
                  bulkColumns={columnsAll.filter((c) => c.editable)}
                  onBulk={canDraw ? (edits) => commitEdits(edits) : undefined}
                  onClearChecked={() => setChecked(new Set())}
                  notice={notice}
                />
                <div
                  className="inv-list__grid"
                  onPaste={(e) => {
                    const target = e.target as HTMLElement;
                    if (!canDraw || target.tagName === 'INPUT' || target.tagName === 'SELECT') return;
                    const text = e.clipboardData.getData('text/plain');
                    if (/[\t\n]/.test(text)) {
                      e.preventDefault();
                      setPasteText(text);
                    }
                  }}
                >
                  <DataTable
                    columns={columns}
                    rows={rows}
                    openKey={openKey}
                    checked={checked}
                    sort={sort}
                    canEdit={canDraw}
                    onCommit={onCommit}
                    onFilterTag={(tag) => setFilters((f) => (f.some((x) => x.col === 'tags' && x.value === tag) ? f : [...f, { col: 'tags', value: tag }]))}
                    onOpen={(row) => {
                      setOpenKey(row.key);
                      setOverride(null);
                    }}
                    onToggleChecked={toggleChecked}
                    onToggleAll={(all) => setChecked(all ? new Set(rows.map((r) => r.key)) : new Set())}
                    onSort={(key) =>
                      setSort((s) => (s?.key !== key ? { key, dir: 'asc' } : s.dir === 'asc' ? { key, dir: 'desc' } : null))
                    }
                    emptyText={baseRows.length === 0 ? `No ${kind} yet.` : 'Nothing matches the filters.'}
                  />
                </div>
              </div>
              {kind === 'addresses' ? <AddressNote row={openRow} onOpenDevice={() => switchKind('devices')} /> : page}
            </>
          )}
          {pasteText !== null ? (
            <PasteDialog
              initialText={pasteText}
              kindLabel={KINDS.find((k) => k.key === kind)!.label}
              columns={columnsAll.filter((c) => c.editable)}
              rows={baseRows}
              canAdd={CAN_ADD.has(kind)}
              redact={redact}
              onCancel={() => setPasteText(null)}
              onApply={(plan) => {
                let working = doc;
                const refused: string[] = [];
                const edits: CellEdit[] = [];
                for (const add of plan.adds) {
                  try {
                    const made = addThing(working, kind, add.name, view.premisesId === '' ? null : view.premisesId, ctx);
                    working = made.doc;
                    for (const e of add.edits) edits.push({ row: made.row, col: e.col, value: e.value });
                  } catch (e) {
                    refused.push(`${add.name}: ${e instanceof Error ? e.message : 'refused'}`);
                  }
                }
                for (const u of plan.updates) for (const e of u.edits) edits.push({ row: u.row, col: e.col, value: e.value });
                const result = applyCellEdits(working, kind, edits, ctx);
                refused.push(...result.refused);
                applyDocChange(result.doc);
                setPasteText(null);
                setNotice(
                  `Pasted: ${plan.adds.length} added, ${plan.updates.length} updated${refused.length ? `, ${refused.length} not changed: ${refused.slice(0, 3).join('; ')}` : ''}.`,
                );
              }}
            />
          ) : null}
        </div>
      )}
    </Shell>
  );
}

function ownerOfSelection(s: Selection): string | null {
  if (s.kind === 'rack' || s.kind === 'cable' || s.kind === 'port') return s.id;
  return null;
}

function AddressNote({ row, onOpenDevice }: { row: InvRow | null; onOpenDevice: () => void }) {
  if (!row) return null;
  return (
    <aside className="shell-editor inv-page" aria-label="Address">
      <div className="inv-page__head">
        <span className="inv-page__title">{row.title}</span>
      </div>
      <div className="inv-page__body">
        <p className="inv-page__muted">
          On {row.cells.device} · {row.cells.interface} in {row.cells.subnet}.
        </p>
        <button type="button" onClick={onOpenDevice}>
          Go to Devices
        </button>
      </div>
    </aside>
  );
}
