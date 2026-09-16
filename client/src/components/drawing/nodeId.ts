/** React Flow node ids are one flat string namespace; this is the one place
 * that mints and parses the `rack:<id>` / `chassis:<id>` convention so
 * `Drawing.tsx`'s handlers never string-slice inline. */

export function rackNodeId(id: string): string {
  return `rack:${id}`;
}

export function chassisNodeId(id: string): string {
  return `chassis:${id}`;
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
