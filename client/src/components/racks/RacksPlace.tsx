import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { captureOf } from '../../document/capture';
import { connectPorts, disconnect, type Sheath } from '../../document/cables';
import { SURFACE_FORMS, createSketchDevice, moveChassis, movePlacement, placeChassis, removeChassis } from '../../document/commands';
import { parseNodeId, type Document } from '../../document/model';
import { viewOf, type ChassisView, type ClosetView } from '../../document/view';
import { Engine } from '../../engine/engine';
import { Mirror, refusalSentence } from '../../engine/mirror';
import { ConfigDrawer } from '../config/ConfigDrawer';
import { canDrawFor, refusalFor, type DesignSession } from '../design/useDesignSession';
import { Drawing, EditorFor, Palette, type NotesActions, type Selection } from '../drawing';
import { CAMERA_STOPS } from '../drawing/geometry';
import { InsideStop } from '../inside/InsideStop';
import type { ShellProps } from '../shell/types';
import { Shell } from '../Shell';
import { ensureRackToPlaceInto } from './emptyDesign';
import { isBoardPaletteItem, isSketchDevicePaletteItem, paletteFromCatalogue, paletteRows } from './palette';
import './racks.css';

// `canDrawFor`/`refusalFor` now live in `components/design/useDesignSession.ts`
// (this session's brief item 1) — re-exported here, unchanged, so the two
// test files that import them from `'./RacksPlace'`
// (`RacksPlace.canDraw.test.ts`, `RacksPlace.edit.test.ts`) keep passing
// without themselves needing to know the logic moved.
export { canDrawFor, refusalFor };

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

/**
 * ADR-0051 §1, this session's brief item 3 — "+ add a surface". There is no
 * premises editor (`EditorFor`'s own `Selection` has no `'premises'` kind
 * yet) and no separate page header for the Racks place
 * (`shell/types.ts`'s `ShellProps` has no header slot); the rail — this
 * place's one persistent control surface, today just `Palette` — is the
 * nearest thing that exists, so this sits above it. Disabled until a
 * premises exists: `createSurface` needs a real `premisesId`
 * (`document/commands.ts`'s own doc), and there is no standalone "make a
 * premises" command to reach for the way `handlePlace`'s
 * `ensureRackToPlaceInto` mints one alongside a rack.
 */
function AddSurfaceControl({
  premisesId,
  onAdd,
}: {
  premisesId: string;
  onAdd: (label: string, form: string) => { refused: string } | void;
}) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [form, setForm] = useState<string>(SURFACE_FORMS[0]);
  const [refusal, setRefusal] = useState<string | null>(null);

  if (premisesId === '') {
    return null;
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}>
        + add a surface
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
  /** This session's brief item 5's reverse — "Open in inventory," rendered
   * beside the editor for a selected chassis. Omitted (no button at all)
   * where no caller supplies it, the same "no action, not a disabled one"
   * shape `EditorActions.onSelect` already follows. */
  onOpenInventory?: (chassisId: string) => void;
  /** The signed-in account, stamped on each change as its actor. `null` in the
   * moment between an expired session and the shell noticing. */
  accountId: string | null;
  /** ADR-0053 §5/§6, this session's brief item 4 — Notes, threaded straight
   * into `EditorFor`'s own `actions` below. */
  notesActions: NotesActions;
  /** The rack the current selection resolves to, for the Print panel's
   * "this rack" — `null` when the selection names nothing rack-shaped. */
  onActiveRackChange?: (rackId: string | null) => void;
}

/**
 * The Racks place for one open design: reads the `Document`/`SaveQueue`
 * `session` prop (shared with `InventoryPlace` over the same design —
 * `DesignPlace.tsx`, this session's brief item 1) and turns every `Drawing`
 * action into a command from `document/commands.ts` followed by a save.
 * Every change saves — the server is where the data lives — through the
 * session's one `SaveQueue`, so a save already running is never joined by a
 * second one for the same design.
 */
