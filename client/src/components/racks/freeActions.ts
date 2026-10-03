// The free layer's writes (ADR-0060 step 7): pure, one undo step each, so a vitest drives them.

import { addSketchPortRange } from '../../document/commands';
import { isDeviceRole } from '../../document/edit';
import { createFreeBox, createLabel, createLine, foldFrom, setLineLabel, snap } from '../../document/freeform';
import type { Document } from '../../document/model';
import type { ClosetView } from '../../document/view';
import { DEFAULT_FACEPLATES } from './palette';
import { hostnamesOf, nextHostname } from './pick';

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

/** Copies the named boxes, labels and areas, and the lines between them, offset by (dx, dy). Copies get fresh names. */
export function duplicateFreeDoc(doc: Document, view: ClosetView, ids: readonly string[], dx: number, dy: number, opts?: Actor): { doc: Document; ids: string[] } {
  const want = new Set(ids);
  const copies = new Map<string, string>();
  let working = doc;
  for (const box of view.free ?? []) {
    if (!want.has(box.id)) continue;
    const made = addFreeBoxDoc(working, box.role, box.x + dx, box.y + dy, undefined, opts);
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
