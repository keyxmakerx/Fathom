// The document loading, saving and editing machinery Racks and Inventory
// both need — ADR-0046 §2 ("one editor … one graph") and this session's own
// brief item 1: switching place must never reload the design or lose an
// unsaved change. Before this session, `racks/RacksPlace.tsx` owned all of
// this itself; it is pulled out here, unchanged in behaviour, so a caller
// that mounts this hook ONCE — above wherever `RacksPlace`/`InventoryPlace`
// are chosen between (`components/design/DesignPlace.tsx`) — keeps the same
// `Document`, the same in-flight `SaveQueue`, and the same pending edits
// across a place switch, because the hook itself never unmounts: only the
// place component reading its return value does.
//
// `RacksPlace.tsx` still re-exports `canDrawFor`/`refusalFor` from here (its
// own file no longer defines them) so the two test files that import them
// from `'./RacksPlace'` (`RacksPlace.canDraw.test.ts`,
// `RacksPlace.edit.test.ts`) keep working unchanged.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { fetchCatalogue, fetchModel, type CatalogueModel } from '../../api/catalogue';
import { ApiRefusal } from '../../api/errors';
import type { DesignCapability } from '../../api/designs';
import { openDesign } from '../../api/payload';
import { ConditionalSave } from './conditionalSave';
import type { EditorChange } from '../drawing';
import {
  AlreadyPlacedError,
  DuplicatePortLabelError,
  InvalidFixedToTargetError,
  InvalidPortRangeError,
  ModelMismatchError,
  NotAShelfError,
  PortRangeTooLargeError,
  RackOverlapError,
  RackRangeError,
  SketchOnCatalogueChassisError,
  SlotTakenError,
  SURFACE_FORMS,
  addSketchPort,
  addSketchPortRange,
  createShelf,
  createSurface,
  duplicateDevice,
  isSurfaceForm,
  movePlacement,
  removeChassis,
  removeSketchPort,
} from '../../document/commands';
import { disconnect, setCableField } from '../../document/cables';
import { FieldValueError, setChassisField, setDeviceField, setPassiveNodeField, setRackField } from '../../document/edit';
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
import { getSession } from '../../state/sessionState';
import { SaveQueue } from '../racks/saveQueue';

/** The server's own wording where the failure was a refusal it sent
 * (`ApiRefusal`, `api/errors.ts`); this client's own honest statement where
 * it was not. Never a guess at which check failed. Moved from
 * `racks/RacksPlace.tsx` verbatim — `components/home/Home.tsx`'s own
 * `describeError` follows the same rule independently. */
export function describeError(error: unknown): string {
  if (error instanceof ApiRefusal) {
    return error.retryAfterSeconds != null
      ? `${error.message} Try again in ${error.retryAfterSeconds}s.`
      : error.message;
  }
  if (error instanceof Error) return error.message;
  return 'That request did not complete.';
}

/** ADR-0052 §5: "canDraw = capability !== 'read'." An unrecognised
 * capability fails OPEN to draw rather than silently losing every save —
 * moved from `racks/RacksPlace.tsx` verbatim. */
export function canDrawFor(capability: DesignCapability): boolean {
  return capability !== 'read';
}

export function refusalFor(error: unknown): { refused: string } | undefined {
  if (error instanceof FieldValueError) return { refused: error.message };
  if (error instanceof UnknownSlotError || error instanceof SlotAlreadyFittedError || error instanceof FixedSlotError) {
    return { refused: error.message };
  }
  if (
    error instanceof NotAShelfError ||
    error instanceof SlotTakenError ||
    error instanceof AlreadyPlacedError ||
    error instanceof InvalidFixedToTargetError ||
    error instanceof SketchOnCatalogueChassisError ||
    error instanceof InvalidPortRangeError ||
    error instanceof PortRangeTooLargeError ||
    error instanceof DuplicatePortLabelError ||
    error instanceof ModelMismatchError
  ) {
    return { refused: error.message };
  }
  if (error instanceof RackRangeError || error instanceof RackOverlapError) {
    return { refused: error.message };
  }
  if (error instanceof RangeError) return { refused: error.message };
  return undefined;
}

export interface DesignSession {
  doc: Document | null;
  catalogue: CatalogueModel[];
  loadError: string | null;
  saveRefusal: string | null;
  canDraw: boolean;
  /** Writes `next` into local state and, for a drawable capability, queues
   * it for save (ADR-0052 §5: a reader's document never reaches the
   * `SaveQueue`). */
  applyDocChange: (next: Document) => void;
  /** ADR-0046 §2, "edited from either": the one `EditorChange` dispatcher
   * both places' `EditorFor` calls raise through `EditorActions.onEdit`. */
  handleEdit: (change: EditorChange) => { refused: string } | void;
  /** ADR-0054 §1's Reload: re-opens this design and adopts the version it
   * comes back at as a fresh base — the one place a server-told version is
   * ever adopted, because here the person themselves asked for it, unlike a
   * save refusal's own header, which nothing in this module ever reads for
   * that purpose. Wired to the Reload button `RacksPlace.tsx` and
   * `InventoryPlace.tsx` render in the save-refusal wash a 409 leaves
   * showing; it does not itself touch `doc` or `saveRefusal` before the
   * reopened design actually arrives, so nothing visible is
   * discarded until then. */
  reloadDesign: () => void;
}

