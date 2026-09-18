/** React Flow node ids are one flat string namespace; this is the one place
 * that mints and parses the `rack:<id>` / `chassis:<id>` convention so
 * `Drawing.tsx`'s handlers never string-slice inline. */

export function rackNodeId(id: string): string {
  return `rack:${id}`;
}

export function chassisNodeId(id: string): string {
  return `chassis:${id}`;
}

/** ADR-0051 §1 — one `SurfaceView`'s own React Flow node id (`SurfaceNode.tsx`),
 * the closet stop's third kind of box beside a rack and a chassis. A board
 * fixture and its own nested fixtures are NOT separate node ids — they draw
 * as ordinary content inside their surface's one node (`SurfaceNode.tsx`'s
 * own file header), the same way a shelf occupant is content inside its
 * shelf's one node rather than a node of its own. */
export function surfaceNodeId(id: string): string {
  return `surface:${id}`;
}

/** A portal tray node's id — `key` is `portals.ts`'s own `PortalGroup.key`
 * (already unique per rack/side/far-label), so this just tags it with the
 * node-id namespace the other two prefixes use. Never parsed back by
 * `parseNodeId`: a tray is not a `Selection` this drawing raises (UI-SPEC
 * "Portals": "Click to follow" is a later surface, per the session brief's
 * `CableEdge.tsx` note). */
export function trayNodeId(key: string): string {
  return `tray:${key}`;
}

/** A row label node's id — `key` is `rows.ts`'s own `rowKey`. Never parsed
 * back by `parseNodeId` either, same reason as `trayNodeId`: a row label is
 * not a `Selection`. */
export function rowLabelNodeId(key: string): string {
  return `rowLabel:${key}`;
}

export function parseNodeId(nodeId: string): { kind: 'rack' | 'chassis'; id: string } | null {
  const sep = nodeId.indexOf(':');
  if (sep <= 0) return null;
  const prefix = nodeId.slice(0, sep);
  const rest = nodeId.slice(sep + 1);
  if (rest.length === 0) return null;
  if (prefix === 'rack') return { kind: 'rack', id: rest };
  if (prefix === 'chassis') return { kind: 'chassis', id: rest };
  return null;
}
