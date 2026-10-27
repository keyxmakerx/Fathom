// A label's QR code and what scanning it opens (ADR-0075, ADR-0068 point 8). Pure.
//
// The link is `<origin>/scan#<designId>/<nodeId>`. The ids ride in the fragment, which a browser never
// sends, so they stay out of the server's and any proxy's logs (the same reason an invitation is
// `/invite#inv_…`). The link carries nothing readable about the network: a name or a port number on a
// label is printed beside the code, not inside it. Opening it needs sign-in and the design's Read.

import { isNodeOfKind, parseNodeId, edgesOut, findNode, type Document } from '../../document/model';
import { EMPTY_STATE, formatHash } from '../inventory/listState';

export const SCAN_PATH = '/scan';

export interface ScanTarget {
  designId: string;
  nodeId: string;
}

/** A design id as the server issues it: a ULID, or anything of the same safe alphabet. */
const DESIGN_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** The kinds a label is printed for, and so the kinds a scan opens. */
export type LabelKind = 'Rack' | 'Chassis' | 'Cable' | 'PhysicalPort';
const LABEL_KINDS: readonly LabelKind[] = ['Rack', 'Chassis', 'Cable', 'PhysicalPort'];

function nodeIdOk(id: string): boolean {
  try {
    parseNodeId(id);
    return true;
  } catch {
    return false;
  }
}

export function scanLink(origin: string, t: ScanTarget): string {
  return `${origin.replace(/\/+$/, '')}${SCAN_PATH}#${t.designId}/${t.nodeId}`;
}

/** The fragment after `#`, as `location.hash` gives it (with or without the `#`). */
export function parseScanFragment(hash: string): ScanTarget | null {
  const h = hash.replace(/^#/, '');
  const slash = h.indexOf('/');
  if (slash <= 0) return null;
  const designId = h.slice(0, slash);
  const nodeId = decodeURIComponent(h.slice(slash + 1));
  if (!DESIGN_ID.test(designId) || !nodeIdOk(nodeId)) return null;
  return { designId, nodeId };
}

/** A pending scan in the address bar: only on the `/scan` path. */
export function scanFromLocation(loc: Pick<Location, 'pathname' | 'hash'>): ScanTarget | null {
  if (loc.pathname !== SCAN_PATH && loc.pathname !== `${SCAN_PATH}/`) return null;
  return parseScanFragment(loc.hash);
}

/**
 * What a camera or a typed line read: a Fathom label for this server, or null. A label printed by
 * another Fathom (another origin) is not followed, so a code stuck on a rack cannot send a person
 * to a look-alike sign-in page.
 */
export function parseScannedText(text: string, origin: string): ScanTarget | null {
  const t = text.trim();
  let url: URL;
  try {
    url = new URL(t);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  return scanFromLocation(url);
}

export function isLabelKind(nodeId: string): boolean {
  return LABEL_KINDS.some((k) => isNodeOfKind(nodeId, k));
}

/**
 * The Inventory address a scanned node opens: the same row key the list's own rows carry, so the
 * page is the ordinary item page. Null when the node is gone or is not a kind with a page.
 */
export function scanHash(doc: Document, nodeId: string): string | null {
  const node = findNode(doc, nodeId);
  if (!node || node.absentSince !== undefined) return null;
  const open = (kind: string, key: string) => formatHash({ ...EMPTY_STATE, kind, open: key });
  if (isNodeOfKind(nodeId, 'Rack')) return open('racks', `rack:${nodeId}`);
  if (isNodeOfKind(nodeId, 'Cable')) return open('cables', `cable:${nodeId}`);
  if (isNodeOfKind(nodeId, 'PhysicalPort')) return open('ports', `port:${nodeId}`);
  if (isNodeOfKind(nodeId, 'Chassis')) {
    // The device row's key names how the box is placed: in a rack, on a shelf, or fixed to a wall.
    const sel = edgesOut(doc, nodeId, 'SitsOn').length > 0 ? 'occupant' : edgesOut(doc, nodeId, 'FixedTo').length > 0 ? 'fixture' : 'chassis';
    return open('devices', `${sel}:${nodeId}`);
  }
  return null;
}
