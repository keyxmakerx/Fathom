// Whether an address is inside a range a Steward listed, so the panel can say why Read now can't be
// pressed before anyone presses it. The server checks again and has the last word
// (`device_read.rs`'s `range_for`).

function v4(s: string): bigint | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  let n = 0n;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    n = (n << 8n) | BigInt(Number(p));
  }
  return n;
}

function v6(s: string): bigint | null {
  if (!/^[0-9a-fA-F:]+$/.test(s) || s.split('::').length > 2) return null;
  const [head, tail] = s.includes('::') ? s.split('::') : [s, null];
  const a = head ? head.split(':') : [];
  const b = tail ? tail.split(':') : [];
  const fill = tail === null ? 0 : 8 - a.length - b.length;
  if (fill < 0 || (tail === null && a.length !== 8)) return null;
  const groups = [...a, ...Array<string>(fill).fill('0'), ...b];
  let n = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    n = (n << 16n) | BigInt(parseInt(g, 16));
  }
  return n;
}

/** True when `address` is inside `cidr`; false for anything that does not parse. */
export function inRange(address: string, cidr: string): boolean {
  const slash = cidr.indexOf('/');
  if (slash < 0) return false;
  const net = cidr.slice(0, slash).trim();
  const len = Number(cidr.slice(slash + 1));
  const six = net.includes(':');
  if (six !== address.includes(':')) return false;
  const bits = six ? 128 : 32;
  const a = six ? v6(address.trim()) : v4(address.trim());
  const n = six ? v6(net) : v4(net);
  if (a === null || n === null || !Number.isInteger(len) || len < 0 || len > bits) return false;
  const shift = BigInt(bits - len);
  return a >> shift === n >> shift;
}
