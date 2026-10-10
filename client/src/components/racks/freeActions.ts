// The free layer's writes (ADR-0060 step 7): pure, one undo step each, so a vitest drives them.

import type { CatalogueModel } from '../../api/catalogue';
import { ModelMismatchError, addSketchPortRange, duplicateDevice } from '../../document/commands';
import { isDeviceRole } from '../../document/edit';
import { createFreeBox, createLabel, createLine, foldFrom, moveFree, setLineLabel, snap } from '../../document/freeform';
import type { Document } from '../../document/model';
import type { ClosetView } from '../../document/view';
import { DEFAULT_FACEPLATES } from './palette';
import { copyName, hostnamesOf, nextHostname } from './pick';

type Actor = { actor?: string };

/** A box at (x, y), named and given its usual ports when it has a known role, joined to `fromBoxId` if given. */
export function addFreeBoxDoc(doc: Document, role: string | null, x: number, y: number, fromBoxId: string | undefined, opts?: Actor): { doc: Document; chassisId: string } {
  const known = role !== null && isDeviceRole(role) ? role : undefined;
  const made = createFreeBox(doc, { ...opts, x: snap(x), y: snap(y), ...(known ? { role: known, hostname: nextHostname(hostnamesOf(doc), known) } : {}) });
  let working = made.doc;
  for (const run of known ? (DEFAULT_FACEPLATES[known] ?? []) : []) working = addSketchPortRange(working, made.chassisId, { ...run, face: 'front' }, opts);
  if (fromBoxId !== undefined) working = createLine(working, fromBoxId, made.chassisId, opts).doc;
  return { doc: foldFrom(working, doc.batches.length), chassisId: made.chassisId };
}

/** Copies the named boxes, labels and areas, and the lines between them, offset by (dx, dy). A copy keeps the
 * box's model, ports and role, and is named the next in sequence (sw-02 gives sw-03). Never its serial,
 * notes or captured config. Give the catalogue so a box with a model can copy it. */
export function duplicateFreeDoc(doc: Document, view: ClosetView, ids: readonly string[], dx: number, dy: number, opts?: Actor & { catalogue?: readonly CatalogueModel[] }): { doc: Document; ids: string[] } {
  const want = new Set(ids);
  const copies = new Map<string, string>();
  let working = doc;
  for (const box of view.free ?? []) {
    if (!want.has(box.id)) continue;
    const made = copyFreeBox(working, box, box.x + dx, box.y + dy, opts);
    working = made.doc;
    copies.set(box.id, made.chassisId);
  }
  const created: string[] = [...copies.values()];
  for (const l of view.labels ?? []) {
    if (!want.has(l.id)) continue;
    const made = createLabel(working, { ...opts, text: l.text, form: l.form, x: l.x + dx, y: l.y + dy, ...(l.form === 'area' ? { w: l.w, h: l.h } : {}) });
    working = made.doc;
    created.push(made.id);
  }
  for (const line of view.lines ?? []) {
    const a = copies.get(line.aId);
    const b = copies.get(line.bId);
    if (a === undefined || b === undefined) continue;
    const made = createLine(working, a, b, opts);
    working = line.label !== null ? setLineLabel(made.doc, made.id, line.label, opts) : made.doc;
  }
  return { doc: foldFrom(working, doc.batches.length), ids: created };
}

/** One free box copied to (x, y): its model, ports and role, under the next name in sequence. */
function copyFreeBox(doc: Document, box: ClosetView['free'][number], x: number, y: number, opts?: Actor & { catalogue?: readonly CatalogueModel[] }): { doc: Document; chassisId: string } {
  const taken = hostnamesOf(doc);
  const hostname = box.hostname ? copyName(taken, box.hostname, box.role) : undefined;
  try {
    const made = duplicateDevice(doc, box.id, { catalogue: opts?.catalogue, actor: opts?.actor, unplaced: true, ...(hostname !== undefined ? { hostname } : {}) });
    return { doc: foldFrom(moveFree(made.doc, [{ id: made.chassisId, x: snap(x), y: snap(y) }], opts), doc.batches.length), chassisId: made.chassisId };
  } catch (e) {
    // A model the catalogue no longer lists: the copy keeps its role and name, without the model.
    if (!(e instanceof ModelMismatchError)) throw e;
    return addFreeBoxDoc(doc, box.role, x, y, undefined, opts);
  }
}
