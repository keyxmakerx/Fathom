import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { captureOf } from '../../document/capture';
import { connectPorts, disconnect, IncompatibleConnectorError, PortAlreadyTerminatedError, type Sheath } from '../../document/cables';
import {
  SURFACE_FORMS,
  createBoard,
  addSketchPort,
  addSketchPortRange,
  createSketchDevice,
  createSurface,
  isSurfaceForm,
  moveChassis,
  movePlacement,
  placeChassis,
  removeChassis,
  resizeShelf,
} from '../../document/commands';
import { nextFreeSpot } from '../drawing/freeLayout';
import { BOX_H, BOX_W, createLabel, createLine, moveFree, removeFree, setLabel } from '../../document/freeform';
import { FieldValueError, isDeviceRole, setDeviceField } from '../../document/edit';
import { useResumeView } from './useResumeView';
import { edgesIn, parseNodeId, type Document } from '../../document/model';
import { viewOf, type ChassisView, type ClosetView } from '../../document/view';
import { Engine, EngineTrap } from '../../engine/engine';
import { Mirror, refusalSentence } from '../../engine/mirror';
import { JotView } from '../jot/JotView';
import { deviceChassis, jotPlates, jotSpot, originOf } from '../jot/jotLayout';
import { PasteCard, type PasteState } from '../paste/PasteCard';
import type { PastePlatform } from '../../engine/frames';
import { devicePlatform, platformChoices, previewPaste, worthReading } from '../paste/pasteConfig';
import { ConfigDrawer } from '../config/ConfigDrawer';
import { canDrawFor, refusalFor, type DesignSession } from '../design/useDesignSession';
import { Drawing, EditorFor, Palette, type NotesActions, type Selection, type TagsActions, type FieldsActions } from '../drawing';
import {
  cableGroupsStorageKey,
  closetCableIdSet,
  closetHiddenCableCount,
  computeCableDraw,
  isCableGroupsFiltered,
  loadCableGroupsState,
  migratedOrDefaultCableGroupsState,
  resolveStoredGroups,
  saveCableGroupsState,
  withAllCablesShown,
  withCableHidden,
  withCableShown,
  withHiddenCablesPruned,
  type StoredCableGroupsState,
} from '../drawing/cableGroups';
import { CableGroupsPopover } from '../drawing/CableGroupsPopover';
import { CAMERA_STOPS } from '../drawing/geometry';
import { DiagramDrawing } from '../drawing/DiagramDrawing';
import { layerWords } from '../drawing/layerLabels';
import { layerOn, loadLayers, saveLayers, type LayerId, type LayerSet } from '../drawing/layers';
import { loadDiagramStyle, saveDiagramStyle, type DiagramStyle } from '../drawing/diagramStyle';
import { loadLook, saveLook, type Look } from '../drawing/look';
import { InsideStop } from '../inside/InsideStop';
import { ChecksBarChip, ChecksSurface } from '../checks/ChecksPanel';
import { mediaCandidates } from '../checks/checksModel';
import { CheckMarksContext, ChecksContext } from '../checks/checksStore';
import { useChecksController } from '../checks/useChecksController';
import { TracePanel } from '../trace/TracePanel';
import { TraceContext } from '../trace/traceStore';
import { useTraceController } from '../trace/useTraceController';
import { PlanBand, PlansBarChip } from '../plans/PlanBand';
import { PlansSurface } from '../plans/PlansSurface';
import { PlansContext } from '../plans/plansStore';
import { usePlansController } from '../plans/usePlansController';
import { DeviceIssues } from '../troubleshoot/DeviceIssues';
import { TroublePanel } from '../troubleshoot/TroublePanel';
import { TroubleContext } from '../troubleshoot/troubleStore';
import { useTroubleController } from '../troubleshoot/useTroubleController';
import type { PathPart, ShellProps } from '../shell/types';
import { Shell } from '../Shell';
import { addFreeBoxDoc, duplicateFreeDoc } from './freeActions';
import { addRack, createPremises, ensureRackToPlaceInto, nextName } from './emptyDesign';
import type { PaletteItem } from '../drawing/contract';
import { DEFAULT_FACEPLATES, SKETCH_DEVICE_PALETTE_ITEM, isBoardPaletteItem, isSketchDevicePaletteItem, paletteFromCatalogue, paletteRows } from './palette';
import { highestFreeU, hostnamesOf, nextHostname, racksInPickOrder } from './pick';
import './racks.css';
import { SkeletonRacks } from '../ui/Skeleton';

// `canDrawFor`/`refusalFor` now live in `components/design/useDesignSession.ts`,
// re-exported here unchanged, so the two
// test files that import them from `'./RacksPlace'`
// (`RacksPlace.canDraw.test.ts`, `RacksPlace.edit.test.ts`) keep passing
// without themselves needing to know the logic moved.
export { canDrawFor, refusalFor };

/** Folds every batch added after the first `from` into one, so a placement
 * built from several commands (the device, its spot, its default ports) is
 * one undo step. */
export function oneUndoStep(doc: Document, from: number): Document {
  const added = doc.batches.slice(from);
  if (added.length < 2) return doc;
  const merged = { ...added[0]!, ops: added.flatMap((b) => b.ops) };
  return { ...doc, batches: [...doc.batches.slice(0, from), merged] };
}

/**
 * The `Actor` opts every command `handlePlace`/`handleMove` dispatches is
 * stamped with — the signed-in account's own ulid, the same shape
 * `useDesignSession.ts`'s `handleEdit` already builds from
 * `getSession()?.accountId`. Pulled out as its own named, exported function
 * (rather than an inline ternary at four call sites) so it is a thing this
 * file's own test can call directly: a regression that drops the argument
 * from one of those four calls, or that reintroduces `undefined` for a real
 * signed-in `accountId`, previously landed a batch stamped
 * `document/model.ts`'s `LOCAL_ACTOR` — one nobody could undo (ADR-0053
 * §1/§3) and the Trail could only read as `'local'`
 * (`components/racks/trail.ts`'s `whoLabel`).
 */
export function actorOpts(accountId: string | null): { actor: string } | undefined {
  return accountId != null ? { actor: accountId } : undefined;
}

/** Not a valid formatted node id (`document/model.ts`'s ids are always
 * `<kebab-kind>:<ulid>`) — a sentinel `Drawing` can hand back to `onPlace`
 * that can never collide with a real rack. Stands in for the rack an empty
 * design does not have yet, so there is something to drop the first device
 * onto; see `handlePlace`. */
const PENDING_RACK_ID = 'pending-rack';

const PENDING_RACK_VIEW: ClosetView['racks'][number] = {
  id: PENDING_RACK_ID,
  label: 'Rack 1',
  heightU: 42,
  unitNumbering: 'ascending',
  chassis: [],
  shelves: [],
  freeRuns: [{ fromU: 1, toU: 42 }],
  row: null,
  bay: null,
};

/** What an empty design says (ADR-0060 decision 4). */
const EMPTY_HINT =
  'An empty design. Open Equipment on the left and drag a device onto the rack, or right-click the canvas to add a rack or a wall.';

/**
 * ADR-0051 §1 — "+ add a surface". There is no
 * premises editor (`EditorFor`'s own `Selection` has no `'premises'` kind
 * yet) and no separate page header for the Racks place
 * (`shell/types.ts`'s `ShellProps` has no header slot); the rail — this
 * place's one persistent control surface, today just `Palette` — is the
 * nearest thing that exists, so this sits above it. A design with no
 * premises yet gets one alongside the surface (`handleAddSurface`).
 */
function AddSurfaceControl({ onAdd }: { onAdd: (label: string, form: string) => { refused: string } | void }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [form, setForm] = useState<string>(SURFACE_FORMS[0]);
  const [refusal, setRefusal] = useState<string | null>(null);

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}>
        + Add a wall, floor or desk
      </button>
    );
  }

  function commit() {
    const result = onAdd(label, form);
    if (result?.refused) {
      setRefusal(result.refused);
      return;
    }
    setRefusal(null);
    setOpen(false);
    setLabel('');
  }

  return (
    <div>
      <input placeholder="label" value={label} onChange={(e) => setLabel(e.target.value)} />
      <select value={form} onChange={(e) => setForm(e.target.value)}>
        {SURFACE_FORMS.map((f) => (
          <option key={f} value={f}>
            {f}
          </option>
        ))}
      </select>
      <button type="button" onClick={commit}>
        add
      </button>
      <button type="button" onClick={() => setOpen(false)}>
        cancel
      </button>
      {refusal != null ? <div className="racks-place__refusal">{refusal}</div> : null}
    </div>
  );
}

