// Is the version a device runs older than another? A port of `fathom_rules::version::older`
// (crates/fathom-rules/src/version.rs), so the Firmware page says "behind" for the same devices the
// `fw.device.behind-chosen-version` check does. It answers true or false only when both versions
// read under the platform's scheme and the numbers settle the order; anything else is `null`
// (claim nothing). `firmwareVersion.test.ts` holds the Rust test vectors; change both together.

/** Platform id to version scheme: the table in version.rs, a copy of schema/platforms.yaml. */
const SCHEMES: Readonly<Record<string, 'junos' | 'iosxe' | 'nxos' | 'eos'>> = {
  'junos-srx': 'junos',
  'junos-mx': 'junos',
  'junos-ex': 'junos',
  'ios-xe': 'iosxe',
  'nx-os': 'nxos',
  eos: 'eos',
};

/** The platforms a firmware image can be for, with the words the forms show. */
export const FIRMWARE_PLATFORMS: ReadonlyArray<{ id: string; label: string }> = [
  { id: 'junos-ex', label: 'Juniper EX (junos-ex)' },
  { id: 'junos-srx', label: 'Juniper SRX (junos-srx)' },
  { id: 'junos-mx', label: 'Juniper MX (junos-mx)' },
  { id: 'ios-xe', label: 'Cisco IOS XE (ios-xe)' },
  { id: 'nx-os', label: 'Cisco NX-OS (nx-os)' },
  { id: 'eos', label: 'Arista EOS (eos)' },
];

interface Parsed {
  nums: number[];
  tag: string;
  /** The tag names the product, so a mismatch settles nothing. */
  product: boolean;
}

/** One run of ASCII digits, nine at most. */
function num(s: string | undefined): number | null {
  if (s === undefined || s.length === 0 || s.length > 9 || !/^[0-9]+$/.test(s)) return null;
  return Number.parseInt(s, 10);
}

function splitOnce(s: string, sep: string): [string, string] | null {
  const i = s.indexOf(sep);
  return i < 0 ? null : [s.slice(0, i), s.slice(i + sep.length)];
}

/** `m.nRb[.s][-Sk[.s]][-EVO]`. Only R releases. */
function junos(input: string): Parsed | null {
  const evo = input.endsWith('-EVO');
  const v = evo ? input.slice(0, -4) : input;
  const svcSplit = splitOnce(v, '-S');
  const base = svcSplit ? svcSplit[0] : v;
  const svc = svcSplit ? svcSplit[1] : null;
  const r = splitOnce(base, 'R');
  if (!r) return null;
  const mn = splitOnce(r[0], '.');
  if (!mn) return null;
  const buildSpin = splitOnce(r[1], '.');
  const build = buildSpin ? buildSpin[0] : r[1];
  const spin = buildSpin ? buildSpin[1] : null;
  let sNum = 0;
  let lastSpin: string | null = spin;
  if (svc !== null) {
    if (spin !== null) return null;
    const k = splitOnce(svc, '.');
    if (k) {
      const kn = num(k[0]);
      if (kn === null) return null;
      sNum = kn;
      lastSpin = k[1];
    } else {
      const kn = num(svc);
      if (kn === null) return null;
      sNum = kn;
      lastSpin = null;
    }
  }
  let spinNum = 0;
  if (lastSpin !== null) {
    const sp = num(lastSpin);
    if (sp === null) return null;
    spinNum = sp;
  }
  const nums = [num(mn[0]), num(mn[1]), num(build)];
  if (nums.some((n) => n === null)) return null;
  return { nums: [...(nums as number[]), sNum, spinNum], tag: evo ? 'evo' : 'os', product: true };
}

/** `A.B.C` and an optional lowercase letter run. */
function iosxe(v: string): Parsed | null {
  const m = /[a-z]/.exec(v);
  const end = m ? m.index : v.length;
  const digits = v.slice(0, end);
  const letters = v.slice(end);
  if (!/^[a-z]*$/.test(letters)) return null;
  const parts = digits.split('.');
  if (parts.length !== 3) return null;
  const nums = parts.map(num);
  if (nums.some((n) => n === null)) return null;
  return { nums: nums as number[], tag: letters, product: false };
}

/** `A.B(C[letters])[F|M]`. */
function nxos(v: string): Parsed | null {
  const open = splitOnce(v, '(');
  if (!open) return null;
  const close = splitOnce(open[1], ')');
  if (!close) return null;
  const [inner, kind] = close;
  if (kind !== '' && kind !== 'F' && kind !== 'M') return null;
  const ab = splitOnce(open[0], '.');
  if (!ab) return null;
  const m = /[a-z]/.exec(inner);
  const end = m ? m.index : inner.length;
  const c = inner.slice(0, end);
  const letters = inner.slice(end);
  if (!/^[a-z]*$/.test(letters)) return null;
  const nums = [num(ab[0]), num(ab[1]), num(c)];
  if (nums.some((n) => n === null)) return null;
  return { nums: nums as number[], tag: `${letters}/${kind}`, product: false };
}

/** `A.B.C[.D][F|M]`. */
function eos(v: string): Parsed | null {
  const last = v.slice(-1);
  const kind = last === 'F' || last === 'M' ? last : '';
  const digits = kind === '' ? v : v.slice(0, -1);
  const parts = digits.split('.');
  if (parts.length < 3 || parts.length > 4) return null;
  const nums = parts.map(num);
  if (nums.some((n) => n === null)) return null;
  const out = nums as number[];
  if (out.length === 3) out.push(0);
  return { nums: out, tag: kind, product: false };
}

function cmp(a: readonly number[], b: readonly number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** True or false when the order is settled; `null` when it cannot be said. */
export function versionOlder(platform: string, have: string, want: string): boolean | null {
  const scheme = SCHEMES[platform];
  if (scheme === undefined) return null;
  const parse = { junos, iosxe, nxos, eos }[scheme];
  const a = parse(have.trim());
  const b = parse(want.trim());
  if (a === null || b === null) return null;
  if (a.product && a.tag !== b.tag) return null;
  const order = cmp(a.nums, b.nums);
  if (order < 0) return true;
  if (order > 0) return false;
  return a.tag === b.tag ? false : null;
}
