// What accepting a cable correction does to the design: the ordinary edit a person with Draw
// would have made by hand, folded into ONE undoable batch whose history line says whose
// correction it was. Pure; the server is told afterwards (or first: see InventoryPlace).

import type { CorrectionView } from '../../api/corrections';
import { setCableField } from '../../document/cables';
import { foldFrom } from '../../document/freeform';
import { findNode, parseNodeId, type Document } from '../../document/model';
import { addNote } from '../../document/notes';

type Actor = { actor?: string };

/** "2026-10-03", the day (UTC) a correction was sent, which is the day the cable was walked. */
export function dayOf(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The history line an acceptance leaves. */
export const acceptedLabel = (c: Pick<CorrectionView, 'senderName'>): string => `accepted ${c.senderName}'s correction`;
export const dismissedLabel = (c: Pick<CorrectionView, 'senderName'>): string => `dismissed ${c.senderName}'s correction`;

/** Whether the correction's target is a live Cable in the design. */
export function targetIsALiveCable(doc: Document, cable: string): boolean {
  const node = findNode(doc, cable);
  if (!node || node.absentSince !== undefined) return false;
  try {
    return parseNodeId(cable).kind === 'Cable';
  } catch {
    return false;
  }
}

/** Why a correction cannot be applied, or null when it can: the target must be a Cable still in the design. */
export function whyNotApplicable(doc: Document, c: Pick<CorrectionView, 'cable'>): string | null {
  return targetIsALiveCable(doc, c.cable) ? null : 'That cable is no longer in this design.';
}

/** `doc` with the correction applied as one batch. Throws what the document commands throw, and
 * refuses a target that is not a live Cable. The sender's name is in the batch label, not the note. */
export function applyCorrection(doc: Document, c: CorrectionView, opts?: Actor): Document {
  const why = whyNotApplicable(doc, c);
  if (why) throw new Error(why);
  const before = doc.batches.length;
  let working: Document;
  if (c.kind === 'traced') {
    working = setCableField(doc, c.cable, 'last_confirmed', dayOf(c.createdAt), opts);
  } else if (c.kind === 'label') {
    working = setCableField(doc, c.cable, 'label', c.text, opts);
  } else {
    working = addNote(doc, c.cable, { text: `Reported not here by ${c.senderName}: ${c.text}`, how: 'typed', actor: opts?.actor });
  }
  const folded = foldFrom(working, before);
  const last = folded.batches[folded.batches.length - 1];
  if (!last || folded.batches.length === before) return folded;
  return { ...folded, batches: [...folded.batches.slice(0, -1), { ...last, label: acceptedLabel(c) }] };
}