export interface RacksPlaceProps extends Omit<ShellProps, 'editor' | 'rail' | 'children'> {
  /** This session's brief item 1: the document, the catalogue, the
   * `SaveQueue` and the one `handleEdit` dispatcher — held by
   * `useDesignSession` and mounted exactly once, in `DesignPlace.tsx`,
   * above wherever this component and `InventoryPlace` are chosen between.
   * Neither place calls the hook itself, so switching place remounts only
   * the place component, never the session: nothing reloads, no queued
   * save is lost. */
  session: DesignSession;
  /** The camera's continuous zoom, kept in agreement with the bar's
   * stepped `zoom`/`onZoomIn`/`onZoomOut` by the caller (`App.tsx`) — the
   * same single number, two ways to move it. */
  onZoomChange: (zoom: number) => void;
  /** This session's brief item 5 — "Show on rack": `InventoryPlace.tsx`'s
   * caller (`DesignPlace.tsx`) hands in a `Selection` to open already
   * chosen, e.g. the chassis a device row named. Selected the moment the
   * document is ready, with the camera asked to the faceplate stop
   * (`CAMERA_STOPS.faceplate`) the same motion a shelf-occupant open
   * already uses (`Drawing.tsx`'s Motion #10). Absent on every ordinary
   * open — nothing is pre-selected just because a design loaded. */
  initialFocus?: Selection | null;
  /** A saved issue to open on arrival ("Show on canvas" on an Inventory issue page); a fresh object per ask. */
  initialIssue?: { id: string } | null;
  /** This session's brief item 5's reverse — "Open in inventory," rendered
   * beside the editor for a selected chassis. Omitted (no button at all)
   * where no caller supplies it, the same "no action, not a disabled one"
   * shape `EditorActions.onSelect` already follows. */
  onOpenInventory?: (chassisId: string) => void;
  /** The signed-in account, stamped on each change as its actor. `null` in the
   * moment between an expired session and the shell noticing. */
  accountId: string | null;
  /** ADR-0053 §5/§6 — Notes, threaded straight into `EditorFor`'s own
   * `actions` below. */
  notesActions: NotesActions;
  /** ADR-0059 — Tags, threaded straight into `EditorFor`'s own `actions`
   * below, `notesActions`'s own shape. */
  tagsActions: TagsActions;
  /** ADR-0062 — custom fields in the canvas panel, the same editor Inventory shows. */
  fieldsActions: FieldsActions;
  /** The rack the current selection resolves to, for the Print panel's
   * "this rack" — `null` when the selection names nothing rack-shaped. */
  onActiveRackChange?: (rackId: string | null) => void;
  /** The History panel, shown in the editor's place, and the line over the canvas while a
   * past save is shown. Absent unless History is open. */
  historyView?: { panel: ReactNode; banner: string | null };
  /** The cable ids the Cables list shows, or `null` when it shows them all — for "as shown on screen" in print. */
  onShownCablesChange?: (ids: ReadonlySet<string> | null) => void;
  /** The Cables list's own storage key (`fathom.cables.<designId>`), one
   * per design, never the document. */
  designId: string;
  /** What is selected, by element id, for presence (ADR-0063 §12). */
  onSelectedChange?: (id: string | null) => void;
  /** A device was opened (double-click): Home's Recent row remembers it. */
  onDeviceOpened?: (chassisId: string, name: string) => void;
}

/**
 * The Racks place for one open design: reads the `Document`/`SaveQueue`
 * `session` prop (shared with `InventoryPlace` over the same design,
 * `DesignPlace.tsx`) and turns every `Drawing`
 * action into a command from `document/commands.ts` followed by a save.
 * Every change saves — the server is where the data lives — through the
 * session's one `SaveQueue`, so a save already running is never joined by a
 * second one for the same design.
 */
