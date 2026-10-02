// One `EditorChange` applied to a `Document`, with no React and no save: `useDesignSession`'s
// `handleEdit` calls it once per edit, and the Inventory table calls it in a loop for a bulk edit
// or a paste so the whole thing is one save.

import type { CatalogueModel } from '../../api/catalogue';
import type { EditorChange } from '../drawing';
import {
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
import { FieldValueError, setChassisField, setDeviceField, setPassiveNodeField, setRackField, setRackHeight } from '../../document/edit';
import type { Document } from '../../document/model';
import { fitSupply, removeSupply, setSupplyField } from '../../document/supplies';

/** Throws the same errors the document commands throw; `refusalFor` words them. `notice` is set
 * only by a duplicate whose copy landed unplaced. */
export function applyEditorChange(
  doc: Document,
  change: EditorChange,
  catalogue: readonly CatalogueModel[],
  opts: { actor: string } | undefined,
): { doc: Document; notice?: string } {
  let next: Document;
  let notice: string | undefined;
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
    } else if (change.field === 'label') {
      next = setRackField(doc, change.id, 'label', change.value, opts);
    } else {
      next = setRackField(doc, change.id, 'row', change.value, opts);
    }
  } else if (change.kind === 'rack-height') {
    next = setRackHeight(doc, change.id, change.heightU, opts);
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
      notice = 'Duplicated — no free position in this rack, so the copy is unplaced.';
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
  return { doc: next, notice };
}
