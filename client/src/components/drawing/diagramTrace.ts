/** A path trace on the Diagram look (sign-off r101, option A "numbered hops on the drawing"). The same
 * engine walk the Rack look lights, read onto the Diagram's boxes and lines: what the walk touches stays at
 * full strength, the rest takes the phantom fade, each hop gets its number, and a walk that stopped short
 * gets a caution box beside the last device it reached, saying why. Pure; the engine's words only. */

import type { TraceResult } from '../../engine/engine';
import type { Canon } from '../checks/checksModel';

export interface DiagramTrace {
  /** Boxes the walk touches, by box (chassis) id. */
  boxes: Set<string>;
  /** Lines the walk crosses, by cable id. */
  cables: Set<string>;
  /** Hop numbers on a box, in walk order. */
  boxNumbers: Map<string, number[]>;
  /** Hop numbers on a line, in walk order. */
  cableNumbers: Map<string, number[]>;
  /** Where the walk stopped short, and the engine's reason; null when it reached the far end. */
  stop: { boxId: string | null; text: string } | null;
}

const push = (m: Map<string, number[]>, k: string, n: number) => m.set(k, [...(m.get(k) ?? []), n]);

export function diagramTrace(result: TraceResult, canon: Canon, boxIds: readonly string[], cableIds: ReadonlySet<string>): DiagramTrace {
  const boxOf = new Map<string, string>();
  for (const id of boxIds) if (!boxOf.has(canon(id))) boxOf.set(canon(id), id);
  const out: DiagramTrace = { boxes: new Set(), cables: new Set(), boxNumbers: new Map(), cableNumbers: new Map(), stop: null };
  let lastBox: string | null = null;
  for (const hop of result.hops) {
    if (hop.kind === 'stop') continue;
    let numbered = false;
    for (const node of hop.nodes) {
      const id = canon(node);
      if (cableIds.has(id)) {
        out.cables.add(id);
        if (!numbered && hop.kind === 'cable') {
          push(out.cableNumbers, id, hop.n);
          numbered = true;
        }
        continue;
      }
      const box = boxOf.get(id);
      if (box == null) continue;
      out.boxes.add(box);
      lastBox = box;
      if (!numbered && hop.kind !== 'cable' && !(out.boxNumbers.get(box) ?? []).includes(hop.n)) {
        push(out.boxNumbers, box, hop.n);
        numbered = true;
      }
    }
  }
  if (result.stopped !== '') out.stop = { boxId: lastBox, text: result.stopped };
  return out;
}

/** "1", or "2·5" when the walk passes a box twice. */
export function numberText(ns: readonly number[]): string {
  return ns.join('·');
}