export function RacksPlace(props: RacksPlaceProps) {
  const {
    session,
    onZoomChange,
    initialFocus,
    onOpenInventory,
    accountId,
    notesActions,
    onActiveRackChange,
    ...shellProps
  } = props;
  const { doc, catalogue, loadError, saveRefusal, canDraw, applyDocChange, handleEdit, reloadDesign } = session;
  const [selection, setSelection] = useState<Selection | null>(initialFocus ?? null);
  // Bumped by the bar's percentage button; the drawing fits every rack.
  const [fitRequest, setFitRequest] = useState(0);

  // "Show on rack" (`InventoryPlace.tsx`) — this session's brief item 5: a
  // caller landing here with something already chosen selects it and asks
  // for the faceplate stop the moment the document is ready (an
  // `initialFocus` handed in before `doc` loads waits for it rather than
  // selecting an id `EditorFor` cannot yet resolve to anything). Fires once
  // per distinct `initialFocus` value — `DesignPlace.tsx` gives every "Show
  // on rack" click a fresh object, so identity itself is the "asked again"
  // signal, the same edge-triggered shape `Drawing.tsx`'s own camera moves
  // already use.
  useEffect(() => {
    if (initialFocus == null || doc == null) return;
    setSelection(initialFocus);
    onZoomChange(CAMERA_STOPS.faceplate);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- edge-triggered
    // on the `initialFocus` object identity and `doc` becoming available;
    // `onZoomChange` is a stable setter from `App.tsx`.
  }, [initialFocus, doc]);

  // ADR-0052 §1/§4, this session's brief item 2 — the config drawer's
  // engine. `Engine.init()` fetches and boots the wasm module
  // (`engine.ts`'s own doc), which is not free, so it happens on first
  // need — the first time a chassis is selected in this session — and
  // never at sign-in or on opening the design. `mirrorPromiseRef` makes a
  // second "first need" (a second chassis selected before the first
  // `Engine.init()` resolves) join the same boot rather than start another.
  const mirrorRef = useRef<Mirror | null>(null);
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

  const ensureMirror = useCallback((): Promise<Mirror> => {
    if (mirrorPromiseRef.current == null) {
      mirrorPromiseRef.current = Engine.init().then((engine) => {
        const mirror = new Mirror(engine);
        mirrorRef.current = mirror;
        forceMirrorRerender((n) => n + 1);
        return mirror;
      });
    }
    return mirrorPromiseRef.current;
  }, []);

  // On demand only, never on every document change: a design nobody has
  // opened the drawer or the inside stop on yet never boots the module at
  // all, and one already open only reloads the module when the document it
  // holds is actually stale (`mirrorLoadedDocRef` above) — dragging a
  // chassis, editing a hostname, fitting a PSU pay nothing here unless a
  // call site below is about to actually use the module. Reference equality
  // is enough: every `document/commands.ts`/`document/edit.ts` call and
  // `mirror.pasteInto`'s own readback return a fresh `Document`, never
  // mutate one in place.
  const withMirror = useCallback(async (): Promise<Mirror> => {
    const mirror = await ensureMirror();
    if (doc != null && mirrorLoadedDocRef.current !== doc) {
      mirror.load(doc);
      mirrorLoadedDocRef.current = doc;
    }
    return mirror;
  }, [ensureMirror, doc]);

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

  const handlePasteInto = useCallback(
    (deviceId: string, text: string) => {
      setPasteRefusal(null);
      withMirror()
        .then((mirror) => {
          // Door three, ADR-0052 §4: "the human answer ADR-0010 asks for" —
          // `pasteInto`'s own reply already carries `PasteResult`, but the
          // drawer's own gutter (built/kept/destroyed) is derived from the
          // saved document's own provenance on reopen (`document/capture.ts`'s
          // `captureOf`, ADR-0052 §3) rather than kept from this reply, so
          // only the `Document` it returns is used here.
          const { doc: nextDoc } = mirror.pasteInto(deviceId, text);
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
        .catch((error: unknown) => setPasteRefusal(refusalSentence(error)));
    },
    [withMirror, applyDocChange],
  );

  // ADR-0052 §5, this session's brief item 2 — "when a chassis is selected
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

  // ADR-0051 "Inside a box" / this session's brief item 3 — `mirror.inside`
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
      if (doc != null && mirrorLoadedDocRef.current !== doc) {
        mirrorRef.current.load(doc);
        mirrorLoadedDocRef.current = doc;
      }
      const faces = mirrorRef.current.inside(chassis.deviceId);
      return <InsideStop chassis={chassis} faces={faces} litPortLabel={litPortLabel} />;
    },
    [litPortLabel, doc],
  );

  const realView = useMemo<ClosetView>(
    () => (doc ? viewOf(doc, catalogue) : { premisesId: '', racks: [], cables: [], rows: [], surfaces: [], unplaced: [] }),
    [doc, catalogue],
  );

  // An empty design (no premises yet, or a premises with no racks) has
  // nothing to drop a device onto — this stand-in rack gives it one. It is
  // never written to the document; `handlePlace` mints the real Premises
  // and Rack (`ensureRackToPlaceInto`) only when something is actually
  // dropped onto it, never on load.
  const displayView = useMemo<ClosetView>(
    () =>
      realView.racks.length > 0
        ? realView
        : {
            premisesId: realView.premisesId,
            racks: [PENDING_RACK_VIEW],
            cables: realView.cables,
            rows: [{ label: null, racks: [PENDING_RACK_VIEW] }],
            surfaces: realView.surfaces,
            unplaced: realView.unplaced,
          },
    [realView],
  );

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
    (rackId: string, catalogueRef: { vendor: string; model: string }, positionU: number) => {
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

      // ADR-0051 §1/§2, this session's brief item 2 — the palette's own two
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
          const withDevice = createSketchDevice(working, opts ?? {});
          const chassisNode = withDevice.nodes.find((n) => !beforeIds.has(n.id) && parseNodeId(n.id).kind === 'Chassis');
          if (!chassisNode) return;
          applyDocChange(
            movePlacement(withDevice, chassisNode.id, { kind: 'rack', rackId: targetRackId, positionU, face: 'front' }, opts),
          );
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

  // `handleEdit` (ADR-0046 §2's one editor) now lives in
  // `useDesignSession` — this session's brief item 1 — so the exact same
  // function `InventoryPlace`'s own `EditorFor` call raises through runs
  // here too: "an edit here is the same edit there."
  // ADR-0047: the editor is absent, not empty, when nothing is selected —
  // an empty fragment here would still mount the surface and take its width.
  const selectedPanel =
    doc != null
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
          },
          paletteFromCatalogue(catalogue),
        )
      : null;
  const editor =
    saveRefusal != null ? (
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
        {selection?.kind === 'chassis' && onOpenInventory ? (
          <button type="button" className="racks-place__open-inventory" onClick={() => onOpenInventory(selection.id)}>
            Open in inventory
          </button>
        ) : null}
      </>
    ) : null;

  // ADR-0052 §5, this session's brief item 1 — "the rail shows no palette
  // and no add controls" for a reader: the whole rail is empty rather than
  // showing a palette that could never place anything or a surface control
  // that could never write.
  const rail = canDraw ? (
    <>
      <AddSurfaceControl
        premisesId={realView.premisesId}
        onAdd={(label, form) => handleEdit({ kind: 'create-surface', premisesId: realView.premisesId, label, form })}
      />
      {/* ADR-0051 §1/§2, this session's brief item 2 — `paletteRows` adds
          the sketch-device and board rows beside the catalogue's own
          models; `AddShelfControl`'s own model dropdown (inside `editor`
          above) keeps using plain `paletteFromCatalogue` so a shelf's
          optional model never offers either as if it were a real one. */}
      <Palette palette={paletteRows(catalogue)} />
    </>
  ) : null;

  return (
    <Shell {...shellProps} onZoomFit={() => setFitRequest((n) => n + 1)} editor={editor} rail={rail} viewOnly={!canDraw}>
      {doc == null ? (
        <div className="racks-place__loading">{loadError ?? 'Opening the design…'}</div>
      ) : (
        <Drawing
          view={displayView}
          selected={selection}
          zoom={shellProps.zoom}
          onZoomChange={onZoomChange}
          fitRequest={fitRequest}
          onPlace={handlePlace}
          onMove={handleMove}
          onConnect={handleConnect}
          onDisconnect={handleDisconnect}
          onRemoveDevice={handleRemoveDevice}
          onSelect={setSelection}
          canDraw={canDraw}
          renderConfigDrawer={renderConfigDrawer}
          renderInsideStop={renderInsideStop}
          litPortLabel={litPortLabel}
          // ADR-0053 §1/§3, this session's brief item 2 — Ctrl Z / Ctrl
          // Shift Z, at `Drawing.tsx`'s own existing keydown site.
          onUndo={shellProps.onUndo}
          onRedo={shellProps.onRedo}
        />
      )}
    </Shell>
  );
}
