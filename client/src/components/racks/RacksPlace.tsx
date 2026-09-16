import { useCallback, useEffect, useMemo, useState } from 'react';

import { fetchCatalogue, fetchModel, type CatalogueModel } from '../../api/catalogue';
import { openDesign, saveDesign } from '../../api/payload';
import { ApiRefusal } from '../../api/errors';
import { moveChassis, placeChassis } from '../../document/commands';
import { FieldValueError, setChassisField, setDeviceField } from '../../document/edit';
import type { Document } from '../../document/model';
import { readPlain, writePlain } from '../../document/plain';
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
  freeRuns: [{ fromU: 1, toU: 42 }],
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
  return error instanceof FieldValueError ? { refused: error.message } : undefined;
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
    () => (doc ? viewOf(doc, catalogue) : { premisesId: '', racks: [], cables: [] }),
    [doc, catalogue],
  );

  // An empty design (no premises yet, or a premises with no racks) has
  // nothing to drop a device onto — this stand-in rack gives it one. It is
  // never written to the document; `handlePlace` mints the real Premises
  // and Rack (`ensureRackToPlaceInto`) only when something is actually
  // dropped onto it, never on load.
  const displayView = useMemo<ClosetView>(
    () => (realView.racks.length > 0 ? realView : { premisesId: realView.premisesId, racks: [PENDING_RACK_VIEW], cables: realView.cables }),
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
  // `document/edit.ts` call and saves it the same way `handlePlace` and
  // `handleMove` do above — one `SaveQueue` push, a refused edit (an
  // out-of-schema value, or an id that no longer resolves because the
  // document moved under us) leaves the document exactly as it was.
  const handleEdit = useCallback(
    (change: EditorChange): { refused: string } | void => {
      if (doc == null) return;
      try {
        const next =
          change.kind === 'device'
            ? setDeviceField(doc, change.id, change.field, change.value)
            : setChassisField(doc, change.id, change.field, change.value);
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
      EditorFor(selection, displayView, { onEdit: handleEdit })
    ) : null;

  const rail = <Palette palette={paletteFromCatalogue(catalogue)} />;

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
