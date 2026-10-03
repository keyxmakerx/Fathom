import { useEffect, useMemo, useRef, useState } from 'react';

import { getSession } from '../../state/sessionState';
import { viewOfAll, type ClosetView } from '../../document/view';
import { deriveNetworks, type NetworksDerived } from '../../document/networks-derive';
import { deriveIpam, type IpamDerived } from '../../document/ipam';
import { pastePrefixRows, pasteVlanRows } from '../../document/ipam-write';
import { type DesignSession } from '../design/useDesignSession';
import { useCorrections } from '../design/useCorrections';
import { WaitingPage, type CorrectionsApi } from './CableCorrections';
import { applyCorrection, whyNotApplicable } from './corrections';
import { EditorFor, type FieldsActions, type NotesActions, type Selection, type TagsActions } from '../drawing';
import { paletteFromCatalogue } from '../racks/palette';
import { Shell } from '../Shell';
import type { ShellProps } from '../shell/types';
import { DataTable } from './DataTable';
import { ItemPage } from './ItemPage';
import type { FieldFor, FieldType } from '../../api/fieldDefinitions';
import { ImportDialog } from '../import/ImportDialog';
import type { FieldDefView } from '../../document/fields';
import { ListToolbar } from './ListToolbar';
import { isKind } from './kinds';
import { nextSorts, setSort, sortRows } from './sorting';
import { ColumnMenu } from './ColumnMenu';
import { ListFoot } from './ListFoot';
import { PROGRESS_FROM, applyPlan, applyPlanChunked, bulkStillUndoable, dryRun, keepSelected, type BulkPlan } from './bulk';
import { undo as undoBatch } from '../../document/undo';
import { schemaFor, filterRows, type QuerySchema } from './rowQuery';
import { joinUnits, quoteValue, units } from './query';
import { useListState } from './useListState';
import { linkTarget } from './links';
import { listKey, loadMemory, saveMemory, type ListMemory } from './listView';
import { placeLabel, type ListState } from './listState';
import { FindBox } from './FindBox';
import { buildSearchIndex, type Hit } from './search';
import { WhereBar } from './WhereBar';
import { buildPlaceIndex, hasWhere, inWhere, NO_WHERE, whereOptions } from './placeIndex';
import { FilterLine } from './FilterLine';
import { ListHead } from './ListHead';
import { SideList } from './SideList';
import { PINNED_VIEWS, addMine, loadMine, removeMine, saveMine, updateMine, type SavedView } from './views';
import { NetworksPanel } from './NetworksPanel';
import { AddPrefixForm, AddVlanForm, PrefixPage, VlanPage } from './IpamPages';
import { PasteDialog, type CustomPaste } from './PasteDialog';
import { PasteGateBoundary } from '../paste/PasteGateBoundary';
import {
  CAN_ADD,
  FACETS,
  KINDS,
  addThing,
  addressRows,
  allColumns,
  applyCellEdits,
  cableRows,
  defaultColumnKeys,
  deviceRows,
  portRows,
  prefixRows,
  rackRows,
  vlanKindRows,
  type CellEdit,
  type Column,
  type InvRow,
  type Kind,
} from './kinds';
import './inventory.css';

const EMPTY_VIEW: ClosetView = { premisesId: '', racks: [], cables: [], rows: [], surfaces: [], unplaced: [], free: [], lines: [], labels: [] };
const EMPTY_NETWORKS_DERIVED: NetworksDerived = { vlanRows: [], subnetRows: [], dockerNetworkRows: [], dockerUnattachedContainers: [] };
const EMPTY_IPAM: IpamDerived = { prefixes: [], vlans: [] };
/** Kinds read off the network derivation. */
const NETWORK_KINDS: ReadonlySet<Kind> = new Set<Kind>(['networks', 'addresses', 'prefixes', 'vlans']);

export interface InventoryPlaceProps extends Omit<ShellProps, 'editor' | 'rail' | 'children'> {
  session: DesignSession;
  /** "Show on canvas": switches the place to the canvas with `selection` chosen. */
  onShowOnRack: (selection: Selection) => void;
  notesActions: NotesActions;
  tagsActions: TagsActions;
  fieldsActions: FieldsActions;
  /** The organisation's field definitions (ADR-0062). */
  fieldDefs: readonly FieldDefView[];
  /** Makes an organisation-wide field (the importer's new columns). */
  createField: (kind: FieldFor, name: string, type: FieldType) => Promise<{ refused: string } | void>;
  /** Runs pasted text through the redaction gate (CLAUDE.md rule 4). */
  redact: (text: string) => Promise<string>;
  accountId: string | null;
  /** The organisation the design is in, for the corrections store. */
  organisationId: string;
}

