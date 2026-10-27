// Links between sites (ADR-0079 decision 5, schema 0.31): a cable whose far end is an
// `ExternalPeer` naming a port in another design (`ExternalPeer.far_design`, `.far_element`).
// Pure reads over a document; `cables.ts`'s `connectToOutside` writes them.
import { edgesIn, edgesOut, fieldValue, findNode, type Document } from './model';

export interface SiteLink {
  peerId: string;
  cableId: string;
  /** The port on this design's side; null when the cable has no port end here. */
  nearPortId: string | null;
  label: string;
  far: { design: string; element: string };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Every live link from this design to another, in document order. */
export function siteLinks(doc: Document): SiteLink[] {
  const out: SiteLink[] = [];
  for (const peer of doc.nodes) {
    if (peer.absentSince !== undefined || !peer.id.startsWith('external-peer:')) continue;
    const design = str(fieldValue(peer.fields, 'ExternalPeer.far_design'));
    const element = str(fieldValue(peer.fields, 'ExternalPeer.far_element'));
    if (design === '' || element === '') continue;
    for (const term of edgesIn(doc, peer.id, 'Terminates')) {
      const cable = findNode(doc, term.from);
      if (cable == null || cable.absentSince !== undefined) continue;
      const near = edgesOut(doc, cable.id, 'Terminates').find((e) => e.to !== peer.id);
      out.push({
        peerId: peer.id,
        cableId: cable.id,
        nearPortId: near?.to ?? null,
        label: str(fieldValue(peer.fields, 'ExternalPeer.label')),
        far: { design, element },
      });
    }
  }
  return out;
}

/** The first link a set of element ids touches (its cable, its peer or its near port), if any:
 * what lets a trace that runs out at the edge of this design offer to continue in the next. */
export function siteLinkTouching(doc: Document, ids: readonly string[]): SiteLink | undefined {
  const links = siteLinks(doc);
  if (links.length === 0) return undefined;
  const wanted = new Set(ids);
  return links.find((l) => wanted.has(l.cableId) || wanted.has(l.peerId) || (l.nearPortId != null && wanted.has(l.nearPortId)));
}
