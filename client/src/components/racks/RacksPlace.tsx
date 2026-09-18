import { useCallback, useEffect, useMemo, useState } from 'react';

import { fetchCatalogue, fetchModel, type CatalogueModel } from '../../api/catalogue';
import { openDesign, saveDesign } from '../../api/payload';
import { ApiRefusal } from '../../api/errors';
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
  createSurface,
  isSurfaceForm,
  moveChassis,
  movePlacement,
  placeChassis,
  removeSketchPort,
} from '../../document/commands';
import { FieldValueError, setChassisField, setDeviceField, setRackField } from '../../document/edit';
import type { Document } from '../../document/model';
import { readPlain, writePlain } from '../../document/plain';
import {
  FixedSlotError,
  SlotAlreadyFittedError,
  UnknownSlotError,
  fitSupply,
  removeSupply,
  setSupplyField,
} from '../../document/supplies';
import { viewOf, type ClosetView } from '../../document/view';
import { Drawing, EditorFor, Palette, type EditorChange, type Selection } from '../drawing';
import type { ShellProps } from '../shell/types';
import { Shell } from '../Shell';
import { ensureRackToPlaceInto } from './emptyDesign';
import { paletteFromCatalogue } from './palette';
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
  const { organisationId, designId, onZoomChange, ...shellProps } = props;

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
      saveQueue.push(writePlain(next));
    },
    [saveQueue],
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
          next = createShelf(doc, change.rackId, { positionU: change.positionU, model });
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
      EditorFor(selection, displayView, { onEdit: handleEdit }, paletteFromCatalogue(catalogue))
    ) : null;

  const rail = (
    <>
      <AddSurfaceControl
        premisesId={realView.premisesId}
        onAdd={(label, form) => handleEdit({ kind: 'create-surface', premisesId: realView.premisesId, label, form })}
      />
      <Palette palette={paletteFromCatalogue(catalogue)} />
    </>
  );

  return (
    <Shell {...shellProps} editor={editor} rail={rail}>
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
        />
      )}
    </Shell>
  );
}
