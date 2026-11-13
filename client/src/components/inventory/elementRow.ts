// ADR-0091 as built: a name in Checks on Inventory or Sheet opens that item's page. Which list holds the element,
// and which row in it, from the element's design id (a device, its chassis, a rack, a cable or a port).
import type { Document } from '../../document/model';
import { canvasSelectionOf } from '../phone/scan';
import type { InvRow } from './kinds';

/** The list and row an element is, or null when no list holds it. A device is found by its chassis, as the canvas
 * selects it; anything else by the node its row hangs off. */
export function elementRow(doc: Document, rowsByKind: Readonly<Record<string, readonly InvRow[]>>, id: string): { kind: string; row: InvRow } | null {
  const sel = canvasSelectionOf(doc, id);
  for (const [kind, list] of Object.entries(rowsByKind)) {
    const row = list.find((r) => (sel != null && r.selection?.kind === sel.kind && r.selection.id === sel.id) || r.ownerId === id);
    if (row != null) return { kind, row };
  }
  return null;
}