/** An engine refusal as a sentence: no code quoting, a capital to start. */
function tidySentence(text: string): string {
  const plain = text.replace(/`/g, '').trim();
  return plain.charAt(0).toUpperCase() + plain.slice(1);
}

const NO_ROOM_ADD = 'No room in this rack for another device.';

export function RacksPlace(props: RacksPlaceProps) {
  const {
    session,
    onZoomChange,
    initialFocus,
    initialIssue,
    onOpenInventory,
    accountId,
    notesActions,
    tagsActions,
    fieldsActions,
    onActiveRackChange,
    historyView,
    onShownCablesChange,
    designId,
    onSelectedChange,
    onDeviceOpened,
    ...shellProps
  } = props;
  const { doc, catalogue, loadError, saveRefusal, canDraw, applyDocChange, handleEdit, reloadDesign } = session;
  const [selection, setSelection] = useState<Selection | null>(initialFocus ?? null);
  const selectedId = selection?.id ?? null;
  useEffect(() => {
    onSelectedChange?.(selectedId);
  }, [onSelectedChange, selectedId]);
  const resumeView = useResumeView({ accountId, designId, doc, hasFocus: initialFocus != null, selection, setSelection });
  // A device whose callout is showing keeps the details panel closed; the callout's Details opens it.
  const [calloutId, setCalloutId] = useState<string | null>(null);
  // Rack or Diagram: this person's choice for this design, kept in this browser.
  const [look, setLookState] = useState<Look>(() => loadLook(accountId, session.designId));
  useEffect(() => setLookState(loadLook(accountId, session.designId)), [accountId, session.designId]);
  const changeLook = useCallback(
    (next: Look) => {
      setLookState(next);
      setCalloutId(null);
      saveLook(accountId, session.designId, next);
    },
    [accountId, session.designId],
  );
  // Boxes or Icons in the Diagram look: this person's choice, kept in this browser.
  const [diagramStyle, setDiagramStyleState] = useState<DiagramStyle>(() => loadDiagramStyle(accountId, session.designId));
  useEffect(() => setDiagramStyleState(loadDiagramStyle(accountId, session.designId)), [accountId, session.designId]);
  const changeDiagramStyle = useCallback(
    (next: DiagramStyle) => {
      setDiagramStyleState(next);
      saveDiagramStyle(accountId, session.designId, next);
    },
    [accountId, session.designId],
  );
  // The Show menu's ticked layers: this person's, this design's, this browser's.
  const [layers, setLayers] = useState<LayerSet>(() => loadLayers(accountId, session.designId));
  useEffect(() => setLayers(loadLayers(accountId, session.designId)), [accountId, session.designId]);
  const toggleLayer = useCallback(
    (id: LayerId) =>
      setLayers((prev) => {
        const next = { ...prev, [id]: !prev[id] };
        saveLayers(accountId, session.designId, next);
        return next;
      }),
    [accountId, session.designId],
  );
  // Bumped by the bar's percentage button; the drawing fits every rack.
  const [fitRequest, setFitRequest] = useState(0);
  // A short-lived note over the canvas for a menu action that did nothing
  // visible (no room for a device). Clears itself.
  const [canvasNotice, setCanvasNotice] = useState<string | null>(null);
  useEffect(() => {
    if (canvasNotice == null) return;
    const t = setTimeout(() => setCanvasNotice(null), 5000);
    return () => clearTimeout(t);
  }, [canvasNotice]);

  // "Show on rack" (`InventoryPlace.tsx`): a caller landing here with
  // something already chosen selects it and asks
  // for the faceplate stop the moment the document is ready (an
  // `initialFocus` handed in before `doc` loads waits for it rather than
  // selecting an id `EditorFor` cannot yet resolve to anything). Fires once
  // per distinct `initialFocus` value — `DesignPlace.tsx` gives every "Show
  // on rack" click a fresh object, so identity itself is the "asked again"
  // signal, the same edge-triggered shape `Drawing.tsx`'s own camera moves
  // already use.
  const [openRequest, setOpenRequest] = useState<{ id: string; view: 'config' | 'inside' } | null>(null);
  useEffect(() => {
    if (initialFocus == null || doc == null) return;
    setSelection(initialFocus);
    if (initialFocus.kind === 'chassis') setOpenRequest({ id: initialFocus.id, view: 'config' });
    onZoomChange(CAMERA_STOPS.faceplate);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- edge-triggered
    // on the `initialFocus` object identity and `doc` becoming available;
    // `onZoomChange` is a stable setter from `App.tsx`.
  }, [initialFocus, doc]);

  // ADR-0052 §1/§4 — the config drawer's
  // engine. `Engine.init()` fetches and boots the wasm module
  // (`engine.ts`'s own doc), which is not free, so it happens on first
  // need — the first time a chassis is selected in this session — and
  // never at sign-in or on opening the design. `mirrorPromiseRef` makes a
  // second "first need" (a second chassis selected before the first
  // `Engine.init()` resolves) join the same boot rather than start another.
  const mirrorRef = useRef<Mirror | null>(null);
  // The engine itself, for the redaction gate Plans runs its notes through.
  const engineRef = useRef<Engine | null>(null);
  const mirrorPromiseRef = useRef<Promise<Mirror> | null>(null);
  // The `Document` the module currently holds, by reference — `writePlain`
  // and `loadPlain` (`mirror.ts`'s `load`) are not free (measured: seconds,
  // not milliseconds, on a realistic multi-thousand-line capture), so this
  // is what lets every call site below load the module only when the
  // document it holds is stale, rather than on every render or every
  // document change regardless of whether the module is even in use.
  const mirrorLoadedDocRef = useRef<Document | null>(null);
  // Bumped once `mirrorRef.current` goes from `null` to real — a ref change
  // alone does not schedule a render, and `renderConfigDrawer`/
  // `renderInsideStop` (below) read `mirrorRef.current` directly, so
  // something has to ask React to call them again once the engine is
  // actually ready.
  const [, forceMirrorRerender] = useState(0);

  // A trapped module is never reused: drop it, so the next need boots another and loads the design whole.
  const discardTrapped = useCallback(() => {
    mirrorRef.current = null;
    mirrorPromiseRef.current = null;
    mirrorLoadedDocRef.current = null;
    forceMirrorRerender((n) => n + 1);
  }, []);

  const ensureMirror = useCallback((): Promise<Mirror> => {
    if (mirrorRef.current?.trapped) discardTrapped();
    if (mirrorPromiseRef.current == null) {
      mirrorPromiseRef.current = Engine.init().then((engine) => {
        const mirror = new Mirror(engine);
        engineRef.current = engine;
        mirrorRef.current = mirror;
        forceMirrorRerender((n) => n + 1);
        return mirror;
      });
    }
    return mirrorPromiseRef.current;
  }, [discardTrapped]);

  // How long the last sync of the module took, ms: Checks sizes its wait and its guard by it. After the first
  // full load the next sync is a delta, so one full load says little about it and is not counted; a second
  // full load in a row (the module keeps answering "resync needed") is the real cost and is.
  const loadCostRef = useRef<number | null>(null);
  const fullStreakRef = useRef(0);
  const loadInto = useCallback((mirror: Mirror, target: Document, discard: () => void = discardTrapped) => {
    const t0 = performance.now();
    let kind: ReturnType<Mirror['sync']>;
    try {
      kind = mirror.sync(target);
    } catch (e) {
      if (e instanceof EngineTrap) discard();
      throw e;
    }
    const ms = performance.now() - t0;
    fullStreakRef.current = kind === 'full' ? fullStreakRef.current + 1 : 0;
    if (kind === 'delta' || (kind === 'full' && fullStreakRef.current > 1)) loadCostRef.current = ms;
    mirrorLoadedDocRef.current = target;
  }, [discardTrapped]);

  // The drawer and the inside stop load the module only when the document it holds is stale, at the moment they
  // are about to use it (`mirrorLoadedDocRef` above). Checks (below) also boots it and keeps it current, but after
  // the document has been quiet for a while, not on every change. Reference equality is enough: every
  // `document/commands.ts`/`document/edit.ts` call and `mirror.pasteInto`'s readback return a fresh `Document`.
  const withMirror = useCallback(async (): Promise<Mirror> => {
    const mirror = await ensureMirror();
    if (doc != null && mirrorLoadedDocRef.current !== doc) loadInto(mirror, doc);
    return mirror;
  }, [ensureMirror, doc, loadInto]);

  // Checks (ADR-0061 §5): the same engine and mirror. The standing run is debounced by the last load's cost; the
  // gesture guard asks for `load = false` when that cost is high and uses what the module holds.
  const mirrorNow = useCallback(
    (load = true): Mirror | null => {
      const mirror = mirrorRef.current;
      if (mirror == null || doc == null) return null;
      if (load && mirrorLoadedDocRef.current !== doc) loadInto(mirror, doc);
      return mirror;
    },
    [doc, loadInto],
  );
  const loadCostMs = useCallback(() => loadCostRef.current, []);
  const checks = useChecksController({ doc, boot: ensureMirror, mirrorNow, loadCostMs });
  // Maintenance plans (ADR-0061 round 7): the same engine and mirror; every command goes through applyDocChange.
  const redact = useCallback(() => {
    const engine = engineRef.current;
    return engine == null ? null : (t: string) => engine.redactText(t).text;
  }, []);
  const plans = usePlansController({
    doc,
    boot: ensureMirror,
    mirrorNow,
    loadCostMs,
    redact,
    applyDocChange,
    actor: actorOpts(accountId),
    authorName: shellProps.account?.initials,
    canEdit: canDraw,
  });
  // "It's down" (ADR-0061 troubleshooting): the draft stays in memory; Plan a fix opens the plan in the plans surface.
  const trouble = useTroubleController({
    doc,
    boot: ensureMirror,
    redact,
    applyDocChange,
    actor: actorOpts(accountId),
    authorName: shellProps.account?.initials,
    canEdit: canDraw,
    openPlan: (id) => {
      plans.openPlan(id);
      plans.setPanelOpen(true);
    },
    foldPlans: () => plans.setPanelOpen(false),
  });
  const issueHandled = useRef<unknown>(null);
  useEffect(() => {
    if (initialIssue == null || doc == null || issueHandled.current === initialIssue) return;
    issueHandled.current = initialIssue;
    trouble.openIssue(initialIssue.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per ask: the object's identity is the signal
  }, [initialIssue, doc]);

  const selectedChassisId = selection?.kind === 'chassis' ? selection.id : null;

  // First need: a chassis is selected at all (the faceplate/inside stops
  // are a further zoom on the same selection, not a separate action) —
  // warms the engine so the drawer or the inside stop, whichever the
  // camera reaches next, does not wait on a fresh boot. Best-effort: a
  // refusal here surfaces instead from `handlePasteInto`, the one place
  // this session actually acts on the module's reply.
  useEffect(() => {
    if (selectedChassisId == null) return;
    withMirror().catch(() => {});
  }, [selectedChassisId, withMirror]);

  const [pasteRefusal, setPasteRefusal] = useState<string | null>(null);
  // ADR-0052 §1: "the drawer's gutter lights the port it built" — hover and
  // a click both name a line's own port label; hover wins while it is
  // active (UI-SPEC "Config": "click a line and the port it built lights"),
  // the last click stays lit once the pointer leaves.
  const [hoverPortLabel, setHoverPortLabel] = useState<string | null>(null);
  const [selectedLinePortLabel, setSelectedLinePortLabel] = useState<string | null>(null);
  const litPortLabel = hoverPortLabel ?? selectedLinePortLabel;

  // All three are facts about ONE device's own drawer — a refusal from the
  // last chassis's paste, a line hovered or clicked in the last chassis's
  // own capture — and none of them names the device they are about. Left
  // alone across a selection change, the next chassis's drawer would show
  // the previous one's refusal, or light a port on this chassis for a line
  // that only ever built something on the last one (the normal case for two
  // devices sharing a port label like `ge-0/0/0`). Reset the moment the
  // selected chassis itself changes, not only at design load or paste time.
  useEffect(() => {
    setPasteRefusal(null);
    setHoverPortLabel(null);
    setSelectedLinePortLabel(null);
  }, [selectedChassisId]);

  // The drawer's paste asks "which device is this from?" only when the device has no platform of its own
  // and the engine cannot tell; the text is held for that one question and dropped on any other outcome.
  const [drawerAsk, setDrawerAsk] = useState<{ deviceId: string; text: string; candidates: PastePlatform[] } | null>(null);
  const handlePasteInto = useCallback(
    (deviceId: string, text: string, platform?: PastePlatform) => {
      setPasteRefusal(null);
      setDrawerAsk(null);
      withMirror()
        .then((mirror) => {
          // Door three, ADR-0052 §4: "the human answer ADR-0010 asks for" —
          // `pasteInto`'s own reply already carries `PasteResult`, but the
          // drawer's own gutter (built/kept/destroyed) is derived from the
          // saved document's own provenance on reopen (`document/capture.ts`'s
          // `captureOf`, ADR-0052 §3) rather than kept from this reply, so
          // only the `Document` it returns is used here.
          const { doc: nextDoc } = mirror.pasteInto(deviceId, text, platform ?? (doc ? devicePlatform(doc, deviceId) : null) ?? undefined);
          // The module already holds exactly this document — its own
          // `OP_EXPORT_PLAIN` is what `nextDoc` was read back from
          // (`mirror.ts`'s `pasteInto`) — so the next call to reach for the
          // mirror (a hover, a second paste, the inside stop) must not pay
          // `writePlain`/`loadPlain` again for a round-trip that already
          // happened.
          mirrorLoadedDocRef.current = nextDoc;
          applyDocChange(nextDoc);
        })
        // `mirror.ts`'s own `refusalSentence` — the one place an
        // `EngineError`'s code is read into the drawer's own sentence
        // (ADR-0052 §5's amendment on a second paste, among others); this
        // file's own `describeError` is for the server's refusals, a
        // different vocabulary.
        .catch((error: unknown) => {
          const candidates = platformChoices(error);
          if (candidates !== null) setDrawerAsk({ deviceId, text, candidates });
          else setPasteRefusal(refusalSentence(error));
        });
    },
    [withMirror, applyDocChange, doc],
  );

  // ADR-0052 §5 — "when a chassis is selected
  // at the faceplate stop and canDraw or a capture exists." `Drawing.tsx`
  // decides WHEN this runs (a chassis selected, the camera at the
  // faceplate stop); this decides WHAT it draws — the real `ConfigDrawer`
  // when either half of that "or" holds, `null` (nothing mounts, no dim)
  // otherwise, mirroring `captureOf`'s own read of `doc`'s provenance
  // rather than the paste reply this session just got (ADR-0052 §3: "on
  // reopen the gutter is derived from provenance spans... never stored
  // twice" — true of every render, not only a reopen).
  const renderConfigDrawer = useCallback(
    (chassis: ChassisView) => {
      const capture = doc != null ? captureOf(doc, chassis.deviceId) : null;
      if (!canDraw && capture == null) return null;
      return (
        // Keyed to the device: `Drawing.tsx` mounts this at the same
        // position under the faceplate regardless of which chassis is
        // selected, so with no key React would keep the previous device's
        // `ConfigDrawer` instance (and therefore its own paste-box state)
        // mounted across a selection change. A fresh key forces a fresh
        // instance — a fresh, empty paste box — every time the selected
        // device changes.
        <ConfigDrawer
          key={chassis.deviceId}
          chassis={chassis}
          capture={capture}
          canDraw={canDraw}
          onPaste={(text) => handlePasteInto(chassis.deviceId, text)}
          onLineHover={setHoverPortLabel}
          onLineSelect={setSelectedLinePortLabel}
          refusal={pasteRefusal}
        />
      );
    },
    [doc, canDraw, handlePasteInto, pasteRefusal],
  );

  // ADR-0051 "Inside a box" — `mirror.inside`
  // is synchronous once the module holds the document (`Mirror`'s own
  // contract), but the module itself may still be booting the first time a
  // chassis reaches this stop — `mirrorRef.current == null` then, and
  // nothing renders rather than call a method on a mirror that is not
  // there yet; `forceMirrorRerender` (above) is what asks this to run
  // again the moment it is.
  const renderInsideStop = useCallback(
    (chassis: ChassisView) => {
      if (mirrorRef.current == null) return null;
      // Loaded on demand, the same reference-equality dedupe `withMirror`
      // above uses: this stop needs the module in step with `doc` right
      // now, synchronously (`Mirror.inside` has no async door to await
      // one), but only pays the reload when the module is actually stale.
      // A trapped or refused mirror is dropped, never thrown from a render: the discard is deferred
      // (it sets state) and the stop shows nothing until the next need boots another.
      const mirror = mirrorRef.current;
      const discardLater = () =>
        queueMicrotask(() => {
          if (mirrorRef.current === mirror) discardTrapped();
        });
      try {
        if (doc != null && mirrorLoadedDocRef.current !== doc) loadInto(mirror, doc, discardLater);
        const faces = mirror.inside(chassis.deviceId);
        return <InsideStop chassis={chassis} faces={faces} litPortLabel={litPortLabel} />;
      } catch {
        discardLater();
        return null;
      }
    },
    [litPortLabel, doc, loadInto, discardTrapped],
  );

  const realView = useMemo<ClosetView>(
    () => (doc ? viewOf(doc, catalogue) : { premisesId: '', racks: [], cables: [], rows: [], surfaces: [], unplaced: [], free: [], lines: [], labels: [] }),
    [doc, catalogue],
  );

  // An empty design (no premises yet, or a premises with no racks) has
  // nothing to drop a device onto — this stand-in rack gives it one. It is
  // never written to the document; `handlePlace` mints the real Premises
  // and Rack (`ensureRackToPlaceInto`) only when something is actually
  // dropped onto it, never on load.
  const displayView = useMemo<ClosetView>(
    () =>
      realView.racks.length > 0 || realView.free.length > 0 || realView.labels.length > 0
        ? realView
        : {
            premisesId: realView.premisesId,
            racks: [PENDING_RACK_VIEW],
            cables: realView.cables,
            rows: [{ label: null, racks: [PENDING_RACK_VIEW] }],
            surfaces: realView.surfaces,
            unplaced: realView.unplaced,
            free: realView.free,
            lines: realView.lines,
            labels: realView.labels,
          },
    [realView],
  );
  const words = useMemo(() => layerWords(doc, displayView, layers), [doc, displayView, layers]);

  // The Cables list. `cableGroupsState`'s own initial value is read from
  // storage synchronously (never a placeholder that then flashes every
  // cable): the lazy `useState` initialiser runs before the first render,
  // and the only case it cannot cover — nothing stored yet, needing the
  // real `view` to pick a default type list — starts at the empty state,
  // which draws exactly the same as that default (every group unticked)
  // until the effect below replaces it.
  const EMPTY_CABLE_GROUPS_STATE: StoredCableGroupsState = { groups: [], none: false, hiddenCableIds: [] };
  const [cableGroupsDesignId, setCableGroupsDesignId] = useState(designId);
  const [cableGroupsState, setCableGroupsStateRaw] = useState<StoredCableGroupsState>(
    () => loadCableGroupsState(designId) ?? EMPTY_CABLE_GROUPS_STATE,
  );
  const [cableGroupsNeedsDefault, setCableGroupsNeedsDefault] = useState(() => loadCableGroupsState(designId) == null);

  // Switching design without remounting this component: reset during
  // render, the moment the prop itself changes, rather than one render
  // late through an effect — the same "derived state" pattern React's own
  // docs give for a prop-keyed reset.
  if (designId !== cableGroupsDesignId) {
    setCableGroupsDesignId(designId);
    const stored = loadCableGroupsState(designId);
    setCableGroupsStateRaw(stored ?? EMPTY_CABLE_GROUPS_STATE);
    setCableGroupsNeedsDefault(stored == null);
  }

  useEffect(() => {
    if (!cableGroupsNeedsDefault || doc == null) return;
    const initial = migratedOrDefaultCableGroupsState(displayView);
    setCableGroupsStateRaw(initial);
    saveCableGroupsState(designId, initial);
    setCableGroupsNeedsDefault(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `displayView` is read fresh at the one moment this runs (doc arriving, or nothing stored for this design); it is not meant to re-run on every later view change.
  }, [doc, designId, cableGroupsNeedsDefault]);

  // Two tabs open on the same design: another tab's own save fires a
  // `storage` event in this one: take its state rather than keep drawing a
  // filter this tab's own click never made.
  useEffect(() => {
    const key = cableGroupsStorageKey(designId);
    function onStorage(event: StorageEvent): void {
      if (event.key !== key) return;
      const next = loadCableGroupsState(designId);
      if (next) setCableGroupsStateRaw(next);
    }
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [designId]);

  const setCableGroupsState = useCallback(
    (next: StoredCableGroupsState) => {
      setCableGroupsStateRaw(next);
      saveCableGroupsState(designId, next);
    },
    [designId],
  );

  // A hidden id whose cable no longer exists anywhere in the design drops
  // here, once; a stored group that stops resolving drops in
  // `resolveStoredGroups` itself. Either dropping something is what makes
  // `effectiveCableGroupsState` differ from the raw stored value below —
  // the effect right after persists that drop, once, rather than on every
  // render.
  const existingCableIds = useMemo(() => new Set(displayView.cables.map((c) => c.id)), [displayView.cables]);
  const prunedCableGroupsState = useMemo(
    () => withHiddenCablesPruned(cableGroupsState, existingCableIds),
    [cableGroupsState, existingCableIds],
  );
  const { state: effectiveCableGroupsState, rows: resolvedCableGroupRows } = useMemo(
    () => (doc ? resolveStoredGroups(doc, displayView, prunedCableGroupsState) : { state: prunedCableGroupsState, rows: [], droppedRefKeys: [] }),
    [doc, displayView, prunedCableGroupsState],
  );
  useEffect(() => {
    if (effectiveCableGroupsState !== cableGroupsState) {
      setCableGroupsStateRaw(effectiveCableGroupsState);
      saveCableGroupsState(designId, effectiveCableGroupsState);
    }
  }, [effectiveCableGroupsState, cableGroupsState, designId]);

  const tickedCableGroups = useMemo(
    () => resolvedCableGroupRows.filter((r) => r.stored.on).map((r) => r.resolved),
    [resolvedCableGroupRows],
  );
  const closetCableIds = useMemo(() => closetCableIdSet(displayView), [displayView]);
  const hiddenCableIdSet = useMemo(() => new Set(effectiveCableGroupsState.hiddenCableIds), [effectiveCableGroupsState.hiddenCableIds]);
  const cableDraw = useMemo(
    () => computeCableDraw([...closetCableIds], hiddenCableIdSet, effectiveCableGroupsState.none, tickedCableGroups),
    [closetCableIds, hiddenCableIdSet, effectiveCableGroupsState.none, tickedCableGroups],
  );
  const cablesGroupsSummary = isCableGroupsFiltered(effectiveCableGroupsState)
    ? `${cableDraw.drawnIds.size} of ${closetCableIds.size}`
    : null;
  const cablesFiltered = isCableGroupsFiltered(effectiveCableGroupsState);
  useEffect(() => {
    onShownCablesChange?.(cablesFiltered ? cableDraw.drawnIds : null);
  }, [onShownCablesChange, cablesFiltered, cableDraw]);
  const hiddenCablesInClosetCount = closetHiddenCableCount(displayView, effectiveCableGroupsState.hiddenCableIds);

  const handleToggleCableHidden = useCallback(
    (cableId: string) => {
      setCableGroupsState(
        effectiveCableGroupsState.hiddenCableIds.includes(cableId)
          ? withCableShown(effectiveCableGroupsState, cableId)
          : withCableHidden(effectiveCableGroupsState, cableId),
      );
    },
    [effectiveCableGroupsState, setCableGroupsState],
  );
  const handleIsCableHidden = useCallback(
    (cableId: string) => effectiveCableGroupsState.hiddenCableIds.includes(cableId),
    [effectiveCableGroupsState],
  );
  const handleShowAllHiddenCables = useCallback(
    () => setCableGroupsState(withAllCablesShown(effectiveCableGroupsState)),
    [effectiveCableGroupsState, setCableGroupsState],
  );

  const cablesGroupsPopover =
    doc != null ? (
      <CableGroupsPopover
        doc={doc}
        view={displayView}
        state={effectiveCableGroupsState}
        rows={resolvedCableGroupRows}
        onStateChange={setCableGroupsState}
        drawnCount={cableDraw.drawnIds.size}
        totalCount={closetCableIds.size}
        onShowAllHidden={handleShowAllHiddenCables}
      />
    ) : undefined;

  // Path trace (ADR-0061 item 9): the same module; opened from a device's right-click.
  const trace = useTraceController({ doc, view: realView, boot: ensureMirror, mirrorNow });

  // Resolves the current selection to a rack id, however it was reached;
  // anything not rack-shaped reports `null`.
  useEffect(() => {
    if (!onActiveRackChange) return;
    if (selection == null) {
      onActiveRackChange(null);
      return;
    }
    if (selection.kind === 'rack') {
      onActiveRackChange(selection.id);
      return;
    }
    if (selection.kind === 'chassis') {
      for (const rack of realView.racks) {
        if (rack.chassis.some((c) => c.id === selection.id)) {
          onActiveRackChange(rack.id);
          return;
        }
      }
      onActiveRackChange(null);
      return;
    }
    if (selection.kind === 'shelf' || selection.kind === 'occupant') {
      for (const rack of realView.racks) {
        const hit = rack.shelves.some(
          (shelf) => shelf.id === selection.id || shelf.occupants.some((o) => o.id === selection.id),
        );
        if (hit) {
          onActiveRackChange(rack.id);
          return;
        }
      }
    }
    onActiveRackChange(null);
  }, [selection, realView, onActiveRackChange]);

  const handlePlace = useCallback(
    (rackId: string, catalogueRef: { vendor: string; model: string; role?: string }, positionU: number) => {
      if (doc == null) return;
      // ADR-0053 §3, same stamp `useDesignSession.ts`'s `handleEdit` gives
      // every field write — every command dispatched from here (creating a
      // premises/rack to drop the first device into, placing or moving a
      // chassis) is stamped with the signed-in account's ulid too, so its
      // provenance names who really made it rather than falling through to
      // `document/model.ts`'s `LOCAL_ACTOR` read-side sentinel (undoable by
      // nobody — ADR-0053's "you undo your own changes" has no "you" for
      // that stamp).
      const opts = actorOpts(accountId);

      // ADR-0051 §1/§2 — the palette's own two
      // extra rows (`racks/palette.ts`'s `SKETCH_DEVICE_PALETTE_ITEM`/
      // `BOARD_PALETTE_ITEM`) are told apart from a real catalogue drop by
      // vendor alone, before either ever reaches the `catalogue.find` below.
      if (isSketchDevicePaletteItem(catalogueRef)) {
        let working = doc;
        let targetRackId = rackId;
        if (rackId === PENDING_RACK_ID) {
          const ensured = ensureRackToPlaceInto(working, realView.premisesId === '' ? null : realView.premisesId, opts);
          working = ensured.doc;
          targetRackId = ensured.rackId;
        }
        try {
          // `createSketchDevice` returns a `Document` only, like every
          // command in `document/commands.ts` — the fresh `Chassis` id is
          // found the same way `racks/emptyDesign.ts`'s own
          // `ensureRackToPlaceInto` finds a fresh `Rack`: diffing
          // `doc.nodes` against the ids that existed before the call.
          const beforeIds = new Set(working.nodes.map((n) => n.id));
          // A common device (ADR-0060 decision 4) arrives named, such as router-1, with its role set.
          const role = catalogueRef.role !== undefined && isDeviceRole(catalogueRef.role) ? catalogueRef.role : null;
          const withDevice = createSketchDevice(
            working,
            role !== null ? { ...(opts ?? {}), hostname: nextHostname(hostnamesOf(working), role) } : (opts ?? {}),
          );
          const chassisNode = withDevice.nodes.find((n) => !beforeIds.has(n.id) && parseNodeId(n.id).kind === 'Chassis');
          if (!chassisNode) return;
          let placed = movePlacement(withDevice, chassisNode.id, { kind: 'rack', rackId: targetRackId, positionU, face: 'front' }, opts);
          const deviceNode = role !== null ? withDevice.nodes.find((n) => !beforeIds.has(n.id) && parseNodeId(n.id).kind === 'Device') : undefined;
          if (role !== null && deviceNode) placed = setDeviceField(placed, deviceNode.id, 'role', role, opts);
          for (const run of role !== null ? (DEFAULT_FACEPLATES[role] ?? []) : []) {
            placed = addSketchPortRange(placed, chassisNode.id, { ...run, face: 'front' }, opts);
          }
          applyDocChange(oneUndoStep(placed, working.batches.length));
        } catch {
          // As below: `Drawing` checked this drop against a view that
          // turned out to be stale. Leave the document as it was.
        }
        return;
      }

      if (isBoardPaletteItem(catalogueRef)) {
        // A board is `FixedTo` a SURFACE, never a rack — the one drop
        // target this drawing has today (`Drawing.tsx`'s `handleDrop`, off
        // limits this session) only ever resolves a rack under the
        // pointer, so there is no surface this drop can honestly name yet.
        // The row is offered (and `document/commands.ts`'s `createBoard` is
        // real and tested) so a surface drop zone is a small, later, wholly
        // additive change to `Drawing.tsx` rather than a new mechanism.
        return;
      }

      const model = catalogue.find((m) => m.vendor === catalogueRef.vendor && m.model === catalogueRef.model);
      if (!model) return; // the palette only ever offers models drawn from `catalogue` itself

      let working = doc;
      let targetRackId = rackId;
      if (rackId === PENDING_RACK_ID) {
        const ensured = ensureRackToPlaceInto(working, realView.premisesId === '' ? null : realView.premisesId, opts);
        working = ensured.doc;
        targetRackId = ensured.rackId;
      }

      try {
        applyDocChange(placeChassis(working, targetRackId, model, positionU, 'front', opts));
      } catch {
        // `Drawing` already checked this drop for range/overlap against the
        // view it was given before calling `onPlace`; a command-level
        // refusal here can only mean that view was stale. Leave the
        // document exactly as it was rather than apply a half-formed edit.
      }
    },
    [doc, catalogue, realView.premisesId, applyDocChange, accountId],
  );

  // ADR-0060 step 7: free boxes, lines and areas. Each is one undo step; a refusal leaves the document as it was.
  const freeWrite = useCallback(
    <T,>(make: (d: Document, opts: { actor: string } | undefined) => { doc: Document; out: T }): T | undefined => {
      if (doc == null) return undefined;
      try {
        const r = make(doc, actorOpts(accountId));
        applyDocChange(r.doc);
        return r.out;
      } catch (e) {
        const refusal = refusalFor(e);
        if (refusal != null) setCanvasNotice(refusal.refused);
        return undefined;
      }
    },
    [doc, accountId, applyDocChange],
  );
  const handleAddFreeBox = useCallback(
    (role: string | null, x: number, y: number, fromBoxId?: string) =>
      freeWrite((d, o) => {
        const r = addFreeBoxDoc(d, role, x, y, fromBoxId, o);
        return { doc: r.doc, out: r.chassisId };
      }),
    [freeWrite],
  );
  // ADR-0060 decision 10: Open goes into a device ("jot mode"). Drawing stays mounted beneath, so its camera is
  // where it was on the way back; the way out is Esc, the bar's path, or the Back button.
  const [jot, setJot] = useState<{ id: string; origin: { x: number; y: number } | null; inside: boolean } | null>(null);
  const realViewRef = useRef(realView);
  realViewRef.current = realView;
  const onDeviceOpenedRef = useRef(onDeviceOpened);
  onDeviceOpenedRef.current = onDeviceOpened;
  const handleOpenDevice = useCallback((id: string, inside: boolean, at: { x: number; y: number } | null) => {
    setSelection({ kind: 'chassis', id });
    setJot({ id, origin: at, inside });
    onDeviceOpenedRef.current?.(id, deviceChassis(realViewRef.current, id)?.hostname ?? '');
  }, []);
  const leaveJot = useCallback(() => setJot(null), []);

  // ADR-0061 §7: a config pasted anywhere on the canvas. The gate runs in the module (`previewPaste`)
  // before the card shows; the card's choice is the only thing that writes. The raw text is never kept.
  const [pasteState, setPasteState] = useState<PasteState | null>(null);
  const openSpot = useCallback(() => {
    const taken = [...realView.free.map((f) => ({ x: f.x, y: f.y, w: BOX_W, h: BOX_H })), ...realView.labels.map((l) => ({ x: l.x, y: l.y, w: l.form === 'area' ? l.w : 64, h: l.form === 'area' ? l.h : 22 }))];
    return nextFreeSpot(taken);
  }, [realView.free, realView.labels]);
  // Held only while the card asks "which device is this from?"; cleared on every other outcome.
  const pendingPasteRef = useRef<string | null>(null);
  const startPaste = useCallback(
    (text: string, platform?: PastePlatform) => {
      if (doc == null || !canDraw) return;
      pendingPasteRef.current = null;
      setPasteState({ kind: 'reading' });
      withMirror()
        .then((mirror) => {
          const at = openSpot();
          const preview = previewPaste(mirror, doc, text, at, actorOpts(accountId), platform);
          // The module now holds the scratch design the preview was read from.
          mirrorLoadedDocRef.current = null;
          setPasteState({ kind: 'card', preview, base: doc });
        })
        .catch((error: unknown) => {
          mirrorLoadedDocRef.current = null;
          const candidates = platformChoices(error);
          if (candidates !== null) {
            pendingPasteRef.current = text;
            setPasteState({ kind: 'which', candidates });
            return;
          }
          setPasteState({ kind: 'refused', message: tidySentence(refusalFor(error)?.refused ?? refusalSentence(error)) });
        });
    },
    [doc, canDraw, withMirror, openSpot, accountId],
  );
  const handlePasteConfig = useCallback(() => {
    // A right-click is a gesture, so the browser may let the page read the clipboard; if not, the card has a box.
    const read = navigator.clipboard?.readText?.bind(navigator.clipboard);
    if (read === undefined) return setPasteState({ kind: 'ask' });
    read().then(
      (text) => (worthReading(text) ? startPaste(text) : setPasteState({ kind: 'ask' })),
      () => setPasteState({ kind: 'ask' }),
    );
  }, [startPaste]);
  const handlePasteChoice = useCallback(
    (choice: 'attach' | 'add') => {
      if (pasteState?.kind !== 'card') return;
      const { preview } = pasteState;
      if (pasteState.base !== doc) {
        // The design moved on while the card was open; applying the preview would undo that.
        setPasteState({ kind: 'refused', message: 'The design changed while this was open. Paste it again.' });
        return;
      }
      const next = choice === 'attach' && preview.attachDoc != null ? preview.attachDoc : preview.addDoc;
      const chassisId = choice === 'attach' ? (preview.match?.chassisId ?? null) : preview.addChassisId;
      applyDocChange(next);
      if (chassisId !== null) setSelection({ kind: 'chassis', id: chassisId });
      setPasteState(null);
    },
    [pasteState, doc, applyDocChange],
  );
  useEffect(() => {
    if (!canDraw || doc == null) return;
    const onPaste = (event: ClipboardEvent) => {
      const el = event.target instanceof HTMLElement ? event.target : null;
      if (el !== null && (el.isContentEditable || /^(input|textarea|select)$/i.test(el.tagName))) return;
      const text = event.clipboardData?.getData('text/plain') ?? '';
      if (!worthReading(text)) return;
      event.preventDefault();
      startPaste(text);
    };
    document.addEventListener('paste', onPaste);
    return () => document.removeEventListener('paste', onPaste);
  }, [canDraw, doc, startPaste]);

  const jotOrigin = useMemo(() => (jot ? originOf(realView, jot.id, jot.origin) : { x: 0, y: 0 }), [jot, realView]);
  const jotPlateList = useMemo(() => (jot ? jotPlates(realView, jot.id, jotOrigin) : null), [jot, realView, jotOrigin]);
  // The device went away (an undo, a remove from elsewhere): back out rather than leave an empty room.
  useEffect(() => {
    if (jot != null && doc != null && jotPlateList === null) setJot(null);
  }, [jot, doc, jotPlateList]);
  const handleJotConnect = useCallback(
    (fromPortId: string, toPortId: string) => {
      if (doc == null) return;
      if (checks.api.guardCable(fromPortId, toPortId, mediaCandidates(realView, fromPortId, toPortId))) return;
      try {
        applyDocChange(connectPorts(doc, fromPortId, toPortId, { sheath: 'grey' }, actorOpts(accountId)));
      } catch (e) {
        if (e instanceof IncompatibleConnectorError) setCanvasNotice(`Those two ports can't be cabled together: ${e.reason}`);
        else if (e instanceof PortAlreadyTerminatedError) setCanvasNotice('One of those ports already has a cable. A port takes one.');
        else setCanvasNotice(refusalFor(e)?.refused ?? 'That cable could not be made.');
      }
    },
    [doc, applyDocChange, accountId, checks.api, realView],
  );
  const handleJotAddPort = useCallback(
    (chassisId: string) => {
      const chassis = deviceChassis(realView, chassisId);
      if (!chassis) return;
      const taken = new Set(chassis.ports.map((p) => p.label));
      let n = chassis.ports.length + 1;
      while (taken.has(String(n))) n += 1;
      void freeWrite((d, o) => ({ doc: addSketchPort(d, chassisId, { label: String(n), connector: 'rj45', face: 'front' }, o), out: null }));
    },
    [realView, freeWrite],
  );

  // ADR-0060 decision 4: a click in the equipment list adds the item where there
  // is room, the rack in use first; a backboard goes on the first wall.
  const handlePick = useCallback(
    (item: PaletteItem) => {
      if (doc == null) return;
      if (isBoardPaletteItem(item)) {
        const surface = realView.surfaces[0];
        if (!surface) return;
        try {
          applyDocChange(createBoard(doc, surface.id, { ...(actorOpts(accountId) ?? {}), label: 'Backboard' }));
        } catch {
          // As `handlePlace`: a refusal leaves the document as it was.
        }
        return;
      }
      if (jot != null && jotPlateList != null) {
        const at = jotSpot(jotPlateList);
        handleAddFreeBox(item.role ?? null, jotOrigin.x + at.x, jotOrigin.y + at.y);
        return;
      }
      if (displayView.racks.length === 0) {
        // Only free boxes so far: the pick lands on the next open spot of the canvas.
        const at = openSpot();
        handleAddFreeBox(item.role ?? null, at.x, at.y);
        return;
      }
      for (const rack of racksInPickOrder(displayView.racks, selection)) {
        const positionU = highestFreeU(rack, item.rackUnits);
        if (positionU !== null) {
          handlePlace(rack.id, item, positionU);
          return;
        }
      }
    },
    [doc, realView.surfaces, openSpot, displayView.racks, selection, handlePlace, handleAddFreeBox, applyDocChange, accountId, jot, jotPlateList, jotOrigin],
  );

  const handleMove = useCallback(
    (chassisId: string, rackId: string, positionU: number) => {
      if (doc == null) return;
      try {
        // ADR-0053 §3 — same stamp as `handlePlace` above.
        applyDocChange(moveChassis(doc, chassisId, rackId, positionU, 'front', actorOpts(accountId)));
      } catch {
        // As `handlePlace` above: the drawing validated the drop against a
        // view that turned out to be stale. Leave the document as it was.
      }
    },
    [doc, applyDocChange, accountId],
  );

  // UI-SPEC "Drag-to-connect" — `DrawingActions.onConnect` was left unwired
  // here; `document/cables.ts`'s `connectPorts` is the write side, wired
  // the same way `handlePlace`/`handleMove` are.
  const handleConnect = useCallback(
    (fromPortId: string, toPortId: string, sheath: Sheath) => {
      if (doc == null) return;
      try {
        applyDocChange(connectPorts(doc, fromPortId, toPortId, { sheath }, actorOpts(accountId)));
      } catch {
        // As `handlePlace`/`handleMove` above.
      }
    },
    [doc, applyDocChange, accountId],
  );

  // UI-SPEC "Delete/Backspace on a selected cable" — the canvas's own
  // shortcut was left unwired like `onConnect`; same `document/cables.ts`
  // `disconnect` the editor panel's own "Disconnect" button already reaches
  // through `handleEdit`'s `'cable-disconnect'` kind, not a second command.
  const handleDisconnect = useCallback(
    (cableId: string) => {
      if (doc == null) return;
      try {
        applyDocChange(disconnect(doc, cableId, actorOpts(accountId)));
      } catch {
        // As `handleConnect` above.
      }
    },
    [doc, applyDocChange, accountId],
  );

  // UI-SPEC's cable-delete rule — Delete/Backspace on a selected device,
  // the same shape `handleDisconnect` above already gives a selected
  // cable: `document/commands.ts`'s `removeChassis`, the one command the
  // panel's "Remove device" button reaches too (through `handleEdit`'s
  // `'device-remove'` kind), not a second one.
  const handleRemoveDevice = useCallback(
    (chassisId: string) => {
      if (doc == null) return;
      try {
        applyDocChange(removeChassis(doc, chassisId, actorOpts(accountId)));
      } catch {
        // As `handleDisconnect` above.
      }
    },
    [doc, applyDocChange, accountId],
  );

  // A wall, floor or desk. A brand-new design has no premises yet, so one is
  // made alongside the surface, the way `handlePlace` makes one for a rack.
  const handleAddSurface = useCallback(
    (label: string, form: string): { refused: string } | void => {
      if (doc == null) return;
      if (realView.premisesId !== '') return handleEdit({ kind: 'create-surface', premisesId: realView.premisesId, label, form });
      try {
        // As `handleEdit`'s own 'create-surface' branch.
        if (!isSurfaceForm(form)) throw new FieldValueError('Surface.form', form, `is not one of: ${SURFACE_FORMS.join(', ')}`);
        const opts = actorOpts(accountId);
        const created = createPremises(doc, opts);
        applyDocChange(createSurface(created.doc, created.premisesId, { ...(opts ?? {}), label, form }));
      } catch (e) {
        return refusalFor(e);
      }
    },
    [doc, realView.premisesId, handleEdit, applyDocChange, accountId],
  );

  // The right-click menu's actions (ADR-0060 decision 4).
  const handleAddRack = useCallback(
    (heightU: number) => {
      if (doc == null) return;
      const label = nextName(realView.racks.map((r) => r.label), 'Rack');
      try {
        const premisesId = realView.premisesId === '' ? null : realView.premisesId;
        applyDocChange(addRack(doc, premisesId, { ...(actorOpts(accountId) ?? {}), label, heightU }).doc);
      } catch {
        // As `handlePlace`: a refusal leaves the document as it was.
      }
    },
    [doc, realView.premisesId, realView.racks, applyDocChange, accountId],
  );
  const handleAddWall = useCallback(() => {
    handleAddSurface(nextName(realView.surfaces.map((s) => s.label), 'Wall'), 'wall');
  }, [realView.surfaces, handleAddSurface]);
  const handleAddDevice = useCallback(
    (rackId: string) => {
      const rack = displayView.racks.find((r) => r.id === rackId);
      const positionU = rack ? highestFreeU(rack, SKETCH_DEVICE_PALETTE_ITEM.rackUnits) : null;
      if (positionU !== null) handlePlace(rackId, SKETCH_DEVICE_PALETTE_ITEM, positionU);
      else if (rack) setCanvasNotice(NO_ROOM_ADD);
    },
    [displayView.racks, handlePlace],
  );
  const handleDuplicateDevice = useCallback(
    (chassisId: string) => {
      const result = handleEdit({ kind: 'duplicate-device', chassisId });
      // The copy was made but could not be placed; the details panel shows the
      // same sentence, but a right-click may have no panel open.
      if (result != null && 'refused' in result) setCanvasNotice(result.refused);
    },
    [handleEdit],
  );

  const handleAddDeviceAt = useCallback(
    (rackId: string, positionU: number, role: string | null) => handlePlace(rackId, role !== null ? { ...SKETCH_DEVICE_PALETTE_ITEM, role } : SKETCH_DEVICE_PALETTE_ITEM, positionU),
    [handlePlace],
  );
  const handleMoveFree = useCallback((moves: readonly { id: string; x: number; y: number }[]) => void freeWrite((d, o) => ({ doc: moveFree(d, moves, o), out: null })), [freeWrite]);
  const handleConnectBoxes = useCallback((a: string, b: string) => void freeWrite((d, o) => ({ doc: createLine(d, a, b, o).doc, out: null })), [freeWrite]);
  const handleAddLabel = useCallback(
    (form: 'text' | 'area', text: string, x: number, y: number, w?: number, h?: number) =>
      freeWrite((d, o) => {
        const r = createLabel(d, { ...o, text, form, x, y, ...(w !== undefined ? { w } : {}), ...(h !== undefined ? { h } : {}) });
        return { doc: r.doc, out: r.id };
      }),
    [freeWrite],
  );
  const handleSetLabel = useCallback((id: string, patch: { text?: string; w?: number; h?: number }) => void freeWrite((d, o) => ({ doc: setLabel(d, id, patch, o), out: null })), [freeWrite]);
  const handleRemoveFree = useCallback((ids: readonly string[]) => void freeWrite((d, o) => ({ doc: removeFree(d, ids, o), out: null })), [freeWrite]);
  const handleDuplicateFree = useCallback(
    (ids: readonly string[], dx: number, dy: number) =>
      freeWrite((d, o) => {
        const r = duplicateFreeDoc(d, realView, ids, dx, dy, o);
        return { doc: r.doc, out: r.ids };
      }),
    [freeWrite, realView],
  );
  const handleResizeShelf = useCallback(
    (shelfId: string, change: { heightU?: number; slots?: number }, preview: boolean) => {
      if (!preview) {
        const result = handleEdit({ kind: 'shelf-size', id: shelfId, ...change });
        if (result != null && 'refused' in result) return result;
        return;
      }
      // The same command the drop will run, run on a copy: the grips name what is in the way live.
      if (doc == null) return;
      try {
        resizeShelf(doc, shelfId, change, { catalogue, ...(actorOpts(accountId) ?? {}) });
      } catch (e) {
        return refusalFor(e) ?? undefined;
      }
    },
    [handleEdit, doc, catalogue, accountId],
  );

  // `handleEdit` (ADR-0046 §2's one editor) now lives in
  // `useDesignSession`, so the exact same
  // function `InventoryPlace`'s own `EditorFor` call raises through runs
  // here too: "an edit here is the same edit there."
  // ADR-0047: the editor is absent, not empty, when nothing is selected —
  // an empty fragment here would still mount the surface and take its width.
  const selectedPanel =
    doc != null && !(selection?.kind === 'chassis' && selection.id === calloutId)
      ? EditorFor(
          selection,
          displayView,
          {
            onEdit: canDraw ? handleEdit : undefined,
            onSelect: setSelection,
            // ADR-0053 §5/§6 — every reader may read a Notes section; only a
            // writer may add or remove one.
            notesOf: notesActions.notesOf,
            onAddNote: canDraw ? notesActions.onAddNote : undefined,
            onRemoveNote: canDraw ? notesActions.onRemoveNote : undefined,
            // ADR-0059 — every reader may read
            // a Tags section; only a writer may add or remove one.
            tagsOf: tagsActions.tagsOf,
            allTags: tagsActions.allTags,
            onAddTag: canDraw ? tagsActions.onAddTag : undefined,
            onRemoveTag: canDraw ? tagsActions.onRemoveTag : undefined,
            onRenameTag: canDraw ? tagsActions.onRenameTag : undefined,
            fieldsOf: fieldsActions.fieldsOf,
            onSetField: canDraw ? fieldsActions.onSetField : undefined,
            onAddFieldDef: canDraw ? fieldsActions.onAddFieldDef : undefined,
            onRemoveFieldDef: canDraw ? fieldsActions.onRemoveFieldDef : undefined,
            // A view choice, offered to every reader regardless of
            // `canDraw`.
            isCableHidden: handleIsCableHidden,
            onToggleCableHidden: handleToggleCableHidden,
          },
          paletteFromCatalogue(catalogue),
        )
      : null;
  const editor = saveRefusal != null ? (
      <div className="racks-place__refusal">
        {saveRefusal}
        {/* ADR-0054 §1's refusal wash "offers reload". */}
        <button type="button" className="racks-place__refusal-reload" onClick={reloadDesign}>
          Reload
        </button>
      </div>
    ) : selectedPanel != null ? (
      <>
        {selectedPanel}
        {selection?.kind === 'chassis' && doc != null ? <DeviceIssues controller={trouble} chassisId={selection.id} deviceId={edgesIn(doc, selection.id, 'HasChassis')[0]?.from ?? ''} /> : null}
        {selection?.kind === 'chassis' && onOpenInventory ? (
          <button type="button" className="racks-place__open-inventory" onClick={() => onOpenInventory(selection.id)}>
            Open in inventory
          </button>
        ) : null}
      </>
    ) : null;

  // ADR-0052 §5 — "the rail shows no palette
  // and no add controls" for a reader: the whole rail is empty rather than
  // showing a palette that could never place anything or a surface control
  // that could never write.
  const rail = canDraw ? (
    <>
      <AddSurfaceControl onAdd={handleAddSurface} />
      {/* ADR-0051 §1/§2 — `paletteRows` adds
          the sketch-device and board rows beside the catalogue's own
          models; `AddShelfControl`'s own model dropdown (inside `editor`
          above) keeps using plain `paletteFromCatalogue` so a shelf's
          optional model never offers either as if it were a real one. */}
      <Palette palette={paletteRows(catalogue)} onPick={handlePick} />
    </>
  ) : null;

  // The bar's path gains the open device; the part before it leads back out.
  const jotDevice = jot != null ? deviceChassis(realView, jot.id) : undefined;
  const jotPath: PathPart[] =
    jotDevice != null && shellProps.path.length > 0
      ? [
          ...shellProps.path.slice(0, -1),
          { ...shellProps.path[shellProps.path.length - 1]!, onSelect: () => { shellProps.path[shellProps.path.length - 1]!.onSelect?.(); leaveJot(); } },
          { label: jotDevice.hostname || 'unnamed' },
        ]
      : shellProps.path;

  return (
    <Shell {...shellProps} path={jotPath} look={{ value: look, onChange: changeLook }} layers={{ value: layers, onToggle: toggleLayer, style: { value: diagramStyle, onChange: changeDiagramStyle } }} onZoomFit={() => setFitRequest((n) => n + 1)} editor={editor} history={historyView?.panel} rail={rail} viewOnly={!canDraw} cablesGroupsPopover={cablesGroupsPopover} cablesGroupsSummary={cablesGroupsSummary} hiddenCablesCount={hiddenCablesInClosetCount} onShowAllHiddenCables={handleShowAllHiddenCables} barExtra={
        doc != null ? (
          <>
            <PlansBarChip controller={plans} />
            <ChecksBarChip controller={checks} />
          </>
        ) : undefined
      }
      band={doc != null && plans.bandOpen ? <PlanBand controller={plans} /> : undefined}
    >
      <ChecksContext.Provider value={checks.api}>
      {historyView?.banner != null ? (
        <div className="history-banner" role="status" data-testid="history-banner">
          {historyView.banner}
        </div>
      ) : null}
      <CheckMarksContext.Provider value={layerOn(layers, 'checks')}>
      <PlansContext.Provider value={plans.store}>
      <TroubleContext.Provider value={trouble.store}>
      <TraceContext.Provider value={trace.store}>
      {doc == null ? (
        <div className="racks-place__loading">{loadError ?? <SkeletonRacks label="Opening the design…" />}</div>
      ) : look === 'diagram' ? (
        <DiagramDrawing
          view={displayView}
          selected={selection}
          onSelect={setSelection}
          zoom={shellProps.zoom}
          onZoomChange={onZoomChange}
          fitRequest={fitRequest}
          drawnCableIds={cableDraw.drawnIds}
          dashedCableIds={cableDraw.dashedIds}
          words={words}
          style={diagramStyle}
        />
      ) : (
        <Drawing
          view={displayView}
          peers={session.live.people}
          selected={jot ? null : selection}
          zoom={shellProps.zoom}
          onZoomChange={onZoomChange}
          fitRequest={fitRequest}
          initialViewport={resumeView.initialViewport}
          onViewportSettled={resumeView.onViewportSettled}
          onPlace={handlePlace}
          onMove={handleMove}
          onConnect={handleConnect}
          onDisconnect={handleDisconnect}
          onRemoveDevice={handleRemoveDevice}
          onDuplicateDevice={canDraw ? handleDuplicateDevice : undefined}
          onAddDevice={canDraw ? handleAddDevice : undefined}
          onAddRack={canDraw ? handleAddRack : undefined}
          onAddWall={canDraw ? handleAddWall : undefined}
          onPasteConfig={canDraw ? handlePasteConfig : undefined}
          onOpenDevice={handleOpenDevice}
          onAddFreeBox={canDraw ? handleAddFreeBox : undefined}
          onAddDeviceAt={canDraw ? handleAddDeviceAt : undefined}
          onMoveFree={canDraw ? handleMoveFree : undefined}
          onConnectBoxes={canDraw ? handleConnectBoxes : undefined}
          onAddLabel={canDraw ? handleAddLabel : undefined}
          onSetLabel={canDraw ? handleSetLabel : undefined}
          onRemoveFree={canDraw ? handleRemoveFree : undefined}
          onDuplicateFree={canDraw ? handleDuplicateFree : undefined}
          onResizeShelf={canDraw ? handleResizeShelf : undefined}
          onSelect={setSelection}
          onPlanChange={canDraw ? plans.planChange : undefined}
          onItsDown={canDraw ? trouble.start : undefined}
          onCalloutChange={setCalloutId}
          canDraw={canDraw && jot === null}
          openRequest={openRequest}
          renderConfigDrawer={renderConfigDrawer}
          renderInsideStop={renderInsideStop}
          onTraceFrom={trace.openFrom}
          litPortLabel={litPortLabel}
          emptyHint={canDraw && realView.racks.length === 0 && (realView.surfaces?.length ?? 0) === 0 && realView.free.length === 0 && realView.labels.length === 0 ? EMPTY_HINT : null}
          drawnCableIds={cableDraw.drawnIds}
          dashedCableIds={cableDraw.dashedIds}
          // ADR-0053 §1/§3 — Ctrl Z / Ctrl
          // Shift Z, at `Drawing.tsx`'s own existing keydown site.
          onUndo={shellProps.onUndo}
          onRedo={shellProps.onRedo}
        />
      )}
      {jot != null && jotPlateList != null ? (
        <JotView
          key={jot.id}
          view={realView}
          deviceId={jot.id}
          origin={jotOrigin}
          canDraw={canDraw}
          selected={selection}
          litPortLabel={litPortLabel}
          startInside={jot.inside}
          onSelect={setSelection}
          onBack={leaveJot}
          onAddBox={handleAddFreeBox}
          onMoveBox={(id, x, y) => handleMoveFree([{ id, x, y }])}
          onConnect={handleJotConnect}
          onDisconnect={handleDisconnect}
          onRemoveBox={(id) => handleRemoveFree([id])}
          onAddPort={handleJotAddPort}
          onUndo={shellProps.onUndo}
          onRedo={shellProps.onRedo}
          fitRequest={fitRequest}
          paused={pasteState != null}
          renderConfigDrawer={renderConfigDrawer}
          renderInsideStop={renderInsideStop}
        />
      ) : null}
      {drawerAsk != null && pasteState == null ? (
        <PasteCard
          state={{ kind: 'which', candidates: drawerAsk.candidates }}
          onText={() => {}}
          onPlatform={(p) => handlePasteInto(drawerAsk.deviceId, drawerAsk.text, p)}
          onChoose={() => {}}
          onCancel={() => setDrawerAsk(null)}
        />
      ) : null}
      {pasteState != null ? (
        <PasteCard
          state={pasteState}
          onText={(t) => startPaste(t)}
          onPlatform={(p) => {
            const text = pendingPasteRef.current;
            if (text != null) startPaste(text, p);
          }}
          onChoose={handlePasteChoice}
          onCancel={() => {
            pendingPasteRef.current = null;
            setPasteState(null);
          }}
        />
      ) : null}
      {canvasNotice != null ? (
        <div className="racks-place__notice" role="status" data-testid="canvas-notice">
          {canvasNotice}
        </div>
      ) : null}
      {doc != null && !trace.open ? <ChecksSurface controller={checks} canShow={jot == null} /> : null}
      {doc != null ? <PlansSurface controller={plans} besideChecks={checks.open} /> : null}
      {doc != null && (trouble.draft != null || trouble.viewing != null) ? <TroublePanel controller={trouble} besideChecks={checks.open} besidePlans={plans.plan != null && plans.panelOpen && !plans.listMode} /> : null}
      {doc != null && jot == null ? <TracePanel controller={trace} /> : null}
      </TraceContext.Provider>
      </TroubleContext.Provider>
      </PlansContext.Provider>
      </CheckMarksContext.Provider>
      </ChecksContext.Provider>
    </Shell>
  );
}
