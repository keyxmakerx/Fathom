import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { fetchCatalogue, fetchModel, type CatalogueModel } from '../../api/catalogue';
import { openDesign, saveDesign } from '../../api/payload';
import { ApiRefusal } from '../../api/errors';
import type { DesignCapability } from '../../api/designs';
import { captureOf } from '../../document/capture';
import { Engine } from '../../engine/engine';
import { Mirror, refusalSentence } from '../../engine/mirror';
import { ConfigDrawer } from '../config/ConfigDrawer';
import { InsideStop } from '../inside/InsideStop';
import {
  AlreadyPlacedError,
  InvalidFixedToTargetError,
  NotAShelfError,
  RackOverlapError,
  RackRangeError,
  SketchOnCatalogueChassisError,
  SlotTakenError,
  SURFACE_FORMS,
  addSketchPort,
  createShelf,
  createSketchDevice,
  createSurface,
  isSurfaceForm,
  moveChassis,
  movePlacement,
  placeChassis,
  removeSketchPort,
} from '../../document/commands';
import { FieldValueError, setChassisField, setDeviceField, setPassiveNodeField, setRackField } from '../../document/edit';
import { parseNodeId, type Document } from '../../document/model';
import { readPlain, writePlain } from '../../document/plain';
import {
  FixedSlotError,
  SlotAlreadyFittedError,
  UnknownSlotError,
  fitSupply,
  removeSupply,
  setSupplyField,
} from '../../document/supplies';
import { viewOf, type ChassisView, type ClosetView } from '../../document/view';
import { Drawing, EditorFor, Palette, type EditorChange, type Selection } from '../drawing';
import type { ShellProps } from '../shell/types';
import { Shell } from '../Shell';
import { ensureRackToPlaceInto } from './emptyDesign';
import { isBoardPaletteItem, isSketchDevicePaletteItem, paletteFromCatalogue, paletteRows } from './palette';
import './racks.css';
import { SaveQueue } from './saveQueue';

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

/** The server's own wording where the failure was a refusal it sent
 * (`ApiRefusal`, `errors.ts`); this client's own honest statement where it
 * was not. Never a guess at which check failed — the same rule
 * `components/home/Home.tsx`'s `describeError` follows. */
function describeError(error: unknown): string {
  if (error instanceof ApiRefusal) {
    return error.retryAfterSeconds != null
      ? `${error.message} Try again in ${error.retryAfterSeconds}s.`
      : error.message;
  }
  if (error instanceof Error) return error.message;
  return 'That request did not complete.';
}

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

/** What `handleEdit` turns a caught `document/edit.ts` failure into for
 * `EditorActions.onEdit` (`contract.ts`) — pulled out as its own pure
 * function, no `Document` or React involved, so the message for each kind
 * of refusal can be tested directly. Only `FieldValueError` (a malformed
 * value the schema refuses — a malformed management address, a role outside
 * the enum) becomes a refusal the editor shows beside the field it came
 * from; `UnknownReferenceError` (the id no longer resolves because the
 * document moved under us) has no field left to attach a message to, so it
 * still resolves to `undefined` — the same silent drop as before this
 * change, now named rather than accidental. */
/** ADR-0052 §5, this session's brief item 1: "canDraw = capability !== 'read'."
 * A capability this client does not recognise (`api/designs.ts`'s own note
 * on why `DesignCapability` is kept as `string`) is never treated as
 * drawable by guessing — only the one capability that names "cannot write"
 * is refused draw, so an unrecognised future value fails open to draw
 * rather than silently losing every save, the opposite of the security
 * failure mode this gate exists to prevent. Pulled out as its own function,
 * pure and exported, so the gate itself is tested without mounting
 * anything. */
export function canDrawFor(capability: DesignCapability): boolean {
  return capability !== 'read';
}