/** Lets the page paint before the next step of a long job. */
const nextPaint = (): Promise<void> =>
  new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => setTimeout(resolve, 0));
    else setTimeout(resolve, 0);
  });

function kindLabelOf(kind: Kind): string {
  return KINDS.find((k) => k.key === kind)?.label ?? kind;
}

function kindWord(kind: Kind): string {
  return KINDS.find((k) => k.key === kind)?.label.toLowerCase() ?? 'this list';
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

/**
 * Inventory (ADR-0062): kinds down the left, a table in the middle, the selected thing's page
 * beside it. Every edit goes through the same document commands the canvas editor uses.
 */
export function InventoryPlace(props: InventoryPlaceProps) {
  const { session, onShowOnRack, notesActions, tagsActions, fieldsActions, fieldDefs, createField, redact, accountId, organisationId, lens, ...shellProps } = props;
  const { doc, catalogue, loadError, saveRefusal, canDraw, handleEdit, applyDocChange, reloadDesign } = session;

  const { ls, go, back: stepBack, backLabel, moves } = useListState();
  const kind: Kind = isKind(ls.kind) ? ls.kind : 'devices';
  const openKey = ls.open || null;
  const q = ls.q;
  const sorts = ls.sorts;
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [lastChecked, setLastChecked] = useState<string | null>(null);
  /** Where the list was scrolled to, so Back returns there. */
  const scrollTop = useRef(0);
  /** The row last opened, marked when the list comes back. */
  const [lastOpened, setLastOpened] = useState<string | null>(null);
  // Back, Forward, a reload and Back-after-Find put the list's scroll and ticks back from the
  // session's memory of that list (listView.ts). The first render counts as a move.
  const [seenMoves, setSeenMoves] = useState(-1);
  if (seenMoves !== moves) {
    setSeenMoves(moves);
    const m = loadMemory(window.sessionStorage, listKey(ls));
    scrollTop.current = m?.top ?? 0;
    setChecked(new Set(m?.checked ?? []));
    setLastOpened(m?.lastOpened ?? null);
  }
  const [prefs, setPrefs] = useState<string[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pasteText, setPasteText] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  // The design as it was when the importer opened, and as it is now (the dialog's callback is old by
  // the time a long import finishes). An import is applied only to the design it was made against.
  const importBase = useRef<typeof doc>(null);
  const liveDoc = useRef(doc);
  liveDoc.current = doc;
  const [addingRaw, setAdding] = useState<'prefix' | 'vlan' | 'waiting' | null>(null);
  // Opening a page (a link, Back, a pasted address) puts away the form or list that was shown in its place.
  const adding = openKey ? null : addingRaw;
  const [mine, setMine] = useState<SavedView[]>(loadMine);

  const corrections = useCorrections(organisationId, session.designId);

  const view = useMemo<ClosetView>(() => (doc ? viewOfAll(doc, catalogue) : EMPTY_VIEW), [doc, catalogue]);
  const placeIdx = useMemo(() => buildPlaceIndex(doc, view), [doc, view]);

  // Networks, addresses, prefixes and VLANs share one derivation, computed only when one of them
  // is shown, and a debounced one for the rail counts.
  const networksDerived = useMemo(() => {
    if (!doc || !NETWORK_KINDS.has(kind)) return EMPTY_NETWORKS_DERIVED;
    try {
      return deriveNetworks(doc);
    } catch {
      return EMPTY_NETWORKS_DERIVED;
    }
  }, [doc, kind]);
  const ipam = useMemo(() => {
    if (!doc || (kind !== 'prefixes' && kind !== 'vlans')) return EMPTY_IPAM;
    try {
      return deriveIpam(doc, networksDerived);
    } catch {
      return EMPTY_IPAM;
    }
  }, [doc, kind, networksDerived]);
  const [background, setBackground] = useState<{ networks: number; addresses: number; prefixes: InvRow[]; vlans: InvRow[]; prefixData: IpamDerived['prefixes'] } | null>(null);
  useEffect(() => {
    if (!doc) return undefined;
    const timer = window.setTimeout(() => {
      try {
        const d = deriveNetworks(doc);
        const derived = deriveIpam(doc, d);
        setBackground({
          networks: d.vlanRows.length + d.subnetRows.length + d.dockerNetworkRows.length,
          addresses: d.subnetRows.reduce((n, s) => n + s.members.length, 0),
          prefixes: prefixRows(derived.prefixes),
          vlans: vlanKindRows(derived.vlans),
          prefixData: derived.prefixes,
        });
      } catch {
        setBackground({ networks: 0, addresses: 0, prefixes: [], vlans: [], prefixData: [] });
      }
    }, 250);
    return () => window.clearTimeout(timer);
  }, [doc]);

  const rowsByKind = useMemo(() => {
    if (!doc) return { devices: [], racks: [], cables: [], ports: [] } as Record<string, InvRow[]>;
    return {
      devices: deviceRows(doc, view, fieldDefs, placeIdx),
      racks: rackRows(doc, view, fieldDefs, placeIdx),
      cables: cableRows(doc, view, placeIdx, fieldDefs),
      ports: portRows(doc, view, placeIdx, fieldDefs),
    } as Record<string, InvRow[]>;
  }, [doc, view, placeIdx, fieldDefs]);

  // Where: counts, lists and search all follow it (listState.where).
  const where = ls.where;
  const whereOn = hasWhere(where);
  const whereOpts = useMemo(() => whereOptions(placeIdx.racks.values(), where), [placeIdx, where]);
  const scoped = useMemo(() => {
    if (!whereOn) return rowsByKind;
    const out: Record<string, InvRow[]> = {};
    for (const k of Object.keys(rowsByKind)) out[k] = rowsByKind[k]!.filter((r) => inWhere(r.places, where));
    return out;
  }, [rowsByKind, where, whereOn]);

  const baseRows = useMemo<InvRow[]>(() => {
    if (!doc) return [];
    if (kind === 'addresses') {
      const labelOf = (id: string) => rowsByKind.devices?.find((r) => r.deviceNodeId === id)?.title ?? id;
      return addressRows(doc, networksDerived.subnetRows, labelOf);
    }
    if (kind === 'prefixes') return prefixRows(ipam.prefixes).filter((r) => inWhere(r.places, where));
    if (kind === 'vlans') return vlanKindRows(ipam.vlans).filter((r) => inWhere(r.places, where));
    return scoped[kind] ?? [];
  }, [doc, kind, rowsByKind, scoped, networksDerived, ipam, where]);

  const kindLabel = KINDS.find((k) => k.key === kind)!.label;
  // A page opens from the whole design, not the Where-narrowed list: a link can lead outside Where.
  const openRow = openKey ? ((rowsByKind[kind] ?? baseRows).find((r) => r.key === openKey) ?? baseRows.find((r) => r.key === openKey) ?? null) : null;

  // Writes what the list on screen remembers (scroll, ticks, the row opened) before it is left.
  const checkedRef = useRef(checked);
  checkedRef.current = checked;
  const lastOpenedRef = useRef(lastOpened);
  lastOpenedRef.current = lastOpened;
  const rememberList = (extra?: Partial<ListMemory>) =>
    saveMemory(window.sessionStorage, listKey(ls), { top: scrollTop.current, checked: [...checkedRef.current], lastOpened: lastOpenedRef.current, ...extra });
  const scrollSave = useRef<number | null>(null);
  const here = listKey(ls);
  useEffect(() => {
    if (!openKey && !adding) rememberList();
  }, [checked, lastOpened, here]); // eslint-disable-line react-hooks/exhaustive-deps -- remember on a tick or a move, not on every render.
  /** A move to another page or list: a new history entry whose Back goes to where this was. */
  const push = (patch: Partial<ListState>, extra?: Partial<ListMemory>) => {
    if (!openKey) rememberList(extra);
    if (extra?.lastOpened !== undefined) setLastOpened(extra.lastOpened);
    go(patch, 'push', hereLabel);
  };

  const scopedCount = (rows: readonly InvRow[] | undefined): number | null => (rows ? rows.filter((r) => inWhere(r.places, where)).length : null);

  const counts: Record<Kind, number | null> = {
    devices: scoped.devices?.length ?? 0,
    racks: scoped.racks?.length ?? 0,
    cables: scoped.cables?.length ?? 0,
    ports: scoped.ports?.length ?? 0,
    networks: kind === 'networks' ? networksDerived.vlanRows.length + networksDerived.subnetRows.length + networksDerived.dockerNetworkRows.length : (background?.networks ?? null),
    prefixes: kind === 'prefixes' ? baseRows.length : scopedCount(background?.prefixes),
    vlans: kind === 'vlans' ? baseRows.length : scopedCount(background?.vlans),
    addresses: kind === 'addresses' ? baseRows.length : (background?.addresses ?? null),
  };

  // Find anything reads the whole design, Where applied afterwards so it can say what it hid.
  const [findArmed, setFindArmed] = useState(false);
  const [findSlot, setFindSlot] = useState<HTMLDivElement | null>(null);
  const searchIndex = useMemo(
    () =>
      findArmed || ls.find
        ? buildSearchIndex({ devices: rowsByKind.devices ?? [], ports: rowsByKind.ports ?? [], racks: rowsByKind.racks ?? [], cables: rowsByKind.cables ?? [], idx: placeIdx, prefixes: background?.prefixData, vlans: background?.vlans })
        : null,
    [findArmed, ls.find, rowsByKind, placeIdx, background],
  );
  const openHit = (h: Hit) => {
    setPrefs(null);
    setNotice(null);
    setAdding(null);
    push({ kind: h.kind, q: '', sorts: [], view: '', open: h.row.key, tab: '', find: '' });
  };

  const columnsAll = useMemo(() => allColumns(kind, fieldDefs), [kind, fieldDefs]);
  const columns = useMemo<Column[]>(() => {
    const keys = prefs ?? loadColumnPrefs(kind) ?? defaultColumnKeys(kind, lens);
    const byKey = new Map(columnsAll.map((c) => [c.key, c]));
    const picked = keys.map((k) => byKey.get(k)).filter((c): c is Column => c !== undefined);
    return picked.length > 0 ? picked : columnsAll.slice(0, 4);
  }, [columnsAll, prefs, kind, lens]);

  const schema = useMemo(() => schemaFor(kindWord(kind), columnsAll, FACETS[kind] ?? []), [kind, columnsAll]);
  const filtered = useMemo(() => filterRows(baseRows, schema, q), [baseRows, schema, q]);
  const rows = useMemo(() => sortRows(filtered.rows, sorts), [filtered, sorts]);

  const allViews = useMemo(() => [...PINNED_VIEWS, ...mine], [mine]);
  const currentView = ls.view ? allViews.find((v) => v.id === ls.view && v.kind === kind) : undefined;
  /** The place being left, as the next entry's Back label: the open item's name, else the saved view, else the kind. */
  const hereLabel = openKey ? placeLabel({ openTitle: openRow?.title, kindLabel }) : placeLabel({ viewName: currentView?.name, kindLabel });
  const kindSchemas = useMemo(() => {
    const out: Partial<Record<Kind, QuerySchema>> = {};
    for (const k of ['devices', 'ports', 'racks', 'cables'] as const) out[k] = schemaFor(kindWord(k), allColumns(k, fieldDefs), FACETS[k] ?? []);
    return out;
  }, [fieldDefs]);
  const viewCounts = useMemo(() => {
    const m = new Map<string, number>();
    for (const v of allViews) {
      const k = v.kind as Kind;
      const rs = k === kind ? baseRows : scoped[k];
      const sc = k === kind ? schema : kindSchemas[k];
      if (rs && sc) m.set(v.id, filterRows(rs, sc, v.q).rows.length);
    }
    return m;
  }, [allViews, kind, baseRows, schema, scoped, kindSchemas]);

  const onView = (v: SavedView) => {
    push({ kind: v.kind, q: v.q, sorts: v.sorts, view: v.id, open: '', tab: '' });
    setPrefs(null);
    setNotice(null);
    setAdding(null);
  };
  const onSaveAs = (name: string) => {
    const id = `m${Date.now().toString(36)}`;
    const next = addMine(mine, kind, name, q, sorts, id);
    setMine(next);
    saveMine(next);
    const made = next.find((v) => v.id === id) ?? next.find((v) => v.name === (name.trim() || 'My view'));
    go({ view: made?.id ?? id });
    setNotice(`Saved “${name.trim() || 'My view'}” under ${kindLabelOf(kind)}.`);
  };
  const onUpdateView = () => {
    if (!currentView) return;
    const next = updateMine(mine, currentView.id, q, sorts);
    setMine(next);
    saveMine(next);
  };
  const onRemoveView = (v: SavedView) => {
    const next = removeMine(mine, v.id);
    setMine(next);
    saveMine(next);
    if (ls.view === v.id) go({ view: '' });
  };

  const switchKind = (next: Kind) => {
    push({ kind: next, q: '', sorts: [], view: '', open: '', tab: '' });
    setPrefs(null);
    setNotice(null);
    setAdding(null);
  };

  const openPage = (row: InvRow) => {
    push({ open: row.key, tab: '' }, { lastOpened: row.key });
  };

  /** One step back, as the browser's Back button does; the label says where it goes. */
  const closePage = () => {
    setAdding(null);
    if (openKey) stepBack();
  };

  const pageSelection = openRow?.selection ?? null;

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

  // A previewed bulk change is written as one undo step, and the notice carries an Undo for it.
  const [bulkUndo, setBulkUndo] = useState<{ id: string; notice: string } | null>(null);
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);
  const finishBulk = (r: ReturnType<typeof applyPlan>, title: string): string | void => {
    if (r.changed <= 0) return r.refused[0] ?? 'Nothing changed.';
    applyDocChange(r.doc);
    const text = `${title} on ${r.changed.toLocaleString('en-GB')} ${kindLabel.toLowerCase()}.${r.refused.length ? ` ${r.refused.length} not changed: ${r.refused.slice(0, 3).join('; ')}` : ''}`;
    setNotice(text);
    setBulkUndo(r.batchId ? { id: r.batchId, notice: text } : null);
  };
  const onBulkApply = (plan: BulkPlan): string | void | Promise<string | void> => {
    if (!doc || bulkProgress) return;
    // Only rows ticked now (and still listed) are written, whatever the preview held.
    const live = keepSelected(plan, new Set(checkedRows.map((r) => r.key)));
    if (live.edits.length === 0) return 'Nothing is ticked that this would change.';
    if (live.edits.length <= PROGRESS_FROM) return finishBulk(applyPlan(doc, kind, live, ctx), live.title);
    // A big change is written in steps with a progress line, and is still one undo step.
    const base = doc;
    setBulkProgress({ done: 0, total: live.edits.length });
    return (async () => {
      try {
        const r = await applyPlanChunked(base, kind, live, ctx, {
          onProgress: (done, total) => setBulkProgress({ done, total }),
          yieldToUi: nextPaint,
        });
        if (liveDoc.current !== base) return 'The design changed while this was being written. Nothing was applied; try again.';
        return finishBulk(r, live.title);
      } finally {
        setBulkProgress(null);
      }
    })();
  };
  const runBulkUndo = () => {
    if (!doc || !bulkUndo || !accountId) return;
    if (!bulkStillUndoable(doc, bulkUndo.id)) {
      setBulkUndo(null);
      setNotice('That change was already undone.');
      return;
    }
    try {
      applyDocChange(undoBatch(doc, bulkUndo.id, { actor: accountId, now: Date.now() }));
      setBulkUndo(null);
      setNotice('Undone.');
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'That could not be undone.');
    }
  };

  /** New racks and devices go to the premises Where names, else the first. */
  const addTo = placeIdx.premisesOfSite.get(where.site) ?? (view.premisesId === '' ? null : view.premisesId);
  const onAdd = (name: string): string | void => {
    if (!doc) return;
    try {
      const made = addThing(doc, kind, name, addTo, ctx);
      applyDocChange(made.doc);
      push({ open: made.row.key, tab: '' }, { lastOpened: made.row.key });
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
    // A link inside a page is a history entry like any other, so the browser's Back works.
    onSelect: (s: Selection) => {
      const t = linkTarget(s);
      if (t) push({ kind: t.kind, q: '', sorts: [], view: '', open: t.open, tab: '' });
    },
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

  const actorOpts = ctx.actor ? { actor: ctx.actor } : undefined;
  // Corrections from the floor. Accepting is the ordinary edit, made by this person as one undoable
  // batch; the server is asked first, so two people accepting at once make the edit once.
  const correctionsApi: CorrectionsApi = {
    list: corrections.list,
    canDraw,
    send: corrections.send,
    accept: async (c) => {
      if (!liveDoc.current) return { refused: 'No design is open.' };
      const gone = whyNotApplicable(liveDoc.current, c);
      if (gone) return { refused: gone };
      const decided = await corrections.decide(c, 'accept');
      if ('refused' in decided) return decided;
      // The server now says accepted. If the edit cannot be made or saved, say so there too, so the
      // correction is waiting again rather than recorded as done.
      const putBack = async (why: string): Promise<{ refused: string }> => {
        const back = await corrections.decide(decided, 'reopen');
        return {
          refused:
            'refused' in back
              ? `${why} It is still marked accepted and could not be put back in the waiting list (${back.refused}); make the change by hand.`
              : `${why} The correction is back in the waiting list.`,
        };
      };
      let next: typeof doc;
      try {
        const current = liveDoc.current;
        next = current ? applyCorrection(current, decided, actorOpts) : null;
      } catch (e) {
        return putBack(`The edit could not be made${e instanceof Error && e.message ? ` (${e.message})` : ''}.`);
      }
      if (!next) return putBack('No design is open.');
      const saved = await session.applyAndConfirm(next);
      if (saved && 'refused' in saved) return putBack('The edit could not be saved, so it is not in the design.');
    },
    dismiss: async (c) => {
      const decided = await corrections.decide(c, 'dismiss');
      if ('refused' in decided) return decided;
    },
  };
  const waitingCount = canDraw ? corrections.list.filter((c) => c.state === 'open').length : 0;
  const openWaiting = () => {
    setPrefs(null);
    setNotice(null);
    if (openKey) push({ open: '', tab: '' });
    setAdding('waiting');
  };
  const cableLabels = useMemo(() => new Map(view.cables.map((cb) => [cb.id, cb.label] as const)), [view]);

  const afterIpamWrite = (next: typeof doc, openNext?: string) => {
    if (!next) return;
    applyDocChange(next);
    setAdding(null);
    setNotice(null);
    if (openNext) push({ open: openNext, tab: '' }, { lastOpened: openNext });
  };
  const ipamPage = (() => {
    if (!doc) return null;
    if (adding === 'prefix') return <AddPrefixForm doc={doc} actor={actorOpts} onDone={(next, key) => afterIpamWrite(next, key)} onCancel={() => setAdding(null)} />;
    if (adding === 'waiting')
      return (
        <WaitingPage
          api={correctionsApi}
          cables={cableLabels}
          onOpenCable={(id) => {
            const t = linkTarget({ kind: 'cable', id });
            setAdding(null);
            if (t) push({ kind: t.kind, q: '', sorts: [], view: '', open: t.open, tab: '' });
          }}
        />
      );
    if (adding === 'vlan') return <AddVlanForm doc={doc} actor={actorOpts} onDone={(next) => afterIpamWrite(next)} onCancel={() => setAdding(null)} />;
    if (!openRow) return null;
    const prefix = kind === 'prefixes' ? ipam.prefixes.find((p) => p.key === openRow.key) : undefined;
    if (prefix) return <PrefixPage key={prefix.key} doc={doc} row={prefix} actor={actorOpts} canDraw={canDraw} applyDocChange={applyDocChange} />;
    const vlan = kind === 'vlans' ? ipam.vlans.find((v) => v.key === openRow.key) : undefined;
    if (vlan) return <VlanPage key={vlan.key} doc={doc} row={vlan} actor={actorOpts} canDraw={canDraw} applyDocChange={applyDocChange} />;
    return null;
  })();

  const customPaste: CustomPaste | undefined =
    kind === 'prefixes' || kind === 'vlans'
      ? {
          hint:
            kind === 'prefixes'
              ? 'Rows of Prefix, Address, Device and Interface, tab-separated or CSV, with or without a header row. Each row is one address put on one device interface. Pasted text passes the redaction gate.'
              : 'Rows of VLAN number, Name and Device, tab-separated or CSV, with or without a header row. Each row puts a VLAN on a device. Pasted text passes the redaction gate.',
          summarise: (table) => {
            const header = table[0]?.every((c) => c.trim() === '' || !/^\d/.test(c.trim())) ?? false;
            const n = table.length - (header ? 1 : 0);
            return `${n} ${n === 1 ? 'row' : 'rows'} to try.`;
          },
          onApply: (clean) => {
            if (!doc) return;
            const r = kind === 'prefixes' ? pastePrefixRows(doc, clean, actorOpts) : pasteVlanRows(doc, clean, actorOpts);
            if (r.done > 0) applyDocChange(r.doc);
            setPasteText(null);
            setNotice(`Pasted: ${r.done} added${r.refused.length ? `, ${r.refused.length} not added: ${r.refused.slice(0, 3).join('; ')}` : '.'}`);
          },
        }
      : undefined;

  const palette = useMemo(() => paletteFromCatalogue(catalogue), [catalogue]);
  const showPage = doc != null && kind !== 'networks' && pageSelection != null && EditorFor(pageSelection, view, {}, palette) != null;

  const page =
    showPage && pageSelection ? (
      <ItemPage
        key={openKey ?? ''}
        doc={doc}
        view={view}
        selection={pageSelection}
        ownerId={openRow?.ownerId ?? null}
        title={openRow?.title ?? ''}
        actions={editorActions}
        palette={palette}
        accountId={accountId}
        idx={placeIdx}
        onSetWhere={(w) => go({ where: w })}
        onShowOnCanvas={() => onShowOnRack(pageSelection)}
        tab={ls.tab}
        onTab={(t) => go({ tab: t })}
        corrections={correctionsApi}
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
        <PasteGateBoundary redact={redact}>
        <div className="inventory-place">
          <FindBox index={searchIndex} arm={() => setFindArmed(true)} value={ls.find} onValue={(v) => go({ find: v })} where={where} onOpen={openHit} onClearWhere={() => go({ where: NO_WHERE })} slot={findSlot} />
          <WhereBar where={where} options={whereOpts} onChange={(w) => go({ where: w })} />
          <div className="inv-find-slot" ref={setFindSlot} />
          <div className="inventory-place__body">
          <SideList
            kind={kind}
            viewId={currentView?.id ?? ''}
            counts={counts}
            views={allViews}
            viewCounts={viewCounts}
            onList={!openKey && !adding}
            onKind={switchKind}
            onView={onView}
            onRemoveView={onRemoveView}
            waiting={canDraw ? { count: waitingCount, onOpen: openWaiting } : undefined}
          />

          {kind === 'networks' ? (
            <div className="inventory-place__main inventory-place__main--flush">
              <NetworksPanel doc={doc} derived={networksDerived} view={view} applyDocChange={applyDocChange} canDraw={canDraw} />
            </div>
          ) : adding || (openKey && (ipamPage || page || (kind === 'addresses' && openRow))) ? (
            <div className="inv-pageframe">
              {refusal}
              <div className="inv-pageframe__bar">
                <button type="button" className="inv-pageframe__back" onClick={closePage}>
                  ← Back to {adding || backLabel === undefined || backLabel === '' ? kindLabel : backLabel}
                </button>
                {adding ? <span className="inv-pageframe__crumb">{adding === 'prefix' ? 'New prefix' : adding === 'vlan' ? 'New VLAN' : 'Corrections waiting'}</span> : null}
              </div>
              <div className="inv-pageframe__body">{kind === 'addresses' ? <AddressNote row={openRow} onOpenDevice={() => switchKind('devices')} /> : (ipamPage ?? page)}</div>
            </div>
          ) : (
            <div className="inv-list">
              {refusal}
              <ListHead
                title={currentView ? `${kindLabel} › ${currentView.name}` : kindLabel}
                shown={rows.length}
                total={baseRows.length}
                edited={!!currentView && (currentView.q !== q || JSON.stringify(currentView.sorts) !== JSON.stringify(sorts))}
                canUpdate={currentView?.who === 'Mine'}
                hasQuery={q.trim() !== ''}
                onUpdate={onUpdateView}
                onSaveAs={onSaveAs}
              />
              <ListToolbar
                kindLabel={kindLabel}
                columnsAll={columnsAll}
                columns={columns}
                onColumns={(keys) => {
                  setPrefs(keys);
                  saveColumnPrefs(kind, keys);
                }}
                canAdd={canDraw && CAN_ADD.has(kind)}
                addAction={
                  canDraw && (kind === 'prefixes' || kind === 'vlans')
                    ? { label: kind === 'prefixes' ? '+ Add a prefix' : '+ Add a VLAN', onClick: () => setAdding(kind === 'prefixes' ? 'prefix' : 'vlan') }
                    : undefined
                }
                addHint={kind === 'cables' ? 'Draw cables on the canvas.' : kind === 'ports' ? 'Ports come with a device.' : kind === 'addresses' ? 'Addresses are read from your devices.' : ''}
                onAdd={onAdd}
                onImport={canDraw && kind === 'devices' ? () => { importBase.current = liveDoc.current; setImporting(true); } : undefined}
                onPaste={canDraw && (kind === 'devices' || kind === 'racks' || kind === 'cables' || kind === 'ports' || kind === 'prefixes' || kind === 'vlans') ? () => setPasteText('') : undefined}
                checkedRows={checkedRows}
                bulkColumns={columnsAll.filter((c) => c.editable)}
                onBulkApply={canDraw ? onBulkApply : undefined}
                bulkCheck={(plan) => (doc ? dryRun(doc, kind, plan, ctx) : null)}
                matching={rows.length}
                onSelectAllMatching={() => setChecked(new Set(rows.map((r) => r.key)))}
                onClearChecked={() => setChecked(new Set())}
                notice={notice}
                progress={bulkProgress}
                undo={bulkUndo && bulkUndo.notice === notice && bulkStillUndoable(doc, bulkUndo.id) ? { run: runBulkUndo } : null}
              />
              <FilterLine q={q} onQ={(next) => go({ q: next })} schema={schema} rows={baseRows} parsed={filtered.parsed} kindLabel={kindLabel} />
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
                  key={`${kind}:${moves}`}
                  columns={columns}
                  rows={rows}
                  openKey={lastOpened}
                  checked={checked}
                  sorts={sorts}
                  canEdit={canDraw}
                  onCommit={onCommit}
                  onFilterTag={(tag) => go({ q: joinUnits([...units(q), `tags:${quoteValue(tag)}`]) })}
                  onOpen={openPage}
                  onToggleChecked={toggleChecked}
                  onToggleAll={(all) => setChecked(all ? new Set(rows.map((r) => r.key)) : new Set())}
                  onSort={(key, additive) => go({ sorts: nextSorts(sorts, key, additive) })}
                  columnMenu={(col, close) => (
                    <ColumnMenu
                      col={col}
                      kind={kind}
                      schema={schema}
                      rows={baseRows}
                      q={q}
                      onQ={(next) => go({ q: next })}
                      sorts={sorts}
                      onSort={(dir, additive) => go({ sorts: setSort(sorts, col.key, dir, additive) })}
                      onClose={close}
                    />
                  )}
                  emptyText={baseRows.length === 0 ? `No ${kind} yet.` : 'Nothing matches the filters.'}
                  initialScrollTop={scrollTop.current}
                  onScrollTop={(top) => {
                    scrollTop.current = top;
                    if (scrollSave.current !== null) window.clearTimeout(scrollSave.current);
                    scrollSave.current = window.setTimeout(() => rememberList(), 200);
                  }}
                />
              </div>
              <ListFoot kind={kind} noun={kindLabel.toLowerCase()} rows={rows} total={baseRows.length} checkedRows={checkedRows} />
            </div>
          )}
          </div>
          {importing && doc ? (
            <ImportDialog
              doc={doc}
              catalogue={catalogue}
              fieldDefs={fieldDefs}
              createField={createField}
              redact={redact}
              actor={accountId ?? undefined}
              canDraw={canDraw}
              onCancel={() => setImporting(false)}
              onApply={(next, summary) => {
                setImporting(false);
                if (liveDoc.current !== importBase.current) {
                  setNotice('The design changed while you were importing. Nothing was applied; try again.');
                  return;
                }
                applyDocChange(next);
                setNotice(`Imported ${summary.fileName}: ${summary.created} new, ${summary.filled} filled in. One undo step.`);
              }}
            />
          ) : null}
          {pasteText !== null ? (
            <PasteDialog
              custom={customPaste}
              initialText={pasteText}
              kindLabel={kindLabel}
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
                    const made = addThing(working, kind, add.name, addTo, ctx);
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
        </PasteGateBoundary>
      )}
    </Shell>
  );
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
