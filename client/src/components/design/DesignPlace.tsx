import { useCallback, useEffect, useRef, useState } from 'react';

import type { DesignCapability } from '../../api/designs';
import { addNote, notesOf as notesOfDoc, removeNote, type NoteHow } from '../../document/notes';
import { redo as redoBatch, undo as undoBatch, undoable } from '../../document/undo';
import { viewOf } from '../../document/view';
import { Engine } from '../../engine/engine';
import { refusalSentence } from '../../engine/mirror';
import { buildCsv } from '../../print/csv';
import { buildCutSheet } from '../../print/cutSheet';
import { cutSheetTableRows } from '../../print/cutSheetTable';
import { PrintPanel } from '../../print/PrintPanel';
import { PrintPreview } from '../../print/PrintPreview';
import { buildPrintJob, type PrintOptions, type PrintPage, type PrintWhat } from '../../print/printJob';
import { buildXlsx } from '../../print/xlsx';
import { getSession } from '../../state/sessionState';
import type { Selection } from '../drawing';
import { InventoryPlace } from '../inventory/InventoryPlace';
import { RacksPlace } from '../racks/RacksPlace';
import { Trail } from '../racks/Trail';
import { redoable } from '../racks/trail';
import { searchDesign } from '../shell/search';
import type { Place, ShellProps } from '../shell/types';
import { useDesignSession } from './useDesignSession';

/** A download with no server round trip and no new dependency — an object
 * URL an anchor click reaches for, revoked once the click has fired. */