export function refusalFor(error: unknown): { refused: string } | undefined {
  if (error instanceof FieldValueError) return { refused: error.message };
  // `document/supplies.ts`'s own typed refusals (ADR-0050 §4) — an unknown
  // slot, a slot already fitted, a fixed slot — shown beside the fit/remove
  // action the same way a `FieldValueError` shows beside its field.
  if (error instanceof UnknownSlotError || error instanceof SlotAlreadyFittedError || error instanceof FixedSlotError) {
    return { refused: error.message };
  }
  // `document/commands.ts`'s own ADR-0051 §1 refusals — the "PLACED ON"
  // control's `movePlacement`, a shelf's `createShelf`, a sketch's
  // `addSketchPort`: an occupied slot, a target that is not a shelf/board/
  // surface, an item already placed elsewhere, a catalogued chassis refusing
  // a hand-typed port. Shown beside the control the same way as above.
  if (
    error instanceof NotAShelfError ||
    error instanceof SlotTakenError ||
    error instanceof AlreadyPlacedError ||
    error instanceof InvalidFixedToTargetError ||
    error instanceof SketchOnCatalogueChassisError
  ) {
    return { refused: error.message };
  }
  // `movePlacement`'s `'rack'` branch reuses the same `RackRangeError`/
  // `RackOverlapError` a rack drop-place already refuses with — the "PLACED
  // ON" control asks for a unit the same way the drawing's own drop does,
  // and needs the same two refusals shown beside it rather than treated as
  // a stale view (`AlreadyPlacedError`'s neighbours above).
  if (error instanceof RackRangeError || error instanceof RackOverlapError) {
    return { refused: error.message };
  }
  // `document/model.ts`'s `uint`/`identifier` throw a bare `RangeError` for
  // a value out of the schema's own numeric range (e.g. `FixedTo.x_mm`
  // beyond u32, or negative) that the editor's own input check did not
  // already catch. Shown generically rather than silently treated as
  // success (this file's own `handleEdit` doc: "a refused VALUE is the
  // editor's to show beside the field it came from, not to drop silently").
  if (error instanceof RangeError) return { refused: error.message };
  return undefined;
}

export interface RacksPlaceProps extends Omit<ShellProps, 'editor' | 'rail' | 'children'> {
  organisationId: string;
  designId: string;
  /** The camera's continuous zoom, kept in agreement with the bar's
   * stepped `zoom`/`onZoomIn`/`onZoomOut` by the caller (`App.tsx`) — the
   * same single number, two ways to move it. */
  onZoomChange: (zoom: number) => void;
  /** `api/designs.ts`'s `DesignSummary.capability` for the open design —
   * ADR-0052 §5: "canDraw = capability !== 'read'" is computed once, here,
   * from this and threaded to every place that needs it (`Drawing`'s
   * `canDraw`, the editor's `onEdit`, the rail's controls) rather than each
   * of them re-deriving it. */
  capability: DesignCapability;
}

/**
 * The Racks place for one open design: fetches the catalogue and the
 * design once on mount, holds the `Document` this session edits, and turns
 * every `Drawing` action into a command from `document/commands.ts`
 * followed by a save. Every change saves — the server is where the data
 * lives — through one `SaveQueue` per (organisation, design) pair, so a
 * save already running is never joined by a second one for the same
 * design.
 */
