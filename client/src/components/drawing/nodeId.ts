/** React Flow node ids are one flat string namespace; this is the one place
 * that mints and parses the `rack:<id>` / `chassis:<id>` convention so
 * `Drawing.tsx`'s handlers never string-slice inline. */

export function rackNodeId(id: string): string {
  return `rack:${id}`;
}

export function chassisNodeId(id: string): string {
  return `chassis:${id}`;
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