/**
 * Fetches the catalogue and the open design once per (organisation, design)
 * pair, holds the `Document` this session edits, and turns every
 * `EditorChange` into a `document/edit.ts`/`document/commands.ts`/
 * `document/supplies.ts` call followed by a save through one `SaveQueue`.
 *
 * Call this ONCE, in a component both places are mounted beneath
 * (`DesignPlace.tsx`) — mounting it separately inside `RacksPlace` and
 * `InventoryPlace` would give each place its own `Document`/`SaveQueue`,
 * exactly the "switching place reloads or loses a change" failure this
 * session's brief names.
 */
export function useDesignSession(organisationId: string, designId: string, capability: DesignCapability): DesignSession {
  const canDraw = canDrawFor(capability);

  const [doc, setDoc] = useState<Document | null>(null);
  const [catalogue, setCatalogue] = useState<CatalogueModel[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveRefusal, setSaveRefusal] = useState<string | null>(null);

  // ADR-0054 §1: the base a save is conditioned on, held here rather than in
  // state — it moves on every save that lands, which a document mid-drawing
  // does often, and nothing in this hook needs to re-render off that move by
  // itself (only `saveRefusal`, set separately below on a refusal, does).
  // `null` exactly when no design has finished opening yet, the one state a
  // queued save arriving too early (it cannot: `applyDocChange` needs a
  // `doc`, which is set in the same place this is) would otherwise have
  // nothing valid to send.
  const conditionalSaveRef = useRef<ConditionalSave | null>(null);
  const cancelledRef = useRef(false);

  const load = useCallback(() => {
    cancelledRef.current = false;
    setLoadError(null);

    fetchCatalogue()
      .then((list) => Promise.all(list.map((entry) => fetchModel(entry.vendor, entry.model))))
      .then((models) => {
        if (!cancelledRef.current) setCatalogue(models);
      })
      .catch((error: unknown) => {
        if (!cancelledRef.current) setLoadError(describeError(error));
      });

    openDesign(organisationId, designId)
      .then((opened) => {
        if (cancelledRef.current) return;
        // The one place a server-told version is ever adopted: reopening is
        // always the person's own asking (the initial open, or Reload after
        // a conflict), never a reaction to a refusal's own header.
        conditionalSaveRef.current = new ConditionalSave(opened.version);
        setDoc(readPlain(opened.bytes));
        setSaveRefusal(null);
      })
      .catch((error: unknown) => {
        if (!cancelledRef.current) setLoadError(describeError(error));
      });
  }, [organisationId, designId]);

  useEffect(() => {
    setDoc(null);
    setCatalogue([]);
    setSaveRefusal(null);
    conditionalSaveRef.current = null;
    load();
    return () => {
      cancelledRef.current = true;
    };
  }, [load]);

  /** ADR-0054 §1's Reload — see the `DesignSession.reloadDesign` doc. */
  const reloadDesign = useCallback(() => {
    load();
  }, [load]);

  const saveQueue = useMemo(
    () =>
      new SaveQueue<Uint8Array>(
        (bytes) => {
          const conditionalSave = conditionalSaveRef.current;
          if (conditionalSave == null) {
            // Cannot happen through `applyDocChange` (it requires `doc`,
            // which is set in the same step as `conditionalSaveRef`), but a
            // typed `Promise.reject` here is still an honest answer rather
            // than a throw the `SaveQueue` was not built to catch
            // synchronously.
            return Promise.reject(new Error('save queued before the design finished opening'));
          }
          // ADR-0054 §1: this is the one call site that ever appends
          // `?base=` — `conditionalSave.save` reads and moves the base
          // itself; this hook never touches it directly.
          return conditionalSave.save(organisationId, designId, bytes).then(() => setSaveRefusal(null));
        },
        (error: unknown) => setSaveRefusal(describeError(error)),
      ),
    [organisationId, designId],
  );

  const applyDocChange = useCallback(
    (next: Document) => {
      setDoc(next);
      if (!canDraw) return;
      saveQueue.push(writePlain(next));
    },
    [saveQueue, canDraw],
  );

  const handleEdit = useCallback(
    (change: EditorChange): { refused: string } | void => {
      if (doc == null) return;
      // ADR-0053 §3: every command dispatched here is stamped with the
      // signed-in account's ulid, so its provenance records and tombstones
      // name who really made the change rather than `document/model.ts`'s
      // `LOCAL_ACTOR` read-side sentinel. `useDesignSession` mounts only
      // beneath a signed-in `App` (`App.tsx` renders `DesignPlace` only once
      // `session` is set), so `accountId` is absent only in the moment
      // between an expired session and the shell noticing — `opts.actor`
      // being `undefined` then falls back to each command's own default.
      const accountId = getSession()?.accountId;
      const opts = accountId !== undefined ? { actor: accountId } : undefined;
      // Set only by `'duplicate-device'` — a `{ refused }`-shaped NOTICE,
      // not a refusal (`contract.ts`'s `EditorActions.onEdit`).
      let placementNotice: string | undefined;
      try {
        let next: Document;
        if (change.kind === 'device') {
          next = setDeviceField(doc, change.id, change.field, change.value, opts);
        } else if (change.kind === 'chassis') {
          next = setChassisField(doc, change.id, change.field, change.value, opts);
        } else if (change.kind === 'shelf') {
          next = setPassiveNodeField(doc, change.id, change.field, change.value, opts);
        } else if (change.kind === 'rack') {
          if (change.field === 'bay') {
            if (change.value === null) {
              next = setRackField(doc, change.id, 'bay', null, opts);
            } else {
              const parsed = Number(change.value);
              if (!Number.isInteger(parsed)) {
                throw new FieldValueError('Rack.bay', change.value, 'must be a whole number');
              }
              next = setRackField(doc, change.id, 'bay', parsed, opts);
            }
          } else {
            next = setRackField(doc, change.id, 'row', change.value, opts);
          }
        } else if (change.kind === 'supply') {
          next = setSupplyField(doc, change.id, change.field, change.value, opts);
        } else if (change.kind === 'supply-remove') {
          next = removeSupply(doc, change.id, opts);
        } else if (change.kind === 'supply-fit') {
          next = fitSupply(doc, change.chassisId, change.slot, {}, opts);
        } else if (change.kind === 'cable') {
          // UI-SPEC "Cables", this session's brief — the cable panel's own
          // fields. `value` is always the raw text a field holds
          // (`contract.ts`'s own doc on this `EditorChange` kind); `length_m`
          // is parsed here, the same "the caller parses before the write-
          // side function gets a chance to refuse it" reading `'rack'`'s
          // `bay` above already gives.
          if (change.field === 'length_m') {
            if (change.value === null) {
              next = setCableField(doc, change.id, 'length_m', null, opts);
            } else {
              const parsed = Number(change.value);
              if (!Number.isInteger(parsed) || parsed < 0) {
                throw new FieldValueError('Cable.length_m', change.value, 'must be a whole, non-negative number');
              }
              next = setCableField(doc, change.id, 'length_m', parsed, opts);
            }
          } else {
            next = setCableField(doc, change.id, change.field, change.value, opts);
          }
        } else if (change.kind === 'cable-disconnect') {
          next = disconnect(doc, change.id, opts);
        } else if (change.kind === 'device-remove') {
          next = removeChassis(doc, change.chassisId, opts);
        } else if (change.kind === 'move-placement') {
          next = movePlacement(doc, change.itemId, change.placement, opts);
        } else if (change.kind === 'add-sketch-port') {
          next = addSketchPort(
            doc,
            change.chassisId,
            {
              label: change.label,
              connector: change.connector,
              service: change.service ?? undefined,
              face: change.face,
            },
            opts,
          );
        } else if (change.kind === 'remove-sketch-port') {
          next = removeSketchPort(doc, change.chassisId, change.portId, opts);
        } else if (change.kind === 'add-sketch-port-range') {
          next = addSketchPortRange(
            doc,
            change.chassisId,
            {
              labelPrefix: change.labelPrefix,
              first: change.first,
              last: change.last,
              connector: change.connector,
              service: change.service ?? undefined,
              face: change.face,
            },
            opts,
          );
        } else if (change.kind === 'duplicate-device') {
          const result = duplicateDevice(doc, change.chassisId, { catalogue, ...opts });
          next = result.doc;
          if (!result.placed) {
            placementNotice = 'Duplicated — no free position in this rack, so the copy is unplaced.';
          }
        } else if (change.kind === 'create-shelf') {
          const model = change.model
            ? catalogue.find((m) => m.vendor === change.model!.vendor && m.model === change.model!.model)
            : undefined;
          next = createShelf(doc, change.rackId, { positionU: change.positionU, label: change.label, model, ...opts });
        } else {
          if (!isSurfaceForm(change.form)) {
            throw new FieldValueError('Surface.form', change.form, `is not one of: ${SURFACE_FORMS.join(', ')}`);
          }
          next = createSurface(doc, change.premisesId, { label: change.label, form: change.form, ...opts });
        }
        applyDocChange(next);
        if (placementNotice !== undefined) return { refused: placementNotice };
      } catch (e) {
        return refusalFor(e);
      }
    },
    [doc, catalogue, applyDocChange],
  );

  return { doc, catalogue, loadError, saveRefusal, canDraw, applyDocChange, handleEdit, reloadDesign };
}