export function RacksPlace(props: RacksPlaceProps) {
  const { organisationId, designId, onZoomChange, capability, ...shellProps } = props;
  const canDraw = canDrawFor(capability);

  const [doc, setDoc] = useState<Document | null>(null);
  const [catalogue, setCatalogue] = useState<CatalogueModel[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveRefusal, setSaveRefusal] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDoc(null);
    setCatalogue([]);
    setSelection(null);
    setLoadError(null);
    setSaveRefusal(null);

    fetchCatalogue()
      .then((list) => Promise.all(list.map((entry) => fetchModel(entry.vendor, entry.model))))
      .then((models) => {
        if (!cancelled) setCatalogue(models);
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(describeError(error));
      });

    openDesign(organisationId, designId)
      .then((opened) => {
        if (!cancelled) setDoc(readPlain(opened.bytes));
      })
      .catch((error: unknown) => {
        if (!cancelled) setLoadError(describeError(error));
      });

    return () => {
      cancelled = true;
    };
  }, [organisationId, designId]);

  // One in-flight save at a time for this (organisation, design); the next
  // change made while it is running replaces whatever was queued and goes
  // out the moment it finishes, success or refusal (`SaveQueue`'s own doc).
  const saveQueue = useMemo(
    () =>
      new SaveQueue<Uint8Array>(
        (bytes) => saveDesign(organisationId, designId, bytes).then(() => setSaveRefusal(null)),
        (error: unknown) => setSaveRefusal(describeError(error)),
      ),
    [organisationId, designId],
  );

  const applyDocChange = useCallback(
    (next: Document) => {
      setDoc(next);
      // ADR-0052 §5, this session's brief item 1: a reader's document never
      // reaches the `SaveQueue` — nothing here should ever run for one
      // (`Drawing`'s own `canDraw` gating, `EditorFor`'s absent `onEdit`),
      // but this is the one place every path that could still call
      // `applyDocChange` funnels through, so it is the save's own last
      // refusal too, not only the controls'.
      if (!canDraw) return;
      saveQueue.push(writePlain(next));
    },
    [saveQueue, canDraw],
  );

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
    () => (doc ? viewOf(doc, catalogue) : { premisesId: '', racks: [], cables: [], rows: [], surfaces: [] }),
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
          },
    [realView],
  );

  const handlePlace = useCallback(
    (rackId: string, catalogueRef: { vendor: string; model: string }, positionU: number) => {
      if (doc == null) return;

      // ADR-0051 §1/§2, this session's brief item 2 — the palette's own two
      // extra rows (`racks/palette.ts`'s `SKETCH_DEVICE_PALETTE_ITEM`/
      // `BOARD_PALETTE_ITEM`) are told apart from a real catalogue drop by
      // vendor alone, before either ever reaches the `catalogue.find` below.
      if (isSketchDevicePaletteItem(catalogueRef)) {
        let working = doc;
        let targetRackId = rackId;
        if (rackId === PENDING_RACK_ID) {
          const ensured = ensureRackToPlaceInto(working, realView.premisesId === '' ? null : realView.premisesId);
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
          const withDevice = createSketchDevice(working, {});
          const chassisNode = withDevice.nodes.find((n) => !beforeIds.has(n.id) && parseNodeId(n.id).kind === 'Chassis');
          if (!chassisNode) return;
          applyDocChange(movePlacement(withDevice, chassisNode.id, { kind: 'rack', rackId: targetRackId, positionU, face: 'front' }));
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
        const ensured = ensureRackToPlaceInto(working, realView.premisesId === '' ? null : realView.premisesId);
        working = ensured.doc;
        targetRackId = ensured.rackId;
      }

      try {
        applyDocChange(placeChassis(working, targetRackId, model, positionU, 'front'));
      } catch {
        // `Drawing` already checked this drop for range/overlap against the
        // view it was given before calling `onPlace`; a command-level
        // refusal here can only mean that view was stale. Leave the
        // document exactly as it was rather than apply a half-formed edit.
      }
    },
    [doc, catalogue, realView.premisesId, applyDocChange],
  );

  const handleMove = useCallback(
    (chassisId: string, rackId: string, positionU: number) => {
      if (doc == null) return;
      try {
        applyDocChange(moveChassis(doc, chassisId, rackId, positionU, 'front'));
      } catch {
        // As `handlePlace` above: the drawing validated the drop against a
        // view that turned out to be stale. Leave the document as it was.
      }
    },
    [doc, applyDocChange],
  );

  // Turns an `EditorChange` (ADR-0046 §2's one editor) into the matching
  // `document/edit.ts`/`document/supplies.ts` call and saves it the same way
  // `handlePlace` and `handleMove` do above — one `SaveQueue` push, a
  // refused edit (an out-of-schema value, an id that no longer resolves
  // because the document moved under us, or one of `supplies.ts`'s own
  // typed refusals) leaves the document exactly as it was.
  const handleEdit = useCallback(
    (change: EditorChange): { refused: string } | void => {
      if (doc == null) return;
      try {
        let next: Document;
        if (change.kind === 'device') {
          next = setDeviceField(doc, change.id, change.field, change.value);
        } else if (change.kind === 'chassis') {
          next = setChassisField(doc, change.id, change.field, change.value);
        } else if (change.kind === 'shelf') {
          // ADR-0051 §1, this session's brief item 1 — a shelf's own
          // editor commits its name through `setPassiveNodeField`.
          next = setPassiveNodeField(doc, change.id, change.field, change.value);
        } else if (change.kind === 'rack') {
          // `EditorChange`'s own doc (`drawing/contract.ts`): the editor
          // only ever holds text, so `bay` is parsed here, before
          // `setRackField` gets a chance to refuse it as a schema value.
          if (change.field === 'bay') {
            if (change.value === null) {
              next = setRackField(doc, change.id, 'bay', null);
            } else {
              const parsed = Number(change.value);
              if (!Number.isInteger(parsed)) {
                throw new FieldValueError('Rack.bay', change.value, 'must be a whole number');
              }
              next = setRackField(doc, change.id, 'bay', parsed);
            }
          } else {
            next = setRackField(doc, change.id, 'row', change.value);
          }
        } else if (change.kind === 'supply') {
          next = setSupplyField(doc, change.id, change.field, change.value);
        } else if (change.kind === 'supply-remove') {
          next = removeSupply(doc, change.id);
        } else if (change.kind === 'supply-fit') {
          next = fitSupply(doc, change.chassisId, change.slot);
        } else if (change.kind === 'move-placement') {
          next = movePlacement(doc, change.itemId, change.placement);
        } else if (change.kind === 'add-sketch-port') {
          next = addSketchPort(doc, change.chassisId, {
            label: change.label,
            connector: change.connector,
            service: change.service ?? undefined,
            face: change.face,
          });
        } else if (change.kind === 'remove-sketch-port') {
          next = removeSketchPort(doc, change.chassisId, change.portId);
        } else if (change.kind === 'create-shelf') {
          const model = change.model
            ? catalogue.find((m) => m.vendor === change.model!.vendor && m.model === change.model!.model)
            : undefined;
          next = createShelf(doc, change.rackId, { positionU: change.positionU, label: change.label, model });
        } else {
          // change.kind === 'create-surface' — `EditorChange`'s own doc
          // (`drawing/contract.ts`): the control only ever holds raw text,
          // so `form` is validated against `SURFACE_FORMS` here, before
          // `createSurface` gets a chance to refuse it as a schema value
          // (the same "parse before the write-side sees it" shape `'rack'`'s
          // `bay` above already follows).
          if (!isSurfaceForm(change.form)) {
            throw new FieldValueError('Surface.form', change.form, `is not one of: ${SURFACE_FORMS.join(', ')}`);
          }
          next = createSurface(doc, change.premisesId, { label: change.label, form: change.form });
        }
        applyDocChange(next);
      } catch (e) {
        // As `handlePlace`/`handleMove`: the editor raised a request against
        // a view that turned out to be stale, or a value the schema refuses.
        // Leave the document as it was rather than apply a half-formed edit
        // — but a refused VALUE (`refusalFor`) is the editor's to show
        // beside the field it came from, not to drop silently.
        return refusalFor(e);
      }
    },
    [doc, applyDocChange],
  );

  const editor =
    saveRefusal != null ? (
      <div className="racks-place__refusal">{saveRefusal}</div>
    ) : doc != null ? (
      // `onSelect: setSelection` — ADR-0051 §1, this session's brief item
      // 4 — a shelf's own editor lists its occupants by slot, each a link
      // that selects the occupant; the same setter `Drawing`'s own
      // `onSelect` prop below already uses. ADR-0052 §5, this session's
      // brief item 1 — `onEdit` is omitted entirely for a reader
      // (`canDraw`), never supplied as a function that would refuse: every
      // value then renders as plain text with no input and no action
      // (`Editor.tsx`'s own `EditableValue`/`SupplyAction`/`PlacedOnControl`
      // doc on reading `onEdit == null`).
      EditorFor(
        selection,
        displayView,
        { onEdit: canDraw ? handleEdit : undefined, onSelect: setSelection },
        paletteFromCatalogue(catalogue),
      )
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
    <Shell {...shellProps} editor={editor} rail={rail} viewOnly={!canDraw}>
      {doc == null ? (
        <div className="racks-place__loading">{loadError ?? 'Opening the design…'}</div>
      ) : (
        <Drawing
          view={displayView}
          selected={selection}
          zoom={shellProps.zoom}
          onZoomChange={onZoomChange}
          onPlace={handlePlace}
          onMove={handleMove}
          onSelect={setSelection}
          canDraw={canDraw}
          renderConfigDrawer={renderConfigDrawer}
          renderInsideStop={renderInsideStop}
          litPortLabel={litPortLabel}
        />
      )}
    </Shell>
  );
}