function downloadBytes(filename: string, bytes: Uint8Array, mime: string) {
  const blob = new Blob([new Uint8Array(bytes)], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export interface DesignPlaceProps extends Omit<ShellProps, 'editor' | 'rail' | 'children' | 'place'> {
  place: Place;
  organisationId: string;
  designId: string;
  capability: DesignCapability;
  onZoomChange: (zoom: number) => void;
}

/**
 * This session's brief item 1 — the parent Racks and Inventory share.
 * `useDesignSession` is called exactly ONCE here, above the `if` that picks
 * which of the two place components actually renders: switching `place`
 * only ever swaps which of `RacksPlace`/`InventoryPlace` is mounted, never
 * remounts `DesignPlace` itself, so the `Document`, the catalogue and the
 * in-flight `SaveQueue` all survive the switch untouched — nothing reloads,
 * and a change queued the moment before someone clicked "Inventory" still
 * goes out.
 *
 * Also holds the one thing "Show on rack"/"Open in inventory" (this
 * session's brief item 5) needs to cross the switch: `focus`, the
 * `Selection` Racks should open already showing. Each call gets a fresh
 * object (a new `{ kind, id }` literal) so `RacksPlace`'s own edge-triggered
 * effect can tell "asked again" from "the same selection, unchanged" by
 * identity, the same shape `Drawing.tsx`'s own camera moves already use.
 */
/** ADR-0053 §4: "sealed when present in the last version opened or saved,
 * pending otherwise." `useDesignSession` (off limits this session) exposes
 * no save-completion signal of its own — only `saveRefusal`, which clears
 * on success but says nothing about WHICH save that was for — so this is an
 * honest approximation from what IS observable here: the document just
 * loaded is sealed immediately (it came straight from the server); after
 * that, a document that has not changed again for `SEAL_SETTLE_MS` with no
 * refusal showing is presumed to have made a full round trip. A further
 * local edit inside that window simply restarts the wait for its own,
 * later snapshot — never marks the earlier one sealed early. */
const SEAL_SETTLE_MS = 1_500;

export function DesignPlace(props: DesignPlaceProps) {
  const { organisationId, designId, capability, onZoomChange, onPlaceChange, ...shellProps } = props;
  const session = useDesignSession(organisationId, designId, capability);
  const [focus, setFocus] = useState<Selection | null>(null);

  const accountId = getSession()?.accountId ?? null;
  const accountAddress = getSession()?.address ?? null;

  // ------------------------------------------------------------------
  // GitHub issue #39 — Print. `activeRackId` is `RacksPlace`'s own report of
  // what the current selection resolves to (`RacksPlace.tsx`'s own effect);
  // Inventory never sets it, so a design opened straight into Inventory
  // still falls back to the closet's first rack (`PrintPanel`'s own prop is
  // already `| null`, and the panel disables "This rack" when there truly
  // is none).
  const [activeRackId, setActiveRackId] = useState<string | null>(null);
  const [printMode, setPrintMode] = useState<'closed' | 'panel' | 'preview'>('closed');
  const [printJob, setPrintJob] = useState<PrintPage[]>([]);
  const [printOptions, setPrintOptions] = useState<PrintOptions | null>(null);

  const pathLabel = shellProps.path.map((p) => p.label).join(' › ');
  const designLabel = shellProps.path[0]?.label ?? '';

  const openPrintPanel = useCallback(() => {
    if (session.doc == null) return;
    setPrintMode('panel');
  }, [session.doc]);

  const closePrint = useCallback(() => {
    setPrintMode('closed');
    setPrintJob([]);
    setPrintOptions(null);
  }, []);

  // Ctrl+P: left alone in a text field; opens the panel when nothing of
  // this feature is open yet. `PrintPreview.tsx` carries its own Ctrl+P
  // (prints) once the preview itself is open — brief item 1.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'p') return;
      const target = event.target as HTMLElement | null;
      const inField = !!target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
      if (inField) return;
      if (printMode !== 'closed') return; // the panel or the preview already owns this key
      event.preventDefault();
      openPrintPanel();
    }
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [printMode, openPrintPanel]);

  const handlePrintSubmit = useCallback(
    (what: PrintWhat, options: PrintOptions) => {
      const doc = session.doc;
      if (doc == null) return;
      const view = viewOf(doc, session.catalogue);
      const racks =
        what === 'closet'
          ? view.rows.flatMap((row) => row.racks)
          : what === 'this-rack'
            ? view.racks.filter((r) => r.id === (activeRackId ?? view.racks[0]?.id))
            : [];
      const cutSheetDevices = what === 'cut-sheet' ? buildCutSheet(doc, view) : [];
      const job = buildPrintJob({
        what,
        racks,
        cables: view.cables,
        cutSheetDevices,
        options,
        meta: { designName: designLabel, path: pathLabel, printedBy: accountAddress ?? '', printedAt: new Date() },
      });
      setPrintJob(job);
      setPrintOptions(options);
      setPrintMode('preview');
    },
    [session.doc, session.catalogue, activeRackId, designLabel, pathLabel, accountAddress],
  );

  const downloadCutSheet = useCallback(
    (format: 'xlsx' | 'csv') => {
      const doc = session.doc;
      if (doc == null) return;
      const view = viewOf(doc, session.catalogue);
      const devices = buildCutSheet(doc, view);
      const rows = cutSheetTableRows(devices);
      if (format === 'csv') {
        downloadBytes('cut-sheet.csv', buildCsv(rows.map((r) => r.cells)), 'text/csv;charset=utf-8');
      } else {
        downloadBytes(
          'cut-sheet.xlsx',
          buildXlsx('Cut sheet', rows.map((r) => r.cells.map((text) => ({ text, bold: r.bold })))),
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        );
      }
    },
    [session.doc, session.catalogue],
  );

  // ------------------------------------------------------------------
  // ADR-0053 §4 — the Trail's own "sealed or pending," approximated per the
  // note above. Reset whenever the open design changes (a fresh
  // `DesignPlace` instance per (organisationId, designId) — `App.tsx` never
  // reuses one across designs — so this only ever needs to reset when the
  // session's own `doc` identity moves from one design's document to
  // another's, which loading always does).
  const [sealedBatchIds, setSealedBatchIds] = useState<ReadonlySet<string>>(() => new Set());
  const openedOnceRef = useRef(false);
  const lastDocRef = useRef<typeof session.doc>(null);
  useEffect(() => {
    const doc = session.doc;
    if (doc == null) {
      openedOnceRef.current = false;
      lastDocRef.current = null;
      setSealedBatchIds(new Set());
      return undefined;
    }
    lastDocRef.current = doc;
    if (!openedOnceRef.current) {
      openedOnceRef.current = true;
      setSealedBatchIds(new Set(doc.batches.map((b) => b.id)));
      return undefined;
    }
    if (session.saveRefusal != null) return undefined; // stays pending while refused
    const timer = setTimeout(() => {
      if (lastDocRef.current === doc) setSealedBatchIds(new Set(doc.batches.map((b) => b.id)));
    }, SEAL_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [session.doc, session.saveRefusal]);

  // ------------------------------------------------------------------
  // ADR-0053 §1/§3 — undo/redo, live off `undoable`/`trail.ts`'s own
  // `redoable`, computed here (above where Racks and Inventory are chosen
  // between) so the bar's Undo/Redo chips work the same in either place —
  // ADR-0046 §2's "one editor" extended to one undo.
  const doc = session.doc;
  const undoCandidates = doc != null && accountId != null ? undoable(doc, accountId) : [];
  const redoCandidate = doc != null && accountId != null ? redoable(doc, accountId) : undefined;
  const [undoRefusal, setUndoRefusal] = useState<string | null>(null);
  // The trail starts folded; a refused undo or redo opens it so the refusal is seen.
  const [trailOpen, setTrailOpen] = useState(false);

  const handleUndo = useCallback(() => {
    if (!session.canDraw) return; // ADR-0052 §5: a reader undoes nothing, even via a stray Ctrl+Z
    if (doc == null || accountId == null) return;
    const target = undoCandidates[0];
    if (target == null) return;
    try {
      session.applyDocChange(undoBatch(doc, target.id, { actor: accountId, now: Date.now() }));
      setUndoRefusal(null);
    } catch (error) {
      setUndoRefusal(error instanceof Error ? error.message : 'That undo did not complete.');
      setTrailOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `undoCandidates`
    // is recomputed fresh every render from `doc`/`accountId`, both already
    // listed.
  }, [doc, accountId, session]);

  const handleRedo = useCallback(() => {
    if (!session.canDraw) return; // ADR-0052 §5: a reader redoes nothing, even via a stray Ctrl+Shift+Z
    if (doc == null || accountId == null || redoCandidate == null) return;
    try {
      session.applyDocChange(redoBatch(doc, redoCandidate.id, { actor: accountId, now: Date.now() }));
      setUndoRefusal(null);
    } catch (error) {
      setUndoRefusal(error instanceof Error ? error.message : 'That redo did not complete.');
      setTrailOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, accountId, session]);

  // ------------------------------------------------------------------
  // ADR-0053 §4 — "a comment on a pending change is a batch field." Held
  // here, above the change itself: typed before the edit that will carry
  // it, then stamped onto whichever batch turns out to be the very next one
  // the document gains, the moment it arrives — `session.doc` is the
  // authoritative signal for "a new batch landed," not a return value
  // `handleEdit`/undo/redo would each have to thread separately.
  const [pendingComment, setPendingComment] = useState('');
  const lastBatchCountRef = useRef<number | null>(null);
  useEffect(() => {
    const current = session.doc;
    if (current == null) return;
    const count = current.batches.length;
    const prevCount = lastBatchCountRef.current;
    lastBatchCountRef.current = count;
    if (prevCount == null || count <= prevCount) return; // no new batch to attach to
    const comment = pendingComment.trim();
    if (comment.length === 0) return;
    const target = current.batches[current.batches.length - 1];
    if (target.comment !== undefined) return; // already carries one (a redo of a commented undo, say)
    setPendingComment('');
    session.applyDocChange({
      ...current,
      batches: current.batches.map((b) => (b.id === target.id ? { ...b, comment } : b)),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires off the
    // batch COUNT changing, not `pendingComment`'s own identity (typing must
    // not re-run this).
  }, [session.doc]);

  // ------------------------------------------------------------------
  // ADR-0053 §5/§6 — Notes, shared by both places' editors. `OP_REDACT_TEXT`
  // needs only the module booted (`engine.ts`'s own doc: "this door never
  // writes the graph"), never a document loaded into it, so this is its own
  // small boot rather than a second copy of `RacksPlace.tsx`'s own
  // `Mirror`-based one (which exists for the config drawer's paste-into,
  // a document-mutating door this is not).
  const enginePromiseRef = useRef<Promise<Engine> | null>(null);
  const ensureEngine = useCallback((): Promise<Engine> => {
    if (enginePromiseRef.current == null) enginePromiseRef.current = Engine.init();
    return enginePromiseRef.current;
  }, []);

  const notesOfCallback = useCallback((ownerId: string) => (session.doc ? notesOfDoc(session.doc, ownerId) : []), [session.doc]);

  const handleAddNote = useCallback(
    async (ownerId: string, opts: { text: string; how: NoteHow }): Promise<{ refused: string } | void> => {
      const current = session.doc;
      if (current == null) return { refused: 'No design is open.' };
      let text = opts.text;
      let lineCount: number | undefined;
      if (opts.how === 'pasted') {
        lineCount = opts.text.split('\n').length;
        try {
          const engine = await ensureEngine();
          text = engine.redactText(opts.text).text;
        } catch (error) {
          return { refused: refusalSentence(error) };
        }
      }
      try {
        session.applyDocChange(addNote(current, ownerId, { text, how: opts.how, lineCount, actor: accountId ?? undefined }));
      } catch (error) {
        return { refused: error instanceof Error ? error.message : 'That note was refused.' };
      }
    },
    [session, ensureEngine, accountId],
  );

  const handleRemoveNote = useCallback(
    (noteId: string): { refused: string } | void => {
      const current = session.doc;
      if (current == null) return { refused: 'No design is open.' };
      try {
        session.applyDocChange(removeNote(current, noteId, accountId ? { actor: accountId } : undefined));
      } catch (error) {
        return { refused: error instanceof Error ? error.message : 'That removal was refused.' };
      }
    },
    [session, accountId],
  );

  const showOnRack = useCallback(
    (selection: Selection) => {
      setFocus({ ...selection });
      onPlaceChange('racks');
    },
    [onPlaceChange],
  );

  const openInInventory = useCallback(
    (chassisId: string) => {
      // The reverse trip carries no focus today — `InventoryPlace` has no
      // per-row scroll target of its own yet (its brief item 4 opens the
      // editor by selection, not by a remembered row); the chassis id is
      // still named in case a later session adds one.
      void chassisId;
      onPlaceChange('inventory');
    },
    [onPlaceChange],
  );

  // The bar's Undo/Redo, real everywhere `DesignPlace` renders — overrides
  // whatever stub `App.tsx`'s own `common` handed down (Home's own copy,
  // untouched, stays disabled: `DesignPlace` never mounts there). Gated on
  // `session.canDraw` (ADR-0052 §5) the same way `onEdit`/`onAddNote`/
  // `onRemoveNote` already are: a reader's Ctrl+Z or Undo chip does nothing
  // silently rather than writing a batch nobody with read-only access is
  // allowed to write.
  // Quick search (the owner's option A): the open design; a choice shows it on the rack.
  const search = {
    run: (query: string) => (session.doc ? searchDesign(viewOf(session.doc, session.catalogue), query) : []),
    choose: (selection: Selection) => showOnRack(selection),
  };

  // One trail for the design, the same in Racks and Inventory.
  const trail =
    doc != null ? (
      <Trail
        doc={doc}
        accountId={accountId}
        accountAddress={accountAddress}
        sealedBatchIds={sealedBatchIds}
        undoRefusal={undoRefusal}
        pendingComment={pendingComment}
        onPendingCommentChange={setPendingComment}
      />
    ) : null;

  const sharedShellProps = {
    ...shellProps,
    search,
    trail,
    trailOpen,
    onTrailOpenChange: setTrailOpen,
    canUndo: session.canDraw && undoCandidates.length > 0,
    canRedo: session.canDraw && redoCandidate != null,
    onUndo: handleUndo,
    onRedo: handleRedo,
    onPrint: openPrintPanel,
  };

  const notesActions = { notesOf: notesOfCallback, onAddNote: handleAddNote, onRemoveNote: handleRemoveNote };

  // The closet view for the print panel/preview only — computed while
  // either is actually open, never on every render of the place itself.
  const printView = printMode !== 'closed' && session.doc != null ? viewOf(session.doc, session.catalogue) : null;
  const activeRackSummary = printView
    ? (printView.racks.find((r) => r.id === activeRackId) ?? printView.racks[0] ?? null)
    : null;

  const place =
    props.place === 'racks' ? (
      <RacksPlace
        {...sharedShellProps}
        onPlaceChange={onPlaceChange}
        session={session}
        onZoomChange={onZoomChange}
        initialFocus={focus}
        onOpenInventory={openInInventory}
        accountId={accountId}
        notesActions={notesActions}
        onActiveRackChange={setActiveRackId}
      />
    ) : (
      <InventoryPlace
        {...sharedShellProps}
        onPlaceChange={onPlaceChange}
        session={session}
        onShowOnRack={showOnRack}
        notesActions={notesActions}
      />
    );

  return (
    <>
      {place}
      {printMode === 'panel' && printView && (
        <PrintPanel
          activeRack={activeRackSummary ? { id: activeRackSummary.id, label: activeRackSummary.label, heightU: activeRackSummary.heightU } : null}
          rackCount={printView.racks.length}
          onPrint={handlePrintSubmit}
          onCancel={closePrint}
          onDownloadXlsx={() => downloadCutSheet('xlsx')}
          onDownloadCsv={() => downloadCutSheet('csv')}
        />
      )}
      {printMode === 'preview' && printOptions && (
        <PrintPreview pages={printJob} paper={printOptions.paper} blackAndWhite={printOptions.blackAndWhite} onClose={closePrint} />
      )}
    </>
  );
}
